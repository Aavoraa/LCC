"use client";

import { ClipboardList, PackageCheck, Plus, Send, Truck, XCircle } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateFmt, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import type { Location } from "@/lib/types";
import { Alert, Badge, Button, Card, Drawer, EmptyState, ErrorState, Field, Input, Modal, Select, Spinner, Td, Th, cx } from "../ui";

type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";
export interface PadRow {
  id: number; number: string; status: string; so_id: number; so_number: string; customer: string; customer_po_ref: string | null;
  committed_date: string | null; required_date: string | null; item_code: string; item_name: string; quantity: string;
  machine: { id: number; code: string } | null; lines_total: number; counts: Record<string, number>; notes: string | null;
  created_at: string; released_at: string | null;
}
interface PadLine {
  id: number; line_no: number; item_id: number | null; item_code: string | null; name: string; group: string | null; item_type: string | null;
  uom: string | null; location_id: number | null; qty_required: string; qty_issued: string; status: string; available: string | null;
  shortage: string; open_qty: string;
  requisition: { number: string; kind: string; status: string } | null;
  work_order: { id: number; number: string; status: string } | null;
}
interface PadDetail extends PadRow { lines: PadLine[] }
interface Candidate { so_line_id: number; so_number: string; line_no: number; customer: string; item_code: string; item_name: string; quantity: string; item_type: string; customer_po_ref: string | null }

export const PAD_TONE: Record<string, Tone> = { DRAFT: "neutral", RELEASED: "primary", ISSUED: "success", CANCELLED: "danger" };
const LINE_TONE: Record<string, Tone> = { ISSUED: "success", AVAILABLE: "info", SHORT: "warning", NOT_IN_STORE: "danger" };
const LINE_LABEL: Record<string, string> = { ISSUED: "Issued", AVAILABLE: "In stores", SHORT: "Short", NOT_IN_STORE: "Not in stores" };

/** Planning & Design WIP/PAD documents: raised against a sales order, released to Stores, issued to assembly. */
export function PadsPanel({ onOpenWorkOrder, openPad, onOpenPad, newPadLine, onNewPadDone }: {
  onOpenWorkOrder: (id: number) => void; openPad: number | null; onOpenPad: (id: number | null) => void;
  newPadLine?: number | null; onNewPadDone?: () => void;
}) {
  const { can } = useAuth();
  const pads = useApi<PadRow[]>("/api/pads", { pollMs: 30000 });
  const open = openPad, setOpen = onOpenPad;
  const [creatingState, setCreating] = useState(false);
  const creating = creatingState || (newPadLine != null && can("pad.manage"));
  const closeCreate = () => { setCreating(false); onNewPadDone?.(); };

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">WIP / PAD documents</h2>
            <p className="text-xs text-muted">Parts list per sales order from the machine&apos;s standard SOP — released to Stores, issued to assembly.</p>
          </div>
          {can("pad.manage") && <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New WIP/PAD</Button>}
        </div>
        {pads.error ? <ErrorState error={pads.error} onRetry={pads.reload} /> : !pads.data ? <Spinner /> : pads.data.length === 0 ? (
          <EmptyState icon={<ClipboardList className="size-5" />} title="No WIP/PAD yet"
            description="Raise one against a confirmed sales order to start Stores verification and production." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-[13px]">
              <thead><tr><Th>PAD</Th><Th>Sales order</Th><Th>Building</Th><Th className="text-right">Qty</Th><Th>Parts</Th><Th>Committed</Th><Th>Status</Th></tr></thead>
              <tbody>
                {pads.data.map((p) => (
                  <tr key={p.id} className="cursor-pointer hover:bg-surface-2" onClick={() => setOpen(p.id)}>
                    <Td className="py-2.5 font-mono text-xs font-semibold text-primary">{p.number}</Td>
                    <Td className="py-2.5"><span className="font-medium">{p.so_number}</span><span className="block text-xs text-muted">{p.customer}{p.customer_po_ref && ` · PO ${p.customer_po_ref}`}</span></Td>
                    <Td className="py-2.5">{p.item_name}<span className="block font-mono text-[11px] text-muted">{p.item_code}{p.machine && ` · ${p.machine.code}`}</span></Td>
                    <Td className="tabular py-2.5 text-right">{qty(p.quantity)}</Td>
                    <Td className="py-2.5"><LineCounts counts={p.counts} total={p.lines_total} /></Td>
                    <Td className="py-2.5 text-xs">{dateFmt(p.committed_date ?? p.required_date)}</Td>
                    <Td className="py-2.5"><Badge tone={PAD_TONE[p.status]}>{p.status.toLowerCase()}</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Drawer open={open != null} onClose={() => setOpen(null)} title="WIP / PAD" width="max-w-4xl">
        {open != null && <PadDetailView id={open} onChanged={pads.reload} onOpenWorkOrder={onOpenWorkOrder} />}
      </Drawer>
      {creating && <CreatePadModal initialLine={newPadLine ?? null} onClose={closeCreate} onCreated={(id) => { closeCreate(); pads.reload(); setOpen(id); }} />}
    </>
  );
}

function LineCounts({ counts, total }: { counts: Record<string, number>; total: number }) {
  return (
    <span className="flex flex-wrap gap-1">
      <span className="text-xs text-muted">{total} lines</span>
      {(["ISSUED", "AVAILABLE", "SHORT", "NOT_IN_STORE"] as const).map((k) => counts[k] ? <Badge key={k} tone={LINE_TONE[k]}>{counts[k]} {LINE_LABEL[k].toLowerCase()}</Badge> : null)}
    </span>
  );
}

function CreatePadModal({ initialLine, onClose, onCreated }: { initialLine: number | null; onClose: () => void; onCreated: (id: number) => void }) {
  const cands = useApi<Candidate[]>("/api/pads/candidates");
  const [lineId, setLineId] = useState(initialLine ? String(initialLine) : "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function create() {
    setBusy(true); setErr(null);
    try { onCreated((await api<PadDetail>("/api/pads", { method: "POST", json: { so_line_id: Number(lineId), notes: notes || null } })).id); }
    catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="New WIP/PAD from sales order"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!lineId} onClick={create}>Create WIP/PAD</Button></>}>
      {err && <div className="mb-3"><Alert>{err}</Alert></div>}
      <Field label="Confirmed sales order line" required hint="A machine expands into its standard SOP parts list; a spare is a single line.">
        <Select value={lineId} onChange={(e) => setLineId(e.target.value)}>
          <option value="">{cands.data ? (cands.data.length ? "Select…" : "No confirmed order without a PAD") : "Loading…"}</option>
          {cands.data?.map((c) => (
            <option key={c.so_line_id} value={c.so_line_id}>{c.so_number} · {c.customer} · {c.item_name} × {qty(c.quantity)}</option>
          ))}
        </Select>
      </Field>
      <Field label="Notes" className="mt-3"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Model / spec, drawing revision…" /></Field>
    </Modal>
  );
}

function PadDetailView({ id, onChanged, onOpenWorkOrder }: { id: number; onChanged: () => void; onOpenWorkOrder: (id: number) => void }) {
  const { can } = useAuth();
  const pad = useApi<PadDetail>(`/api/pads/${id}`);
  const locs = useApi<Location[]>("/api/masters/locations");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState("");
  const [issue, setIssue] = useState<Record<number, { q: string; loc: string }>>({});

  if (pad.error) return <ErrorState error={pad.error} onRetry={pad.reload} />;
  const p = pad.data;
  if (!p) return <Spinner />;

  async function act(key: string, fn: () => Promise<unknown>, ok: (r: unknown) => string) {
    setBusy(key); setMsg(null);
    try { const r = await fn(); setMsg({ ok: true, text: ok(r) }); pad.reload(); onChanged(); }
    catch (e) { setMsg({ ok: false, text: (e as ApiError).message }); } finally { setBusy(null); }
  }
  const rows = p.lines.filter((l) => !filter || l.status === filter);

  return (
    <div className="divide-y divide-line">
      <section className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-primary">{p.number}</span>
          <Badge tone={PAD_TONE[p.status]}>{p.status.toLowerCase()}</Badge>
        </div>
        <h2 className="mt-1 text-lg font-semibold">{p.item_name} × {qty(p.quantity)}</h2>
        <p className="text-sm text-muted">
          {p.so_number} · {p.customer}{p.customer_po_ref && ` · customer PO ${p.customer_po_ref}`} · deliver by {dateFmt(p.committed_date ?? p.required_date)}
        </p>
        {p.notes && <p className="mt-1 text-sm text-ink-2">{p.notes}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {p.status === "DRAFT" && can("pad.manage") && (
            <Button size="sm" icon={<Send className="size-4" />} loading={busy === "release"}
              onClick={() => act("release", () => api(`/api/pads/${id}/release`, { method: "POST" }), () => "Released to Stores")}>Release to Stores</Button>
          )}
          {p.status === "RELEASED" && (can("machines.requisition") || can("pad.manage")) && (
            <Button size="sm" icon={<PackageCheck className="size-4" />} loading={busy === "short"}
              onClick={() => act("short", () => api<{ purchase: unknown[]; production: unknown[]; not_in_store: string[] }>(`/api/pads/${id}/shortages`, { method: "POST" }),
                (r) => { const x = r as { purchase: unknown[]; production: unknown[]; not_in_store: string[] };
                  return `${x.purchase.length} purchase requisition(s) and ${x.production.length} work order(s) raised${x.not_in_store.length ? `; ${x.not_in_store.length} line(s) not in stores` : ""}`; })}>
              Raise shortages
            </Button>
          )}
          {(p.status === "DRAFT" || p.status === "RELEASED") && can("pad.manage") && (
            <Button size="sm" variant="ghost" icon={<XCircle className="size-4" />} loading={busy === "cancel"} onClick={() => {
              const reason = prompt("Reason for cancelling this PAD");
              if (reason) act("cancel", () => api(`/api/pads/${id}/cancel`, { method: "POST", json: { reason } }), () => "PAD cancelled");
            }}>Cancel</Button>
          )}
        </div>
        {msg && <div className="mt-3"><Alert tone={msg.ok ? "success" : "danger"}>{msg.text}</Alert></div>}
      </section>

      <section className="px-5 py-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Parts ({p.lines_total})</h3>
          <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8 w-40 text-xs" aria-label="Filter lines">
            <option value="">All lines</option>
            {Object.entries(LINE_LABEL).map(([k, v]) => <option key={k} value={k}>{v} ({p.counts[k] ?? 0})</option>)}
          </Select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead><tr><Th>#</Th><Th>Part</Th><Th className="text-right">Required</Th><Th className="text-right">Issued</Th><Th className="text-right">In stores</Th><Th>Status</Th><Th>Requisition / work order</Th><Th className="text-right">Issue to assembly</Th></tr></thead>
            <tbody>
              {rows.map((l) => {
                const open = Number(l.open_qty);
                const canIssue = can("stock.issue") && (p.status === "RELEASED" || p.status === "ISSUED") && l.item_id && open > 0 && Number(l.available ?? 0) > 0;
                const f = issue[l.id] ?? { q: String(Math.min(open, Number(l.available ?? 0))), loc: String(l.location_id ?? "") };
                return (
                  <tr key={l.id} className="border-t border-line align-top">
                    <Td className="py-2 font-mono text-xs text-muted">{l.line_no}</Td>
                    <Td className="py-2"><span className="font-medium text-ink">{l.name}</span>
                      <span className="block font-mono text-[11px] text-muted">{l.item_code ?? "not linked to stores"}{l.group && ` · ${l.group.toLowerCase()}`}</span></Td>
                    <Td className="tabular py-2 text-right">{qty(l.qty_required)} <span className="text-[11px] text-muted">{l.uom}</span></Td>
                    <Td className="tabular py-2 text-right">{qty(l.qty_issued)}</Td>
                    <Td className={cx("tabular py-2 text-right", l.status === "SHORT" && "text-warning")}>{l.available == null ? "—" : qty(l.available)}</Td>
                    <Td className="py-2"><Badge tone={LINE_TONE[l.status]}>{LINE_LABEL[l.status]}</Badge></Td>
                    <Td className="py-2 text-xs">
                      {l.requisition && <span className="block">{l.requisition.number} <span className="text-muted">{l.requisition.kind.toLowerCase()} · {l.requisition.status.toLowerCase().replace("_", " ")}</span></span>}
                      {l.work_order && <button className="font-medium text-primary hover:underline" onClick={() => onOpenWorkOrder(l.work_order!.id)}>{l.work_order.number} ({l.work_order.status.toLowerCase().replace("_", " ")})</button>}
                      {!l.requisition && !l.work_order && <span className="text-muted">—</span>}
                    </Td>
                    <Td className="py-2">
                      {canIssue ? (
                        <div className="flex justify-end gap-1">
                          <Input type="number" min={0} step="any" className="h-8 w-16 text-xs" value={f.q} aria-label="Issue quantity"
                            onChange={(e) => setIssue({ ...issue, [l.id]: { ...f, q: e.target.value } })} />
                          <Select className="h-8 w-28 text-xs" value={f.loc} aria-label="From location" onChange={(e) => setIssue({ ...issue, [l.id]: { ...f, loc: e.target.value } })}>
                            <option value="">From…</option>{locs.data?.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
                          </Select>
                          <Button size="sm" className="h-8" icon={<Truck className="size-3.5" />} loading={busy === `i${l.id}`} disabled={!f.loc || !(Number(f.q) > 0)}
                            onClick={() => act(`i${l.id}`, () => api(`/api/pads/${id}/lines/${l.id}/issue`, { method: "POST", json: { quantity: f.q, location_id: Number(f.loc) } }),
                              () => `Issued ${f.q} ${l.uom} of ${l.item_code} to assembly`)}>Issue</Button>
                        </div>
                      ) : <span className="block text-right text-xs text-muted">{open <= 0 ? "Done" : "—"}</span>}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
