"""End-to-end walk through the "QR-enabled inventory & sales delivery automation flow" for a customer order of a
full machine (Flat End Milling Machine 60"), step by step as drawn on the flow chart.

Run with ``python -m pytest tests/test_machine_order_flow.py -s`` to see each step logged as it happens.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.db import SessionLocal
from app.machine_catalog import load as load_catalog
from app.machine_hardware import load as load_hardware
from app.models import ItemType, Machine, User
from app.services.process import apply_standard


def log(step: str, detail: str = "") -> None:
    print(f"  {step:<58} {detail}")


def move(api, mtype: str, item_id: int, qty, **extra):
    r = api.post("/api/stock/movements", json={"txn_uuid": str(uuid.uuid4()), "movement_type": mtype, "item_id": item_id,
                                               "quantity": str(qty), **extra})
    assert r.status_code == 200, r.text
    return r.json()


def ok(r, code=200):
    assert r.status_code == code, r.text
    return r.json()


def track(api, so_id: int, expect_stage: str | None) -> dict:
    """Order tracker: the next action should sit on the stage we expect."""
    t = ok(api.get(f"/api/tracker/{so_id}"))
    nxt = t["next"]
    log(f"   tracker {t['progress']:>3}% " + "".join(s["status"][0] for s in t["stages"]), f"[{nxt['stage']}] {nxt['label']} ({nxt['who']})" if nxt else "nothing pending")
    assert (nxt["stage"] if nxt else None) == expect_stage, t["stages"]
    return t


def _setup_machine_master() -> None:
    """Master data the flow relies on: the machine with its SOP parts list, build hardware, and process routes."""
    with SessionLocal() as db:
        admin = db.scalar(select(User).where(User.username == "admin"))
        load_catalog(db, admin)  # machines + SOP lists + sellable machine items (finished goods)
        load_hardware(db, admin)  # fasteners and powder-coated sheet metal, created as processed-spare items
        fem = db.scalar(select(Machine).where(Machine.code == "CSM-FEM"))
        for s in fem.spares:  # standard manufacturing route for every processed spare of this machine
            if s.item and s.item.item_type == ItemType.PROCESSED_SPARE:
                apply_standard(db, admin, s.item)
        db.commit()


def run_work_order(production, qc, wo: dict, vendor_id: int, *, fail_first_qc: bool = False) -> dict:
    """Run every process step of a work order: in-house start/finish, outside send/receive, then QC each step."""
    first = True
    for op in wo["ops"]:
        seq = op["seq"]
        if op["mode"] == "IN_HOUSE":
            ok(production.post(f"/api/work-orders/{wo['id']}/ops/{seq}", json={"action": "start"}))
            wo = ok(production.post(f"/api/work-orders/{wo['id']}/ops/{seq}", json={"action": "finish"}))
        else:
            ok(production.post(f"/api/work-orders/{wo['id']}/ops/{seq}",
                               json={"action": "send", "supplier_id": vendor_id, "challan_no": f"DC-{wo['number']}-{seq}"}))
            wo = ok(production.post(f"/api/work-orders/{wo['id']}/ops/{seq}", json={"action": "receive"}))
        if fail_first_qc and first:  # QC rejects the first step once: it goes back for rework
            wo = ok(qc.post(f"/api/work-orders/{wo['id']}/ops/{seq}", json={"action": "qc", "passed": False, "note": "Burr on edges"}))
            assert wo["ops"][seq - 1]["status"] == "PENDING" and wo["ops"][seq - 1]["rework_count"] == 1
            log(f"     step {seq} QC FAILED -> rework", op["operation"])
            redo = "start" if op["mode"] == "IN_HOUSE" else "send"
            ok(production.post(f"/api/work-orders/{wo['id']}/ops/{seq}",
                               json={"action": redo, "supplier_id": vendor_id, "challan_no": f"DC-{wo['number']}-{seq}R"}))
            ok(production.post(f"/api/work-orders/{wo['id']}/ops/{seq}", json={"action": "finish" if redo == "start" else "receive"}))
        wo = ok(qc.post(f"/api/work-orders/{wo['id']}/ops/{seq}", json={"action": "qc", "passed": True}))
        log(f"     step {seq} {'in-house' if op['mode'] == 'IN_HOUSE' else 'OUTSIDE '} done + QC passed", op["operation"])
        first = False
    return wo


def test_full_machine_order_follows_the_flow_chart(as_user, refs):
    sales, stores, purchase, manager, qc, admin, planning, production = (
        as_user(u) for u in ("sales", "stores", "purchase", "manager", "qc", "admin", "planning", "production"))
    loc = refs["loc"]["MAIN-R01-B01"]
    _setup_machine_master()
    print("\n=== Machine order flow: Flat End Milling Machine 60\" ===")

    machine = next(m for m in stores.get("/api/machines/options").json() if m["code"] == "CSM-FEM")
    machine_item_id = machine["item"]["id"]
    customer_id = admin.post("/api/masters/customers", json={"name": "Sri Ganesh Spinning Mills", "transport_days": 3}).json()["id"]
    gauge_vendor = admin.post("/api/masters/suppliers", json={"name": "Precision Gauges Coimbatore", "lead_time_days": 7}).json()["id"]
    job_worker = admin.post("/api/masters/suppliers", json={"name": "Kovai Laser & Powder Coaters", "lead_time_days": 3}).json()["id"]

    # ================================================================== 1. SALES ORDER (SO) / CUSTOMER ENQUIRY
    # Type of sales order: 1 = manufacturing a full machine (2 = spares for an existing machine).

    # ---------------- PRE-SALES STOCK AVAILABILITY & ESTIMATION
    # Customer enquiry (pre-sales): item / machine / quantity.
    required = date.today() + timedelta(days=60)

    # Sales dashboard: live stock + reserved stock + incoming stock.
    atp = sales.get(f"/api/sales/availability/{machine_item_id}", params={"quantity": 1}).json()
    log("Sales dashboard: live / reserved / incoming",
        f"physical {atp['physical']}, reserved {atp['reserved']}, incoming {atp['incoming_total']}, free {atp['available_to_promise']}")

    # Sufficient free stock? -> NO: there is no finished machine in stores.
    assert Decimal(str(atp["available_to_promise"])) < 1
    log("Sufficient free stock?", "NO -> calculate shortage")

    # Calculate shortage (lead time, in-house & outside process) -> preliminary delivery estimate with assumptions.
    est = ok(sales.post("/api/sales/estimate", json={"item_id": machine_item_id, "quantity": "1", "customer_id": customer_id,
                                                     "required_date": required.isoformat()}))
    assert "Production" in [s["owner"] for s in est["steps"]]
    log("Calculate shortage -> preliminary estimate", f"{est['estimated_date']} (risk {est['risk']})")

    # The enquiry is saved with that estimate; the chosen spec goes into the notes.
    enq = ok(sales.post("/api/sales/enquiries", json={"customer_id": customer_id, "item_id": machine_item_id, "quantity": "1",
                                                      "required_date": required.isoformat(),
                                                      "notes": "Model: Flat End Milling Machine 60\""}), 201)
    log("Customer enquiry recorded", f"{enq['number']} est. {enq['estimated_date']}")

    # Quote / estimated delivery date to customer.
    quote = ok(sales.post("/api/sales/quotations", json={"enquiry_id": enq["id"], "unit_price": "1450000"}), 201)
    log("Quote + estimated delivery date to customer", f"{quote['number']} Rs {quote['amount']} by {quote['preliminary_date']}")

    # Customer accepts and sends their purchase order -> sales order carrying the customer's PO number.
    ok(sales.post(f"/api/sales/quotations/{quote['id']}/status", json={"status": "ACCEPTED"}))
    so = ok(sales.post("/api/sales/orders", json={"quotation_id": quote["id"], "customer_po_ref": "SGSM/PO/2026/1187"}), 201)
    log("Customer PO received -> sales order", f"{so['number']} (customer PO {so['customer_po_ref']})")
    assert track(sales, so["id"], "Sell")["next"]["label"] == "Confirm the sales order"

    # ---------------- AFTER ORDER CONFIRMATION
    # Sales order confirmed -> reserve materials + production plan (the machine itself must be built).
    so = ok(sales.post(f"/api/sales/orders/{so['id']}/confirm"))
    machine_pr = next(r for r in so["requisitions"] if r["item_id"] == machine_item_id)
    assert so["status"] == "CONFIRMED" and machine_pr["kind"] == "PRODUCTION"
    log("Sales order confirmed -> production plan", f"{machine_pr['number']} PRODUCTION x{machine_pr['quantity']}")

    # Order-wise delivery schedule, then committed delivery date (Sales proposes, Management approves).
    commit = so["forecast_date"] or so["preliminary_date"]
    ok(sales.post(f"/api/sales/orders/{so['id']}/commit-request", json={"committed_date": commit, "note": "Agreed with customer"}))
    so = ok(manager.post(f"/api/sales/orders/{so['id']}/commit-decision", json={"approve": True}))
    log("Committed delivery date (approved by Management)", so["committed_date"])
    assert track(sales, so["id"], "Plan")["next"]["who"] == "Planning & Design"

    # ================================================================== 2. PLANNING AND DESIGN (PD)
    # PD creates the WIP/PAD against the sales order from the machine's standard SOP, then releases it to Stores.
    cand = next(c for c in planning.get("/api/pads/candidates").json() if c["so_number"] == so["number"])
    assert sales.post("/api/pads", json={"so_line_id": cand["so_line_id"]}).status_code == 403  # PD's job, not Sales'
    pad = ok(planning.post("/api/pads", json={"so_line_id": cand["so_line_id"]}), 201)
    assert pad["status"] == "DRAFT" and pad["machine"]["code"] == "CSM-FEM" and pad["lines_total"] > 30
    assert planning.post("/api/pads", json={"so_line_id": cand["so_line_id"]}).status_code == 409  # one PAD per SO line
    log("2. PD: WIP/PAD from SOP", f"{pad['number']} for {pad['so_number']}: {pad['lines_total']} part lines")
    pad = ok(planning.post(f"/api/pads/{pad['id']}/release"))
    assert pad["status"] == "RELEASED"
    log("   PAD released to Stores", pad["number"])
    track(stores, so["id"], "Get parts")

    # ================================================================== 3. STORES DEPARTMENT
    # Verify material availability line by line (live inventory), then raise the shortages:
    # bought-out -> purchase requisition; processed spare -> production requisition + work order on its route.
    stores.post(f"/api/machines/{machine['id']}/align", json={"create_missing": True})  # every SOP line has a stores item
    pad = ok(stores.get(f"/api/pads/{pad['id']}"))
    log("3. Stores: verify PAD availability", f"{pad['counts']}")
    short = ok(stores.post(f"/api/pads/{pad['id']}/shortages"))
    assert short["purchase"] and short["production"]
    log("   Shortages raised", f"{len(short['purchase'])} purchase PRs, {len(short['production'])} work orders")
    again = ok(stores.post(f"/api/pads/{pad['id']}/shortages"))  # idempotent: nothing raised twice
    assert not again["purchase"] and not again["production"]
    pad = short["pad"]
    track(stores, so["id"], "Get parts")
    lines = {l["name"]: l for l in pad["lines"]}

    # ================================================================== A2. PURCHASED ITEMS (BO)
    # 1. Check BO item against SO / scan QR -> available in stores? NO -> purchase requisition was raised.
    bo_line = next(l for n, l in lines.items() if n.startswith("Dial Gauge"))
    assert bo_line["status"] == "SHORT" and bo_line["requisition"]["kind"] == "PURCHASE"
    bo_pr = next(r for r in purchase.get("/api/purchase/requisitions", params={"status": "OPEN"}).json()
                 if r["number"] == bo_line["requisition"]["number"])
    log("A2.1 BO item short", f"{bo_line['item_code']} {bo_line['name'][:40]} -> {bo_pr['number']}")
    # 2. Purchase initiation -> 3. approval by a different person -> 4. purchase order placed.
    po = ok(purchase.post(f"/api/purchase/requisitions/{bo_pr['id']}/convert", json={"supplier_id": gauge_vendor, "unit_price": "4200"}), 201)
    assert purchase.post(f"/api/purchase/orders/{po['id']}/approve").status_code == 403  # maker-checker
    po = ok(manager.post(f"/api/purchase/orders/{po['id']}/approve"))
    log("A2.2-4 PR -> PO -> approved -> placed", f"{bo_pr['number']} -> {po['number']} ({po['status']})")
    # 5. Order received into QC hold -> 6. quality check -> 7. update to stores.
    pl = po["lines"][0]
    ok(purchase.post(f"/api/purchase/orders/{po['id']}/receive", json={"line_id": pl["id"], "quantity": pl["qty_ordered"], "to_location_id": loc}))
    move(qc, "QC_RELEASE", bo_line["item_id"], pl["qty_ordered"], from_location_id=loc)
    log("A2.5-7 Received -> QC passed -> in stores", f"{pl['qty_ordered']} {bo_line['uom']}")
    # Deliver to assembly department: issue against the PAD.
    pad = ok(stores.post(f"/api/pads/{pad['id']}/lines/{bo_line['id']}/issue", json={"quantity": bo_line["qty_required"], "location_id": loc}))
    assert next(l for l in pad["lines"] if l["id"] == bo_line["id"])["status"] == "ISSUED"
    log("A2 Delivered to assembly (issue vs PAD)", pad["number"])

    # ================================================================== C. PROCESSED MATERIALS (SPARES)
    # 1. Check spare against SO / scan QR -> available? NO -> 2. work order issued against the PAD, following the
    # item's route (scenario 1/2/3 = all in-house / last step outside / mixed in-house and outside).
    ps_line = next(l for n, l in lines.items() if "Milling Cutter Guard Hood" in n)
    assert ps_line["requisition"]["kind"] == "PRODUCTION" and ps_line["work_order"]
    wo = ok(production.get(f"/api/work-orders/{ps_line['work_order']['id']}"))
    assert wo["pad_number"] == pad["number"] and wo["requisition_status"] == "IN_PRODUCTION"
    log("C.2 Work order vs PAD", f"{wo['number']} {wo['item_code']} x{wo['quantity']}: {wo['ops_total']} steps, "
                                 f"{wo['outside_steps']} outside, est. {wo['estimate']['total_days']} d")

    # Controls: steps run in order, and nobody may skip QC.
    second = wo["ops"][1]["seq"]
    assert production.post(f"/api/work-orders/{wo['id']}/ops/{second}", json={"action": "start"}).status_code == 409
    assert production.post(f"/api/work-orders/{wo['id']}/complete", json={"quantity": wo["quantity"], "location_id": loc}).status_code == 409
    assert production.post(f"/api/work-orders/{wo['id']}/ops/1", json={"action": "qc", "passed": True}).status_code == 403  # QC role only

    # B. Raw materials: issue the sheet for the process against the work order (WIP).
    rm = ok(admin.post("/api/items", json={"name": "CRCA Sheet 1.6 mm 1250 x 2500", "item_type": "RAW_MATERIAL",
                                           "uom_id": refs["uom"]["KG"], "default_location_id": loc}), 201)["item"]
    move(stores, "RECEIPT", rm["id"], 500, to_location_id=loc, unit_cost="72")
    wo = ok(stores.post(f"/api/work-orders/{wo['id']}/materials", json={"item_id": rm["id"], "quantity": "18", "location_id": loc}))
    assert wo["movements"][0]["item_code"] == rm["item_code"]
    log("B. Raw material issued to work order", f"{rm['item_code']} 18 KG vs WIP {wo['number']}")

    # Process 1..n with QC after every step (first step fails QC once and is reworked).
    wo = run_work_order(production, qc, wo, job_worker, fail_first_qc=True)

    # Quality check after all processes -> update to store; the requisition closes on completion.
    wo = ok(production.post(f"/api/work-orders/{wo['id']}/complete", json={"quantity": wo["quantity"], "location_id": loc, "unit_cost": "2800"}))
    assert wo["status"] == "COMPLETED" and wo["requisition_status"] == "FULFILLED"
    log("C. Completed -> stores, requisition closed", f"{wo['number']} {wo['status']}, {wo['requisition_number']} {wo['requisition_status']}")
    # Delivered to assembly department against the PAD.
    pad = ok(stores.post(f"/api/pads/{pad['id']}/lines/{ps_line['id']}/issue", json={"quantity": ps_line["qty_required"], "location_id": loc}))
    log("C. Delivered to assembly (issue vs PAD)", pad["number"])

    # ================================================================== A1. DAILY CONSUMABLES
    # Request from any department -> scan QR & check availability -> available? YES -> deliver.
    oil = ok(admin.post("/api/items", json={"name": "Spindle Oil ISO VG 10 (Assembly)", "item_type": "DAILY_CONSUMABLE",
                                            "uom_id": refs["uom"]["LTR"], "default_location_id": loc}), 201)["item"]
    move(stores, "RECEIPT", oil["id"], 20, to_location_id=loc, unit_cost="180")
    move(stores, "ISSUE", oil["id"], 2, from_location_id=loc, ref_doc_type="PAD", ref_doc_no=pad["number"])
    log("A1. Consumable requested & delivered", f"{oil['item_code']} 2 LTR to assembly")

    # ================================================================== ASSEMBLY -> FINISHED MACHINE -> DISPATCH
    # The machine's own production requisition becomes an assembly work order (machine assembly route).
    open_prs = production.get("/api/work-orders/open-requisitions").json()
    assert any(r["number"] == machine_pr["number"] for r in open_prs)
    mwo = ok(production.post("/api/work-orders", json={"requisition_id": machine_pr["id"]}), 201)
    log("Assembly work order", f"{mwo['number']} {mwo['item_code']}: {mwo['ops_total']} steps")
    mwo = run_work_order(production, qc, mwo, job_worker)
    # Completing the machine closes its requisition and reserves it for the waiting sales order automatically.
    mwo = ok(production.post(f"/api/work-orders/{mwo['id']}/complete", json={"quantity": "1", "location_id": loc}))
    assert mwo["requisition_status"] == "FULFILLED"
    so = ok(sales.get(f"/api/sales/orders/{so['id']}"))
    assert Decimal(so["lines"][0]["qty_shortage"]) == 0
    log("Machine completed -> requisition closed -> reserved", f"{mwo['number']}, {so['number']} fully reserved")

    # Dispatch against the sales order.
    move(stores, "ISSUE", machine_item_id, 1, from_location_id=loc, ref_doc_type="SALES_ORDER", ref_doc_no=so["number"])
    so = ok(sales.get(f"/api/sales/orders/{so['id']}"))
    assert so["status"] == "COMPLETED"
    log("Dispatch against sales order", f"{so['number']} COMPLETED")
    final = track(sales, so["id"], None)
    assert final["progress"] == 100 and all(s["status"] == "done" for s in final["stages"])

    # ================================================================== INVENTORY LEDGER + KEY CONTROLS & AUDIT TRAIL
    auditor = as_user("auditor")
    actions = {e["action"] for prefix in ("sales.", "purchase.", "pad.", "production.")
               for e in auditor.get("/api/audit", params={"action": prefix}).json()["events"]}
    assert {"pad.create", "pad.release", "pad.shortages", "production.wo.create", "production.op.send", "production.op.qc",
            "production.wo.complete", "purchase.po.approve", "sales.order.confirm"} <= actions
    log("Ledger + audit trail", f"{len(actions)} audited action types")
    print("=== flow complete ===")
