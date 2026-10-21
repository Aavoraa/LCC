"use client";

import { AlertTriangle, Ban, CalendarCheck, CheckCircle2, ClipboardList, PackageCheck, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { Alert, Badge, Button, Card, CardHeader, Drawer, EmptyState, Field, Input, RiskBadge, Spinner, Td, Textarea, Th, cx } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateFmt, dateTime, money, qty } from "@/lib/format";
import { useApi, type Query } from "@/lib/hooks";
import type { SalesOrder } from "@/lib/types";

const SO_TONE: Record<string, "neutral" | "primary" | "success" | "danger"> = { DRAFT: "neutral", CONFIRMED: "primary", COMPLETED: "success", CANCELLED: "danger" };
const COMMIT_TONE: Record<string, "neutral" | "warning" | "success" | "danger"> = { NONE: "neutral", PENDING: "warning", APPROVED: "success", REJECTED: "danger" };

export function OrdersPanel({ orders, openId, onOpen }: { orders: Query<SalesOrder[]>; openId: number | null; onOpen: (id: number | null) => void }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Sales orders" subtitle="Preliminary estimate, rule-based forecast and approved commitment are tracked separately" />
      {!orders.data ? <Spinner /> : orders.data.length === 0 ? (
        <EmptyState icon={<ClipboardList className="size-5" />} title="No sales orders yet" description="Convert an accepted quotation, or an open enquiry, into an order." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-[13px]">
            <thead><tr><Th>Order</Th><Th>Customer</Th><Th>Item</Th><Th className="text-right">Reserved / Qty</Th><Th>Required</Th><Th>Preliminary</Th><Th>Forecast</Th><Th>Committed</Th><Th>Status</Th></tr></thead>
            <tbody>{orders.data.map((so) => {
              const l = so.lines[0];
              return (
                <tr key={so.id} className={cx("h-11 cursor-pointer hover:bg-surface-2", so.at_risk && "bg-danger-soft/40")} onClick={() => onOpen(so.id)}>
                  <Td><span className="font-mono text-xs text-primary">{so.number}</span>{so.quotation_number && <p className="text-[11px] text-muted">{so.quotation_number}</p>}</Td>
                  <Td className="text-ink">{so.customer}</Td>
                  <Td>{l && <><span className="font-mono text-xs">{l.item_code}</span> {l.item_name}</>}{so.lines.length > 1 && <span className="text-muted"> +{so.lines.length - 1}</span>}</Td>
                  <Td className="tabular text-right">{l && <>{qty(l.qty_reserved)} / {qty(l.quantity)} <span className="text-muted">{l.uom}</span></>}</Td>
                  <Td>{dateFmt(so.required_date)}</Td>
                  <Td className="text-muted">{dateFmt(so.preliminary_date)}</Td>
                  <Td><span className="flex items-center gap-1.5">{dateFmt(so.forecast_date)} {so.at_risk && <AlertTriangle className="size-3.5 text-danger" aria-label="At risk" />}</span></Td>
                  <Td>{so.committed_date ? <b>{dateFmt(so.committed_date)}</b> : so.commit_status === "PENDING" ? <Badge tone="warning">pending</Badge> : "—"}</Td>
                  <Td><Badge tone={SO_TONE[so.status]}>{so.status.toLowerCase()}</Badge></Td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {openId != null && <OrderDrawer id={openId} onClose={() => onOpen(null)} onChanged={orders.reload} />}
    </Card>
  );
}

function OrderDrawer({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { can, user } = useAuth();
  const so = useApi<SalesOrder>(`/api/sales/orders/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [commitDate, setCommitDate] = useState("");
  const [note, setNote] = useState("");
  const [cancelReason, setCancelReason] = useState<string | null>(null);

  async function act(key: string, path: string, json?: unknown) {
    setBusy(key); setErr(null);
    try { await api(`/api/sales/orders/${id}/${path}`, { method: "POST", json: json ?? {} }); so.reload(); onChanged(); setNote(""); setCancelReason(null); }
    catch (e) { setErr((e as ApiError).message); } finally { setBusy(null); }
  }

  const o = so.data;
  const canApprove = o && can("sales.commit_approve") && o.commit_requested_by_id !== user?.id;
  return (
    <Drawer open onClose={onClose} width="max-w-2xl" title={o ? <span className="flex items-center gap-2">{o.number} <Badge tone={SO_TONE[o.status]}>{o.status.toLowerCase()}</Badge></span> : "Sales order"}>
      {!o ? <Spinner /> : (
        <div className="space-y-5 p-5">
          {err && <Alert>{err}</Alert>}
          {o.at_risk && (
            <Alert tone="danger" title="At risk of late delivery">
              Forecast {dateFmt(o.forecast_date)} is later than the {o.committed_date ? "committed" : "required"} date {dateFmt(o.committed_date ?? o.required_date)}.
            </Alert>
          )}
          <div className="text-sm">
            <p className="font-medium text-ink">{o.customer}</p>
            <p className="text-xs text-muted">{[o.enquiry_number, o.quotation_number, o.customer_po_ref && `Customer PO ${o.customer_po_ref}`].filter(Boolean).join(" · ")} · {money(o.total)}</p>
          </div>

          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
            {[
              ["Required", o.required_date, "Customer's date"],
              ["Preliminary", o.preliminary_date, "From quotation · not binding"],
              ["Forecast", o.forecast_date, o.forecast_updated_at ? `Rule-based · ${dateTime(o.forecast_updated_at)}` : "Calculated on confirmation"],
              ["Committed", o.committed_date, o.commit_status === "APPROVED" ? `Approved by ${o.commit_approved_by}` : o.commit_status === "PENDING" ? `Proposed ${dateFmt(o.proposed_commit_date)}` : "Needs approval"],
            ].map(([label, d, sub]) => (
              <div key={label} className="bg-surface p-3">
                <p className="text-xs text-muted">{label}</p>
                <p className={cx("mt-0.5 font-semibold", label === "Committed" && o.committed_date && "text-success", label === "Forecast" && o.at_risk && "text-danger")}>{dateFmt(d)}</p>
                <p className="mt-0.5 text-[11px] text-muted">{sub}</p>
              </div>
            ))}
          </div>

          {o.lines.map((l) => (
            <Card key={l.id} className="overflow-hidden">
              <CardHeader title={<><span className="font-mono text-xs text-primary">{l.item_code}</span> {l.item_name}</>}
                subtitle={`Line ${l.line_no} · ${qty(l.quantity)} ${l.uom} @ ${money(l.unit_price, true)}`} actions={<RiskBadge risk={l.forecast?.risk} />} />
              <dl className="grid grid-cols-4 divide-x divide-line text-center text-sm">
                {[["Reserved", l.qty_reserved, "text-success"], ["Short", l.qty_shortage, Number(l.qty_shortage) > 0 ? "text-danger" : ""], ["Issued", l.qty_issued, ""], ["Uncovered", l.forecast?.uncovered_qty ?? "0", Number(l.forecast?.uncovered_qty ?? 0) > 0 ? "text-danger" : ""]].map(([k, v, c]) => (
                  <div key={k} className="p-2.5"><dt className="text-[11px] text-muted">{k}</dt><dd className={cx("tabular font-semibold", c)}>{qty(v)}</dd></div>
                ))}
              </dl>
              {l.forecast && (
                <div className="border-t border-line">
                  <table className="w-full text-[12.5px]">
                    <thead><tr><Th>Forecast step</Th><Th>Owner</Th><Th className="text-right">Days</Th><Th>Complete by</Th></tr></thead>
                    <tbody>{l.forecast.steps.map((s) => (
                      <tr key={s.step}><Td className="h-8 text-ink">{s.step}</Td><Td>{s.owner}</Td><Td className="tabular text-right">{s.days}</Td><Td className="tabular">{dateFmt(s.complete_by)}</Td></tr>
                    ))}</tbody>
                  </table>
                  {l.forecast.critical_dependencies.length > 0 && (
                    <ul className="list-disc space-y-0.5 px-4 py-2.5 pl-8 text-xs text-ink-2">{l.forecast.critical_dependencies.map((d) => <li key={d}>{d}</li>)}</ul>
                  )}
                </div>
              )}
            </Card>
          ))}

          {o.requisitions.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted">Shortage requisitions</p>
              <ul className="divide-y divide-line rounded-lg border border-line text-sm">
                {o.requisitions.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span><span className="font-mono text-xs">{r.number}</span> · {r.kind.toLowerCase()} {qty(r.quantity)} {r.uom}{r.po_number && <span className="text-muted"> → {r.po_number}</span>}</span>
                    <Badge tone={r.status === "OPEN" ? "warning" : r.status === "ORDERED" ? "primary" : "neutral"}>{r.status.toLowerCase()}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ------------------------------------------------ actions */}
          {o.status === "DRAFT" && can("sales.order") && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 p-3">
              <p className="text-xs text-muted">Confirming re-validates stock, reserves free quantity atomically and raises requisitions for shortages.</p>
              <Button icon={<CheckCircle2 className="size-4" />} loading={busy === "confirm"} onClick={() => act("confirm", "confirm")}>Confirm order</Button>
            </div>
          )}

          {o.status === "CONFIRMED" && (
            <div className="space-y-3 rounded-lg border border-line p-3">
              <p className="flex items-center gap-2 text-sm font-medium"><CalendarCheck className="size-4 text-primary" /> Delivery commitment <Badge tone={COMMIT_TONE[o.commit_status]}>{o.commit_status.toLowerCase()}</Badge></p>
              {o.commit_status === "PENDING" ? (
                <div className="space-y-2">
                  <p className="text-sm">{o.commit_requested_by} proposed <b>{dateFmt(o.proposed_commit_date)}</b>{o.commit_note && <span className="text-muted"> — {o.commit_note}</span>}</p>
                  {canApprove ? (
                    <div className="flex flex-wrap items-end gap-2">
                      <Field label="Decision note" className="min-w-48 flex-1"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                      <Button variant="success" icon={<ShieldCheck className="size-4" />} loading={busy === "approve"} onClick={() => act("approve", "commit-decision", { approve: true, note: note || null })}>Approve</Button>
                      <Button variant="secondary" icon={<X className="size-4" />} loading={busy === "reject"} onClick={() => act("reject", "commit-decision", { approve: false, note: note || null })}>Reject</Button>
                    </div>
                  ) : <p className="text-xs text-muted">Awaiting approval by a different user with commitment-approval rights.</p>}
                </div>
              ) : can("sales.order") ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Date to commit" hint={o.forecast_date ? `Not earlier than the forecast ${dateFmt(o.forecast_date)}` : undefined}>
                    <Input type="date" className="w-44" min={o.forecast_date ?? undefined} value={commitDate} onChange={(e) => setCommitDate(e.target.value)} />
                  </Field>
                  <Field label="Note" className="min-w-40 flex-1"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                  <Button disabled={!commitDate} loading={busy === "commit"} onClick={() => act("commit", "commit-request", { committed_date: commitDate, note: note || null })}>
                    {o.committed_date ? "Request new date" : "Request approval"}
                  </Button>
                </div>
              ) : null}
            </div>
          )}

          {o.status === "CONFIRMED" && can("sales.order") && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" icon={<PackageCheck className="size-3.5" />} loading={busy === "allocate"} onClick={() => act("allocate", "allocate")}>Allocate free stock</Button>
              <Button variant="secondary" size="sm" icon={<RefreshCw className="size-3.5" />} loading={busy === "recalc"} onClick={() => act("recalc", "recalculate")}>Recalculate forecast</Button>
            </div>
          )}

          {(o.status === "DRAFT" || o.status === "CONFIRMED") && can("sales.order") && (
            cancelReason === null ? (
              <Button variant="ghost" size="sm" icon={<Ban className="size-3.5" />} onClick={() => setCancelReason("")}>Cancel order…</Button>
            ) : (
              <div className="space-y-2 rounded-lg border border-danger/30 p-3">
                <Field label="Reason for cancelling" hint="Releases reservations and cancels open requisitions"><Textarea rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} /></Field>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setCancelReason(null)}>Keep order</Button>
                  <Button variant="danger" size="sm" disabled={cancelReason.trim().length < 5} loading={busy === "cancel"} onClick={() => act("cancel", "cancel", { reason: cancelReason })}>Cancel order</Button>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </Drawer>
  );
}
