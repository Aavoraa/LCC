"""Machine SOP spare lists: catalogue load, stores alignment, stores check and shortage requisitions."""
from __future__ import annotations

import uuid

from app.db import SessionLocal
from app.machine_catalog import MACHINES, load
from app.models import User


def _load():
    with SessionLocal() as db:
        load(db, db.query(User).filter_by(username="admin").one())
        db.commit()


def _machine(api, code):
    return next(m for m in api.get("/api/machines").json() if m["code"] == code)


def test_catalogue_loads_all_machines_and_is_idempotent(as_user):
    _load()
    _load()  # re-running must not duplicate lines
    machines = as_user("stores").get("/api/machines").json()
    assert len(machines) == len(MACHINES) == 11
    wme = next(m for m in machines if m["code"] == "CSM-WME")
    assert wme["spare_count"] == len(MACHINES[0]["spares"]) and wme["aligned_count"] == 0
    assert wme["counts"]["NOT_IN_STORE"] + wme["counts"]["ON_DEMAND"] == wme["spare_count"] and wme["readiness_pct"] == 0
    assert wme["counts"]["ON_DEMAND"] == sum(1 for sp in MACHINES[0]["spares"] if sp[4] == 0)
    detail = as_user("sales").get(f"/api/machines/{wme['id']}").json()  # view needs only items.view
    assert detail["spares"][0]["source_ref"].startswith("Catalogue p.") and detail["spares"][0]["basis"] in ("CATALOGUE", "DERIVED")


def test_align_links_exact_names_and_shares_items_across_machines(as_user, refs):
    _load()
    stores = as_user("stores")
    # An existing stores item with the exact spare name is linked, not duplicated.
    existing = stores.post("/api/items", json={"name": "Ceramic Guide Plate Plain", "item_type": "PURCHASED_ITEM",
                                               "uom_id": refs["uom"]["NOS"]}).json()["item"]
    wme, mrm = _machine(stores, "CSM-WME"), _machine(stores, "CSM-MRM")
    r = stores.post(f"/api/machines/{wme['id']}/align", json={"create_missing": True}).json()
    assert r["linked"] == 1
    spares = {s["name"]: s for s in r["machine"]["spares"]}
    assert spares["Ceramic Guide Plate Plain"]["item_id"] == existing["id"]
    created_ids = {s["item_id"] for s in r["machine"]["spares"] if s["item_id"]}
    # MRM shares guide plates, inverter and soldering iron with WME — it must reuse those items.
    r2 = stores.post(f"/api/machines/{mrm['id']}/align", json={"create_missing": True}).json()
    mrm_spares = {s["name"]: s for s in r2["machine"]["spares"]}
    assert mrm_spares["AC Inverter Drive 1.5 HP with Remote Control"]["item_id"] in created_ids
    assert mrm_spares["Soldering Iron 500 W with Tin/Lead and Flux"]["item_id"] == spares["Soldering Iron 500 W with Tin/Lead and Flux"]["item_id"]
    # New stores items carry a code and QR and sit in the spares category with SOP stock as reorder level.
    item = stores.get(f"/api/items/{spares['Tipped Finger for Wire Mounting Equipment']['item_id']}").json()
    assert item["qr"]["status"] == "ACTIVE" and item["item"]["category"]["name"] == "Card Service Spares"
    assert item["item"]["reorder_level"] == "2"


def test_similar_names_wait_for_review_and_manual_link(as_user, refs):
    _load()
    stores = as_user("stores")
    similar = stores.post("/api/items", json={"name": "Tipped Fingers for Wire Mounting Equipments", "item_type": "PURCHASED_ITEM",
                                              "uom_id": refs["uom"]["NOS"]}).json()["item"]
    wme = _machine(stores, "CSM-WME")
    r = stores.post(f"/api/machines/{wme['id']}/align", json={"create_missing": True}).json()
    assert r["needs_review"] >= 1
    line = next(s for s in r["machine"]["spares"] if s["name"] == "Tipped Finger for Wire Mounting Equipment")
    assert line["item_id"] is None and line["suggestions"][0]["item_id"] == similar["id"]
    linked = stores.post(f"/api/machines/spares/{line['id']}/link", json={"item_id": similar["id"]}).json()
    assert linked["item"]["item_code"] == similar["item_code"]


def test_store_check_and_requisitions_without_double_ordering(as_user, refs):
    _load()
    stores = as_user("stores")
    ofgm = _machine(stores, "CSM-OFGM")
    stores.post(f"/api/machines/{ofgm['id']}/align", json={"create_missing": True})
    detail = stores.get(f"/api/machines/{ofgm['id']}").json()
    fillet = next(s for s in detail["spares"] if s["name"] == "Emery Fillet Silicarbo No.7 Grooved")
    assert fillet["sop_stock"] == "2"
    # Receive 3 fillets: enough for one machine (SOP 2), short for two machines (need 4).
    stores.post("/api/stock/movements", json={"txn_uuid": str(uuid.uuid4()), "movement_type": "RECEIPT", "item_id": fillet["item_id"],
                                              "quantity": "3", "to_location_id": refs["loc"]["MAIN-R01-B01"], "unit_cost": "950"})
    one = stores.get(f"/api/machines/{ofgm['id']}/store-check", params={"units": 1}).json()
    two = stores.get(f"/api/machines/{ofgm['id']}/store-check", params={"units": 2}).json()
    row1 = next(l for l in one["lines"] if l["spare_id"] == fillet["id"])
    row2 = next(l for l in two["lines"] if l["spare_id"] == fillet["id"])
    assert row1["status"] == "OK" and row1["available"] == "3"
    assert row2["status"] == "SHORT" and row2["required"] == "4" and row2["shortage"] == "1"
    assert as_user("sales").post(f"/api/machines/{ofgm['id']}/requisitions", json={"units": 2}).status_code == 403
    first = as_user("purchase").post(f"/api/machines/{ofgm['id']}/requisitions", json={"units": 2}).json()["created"]
    fillet_pr = [p for p in first if p["item_name"] == "Emery Fillet Silicarbo No.7 Grooved"]
    assert fillet_pr and fillet_pr[0]["quantity"] == "1"
    again = as_user("purchase").post(f"/api/machines/{ofgm['id']}/requisitions", json={"units": 2}).json()["created"]
    assert again == []  # open requisitions already cover every shortage
    after = stores.get(f"/api/machines/{ofgm['id']}/store-check", params={"units": 2}).json()
    assert next(l for l in after["lines"] if l["spare_id"] == fillet["id"])["open_requisition_qty"] == "1"


def test_sop_quantities_editable_only_by_maintainers(as_user):
    _load()
    wme = _machine(as_user("stores"), "CSM-WME")
    spare = as_user("stores").get(f"/api/machines/{wme['id']}").json()["spares"][0]
    assert as_user("sales").patch(f"/api/machines/spares/{spare['id']}", json={"sop_stock": "5"}).status_code == 403
    r = as_user("stores").patch(f"/api/machines/spares/{spare['id']}", json={"sop_stock": "5", "criticality": "A"})
    assert r.status_code == 200 and r.json()["sop_stock"] == "5"
    added = as_user("stores").post(f"/api/machines/{wme['id']}/spares", json={"name": "Spare Tension Spring", "group": "WEAR"})
    assert added.status_code == 201 and added.json()["part_no"].startswith("CSM-WME-")
    dup = as_user("stores").post(f"/api/machines/{wme['id']}/spares", json={"name": "Spare tension spring", "group": "WEAR"})
    assert dup.status_code == 409
