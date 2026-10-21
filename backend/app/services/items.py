from __future__ import annotations

import difflib
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import ITEM_TYPE_PREFIX, Item, ItemType, QrCode, QrStatus, User
from .common import BusinessError, audit, get_setting, next_number, normalize_name

QR_PREFIX = "LMQ1:"


_NUM = re.compile(r"\d+(?:\.\d+)?")


def _numbers(*texts: str) -> set[str]:
    return {n for t in texts for n in _NUM.findall(t)}


@dataclass
class DuplicateCandidate:
    item: Item
    score: float
    reason: str


def find_duplicates(db: Session, name: str, make_model: str | None = None, manufacturer: str | None = None,
                    exclude_id: int | None = None, limit: int = 5) -> list[DuplicateCandidate]:
    """Configurable fuzzy match on normalized name (+ make/model when supplied)."""
    threshold = float(get_setting(db, "duplicates.name_similarity"))
    norm = normalize_name(name)
    if not norm:
        return []
    model = normalize_name(make_model or "")
    nums = _numbers(norm, model)
    results: list[DuplicateCandidate] = []
    rows = db.execute(select(Item.id, Item.name_normalized, Item.make_model, Item.manufacturer)).all()
    for item_id, other_norm, other_model, other_mfr in rows:
        if item_id == exclude_id:
            continue
        other_model_n = normalize_name(other_model or "")
        other_nums = _numbers(other_norm, other_model_n)
        if nums and other_nums and nums != other_nums:
            # Different sizes / ratings / angles (8VG vs 12VG, 1.5 HP vs 3 HP, M12x50 vs M12x60) are different parts.
            continue
        if model and other_model_n:
            # Both specify a make/model: compare them together so e.g. 6205 vs 6206 is not flagged.
            score = difflib.SequenceMatcher(None, f"{norm} {model}", f"{other_norm} {other_model_n}").ratio()
            reason = "Identical name and make/model" if score == 1.0 else f"Similar name and model ({score:.0%})"
        else:
            # Only one (or neither) has a model — judge on the name alone.
            score = difflib.SequenceMatcher(None, norm, other_norm).ratio()
            reason = "Identical name" if score == 1.0 else f"Similar name ({score:.0%})"
            if manufacturer and other_mfr and normalize_name(manufacturer) == normalize_name(other_mfr):
                score = min(1.0, score + 0.03)
        if score >= threshold:
            results.append(DuplicateCandidate(db.get(Item, item_id), round(score, 3), reason))
    results.sort(key=lambda c: c.score, reverse=True)
    return results[:limit]


def new_qr_token() -> str:
    return secrets.token_urlsafe(18)


def issue_qr(db: Session, item: Item, *, batch_no: str | None = None, serial_no: str | None = None) -> QrCode:
    qr = QrCode(token=new_qr_token(), item_id=item.id, batch_no=batch_no, serial_no=serial_no)
    db.add(qr)
    db.flush()
    return qr


def active_item_qr(db: Session, item_id: int) -> QrCode | None:
    return db.scalar(
        select(QrCode).where(QrCode.item_id == item_id, QrCode.status == QrStatus.ACTIVE,
                             QrCode.batch_no.is_(None), QrCode.serial_no.is_(None))
    )


def ensure_item_qr(db: Session, item: Item) -> tuple[QrCode, bool]:
    """Return the item's SKU-level QR, creating one only if none exists (no duplicates)."""
    existing = active_item_qr(db, item.id)
    if existing:
        return existing, False
    return issue_qr(db, item), True


def regenerate_qr(db: Session, item: Item, user: User, reason: str) -> QrCode:
    """Revoke the current token and issue a new one. ``item_code`` never changes."""
    old = active_item_qr(db, item.id)
    generation = 1
    if old:
        old.status = QrStatus.REVOKED
        old.revoked_at = datetime.now(timezone.utc)
        generation = old.generation + 1
    qr = issue_qr(db, item)
    qr.generation = generation
    audit(db, user, "qr.regenerate", "item", item.id, {"reason": reason, "old_token_id": old.id if old else None, "generation": generation})
    return qr


def create_item(db: Session, user: User, data: dict, *, allow_duplicate: bool = False, reviewed: bool = False) -> Item:
    """``reviewed`` is for internal callers (import approval) where duplicates were already resolved."""
    item_type = ItemType(data["item_type"])
    if reviewed:
        pass
    elif not allow_duplicate:
        dupes = find_duplicates(db, data["name"], data.get("make_model"), data.get("manufacturer"))
        if dupes:
            raise BusinessError(
                "Possible duplicate of " + ", ".join(f"{d.item.item_code} ({d.reason})" for d in dupes[:3])
                + ". Review the existing item, or confirm creation with allow_duplicate.",
                status_code=409, code="possible_duplicate",
            )
    elif "items.duplicate_override" not in user.permission_codes:
        raise BusinessError("You are not authorized to override duplicate checks", status_code=403, code="forbidden")

    levels = (data.get("min_stock") or 0, data.get("reorder_level") or 0, data.get("max_stock") or 0)
    if data.get("max_stock") and data.get("reorder_level") and data["reorder_level"] > data["max_stock"]:
        raise BusinessError("Reorder level cannot exceed maximum stock")
    if min(levels) < 0:
        raise BusinessError("Stock levels cannot be negative")

    while True:  # skip numbers already taken by preserved legacy codes
        code = next_number(db, f"item.{item_type.value}", f"{ITEM_TYPE_PREFIX[item_type]}-")
        if not db.scalar(select(Item.id).where(Item.item_code == code)):
            break
    item = Item(item_code=code, name=data["name"].strip(), name_normalized=normalize_name(data["name"]),
                created_by_id=user.id, **{k: v for k, v in data.items() if k not in {"name", "item_type"}})
    item.item_type = item_type
    db.add(item)
    db.flush()
    issue_qr(db, item)
    audit(db, user, "item.create", "item", item.id, {"item_code": code, **data})
    return item


def qr_payload(token: str) -> str:
    return f"{QR_PREFIX}{token}"


def parse_qr_payload(payload: str) -> str:
    """Accepts the raw ``LMQ1:<token>`` payload, an inventory URL ending in the token, or a bare token."""
    payload = payload.strip()
    if payload.startswith(QR_PREFIX):
        return payload[len(QR_PREFIX):]
    if "/q/" in payload:
        return payload.rsplit("/q/", 1)[1].split("?")[0]
    return payload
