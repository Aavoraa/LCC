"""Sample business activity on top of the demo item master, so every screen has something to show.

    python -m app.seed --demo           # roles, locations, demo users (one per role), suppliers, customers
    python -m app.demo_catalog          # 1,000 products with QR codes and opening stock
    python -m app.machine_catalog --align --create-missing
    python -m app.demo_activity         # this script

Everything goes through the normal services (ledger, reservations, maker-checker, job-work challans, document checks),
then the dates are spread over the last few weeks so the dashboard, ledger and reports look like a running unit.
Runs once: it stops if purchase orders already exist.
"""
from __future__ import annotations

import random
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

from sqlalchemy import func, select

from .db import SessionLocal
from .models import (
    CycleCount,
    Customer,
    Item,
    ItemType,
    JobWorkChallan,
    Location,
    Machine,
    MovementType,
    PurchaseOrder,
    PurchaseOrderLine,
    SalesEnquiry,
    SalesOrder,
    StockBalance,
    StockMovement,
    Supplier,
    User,
    WorkOrder,
)
from .services import documents as docs
from .services import process, production, sales
from .services.availability import estimate_delivery
from .services.common import audit, next_number
from .services.stock import MovementInput, post_movement, request_adjustment

IST = timezone(timedelta(hours=5, minutes=30))
rng = random.Random(20261026)
D = Decimal


def _u(db, username: str) -> User:
    user = db.scalar(select(User).where(User.username == username))
    if user is None:
        raise RuntimeError(f"User {username} missing - load the demo users first (python -m app.seed --demo)")
    return user


def _move(db, user, **kw):
    return post_movement(db, user, MovementInput(txn_uuid=f"demo-{uuid.uuid4()}", **kw))[0]


def _available(db, item_id: int) -> list[StockBalance]:
    return [b for b in db.scalars(select(StockBalance).where(StockBalance.item_id == item_id)) if b.qty_available > 0]


def _jsonable(v):
    if isinstance(v, Decimal):
        return format(v.normalize(), "f")
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    return v


def _pdf(lines: list[str]) -> bytes:
    """A one-page text PDF (no external libraries) standing in for a scanned supplier document."""
    ops, y = [], 800
    for t in lines:
        t = t.replace("\\", "/").replace("(", "[").replace(")", "]")
        ops.append(f"BT /F1 10 Tf 40 {y} Td ({t}) Tj ET")
        y -= 16
    stream = "\n".join(ops).encode("latin-1", "replace")
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream", b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"]
    out, offs = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    return out + b"trailer << /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)


# ------------------------------------------------------------------ masters
SUPPLIERS = [
    ("Sri Balaji Bearings", "33ABCDE1234F1Z5", "12 Avinashi Road, Peelamedu, Coimbatore 641004", "0422-2571234", 10),
    ("Coimbatore Steel Traders", "33AACCS9876K1Z2", "45 Mettupalayam Road, Coimbatore 641043", "0422-2445566", 7),
    ("Sakthi Heat Treatment Industry", "33AAKFS4521M1Z8", "6/115 A, Pannimadai Road, Coimbatore 641017", "0422-2692450", 5),
    ("Precision Grinders Coimbatore", "33AAGFP7788Q1Z3", "SIDCO Industrial Estate, Kurichi, Coimbatore 641021", "0422-2672310", 4),
    ("Rathna Electricals", "33AAHFR3344L1Z9", "88 Big Bazaar Street, Coimbatore 641001", "0422-2391122", 6),
    ("Mumbai Fasteners Co", "27AABCM5566N1Z4", "Plot 23, MIDC Bhosari, Pune 411026", "020-27121234", 12),
]
CUSTOMERS = [
    ("Kaveri Textiles Pvt Ltd", "Tiruppur", 1), ("Deccan Spinning Mills", "Hyderabad", 3), ("Sri Ganapathy Mills", "Rajapalayam", 2),
    ("Vardhman Cotspin", "Ludhiana", 5), ("Bannari Amman Spinning", "Sathyamangalam", 1),
]


def masters(db, purchase: User) -> tuple[dict[str, Supplier], list[Customer]]:
    sups = {}
    for name, gstin, address, phone, lead in SUPPLIERS:
        s = db.scalar(select(Supplier).where(Supplier.name == name))
        if s is None:
            s = Supplier(code=next_number(db, "supplier", "SUP-", 4), name=name)
            db.add(s)
        s.gstin, s.address, s.phone, s.lead_time_days = gstin, address, phone, lead
        sups[name] = s
    for name, city, days in CUSTOMERS:
        if not db.scalar(select(Customer).where(Customer.name == name)):
            db.add(Customer(code=next_number(db, "customer", "CUS-", 4), name=name, city=city, transport_days=days))
    db.flush()
    return sups, list(db.scalars(select(Customer).order_by(Customer.id)))


# ------------------------------------------------------------------ purchasing
def purchasing(db, u: dict[str, User], sups: dict[str, Supplier]) -> list[PurchaseOrder]:
    bought = list(db.scalars(select(Item).where(Item.item_type.in_((ItemType.PURCHASED_ITEM, ItemType.RAW_MATERIAL)),
                                               Item.is_active.is_(True)).order_by(Item.id).limit(400)))
    rng.shuffle(bought)
    receiving = {l.code: l.id for l in db.scalars(select(Location))}
    plan = [  # (supplier, lines, outcome)
        ("Sri Balaji Bearings", 3, "received"), ("Coimbatore Steel Traders", 2, "received"), ("Rathna Electricals", 3, "qc_hold"),
        ("Mumbai Fasteners Co", 3, "partial"), ("Sri Balaji Bearings", 2, "approved"), ("Coimbatore Steel Traders", 2, "approved"),
        ("Rathna Electricals", 2, "draft"),
    ]
    pos = []
    for n, (sup_name, n_lines, outcome) in enumerate(plan):
        po = PurchaseOrder(number=next_number(db, "purchase_order", "PO-", 5), supplier_id=sups[sup_name].id, order_date=date.today(),
                           created_by_id=u["purchase"].id)
        for _ in range(n_lines):
            item = bought.pop()
            qty = D(rng.choice([20, 25, 40, 50, 100])) if item.uom.code != "KG" else D(rng.choice([200, 300, 500]))
            price = (D(item.avg_cost or 0) * D(str(rng.uniform(0.95, 1.08)))).quantize(D("0.01")) or D("100.00")
            po.lines.append(PurchaseOrderLine(item_id=item.id, qty_ordered=qty, unit_price=price,
                                              expected_date=date.today() + timedelta(days=rng.randint(-3, 12))))
        db.add(po)
        db.flush()
        audit(db, u["purchase"], "purchase.po.create", "purchase_order", po.id, {"number": po.number, "demo": True})
        if outcome != "draft":
            po.status, po.approved_by_id = "APPROVED", u["manager"].id
            audit(db, u["manager"], "purchase.po.approve", "purchase_order", po.id, {"number": po.number, "demo": True})
        if outcome in ("received", "qc_hold", "partial"):
            for i, line in enumerate(po.lines):
                qty = D(line.qty_ordered) if outcome != "partial" or i == 0 else (D(line.qty_ordered) / 2).quantize(D("1"))
                loc = line.item.default_location_id or receiving["MAIN-R01-B01"]
                _move(db, u["stores"], movement_type=MovementType.RECEIPT, item_id=line.item_id, quantity=qty, to_location_id=loc,
                      unit_cost=D(line.unit_price), ref_doc_type="PURCHASE_ORDER", ref_doc_no=po.number, into_qc_hold=outcome == "qc_hold")
                line.qty_received = qty
            if outcome == "received":
                po.status = "CLOSED"
        po.order_date = date.today() - timedelta(days=24 - n * 3)
        pos.append(po)
    db.flush()
    # QC releases one of the two lines that went to QC hold; the other stays waiting for inspection.
    qc_po = next(p for p in pos if p.supplier.name == "Rathna Electricals" and p.status == "APPROVED" and any(l.qty_received for l in p.lines))
    first = qc_po.lines[0]
    _move(db, u["qc"], movement_type=MovementType.QC_RELEASE, item_id=first.item_id, quantity=D(first.qty_received),
          from_location_id=first.item.default_location_id or receiving["MAIN-R01-B01"], notes="Released after inspection")
    return pos


# ------------------------------------------------------------------ consumption
def consumption(db, u: dict[str, User], count: int = 45) -> None:
    pool = list(db.scalars(select(Item).where(Item.item_type.in_((ItemType.DAILY_CONSUMABLE, ItemType.RAW_MATERIAL, ItemType.PURCHASED_ITEM)),
                                             Item.is_active.is_(True)).order_by(Item.id)))
    rng.shuffle(pool)
    done = 0
    for item in pool:
        if done >= count:
            break
        bal = _available(db, item.id)
        if not bal:
            continue
        b = max(bal, key=lambda x: x.qty_available)
        qty = max(D(1), (b.qty_available * D(str(rng.uniform(0.05, 0.3)))).quantize(D("1")))
        if qty > b.qty_available:
            continue
        ref = rng.choice([("ASSEMBLY_REQUEST", f"AR-{rng.randint(100, 999)}"), ("REQUISITION", f"IR-{rng.randint(1000, 9999)}")])
        _move(db, rng.choice([u["stores"], u["stores2"]]), movement_type=MovementType.ISSUE, item_id=item.id, quantity=qty,
              from_location_id=b.location_id, ref_doc_type=ref[0], ref_doc_no=ref[1], notes="Issued to shop floor")
        done += 1


# ------------------------------------------------------------------ sales
def selling(db, u: dict[str, User], customers: list[Customer]) -> list[SalesOrder]:
    spares = list(db.scalars(select(Item).where(Item.item_type.in_((ItemType.PURCHASED_ITEM, ItemType.PROCESSED_SPARE)),
                                               Item.is_active.is_(True)).order_by(Item.id).limit(300)))
    machine_item = db.scalar(select(Item).join(Machine, Machine.item_id == Item.id).order_by(Machine.code))
    rng.shuffle(spares)
    picks = [(machine_item, D(1)) if machine_item else (spares.pop(), D(2))] + [(spares.pop(), D(rng.choice([5, 10, 20]))) for _ in range(5)]
    orders = []
    for n, (item, qty) in enumerate(picks):
        cust = customers[n % len(customers)]
        required = date.today() + timedelta(days=rng.choice([10, 15, 21, 30, 45]))
        est = estimate_delivery(db, item, qty, customer=cust, required_date=required)
        enq = SalesEnquiry(number=next_number(db, "sales_enquiry", "ENQ-", 5), customer_id=cust.id, reference=f"Mail {date.today():%d-%m} #{n + 1}",
                           item_id=item.id, quantity=qty, required_date=required, customer_location=cust.city, notes=None,
                           estimate=_jsonable(est), estimated_date=est["estimated_date"], risk=est["risk"], created_by_id=u["sales"].id)
        db.add(enq)
        db.flush()
        if n == 5:
            continue  # left as an open enquiry
        price = (D(item.avg_cost or 0) * D("1.35")).quantize(D("1")) or D("15000")
        q = sales.create_quotation(db, u["sales"], enquiry_id=enq.id, unit_price=price)
        if n == 4:
            sales.set_quotation_status(db, u["sales"], q, "SENT")  # waiting for the customer
            continue
        sales.set_quotation_status(db, u["sales"], q, "ACCEPTED")
        so = sales.create_sales_order(db, u["sales"], quotation_id=q.id, customer_po_ref=f"PO/{cust.code}/{rng.randint(1000, 9999)}")
        if n < 3:
            sales.confirm_sales_order(db, u["sales"], so)
        orders.append(so)
    db.flush()
    # Stores picks and issues the reserved stock of one confirmed order against it.
    from .models import Reservation

    for so in orders:
        res = [r for r in db.scalars(select(Reservation).where(Reservation.ref_doc_type == "SALES_ORDER", Reservation.ref_doc_no == so.number,
                                                              Reservation.status == "ACTIVE")) if r.qty_open > 0]
        if res:
            r = res[0]
            _move(db, u["stores"], movement_type=MovementType.ISSUE, item_id=r.item_id, quantity=r.qty_open, from_location_id=r.location_id,
                  ref_doc_type="SALES_ORDER", ref_doc_no=so.number, notes="Dispatched to customer")
            break
    return orders


# ------------------------------------------------------------------ production
ROUTE = [
    {"operation": "Turning", "work_center": "CNC lathe", "mode": "IN_HOUSE", "setup_min": D(30), "run_min": D(6), "outside_days": 0},
    {"operation": "Hardening and tempering", "work_center": "Heat treatment", "mode": "OUTSIDE", "setup_min": D(0), "run_min": D(0), "outside_days": 5},
    {"operation": "Cylindrical grinding", "work_center": "Grinding", "mode": "IN_HOUSE", "setup_min": D(20), "run_min": D(4), "outside_days": 0},
]
VEHICLES = ["TN 66 AK 5769", "TN 38 BZ 1123", "TN 37 CD 4410", "TN 66 Y 2087"]


def manufacturing(db, u: dict[str, User], sups: dict[str, Supplier], orders: list[SalesOrder]) -> None:
    from .models import Pad

    made = list(db.scalars(select(Item).where(Item.item_type == ItemType.PROCESSED_SPARE, Item.is_active.is_(True)).order_by(Item.id).limit(60)))
    rng.shuffle(made)
    steel = db.scalars(select(Item).where(Item.item_type == ItemType.RAW_MATERIAL, Item.is_active.is_(True)).order_by(Item.id)).all()
    heat = sups["Sakthi Heat Treatment Industry"]
    stage = ["complete", "complete", "partial", "at_vendor", "in_progress"]
    po_no = 174637
    for n, how in enumerate(stage):
        item = made[n]
        route = [{**s, "supplier_id": heat.id if s["mode"] == "OUTSIDE" else None} for s in ROUTE]
        process.replace_steps(db, u["planning"], item, route)
        qty = D(rng.choice([10, 20, 30, 40]))
        wo = production.create_work_order(db, u["production"], item, qty, required_date=date.today() + timedelta(days=20),
                                          notes="Replenish stores stock")
        mat = next((s for s in steel if any(b.qty_available >= 1 for b in _available(db, s.id))), None)
        if mat is not None:
            b = max(_available(db, mat.id), key=lambda x: x.qty_available)
            take = min(b.qty_available, max(D(1), qty / 2)).quantize(D("1"), rounding="ROUND_DOWN")
            production.issue_material(db, u["stores"], wo, mat.id, take, b.location_id)
        for op in list(wo.ops):
            if how == "in_progress" and op.seq == 2:
                break
            if op.mode == "IN_HOUSE":
                production.op_action(db, u["production"], wo, op.seq, "start")
                if how == "in_progress":
                    break
                production.op_action(db, u["production"], wo, op.seq, "finish")
            else:
                po_no += rng.randint(3, 40)
                production.op_action(db, u["production"], wo, op.seq, "send", supplier_id=heat.id, challan={
                    "process_nature": "HARDENING AND TEMPERING", "po_number": str(po_no), "po_date": date.today() - timedelta(days=20),
                    "vehicle_no": VEHICLES[n % len(VEHICLES)], "transporter": "Own vehicle"})
                if how == "at_vendor":
                    break
                production.op_action(db, u["production"], wo, op.seq, "receive")
            production.op_action(db, u["qc"], wo, op.seq, "qc", passed=True)
        loc = item.default_location_id or db.scalar(select(Location.id).where(Location.code == "MAIN-R03-B01"))
        cost = (D(item.avg_cost or 0) or D(500)).quantize(D("0.01"))
        if how == "complete":
            production.complete_work_order(db, u["production"], wo, (qty / 2).quantize(D("1")), loc, cost)
            production.complete_work_order(db, u["production"], wo, qty - (qty / 2).quantize(D("1")), loc, cost)
        elif how == "partial":
            production.complete_work_order(db, u["production"], wo, (qty / 4).quantize(D("1")), loc, cost)
    # A WIP/PAD for the machine order: released to Stores, waiting for parts to be issued.
    machine_so = next((s for s in orders if s.status == "CONFIRMED" and db.scalar(select(Machine.id).where(Machine.item_id == s.lines[0].item_id))), None)
    if machine_so is not None and not db.scalar(select(Pad.id).where(Pad.sales_order_id == machine_so.id)):
        pad = production.create_pad(db, u["planning"], machine_so, machine_so.lines[0], notes="Standard build")
        production.release_pad(db, u["planning"], pad)
    db.flush()


# ------------------------------------------------------------------ counts and documents
def counting(db, u: dict[str, User]) -> None:
    from .api.inventory import CountIn, create_count  # reuse the API's line selection

    done = create_count(CountIn(scope="MAIN-R01-B01", due_date=date.today() - timedelta(days=2), notes="Monthly bin count"), db, u["stores"])
    c = db.get(CycleCount, done["id"])
    first = True
    for line in c.lines:
        bal = db.scalar(select(StockBalance).where(StockBalance.item_id == line.item_id, StockBalance.location_id == line.location_id))
        on_hand = D(bal.qty_on_hand) if bal else D(0)
        line.counted_qty, line.counted_by_id = (max(on_hand - 2, D(0)) if first and on_hand >= 2 else on_hand), u["stores"].id
        first = first and on_hand < 2
    for line in c.lines:
        bal = db.scalar(select(StockBalance).where(StockBalance.item_id == line.item_id, StockBalance.location_id == line.location_id))
        line.system_qty = D(bal.qty_on_hand) if bal else D(0)
        delta = D(line.counted_qty) - line.system_qty
        if delta:
            line.adjustment_id = request_adjustment(db, u["stores"], line.item_id, line.location_id, delta,
                                                    f"Cycle count {c.number}: counted {D(line.counted_qty).normalize():f}, "
                                                    f"ledger {line.system_qty.normalize():f}").id
    c.status, c.submitted_by_id, c.submitted_at = "SUBMITTED", u["stores"].id, datetime.now(timezone.utc)
    # A second count still open and past its due date (shows as late on the overview).
    create_count(CountIn(scope="MAIN-R02", due_date=date.today() - timedelta(days=3), notes="Rack R02 full count"), db, u["stores2"])


def documents(db, u: dict[str, User], pos: list[PurchaseOrder]) -> None:
    received = next(p for p in pos if p.status == "CLOSED")
    partial = next(p for p in pos if p.supplier.name == "Mumbai Fasteners Co")

    def invoice(po: PurchaseOrder, number: str, qty_of) -> tuple[bytes, dict, list[dict]]:
        s = po.supplier
        lines, taxable = [], D(0)
        for l in po.lines:
            q = qty_of(l)
            amt = (q * D(l.unit_price)).quantize(D("0.01"))
            taxable += amt
            lines.append({"item_code": "", "description": l.item.name, "hsn_code": l.item.hsn_code or "", "quantity": f"{q.normalize():f}",
                          "uom": l.item.uom.code, "unit_price": f"{D(l.unit_price):.2f}", "discount": "", "taxable_value": f"{amt:.2f}",
                          "gst_rate": "18", "tax_amount": f"{amt * D('0.18'):.2f}", "line_total": f"{amt * D('1.18'):.2f}"})
        tax = (taxable * D("0.18")).quantize(D("0.01"))
        intra = (s.gstin or "")[:2] == "33"
        total = (taxable + tax).quantize(D("1"))
        header = {"supplier_name": s.name, "supplier_gstin": s.gstin or "", "supplier_address": s.address or "", "invoice_number": number,
                  "invoice_date": date.today().isoformat(), "po_number": po.number, "buyer_name": "Lakshmi Card Clothing Mfg Co Pvt Ltd - Unit 4",
                  "buyer_gstin": "33AAACL3521E1Z6", "taxable_value": f"{taxable:.2f}",
                  "cgst_amount": f"{tax / 2:.2f}" if intra else "", "sgst_amount": f"{tax / 2:.2f}" if intra else "",
                  "igst_amount": "" if intra else f"{tax:.2f}", "round_off": f"{total - taxable - tax:.2f}", "grand_total": f"{total:.2f}"}
        text = ["TAX INVOICE", s.name, s.address or "", f"GSTIN: {s.gstin}", f"Invoice No: {number}   Date: {date.today():%d/%m/%Y}",
                f"Buyer: {header['buyer_name']}  GSTIN: 33AAACL3521E1Z6", f"Your PO: {po.number}", ""]
        text += [f"{i + 1}. {l['description'][:38]:38} {l['quantity']:>6} {l['uom']:4} {l['unit_price']:>10} {l['taxable_value']:>12}"
                 for i, l in enumerate(lines)]
        text += ["", f"Taxable value: {taxable:.2f}", *( [f"CGST 9%: {tax / 2:.2f}", f"SGST 9%: {tax / 2:.2f}"] if intra else [f"IGST 18%: {tax:.2f}"]),
                 f"Grand total: Rs. {total:.2f}"]
        return _pdf(text), header, lines

    pdf, header, lines = invoice(received, f"SBB/26-27/{rng.randint(300, 700)}", lambda l: D(l.qty_received))
    d1 = docs.create_document(db, u["purchase"], "SUPPLIER_INVOICE", [("invoice-sri-balaji.pdf", "application/pdf", pdf)], "Sample: matches the goods receipt")
    docs.save_data(db, u["purchase"], d1, header, lines, None)
    docs.decide(db, u["finance"], d1, True, "Checked against GRN and PO", override=bool([c for c in d1.checks if c["status"] == "fail"]))

    pdf, header, lines = invoice(partial, f"MFC/{rng.randint(1000, 2000)}", lambda l: D(l.qty_ordered))  # billed in full, half received
    d2 = docs.create_document(db, u["purchase"], "SUPPLIER_INVOICE", [("invoice-mumbai-fasteners.pdf", "application/pdf", pdf)],
                              "Sample: billed before the full quantity arrived")
    docs.save_data(db, u["purchase"], d2, header, lines, None)

    ch = db.scalar(select(JobWorkChallan).order_by(JobWorkChallan.id))
    if ch is not None:
        l0 = ch.lines[0]
        pdf = _pdf(["DELIVERY CHALLAN (RETURN AFTER JOB WORK)", ch.supplier.name, ch.supplier.address or "", f"GSTIN: {ch.supplier.gstin}",
                    f"DC No: SHT/{rng.randint(100, 900)}   Date: {date.today():%d/%m/%Y}", f"Against your challan {ch.number}", "",
                    f"1. {l0.description[:40]}  Qty {D(l0.quantity).normalize():f} {l0.uom}  - Hardening and tempering done"])
        d3 = docs.create_document(db, u["stores"], "DELIVERY_CHALLAN", [("dc-sakthi-heat-treatment.pdf", "application/pdf", pdf)],
                                  "Sample: material back from job work")
        docs.save_data(db, u["stores"], d3, {"challan_number": f"SHT/{rng.randint(100, 900)}", "challan_date": date.today().isoformat(),
                                              "consignor_name": ch.supplier.name, "consignor_gstin": ch.supplier.gstin or "",
                                              "consignee_name": "Lakshmi Card Clothing Mfg Co Pvt Ltd - Unit 4", "consignee_gstin": "33AAACL3521E1Z6",
                                              "po_number": ch.po_number or "", "process_nature": ch.process_nature},
                       [{"item_code": l0.item.item_code if l0.item else "", "description": l0.description, "hsn_code": l0.hsn_code or "",
                         "quantity": f"{D(l0.quantity).normalize():f}", "uom": l0.uom, "rate": "", "value": ""}], None)


# ------------------------------------------------------------------ dates
def spread_dates(db, days: int = 21) -> None:
    """Openings land a month back; everything after is spread across working hours of the last ``days`` days, in order."""
    now = datetime.now(timezone.utc)
    opening_at = now - timedelta(days=days + 9)
    for m in db.scalars(select(StockMovement).where(StockMovement.ref_doc_type.in_(("OPENING", "DEMO-CATALOG")))):
        m.created_at = opening_at
    rest = list(db.scalars(select(StockMovement).where(StockMovement.ref_doc_type.not_in(("OPENING", "DEMO-CATALOG")) |
                                                       StockMovement.ref_doc_type.is_(None)).order_by(StockMovement.id)))
    start = (now - timedelta(days=days)).astimezone(IST).date()
    by_day: dict[date, list[StockMovement]] = {}
    for i, m in enumerate(rest):  # in posting order, ending today
        by_day.setdefault(start + timedelta(days=i * (days + 1) // max(len(rest), 1)), []).append(m)
    for day, moves in by_day.items():
        first = datetime.combine(day, time(9, 15), IST)
        last = min(datetime.combine(day, time(17, 30), IST), now.astimezone(IST) - timedelta(minutes=5))
        gap = max((last - first) / max(len(moves), 1), timedelta(minutes=1))
        for k, m in enumerate(moves):  # times rise through the day, so documents stay in sequence
            m.created_at = (first + gap * k).astimezone(timezone.utc)
    for wo in db.scalars(select(WorkOrder)):
        first = db.scalar(select(func.min(StockMovement.created_at)).where(StockMovement.ref_doc_no == wo.number))
        if first:
            wo.created_at = first - timedelta(hours=2)
    for i, ch in enumerate(db.scalars(select(JobWorkChallan).order_by(JobWorkChallan.id))):
        ch.challan_date = date.today() - timedelta(days=max(1, 12 - i * 3))
        ch.expected_return_date = ch.challan_date + timedelta(days=5)


def run(db) -> dict[str, int]:
    """Add the sample activity in one transaction; refuses when purchase orders (real activity) already exist."""
    if db.scalar(select(func.count()).select_from(PurchaseOrder)):
        raise RuntimeError("Purchase orders already exist - sample activity is only added to a fresh system")
    if (db.scalar(select(func.count()).select_from(Item)) or 0) < 50:
        raise RuntimeError("Load the item master first (demo catalogue)")
    u = {n: _u(db, n) for n in ("stores", "stores2", "sales", "purchase", "qc", "manager", "finance", "planning", "production")}
    sups, customers = masters(db, u["purchase"])
    pos = purchasing(db, u, sups)
    consumption(db, u)
    orders = selling(db, u, customers)
    manufacturing(db, u, sups, orders)
    counting(db, u)
    documents(db, u, pos)
    spread_dates(db)
    db.commit()
    return {name: db.scalar(select(func.count()).select_from(model)) for name, model in (
        ("purchase orders", PurchaseOrder), ("sales orders", SalesOrder), ("work orders", WorkOrder),
        ("job-work challans", JobWorkChallan), ("stock movements", StockMovement), ("cycle counts", CycleCount))}


def main() -> None:
    with SessionLocal() as db:
        try:
            counts = run(db)
        except RuntimeError as e:
            print(e)
            return
        print("Sample activity added:", ", ".join(f"{v} {k}" for k, v in counts.items()))


if __name__ == "__main__":
    main()
