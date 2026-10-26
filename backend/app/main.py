from __future__ import annotations

import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .api import auth, dashboard, documents, imports, inventory, items, machines, masters, osp, process, production, reports, sales_orders, sales_purchase, stock  # noqa: F401 (sales_orders registers routes)
from .bootstrap import bootstrap
from .config import settings
from .db import engine
from .services.common import BusinessError

logging.basicConfig(level=logging.INFO, format='{"t":"%(asctime)s","lvl":"%(levelname)s","msg":%(message)s}')
log = logging.getLogger("erp")

bootstrap()  # no-op locally; on Vercel migrates the DB and creates the first admin if there are no users

app = FastAPI(
    title="Lakshmi Machine ERP API",
    version="0.1.0",
    description="Inventory, QR, stock ledger, availability and delivery estimation. Interactive docs at /docs.",
)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def request_log(request: Request, call_next):
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    start = time.perf_counter()
    response = await call_next(request)
    response.headers["x-request-id"] = rid
    log.info('{"rid":"%s","method":"%s","path":"%s","status":%d,"ms":%.1f}', rid, request.method, request.url.path,
             response.status_code, (time.perf_counter() - start) * 1000)
    return response


@app.exception_handler(BusinessError)
async def business_error(_: Request, exc: BusinessError):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.message, "code": exc.code})


@app.get("/health", tags=["ops"])
def health():
    """Liveness plus database reachability. On failure, reports the error type and first line (credentials scrubbed)
    and the last start-up migration result, so a broken deployment can be diagnosed from outside."""
    from .bootstrap import STATE, describe_error

    boot = {"ran": STATE["ran"], "error": STATE["error"]}
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as e:
        log.exception('"health: database check failed"')
        return JSONResponse(status_code=503, content={"status": "error", "database": engine.dialect.name,
                                                      "error": describe_error(e), "bootstrap": boot})
    return {"status": "ok", "database": engine.dialect.name, "bootstrap": boot}


for r in (auth.router, auth.users_router, items.router, items.qr_router, stock.router, masters.router,
          sales_purchase.sales_router, sales_purchase.purchase_router, imports.router, dashboard.router, machines.router, process.router, production.pad_router, production.wo_router,
          production.tracker_router, reports.router, reports.locator_router, osp.router, inventory.router, documents.router):
    app.include_router(r)
