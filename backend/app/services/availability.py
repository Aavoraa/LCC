"""Available-to-promise and rule-based delivery estimation (spec §7).

Policy: available = on_hand − reserved − qc_hold. Incoming PO quantities are reported
separately and never treated as immediately available. Estimates are derived only from
configured rules and recorded data — no AI involvement.

Confirmed sales orders reuse ``estimate_delivery`` for their forecasts by passing the shortage
left after reservation and the incoming supply pegged to that order line (see services.sales).
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Customer, Holiday, Item, ItemType, PurchaseOrder, PurchaseOrderLine, Reservation
from .common import get_int_setting
from .stock import item_totals


def add_working_days(db: Session, start: date, days: int) -> date:
    holidays = set(db.scalars(select(Holiday.day).where(Holiday.day >= start)))
    current, remaining = start, days
    while remaining > 0:
        current += timedelta(days=1)
        if current.weekday() == 6 or current in holidays:  # Sunday off
            continue
        remaining -= 1
    return current


def incoming_supply(db: Session, item_id: int) -> list[dict]:
    rows = db.execute(
        select(PurchaseOrderLine, PurchaseOrder)
        .join(PurchaseOrder, PurchaseOrderLine.po_id == PurchaseOrder.id)
        .where(PurchaseOrderLine.item_id == item_id, PurchaseOrder.status == "APPROVED")
        .order_by(PurchaseOrderLine.expected_date)
    ).all()
    out = []
    for line, po in rows:
        open_qty = Decimal(line.qty_ordered) - Decimal(line.qty_received)
        if open_qty > 0:
            out.append({"po_number": po.number, "po_line_id": line.id, "supplier": po.supplier.name, "open_qty": open_qty,
                        "expected_date": line.expected_date})
    return out


def availability(db: Session, item: Item, requested_qty: Decimal | None = None) -> dict:
    totals = item_totals(db, item.id)
    incoming = incoming_supply(db, item.id)
    committed: dict[str, Decimal] = {}
    for r in db.scalars(select(Reservation).where(Reservation.item_id == item.id, Reservation.status == "ACTIVE").order_by(Reservation.id)):
        ref = f"{r.ref_doc_type} {r.ref_doc_no}"
        committed[ref] = committed.get(ref, Decimal(0)) + r.qty_open
    available = max(totals["available"], Decimal(0))
    shortage = max(Decimal(requested_qty or 0) - available, Decimal(0))
    return {
        "item_id": item.id,
        "item_code": item.item_code,
        "item_name": item.name,
        "uom": item.uom.code,
        "physical": totals["on_hand"],
        "reserved": totals["reserved"],
        "quality_hold": totals["qc_hold"],
        "available_to_promise": available,
        "incoming_total": sum((i["open_qty"] for i in incoming), Decimal(0)),
        "incoming": incoming,
        "committed_demand": [{"ref": ref, "quantity": q} for ref, q in committed.items() if q > 0],
        "requested": requested_qty,
        "shortage": shortage,
    }


def estimate_delivery(db: Session, item: Item, qty: Decimal, *, customer: Customer | None = None,
                      required_date: date | None = None, start: date | None = None,
                      shortage: Decimal | None = None, incoming: list[dict] | None = None) -> dict:
    """``shortage``/``incoming`` override the live ATP view: a confirmed order passes the quantity
    still unreserved and the supply pegged to it, so other demand cannot be double-counted."""
    start = start or date.today()
    avail = availability(db, item, qty)
    for_order = shortage is not None
    if shortage is None:
        shortage = avail["shortage"]
    if incoming is None:
        incoming = avail["incoming"]
    qc = get_int_setting(db, "estimate.qc_days")
    pack = get_int_setting(db, "estimate.packing_days")
    dispatch = get_int_setting(db, "estimate.dispatch_days")
    transport = customer.transport_days if customer else get_int_setting(db, "estimate.default_transport_days")

    steps: list[dict] = []
    assumptions: list[str] = [
        "Working calendar excludes Sundays and configured holidays.",
        "Available-to-promise excludes reserved and quality-hold stock; incoming POs are not counted as on hand.",
    ]
    dependencies: list[str] = []
    cursor = start
    risk = "LOW"

    def step(label: str, days: int, owner: str) -> None:
        nonlocal cursor
        cursor = add_working_days(db, cursor, days) if days > 0 else cursor
        steps.append({"step": label, "days": days, "owner": owner, "complete_by": cursor})

    if item.item_type == ItemType.SERVICE:
        assumptions.append("Service item: no stock check performed.")
    elif shortage <= 0:
        assumptions.append(f"{qty.normalize():f} {item.uom.code} " + ("reserved from stock for this order." if for_order else "available from stock now."))
    else:
        dependencies.append(f"Shortage of {shortage.normalize():f} {item.uom.code}")
        remaining = shortage
        covering: list[dict] = []
        for inc in incoming:
            if remaining <= 0:
                break
            covering.append(inc)
            remaining -= inc["open_qty"]
        if remaining <= 0 and covering:
            arrival = max(c["expected_date"] for c in covering)
            dependencies += [c.get("label") or f"PO {c['po_number']} ({c['supplier']}) due {c['expected_date'].isoformat()}" for c in covering]
            if arrival > cursor:
                steps.append({"step": "Await incoming purchase receipt", "days": (arrival - cursor).days, "owner": "Purchase", "complete_by": arrival})
                cursor = arrival
            step("Goods receipt inspection", qc, "QC")
            risk = "MEDIUM"
            assumptions.append("Shortage covered by approved purchase orders; estimate depends on supplier delivering on time.")
        else:
            lead = item.purchase_lead_days or (item.supplier.lead_time_days if item.supplier else None) \
                or get_int_setting(db, "estimate.default_purchase_lead_days")
            produced = item.item_type in (ItemType.PROCESSED_SPARE, ItemType.FINISHED_GOOD)
            if produced and item.production_lead_days:
                step("Material planning & procurement approval", get_int_setting(db, "estimate.procurement_approval_days"), "Planning")
                step("Production / process route", item.production_lead_days, "Production")
                step("In-process QC and rework allowance", get_int_setting(db, "estimate.rework_allowance_days"), "QC")
                assumptions.append(f"Production lead time of {item.production_lead_days} working days"
                                   f"{' from its process route' if item.item_type == ItemType.PROCESSED_SPARE else ' from item master'}; "
                                   "work-centre capacity and job-work vendor load are not checked.")
                dependencies.append("Production capacity and raw-material availability")
            else:
                step("Procurement approval & PO release", get_int_setting(db, "estimate.procurement_approval_days"), "Purchase")
                step("Supplier lead time", lead, "Supplier")
                step("Goods receipt inspection", qc, "QC")
                assumptions.append(f"Supplier lead time of {lead} working days"
                                   f"{' from ' + item.supplier.name if item.supplier and not item.purchase_lead_days else ''}.")
                dependencies.append(f"New purchase of {remaining.normalize():f} {item.uom.code}")
            risk = "HIGH"

    step("Final QC", qc, "QC")
    step("Packing", pack, "Stores")
    step("Dispatch", dispatch, "Logistics")
    step("Transport to customer", transport, "Logistics")

    on_time = None
    if required_date:
        on_time = cursor <= required_date
        if not on_time:
            risk = "HIGH"
            dependencies.append(f"Estimated date is {(cursor - required_date).days} day(s) after the required date")
    return {
        "preliminary": True,
        "estimated_date": cursor,
        "risk": risk,
        "meets_required_date": on_time,
        "steps": steps,
        "assumptions": assumptions,
        "critical_dependencies": dependencies,
        "availability": avail,
    }
