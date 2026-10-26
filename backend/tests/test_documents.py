"""Invoice scanner: upload, AI extraction (provider faked here), review, validation and maker–checker approval."""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.services.extraction import ExtractionError, ExtractionResult

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def ok(r, code=200):
    assert r.status_code == code, r.text
    return r.json()


def scored(v, c=0.98):
    return {"value": str(v), "confidence": c}


class FakeProvider:
    name, model, configured = "fake", "fake-vision", True

    def __init__(self, data=None, error=None):
        self.data, self.error, self.calls = data, error, []

    def extract(self, spec, pages):
        self.calls.append((spec.code, [p.content_type for p in pages]))
        if self.error:
            raise ExtractionError(self.error)
        return ExtractionResult(data=self.data, provider=self.name, model=self.model, usage={"input_tokens": 1})


def invoice(po_number, qty="30", gstin="33ABCDE1234F1Z5", number="SBB/2026/0412", igst=False):
    taxable = float(qty) * 120
    tax = round(taxable * 0.18, 2)
    header = {k: scored("", 0) for k in (
        "supplier_name", "supplier_gstin", "supplier_address", "invoice_number", "invoice_date", "po_number", "po_date", "buyer_name",
        "buyer_gstin", "place_of_supply", "dc_number", "vehicle_number", "taxable_value", "cgst_amount", "sgst_amount", "igst_amount",
        "other_charges", "round_off", "grand_total")}
    header.update(supplier_name=scored("Sri Balaji Bearings"), supplier_gstin=scored(gstin), supplier_address=scored("Coimbatore", 0.5),
                  invoice_number=scored(number), invoice_date=scored(date.today().isoformat()), po_number=scored(po_number),
                  buyer_gstin=scored("33AAACL3521E1Z6"), taxable_value=scored(f"{taxable:.2f}"), grand_total=scored(f"{taxable + tax:.2f}"))
    if igst:
        header["igst_amount"] = scored(f"{tax:.2f}")
    else:
        header.update(cgst_amount=scored(f"{tax / 2:.2f}"), sgst_amount=scored(f"{tax / 2:.2f}"))
    line = {"item_code": "", "description": "Ball Bearing 6205", "hsn_code": "84821011", "quantity": qty, "uom": "NOS", "unit_price": "120.00",
            "discount": "", "taxable_value": f"{taxable:.2f}", "gst_rate": "18", "tax_amount": f"{tax:.2f}", "line_total": f"{taxable + tax:.2f}",
            "confidence": 0.97, "uncertain_fields": []}
    return {"detected_document_type": "tax invoice", "document_type_matches": True, "header": header, "lines": [line], "notes": []}


@pytest.fixture
def po(as_user, make_item, refs):
    """Approved PO for 50 bearings at 120 with 30 received (GRN) from a supplier in our state."""
    admin, purchase, manager, stores = as_user("admin"), as_user("purchase"), as_user("manager"), as_user("stores")
    item = make_item("Ball Bearing 6205")["item"]
    sup = ok(admin.post("/api/masters/suppliers", json={"name": "Sri Balaji Bearings", "gstin": "33ABCDE1234F1Z5"}), 201)
    p = ok(purchase.post("/api/purchase/orders", json={"supplier_id": sup["id"], "lines": [
        {"item_id": item["id"], "qty_ordered": "50", "unit_price": "120", "expected_date": (date.today() + timedelta(days=5)).isoformat()}]}), 201)
    ok(manager.post(f"/api/purchase/orders/{p['id']}/approve"))
    ok(stores.post(f"/api/purchase/orders/{p['id']}/receive", json={"line_id": p["lines"][0]["id"], "quantity": "30",
                                                                      "to_location_id": refs["loc"]["MAIN-R01-B01"], "into_qc_hold": False}))
    return p


def _upload(api, doc_type="SUPPLIER_INVOICE", files=(("invoice.png", PNG, "image/png"),), **form):
    return api.post("/api/documents", data={"doc_type": doc_type, **form}, files=[("files", f) for f in files])


def statuses(doc):
    return {c["code"]: c["status"] for c in doc["checks"]}


def test_invoice_extracted_validated_and_approved_by_checker(as_user, po, monkeypatch):
    fake = FakeProvider(invoice(po["number"]))
    monkeypatch.setattr("app.services.documents.get_provider", lambda: fake)
    purchase, manager = as_user("purchase"), as_user("manager")

    doc = ok(_upload(purchase), 201)
    assert fake.calls == [("SUPPLIER_INVOICE", ["image/png"])]
    assert doc["status"] == "EXTRACTED" and doc["reference_no"] == "SBB/2026/0412" and float(doc["total"]) == 4248
    s = statuses(doc)
    assert s["lines_total"] == s["grand_total"] == s["gst_type"] == s["gst_rate"] == s["supplier"] == s["po"] == s["grn"] == "pass"
    assert s["low_confidence"] == "warn" and doc["failed"] == 0  # supplier address read with confidence 0.5
    assert doc["supplier_id"] and doc["purchase_order_id"] == po["id"]

    # The stored file is served privately through the API.
    page = purchase.get(f"/api/documents/{doc['id']}/pages/1")
    assert page.status_code == 200 and page.content == PNG and page.headers["content-type"] == "image/png"
    assert purchase.c.get(f"/api/documents/{doc['id']}/pages/1").status_code == 401  # no token

    # Reviewer corrects the invoice to 40 units — more than the 30 received — so the GRN match fails.
    data = doc["data"]
    line = {k: v for k, v in data["lines"][0].items() if k not in ("confidence", "uncertain_fields", "edited")}
    edited = ok(purchase.put(f"/api/documents/{doc['id']}/data", json={
        "header": {"supplier_address": "Avinashi Road, Coimbatore"}, "lines": [{**line, "quantity": "40", "taxable_value": "4800.00"}]}))
    s = statuses(edited)
    assert s["grn"] == "fail" and s["lines_total"] == "fail" and edited["data"]["header"]["supplier_address"]["edited"]
    assert "low_confidence" not in s  # corrected by a person
    assert manager.post(f"/api/documents/{doc['id']}/decision", json={"approve": True}).json()["code"] == "checks_failed"

    ok(purchase.put(f"/api/documents/{doc['id']}/data", json={"lines": [line]}))  # back to what was received
    assert purchase.post(f"/api/documents/{doc['id']}/decision", json={"approve": True}).status_code == 403  # no approve permission
    approved = ok(manager.post(f"/api/documents/{doc['id']}/decision", json={"approve": True, "note": "Matches GRN"}))
    assert approved["status"] == "APPROVED" and approved["reviewed_by"] == "Manager"
    assert purchase.put(f"/api/documents/{doc['id']}/data", json={"header": {}}).status_code == 409  # locked once approved

    # The same invoice again is caught as a duplicate (and as the same file).
    dup = ok(_upload(purchase), 201)
    assert statuses(dup)["duplicate"] == "fail" and statuses(dup)["duplicate_file"] == "warn"
    rejected = ok(manager.post(f"/api/documents/{dup['id']}/decision", json={"approve": False, "note": "Duplicate of DOC-00001"}))
    assert rejected["status"] == "REJECTED"
    listed = ok(manager.get("/api/documents", params={"q": "SBB/2026"}))
    assert {d["status"] for d in listed} == {"APPROVED", "REJECTED"}

    # Wrong uploads can be deleted (with their files); approved documents stay.
    assert purchase.delete(f"/api/documents/{doc['id']}").status_code == 409
    assert as_user("sales").delete(f"/api/documents/{dup['id']}").status_code == 403
    assert purchase.delete(f"/api/documents/{dup['id']}").status_code == 204
    assert purchase.get(f"/api/documents/{dup['id']}").status_code == 404
    assert purchase.get(f"/api/documents/{dup['id']}/pages/1").status_code == 404
    assert any(e["action"] == "document.delete" for e in ok(manager.get("/api/audit", params={"action": "document.delete"}))["events"])


def test_gst_type_and_maker_checker(as_user, po, monkeypatch):
    monkeypatch.setattr("app.services.documents.get_provider", lambda: FakeProvider(invoice(po["number"], igst=True, number="X-1")))
    admin = as_user("admin")
    doc = ok(_upload(admin), 201)
    assert statuses(doc)["gst_type"] == "fail"  # same-state supplier charged IGST
    r = admin.post(f"/api/documents/{doc['id']}/decision", json={"approve": True, "override": True, "note": "Supplier to reissue"})
    assert r.status_code == 403 and r.json()["code"] == "forbidden"  # uploader cannot approve their own document
    ok(as_user("manager").post(f"/api/documents/{doc['id']}/decision", json={"approve": True, "override": True, "note": "Supplier to reissue"}))


def test_failed_extraction_kept_for_manual_entry_and_upload_rules(as_user, monkeypatch):
    monkeypatch.setattr("app.services.documents.get_provider", lambda: FakeProvider(error="AI extraction is not set up"))
    stores = as_user("stores")
    doc = ok(_upload(stores, doc_type="PRODUCTION_REPORT", files=(("p1.jpg", b"\xff\xd8\xff" + b"0" * 32, "image/jpeg"),
                                                                    ("p2.pdf", b"%PDF-1.4 x", "application/pdf"))), 201)
    assert doc["status"] == "FAILED" and doc["extraction_error"] == "AI extraction is not set up" and doc["page_count"] == 2
    filled = ok(stores.put(f"/api/documents/{doc['id']}/data", json={"header": {"report_title": "Production details"},
                                                                     "lines": [{"job_no": "WO-99999", "item_no": "M502940160", "quantity": "1"}]}))
    assert filled["status"] == "EXTRACTED" and statuses(filled)["job"] == "warn" and statuses(filled)["item"] == "warn"

    assert _upload(stores, files=(("a.txt", b"hello", "text/plain"),)).status_code == 422
    assert _upload(stores, doc_type="NOPE").status_code == 422
    assert _upload(as_user("sales")).status_code == 403
    cfg = ok(stores.get("/api/documents/config"))
    assert {t["code"] for t in cfg["doc_types"]} == {"SUPPLIER_INVOICE", "DELIVERY_CHALLAN", "PRODUCTION_REPORT", "OTHER"}


def test_sample_data_loader_runs_in_steps_and_only_on_a_fresh_system(as_user, monkeypatch):
    import app.api.sample_data as sd

    monkeypatch.setattr(sd, "TARGET_ITEMS", 120)
    monkeypatch.setattr(sd, "BATCH", 60)
    monkeypatch.setenv("EXTRACTION_PROVIDER", "none")
    admin = as_user("admin")
    assert as_user("manager").post("/api/admin/sample-data", json={"step": "base", "password": "Demo-pass-123"}).status_code == 403
    assert admin.post("/api/admin/sample-data", json={"step": "base"}).status_code == 422  # demo users need a password
    ok(admin.post("/api/admin/sample-data", json={"step": "base", "password": "Demo-pass-123"}))
    while ok(admin.get("/api/admin/sample-data"))["items"] < 120:
        assert ok(admin.post("/api/admin/sample-data", json={"step": "catalog"}))["result"]["added"] > 0
    ok(admin.post("/api/admin/sample-data", json={"step": "machines"}))
    res = ok(admin.post("/api/admin/sample-data", json={"step": "activity"}))
    st = res["status"]
    assert st["purchase_orders"] == 7 and st["sales_orders"] >= 3 and st["machines"] >= 10 and not st["can_load"]
    assert ok(admin.get("/api/stock/reconcile"))["balanced"]
    # Once there are transactions, nothing more is loaded.
    assert admin.post("/api/admin/sample-data", json={"step": "catalog"}).status_code == 409
