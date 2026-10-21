"use client";

import { AlertTriangle, Check, ChevronDown, PackageX, Pencil, X } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { qty } from "@/lib/format";
import { useApi, useLocalState } from "@/lib/hooks";
import { Badge, Button, Card, Input, cx } from "./ui";

export interface AlertItem {
  id: number; item_code: string; name: string; item_type: string; category: string | null; uom: string; location: string | null;
  physical: string; available: string; min_stock: string; max_stock: string; restock_order_qty: string; reorder_level: string; shortfall: string;
  restock_qty: string | null;
}
interface Alerts { out: AlertItem[]; below_min: AlertItem[]; out_count: number; below_min_count: number }

/** Inline editor for one stock-level field of an item. */
function LevelEditor({ itemId, field, label, emptyText, value, uom, onSaved, className }: {
  itemId: number; field: "min_stock" | "restock_order_qty"; label: string; emptyText: string;
  value: string | number; uom: string; onSaved: () => void; className?: string;
}) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const current = Number(value);

  if (!editing) {
    return (
      <span className={cx("inline-flex items-center gap-1 text-xs", className)}>
        <span className="text-muted">{label}</span>
        <span className={cx("tabular font-semibold", current > 0 ? "text-ink" : "font-normal text-muted")}>{current > 0 ? `${qty(current)} ${uom}` : emptyText}</span>
        {can("items.edit") && (
          <button type="button" className="rounded p-0.5 text-muted hover:bg-surface-3 hover:text-primary" aria-label={`Set ${label.toLowerCase()}`}
            onClick={(e) => { e.stopPropagation(); setV(current > 0 ? String(current) : ""); setErr(null); setEditing(true); }}>
            <Pencil className="size-3" />
          </button>
        )}
      </span>
    );
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api(`/api/items/${itemId}`, { method: "PATCH", json: { [field]: v || "0" } });
      setEditing(false); onSaved();
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }

  return (
    <span className={cx("inline-flex flex-col gap-1", className)} onClick={(e) => e.stopPropagation()}>
      <span className="inline-flex items-center gap-1">
        <Input autoFocus type="number" min={0} step="any" className="h-7 w-20 text-xs" value={v} placeholder="0" aria-label={label}
          onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} />
        <span className="text-[11px] text-muted">{uom}</span>
        <Button size="sm" className="h-7 px-1.5" loading={busy} aria-label={`Save ${label.toLowerCase()}`} icon={<Check className="size-3.5" />} onClick={save} />
        <Button size="sm" variant="ghost" className="h-7 px-1.5" aria-label="Cancel" icon={<X className="size-3.5" />} onClick={() => setEditing(false)} />
      </span>
      {err && <span className="text-[11px] text-danger">{err}</span>}
    </span>
  );
}

type EditorProps = { itemId: number; value: string | number; uom: string; onSaved: () => void; className?: string };

/** Minimum stock — the level at which a restock warning appears. */
export function MinStockEditor(p: EditorProps) {
  return <LevelEditor {...p} field="min_stock" label="Min" emptyText="not set" />;
}

/** Restock order quantity — what stores orders each time the item reaches its minimum. */
export function OrderQtyEditor(p: EditorProps) {
  return <LevelEditor {...p} field="restock_order_qty" label="Order qty" emptyText="auto (refill)" />;
}

function AlertCard({ a, kind, onOpen, onChanged }: { a: AlertItem; kind: "out" | "min"; onOpen: () => void; onChanged: () => void }) {
  const min = Number(a.min_stock);
  const avail = Math.max(Number(a.available), 0);
  const pct = min > 0 ? Math.min(100, Math.round((avail / min) * 100)) : 0;
  const restock = a.restock_qty != null ? Number(a.restock_qty) : 0;
  const preset = Number(a.restock_order_qty) > 0;
  const basis = preset ? "set by stores" : `refills to ${Number(a.max_stock) > min ? `max ${qty(a.max_stock)}` : `min ${qty(min)}`}`;
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      className={cx("flex w-60 shrink-0 cursor-pointer flex-col gap-2 rounded-lg border bg-surface p-3 text-left shadow-card transition hover:shadow-pop",
        kind === "out" ? "border-danger/40" : "border-warning/50")}>
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[11px] font-semibold text-primary">{a.item_code}</span>
        {kind === "out" ? <Badge tone="danger" dot>Out of stock</Badge> : <Badge tone="warning" dot>Restock</Badge>}
      </div>
      <p className="line-clamp-2 min-h-[2.5rem] text-[13px] font-medium leading-snug text-ink" title={a.name}>{a.name}</p>
      <div>
        <div className="flex items-baseline justify-between">
          <span className={cx("tabular text-xl font-semibold", kind === "out" ? "text-danger" : "text-warning")}>
            {qty(a.available)} <span className="text-xs font-normal text-muted">{a.uom} left</span>
          </span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div className={cx("h-full rounded-full", kind === "out" ? "bg-danger" : "bg-warning")} style={{ width: `${kind === "out" ? 0 : pct}%` }} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <MinStockEditor itemId={a.id} value={a.min_stock} uom={a.uom} onSaved={onChanged} />
        <OrderQtyEditor itemId={a.id} value={a.restock_order_qty} uom={a.uom} onSaved={onChanged} />
      </div>
      <p className={cx("flex items-start gap-1 text-[11px] leading-snug", kind === "out" ? "text-danger" : "text-warning")}>
        <AlertTriangle className="mt-px size-3 shrink-0" />
        {restock > 0
          ? <span>{kind === "out" ? "Restock now" : "Reached minimum"} — order <b className="tabular">{qty(restock)} {a.uom}</b> ({basis})</span>
          : "Restock now — set a minimum to get early warnings"}
      </p>
    </div>
  );
}

function Row({ title, icon, tone, items, count, kind, onOpen, onViewAll, onChanged, empty }: {
  title: string; icon: React.ReactNode; tone: "danger" | "warning"; items: AlertItem[]; count: number; kind: "out" | "min";
  onOpen: (id: number) => void; onViewAll: () => void; onChanged: () => void; empty: string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className={tone === "danger" ? "text-danger" : "text-warning"}>{icon}</span>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <Badge tone={tone}>{count}</Badge>
        {count > items.length && <button className="ml-auto text-xs font-medium text-primary hover:underline" onClick={onViewAll}>View all {count} in table</button>}
      </div>
      {items.length === 0 ? <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-muted">{empty}</p> : (
        <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
          {items.map((a) => <AlertCard key={a.id} a={a} kind={kind} onOpen={() => onOpen(a.id)} onChanged={onChanged} />)}
        </div>
      )}
    </div>
  );
}

/** Restock alert cards above the inventory table: out-of-stock items and items at or below their minimum stock. */
export function RestockAlerts({ itemType, onOpen, onFilter, reloadKey, onChanged }: {
  itemType: string; onOpen: (id: number) => void; onFilter: (status: "OUT" | "MIN") => void; reloadKey?: number; onChanged?: () => void;
}) {
  const [open, setOpen] = useLocalState("lm_inv_alerts_open", true);
  const alerts = useApi<Alerts>(`/api/items/restock-alerts?limit=24${itemType ? `&item_type=${itemType}` : ""}&k=${reloadKey ?? 0}`, { pollMs: 30000 });
  const d = alerts.data;
  if (!d) return null;
  const total = d.out_count + d.below_min_count;
  const changed = () => { alerts.reload(); onChanged?.(); };

  return (
    <Card className="mb-4">
      <button className="flex w-full items-center gap-2 px-4 py-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <AlertTriangle className={cx("size-4", total ? "text-warning" : "text-success")} />
        <span className="text-sm font-semibold text-ink">Restock alerts</span>
        <span className="text-xs text-muted">
          {total === 0 ? "Everything is above its minimum stock" : `${d.out_count} out of stock · ${d.below_min_count} at or below minimum`}
        </span>
        <ChevronDown className={cx("ml-auto size-4 text-muted transition", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-4 py-3">
          <Row title="Restock warning — reached minimum stock" icon={<AlertTriangle className="size-4" />} tone="warning" kind="min"
            items={d.below_min} count={d.below_min_count} onOpen={onOpen} onViewAll={() => onFilter("MIN")} onChanged={changed}
            empty="No item has reached its minimum. Set a minimum on any item (pencil icon) to be warned before it runs out." />
          <Row title="Out of stock" icon={<PackageX className="size-4" />} tone="danger" kind="out"
            items={d.out} count={d.out_count} onOpen={onOpen} onViewAll={() => onFilter("OUT")} onChanged={changed}
            empty="Nothing is out of stock." />
        </div>
      )}
    </Card>
  );
}
