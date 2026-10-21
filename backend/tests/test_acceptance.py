"""Acceptance scenarios from spec §16 that this slice covers (numbers match the spec)."""
from __future__ import annotations

import threading
import uuid
from datetime import date, timedelta
from decimal import Decimal

from app.db import SessionLocal
from app.models import MovementType, User
from app.services.common import BusinessError
from app.services.stock import MovementInput, post_movement


def receive(api, item_id, qty, loc, cost="100", **extra):
    return api.post("/api/stock/movements", json={"txn_uuid": str(uuid.uuid4()), "movement_type": "RECEIPT", "item_id": item_id,
                                                  "quantity": str(qty), "to_location_id": loc, "unit_cost": cost, **extra})


def issue(api, item_id, qty, loc, txn=None, ref=("SALES_ORDER", "SO-1")):
    return api.post("/api/stock/movements", json={"txn_uuid": txn or str(uuid.uuid4()), "movement_type": "ISSUE", "item_id": item_id,
                                                  "quantity": str(qty), "from_location_id": loc, "ref_doc_type": ref[0], "ref_doc_no": ref[1]})


# 1 -------------------------------------------------------------------------
def test_create_item_generates_code_and_printable_qr(as_user, make_item):
    detail = make_item()
    item = detail["item"]
    assert item["item_code"] == "PI-000001"
    assert detail["qr"]["status"] == "ACTIVE"
    assert "/q/" in detail["qr"]["content"]
    assert "185" not in detail["qr"]["content"] and "supplier" not in detail["qr"]["content"].lower()
    stores = as_user("stores")
    png = stores.get(f"/api/items/{item['id']}/qr.png")
    assert png.status_code == 200 and png.content[:8] == b"\x89PNG\r\n\x1a\n"
    svg = stores.get(f"/api/items/{item['id']}/qr.svg")
    assert svg.status_code == 200 and "<svg" in svg.text
    labels = stores.post("/api/qr/labels", json={"item_ids": [item["id"]], "mark_printed": True}).json()
    assert labels[0]["item_code"] == "PI-000001" and "<svg" in labels[0]["svg"] and labels[0]["created"] is False


def test_regenerate_qr_keeps_item_identity_and_revokes_old(as_user, make_item):
    detail = make_item()
    old = detail["qr"]["token"]
    stores = as_user("stores")
    new = stores.post(f"/api/items/{detail['item']['id']}/qr/regenerate", json={"reason": "Label damaged"}).json()
    assert new["token"] != old and new["generation"] == 2
    assert stores.get(f"/api/items/{detail['item']['id']}").json()["item"]["item_code"] == detail["item"]["item_code"]
    assert stores.get("/api/qr/resolve", params={"payload": f"LMQ1:{old}"}).status_code == 410


def test_duplicate_item_is_blocked_unless_overridden_by_authorized_user(as_user, make_item, refs):
    make_item(name="Deep Groove Ball Bearing 6205-2RS", make_model="6205-2RS")
    body = {"name": "Deep groove ball bearing 6205 2RS", "make_model": "6205-2RS", "item_type": "PURCHASED_ITEM", "uom_id": refs["uom"]["NOS"]}
    r = as_user("stores").post("/api/items", json=body)
    assert r.status_code == 409 and r.json()["code"] == "possible_duplicate"
    r = as_user("stores").post("/api/items", json={**body, "allow_duplicate": True})
    assert r.status_code == 403  # stores lacks items.duplicate_override
    r = as_user("admin").post("/api/items", json={**body, "allow_duplicate": True})
    assert r.status_code == 201
    # Same name without a make/model is still flagged; a different model of a similar name is not.
    dupes = as_user("stores").get("/api/items/duplicate-check", params={"name": "Deep Groove Ball Bearing 6205 2RS"}).json()
    assert dupes and dupes[0]["score"] == 1.0
    other = as_user("stores").get("/api/items/duplicate-check", params={"name": "Deep Groove Ball Bearing", "make_model": "6310-ZZ"}).json()
    assert other == []


# 2 -------------------------------------------------------------------------
CSV = (
    "Part No,Item Name,Type,Unit,Make,Bin,Closing Stock,Rate\n"
    "LEG-001,Hex Bolt M12x50,Purchased,NOS,Unbrako,MAIN-R01-B02,250,12.5\n"
    "LEG-002,Ball Bearing 6205,Purchased,NOS,SKF,MAIN-R01-B01,40,180\n"
    ",Hex Bolt M12x50,Purchased,NOS,Unbrako,MAIN-R01-B02,10,12.5\n"
    "LEG-004,Mystery Part,Alien,PCS,,MAIN-R01-B03,5,1\n"
)


def test_import_spreadsheet_with_duplicates_and_maker_checker(as_user, make_item, client):
    existing = make_item(name="Ball Bearing 6205")["item"]
    stores = as_user("stores")
    up = stores.post("/api/imports", files={"file": ("legacy.csv", CSV.encode(), "text/csv")})
    assert up.status_code == 201, up.text
    batch = up.json()
    assert batch["mapping"]["name"] == "Item Name" and batch["mapping"]["opening_qty"] == "Closing Stock"
    v = stores.post(f"/api/imports/{batch['id']}/validate", json={"mapping": batch["mapping"]}).json()
    by_row = {r["row_no"]: r for r in v["rows"]}
    assert by_row[2]["status"] == "VALID"
    assert by_row[3]["status"] == "DUPLICATE" and by_row[3]["duplicate_item_id"] == existing["id"] and by_row[3]["resolution"] == "LINK"
    assert by_row[4]["status"] == "DUPLICATE" and by_row[4]["resolution"] == "SKIP"  # repeated within the file
    assert by_row[5]["status"] == "INVALID" and any("type" in e.lower() for e in by_row[5]["errors"])

    assert stores.post(f"/api/imports/{batch['id']}/approve").status_code == 403  # stores lacks imports.approve
    assert as_user("manager").post(f"/api/imports/{batch['id']}/approve").status_code == 200
    done = as_user("manager").get(f"/api/imports/{batch['id']}").json()
    assert done["status"] == "APPROVED"
    assert done["summary"]["created"] == 1 and done["summary"]["linked"] == 1

    items = {i["item_code"]: i for i in stores.get("/api/items").json()["items"]}
    assert "LEG-001" in items and Decimal(items["LEG-001"]["physical"]) == 250
    assert Decimal(items[existing["item_code"]]["physical"]) == 40  # linked: opening stock posted to the existing item
    assert len(items) == 2  # no duplicate items created


def test_import_uploader_cannot_self_approve(as_user):
    admin = as_user("admin")
    batch = admin.post("/api/imports", files={"file": ("a.csv", CSV.encode(), "text/csv")}).json()
    admin.post(f"/api/imports/{batch['id']}/validate", json={"mapping": batch["mapping"]})
    r = admin.post(f"/api/imports/{batch['id']}/approve")
    assert r.status_code == 403 and "Maker" in r.json()["detail"]


# 3 -------------------------------------------------------------------------
def test_bulk_labels_for_existing_items_do_not_duplicate_qr(as_user, make_item):
    a, b = make_item(name="Item Alpha")["item"], make_item(name="Gear Box Housing")["item"]
    stores = as_user("stores")
    first = stores.post("/api/qr/labels", json={"item_ids": [a["id"], b["id"], a["id"]]}).json()
    second = stores.post("/api/qr/labels", json={"item_ids": [a["id"], b["id"]]}).json()
    assert len(first) == 2
    assert [l["token"] for l in first] == [l["token"] for l in second]
    resolved = stores.get("/api/qr/resolve", params={"payload": first[0]["content"], "verify": True}).json()
    assert resolved["kind"] == "item" and resolved["item"]["id"] == a["id"]


# 4 + 5 ---------------------------------------------------------------------
def test_scan_receive_then_issue_updates_balance(as_user, make_item, refs):
    detail = make_item()
    stores, loc = as_user("stores"), refs["loc"]["MAIN-R01-B01"]
    scanned = stores.get("/api/qr/resolve", params={"payload": detail["qr"]["content"]}).json()
    item_id = scanned["item"]["id"]
    r = receive(stores, item_id, 50, loc, source="android")
    assert r.status_code == 200 and r.json()["totals"]["on_hand"] == "50"
    r = issue(stores, item_id, 15, loc, ref=("ASSEMBLY_REQUEST", "AR-77"))
    assert r.status_code == 200, r.text
    assert r.json()["totals"]["available"] == "35"
    assert stores.get("/api/qr/resolve", params={"payload": detail["qr"]["content"]}).json()["totals"]["on_hand"] == "35"
    dash = as_user("manager").get("/api/dashboard/summary").json()
    assert dash["total_items"] == 1 and dash["inventory_valuation"] == "3500"


# 6 -------------------------------------------------------------------------
def test_prevent_unauthorized_or_excessive_issue(as_user, make_item, refs):
    item_id = make_item()["item"]["id"]
    loc = refs["loc"]["MAIN-R01-B01"]
    receive(as_user("stores"), item_id, 10, loc)
    over = issue(as_user("stores"), item_id, 11, loc)
    assert over.status_code == 422 and over.json()["code"] == "insufficient_stock"
    assert issue(as_user("sales"), item_id, 1, loc).status_code == 403
    assert issue(as_user("auditor"), item_id, 1, loc).status_code == 403
    no_ref = issue(as_user("stores"), item_id, 1, loc, ref=("", ""))
    assert no_ref.status_code == 422 and "authorized document" in no_ref.json()["detail"]
    direct = as_user("stores").post("/api/stock/movements", json={"txn_uuid": str(uuid.uuid4()), "movement_type": "ADJUSTMENT_IN",
                                                                  "item_id": item_id, "quantity": "5", "to_location_id": loc})
    assert direct.status_code == 403


def test_qc_hold_excluded_from_available(as_user, make_item, refs):
    item_id = make_item()["item"]["id"]
    loc = refs["loc"]["MAIN-R01-B01"]
    receive(as_user("stores"), item_id, 20, loc, into_qc_hold=True)
    assert issue(as_user("stores"), item_id, 1, loc).status_code == 422
    rel = as_user("qc").post("/api/stock/movements", json={"txn_uuid": str(uuid.uuid4()), "movement_type": "QC_RELEASE", "item_id": item_id,
                                                           "quantity": "20", "from_location_id": loc})
    assert rel.status_code == 200 and rel.json()["totals"]["available"] == "20"


# 7 + 8 ---------------------------------------------------------------------
def _customer(as_user):
    return as_user("admin").post("/api/masters/customers", json={"name": "Kaveri Textiles", "transport_days": 2}).json()["id"]


def test_sales_sees_live_atp_and_estimates(as_user, make_item, refs):
    item_id = make_item(purchase_lead_days=10)["item"]["id"]
    loc = refs["loc"]["MAIN-R01-B01"]
    receive(as_user("stores"), item_id, 30, loc)
    receive(as_user("stores"), item_id, 5, loc, into_qc_hold=True)
    sales = as_user("sales")
    atp = sales.get(f"/api/sales/availability/{item_id}", params={"quantity": "40"}).json()
    assert atp["physical"] == "35" and atp["quality_hold"] == "5" and atp["available_to_promise"] == "30" and atp["shortage"] == "10"

    cust = _customer(as_user)
    ok = sales.post("/api/sales/estimate", json={"item_id": item_id, "quantity": "20", "customer_id": cust}).json()
    short = sales.post("/api/sales/estimate", json={"item_id": item_id, "quantity": "40", "customer_id": cust}).json()
    assert ok["risk"] == "LOW" and short["risk"] == "HIGH"
    assert date.fromisoformat(short["estimated_date"]) > date.fromisoformat(ok["estimated_date"])
    assert any("Supplier lead time" == s["step"] for s in short["steps"])
    # 5 working days of QC/pack/dispatch/transport after today
    assert ok["preliminary"] is True and len(ok["steps"]) == 4

    enq = sales.post("/api/sales/enquiries", json={"customer_id": cust, "item_id": item_id, "quantity": "40",
                                                   "required_date": (date.today() + timedelta(days=3)).isoformat()})
    assert enq.status_code == 201 and enq.json()["risk"] == "HIGH" and enq.json()["number"] == "ENQ-00001"
    assert sales.post("/api/stock/movements", json={}).status_code == 422


def test_incoming_po_shortens_estimate_but_is_not_available(as_user, make_item, refs):
    item_id = make_item(purchase_lead_days=30)["item"]["id"]
    admin, purchase = as_user("admin"), as_user("purchase")
    sup = admin.post("/api/masters/suppliers", json={"name": "Sri Balaji Bearings", "lead_time_days": 30}).json()["id"]
    po = purchase.post("/api/purchase/orders", json={"supplier_id": sup, "lines": [
        {"item_id": item_id, "qty_ordered": "50", "unit_price": "90", "expected_date": (date.today() + timedelta(days=7)).isoformat()}]}).json()
    assert purchase.post(f"/api/purchase/orders/{po['id']}/approve").status_code == 403  # maker–checker
    assert as_user("manager").post(f"/api/purchase/orders/{po['id']}/approve").status_code == 200
    est = as_user("sales").post("/api/sales/estimate", json={"item_id": item_id, "quantity": "20"}).json()
    assert est["availability"]["available_to_promise"] == "0" and est["availability"]["incoming_total"] == "50"
    assert est["risk"] == "MEDIUM"
    # goods receipt against the PO lands in QC hold
    grn = as_user("stores").post(f"/api/purchase/orders/{po['id']}/receive",
                                 json={"line_id": po["lines"][0]["id"], "quantity": "50", "to_location_id": refs["loc"]["MAIN-QC-INSP"]})
    assert grn.status_code == 200 and grn.json()["totals"]["qc_hold"] == "50"


# 13 + 15 -------------------------------------------------------------------
def test_ledger_is_traceable_and_reconciles(as_user, make_item, refs):
    item_id = make_item()["item"]["id"]
    s, l1, l2 = as_user("stores"), refs["loc"]["MAIN-R01-B01"], refs["loc"]["MAIN-R02-B01"]
    receive(s, item_id, 100, l1, cost="10")
    receive(s, item_id, 100, l1, cost="20")
    s.post("/api/stock/movements", json={"txn_uuid": str(uuid.uuid4()), "movement_type": "TRANSFER", "item_id": item_id, "quantity": "30",
                                         "from_location_id": l1, "to_location_id": l2})
    assert issue(s, item_id, 20, l2).status_code == 200
    detail = s.get(f"/api/items/{item_id}").json()
    assert detail["item"]["avg_cost"] == "15"  # weighted average
    assert detail["totals"]["on_hand"] == "180" and detail["totals"]["valuation"] == "2700"
    moves = s.get(f"/api/items/{item_id}/movements").json()
    assert [m["movement_type"] for m in moves] == ["ISSUE", "TRANSFER", "RECEIPT", "RECEIPT"]
    assert all(m["created_by"] and m["number"].startswith("SM-") for m in moves)
    assert s.get("/api/stock/reconcile").json() == {"balanced": True, "mismatches": []}
    audit = as_user("auditor").get("/api/audit", params={"action": "stock."}).json()
    assert audit["total"] >= 4


def test_adjustment_requires_different_approver(as_user, make_item, refs):
    item_id = make_item()["item"]["id"]
    loc = refs["loc"]["MAIN-R01-B01"]
    receive(as_user("stores"), item_id, 10, loc)
    req = as_user("stores").post("/api/stock/adjustments", json={"item_id": item_id, "location_id": loc, "qty_delta": "-2",
                                                                 "reason": "Physical count shortfall"}).json()
    assert as_user("stores").post(f"/api/stock/adjustments/{req['id']}/decision", json={"approve": True}).status_code == 403
    admin_req = as_user("admin").post("/api/stock/adjustments", json={"item_id": item_id, "location_id": loc, "qty_delta": "1", "reason": "Found one"}).json()
    assert as_user("admin").post(f"/api/stock/adjustments/{admin_req['id']}/decision", json={"approve": True}).status_code == 403
    ok = as_user("manager").post(f"/api/stock/adjustments/{req['id']}/decision", json={"approve": True, "note": "Verified"})
    assert ok.status_code == 200 and ok.json()["status"] == "APPROVED"
    assert as_user("stores").get(f"/api/items/{item_id}").json()["totals"]["on_hand"] == "8"


# 14 ------------------------------------------------------------------------
def test_duplicate_submission_is_idempotent(as_user, make_item, refs):
    item_id = make_item()["item"]["id"]
    s, loc = as_user("stores"), refs["loc"]["MAIN-R01-B01"]
    receive(s, item_id, 10, loc)
    txn = str(uuid.uuid4())
    first, again = issue(s, item_id, 4, loc, txn=txn), issue(s, item_id, 4, loc, txn=txn)
    assert first.json()["created"] is True and again.json()["created"] is False
    assert first.json()["movement"]["id"] == again.json()["movement"]["id"]
    assert again.json()["totals"]["on_hand"] == "6"
    reused = issue(s, item_id, 5, loc, txn=txn)
    assert reused.status_code == 409


def test_offline_sync_batch(as_user, make_item, refs):
    item_id = make_item()["item"]["id"]
    s, loc = as_user("stores"), refs["loc"]["MAIN-R01-B01"]
    t1, t2 = str(uuid.uuid4()), str(uuid.uuid4())
    batch = [
        {"txn_uuid": t1, "movement_type": "RECEIPT", "item_id": item_id, "quantity": "5", "to_location_id": loc, "source": "android"},
        {"txn_uuid": t2, "movement_type": "ISSUE", "item_id": item_id, "quantity": "9", "from_location_id": loc, "ref_doc_type": "WIP",
         "ref_doc_no": "W-1", "source": "android"},
    ]
    res = s.post("/api/stock/movements/sync", json=batch).json()["results"]
    assert [r["status"] for r in res] == ["CONFIRMED", "REJECTED"]
    res2 = s.post("/api/stock/movements/sync", json=batch[:1]).json()["results"]
    assert res2[0]["status"] == "ALREADY_CONFIRMED"


def test_concurrent_issues_cannot_oversell(as_user, make_item, refs):
    item_id = make_item()["item"]["id"]
    loc = refs["loc"]["MAIN-R01-B01"]
    receive(as_user("stores"), item_id, 10, loc)
    with SessionLocal() as db:
        user_id = db.query(User).filter_by(username="stores").one().id
    results: list[str] = []

    def worker():
        with SessionLocal() as db:
            user = db.get(User, user_id)
            for _ in range(5):
                try:
                    post_movement(db, user, MovementInput(txn_uuid=str(uuid.uuid4()), movement_type=MovementType.ISSUE, item_id=item_id,
                                                          quantity=Decimal(3), from_location_id=loc, ref_doc_type="WIP", ref_doc_no="W"))
                    db.commit()
                    results.append("ok")
                    return
                except BusinessError:
                    db.rollback()
                    results.append("rejected")
                    return
                except Exception:  # optimistic-lock or SQLite busy → retry
                    db.rollback()
            results.append("gave_up")

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count("ok") == 3  # 3 × 3 = 9 ≤ 10; a 4th would oversell
    assert as_user("stores").get(f"/api/items/{item_id}").json()["totals"]["on_hand"] == "1"
    assert as_user("stores").get("/api/stock/reconcile").json()["balanced"] is True


def test_auditor_is_read_only(as_user, refs):
    aud = as_user("auditor")
    assert aud.get("/api/items").status_code == 200
    assert aud.post("/api/items", json={"name": "X item", "item_type": "SERVICE", "uom_id": refs["uom"]["NOS"]}).status_code == 403
    assert aud.get("/api/audit").status_code == 200


def test_requires_authentication(client):
    assert client.get("/api/items").status_code == 401
    assert client.get("/health").json()["status"] == "ok"
