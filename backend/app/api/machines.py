from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_permission
from ..models import Item, Machine, MachineSpare, User
from ..services.common import BusinessError, audit, normalize_name
from ..services.machines import align_machine, create_store_item, link, raise_requisitions, store_check, suggestions

router = APIRouter(prefix="/api/machines", tags=["machines"])
VIEW = require_permission("items.view")
MANAGE = require_permission("machines.manage")
GROUPS = ("WEAR", "TOOLING", "MECHANICAL", "ELECTRICAL", "PNEUMATIC", "INSPECTION", "CONSUMABLE", "FASTENER", "FABRICATION")


def _d(v) -> str | None:
    return None if v is None else format(Decimal(v).normalize(), "f")


def _jsonable(obj):
    if isinstance(obj, Decimal):
        return _d(obj)
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_jsonable(v) for v in obj]
    return obj


def _machine(db: Session, machine_id: int) -> Machine:
    m = db.get(Machine, machine_id)
    if m is None:
        raise HTTPException(404, "Machine not found")
    return m


def _spare(db: Session, spare_id: int) -> MachineSpare:
    s = db.get(MachineSpare, spare_id)
    if s is None:
        raise HTTPException(404, "Spare line not found")
    return s


def spare_out(db: Session, s: MachineSpare, with_suggestions: bool = False) -> dict:
    out = {
        "id": s.id, "line_no": s.line_no, "part_no": s.part_no, "name": s.name, "group": s.group, "criticality": s.criticality,
        "qty_per_machine": _d(s.qty_per_machine), "sop_stock": _d(s.sop_stock), "uom": s.uom_code, "basis": s.basis,
        "source_ref": s.source_ref, "notes": s.notes, "item_id": s.item_id,
        "item": {"id": s.item.id, "item_code": s.item.item_code, "name": s.item.name} if s.item else None,
    }
    if with_suggestions and not s.item_id:
        out["suggestions"] = suggestions(db, s)
    return out


def machine_out(db: Session, m: Machine, detail: bool = False) -> dict:
    out = {
        "id": m.id, "code": m.code, "name": m.name, "models": m.models, "family": m.family, "description": m.description,
        "specifications": m.specifications, "source": m.source, "units_supported": m.units_supported,
        "spare_count": len(m.spares), "aligned_count": sum(1 for s in m.spares if s.item_id),
        "item": {"id": m.item.id, "item_code": m.item.item_code, "name": m.item.name} if m.item else None,
    }
    if detail:
        out["spares"] = [spare_out(db, s, with_suggestions=True) for s in m.spares]
    return out


@router.get("")
def list_machines(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    out = []
    for m in db.scalars(select(Machine).where(Machine.is_active.is_(True)).order_by(Machine.code)):
        row = machine_out(db, m)
        chk = store_check(db, m)
        row.update(readiness_pct=chk["readiness_pct"], counts=chk["counts"], critical_gaps=chk["critical_gaps"],
                   shortage_value=_d(chk["shortage_value"]), unpriced_shortages=chk["unpriced_shortages"],
                   stocked_lines=chk["stocked_lines"])
        out.append(row)
    return out


@router.get("/options")
def machine_options(db: Session = Depends(get_db), _: User = Depends(VIEW)):
    """Lightweight list for pickers (e.g. the sales enquiry form): machines with their sellable item and aligned spares."""
    out = []
    for m in db.scalars(select(Machine).where(Machine.is_active.is_(True)).order_by(Machine.code)):
        out.append({
            "id": m.id, "code": m.code, "name": m.name, "models": m.models, "family": m.family,
            "item": {"id": m.item.id, "item_code": m.item.item_code} if m.item else None,
            "spares": [{"id": s.id, "part_no": s.part_no, "name": s.name, "item_id": s.item_id,
                        "item_code": s.item.item_code if s.item else None} for s in m.spares],
        })
    return out


@router.get("/{machine_id}")
def get_machine(machine_id: int, db: Session = Depends(get_db), _: User = Depends(VIEW)):
    return machine_out(db, _machine(db, machine_id), detail=True)


class MachinePatch(BaseModel):
    units_supported: int | None = Field(default=None, ge=0, le=1000)
    description: str | None = None


@router.patch("/{machine_id}")
def update_machine(machine_id: int, body: MachinePatch, db: Session = Depends(get_db), user: User = Depends(MANAGE)):
    m = _machine(db, machine_id)
    changes = body.model_dump(exclude_unset=True)
    for k, v in changes.items():
        setattr(m, k, v)
    audit(db, user, "machine.update", "machine", m.id, changes)
    db.commit()
    return machine_out(db, m, detail=True)


class SpareIn(BaseModel):
    name: str = Field(min_length=3, max_length=200)
    group: str = Field(pattern="^(" + "|".join(GROUPS) + ")$")
    criticality: str = Field(default="B", pattern="^[ABC]$")
    qty_per_machine: Decimal = Field(default=Decimal(1), gt=0)
    sop_stock: Decimal = Field(default=Decimal(1), ge=0)
    uom: str = Field(default="NOS", max_length=16)
    notes: str | None = None
    source_ref: str | None = None


@router.post("/{machine_id}/spares", status_code=201)
def add_spare(machine_id: int, body: SpareIn, db: Session = Depends(get_db), user: User = Depends(MANAGE)):
    m = _machine(db, machine_id)
    norm = normalize_name(body.name)
    if any(s.name_normalized == norm for s in m.spares):
        raise BusinessError("This spare is already on the machine's list", status_code=409, code="duplicate")
    line_no = (db.scalar(select(func.max(MachineSpare.line_no)).where(MachineSpare.machine_id == m.id)) or 0) + 1
    s = MachineSpare(machine_id=m.id, line_no=line_no, part_no=f"{m.code}-{line_no:03d}", name=body.name.strip(), name_normalized=norm,
                     group=body.group, criticality=body.criticality, qty_per_machine=body.qty_per_machine, sop_stock=body.sop_stock,
                     uom_code=body.uom.upper(), basis="MANUAL", source_ref=body.source_ref or "Added manually", notes=body.notes)
    db.add(s)
    db.flush()
    audit(db, user, "machine.spare.add", "machine_spare", s.id, {"machine": m.code, **body.model_dump()})
    db.commit()
    return spare_out(db, s, with_suggestions=True)


class SparePatch(BaseModel):
    criticality: str | None = Field(default=None, pattern="^[ABC]$")
    qty_per_machine: Decimal | None = Field(default=None, gt=0)
    sop_stock: Decimal | None = Field(default=None, ge=0)
    notes: str | None = None


@router.patch("/spares/{spare_id}")
def update_spare(spare_id: int, body: SparePatch, db: Session = Depends(get_db), user: User = Depends(MANAGE)):
    s = _spare(db, spare_id)
    changes = body.model_dump(exclude_unset=True)
    before = {k: getattr(s, k) for k in changes}
    for k, v in changes.items():
        setattr(s, k, v)
    audit(db, user, "machine.spare.update", "machine_spare", s.id, {"before": before, "after": changes})
    db.commit()
    return spare_out(db, s, with_suggestions=True)


class LinkIn(BaseModel):
    item_id: int | None


@router.post("/spares/{spare_id}/link")
def link_spare(spare_id: int, body: LinkIn, db: Session = Depends(get_db), user: User = Depends(MANAGE)):
    s = _spare(db, spare_id)
    item = None
    if body.item_id is not None:
        item = db.get(Item, body.item_id)
        if item is None or not item.is_active:
            raise HTTPException(404, "Item not found or inactive")
    link(db, user, s, item, "link_manual" if item else "unlink")
    db.commit()
    return spare_out(db, s, with_suggestions=True)


@router.post("/spares/{spare_id}/create-item")
def create_item_for_spare(spare_id: int, db: Session = Depends(get_db), user: User = Depends(require_permission("items.create"))):
    s = _spare(db, spare_id)
    if s.item_id:
        raise BusinessError("This spare is already aligned with a stores item", status_code=409, code="state")
    if "machines.manage" not in user.permission_codes:
        raise BusinessError("Missing permission: machines.manage", status_code=403, code="forbidden")
    link(db, user, s, create_store_item(db, user, s), "create")
    db.commit()
    return spare_out(db, s, with_suggestions=True)


class AlignIn(BaseModel):
    create_missing: bool = False


@router.post("/{machine_id}/align")
def align(machine_id: int, body: AlignIn, db: Session = Depends(get_db), user: User = Depends(MANAGE)):
    if body.create_missing and "items.create" not in user.permission_codes:
        raise BusinessError("Missing permission: items.create", status_code=403, code="forbidden")
    m = _machine(db, machine_id)
    result = align_machine(db, user, m, create_missing=body.create_missing)
    db.commit()
    return {**result, "machine": machine_out(db, m, detail=True)}


@router.get("/{machine_id}/store-check")
def check(machine_id: int, units: int | None = None, db: Session = Depends(get_db), _: User = Depends(require_permission("stock.view"))):
    return _jsonable(store_check(db, _machine(db, machine_id), units))


class RequisitionIn(BaseModel):
    units: int = Field(ge=1, le=1000)
    spare_ids: list[int] | None = None
    required_date: date | None = None


@router.post("/{machine_id}/requisitions", status_code=201)
def requisitions(machine_id: int, body: RequisitionIn, db: Session = Depends(get_db),
                 user: User = Depends(require_permission("machines.requisition"))):
    m = _machine(db, machine_id)
    try:
        prs = raise_requisitions(db, user, m, body.units, body.spare_ids, body.required_date)
        db.commit()
    except BusinessError:
        db.rollback()
        raise
    return {"created": [{"number": p.number, "item_code": p.item.item_code, "item_name": p.item.name, "quantity": _d(p.quantity),
                         "kind": p.kind} for p in prs]}
