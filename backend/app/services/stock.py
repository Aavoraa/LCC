"""Inventory ledger. The only code path that changes stock balances.

Every call posts exactly one append-only ``StockMovement`` and updates the affected
``StockBalance`` rows in the same transaction. Concurrency: balance rows are locked
(``FOR UPDATE`` on PostgreSQL) and versioned (optimistic check everywhere), so two
simultaneous issues cannot both consume the same quantity.

Reservations (``reserve`` / ``release_reservations``) follow the same rule: they lock and
version the balance rows they touch, so two orders can never reserve the same free quantity.
An ISSUE against a ``SALES_ORDER`` consumes that order's reservations at the source location.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import (
    ApprovalStatus,
    Item,
    Location,
    MovementType,
    Reservation,
    SalesOrder,
    StockAdjustmentRequest,
    StockBalance,
    StockMovement,
    User,
)
from .common import BusinessError, audit, next_number, notify

ZERO = Decimal("0")
Q4 = Decimal("0.0001")

# Documents an issue may be raised against (spec §5).
ISSUE_REF_TYPES = {"SALES_ORDER", "PURCHASE_ORDER", "PAD", "WIP", "ASSEMBLY_REQUEST", "REQUISITION"}

MOVEMENT_PERMISSION = {
    MovementType.RECEIPT: "stock.receive",
    MovementType.ISSUE: "stock.issue",
    MovementType.TRANSFER: "stock.transfer",
    MovementType.RETURN: "stock.return",
    MovementType.QC_HOLD: "qc.hold",
    MovementType.QC_RELEASE: "qc.hold",
}


@dataclass
class MovementInput:
    txn_uuid: str
    movement_type: MovementType
    item_id: int
    quantity: Decimal
    from_location_id: int | None = None
    to_location_id: int | None = None
    unit_cost: Decimal | None = None
    ref_doc_type: str | None = None
    ref_doc_no: str | None = None
    batch_no: str | None = None
    notes: str | None = None
    source: str = "web"
    device_captured_at: datetime | None = None
    into_qc_hold: bool = False


def _q(value: Decimal) -> Decimal:
    return Decimal(value).quantize(Q4, rounding=ROUND_HALF_UP)


def _lock_balance(db: Session, item_id: int, location_id: int) -> StockBalance:
    stmt = select(StockBalance).where(StockBalance.item_id == item_id, StockBalance.location_id == location_id)
    stmt = stmt.with_for_update()
    bal = db.scalar(stmt)
    if bal is None:
        bal = StockBalance(item_id=item_id, location_id=location_id, qty_on_hand=ZERO, qty_reserved=ZERO, qty_qc_hold=ZERO)
        db.add(bal)
        db.flush()
    return bal


def total_on_hand(db: Session, item_id: int) -> Decimal:
    return Decimal(db.scalar(select(func.coalesce(func.sum(StockBalance.qty_on_hand), 0)).where(StockBalance.item_id == item_id)) or 0)


def item_totals(db: Session, item_id: int) -> dict[str, Decimal]:
    row = db.execute(
        select(
            func.coalesce(func.sum(StockBalance.qty_on_hand), 0),
            func.coalesce(func.sum(StockBalance.qty_reserved), 0),
            func.coalesce(func.sum(StockBalance.qty_qc_hold), 0),
        ).where(StockBalance.item_id == item_id)
    ).one()
    on_hand, reserved, qc = (Decimal(v) for v in row)
    return {"on_hand": on_hand, "reserved": reserved, "qc_hold": qc, "available": on_hand - reserved - qc}


def _check_uom_precision(item: Item, qty: Decimal) -> None:
    decimals = item.uom.decimals if item.uom else 4
    if qty != qty.quantize(Decimal(1).scaleb(-decimals)):
        raise BusinessError(f"Quantity for {item.uom.code} allows at most {decimals} decimal places")


def post_movement(db: Session, user: User, data: MovementInput, *, _internal: bool = False) -> tuple[StockMovement, bool]:
    """Returns ``(movement, created)``. Re-posting the same ``txn_uuid`` returns the original (idempotent)."""
    existing = db.scalar(select(StockMovement).where(StockMovement.txn_uuid == data.txn_uuid))
    if existing:
        if existing.item_id != data.item_id or existing.movement_type != data.movement_type or _q(existing.quantity) != _q(data.quantity):
            raise BusinessError("This transaction ID was already used for a different movement", status_code=409, code="txn_conflict")
        return existing, False

    mtype = data.movement_type
    if not _internal:
        if mtype in (MovementType.ADJUSTMENT_IN, MovementType.ADJUSTMENT_OUT, MovementType.OPENING):
            raise BusinessError("Adjustments and opening stock must go through their approval workflows", status_code=403, code="forbidden")
        needed = MOVEMENT_PERMISSION[mtype]
        if needed not in user.permission_codes:
            raise BusinessError(f"Missing permission: {needed}", status_code=403, code="forbidden")

    item = db.get(Item, data.item_id)
    if item is None or not item.is_active:
        raise BusinessError("Item not found or inactive", status_code=404, code="not_found")
    qty = Decimal(data.quantity)
    if qty <= 0:
        raise BusinessError("Quantity must be greater than zero")
    _check_uom_precision(item, qty)

    needs_from = mtype in (MovementType.ISSUE, MovementType.TRANSFER, MovementType.ADJUSTMENT_OUT, MovementType.QC_HOLD, MovementType.QC_RELEASE)
    needs_to = mtype in (MovementType.RECEIPT, MovementType.TRANSFER, MovementType.RETURN, MovementType.ADJUSTMENT_IN, MovementType.OPENING)
    if needs_from and not data.from_location_id:
        raise BusinessError("Source location is required")
    if needs_to and not data.to_location_id:
        raise BusinessError("Destination location is required")
    if not needs_from:
        data.from_location_id = None
    if not needs_to:
        data.to_location_id = None
    if mtype == MovementType.TRANSFER and data.from_location_id == data.to_location_id:
        raise BusinessError("Source and destination must differ")
    for loc_id in (data.from_location_id, data.to_location_id):
        if loc_id is not None:
            loc = db.get(Location, loc_id)
            if loc is None or not loc.is_active:
                raise BusinessError("Location not found or inactive", status_code=404, code="not_found")
    if mtype == MovementType.ISSUE:
        if (data.ref_doc_type or "").upper() not in ISSUE_REF_TYPES or not data.ref_doc_no:
            raise BusinessError("Issues must reference an authorized document: " + ", ".join(sorted(ISSUE_REF_TYPES)))
        data.ref_doc_type = data.ref_doc_type.upper()

    before_total = total_on_hand(db, item.id)
    avg = Decimal(item.avg_cost or 0)

    # Inbound movements may carry a cost; everything else moves at the current average.
    if mtype in (MovementType.RECEIPT, MovementType.OPENING, MovementType.ADJUSTMENT_IN) and data.unit_cost is not None:
        unit_cost = Decimal(data.unit_cost)
        if unit_cost < 0:
            raise BusinessError("Unit cost cannot be negative")
    else:
        unit_cost = avg

    # ---- sales-order issue: validate against the order and find its reservations here
    so: SalesOrder | None = None
    own_reservations: list[Reservation] = []
    if mtype == MovementType.ISSUE and data.ref_doc_type == "SALES_ORDER":
        so = db.scalar(select(SalesOrder).where(SalesOrder.number == data.ref_doc_no))
        if so is not None:
            _check_so_issue(so, item, qty)
            own_reservations = list(db.scalars(
                select(Reservation).where(Reservation.ref_doc_type == "SALES_ORDER", Reservation.ref_doc_no == so.number,
                                          Reservation.item_id == item.id, Reservation.location_id == data.from_location_id,
                                          Reservation.status == "ACTIVE")
                .order_by(Reservation.id).with_for_update()))
    own_open = sum((r.qty_open for r in own_reservations), ZERO)

    # ---- balance projection (locked)
    if data.from_location_id:
        src = _lock_balance(db, item.id, data.from_location_id)
        if mtype == MovementType.QC_HOLD:
            free = src.qty_available
            if qty > free:
                raise BusinessError(f"Only {free.normalize():f} {item.uom.code} free to place on QC hold")
            src.qty_qc_hold = _q(src.qty_qc_hold + qty)
        elif mtype == MovementType.QC_RELEASE:
            if qty > src.qty_qc_hold:
                raise BusinessError(f"Only {Decimal(src.qty_qc_hold).normalize():f} {item.uom.code} is on QC hold here")
            src.qty_qc_hold = _q(src.qty_qc_hold - qty)
        else:
            consume = min(qty, own_open)  # an order may draw on its own reservation
            free = src.qty_available + consume
            if qty > free:
                raise BusinessError(
                    f"Insufficient available stock at this location: requested {qty.normalize():f}, available {free.normalize():f} {item.uom.code}"
                    + (" (reserved and QC-hold quantities are excluded)" if (src.qty_reserved or src.qty_qc_hold) else ""),
                    code="insufficient_stock",
                )
            src.qty_on_hand = _q(src.qty_on_hand - qty)
            if consume > 0:
                src.qty_reserved = _q(src.qty_reserved - consume)
                _consume_reservations(own_reservations, consume)
    if data.to_location_id:
        dst = _lock_balance(db, item.id, data.to_location_id)
        dst.qty_on_hand = _q(dst.qty_on_hand + qty)
        if data.into_qc_hold and mtype == MovementType.RECEIPT:
            dst.qty_qc_hold = _q(dst.qty_qc_hold + qty)

    # ---- weighted average valuation
    if mtype in (MovementType.RECEIPT, MovementType.OPENING, MovementType.ADJUSTMENT_IN, MovementType.RETURN):
        new_total = before_total + qty
        if new_total > 0:
            item.avg_cost = _q((before_total * avg + qty * unit_cost) / new_total)

    movement = StockMovement(
        number=next_number(db, "stock_movement", "SM-", 8),
        txn_uuid=data.txn_uuid,
        movement_type=mtype,
        item_id=item.id,
        from_location_id=data.from_location_id,
        to_location_id=data.to_location_id,
        quantity=_q(qty),
        unit_cost=_q(unit_cost),
        value=_q(qty * unit_cost),
        ref_doc_type=data.ref_doc_type,
        ref_doc_no=data.ref_doc_no,
        batch_no=data.batch_no,
        notes=data.notes,
        source=data.source,
        device_captured_at=data.device_captured_at,
        created_by_id=user.id,
    )
    db.add(movement)
    db.flush()
    if so is not None:
        _record_so_issue(so, item.id, qty)
    audit(db, user, f"stock.{mtype.value.lower()}", "stock_movement", movement.id,
          {"number": movement.number, "item_code": item.item_code, "qty": qty, "from": data.from_location_id,
           "to": data.to_location_id, "ref": f"{data.ref_doc_type or ''} {data.ref_doc_no or ''}".strip()})

    totals = item_totals(db, item.id)
    if totals["available"] <= Decimal(item.reorder_level or 0) and Decimal(item.reorder_level or 0) > 0 \
            and mtype in (MovementType.ISSUE, MovementType.ADJUSTMENT_OUT, MovementType.QC_HOLD):
        notify(db, "reorder", f"{item.item_code} at or below reorder level",
               f"{item.name}: available {totals['available'].normalize():f} {item.uom.code}, reorder level "
               f"{Decimal(item.reorder_level).normalize():f}", role_code="PURCHASE", entity_type="item", entity_id=item.id)
    return movement, True


# ------------------------------------------------------------ sales-order issues
def _so_outstanding(so: SalesOrder, item_id: int) -> Decimal:
    return sum((Decimal(l.quantity) - Decimal(l.qty_issued) for l in so.lines if l.item_id == item_id), ZERO)


def _check_so_issue(so: SalesOrder, item: Item, qty: Decimal) -> None:
    if so.status != "CONFIRMED":
        raise BusinessError(f"Sales order {so.number} is {so.status.lower()}; stock can only be issued against a confirmed order",
                            status_code=409, code="state")
    if not any(l.item_id == item.id for l in so.lines):
        raise BusinessError(f"{item.item_code} is not on sales order {so.number}")
    outstanding = _so_outstanding(so, item.id)
    if qty > outstanding:
        raise BusinessError(f"Over-issue: only {outstanding.normalize():f} {item.uom.code} of {item.item_code} remains to issue on {so.number}",
                            code="over_issue")


def _consume_reservations(reservations: list[Reservation], qty: Decimal) -> None:
    remaining = qty
    for r in reservations:
        if remaining <= 0:
            break
        take = min(r.qty_open, remaining)
        r.qty_consumed = _q(Decimal(r.qty_consumed or 0) + take)
        if r.qty_open <= 0:
            r.status = "CONSUMED"
        remaining -= take


def _record_so_issue(so: SalesOrder, item_id: int, qty: Decimal) -> None:
    remaining = qty
    for line in so.lines:
        if line.item_id != item_id or remaining <= 0:
            continue
        take = min(Decimal(line.quantity) - Decimal(line.qty_issued), remaining)
        if take > 0:
            line.qty_issued = _q(Decimal(line.qty_issued) + take)
            remaining -= take
    if all(Decimal(l.qty_issued) >= Decimal(l.quantity) for l in so.lines):
        so.status = "COMPLETED"
        so.at_risk = False


# ------------------------------------------------------------ reservations
def reserve(db: Session, user: User, *, item_id: int, quantity: Decimal, ref_doc_type: str, ref_doc_no: str, key_prefix: str,
            so_line_id: int | None = None, preferred_location_id: int | None = None) -> Decimal:
    """Reserve up to ``quantity`` of free stock (on hand − reserved − QC hold) across locations and
    return how much was reserved. Balance rows are locked and versioned, so concurrent callers can
    never reserve the same free quantity: the loser fails and retries with fresh data.
    One reservation row per ``key_prefix`` + location (``idempotency_key``)."""
    if quantity <= 0:
        return ZERO
    balances = list(db.scalars(select(StockBalance).where(StockBalance.item_id == item_id).order_by(StockBalance.id).with_for_update()))
    # Allocation order: the item's default location first, then the location with most free stock.
    balances.sort(key=lambda b: (b.location_id != preferred_location_id, -b.qty_available, b.id))
    remaining = Decimal(quantity)
    for bal in balances:
        if remaining <= 0:
            break
        free = bal.qty_available
        if free <= 0 or not bal.location.is_active:
            continue
        take = min(free, remaining)
        key = f"{key_prefix}:L{bal.location_id}"
        res = db.scalar(select(Reservation).where(Reservation.idempotency_key == key))
        if res is None:
            db.add(Reservation(item_id=item_id, location_id=bal.location_id, quantity=_q(take), qty_consumed=ZERO,
                               ref_doc_type=ref_doc_type, ref_doc_no=ref_doc_no, so_line_id=so_line_id, idempotency_key=key,
                               status="ACTIVE", created_by_id=user.id))
        else:  # top-up of an earlier allocation at the same location
            res.quantity = _q(Decimal(res.quantity) + take)
            res.status = "ACTIVE"
        bal.qty_reserved = _q(bal.qty_reserved + take)
        remaining -= take
    db.flush()
    reserved = Decimal(quantity) - remaining
    if reserved > 0:
        audit(db, user, "stock.reserve", "reservation", f"{ref_doc_type} {ref_doc_no}",
              {"item_id": item_id, "qty": reserved, "requested": quantity, "key": key_prefix})
    return reserved


def release_reservations(db: Session, user: User, reservations: list[Reservation]) -> Decimal:
    released = ZERO
    for r in reservations:
        if r.status != "ACTIVE":
            continue
        bal = _lock_balance(db, r.item_id, r.location_id)
        open_qty = r.qty_open
        bal.qty_reserved = _q(max(Decimal(bal.qty_reserved) - open_qty, ZERO))
        r.status = "RELEASED"
        released += open_qty
        audit(db, user, "stock.reservation.release", "reservation", r.id, {"qty": open_qty, "ref": f"{r.ref_doc_type} {r.ref_doc_no}"})
    db.flush()
    return released


def open_reserved(db: Session, *, so_line_id: int) -> Decimal:
    rows = db.scalars(select(Reservation).where(Reservation.so_line_id == so_line_id, Reservation.status == "ACTIVE"))
    return sum((r.qty_open for r in rows), ZERO)


# ------------------------------------------------------------ adjustments (maker–checker)
def request_adjustment(db: Session, user: User, item_id: int, location_id: int, qty_delta: Decimal, reason: str) -> StockAdjustmentRequest:
    if qty_delta == 0:
        raise BusinessError("Adjustment quantity cannot be zero")
    if not reason or len(reason.strip()) < 5:
        raise BusinessError("A reason of at least 5 characters is required")
    if db.get(Item, item_id) is None or db.get(Location, location_id) is None:
        raise BusinessError("Item or location not found", status_code=404, code="not_found")
    req = StockAdjustmentRequest(number=next_number(db, "stock_adjustment", "ADJ-"), item_id=item_id, location_id=location_id,
                                 qty_delta=_q(qty_delta), reason=reason.strip(), requested_by_id=user.id)
    db.add(req)
    db.flush()
    audit(db, user, "stock.adjustment.request", "stock_adjustment", req.id, {"qty_delta": qty_delta, "reason": reason})
    notify(db, "approval", f"Stock adjustment {req.number} awaiting approval", reason, role_code="MANAGEMENT",
           entity_type="stock_adjustment", entity_id=req.id)
    return req


def decide_adjustment(db: Session, user: User, req: StockAdjustmentRequest, approve: bool, note: str | None) -> StockAdjustmentRequest:
    if req.status != ApprovalStatus.PENDING:
        raise BusinessError(f"Request is already {req.status.value.lower()}", status_code=409, code="state")
    if req.requested_by_id == user.id:
        raise BusinessError("Maker–checker: you cannot approve your own adjustment request", status_code=403, code="forbidden")
    req.decided_by_id = user.id
    req.decided_at = datetime.now(timezone.utc)
    req.decision_note = note
    if approve:
        delta = Decimal(req.qty_delta)
        mtype = MovementType.ADJUSTMENT_IN if delta > 0 else MovementType.ADJUSTMENT_OUT
        movement, _ = post_movement(db, user, MovementInput(
            txn_uuid=f"adj-{req.id}", movement_type=mtype, item_id=req.item_id, quantity=abs(delta),
            from_location_id=req.location_id if delta < 0 else None, to_location_id=req.location_id if delta > 0 else None,
            ref_doc_type="ADJUSTMENT", ref_doc_no=req.number, notes=req.reason,
        ), _internal=True)
        req.movement_id = movement.id
        req.status = ApprovalStatus.APPROVED
    else:
        req.status = ApprovalStatus.REJECTED
    audit(db, user, f"stock.adjustment.{req.status.value.lower()}", "stock_adjustment", req.id, {"note": note})
    return req


# ------------------------------------------------------------ reconciliation
def reconcile(db: Session) -> list[dict]:
    """Recompute on-hand per item/location from the ledger and report any mismatch with the projection."""
    signed: dict[tuple[int, int], Decimal] = {}
    for m in db.scalars(select(StockMovement)):
        if m.movement_type in (MovementType.QC_HOLD, MovementType.QC_RELEASE):
            continue
        if m.from_location_id:
            key = (m.item_id, m.from_location_id)
            signed[key] = signed.get(key, ZERO) - Decimal(m.quantity)
        if m.to_location_id:
            key = (m.item_id, m.to_location_id)
            signed[key] = signed.get(key, ZERO) + Decimal(m.quantity)
    issues = []
    balances = {(b.item_id, b.location_id): Decimal(b.qty_on_hand) for b in db.scalars(select(StockBalance))}
    for key in set(signed) | set(balances):
        ledger, proj = _q(signed.get(key, ZERO)), _q(balances.get(key, ZERO))
        if ledger != proj:
            issues.append({"item_id": key[0], "location_id": key[1], "ledger_qty": str(ledger), "balance_qty": str(proj)})
    # qty_reserved must equal the open quantity of active reservations at each balance.
    open_res: dict[tuple[int, int], Decimal] = {}
    for r in db.scalars(select(Reservation).where(Reservation.status == "ACTIVE")):
        key = (r.item_id, r.location_id)
        open_res[key] = open_res.get(key, ZERO) + r.qty_open
    reserved = {(b.item_id, b.location_id): Decimal(b.qty_reserved) for b in db.scalars(select(StockBalance))}
    for key in set(open_res) | set(reserved):
        ledger, proj = _q(open_res.get(key, ZERO)), _q(reserved.get(key, ZERO))
        if ledger != proj:
            issues.append({"item_id": key[0], "location_id": key[1], "reserved_by_reservations": str(ledger), "reserved_balance": str(proj)})
    return issues


def restock_qty(item, on_hand: Decimal, available: Decimal) -> Decimal | None:
    """Quantity to order when an item is out of stock or at/below its minimum: the restock order quantity stores
    set on the item; otherwise enough to refill to max stock (or to the minimum when no higher max is set).
    None when no restock is due or nothing is set to work it out from."""
    minimum, maximum = Decimal(item.min_stock or 0), Decimal(item.max_stock or 0)
    due = on_hand <= 0 or (minimum > 0 and available <= minimum)
    preset = Decimal(getattr(item, "restock_order_qty", 0) or 0)
    if due and preset > 0:
        return preset
    target = maximum if maximum > minimum else minimum
    if not due or target <= 0:
        return None
    return max(target - max(available, Decimal(0)), Decimal(0))
