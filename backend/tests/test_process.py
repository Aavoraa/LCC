"""Manufacturing routes: standard route by part family, in-house vs outside time estimate, lead-time sync."""
from __future__ import annotations


def _spare(api, refs, name):
    return api.post("/api/items", json={"name": name, "item_type": "PROCESSED_SPARE", "uom_id": refs["uom"]["NOS"],
                                        "reorder_level": "10", "max_stock": "50"}).json()["item"]


def test_standard_route_estimate_and_lead_time(as_user, refs):
    admin = as_user("admin")
    gear = _spare(admin, refs, "Spur Gear 40T Module 2.0 Test")
    assert admin.get(f"/api/items/{gear['id']}/process").json()["steps"] == []
    r = admin.post(f"/api/items/{gear['id']}/process/standard").json()
    assert r["standard_route"] == "gear"
    modes = [s["mode"] for s in r["steps"]]
    assert "IN_HOUSE" in modes and "OUTSIDE" in modes  # hobbing in-house, case hardening outside
    est = r["estimate"]
    # batch = reorder level 10: in-house 130 min setup + 64 min/unit = 770 min = 12.8 h -> 2 days at 8 h; HT 4 days outside
    assert float(est["qty"]) == 10 and est["in_house_days"] == 2 and est["outside_days"] == 4 and est["total_days"] == 6
    assert r["production_lead_days"] == 6
    assert admin.get(f"/api/items/{gear['id']}/process?qty=1").json()["estimate"]["total_days"] == 5


def test_edit_route_validates_and_resyncs(as_user, refs):
    admin = as_user("admin")
    cover = _spare(admin, refs, "Motor Cover Sheet, Powder Coated - TEST")
    assert admin.post(f"/api/items/{cover['id']}/process/standard").json()["standard_route"] == "sheet_plain"
    bad = admin.put(f"/api/items/{cover['id']}/process", json={"steps": [{"operation": "Powder coating", "mode": "OUTSIDE"}]})
    assert bad.status_code in (400, 422)
    ok = admin.put(f"/api/items/{cover['id']}/process", json={"steps": [
        {"operation": "Laser cutting", "mode": "IN_HOUSE", "setup_min": "60", "run_min": "0"},
        {"operation": "Powder coating", "mode": "OUTSIDE", "outside_days": 3}]}).json()
    assert [s["seq"] for s in ok["steps"]] == [1, 2] and ok["production_lead_days"] == 4
    assert as_user("sales").put(f"/api/items/{cover['id']}/process", json={"steps": []}).status_code == 403
