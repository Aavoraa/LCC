"""First-start setup for hosted deploys where nobody can run `alembic upgrade head` / `python -m app.seed` by hand.

Runs on Vercel (or when AUTO_BOOTSTRAP=1): brings the schema to head and, only while the users table is empty,
seeds reference data plus the first admin (BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD, default: the demo login).
Change that password after the first sign-in.
"""
from __future__ import annotations

import logging
import os

from sqlalchemy import func, select, text

from .config import BASE_DIR
from .db import SessionLocal, engine

log = logging.getLogger("erp.bootstrap")

DEMO_ADMIN_USERNAME = "demo@example.com"
DEMO_ADMIN_PASSWORD = "demo@12345"
_LOCK_ID = 0x4C4343  # "LCC" – serialises concurrent cold starts
# Outcome of the last bootstrap run, reported by /health so a failed migration is visible without the host logs.
STATE: dict[str, str | bool | None] = {"ran": False, "error": None}


def _enabled() -> bool:
    return bool(os.environ.get("VERCEL") or os.environ.get("AUTO_BOOTSTRAP"))


def _migrate() -> None:
    from alembic import command
    from alembic.config import Config

    command.upgrade(Config(str(BASE_DIR / "alembic.ini")), "head")


def _seed_first_admin() -> None:
    from .models import User
    from .seed import ensure_user, seed_reference

    with SessionLocal() as db:
        if db.scalar(select(func.count()).select_from(User)):
            return
        seed_reference(db)
        username = os.environ.get("BOOTSTRAP_ADMIN_USERNAME") or DEMO_ADMIN_USERNAME
        password = os.environ.get("BOOTSTRAP_ADMIN_PASSWORD") or DEMO_ADMIN_PASSWORD
        ensure_user(db, username, "System Administrator", ["SUPER_ADMIN"], password)
        db.commit()
        log.info('"bootstrap: created first admin %s"', username)


def describe_error(e: BaseException) -> str:
    """First line of an error, safe to show publicly: connection URLs and passwords are scrubbed."""
    import re

    msg = str(getattr(e, "orig", None) or e).strip().splitlines()
    text_ = f"{type(e).__name__}: {msg[0] if msg else ''}"
    text_ = re.sub(r"[a-z+]+://[^\s@/]+@", "<url>://***@", text_)  # user:password in URLs
    text_ = re.sub(r"(password|secret|token)=\S+", r"\1=***", text_, flags=re.I)
    return text_[:300]


def bootstrap() -> None:
    if not _enabled():
        return
    try:
        with engine.connect() as lock_conn:
            postgres = lock_conn.dialect.name == "postgresql"
            if postgres:
                lock_conn.execute(text("SELECT pg_advisory_lock(:id)"), {"id": _LOCK_ID})
            try:
                _migrate()
                _seed_first_admin()
            finally:
                if postgres:
                    lock_conn.execute(text("SELECT pg_advisory_unlock(:id)"), {"id": _LOCK_ID})
        STATE["error"] = None
    except Exception as e:  # keep serving (/health etc.) so the failure is visible rather than a dead function
        STATE["error"] = describe_error(e)
        log.exception('"bootstrap failed"')
    finally:
        STATE["ran"] = True
