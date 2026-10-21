"use client";

import { Download, Printer, QrCode, RefreshCw, ScanLine } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError, download } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateTime, isInbound, isOutbound, money, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { itemTypeLabel, type ItemDetail, type Movement } from "@/lib/types";
import { pushRecent } from "./CommandPalette";
import { MovementBadge } from "./MovementBadge";
import { ProcessRoute } from "./ProcessRoute";
import { MinStockEditor, OrderQtyEditor } from "./RestockAlerts";
import { QrImage } from "./QrImage";
import { Alert, Badge, Button, ErrorState, Field, Input, Modal, Spinner, cx } from "./ui";

export function ItemPanel({ itemId, onChanged }: { itemId: number; onChanged?: () => void }) {
  const { can } = useAuth();
  const detail = useApi<ItemDetail>(`/api/items/${itemId}`);
  const moves = useApi<Movement[]>(can("stock.view") ? `/api/items/${itemId}/movements?limit=50` : null);
  const [regenOpen, setRegenOpen] = useState(false);

  useEffect(() => {
    if (detail.data) pushRecent({ label: `${detail.data.item.item_code} · ${detail.data.item.name}`, href: `/inventory?item=${itemId}`, sub: "Item" });
  }, [detail.data, itemId]);

  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Spinner />;
  const { item, totals, balances, qr } = detail.data;

  return (
    <div className="divide-y divide-line">
      <section className="px-5 py-4">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold text-primary">{item.item_code}</span>
              <Badge tone="primary">{itemTypeLabel(item.item_type)}</Badge>
              {!item.is_active && <Badge tone="danger">Inactive</Badge>}
            </div>
            <h2 className="mt-1 text-lg font-semibold leading-snug">{item.name}</h2>
            {item.description && <p className="mt-1 text-sm text-muted">{item.description}</p>}
          </div>
          {qr && <QrImage itemId={item.id} token={qr.token} className="size-24 shrink-0 rounded-md border border-line bg-white p-1" />}
        </div>
        <div className="mt-4 grid grid-cols-4 gap-2 rounded-lg bg-surface-2 p-3 text-center">
          {[["Physical", totals.on_hand], ["Reserved", totals.reserved], ["QC hold", totals.qc_hold], ["Available", totals.available]].map(([l, v]) => (
            <div key={l}>
              <p className="text-[11px] text-muted">{l}</p>
              <p className={cx("tabular text-base font-semibold", l === "Available" && "text-success")}>{qty(v)}</p>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <MinStockEditor itemId={item.id} value={item.min_stock} uom={item.uom.code} onSaved={() => { detail.reload(); onChanged?.(); }} />
          <OrderQtyEditor itemId={item.id} value={item.restock_order_qty} uom={item.uom.code} onSaved={() => { detail.reload(); onChanged?.(); }} />
          {Number(item.min_stock) > 0 && Number(totals.on_hand) > 0 && Number(totals.available) <= Number(item.min_stock) && (
            <Badge tone="warning" dot>Reached minimum — restock</Badge>
          )}
          {Number(totals.on_hand) <= 0 && <Badge tone="danger" dot>Out of stock</Badge>}
          {totals.restock_qty != null && Number(totals.restock_qty) > 0 && (
            <span className="text-xs" title="Refills to max stock, or to the minimum when no higher max is set">
              <span className="text-muted">Restock qty</span>{" "}
              <span className={cx("tabular font-semibold", Number(totals.on_hand) <= 0 ? "text-danger" : "text-warning")}>{qty(totals.restock_qty)} {item.uom.code}</span>
              <span className="text-muted"> ({Number(item.restock_order_qty) > 0 ? "set by stores" : `to ${Number(item.max_stock) > Number(item.min_stock) ? `max ${qty(item.max_stock)}` : `min ${qty(item.min_stock)}`}`})</span>
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">
          {item.uom.name} · valuation {money(totals.valuation)} at {money(item.avg_cost, true)} avg · reorder at {qty(item.reorder_level)}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={`/scan?item=${item.id}`}><Button size="sm" icon={<ScanLine className="size-4" />}>Transact</Button></Link>
          {qr && (
            <>
              <Button size="sm" variant="secondary" icon={<Download className="size-4" />} onClick={() => download(`/api/items/${item.id}/qr.png?scale=12`, `${item.item_code}.png`)}>PNG</Button>
              <Button size="sm" variant="secondary" icon={<Download className="size-4" />} onClick={() => download(`/api/items/${item.id}/qr.svg`, `${item.item_code}.svg`)}>SVG</Button>
            </>
          )}
          {can("qr.generate") && (
            <>
              <Link href={`/qr/print?ids=${item.id}`}><Button size="sm" variant="secondary" icon={<Printer className="size-4" />}>Print label</Button></Link>
              <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => setRegenOpen(true)}>Regenerate QR</Button>
            </>
          )}
        </div>
      </section>

      <section className="px-5 py-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Stock by location</h3>
        {balances.length === 0 ? <p className="text-sm text-muted">No stock recorded.</p> : (
          <table className="w-full text-[13px]">
            <thead className="text-left text-[11px] text-muted"><tr><th className="py-1 font-medium">Location</th><th className="text-right font-medium">On hand</th><th className="text-right font-medium">Reserved</th><th className="text-right font-medium">QC</th><th className="text-right font-medium">Available</th></tr></thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.location.id} className="border-t border-line">
                  <td className="py-1.5 font-mono text-xs">{b.location.code}</td>
                  <td className="tabular text-right">{qty(b.qty_on_hand)}</td>
                  <td className="tabular text-right">{qty(b.qty_reserved)}</td>
                  <td className="tabular text-right">{qty(b.qty_qc_hold)}</td>
                  <td className="tabular text-right font-medium">{qty(b.qty_available)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="px-5 py-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Details</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
          {[
            ["Category", [item.category?.name, item.subcategory?.name].filter(Boolean).join(" / ")],
            ["Default location", item.default_location?.code],
            ["Manufacturer", item.manufacturer], ["Make / model", item.make_model],
            ["Supplier", item.supplier?.name], ["HSN / GST", [item.hsn_code, item.gst_rate && `${Number(item.gst_rate)}%`].filter(Boolean).join(" · ")],
            ["Min / reorder / max", `${qty(item.min_stock)} / ${qty(item.reorder_level)} / ${qty(item.max_stock)}`],
            ["Tracking", item.tracking.toLowerCase()], ["Valuation", item.valuation_method.replace("_", " ").toLowerCase()],
            ["Purchase lead", item.purchase_lead_days ? `${item.purchase_lead_days} days` : "Supplier default"],
            ...(item.item_type === "PROCESSED_SPARE" || item.item_type === "FINISHED_GOOD"
              ? [["Production lead", item.production_lead_days ? `${item.production_lead_days} working days` : "Not set"]] : []),
          ].map(([k, v]) => (
            <div key={k as string}><dt className="text-[11px] text-muted">{k}</dt><dd className="text-ink-2">{v || "—"}</dd></div>
          ))}
        </dl>
        {item.specifications && <p className="mt-3 whitespace-pre-wrap rounded bg-surface-2 p-2.5 text-xs text-ink-2">{item.specifications}</p>}
      </section>

      {(item.item_type === "PROCESSED_SPARE" || item.item_type === "FINISHED_GOOD") && (
        <ProcessRoute itemId={item.id} uom={item.uom.code} onChanged={() => { detail.reload(); onChanged?.(); }} />
      )}

      {can("stock.view") && (
        <section className="px-5 py-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Stock movement timeline</h3>
          {!moves.data ? <Spinner /> : moves.data.length === 0 ? <p className="text-sm text-muted">No movements yet.</p> : (
            <ol className="relative space-y-3 border-l border-line pl-4">
              {moves.data.map((m) => (
                <li key={m.id} className="relative">
                  <span className={cx("absolute -left-[21px] top-1.5 size-2.5 rounded-full ring-4 ring-surface",
                    isInbound(m.movement_type) ? "bg-success" : isOutbound(m.movement_type) ? "bg-danger" : "bg-primary")} />
                  <div className="flex flex-wrap items-center gap-2">
                    <MovementBadge type={m.movement_type} />
                    <span className="tabular text-sm font-semibold">{isOutbound(m.movement_type) ? "−" : isInbound(m.movement_type) ? "+" : ""}{qty(m.quantity)} {item.uom.code}</span>
                    <span className="text-xs text-muted">{[m.from_location, m.to_location].filter(Boolean).join(" → ")}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {m.number} · {m.ref_doc_type ? `${m.ref_doc_type.replace(/_/g, " ").toLowerCase()} ${m.ref_doc_no} · ` : ""}{m.created_by} · {dateTime(m.created_at)}
                    {m.source === "android" && " · Android"}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      <RegenerateModal open={regenOpen} onClose={() => setRegenOpen(false)} itemId={item.id} onDone={() => { detail.reload(); onChanged?.(); }} />
    </div>
  );
}

function RegenerateModal({ open, onClose, itemId, onDone }: { open: boolean; onClose: () => void; itemId: number; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open={open} onClose={onClose} title="Regenerate QR code"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={busy} disabled={reason.trim().length < 5} icon={<QrCode className="size-4" />} onClick={async () => {
          setBusy(true); setErr(null);
          try {
            await api(`/api/items/${itemId}/qr/regenerate`, { method: "POST", json: { reason } });
            onDone(); onClose(); setReason("");
          } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
        }}>Revoke & regenerate</Button>
      </>}>
      <div className="space-y-3">
        <Alert tone="warning">The current label stops working immediately. The item code and stock history stay the same — reprint and replace the physical label.</Alert>
        {err && <Alert>{err}</Alert>}
        <Field label="Reason" required hint="Recorded in the audit trail"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Label damaged in rack R02" /></Field>
      </div>
    </Modal>
  );
}
