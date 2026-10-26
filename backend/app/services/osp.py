"""Outside processing (OSP): job-work delivery challans for work-order steps done by a vendor.

Sending an OUTSIDE step raises a challan for the work order's open quantity; receiving the step back closes it. The
material stays in WIP the whole time (no stores movement), as in Oracle OSP. Under GST the goods move on a delivery
challan for job work (CGST Rule 45 / Section 143), not an invoice.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import JobWorkChallan, JobWorkChallanLine, User, WorkOrder, WorkOrderOp
from .common import BusinessError, audit, next_number
from .company import company_profile

IST = timezone(timedelta(hours=5, minutes=30))


def today_ist() -> date:
    return datetime.now(IST).date()


def fiscal_year(d: date) -> str:
    """Indian financial year (April–March) as ``26-27``."""
    start = d.year if d.month >= 4 else d.year - 1
    return f"{start % 100:02d}-{(start + 1) % 100:02d}"


def next_challan_number(db: Session, on: date) -> str:
    unit = company_profile(db)["unit_code"]
    fy = fiscal_year(on)
    while True:  # skip numbers already used by challans keyed in by hand
        number = next_number(db, f"jw_challan.{unit}.{fy}", f"{unit}-{fy}/", 4)
        if not db.scalar(select(JobWorkChallan.id).where(JobWorkChallan.number == number)):
            return number


def create_for_op(db: Session, user: User, wo: WorkOrder, op: WorkOrderOp, *, supplier_id: int, number: str | None = None,
                  challan_date: date | None = None, process_nature: str | None = None, po_number: str | None = None,
                  po_date: date | None = None, vehicle_no: str | None = None, transporter: str | None = None,
                  waybill_no: str | None = None, expected_return_date: date | None = None, notes: str | None = None) -> JobWorkChallan:
    on = challan_date or today_ist()
    number = (number or "").strip() or next_challan_number(db, on)
    if db.scalar(select(JobWorkChallan.id).where(JobWorkChallan.number == number)):
        raise BusinessError(f"Challan {number} already exists", status_code=409, code="duplicate")
    item = wo.item
    qty = Decimal(wo.quantity) - Decimal(wo.qty_completed)
    rate = Decimal(item.avg_cost or 0)
    ch = JobWorkChallan(
        number=number, challan_date=on, supplier_id=supplier_id, work_order_id=wo.id, op_seq=op.seq,
        process_nature=(process_nature or op.operation).strip().upper()[:120], po_number=(po_number or "").strip() or None, po_date=po_date,
        vehicle_no=(vehicle_no or "").strip().upper() or None, transporter=(transporter or "").strip() or None,
        waybill_no=(waybill_no or "").strip() or None,
        expected_return_date=expected_return_date or (on + timedelta(days=op.outside_days or 0) if op.outside_days else None),
        notes=notes, created_by_id=user.id,
    )
    ch.lines.append(JobWorkChallanLine(line_no=1, item_id=item.id, description=item.name, hsn_code=item.hsn_code, quantity=qty,
                                       uom=item.uom.code, rate=rate, value=(qty * rate).quantize(Decimal("0.01"))))
    db.add(ch)
    db.flush()
    audit(db, user, "osp.challan.create", "job_work_challan", ch.id,
          {"number": ch.number, "work_order": wo.number, "step": op.seq, "supplier_id": supplier_id, "qty": qty})
    return ch


def receive_for_op(db: Session, user: User, wo: WorkOrder, op: WorkOrderOp) -> JobWorkChallan | None:
    ch = db.scalar(select(JobWorkChallan).where(JobWorkChallan.work_order_id == wo.id, JobWorkChallan.op_seq == op.seq,
                                                JobWorkChallan.status == "SENT").order_by(JobWorkChallan.id.desc()))
    if ch is None:
        return None
    for line in ch.lines:
        line.qty_received = line.quantity
    ch.status, ch.received_at = "RECEIVED", datetime.now(timezone.utc)
    audit(db, user, "osp.challan.receive", "job_work_challan", ch.id, {"number": ch.number, "work_order": wo.number})
    return ch


EDITABLE = ("po_number", "po_date", "vehicle_no", "transporter", "waybill_no", "expected_return_date", "process_nature", "notes")


def update_challan(db: Session, user: User, ch: JobWorkChallan, changes: dict) -> JobWorkChallan:
    """Transport details are usually known only when the vehicle is loaded, so they stay editable."""
    before = {k: getattr(ch, k) for k in changes}
    for key, value in changes.items():
        if key not in EDITABLE:
            raise BusinessError(f"{key} cannot be changed")
        if isinstance(value, str):
            value = value.strip() or None
            if key == "vehicle_no" and value:
                value = value.upper()
            if key == "process_nature":
                if not value:
                    raise BusinessError("Process nature cannot be empty")
                value = value.upper()
        setattr(ch, key, value)
    audit(db, user, "osp.challan.update", "job_work_challan", ch.id, {"number": ch.number, "before": before, "after": changes})
    return ch
