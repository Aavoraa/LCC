"""Reference data: permissions, the 11 roles from spec §12, UOMs, stores layout, settings.

    python -m app.seed            # reference data + admin user
    python -m app.seed --demo     # also demo users per role and a few demo items posted through the real ledger
"""
from __future__ import annotations

import argparse
import os
import uuid
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import (
    Customer,
    ItemCategory,
    Location,
    MovementType,
    Permission,
    Role,
    Supplier,
    Uom,
    User,
    Warehouse,
)
from .security import hash_password
from .services.common import ensure_settings, next_number

PERMISSIONS = {
    "dashboard.view": "View executive dashboard",
    "items.view": "View item master and QR codes",
    "items.create": "Create items",
    "items.edit": "Edit item master data",
    "items.duplicate_override": "Create an item despite a possible-duplicate warning",
    "qr.generate": "Generate, regenerate and print QR labels",
    "stock.view": "View stock balances and ledger",
    "stock.receive": "Record stock receipts",
    "stock.issue": "Issue stock against authorized documents",
    "stock.transfer": "Transfer stock between locations",
    "stock.return": "Record stock returns",
    "stock.adjust.request": "Request stock adjustments",
    "stock.adjust.approve": "Approve stock adjustments (checker)",
    "qc.hold": "Place or release quality holds",
    "imports.create": "Upload and validate inventory imports",
    "imports.approve": "Approve inventory imports and opening stock (checker)",
    "sales.availability": "View available-to-promise and delivery estimates",
    "sales.enquiry": "Create sales enquiries",
    "sales.order": "Create quotations and sales orders, confirm orders and request delivery commitments",
    "sales.commit_approve": "Approve committed delivery dates (checker)",
    "purchase.view": "View purchase orders",
    "purchase.manage": "Create purchase orders",
    "purchase.approve": "Approve purchase orders (checker)",
    "masters.view": "View masters (suppliers, customers, locations)",
    "masters.manage": "Manage masters",
    "reports.view": "View reports",
    "audit.view": "View audit trail",
    "users.manage": "Manage users and roles",
    "machines.manage": "Maintain machine SOP spare lists and align them with stores items",
    "machines.requisition": "Raise purchase requisitions for SOP spare shortages",
    "production.view": "View WIP/PAD documents and work orders",
    "pad.manage": "Create and release WIP/PAD documents against sales orders (Planning & Design)",
    "production.manage": "Create work orders and run their process steps",
}

VIEW = ["dashboard.view", "items.view", "stock.view", "masters.view", "production.view"]
ROLES: dict[str, tuple[str, list[str]]] = {
    "SUPER_ADMIN": ("Super Admin", list(PERMISSIONS)),
    "MANAGEMENT": ("Management", VIEW + ["sales.availability", "purchase.view", "purchase.approve", "reports.view", "audit.view",
                                          "stock.adjust.approve", "imports.approve", "sales.commit_approve"]),
    "SALES": ("Sales", VIEW + ["sales.availability", "sales.enquiry", "sales.order"]),
    "STORES": ("Stores", VIEW + ["items.create", "items.edit", "qr.generate", "stock.receive", "stock.issue", "stock.transfer",
                                  "stock.return", "stock.adjust.request", "imports.create",
                                  "machines.manage", "machines.requisition"]),
    "PURCHASE": ("Purchase", VIEW + ["purchase.view", "purchase.manage", "stock.receive", "masters.manage", "sales.availability",
                                      "machines.requisition"]),
    "PLANNING": ("Planning & Design", VIEW + ["sales.availability", "purchase.view", "items.create", "items.edit", "machines.manage",
                                              "pad.manage", "production.manage"]),
    "PRODUCTION": ("Production", VIEW + ["stock.return", "purchase.view", "production.manage"]),
    "QC": ("QC", VIEW + ["qc.hold"]),
    "ACCOUNTS": ("Accounts", VIEW + ["purchase.view", "reports.view"]),
    "FINANCE_APPROVER": ("Finance Approver", VIEW + ["purchase.view", "purchase.approve", "reports.view", "imports.approve", "stock.adjust.approve"]),
    "AUDITOR": ("Auditor", VIEW + ["purchase.view", "sales.availability", "reports.view", "audit.view"]),
}

UOMS = [("NOS", "Numbers", 0), ("SET", "Set", 0), ("BOX", "Box", 0), ("KG", "Kilogram", 3), ("MTR", "Metre", 3), ("LTR", "Litre", 3)]


def seed_reference(db: Session) -> None:
    perms = {p.code: p for p in db.scalars(select(Permission))}
    for code, desc in PERMISSIONS.items():
        if code not in perms:
            perms[code] = Permission(code=code, description=desc)
            db.add(perms[code])
    db.flush()
    for code, (name, codes) in ROLES.items():
        role = db.scalar(select(Role).where(Role.code == code))
        if role is None:
            role = Role(code=code, name=name)
            db.add(role)
        role.permissions = [perms[c] for c in codes]
    for code, name, decimals in UOMS:
        if not db.scalar(select(Uom).where(Uom.code == code)):
            db.add(Uom(code=code, name=name, decimals=decimals))
    wh = db.scalar(select(Warehouse).where(Warehouse.code == "MAIN"))
    if wh is None:
        wh = Warehouse(code="MAIN", name="Main Stores")
        db.add(wh)
        db.flush()
        for rack in ("R01", "R02", "R03"):
            for b in ("B01", "B02", "B03", "B04"):
                db.add(Location(code=f"MAIN-{rack}-{b}", warehouse_id=wh.id, rack=rack, bin=b))
        db.add(Location(code="MAIN-QC-INSP", warehouse_id=wh.id, rack="QC", bin="INSP"))
        db.add(Location(code="MAIN-ASSY-WIP", warehouse_id=wh.id, rack="ASSY", bin="WIP"))
    for name in ("Fasteners", "Bearings", "Electrical", "Hydraulics", "Steel", "Castings", "Consumables", "Machines", "Spares"):
        if not db.scalar(select(ItemCategory).where(ItemCategory.name == name, ItemCategory.parent_id.is_(None))):
            db.add(ItemCategory(name=name))
    ensure_settings(db)
    db.flush()


def ensure_user(db: Session, username: str, full_name: str, role_codes: list[str], password: str) -> User:
    user = db.scalar(select(User).where(User.username == username))
    if user is None:
        user = User(username=username, full_name=full_name, password_hash=hash_password(password))
        db.add(user)
    user.roles = list(db.scalars(select(Role).where(Role.code.in_(role_codes))))
    db.flush()
    return user


def seed_demo(db: Session, password: str) -> None:
    from .services.items import create_item
    from .services.stock import MovementInput, post_movement

    demo_users = {
        "stores": ("Ravi Stores", ["STORES"]), "stores2": ("Meena Stores", ["STORES"]),
        "sales": ("Anil Sales", ["SALES"]), "purchase": ("Priya Purchase", ["PURCHASE"]),
        "qc": ("Suresh QC", ["QC"]), "manager": ("Lakshmi Management", ["MANAGEMENT"]),
        "accounts": ("Kavya Accounts", ["ACCOUNTS"]), "finance": ("Arjun Finance", ["FINANCE_APPROVER"]),
        "auditor": ("Deepa Auditor", ["AUDITOR"]), "planning": ("Vikram Planning", ["PLANNING"]),
        "production": ("Ganesh Production", ["PRODUCTION"]),
    }
    users = {u: ensure_user(db, u, n, r, password) for u, (n, r) in demo_users.items()}
    if not db.scalar(select(Supplier).limit(1)):
        db.add_all([
            Supplier(code=next_number(db, "supplier", "SUP-", 4), name="Sri Balaji Bearings", gstin="33ABCDE1234F1Z5", lead_time_days=10),
            Supplier(code=next_number(db, "supplier", "SUP-", 4), name="Coimbatore Steel Traders", gstin="33AACCS9876K1Z2", lead_time_days=7),
        ])
    if not db.scalar(select(Customer).limit(1)):
        db.add_all([
            Customer(code=next_number(db, "customer", "CUS-", 4), name="Kaveri Textiles Pvt Ltd", city="Tiruppur", transport_days=1),
            Customer(code=next_number(db, "customer", "CUS-", 4), name="Deccan Spinning Mills", city="Hyderabad", transport_days=3),
        ])
    db.flush()
    from .models import Item

    if db.scalar(select(Item).limit(1)):
        return
    uom = {u.code: u.id for u in db.scalars(select(Uom))}
    cat = {c.name: c.id for c in db.scalars(select(ItemCategory))}
    loc = {l.code: l.id for l in db.scalars(select(Location))}
    sup = db.scalars(select(Supplier)).all()
    stores = users["stores"]
    demo_items = [
        ({"name": "Deep Groove Ball Bearing 6205-2RS", "item_type": "PURCHASED_ITEM", "uom_id": uom["NOS"], "category_id": cat["Bearings"],
          "manufacturer": "SKF", "make_model": "6205-2RS", "supplier_id": sup[0].id, "reorder_level": Decimal(40), "min_stock": Decimal(20),
          "max_stock": Decimal(400), "hsn_code": "84821011", "gst_rate": Decimal(18), "default_location_id": loc["MAIN-R01-B01"]}, 120, Decimal("185.00")),
        ({"name": "MS Round Bar EN8 40mm", "item_type": "RAW_MATERIAL", "uom_id": uom["KG"], "category_id": cat["Steel"],
          "supplier_id": sup[1].id, "reorder_level": Decimal(500), "max_stock": Decimal(3000), "hsn_code": "72142090", "gst_rate": Decimal(18),
          "default_location_id": loc["MAIN-R02-B01"]}, 850, Decimal("72.50")),
        ({"name": "Spindle Shaft Ring Frame", "item_type": "PROCESSED_SPARE", "uom_id": uom["NOS"], "category_id": cat["Spares"],
          "reorder_level": Decimal(10), "max_stock": Decimal(80), "production_lead_days": 12, "hsn_code": "84483990", "gst_rate": Decimal(18),
          "default_location_id": loc["MAIN-R03-B02"]}, 6, Decimal("2450.00")),
        ({"name": "Cotton Waste Cleaning Cloth", "item_type": "DAILY_CONSUMABLE", "uom_id": uom["KG"], "category_id": cat["Consumables"],
          "reorder_level": Decimal(25), "max_stock": Decimal(200), "default_location_id": loc["MAIN-R03-B04"]}, 60, Decimal("48.00")),
    ]
    for data, qty, cost in demo_items:
        item = create_item(db, stores, data)
        post_movement(db, stores, MovementInput(txn_uuid=str(uuid.uuid4()), movement_type=MovementType.RECEIPT, item_id=item.id,
                                                quantity=Decimal(qty), to_location_id=data["default_location_id"], unit_cost=cost,
                                                ref_doc_type="OPENING", ref_doc_no="DEMO"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--demo", action="store_true")
    args = parser.parse_args()
    password = os.environ.get("SEED_PASSWORD", "ChangeMe@123")
    with SessionLocal() as db:
        seed_reference(db)
        ensure_user(db, os.environ.get("ADMIN_USERNAME", "admin"), "System Administrator", ["SUPER_ADMIN"], password)
        if args.demo:
            seed_demo(db, password)
        db.commit()
    print("Seed complete." + (" Demo users share SEED_PASSWORD." if args.demo else ""))


if __name__ == "__main__":
    main()
