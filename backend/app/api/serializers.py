from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import schemas
from ..models import Item, QrCode, StockAdjustmentRequest, StockBalance, StockMovement
from ..services.qr import qr_content
from ..services.stock import item_totals, restock_qty


def qr_out(qr: QrCode) -> schemas.QrOut:
    return schemas.QrOut(id=qr.id, token=qr.token, status=qr.status.value, generation=qr.generation, batch_no=qr.batch_no,
                         serial_no=qr.serial_no, created_at=qr.created_at, printed_count=qr.printed_count, content=qr_content(qr.token))


def movement_out(m: StockMovement) -> schemas.MovementOut:
    return schemas.MovementOut(
        id=m.id, number=m.number, txn_uuid=m.txn_uuid, movement_type=m.movement_type, item_id=m.item_id,
        item_code=m.item.item_code, item_name=m.item.name,
        from_location=m.from_location.code if m.from_location else None, to_location=m.to_location.code if m.to_location else None,
        quantity=m.quantity, unit_cost=m.unit_cost, value=m.value, ref_doc_type=m.ref_doc_type, ref_doc_no=m.ref_doc_no,
        notes=m.notes, source=m.source, created_by=m.created_by.full_name, created_at=m.created_at,
    )


def balances(db: Session, item_id: int) -> list[schemas.BalanceOut]:
    rows = db.scalars(select(StockBalance).where(StockBalance.item_id == item_id).order_by(StockBalance.location_id)).all()
    return [schemas.BalanceOut(location=schemas.LocationOut.model_validate(b.location), qty_on_hand=b.qty_on_hand,
                               qty_reserved=b.qty_reserved, qty_qc_hold=b.qty_qc_hold, qty_available=b.qty_available)
            for b in rows if b.qty_on_hand or b.qty_reserved or b.qty_qc_hold]


def totals(db: Session, item: Item) -> dict[str, Decimal]:
    t = item_totals(db, item.id)
    t["valuation"] = (t["on_hand"] * Decimal(item.avg_cost or 0)).quantize(Decimal("0.01"))
    t["restock_qty"] = restock_qty(item, Decimal(t["on_hand"]), Decimal(t["available"]))
    return t


def adjustment_out(r: StockAdjustmentRequest) -> schemas.AdjustmentOut:
    return schemas.AdjustmentOut(
        id=r.id, number=r.number, item_code=r.item.item_code, item_name=r.item.name, location=r.location.code, qty_delta=r.qty_delta,
        reason=r.reason, status=r.status.value, requested_by=r.requested_by.full_name,
        decided_by=r.decided_by.full_name if r.decided_by else None, decision_note=r.decision_note, created_at=r.created_at,
    )
