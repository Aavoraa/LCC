"""Company / unit profile printed on documents (job-work delivery challans) and used for document numbering.

Stored as ``company.*`` rows in the settings table; anything not yet saved falls back to the defaults below.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Setting, User
from .common import BusinessError, audit

COMPANY_FIELDS: dict[str, tuple[str, str]] = {
    "name": ("LAKSHMI CARD CLOTHING MANUFACTURING CO. PVT. LTD.", "Company name"),
    "unit_name": ("Unit 4", "Unit"),
    "unit_code": ("U4", "Unit / inventory organisation code (prefix of challan numbers)"),
    "address": ("S.R.K.V. Post Perianaickenpalayam\nCoimbatore", "Unit address"),
    "state": ("Tamil Nadu", "State"),
    "phone": ("0422-2692317, 2692318", "Phone"),
    "fax": ("0422-2692319", "Fax"),
    "email": ("lccunit1@lakshmicardclothing.com", "E-mail"),
    "regd_office": ("Semmipalayam, Kuppuswamynaidupuram,\n- 641 662, Tiruppur Dist.", "Registered office"),
    "regd_phone": ("04255-277105 (3 lines)", "Registered office phone"),
    "cin": ("U17219TZ1960PTC000343", "CIN"),
    "pan": ("AAACL3521E", "PAN"),
    "gstin": ("33AAACL3521E1Z6", "GSTIN"),
}
PREFIX = "company."


def company_profile(db: Session) -> dict[str, str]:
    saved = {s.key[len(PREFIX):]: s.value for s in db.scalars(select(Setting).where(Setting.key.like(f"{PREFIX}%")))}
    return {k: saved.get(k, default) for k, (default, _) in COMPANY_FIELDS.items()}


def update_company_profile(db: Session, user: User, changes: dict[str, str]) -> dict[str, str]:
    unknown = set(changes) - set(COMPANY_FIELDS)
    if unknown:
        raise BusinessError(f"Unknown company field(s): {', '.join(sorted(unknown))}")
    before = company_profile(db)
    for key, value in changes.items():
        value = (value or "").strip()
        if key in ("name", "unit_code") and not value:
            raise BusinessError(f"{COMPANY_FIELDS[key][1]} cannot be empty")
        if len(value) > 255:
            raise BusinessError(f"{COMPANY_FIELDS[key][1]} is too long (255 characters max)")
        row = db.get(Setting, PREFIX + key)
        if row is None:
            db.add(Setting(key=PREFIX + key, value=value, description=COMPANY_FIELDS[key][1]))
        else:
            row.value = value
    db.flush()
    audit(db, user, "company.update", "setting", "company", {"before": {k: before[k] for k in changes}, "after": changes})
    return company_profile(db)
