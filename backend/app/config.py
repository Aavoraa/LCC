"""Environment-based configuration. Nothing secret is hardcoded for production use."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    env_file = BASE_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


def _with_scheme(value: str) -> str:
    # PaaS hosts (e.g. Render's fromService host) may provide a bare hostname.
    return value if "://" in value else f"https://{value}"


def _list(name: str, default: str) -> list[str]:
    return [v.strip() for v in os.environ.get(name, default).split(",") if v.strip()]


def _database_url() -> str:
    if os.environ.get("VERCEL") and not os.environ.get("DATABASE_URL"):
        # Vercel's filesystem is read-only and the SQLite file is not deployed – a hosted Postgres is required.
        raise RuntimeError("DATABASE_URL is not set. On Vercel, attach a Postgres database (e.g. Neon) and set DATABASE_URL.")
    url = os.environ.get("DATABASE_URL", f"sqlite:///{(BASE_DIR / 'lakshmi_erp.db').as_posix()}")
    # Hosted providers (Neon, Vercel Postgres, Heroku) hand out postgres:// URLs; route them to the installed psycopg 3 driver.
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


@dataclass(frozen=True)
class Settings:
    env: str = os.environ.get("APP_ENV", "development")
    database_url: str = field(default_factory=_database_url)
    jwt_secret: str = os.environ.get("JWT_SECRET", "dev-only-insecure-secret-change-me-0000000000")
    jwt_expiry_minutes: int = int(os.environ.get("JWT_EXPIRY_MINUTES", "720"))
    cors_origins: list[str] = field(default_factory=lambda: [_with_scheme(o) for o in _list("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")])
    # Base URL printed under QR labels and encoded in opaque inventory URLs.
    # On Vercel Services the web app shares the API's domain, so fall back to the project's production domain.
    public_base_url: str = _with_scheme(os.environ.get("PUBLIC_BASE_URL") or os.environ.get("VERCEL_PROJECT_PRODUCTION_URL") or "http://localhost:3000")
    upload_dir: Path = Path(os.environ.get("UPLOAD_DIR", str(BASE_DIR / "storage")))

    @property
    def is_production(self) -> bool:
        return self.env == "production"


settings = Settings()

if settings.is_production and settings.jwt_secret == "dev-only-insecure-secret-change-me-0000000000":
    raise RuntimeError("JWT_SECRET must be set in production")
