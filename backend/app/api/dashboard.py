"""Executive dashboard and operational lists. Every figure comes from a live query.

Metrics owned by modules that are not built yet (accounts, production, outside processing)
are returned as ``null`` with ``available: false`` so the UI never shows invented numbers.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user, require_permission
from ..models import (
    ApprovalStatus,
    AuditEvent,
    Customer,
    ImportBatch,
    Item,
    Notification,
    PurchaseOrder,
    PurchaseRequisition,
    SalesEnquiry,
    SalesOrder,
    StockAdjustmentRequest,
    StockBalance,
    StockMovement,
    User,
)
from .serializers import movement_out

router = APIRouter(prefix="/api", tags=["dashboard"])

NOT_BUILT = {"value": None, "available": False, "note": "Module not implemented yet"}


def _d(v) -> str:
    return format(Decimal(v or 0).quantize(Decimal("0.01")).normalize(), "f")


@router.get("/dashboard/summary")
def summary(days: int = Query(14, ge=7, le=90, description="Days in the stock-movement series"),
            db: Session = Depends(get_db), _: User = Depends(require_permission("dashboard.view"))):
    per_item = (
        select(
            Item.id, Item.item_type, Item.reorder_level, Item.avg_cost,
            func.coalesce(func.sum(StockBalance.qty_on_hand), 0).label("oh"),
            func.coalesce(func.sum(StockBalance.qty_reserved), 0).label("res"),
            func.coalesce(func.sum(StockBalance.qty_qc_hold), 0).label("qc"),
        )
        .outerjoin(StockBalance, StockBalance.item_id == Item.id)
        .where(Item.is_active.is_(True))
        .group_by(Item.id)
    )
    rows = db.execute(per_item).all()
    valuation = Decimal(0)
    on_hand_total = reserved_total = qc_total = Decimal(0)
    low = out = 0
    by_type: dict[str, Decimal] = {}
    for _id, itype, rol, avg, oh, res, qc in rows:
        oh, res, qc = Decimal(oh), Decimal(res), Decimal(qc)
        val = oh * Decimal(avg or 0)
        valuation += val
        by_type[itype.value] = by_type.get(itype.value, Decimal(0)) + val
        on_hand_total += oh
        reserved_total += res
        qc_total += qc
        if oh <= 0:
            out += 1
        elif oh - res - qc <= Decimal(rol or 0):
            low += 1

    since = datetime.now(timezone.utc) - timedelta(days=days - 1)
    daily: dict[str, dict[str, int]] = {}
    for d in range(days):
        key = (since + timedelta(days=d)).date().isoformat()
        daily[key] = {"in": 0, "out": 0}
    for mtype, created in db.execute(select(StockMovement.movement_type, StockMovement.created_at).where(StockMovement.created_at >= since.replace(hour=0, minute=0, second=0))):
        key = created.date().isoformat()
        if key in daily:
            bucket = "in" if mtype.value in ("RECEIPT", "OPENING", "RETURN", "ADJUSTMENT_IN") else "out" if mtype.value in ("ISSUE", "ADJUSTMENT_OUT") else None
            if bucket:
                daily[key][bucket] += 1

    recent = db.scalars(select(StockMovement).order_by(StockMovement.id.desc()).limit(8))
    pending_adj = db.scalar(select(func.count()).where(StockAdjustmentRequest.status == ApprovalStatus.PENDING))
    pending_imports = db.scalar(select(func.count()).select_from(ImportBatch).where(ImportBatch.status == "VALIDATED"))
    open_pos = db.scalar(select(func.count()).select_from(PurchaseOrder).where(PurchaseOrder.status.in_(("DRAFT", "APPROVED"))))
    draft_pos = db.scalar(select(func.count()).select_from(PurchaseOrder).where(PurchaseOrder.status == "DRAFT"))
    open_enq = db.scalar(select(func.count()).select_from(SalesEnquiry).where(SalesEnquiry.status == "OPEN"))
    # At-risk = confirmed orders whose recalculated forecast is later than the committed (or required) date.
    at_risk_rows = db.execute(
        select(SalesOrder.id, SalesOrder.number, Customer.name, SalesOrder.forecast_date, SalesOrder.committed_date, SalesOrder.required_date)
        .join(Customer, SalesOrder.customer_id == Customer.id)
        .where(SalesOrder.status == "CONFIRMED", SalesOrder.at_risk.is_(True))
        .order_by(SalesOrder.forecast_date.desc()).limit(10)
    ).all()
    at_risk = db.scalar(select(func.count()).select_from(SalesOrder).where(SalesOrder.status == "CONFIRMED", SalesOrder.at_risk.is_(True)))
    open_sos = db.scalar(select(func.count()).select_from(SalesOrder).where(SalesOrder.status.in_(("DRAFT", "CONFIRMED"))))
    pending_commits = db.scalar(select(func.count()).select_from(SalesOrder).where(SalesOrder.commit_status == "PENDING"))
    open_reqs = db.scalar(select(func.count()).select_from(PurchaseRequisition).where(PurchaseRequisition.status == "OPEN"))
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "inventory_valuation": _d(valuation),
        "total_items": len(rows),
        "low_stock_items": low,
        "out_of_stock_items": out,
        "stock_on_hand_qty": _d(on_hand_total),
        "reserved_qty": _d(reserved_total),
        "qc_hold_qty": _d(qc_total),
        "available_qty": _d(on_hand_total - reserved_total - qc_total),
        "valuation_by_type": {k: _d(v) for k, v in by_type.items()},
        "movements_days": days,
        "movements_14d": [{"date": k, **v} for k, v in daily.items()],  # name kept for older clients; holds `days` entries
        "recent_movements": [movement_out(m).model_dump(mode="json") for m in recent],
        "pending_adjustments": pending_adj,
        "pending_import_approvals": pending_imports,
        "open_purchase_orders": open_pos,
        "purchase_orders_awaiting_approval": draft_pos,
        "goods_pending_qc_qty": _d(qc_total),
        "open_enquiries": open_enq,
        "orders_at_risk": at_risk,
        "orders_at_risk_list": [{"id": i, "number": n, "customer": c, "forecast_date": f, "target_date": cd or rd,
                                 "target": "committed" if cd else "required"} for i, n, c, f, cd, rd in at_risk_rows],
        "open_sales_orders": open_sos,
        "pending_commit_approvals": pending_commits,
        "open_requisitions": open_reqs,
        "work_in_progress": NOT_BUILT,
        "outside_processing_outstanding": NOT_BUILT,
        "accounts_receivable": NOT_BUILT,
        "accounts_payable": NOT_BUILT,
        "cash_and_bank": NOT_BUILT,
        "invoice_extraction_pending": NOT_BUILT,
    }


@router.get("/notifications")
def notifications(db: Session = Depends(get_db), user: User = Depends(current_user)):
    roles = [r.code for r in user.roles]
    stmt = select(Notification).where(or_(Notification.user_id == user.id, Notification.role_code.in_(roles)))
    if "SUPER_ADMIN" in roles:
        stmt = select(Notification)
    rows = db.scalars(stmt.order_by(Notification.id.desc()).limit(50))
    return [{"id": n.id, "kind": n.kind, "title": n.title, "body": n.body, "entity_type": n.entity_type, "entity_id": n.entity_id,
             "is_read": n.is_read, "created_at": n.created_at} for n in rows]


@router.post("/notifications/{nid}/read")
def mark_read(nid: int, db: Session = Depends(get_db), _: User = Depends(current_user)):
    n = db.get(Notification, nid)
    if n:
        n.is_read = True
        db.commit()
    return {"ok": True}


@router.get("/audit")
def audit_trail(entity_type: str | None = None, entity_id: str | None = None, action: str | None = None,
                page: int = Query(1, ge=1), page_size: int = Query(50, le=500),
                db: Session = Depends(get_db), _: User = Depends(require_permission("audit.view"))):
    stmt = select(AuditEvent)
    if entity_type:
        stmt = stmt.where(AuditEvent.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AuditEvent.entity_id == entity_id)
    if action:
        stmt = stmt.where(AuditEvent.action.ilike(f"{action}%"))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(AuditEvent.id.desc()).offset((page - 1) * page_size).limit(page_size))
    return {"total": total, "events": [{"id": e.id, "at": e.at, "user": e.user.full_name if e.user else None, "action": e.action,
                                        "entity_type": e.entity_type, "entity_id": e.entity_id, "data": e.data} for e in rows]}
