from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import require_permission
from ..models import Item, ItemType, Location, MovementType, QrCode, QrStatus, StockBalance, StockMovement, User
from ..services.common import BusinessError, audit
from ..services.items import active_item_qr, create_item, ensure_item_qr, find_duplicates, parse_qr_payload, regenerate_qr
from ..services.qr import qr_content, render_png, render_svg
from ..services.stock import MovementInput, post_movement, restock_qty
from .serializers import balances, movement_out, qr_out, totals

router = APIRouter(prefix="/api/items", tags=["items"])
qr_router = APIRouter(prefix="/api/qr", tags=["qr"])


def _get_item(db: Session, item_id: int) -> Item:
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "Item not found")
    return item


@router.get("", response_model=dict)
def list_items(
    q: str | None = None,
    item_type: ItemType | None = None,
    category_id: int | None = None,
    location_id: int | None = None,
    stock_status: str | None = Query(None, pattern="^(OK|LOW|OUT|MIN)$"),
    qr_status: str | None = Query(None, pattern="^(ACTIVE|NONE)$"),
    include_inactive: bool = False,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("items.view")),
):
    bal = (
        select(
            StockBalance.item_id.label("item_id"),
            func.sum(StockBalance.qty_on_hand).label("on_hand"),
            func.sum(StockBalance.qty_reserved).label("reserved"),
            func.sum(StockBalance.qty_qc_hold).label("qc_hold"),
        ).group_by(StockBalance.item_id).subquery()
    )
    qr_sub = select(QrCode.item_id).where(QrCode.status == QrStatus.ACTIVE).distinct().subquery()
    on_hand = func.coalesce(bal.c.on_hand, 0)
    available = on_hand - func.coalesce(bal.c.reserved, 0) - func.coalesce(bal.c.qc_hold, 0)
    stmt = (
        select(Item, on_hand, func.coalesce(bal.c.reserved, 0), func.coalesce(bal.c.qc_hold, 0), available, qr_sub.c.item_id)
        .outerjoin(bal, bal.c.item_id == Item.id)
        .outerjoin(qr_sub, qr_sub.c.item_id == Item.id)
    )
    if not include_inactive:
        stmt = stmt.where(Item.is_active.is_(True))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Item.item_code.ilike(like), Item.name.ilike(like), Item.make_model.ilike(like), Item.manufacturer.ilike(like)))
    if item_type:
        stmt = stmt.where(Item.item_type == item_type)
    if category_id:
        stmt = stmt.where(or_(Item.category_id == category_id, Item.subcategory_id == category_id))
    if location_id:
        stmt = stmt.where(or_(Item.default_location_id == location_id,
                              Item.id.in_(select(StockBalance.item_id).where(StockBalance.location_id == location_id, StockBalance.qty_on_hand > 0))))
    if stock_status == "OUT":
        stmt = stmt.where(on_hand <= 0)
    elif stock_status == "LOW":
        stmt = stmt.where(on_hand > 0, available <= Item.reorder_level)
    elif stock_status == "OK":
        stmt = stmt.where(available > Item.reorder_level)
    elif stock_status == "MIN":  # still in stock but at or below the minimum the stores team set
        stmt = stmt.where(on_hand > 0, Item.min_stock > 0, available <= Item.min_stock)
    if qr_status == "ACTIVE":
        stmt = stmt.where(qr_sub.c.item_id.is_not(None))
    elif qr_status == "NONE":
        stmt = stmt.where(qr_sub.c.item_id.is_(None))

    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.execute(stmt.order_by(Item.item_code).offset((page - 1) * page_size).limit(page_size)).all()
    out = []
    for item, oh, res, qc, av, has_qr in rows:
        oh, res, qc, av = Decimal(oh), Decimal(res), Decimal(qc), Decimal(av)
        status = "OUT" if oh <= 0 else ("LOW" if av <= Decimal(item.reorder_level or 0) else "OK")
        out.append(schemas.ItemRow(
            id=item.id, item_code=item.item_code, name=item.name, item_type=item.item_type,
            category=item.category.name if item.category else None, uom=item.uom.code,
            location=item.default_location.code if item.default_location else None,
            qr_status="ACTIVE" if has_qr else "NONE", physical=oh, reserved=res, qc_hold=qc, available=av,
            reorder_level=item.reorder_level, valuation=(oh * Decimal(item.avg_cost or 0)).quantize(Decimal("0.01")), stock_status=status,
            min_stock=item.min_stock, max_stock=item.max_stock, restock_order_qty=item.restock_order_qty, restock_qty=restock_qty(item, oh, av),
        ).model_dump(mode="json"))
    return {"items": out, "total": total, "page": page, "page_size": page_size}


@router.get("/duplicate-check", response_model=list[schemas.DuplicateOut])
def duplicate_check(name: str = Query(min_length=2), make_model: str | None = None, manufacturer: str | None = None,
                    exclude_id: int | None = None, db: Session = Depends(get_db), _: User = Depends(require_permission("items.view"))):
    return [schemas.DuplicateOut(item_id=c.item.id, item_code=c.item.item_code, name=c.item.name, make_model=c.item.make_model,
                                 score=c.score, reason=c.reason) for c in find_duplicates(db, name, make_model, manufacturer, exclude_id)]


@router.get("/restock-alerts")
def restock_alerts(
    item_type: ItemType | None = None,
    limit: int = Query(24, ge=1, le=200),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("items.view")),
):
    """Items to restock: out of stock (nothing on hand), and items still in stock whose available quantity has
    reached the minimum stock set on the item. Most urgent first; counts cover all matches."""
    bal = (
        select(
            StockBalance.item_id.label("item_id"),
            func.sum(StockBalance.qty_on_hand).label("on_hand"),
            func.sum(StockBalance.qty_reserved + StockBalance.qty_qc_hold).label("held"),
        ).group_by(StockBalance.item_id).subquery()
    )
    on_hand = func.coalesce(bal.c.on_hand, 0)
    available = on_hand - func.coalesce(bal.c.held, 0)
    base = select(Item, on_hand, available).outerjoin(bal, bal.c.item_id == Item.id).where(Item.is_active.is_(True),
                                                                                          Item.item_type != ItemType.SERVICE)
    if item_type:
        base = base.where(Item.item_type == item_type)
    out_q = base.where(on_hand <= 0)
    min_q = base.where(on_hand > 0, Item.min_stock > 0, available <= Item.min_stock)

    def rows(stmt, order):
        result = []
        for item, oh, av in db.execute(stmt.order_by(*order).limit(limit)).all():
            oh, av, mn = Decimal(oh), Decimal(av), Decimal(item.min_stock or 0)
            result.append({
                "id": item.id, "item_code": item.item_code, "name": item.name, "item_type": item.item_type.value,
                "category": item.category.name if item.category else None, "uom": item.uom.code,
                "location": item.default_location.code if item.default_location else None,
                "physical": oh, "available": av, "min_stock": mn, "max_stock": item.max_stock, "restock_order_qty": item.restock_order_qty, "reorder_level": item.reorder_level,
                "shortfall": max(mn - av, Decimal(0)), "restock_qty": restock_qty(item, oh, av),
            })
        return result

    count = lambda stmt: db.scalar(select(func.count()).select_from(stmt.subquery()))  # noqa: E731
    return {
        # Out of stock with a minimum set first: those are items the stores team actively keeps.
        "out": rows(out_q, (Item.min_stock.desc(), Item.item_code)),
        "below_min": rows(min_q, ((available / Item.min_stock).asc(), Item.item_code)),
        "out_count": count(out_q), "below_min_count": count(min_q),
    }


@router.post("", response_model=schemas.ItemDetailOut, status_code=201)
def create(body: schemas.ItemCreateIn, db: Session = Depends(get_db), user: User = Depends(require_permission("items.create"))):
    data = body.model_dump(exclude={"allow_duplicate", "opening_qty", "opening_unit_cost"})
    data["item_type"] = body.item_type.value
    item = create_item(db, user, data, allow_duplicate=body.allow_duplicate)
    if body.opening_qty:
        if not body.default_location_id:
            raise BusinessError("Choose a default storage location to receive the opening balance")
        if "stock.receive" not in user.permission_codes:
            raise BusinessError("Missing permission: stock.receive", status_code=403, code="forbidden")
        post_movement(db, user, MovementInput(
            txn_uuid=f"item-opening-{item.id}-{uuid.uuid4().hex[:8]}", movement_type=MovementType.RECEIPT, item_id=item.id,
            quantity=body.opening_qty, to_location_id=body.default_location_id, unit_cost=body.opening_unit_cost,
            ref_doc_type="OPENING", ref_doc_no=item.item_code,
        ))
    db.commit()
    return detail(item.id, db)


@router.get("/{item_id}", response_model=schemas.ItemDetailOut)
def get_item(item_id: int, db: Session = Depends(get_db), _: User = Depends(require_permission("items.view"))):
    return detail(item_id, db)


def detail(item_id: int, db: Session) -> schemas.ItemDetailOut:
    item = _get_item(db, item_id)
    qr = active_item_qr(db, item.id)
    return schemas.ItemDetailOut(item=schemas.ItemOut.model_validate(item), balances=balances(db, item.id), totals=totals(db, item),
                                 qr=qr_out(qr) if qr else None)


@router.patch("/{item_id}", response_model=schemas.ItemDetailOut)
def update_item(item_id: int, body: schemas.ItemUpdateIn, db: Session = Depends(get_db), user: User = Depends(require_permission("items.edit"))):
    item = _get_item(db, item_id)
    changes = body.model_dump(exclude_unset=True)
    before = {k: getattr(item, k) for k in changes}
    for k, v in changes.items():
        setattr(item, k, v)
    if "name" in changes:
        from ..services.common import normalize_name

        item.name_normalized = normalize_name(item.name)
    if Decimal(item.max_stock or 0) and Decimal(item.reorder_level or 0) > Decimal(item.max_stock):
        raise BusinessError("Reorder level cannot exceed maximum stock")
    audit(db, user, "item.update", "item", item.id, {"before": before, "after": changes})
    db.commit()
    return detail(item.id, db)


@router.get("/{item_id}/movements", response_model=list[schemas.MovementOut])
def item_movements(item_id: int, limit: int = Query(100, le=1000), db: Session = Depends(get_db),
                   _: User = Depends(require_permission("stock.view"))):
    _get_item(db, item_id)
    rows = db.scalars(select(StockMovement).where(StockMovement.item_id == item_id).order_by(StockMovement.id.desc()).limit(limit))
    return [movement_out(m) for m in rows]


# ------------------------------------------------------------------- QR
@router.get("/{item_id}/qr.png")
def item_qr_png(item_id: int, scale: int = Query(10, ge=2, le=40), download: bool = False, db: Session = Depends(get_db),
                _: User = Depends(require_permission("items.view"))):
    item = _get_item(db, item_id)
    qr = active_item_qr(db, item.id)
    if qr is None:
        raise HTTPException(404, "No active QR — generate one first")
    headers = {"Content-Disposition": f'attachment; filename="{item.item_code}.png"'} if download else {}
    return Response(render_png(qr.token, scale), media_type="image/png", headers=headers)


@router.get("/{item_id}/qr.svg")
def item_qr_svg(item_id: int, download: bool = False, db: Session = Depends(get_db), _: User = Depends(require_permission("items.view"))):
    item = _get_item(db, item_id)
    qr = active_item_qr(db, item.id)
    if qr is None:
        raise HTTPException(404, "No active QR — generate one first")
    headers = {"Content-Disposition": f'attachment; filename="{item.item_code}.svg"'} if download else {}
    return Response(render_svg(qr.token), media_type="image/svg+xml", headers=headers)


@router.post("/{item_id}/qr/regenerate", response_model=schemas.QrOut)
def item_qr_regenerate(item_id: int, body: schemas.QrRegenerateIn, db: Session = Depends(get_db),
                       user: User = Depends(require_permission("qr.generate"))):
    item = _get_item(db, item_id)
    qr = regenerate_qr(db, item, user, body.reason)
    db.commit()
    return qr_out(qr)


@qr_router.post("/labels", response_model=list[schemas.LabelOut])
def labels(body: schemas.LabelsIn, db: Session = Depends(get_db), user: User = Depends(require_permission("qr.generate"))):
    """Bulk label data for selected items. Existing QR codes are reused; a QR is created only when an item has none."""
    out = []
    for item_id in dict.fromkeys(body.item_ids):
        item = _get_item(db, item_id)
        qr, created = ensure_item_qr(db, item)
        if body.mark_printed:
            qr.printed_count += 1
        out.append(schemas.LabelOut(item_id=item.id, item_code=item.item_code, name=item.name, uom=item.uom.code,
                                    location=item.default_location.code if item.default_location else None, token=qr.token,
                                    content=qr_content(qr.token), svg=render_svg(qr.token, inline=True), created=created))
    created_n = sum(1 for o in out if o.created)
    audit(db, user, "qr.labels", "item", None, {"items": body.item_ids, "created": created_n, "printed": body.mark_printed})
    db.commit()
    return out


@qr_router.get("/resolve", response_model=schemas.ResolveOut)
def resolve(payload: str = Query(min_length=4, max_length=512), verify: bool = False, db: Session = Depends(get_db),
            _: User = Depends(require_permission("items.view"))):
    """Map a scanned QR (or manual item code fallback) to the existing item record."""
    token = parse_qr_payload(payload)
    qr = db.scalar(select(QrCode).where(QrCode.token == token))
    if qr is None:
        item = db.scalar(select(Item).where(func.upper(Item.item_code) == payload.strip().upper()))
        if item is None:
            raise HTTPException(404, "QR code or item code not recognised")
        qr = active_item_qr(db, item.id)
        if qr is None:
            raise HTTPException(404, f"{item.item_code} has no active QR yet")
    if qr.status != QrStatus.ACTIVE:
        current = active_item_qr(db, qr.item_id) if qr.item_id else None
        hint = f" — reprint the current label for {db.get(Item, qr.item_id).item_code}" if current else ""
        raise HTTPException(410, "This QR label was revoked" + hint)
    if verify:
        qr.last_verified_at = datetime.now(timezone.utc)
        db.commit()
    if qr.location_id and not qr.item_id:
        return schemas.ResolveOut(kind="location", qr=qr_out(qr), location=schemas.LocationOut.model_validate(db.get(Location, qr.location_id)))
    item = _get_item(db, qr.item_id)
    return schemas.ResolveOut(kind="item", item=schemas.ItemOut.model_validate(item), balances=balances(db, item.id),
                              totals=totals(db, item), qr=qr_out(qr))


@qr_router.get("/locations/{location_id}.svg")
def location_qr(location_id: int, db: Session = Depends(get_db), _: User = Depends(require_permission("items.view"))):
    loc = db.get(Location, location_id)
    if loc is None:
        raise HTTPException(404, "Location not found")
    qr = db.scalar(select(QrCode).where(QrCode.location_id == location_id, QrCode.status == QrStatus.ACTIVE))
    if qr is None:
        from ..services.items import new_qr_token

        qr = QrCode(token=new_qr_token(), location_id=location_id)
        db.add(qr)
        db.commit()
    return Response(render_svg(qr.token), media_type="image/svg+xml")
