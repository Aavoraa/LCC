from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import require_permission
from ..models import ImportBatch, ImportRow, User
from ..services.common import BusinessError
from ..services.imports import FIELDS, approve_batch, create_batch, resolve_row, validate_batch

router = APIRouter(prefix="/api/imports", tags=["imports"])
MAX_BYTES = 10 * 1024 * 1024


def batch_out(b: ImportBatch, with_rows: bool = False) -> schemas.ImportBatchOut:
    return schemas.ImportBatchOut(
        id=b.id, number=b.number, filename=b.filename, status=b.status, headers=b.headers, mapping=b.mapping, summary=b.summary,
        uploaded_by=b.uploaded_by.full_name, uploaded_by_id=b.uploaded_by_id, created_at=b.created_at,
        fields={k: {"label": v["label"], "required": v.get("required", False)} for k, v in FIELDS.items()},
        rows=[schemas.ImportRowOut.model_validate(r) for r in b.rows] if with_rows else None,
    )


def _batch(db: Session, batch_id: int) -> ImportBatch:
    b = db.get(ImportBatch, batch_id)
    if b is None:
        raise HTTPException(404, "Import batch not found")
    return b


@router.get("", response_model=list[schemas.ImportBatchOut])
def list_batches(db: Session = Depends(get_db), _: User = Depends(require_permission("imports.create", "imports.approve"))):
    return [batch_out(b) for b in db.scalars(select(ImportBatch).order_by(ImportBatch.id.desc()).limit(100))]


@router.post("", response_model=schemas.ImportBatchOut, status_code=201)
async def upload(file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(require_permission("imports.create"))):
    content = await file.read()
    if len(content) > MAX_BYTES:
        raise HTTPException(413, "File exceeds 10 MB")
    batch = create_batch(db, user, file.filename or "upload.csv", content)
    db.commit()
    return batch_out(batch, with_rows=True)


@router.get("/{batch_id}", response_model=schemas.ImportBatchOut)
def get_batch(batch_id: int, db: Session = Depends(get_db), _: User = Depends(require_permission("imports.create", "imports.approve"))):
    return batch_out(_batch(db, batch_id), with_rows=True)


@router.post("/{batch_id}/validate", response_model=schemas.ImportBatchOut)
def validate(batch_id: int, body: schemas.MappingIn, db: Session = Depends(get_db), user: User = Depends(require_permission("imports.create"))):
    batch = validate_batch(db, user, _batch(db, batch_id), {k: v for k, v in body.mapping.items() if v})
    db.commit()
    return batch_out(batch, with_rows=True)


@router.post("/{batch_id}/rows/{row_id}/resolve", response_model=schemas.ImportRowOut)
def resolve(batch_id: int, row_id: int, body: schemas.ResolveRowIn, db: Session = Depends(get_db),
            user: User = Depends(require_permission("imports.create", "imports.approve"))):
    row = db.get(ImportRow, row_id)
    if row is None or row.batch_id != batch_id:
        raise HTTPException(404, "Row not found")
    resolve_row(db, user, row, body.resolution, body.link_item_id)
    db.commit()
    return row


@router.post("/{batch_id}/approve", response_model=schemas.ImportBatchOut)
def approve(batch_id: int, db: Session = Depends(get_db), user: User = Depends(require_permission("imports.approve"))):
    try:
        batch = approve_batch(db, user, _batch(db, batch_id))
        db.commit()
    except BusinessError:
        db.rollback()
        raise
    return batch_out(batch, with_rows=True)


@router.post("/{batch_id}/reject", response_model=schemas.ImportBatchOut)
def reject(batch_id: int, db: Session = Depends(get_db), user: User = Depends(require_permission("imports.approve"))):
    batch = _batch(db, batch_id)
    if batch.status not in ("UPLOADED", "VALIDATED"):
        raise BusinessError("Batch can no longer be rejected", status_code=409, code="state")
    batch.status = "REJECTED"
    from ..services.common import audit

    audit(db, user, "import.reject", "import_batch", batch.id)
    db.commit()
    return batch_out(batch)
