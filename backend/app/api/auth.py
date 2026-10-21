from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import schemas
from ..db import get_db
from ..deps import current_user, require_permission
from ..models import Role, User
from ..security import create_access_token, hash_password, verify_password
from ..services.common import audit

router = APIRouter(prefix="/api/auth", tags=["auth"])
users_router = APIRouter(prefix="/api/users", tags=["users"])


def me_out(user: User) -> schemas.MeOut:
    return schemas.MeOut(**schemas.UserOut.model_validate(user).model_dump(), permissions=sorted(user.permission_codes))


@router.post("/login", response_model=schemas.TokenOut)
def login(body: schemas.LoginIn, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.username == body.username.strip().lower()))
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        audit(db, None, "auth.login_failed", "user", None, {"username": body.username})
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect username or password")
    audit(db, user, "auth.login", "user", user.id)
    db.commit()
    return schemas.TokenOut(access_token=create_access_token(user.id), user=me_out(user))


@router.get("/me", response_model=schemas.MeOut)
def me(user: User = Depends(current_user)):
    return me_out(user)


@users_router.get("", response_model=list[schemas.UserOut])
def list_users(db: Session = Depends(get_db), _: User = Depends(require_permission("users.manage", "audit.view"))):
    return db.scalars(select(User).order_by(User.username)).all()


@users_router.get("/roles")
def list_roles(db: Session = Depends(get_db), _: User = Depends(require_permission("users.manage", "audit.view"))):
    return [{"code": r.code, "name": r.name, "permissions": sorted(p.code for p in r.permissions)}
            for r in db.scalars(select(Role).order_by(Role.id))]


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[a-z0-9._-]+$")
    full_name: str = Field(min_length=2)
    email: str | None = None
    password: str = Field(min_length=8)
    roles: list[str] = Field(min_length=1)


@users_router.post("", response_model=schemas.UserOut, status_code=201)
def create_user(body: UserCreate, db: Session = Depends(get_db), actor: User = Depends(require_permission("users.manage"))):
    if db.scalar(select(User).where(User.username == body.username)):
        raise HTTPException(409, "Username already exists")
    roles = list(db.scalars(select(Role).where(Role.code.in_(body.roles))))
    if len(roles) != len(set(body.roles)):
        raise HTTPException(422, "Unknown role code")
    user = User(username=body.username, full_name=body.full_name, email=body.email, password_hash=hash_password(body.password), roles=roles)
    db.add(user)
    db.flush()
    audit(db, actor, "user.create", "user", user.id, {"username": user.username, "roles": body.roles})
    db.commit()
    return user
