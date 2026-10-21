"""Card Service Machines and their SOP spare lists, transcribed from the LCC catalogue
"Card Service Machines" (October 2023 edition, 28 pages).

    python -m app.machine_catalog                    # load / refresh machines and spare lists
    python -m app.machine_catalog --align            # also link spares to identically named stores items
    python -m app.machine_catalog --align --create-missing   # and create the remaining spares as stores items

Basis of each spare line:
* CATALOGUE — the part is named in the catalogue (components, tools & accessories pages).
* DERIVED   — the catalogue describes the feature/spec (e.g. "inverter drive with remote control",
              motor rating) but does not list it as a spare; included as a standard maintenance spare.
SOP stock quantities are proposed defaults (A = critical wear part, B = important, C = order on demand)
for the stores team to review and adjust on the Machines page.
"""
from __future__ import annotations

import argparse
from decimal import Decimal

from sqlalchemy import select

from .db import SessionLocal
from .models import Machine, MachineSpare, User
from .services.common import audit, normalize_name

SRC = "LCC Card Service Machines catalogue, Oct 2023"

# spare tuple: (name, group, criticality, qty_per_machine, sop_stock, uom, basis, page, notes)
MACHINES: list[dict] = [
    {
        "code": "CSM-WME", "name": "Metallic Wire Mounting Equipment", "models": "40\" / 51\" / 54\" / 60\"", "pages": "4-5",
        "description": "Mounts cylinder and doffer metallic wires. Single bar system, geared motor and A/C inverter drive with remote control, "
                       "three-jaw chuck, tensioning device with dressing and pre-bending rollers, butt welding machine included.",
        "specs": {"Motor": "Three phase, 1.5 hp, 1400 rpm", "Working width": "40\", 51\", 54\" & 60\"",
                  "Tension device calibration": "0 - 12 kg", "Mounting speed": "0 - 45 rpm (variable)"},
        "spares": [
            ("Tipped Finger for Wire Mounting Equipment", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, None),
            ("Finger Guide Roller Assembly (Roller Finger)", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, None),
            ("11-Up Roller Assembly Complete for Wire Mounting Machine", "WEAR", "A", 1, 1, "SET", "CATALOGUE", 24, "1 set = 11 nos."),
            ("Servo 11 CAM Cleat 3-7 mm SV11 with Wire Fairlead", "WEAR", "B", 1, 1, "NOS", "CATALOGUE", 24, None),
            ("Ceramic Guide Plate Plain", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, "Cylinder & doffer guide plate"),
            ("Ceramic Guide Plate Stepped", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, "Cylinder & doffer guide plate"),
            ("Carbide Guide Plate Plain", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, "Cylinder & doffer guide plate"),
            ("Carbide Guide Plate Stepped", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, "Cylinder & doffer guide plate"),
            ("Pre-Bending Roller for Wire Tensioning Device", "WEAR", "B", 1, 1, "NOS", "DERIVED", 4, "Tensioning device with dressing and pre-bending rollers"),
            ("Dressing Roller for Wire Tensioning Device", "WEAR", "B", 1, 1, "NOS", "DERIVED", 4, "Tensioning device with dressing and pre-bending rollers"),
            ("Three Jaw Self-Centering Chuck Jaw Set (25-65 mm shafts)", "MECHANICAL", "C", 1, 0, "SET", "DERIVED", 4, "Chuck adjustable for shaft diameters 25 - 65 mm"),
            ("Geared Motor 3-Phase 1.5 HP 1400 RPM", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 5, None),
            ("AC Inverter Drive 1.5 HP with Remote Control", "ELECTRICAL", "B", 1, 1, "NOS", "DERIVED", 4, "Portable drive unit with inverter and remote control"),
            ("Inverter Remote Control Pendant", "ELECTRICAL", "B", 1, 1, "NOS", "DERIVED", 4, None),
            ("Soldering Iron 500 W with Tin/Lead and Flux", "TOOLING", "B", 1, 1, "SET", "CATALOGUE", 25, "Wire joining"),
        ],
    },
    {
        "code": "CSM-MRM", "name": "Multi Roller Mounting Machine", "models": "Up to 1600 mm length, 20\" dia", "pages": "6-7",
        "description": "Mounts cylinder/doffer wires, grooved and interlock lickerins, blowroom beaters, feed and stripper rollers, "
                       "stripping and emery fillets. Aluminium extruded frame, LM guideway bed, inverter drive with remote control.",
        "specs": {"Motor": "Three phase, 1.5 hp, 1400 rpm", "Effective working width": "1600 mm",
                  "Roller capacity": "Up to 1600 mm length & 20\" diameter"},
        "spares": [
            ("Carbide Plate 8VG", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, "Interlock wire guide"),
            ("Carbide Plate 12VG", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, "Interlock wire guide"),
            ("Carbide Plate 16VG", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, "Interlock wire guide"),
            ("Carbide Plate Female 8VG", "WEAR", "A", 1, 1, "NOS", "CATALOGUE", 24, None),
            ("Carbide Plate Male for 6-32VG", "WEAR", "A", 1, 1, "NOS", "CATALOGUE", 24, None),
            ("Carbide Plate Female 12-16VG", "WEAR", "A", 1, 1, "NOS", "CATALOGUE", 24, None),
            ("Carbide Plate for Grooved Lickerin (2 mm) - MRM", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, None),
            ("Ceramic Guide Plate Plain", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, "Cylinder & doffer guide plate"),
            ("Ceramic Guide Plate Stepped", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, "Cylinder & doffer guide plate"),
            ("Carbide Guide Plate Plain", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, "Cylinder & doffer guide plate"),
            ("Carbide Guide Plate Stepped", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 24, "Cylinder & doffer guide plate"),
            ("Press Roller Assembly for Lickerin and ERM Beater", "WEAR", "A", 1, 1, "NOS", "CATALOGUE", 25, None),
            ("LM Guideway Block and Rail Set - MRM Mounting Bed", "MECHANICAL", "C", 1, 0, "SET", "DERIVED", 6, "Linear motion guideway supported bed"),
            ("Three Jaw Self-Centering Chuck Jaw Set (25-65 mm shafts)", "MECHANICAL", "C", 1, 0, "SET", "DERIVED", 6, "Chuck adjustable for shaft diameters 25 - 65 mm"),
            ("3-Phase Motor 1.5 HP 1400 RPM", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 7, None),
            ("AC Inverter Drive 1.5 HP with Remote Control", "ELECTRICAL", "B", 1, 1, "NOS", "DERIVED", 6, None),
            ("Inverter Remote Control Pendant", "ELECTRICAL", "B", 1, 1, "NOS", "DERIVED", 6, None),
            ("Soldering Iron 500 W with Tin/Lead and Flux", "TOOLING", "B", 1, 1, "SET", "CATALOGUE", 25, "Wire joining"),
        ],
    },
    {
        "code": "CSM-FEM", "name": "Flat End Milling Machine", "models": "40\" / 51\" / 54\" / 60\"", "pages": "8-9",
        "description": "Automated milling of flat ends with interchangeable templates per card model, pneumatic foot-pedal clamping, "
                       "centralised lubrication. Supplied with inspection fixture (0.01 mm dial gauge).",
        "specs": {"Cutter motor": "Three phase, 1.5 hp, 1410 rpm", "Carriage drive motor": "1 hp, 1400 rpm",
                  "Cast iron flats": "250 rpm (HSS cutter, 0.5 mm land)", "RTR C4 / C50 / C51": "500 rpm (carbide cutter)",
                  "RTR C60 / C70 flats": "500 rpm (HSS cutter, 0.5 mm land)", "LMW LC361 / 363 flats": "1500 rpm (HSS cutter, 0.2 mm land)"},
        "spares": [
            ("HSS Milling Cutter 0.5 mm Land (Cast Iron / RTR C60-C70 Flats)", "TOOLING", "A", 1, 2, "NOS", "DERIVED", 9, "Per spindle speed table"),
            ("HSS Milling Cutter 0.2 mm Land (LMW LC361/363 Flats)", "TOOLING", "A", 1, 2, "NOS", "DERIVED", 9, "Per spindle speed table"),
            ("Solid Carbide Milling Cutter", "TOOLING", "A", 1, 2, "NOS", "CATALOGUE", 25, "RTR C4 / C50 / C51 flats"),
            ("HSS Milling Cutter for Shoe Type Polymer End Connector", "TOOLING", "B", 1, 1, "NOS", "CATALOGUE", 25, None),
            ("Milling Template 150 mm RTR C60/C70 0.6 R415", "TOOLING", "B", 1, 1, "NOS", "CATALOGUE", 25, None),
            ("Milling Template LC363/361/636 Ring Cotton 0.4 mm", "TOOLING", "B", 1, 1, "NOS", "CATALOGUE", 25, None),
            ("Milling Template LC363/361/636 OE Cotton and Synthetic 0.6 mm", "TOOLING", "B", 1, 1, "NOS", "CATALOGUE", 25, None),
            ("Milling Template 0.55 mm Cast Iron", "TOOLING", "B", 1, 1, "NOS", "CATALOGUE", 25, None),
            ("Dial Gauge Type KO2 0.01 mm for Flat End Milling Inspection Device", "INSPECTION", "B", 1, 1, "NOS", "CATALOGUE", 26, None),
            ("Pneumatic Foot Pedal Valve for Flat Clamping", "PNEUMATIC", "B", 1, 1, "NOS", "DERIVED", 8, "Pneumatic clamping with foot pedal system"),
            ("Centralised Lubrication Hand Pump with Distributor", "MECHANICAL", "C", 1, 0, "NOS", "DERIVED", 8, None),
            ("Milling Cutter Motor 3-Phase 1.5 HP 1410 RPM", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 9, None),
            ("Carriage Drive Motor 1 HP 1400 RPM", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 9, None),
        ],
    },
    {
        "code": "CSM-LFCM", "name": "Lakshmi Flat Clipping Machine", "models": "LFCM 100, LFCM 40", "pages": "10-11",
        "description": "Fully automatic PLC-controlled flat clipping with split-type top-pressed mounting head, LM guideways on both sides, "
                       "ball screw with encoder, light-curtain safety, de-clipping attachment.",
        "specs": {"Brake motor": "Three phase, 1.5 hp, 960 rpm", "Effective working width": "40\", 51\", 54\" & 60\"",
                  "Pneumatic air pressure": "4 to 6 bar"},
        "spares": [
            ("Pre-Bending Roller Assembly for Lakshmi Flat Clipping Machine", "WEAR", "A", 1, 1, "NOS", "CATALOGUE", 26, None),
            ("Form Roller Assembly 5 Deg (LFCM Split Spindle)", "WEAR", "A", 1, 1, "NOS", "CATALOGUE", 26, None),
            ("Form Roller Assembly 10 Deg (LFCM Split Spindle)", "WEAR", "A", 1, 1, "NOS", "CATALOGUE", 26, None),
            ("Form Roller Assembly 15 Deg (LFCM Split Spindle)", "WEAR", "A", 1, 1, "NOS", "CATALOGUE", 26, None),
            ("Form Roller Assembly 20 Deg (LFCM Split Spindle)", "WEAR", "A", 1, 1, "NOS", "CATALOGUE", 26, None),
            ("Stripping Tool for Flat De-Clipping", "TOOLING", "B", 1, 1, "NOS", "CATALOGUE", 26, None),
            ("Clamp Support Plate - All Cards", "TOOLING", "B", 1, 1, "NOS", "CATALOGUE", 26, None),
            ("Clamping Support Plate for TRTZLR Cards Aluminium Flats", "TOOLING", "C", 1, 0, "NOS", "CATALOGUE", 26, None),
            ("Clamping Support Plate LH and RH for RTR C60/C70/C72/C75 Cards", "TOOLING", "C", 1, 0, "SET", "CATALOGUE", 26, None),
            ("Dial Gauge 3046S Mitutoyo for Flat Clipping and Grinding Inspection", "INSPECTION", "B", 1, 1, "NOS", "CATALOGUE", 26, None),
            ("Light Curtain Safety Sensor Pair - LFCM", "ELECTRICAL", "B", 1, 1, "SET", "DERIVED", 11, "Stops machine on interference"),
            ("Rotary Encoder for Ball Screw Clipping Drive", "ELECTRICAL", "B", 1, 1, "NOS", "DERIVED", 11, "Ball screw rod with encoder"),
            ("Electronic Air Pressure Indicator - LFCM", "PNEUMATIC", "C", 2, 0, "NOS", "DERIVED", 10, "Dual electronic pressure indicator"),
            ("Top-Press Pneumatic Piston Seal Kit - LFCM", "PNEUMATIC", "A", 1, 2, "SET", "DERIVED", 10, "Fully top pressed pistons"),
            ("LM Guideway Block and Rail Set - LFCM Bed", "MECHANICAL", "C", 2, 0, "SET", "DERIVED", 10, "Guideways on both sides of the bed"),
            ("Brake Motor 3-Phase 1.5 HP 960 RPM", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 11, None),
        ],
    },
    {
        "code": "CSM-LFGM", "name": "Lakshmi Flat Grinding Machine", "models": "LFGM 60, LFGM 40", "pages": "12-13",
        "description": "Single-flat grinding with dynamically balanced grinding roller (ceramic stone or emery fillet), automatic roller feed, "
                       "interchangeable grinding plates, dust extraction, centralised lubrication, 60\"-40\"/51\"/54\" conversions.",
        "specs": {"Drive motor": "Three phase, 1.5 hp, 1400 rpm", "Dust extraction": "0.8 hp, 2880 rpm",
                  "Flat width": "40\", 51\", 54\" & 60\"", "Grinding roller": "Ceramic stone or emery fillet"},
        "spares": [
            ("Ceramic Grinding Stone for Flat Grinding Roller", "WEAR", "A", 1, 1, "NOS", "DERIVED", 13, "Grinding roller option"),
            ("Emery Fillet for Flat Grinding Roller", "WEAR", "A", 1, 2, "NOS", "DERIVED", 13, "Grinding roller option"),
            ("Stone Truing Attachment - LFGM", "TOOLING", "B", 1, 1, "NOS", "CATALOGUE", 13, None),
            ("Interchangeable Grinding Plate Set - LFGM", "TOOLING", "B", 1, 1, "SET", "DERIVED", 12, None),
            ("Dial Gauge 3046S Mitutoyo for Flat Clipping and Grinding Inspection", "INSPECTION", "B", 1, 1, "NOS", "CATALOGUE", 26, None),
            ("Dust Extraction Motor 0.8 HP 2880 RPM", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 13, None),
            ("3-Phase Motor 1.5 HP 1400 RPM", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 13, None),
            ("Centralised Lubrication Hand Pump with Distributor", "MECHANICAL", "C", 1, 0, "NOS", "DERIVED", 12, None),
        ],
    },
    {
        "code": "CSM-TSD", "name": "Traverse Sharpening Device", "models": "TSD 100, TSD 40", "pages": "14-15",
        "description": "Traverse re-sharpening head with stationary spring-loaded ceramic stone, toothed-belt traverse, digital traverse counter, "
                       "cylinder/doffer speed selector. Supplied with trolley.",
        "specs": {"Motor": "0.18 kW three phase 230 / 415 V", "Input supply": "Three phase 380-440 V 50 Hz via step-down transformer",
                  "Machine input": "Single phase 230 V 50 Hz", "Cylinder wire traverse": "6 m/min", "Doffer wire traverse": "1 m/min",
                  "Weight": "23 kg (excluding trolley)"},
        "spares": [
            ("Traverse Sharpening Device - Sharpening Stone", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 26, None),
            ("Toothed Belt for TSD Traverse Drive", "WEAR", "B", 1, 1, "NOS", "DERIVED", 14, "Traverse movement with toothed belt"),
            ("Stone Loading Spring - TSD Head", "WEAR", "B", 1, 2, "NOS", "DERIVED", 14, "Spring-loaded ceramic stone"),
            ("TSD Drive Motor 0.18 kW 3-Phase", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 15, None),
            ("Digital Traverse Counter - TSD", "ELECTRICAL", "B", 1, 1, "NOS", "DERIVED", 15, None),
            ("Cylinder/Doffer Speed Selector Switch - TSD", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 15, None),
            ("Step-Down Transformer 415/230 V - TSD", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 15, None),
        ],
    },
    {
        "code": "CSM-OFGM", "name": "Restore - On the Card Flats Grinding Machine", "models": "OFGM 60, OFGM 40", "pages": "16-17",
        "description": "Light-weight aluminium extruded roller mounted with emery fillet, dynamically balanced, traverse gear mechanism, "
                       "supplied with trolley. 40\", 51\" and 60\" versions.",
        "specs": {"Motor": "Three phase, 0.5 hp, 1440 rpm", "Emery fillet": "Silicarbo No.7 (grooved type)", "Emery roller speed": "750 rpm",
                  "Roller diameter": "226 mm (RTR / TRTZLR / LAKSHMI / CRSL MK6, MK7); 150 mm (CRSL MK4, MK5)"},
        "spares": [
            ("Emery Fillet Silicarbo No.7 Grooved", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 17, None),
            ("OFGM Emery Roller Dia 226 mm", "WEAR", "B", 1, 1, "NOS", "CATALOGUE", 17, "RTR / TRTZLR / LAKSHMI / CRSL MK6, MK7"),
            ("OFGM Emery Roller Dia 150 mm", "WEAR", "C", 1, 0, "NOS", "CATALOGUE", 17, "CRSL MK4, MK5"),
            ("Traverse Gear Mechanism Gear Set - OFGM", "MECHANICAL", "B", 1, 1, "SET", "CATALOGUE", 17, None),
            ("3-Phase Induction Motor 0.5 HP 1440 RPM", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 17, "Matches catalogue motor rating"),
        ],
    },
    {
        "code": "CSM-WDM", "name": "Wire De-Mounting Machine", "models": "Up to 60\"", "pages": "18-19",
        "description": "Inverter-driven wire de-mounting with remote control, cylinder brake, roll ring traverse unit for uniform unwinding, "
                       "wire guide for reverse unwinding, adjustable spool holder, inbuilt trolley.",
        "specs": {"Motor": "Three phase, 1.5 hp, 1000 rpm", "Working width": "Up to 60\"", "Demounting speed": "Up to 50 rpm",
                  "Supply": "415 / 380 V, 3 phase, 50 Hz", "Drive power / MCB": "2 hp / 10 A", "Dimensions (LxHxW)": "950 x 730 x 782 mm"},
        "spares": [
            ("Roll Ring Traverse Unit - Wire De-Mounting", "MECHANICAL", "B", 1, 1, "NOS", "CATALOGUE", 18, None),
            ("Wire Guide for Reverse Unwinding", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 18, None),
            ("Cylinder Brake Pad Set - Wire De-Mounting", "WEAR", "A", 1, 2, "SET", "DERIVED", 18, "Cylinder brake"),
            ("Adjustable Spool Holder - Wire De-Mounting", "MECHANICAL", "C", 1, 0, "NOS", "DERIVED", 19, None),
            ("VFD Drive 2 HP", "ELECTRICAL", "B", 1, 1, "NOS", "DERIVED", 19, "Drive power 2 hp; remote control"),
            ("Inverter Remote Control Pendant", "ELECTRICAL", "B", 1, 1, "NOS", "DERIVED", 18, None),
            ("MCB 10A TP C-Curve", "ELECTRICAL", "B", 1, 1, "NOS", "DERIVED", 19, "MCB rating 10 A, 3 phase; trip curve to be confirmed"),
            ("3-Phase Motor 1.5 HP 1000 RPM", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 19, None),
        ],
    },
    {
        "code": "CSM-BCG", "name": "Bare Cylinder Grinder", "models": "BCG 40", "pages": "20-21",
        "description": "Grinds bare cylinders/doffers true. Strong tube on ball bearings, V-belt drive, rugged steel bed, built-in dressing "
                       "attachment, threaded spindle to set parallel. Supplied with trolley.",
        "specs": {"Motor": "Three phase, 3 hp, 1400 rpm", "Effective working width": "40\"", "Grinding wheel diameter": "350 mm",
                  "Stone for cast iron": "C36 15VG", "Stone for steel": "A36 K5 V10", "Run-out accuracy": "0.02 - 0.03 mm",
                  "Grinding roller speed": "1100 rpm"},
        "spares": [
            ("Grinding Wheel 350 mm C36 15VG (Cast Iron)", "WEAR", "A", 1, 1, "NOS", "CATALOGUE", 21, None),
            ("Grinding Wheel 350 mm A36 K5 V10 (Steel)", "WEAR", "A", 1, 1, "NOS", "CATALOGUE", 21, None),
            ("Stone Dresser Unit - BCG", "TOOLING", "B", 1, 1, "NOS", "CATALOGUE", 21, None),
            ("V-Belt Set - BCG 40 Drive", "WEAR", "B", 1, 1, "SET", "DERIVED", 20, "Driven by electric motor through V belts"),
            ("Grinding Tube Ball Bearing Set - BCG", "MECHANICAL", "B", 1, 1, "SET", "DERIVED", 20, "Strong tube on ball bearings"),
            ("3-Phase Motor 3 HP 1400 RPM", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 21, None),
        ],
    },
    {
        "code": "CSM-MTWG", "name": "Motorised Traverse Wheel Grinder", "models": "MTWG 40", "pages": "22-23",
        "description": "Self-driven traverse wheel grinder with cross spindle inside a toughened steel tube, simple truing device. "
                       "Also available with pulley drive. Supplied with trolley.",
        "specs": {"Motor": "Three phase, 0.5 hp, 1380 rpm", "Effective working width": "40\"", "Grinding wheel diameter": "180 mm",
                  "Grinding wheel": "25A 54 G 19 VCR, 180 x 137 x 90 mm", "Grinding roller speed": "850 rpm"},
        "spares": [
            ("Grinding Wheel 25A 54 G 19 VCR 180x137x90 mm", "WEAR", "A", 1, 2, "NOS", "CATALOGUE", 23, None),
            ("Wheel Truing Device - MTWG", "TOOLING", "B", 1, 1, "NOS", "DERIVED", 23, "Simple truing device for dressing"),
            ("Cross Spindle Bearing Set - MTWG", "MECHANICAL", "B", 1, 1, "SET", "DERIVED", 22, "Cross spindle inside toughened steel tube"),
            ("Drive Pulley - MTWG Pulley Drive Version", "MECHANICAL", "C", 1, 0, "NOS", "CATALOGUE", 23, "Only for pulley-drive version"),
            ("3-Phase Motor 0.5 HP 1380 RPM", "ELECTRICAL", "C", 1, 0, "NOS", "DERIVED", 23, None),
        ],
    },
    {
        "code": "CSM-ACC", "name": "Card Setting & Inspection Accessories (common)", "models": "All card service machines", "pages": "24-27",
        "sellable": False, "family": "Accessories",
        "description": "Common tools and accessories used across card service work: card setting gauges, hand stones, burnishing pad and "
                       "wire inspection aids.",
        "specs": {},
        "spares": [
            ("Burnishing Pad 203 x 103 x 25 mm", "CONSUMABLE", "A", 1, 4, "NOS", "CATALOGUE", 25, None),
            ("Oil Stone 150 x 50 x 25 mm", "CONSUMABLE", "A", 1, 4, "NOS", "CATALOGUE", 25, "Hand grinding stone"),
            ("Card Setting Leaf Gauge with Handle - Individual Leaf", "INSPECTION", "B", 1, 4, "NOS", "CATALOGUE", 27, None),
            ("Card Setting Leaf Gauge 300 x 30 mm (4-12/1000)", "INSPECTION", "B", 1, 2, "SET", "CATALOGUE", 27, "12\" with 4,5,6,7,8,10 and 12/1000"),
            ("Card Setting Leaf Gauge 400 x 30 mm (4-12/1000)", "INSPECTION", "B", 1, 2, "SET", "CATALOGUE", 27, "4,5,6,7,8,10 and 12/1000"),
            ("Flat Setting Gauge with Handle (7T-14)", "INSPECTION", "B", 1, 2, "SET", "CATALOGUE", 27,
             "7T (0.175 mm), 8T (0.20), 9 (0.225), 10 (0.25), 12 (0.30) & 14 (0.35 mm)"),
            ("Dinolite AM2111 Digital Microscope", "INSPECTION", "C", 1, 0, "NOS", "CATALOGUE", 27, "Wire inspection via laptop / phone"),
            ("Magnifying Glass 30X for Wire Inspection", "INSPECTION", "B", 1, 2, "NOS", "CATALOGUE", 27, None),
        ],
    },
]


def load(db, user: User | None) -> dict:
    """Insert or refresh machines and spare lines. Existing lines keep their store alignment and any
    SOP quantities the stores team has edited; only catalogue text fields are refreshed."""
    added_m = added_s = 0
    for spec in MACHINES:
        m = db.scalar(select(Machine).where(Machine.code == spec["code"]))
        if m is None:
            m = Machine(code=spec["code"])
            db.add(m)
            added_m += 1
        m.name, m.models, m.description = spec["name"], spec["models"], spec["description"]
        m.family = spec.get("family", "Card Service Machines")
        m.specifications = spec["specs"]
        m.source = f"{SRC}, pages {spec['pages']}"
        db.flush()
        existing = {s.name_normalized: s for s in m.spares}
        next_line = max((s.line_no for s in m.spares), default=0)
        for name, group, crit, qty, sop, uom, basis, page, notes in spec["spares"]:
            norm = normalize_name(name)
            s = existing.get(norm)
            if s is None:
                next_line += 1
                s = MachineSpare(machine_id=m.id, line_no=next_line, part_no=f"{m.code}-{next_line:03d}", name=name, name_normalized=norm,
                                 group=group, criticality=crit, qty_per_machine=Decimal(qty), sop_stock=Decimal(sop), uom_code=uom)
                db.add(s)
                added_s += 1
            s.basis, s.source_ref, s.notes = basis, f"Catalogue p.{page}", notes
        db.flush()
        db.refresh(m)
        if spec.get("sellable", True) and user is not None:
            from .services.machines import ensure_machine_item

            ensure_machine_item(db, user, m)
    audit(db, user, "machine.catalog.load", "machine", None, {"machines_added": added_m, "spares_added": added_s})
    return {"machines_added": added_m, "spares_added": added_s}


def main() -> None:
    from .services.machines import align_machine

    parser = argparse.ArgumentParser()
    parser.add_argument("--align", action="store_true", help="link spares to identically named stores items")
    parser.add_argument("--create-missing", action="store_true", help="with --align: create unmatched spares as stores items")
    args = parser.parse_args()
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == "stores")) or db.scalar(select(User).where(User.username == "admin"))
        print(load(db, user))
        if args.align:
            for m in db.scalars(select(Machine).order_by(Machine.code)):
                print(m.code, align_machine(db, user, m, create_missing=args.create_missing))
        db.commit()


if __name__ == "__main__":
    main()
