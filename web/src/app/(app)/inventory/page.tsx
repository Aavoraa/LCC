"use client";

import { Bookmark, Columns3, FileUp, Plus, Printer, Rows3, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ItemPanel } from "@/components/ItemPanel";
import { RestockAlerts } from "@/components/RestockAlerts";
import { Badge, Button, Card, Drawer, EmptyState, ErrorState, Input, PageHeader, Select, Skeleton, StockBadge, Td, Th, cx } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { money, qty } from "@/lib/format";
import { useApi, useLocalState } from "@/lib/hooks";
import { ITEM_TYPES, itemTypeLabel, type Category, type ItemRow, type Location } from "@/lib/types";

const COLUMNS = [
  { key: "qr", label: "QR" }, { key: "category", label: "Category" }, { key: "location", label: "Location" },
  { key: "physical", label: "Physical" }, { key: "reserved", label: "Reserved" }, { key: "qc_hold", label: "QC hold" },
  { key: "available", label: "Available" }, { key: "reorder", label: "Reorder" }, { key: "restock", label: "Restock qty" }, { key: "valuation", label: "Valuation" }, { key: "status", label: "Status" },
] as const;
type ColKey = (typeof COLUMNS)[number]["key"];

interface SavedFilter { name: string; query: string }

export default function InventoryPage() {
  return <Suspense><Inventory /></Suspense>;
}

function Inventory() {
  const { can } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [density, setDensity] = useLocalState<"compact" | "comfortable">("lm_inv_density", "compact");
  const [hidden, setHidden] = useLocalState<ColKey[]>("lm_inv_hidden_cols", ["qc_hold"]);
  const [saved, setSaved] = useLocalState<SavedFilter[]>("lm_inv_saved_filters", []);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [colsOpen, setColsOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [alertsKey, setAlertsKey] = useState(0);

  const type = params.get("type") ?? "";
  const status = params.get("status") ?? "";
  const category = params.get("category") ?? "";
  const location = params.get("location") ?? "";
  const qrFilter = params.get("qr") ?? "";
  const openItem = params.get("item");

  const setParam = useCallback((key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value); else next.delete(key);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [params, pathname, router]);

  // Debounce search box into the URL.
  const qRef = useRef(q);
  useEffect(() => {
    qRef.current = q;
    const t = setTimeout(() => { if ((params.get("q") ?? "") !== qRef.current) setParam("q", qRef.current || null); }, 250);
    return () => clearTimeout(t);
  }, [q, params, setParam]);

  const qParam = params.get("q");
  useEffect(() => setPage(1), [type, status, category, location, qrFilter, qParam]);

  const apiQuery = useMemo(() => {
    const s = new URLSearchParams({ page: String(page), page_size: "50" });
    if (params.get("q")) s.set("q", params.get("q")!);
    if (type) s.set("item_type", type);
    if (status) s.set("stock_status", status);
    if (category) s.set("category_id", category);
    if (location) s.set("location_id", location);
    if (qrFilter) s.set("qr_status", qrFilter);
    return s.toString();
  }, [params, type, status, category, location, qrFilter, page]);

  const list = useApi<{ items: ItemRow[]; total: number }>(`/api/items?${apiQuery}`, { pollMs: 20000 });
  const cats = useApi<Category[]>("/api/masters/categories");
  const locs = useApi<Location[]>("/api/masters/locations");
  const show = (k: ColKey) => !hidden.includes(k);
  const rows = list.data?.items ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const filterQuery = params.toString().replace(/(^|&)item=\d+/, "");
  const cell = density === "compact" ? "h-9" : "h-12";
  const title = type ? `${itemTypeLabel(type)}s` : "Inventory & Stores";

  return (
    <>
      <PageHeader
        title={title}
        description="Live balances from the stock ledger. Available = physical − reserved − quality hold."
        actions={<>
          {can("imports.create") && <Link href="/inventory/import"><Button variant="secondary" icon={<FileUp className="size-4" />}>Import</Button></Link>}
          {can("items.create") && <Link href="/inventory/new"><Button icon={<Plus className="size-4" />}>New item</Button></Link>}
        </>}
      />
      <RestockAlerts itemType={type} reloadKey={alertsKey} onOpen={(id) => setParam("item", String(id))}
        onFilter={(st) => setParam("status", st)} onChanged={list.reload} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code, name, make, model" className="pl-8" aria-label="Search inventory" />
          </div>
          <Select value={type} onChange={(e) => setParam("type", e.target.value || null)} className="w-auto" aria-label="Item type">
            <option value="">All types</option>
            {ITEM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
          <Select value={status} onChange={(e) => setParam("status", e.target.value || null)} className="w-auto" aria-label="Stock status">
            <option value="">Any stock</option><option value="OK">In stock</option><option value="LOW">Low stock</option><option value="MIN">At or below minimum</option><option value="OUT">Out of stock</option>
          </Select>
          <Select value={category} onChange={(e) => setParam("category", e.target.value || null)} className="w-auto" aria-label="Category">
            <option value="">All categories</option>
            {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={location} onChange={(e) => setParam("location", e.target.value || null)} className="w-auto" aria-label="Location">
            <option value="">All locations</option>
            {locs.data?.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}
          </Select>
          <Select value={qrFilter} onChange={(e) => setParam("qr", e.target.value || null)} className="w-auto" aria-label="QR status">
            <option value="">Any QR</option><option value="ACTIVE">Has QR</option><option value="NONE">No QR</option>
          </Select>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" title="Save current filters" icon={<Bookmark className="size-4" />} onClick={() => {
              const name = prompt("Name this filter");
              if (name) setSaved([...saved.filter((s) => s.name !== name), { name, query: filterQuery }]);
            }}>Save</Button>
            <Button variant="ghost" size="sm" onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}
                    icon={<Rows3 className="size-4" />} aria-label={`Switch to ${density === "compact" ? "comfortable" : "compact"} density`}>
              {density === "compact" ? "Compact" : "Comfortable"}
            </Button>
            <div className="relative">
              <Button variant="ghost" size="sm" icon={<Columns3 className="size-4" />} onClick={() => setColsOpen(!colsOpen)} aria-expanded={colsOpen}>Columns</Button>
              {colsOpen && (
                <div className="absolute right-0 top-9 z-20 w-48 rounded-lg border border-line bg-surface p-2 shadow-pop">
                  {COLUMNS.map((c) => (
                    <label key={c.key} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface-3">
                      <input type="checkbox" checked={show(c.key)} onChange={() => setHidden(show(c.key) ? [...hidden, c.key] : hidden.filter((h) => h !== c.key))} />
                      {c.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {saved.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
            <span className="text-xs text-muted">Saved:</span>
            {saved.map((s) => (
              <span key={s.name} className="inline-flex items-center rounded-full border border-line bg-surface-2 text-xs">
                <button className="px-2.5 py-1 hover:text-primary" onClick={() => router.replace(`${pathname}?${s.query}`)}>{s.name}</button>
                <button className="pr-2 text-muted hover:text-danger" aria-label={`Delete saved filter ${s.name}`} onClick={() => setSaved(saved.filter((x) => x.name !== s.name))}><X className="size-3" /></button>
              </span>
            ))}
          </div>
        )}
        {selected.size > 0 && (
          <div className="flex items-center gap-3 border-b border-line bg-primary-soft px-3 py-2 text-sm">
            <span className="font-medium">{selected.size} selected</span>
            {can("qr.generate") && <Link href={`/qr/print?ids=${[...selected].join(",")}`}><Button size="sm" icon={<Printer className="size-4" />}>Print QR labels</Button></Link>}
            <button className="text-muted hover:text-ink" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}

        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-[13px]">
              <thead>
                <tr>
                  <Th className="w-9"><input type="checkbox" aria-label="Select all on page" checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set([...selected, ...rows.map((r) => r.id)]))} /></Th>
                  <Th>Item</Th>
                  {show("qr") && <Th>QR</Th>}
                  {show("category") && <Th>Category</Th>}
                  {show("location") && <Th>Location</Th>}
                  {show("physical") && <Th className="text-right">Physical</Th>}
                  {show("reserved") && <Th className="text-right">Reserved</Th>}
                  {show("qc_hold") && <Th className="text-right">QC hold</Th>}
                  {show("available") && <Th className="text-right">Available</Th>}
                  {show("reorder") && <Th className="text-right">Reorder</Th>}
                  {show("restock") && <Th className="text-right" title="Quantity to order to refill to max stock (or to the minimum when no max is set)">Restock qty</Th>}
                  {show("valuation") && <Th className="text-right">Valuation</Th>}
                  {show("status") && <Th>Status</Th>}
                </tr>
              </thead>
              <tbody>
                {list.loading && !list.data ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}><td colSpan={13} className="px-3 py-2"><Skeleton className="h-5" /></td></tr>
                )) : rows.map((r) => (
                  <tr key={r.id} onClick={() => setParam("item", String(r.id))}
                      className={cx("cursor-pointer hover:bg-surface-2", String(r.id) === openItem && "bg-primary-soft/50", selected.has(r.id) && "bg-primary-soft/30")}>
                    <Td className={cell} onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${r.item_code}`} checked={selected.has(r.id)} onChange={() => {
                        const s = new Set(selected); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); setSelected(s);
                      }} />
                    </Td>
                    <Td className={cell}>
                      <span className="font-mono text-xs font-semibold text-primary">{r.item_code}</span>
                      <span className="ml-2 font-medium text-ink">{r.name}</span>
                      {density === "comfortable" && <span className="block text-xs text-muted">{itemTypeLabel(r.item_type)} · {r.uom}</span>}
                    </Td>
                    {show("qr") && <Td>{r.qr_status === "ACTIVE" ? <Badge tone="success">Active</Badge> : <Badge tone="warning">None</Badge>}</Td>}
                    {show("category") && <Td className="text-xs">{r.category ?? "—"}</Td>}
                    {show("location") && <Td className="font-mono text-xs">{r.location ?? "—"}</Td>}
                    {show("physical") && <Td className="tabular text-right">{qty(r.physical)}</Td>}
                    {show("reserved") && <Td className="tabular text-right text-muted">{qty(r.reserved)}</Td>}
                    {show("qc_hold") && <Td className="tabular text-right text-muted">{qty(r.qc_hold)}</Td>}
                    {show("available") && <Td className="tabular text-right font-semibold text-ink">{qty(r.available)} <span className="text-[11px] font-normal text-muted">{r.uom}</span></Td>}
                    {show("reorder") && <Td className="tabular text-right text-muted">{qty(r.reorder_level)}</Td>}
                    {show("restock") && <Td className="tabular text-right" title={r.restock_qty != null ? `Min ${qty(r.min_stock)} · max ${qty(r.max_stock)}` : undefined}>
                      {r.restock_qty != null && Number(r.restock_qty) > 0
                        ? <span className={cx("font-semibold", r.stock_status === "OUT" ? "text-danger" : "text-warning")}>{qty(r.restock_qty)} <span className="text-[11px] font-normal text-muted">{r.uom}</span></span>
                        : <span className="text-muted">—</span>}
                    </Td>}
                    {show("valuation") && <Td className="tabular text-right">{money(r.valuation)}</Td>}
                    {show("status") && <Td><StockBadge status={r.stock_status} /></Td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {list.data && rows.length === 0 && (
              <EmptyState title="No items match" description="Adjust the filters, or add an item to the master."
                          action={can("items.create") && <Link href="/inventory/new"><Button icon={<Plus className="size-4" />}>New item</Button></Link>} />
            )}
          </div>
        )}
        {list.data && list.data.total > 50 && (
          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-muted">
            <span>{(page - 1) * 50 + 1}–{Math.min(page * 50, list.data.total)} of {list.data.total}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <Button size="sm" variant="secondary" disabled={page * 50 >= list.data.total} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </div>
        )}
      </Card>
      <Drawer open={!!openItem} onClose={() => setParam("item", null)} title="Item details">
        {openItem && <ItemPanel key={openItem} itemId={Number(openItem)} onChanged={() => { list.reload(); setAlertsKey((k) => k + 1); }} />}
      </Drawer>
    </>
  );
}
