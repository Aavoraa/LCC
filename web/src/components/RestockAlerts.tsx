"use client";

import { AlertTriangle, ArrowRight, Check, ChevronDown, PackageX, Pencil, ShoppingCart, X } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { qty } from "@/lib/format";
import { useApi, useLocalState } from "@/lib/hooks";
import { Button, Card, Input, cx } from "./ui";

export interface AlertItem {
  id: number; item_code: string; name: string; item_type: string; category: string | null; uom: string; location: string | null;
  physical: string; available: string; min_stock: string; max_stock: string; restock_order_qty: string; reorder_level: string; shortfall: string;
  restock_qty: string | null;
}
interface Alerts { out: AlertItem[]; below_min: AlertItem[]; out_count: number; below_min_count: number }

/** Inline editor for one stock-level field of an item. */
function LevelEditor({ itemId, field, label, emptyText, value, uom, onSaved, className, spread }: {
  itemId: number; field: "min_stock" | "restock_order_qty"; label: string; emptyText: string;
  value: string | number; uom: string; onSaved: () => void; className?: string; spread?: boolean;
}) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const current = Number(value);

  if (!editing) {
    return (
      <span className={cx("inline-flex items-center gap-1 text-xs", spread && "flex w-full", className)}>
        <span className={cx("text-muted", spread && "flex-1")}>{label}</span>
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

type EditorProps = { itemId: number; value: string | number; uom: string; onSaved: () => void; className?: string; spread?: boolean };

/** Minimum stock — the level at which a restock warning appears. */
export function MinStockEditor(p: EditorProps) {
  return <LevelEditor {...p} field="min_stock" label="Min" emptyText="not set" />;
}

/** Restock order quantity — what stores orders each time the item reaches its minimum. */
export function OrderQtyEditor(p: EditorProps) {
  return <LevelEditor {...p} field="restock_order_qty" label="Order qty" emptyText="auto (refill)" />;
}

type Kind = "out" | "min";
const KIND: Record<Kind, { label: string; strip: string; text: string; soft: string; bar: string }> = {
  out: { label: "Out of stock", strip: "bg-brand", text: "text-brand", soft: "bg-brand-soft text-brand", bar: "bg-brand" },
  min: { label: "Reached minimum", strip: "bg-warning", text: "text-warning", soft: "bg-warning-soft text-warning", bar: "bg-warning" },
};

function AlertCard({ a, kind, onOpen, onChanged }: { a: AlertItem; kind: Kind; onOpen: () => void; onChanged: () => void }) {
  const k = KIND[kind];
  const min = Number(a.min_stock);
  const avail = Math.max(Number(a.available), 0);
  const pct = min > 0 ? Math.min(100, Math.round((avail / min) * 100)) : 0;
  const restock = a.restock_qty != null ? Number(a.restock_qty) : 0;
  const preset = Number(a.restock_order_qty) > 0;
  const basis = preset ? "set by stores" : `refills to ${Number(a.max_stock) > min ? `max ${qty(a.max_stock)}` : `min ${qty(min)}`}`;
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      className="group relative flex min-w-0 cursor-pointer flex-col overflow-hidden rounded-xl border border-line bg-surface text-left transition hover:-translate-y-0.5 hover:border-line-strong hover:shadow-pop focus-visible:shadow-pop">
      <span className={cx("absolute inset-y-0 left-0 w-1", k.strip)} aria-hidden />
      <div className="flex flex-1 flex-col gap-3 py-3.5 pl-5 pr-4">
        <div className="min-w-0">
          <p className="font-mono text-[11px] text-muted">{a.item_code}{a.location ? ` · ${a.location}` : ""}</p>
          <p className="mt-0.5 truncate text-sm font-semibold text-ink group-hover:text-primary" title={a.name}>{a.name}</p>
        </div>
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span className={cx("tabular text-2xl font-extrabold leading-none", k.text)}>
              {qty(a.available)}<span className="ml-1 text-xs font-medium text-muted">{a.uom}</span>
            </span>
            <span className="tabular text-xs text-muted">{min > 0 ? `of ${qty(min)} min` : "no minimum"}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <div className={cx("h-full rounded-full", k.bar)} style={{ width: `${kind === "out" ? 0 : Math.max(pct, 4)}%` }} />
          </div>
        </div>
        <div className="space-y-1.5 border-t border-line pt-3">
          <MinStockEditor itemId={a.id} value={a.min_stock} uom={a.uom} onSaved={onChanged} spread />
          <OrderQtyEditor itemId={a.id} value={a.restock_order_qty} uom={a.uom} onSaved={onChanged} spread />
        </div>
      </div>
      <div className={cx("flex items-center gap-2 px-4 py-2.5 pl-5 text-xs", k.soft)}>
        <ShoppingCart className="size-3.5 shrink-0" aria-hidden />
        {restock > 0
          ? <span className="min-w-0 flex-1 truncate" title={`Suggested order ${qty(restock)} ${a.uom} (${basis})`}>
              Order <b className="tabular">{qty(restock)} {a.uom}</b> <span className="opacity-75">· {basis}</span>
            </span>
          : <span className="min-w-0 flex-1 truncate">Set a minimum to get early warnings</span>}
      </div>
    </div>
  );
}

const SHOWN = 8;

/** Restock alerts above the inventory table: tabs for out-of-stock items and items at or below their minimum stock. */
export function RestockAlerts({ itemType, onOpen, onFilter, reloadKey, onChanged }: {
  itemType: string; onOpen: (id: number) => void; onFilter: (status: "OUT" | "MIN") => void; reloadKey?: number; onChanged?: () => void;
}) {
  const [open, setOpen] = useLocalState("lm_inv_alerts_open", true);
  const [tab, setTab] = useLocalState<Kind>("lm_inv_alerts_tab", "out");
  const alerts = useApi<Alerts>(`/api/items/restock-alerts?limit=24${itemType ? `&item_type=${itemType}` : ""}&k=${reloadKey ?? 0}`, { pollMs: 30000 });
  const d = alerts.data;
  if (!d) return null;
  const total = d.out_count + d.below_min_count;
  const changed = () => { alerts.reload(); onChanged?.(); };
  const items = (tab === "out" ? d.out : d.below_min).slice(0, SHOWN);
  const count = tab === "out" ? d.out_count : d.below_min_count;
  const tabs: { id: Kind; count: number; icon: React.ReactNode }[] = [
    { id: "out", count: d.out_count, icon: <PackageX className="size-4" aria-hidden /> },
    { id: "min", count: d.below_min_count, icon: <AlertTriangle className="size-4" aria-hidden /> },
  ];

  return (
    <Card className="mb-5 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <button className="flex min-w-0 items-center gap-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="border-l-[3px] border-brand pl-3">
            <span className="block text-base font-extrabold leading-5 text-ink">Restock Alerts</span>
            <span className="block text-xs text-muted">
              {total === 0 ? "Everything is above its minimum stock" : `${total.toLocaleString("en-IN")} items need attention`}
            </span>
          </span>
          <ChevronDown className={cx("size-4 shrink-0 text-muted transition", open && "rotate-180")} aria-hidden />
        </button>
        {open && total > 0 && (
          <div role="tablist" aria-label="Alert type" className="ml-auto flex rounded-full border border-line bg-surface-2 p-1">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={cx("flex h-8 items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold transition-colors",
                  tab === t.id ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink")}>
                <span className={tab === t.id ? KIND[t.id].text : ""}>{t.icon}</span>
                {KIND[t.id].label}
                <span className={cx("tabular rounded-full px-2 text-[11px] font-bold", tab === t.id ? KIND[t.id].soft : "bg-surface-3 text-ink-2")}>
                  {t.count.toLocaleString("en-IN")}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {open && total > 0 && (
        <div className="border-t border-line bg-surface-2/60 px-5 py-4">
          {items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-muted">
              {tab === "out" ? "Nothing is out of stock." : "No item has reached its minimum. Set a minimum on any item (pencil icon) to be warned before it runs out."}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {items.map((a) => <AlertCard key={a.id} a={a} kind={tab} onOpen={() => onOpen(a.id)} onChanged={changed} />)}
            </div>
          )}
          {count > items.length && (
            <div className="mt-4 flex justify-center">
              <button onClick={() => onFilter(tab === "out" ? "OUT" : "MIN")}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-4 py-2 text-[13px] font-semibold text-primary shadow-card hover:bg-primary-soft">
                View all {count.toLocaleString("en-IN")} in table <ArrowRight className="size-3.5" aria-hidden />
              </button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
