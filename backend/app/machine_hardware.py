"""Build-standard hardware for each card service machine: fasteners and powder-coated sheet-metal parts.

These are not named in the LCC catalogue (basis ``STANDARD``); they come from the machine build and are made or
finished in-house, so each is a PROCESSED_SPARE stores item. Fasteners are shared across machines (one stores item
each); sheet-metal parts are specific to a machine and carry its short code.

    python -m app.machine_hardware          # add the lines to every machine and create/link their stores items

Quantities are proposed defaults for the stores team to review on the Machines page.
"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select

from .db import SessionLocal
from .models import Machine, MachineSpare, User
from .services.common import audit, normalize_name

SOURCE_REF = "Build standard (stores to confirm)"
FINISH = "Powder coated 60-80 micron, RAL 7035 light grey"

# (name, group, criticality, qty_per_machine, sop_stock, uom, notes)
FASTENERS: list[tuple] = [
    ("Hex Bolt M8 x 25 mm Gr 8.8 Zinc Plated", "FASTENER", "B", 16, 32, "NOS", "Frame and guard fixing"),
    ("Hex Bolt M10 x 40 mm Gr 8.8 Zinc Plated", "FASTENER", "B", 8, 16, "NOS", "Base frame / motor mounting"),
    ("Hex Bolt M12 x 50 mm Gr 8.8 Zinc Plated", "FASTENER", "C", 4, 8, "NOS", "Foundation and bed fixing"),
    ("Hex Nut M8 Class 8 Zinc Plated", "FASTENER", "B", 16, 32, "NOS", None),
    ("Hex Nut M10 Class 8 Zinc Plated", "FASTENER", "B", 8, 16, "NOS", None),
    ("Nyloc Nut M8 Zinc Plated", "FASTENER", "B", 8, 16, "NOS", "Vibration-prone joints"),
    ("Plain Washer M8 Zinc Plated", "FASTENER", "B", 32, 64, "NOS", None),
    ("Plain Washer M10 Zinc Plated", "FASTENER", "B", 16, 32, "NOS", None),
    ("Spring Washer M8 Zinc Plated", "FASTENER", "B", 16, 32, "NOS", None),
    ("Allen Cap Screw M6 x 16 mm Gr 12.9 Black", "FASTENER", "B", 20, 40, "NOS", "Bracket and bearing housing fixing"),
    ("Allen Cap Screw M10 x 30 mm Gr 12.9 Black", "FASTENER", "B", 8, 16, "NOS", None),
    ("CSK Allen Screw M5 x 12 mm Zinc Plated", "FASTENER", "A", 24, 48, "NOS", "Cover sheet fixing — often lost during service"),
    ("Button Head Allen Screw M6 x 12 mm SS 304", "FASTENER", "B", 12, 24, "NOS", "Panel door and guard fixing"),
    ("Grub Screw M6 x 8 mm Cup Point", "FASTENER", "B", 4, 8, "NOS", "Pulley and coupling locking"),
    ("Cage Nut M6 for Panel Mounting", "FASTENER", "C", 8, 0, "NOS", None),
]

# Sheet-metal parts common to every machine; " - <short code>" is appended per machine.
COMMON_SHEET = [
    ("Motor Cover Sheet 1.6 mm CRCA", "B", 1, 1),
    ("Belt and Pulley Guard 1.6 mm CRCA", "A", 1, 1),
    ("Electrical Panel Enclosure Door 1.6 mm CRCA", "C", 1, 0),
    ("Side Cover Sheet LH 1.2 mm CRCA", "B", 1, 1),
    ("Side Cover Sheet RH 1.2 mm CRCA", "B", 1, 1),
    ("Cable Tray Cover 1.2 mm CRCA", "C", 1, 0),
    ("Name Plate and Caution Label Bracket", "C", 1, 0),
]

# Sheet-metal and fabricated parts particular to one machine.
MACHINE_SHEET: dict[str, list[tuple]] = {
    "CSM-WME": [("Wire Spool Stand Cover Sheet", "C", 1, 0), ("Tensioning Device Guard Cover", "B", 1, 1),
                ("Remote Pendant Holder Bracket", "C", 1, 0), ("Butt Welder Base Tray", "C", 1, 0)],
    "CSM-MRM": [("Aluminium Bed End Cover Plate", "B", 2, 1), ("Carriage Top Cover Sheet", "B", 1, 1),
                ("Roller Support Stand Guard", "C", 2, 0), ("Chip Collection Tray", "C", 1, 0)],
    "CSM-FEM": [("Milling Cutter Guard Hood", "A", 1, 1), ("Carriage Bellow Cover Frame", "B", 1, 1),
                ("Chip Collection Tray", "C", 1, 0), ("Pneumatic Valve Box Cover", "C", 1, 0),
                ("Flat Rest Support Bracket", "B", 2, 1)],
    "CSM-LFCM": [("Clipping Head Guard Cover", "A", 1, 1), ("Light Curtain Mounting Bracket", "B", 2, 1),
                 ("Ball Screw Cover Sheet", "B", 1, 1), ("Pneumatic Panel Cover Sheet", "C", 1, 0),
                 ("Flat Loading Table Top Sheet", "C", 1, 0)],
    "CSM-LFGM": [("Grinding Roller Guard Hood", "A", 1, 1), ("Dust Extraction Duct Sheet", "B", 1, 1),
                 ("Dust Collection Bin", "C", 1, 0), ("Grinding Plate Holder Bracket", "B", 1, 1)],
    "CSM-TSD": [("Grinding Head Cover", "A", 1, 1), ("Toothed Belt Guard Sheet", "B", 1, 1),
                ("Traverse Bar End Cover", "B", 2, 1), ("Control Box Enclosure", "C", 1, 0)],
    "CSM-OFGM": [("Flat Grinding Head Guard", "A", 1, 1), ("Dust Shield Sheet", "B", 1, 1),
                 ("Mounting Bracket Pair for Card Frame", "B", 1, 1), ("Control Box Enclosure", "C", 1, 0)],
    "CSM-WDM": [("Cylinder Brake Guard Cover", "B", 1, 1), ("Wire Take-Up Spool Guard", "A", 1, 1),
                ("Spool Holder Base Plate", "C", 1, 0), ("Remote Pendant Holder Bracket", "C", 1, 0)],
    "CSM-BCG": [("Grinding Tube Guard Cover", "A", 1, 1), ("V-Belt Guard Sheet", "B", 1, 1),
                ("Grinding Dust Tray", "C", 1, 0), ("Tube Support Bracket Pair", "B", 1, 1)],
    "CSM-MTWG": [("Grinding Wheel Guard Hood", "A", 1, 1), ("Traverse Tube End Cover", "B", 2, 1),
                 ("Motor Mounting Bracket", "B", 1, 1), ("Spark Deflector Sheet", "B", 1, 1)],
}


def hardware_for(machine: Machine) -> list[tuple]:
    short = machine.code.removeprefix("CSM-")
    lines = list(FASTENERS)
    for name, crit, qty, sop in COMMON_SHEET + MACHINE_SHEET.get(machine.code, []):
        lines.append((f"{name}, Powder Coated - {short}", "FABRICATION", crit, qty, sop, "NOS", f"{FINISH}. Fits {machine.name}."))
    return lines


def load(db, user: User) -> dict:
    """Add build-standard lines to every sellable machine and create/link a PROCESSED_SPARE item for each.
    Re-running is safe: existing lines and links are kept."""
    from .services.machines import create_store_item, exact_item_match, link

    added = created = linked = 0
    for m in db.scalars(select(Machine).where(Machine.code.in_(MACHINE_SHEET)).order_by(Machine.code)):
        existing = {s.name_normalized: s for s in m.spares}
        next_line = max((s.line_no for s in m.spares), default=0)
        for name, group, crit, qty, sop, uom, notes in hardware_for(m):
            norm = normalize_name(name)
            s = existing.get(norm)
            if s is None:
                next_line += 1
                s = MachineSpare(machine_id=m.id, line_no=next_line, part_no=f"{m.code}-{next_line:03d}", name=name,
                                 name_normalized=norm, group=group, criticality=crit, qty_per_machine=Decimal(qty),
                                 sop_stock=Decimal(sop), uom_code=uom, basis="STANDARD", source_ref=SOURCE_REF, notes=notes)
                db.add(s)
                db.flush()
                s.machine = m
                added += 1
            if s.item_id is None:
                # Deliberately no fuzzy review: these are in-house processed parts, distinct from the purchased
                # boxes of fasteners already in stores, so link only on an exact name and otherwise create.
                item = exact_item_match(db, s)
                if item:
                    link(db, user, s, item, "link_exact")
                    linked += 1
                else:
                    link(db, user, s, create_store_item(db, user, s), "create")
                    created += 1
                db.flush()
    audit(db, user, "machine.hardware.load", "machine", None, {"spares_added": added, "items_created": created, "linked": linked})
    return {"spares_added": added, "items_created": created, "linked": linked}


def main() -> None:
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == "stores")) or db.scalar(select(User).where(User.username == "admin"))
        print(load(db, user))
        db.commit()


if __name__ == "__main__":
    main()
