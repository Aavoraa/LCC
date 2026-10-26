"""Stores stock report (drives the voice report) and the item locator: one item's full purchase / stock history."""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import require_permission
from ..models import (
    Customer,
    Item,
    ItemCategory,
    ItemType,
    Location,
    Machine,
    MachineSpare,
    MovementType,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseRequisition,
    QrCode,
    QrStatus,
    Reservation,
    SalesOrder,
    SalesOrderLine,
    StockBalance,
    StockMovement,
    User,
    WorkOrder,
)
from ..services.items import active_item_qr, parse_qr_payload
from ..services.stock import restock_qty
from .serializers import balances, movement_out, qr_out, totals

router = APIRouter(prefix="/api/reports", tags=["reports"])
locator_router = APIRouter(prefix="/api/locator", tags=["locator"])


def _norm_code(s: str) -> str:
    return "".join(ch for ch in s.upper() if ch.isalnum())


def _search(stmt, q: str):
    """Every word must match the code, name, make/model, manufacturer or category."""
    for word in q.split():
        like = f"%{word}%"
        cats = select(ItemCategory.id).where(ItemCategory.name.ilike(like))
        stmt = stmt.where(or_(Item.item_code.ilike(like), Item.name.ilike(like), Item.make_model.ilike(like),
                              Item.manufacturer.ilike(like), Item.category_id.in_(cats), Item.subcategory_id.in_(cats)))
    return stmt


def _stock_subquery():
    return (
        select(
            StockBalance.item_id.label("item_id"),
            func.sum(StockBalance.qty_on_hand).label("on_hand"),
            func.sum(StockBalance.qty_reserved).label("reserved"),
            func.sum(StockBalance.qty_qc_hold).label("qc_hold"),
        ).group_by(StockBalance.item_id).subquery()
    )


def _status(item: Item, on_hand: Decimal, available: Decimal) -> tuple[str, bool]:
    status = "OUT" if on_hand <= 0 else ("LOW" if available <= Decimal(item.reorder_level or 0) else "OK")
    minimum = Decimal(item.min_stock or 0)
    return status, on_hand > 0 and minimum > 0 and available <= minimum


# ------------------------------------------------------------------ stock report
@router.get("/stock")
def stock_report(
    q: str | None = None,
    item_type: ItemType | None = None,
    stock_status: str | None = Query(None, pattern="^(OK|LOW|OUT|MIN)$"),
    location: str | None = Query(None, description="Part of a location code, e.g. R01 or R01-B02"),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("stock.view")),
):
    """Every active stores item (services excluded) with stock per location and report totals. Not paginated:
    the voice report reads the whole list."""
    bal = _stock_subquery()
    on_hand = func.coalesce(bal.c.on_hand, 0)
    available = on_hand - func.coalesce(bal.c.reserved, 0) - func.coalesce(bal.c.qc_hold, 0)
    stmt = (
        select(Item, on_hand, func.coalesce(bal.c.reserved, 0), func.coalesce(bal.c.qc_hold, 0), available)
        .outerjoin(bal, bal.c.item_id == Item.id)
        .where(Item.is_active.is_(True), Item.item_type != ItemType.SERVICE)
    )
    if q and q.strip():
        stmt = _search(stmt, q.strip())
    if item_type:
        stmt = stmt.where(Item.item_type == item_type)
    if stock_status == "OUT":
        stmt = stmt.where(on_hand <= 0)
    elif stock_status == "LOW":
        stmt = stmt.where(on_hand > 0, available <= Item.reorder_level)
    elif stock_status == "OK":
        stmt = stmt.where(available > Item.reorder_level)
    elif stock_status == "MIN":
        stmt = stmt.where(on_hand > 0, Item.min_stock > 0, available <= Item.min_stock)
    loc_code = _norm_code(location or "")
    if loc_code:
        code = func.upper(func.replace(Location.code, "-", ""))
        locs = select(Location.id).where(code.like(f"%{loc_code}%"))
        stmt = stmt.where(or_(Item.default_location_id.in_(locs),
                              Item.id.in_(select(StockBalance.item_id).where(StockBalance.location_id.in_(locs),
                                                                             StockBalance.qty_on_hand > 0))))
    rows = db.execute(stmt.order_by(Item.item_code)).all()

    where: dict[int, list[dict]] = defaultdict(list)
    if rows:
        ids = {r[0].id for r in rows}
        for b in db.scalars(select(StockBalance).where(or_(StockBalance.qty_on_hand > 0, StockBalance.qty_reserved > 0))
                            .order_by(StockBalance.location_id)):
            if b.item_id in ids:
                where[b.item_id].append({"code": b.location.code, "on_hand": b.qty_on_hand, "available": b.qty_available})

    out = []
    summary = {"items": 0, "out": 0, "low": 0, "ok": 0, "below_min": 0, "valuation": Decimal(0)}
    by_type: dict[str, int] = defaultdict(int)
    for item, oh, res, qc, av in rows:
        oh, res, qc, av = Decimal(oh), Decimal(res), Decimal(qc), Decimal(av)
        status, below_min = _status(item, oh, av)
        value = (oh * Decimal(item.avg_cost or 0)).quantize(Decimal("0.01"))
        summary["items"] += 1
        summary[status.lower()] += 1
        summary["below_min"] += below_min
        summary["valuation"] += value
        by_type[item.item_type.value] += 1
        out.append({
            "id": item.id, "item_code": item.item_code, "name": item.name, "item_type": item.item_type.value,
            "category": item.category.name if item.category else None, "uom": item.uom.code,
            "default_location": item.default_location.code if item.default_location else None,
            "locations": where.get(item.id, []),
            "physical": oh, "reserved": res, "qc_hold": qc, "available": av,
            "min_stock": item.min_stock, "reorder_level": item.reorder_level, "max_stock": item.max_stock,
            "avg_cost": item.avg_cost, "valuation": value, "stock_status": status, "below_min": below_min,
            "restock_qty": restock_qty(item, oh, av),
        })
    return {"generated_at": datetime.now(timezone.utc).isoformat(), "summary": {**summary, "by_type": by_type}, "rows": out}


# ------------------------------------------------------------------ item locator
def _lite(item: Item) -> dict:
    return {"id": item.id, "item_code": item.item_code, "name": item.name, "item_type": item.item_type.value, "uom": item.uom.code,
            "location": item.default_location.code if item.default_location else None}


@locator_router.get("/find")
def find(query: str = Query(min_length=1, max_length=512), db: Session = Depends(get_db),
         _: User = Depends(require_permission("items.view"))):
    """Resolve a scanned QR payload, an item number or a product name. Returns the item when the match is exact,
    otherwise candidates to pick from. A scanned bin label lists the items stored in that bin."""
    text = query.strip()
    token = parse_qr_payload(text)
    qr = db.scalar(select(QrCode).where(QrCode.token == token)) if token else None
    if qr is not None:
        if qr.location_id and not qr.item_id:
            loc = db.get(Location, qr.location_id)
            stocked = db.scalars(select(Item).join(StockBalance, StockBalance.item_id == Item.id)
                                 .where(StockBalance.location_id == loc.id, StockBalance.qty_on_hand > 0).order_by(Item.item_code)).all()
            assigned = db.scalars(select(Item).where(Item.default_location_id == loc.id, Item.is_active.is_(True)).order_by(Item.item_code)).all()
            items = list({i.id: i for i in [*stocked, *assigned]}.values())
            return {"kind": "location", "location": loc.code, "item_id": None, "warning": None, "candidates": [_lite(i) for i in items]}
        item = db.get(Item, qr.item_id)
        warning = None
        if qr.status != QrStatus.ACTIVE:
            warning = "This QR label was revoked — reprint the current label" if active_item_qr(db, item.id) else "This QR label was revoked"
        return {"kind": "item", "location": None, "item_id": item.id, "warning": warning, "candidates": [_lite(item)]}

    exact = db.scalar(select(Item).where(func.upper(Item.item_code) == text.upper()))
    if exact is None and _norm_code(text):  # typed without the dash: "PI 000001", "pi000001"
        exact = db.scalar(select(Item).where(func.upper(func.replace(Item.item_code, "-", "")) == _norm_code(text)))
    spoken = re.fullmatch(r"([A-Za-z])\W*([A-Za-z])\W*0*(\d{1,9})", text)
    if exact is None and spoken:  # spoken without the zeros: "P I 12", "PI-12"
        a, b, num = spoken.groups()
        exact = db.scalar(select(Item).where(func.upper(Item.item_code) == f"{a}{b}-{int(num):06d}".upper()))
    if exact is not None:
        return {"kind": "item", "location": None, "item_id": exact.id, "warning": None, "candidates": [_lite(exact)]}

    matches = db.scalars(_search(select(Item), text).order_by(Item.is_active.desc(), Item.item_code).limit(25)).all()
    return {"kind": "search", "location": None, "item_id": matches[0].id if len(matches) == 1 else None, "warning": None,
            "candidates": [_lite(i) for i in matches]}


@locator_router.get("/items/{item_id}")
def item_history(item_id: int, limit: int = Query(500, ge=1, le=5000), db: Session = Depends(get_db),
                 _: User = Depends(require_permission("stock.view"))):
    """Everything about one item: where it is, what is available, its purchase history, every stock movement,
    open demand against it and the machines that use it."""
    item = db.get(Item, item_id)
    if item is None:
        raise HTTPException(404, "Item not found")
    qr = active_item_qr(db, item.id)

    # Purchases
    po_rows = db.execute(
        select(PurchaseOrderLine, PurchaseOrder).join(PurchaseOrder, PurchaseOrderLine.po_id == PurchaseOrder.id)
        .where(PurchaseOrderLine.item_id == item.id).order_by(PurchaseOrder.order_date.desc(), PurchaseOrder.id.desc())
    ).all()
    lines = []
    for line, po in po_rows:
        ordered, received = Decimal(line.qty_ordered), Decimal(line.qty_received)
        lines.append({
            "po_id": po.id, "po_number": po.number, "status": po.status, "supplier": po.supplier.name, "order_date": po.order_date,
            "expected_date": line.expected_date, "qty_ordered": ordered, "qty_received": received,
            "qty_open": max(ordered - received, Decimal(0)) if po.status in ("DRAFT", "APPROVED") else Decimal(0),
            "unit_price": line.unit_price, "amount": (ordered * Decimal(line.unit_price)).quantize(Decimal("0.01")),
        })
    live = [l for l in lines if l["status"] != "CANCELLED"]
    prices = [Decimal(l["unit_price"]) for l in live if Decimal(l["unit_price"]) > 0]
    ordered_total = sum((l["qty_ordered"] for l in live), Decimal(0))
    purchase = {
        "lines": lines, "count": len(live), "total_ordered": ordered_total,
        "total_received": sum((l["qty_received"] for l in live), Decimal(0)),
        "open_qty": sum((l["qty_open"] for l in live), Decimal(0)),
        "total_amount": sum((l["amount"] for l in live), Decimal(0)),
        "last_price": live[0]["unit_price"] if live else None,
        "avg_price": (sum((l["amount"] for l in live), Decimal(0)) / ordered_total).quantize(Decimal("0.01")) if ordered_total else None,
        "min_price": min(prices) if prices else None, "max_price": max(prices) if prices else None,
        "suppliers": sorted({l["supplier"] for l in live} | ({item.supplier.name} if item.supplier else set())),
    }

    # Stock movements
    sums = dict(db.execute(select(StockMovement.movement_type, func.sum(StockMovement.quantity))
                           .where(StockMovement.item_id == item.id).group_by(StockMovement.movement_type)).all())
    count = db.scalar(select(func.count()).select_from(StockMovement).where(StockMovement.item_id == item.id))
    first_at = db.scalar(select(func.min(StockMovement.created_at)).where(StockMovement.item_id == item.id))

    def last(*types: MovementType):
        m = db.scalar(select(StockMovement).where(StockMovement.item_id == item.id, StockMovement.movement_type.in_(types))
                      .order_by(StockMovement.id.desc()).limit(1))
        return movement_out(m) if m else None

    q = lambda t: Decimal(sums.get(t, 0) or 0)  # noqa: E731
    movement_summary = {
        "count": count, "first_at": first_at,
        "opening": q(MovementType.OPENING), "received": q(MovementType.RECEIPT), "issued": q(MovementType.ISSUE),
        "returned": q(MovementType.RETURN), "adjusted_in": q(MovementType.ADJUSTMENT_IN), "adjusted_out": q(MovementType.ADJUSTMENT_OUT),
        "transferred": q(MovementType.TRANSFER),
        "last_receipt": last(MovementType.RECEIPT, MovementType.OPENING), "last_issue": last(MovementType.ISSUE),
    }
    movements = [movement_out(m) for m in db.scalars(select(StockMovement).where(StockMovement.item_id == item.id)
                                                     .order_by(StockMovement.id.desc()).limit(limit))]

    # Demand and usage
    reservations = [
        {"ref_doc_type": r.ref_doc_type, "ref_doc_no": r.ref_doc_no, "location": r.location.code, "qty_open": r.qty_open, "created_at": r.created_at}
        for r in db.scalars(select(Reservation).where(Reservation.item_id == item.id, Reservation.status == "ACTIVE").order_by(Reservation.id.desc()))
        if r.qty_open > 0
    ]
    sales = [
        {"so_id": so.id, "so_number": so.number, "customer": cust, "status": so.status, "quantity": l.quantity, "qty_issued": l.qty_issued,
         "forecast_date": l.forecast_date}
        for l, so, cust in db.execute(
            select(SalesOrderLine, SalesOrder, Customer.name).join(SalesOrder, SalesOrderLine.so_id == SalesOrder.id)
            .join(Customer, SalesOrder.customer_id == Customer.id)
            .where(SalesOrderLine.item_id == item.id, SalesOrder.status.in_(("DRAFT", "CONFIRMED"))).order_by(SalesOrder.id.desc()).limit(50)
        ).all()
    ]
    requisitions = [
        {"number": r.number, "kind": r.kind, "quantity": r.quantity, "status": r.status, "required_date": r.required_date, "created_at": r.created_at}
        for r in db.scalars(select(PurchaseRequisition).where(PurchaseRequisition.item_id == item.id).order_by(PurchaseRequisition.id.desc()).limit(50))
    ]
    work_orders = [
        {"number": w.number, "quantity": w.quantity, "qty_completed": w.qty_completed, "status": w.status, "required_date": w.required_date}
        for w in db.scalars(select(WorkOrder).where(WorkOrder.item_id == item.id).order_by(WorkOrder.id.desc()).limit(50))
    ]
    machines = [
        {"machine_id": m.id, "code": m.code, "name": m.name, "qty_per_machine": s.qty_per_machine, "sop_stock": s.sop_stock}
        for s, m in db.execute(select(MachineSpare, Machine).join(Machine, MachineSpare.machine_id == Machine.id)
                               .where(MachineSpare.item_id == item.id, Machine.is_active.is_(True)).order_by(Machine.code)).all()
    ]

    t = totals(db, item)
    status, below_min = _status(item, Decimal(t["on_hand"]), Decimal(t["available"]))

    # Oracle "Manage Item Quantities": organisation → subinventory (warehouse) → locator (rack-bin).
    from ..services.company import company_profile

    subs: dict[int, dict] = {}
    for b in db.scalars(select(StockBalance).where(StockBalance.item_id == item.id).order_by(StockBalance.location_id)):
        if not (b.qty_on_hand or b.qty_reserved or b.qty_qc_hold):
            continue
        wh = b.location.warehouse
        sub = subs.setdefault(wh.id, {"code": wh.code, "name": wh.name, "on_hand": Decimal(0), "reserved": Decimal(0),
                                      "qc_hold": Decimal(0), "available": Decimal(0), "locators": []})
        for k, v in (("on_hand", b.qty_on_hand), ("reserved", b.qty_reserved), ("qc_hold", b.qty_qc_hold), ("available", b.qty_available)):
            sub[k] += Decimal(v)
        sub["locators"].append({"code": b.location.code, "rack": b.location.rack, "bin": b.location.bin, "on_hand": b.qty_on_hand,
                                "reserved": b.qty_reserved, "qc_hold": b.qty_qc_hold, "available": b.qty_available})
    quantities = {"organization": company_profile(db)["unit_code"], "on_hand": t["on_hand"], "receiving_inbound": purchase["open_qty"],
                  "qc_hold": t["qc_hold"], "uom_name": item.uom.name, "category": item.category.name if item.category else None,
                  "subinventories": list(subs.values())}
    return {
        "item": schemas.ItemOut.model_validate(item), "qr": qr_out(qr) if qr else None,
        "balances": balances(db, item.id), "totals": t, "stock_status": status, "below_min": below_min, "quantities": quantities,
        "purchase": purchase, "movement_summary": movement_summary, "movements": movements,
        "reservations": reservations, "sales_orders": sales, "requisitions": requisitions, "work_orders": work_orders,
        "machines": machines,
    }


# ------------------------------------------------------------------ production details (Oracle "LCC Production Details for Given Date")
JOB_STATUS = {"OPEN": "RELEASED", "IN_PROGRESS": "RELEASED", "COMPLETED": "COMPLETED", "CANCELLED": "CANCELLED"}
PRODUCTION_COLUMNS = [
    ("org", "Org"), ("job_type", "Job Type"), ("job_no", "Job No"), ("item_no", "Item No"), ("item_desc", "Item Desc"),
    ("transaction_qty", "Transaction Quantity"), ("primary_qty", "Primary Quantity"), ("transaction_uom", "Transaction Uom"),
    ("transaction_date", "Transaction Date"), ("remarks", "Remarks"), ("wip_value", "Wip Value"), ("start_qty", "Start Quantity"),
    ("qty_completed", "Quantity Completed"), ("job_status", "Job Status"), ("cost_incurred", "Cost Incurred"), ("cost_relieved", "Cost Relieved"),
]


def _production_rows(db: Session, date_from, date_to, q: str | None) -> list[dict]:
    from datetime import time, timedelta

    from ..services.company import company_profile
    from ..services.osp import IST

    if date_to < date_from:
        raise HTTPException(422, "To date is before from date")
    if (date_to - date_from).days > 366:
        raise HTTPException(422, "Choose a range of at most one year")
    start = datetime.combine(date_from, time.min, IST).astimezone(timezone.utc)
    end = datetime.combine(date_to + timedelta(days=1), time.min, IST).astimezone(timezone.utc)
    wip = (StockMovement.ref_doc_type == "WIP")
    comps = db.scalars(select(StockMovement).where(wip, StockMovement.movement_type == MovementType.RECEIPT,
                                                   StockMovement.created_at >= start, StockMovement.created_at < end)
                       .order_by(StockMovement.created_at, StockMovement.id)).all()
    jobs = {w.number: w for w in db.scalars(select(WorkOrder).where(WorkOrder.number.in_({m.ref_doc_no for m in comps})))}
    if not jobs:
        return []
    # Job-level costs: material issued to the job (less returns) is incurred; completions booked to stores are relieved.
    incurred: dict[str, Decimal] = defaultdict(Decimal)
    relieved: dict[str, Decimal] = defaultdict(Decimal)
    done_by_id: dict[str, list[tuple[int, Decimal]]] = defaultdict(list)
    for mid, no, mtype, qty, value in db.execute(
        select(StockMovement.id, StockMovement.ref_doc_no, StockMovement.movement_type, StockMovement.quantity, StockMovement.value)
        .where(wip, StockMovement.ref_doc_no.in_(jobs)).order_by(StockMovement.id)
    ).all():
        if mtype == MovementType.ISSUE:
            incurred[no] += Decimal(value)
        elif mtype == MovementType.RETURN:
            incurred[no] -= Decimal(value)
        elif mtype == MovementType.RECEIPT:
            relieved[no] += Decimal(value)
            done_by_id[no].append((mid, Decimal(qty)))
    org = company_profile(db)["unit_code"]
    needle = (q or "").strip().lower()
    rows = []
    for m in comps:
        wo = jobs.get(m.ref_doc_no)
        if wo is None:
            continue
        if needle and needle not in f"{wo.number} {m.item.item_code} {m.item.name}".lower():
            continue
        cumulative = sum((qty for mid, qty in done_by_id[wo.number] if mid <= m.id), Decimal(0))
        rows.append({
            "org": org, "job_type": "SHOPMADE", "job_no": wo.number, "work_order_id": wo.id, "item_id": m.item_id,
            "item_no": m.item.item_code, "item_desc": m.item.name, "transaction_qty": m.quantity, "primary_qty": m.quantity,
            "transaction_uom": m.item.uom.code, "transaction_date": m.created_at.replace(tzinfo=m.created_at.tzinfo or timezone.utc).astimezone(IST).date(),
            "remarks": "COMPLETED" if cumulative >= Decimal(wo.quantity) else "PARTIAL COMPLETION",
            "wip_value": m.value, "start_qty": wo.quantity, "qty_completed": wo.qty_completed,
            "job_status": JOB_STATUS.get(wo.status, wo.status), "cost_incurred": incurred[wo.number].quantize(Decimal("0.01")),
            "cost_relieved": relieved[wo.number].quantize(Decimal("0.01")),
        })
    return rows


@router.get("/production")
def production_report(date_from: date, date_to: date, q: str | None = None, db: Session = Depends(get_db),
                      _: User = Depends(require_permission("production.view"))):
    """Work-order completions in a date range (India time), one row per completion transaction, laid out like the
    Oracle "Production Details for Given Date" report."""
    rows = _production_rows(db, date_from, date_to, q)
    return {
        "date_from": date_from, "date_to": date_to, "columns": [{"key": k, "label": l} for k, l in PRODUCTION_COLUMNS], "rows": rows,
        "totals": {"transactions": len(rows), "jobs": len({r["job_no"] for r in rows}),
                   "quantity": sum((Decimal(r["transaction_qty"]) for r in rows), Decimal(0)),
                   "wip_value": sum((Decimal(r["wip_value"]) for r in rows), Decimal(0)),
                   "completed": sum(1 for r in rows if r["remarks"] == "COMPLETED")},
    }


@router.get("/production.xlsx")
def production_report_xlsx(date_from: date, date_to: date, q: str | None = None, db: Session = Depends(get_db),
                           _: User = Depends(require_permission("production.view"))):
    import io

    from fastapi import Response
    from openpyxl import Workbook
    from openpyxl.styles import Font

    rows = _production_rows(db, date_from, date_to, q)
    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    fmt = lambda d: d.strftime("%d-%b-%Y").upper()  # noqa: E731  08-OCT-2026, as Oracle prints it
    ws.append(["From Date:", fmt(date_from)])
    ws.append(["To Date:", fmt(date_to)])
    ws.append([])
    ws.append([label for _, label in PRODUCTION_COLUMNS])
    for cell in ws[4]:
        cell.font = Font(bold=True)
    for r in rows:
        ws.append([fmt(r[k]) if k == "transaction_date" else float(r[k]) if isinstance(r[k], Decimal) else r[k] for k, _ in PRODUCTION_COLUMNS])
    for col, width in zip("ABCDEFGHIJKLMNOP", (6, 11, 14, 14, 44, 12, 12, 10, 14, 20, 12, 12, 12, 12, 14, 14)):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = "A5"
    buf = io.BytesIO()
    wb.save(buf)
    name = f"LCC Production Details {date_from.isoformat()} to {date_to.isoformat()}.xlsx"
    return Response(buf.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
