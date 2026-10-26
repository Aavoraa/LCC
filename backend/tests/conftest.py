from __future__ import annotations

import os
import tempfile

import pytest
from fastapi.testclient import TestClient

_tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.seed import ensure_user, seed_reference  # noqa: E402

PASSWORD = "Test@12345"
USERS = {
    "admin": ["SUPER_ADMIN"], "stores": ["STORES"], "stores2": ["STORES"], "sales": ["SALES"], "purchase": ["PURCHASE"],
    "manager": ["MANAGEMENT"], "auditor": ["AUDITOR"], "qc": ["QC"],
    "planning": ["PLANNING"], "production": ["PRODUCTION"],
}


@pytest.fixture(autouse=True)
def fresh_db():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        seed_reference(db)
        for u, roles in USERS.items():
            ensure_user(db, u, u.title(), roles, PASSWORD)
        db.commit()
    yield


@pytest.fixture
def client():
    return TestClient(app)


class Api:
    def __init__(self, client: TestClient, username: str):
        self.c = client
        r = client.post("/api/auth/login", json={"username": username, "password": PASSWORD})
        assert r.status_code == 200, r.text
        self.h = {"Authorization": f"Bearer {r.json()['access_token']}"}

    def get(self, url, **kw):
        return self.c.get(url, headers=self.h, **kw)

    def post(self, url, **kw):
        return self.c.post(url, headers=self.h, **kw)

    def patch(self, url, **kw):
        return self.c.patch(url, headers=self.h, **kw)

    def put(self, url, **kw):
        return self.c.put(url, headers=self.h, **kw)

    def delete(self, url, **kw):
        return self.c.delete(url, headers=self.h, **kw)


@pytest.fixture
def as_user(client):
    cache: dict[str, Api] = {}

    def _get(name: str) -> Api:
        if name not in cache:
            cache[name] = Api(client, name)
        return cache[name]

    return _get


@pytest.fixture
def refs(as_user):
    a = as_user("admin")
    uoms = {u["code"]: u["id"] for u in a.get("/api/masters/uoms").json()}
    locs = {l["code"]: l["id"] for l in a.get("/api/masters/locations").json()}
    cats = {c["name"]: c["id"] for c in a.get("/api/masters/categories").json()}
    return {"uom": uoms, "loc": locs, "cat": cats}


@pytest.fixture
def make_item(as_user, refs):
    def _make(name="Ball Bearing 6205", item_type="PURCHASED_ITEM", **extra):
        body = {"name": name, "item_type": item_type, "uom_id": refs["uom"]["NOS"], "reorder_level": "10",
                "default_location_id": refs["loc"]["MAIN-R01-B01"], **extra}
        r = as_user("stores").post("/api/items", json=body)
        assert r.status_code == 201, r.text
        return r.json()

    return _make
