"""Quotations, sales orders, delivery commitments, requisitions and PO rescheduling (spec §7–8).

Routes register on the existing ``/api/sales`` and ``/api/purchase`` routers.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import require_permission
from ..models import PurchaseOrder, PurchaseOrderLine, PurchaseRequisition, Quotation, SalesEnquiry, SalesOrder, Supplier, User
from ..services import sales as sales_svc
from ..services.availability import add_working_days
from ..services.common import BusinessError, audit, get_int_setting, next_number, run_with_retry
from ..services.stock import open_reserved
from .sales_purchase import po_out, purchase_router, sales_router


# ------------------------------------------------------------------ PO rescheduling
@purchase_router.patch("/orders/{po_id}/lines/{line_id}", response_model=schemas.POOut)
def update_po_line(po_id: int, line_id: int, body: schemas.POLineUpdateIn, db: Session = Depends(get_db),
                   user: User = Depends(require_permission("purchase.manage"))):
    """Record a supplier's revised expected date; forecasts of orders depending on this supply are recalculated."""
    po = db.get(PurchaseOrder, po_id)
    line = db.get(PurchaseOrderLine, line_id)
    if po is None or line is None or line.po_id != po.id:
        raise HTTPException(404, "PO line not found")
    if po.status not in ("DRAFT", "APPROVED"):
        raise BusinessError(f"PO is {po.status.lower()}", status_code=409, code="state")
    old = line.expected_date
    if old == body.expected_date:
        return po_out(po)
    line.expected_date = body.expected_date
    audit(db, user, "purchase.po.reschedule", "purchase_order", po.id,
          {"number": po.number, "line_id": line.id, "item": line.item.item_code, "from": old, "to": body.expected_date, "reason": body.reason})
    db.flush()
    if po.status == "APPROVED":
        sales_svc.recalculate_forecasts(db, {line.item_id}, user=user,
                                        reason=f"{po.number} {line.item.item_code} rescheduled {old.isoformat()} to {body.expected_date.isoformat()}")
    db.commit()
    return po_out(po)


# ------------------------------------------------------------------ requisitions
def requisition_out(pr: PurchaseRequisition, db: Session) -> schemas.RequisitionOut:
    po_number = None
    if pr.po_line_id:
        pl = db.get(PurchaseOrderLine, pr.po_line_id)
        po_number = pl.po.number if pl else None
    return schemas.RequisitionOut(id=pr.id, number=pr.number, kind=pr.kind, item_id=pr.item_id, item_code=pr.item.item_code,
                                  item_name=pr.item.name, uom=pr.item.uom.code, quantity=pr.quantity, required_date=pr.required_date,
                                  status=pr.status, so_number=pr.so_line.so.number if pr.so_line else None, so_line_id=pr.so_line_id,
                                  po_line_id=pr.po_line_id, po_number=po_number, notes=pr.notes, created_at=pr.created_at)


def _requisition(db: Session, req_id: int) -> PurchaseRequisition:
    pr = db.get(PurchaseRequisition, req_id)
    if pr is None:
        raise HTTPException(404, "Requisition not found")
    if pr.status != "OPEN":
        raise BusinessError(f"Requisition is {pr.status.lower()}", status_code=409, code="state")
    return pr


@purchase_router.get("/requisitions", response_model=list[schemas.RequisitionOut])
def list_requisitions(status: str | None = None, db: Session = Depends(get_db), _: User = Depends(require_permission("purchase.view"))):
    stmt = select(PurchaseRequisition).order_by(PurchaseRequisition.id.desc()).limit(300)
    if status:
        stmt = stmt.where(PurchaseRequisition.status == status.upper())
    return [requisition_out(r, db) for r in db.scalars(stmt)]


@purchase_router.post("/requisitions/{req_id}/convert", response_model=schemas.POOut, status_code=201)
def convert_requisition(req_id: int, body: schemas.RequisitionConvertIn, db: Session = Depends(get_db),
                        user: User = Depends(require_permission("purchase.manage"))):
    """Raise a DRAFT PO for a purchase requisition. It counts as supply once a different user approves it."""
    pr = _requisition(db, req_id)
    if pr.kind != "PURCHASE":
        raise BusinessError("Production requisitions are fulfilled by Production, not by a purchase order", status_code=409, code="state")
    supplier_id = body.supplier_id or pr.item.supplier_id
    supplier = db.get(Supplier, supplier_id) if supplier_id else None
    if supplier is None:
        raise BusinessError("Choose a supplier: the item master has no default supplier")
    lead = pr.item.purchase_lead_days or supplier.lead_time_days or get_int_setting(db, "estimate.default_purchase_lead_days")
    expected = body.expected_date or add_working_days(db, date.today(), lead)
    po = PurchaseOrder(number=next_number(db, "purchase_order", "PO-", 5), supplier_id=supplier.id, order_date=date.today(), created_by_id=user.id)
    line = PurchaseOrderLine(item_id=pr.item_id, qty_ordered=pr.quantity, unit_price=body.unit_price, expected_date=expected)
    po.lines.append(line)
    db.add(po)
    db.flush()
    pr.status, pr.po_line_id = "ORDERED", line.id
    audit(db, user, "purchase.po.create", "purchase_order", po.id, {"number": po.number, "requisition": pr.number})
    audit(db, user, "purchase.requisition.convert", "purchase_requisition", pr.id, {"number": pr.number, "po": po.number})
    db.commit()
    db.refresh(po)
    return po_out(po)


@purchase_router.post("/requisitions/{req_id}/cancel", response_model=schemas.RequisitionOut)
def cancel_requisition(req_id: int, body: schemas.CancelIn, db: Session = Depends(get_db),
                       user: User = Depends(require_permission("purchase.manage"))):
    pr = _requisition(db, req_id)
    if len(body.reason.strip()) < 5:
        raise BusinessError("A reason of at least 5 characters is required")
    pr.status = "CANCELLED"
    audit(db, user, "purchase.requisition.cancel", "purchase_requisition", pr.id, {"number": pr.number, "reason": body.reason})
    db.commit()
    return requisition_out(pr, db)


# ------------------------------------------------------------------ quotations
def quotation_out(q: Quotation, db: Session) -> schemas.QuotationOut:
    so_id = db.scalar(select(SalesOrder.id).where(SalesOrder.quotation_id == q.id))
    return schemas.QuotationOut(id=q.id, number=q.number, enquiry_id=q.enquiry_id, enquiry_number=q.enquiry.number, customer=q.customer.name,
                                item_id=q.item_id, item_code=q.item.item_code, item_name=q.item.name, uom=q.item.uom.code,
                                quantity=q.quantity, unit_price=q.unit_price, amount=Decimal(q.quantity) * Decimal(q.unit_price),
                                valid_until=q.valid_until, preliminary_date=q.preliminary_date, risk=q.risk, status=q.status,
                                notes=q.notes, created_at=q.created_at, sales_order_id=so_id)


@sales_router.get("/quotations", response_model=list[schemas.QuotationOut])
def list_quotations(db: Session = Depends(get_db), _: User = Depends(require_permission("sales.availability"))):
    return [quotation_out(q, db) for q in db.scalars(select(Quotation).order_by(Quotation.id.desc()).limit(200))]


@sales_router.post("/quotations", response_model=schemas.QuotationOut, status_code=201)
def create_quotation(body: schemas.QuotationIn, db: Session = Depends(get_db), user: User = Depends(require_permission("sales.order"))):
    q = sales_svc.create_quotation(db, user, enquiry_id=body.enquiry_id, unit_price=body.unit_price, valid_days=body.valid_days, notes=body.notes)
    db.commit()
    return quotation_out(q, db)


@sales_router.post("/quotations/{qid}/status", response_model=schemas.QuotationOut)
def quotation_status(qid: int, body: schemas.QuotationStatusIn, db: Session = Depends(get_db),
                     user: User = Depends(require_permission("sales.order"))):
    q = db.get(Quotation, qid)
    if q is None:
        raise HTTPException(404, "Quotation not found")
    sales_svc.set_quotation_status(db, user, q, body.status)
    db.commit()
    return quotation_out(q, db)


# ------------------------------------------------------------------ sales orders
def so_out(so: SalesOrder, db: Session, *, with_requisitions: bool = False) -> schemas.SalesOrderOut:
    def name(uid: int | None) -> str | None:
        u = db.get(User, uid) if uid else None
        return u.full_name if u else None

    lines = [schemas.SOLineOut(id=l.id, line_no=l.line_no, item_id=l.item_id, item_code=l.item.item_code, item_name=l.item.name,
                               uom=l.item.uom.code, quantity=l.quantity, unit_price=l.unit_price,
                               qty_reserved=open_reserved(db, so_line_id=l.id), qty_issued=l.qty_issued, qty_shortage=l.qty_shortage,
                               forecast_date=l.forecast_date, forecast=l.forecast) for l in so.lines]
    reqs = []
    if with_requisitions:
        reqs = [requisition_out(r, db) for r in db.scalars(select(PurchaseRequisition).where(
            PurchaseRequisition.so_line_id.in_([l.id for l in so.lines])).order_by(PurchaseRequisition.id))]
    enq = db.get(SalesEnquiry, so.enquiry_id) if so.enquiry_id else None
    quote = db.get(Quotation, so.quotation_id) if so.quotation_id else None
    return schemas.SalesOrderOut(
        id=so.id, number=so.number, customer=so.customer.name, customer_id=so.customer_id, enquiry_number=enq.number if enq else None,
        quotation_number=quote.number if quote else None, customer_po_ref=so.customer_po_ref, status=so.status,
        required_date=so.required_date, preliminary_date=so.preliminary_date, forecast_date=so.forecast_date,
        forecast_risk=so.forecast_risk, forecast_updated_at=so.forecast_updated_at, at_risk=so.at_risk, commit_status=so.commit_status,
        proposed_commit_date=so.proposed_commit_date, commit_requested_by=name(so.commit_requested_by_id),
        commit_requested_by_id=so.commit_requested_by_id, committed_date=so.committed_date, commit_approved_by=name(so.commit_approved_by_id),
        commit_note=so.commit_note, total=sum((Decimal(l.quantity) * Decimal(l.unit_price) for l in so.lines), Decimal(0)),
        created_at=so.created_at, confirmed_at=so.confirmed_at, lines=lines, requisitions=reqs,
    )


def _so(db: Session, so_id: int) -> SalesOrder:
    so = db.get(SalesOrder, so_id)
    if so is None:
        raise HTTPException(404, "Sales order not found")
    return so


@sales_router.get("/orders", response_model=list[schemas.SalesOrderOut])
def list_orders(at_risk: bool | None = None, db: Session = Depends(get_db), _: User = Depends(require_permission("sales.availability"))):
    stmt = select(SalesOrder).order_by(SalesOrder.id.desc()).limit(200)
    if at_risk is not None:
        stmt = stmt.where(SalesOrder.at_risk.is_(at_risk))
    return [so_out(so, db) for so in db.scalars(stmt)]


@sales_router.get("/orders/{so_id}", response_model=schemas.SalesOrderOut)
def get_order(so_id: int, db: Session = Depends(get_db), _: User = Depends(require_permission("sales.availability"))):
    return so_out(_so(db, so_id), db, with_requisitions=True)


@sales_router.post("/orders", response_model=schemas.SalesOrderOut, status_code=201)
def create_order(body: schemas.SalesOrderIn, db: Session = Depends(get_db), user: User = Depends(require_permission("sales.order"))):
    so = sales_svc.create_sales_order(db, user, **body.model_dump())
    db.commit()
    return so_out(so, db)


@sales_router.post("/orders/{so_id}/confirm", response_model=schemas.SalesOrderOut)
def confirm_order(so_id: int, db: Session = Depends(get_db), user: User = Depends(require_permission("sales.order"))):
    """Re-validates stock and reserves atomically; retried if a concurrent transaction wins a stock row."""
    _so(db, so_id)
    run_with_retry(db, lambda: sales_svc.confirm_sales_order(db, user, db.get(SalesOrder, so_id)))
    return so_out(_so(db, so_id), db, with_requisitions=True)


@sales_router.post("/orders/{so_id}/allocate", response_model=schemas.SalesOrderOut)
def allocate_order(so_id: int, db: Session = Depends(get_db), user: User = Depends(require_permission("sales.order"))):
    """Reserve stock that has become free since confirmation (e.g. after goods receipt and QC release)."""
    _so(db, so_id)
    run_with_retry(db, lambda: sales_svc.allocate_shortages(db, user, db.get(SalesOrder, so_id)))
    return so_out(_so(db, so_id), db, with_requisitions=True)


@sales_router.post("/orders/{so_id}/recalculate", response_model=schemas.SalesOrderOut)
def recalculate_order(so_id: int, db: Session = Depends(get_db),
                      user: User = Depends(require_permission("sales.order", "sales.commit_approve"))):
    so = _so(db, so_id)
    sales_svc.recalculate_forecasts(db, {l.item_id for l in so.lines}, user=user, reason="Manual recalculation")
    db.commit()
    return so_out(so, db, with_requisitions=True)


@sales_router.post("/orders/{so_id}/cancel", response_model=schemas.SalesOrderOut)
def cancel_order(so_id: int, body: schemas.CancelIn, db: Session = Depends(get_db), user: User = Depends(require_permission("sales.order"))):
    _so(db, so_id)
    run_with_retry(db, lambda: sales_svc.cancel_sales_order(db, user, db.get(SalesOrder, so_id), body.reason))
    return so_out(_so(db, so_id), db, with_requisitions=True)


@sales_router.post("/orders/{so_id}/commit-request", response_model=schemas.SalesOrderOut)
def request_commit(so_id: int, body: schemas.CommitRequestIn, db: Session = Depends(get_db),
                   user: User = Depends(require_permission("sales.order"))):
    so = sales_svc.request_commitment(db, user, _so(db, so_id), body.committed_date, body.note)
    db.commit()
    return so_out(so, db, with_requisitions=True)


@sales_router.post("/orders/{so_id}/commit-decision", response_model=schemas.SalesOrderOut)
def decide_commit(so_id: int, body: schemas.CommitDecisionIn, db: Session = Depends(get_db),
                  user: User = Depends(require_permission("sales.commit_approve"))):
    so = sales_svc.decide_commitment(db, user, _so(db, so_id), body.approve, body.note)
    db.commit()
    return so_out(so, db, with_requisitions=True)
