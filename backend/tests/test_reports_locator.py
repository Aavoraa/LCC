"""Stores stock report (voice report data) and the item locator history."""
from __future__ import annotations

import uuid
from datetime import date, timedelta


def _move(api, **body):
    r = api.post("/api/stock/movements", json={"txn_uuid": str(uuid.uuid4()), **body})
    assert r.status_code == 200, r.text


def test_stock_report_lists_every_item_with_filters(as_user, make_item, refs):
    stores, loc = as_user("stores"), refs["loc"]["MAIN-R01-B01"]
    bearing = make_item("Ball Bearing 6205", min_stock="10")["item"]
    belt = make_item("V Belt B-52", item_type="DAILY_CONSUMABLE")["item"]
    make_item("Hex Bolt M12 x 50", item_type="RAW_MATERIAL")
    _move(stores, movement_type="RECEIPT", item_id=bearing["id"], quantity="8", to_location_id=loc, unit_cost="150")
    _move(stores, movement_type="RECEIPT", item_id=belt["id"], quantity="40", to_location_id=loc, unit_cost="20")

    report = stores.get("/api/reports/stock").json()
    s = report["summary"]
    assert s["items"] == 3 and s["out"] == 1 and s["low"] == 1 and s["ok"] == 1 and s["below_min"] == 1
    assert float(s["valuation"]) == 8 * 150 + 40 * 20
    row = next(r for r in report["rows"] if r["id"] == bearing["id"])
    assert row["locations"][0]["code"] == "MAIN-R01-B01" and float(row["available"]) == 8 and row["below_min"]

    names = lambda **p: [r["name"] for r in stores.get("/api/reports/stock", params=p).json()["rows"]]  # noqa: E731
    assert names(stock_status="OUT") == ["Hex Bolt M12 x 50"]
    assert names(stock_status="MIN") == ["Ball Bearing 6205"]
    assert names(item_type="DAILY_CONSUMABLE") == ["V Belt B-52"]
    assert names(q="bearing 6205") == ["Ball Bearing 6205"]  # every word must match
    assert names(location="r01 b01") == names()  # spoken location without dashes
    assert names(location="R99") == []


def test_locator_finds_by_qr_code_and_name(as_user, make_item, refs):
    stores = as_user("stores")
    detail = make_item("Proximity Sensor M18 PNP")
    item_id = detail["item"]["id"]
    make_item("Proximity Sensor M12 NPN")

    find = lambda q: stores.get("/api/locator/find", params={"query": q}).json()  # noqa: E731
    assert find(detail["qr"]["content"])["item_id"] == item_id
    assert find(detail["item"]["item_code"].lower())["item_id"] == item_id
    assert find(detail["item"]["item_code"].replace("-", " "))["item_id"] == item_id
    assert detail["item"]["item_code"] == "PI-000001" and find("P I 1")["item_id"] == item_id  # spoken item number
    many = find("proximity sensor")
    assert many["item_id"] is None and len(many["candidates"]) == 2
    assert find("sensor m18")["item_id"] == item_id

    # A revoked label still locates the item, with a warning to reprint.
    stores.post(f"/api/items/{item_id}/qr/regenerate", json={"reason": "Label damaged in rack"})
    old = find(detail["qr"]["content"])
    assert old["item_id"] == item_id and "revoked" in old["warning"]


def test_locator_history_covers_purchases_and_movements(as_user, make_item, refs):
    admin, purchase, manager, stores = as_user("admin"), as_user("purchase"), as_user("manager"), as_user("stores")
    loc = refs["loc"]["MAIN-R01-B01"]
    item_id = make_item("Ball Bearing 6205")["item"]["id"]
    sup = admin.post("/api/masters/suppliers", json={"name": "Sri Balaji Bearings", "lead_time_days": 10}).json()["id"]
    expected = (date.today() + timedelta(days=7)).isoformat()
    po = purchase.post("/api/purchase/orders", json={"supplier_id": sup, "lines": [
        {"item_id": item_id, "qty_ordered": "50", "unit_price": "120", "expected_date": expected}]}).json()
    assert manager.post(f"/api/purchase/orders/{po['id']}/approve").status_code == 200
    r = stores.post(f"/api/purchase/orders/{po['id']}/receive",
                    json={"line_id": po["lines"][0]["id"], "quantity": "30", "to_location_id": loc, "into_qc_hold": False})
    assert r.status_code == 200, r.text
    _move(stores, movement_type="ISSUE", item_id=item_id, quantity="12", from_location_id=loc,
          ref_doc_type="ASSEMBLY_REQUEST", ref_doc_no="AR-9")

    h = stores.get(f"/api/locator/items/{item_id}").json()
    assert h["item"]["name"] == "Ball Bearing 6205" and float(h["totals"]["available"]) == 18
    assert h["balances"][0]["location"]["code"] == "MAIN-R01-B01"
    p = h["purchase"]
    assert p["count"] == 1 and p["suppliers"] == ["Sri Balaji Bearings"]
    assert float(p["total_ordered"]) == 50 and float(p["total_received"]) == 30 and float(p["open_qty"]) == 20
    assert float(p["last_price"]) == 120 and p["lines"][0]["po_number"] == po["number"]
    ms = h["movement_summary"]
    assert ms["count"] == 2 and float(ms["received"]) == 30 and float(ms["issued"]) == 12
    assert ms["last_receipt"]["ref_doc_no"] == po["number"]
    assert [m["movement_type"] for m in h["movements"]] == ["ISSUE", "RECEIPT"]
    assert as_user("sales").get(f"/api/locator/items/{item_id}").status_code == 200  # every role can view stock


def test_dashboard_movement_series_follows_the_chosen_period(as_user):
    manager = as_user("manager")
    for days in (7, 14, 30, 90):
        d = manager.get("/api/dashboard/summary", params={"days": days}).json()
        assert d["movements_days"] == days and len(d["movements_14d"]) == days
    assert len(manager.get("/api/dashboard/summary").json()["movements_14d"]) == 14  # default unchanged
    assert manager.get("/api/dashboard/summary", params={"days": 365}).status_code == 422
