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
    except Exception:  # keep serving (/health etc.) so the failure is visible in logs rather than a dead function
        log.exception('"bootstrap failed"')
