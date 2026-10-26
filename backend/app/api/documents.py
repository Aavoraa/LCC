"""Invoice scanner & AI extraction: upload / camera capture, extraction, review, validation, approval."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, noload

from ..db import get_db
from ..deps import require_permission
from ..models import DocumentPage, ScannedDocument, User
from ..services import documents as svc
from ..services.extraction import get_provider
from .machines import _jsonable

router = APIRouter(prefix="/api/documents", tags=["documents"])
VIEW = require_permission("stock.view")
UPLOAD = require_permission("purchase.manage", "stock.receive", "production.manage", "imports.create")
APPROVE = require_permission("purchase.approve", "imports.approve")


def _doc(db: Session, doc_id: int) -> ScannedDocument:
    doc = db.get(ScannedDocument, doc_id)
    if doc is None:
        raise HTTPException(404, "Document not found")
    return doc


def _users(db: Session, *ids: int | None) -> dict[int, str]:
    wanted = {i for i in ids if i}
    return {u.id: u.full_name for u in db.scalars(select(User).where(User.id.in_(wanted)))} if wanted else {}


def brief(d: ScannedDocument, users: dict[int, str]) -> dict:
    checks = d.checks or []
    return {
        "id": d.id, "number": d.number, "doc_type": d.doc_type, "doc_type_label": svc.SPECS[d.doc_type].label, "status": d.status,
        "title": d.title, "page_count": d.page_count, "party_name": d.party_name, "party_gstin": d.party_gstin,
        "reference_no": d.reference_no, "document_date": d.document_date, "total": d.total,
        "failed": sum(1 for c in checks if c["status"] == "fail"), "warnings": sum(1 for c in checks if c["status"] == "warn"),
        "created_by": users.get(d.created_by_id), "created_at": d.created_at, "reviewed_by": users.get(d.reviewed_by_id), "reviewed_at": d.reviewed_at,
    }


def detail(db: Session, d: ScannedDocument) -> dict:
    users = _users(db, d.created_by_id, d.reviewed_by_id)
    pages = db.execute(select(DocumentPage.page_no, DocumentPage.filename, DocumentPage.content_type, DocumentPage.size)
                       .where(DocumentPage.document_id == d.id).order_by(DocumentPage.page_no)).all()
    return _jsonable({
        **brief(d, users), "data": d.data or svc.empty_data(d.doc_type), "checks": d.checks or [], "notes": d.notes,
        "provider": d.provider, "model": d.model, "extracted_at": d.extracted_at, "extraction_error": d.extraction_error,
        "created_by_id": d.created_by_id, "decision_note": d.decision_note, "supplier_id": d.supplier_id, "purchase_order_id": d.purchase_order_id,
        "pages": [{"page_no": n, "filename": f, "content_type": c, "size": s} for n, f, c, s in pages],
    })


@router.get("/config")
def config(_: User = Depends(VIEW)):
    """Document types with their fields, upload limits and whether AI extraction is set up on the server."""
    p = get_provider()
    return {
        "provider": p.name, "model": p.model, "configured": bool(p.configured),
        "max_image_mb": svc.MAX_IMAGE_BYTES // (1024 * 1024), "max_pdf_mb": svc.MAX_FILE_BYTES // (1024 * 1024), "max_files": svc.MAX_FILES,
        "low_confidence": svc.LOW_CONFIDENCE,
        "doc_types": [{"code": s.code, "label": s.label, "header": [{"key": k, "label": l} for k, l in s.header],
                       "lines": [{"key": k, "label": l} for k, l in s.lines]} for s in svc.SPECS.values()],
    }


@router.get("")
def list_documents(doc_type: str | None = None, status: str | None = None, q: str | None = None,
                   db: Session = Depends(get_db), _: User = Depends(VIEW)):
    stmt = select(ScannedDocument).options(noload(ScannedDocument.pages))
    if doc_type:
        stmt = stmt.where(ScannedDocument.doc_type == doc_type)
    if status:
        stmt = stmt.where(ScannedDocument.status.in_([s.strip().upper() for s in status.split(",")]))
    if q and q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(ScannedDocument.number.ilike(like), ScannedDocument.reference_no.ilike(like),
                              ScannedDocument.party_name.ilike(like), ScannedDocument.title.ilike(like)))
    rows = db.scalars(stmt.order_by(ScannedDocument.id.desc()).limit(300)).all()
    users = _users(db, *{r.created_by_id for r in rows}, *{r.reviewed_by_id for r in rows})
    return _jsonable([brief(r, users) for r in rows])


@router.post("", status_code=201)
async def upload(doc_type: str = Form(...), files: list[UploadFile] = File(...), notes: str | None = Form(None),
                 extract: bool = Form(True), db: Session = Depends(get_db), user: User = Depends(UPLOAD)):
    """Store the files privately, then (by default) extract the fields straight away. A failed extraction still keeps
    the document so it can be re-run or entered by hand."""
    payload = []
    for f in files:
        content = await f.read(svc.MAX_FILE_BYTES + 1)
        payload.append((f.filename or "document", (f.content_type or "").split(";")[0].strip().lower(), content))
    doc = svc.create_document(db, user, doc_type, payload, notes)
    if extract:
        svc.run_extraction(db, user, doc)
    else:
        doc.data = svc.empty_data(doc_type)
        svc._refresh(db, doc)
    db.commit()
    return detail(db, doc)


@router.get("/{doc_id}")
def get_document(doc_id: int, db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return detail(db, _doc(db, doc_id))


@router.delete("/{doc_id}", status_code=204)
def delete_document(doc_id: int, db: Session = Depends(get_db), user: User = Depends(UPLOAD)):
    svc.delete_document(db, user, _doc(db, doc_id))
    db.commit()
    return Response(status_code=204)


@router.get("/{doc_id}/pages/{page_no}")
def page_file(doc_id: int, page_no: int, db: Session = Depends(get_db), _: User = Depends(VIEW)):
    page = db.scalar(select(DocumentPage).where(DocumentPage.document_id == doc_id, DocumentPage.page_no == page_no))
    if page is None:
        raise HTTPException(404, "Page not found")
    return Response(page.content, media_type=page.content_type,
                    headers={"Content-Disposition": f'inline; filename="{page.filename}"', "Cache-Control": "private, max-age=3600"})


@router.post("/{doc_id}/extract")
def extract(doc_id: int, db: Session = Depends(get_db), user: User = Depends(UPLOAD)):
    doc = svc.run_extraction(db, user, _doc(db, doc_id))
    db.commit()
    return detail(db, doc)


class DataIn(BaseModel):
    header: dict[str, str] = Field(default_factory=dict)
    lines: list[dict[str, str]] = Field(default_factory=list, max_length=500)
    notes: str | None = Field(default=None, max_length=2000)


@router.put("/{doc_id}/data")
def save(doc_id: int, body: DataIn, db: Session = Depends(get_db), user: User = Depends(UPLOAD)):
    doc = svc.save_data(db, user, _doc(db, doc_id), body.header, body.lines, body.notes)
    db.commit()
    return detail(db, doc)


class DecisionIn(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=1000)
    override: bool = False


@router.post("/{doc_id}/decision")
def decision(doc_id: int, body: DecisionIn, db: Session = Depends(get_db), user: User = Depends(APPROVE)):
    doc = svc.decide(db, user, _doc(db, doc_id), body.approve, body.note, body.override)
    db.commit()
    return detail(db, doc)

