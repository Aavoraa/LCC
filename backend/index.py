"""Vercel entrypoint.

Vercel's FastAPI runtime looks for an `app` object in a default location (index.py, app.py,
main.py, …) at the project root. Deploy this API with the Vercel project Root Directory set to
`backend/`; locally keep using `uvicorn app.main:app`.
"""
from app.main import app

__all__ = ["app"]
