"""Manufacturing route (process steps) and make-time estimate for a made item."""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_permission
from ..models import Item, ItemType, ProcessStep, User
from ..services import process

router = APIRouter(prefix="/api/items", tags=["process"])


class StepIn(BaseModel):
    operation: str = Field(min_length=2, max_length=120)
    work_center: str | None = Field(default=None, max_length=80)
    mode: str = Field(pattern="^(IN_HOUSE|OUTSIDE)$")
    setup_min: Decimal = Field(default=Decimal(0), ge=0, le=100000)
    run_min: Decimal = Field(default=Decimal(0), ge=0, le=100000)
    outside_days: int = Field(default=0, ge=0, le=180)
    supplier_id: int | None = None
    notes: str | None = Field(default=None, max_length=500)


class RouteIn(BaseModel):
    steps: list[StepIn] = Field(max_length=40)


def _item(db: Session, item_id: int) -> Item:
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "Item not found")
    return item


def _step_out(s: ProcessStep) -> dict:
    return {"id": s.id, "seq": s.seq, "operation": s.operation, "work_center": s.work_center, "mode": s.mode,
            "setup_min": s.setup_min, "run_min": s.run_min, "outside_days": s.outside_days,
            "supplier": {"id": s.supplier.id, "name": s.supplier.name} if s.supplier else None, "notes": s.notes}


def route_out(db: Session, item: Item, qty: Decimal | None = None) -> dict:
    steps = process.steps_of(db, item.id)
    batch = process.batch_qty(item)
    return {
        "item_id": item.id, "applicable": item.item_type in (ItemType.PROCESSED_SPARE, ItemType.FINISHED_GOOD),
        "standard_route": process.standard_route_key(item), "batch_qty": batch,
        "production_lead_days": item.production_lead_days,
        "steps": [_step_out(s) for s in steps],
        "estimate": process.estimate(db, steps, qty if qty and qty > 0 else batch) if steps else None,
    }


@router.get("/{item_id}/process")
def get_route(item_id: int, qty: Decimal | None = Query(None, gt=0, le=1000000), db: Session = Depends(get_db),
              _: User = Depends(require_permission("items.view"))):
    return route_out(db, _item(db, item_id), qty)


@router.put("/{item_id}/process")
def put_route(item_id: int, body: RouteIn, db: Session = Depends(get_db), user: User = Depends(require_permission("items.edit"))):
    item = _item(db, item_id)
    process.replace_steps(db, user, item, [s.model_dump() for s in body.steps])
    db.commit()
    return route_out(db, item)


@router.post("/{item_id}/process/standard")
def standard_route(item_id: int, db: Session = Depends(get_db), user: User = Depends(require_permission("items.edit"))):
    item = _item(db, item_id)
    process.apply_standard(db, user, item)
    db.commit()
    return route_out(db, item)
