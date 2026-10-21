from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer

from .models import ItemType, MovementType, TrackingMode, ValuationMethod

# Decimals travel as strings to avoid float rounding in clients.
Dec = Annotated[Decimal, PlainSerializer(lambda v: format(Decimal(v).normalize(), "f"), return_type=str, when_used="json")]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------- auth
class LoginIn(BaseModel):
    username: str
    password: str


class RoleOut(ORM):
    code: str
    name: str


class UserOut(ORM):
    id: int
    username: str
    full_name: str
    email: str | None
    is_active: bool
    roles: list[RoleOut]


class MeOut(UserOut):
    permissions: list[str]


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: MeOut


# ---------------------------------------------------------------- masters
class UomOut(ORM):
    id: int
    code: str
    name: str
    decimals: int


class CategoryOut(ORM):
    id: int
    name: str
    parent_id: int | None


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    parent_id: int | None = None


class SupplierIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    gstin: str | None = Field(default=None, pattern=r"^[0-9]{2}[A-Z0-9]{13}$")
    address: str | None = None
    phone: str | None = None
    email: str | None = None
    lead_time_days: int = Field(default=14, ge=0, le=365)


class SupplierOut(ORM):
    id: int
    code: str
    name: str
    gstin: str | None
    lead_time_days: int


class CustomerIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    gstin: str | None = Field(default=None, pattern=r"^[0-9]{2}[A-Z0-9]{13}$")
    address: str | None = None
    city: str | None = None
    phone: str | None = None
    email: str | None = None
    transport_days: int = Field(default=2, ge=0, le=60)


class CustomerOut(ORM):
    id: int
    code: str
    name: str
    city: str | None
    transport_days: int


class WarehouseOut(ORM):
    id: int
    code: str
    name: str


class LocationOut(ORM):
    id: int
    code: str
    rack: str
    bin: str
    warehouse: WarehouseOut


class LocationIn(BaseModel):
    warehouse_id: int
    rack: str = Field(min_length=1, max_length=16)
    bin: str = Field(min_length=1, max_length=16)


# ---------------------------------------------------------------- items
class ItemIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    description: str | None = None
    item_type: ItemType
    category_id: int | None = None
    subcategory_id: int | None = None
    uom_id: int
    manufacturer: str | None = None
    supplier_id: int | None = None
    make_model: str | None = None
    specifications: str | None = None
    min_stock: Decimal = Field(default=Decimal(0), ge=0)
    reorder_level: Decimal = Field(default=Decimal(0), ge=0)
    max_stock: Decimal = Field(default=Decimal(0), ge=0)
    restock_order_qty: Decimal = Field(default=Decimal(0), ge=0)
    default_location_id: int | None = None
    tracking: TrackingMode = TrackingMode.NONE
    valuation_method: ValuationMethod = ValuationMethod.WEIGHTED_AVERAGE
    hsn_code: str | None = Field(default=None, pattern=r"^[0-9]{4,8}$")
    gst_rate: Decimal | None = Field(default=None, ge=0, le=28)
    purchase_lead_days: int | None = Field(default=None, ge=0, le=365)
    production_lead_days: int = Field(default=0, ge=0, le=365)


class ItemCreateIn(ItemIn):
    allow_duplicate: bool = False
    opening_qty: Decimal | None = Field(default=None, gt=0)
    opening_unit_cost: Decimal | None = Field(default=None, ge=0)


class ItemUpdateIn(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=200)
    description: str | None = None
    category_id: int | None = None
    subcategory_id: int | None = None
    manufacturer: str | None = None
    supplier_id: int | None = None
    make_model: str | None = None
    specifications: str | None = None
    min_stock: Decimal | None = Field(default=None, ge=0)
    reorder_level: Decimal | None = Field(default=None, ge=0)
    max_stock: Decimal | None = Field(default=None, ge=0)
    restock_order_qty: Decimal | None = Field(default=None, ge=0)
    default_location_id: int | None = None
    hsn_code: str | None = Field(default=None, pattern=r"^[0-9]{4,8}$")
    gst_rate: Decimal | None = Field(default=None, ge=0, le=28)
    purchase_lead_days: int | None = Field(default=None, ge=0, le=365)
    production_lead_days: int | None = Field(default=None, ge=0, le=365)
    is_active: bool | None = None


class ItemOut(ORM):
    id: int
    item_code: str
    name: str
    description: str | None
    item_type: ItemType
    category: CategoryOut | None
    subcategory: CategoryOut | None
    uom: UomOut
    manufacturer: str | None
    supplier: SupplierOut | None
    make_model: str | None
    specifications: str | None
    min_stock: Dec
    reorder_level: Dec
    max_stock: Dec
    restock_order_qty: Dec
    default_location: LocationOut | None
    tracking: TrackingMode
    valuation_method: ValuationMethod
    hsn_code: str | None
    gst_rate: Dec | None
    purchase_lead_days: int | None
    production_lead_days: int
    avg_cost: Dec
    is_active: bool
    created_at: datetime


class ItemRow(BaseModel):
    """Inventory table row with live balances."""

    id: int
    item_code: str
    name: str
    item_type: ItemType
    category: str | None
    uom: str
    location: str | None
    qr_status: str
    physical: Dec
    reserved: Dec
    qc_hold: Dec
    available: Dec
    reorder_level: Dec
    valuation: Dec
    stock_status: str  # OK, LOW, OUT
    min_stock: Dec = Decimal(0)
    max_stock: Dec = Decimal(0)
    restock_order_qty: Dec = Decimal(0)
    restock_qty: Dec | None = None  # to refill to max (or min) when out of stock / at minimum


class DuplicateOut(BaseModel):
    item_id: int
    item_code: str
    name: str
    make_model: str | None
    score: float
    reason: str


class BalanceOut(ORM):
    location: LocationOut
    qty_on_hand: Dec
    qty_reserved: Dec
    qty_qc_hold: Dec
    qty_available: Dec


class ItemDetailOut(BaseModel):
    item: ItemOut
    balances: list[BalanceOut]
    totals: dict[str, Dec | None]  # on_hand, reserved, qc_hold, available, valuation, restock_qty
    qr: QrOut | None


class QrOut(ORM):
    id: int
    token: str
    status: str
    generation: int
    batch_no: str | None
    serial_no: str | None
    created_at: datetime
    printed_count: int
    content: str


class QrRegenerateIn(BaseModel):
    reason: str = Field(min_length=5)


class LabelOut(BaseModel):
    item_id: int
    item_code: str
    name: str
    uom: str
    location: str | None
    token: str
    content: str
    svg: str
    created: bool


class LabelsIn(BaseModel):
    item_ids: list[int] = Field(min_length=1, max_length=500)
    mark_printed: bool = False


class ResolveOut(BaseModel):
    kind: str  # "item" or "location"
    qr: QrOut
    item: ItemOut | None = None
    balances: list[BalanceOut] = []
    totals: dict[str, Dec | None] = {}
    location: LocationOut | None = None


# ---------------------------------------------------------------- stock
class MovementIn(BaseModel):
    txn_uuid: str = Field(min_length=8, max_length=64, description="Client-generated idempotency key")
    movement_type: MovementType
    item_id: int
    quantity: Decimal = Field(gt=0, max_digits=18, decimal_places=4)
    from_location_id: int | None = None
    to_location_id: int | None = None
    unit_cost: Decimal | None = Field(default=None, ge=0)
    ref_doc_type: str | None = Field(default=None, max_length=32)
    ref_doc_no: str | None = Field(default=None, max_length=64)
    batch_no: str | None = None
    notes: str | None = Field(default=None, max_length=1000)
    source: str = Field(default="web", pattern=r"^(web|android|import)$")
    device_captured_at: datetime | None = None
    into_qc_hold: bool = False


class MovementOut(ORM):
    id: int
    number: str
    txn_uuid: str
    movement_type: MovementType
    item_id: int
    item_code: str
    item_name: str
    from_location: str | None
    to_location: str | None
    quantity: Dec
    unit_cost: Dec
    value: Dec
    ref_doc_type: str | None
    ref_doc_no: str | None
    notes: str | None
    source: str
    created_by: str
    created_at: datetime


class MovementResult(BaseModel):
    movement: MovementOut
    created: bool
    totals: dict[str, Dec | None]


class AdjustmentIn(BaseModel):
    item_id: int
    location_id: int
    qty_delta: Decimal
    reason: str = Field(min_length=5, max_length=1000)


class DecisionIn(BaseModel):
    approve: bool
    note: str | None = None


class AdjustmentOut(BaseModel):
    id: int
    number: str
    item_code: str
    item_name: str
    location: str
    qty_delta: Dec
    reason: str
    status: str
    requested_by: str
    decided_by: str | None
    decision_note: str | None
    created_at: datetime


# ---------------------------------------------------------------- purchasing & sales
class POLineIn(BaseModel):
    item_id: int
    qty_ordered: Decimal = Field(gt=0)
    unit_price: Decimal = Field(ge=0)
    expected_date: date


class POIn(BaseModel):
    supplier_id: int
    lines: list[POLineIn] = Field(min_length=1)


class POLineOut(BaseModel):
    id: int
    item_id: int
    item_code: str
    item_name: str
    qty_ordered: Dec
    qty_received: Dec
    unit_price: Dec
    expected_date: date


class POOut(BaseModel):
    id: int
    number: str
    supplier: str
    status: str
    order_date: date
    total: Dec
    lines: list[POLineOut]


class EnquiryIn(BaseModel):
    customer_id: int
    reference: str | None = None
    item_id: int
    quantity: Decimal = Field(gt=0)
    required_date: date | None = None
    customer_location: str | None = None
    notes: str | None = None


class EstimateIn(BaseModel):
    item_id: int
    quantity: Decimal = Field(gt=0)
    customer_id: int | None = None
    required_date: date | None = None


class EnquiryOut(BaseModel):
    id: int
    number: str
    customer: str
    reference: str | None
    item_code: str
    item_name: str
    quantity: Dec
    required_date: date | None
    estimated_date: date | None
    risk: str | None
    status: str
    created_at: datetime
    estimate: dict | None


# ---------------------------------------------------------------- imports
class ImportRowOut(ORM):
    id: int
    row_no: int
    raw: dict
    mapped: dict
    status: str
    errors: list
    duplicate_item_id: int | None
    resolution: str | None
    result_item_id: int | None


class ImportBatchOut(BaseModel):
    id: int
    number: str
    filename: str
    status: str
    headers: list[str]
    mapping: dict
    summary: dict
    uploaded_by: str
    uploaded_by_id: int
    created_at: datetime
    fields: dict
    rows: list[ImportRowOut] | None = None


class MappingIn(BaseModel):
    mapping: dict[str, str]


class ResolveRowIn(BaseModel):
    resolution: str
    link_item_id: int | None = None


ItemDetailOut.model_rebuild()


# ---------------------------------------------------------------- quotations, sales orders, requisitions
class QuotationIn(BaseModel):
    enquiry_id: int
    unit_price: Decimal = Field(ge=0)
    valid_days: int = Field(30, ge=1, le=365)
    notes: str | None = None


class QuotationStatusIn(BaseModel):
    status: str = Field(pattern="^(SENT|ACCEPTED|REJECTED)$")


class QuotationOut(BaseModel):
    id: int
    number: str
    enquiry_id: int
    enquiry_number: str
    customer: str
    item_id: int
    item_code: str
    item_name: str
    uom: str
    quantity: Dec
    unit_price: Dec
    amount: Dec
    valid_until: date | None
    preliminary_date: date | None
    risk: str | None
    status: str
    notes: str | None
    created_at: datetime
    sales_order_id: int | None = None


class SalesOrderIn(BaseModel):
    quotation_id: int | None = None
    enquiry_id: int | None = None
    customer_po_ref: str | None = None
    required_date: date | None = None
    notes: str | None = None


class SOLineOut(BaseModel):
    id: int
    line_no: int
    item_id: int
    item_code: str
    item_name: str
    uom: str
    quantity: Dec
    unit_price: Dec
    qty_reserved: Dec
    qty_issued: Dec
    qty_shortage: Dec
    forecast_date: date | None
    forecast: dict | None


class RequisitionOut(BaseModel):
    id: int
    number: str
    kind: str
    item_id: int
    item_code: str
    item_name: str
    uom: str
    quantity: Dec
    required_date: date | None
    status: str
    so_number: str | None
    so_line_id: int | None
    po_line_id: int | None
    po_number: str | None
    notes: str | None
    created_at: datetime


class SalesOrderOut(BaseModel):
    id: int
    number: str
    customer: str
    customer_id: int
    enquiry_number: str | None
    quotation_number: str | None
    customer_po_ref: str | None
    status: str
    required_date: date | None
    preliminary_date: date | None
    forecast_date: date | None
    forecast_risk: str | None
    forecast_updated_at: datetime | None
    at_risk: bool
    commit_status: str
    proposed_commit_date: date | None
    commit_requested_by: str | None
    commit_requested_by_id: int | None
    committed_date: date | None
    commit_approved_by: str | None
    commit_note: str | None
    total: Dec
    created_at: datetime
    confirmed_at: datetime | None
    lines: list[SOLineOut]
    requisitions: list[RequisitionOut] = []


class CommitRequestIn(BaseModel):
    committed_date: date
    note: str | None = None


class CommitDecisionIn(BaseModel):
    approve: bool
    note: str | None = None


class CancelIn(BaseModel):
    reason: str


class POLineUpdateIn(BaseModel):
    expected_date: date
    reason: str = Field(min_length=3)


class RequisitionConvertIn(BaseModel):
    supplier_id: int | None = None
    unit_price: Decimal = Field(0, ge=0)
    expected_date: date | None = None
