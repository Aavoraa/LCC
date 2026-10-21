"""Quotations, sales orders, shortages and delivery forecasting (spec §7–8).

Flow: enquiry → quotation (carries the preliminary estimate) → sales order (DRAFT) → confirm.
Confirmation re-validates stock, reserves free stock atomically (services.stock.reserve), raises
purchase/production requisitions for whatever incoming supply cannot cover, and computes a
rule-based forecast. A committed delivery date is a separate, maker–checker approved value.

Forecast pegging rule (deterministic, documented in docs/ARCHITECTURE.md):
for each item, confirmed order lines are served in confirmation order. Each line's unreserved
need is covered first by PO lines raised from its own requisitions, then FIFO from the remaining
supply: unallocated free stock, stock in QC hold, then approved PO lines by expected date.
The pegged supply is fed to ``availability.estimate_delivery`` — the same rules as pre-sales.
"""
from __future__ import annotations

from collections.abc import Iterable
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    Item,
    ItemType,
    PurchaseRequisition,
    Quotation,
    Reservation,
    SalesEnquiry,
    SalesOrder,
    SalesOrderLine,
    User,
)
from .availability import estimate_delivery, incoming_supply
from .common import BusinessError, _jsonable, audit, next_number, notify
from .stock import item_totals, open_reserved, release_reservations, reserve

ZERO = Decimal(0)
RISK_ORDER = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ quotations
def create_quotation(db: Session, user: User, *, enquiry_id: int, unit_price: Decimal, valid_days: int = 30,
                     notes: str | None = None) -> Quotation:
    enq = db.get(SalesEnquiry, enquiry_id)
    if enq is None:
        raise BusinessError("Enquiry not found", status_code=404, code="not_found")
    if enq.status not in ("OPEN", "QUOTED"):
        raise BusinessError(f"Enquiry {enq.number} is {enq.status.lower()}; it can no longer be quoted", status_code=409, code="state")
    if unit_price < 0:
        raise BusinessError("Unit price cannot be negative")
    q = Quotation(number=next_number(db, "quotation", "QT-", 5), enquiry_id=enq.id, customer_id=enq.customer_id, item_id=enq.item_id,
                  quantity=enq.quantity, unit_price=unit_price, valid_until=date.today() + timedelta(days=valid_days),
                  preliminary_date=enq.estimated_date, estimate=enq.estimate, risk=enq.risk, notes=notes, created_by_id=user.id)
    db.add(q)
    enq.status = "QUOTED"
    db.flush()
    audit(db, user, "sales.quotation.create", "quotation", q.id,
          {"number": q.number, "enquiry": enq.number, "unit_price": unit_price, "preliminary_date": q.preliminary_date})
    return q


QUOTE_TRANSITIONS = {"DRAFT": {"SENT", "ACCEPTED", "REJECTED"}, "SENT": {"ACCEPTED", "REJECTED"}}


def set_quotation_status(db: Session, user: User, q: Quotation, status: str) -> Quotation:
    status = status.upper()
    if status not in QUOTE_TRANSITIONS.get(q.status, set()):
        raise BusinessError(f"Quotation {q.number} cannot move from {q.status.lower()} to {status.lower()}", status_code=409, code="state")
    if status == "ACCEPTED" and q.valid_until and q.valid_until < date.today():
        raise BusinessError(f"Quotation {q.number} expired on {q.valid_until.isoformat()}; issue a new quotation", status_code=409, code="state")
    old, q.status = q.status, status
    if status == "REJECTED":
        q.enquiry.status = "LOST"
    audit(db, user, f"sales.quotation.{status.lower()}", "quotation", q.id, {"number": q.number, "from": old})
    return q


# ------------------------------------------------------------------ sales orders
def create_sales_order(db: Session, user: User, *, quotation_id: int | None = None, enquiry_id: int | None = None,
                       customer_po_ref: str | None = None, required_date: date | None = None, notes: str | None = None) -> SalesOrder:
    """Convert an accepted quotation (or directly an open enquiry) into a DRAFT sales order."""
    if bool(quotation_id) == bool(enquiry_id):
        raise BusinessError("Provide either a quotation or an enquiry to convert")
    quote: Quotation | None = None
    if quotation_id:
        quote = db.get(Quotation, quotation_id)
        if quote is None:
            raise BusinessError("Quotation not found", status_code=404, code="not_found")
        if quote.status != "ACCEPTED":
            raise BusinessError(f"Only an accepted quotation can be converted (this one is {quote.status.lower()})", status_code=409, code="state")
        enq = quote.enquiry
    else:
        enq = db.get(SalesEnquiry, enquiry_id)
        if enq is None:
            raise BusinessError("Enquiry not found", status_code=404, code="not_found")
        if enq.status not in ("OPEN", "QUOTED"):
            raise BusinessError(f"Enquiry {enq.number} is {enq.status.lower()}", status_code=409, code="state")
    if db.scalar(select(SalesOrder.id).where(SalesOrder.enquiry_id == enq.id)):
        raise BusinessError(f"Enquiry {enq.number} has already been converted to a sales order", status_code=409, code="duplicate")
    so = SalesOrder(number=next_number(db, "sales_order", "SO-", 5), customer_id=enq.customer_id, enquiry_id=enq.id,
                    quotation_id=quote.id if quote else None, customer_po_ref=customer_po_ref,
                    required_date=required_date or enq.required_date, preliminary_date=quote.preliminary_date if quote else enq.estimated_date,
                    notes=notes, created_by_id=user.id)
    so.lines.append(SalesOrderLine(line_no=1, item_id=enq.item_id, quantity=enq.quantity,
                                   unit_price=quote.unit_price if quote else ZERO, qty_issued=ZERO, qty_shortage=ZERO))
    db.add(so)
    enq.status = "WON"
    if quote:
        quote.status = "CONVERTED"
    db.flush()
    audit(db, user, "sales.order.create", "sales_order", so.id,
          {"number": so.number, "enquiry": enq.number, "quotation": quote.number if quote else None})
    return so


def confirm_sales_order(db: Session, user: User, so: SalesOrder) -> dict:
    """Re-validate stock, reserve, raise requisitions for uncovered shortages, forecast.
    Idempotent: confirming an already confirmed order returns its current state."""
    if so.status == "CONFIRMED":
        return {"already_confirmed": True}
    if so.status != "DRAFT":
        raise BusinessError(f"Sales order {so.number} is {so.status.lower()}", status_code=409, code="state")
    reserved: dict[int, Decimal] = {}
    for line in so.lines:
        item = line.item
        if not item.is_active:
            raise BusinessError(f"{item.item_code} is inactive; it cannot be confirmed on an order")
        if item.item_type == ItemType.SERVICE:
            line.qty_shortage = ZERO
            continue
        got = reserve(db, user, item_id=item.id, quantity=Decimal(line.quantity), ref_doc_type="SALES_ORDER", ref_doc_no=so.number,
                      key_prefix=f"SO-LINE-{line.id}", so_line_id=line.id, preferred_location_id=item.default_location_id)
        reserved[line.id] = got
        line.qty_shortage = Decimal(line.quantity) - got
    so.status, so.confirmed_by_id, so.confirmed_at = "CONFIRMED", user.id, _now()
    db.flush()
    uncovered = recalculate_forecasts(db, {l.item_id for l in so.lines}, user=user, reason=f"{so.number} confirmed")
    requisitions = []
    for line in so.lines:
        need = uncovered.get(line.id, ZERO)
        if need > 0:
            requisitions.append(_raise_requisition(db, user, so, line, need))
    audit(db, user, "sales.order.confirm", "sales_order", so.id,
          {"number": so.number, "reserved": {str(k): v for k, v in reserved.items()},
           "requisitions": [r.number for r in requisitions], "forecast_date": so.forecast_date})
    return {"already_confirmed": False, "reserved": reserved, "requisitions": [r.number for r in requisitions]}


def allocate_shortages(db: Session, user: User, so: SalesOrder) -> Decimal:
    """Reserve newly free stock (e.g. after a goods receipt passes QC) against short lines."""
    if so.status != "CONFIRMED":
        raise BusinessError(f"Sales order {so.number} is {so.status.lower()}", status_code=409, code="state")
    total = ZERO
    for line in so.lines:
        need = Decimal(line.quantity) - Decimal(line.qty_issued) - open_reserved(db, so_line_id=line.id)
        if need <= 0 or line.item.item_type == ItemType.SERVICE:
            continue
        got = reserve(db, user, item_id=line.item_id, quantity=need, ref_doc_type="SALES_ORDER", ref_doc_no=so.number,
                      key_prefix=f"SO-LINE-{line.id}", so_line_id=line.id, preferred_location_id=line.item.default_location_id)
        line.qty_shortage = need - got
        total += got
    recalculate_forecasts(db, {l.item_id for l in so.lines}, user=user, reason=f"{so.number} allocation")
    audit(db, user, "sales.order.allocate", "sales_order", so.id, {"number": so.number, "reserved": total})
    return total


def cancel_sales_order(db: Session, user: User, so: SalesOrder, reason: str) -> SalesOrder:
    if so.status not in ("DRAFT", "CONFIRMED"):
        raise BusinessError(f"Sales order {so.number} is {so.status.lower()}", status_code=409, code="state")
    if any(Decimal(l.qty_issued) > 0 for l in so.lines):
        raise BusinessError("Stock has already been issued against this order; return it before cancelling", status_code=409, code="state")
    if not reason or len(reason.strip()) < 5:
        raise BusinessError("A reason of at least 5 characters is required")
    line_ids = [l.id for l in so.lines]
    res = list(db.scalars(select(Reservation).where(Reservation.so_line_id.in_(line_ids), Reservation.status == "ACTIVE")))
    released = release_reservations(db, user, res)
    for pr in db.scalars(select(PurchaseRequisition).where(PurchaseRequisition.so_line_id.in_(line_ids), PurchaseRequisition.status == "OPEN")):
        pr.status = "CANCELLED"
    so.status, so.at_risk = "CANCELLED", False
    db.flush()
    recalculate_forecasts(db, {l.item_id for l in so.lines}, user=user, reason=f"{so.number} cancelled")
    audit(db, user, "sales.order.cancel", "sales_order", so.id, {"number": so.number, "reason": reason, "released": released})
    return so


# ------------------------------------------------------------------ requisitions
def _raise_requisition(db: Session, user: User, so: SalesOrder, line: SalesOrderLine, qty: Decimal) -> PurchaseRequisition:
    key = f"SO-LINE-{line.id}:REQ"
    existing = db.scalar(select(PurchaseRequisition).where(PurchaseRequisition.idempotency_key == key))
    if existing:
        return existing
    item = line.item
    produced = item.item_type in (ItemType.PROCESSED_SPARE, ItemType.FINISHED_GOOD) and bool(item.production_lead_days)
    kind = "PRODUCTION" if produced else "PURCHASE"
    pr = PurchaseRequisition(number=next_number(db, "requisition", "PR-", 5), kind=kind, item_id=item.id, quantity=qty,
                             required_date=so.required_date, so_line_id=line.id, idempotency_key=key, status="OPEN",
                             notes=f"Shortage on {so.number} line {line.line_no}", created_by_id=user.id)
    db.add(pr)
    db.flush()
    audit(db, user, "purchase.requisition.create", "purchase_requisition", pr.id,
          {"number": pr.number, "kind": kind, "item": item.item_code, "qty": qty, "so": so.number})
    notify(db, "requisition", f"{pr.number}: {kind.lower()} {qty.normalize():f} {item.uom.code} of {item.item_code}",
           f"Raised by sales order {so.number} ({so.customer.name})", role_code="PRODUCTION" if produced else "PURCHASE",
           entity_type="purchase_requisition", entity_id=pr.id)
    return pr


# ------------------------------------------------------------------ forecasting
def _line_need(db: Session, line: SalesOrderLine) -> tuple[Decimal, Decimal]:
    """(outstanding qty to deliver, part of it not yet covered by an open reservation)."""
    outstanding = Decimal(line.quantity) - Decimal(line.qty_issued)
    return outstanding, max(outstanding - open_reserved(db, so_line_id=line.id), ZERO)


def _supply_pool(db: Session, item: Item) -> list[dict]:
    """Supply not yet reserved, in the order it can be used."""
    today = date.today()
    totals = item_totals(db, item.id)
    pool: list[dict] = []
    if totals["available"] > 0:
        pool.append({"source": "STOCK", "open_qty": totals["available"], "expected_date": today,
                     "label": "Unreserved stock on hand — allocate to the order"})
    if totals["qc_hold"] > 0:
        pool.append({"source": "QC", "open_qty": totals["qc_hold"], "expected_date": today,
                     "label": "Stock in quality hold — pending inspection release"})
    for inc in incoming_supply(db, item.id):
        pool.append({"source": "PO", **inc})
    return pool


def recalculate_forecasts(db: Session, item_ids: Iterable[int], *, user: User | None = None, reason: str = "") -> dict[int, Decimal]:
    """Re-peg supply to confirmed order lines for the given items and refresh line and order
    forecasts. Returns the quantity per line that no supply covers (candidate requisitions)."""
    uncovered: dict[int, Decimal] = {}
    touched: dict[int, SalesOrder] = {}
    for item_id in sorted(set(item_ids)):
        item = db.get(Item, item_id)
        if item is None:
            continue
        lines = list(db.scalars(
            select(SalesOrderLine).join(SalesOrder, SalesOrderLine.so_id == SalesOrder.id)
            .where(SalesOrderLine.item_id == item_id, SalesOrder.status == "CONFIRMED")
            .order_by(SalesOrder.confirmed_at, SalesOrder.id, SalesOrderLine.line_no)))
        if not lines:
            continue
        pool = _supply_pool(db, item)
        need = {}
        outstanding = {}
        for l in lines:
            outstanding[l.id], need[l.id] = _line_need(db, l)
        pegged: dict[int, list[dict]] = {l.id: [] for l in lines}

        def take(line_id: int, entry: dict) -> None:
            qty = min(need[line_id], entry["open_qty"])
            if qty <= 0:
                return
            pegged[line_id].append({**entry, "open_qty": qty})
            entry["open_qty"] -= qty
            need[line_id] -= qty

        # 1) supply ordered specifically for a line (requisition → PO line)
        own_po_lines: dict[int, set[int]] = {}
        for pr in db.scalars(select(PurchaseRequisition).where(
                PurchaseRequisition.so_line_id.in_(list(need)), PurchaseRequisition.po_line_id.is_not(None),
                PurchaseRequisition.status == "ORDERED")):
            own_po_lines.setdefault(pr.so_line_id, set()).add(pr.po_line_id)
        for l in lines:
            for entry in pool:
                if entry.get("po_line_id") in own_po_lines.get(l.id, ()):
                    take(l.id, entry)
        # 2) FIFO by confirmation for everything else
        for l in lines:
            for entry in pool:
                if need[l.id] <= 0:
                    break
                take(l.id, entry)

        for l in lines:
            so = l.so
            if outstanding[l.id] <= 0:
                l.forecast_date, l.forecast = None, None
                touched[so.id] = so
                continue
            short_before = sum((p["open_qty"] for p in pegged[l.id]), ZERO) + need[l.id]
            est = estimate_delivery(db, item, outstanding[l.id], customer=so.customer, required_date=so.required_date,
                                    shortage=short_before, incoming=pegged[l.id])
            l.forecast_date = est["estimated_date"]
            l.forecast = _jsonable({k: v for k, v in est.items() if k != "availability"} | {
                "uncovered_qty": need[l.id], "pegged_supply": pegged[l.id]})
            uncovered[l.id] = need[l.id]
            touched[so.id] = so
    for so in touched.values():
        _refresh_order(db, so, user=user, reason=reason)
    db.flush()
    return uncovered


def _refresh_order(db: Session, so: SalesOrder, *, user: User | None, reason: str) -> None:
    dated = [l for l in so.lines if l.forecast_date]
    old_date = so.forecast_date
    was_at_risk = so.at_risk
    so.forecast_date = max((l.forecast_date for l in dated), default=None)
    so.forecast_risk = max((l.forecast["risk"] for l in dated if l.forecast), key=lambda r: RISK_ORDER.get(r, 0), default=None)
    so.forecast_updated_at = _now()
    target = so.committed_date or so.required_date
    so.at_risk = bool(so.status == "CONFIRMED" and target and so.forecast_date and so.forecast_date > target)
    if old_date and so.forecast_date and so.forecast_date != old_date:
        audit(db, user, "sales.order.forecast_change", "sales_order", so.id,
              {"number": so.number, "from": old_date, "to": so.forecast_date, "reason": reason, "at_risk": so.at_risk})
        if so.forecast_date > old_date:
            notify(db, "forecast", f"{so.number} forecast slipped to {so.forecast_date.isoformat()}",
                   f"Was {old_date.isoformat()} ({reason})." + (f" Now later than the {'committed' if so.committed_date else 'required'} "
                                                                 f"date {target.isoformat()}." if so.at_risk else ""),
                   role_code="SALES", entity_type="sales_order", entity_id=so.id)
    if so.at_risk and not was_at_risk and old_date is not None:
        notify(db, "at_risk", f"{so.number} is at risk of late delivery", reason, role_code="MANAGEMENT",
               entity_type="sales_order", entity_id=so.id)


# ------------------------------------------------------------------ committed date (maker–checker)
def request_commitment(db: Session, user: User, so: SalesOrder, committed_date: date, note: str | None) -> SalesOrder:
    if so.status != "CONFIRMED":
        raise BusinessError("A delivery date can only be committed on a confirmed order", status_code=409, code="state")
    if so.commit_status == "PENDING":
        raise BusinessError("A commitment request is already awaiting approval", status_code=409, code="state")
    if so.forecast_date and committed_date < so.forecast_date:
        raise BusinessError(f"Cannot commit {committed_date.isoformat()}: the rule-based forecast is {so.forecast_date.isoformat()}")
    so.commit_status, so.proposed_commit_date, so.commit_requested_by_id = "PENDING", committed_date, user.id
    so.commit_note, so.commit_approved_by_id, so.commit_decided_at = note, None, None
    audit(db, user, "sales.order.commit_request", "sales_order", so.id,
          {"number": so.number, "proposed": committed_date, "forecast": so.forecast_date, "note": note})
    notify(db, "approval", f"{so.number}: approve committed delivery {committed_date.isoformat()}",
           f"Forecast {so.forecast_date.isoformat() if so.forecast_date else 'n/a'}; requested by {user.full_name}",
           role_code="MANAGEMENT", entity_type="sales_order", entity_id=so.id)
    return so


def decide_commitment(db: Session, user: User, so: SalesOrder, approve: bool, note: str | None) -> SalesOrder:
    if so.commit_status != "PENDING":
        raise BusinessError("No commitment request is awaiting approval", status_code=409, code="state")
    if so.commit_requested_by_id == user.id:
        raise BusinessError("Maker–checker: you cannot approve your own delivery commitment", status_code=403, code="forbidden")
    if approve and so.forecast_date and so.proposed_commit_date < so.forecast_date:
        raise BusinessError(f"The forecast has moved to {so.forecast_date.isoformat()} since this was requested; "
                            "reject it and request a new date", status_code=409, code="stale")
    so.commit_approved_by_id, so.commit_decided_at = user.id, _now()
    if approve:
        so.commit_status, so.committed_date = "APPROVED", so.proposed_commit_date
        so.at_risk = bool(so.forecast_date and so.forecast_date > so.committed_date)
    else:
        so.commit_status = "REJECTED"
    audit(db, user, f"sales.order.commit_{'approve' if approve else 'reject'}", "sales_order", so.id,
          {"number": so.number, "date": so.proposed_commit_date, "note": note})
    return so
