"""Invoice scanner: upload or photograph a document, extract its fields with AI, review, validate and approve.

Lifecycle: UPLOADED → EXTRACTED (or FAILED, then re-run or enter by hand) → APPROVED / REJECTED.
Every save re-runs the validations; approval is maker–checker (a different user from the uploader) and is blocked by
failed checks unless the approver overrides them with a reason.
"""
from __future__ import annotations

import copy
import difflib
import hashlib
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import DocumentPage, Item, PurchaseOrder, ScannedDocument, Supplier, User, WorkOrder
from .common import BusinessError, audit, next_number, normalize_name, notify
from .company import company_profile
from .extraction import DocSpec, ExtractionError, Page, get_provider

ALLOWED_TYPES = {"application/pdf", "image/jpeg", "image/png", "image/webp"}
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # the vision API's per-image limit; the web app downsizes photos before upload
MAX_TOTAL_BYTES = 30 * 1024 * 1024
MAX_FILES = 20
LOW_CONFIDENCE = 0.8
GSTIN_RE = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$")

SPECS: dict[str, DocSpec] = {
    "SUPPLIER_INVOICE": DocSpec(
        "SUPPLIER_INVOICE", "Supplier tax invoice (GST)",
        [("supplier_name", "Supplier (seller) name"), ("supplier_gstin", "Supplier GSTIN"), ("supplier_address", "Supplier address"),
         ("invoice_number", "Invoice number"), ("invoice_date", "Invoice date"), ("po_number", "Buyer's PO / order number"),
         ("po_date", "PO date"), ("buyer_name", "Buyer (bill-to) name"), ("buyer_gstin", "Buyer GSTIN"),
         ("place_of_supply", "Place of supply (state)"), ("dc_number", "Delivery challan / DC number"),
         ("vehicle_number", "Vehicle number"), ("taxable_value", "Total taxable value (before GST)"),
         ("cgst_amount", "Total CGST amount"), ("sgst_amount", "Total SGST / UTGST amount"), ("igst_amount", "Total IGST amount"),
         ("other_charges", "Freight / packing / other charges"), ("round_off", "Round off (negative if deducted)"),
         ("grand_total", "Invoice grand total")],
        [("item_code", "Item / part code"), ("description", "Description of goods"), ("hsn_code", "HSN / SAC"),
         ("quantity", "Quantity"), ("uom", "Unit"), ("unit_price", "Rate per unit"), ("discount", "Discount amount"),
         ("taxable_value", "Taxable value of the line"), ("gst_rate", "GST rate % (total of CGST+SGST or IGST)"),
         ("tax_amount", "GST amount of the line"), ("line_total", "Line total including tax")],
        "An Indian GST tax invoice from a supplier to us (the buyer). The seller is the supplier.",
    ),
    "DELIVERY_CHALLAN": DocSpec(
        "DELIVERY_CHALLAN", "Delivery challan (incl. job-work challan)",
        [("challan_number", "Challan number"), ("challan_date", "Challan date"), ("consignor_name", "Consignor (sender) name"),
         ("consignor_gstin", "Consignor GSTIN"), ("consignee_name", "Consignee (receiver) name"), ("consignee_gstin", "Consignee GSTIN"),
         ("po_number", "PO number"), ("po_date", "PO date"), ("vehicle_number", "Vehicle number"), ("transporter", "Transporter"),
         ("waybill_number", "Waybill / e-way bill number"), ("process_nature", "Nature of processing (job work)"),
         ("total_value", "Total value")],
        [("item_code", "Item / part code"), ("description", "Description of goods"), ("hsn_code", "HSN"), ("quantity", "Quantity"),
         ("uom", "Unit"), ("rate", "Rate"), ("value", "Value")],
        "A delivery challan sent with goods (for example to or from a job-work vendor). It is not a tax invoice.",
    ),
    "PRODUCTION_REPORT": DocSpec(
        "PRODUCTION_REPORT", "Production report / job card",
        [("report_title", "Report title"), ("organization", "Organisation / unit"), ("from_date", "From date"),
         ("to_date", "To date"), ("prepared_by", "Prepared by")],
        [("job_no", "Job / work order number"), ("item_no", "Item number"), ("item_description", "Item description"),
         ("quantity", "Transaction / completed quantity"), ("uom", "Unit"), ("transaction_date", "Transaction date"),
         ("remarks", "Remarks (e.g. COMPLETED, PARTIAL COMPLETION)"), ("start_quantity", "Job start quantity"),
         ("quantity_completed", "Job quantity completed to date"), ("job_status", "Job status (e.g. RELEASED, COMPLETED)")],
        "A shop-floor production report, job card or production details printout listing work-order (job) completions.",
    ),
    "OTHER": DocSpec(
        "OTHER", "Other document",
        [("title", "Document title"), ("reference_number", "Reference / document number"), ("document_date", "Document date"),
         ("party_name", "Other party (company) name"), ("party_gstin", "Other party GSTIN"), ("total_amount", "Total amount")],
        [("item_code", "Item / part code"), ("description", "Description"), ("quantity", "Quantity"), ("uom", "Unit"), ("amount", "Amount")],
        "Any other business document.",
    ),
}
# Which header fields fill the listing columns.
KEYS = {
    "SUPPLIER_INVOICE": ("supplier_name", "supplier_gstin", "invoice_number", "invoice_date", "grand_total"),
    "DELIVERY_CHALLAN": ("consignor_name", "consignor_gstin", "challan_number", "challan_date", "total_value"),
    "PRODUCTION_REPORT": ("organization", None, "report_title", "to_date", None),
    "OTHER": ("party_name", "party_gstin", "reference_number", "document_date", "total_amount"),
}


def _spec(doc_type: str) -> DocSpec:
    spec = SPECS.get(doc_type)
    if spec is None:
        raise BusinessError(f"Unknown document type {doc_type}")
    return spec


def num(v) -> Decimal | None:
    s = re.sub(r"[^\d.\-]", "", str(v or "").replace(",", ""))
    if s in ("", "-", ".", "-."):
        return None
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


def parse_date(v) -> date | None:
    try:
        return date.fromisoformat(str(v or "").strip()[:10])
    except ValueError:
        return None


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ upload
def create_document(db: Session, user: User, doc_type: str, files: list[tuple[str, str, bytes]], notes: str | None = None) -> ScannedDocument:
    _spec(doc_type)
    if not files:
        raise BusinessError("Choose at least one file or take a photo")
    if len(files) > MAX_FILES:
        raise BusinessError(f"Upload at most {MAX_FILES} pages per document")
    total = 0
    for name, ctype, content in files:
        if ctype not in ALLOWED_TYPES:
            raise BusinessError(f"{name}: only PDF, JPG, PNG and WEBP files are accepted")
        if not content:
            raise BusinessError(f"{name} is empty")
        limit = MAX_FILE_BYTES if ctype == "application/pdf" else MAX_IMAGE_BYTES
        if len(content) > limit:
            raise BusinessError(f"{name} is larger than {limit // (1024 * 1024)} MB")
        total += len(content)
    if total > MAX_TOTAL_BYTES:
        raise BusinessError(f"The upload is larger than {MAX_TOTAL_BYTES // (1024 * 1024)} MB in total")
    digest = hashlib.sha256()
    for _, _, content in files:
        digest.update(hashlib.sha256(content).digest())
    doc = ScannedDocument(number=next_number(db, "scanned_document", "DOC-", 5), doc_type=doc_type, status="UPLOADED",
                          title=files[0][0][:255], page_count=len(files), sha256=digest.hexdigest(), notes=notes, created_by_id=user.id)
    for n, (name, ctype, content) in enumerate(files, start=1):
        doc.pages.append(DocumentPage(page_no=n, filename=name[:255], content_type=ctype, size=len(content), content=content))
    db.add(doc)
    db.flush()
    audit(db, user, "document.upload", "scanned_document", doc.id, {"number": doc.number, "type": doc_type, "pages": len(files)})
    return doc


def empty_data(doc_type: str) -> dict:
    spec = _spec(doc_type)
    return {"detected_document_type": "", "document_type_matches": True, "notes": [], "lines": [],
            "header": {k: {"value": "", "confidence": 0.0, "edited": False} for k, _ in spec.header}}


def _normalise(spec: DocSpec, raw: dict) -> dict:
    """Coerce the model's answer to the stored shape (also guards against missing keys)."""
    header = {}
    for k, _ in spec.header:
        f = (raw.get("header") or {}).get(k) or {}
        header[k] = {"value": str(f.get("value") or "").strip(), "confidence": float(f.get("confidence") or 0), "edited": False}
    lines = []
    for line in raw.get("lines") or []:
        row = {k: str(line.get(k) or "").strip() for k, _ in spec.lines}
        row["confidence"] = float(line.get("confidence") or 0)
        row["uncertain_fields"] = [f for f in line.get("uncertain_fields") or [] if f in row]
        lines.append(row)
    return {"detected_document_type": str(raw.get("detected_document_type") or ""),
            "document_type_matches": bool(raw.get("document_type_matches", True)),
            "notes": [str(n) for n in raw.get("notes") or []], "header": header, "lines": lines}


def run_extraction(db: Session, user: User, doc: ScannedDocument) -> ScannedDocument:
    if doc.status in ("APPROVED", "REJECTED"):
        raise BusinessError(f"{doc.number} is {doc.status.lower()}", status_code=409, code="state")
    spec = _spec(doc.doc_type)
    provider = get_provider()
    pages = [Page(p.filename, p.content_type, p.content) for p in doc.pages]
    try:
        result = provider.extract(spec, pages)
    except ExtractionError as e:
        doc.status, doc.extraction_error = "FAILED", str(e)
        if doc.data is None:
            doc.data = empty_data(doc.doc_type)
        _refresh(db, doc)
        audit(db, user, "document.extract.failed", "scanned_document", doc.id, {"number": doc.number, "error": str(e)})
        return doc
    data = _normalise(spec, result.data)
    doc.extraction, doc.data = result.data, data
    doc.provider, doc.model, doc.usage, doc.extracted_at = result.provider, result.model, result.usage, _now()
    doc.status, doc.extraction_error = "EXTRACTED", None
    _refresh(db, doc)
    audit(db, user, "document.extract", "scanned_document", doc.id,
          {"number": doc.number, "provider": result.provider, "model": result.model, "lines": len(data["lines"])})
    return doc


def save_data(db: Session, user: User, doc: ScannedDocument, header: dict[str, str], lines: list[dict], notes: str | None) -> ScannedDocument:
    """A reviewer's corrections. Changed header fields are flagged ``edited`` (shown as checked by a person)."""
    if doc.status in ("APPROVED", "REJECTED"):
        raise BusinessError(f"{doc.number} is {doc.status.lower()}", status_code=409, code="state")
    spec = _spec(doc.doc_type)
    data = copy.deepcopy(doc.data) if doc.data else empty_data(doc.doc_type)
    for k, _ in spec.header:
        if k in header:
            new = str(header[k] or "").strip()
            f = data["header"].setdefault(k, {"value": "", "confidence": 0.0, "edited": False})
            if new != f["value"]:
                f.update(value=new, edited=True)
    keys = [k for k, _ in spec.lines]
    old = data.get("lines") or []
    new_lines = []
    for i, line in enumerate(lines):
        row = {k: str(line.get(k) or "").strip() for k in keys}
        prev = old[i] if i < len(old) else None
        same = prev is not None and all(prev.get(k, "") == row[k] for k in keys)
        row["confidence"] = prev.get("confidence", 1.0) if same else 1.0
        row["uncertain_fields"] = prev.get("uncertain_fields", []) if same else []
        row["edited"] = (prev.get("edited", False) if same else True)
        new_lines.append(row)
    data["lines"] = new_lines
    doc.data = data
    if notes is not None:
        doc.notes = notes
    if doc.status in ("UPLOADED", "FAILED"):
        doc.status = "EXTRACTED"  # entered by hand
    _refresh(db, doc)
    audit(db, user, "document.update", "scanned_document", doc.id, {"number": doc.number})
    return doc


def decide(db: Session, user: User, doc: ScannedDocument, approve: bool, note: str | None, override: bool = False) -> ScannedDocument:
    if doc.status != "EXTRACTED":
        raise BusinessError(f"{doc.number} is {doc.status.lower()} — extract or enter the data first", status_code=409, code="state")
    if doc.created_by_id == user.id:
        raise BusinessError("Maker–checker: a different user must approve or reject a document you uploaded", status_code=403, code="forbidden")
    if approve:
        _refresh(db, doc)
        failed = [c for c in doc.checks or [] if c["status"] == "fail"]
        if failed and not override:
            raise BusinessError(f"{len(failed)} check(s) failed: {failed[0]['message']} — fix the data, or approve with an override reason",
                                code="checks_failed")
        if failed and len((note or "").strip()) < 5:
            raise BusinessError("Give a reason (5+ characters) for approving despite failed checks")
    elif len((note or "").strip()) < 5:
        raise BusinessError("Give a reason (5+ characters) for rejecting")
    doc.status, doc.reviewed_by_id, doc.reviewed_at, doc.decision_note = ("APPROVED" if approve else "REJECTED"), user.id, _now(), note
    audit(db, user, f"document.{'approve' if approve else 'reject'}", "scanned_document", doc.id,
          {"number": doc.number, "note": note, "override": bool(override), "reference": doc.reference_no, "total": doc.total})
    if approve and doc.doc_type == "SUPPLIER_INVOICE":
        notify(db, "invoice", f"Invoice {doc.reference_no or doc.number} approved", f"{doc.party_name or ''} — ready for accounts posting",
               role_code="ACCOUNTS", entity_type="scanned_document", entity_id=doc.id)
    return doc


def delete_document(db: Session, user: User, doc: ScannedDocument) -> None:
    """Remove a wrong or unwanted upload with its files. Approved documents are the record of an approved invoice and
    stay; the deletion itself is kept in the audit trail."""
    if doc.status == "APPROVED":
        raise BusinessError(f"{doc.number} is approved and cannot be deleted", status_code=409, code="state")
    audit(db, user, "document.delete", "scanned_document", doc.id,
          {"number": doc.number, "type": doc.doc_type, "status": doc.status, "reference": doc.reference_no,
           "party": doc.party_name, "total": doc.total, "file": doc.title})
    db.delete(doc)
    db.flush()


# ------------------------------------------------------------------ validation
def _refresh(db: Session, doc: ScannedDocument) -> None:
    """Copy key fields out of ``data`` and re-run the checks."""
    data = doc.data or empty_data(doc.doc_type)
    h = {k: v.get("value", "") for k, v in data["header"].items()}
    party, gstin, ref, dt, total = KEYS[doc.doc_type]
    doc.party_name = (h.get(party) or None) if party else None
    doc.party_gstin = (h.get(gstin) or "").upper().replace(" ", "")[:15] or None if gstin else None
    doc.reference_no = (h.get(ref) or "")[:64] or None
    doc.document_date = parse_date(h.get(dt)) if dt else None
    doc.total = num(h.get(total)) if total else None
    doc.checks = validate(db, doc)


def _check(code: str, status: str, message: str, field: str | None = None) -> dict:
    return {"code": code, "status": status, "message": message, "field": field}


def _close(a: Decimal, b: Decimal, tolerance: Decimal = Decimal("1")) -> bool:
    return abs(a - b) <= max(tolerance, abs(b) * Decimal("0.005"))


def _find_po(db: Session, po_number: str) -> PurchaseOrder | None:
    po_number = po_number.strip()
    if not po_number:
        return None
    po = db.scalar(select(PurchaseOrder).where(func.upper(PurchaseOrder.number) == po_number.upper()))
    if po is None and po_number.isdigit():  # "12" matches PO-00012
        po = next((p for p in db.scalars(select(PurchaseOrder).where(PurchaseOrder.number.like(f"%{int(po_number)}")))
                   if re.sub(r"\D", "", p.number).lstrip("0") == po_number.lstrip("0")), None)
    return po


def _find_supplier(db: Session, name: str, gstin: str) -> Supplier | None:
    if gstin:
        s = db.scalar(select(Supplier).where(func.upper(Supplier.gstin) == gstin.upper()))
        if s:
            return s
    norm = normalize_name(name or "")
    if not norm:
        return None
    best, score = None, 0.0
    for s in db.scalars(select(Supplier)):
        r = difflib.SequenceMatcher(None, norm, normalize_name(s.name)).ratio()
        if r > score:
            best, score = s, r
    return best if score >= 0.85 else None


def _match_item(lines: list, line: dict):
    """PO line for an invoice line: same item code, else the closest item name."""
    code = (line.get("item_code") or "").strip().upper()
    if code:
        for pl in lines:
            if pl.item.item_code.upper() == code:
                return pl
    desc = normalize_name(line.get("description") or "")
    best, score = None, 0.0
    for pl in lines:
        r = difflib.SequenceMatcher(None, desc, normalize_name(pl.item.name)).ratio()
        if r > score:
            best, score = pl, r
    return best if score >= 0.6 else None


def validate(db: Session, doc: ScannedDocument) -> list[dict]:
    data = doc.data or empty_data(doc.doc_type)
    h = {k: v.get("value", "") for k, v in data["header"].items()}
    lines = data.get("lines") or []
    spec = _spec(doc.doc_type)
    checks: list[dict] = []
    labels = dict(spec.header)

    if data.get("detected_document_type") and not data.get("document_type_matches", True):
        checks.append(_check("doc_type", "warn", f"This looks like a {data['detected_document_type']}, not a {spec.label.lower()}"))
    low = [k for k, f in data["header"].items() if f.get("value") and not f.get("edited") and f.get("confidence", 0) < LOW_CONFIDENCE]
    for k in low:
        checks.append(_check("low_confidence", "warn", f"{labels.get(k, k)} was hard to read — check it against the document", k))
    for i, line in enumerate(lines, start=1):
        for f in line.get("uncertain_fields") or []:
            if not line.get("edited"):
                checks.append(_check("low_confidence", "warn", f"Line {i}: {f.replace('_', ' ')} was hard to read", f"lines.{i - 1}.{f}"))

    # Duplicate upload of the same files.
    same_file = db.scalar(select(ScannedDocument).where(ScannedDocument.sha256 == doc.sha256, ScannedDocument.id != doc.id,
                                                        ScannedDocument.status != "REJECTED"))
    if same_file:
        checks.append(_check("duplicate_file", "warn", f"The same file was already uploaded as {same_file.number}"))

    if doc.doc_type == "SUPPLIER_INVOICE":
        checks += _validate_invoice(db, doc, h, lines)
    elif doc.doc_type == "DELIVERY_CHALLAN":
        checks += _validate_challan(db, doc, h, lines)
    elif doc.doc_type == "PRODUCTION_REPORT":
        checks += _validate_production(db, lines)
    return checks


def _gstin_checks(h: dict, key: str, label: str) -> list[dict]:
    v = (h.get(key) or "").upper().replace(" ", "")
    if v and not GSTIN_RE.match(v):
        return [_check("gstin_format", "warn", f"{label} {v} is not a valid GSTIN format", key)]
    return []


def _duplicate_ref(db: Session, doc: ScannedDocument, ref: str, party_gstin: str | None, party: str | None, label: str) -> list[dict]:
    if not ref:
        return []
    stmt = select(ScannedDocument).where(ScannedDocument.doc_type == doc.doc_type, ScannedDocument.id != doc.id,
                                         ScannedDocument.status != "REJECTED", func.upper(ScannedDocument.reference_no) == ref.upper())
    for other in db.scalars(stmt):
        if (party_gstin and other.party_gstin == party_gstin) or normalize_name(other.party_name or "") == normalize_name(party or ""):
            return [_check("duplicate", "fail", f"{label} {ref} from this party is already recorded as {other.number} ({other.status.lower()})")]
    return [_check("duplicate", "pass", f"No other {label.lower()} {ref} from this party")]


def _validate_invoice(db: Session, doc: ScannedDocument, h: dict, lines: list[dict]) -> list[dict]:
    out: list[dict] = []
    for key, label in (("supplier_name", "Supplier name"), ("invoice_number", "Invoice number"), ("invoice_date", "Invoice date"),
                       ("grand_total", "Grand total")):
        if not h.get(key):
            out.append(_check("required", "fail", f"{label} is missing", key))
    inv_date = parse_date(h.get("invoice_date"))
    if h.get("invoice_date") and inv_date is None:
        out.append(_check("date", "fail", "Invoice date is not a valid date (YYYY-MM-DD)", "invoice_date"))
    elif inv_date and inv_date > date.today() + timedelta(days=1):
        out.append(_check("date", "warn", "Invoice date is in the future", "invoice_date"))
    elif inv_date and inv_date < date.today() - timedelta(days=365):
        out.append(_check("date", "warn", "Invoice is more than a year old", "invoice_date"))

    # Arithmetic: each line, the lines against the taxable value, and the grand total.
    line_taxable = Decimal(0)
    line_tax = Decimal(0)
    computed_tax_ok = True
    for i, l in enumerate(lines, start=1):
        q, rate, disc, taxable = num(l.get("quantity")), num(l.get("unit_price")), num(l.get("discount")) or Decimal(0), num(l.get("taxable_value"))
        if q is not None and rate is not None and taxable is not None and not _close(q * rate - disc, taxable):
            out.append(_check("line_math", "fail", f"Line {i}: {q.normalize():f} × {rate.normalize():f}"
                              f"{f' − {disc.normalize():f}' if disc else ''} = {(q * rate - disc):.2f}, but the line shows {taxable:.2f}",
                              f"lines.{i - 1}.taxable_value"))
        base = taxable if taxable is not None else (q * rate - disc if q is not None and rate is not None else None)
        if base is not None:
            line_taxable += base
            gst = num(l.get("gst_rate"))
            if gst is not None:
                line_tax += base * gst / 100
            else:
                computed_tax_ok = False
        else:
            computed_tax_ok = False
    taxable_hdr = num(h.get("taxable_value"))
    if lines and taxable_hdr is not None:
        if _close(line_taxable, taxable_hdr):
            out.append(_check("lines_total", "pass", f"Lines add up to the taxable value {taxable_hdr:.2f}"))
        else:
            out.append(_check("lines_total", "fail", f"Lines add up to {line_taxable:.2f}, but the taxable value is {taxable_hdr:.2f}", "taxable_value"))
    cgst, sgst, igst = (num(h.get(k)) or Decimal(0) for k in ("cgst_amount", "sgst_amount", "igst_amount"))
    other, round_off, grand = num(h.get("other_charges")) or Decimal(0), num(h.get("round_off")) or Decimal(0), num(h.get("grand_total"))
    base_total = taxable_hdr if taxable_hdr is not None else (line_taxable if lines else None)
    if base_total is not None and grand is not None:
        computed = base_total + cgst + sgst + igst + other + round_off
        if _close(computed, grand, Decimal("1.5")):
            out.append(_check("grand_total", "pass", f"Taxable + GST + charges = grand total {grand:.2f}"))
        else:
            out.append(_check("grand_total", "fail", f"Taxable {base_total:.2f} + GST {cgst + sgst + igst:.2f} + other {other + round_off:.2f} "
                              f"= {computed:.2f}, but the grand total is {grand:.2f}", "grand_total"))

    # GST: intra-state (CGST + SGST, equal halves) or inter-state (IGST), and tax matching the line rates.
    company_gstin = company_profile(db)["gstin"].upper()
    supplier_gstin = (h.get("supplier_gstin") or "").upper().replace(" ", "")
    out += _gstin_checks(h, "supplier_gstin", "Supplier GSTIN") + _gstin_checks(h, "buyer_gstin", "Buyer GSTIN")
    if not supplier_gstin:
        out.append(_check("gstin", "warn", "Supplier GSTIN not found — input tax credit needs it", "supplier_gstin"))
    buyer = (h.get("buyer_gstin") or "").upper().replace(" ", "")
    if buyer and company_gstin and buyer != company_gstin:
        out.append(_check("buyer_gstin", "warn", f"Billed to GSTIN {buyer}, not ours ({company_gstin})", "buyer_gstin"))
    if supplier_gstin[:2].isdigit() and company_gstin[:2].isdigit():
        intra = supplier_gstin[:2] == company_gstin[:2]
        if intra and igst > 0:
            out.append(_check("gst_type", "fail", "Supplier is in our state, so CGST + SGST is expected, not IGST", "igst_amount"))
        elif not intra and (cgst > 0 or sgst > 0):
            out.append(_check("gst_type", "fail", "Supplier is in another state, so IGST is expected, not CGST + SGST", "cgst_amount"))
        elif cgst + sgst + igst > 0:
            out.append(_check("gst_type", "pass", "Intra-state CGST + SGST" if intra else "Inter-state IGST"))
    if (cgst or sgst) and not _close(cgst, sgst, Decimal("0.5")):
        out.append(_check("gst_split", "fail", f"CGST {cgst:.2f} and SGST {sgst:.2f} should be equal", "sgst_amount"))
    if lines and computed_tax_ok and (cgst + sgst + igst) > 0:
        if _close(line_tax, cgst + sgst + igst, Decimal("1")):
            out.append(_check("gst_rate", "pass", f"GST {cgst + sgst + igst:.2f} matches the line rates"))
        else:
            out.append(_check("gst_rate", "warn", f"Line rates give GST {line_tax:.2f}, but the invoice charges {cgst + sgst + igst:.2f}"))

    # Supplier master, purchase order and goods receipt (3-way match).
    supplier = _find_supplier(db, h.get("supplier_name") or "", supplier_gstin)
    doc.supplier_id = supplier.id if supplier else None
    if supplier:
        out.append(_check("supplier", "pass", f"Supplier matched: {supplier.name} ({supplier.code})", "supplier_name"))
    else:
        out.append(_check("supplier", "warn", "Supplier not found in the supplier master — add it under Procurement", "supplier_name"))
    po = _find_po(db, h.get("po_number") or "")
    doc.purchase_order_id = po.id if po else None
    if not h.get("po_number"):
        out.append(_check("po", "warn", "No PO number on the invoice", "po_number"))
    elif po is None:
        out.append(_check("po", "warn", f"PO {h['po_number']} is not in this system", "po_number"))
    else:
        if po.status not in ("APPROVED", "CLOSED"):
            out.append(_check("po", "fail", f"{po.number} is {po.status.lower()}, not approved", "po_number"))
        else:
            out.append(_check("po", "pass", f"PO matched: {po.number} ({po.status.lower()})", "po_number"))
        if supplier and po.supplier_id != supplier.id:
            out.append(_check("po_supplier", "fail", f"{po.number} is with {po.supplier.name}, not {supplier.name}", "po_number"))
        for i, l in enumerate(lines, start=1):
            pl = _match_item(po.lines, l)
            q, rate = num(l.get("quantity")), num(l.get("unit_price"))
            if pl is None:
                out.append(_check("po_line", "fail", f"Line {i} ({l.get('description') or l.get('item_code')}) is not on {po.number}",
                                  f"lines.{i - 1}.description"))
                continue
            if q is not None and q > Decimal(pl.qty_received):
                out.append(_check("grn", "fail", f"Line {i}: invoiced {q.normalize():f} {pl.item.uom.code} of {pl.item.item_code}, but only "
                                  f"{Decimal(pl.qty_received).normalize():f} received (GRN) against {po.number}", f"lines.{i - 1}.quantity"))
            elif q is not None:
                out.append(_check("grn", "pass", f"Line {i}: {pl.item.item_code} quantity within goods received"))
            if rate is not None and Decimal(pl.unit_price) > 0 and not _close(rate, Decimal(pl.unit_price), Decimal("0.01")):
                out.append(_check("po_price", "warn", f"Line {i}: rate {rate:.2f} differs from the PO rate {Decimal(pl.unit_price):.2f}",
                                  f"lines.{i - 1}.unit_price"))
    out += _duplicate_ref(db, doc, h.get("invoice_number") or "", supplier_gstin or None, h.get("supplier_name"), "Invoice")
    return out


def _validate_challan(db: Session, doc: ScannedDocument, h: dict, lines: list[dict]) -> list[dict]:
    out: list[dict] = []
    for key, label in (("challan_number", "Challan number"), ("challan_date", "Challan date")):
        if not h.get(key):
            out.append(_check("required", "fail", f"{label} is missing", key))
    out += _gstin_checks(h, "consignor_gstin", "Consignor GSTIN") + _gstin_checks(h, "consignee_gstin", "Consignee GSTIN")
    total = Decimal(0)
    for i, l in enumerate(lines, start=1):
        q, rate, value = num(l.get("quantity")), num(l.get("rate")), num(l.get("value"))
        if q is not None and rate is not None and value is not None and not _close(q * rate, value):
            out.append(_check("line_math", "fail", f"Line {i}: {q.normalize():f} × {rate.normalize():f} = {q * rate:.2f}, not {value:.2f}",
                              f"lines.{i - 1}.value"))
        total += value or Decimal(0)
    hdr_total = num(h.get("total_value"))
    if lines and hdr_total is not None and total and not _close(total, hdr_total):
        out.append(_check("total", "fail", f"Lines add up to {total:.2f}, but the total is {hdr_total:.2f}", "total_value"))
    if h.get("po_number"):
        po = _find_po(db, h["po_number"])
        doc.purchase_order_id = po.id if po else None
        out.append(_check("po", "pass", f"PO matched: {po.number}") if po else _check("po", "warn", f"PO {h['po_number']} is not in this system", "po_number"))
    out += _duplicate_ref(db, doc, h.get("challan_number") or "", (h.get("consignor_gstin") or "").upper() or None, h.get("consignor_name"), "Challan")
    return out


def _validate_production(db: Session, lines: list[dict]) -> list[dict]:
    out: list[dict] = []
    if not lines:
        return [_check("lines", "warn", "No production lines were read")]
    for i, l in enumerate(lines, start=1):
        job = (l.get("job_no") or "").strip()
        wo = db.scalar(select(WorkOrder).where(func.upper(WorkOrder.number) == job.upper())) if job else None
        item = db.scalar(select(Item).where(func.upper(Item.item_code) == (l.get("item_no") or "").strip().upper())) if l.get("item_no") else None
        if not item and l.get("item_no"):
            out.append(_check("item", "warn", f"Line {i}: item {l['item_no']} is not in the item master", f"lines.{i - 1}.item_no"))
        if wo is None:
            if job:
                out.append(_check("job", "warn", f"Line {i}: job {job} is not a work order in this system", f"lines.{i - 1}.job_no"))
            continue
        if item and wo.item_id != item.id:
            out.append(_check("job_item", "fail", f"Line {i}: {wo.number} makes {wo.item.item_code}, not {item.item_code}", f"lines.{i - 1}.item_no"))
        done = num(l.get("quantity_completed"))
        if done is not None and done != Decimal(wo.qty_completed):
            out.append(_check("job_qty", "warn", f"Line {i}: report says {done.normalize():f} completed on {wo.number}; the system has "
                              f"{Decimal(wo.qty_completed).normalize():f}", f"lines.{i - 1}.quantity_completed"))
        else:
            out.append(_check("job", "pass", f"Line {i}: {wo.number} matches"))
    return out
