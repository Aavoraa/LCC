"""Load the sample (demo) data on a fresh system from the web app, in steps small enough for a serverless request.

Steps, in order: ``base`` (roles, locations, demo users with a password the administrator chooses, suppliers,
customers), ``catalog`` (called repeatedly; adds the 1,000-product catalogue in batches), ``machines`` (card service
machines and their SOP spare lists) and ``activity`` (purchases, sales, production, job-work challans, counts and
scanned documents). Refused once real transactions exist, so it can never mix demo rows into live data.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_permission
from ..models import Item, Machine, PurchaseOrder, SalesOrder, StockMovement, User
from ..services.common import BusinessError, audit

router = APIRouter(prefix="/api/admin/sample-data", tags=["admin"])
ADMIN = require_permission("users.manage")
TARGET_ITEMS = 1000
BATCH = 120


def _count(db: Session, model) -> int:
    return db.scalar(select(func.count()).select_from(model)) or 0


def status(db: Session) -> dict:
    items, pos = _count(db, Item), _count(db, PurchaseOrder)
    return {
        "items": items, "purchase_orders": pos, "sales_orders": _count(db, SalesOrder), "machines": _count(db, Machine),
        "stock_movements": _count(db, StockMovement),
        "demo_users": db.scalar(select(func.count()).select_from(User).where(User.username.in_(("stores", "manager", "production")))) or 0,
        "target_items": TARGET_ITEMS, "can_load": pos == 0,
    }


@router.get("")
def get_status(db: Session = Depends(get_db), _: User = Depends(ADMIN)):
    return status(db)


class RunIn(BaseModel):
    step: Literal["base", "catalog", "machines", "activity"]
    password: str | None = Field(default=None, min_length=10, max_length=128)


@router.post("")
def run_step(body: RunIn, db: Session = Depends(get_db), user: User = Depends(ADMIN)):
    if _count(db, PurchaseOrder):
        raise BusinessError("This system already has purchase orders, so sample data is not loaded (it only goes into a fresh system)",
                            status_code=409, code="state")
    done: dict = {}
    if body.step == "base":
        from ..seed import seed_demo, seed_reference

        if not body.password:
            raise BusinessError("Choose a password (10+ characters) for the demo users")
        seed_reference(db)
        seed_demo(db, body.password)
        audit(db, user, "sample_data.base", "system", None, {"demo_users": True})
        db.commit()
    elif body.step == "catalog":
        from ..demo_catalog import add_items

        stores = db.scalar(select(User).where(User.username == "stores"))
        if stores is None:
            raise BusinessError("Load the demo users first")
        done["added"] = add_items(db, stores, TARGET_ITEMS, limit=BATCH)
    elif body.step == "machines":
        from ..machine_catalog import load
        from ..services.machines import align_machine

        stores = db.scalar(select(User).where(User.username == "stores"))
        if stores is None:
            raise BusinessError("Load the demo users first")
        done = load(db, stores)
        for m in db.scalars(select(Machine).order_by(Machine.code)):
            align_machine(db, stores, m, create_missing=True)
        db.commit()
    else:
        from ..demo_activity import run

        try:
            done = run(db)
        except RuntimeError as e:
            db.rollback()
            raise BusinessError(str(e), status_code=409, code="state") from e
        audit(db, user, "sample_data.activity", "system", None, done)
        db.commit()
    return {"step": body.step, "result": done, "status": status(db)}
