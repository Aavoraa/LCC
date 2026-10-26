"""Generate a realistic demo catalogue of engineering / textile-machinery items.

    python -m app.demo_catalog            # top up to 1000 items in total
    python -m app.demo_catalog --target 2500

Every item goes through the normal item service (code + QR) and its opening stock is
posted to the ledger as an OPENING movement (ref DEMO-CATALOG), so valuation, reports and the
dashboard stay reconcilable. Re-running is safe: existing names are skipped and opening
movements use deterministic transaction IDs. Output is deterministic (fixed random seed).
"""
from __future__ import annotations

import argparse
import random
from decimal import Decimal

from sqlalchemy import func, select

from .db import SessionLocal
from .models import Item, ItemCategory, Location, MovementType, Supplier, Uom, User
from .services.common import normalize_name
from .services.items import create_item
from .services.stock import MovementInput, post_movement


def _catalogue() -> list[dict]:
    """(name, type, category, uom, manufacturer, make_model, hsn, gst, cost range, lead days)."""
    out: list[dict] = []

    def add(name, itype, cat, uom, cost, *, mfr=None, model=None, hsn=None, gst=18, prod_days=0):
        out.append(dict(name=name, item_type=itype, category=cat, uom=uom, cost=cost, manufacturer=mfr,
                        make_model=model, hsn_code=hsn, gst_rate=gst, production_lead_days=prod_days))

    # Bearings — purchased items
    for series, sizes in (("60", range(0, 13)), ("62", range(0, 16)), ("63", range(0, 13))):
        for n in sizes:
            code = f"{series}{n:02d}"
            for suffix, mfr in (("2RS", "SKF"), ("ZZ", "FAG"), ("", "NSK")):
                model = f"{code}-{suffix}" if suffix else code
                base = 60 + int(series) * 2 + n * 18
                add(f"Deep Groove Ball Bearing {model}", "PURCHASED_ITEM", "Bearings", "NOS", (base, base * 1.6),
                    mfr=mfr, model=model, hsn="84821011")
    for n in (204, 205, 206, 207, 208, 210, 212):
        add(f"Pillow Block Bearing UCP{n}", "PURCHASED_ITEM", "Bearings", "NOS", (420 + n, 700 + n * 2), mfr="NTN", model=f"UCP{n}", hsn="84822000")
    for n in (30204, 30205, 30206, 30207, 30208, 32008, 32010):
        add(f"Taper Roller Bearing {n}", "PURCHASED_ITEM", "Bearings", "NOS", (380, 950), mfr="Timken", model=str(n), hsn="84822011")

    # Fasteners — purchased, sold in boxes of 100
    for kind, hsn in (("Hex Bolt", "73181500"), ("Allen Cap Screw", "73181500")):
        for d in (6, 8, 10, 12, 16, 20):
            for length in (20, 25, 30, 40, 50, 60, 80, 100):
                if length < d * 2:
                    continue
                add(f"{kind} M{d}x{length} Gr 8.8 (box of 100)", "PURCHASED_ITEM", "Fasteners", "BOX",
                    (d * length * 0.9, d * length * 1.4), mfr="Unbrako" if "Allen" in kind else "TVS", hsn=hsn)
    for d in (6, 8, 10, 12, 16, 20, 24):
        add(f"Hex Nut M{d} (box of 100)", "PURCHASED_ITEM", "Fasteners", "BOX", (d * 18, d * 30), hsn="73181600")
        add(f"Plain Washer M{d} (box of 100)", "PURCHASED_ITEM", "Fasteners", "BOX", (d * 8, d * 14), hsn="73182200")
        add(f"Spring Washer M{d} (box of 100)", "PURCHASED_ITEM", "Fasteners", "BOX", (d * 10, d * 16), hsn="73182100")

    for d in (6, 8, 10, 12, 16, 20):
        for length in (20, 30, 40, 50, 60, 80):
            if length >= d * 2:
                add(f"SS 304 Hex Bolt M{d}x{length} (box of 50)", "PURCHASED_ITEM", "Fasteners", "BOX", (d * length * 2.2, d * length * 3), hsn="73181500")
    for d in (4, 5, 6, 8, 10, 12):
        for length in (6, 8, 10, 12, 16):
            add(f"Grub Screw M{d}x{length} Cup Point (box of 100)", "PURCHASED_ITEM", "Fasteners", "BOX", (d * 40, d * 65), mfr="Unbrako", hsn="73181500")
    for size in range(10, 62, 4):
        add(f"Internal Circlip {size}mm", "DAILY_CONSUMABLE", "Fasteners", "NOS", (3, 14), hsn="73182990")
        add(f"External Circlip {size}mm", "DAILY_CONSUMABLE", "Fasteners", "NOS", (3, 14), hsn="73182990")

    # Power transmission
    for section, base in (("A", 9), ("B", 13), ("C", 22)):
        for inches in range(30, 82, 2):
            add(f"V-Belt {section}{inches}", "PURCHASED_ITEM", "Spares", "NOS", (base * inches * 0.35, base * inches * 0.5), mfr="Fenner", hsn="40103290")
    for length in range(300, 1300, 50):
        add(f"Timing Belt HTD {length}-5M-15", "PURCHASED_ITEM", "Spares", "NOS", (380, 1400), mfr="Gates", hsn="40103590")
    for bush in ("1008", "1108", "1210", "1610", "2012", "2517"):
        for bore in (12, 16, 20, 25, 30):
            add(f"Taper Lock Bush {bush} Bore {bore}mm", "PURCHASED_ITEM", "Spares", "NOS", (180, 820), mfr="Fenner", hsn="84839000")
    for size in ("L050", "L070", "L075", "L090", "L095", "L100", "L110", "L150"):
        add(f"Jaw Coupling {size} Complete", "PURCHASED_ITEM", "Spares", "SET", (420, 3600), mfr="Lovejoy", hsn="84836090")
        add(f"Jaw Coupling Spider {size}", "DAILY_CONSUMABLE", "Spares", "NOS", (60, 480), mfr="Lovejoy", hsn="40169390")
    for shaft, housing in ((20, 35), (25, 40), (30, 47), (35, 52), (40, 62), (45, 62), (50, 72), (55, 80), (60, 85), (65, 90)):
        for width in (7, 8, 10):
            add(f"Oil Seal TC {shaft}x{housing}x{width}", "DAILY_CONSUMABLE", "Hydraulics", "NOS", (35, 160), mfr="NOK", hsn="40169320")

    # Raw materials — steel and metals by weight / length
    for grade in ("EN8", "EN19", "EN24", "EN31", "C45"):
        for dia in (12, 16, 20, 25, 32, 40, 50, 63, 75, 90, 100):
            add(f"MS Round Bar {grade} {dia}mm", "RAW_MATERIAL", "Steel", "KG", (68, 118), hsn="72142090")
    for t in (3, 4, 5, 6, 8, 10, 12, 16, 20, 25):
        add(f"MS Plate IS2062 {t}mm", "RAW_MATERIAL", "Steel", "KG", (62, 82), hsn="72085190")
        add(f"SS 304 Sheet {t}mm", "RAW_MATERIAL", "Steel", "KG", (240, 320), hsn="72193390")
    for size in (25, 32, 40, 50, 65, 75):
        add(f"MS Square Tube {size}x{size}x3mm", "RAW_MATERIAL", "Steel", "MTR", (size * 4, size * 6), hsn="73066100")
        add(f"Aluminium Flat Bar 6061 {size}x10mm", "RAW_MATERIAL", "Steel", "KG", (280, 360), hsn="76042910")
    for dia in (20, 25, 32, 40, 50, 60):
        add(f"Brass Rod {dia}mm", "RAW_MATERIAL", "Steel", "KG", (520, 640), hsn="74072190")
        add(f"Phosphor Bronze Bush Blank {dia}mm", "RAW_MATERIAL", "Castings", "KG", (780, 960), hsn="74031900")
    for part in ("Gearbox Housing", "Spindle Bolster", "Motor Bracket", "Pulley Hub", "Roller Stand", "Creel Bracket"):
        for size in ("Small", "Medium", "Large"):
            add(f"CI Casting {part} {size} (rough)", "RAW_MATERIAL", "Castings", "NOS", (450, 3800), hsn="73251000")

    # Daily consumables
    for d in [x / 2 for x in range(2, 41)]:
        add(f"HSS Drill Bit {d:g}mm", "DAILY_CONSUMABLE", "Consumables", "NOS", (20 + d * 9, 35 + d * 14), mfr="Addison", hsn="82075000")
    for d in (6, 8, 10, 12, 16, 20):
        add(f"Carbide End Mill {d}mm 4 Flute", "DAILY_CONSUMABLE", "Consumables", "NOS", (d * 110, d * 170), mfr="Sandvik", hsn="82077090")
        add(f"HSS Tap M{d} Set", "DAILY_CONSUMABLE", "Consumables", "SET", (d * 45, d * 75), hsn="82074010")
    for size in ("100x6", "125x6", "180x6", "230x6"):
        for kind in ("Grinding Wheel", "Cutting Wheel", "Flap Disc"):
            add(f"{kind} {size}mm", "DAILY_CONSUMABLE", "Consumables", "NOS", (35, 220), mfr="Norton", hsn="68042210")
    for d in ("2.5", "3.15", "4.0"):
        add(f"Welding Electrode E6013 {d}mm (5 kg pack)", "DAILY_CONSUMABLE", "Consumables", "BOX", (650, 980), mfr="ESAB", hsn="83111000")
    for grit in (60, 80, 100, 120, 180, 220, 320, 400):
        add(f"Emery Paper Grit {grit}", "DAILY_CONSUMABLE", "Consumables", "NOS", (12, 22), hsn="68052000")
    for name, uom, cost in (("Cotton Waste Cleaning Cloth", "KG", (42, 58)), ("Soluble Cutting Oil", "LTR", (160, 220)),
                            ("Hydraulic Oil ISO VG 68", "LTR", (140, 190)), ("Spindle Oil ISO VG 10", "LTR", (130, 170)),
                            ("Gear Oil EP 220", "LTR", (180, 240)), ("Lithium Grease EP2", "KG", (220, 300)),
                            ("Leather Hand Gloves", "SET", (85, 130)), ("Nitrile Gloves", "BOX", (380, 520)),
                            ("Safety Goggles", "NOS", (90, 160)), ("Ear Plugs", "BOX", (240, 360)),
                            ("Masking Tape 2 inch", "NOS", (38, 55)), ("Thread Locker 243", "NOS", (420, 560)),
                            ("Anti-Rust Spray", "NOS", (190, 260)), ("Degreaser Solvent", "LTR", (110, 160)),
                            ("Marking Ink Blue", "NOS", (70, 110)), ("Cable Ties 200mm", "BOX", (90, 140))):
        add(name, "DAILY_CONSUMABLE", "Consumables", uom, cost, gst=18)

    # Electrical
    for amp in (6, 10, 16, 20, 25, 32, 40, 63):
        for poles in ("SP", "DP", "TP"):
            add(f"MCB {amp}A {poles} C-Curve", "PURCHASED_ITEM", "Electrical", "NOS", (160 + amp * 3, 260 + amp * 6), mfr="Schneider", hsn="85362030")
    for amp in (9, 12, 18, 25, 32, 40, 50, 65):
        add(f"Power Contactor {amp}A 415V", "PURCHASED_ITEM", "Electrical", "NOS", (900 + amp * 30, 1300 + amp * 45), mfr="Siemens", hsn="85364900")
        add(f"Thermal Overload Relay {amp}A", "PURCHASED_ITEM", "Electrical", "NOS", (700 + amp * 20, 1000 + amp * 30), mfr="L&T", hsn="85364900")
    for sq in ("1.0", "1.5", "2.5", "4.0", "6.0", "10.0"):
        for cores in (2, 3, 4):
            add(f"Copper Flexible Cable {cores}C x {sq} sqmm", "PURCHASED_ITEM", "Electrical", "MTR", (18, 260), mfr="Polycab", hsn="85444999")
    for hp in ("0.5", "1", "2", "3", "5", "7.5", "10"):
        add(f"3-Phase Induction Motor {hp} HP 1440 RPM", "PURCHASED_ITEM", "Electrical", "NOS", (6500, 42000), mfr="Crompton", hsn="85015210")
        add(f"VFD Drive {hp} HP", "PURCHASED_ITEM", "Electrical", "NOS", (9000, 52000), mfr="Delta", hsn="85044090")
    for kind in ("Inductive Proximity Sensor M12", "Inductive Proximity Sensor M18", "Photoelectric Sensor", "Limit Switch Roller Lever",
                 "Push Button Green", "Push Button Red", "Emergency Stop Mushroom", "Selector Switch 2-Pos", "Pilot Lamp 24V LED"):
        add(kind, "PURCHASED_ITEM", "Electrical", "NOS", (140, 1800), mfr="Omron", hsn="85365090")

    # Hydraulics & pneumatics
    for size in ("1/4", "3/8", "1/2", "3/4", "1"):
        for length in (500, 1000, 1500, 2000):
            add(f"Hydraulic Hose {size} inch x {length}mm 2SN", "PURCHASED_ITEM", "Hydraulics", "NOS", (420, 2600), mfr="Parker", hsn="40093100")
    for cs in ("1.5", "2.0", "2.5", "3.0", "3.5", "5.0"):
        for idd in (10, 15, 20, 25, 30, 40, 50):
            add(f"Nitrile O-Ring {idd}x{cs}mm", "DAILY_CONSUMABLE", "Hydraulics", "NOS", (4, 28), hsn="40169320")
    for bore in (25, 32, 40, 50, 63, 80, 100):
        for stroke in (50, 100, 150, 200):
            add(f"Pneumatic Cylinder {bore} bore x {stroke} stroke", "PURCHASED_ITEM", "Hydraulics", "NOS", (1800 + bore * 40, 3200 + bore * 70), mfr="Festo", hsn="84123100")
    for kind in ("5/2 Solenoid Valve 1/4", "5/3 Solenoid Valve 1/4", "FRL Unit 1/2", "Flow Control Valve 1/4", "Quick Coupler 1/4", "Pressure Gauge 0-10 bar"):
        add(kind, "PURCHASED_ITEM", "Hydraulics", "NOS", (180, 4200), mfr="Janatics", hsn="84818090")
    for cc in (4, 8, 12, 16, 20, 25):
        add(f"Hydraulic Gear Pump {cc}cc", "PURCHASED_ITEM", "Hydraulics", "NOS", (5200 + cc * 220, 7800 + cc * 300), mfr="Rexroth", hsn="84136090")

    # Processed spares — textile ring frame / speed frame parts made in-house
    for part, base, days in (("Spindle Shaft Ring Frame", 2200, 12), ("Top Arm Roller", 1400, 10), ("Bottom Roller Fluted", 1800, 14),
                             ("Drafting Apron Cradle", 950, 8), ("Ring Rail Bracket", 650, 6), ("Lappet Hook Assembly", 380, 5),
                             ("Flyer Assembly Speed Frame", 4800, 18), ("Creel Peg Holder", 260, 4), ("Spindle Tape Tensioner", 720, 7),
                             ("Separator Plate", 310, 4)):
        for variant in ("Type A", "Type B", "Type C", "Heavy Duty"):
            add(f"{part} {variant}", "PROCESSED_SPARE", "Spares", "NOS", (base * 0.8, base * 1.3), hsn="84483990", prod_days=days)
    for teeth in range(18, 90, 4):
        for module in ("1.5", "2.0", "2.5"):
            add(f"Spur Gear {teeth}T Module {module}", "PROCESSED_SPARE", "Spares", "NOS", (teeth * 22, teeth * 40), hsn="84834000", prod_days=9)
    for teeth in (12, 15, 18, 21, 24, 30, 36):
        add(f"Chain Sprocket 08B {teeth}T", "PROCESSED_SPARE", "Spares", "NOS", (teeth * 28, teeth * 46), hsn="84834000", prod_days=7)
    for dia in (80, 100, 125, 150, 200, 250):
        add(f"V-Belt Pulley A-Section {dia}mm", "PROCESSED_SPARE", "Spares", "NOS", (dia * 6, dia * 10), hsn="84835090", prod_days=6)

    # Finished goods — machines
    for machine, base in (("Ring Spinning Frame", 1850000), ("Speed Frame Simplex", 1420000), ("Draw Frame", 980000),
                          ("Assembly Winder", 640000), ("Two-for-One Twister", 1260000)):
        for spec in ("Standard", "Compact", "Long Length"):
            add(f"{machine} {spec}", "FINISHED_GOOD", "Machines", "NOS", (base * 0.9, base * 1.2), hsn="84452019", prod_days=45)
    return out


def add_items(db, user: User, target: int = 1000, *, limit: int | None = None, verbose: bool = False) -> int:
    """Top the item master up to ``target`` items (at most ``limit`` in this call); returns how many were added.
    Deterministic per remaining set, and safe to call repeatedly in batches."""
    rng = random.Random(20261016)
    existing = db.scalar(select(func.count()).select_from(Item)) or 0
    need = target - existing
    if need <= 0:
        return 0
    if limit is not None:
        need = min(need, limit)
    names = set(db.scalars(select(Item.name_normalized)))
    uoms = {u.code: u.id for u in db.scalars(select(Uom))}
    cats = {c.name: c.id for c in db.scalars(select(ItemCategory).where(ItemCategory.parent_id.is_(None)))}
    locs = [l.id for l in db.scalars(select(Location).where(Location.code.like("MAIN-R%")))]
    suppliers = list(db.scalars(select(Supplier)))

    catalogue = [c for c in _catalogue() if normalize_name(c["name"]) not in names]
    rng.shuffle(catalogue)
    created = 0
    for spec in catalogue[:need]:
        low, high = spec.pop("cost")
        uom_code, cat_name = spec.pop("uom"), spec.pop("category")
        cost = Decimal(str(round(rng.uniform(low, high), 2)))
        reorder = Decimal(rng.choice([0, 5, 10, 20, 25, 50, 100]) if uom_code != "KG" else rng.choice([100, 200, 500]))
        if spec["item_type"] == "FINISHED_GOOD":
            reorder = Decimal(0)
        data = {
            **spec,
            "uom_id": uoms[uom_code],
            "category_id": cats.get(cat_name),
            "gst_rate": Decimal(spec["gst_rate"]),
            "reorder_level": reorder,
            "min_stock": (reorder / 2).quantize(Decimal(1)),
            "max_stock": reorder * 6 if reorder else Decimal(0),
            "default_location_id": rng.choice(locs),
            "supplier_id": rng.choice(suppliers).id if suppliers and spec["item_type"] in ("PURCHASED_ITEM", "RAW_MATERIAL") else None,
            "description": "Demo catalogue item",
        }
        item = create_item(db, user, data, reviewed=True)

        # Stock profile: ~8% out of stock, ~15% low, the rest healthy.
        roll = rng.random()
        if data["item_type"] == "FINISHED_GOOD":
            qty = Decimal(rng.choice([0, 0, 1, 2]))
        elif roll < 0.08:
            qty = Decimal(0)
        elif roll < 0.23 and reorder:
            qty = Decimal(rng.randint(1, max(1, int(reorder))))
        else:
            qty = Decimal(rng.randint(int(reorder) + 1, int(reorder) * 5 + 40))
        if qty > 0:
            post_movement(db, user, MovementInput(
                txn_uuid=f"demo-catalog-{item.id}", movement_type=MovementType.OPENING, item_id=item.id, quantity=qty,
                to_location_id=data["default_location_id"], unit_cost=cost, ref_doc_type="OPENING", ref_doc_no="DEMO-CATALOG",
                source="import",
            ), _internal=True)
        created += 1
        if created % 100 == 0:
            db.commit()
            if verbose:
                print(f"  {created} items…")
    db.commit()
    return created


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=int, default=1000, help="total number of items wanted in the item master")
    args = parser.parse_args()
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == "stores")) or db.scalar(select(User).where(User.username == "admin"))
        if user is None:
            raise SystemExit("Run `python -m app.seed --demo` first.")
        created = add_items(db, user, args.target, verbose=True)
        total = db.scalar(select(func.count()).select_from(Item))
        print(f"Added {created} demo items. Item master now has {total} items.")


if __name__ == "__main__":
    main()
