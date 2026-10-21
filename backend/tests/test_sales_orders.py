"""Spec §16 scenarios 9 and 10: quotations → sales orders, reservation on confirm, shortage
requisitions, forecast recalculation on supplier delay, and no double allocation under concurrency."""
from __future__ import annotations

import threading
import uuid
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import PurchaseRequisition, Reservation, SalesOrder, User
from app.services import sales as sales_svc
from app.services.common import run_with_retry


def receive(api, item_id, qty, loc):
    r = api.post("/api/stock/movements", json={"txn_uuid": str(uuid.uuid4()), "movement_type": "RECEIPT", "item_id": item_id,
                                               "quantity": str(qty), "to_location_id": loc, "unit_cost": "100"})
    assert r.status_code == 200, r.text


def issue(api, item_id, qty, loc, ref):
    return api.post("/api/stock/movements", json={"txn_uuid": str(uuid.uuid4()), "movement_type": "ISSUE", "item_id": item_id,
                                                  "quantity": str(qty), "from_location_id": loc, "ref_doc_type": ref[0], "ref_doc_no": ref[1]})


def customer(as_user, name="Kaveri Textiles"):
    return as_user("admin").post("/api/masters/customers", json={"name": name, "transport_days": 2}).json()["id"]


def enquiry(as_user, cust, item_id, qty, **extra):
    r = as_user("sales").post("/api/sales/enquiries", json={"customer_id": cust, "item_id": item_id, "quantity": str(qty), **extra})
    assert r.status_code == 201, r.text
    return r.json()


def order_from_quote(as_user, enq, price="250"):
    sales = as_user("sales")
    q = sales.post("/api/sales/quotations", json={"enquiry_id": enq["id"], "unit_price": price})
    assert q.status_code == 201, q.text
    assert sales.post(f"/api/sales/quotations/{q.json()['id']}/status", json={"status": "ACCEPTED"}).status_code == 200
    so = sales.post("/api/sales/orders", json={"quotation_id": q.json()["id"], "customer_po_ref": "CUST-PO-77"})
    assert so.status_code == 201, so.text
    return q.json(), so.json()


def atp(as_user, item_id):
    return as_user("sales").get(f"/api/sales/availability/{item_id}").json()


# ------------------------------------------------------------------ quotations
def test_quotation_from_enquiry_carries_preliminary_estimate(as_user, make_item, refs):
    item_id = make_item(purchase_lead_days=10)["item"]["id"]
    receive(as_user("stores"), item_id, 5, refs["loc"]["MAIN-R01-B01"])
    enq = enquiry(as_user, customer(as_user), item_id, 12)
    sales = as_user("sales")

    q = sales.post("/api/sales/quotations", json={"enquiry_id": enq["id"], "unit_price": "185.50", "valid_days": 15}).json()
    assert q["number"] == "QT-00001" and q["status"] == "DRAFT"
    assert q["preliminary_date"] == enq["estimated_date"] and q["risk"] == enq["risk"] == "HIGH"
    assert q["amount"] == "2226"
    assert sales.get("/api/sales/enquiries").json()[0]["status"] == "QUOTED"
    # Only an accepted quotation converts; Auditor and Stores cannot quote.
    assert sales.post("/api/sales/orders", json={"quotation_id": q["id"]}).status_code == 409
    assert as_user("auditor").post("/api/sales/quotations", json={"enquiry_id": enq["id"], "unit_price": "1"}).status_code == 403
    assert sales.post(f"/api/sales/quotations/{q['id']}/status", json={"status": "SENT"}).json()["status"] == "SENT"
    assert sales.post(f"/api/sales/quotations/{q['id']}/status", json={"status": "ACCEPTED"}).json()["status"] == "ACCEPTED"

    so = sales.post("/api/sales/orders", json={"quotation_id": q["id"]}).json()
    assert so["number"] == "SO-00001" and so["status"] == "DRAFT" and so["quotation_number"] == "QT-00001"
    assert so["preliminary_date"] == q["preliminary_date"] and so["committed_date"] is None
    assert so["lines"][0]["unit_price"] == "185.5" and so["lines"][0]["quantity"] == "12"
    # The same quotation / enquiry cannot be converted twice.
    assert sales.post("/api/sales/orders", json={"quotation_id": q["id"]}).status_code == 409
    assert sales.post("/api/sales/orders", json={"enquiry_id": enq["id"]}).status_code == 409
    actions = {e["action"] for e in as_user("auditor").get("/api/audit", params={"action": "sales."}).json()["events"]}
    assert {"sales.quotation.create", "sales.quotation.accepted", "sales.order.create"} <= actions


# ------------------------------------------------------------------ scenario 9
def test_confirm_reserves_stock_raises_requisition_and_issue_consumes_reservation(as_user, make_item, refs):
    loc = refs["loc"]["MAIN-R01-B01"]
    admin, sales, stores = as_user("admin"), as_user("sales"), as_user("stores")
    sup = admin.post("/api/masters/suppliers", json={"name": "Sri Balaji Bearings", "lead_time_days": 10}).json()["id"]
    item_id = make_item(supplier_id=sup)["item"]["id"]
    receive(stores, item_id, 30, loc)
    _, so = order_from_quote(as_user, enquiry(as_user, customer(as_user), item_id, 40,
                                              required_date=(date.today() + timedelta(days=60)).isoformat()))

    # Draft orders reserve nothing.
    assert atp(as_user, item_id)["available_to_promise"] == "30"
    conf = sales.post(f"/api/sales/orders/{so['id']}/confirm")
    assert conf.status_code == 200, conf.text
    so = conf.json()
    line = so["lines"][0]
    assert so["status"] == "CONFIRMED" and line["qty_reserved"] == "30" and line["qty_shortage"] == "10"
    assert so["forecast_date"] and so["forecast_risk"] == "HIGH" and so["committed_date"] is None
    assert [(r["kind"], r["quantity"], r["status"], r["so_number"]) for r in so["requisitions"]] == [("PURCHASE", "10", "OPEN", so["number"])]
    a = atp(as_user, item_id)
    assert a["reserved"] == "30" and a["available_to_promise"] == "0"
    assert a["committed_demand"] == [{"ref": f"SALES_ORDER {so['number']}", "quantity": "30"}]

    # Confirming again is idempotent: no extra reservation or requisition.
    again = sales.post(f"/api/sales/orders/{so['id']}/confirm").json()
    assert again["lines"][0]["qty_reserved"] == "30" and len(again["requisitions"]) == 1
    assert atp(as_user, item_id)["reserved"] == "30"

    # Reserved stock is protected from other documents …
    assert issue(stores, item_id, 5, loc, ("WIP", "W-9")).json()["code"] == "insufficient_stock"
    # … and an issue against the order consumes its own reservation.
    r = issue(stores, item_id, 25, loc, ("SALES_ORDER", so["number"]))
    assert r.status_code == 200, r.text
    assert r.json()["totals"]["on_hand"] == "5" and r.json()["totals"]["reserved"] == "5"
    after = sales.get(f"/api/sales/orders/{so['id']}").json()["lines"][0]
    assert after["qty_issued"] == "25" and after["qty_reserved"] == "5"
    # Over-issue against the order is blocked (15 outstanding, only 5 physically here anyway).
    assert issue(stores, item_id, 16, loc, ("SALES_ORDER", so["number"])).json()["code"] == "over_issue"
    assert stores.get("/api/stock/reconcile").json() == {"balanced": True, "mismatches": []}

    # Procurement sees the requisition and converts it; once approved, the PO is pegged to this order.
    purchase = as_user("purchase")
    reqs = purchase.get("/api/purchase/requisitions").json()
    assert reqs[0]["number"] == "PR-00001" and reqs[0]["item_id"] == item_id
    po = purchase.post(f"/api/purchase/requisitions/{reqs[0]['id']}/convert", json={"unit_price": "90"})
    assert po.status_code == 201, po.text
    assert po.json()["status"] == "DRAFT" and po.json()["lines"][0]["qty_ordered"] == "10"
    assert purchase.get("/api/purchase/requisitions").json()[0]["status"] == "ORDERED"
    assert as_user("manager").post(f"/api/purchase/orders/{po.json()['id']}/approve").status_code == 200
    covered = sales.get(f"/api/sales/orders/{so['id']}").json()
    assert covered["forecast_risk"] == "MEDIUM"
    assert any(p.get("po_number") == po.json()["number"] for p in covered["lines"][0]["forecast"]["pegged_supply"])


def test_produced_item_shortage_raises_production_requisition_and_cancel_releases(as_user, make_item, refs):
    loc = refs["loc"]["MAIN-R03-B02"]
    item_id = make_item(name="Spindle Shaft Ring Frame", item_type="PROCESSED_SPARE", production_lead_days=12,
                        default_location_id=loc)["item"]["id"]
    receive(as_user("stores"), item_id, 2, loc)
    sales = as_user("sales")
    enq = enquiry(as_user, customer(as_user), item_id, 6)
    so = sales.post("/api/sales/orders", json={"enquiry_id": enq["id"]}).json()  # direct enquiry → order
    so = sales.post(f"/api/sales/orders/{so['id']}/confirm").json()
    assert so["lines"][0]["qty_reserved"] == "2"
    assert [(r["kind"], r["quantity"]) for r in so["requisitions"]] == [("PRODUCTION", "4")]
    assert any(s["step"] == "Production / process route" for s in so["lines"][0]["forecast"]["steps"])
    # Production requisitions are not bought.
    assert as_user("purchase").post(f"/api/purchase/requisitions/{so['requisitions'][0]['id']}/convert", json={}).status_code == 409

    cancelled = sales.post(f"/api/sales/orders/{so['id']}/cancel", json={"reason": "Customer withdrew"}).json()
    assert cancelled["status"] == "CANCELLED" and cancelled["lines"][0]["qty_reserved"] == "0"
    assert cancelled["requisitions"][0]["status"] == "CANCELLED"
    assert atp(as_user, item_id)["available_to_promise"] == "2"
    assert as_user("stores").get("/api/stock/reconcile").json()["balanced"] is True


# ------------------------------------------------------------------ scenario 10 + maker–checker
def test_supplier_delay_recalculates_forecast_and_flags_committed_order(as_user, make_item, refs):
    admin, sales, purchase, manager = as_user("admin"), as_user("sales"), as_user("purchase"), as_user("manager")
    item_id = make_item(purchase_lead_days=30)["item"]["id"]
    sup = admin.post("/api/masters/suppliers", json={"name": "Coimbatore Steel", "lead_time_days": 30}).json()["id"]
    po = purchase.post("/api/purchase/orders", json={"supplier_id": sup, "lines": [
        {"item_id": item_id, "qty_ordered": "20", "unit_price": "90", "expected_date": (date.today() + timedelta(days=7)).isoformat()}]}).json()
    assert manager.post(f"/api/purchase/orders/{po['id']}/approve").status_code == 200

    _, so = order_from_quote(as_user, enquiry(as_user, customer(as_user), item_id, 20))
    so = sales.post(f"/api/sales/orders/{so['id']}/confirm").json()
    assert so["lines"][0]["qty_reserved"] == "0" and so["lines"][0]["qty_shortage"] == "20"
    assert so["requisitions"] == []  # fully covered by the approved PO — no duplicate buying
    assert so["forecast_risk"] == "MEDIUM"
    first = date.fromisoformat(so["forecast_date"])
    assert first > date.today() + timedelta(days=7)

    # Committed date: never earlier than the forecast; needs a different user with sales.commit_approve.
    assert sales.post(f"/api/sales/orders/{so['id']}/commit-request",
                      json={"committed_date": (first - timedelta(days=1)).isoformat()}).status_code == 422
    req = sales.post(f"/api/sales/orders/{so['id']}/commit-request", json={"committed_date": first.isoformat(), "note": "Agreed with buyer"})
    assert req.status_code == 200 and req.json()["commit_status"] == "PENDING" and req.json()["committed_date"] is None
    assert sales.post(f"/api/sales/orders/{so['id']}/commit-decision", json={"approve": True}).status_code == 403
    ok = manager.post(f"/api/sales/orders/{so['id']}/commit-decision", json={"approve": True, "note": "OK"})
    assert ok.status_code == 200, ok.text
    so = ok.json()
    assert so["commit_status"] == "APPROVED" and so["committed_date"] == first.isoformat() and so["at_risk"] is False
    assert so["preliminary_date"] is not None  # kept alongside, never overwritten
    assert manager.get("/api/dashboard/summary").json()["orders_at_risk"] == 0

    # Supplier slips by two weeks → forecast moves, the committed order is flagged at risk.
    line_id = po["lines"][0]["id"]
    assert sales.patch(f"/api/purchase/orders/{po['id']}/lines/{line_id}",
                       json={"expected_date": date.today().isoformat(), "reason": "x"}).status_code == 403
    delayed = purchase.patch(f"/api/purchase/orders/{po['id']}/lines/{line_id}",
                             json={"expected_date": (date.today() + timedelta(days=21)).isoformat(), "reason": "Supplier furnace breakdown"})
    assert delayed.status_code == 200, delayed.text
    so = sales.get(f"/api/sales/orders/{so['id']}").json()
    assert date.fromisoformat(so["forecast_date"]) > first
    assert so["committed_date"] == first.isoformat()  # the commitment itself is never silently moved
    assert so["at_risk"] is True
    summary = manager.get("/api/dashboard/summary").json()
    assert summary["orders_at_risk"] == 1 and summary["orders_at_risk_list"][0]["number"] == so["number"]
    assert summary["orders_at_risk_list"][0]["target"] == "committed"
    assert sales.get("/api/sales/orders", params={"at_risk": True}).json()[0]["id"] == so["id"]
    events = as_user("auditor").get("/api/audit", params={"action": "sales.order.forecast_change"}).json()["events"]
    assert events and events[0]["data"]["to"] == so["forecast_date"]
    titles = [n["title"] for n in admin.get("/api/notifications").json()]
    assert any("forecast slipped" in t for t in titles) and any("at risk" in t for t in titles)

    # Supplier recovers → risk clears.
    purchase.patch(f"/api/purchase/orders/{po['id']}/lines/{line_id}",
                   json={"expected_date": (date.today() + timedelta(days=7)).isoformat(), "reason": "Expedited"})
    assert sales.get(f"/api/sales/orders/{so['id']}").json()["at_risk"] is False


def test_requester_cannot_approve_own_commitment(as_user, make_item, refs):
    item_id = make_item()["item"]["id"]
    receive(as_user("stores"), item_id, 10, refs["loc"]["MAIN-R01-B01"])
    admin = as_user("admin")
    _, so = order_from_quote(as_user, enquiry(as_user, customer(as_user), item_id, 4))
    so = admin.post(f"/api/sales/orders/{so['id']}/confirm").json()
    assert so["forecast_risk"] == "LOW" and so["lines"][0]["qty_reserved"] == "4"
    admin.post(f"/api/sales/orders/{so['id']}/commit-request", json={"committed_date": so["forecast_date"]})
    assert admin.post(f"/api/sales/orders/{so['id']}/commit-decision", json={"approve": True}).status_code == 403
    rej = as_user("manager").post(f"/api/sales/orders/{so['id']}/commit-decision", json={"approve": False, "note": "Hold"}).json()
    assert rej["commit_status"] == "REJECTED" and rej["committed_date"] is None


# ------------------------------------------------------------------ concurrency
def test_concurrent_confirmations_never_double_allocate(as_user, make_item, refs):
    item_id = make_item()["item"]["id"]
    receive(as_user("stores"), item_id, 10, refs["loc"]["MAIN-R01-B01"])
    cust = customer(as_user)
    so_ids = [order_from_quote(as_user, enquiry(as_user, cust, item_id, 8))[1]["id"] for _ in range(2)]
    with SessionLocal() as db:
        user_id = db.scalar(select(User.id).where(User.username == "sales"))
    errors: list[Exception] = []
    barrier = threading.Barrier(6)

    def worker(so_id: int):
        with SessionLocal() as db:
            user = db.get(User, user_id)
            barrier.wait()
            try:
                run_with_retry(db, lambda: sales_svc.confirm_sales_order(db, user, db.get(SalesOrder, so_id)), attempts=20)
            except Exception as exc:  # pragma: no cover - surfaced by the assertion below
                errors.append(exc)

    # Three racing confirmations per order (double-clicks / retries) across two orders for 16 > 10 units.
    threads = [threading.Thread(target=worker, args=(so_ids[i % 2],)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []

    with SessionLocal() as db:
        total_reserved = db.scalar(select(func.sum(Reservation.quantity)).where(Reservation.item_id == item_id, Reservation.status == "ACTIVE"))
        assert Decimal(total_reserved) == Decimal(10)
        assert db.scalar(select(func.count()).select_from(Reservation).where(Reservation.item_id == item_id)) == 2
        reqs = db.scalars(select(PurchaseRequisition).where(PurchaseRequisition.item_id == item_id)).all()
        assert [Decimal(r.quantity) for r in reqs] == [Decimal(6)]
    sales = as_user("sales")
    orders = [sales.get(f"/api/sales/orders/{i}").json() for i in so_ids]
    assert all(o["status"] == "CONFIRMED" for o in orders)
    assert sorted(o["lines"][0]["qty_reserved"] for o in orders) == ["2", "8"]
    assert atp(as_user, item_id)["reserved"] == "10" and atp(as_user, item_id)["available_to_promise"] == "0"
    assert as_user("stores").get("/api/stock/reconcile").json() == {"balanced": True, "mismatches": []}
