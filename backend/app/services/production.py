"""Planning & Design WIP/PAD documents and production work orders.

Flow (matches the stores/sales automation flow chart):

1. Planning & Design creates a WIP/PAD against a confirmed sales-order line. For a machine the parts list is the
   machine's standard SOP list × order quantity; for a spares order it is the spare itself.
2. PD releases the PAD to Stores. Stores sees live availability per line and raises the shortages:
   * bought-out / consumable items → PURCHASE requisition (Purchase turns it into a PO);
   * processed spares → PRODUCTION requisition plus a work order that follows the item's process route.
3. Stores issues each part to assembly against the PAD (stock ISSUE, reference PAD-number).
4. A work order runs its route step by step. IN_HOUSE steps are started and finished on the shop floor; OUTSIDE steps
   are sent to a job-work vendor on a challan and received back. Every step needs QC before the next can start; a
   failed QC sends the step back for rework.
5. Completing the work order books the finished quantity into stores (RECEIPT, reference WIP work-order number),
   closes its requisition once fully made, refreshes delivery forecasts and allocates the stock to the waiting
   sales order.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    Item,
    ItemType,
    Location,
    Machine,
    MachineSpare,
    MovementType,
    Pad,
    PadLine,
    PurchaseRequisition,
    SalesOrder,
    SalesOrderLine,
    Supplier,
    User,
    WorkOrder,
    WorkOrderOp,
)
from . import process
from .common import BusinessError, audit, next_number, notify
from .stock import MovementInput, item_totals, post_movement

ZERO = Decimal(0)
MADE = (ItemType.PROCESSED_SPARE, ItemType.FINISHED_GOOD)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _state(msg: str) -> BusinessError:
    return BusinessError(msg, status_code=409, code="state")


# ------------------------------------------------------------------ WIP / PAD
def create_pad(db: Session, user: User, so: SalesOrder, so_line: SalesOrderLine, notes: str | None = None) -> Pad:
    if so.status != "CONFIRMED":
        raise _state(f"A WIP/PAD can only be raised against a confirmed sales order ({so.number} is {so.status.lower()})")
    if so_line.so_id != so.id:
        raise BusinessError("That line does not belong to this sales order")
    existing = db.scalar(select(Pad).where(Pad.so_line_id == so_line.id, Pad.status != "CANCELLED"))
    if existing:
        raise BusinessError(f"{existing.number} already exists for {so.number} line {so_line.line_no}", status_code=409, code="duplicate")
    units = Decimal(so_line.quantity)
    machine = db.scalar(select(Machine).where(Machine.item_id == so_line.item_id))
    pad = Pad(number=next_number(db, "pad", "PAD-", 5), sales_order_id=so.id, so_line_id=so_line.id, item_id=so_line.item_id,
              machine_id=machine.id if machine else None, quantity=units, notes=notes, created_by_id=user.id)
    if machine:  # full machine: standard SOP parts list x quantity
        for n, s in enumerate(machine.spares, start=1):
            pad.lines.append(PadLine(line_no=n, item_id=s.item_id, machine_spare_id=s.id, name=s.name, group=s.group,
                                     qty_required=Decimal(s.qty_per_machine) * units, qty_issued=ZERO))
    else:  # spares order: the spare itself
        pad.lines.append(PadLine(line_no=1, item_id=so_line.item_id, name=so_line.item.name, qty_required=units, qty_issued=ZERO))
    db.add(pad)
    db.flush()
    audit(db, user, "pad.create", "pad", pad.id, {"number": pad.number, "so": so.number, "lines": len(pad.lines)})
    return pad


def release_pad(db: Session, user: User, pad: Pad) -> Pad:
    if pad.status != "DRAFT":
        raise _state(f"{pad.number} is {pad.status.lower()}")
    pad.status, pad.released_by_id, pad.released_at = "RELEASED", user.id, _now()
    audit(db, user, "pad.release", "pad", pad.id, {"number": pad.number})
    notify(db, "pad", f"{pad.number} released to Stores", f"Verify parts for {pad.sales_order.number} — {pad.item.name}",
           role_code="STORES", entity_type="pad", entity_id=pad.id)
    return pad


def _is_made(db: Session, item: Item) -> bool:
    """Made in-house (work order) unless its route is only a bought-out procurement step."""
    if item.item_type == ItemType.FINISHED_GOOD:
        return True
    steps = process.steps_of(db, item.id)
    return bool(steps) and not any(s.operation.startswith("Procure from") for s in steps)


def _resolve_item(db: Session, line: PadLine) -> None:
    """A SOP part aligned with a stores item after the PAD was raised picks up that item now."""
    if line.item_id is None and line.machine_spare_id:
        spare = db.get(MachineSpare, line.machine_spare_id)
        if spare is not None and spare.item_id:
            line.item_id, line.item = spare.item_id, spare.item


def line_state(db: Session, line: PadLine) -> dict:
    """Live stores position of one PAD line."""
    _resolve_item(db, line)
    open_qty = Decimal(line.qty_required) - Decimal(line.qty_issued)
    if line.item is None:
        return {"status": "NOT_IN_STORE", "available": None, "shortage": open_qty, "open_qty": open_qty}
    available = max(item_totals(db, line.item_id)["available"], ZERO)
    if open_qty <= 0:
        status = "ISSUED"
    elif available >= open_qty:
        status = "AVAILABLE"
    else:
        status = "SHORT"
    return {"status": status, "available": available, "shortage": max(open_qty - available, ZERO), "open_qty": open_qty}


def raise_shortages(db: Session, user: User, pad: Pad) -> dict:
    """PURCHASE requisition for bought items, PRODUCTION requisition + work order for made items. Idempotent per line."""
    if pad.status != "RELEASED":
        raise _state(f"Release {pad.number} to Stores before raising shortages")
    purchase, production, skipped = [], [], []
    for line in pad.lines:
        st = line_state(db, line)
        if st["status"] == "NOT_IN_STORE":
            skipped.append(line.name)
            continue
        if st["shortage"] <= 0:
            continue
        if line.requisition and line.requisition.status not in ("CANCELLED",):
            continue  # already raised
        item = line.item
        made = item.item_type in MADE and _is_made(db, item)
        pr = PurchaseRequisition(number=next_number(db, "requisition", "PR-", 5), kind="PRODUCTION" if made else "PURCHASE",
                                 item_id=item.id, quantity=st["shortage"], required_date=pad.sales_order.committed_date or pad.sales_order.required_date,
                                 idempotency_key=f"PAD-LINE-{line.id}:{uuid.uuid4().hex[:8]}", status="OPEN",
                                 notes=f"Shortage on {pad.number} ({pad.sales_order.number}) line {line.line_no}", created_by_id=user.id)
        db.add(pr)
        db.flush()
        line.requisition_id, line.requisition = pr.id, pr
        if made:
            wo = create_work_order(db, user, item, st["shortage"], pad=pad, requisition=pr)
            production.append({"requisition": pr.number, "work_order": wo.number, "item_code": item.item_code, "quantity": pr.quantity})
        else:
            purchase.append({"requisition": pr.number, "item_code": item.item_code, "quantity": pr.quantity})
    if purchase:
        notify(db, "requisition", f"{len(purchase)} purchase requisition(s) from {pad.number}", None, role_code="PURCHASE",
               entity_type="pad", entity_id=pad.id)
    audit(db, user, "pad.shortages", "pad", pad.id, {"number": pad.number, "purchase": purchase, "production": production,
                                                     "not_in_store": skipped})
    return {"purchase": purchase, "production": production, "not_in_store": skipped}


def issue_line(db: Session, user: User, pad: Pad, line: PadLine, quantity: Decimal, location_id: int) -> PadLine:
    """Issue a part to the assembly department against the PAD."""
    if pad.status not in ("RELEASED", "ISSUED"):
        raise _state(f"{pad.number} must be released to Stores before issuing parts")
    if line.pad_id != pad.id:
        raise BusinessError("That line does not belong to this PAD")
    _resolve_item(db, line)
    if line.item is None:
        raise BusinessError(f"Line {line.line_no} is not linked to a stores item; align it on the Machines page first")
    open_qty = Decimal(line.qty_required) - Decimal(line.qty_issued)
    if quantity <= 0 or quantity > open_qty:
        raise BusinessError(f"Issue between 0 and {open_qty.normalize():f} {line.item.uom.code}")
    post_movement(db, user, MovementInput(txn_uuid=f"pad-{line.id}-{uuid.uuid4().hex}", movement_type=MovementType.ISSUE,
                                          item_id=line.item_id, quantity=quantity, from_location_id=location_id,
                                          ref_doc_type="PAD", ref_doc_no=pad.number, notes=f"To assembly — {pad.sales_order.number}"))
    line.qty_issued = Decimal(line.qty_issued) + quantity
    if all(l.item_id is None or Decimal(l.qty_issued) >= Decimal(l.qty_required) for l in pad.lines):
        pad.status = "ISSUED"
    db.flush()
    return line


def cancel_pad(db: Session, user: User, pad: Pad, reason: str) -> Pad:
    if pad.status == "CANCELLED":
        raise _state(f"{pad.number} is already cancelled")
    if any(Decimal(l.qty_issued) > 0 for l in pad.lines):
        raise _state("Parts have already been issued against this PAD; return them first")
    if len((reason or "").strip()) < 5:
        raise BusinessError("A reason of at least 5 characters is required")
    pad.status = "CANCELLED"
    audit(db, user, "pad.cancel", "pad", pad.id, {"number": pad.number, "reason": reason})
    return pad


# ------------------------------------------------------------------ work orders
def create_work_order(db: Session, user: User, item: Item, quantity: Decimal, *, pad: Pad | None = None,
                      requisition: PurchaseRequisition | None = None, required_date: date | None = None,
                      notes: str | None = None) -> WorkOrder:
    if item.item_type not in MADE:
        raise BusinessError("Work orders are for processed spares and finished machines")
    if quantity <= 0:
        raise BusinessError("Quantity must be greater than zero")
    if requisition is not None:
        if requisition.kind != "PRODUCTION" or requisition.status not in ("OPEN",):
            raise _state(f"{requisition.number} is not an open production requisition")
        if db.scalar(select(WorkOrder.id).where(WorkOrder.requisition_id == requisition.id, WorkOrder.status != "CANCELLED")):
            raise BusinessError(f"{requisition.number} already has a work order", status_code=409, code="duplicate")
    steps = process.steps_of(db, item.id)
    if not steps:  # no route yet: start from the standard route for this kind of part
        process.apply_standard(db, user, item)
        steps = process.steps_of(db, item.id)
    wo = WorkOrder(number=next_number(db, "work_order", "WO-", 5), item_id=item.id, quantity=quantity, qty_completed=ZERO,
                   pad_id=pad.id if pad else None, requisition_id=requisition.id if requisition else None,
                   required_date=required_date or (requisition.required_date if requisition else None), notes=notes,
                   created_by_id=user.id)
    for s in steps:
        wo.ops.append(WorkOrderOp(seq=s.seq, operation=s.operation, work_center=s.work_center, mode=s.mode, setup_min=s.setup_min,
                                  run_min=s.run_min, outside_days=s.outside_days, supplier_id=s.supplier_id, status="PENDING"))
    db.add(wo)
    if requisition is not None:
        requisition.status = "IN_PRODUCTION"
    db.flush()
    audit(db, user, "production.wo.create", "work_order", wo.id,
          {"number": wo.number, "item": item.item_code, "qty": quantity, "pad": pad.number if pad else None,
           "requisition": requisition.number if requisition else None, "ops": len(wo.ops)})
    notify(db, "work_order", f"{wo.number}: make {quantity.normalize():f} {item.uom.code} of {item.item_code}",
           f"{len(wo.ops)} process steps", role_code="PRODUCTION", entity_type="work_order", entity_id=wo.id)
    return wo


def _op(wo: WorkOrder, seq: int) -> WorkOrderOp:
    op = next((o for o in wo.ops if o.seq == seq), None)
    if op is None:
        raise BusinessError("Process step not found", status_code=404, code="not_found")
    return op


def _ready(wo: WorkOrder, op: WorkOrderOp) -> None:
    if wo.status in ("COMPLETED", "CANCELLED"):
        raise _state(f"{wo.number} is {wo.status.lower()}")
    blocking = [o for o in wo.ops if o.seq < op.seq and o.status != "QC_PASSED"]
    if blocking:
        raise _state(f"Step {blocking[0].seq} ({blocking[0].operation}) must pass QC first")


def op_action(db: Session, user: User, wo: WorkOrder, seq: int, action: str, *, supplier_id: int | None = None,
              challan_no: str | None = None, passed: bool | None = None, note: str | None = None) -> WorkOrderOp:
    """start / finish (in-house), send / receive (outside job-work), qc (pass or fail; fail = rework)."""
    op = _op(wo, seq)
    now = _now()
    if action == "start":
        _ready(wo, op)
        if op.mode != "IN_HOUSE" or op.status != "PENDING":
            raise _state(f"Step {seq} cannot be started ({op.mode.lower().replace('_', '-')}, {op.status.lower()})")
        op.status, op.started_at = "IN_PROGRESS", now
    elif action == "finish":
        if op.mode != "IN_HOUSE" or op.status != "IN_PROGRESS":
            raise _state(f"Step {seq} is not in progress")
        op.status, op.done_at, op.done_by_id = "DONE", now, user.id
    elif action == "send":
        _ready(wo, op)
        if op.mode != "OUTSIDE" or op.status != "PENDING":
            raise _state(f"Step {seq} cannot be sent to a vendor ({op.mode.lower().replace('_', '-')}, {op.status.lower()})")
        sid = supplier_id or op.supplier_id
        if not sid or db.get(Supplier, sid) is None:
            raise BusinessError("Choose the job-work vendor for this step")
        if not (challan_no or "").strip():
            raise BusinessError("Enter the delivery challan number sent with the material")
        op.status, op.supplier_id, op.challan_no, op.started_at = "AT_VENDOR", sid, challan_no.strip(), now
    elif action == "receive":
        if op.mode != "OUTSIDE" or op.status != "AT_VENDOR":
            raise _state(f"Step {seq} is not at a vendor")
        op.status, op.done_at, op.done_by_id = "DONE", now, user.id
    elif action == "qc":
        if op.status != "DONE":
            raise _state(f"Step {seq} must be finished before QC")
        if passed is None:
            raise BusinessError("Record QC as passed or failed")
        if not passed and len((note or "").strip()) < 3:
            raise BusinessError("Give the reason for the QC failure")
        op.qc_at, op.qc_by_id, op.qc_note = now, user.id, note
        if passed:
            op.status = "QC_PASSED"
        else:  # rework: the step goes back to the start
            op.status, op.rework_count, op.started_at, op.done_at = "PENDING", op.rework_count + 1, None, None
    else:
        raise BusinessError(f"Unknown action {action}")
    if wo.status == "OPEN" and action in ("start", "send"):
        wo.status, wo.started_at = "IN_PROGRESS", now
    db.flush()
    audit(db, user, f"production.op.{action}", "work_order", wo.id,
          {"number": wo.number, "seq": seq, "operation": op.operation, "status": op.status,
           **({"passed": passed, "note": note} if action == "qc" else {}),
           **({"supplier_id": op.supplier_id, "challan": op.challan_no} if action == "send" else {})})
    return op


def issue_material(db: Session, user: User, wo: WorkOrder, item_id: int, quantity: Decimal, location_id: int) -> None:
    """Raw material / bought-out input issued from stores to the work order (reference WIP)."""
    if wo.status in ("COMPLETED", "CANCELLED"):
        raise _state(f"{wo.number} is {wo.status.lower()}")
    post_movement(db, user, MovementInput(txn_uuid=f"wo-{wo.id}-{uuid.uuid4().hex}", movement_type=MovementType.ISSUE, item_id=item_id,
                                          quantity=quantity, from_location_id=location_id, ref_doc_type="WIP", ref_doc_no=wo.number,
                                          notes=f"Material for {wo.item.item_code}"))


def complete_work_order(db: Session, user: User, wo: WorkOrder, quantity: Decimal, location_id: int,
                        unit_cost: Decimal | None = None) -> WorkOrder:
    """Book made quantity into stores; close the requisition when fully made; allocate to the waiting sales order."""
    from . import sales as sales_svc

    if wo.status in ("COMPLETED", "CANCELLED"):
        raise _state(f"{wo.number} is {wo.status.lower()}")
    pending = [o for o in wo.ops if o.status != "QC_PASSED"]
    if pending:
        raise _state(f"Step {pending[0].seq} ({pending[0].operation}) has not passed QC")
    open_qty = Decimal(wo.quantity) - Decimal(wo.qty_completed)
    if quantity <= 0 or quantity > open_qty:
        raise BusinessError(f"Complete between 0 and {open_qty.normalize():f} {wo.item.uom.code}")
    if db.get(Location, location_id) is None:
        raise BusinessError("Location not found", status_code=404, code="not_found")
    post_movement(db, user, MovementInput(txn_uuid=f"wo-done-{wo.id}-{uuid.uuid4().hex}", movement_type=MovementType.RECEIPT,
                                          item_id=wo.item_id, quantity=quantity, to_location_id=location_id, unit_cost=unit_cost,
                                          ref_doc_type="WIP", ref_doc_no=wo.number, notes="Production completed, QC passed per step"),
                  _internal=True)  # gated by production.manage; every step has already passed QC
    wo.qty_completed = Decimal(wo.qty_completed) + quantity
    pr = wo.requisition
    if wo.qty_completed >= Decimal(wo.quantity):
        wo.status, wo.completed_at = "COMPLETED", _now()
        if pr is not None and pr.status in ("OPEN", "IN_PRODUCTION"):
            pr.status = "FULFILLED"
    db.flush()
    sales_svc.recalculate_forecasts(db, {wo.item_id}, user=user, reason=f"{wo.number} completed")
    so = pr.so_line.so if pr is not None and pr.so_line is not None else (wo.pad.sales_order if wo.pad and wo.pad.item_id == wo.item_id else None)
    if so is not None and so.status == "CONFIRMED":
        sales_svc.allocate_shortages(db, user, so)
    audit(db, user, "production.wo.complete", "work_order", wo.id,
          {"number": wo.number, "qty": quantity, "status": wo.status, "requisition": pr.number if pr else None,
           "requisition_status": pr.status if pr else None})
    return wo


def cancel_work_order(db: Session, user: User, wo: WorkOrder, reason: str) -> WorkOrder:
    if wo.status in ("COMPLETED", "CANCELLED"):
        raise _state(f"{wo.number} is {wo.status.lower()}")
    if len((reason or "").strip()) < 5:
        raise BusinessError("A reason of at least 5 characters is required")
    wo.status = "CANCELLED"
    if wo.requisition is not None and wo.requisition.status == "IN_PRODUCTION":
        wo.requisition.status = "OPEN"  # back to Production / Planning to decide
    audit(db, user, "production.wo.cancel", "work_order", wo.id, {"number": wo.number, "reason": reason})
    return wo
