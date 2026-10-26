from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import require_permission
from ..models import Customer, Holiday, ItemCategory, Location, Setting, Supplier, Uom, User, Warehouse
from ..services.common import audit, next_number

router = APIRouter(prefix="/api/masters", tags=["masters"])
VIEW = require_permission("masters.view")
MANAGE = require_permission("masters.manage")


@router.get("/uoms", response_model=list[schemas.UomOut])
def uoms(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return db.scalars(select(Uom).order_by(Uom.code)).all()


@router.get("/categories", response_model=list[schemas.CategoryOut])
def categories(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return db.scalars(select(ItemCategory).order_by(ItemCategory.name)).all()


@router.post("/categories", response_model=schemas.CategoryOut, status_code=201)
def create_category(body: schemas.CategoryIn, db: Session = Depends(get_db), user: User = Depends(require_permission("masters.manage", "items.create"))):
    if db.scalar(select(ItemCategory).where(ItemCategory.name == body.name, ItemCategory.parent_id == body.parent_id)):
        raise HTTPException(409, "Category already exists")
    cat = ItemCategory(name=body.name.strip(), parent_id=body.parent_id)
    db.add(cat)
    db.flush()
    audit(db, user, "category.create", "category", cat.id, body.model_dump())
    db.commit()
    return cat


@router.get("/warehouses", response_model=list[schemas.WarehouseOut])
def warehouses(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return db.scalars(select(Warehouse).order_by(Warehouse.code)).all()


@router.get("/locations", response_model=list[schemas.LocationOut])
def locations(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return db.scalars(select(Location).where(Location.is_active.is_(True)).order_by(Location.code)).all()


@router.post("/locations", response_model=schemas.LocationOut, status_code=201)
def create_location(body: schemas.LocationIn, db: Session = Depends(get_db), user: User = Depends(MANAGE)):
    wh = db.get(Warehouse, body.warehouse_id)
    if wh is None:
        raise HTTPException(404, "Warehouse not found")
    code = f"{wh.code}-{body.rack.upper()}-{body.bin.upper()}"
    if db.scalar(select(Location).where(Location.code == code)):
        raise HTTPException(409, f"Location {code} already exists")
    loc = Location(code=code, warehouse_id=wh.id, rack=body.rack.upper(), bin=body.bin.upper())
    db.add(loc)
    db.flush()
    audit(db, user, "location.create", "location", loc.id, {"code": code})
    db.commit()
    return loc


@router.get("/suppliers", response_model=list[schemas.SupplierOut])
def suppliers(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return db.scalars(select(Supplier).order_by(Supplier.name)).all()


@router.post("/suppliers", response_model=schemas.SupplierOut, status_code=201)
def create_supplier(body: schemas.SupplierIn, db: Session = Depends(get_db), user: User = Depends(MANAGE)):
    if body.gstin and db.scalar(select(Supplier).where(Supplier.gstin == body.gstin)):
        raise HTTPException(409, "A supplier with this GSTIN already exists")
    sup = Supplier(code=next_number(db, "supplier", "SUP-", 4), **body.model_dump())
    db.add(sup)
    db.flush()
    audit(db, user, "supplier.create", "supplier", sup.id, body.model_dump())
    db.commit()
    return sup


@router.get("/customers", response_model=list[schemas.CustomerOut])
def customers(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return db.scalars(select(Customer).order_by(Customer.name)).all()


@router.post("/customers", response_model=schemas.CustomerOut, status_code=201)
def create_customer(body: schemas.CustomerIn, db: Session = Depends(get_db),
                    user: User = Depends(require_permission("masters.manage", "sales.enquiry"))):
    cust = Customer(code=next_number(db, "customer", "CUS-", 4), **body.model_dump())
    db.add(cust)
    db.flush()
    audit(db, user, "customer.create", "customer", cust.id, body.model_dump())
    db.commit()
    return cust


class HolidayIn(BaseModel):
    day: date
    name: str = Field(min_length=2)


@router.get("/holidays")
def holidays(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return [{"id": h.id, "day": h.day, "name": h.name} for h in db.scalars(select(Holiday).order_by(Holiday.day))]


@router.post("/holidays", status_code=201)
def create_holiday(body: HolidayIn, db: Session = Depends(get_db), user: User = Depends(MANAGE)):
    if db.scalar(select(Holiday).where(Holiday.day == body.day)):
        raise HTTPException(409, "Holiday already configured for that date")
    h = Holiday(day=body.day, name=body.name)
    db.add(h)
    audit(db, user, "holiday.create", "holiday", None, body.model_dump())
    db.commit()
    return {"id": h.id, "day": h.day, "name": h.name}


@router.get("/settings")
def list_settings(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return [{"key": s.key, "value": s.value, "description": s.description}
            for s in db.scalars(select(Setting).where(Setting.key.not_like("company.%")).order_by(Setting.key))]


@router.get("/company")
def get_company(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    """Company / unit profile printed on challans; ``fields`` gives each field's label."""
    from ..services.company import COMPANY_FIELDS, company_profile

    return {"profile": company_profile(db), "fields": {k: label for k, (_, label) in COMPANY_FIELDS.items()}}


@router.put("/company")
def update_company(body: dict[str, str], db: Session = Depends(get_db), user: User = Depends(require_permission("users.manage"))):
    from ..services.company import update_company_profile

    update_company_profile(db, user, body)
    db.commit()
    return get_company(db, user)


class SettingIn(BaseModel):
    value: str = Field(min_length=1, max_length=255)


@router.put("/settings/{key}")
def update_setting(key: str, body: SettingIn, db: Session = Depends(get_db), user: User = Depends(require_permission("users.manage"))):
    s = db.get(Setting, key)
    if s is None or key.startswith("company."):
        raise HTTPException(404, "Unknown setting")
    try:
        float(body.value)
    except ValueError:
        raise HTTPException(422, "Setting values must be numeric")
    audit(db, user, "setting.update", "setting", key, {"before": s.value, "after": body.value})
    s.value = body.value
    db.commit()
    return {"key": s.key, "value": s.value, "description": s.description}
