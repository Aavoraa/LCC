"""Planning & Design WIP/PAD and production work orders (see app.services.production for the flow)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_permission
from ..models import Item, Pad, PadLine, PurchaseRequisition, SalesOrder, SalesOrderLine, StockMovement, User, WorkOrder
from ..services import process
from ..services import production as svc
from .machines import _d, _jsonable

pad_router = APIRouter(prefix="/api/pads", tags=["production"])
wo_router = APIRouter(prefix="/api/work-orders", tags=["production"])
VIEW = require_permission("production.view")


# ------------------------------------------------------------------ serializers
def _so_number(wo: WorkOrder) -> str | None:
    if wo.pad:
        return wo.pad.sales_order.number
    if wo.requisition and wo.requisition.so_line:
        return wo.requisition.so_line.so.number
    return None


def _wo_brief(wo: WorkOrder) -> dict:
    done = sum(1 for o in wo.ops if o.status == "QC_PASSED")
    current = next((o for o in wo.ops if o.status != "QC_PASSED"), None)
    return {"id": wo.id, "number": wo.number, "status": wo.status, "item_id": wo.item_id, "item_code": wo.item.item_code,
            "item_name": wo.item.name, "item_type": wo.item.item_type.value, "uom": wo.item.uom.code,
            "location_id": wo.item.default_location_id, "quantity": _d(wo.quantity), "qty_completed": _d(wo.qty_completed),
            "pad_number": wo.pad.number if wo.pad else None, "requisition_number": wo.requisition.number if wo.requisition else None,
            "requisition_status": wo.requisition.status if wo.requisition else None, "so_number": _so_number(wo),
            "required_date": wo.required_date, "ops_total": len(wo.ops), "ops_passed": done,
            "current_step": None if current is None else {"seq": current.seq, "operation": current.operation, "mode": current.mode,
                                                          "status": current.status},
            "outside_steps": sum(1 for o in wo.ops if o.mode == "OUTSIDE"), "created_at": wo.created_at, "completed_at": wo.completed_at}


def wo_out(db: Session, wo: WorkOrder) -> dict:
    est = process.estimate(db, list(wo.ops), Decimal(wo.quantity)) if wo.ops else None
    users = {u.id: u.full_name for u in db.scalars(select(User))}
    moves = db.scalars(select(StockMovement).where(StockMovement.ref_doc_type == "WIP", StockMovement.ref_doc_no == wo.number)
                       .order_by(StockMovement.id)).all()
    return _jsonable({
        **_wo_brief(wo), "notes": wo.notes, "started_at": wo.started_at, "estimate": est,
        "ops": [{"seq": o.seq, "operation": o.operation, "work_center": o.work_center, "mode": o.mode,
                 "setup_min": _d(o.setup_min), "run_min": _d(o.run_min), "outside_days": o.outside_days, "status": o.status,
                 "supplier": {"id": o.supplier.id, "name": o.supplier.name} if o.supplier else None,
                 "challan_no": o.challan_no, "rework_count": o.rework_count, "started_at": o.started_at, "done_at": o.done_at,
                 "done_by": users.get(o.done_by_id), "qc_at": o.qc_at, "qc_by": users.get(o.qc_by_id), "qc_note": o.qc_note}
                for o in wo.ops],
        "movements": [{"number": m.number, "type": m.movement_type.value, "item_id": m.item_id,
                       "item_code": m.item.item_code if m.item else None, "item_name": m.item.name if m.item else None,
                       "quantity": _d(m.quantity), "created_at": m.created_at} for m in moves],
    })


def pad_out(db: Session, pad: Pad, detail: bool = True) -> dict:
    states = [(l, svc.line_state(db, l)) for l in pad.lines]
    counts: dict[str, int] = {}
    for _, st in states:
        counts[st["status"]] = counts.get(st["status"], 0) + 1
    so = pad.sales_order
    out = {"id": pad.id, "number": pad.number, "status": pad.status, "so_id": so.id, "so_number": so.number, "customer": so.customer.name,
           "customer_po_ref": so.customer_po_ref, "committed_date": so.committed_date, "required_date": so.required_date,
           "item_id": pad.item_id, "item_code": pad.item.item_code, "item_name": pad.item.name, "quantity": _d(pad.quantity),
           "machine": {"id": pad.machine.id, "code": pad.machine.code} if pad.machine else None,
           "lines_total": len(pad.lines), "counts": counts, "notes": pad.notes, "created_at": pad.created_at, "released_at": pad.released_at}
    if detail:
        wos = {w.requisition_id: w for w in db.scalars(select(WorkOrder).where(WorkOrder.pad_id == pad.id, WorkOrder.status != "CANCELLED"))}
        out["lines"] = [{
            "id": l.id, "line_no": l.line_no, "item_id": l.item_id, "item_code": l.item.item_code if l.item else None, "name": l.name,
            "group": l.group, "item_type": l.item.item_type.value if l.item else None, "uom": l.item.uom.code if l.item else None,
            "location_id": l.item.default_location_id if l.item else None,
            "qty_required": l.qty_required, "qty_issued": l.qty_issued, **st,
            "requisition": {"number": l.requisition.number, "kind": l.requisition.kind, "status": l.requisition.status} if l.requisition else None,
            "work_order": ({"id": wos[l.requisition_id].id, "number": wos[l.requisition_id].number, "status": wos[l.requisition_id].status}
                           if l.requisition_id in wos else None),
        } for l, st in states]
    return _jsonable(out)


def _pad(db: Session, pad_id: int) -> Pad:
    pad = db.get(Pad, pad_id)
    if pad is None:
        raise HTTPException(404, "PAD not found")
    return pad


def _wo(db: Session, wo_id: int) -> WorkOrder:
    wo = db.get(WorkOrder, wo_id)
    if wo is None:
        raise HTTPException(404, "Work order not found")
    return wo


# ------------------------------------------------------------------ PAD endpoints
class PadIn(BaseModel):
    so_line_id: int
    notes: str | None = Field(default=None, max_length=1000)


class IssueIn(BaseModel):
    quantity: Decimal = Field(gt=0)
    location_id: int


class ReasonIn(BaseModel):
    reason: str


@pad_router.get("")
def list_pads(status: str | None = None, db: Session = Depends(get_db), _: User = Depends(VIEW)):
    stmt = select(Pad).order_by(Pad.id.desc()).limit(200)
    if status:
        stmt = stmt.where(Pad.status == status.upper())
    return [pad_out(db, p, detail=False) for p in db.scalars(stmt).unique()]


@pad_router.get("/candidates")
def pad_candidates(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    """Confirmed sales-order lines that have no WIP/PAD yet."""
    taken = set(db.scalars(select(Pad.so_line_id).where(Pad.status != "CANCELLED")))
    rows = []
    for so in db.scalars(select(SalesOrder).where(SalesOrder.status == "CONFIRMED").order_by(SalesOrder.id.desc())).unique():
        for l in so.lines:
            if l.id not in taken:
                rows.append({"so_line_id": l.id, "so_number": so.number, "line_no": l.line_no, "customer": so.customer.name,
                             "item_code": l.item.item_code, "item_name": l.item.name, "quantity": _d(l.quantity),
                             "item_type": l.item.item_type.value, "customer_po_ref": so.customer_po_ref})
    return rows


@pad_router.post("", status_code=201)
def create_pad(body: PadIn, db: Session = Depends(get_db), user: User = Depends(require_permission("pad.manage"))):
    line = db.get(SalesOrderLine, body.so_line_id)
    if line is None:
        raise HTTPException(404, "Sales order line not found")
    pad = svc.create_pad(db, user, line.so, line, body.notes)
    db.commit()
    return pad_out(db, pad)


@pad_router.get("/{pad_id}")
def get_pad(pad_id: int, db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return pad_out(db, _pad(db, pad_id))


@pad_router.post("/{pad_id}/release")
def release(pad_id: int, db: Session = Depends(get_db), user: User = Depends(require_permission("pad.manage"))):
    pad = svc.release_pad(db, user, _pad(db, pad_id))
    db.commit()
    return pad_out(db, pad)


@pad_router.post("/{pad_id}/shortages")
def shortages(pad_id: int, db: Session = Depends(get_db),
              user: User = Depends(require_permission("machines.requisition", "pad.manage"))):
    pad = _pad(db, pad_id)
    result = svc.raise_shortages(db, user, pad)
    db.commit()
    return {**_jsonable(result), "pad": pad_out(db, pad)}


@pad_router.post("/{pad_id}/lines/{line_id}/issue")
def issue(pad_id: int, line_id: int, body: IssueIn, db: Session = Depends(get_db), user: User = Depends(require_permission("stock.issue"))):
    pad = _pad(db, pad_id)
    line = db.get(PadLine, line_id)
    if line is None:
        raise HTTPException(404, "PAD line not found")
    svc.issue_line(db, user, pad, line, body.quantity, body.location_id)
    db.commit()
    return pad_out(db, pad)


@pad_router.post("/{pad_id}/cancel")
def cancel_pad(pad_id: int, body: ReasonIn, db: Session = Depends(get_db), user: User = Depends(require_permission("pad.manage"))):
    pad = svc.cancel_pad(db, user, _pad(db, pad_id), body.reason)
    db.commit()
    return pad_out(db, pad)


# ------------------------------------------------------------------ work orders
class WorkOrderIn(BaseModel):
    requisition_id: int | None = None
    item_id: int | None = None
    quantity: Decimal | None = Field(default=None, gt=0)
    required_date: date | None = None
    notes: str | None = Field(default=None, max_length=1000)


class OpActionIn(BaseModel):
    action: str = Field(pattern="^(start|finish|send|receive|qc)$")
    supplier_id: int | None = None
    challan_no: str | None = Field(default=None, max_length=64)
    passed: bool | None = None
    note: str | None = Field(default=None, max_length=500)


class MaterialIn(BaseModel):
    item_id: int
    quantity: Decimal = Field(gt=0)
    location_id: int


class CompleteIn(BaseModel):
    quantity: Decimal = Field(gt=0)
    location_id: int
    unit_cost: Decimal | None = Field(default=None, ge=0)


@wo_router.get("")
def list_work_orders(status: str | None = None, db: Session = Depends(get_db), _: User = Depends(VIEW)):
    stmt = select(WorkOrder).order_by(WorkOrder.id.desc()).limit(300)
    if status:
        stmt = stmt.where(WorkOrder.status.in_([s.strip().upper() for s in status.split(",")]))
    return _jsonable([_wo_brief(w) for w in db.scalars(stmt).unique()])


@wo_router.get("/open-requisitions")
def open_production_requisitions(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    """Production requisitions waiting for a work order (from sales orders, PADs or machine SOP checks)."""
    rows = db.scalars(select(PurchaseRequisition).where(PurchaseRequisition.kind == "PRODUCTION", PurchaseRequisition.status == "OPEN")
                      .order_by(PurchaseRequisition.id.desc())).all()
    return _jsonable([{"id": r.id, "number": r.number, "item_id": r.item_id, "item_code": r.item.item_code, "item_name": r.item.name,
                       "uom": r.item.uom.code, "quantity": r.quantity, "required_date": r.required_date,
                       "so_number": r.so_line.so.number if r.so_line else None, "notes": r.notes} for r in rows])


@wo_router.post("", status_code=201)
def create_work_order(body: WorkOrderIn, db: Session = Depends(get_db), user: User = Depends(require_permission("production.manage"))):
    if body.requisition_id:
        pr = db.get(PurchaseRequisition, body.requisition_id)
        if pr is None:
            raise HTTPException(404, "Requisition not found")
        wo = svc.create_work_order(db, user, pr.item, Decimal(pr.quantity), requisition=pr, notes=body.notes)
    else:
        item = db.get(Item, body.item_id) if body.item_id else None
        if item is None or body.quantity is None:
            raise HTTPException(422, "Give a production requisition, or an item and quantity")
        wo = svc.create_work_order(db, user, item, body.quantity, required_date=body.required_date, notes=body.notes)
    db.commit()
    return wo_out(db, wo)


@wo_router.get("/{wo_id}")
def get_work_order(wo_id: int, db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return wo_out(db, _wo(db, wo_id))


@wo_router.post("/{wo_id}/ops/{seq}")
def op_action(wo_id: int, seq: int, body: OpActionIn, db: Session = Depends(get_db), user: User = Depends(VIEW)):
    # QC of a step belongs to Quality; running the steps belongs to Production.
    needed = "qc.hold" if body.action == "qc" else "production.manage"
    if needed not in user.permission_codes:
        raise HTTPException(403, f"Missing permission: {needed}")
    wo = _wo(db, wo_id)
    svc.op_action(db, user, wo, seq, body.action, supplier_id=body.supplier_id, challan_no=body.challan_no, passed=body.passed, note=body.note)
    db.commit()
    return wo_out(db, wo)


@wo_router.post("/{wo_id}/materials")
def issue_material(wo_id: int, body: MaterialIn, db: Session = Depends(get_db), user: User = Depends(require_permission("stock.issue"))):
    wo = _wo(db, wo_id)
    svc.issue_material(db, user, wo, body.item_id, body.quantity, body.location_id)
    db.commit()
    return wo_out(db, wo)


@wo_router.post("/{wo_id}/complete")
def complete(wo_id: int, body: CompleteIn, db: Session = Depends(get_db), user: User = Depends(require_permission("production.manage"))):
    wo = svc.complete_work_order(db, user, _wo(db, wo_id), body.quantity, body.location_id, body.unit_cost)
    db.commit()
    return wo_out(db, wo)


@wo_router.post("/{wo_id}/cancel")
def cancel(wo_id: int, body: ReasonIn, db: Session = Depends(get_db), user: User = Depends(require_permission("production.manage"))):
    wo = svc.cancel_work_order(db, user, _wo(db, wo_id), body.reason)
    db.commit()
    return wo_out(db, wo)


# ------------------------------------------------------------------ order tracker
tracker_router = APIRouter(prefix="/api/tracker", tags=["tracker"])


@tracker_router.get("")
def tracker_list(include_closed: bool = False, db: Session = Depends(get_db), _: User = Depends(VIEW)):
    """Every sales order as a one-line progress summary with its next action."""
    from ..services.tracker import order_tracker

    stmt = select(SalesOrder).order_by(SalesOrder.id.desc()).limit(200)
    if not include_closed:
        stmt = stmt.where(SalesOrder.status.in_(("DRAFT", "CONFIRMED")))
    out = []
    for so in db.scalars(stmt).unique():
        t = order_tracker(db, so)
        out.append({"so": t["so"], "kind": t["kind"], "progress": t["progress"], "next": t["next"],
                    "stages": [{"key": s["key"], "title": s["title"], "status": s["status"]} for s in t["stages"]]})
    return _jsonable(out)


@tracker_router.get("/{so_id}")
def tracker_detail(so_id: int, db: Session = Depends(get_db), _: User = Depends(VIEW)):
    from ..services.tracker import order_tracker

    so = db.get(SalesOrder, so_id)
    if so is None:
        raise HTTPException(404, "Sales order not found")
    return _jsonable(order_tracker(db, so))
