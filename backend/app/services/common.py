"""Shared service helpers: business errors, audit logging, document numbering, settings."""
from __future__ import annotations

import re
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AuditEvent, DocumentSequence, Notification, Setting, User


class BusinessError(Exception):
    """A rule violation reported to the client as HTTP 4xx with a clear message."""

    def __init__(self, message: str, status_code: int = 422, code: str = "business_rule"):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code


def _jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "value") and hasattr(value, "name"):  # enums
        return value.value
    return value


def audit(db: Session, user: User | None, action: str, entity_type: str, entity_id: Any, data: dict | None = None) -> None:
    db.add(
        AuditEvent(
            user_id=user.id if user else None,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id) if entity_id is not None else None,
            data=_jsonable(data) if data else None,
        )
    )


def notify(db: Session, kind: str, title: str, body: str | None = None, *, role_code: str | None = None,
           entity_type: str | None = None, entity_id: Any = None) -> None:
    db.add(Notification(kind=kind, title=title, body=body, role_code=role_code, entity_type=entity_type,
                        entity_id=str(entity_id) if entity_id is not None else None))


def next_number(db: Session, key: str, prefix: str, width: int = 6) -> str:
    """Gap-free sequential document numbers. The row's version column makes concurrent
    increments fail-and-retry rather than hand out the same number twice."""
    seq = db.get(DocumentSequence, key, with_for_update=True)
    if seq is None:
        seq = DocumentSequence(key=key, next_value=1)
        db.add(seq)
        db.flush()
    value = seq.next_value
    seq.next_value = value + 1
    db.flush()
    return f"{prefix}{value:0{width}d}"


DEFAULT_SETTINGS: dict[str, tuple[str, str]] = {
    "estimate.qc_days": ("1", "Working days for final QC before dispatch"),
    "estimate.packing_days": ("1", "Working days for packing"),
    "estimate.dispatch_days": ("1", "Working days to dispatch after packing"),
    "estimate.default_transport_days": ("2", "Transport days when the customer has none configured"),
    "estimate.procurement_approval_days": ("2", "Working days for purchase approval and PO release"),
    "estimate.default_purchase_lead_days": ("14", "Supplier lead time when neither item nor supplier defines one"),
    "estimate.rework_allowance_days": ("1", "Buffer for possible QC rework on produced items"),
    "production.hours_per_day": ("8", "Productive shop hours per working day, used to turn in-house process time into days"),
    "duplicates.name_similarity": ("0.88", "Similarity ratio (0-1) at which item names are flagged as possible duplicates"),
}


def get_setting(db: Session, key: str) -> str:
    row = db.get(Setting, key)
    if row is not None:
        return row.value
    return DEFAULT_SETTINGS[key][0]


def get_int_setting(db: Session, key: str) -> int:
    return int(get_setting(db, key))


def normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


def ensure_settings(db: Session) -> None:
    existing = set(db.scalars(select(Setting.key)))
    for key, (value, description) in DEFAULT_SETTINGS.items():
        if key not in existing:
            db.add(Setting(key=key, value=value, description=description))


def run_with_retry(db: Session, fn, attempts: int = 6):
    """Run ``fn()`` and commit, retrying when a concurrent writer wins a lock or version check.
    ``fn`` must re-load what it needs (objects are expired after each rollback). Business-rule
    violations are never retried."""
    import time

    from sqlalchemy.exc import IntegrityError, OperationalError
    from sqlalchemy.orm.exc import StaleDataError

    for attempt in range(attempts):
        try:
            result = fn()
            db.commit()
            return result
        except BusinessError:
            db.rollback()
            raise
        except (StaleDataError, OperationalError, IntegrityError):
            db.rollback()
            if attempt == attempts - 1:
                raise BusinessError("Another user changed this stock at the same moment; please retry", status_code=409, code="conflict")
            time.sleep(0.05 * (attempt + 1))
