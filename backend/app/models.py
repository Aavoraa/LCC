"""Relational schema. Quantities and money use NUMERIC(18,4).

Stock integrity rules:
* ``stock_movements`` is append-only — rows are never updated or deleted.
* ``stock_balances`` is a projection maintained in the same transaction as each movement
  and is always reconcilable by summing movements (see ``services.stock.reconcile``).
"""
from __future__ import annotations

import enum
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Table,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base

Qty = Numeric(18, 4)
Money = Numeric(18, 4)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------- enums
class ItemType(str, enum.Enum):
    RAW_MATERIAL = "RAW_MATERIAL"
    PURCHASED_ITEM = "PURCHASED_ITEM"
    DAILY_CONSUMABLE = "DAILY_CONSUMABLE"
    PROCESSED_SPARE = "PROCESSED_SPARE"
    FINISHED_GOOD = "FINISHED_GOOD"
    SERVICE = "SERVICE"


ITEM_TYPE_PREFIX = {
    ItemType.RAW_MATERIAL: "RM",
    ItemType.PURCHASED_ITEM: "PI",
    ItemType.DAILY_CONSUMABLE: "DC",
    ItemType.PROCESSED_SPARE: "PS",
    ItemType.FINISHED_GOOD: "FG",
    ItemType.SERVICE: "SV",
}


class TrackingMode(str, enum.Enum):
    NONE = "NONE"
    BATCH = "BATCH"
    SERIAL = "SERIAL"


class ValuationMethod(str, enum.Enum):
    WEIGHTED_AVERAGE = "WEIGHTED_AVERAGE"
    FIFO = "FIFO"


class MovementType(str, enum.Enum):
    OPENING = "OPENING"
    RECEIPT = "RECEIPT"
    ISSUE = "ISSUE"
    TRANSFER = "TRANSFER"
    RETURN = "RETURN"
    ADJUSTMENT_IN = "ADJUSTMENT_IN"
    ADJUSTMENT_OUT = "ADJUSTMENT_OUT"
    QC_HOLD = "QC_HOLD"
    QC_RELEASE = "QC_RELEASE"


class ApprovalStatus(str, enum.Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


# ---------------------------------------------------------------- identity & RBAC
user_roles = Table(
    "user_roles",
    Base.metadata,
    Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("role_id", ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
)

role_permissions = Table(
    "role_permissions",
    Base.metadata,
    Column("role_id", ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
    Column("permission_id", ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
)


class Permission(Base):
    __tablename__ = "permissions"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    description: Mapped[str] = mapped_column(String(255), default="")


class Role(Base):
    __tablename__ = "roles"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    permissions: Mapped[list[Permission]] = relationship(secondary=role_permissions, lazy="selectin")


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    full_name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str | None] = mapped_column(String(255))
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    roles: Mapped[list[Role]] = relationship(secondary=user_roles, lazy="selectin")

    @property
    def permission_codes(self) -> set[str]:
        return {p.code for r in self.roles for p in r.permissions}


# ---------------------------------------------------------------- masters
class Uom(Base):
    __tablename__ = "uoms"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(16), unique=True)
    name: Mapped[str] = mapped_column(String(64))
    decimals: Mapped[int] = mapped_column(Integer, default=0)


class ItemCategory(Base):
    __tablename__ = "item_categories"
    __table_args__ = (UniqueConstraint("name", "parent_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("item_categories.id"))


class Supplier(Base):
    __tablename__ = "suppliers"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    gstin: Mapped[str | None] = mapped_column(String(15))
    address: Mapped[str | None] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(String(32))
    email: Mapped[str | None] = mapped_column(String(255))
    lead_time_days: Mapped[int] = mapped_column(Integer, default=14)


class Customer(Base):
    __tablename__ = "customers"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    gstin: Mapped[str | None] = mapped_column(String(15))
    address: Mapped[str | None] = mapped_column(Text)
    city: Mapped[str | None] = mapped_column(String(120))
    phone: Mapped[str | None] = mapped_column(String(32))
    email: Mapped[str | None] = mapped_column(String(255))
    transport_days: Mapped[int] = mapped_column(Integer, default=2)


class Warehouse(Base):
    __tablename__ = "warehouses"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(16), unique=True)
    name: Mapped[str] = mapped_column(String(120))


class Location(Base):
    __tablename__ = "locations"
    __table_args__ = (UniqueConstraint("warehouse_id", "rack", "bin"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(48), unique=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))
    rack: Mapped[str] = mapped_column(String(16), default="")
    bin: Mapped[str] = mapped_column(String(16), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    warehouse: Mapped[Warehouse] = relationship(lazy="joined")


class Holiday(Base):
    __tablename__ = "holidays"
    id: Mapped[int] = mapped_column(primary_key=True)
    day: Mapped[date] = mapped_column(Date, unique=True)
    name: Mapped[str] = mapped_column(String(120))


class Setting(Base):
    """Key/value business rules (lead-time defaults, duplicate thresholds …)."""

    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(String(255), default="")


class DocumentSequence(Base):
    __tablename__ = "document_sequences"
    key: Mapped[str] = mapped_column(String(32), primary_key=True)
    next_value: Mapped[int] = mapped_column(Integer, default=1)
    version: Mapped[int] = mapped_column(Integer, default=1)
    __mapper_args__ = {"version_id_col": version}


# ---------------------------------------------------------------- items & QR
class Item(Base):
    __tablename__ = "items"
    __table_args__ = (
        CheckConstraint("min_stock >= 0 AND reorder_level >= 0 AND max_stock >= 0", name="ck_item_levels"),
        Index("ix_items_name_norm", "name_normalized"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    item_code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    name_normalized: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    item_type: Mapped[ItemType] = mapped_column(Enum(ItemType, native_enum=False, length=32))
    category_id: Mapped[int | None] = mapped_column(ForeignKey("item_categories.id"))
    subcategory_id: Mapped[int | None] = mapped_column(ForeignKey("item_categories.id"))
    uom_id: Mapped[int] = mapped_column(ForeignKey("uoms.id"))
    manufacturer: Mapped[str | None] = mapped_column(String(200))
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"))
    make_model: Mapped[str | None] = mapped_column(String(200))
    specifications: Mapped[str | None] = mapped_column(Text)
    min_stock: Mapped[Decimal] = mapped_column(Qty, default=0)
    reorder_level: Mapped[Decimal] = mapped_column(Qty, default=0)
    max_stock: Mapped[Decimal] = mapped_column(Qty, default=0)
    # Quantity stores orders each time the item reaches its minimum (0 = refill to max / min instead).
    restock_order_qty: Mapped[Decimal] = mapped_column(Qty, default=0, server_default="0")
    default_location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id"))
    tracking: Mapped[TrackingMode] = mapped_column(Enum(TrackingMode, native_enum=False, length=16), default=TrackingMode.NONE)
    valuation_method: Mapped[ValuationMethod] = mapped_column(
        Enum(ValuationMethod, native_enum=False, length=24), default=ValuationMethod.WEIGHTED_AVERAGE
    )
    hsn_code: Mapped[str | None] = mapped_column(String(16))
    gst_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    purchase_lead_days: Mapped[int | None] = mapped_column(Integer)
    production_lead_days: Mapped[int] = mapped_column(Integer, default=0)
    avg_cost: Mapped[Decimal] = mapped_column(Money, default=0)
    image_path: Mapped[str | None] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    uom: Mapped[Uom] = relationship(lazy="joined")
    category: Mapped[ItemCategory | None] = relationship(foreign_keys=[category_id], lazy="joined")
    subcategory: Mapped[ItemCategory | None] = relationship(foreign_keys=[subcategory_id], lazy="joined")
    supplier: Mapped[Supplier | None] = relationship(lazy="joined")
    default_location: Mapped[Location | None] = relationship(lazy="joined")


class QrStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    REVOKED = "REVOKED"


class QrCode(Base):
    """Opaque QR identifiers. The token carries no business data."""

    __tablename__ = "qr_codes"
    __table_args__ = (Index("ix_qr_item_status", "item_id", "status"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    token: Mapped[str] = mapped_column(String(64), unique=True)
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id"))
    location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id"))
    batch_no: Mapped[str | None] = mapped_column(String(64))
    serial_no: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[QrStatus] = mapped_column(Enum(QrStatus, native_enum=False, length=16), default=QrStatus.ACTIVE)
    generation: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    printed_count: Mapped[int] = mapped_column(Integer, default=0)
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# ---------------------------------------------------------------- stock ledger
class StockBalance(Base):
    __tablename__ = "stock_balances"
    __table_args__ = (
        UniqueConstraint("item_id", "location_id"),
        CheckConstraint("qty_on_hand >= 0", name="ck_bal_on_hand"),
        CheckConstraint("qty_reserved >= 0 AND qty_qc_hold >= 0", name="ck_bal_holds"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"), index=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"))
    qty_on_hand: Mapped[Decimal] = mapped_column(Qty, default=0)
    qty_reserved: Mapped[Decimal] = mapped_column(Qty, default=0)
    qty_qc_hold: Mapped[Decimal] = mapped_column(Qty, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    location: Mapped[Location] = relationship(lazy="joined")
    __mapper_args__ = {"version_id_col": version}

    @property
    def qty_available(self) -> Decimal:
        return Decimal(self.qty_on_hand) - Decimal(self.qty_reserved) - Decimal(self.qty_qc_hold)


class StockMovement(Base):
    __tablename__ = "stock_movements"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_mov_qty_positive"),
        Index("ix_mov_item_time", "item_id", "created_at"),
        Index("ix_mov_ref", "ref_doc_type", "ref_doc_no"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(32), unique=True)
    txn_uuid: Mapped[str] = mapped_column(String(64), unique=True)
    movement_type: Mapped[MovementType] = mapped_column(Enum(MovementType, native_enum=False, length=24))
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"))
    from_location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id"))
    to_location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty)
    unit_cost: Mapped[Decimal] = mapped_column(Money, default=0)
    value: Mapped[Decimal] = mapped_column(Money, default=0)
    ref_doc_type: Mapped[str | None] = mapped_column(String(32))
    ref_doc_no: Mapped[str | None] = mapped_column(String(64))
    batch_no: Mapped[str | None] = mapped_column(String(64))
    notes: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(16), default="web")
    device_captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    item: Mapped[Item] = relationship(lazy="joined")
    from_location: Mapped[Location | None] = relationship(foreign_keys=[from_location_id], lazy="joined")
    to_location: Mapped[Location | None] = relationship(foreign_keys=[to_location_id], lazy="joined")
    created_by: Mapped[User] = relationship(lazy="joined")


class StockAdjustmentRequest(Base):
    """Maker–checker: requested by one user, approved by a different user."""

    __tablename__ = "stock_adjustment_requests"
    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(32), unique=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"))
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"))
    qty_delta: Mapped[Decimal] = mapped_column(Qty)
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[ApprovalStatus] = mapped_column(Enum(ApprovalStatus, native_enum=False, length=16), default=ApprovalStatus.PENDING)
    requested_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    decided_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    decision_note: Mapped[str | None] = mapped_column(Text)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    movement_id: Mapped[int | None] = mapped_column(ForeignKey("stock_movements.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    item: Mapped[Item] = relationship(lazy="joined")
    location: Mapped[Location] = relationship(lazy="joined")
    requested_by: Mapped[User] = relationship(foreign_keys=[requested_by_id], lazy="joined")
    decided_by: Mapped[User | None] = relationship(foreign_keys=[decided_by_id], lazy="joined")


class Reservation(Base):
    """Stock earmarked against a document at one location. ``quantity`` is what was reserved;
    ``qty_consumed`` grows as stock is issued against the document. Open = quantity − qty_consumed,
    which always equals this row's share of ``stock_balances.qty_reserved``."""

    __tablename__ = "reservations"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_res_qty"),
        CheckConstraint("qty_consumed >= 0 AND qty_consumed <= quantity", name="ck_res_consumed"),
        Index("ix_res_ref", "ref_doc_type", "ref_doc_no"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"), index=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty)
    qty_consumed: Mapped[Decimal] = mapped_column(Qty, default=0)
    ref_doc_type: Mapped[str] = mapped_column(String(32))
    ref_doc_no: Mapped[str] = mapped_column(String(64))
    so_line_id: Mapped[int | None] = mapped_column(ForeignKey("sales_order_lines.id"), index=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(96), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="ACTIVE")  # ACTIVE, CONSUMED, RELEASED
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    location: Mapped[Location] = relationship(lazy="joined")

    @property
    def qty_open(self) -> Decimal:
        if self.status != "ACTIVE":
            return Decimal(0)
        return Decimal(self.quantity) - Decimal(self.qty_consumed or 0)


# ---------------------------------------------------------------- purchasing (incoming supply for ATP)
class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"
    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(32), unique=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("suppliers.id"))
    status: Mapped[str] = mapped_column(String(16), default="DRAFT")  # DRAFT, APPROVED, CLOSED, CANCELLED
    order_date: Mapped[date] = mapped_column(Date)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    approved_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    supplier: Mapped[Supplier] = relationship(lazy="joined")
    lines: Mapped[list[PurchaseOrderLine]] = relationship(back_populates="po", lazy="selectin", cascade="all, delete-orphan")


class PurchaseOrderLine(Base):
    __tablename__ = "purchase_order_lines"
    id: Mapped[int] = mapped_column(primary_key=True)
    po_id: Mapped[int] = mapped_column(ForeignKey("purchase_orders.id", ondelete="CASCADE"))
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"), index=True)
    qty_ordered: Mapped[Decimal] = mapped_column(Qty)
    qty_received: Mapped[Decimal] = mapped_column(Qty, default=0)
    unit_price: Mapped[Decimal] = mapped_column(Money, default=0)
    expected_date: Mapped[date] = mapped_column(Date)
    po: Mapped[PurchaseOrder] = relationship(back_populates="lines")
    item: Mapped[Item] = relationship(lazy="joined")


# ---------------------------------------------------------------- sales enquiries
class SalesEnquiry(Base):
    __tablename__ = "sales_enquiries"
    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(32), unique=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"))
    reference: Mapped[str | None] = mapped_column(String(64))
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty)
    required_date: Mapped[date | None] = mapped_column(Date)
    customer_location: Mapped[str | None] = mapped_column(String(200))
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="OPEN")  # OPEN, QUOTED, WON, LOST
    estimate: Mapped[dict | None] = mapped_column(JSON)
    estimated_date: Mapped[date | None] = mapped_column(Date)
    risk: Mapped[str | None] = mapped_column(String(8))
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    customer: Mapped[Customer] = relationship(lazy="joined")
    item: Mapped[Item] = relationship(lazy="joined")


# ---------------------------------------------------------------- quotations & sales orders (spec §7–8)
class Quotation(Base):
    """Created from a saved enquiry; carries the enquiry's preliminary (non-binding) estimate."""

    __tablename__ = "quotations"
    __table_args__ = (CheckConstraint("quantity > 0 AND unit_price >= 0", name="ck_quote_amounts"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(32), unique=True)
    enquiry_id: Mapped[int] = mapped_column(ForeignKey("sales_enquiries.id"), index=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"))
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty)
    unit_price: Mapped[Decimal] = mapped_column(Money, default=0)
    valid_until: Mapped[date | None] = mapped_column(Date)
    preliminary_date: Mapped[date | None] = mapped_column(Date)
    estimate: Mapped[dict | None] = mapped_column(JSON)
    risk: Mapped[str | None] = mapped_column(String(8))
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="DRAFT")  # DRAFT, SENT, ACCEPTED, REJECTED, CONVERTED
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    enquiry: Mapped[SalesEnquiry] = relationship(lazy="joined")
    customer: Mapped[Customer] = relationship(lazy="joined")
    item: Mapped[Item] = relationship(lazy="joined")


class SalesOrder(Base):
    """Three dates are deliberately kept apart:

    * ``preliminary_date`` — copied from the quotation/enquiry estimate, never changed.
    * ``forecast_date`` — rule-based, recalculated whenever reservations or supply change.
    * ``committed_date`` — only set once a second user with ``sales.commit_approve`` approves it.
    """

    __tablename__ = "sales_orders"
    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(32), unique=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"))
    enquiry_id: Mapped[int | None] = mapped_column(ForeignKey("sales_enquiries.id"), unique=True)
    quotation_id: Mapped[int | None] = mapped_column(ForeignKey("quotations.id"), unique=True)
    customer_po_ref: Mapped[str | None] = mapped_column(String(64))
    required_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(16), default="DRAFT")  # DRAFT, CONFIRMED, COMPLETED, CANCELLED
    preliminary_date: Mapped[date | None] = mapped_column(Date)
    forecast_date: Mapped[date | None] = mapped_column(Date)
    forecast_risk: Mapped[str | None] = mapped_column(String(8))
    forecast_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    at_risk: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    commit_status: Mapped[str] = mapped_column(String(16), default="NONE")  # NONE, PENDING, APPROVED, REJECTED
    proposed_commit_date: Mapped[date | None] = mapped_column(Date)
    commit_requested_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    committed_date: Mapped[date | None] = mapped_column(Date)
    commit_approved_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    commit_decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    commit_note: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    confirmed_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, default=1)
    customer: Mapped[Customer] = relationship(lazy="joined")
    lines: Mapped[list[SalesOrderLine]] = relationship(back_populates="so", lazy="selectin", cascade="all, delete-orphan",
                                                       order_by="SalesOrderLine.line_no")
    __mapper_args__ = {"version_id_col": version}


class SalesOrderLine(Base):
    __tablename__ = "sales_order_lines"
    __table_args__ = (
        UniqueConstraint("so_id", "line_no"),
        CheckConstraint("quantity > 0 AND qty_issued >= 0", name="ck_sol_qty"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    so_id: Mapped[int] = mapped_column(ForeignKey("sales_orders.id", ondelete="CASCADE"))
    line_no: Mapped[int] = mapped_column(Integer)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"), index=True)
    quantity: Mapped[Decimal] = mapped_column(Qty)
    unit_price: Mapped[Decimal] = mapped_column(Money, default=0)
    qty_issued: Mapped[Decimal] = mapped_column(Qty, default=0)
    qty_shortage: Mapped[Decimal] = mapped_column(Qty, default=0)
    forecast_date: Mapped[date | None] = mapped_column(Date)
    forecast: Mapped[dict | None] = mapped_column(JSON)
    so: Mapped[SalesOrder] = relationship(back_populates="lines")
    item: Mapped[Item] = relationship(lazy="joined")


class PurchaseRequisition(Base):
    """Shortage raised by a confirmed SO line. kind=PURCHASE → buy; kind=PRODUCTION → make
    (handed to Production until the work-order module exists)."""

    __tablename__ = "purchase_requisitions"
    __table_args__ = (CheckConstraint("quantity > 0", name="ck_pr_qty"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(32), unique=True)
    kind: Mapped[str] = mapped_column(String(16), default="PURCHASE")  # PURCHASE, PRODUCTION
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"), index=True)
    quantity: Mapped[Decimal] = mapped_column(Qty)
    required_date: Mapped[date | None] = mapped_column(Date)
    so_line_id: Mapped[int | None] = mapped_column(ForeignKey("sales_order_lines.id"), index=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(96), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="OPEN")  # OPEN, ORDERED, CANCELLED
    po_line_id: Mapped[int | None] = mapped_column(ForeignKey("purchase_order_lines.id"))
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    item: Mapped[Item] = relationship(lazy="joined")
    so_line: Mapped[SalesOrderLine | None] = relationship(lazy="joined")


# ---------------------------------------------------------------- import / migration
class ImportBatch(Base):
    __tablename__ = "import_batches"
    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(32), unique=True)
    filename: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(16), default="UPLOADED")  # UPLOADED, VALIDATED, APPROVED, REJECTED
    headers: Mapped[list] = mapped_column(JSON, default=list)
    mapping: Mapped[dict] = mapped_column(JSON, default=dict)
    summary: Mapped[dict] = mapped_column(JSON, default=dict)
    uploaded_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    approved_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    uploaded_by: Mapped[User] = relationship(foreign_keys=[uploaded_by_id], lazy="joined")
    rows: Mapped[list[ImportRow]] = relationship(back_populates="batch", lazy="selectin", order_by="ImportRow.row_no")


class ImportRow(Base):
    __tablename__ = "import_rows"
    __table_args__ = (UniqueConstraint("batch_id", "row_no"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("import_batches.id", ondelete="CASCADE"))
    row_no: Mapped[int] = mapped_column(Integer)
    raw: Mapped[dict] = mapped_column(JSON)
    mapped: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="PENDING")  # VALID, INVALID, DUPLICATE, IMPORTED, SKIPPED
    errors: Mapped[list] = mapped_column(JSON, default=list)
    duplicate_item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id"))
    resolution: Mapped[str | None] = mapped_column(String(16))  # CREATE, SKIP, LINK
    result_item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id"))
    batch: Mapped[ImportBatch] = relationship(back_populates="rows")


# ---------------------------------------------------------------- audit & notifications
class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (Index("ix_audit_entity", "entity_type", "entity_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(64))
    entity_type: Mapped[str] = mapped_column(String(48))
    entity_id: Mapped[str | None] = mapped_column(String(48))
    data: Mapped[dict | None] = mapped_column(JSON)
    user: Mapped[User | None] = relationship(lazy="joined")


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    role_code: Mapped[str | None] = mapped_column(String(64), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str | None] = mapped_column(Text)
    entity_type: Mapped[str | None] = mapped_column(String(48))
    entity_id: Mapped[str | None] = mapped_column(String(48))
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# ---------------------------------------------------------------- machines & SOP spare lists
class Machine(Base):
    """A machine model the company builds or services (e.g. a card service machine)."""

    __tablename__ = "machines"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    models: Mapped[str | None] = mapped_column(String(200))  # model variants, e.g. "LFCM 100, LFCM 40"
    family: Mapped[str] = mapped_column(String(64), default="Card Service Machines")
    description: Mapped[str | None] = mapped_column(Text)
    specifications: Mapped[dict] = mapped_column(JSON, default=dict)
    source: Mapped[str | None] = mapped_column(String(200))  # catalogue reference
    units_supported: Mapped[int] = mapped_column(Integer, default=1)  # machines the stores must support
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id"))  # the sellable finished-good item for this machine
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    item: Mapped[Item | None] = relationship(lazy="joined")
    spares: Mapped[list[MachineSpare]] = relationship(back_populates="machine", lazy="selectin",
                                                       order_by="MachineSpare.line_no", cascade="all, delete-orphan")


class MachineSpare(Base):
    """One line of a machine's SOP spare list. ``item_id`` aligns it to the stores item master."""

    __tablename__ = "machine_spares"
    __table_args__ = (
        UniqueConstraint("machine_id", "line_no"),
        UniqueConstraint("machine_id", "name_normalized"),
        CheckConstraint("qty_per_machine > 0 AND sop_stock >= 0", name="ck_spare_qty"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    machine_id: Mapped[int] = mapped_column(ForeignKey("machines.id", ondelete="CASCADE"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    part_no: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(200))
    name_normalized: Mapped[str] = mapped_column(String(200))
    group: Mapped[str] = mapped_column(String(32))  # WEAR, TOOLING, MECHANICAL, ELECTRICAL, PNEUMATIC, INSPECTION, CONSUMABLE, FASTENER, FABRICATION
    criticality: Mapped[str] = mapped_column(String(1), default="B")  # A critical / B important / C on demand
    qty_per_machine: Mapped[Decimal] = mapped_column(Qty, default=1)
    sop_stock: Mapped[Decimal] = mapped_column(Qty, default=0)  # minimum to hold per machine supported
    uom_code: Mapped[str] = mapped_column(String(16), default="NOS")
    basis: Mapped[str] = mapped_column(String(16), default="CATALOGUE")  # CATALOGUE (named in source), DERIVED (from specs), STANDARD (build hardware) or MANUAL
    source_ref: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id"), index=True)
    machine: Mapped[Machine] = relationship(back_populates="spares")
    item: Mapped[Item | None] = relationship(lazy="joined")


class ProcessStep(Base):
    """One operation in the manufacturing route of a made item (processed spare / finished good).
    IN_HOUSE steps take setup + run time per unit on our machines; OUTSIDE steps go to a job-work vendor and take
    a fixed number of days (including transport both ways)."""

    __tablename__ = "item_process_steps"
    __table_args__ = (
        UniqueConstraint("item_id", "seq"),
        CheckConstraint("setup_min >= 0 AND run_min >= 0 AND outside_days >= 0", name="ck_process_step_time"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    operation: Mapped[str] = mapped_column(String(120))
    work_center: Mapped[str | None] = mapped_column(String(80))  # machine / section, or the job-work trade for OUTSIDE
    mode: Mapped[str] = mapped_column(String(10), default="IN_HOUSE")  # IN_HOUSE or OUTSIDE
    setup_min: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0)  # per batch
    run_min: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0)  # per unit
    outside_days: Mapped[int] = mapped_column(Integer, default=0)  # vendor turnaround incl. transport
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"))
    notes: Mapped[str | None] = mapped_column(Text)
    supplier: Mapped[Supplier | None] = relationship(lazy="joined")


class Pad(Base):
    """WIP / PAD (parts assembly document) raised by Planning & Design against a confirmed sales-order line.
    For a machine it lists the machine's standard SOP parts × quantity; for a spares order, the spare itself.
    Released to Stores, which verifies availability, raises shortages and issues parts to assembly against it."""

    __tablename__ = "pads"
    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(32), unique=True)
    sales_order_id: Mapped[int] = mapped_column(ForeignKey("sales_orders.id"), index=True)
    so_line_id: Mapped[int] = mapped_column(ForeignKey("sales_order_lines.id"), index=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"))  # what is being built / supplied
    machine_id: Mapped[int | None] = mapped_column(ForeignKey("machines.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty)
    status: Mapped[str] = mapped_column(String(16), default="DRAFT")  # DRAFT, RELEASED, ISSUED, CANCELLED
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    released_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    item: Mapped[Item] = relationship(lazy="joined")
    sales_order: Mapped["SalesOrder"] = relationship(lazy="joined")
    machine: Mapped[Machine | None] = relationship(lazy="joined")
    lines: Mapped[list["PadLine"]] = relationship(back_populates="pad", cascade="all, delete-orphan", order_by="PadLine.line_no")


class PadLine(Base):
    __tablename__ = "pad_lines"
    __table_args__ = (UniqueConstraint("pad_id", "line_no"), CheckConstraint("qty_required > 0 AND qty_issued >= 0", name="ck_pad_line_qty"))
    id: Mapped[int] = mapped_column(primary_key=True)
    pad_id: Mapped[int] = mapped_column(ForeignKey("pads.id", ondelete="CASCADE"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id"), index=True)  # None: SOP line not yet in stores
    machine_spare_id: Mapped[int | None] = mapped_column(ForeignKey("machine_spares.id"))
    name: Mapped[str] = mapped_column(String(200))
    group: Mapped[str | None] = mapped_column(String(32))
    qty_required: Mapped[Decimal] = mapped_column(Qty)
    qty_issued: Mapped[Decimal] = mapped_column(Qty, default=0)
    requisition_id: Mapped[int | None] = mapped_column(ForeignKey("purchase_requisitions.id"))
    pad: Mapped[Pad] = relationship(back_populates="lines")
    item: Mapped[Item | None] = relationship(lazy="joined")
    requisition: Mapped[PurchaseRequisition | None] = relationship(lazy="joined")


class WorkOrder(Base):
    """Production order for a made item. Operations are a snapshot of the item's process route at creation:
    each runs in sequence and must pass QC before the next can start; OUTSIDE steps go to a job-work vendor."""

    __tablename__ = "work_orders"
    __table_args__ = (CheckConstraint("quantity > 0 AND qty_completed >= 0", name="ck_wo_qty"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(32), unique=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id"), index=True)
    quantity: Mapped[Decimal] = mapped_column(Qty)
    qty_completed: Mapped[Decimal] = mapped_column(Qty, default=0)
    status: Mapped[str] = mapped_column(String(16), default="OPEN")  # OPEN, IN_PROGRESS, COMPLETED, CANCELLED
    pad_id: Mapped[int | None] = mapped_column(ForeignKey("pads.id"), index=True)
    requisition_id: Mapped[int | None] = mapped_column(ForeignKey("purchase_requisitions.id"), index=True)
    required_date: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    item: Mapped[Item] = relationship(lazy="joined")
    pad: Mapped[Pad | None] = relationship(lazy="joined")
    requisition: Mapped[PurchaseRequisition | None] = relationship(lazy="joined")
    ops: Mapped[list["WorkOrderOp"]] = relationship(back_populates="work_order", cascade="all, delete-orphan", order_by="WorkOrderOp.seq")


class WorkOrderOp(Base):
    """One process step of a work order.
    IN_HOUSE: PENDING → IN_PROGRESS → DONE → QC_PASSED.   OUTSIDE: PENDING → AT_VENDOR → DONE → QC_PASSED.
    A failed QC sends the step back to PENDING for rework."""

    __tablename__ = "work_order_ops"
    __table_args__ = (UniqueConstraint("work_order_id", "seq"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    work_order_id: Mapped[int] = mapped_column(ForeignKey("work_orders.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    operation: Mapped[str] = mapped_column(String(120))
    work_center: Mapped[str | None] = mapped_column(String(80))
    mode: Mapped[str] = mapped_column(String(10))  # IN_HOUSE, OUTSIDE
    setup_min: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0)
    run_min: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=0)
    outside_days: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="PENDING")  # PENDING, IN_PROGRESS, AT_VENDOR, DONE, QC_PASSED
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("suppliers.id"))
    challan_no: Mapped[str | None] = mapped_column(String(64))  # job-work delivery challan for OUTSIDE steps
    rework_count: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    done_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    qc_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    qc_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    qc_note: Mapped[str | None] = mapped_column(Text)
    work_order: Mapped[WorkOrder] = relationship(back_populates="ops")
    supplier: Mapped[Supplier | None] = relationship(lazy="joined")
