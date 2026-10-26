export type ItemType = "RAW_MATERIAL" | "PURCHASED_ITEM" | "DAILY_CONSUMABLE" | "PROCESSED_SPARE" | "FINISHED_GOOD" | "SERVICE";
export type MovementType =
  | "OPENING" | "RECEIPT" | "ISSUE" | "TRANSFER" | "RETURN" | "ADJUSTMENT_IN" | "ADJUSTMENT_OUT" | "QC_HOLD" | "QC_RELEASE";

export const ITEM_TYPES: { value: ItemType; label: string }[] = [
  { value: "RAW_MATERIAL", label: "Raw Material" },
  { value: "PURCHASED_ITEM", label: "Purchased Item" },
  { value: "DAILY_CONSUMABLE", label: "Daily Consumable" },
  { value: "PROCESSED_SPARE", label: "Processed Spare" },
  { value: "FINISHED_GOOD", label: "Finished Good" },
  { value: "SERVICE", label: "Service" },
];
export const itemTypeLabel = (t: string) => ITEM_TYPES.find((x) => x.value === t)?.label ?? t;

export interface Me {
  id: number;
  username: string;
  full_name: string;
  email: string | null;
  roles: { code: string; name: string }[];
  permissions: string[];
}

export interface Uom { id: number; code: string; name: string; decimals: number }
export interface Category { id: number; name: string; parent_id: number | null }
export interface Location { id: number; code: string; rack: string; bin: string; warehouse: { id: number; code: string; name: string } }
export interface Supplier { id: number; code: string; name: string; gstin: string | null; lead_time_days: number }
export interface Customer { id: number; code: string; name: string; city: string | null; transport_days: number }

export interface Item {
  id: number;
  item_code: string;
  name: string;
  description: string | null;
  item_type: ItemType;
  category: Category | null;
  subcategory: Category | null;
  uom: Uom;
  manufacturer: string | null;
  supplier: Supplier | null;
  make_model: string | null;
  specifications: string | null;
  min_stock: string;
  reorder_level: string;
  max_stock: string;
  restock_order_qty: string;
  default_location: Location | null;
  tracking: string;
  valuation_method: string;
  hsn_code: string | null;
  gst_rate: string | null;
  purchase_lead_days: number | null;
  production_lead_days: number;
  avg_cost: string;
  is_active: boolean;
  created_at: string;
}

export interface Qr { id: number; token: string; status: string; generation: number; content: string; printed_count: number; created_at: string }
export interface Balance { location: Location; qty_on_hand: string; qty_reserved: string; qty_qc_hold: string; qty_available: string }
export interface Totals { on_hand: string; reserved: string; qc_hold: string; available: string; valuation: string; restock_qty?: string | null }
export interface ItemDetail { item: Item; balances: Balance[]; totals: Totals; qr: Qr | null }

export interface ItemRow {
  id: number;
  item_code: string;
  name: string;
  item_type: ItemType;
  category: string | null;
  uom: string;
  location: string | null;
  qr_status: "ACTIVE" | "NONE";
  physical: string;
  reserved: string;
  qc_hold: string;
  available: string;
  reorder_level: string;
  valuation: string;
  stock_status: "OK" | "LOW" | "OUT";
  min_stock: string;
  max_stock: string;
  restock_order_qty: string;
  restock_qty: string | null;
}

export interface Movement {
  id: number;
  number: string;
  txn_uuid: string;
  movement_type: MovementType;
  item_id: number;
  item_code: string;
  item_name: string;
  from_location: string | null;
  to_location: string | null;
  quantity: string;
  unit_cost: string;
  value: string;
  ref_doc_type: string | null;
  ref_doc_no: string | null;
  notes: string | null;
  source: string;
  created_by: string;
  created_at: string;
}

export interface Label { item_id: number; item_code: string; name: string; uom: string; location: string | null; token: string; content: string; svg: string; created: boolean }

export interface Resolve {
  kind: "item" | "location";
  qr: Qr;
  item: Item | null;
  balances: Balance[];
  totals: Totals;
  location: Location | null;
}

export interface Estimate {
  preliminary: boolean;
  estimated_date: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  meets_required_date: boolean | null;
  steps: { step: string; days: number; owner: string; complete_by: string }[];
  assumptions: string[];
  critical_dependencies: string[];
  availability: {
    item_code: string;
    item_name: string;
    uom: string;
    physical: string;
    reserved: string;
    quality_hold: string;
    available_to_promise: string;
    incoming_total: string;
    incoming: { po_number: string; supplier: string; open_qty: string; expected_date: string }[];
    committed_demand: { ref: string; quantity: string }[];
    shortage: string;
  };
}

// ---------------------------------------------------------------- sales orders (Phase 5)
export interface Enquiry {
  id: number; number: string; customer: string; reference: string | null; item_code: string; item_name: string; quantity: string;
  required_date: string | null; estimated_date: string | null; risk: string | null; status: string; created_at: string;
}

export interface Quotation {
  id: number; number: string; enquiry_id: number; enquiry_number: string; customer: string; item_id: number; item_code: string;
  item_name: string; uom: string; quantity: string; unit_price: string; amount: string; valid_until: string | null;
  preliminary_date: string | null; risk: string | null; status: string; notes: string | null; created_at: string; sales_order_id: number | null;
}

export interface ForecastStep { step: string; days: number; owner: string; complete_by: string }
export interface LineForecast {
  estimated_date: string; risk: "LOW" | "MEDIUM" | "HIGH"; meets_required_date: boolean | null; steps: ForecastStep[];
  assumptions: string[]; critical_dependencies: string[]; uncovered_qty: string;
  pegged_supply: { source: string; open_qty: string; expected_date: string; po_number?: string; supplier?: string; label?: string }[];
}

export interface SOLine {
  id: number; line_no: number; item_id: number; item_code: string; item_name: string; uom: string; quantity: string; unit_price: string;
  qty_reserved: string; qty_issued: string; qty_shortage: string; forecast_date: string | null; forecast: LineForecast | null;
}

// ---------------------------------------------------------------- item locator
export interface LocatorFind {
  kind: "item" | "location" | "search";
  location: string | null;
  item_id: number | null;
  warning: string | null;
  candidates: { id: number; item_code: string; name: string; item_type: ItemType; uom: string; location: string | null }[];
}

export interface PurchaseLine {
  po_id: number; po_number: string; status: string; supplier: string; order_date: string; expected_date: string;
  qty_ordered: string; qty_received: string; qty_open: string; unit_price: string; amount: string;
}

export interface QtyFigures { on_hand: string; reserved: string; qc_hold: string; available: string }
export interface ItemHistory extends ItemDetail {
  stock_status: "OK" | "LOW" | "OUT";
  below_min: boolean;
  quantities: {
    organization: string; on_hand: string; receiving_inbound: string; qc_hold: string; uom_name: string; category: string | null;
    subinventories: (QtyFigures & { code: string; name: string; locators: (QtyFigures & { code: string; rack: string; bin: string })[] })[];
  };
  purchase: {
    lines: PurchaseLine[]; count: number; total_ordered: string; total_received: string; open_qty: string; total_amount: string;
    last_price: string | null; avg_price: string | null; min_price: string | null; max_price: string | null; suppliers: string[];
  };
  movement_summary: {
    count: number; first_at: string | null; opening: string; received: string; issued: string; returned: string;
    adjusted_in: string; adjusted_out: string; transferred: string; last_receipt: Movement | null; last_issue: Movement | null;
  };
  movements: Movement[];
  reservations: { ref_doc_type: string; ref_doc_no: string; location: string; qty_open: string; created_at: string }[];
  sales_orders: { so_id: number; so_number: string; customer: string; status: string; quantity: string; qty_issued: string; forecast_date: string | null }[];
  requisitions: { number: string; kind: string; quantity: string; status: string; required_date: string | null; created_at: string }[];
  work_orders: { number: string; quantity: string; qty_completed: string; status: string; required_date: string | null }[];
  machines: { machine_id: number; code: string; name: string; qty_per_machine: string; sop_stock: string }[];
}

export interface Requisition {
  id: number; number: string; kind: "PURCHASE" | "PRODUCTION"; item_id: number; item_code: string; item_name: string; uom: string;
  quantity: string; required_date: string | null; status: string; so_number: string | null; so_line_id: number | null;
  po_line_id: number | null; po_number: string | null; notes: string | null; created_at: string;
}

export interface SalesOrder {
  id: number; number: string; customer: string; customer_id: number; enquiry_number: string | null; quotation_number: string | null;
  customer_po_ref: string | null; status: string; required_date: string | null; preliminary_date: string | null;
  forecast_date: string | null; forecast_risk: string | null; forecast_updated_at: string | null; at_risk: boolean;
  commit_status: "NONE" | "PENDING" | "APPROVED" | "REJECTED"; proposed_commit_date: string | null; commit_requested_by: string | null;
  commit_requested_by_id: number | null; committed_date: string | null; commit_approved_by: string | null; commit_note: string | null;
  total: string; created_at: string; confirmed_at: string | null; lines: SOLine[]; requisitions: Requisition[];
}
