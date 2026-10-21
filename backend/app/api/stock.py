from __future__ import annotations

from datetime import date, datetime, time, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from .. import schemas
from ..db import get_db
from ..deps import current_user, require_permission
from ..models import ApprovalStatus, Item, MovementType, StockAdjustmentRequest, StockBalance, StockMovement, User
from ..services.common import BusinessError
from ..services.stock import MovementInput, decide_adjustment, post_movement, reconcile, request_adjustment
from .serializers import adjustment_out, movement_out, totals

router = APIRouter(prefix="/api/stock", tags=["stock"])


def _post_one(db: Session, user: User, body: schemas.MovementIn) -> schemas.MovementResult:
    """Post with retry on optimistic-lock conflicts and idempotent handling of racing duplicate submissions."""
    for attempt in range(3):
        try:
            movement, created = post_movement(db, user, MovementInput(**body.model_dump()))
            db.commit()
            break
        except StaleDataError:
            db.rollback()
            if attempt == 2:
                raise BusinessError("Stock changed concurrently — please retry", status_code=409, code="concurrent_update")
        except IntegrityError:
            db.rollback()
            existing = db.scalar(select(StockMovement).where(StockMovement.txn_uuid == body.txn_uuid))
            if existing is None:
                raise
            movement, created = existing, False
            break
        except BusinessError:
            db.rollback()
            raise
    item = db.get(Item, movement.item_id)
    return schemas.MovementResult(movement=movement_out(movement), created=created, totals=totals(db, item))


@router.post("/movements", response_model=schemas.MovementResult)
def create_movement(body: schemas.MovementIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    # Per-type permission is enforced inside the ledger service.
    return _post_one(db, user, body)


@router.post("/movements/sync")
def sync_movements(bodies: list[schemas.MovementIn], db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Offline queue upload. Each entry is processed independently and idempotently by txn_uuid."""
    if len(bodies) > 200:
        raise HTTPException(413, "Sync at most 200 transactions per request")
    results = []
    for body in bodies:
        try:
            r = _post_one(db, user, body)
            results.append({"txn_uuid": body.txn_uuid, "status": "CONFIRMED" if r.created else "ALREADY_CONFIRMED",
                            "movement": r.movement.model_dump(mode="json"), "totals": {k: str(v) for k, v in r.totals.items()}})
        except BusinessError as e:
            results.append({"txn_uuid": body.txn_uuid, "status": "REJECTED", "error": e.message, "code": e.code})
    return {"results": results}


@router.get("/movements", response_model=dict)
def list_movements(
    item_id: int | None = None,
    movement_type: MovementType | None = None,
    ref_doc_no: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("stock.view")),
):
    stmt = select(StockMovement)
    if item_id:
        stmt = stmt.where(StockMovement.item_id == item_id)
    if movement_type:
        stmt = stmt.where(StockMovement.movement_type == movement_type)
    if ref_doc_no:
        stmt = stmt.where(StockMovement.ref_doc_no.ilike(f"%{ref_doc_no}%"))
    if date_from:
        stmt = stmt.where(StockMovement.created_at >= datetime.combine(date_from, time.min, tzinfo=timezone.utc))
    if date_to:
        stmt = stmt.where(StockMovement.created_at <= datetime.combine(date_to, time.max, tzinfo=timezone.utc))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(StockMovement.id.desc()).offset((page - 1) * page_size).limit(page_size))
    return {"movements": [movement_out(m).model_dump(mode="json") for m in rows], "total": total, "page": page}


@router.get("/balances")
def list_balances(qc_only: bool = False, item_id: int | None = None, db: Session = Depends(get_db),
                  _: User = Depends(require_permission("stock.view"))):
    stmt = select(StockBalance).order_by(StockBalance.item_id, StockBalance.location_id)
    if qc_only:
        stmt = stmt.where(StockBalance.qty_qc_hold > 0)
    if item_id:
        stmt = stmt.where(StockBalance.item_id == item_id)
    out = []
    for b in db.scalars(stmt.limit(1000)):
        item = db.get(Item, b.item_id)
        out.append({"item_id": item.id, "item_code": item.item_code, "item_name": item.name, "uom": item.uom.code,
                    "location_id": b.location_id, "location": b.location.code, "qty_on_hand": str(b.qty_on_hand),
                    "qty_reserved": str(b.qty_reserved), "qty_qc_hold": str(b.qty_qc_hold), "qty_available": str(b.qty_available),
                    "updated_at": b.updated_at})
    return out


@router.get("/reconcile")
def reconcile_ledger(db: Session = Depends(get_db), _: User = Depends(require_permission("stock.view"))):
    issues = reconcile(db)
    return {"balanced": not issues, "mismatches": issues}


# --------------------------------------------------------------- adjustments
@router.post("/adjustments", response_model=schemas.AdjustmentOut, status_code=201)
def create_adjustment(body: schemas.AdjustmentIn, db: Session = Depends(get_db), user: User = Depends(require_permission("stock.adjust.request"))):
    req = request_adjustment(db, user, body.item_id, body.location_id, body.qty_delta, body.reason)
    db.commit()
    return adjustment_out(req)


@router.get("/adjustments", response_model=list[schemas.AdjustmentOut])
def list_adjustments(status: ApprovalStatus | None = None, db: Session = Depends(get_db),
                     _: User = Depends(require_permission("stock.view"))):
    stmt = select(StockAdjustmentRequest).order_by(StockAdjustmentRequest.id.desc()).limit(200)
    if status:
        stmt = stmt.where(StockAdjustmentRequest.status == status)
    return [adjustment_out(r) for r in db.scalars(stmt)]


@router.post("/adjustments/{req_id}/decision", response_model=schemas.AdjustmentOut)
def decide(req_id: int, body: schemas.DecisionIn, db: Session = Depends(get_db), user: User = Depends(require_permission("stock.adjust.approve"))):
    req = db.get(StockAdjustmentRequest, req_id)
    if req is None:
        raise HTTPException(404, "Adjustment request not found")
    try:
        decide_adjustment(db, user, req, body.approve, body.note)
        db.commit()
    except BusinessError:
        db.rollback()
        raise
    return adjustment_out(req)
