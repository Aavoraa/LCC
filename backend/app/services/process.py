"""Manufacturing routes for made items: the operations, where each is done (in-house or outside job-work), and the
time estimate they add up to.

Estimate for a batch of ``qty``:
* in-house time = Σ (setup minutes + run minutes × qty) over IN_HOUSE steps, turned into working days with the
  ``production.hours_per_day`` setting (rounded up);
* outside time  = Σ vendor turnaround days over OUTSIDE steps (each includes transport both ways);
* make time     = in-house days + outside days (steps run in sequence).

The item's ``production_lead_days`` is kept equal to the make time for its standard batch (reorder level, min. 1),
so the sales delivery estimator and production requisitions use the route.

Standard routes below are shop-floor defaults by part family, for Planning to review and correct per item.
"""
from __future__ import annotations

import math
import re
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import Item, ItemType, ProcessStep, User
from .common import BusinessError, audit, get_int_setting

IN, OUT = "IN_HOUSE", "OUTSIDE"
MODES = (IN, OUT)

# step: (operation, work centre, mode, setup min per batch, run min per unit, outside days, notes)
Step = tuple[str, str, str, float, float, int, str | None]

INSPECT: Step = ("Final inspection & packing", "Quality", IN, 5, 2, 0, None)
POWDER: Step = ("Pretreatment & powder coating 60-80 µm, RAL 7035", "Powder coating job-work", OUT, 0, 0, 3, "7-tank pretreatment, oven cure")
ZINC: Step = ("Zinc plating (yellow / clear passivation)", "Electroplating job-work", OUT, 0, 0, 2, None)
LASER: Step = ("CNC laser cutting of blank", "Laser cutting job-work", OUT, 0, 0, 2, "DXF from drawing; nested on sheet")

ROUTES: dict[str, list[Step]] = {
    "sheet_welded": [
        LASER,
        ("Deburring & edge finishing", "Fitting bench", IN, 10, 6, 0, None),
        ("CNC press-brake bending", "Press brake", IN, 20, 8, 0, None),
        ("MIG welding & weld grinding", "Welding bay", IN, 15, 20, 0, None),
        ("Drilling, tapping & PEM nut insertion", "Pillar drill", IN, 10, 6, 0, None),
        POWDER, INSPECT,
    ],
    "sheet_plain": [
        LASER,
        ("Deburring & edge finishing", "Fitting bench", IN, 10, 5, 0, None),
        ("CNC press-brake bending", "Press brake", IN, 20, 6, 0, None),
        ("Drilling, tapping & PEM nut insertion", "Pillar drill", IN, 10, 5, 0, None),
        POWDER, INSPECT,
    ],
    "bolt": [
        ("Bar cutting", "Bandsaw", IN, 10, 0.5, 0, None),
        ("CNC turning & parting", "CNC lathe", IN, 30, 2.5, 0, None),
        ("Head forming (hex milling / socket broaching)", "VMC / broaching", IN, 20, 1.5, 0, None),
        ("Thread rolling", "Thread rolling machine", IN, 20, 0.5, 0, None),
        ("Hardening & tempering to property class", "Heat treatment job-work", OUT, 0, 0, 3, None),
        ZINC, ("Thread gauge inspection & packing", "Quality", IN, 5, 0.3, 0, None),
    ],
    "nut": [
        ("Hex bar turning, drilling & parting", "CNC lathe", IN, 30, 1.5, 0, None),
        ("Tapping", "Tapping machine", IN, 15, 1, 0, None),
        ("Hardening & tempering to property class", "Heat treatment job-work", OUT, 0, 0, 3, None),
        ZINC, ("Thread gauge inspection & packing", "Quality", IN, 5, 0.3, 0, None),
    ],
    "washer": [
        ("Blanking & piercing", "Power press", IN, 20, 0.2, 0, None),
        ("Tumbling / deburring", "Vibro finisher", IN, 10, 0.1, 0, None),
        ZINC, ("Inspection & packing", "Quality", IN, 5, 0.1, 0, None),
    ],
    "gear": [
        ("Bar cutting", "Bandsaw", IN, 10, 3, 0, "EN8 / EN353 bar"),
        ("CNC turning (blank, bore, faces)", "CNC lathe", IN, 30, 15, 0, None),
        ("Gear / sprocket hobbing", "Hobbing machine", IN, 45, 20, 0, None),
        ("Keyway slotting", "Slotting machine", IN, 15, 8, 0, None),
        ("Deburring & tooth chamfering", "Fitting bench", IN, 0, 4, 0, None),
        ("Case carburising, hardening & tempering", "Heat treatment job-work", OUT, 0, 0, 4, "55-60 HRC case"),
        ("Bore & face grinding", "Internal grinder", IN, 20, 10, 0, None),
        ("Inspection (tooth profile, runout) & packing", "Quality", IN, 10, 4, 0, None),
    ],
    "pulley": [
        ("CNC turning of casting (OD, bore, faces)", "CNC lathe", IN, 30, 20, 0, "CI casting from stores"),
        ("V-groove turning", "CNC lathe", IN, 15, 10, 0, None),
        ("Keyway slotting", "Slotting machine", IN, 15, 8, 0, None),
        ("Drilling & tapping for grub screw", "Pillar drill", IN, 10, 4, 0, None),
        ("Dynamic balancing", "Balancing machine", IN, 15, 6, 0, None),
        ("Painting", "Paint booth", IN, 10, 5, 0, None),
        INSPECT,
    ],
    "roller": [
        ("Bar cutting", "Bandsaw", IN, 10, 3, 0, None),
        ("CNC turning", "CNC lathe", IN, 30, 25, 0, None),
        ("Induction hardening", "Heat treatment job-work", OUT, 0, 0, 4, None),
        ("Centre lapping & cylindrical grinding", "Cylindrical grinder", IN, 30, 20, 0, None),
        ("Hard chrome plating", "Hard chrome job-work", OUT, 0, 0, 4, None),
        ("Inspection (runout, diameter) & packing", "Quality", IN, 10, 5, 0, None),
    ],
    "fluted_roller": [
        ("Bar cutting", "Bandsaw", IN, 10, 3, 0, None),
        ("CNC turning", "CNC lathe", IN, 30, 25, 0, None),
        ("Flute milling", "CNC fluting machine", IN, 45, 40, 0, None),
        ("Induction hardening", "Heat treatment job-work", OUT, 0, 0, 4, None),
        ("Centre lapping & cylindrical grinding", "Cylindrical grinder", IN, 30, 20, 0, None),
        ("Hard chrome plating", "Hard chrome job-work", OUT, 0, 0, 4, None),
        ("Inspection (runout, flute pitch) & packing", "Quality", IN, 10, 6, 0, None),
    ],
    "shaft": [
        ("Bar cutting", "Bandsaw", IN, 10, 3, 0, None),
        ("CNC turning", "CNC lathe", IN, 30, 20, 0, None),
        ("Keyway / flat milling", "VMC", IN, 20, 8, 0, None),
        ("Induction hardening", "Heat treatment job-work", OUT, 0, 0, 4, None),
        ("Cylindrical grinding", "Cylindrical grinder", IN, 30, 15, 0, None),
        ("Inspection (runout) & packing", "Quality", IN, 10, 4, 0, None),
    ],
    "flyer": [
        ("CNC turning of boss and top", "CNC lathe", IN, 40, 30, 0, None),
        ("VMC milling of legs and presser slot", "VMC", IN, 45, 35, 0, None),
        ("Brazing / welding of legs", "Welding bay", IN, 20, 25, 0, None),
        ("Dynamic balancing", "Balancing machine", IN, 20, 15, 0, None),
        ("Hard chrome plating", "Hard chrome job-work", OUT, 0, 0, 5, None),
        ("Presser arm assembly", "Assembly", IN, 15, 20, 0, None),
        ("Inspection & packing", "Quality", IN, 10, 8, 0, None),
    ],
    "pressed_bracket": [
        LASER,
        ("CNC press-brake bending", "Press brake", IN, 20, 6, 0, None),
        ("Drilling & tapping", "Pillar drill", IN, 10, 5, 0, None),
        ZINC, INSPECT,
    ],
    "wire_form": [
        ("Wire cutting & bending", "Wire bending fixture", IN, 15, 3, 0, None),
        ("Hardening & tempering", "Heat treatment job-work", OUT, 0, 0, 3, None),
        ("Nickel plating", "Electroplating job-work", OUT, 0, 0, 2, None),
        ("Assembly", "Assembly", IN, 10, 4, 0, None),
        INSPECT,
    ],
    "machined": [
        ("Bar / plate cutting", "Bandsaw", IN, 10, 3, 0, None),
        ("CNC turning", "CNC lathe", IN, 30, 12, 0, None),
        ("VMC milling", "VMC", IN, 40, 15, 0, None),
        ("Drilling & tapping", "Pillar drill", IN, 10, 5, 0, None),
        ("Blackodising / zinc plating", "Electroplating job-work", OUT, 0, 0, 2, None),
        ("Assembly & inspection", "Quality", IN, 10, 6, 0, None),
    ],
    "hardened_machined": [
        ("Bar cutting", "Bandsaw", IN, 10, 3, 0, None),
        ("CNC turning", "CNC lathe", IN, 30, 15, 0, None),
        ("VMC milling (jaw profile)", "VMC", IN, 45, 25, 0, None),
        ("Hardening & tempering", "Heat treatment job-work", OUT, 0, 0, 3, None),
        ("Surface grinding", "Surface grinder", IN, 20, 12, 0, None),
        ("Inspection & matched-set packing", "Quality", IN, 10, 5, 0, None),
    ],
    "machine_assembly": [
        ("Sub-assembly of frame, drives and guards", "Assembly", IN, 60, 480, 0, None),
        ("Final assembly & alignment", "Assembly", IN, 60, 600, 0, None),
        ("Electrical panel wiring & safety interlocks", "Electrical", IN, 30, 240, 0, None),
        ("Trial run & performance test", "Testing bay", IN, 30, 240, 0, "Run-in per machine test sheet"),
        ("Final inspection, touch-up & packing", "Quality", IN, 15, 120, 0, None),
    ],
    "bought_out": [
        ("Procure from approved supplier", "Purchase", OUT, 0, 0, 10, "Bought-out assembly, no machining in-house"),
        ("Incoming inspection & fitment check", "Quality", IN, 10, 10, 0, None),
    ],
}

# First matching pattern wins; order from most to least specific.
RULES: list[tuple[str, str]] = [
    (r"bearing set|lubrication.*pump|guideway", "bought_out"),
    (r"powder coated", "sheet_welded"),  # refined below for plain sheets / brackets
    (r"hex bolt|cap screw|csk allen|button head|grub screw", "bolt"),
    (r"nyloc nut|hex nut|cage nut", "nut"),
    (r"washer", "washer"),
    (r"gear|sprocket", "gear"),
    (r"pulley", "pulley"),
    (r"fluted", "fluted_roller"),
    (r"roller", "roller"),
    (r"spindle shaft|shaft", "shaft"),
    (r"flyer", "flyer"),
    (r"chuck jaw", "hardened_machined"),
    (r"separator plate|ring rail bracket|bracket", "pressed_bracket"),
    (r"lappet hook", "wire_form"),
]
_WELDED = re.compile(r"guard|hood|tray|bin|enclosure|box|duct|frame|stand|door", re.I)


def standard_route_key(item: Item) -> str:
    if item.item_type == ItemType.FINISHED_GOOD:
        return "machine_assembly"
    name = item.name.lower()
    for pattern, key in RULES:
        if re.search(pattern, name):
            if key == "sheet_welded" and (re.search(r"bracket|plate", name) or not _WELDED.search(name)):
                return "sheet_plain"
            return key
    return "machined"


def _route_variant(item: Item, steps: list[Step]) -> list[Step]:
    """Small per-item adjustments to a family route."""
    name = item.name.lower()
    out = list(steps)
    if "ss 304" in name:  # stainless: no hardening, passivate instead of zinc
        out = [s for s in out if "Hardening" not in s[0] and s is not ZINC]
        out.insert(-1, ("Passivation", "Electroplating job-work", OUT, 0, 0, 2, None))
    elif "black" in name:
        out = [("Black oxide (blackodising)", "Electroplating job-work", OUT, 0, 0, 2, None) if s is ZINC else s for s in out]
    if "spring washer" in name:
        out.insert(2, ("Hardening & tempering", "Heat treatment job-work", OUT, 0, 0, 3, None))
    if "nyloc" in name:
        out.insert(2, ("Nylon insert pressing & crimping", "Power press", IN, 10, 0.5, 0, None))
    if "cage nut" in name:
        out = [("Cage blanking & forming", "Power press", IN, 20, 0.5, 0, None)] + out
    if "grub screw" in name:
        out = [s for s in out if not s[0].startswith("Head forming")]
    return out


def standard_steps(item: Item) -> tuple[str, list[Step]]:
    key = standard_route_key(item)
    return key, _route_variant(item, ROUTES[key])


def batch_qty(item: Item) -> Decimal:
    return max(Decimal(item.reorder_level or 0), Decimal(1))


def estimate(db: Session, steps: list[ProcessStep], qty: Decimal) -> dict:
    hours_per_day = max(get_int_setting(db, "production.hours_per_day"), 1)
    rows = []
    in_min = Decimal(0)
    out_days = 0
    for s in steps:
        if s.mode == IN:
            minutes = Decimal(s.setup_min) + Decimal(s.run_min) * qty
            in_min += minutes
            rows.append({"seq": s.seq, "minutes": minutes.quantize(Decimal("0.1")), "days": None})
        else:
            out_days += s.outside_days
            rows.append({"seq": s.seq, "minutes": None, "days": s.outside_days})
    in_hours = in_min / 60
    in_days = math.ceil(in_hours / hours_per_day) if in_min > 0 else 0
    return {
        "qty": qty, "hours_per_day": hours_per_day, "steps": rows,
        "in_house_minutes": in_min.quantize(Decimal("0.1")), "in_house_hours": in_hours.quantize(Decimal("0.01")),
        "in_house_days": in_days, "outside_days": out_days, "total_days": in_days + out_days,
        "in_house_steps": sum(1 for s in steps if s.mode == IN), "outside_steps": sum(1 for s in steps if s.mode == OUT),
    }


def steps_of(db: Session, item_id: int) -> list[ProcessStep]:
    return list(db.scalars(select(ProcessStep).where(ProcessStep.item_id == item_id).order_by(ProcessStep.seq)))


def sync_lead_days(db: Session, item: Item) -> int:
    """Processed spares take their lead time from the route. A machine's lead time also covers its bought-out and
    made parts, so Planning keeps setting that by hand; its assembly route does not overwrite it."""
    steps = steps_of(db, item.id)
    if steps and item.item_type == ItemType.PROCESSED_SPARE:
        item.production_lead_days = min(estimate(db, steps, batch_qty(item))["total_days"], 365)
    return item.production_lead_days


def replace_steps(db: Session, user: User | None, item: Item, steps: list[dict], *, how: str = "edit") -> list[ProcessStep]:
    if item.item_type not in (ItemType.PROCESSED_SPARE, ItemType.FINISHED_GOOD):
        raise BusinessError("Process routes apply to processed spares and finished goods only")
    for s in steps:
        if s["mode"] not in MODES:
            raise BusinessError(f"Step mode must be one of {', '.join(MODES)}")
        if s["mode"] == OUT and not s.get("outside_days"):
            raise BusinessError(f"Outside step '{s['operation']}' needs vendor turnaround days")
    db.execute(delete(ProcessStep).where(ProcessStep.item_id == item.id))
    db.flush()
    rows = []
    for i, s in enumerate(steps, start=1):
        row = ProcessStep(item_id=item.id, seq=i, operation=s["operation"].strip(), work_center=(s.get("work_center") or None),
                          mode=s["mode"], setup_min=Decimal(str(s.get("setup_min") or 0)), run_min=Decimal(str(s.get("run_min") or 0)),
                          outside_days=int(s.get("outside_days") or 0) if s["mode"] == OUT else 0,
                          supplier_id=s.get("supplier_id"), notes=s.get("notes") or None)
        db.add(row)
        rows.append(row)
    db.flush()
    before = item.production_lead_days
    sync_lead_days(db, item)
    audit(db, user, f"item.process.{how}", "item", item.id,
          {"steps": len(rows), "lead_days_before": before, "lead_days_after": item.production_lead_days})
    return rows


def apply_standard(db: Session, user: User | None, item: Item) -> tuple[str, list[ProcessStep]]:
    key, steps = standard_steps(item)
    payload = [{"operation": op, "work_center": wc, "mode": mode, "setup_min": setup, "run_min": run, "outside_days": days, "notes": notes}
               for op, wc, mode, setup, run, days, notes in steps]
    return key, replace_steps(db, user, item, payload, how="standard")
