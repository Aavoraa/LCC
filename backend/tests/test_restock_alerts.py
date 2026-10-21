"""Restock alerts: out-of-stock items, and items whose available stock reached the minimum set by stores."""
from __future__ import annotations

import uuid


def _receive(api, item_id, loc, qty):
    r = api.post("/api/stock/movements", json={"txn_uuid": str(uuid.uuid4()), "movement_type": "RECEIPT", "item_id": item_id,
                                               "quantity": qty, "to_location_id": loc, "unit_cost": "10"})
    assert r.status_code in (200, 201), r.text


def _ids(alerts, key):
    return {a["id"] for a in alerts[key]}


def test_minimum_stock_triggers_restock_warning(as_user, make_item, refs):
    stores = as_user("stores")
    loc = refs["loc"]["MAIN-R01-B01"]
    empty = make_item("Hydraulic Accumulator Bladder 4L")["item"]
    kept = make_item("Proximity Sensor M18 PNP", min_stock="10")["item"]
    _receive(stores, kept["id"], loc, "25")

    a = stores.get("/api/items/restock-alerts").json()
    assert empty["id"] in _ids(a, "out") and kept["id"] not in _ids(a, "out") | _ids(a, "below_min")

    # Raising the minimum above what is available turns on the warning, with the quantity to order.
    assert stores.patch(f"/api/items/{kept['id']}", json={"min_stock": "30"}).status_code == 200
    a = stores.get("/api/items/restock-alerts").json()
    row = next(x for x in a["below_min"] if x["id"] == kept["id"])
    assert float(row["available"]) == 25 and float(row["shortfall"]) == 5 and a["below_min_count"] >= 1
    listed = stores.get("/api/items?stock_status=MIN").json()["items"]
    assert kept["id"] in {r["id"] for r in listed} and empty["id"] not in {r["id"] for r in listed}

    # Filtering by item type, and clearing the minimum removes the warning.
    assert kept["id"] not in _ids(stores.get("/api/items/restock-alerts?item_type=RAW_MATERIAL").json(), "below_min")
    stores.patch(f"/api/items/{kept['id']}", json={"min_stock": "0"})
    assert kept["id"] not in _ids(stores.get("/api/items/restock-alerts").json(), "below_min")


def test_restock_qty_refills_to_max_or_min(as_user, make_item, refs):
    stores = as_user("stores")
    loc = refs["loc"]["MAIN-R01-B01"]
    item = make_item("Pneumatic Cylinder 32x100 Double Acting", min_stock="10", max_stock="40")["item"]
    _receive(stores, item["id"], loc, "8")
    row = next(r for r in stores.get("/api/items?q=Pneumatic Cylinder 32x100").json()["items"] if r["id"] == item["id"])
    assert float(row["restock_qty"]) == 32  # refill 8 -> max 40
    assert float(stores.get(f"/api/items/{item['id']}").json()["totals"]["restock_qty"]) == 32
    alert = next(a for a in stores.get("/api/items/restock-alerts").json()["below_min"] if a["id"] == item["id"])
    assert float(alert["restock_qty"]) == 32

    stores.patch(f"/api/items/{item['id']}", json={"max_stock": "0"})  # no max: refill only to the minimum
    assert float(stores.get(f"/api/items/{item['id']}").json()["totals"]["restock_qty"]) == 2
    stores.patch(f"/api/items/{item['id']}", json={"min_stock": "5"})  # above minimum: nothing to restock
    assert stores.get(f"/api/items/{item['id']}").json()["totals"]["restock_qty"] is None


def test_stores_set_order_qty_is_used_at_minimum(as_user, make_item, refs):
    stores = as_user("stores")
    loc = refs["loc"]["MAIN-R01-B01"]
    item = make_item("Solenoid Coil 24VDC for 5/2 Valve", min_stock="10", max_stock="40", restock_order_qty="50")["item"]
    assert float(item["restock_order_qty"]) == 50
    assert float(stores.get(f"/api/items/{item['id']}").json()["totals"]["restock_qty"]) == 50  # out of stock -> preset

    _receive(stores, item["id"], loc, "8")  # at minimum -> preset, not refill-to-max (32)
    alert = next(a for a in stores.get("/api/items/restock-alerts").json()["below_min"] if a["id"] == item["id"])
    assert float(alert["restock_qty"]) == 50 and float(alert["restock_order_qty"]) == 50

    stores.patch(f"/api/items/{item['id']}", json={"restock_order_qty": "0"})  # cleared -> back to refill to max
    assert float(stores.get(f"/api/items/{item['id']}").json()["totals"]["restock_qty"]) == 32
    stores.patch(f"/api/items/{item['id']}", json={"restock_order_qty": "50", "min_stock": "5"})  # above minimum -> nothing due
    assert stores.get(f"/api/items/{item['id']}").json()["totals"]["restock_qty"] is None
