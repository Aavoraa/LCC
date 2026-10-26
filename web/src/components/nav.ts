import {
  Banknote, BarChart3, Boxes, ClipboardCheck, ClipboardList, Cog, Cpu, Factory, FileScan, FileSpreadsheet, FileText, Gauge, History, Layers, LayoutGrid,
  MapPin, Mic, Package, QrCode, Route, ScanLine,
  ShoppingCart, Sparkles, Truck, Users, Wrench, type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  perm?: string[];
  /** Spec phase that delivers this module, when it is not built yet. */
  planned?: string;
}

export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Overview",
    items: [
      { label: "Executive Dashboard", href: "/", icon: Gauge, perm: ["dashboard.view"] },
      { label: "Order Tracker", href: "/tracker", icon: Route, perm: ["production.view"] },
      { label: "Sales & Enquiries", href: "/sales", icon: Sparkles, perm: ["sales.availability"] },
    ],
  },
  {
    section: "Inventory",
    items: [
      { label: "Inventory Overview", href: "/inventory/overview", icon: LayoutGrid, perm: ["stock.view"] },
      { label: "Inventory & Stores", href: "/inventory", icon: Boxes, perm: ["items.view"] },
      { label: "Machines & SOP Spares", href: "/machines", icon: Cpu, perm: ["items.view"] },
      { label: "Scan & Transact", href: "/scan", icon: ScanLine, perm: ["items.view"] },
      { label: "Item Locator", href: "/locator", icon: MapPin, perm: ["stock.view"] },
      { label: "QR Code Management", href: "/qr", icon: QrCode, perm: ["qr.generate"] },
      { label: "Raw Materials", href: "/inventory?type=RAW_MATERIAL", icon: Layers, perm: ["items.view"] },
      { label: "Purchased Items", href: "/inventory?type=PURCHASED_ITEM", icon: Package, perm: ["items.view"] },
      { label: "Daily Consumables", href: "/inventory?type=DAILY_CONSUMABLE", icon: Package, perm: ["items.view"] },
      { label: "Processed Spares", href: "/inventory?type=PROCESSED_SPARE", icon: Wrench, perm: ["items.view"] },
      { label: "Stock Ledger", href: "/stock/ledger", icon: History, perm: ["stock.view"] },
      { label: "Adjustments", href: "/stock/adjustments", icon: ClipboardCheck, perm: ["stock.view"] },
      { label: "Cycle Counts", href: "/inventory/cycle-counts", icon: ClipboardList, perm: ["stock.view"] },
    ],
  },
  {
    section: "Operations",
    items: [
      { label: "Procurement & Suppliers", href: "/purchase", icon: ShoppingCart, perm: ["purchase.view"] },
      { label: "Production & Planning", href: "/production", icon: Factory, perm: ["production.view"] },
      { label: "OSP Delivery Challans", href: "/production/challans", icon: FileText, perm: ["production.view"] },
      { label: "Quality Control", href: "/qc", icon: ClipboardCheck, perm: ["qc.hold", "stock.view"] },
    ],
  },
  {
    section: "Finance",
    items: [
      { label: "Accounts & Finance", href: "/planned/accounts", icon: Banknote, planned: "Phase 6" },
      { label: "Invoice Scanner", href: "/documents", icon: FileScan, perm: ["stock.view"] },
      { label: "Reports & Analytics", href: "/reports", icon: BarChart3, perm: ["stock.view"] },
      { label: "Voice Stock Report", href: "/reports/voice", icon: Mic, perm: ["stock.view"] },
      { label: "Production Details", href: "/reports/production", icon: FileSpreadsheet, perm: ["production.view"] },
    ],
  },
  {
    section: "Administration",
    items: [
      { label: "Users, Roles & Settings", href: "/settings", icon: Users, perm: ["users.manage", "audit.view"] },
      { label: "Audit Trail", href: "/audit", icon: Cog, perm: ["audit.view"] },
    ],
  },
];

export const QUICK_CREATE = [
  { label: "New item", href: "/inventory/new", perm: ["items.create"], icon: Package },
  { label: "Scan & transact", href: "/scan", perm: ["items.view"], icon: ScanLine },
  { label: "Locate an item", href: "/locator", perm: ["stock.view"], icon: MapPin },
  { label: "Sales enquiry", href: "/sales", perm: ["sales.enquiry"], icon: Sparkles },
  { label: "Import inventory", href: "/inventory/import", perm: ["imports.create"], icon: Truck },
  { label: "Purchase order", href: "/purchase", perm: ["purchase.manage"], icon: ShoppingCart },
  { label: "Scan a document", href: "/documents", perm: ["purchase.manage", "stock.receive", "production.manage"], icon: FileScan },
];
