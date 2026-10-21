"""Machine SOP spare lists: alignment with the stores item master, stores checks and shortage requisitions.

Alignment rules (never guess silently):
* a spare links automatically only to an item whose normalized name matches exactly, or to the
  item named by an explicit ``store_item`` hint in the catalogue data;
* similar names are returned as *suggestions* for a person to confirm;
* a spare with no match can be created in stores as a new item (zero stock) — the item gets a
  normal item code and QR label, and stock arrives through the usual receipt workflow.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Item, ItemCategory, ItemType, Machine, MachineSpare, PurchaseRequisition, Uom, User
from .common import BusinessError, audit, next_number, normalize_name
from .items import create_item, find_duplicates
from .stock import item_totals

SPARE_CATEGORY = "Card Service Spares"
GROUP_ITEM_TYPE = {
    "WEAR": ItemType.PURCHASED_ITEM, "TOOLING": ItemType.PURCHASED_ITEM, "MECHANICAL": ItemType.PROCESSED_SPARE,
    "ELECTRICAL": ItemType.PURCHASED_ITEM, "PNEUMATIC": ItemType.PURCHASED_ITEM, "INSPECTION": ItemType.PURCHASED_ITEM,
    "CONSUMABLE": ItemType.DAILY_CONSUMABLE,
    # Build-standard hardware (app.machine_hardware): fasteners and powder-coated sheet metal are processed in-house.
    "FASTENER": ItemType.PROCESSED_SPARE, "FABRICATION": ItemType.PROCESSED_SPARE,
}


def required_qty(spare: MachineSpare, units: int) -> Decimal:
    return Decimal(spare.sop_stock) * units


def exact_item_match(db: Session, spare: MachineSpare) -> Item | None:
    return db.scalar(select(Item).where(Item.name_normalized == spare.name_normalized, Item.is_active.is_(True)).limit(1))


def suggestions(db: Session, spare: MachineSpare, limit: int = 3) -> list[dict]:
    # An item already aligned to a differently named spare is a distinct catalogue part, not a candidate.
    taken = set(db.scalars(select(MachineSpare.item_id).where(
        MachineSpare.item_id.is_not(None), MachineSpare.name_normalized != spare.name_normalized)))
    return [{"item_id": c.item.id, "item_code": c.item.item_code, "name": c.item.name, "score": c.score, "reason": c.reason}
            for c in find_duplicates(db, spare.name, limit=limit + len(taken)) if c.item.id not in taken][:limit]


def _spare_category(db: Session) -> ItemCategory:
    cat = db.scalar(select(ItemCategory).where(ItemCategory.name == SPARE_CATEGORY, ItemCategory.parent_id.is_(None)))
    if cat is None:
        cat = ItemCategory(name=SPARE_CATEGORY)
        db.add(cat)
        db.flush()
    return cat


def create_store_item(db: Session, user: User, spare: MachineSpare) -> Item:
    """Create the stores item for a spare and link it. Duplicate review happens before this is called."""
    uom = db.scalar(select(Uom).where(Uom.code == spare.uom_code)) or db.scalar(select(Uom).where(Uom.code == "NOS"))
    item = create_item(db, user, {
        "name": spare.name,
        "item_type": GROUP_ITEM_TYPE.get(spare.group, ItemType.PURCHASED_ITEM).value,
        "uom_id": uom.id,
        "category_id": _spare_category(db).id,
        "description": f"SOP spare for {spare.machine.name} ({spare.part_no})",
        "specifications": spare.notes,
        "reorder_level": Decimal(spare.sop_stock),
        "min_stock": Decimal(spare.sop_stock),
    }, reviewed=True)
    return item


# The catalogue gives no build lead time; this placeholder feeds the delivery estimator until Planning sets the real
# figure on the machine's item (Inventory → item → production lead time).
MACHINE_PRODUCTION_LEAD_DAYS = 30


def ensure_machine_item(db: Session, user: User, machine: Machine) -> Item:
    """Link the machine to its sellable finished-good item, creating it if no item has exactly that name."""
    if machine.item is not None:
        return machine.item
    item = db.scalar(select(Item).where(Item.name_normalized == normalize_name(machine.name), Item.is_active.is_(True)).limit(1))
    if item is None:
        cat = db.scalar(select(ItemCategory).where(ItemCategory.name == "Machines", ItemCategory.parent_id.is_(None)))
        nos = db.scalar(select(Uom).where(Uom.code == "NOS"))
        item = create_item(db, user, {
            "name": machine.name,
            "item_type": ItemType.FINISHED_GOOD.value,
            "uom_id": nos.id,
            "category_id": cat.id if cat else None,
            "make_model": machine.models,
            "description": f"{machine.family} — {machine.code}. {machine.description or ''}".strip(),
            "specifications": "; ".join(f"{k}: {v}" for k, v in (machine.specifications or {}).items()) or None,
            "production_lead_days": MACHINE_PRODUCTION_LEAD_DAYS,
        }, reviewed=True)
    machine.item = item
    machine.item_id = item.id
    audit(db, user, "machine.item.link", "machine", machine.id, {"item_id": item.id, "item_code": item.item_code})
    return item


def link(db: Session, user: User, spare: MachineSpare, item: Item | None, how: str) -> None:
    before = spare.item_id
    spare.item = item  # set the relationship (not just the FK) so the response reflects it immediately
    spare.item_id = item.id if item else None
    audit(db, user, f"machine.spare.{how}", "machine_spare", spare.id,
          {"machine": spare.machine.code, "part_no": spare.part_no, "item_before": before, "item_after": spare.item_id})


def align_machine(db: Session, user: User, machine: Machine, *, create_missing: bool) -> dict:
    """Link every unaligned spare by exact name; optionally create the rest in stores.
    Spares whose name is merely *similar* to an existing item are left for manual review."""
    linked = created = review = 0
    for spare in machine.spares:
        if spare.item_id:
            continue
        item = exact_item_match(db, spare)
        if item:
            link(db, user, spare, item, "link_exact")
            linked += 1
            continue
        if suggestions(db, spare, limit=1):
            review += 1  # a person decides: link to the suggestion or create new
            continue
        if create_missing:
            link(db, user, spare, create_store_item(db, user, spare), "create")
            created += 1
    return {"linked": linked, "created": created, "needs_review": review}


def store_check(db: Session, machine: Machine, units: int | None = None) -> dict:
    units = units if units is not None else machine.units_supported
    if units < 0 or units > 1000:
        raise BusinessError("Machines supported must be between 0 and 1000")
    lines = []
    counts = {"OK": 0, "SHORT": 0, "OUT": 0, "NOT_IN_STORE": 0, "ON_DEMAND": 0}
    value_short = Decimal(0)
    unpriced = 0
    for s in machine.spares:
        need = required_qty(s, units)
        row = {
            "spare_id": s.id, "line_no": s.line_no, "part_no": s.part_no, "name": s.name, "group": s.group,
            "criticality": s.criticality, "basis": s.basis, "source_ref": s.source_ref, "uom": s.uom_code,
            "qty_per_machine": s.qty_per_machine, "sop_stock": s.sop_stock, "required": need,
            "item_id": s.item_id, "item_code": s.item.item_code if s.item else None,
            "on_hand": None, "reserved": None, "qc_hold": None, "available": None, "shortage": need,
            "open_requisition_qty": Decimal(0),
        }
        if need == 0:
            # SOP stock 0 = order on demand: nothing is required in stores, so it is neither OK nor a gap.
            row["status"] = "ON_DEMAND"
            row["shortage"] = Decimal(0)
            if s.item is not None:
                t = item_totals(db, s.item_id)
                row.update(on_hand=t["on_hand"], reserved=t["reserved"], qc_hold=t["qc_hold"], available=max(t["available"], Decimal(0)))
        elif s.item is None:
            row["status"] = "NOT_IN_STORE"
        else:
            t = item_totals(db, s.item_id)
            row.update(on_hand=t["on_hand"], reserved=t["reserved"], qc_hold=t["qc_hold"], available=max(t["available"], Decimal(0)))
            row["shortage"] = max(need - row["available"], Decimal(0))
            row["open_requisition_qty"] = Decimal(db.scalar(
                select(func.coalesce(func.sum(PurchaseRequisition.quantity), 0))
                .where(PurchaseRequisition.item_id == s.item_id, PurchaseRequisition.status.in_(("OPEN", "IN_PRODUCTION")))) or 0)
            if row["available"] <= 0 and need > 0:
                row["status"] = "OUT"
            elif row["shortage"] > 0:
                row["status"] = "SHORT"
            else:
                row["status"] = "OK"
            if row["shortage"] > 0:
                if Decimal(s.item.avg_cost or 0) > 0:
                    value_short += row["shortage"] * Decimal(s.item.avg_cost)
                else:
                    unpriced += 1
        counts[row["status"]] += 1
        lines.append(row)
    total = len(lines)
    stocked_lines = total - counts["ON_DEMAND"]
    ready = counts["OK"]
    critical_gaps = sum(1 for r in lines if r["criticality"] == "A" and r["status"] not in ("OK", "ON_DEMAND"))
    return {
        "machine_id": machine.id, "code": machine.code, "name": machine.name, "units": units,
        "lines": lines, "counts": counts, "total": total,
        "stocked_lines": stocked_lines,
        "readiness_pct": round(100 * ready / stocked_lines) if stocked_lines else 100,
        "critical_gaps": critical_gaps,
        "shortage_value": value_short.quantize(Decimal("0.01")),
        "unpriced_shortages": unpriced,
    }


def raise_requisitions(db: Session, user: User, machine: Machine, units: int, spare_ids: list[int] | None,
                       required_date: date | None) -> list[PurchaseRequisition]:
    """One requisition per short spare, net of open requisitions for the same item (no double-ordering)."""
    check = store_check(db, machine, units)
    wanted = set(spare_ids) if spare_ids else None
    created: list[PurchaseRequisition] = []
    for row in check["lines"]:
        if wanted is not None and row["spare_id"] not in wanted:
            continue
        if row["status"] == "NOT_IN_STORE":
            if wanted is not None:
                raise BusinessError(f"{row['part_no']} is not aligned with a stores item yet — align it first")
            continue
        qty = row["shortage"] - row["open_requisition_qty"]
        if qty <= 0:
            continue
        item = db.get(Item, row["item_id"])
        seq = db.scalar(select(func.count()).select_from(PurchaseRequisition).where(PurchaseRequisition.item_id == item.id)) or 0
        pr = PurchaseRequisition(
            number=next_number(db, "requisition", "PR-", 5),
            kind="PRODUCTION" if item.item_type == ItemType.PROCESSED_SPARE and item.production_lead_days else "PURCHASE",
            item_id=item.id, quantity=qty, required_date=required_date,
            idempotency_key=f"SOP:{machine.code}:{item.id}:{seq + 1}",
            notes=f"SOP spare shortage — {machine.code} {machine.name}, {row['part_no']} ({units} machine(s) supported)",
            created_by_id=user.id,
        )
        db.add(pr)
        db.flush()
        created.append(pr)
    audit(db, user, "machine.requisitions", "machine", machine.id,
          {"units": units, "requisitions": [p.number for p in created]})
    return created
