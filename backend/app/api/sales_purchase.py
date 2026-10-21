from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import require_permission
from ..models import Customer, Item, MovementType, PurchaseOrder, PurchaseOrderLine, SalesEnquiry, Supplier, User
from ..services import sales as sales_svc
from ..services.availability import availability, estimate_delivery
from ..services.common import BusinessError, audit, next_number
from ..services.stock import MovementInput, post_movement

sales_router = APIRouter(prefix="/api/sales", tags=["sales"])
purchase_router = APIRouter(prefix="/api/purchase", tags=["purchase"])


def _item(db: Session, item_id: int) -> Item:
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "Item not found")
    return item


def _jsonable_estimate(est: dict) -> dict:
    def conv(v):
        if isinstance(v, Decimal):
            return format(v.normalize(), "f")
        if isinstance(v, date):
            return v.isoformat()
        if isinstance(v, dict):
            return {k: conv(x) for k, x in v.items()}
        if isinstance(v, list):
            return [conv(x) for x in v]
        return v

    return conv(est)


# ------------------------------------------------------------------ sales
@sales_router.get("/availability/{item_id}")
def item_availability(item_id: int, quantity: Decimal | None = None, db: Session = Depends(get_db),
                      _: User = Depends(require_permission("sales.availability"))):
    return _jsonable_estimate(availability(db, _item(db, item_id), quantity))


@sales_router.post("/estimate")
def estimate(body: schemas.EstimateIn, db: Session = Depends(get_db), _: User = Depends(require_permission("sales.availability"))):
    customer = db.get(Customer, body.customer_id) if body.customer_id else None
    return _jsonable_estimate(estimate_delivery(db, _item(db, body.item_id), body.quantity, customer=customer, required_date=body.required_date))


def enquiry_out(e: SalesEnquiry) -> schemas.EnquiryOut:
    return schemas.EnquiryOut(id=e.id, number=e.number, customer=e.customer.name, reference=e.reference, item_code=e.item.item_code,
                              item_name=e.item.name, quantity=e.quantity, required_date=e.required_date, estimated_date=e.estimated_date,
                              risk=e.risk, status=e.status, created_at=e.created_at, estimate=e.estimate)


@sales_router.post("/enquiries", response_model=schemas.EnquiryOut, status_code=201)
def create_enquiry(body: schemas.EnquiryIn, db: Session = Depends(get_db), user: User = Depends(require_permission("sales.enquiry"))):
    customer = db.get(Customer, body.customer_id)
    if customer is None:
        raise HTTPException(404, "Customer not found")
    item = _item(db, body.item_id)
    est = estimate_delivery(db, item, body.quantity, customer=customer, required_date=body.required_date)
    enq = SalesEnquiry(number=next_number(db, "sales_enquiry", "ENQ-", 5), created_by_id=user.id, estimate=_jsonable_estimate(est),
                       estimated_date=est["estimated_date"], risk=est["risk"], **body.model_dump())
    db.add(enq)
    db.flush()
    audit(db, user, "sales.enquiry.create", "sales_enquiry", enq.id, {"number": enq.number, "item": item.item_code, "qty": body.quantity})
    db.commit()
    return enquiry_out(enq)


@sales_router.get("/enquiries", response_model=list[schemas.EnquiryOut])
def list_enquiries(db: Session = Depends(get_db), _: User = Depends(require_permission("sales.availability"))):
    return [enquiry_out(e) for e in db.scalars(select(SalesEnquiry).order_by(SalesEnquiry.id.desc()).limit(200))]


# ------------------------------------------------------------------ purchase
def po_out(po: PurchaseOrder) -> schemas.POOut:
    lines = [schemas.POLineOut(id=l.id, item_id=l.item_id, item_code=l.item.item_code, item_name=l.item.name, qty_ordered=l.qty_ordered,
                               qty_received=l.qty_received, unit_price=l.unit_price, expected_date=l.expected_date) for l in po.lines]
    total = sum((Decimal(l.qty_ordered) * Decimal(l.unit_price) for l in po.lines), Decimal(0))
    return schemas.POOut(id=po.id, number=po.number, supplier=po.supplier.name, status=po.status, order_date=po.order_date, total=total, lines=lines)


@purchase_router.get("/orders", response_model=list[schemas.POOut])
def list_pos(db: Session = Depends(get_db), _: User = Depends(require_permission("purchase.view"))):
    return [po_out(p) for p in db.scalars(select(PurchaseOrder).order_by(PurchaseOrder.id.desc()).limit(200))]


@purchase_router.post("/orders", response_model=schemas.POOut, status_code=201)
def create_po(body: schemas.POIn, db: Session = Depends(get_db), user: User = Depends(require_permission("purchase.manage"))):
    if db.get(Supplier, body.supplier_id) is None:
        raise HTTPException(404, "Supplier not found")
    po = PurchaseOrder(number=next_number(db, "purchase_order", "PO-", 5), supplier_id=body.supplier_id, order_date=date.today(), created_by_id=user.id)
    for line in body.lines:
        _item(db, line.item_id)
        po.lines.append(PurchaseOrderLine(**line.model_dump()))
    db.add(po)
    db.flush()
    audit(db, user, "purchase.po.create", "purchase_order", po.id, {"number": po.number})
    db.commit()
    db.refresh(po)
    return po_out(po)


@purchase_router.post("/orders/{po_id}/approve", response_model=schemas.POOut)
def approve_po(po_id: int, db: Session = Depends(get_db), user: User = Depends(require_permission("purchase.approve"))):
    po = db.get(PurchaseOrder, po_id)
    if po is None:
        raise HTTPException(404, "PO not found")
    if po.status != "DRAFT":
        raise BusinessError(f"PO is {po.status.lower()}", status_code=409, code="state")
    if po.created_by_id == user.id:
        raise BusinessError("Maker–checker: you cannot approve a PO you created", status_code=403, code="forbidden")
    po.status, po.approved_by_id = "APPROVED", user.id
    audit(db, user, "purchase.po.approve", "purchase_order", po.id, {"number": po.number})
    db.flush()
    sales_svc.recalculate_forecasts(db, {l.item_id for l in po.lines}, user=user, reason=f"{po.number} approved")
    db.commit()
    return po_out(po)


class ReceiveIn(BaseModel):
    line_id: int
    quantity: Decimal = Field(gt=0)
    to_location_id: int
    into_qc_hold: bool = True
    txn_uuid: str | None = None


@purchase_router.post("/orders/{po_id}/receive", response_model=schemas.MovementResult)
def receive_po(po_id: int, body: ReceiveIn, db: Session = Depends(get_db), user: User = Depends(require_permission("stock.receive"))):
    """Goods receipt against an approved PO line. Received stock goes to QC hold by default."""
    po = db.get(PurchaseOrder, po_id)
    line = db.get(PurchaseOrderLine, body.line_id)
    if po is None or line is None or line.po_id != po.id:
        raise HTTPException(404, "PO line not found")
    if po.status != "APPROVED":
        raise BusinessError("Goods can only be received against an approved PO")
    open_qty = Decimal(line.qty_ordered) - Decimal(line.qty_received)
    if body.quantity > open_qty:
        raise BusinessError(f"Only {open_qty.normalize():f} remains open on this PO line")
    movement, created = post_movement(db, user, MovementInput(
        txn_uuid=body.txn_uuid or f"grn-{uuid.uuid4()}", movement_type=MovementType.RECEIPT, item_id=line.item_id, quantity=body.quantity,
        to_location_id=body.to_location_id, unit_cost=Decimal(line.unit_price), ref_doc_type="PURCHASE_ORDER", ref_doc_no=po.number,
        into_qc_hold=body.into_qc_hold,
    ))
    if created:
        line.qty_received = Decimal(line.qty_received) + body.quantity
        if all(Decimal(l.qty_received) >= Decimal(l.qty_ordered) for l in po.lines):
            po.status = "CLOSED"
        db.flush()
        sales_svc.recalculate_forecasts(db, {line.item_id}, user=user, reason=f"Goods received on {po.number}")
    db.commit()
    from .serializers import movement_out, totals

    return schemas.MovementResult(movement=movement_out(movement), created=created, totals=totals(db, line.item))
