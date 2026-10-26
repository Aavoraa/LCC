"""OSP delivery challans (job work): register report, printable challan, transport details."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_permission
from ..models import JobWorkChallan, User
from ..services import osp as svc
from ..services.company import company_profile
from .machines import _jsonable

router = APIRouter(prefix="/api/osp", tags=["outside processing"])
VIEW = require_permission("production.view")


def _challan(db: Session, challan_id: int) -> JobWorkChallan:
    ch = db.get(JobWorkChallan, challan_id)
    if ch is None:
        raise HTTPException(404, "Challan not found")
    return ch


def challan_brief(ch: JobWorkChallan) -> dict:
    qty = sum((Decimal(l.quantity) for l in ch.lines), Decimal(0))
    wo = ch.work_order
    return {
        "id": ch.id, "number": ch.number, "challan_date": ch.challan_date, "status": ch.status,
        "supplier": {"id": ch.supplier.id, "code": ch.supplier.code, "name": ch.supplier.name},
        "process_nature": ch.process_nature, "po_number": ch.po_number, "po_date": ch.po_date, "vehicle_no": ch.vehicle_no,
        "transporter": ch.transporter, "waybill_no": ch.waybill_no, "expected_return_date": ch.expected_return_date,
        "work_order": {"id": wo.id, "number": wo.number, "status": wo.status} if wo else None, "op_seq": ch.op_seq,
        "items": ", ".join(f"{l.item.item_code if l.item else ''} {l.description}".strip() for l in ch.lines),
        "quantity": qty, "value": sum((Decimal(l.value) for l in ch.lines), Decimal(0)),
        "overdue": ch.status == "SENT" and ch.expected_return_date is not None and ch.expected_return_date < svc.today_ist(),
        "received_at": ch.received_at,
    }


@router.get("/challans")
def list_challans(date_from: date | None = None, date_to: date | None = None, number: str | None = None, po_number: str | None = None,
                  process_nature: str | None = None, vehicle_no: str | None = None, supplier_id: int | None = None,
                  status: str | None = Query(None, pattern="^(SENT|RECEIVED)$"),
                  db: Session = Depends(get_db), _: User = Depends(VIEW)):
    """LCC OSP Delivery Challan report: filter by challan date, number, PO, process nature, vehicle or vendor."""
    stmt = select(JobWorkChallan)
    if date_from:
        stmt = stmt.where(JobWorkChallan.challan_date >= date_from)
    if date_to:
        stmt = stmt.where(JobWorkChallan.challan_date <= date_to)
    if number:
        stmt = stmt.where(JobWorkChallan.number.ilike(f"%{number.strip()}%"))
    if po_number:
        stmt = stmt.where(JobWorkChallan.po_number.ilike(f"%{po_number.strip()}%"))
    if process_nature:
        stmt = stmt.where(JobWorkChallan.process_nature.ilike(f"%{process_nature.strip()}%"))
    if vehicle_no:
        stmt = stmt.where(JobWorkChallan.vehicle_no.ilike(f"%{vehicle_no.replace(' ', '').strip()}%"))
    if supplier_id:
        stmt = stmt.where(JobWorkChallan.supplier_id == supplier_id)
    if status:
        stmt = stmt.where(JobWorkChallan.status == status)
    rows = db.scalars(stmt.order_by(JobWorkChallan.challan_date.desc(), JobWorkChallan.id.desc()).limit(1000)).unique().all()
    return _jsonable([challan_brief(c) for c in rows])


def challan_out(db: Session, ch: JobWorkChallan) -> dict:
    s = ch.supplier
    creator = db.get(User, ch.created_by_id)
    return _jsonable({
        **challan_brief(ch),
        "consignee": {"name": s.name, "code": s.code, "address": s.address, "gstin": s.gstin, "phone": s.phone, "email": s.email},
        "lines": [{"line_no": l.line_no, "item_code": l.item.item_code if l.item else None, "description": l.description,
                   "hsn_code": l.hsn_code, "quantity": l.quantity, "uom": l.uom, "rate": l.rate, "value": l.value,
                   "qty_received": l.qty_received} for l in ch.lines],
        "notes": ch.notes, "created_by": creator.full_name if creator else None, "created_at": ch.created_at,
        "company": company_profile(db),
    })


@router.get("/challans/{challan_id}")
def get_challan(challan_id: int, db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return challan_out(db, _challan(db, challan_id))


class ChallanUpdateIn(BaseModel):
    po_number: str | None = Field(default=None, max_length=32)
    po_date: date | None = None
    vehicle_no: str | None = Field(default=None, max_length=20)
    transporter: str | None = Field(default=None, max_length=120)
    waybill_no: str | None = Field(default=None, max_length=64)
    expected_return_date: date | None = None
    process_nature: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=1000)


@router.patch("/challans/{challan_id}")
def update_challan(challan_id: int, body: ChallanUpdateIn, db: Session = Depends(get_db),
                   user: User = Depends(require_permission("production.manage"))):
    ch = svc.update_challan(db, user, _challan(db, challan_id), body.model_dump(exclude_unset=True))
    db.commit()
    return challan_out(db, ch)
