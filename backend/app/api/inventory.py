"""Inventory Management overview (the Oracle "Overview – Inventory" work area) and cycle counts."""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_permission
from ..models import (
    ApprovalStatus,
    CycleCount,
    CycleCountLine,
    ImportBatch,
    Item,
    ItemType,
    JobWorkChallan,
    Location,
    MovementType,
    PurchaseOrder,
    PurchaseOrderLine,
    Reservation,
    SalesOrder,
    SalesOrderLine,
    StockAdjustmentRequest,
    StockBalance,
    StockMovement,
    User,
)
from ..services.common import BusinessError, audit, next_number
from ..services.company import company_profile
from ..services.osp import today_ist
from ..services.stock import request_adjustment
from .machines import _jsonable

router = APIRouter(prefix="/api/inventory", tags=["inventory"])
VIEW = require_permission("stock.view")
COUNT = require_permission("stock.adjust.request")


# ------------------------------------------------------------------ overview
@router.get("/overview")
def overview(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    today = today_ist()
    since30 = datetime.now(timezone.utc) - timedelta(days=30)
    company = company_profile(db)

    # Picks: stock earmarked for orders and not yet issued (open) vs issued against an order in the last 30 days (confirmed).
    open_res = [r for r in db.scalars(select(Reservation).where(Reservation.status == "ACTIVE")) if r.qty_open > 0]
    confirmed = db.scalar(select(func.count()).select_from(StockMovement).where(
        StockMovement.movement_type == MovementType.ISSUE, StockMovement.ref_doc_type.in_(("SALES_ORDER", "PAD")),
        StockMovement.created_at >= since30))

    counts = db.scalars(select(CycleCount).where(CycleCount.status == "OPEN")).all()

    # Receipts expected: approved PO lines with quantity still to come.
    po_lines = [l for l in db.scalars(select(PurchaseOrderLine).join(PurchaseOrder).where(PurchaseOrder.status == "APPROVED"))
                if Decimal(l.qty_ordered) > Decimal(l.qty_received)]
    received_30 = db.scalar(select(func.count()).select_from(StockMovement).where(
        StockMovement.movement_type == MovementType.RECEIPT, StockMovement.ref_doc_type == "PURCHASE_ORDER", StockMovement.created_at >= since30))

    qc_rows = db.execute(select(func.count(), func.coalesce(func.sum(StockBalance.qty_qc_hold), 0)).where(StockBalance.qty_qc_hold > 0)).one()

    # Shipments: confirmed sales-order lines still to issue, by their committed / forecast / required date.
    ship_lines = []
    for line, so in db.execute(select(SalesOrderLine, SalesOrder).join(SalesOrder, SalesOrderLine.so_id == SalesOrder.id)
                               .where(SalesOrder.status == "CONFIRMED")).all():
        if Decimal(line.quantity) - Decimal(line.qty_issued) <= 0:
            continue
        due = so.committed_date or line.forecast_date or so.forecast_date or so.required_date
        ship_lines.append((line, so, due))
    next30 = [(l, so, d) for l, so, d in ship_lines if d is not None and today <= d <= today + timedelta(days=30)]
    by_customer: dict[str, int] = defaultdict(int)
    for _, so, _ in next30:
        by_customer[so.customer.name] += 1

    osp_open = db.scalars(select(JobWorkChallan).where(JobWorkChallan.status == "SENT")).all()

    stock = select(StockBalance.item_id, func.sum(StockBalance.qty_on_hand).label("oh"),
                   func.sum(StockBalance.qty_reserved + StockBalance.qty_qc_hold).label("held")).group_by(StockBalance.item_id).subquery()
    on_hand = func.coalesce(stock.c.oh, 0)
    available = on_hand - func.coalesce(stock.c.held, 0)
    base = select(func.count()).select_from(Item).outerjoin(stock, stock.c.item_id == Item.id).where(Item.is_active.is_(True),
                                                                                                     Item.item_type != ItemType.SERVICE)
    return _jsonable({
        "organization": {"code": company["unit_code"], "name": f"{company['name']} – {company['unit_name']}"},
        "picks": {"open": len(open_res), "confirmed_30d": confirmed,
                  "open_qty_lines": [{"ref": f"{r.ref_doc_type} {r.ref_doc_no}", "item_id": r.item_id, "location": r.location.code,
                                      "qty": r.qty_open} for r in open_res[:8]]},
        "cycle_counts": {"open": len(counts), "overdue": sum(1 for c in counts if c.due_date < today),
                         "late_30d": sum(1 for c in counts if c.due_date < today - timedelta(days=30))},
        "pending": {"adjustments": db.scalar(select(func.count()).select_from(StockAdjustmentRequest)
                                             .where(StockAdjustmentRequest.status == ApprovalStatus.PENDING)),
                    "imports": db.scalar(select(func.count()).select_from(ImportBatch).where(ImportBatch.status == "VALIDATED"))},
        "receipts": {"expected_lines": len(po_lines), "overdue": sum(1 for l in po_lines if l.expected_date < today),
                     "due_7d": sum(1 for l in po_lines if today <= l.expected_date <= today + timedelta(days=7)),
                     "received_30d": received_30},
        "inspection": {"lines": qc_rows[0], "qty": Decimal(qc_rows[1])},
        "shipments": {"next_30d": len(next30), "overdue": sum(1 for _, _, d in ship_lines if d is not None and d < today),
                      "by_customer": [{"name": k, "lines": v} for k, v in sorted(by_customer.items(), key=lambda x: -x[1])[:5]]},
        "osp": {"at_vendor": len(osp_open), "overdue": sum(1 for c in osp_open if c.expected_return_date and c.expected_return_date < today)},
        "restock": {"out": db.scalar(base.where(on_hand <= 0)),
                    "below_min": db.scalar(base.where(on_hand > 0, Item.min_stock > 0, available <= Item.min_stock))},
    })


# ------------------------------------------------------------------ cycle counts
def _count(db: Session, count_id: int) -> CycleCount:
    c = db.get(CycleCount, count_id)
    if c is None:
        raise HTTPException(404, "Cycle count not found")
    return c


def count_out(db: Session, c: CycleCount, detail: bool = False) -> dict:
    counted = sum(1 for l in c.lines if l.counted_qty is not None)
    users = {u.id: u.full_name for u in db.scalars(select(User).where(User.id.in_({c.created_by_id, c.submitted_by_id} - {None})))}
    out = {"id": c.id, "number": c.number, "scope": c.scope, "due_date": c.due_date, "status": c.status, "notes": c.notes,
           "lines_total": len(c.lines), "lines_counted": counted,
           "variances": sum(1 for l in c.lines if l.adjustment_id is not None),
           "overdue": c.status == "OPEN" and c.due_date < today_ist(), "created_by": users.get(c.created_by_id),
           "created_at": c.created_at, "submitted_by": users.get(c.submitted_by_id), "submitted_at": c.submitted_at}
    if detail:
        blind = c.status == "OPEN"  # ledger quantity is hidden until the count is submitted
        out["lines"] = [{"id": l.id, "item_id": l.item_id, "item_code": l.item.item_code, "item_name": l.item.name, "uom": l.item.uom.code,
                         "location": l.location.code, "counted_qty": l.counted_qty, "system_qty": None if blind else l.system_qty,
                         "variance": None if blind or l.counted_qty is None or l.system_qty is None else Decimal(l.counted_qty) - Decimal(l.system_qty),
                         "adjustment_id": l.adjustment_id} for l in c.lines]
    return _jsonable(out)


@router.get("/cycle-counts")
def list_counts(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return [count_out(db, c) for c in db.scalars(select(CycleCount).order_by(CycleCount.id.desc()).limit(200))]


class CountIn(BaseModel):
    scope: str = Field(min_length=1, max_length=64, description="Part of a location code, e.g. MAIN-R01 or R03-B02")
    due_date: date | None = None
    notes: str | None = Field(default=None, max_length=1000)


@router.post("/cycle-counts", status_code=201)
def create_count(body: CountIn, db: Session = Depends(get_db), user: User = Depends(COUNT)):
    """Count sheet for every item held at, or assigned to, the matching locations."""
    scope = body.scope.strip().upper()
    norm = "".join(ch for ch in scope if ch.isalnum())
    locs = db.scalars(select(Location).where(Location.is_active.is_(True),
                                             func.upper(func.replace(Location.code, "-", "")).like(f"%{norm}%"))).all()
    if not locs:
        raise BusinessError(f"No location matches “{body.scope}”")
    loc_ids = {l.id for l in locs}
    pairs = {(b.item_id, b.location_id) for b in db.scalars(select(StockBalance).where(StockBalance.location_id.in_(loc_ids),
                                                                                        or_(StockBalance.qty_on_hand > 0, StockBalance.qty_qc_hold > 0)))}
    pairs |= {(i.id, i.default_location_id) for i in db.scalars(select(Item).where(Item.is_active.is_(True), Item.item_type != ItemType.SERVICE,
                                                                                  Item.default_location_id.in_(loc_ids)))}
    if not pairs:
        raise BusinessError("Nothing is stored at those locations")
    c = CycleCount(number=next_number(db, "cycle_count", "CC-", 5), scope=scope, due_date=body.due_date or today_ist(), notes=body.notes,
                   created_by_id=user.id)
    codes = {l.id: l.code for l in locs}
    items = {i.id: i.item_code for i in db.scalars(select(Item).where(Item.id.in_({p[0] for p in pairs})))}
    for item_id, loc_id in sorted(pairs, key=lambda p: (codes[p[1]], items[p[0]])):
        c.lines.append(CycleCountLine(item_id=item_id, location_id=loc_id))
    db.add(c)
    db.flush()
    audit(db, user, "cycle_count.create", "cycle_count", c.id, {"number": c.number, "scope": scope, "lines": len(c.lines)})
    db.commit()
    return count_out(db, c, detail=True)


@router.get("/cycle-counts/{count_id}")
def get_count(count_id: int, db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return count_out(db, _count(db, count_id), detail=True)


class CountEntry(BaseModel):
    line_id: int
    counted_qty: Decimal | None = Field(default=None, ge=0)


@router.put("/cycle-counts/{count_id}/lines")
def record_counts(count_id: int, body: list[CountEntry], db: Session = Depends(get_db), user: User = Depends(COUNT)):
    c = _count(db, count_id)
    if c.status != "OPEN":
        raise BusinessError(f"{c.number} is {c.status.lower()}", status_code=409, code="state")
    lines = {l.id: l for l in c.lines}
    now = datetime.now(timezone.utc)
    for e in body:
        line = lines.get(e.line_id)
        if line is None:
            raise BusinessError(f"Line {e.line_id} is not on {c.number}")
        line.counted_qty, line.counted_by_id, line.counted_at = e.counted_qty, user.id, now
    db.commit()
    return count_out(db, c, detail=True)


@router.post("/cycle-counts/{count_id}/submit")
def submit_count(count_id: int, db: Session = Depends(get_db), user: User = Depends(COUNT)):
    """Compare each count with the ledger now; every difference becomes an adjustment request for approval."""
    c = _count(db, count_id)
    if c.status != "OPEN":
        raise BusinessError(f"{c.number} is {c.status.lower()}", status_code=409, code="state")
    missing = [l for l in c.lines if l.counted_qty is None]
    if missing:
        raise BusinessError(f"{len(missing)} line(s) not counted yet — enter 0 for items not found")
    adjustments = []
    for l in c.lines:
        bal = db.scalar(select(StockBalance).where(StockBalance.item_id == l.item_id, StockBalance.location_id == l.location_id))
        l.system_qty = Decimal(bal.qty_on_hand) if bal else Decimal(0)
        delta = Decimal(l.counted_qty) - l.system_qty
        if delta != 0:
            req = request_adjustment(db, user, l.item_id, l.location_id, delta,
                                     f"Cycle count {c.number}: counted {Decimal(l.counted_qty).normalize():f}, "
                                     f"ledger {l.system_qty.normalize():f} at {l.location.code}")
            l.adjustment_id = req.id
            adjustments.append(req.number)
    c.status, c.submitted_by_id, c.submitted_at = "SUBMITTED", user.id, datetime.now(timezone.utc)
    audit(db, user, "cycle_count.submit", "cycle_count", c.id, {"number": c.number, "adjustments": adjustments})
    db.commit()
    return {**count_out(db, c, detail=True), "adjustments": adjustments}


@router.post("/cycle-counts/{count_id}/cancel")
def cancel_count(count_id: int, db: Session = Depends(get_db), user: User = Depends(COUNT)):
    c = _count(db, count_id)
    if c.status != "OPEN":
        raise BusinessError(f"{c.number} is {c.status.lower()}", status_code=409, code="state")
    c.status = "CANCELLED"
    audit(db, user, "cycle_count.cancel", "cycle_count", c.id, {"number": c.number})
    db.commit()
    return count_out(db, c)
