"use client";

import { Building2, CheckCircle2, Factory, FileText, Hammer, PackagePlus, Play, Plus, Send, ShieldCheck, ShieldX, Square, Undo2, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateFmt, dateTime, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import type { ItemRow, Location, Supplier } from "@/lib/types";
import { ItemPicker } from "../ItemPicker";
import { Alert, Badge, Button, Card, Drawer, EmptyState, ErrorState, Field, Input, Modal, Select, Spinner, Tabs, Td, Th, cx } from "../ui";

type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";
interface WoBrief {
  id: number; number: string; status: string; item_id: number; item_code: string; item_name: string; item_type: string; uom: string;
  location_id: number | null; quantity: string; qty_completed: string; pad_number: string | null; requisition_number: string | null;
  requisition_status: string | null; so_number: string | null; required_date: string | null; ops_total: number; ops_passed: number;
  current_step: { seq: number; operation: string; mode: string; status: string } | null; outside_steps: number; created_at: string;
}
interface Op {
  seq: number; operation: string; work_center: string | null; mode: "IN_HOUSE" | "OUTSIDE"; setup_min: string; run_min: string;
  outside_days: number; status: string; supplier: { id: number; name: string } | null; challan_no: string | null; challan_id: number | null; rework_count: number;
  started_at: string | null; done_at: string | null; done_by: string | null; qc_at: string | null; qc_by: string | null; qc_note: string | null;
}
interface WoDetail extends WoBrief {
  notes: string | null; started_at: string | null;
  estimate: { in_house_hours: string; in_house_days: number; outside_days: number; total_days: number } | null;
  ops: Op[]; movements: { number: string; type: string; item_code: string; item_name: string; quantity: string; created_at: string }[];
}
interface SendForm {
  seq: number; supplier: string; challan: string; process_nature: string; po_number: string; po_date: string;
  vehicle_no: string; transporter: string; waybill_no: string; expected_return_date: string;
}
interface OpenReq { id: number; number: string; item_code: string; item_name: string; uom: string; quantity: string; required_date: string | null; so_number: string | null }

export const WO_TONE: Record<string, Tone> = { OPEN: "neutral", IN_PROGRESS: "primary", COMPLETED: "success", CANCELLED: "danger" };
const OP_TONE: Record<string, Tone> = { PENDING: "neutral", IN_PROGRESS: "primary", AT_VENDOR: "warning", DONE: "info", QC_PASSED: "success" };
const OP_LABEL: Record<string, string> = { PENDING: "Pending", IN_PROGRESS: "In progress", AT_VENDOR: "At vendor", DONE: "Awaiting QC", QC_PASSED: "QC passed" };

/** Production work orders: each follows the item's process route, in-house and outside steps, with QC per step. */
export function WorkOrdersPanel({ openId, onOpen }: { openId: number | null; onOpen: (id: number | null) => void }) {
  const { can } = useAuth();
  const [view, setView] = useState<"active" | "done" | "all">("active");
  const status = view === "active" ? "OPEN,IN_PROGRESS" : view === "done" ? "COMPLETED,CANCELLED" : "";
  const wos = useApi<WoBrief[]>(`/api/work-orders${status ? `?status=${status}` : ""}`, { pollMs: 20000 });
  const reqs = useApi<OpenReq[]>("/api/work-orders/open-requisitions", { pollMs: 30000 });
  const [creating, setCreating] = useState(false);

  return (
    <>
      {reqs.data && reqs.data.length > 0 && (
        <Card className="mb-4">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-sm font-semibold">Production requisitions waiting for a work order <Badge tone="warning">{reqs.data.length}</Badge></h2>
          </div>
          <div className="flex gap-3 overflow-x-auto p-3">
            {reqs.data.slice(0, 20).map((r) => (
              <div key={r.id} className="w-60 shrink-0 rounded-lg border border-line p-3 text-[13px]">
                <p className="font-mono text-[11px] text-muted">{r.number}{r.so_number && ` · ${r.so_number}`}</p>
                <p className="mt-0.5 line-clamp-2 min-h-[2.5rem] font-medium">{r.item_name}</p>
                <p className="tabular text-xs text-muted">{qty(r.quantity)} {r.uom}{r.required_date && ` · by ${dateFmt(r.required_date)}`}</p>
                {can("production.manage") && (
                  <Button size="sm" className="mt-2 w-full" icon={<Hammer className="size-3.5" />} onClick={async () => {
                    try { const wo = await api<WoBrief>("/api/work-orders", { method: "POST", json: { requisition_id: r.id } }); reqs.reload(); wos.reload(); onOpen(wo.id); }
                    catch (e) { alert((e as ApiError).message); }
                  }}>Create work order</Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
          <Tabs value={view} onChange={setView} className="border-0" tabs={[{ id: "active", label: "Active" }, { id: "done", label: "Completed / cancelled" }, { id: "all", label: "All" }]} />
          {can("production.manage") && <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Work order for stock</Button>}
        </div>
        {wos.error ? <ErrorState error={wos.error} onRetry={wos.reload} /> : !wos.data ? <Spinner /> : wos.data.length === 0 ? (
          <EmptyState icon={<Factory className="size-5" />} title="No work orders" description="Work orders are raised from WIP/PAD shortages and production requisitions." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-[13px]">
              <thead><tr><Th>Work order</Th><Th>Item</Th><Th className="text-right">Qty</Th><Th>Progress</Th><Th>Current step</Th><Th>For</Th><Th>Status</Th></tr></thead>
              <tbody>
                {wos.data.map((w) => (
                  <tr key={w.id} className="cursor-pointer hover:bg-surface-2" onClick={() => onOpen(w.id)}>
                    <Td className="py-2.5 font-mono text-xs font-semibold text-primary">{w.number}</Td>
                    <Td className="py-2.5">{w.item_name}<span className="block font-mono text-[11px] text-muted">{w.item_code}</span></Td>
                    <Td className="tabular py-2.5 text-right">{qty(w.qty_completed)} / {qty(w.quantity)} <span className="text-[11px] text-muted">{w.uom}</span></Td>
                    <Td className="py-2.5"><Progress done={w.ops_passed} total={w.ops_total} /></Td>
                    <Td className="py-2.5 text-xs">{w.current_step ? <>{w.current_step.seq}. {w.current_step.operation} <ModeBadge mode={w.current_step.mode} /></> : "—"}</Td>
                    <Td className="py-2.5 text-xs">{[w.so_number, w.pad_number].filter(Boolean).join(" · ") || "Stock"}</Td>
                    <Td className="py-2.5"><Badge tone={WO_TONE[w.status]}>{w.status.toLowerCase().replace("_", " ")}</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Drawer open={openId != null} onClose={() => onOpen(null)} title="Work order" width="max-w-3xl">
        {openId != null && <WorkOrderView key={openId} id={openId} onChanged={() => { wos.reload(); reqs.reload(); }} />}
      </Drawer>
      {creating && <CreateWoModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); wos.reload(); onOpen(id); }} />}
    </>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="w-32">
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-success" style={{ width: `${pct}%` }} /></div>
      <p className="mt-0.5 text-[11px] text-muted">{done} of {total} steps QC passed</p>
    </div>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  return mode === "IN_HOUSE"
    ? <Badge tone="success"><Factory className="mr-1 inline size-3" />In-house</Badge>
    : <Badge tone="warning"><Building2 className="mr-1 inline size-3" />Outside</Badge>;
}

function CreateWoModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [item, setItem] = useState<ItemRow | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title="Work order for stock"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!item || !(Number(q) > 0)} onClick={async () => {
        setBusy(true); setErr(null);
        try { onCreated((await api<WoBrief>("/api/work-orders", { method: "POST", json: { item_id: item!.id, quantity: q } })).id); }
        catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
      }}>Create</Button></>}>
      {err && <div className="mb-3"><Alert>{err}</Alert></div>}
      <p className="mb-3 text-sm text-muted">Replenish a processed spare or machine without a sales order. Steps are copied from the item&apos;s process route.</p>
      <Field label="Processed spare or machine" required><ItemPicker value={item} onChange={setItem} /></Field>
      <Field label={`Quantity${item ? ` (${item.uom})` : ""}`} required className="mt-3"><Input type="number" min={0} step="any" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
    </Modal>
  );
}

function WorkOrderView({ id, onChanged }: { id: number; onChanged: () => void }) {
  const { can } = useAuth();
  const wo = useApi<WoDetail>(`/api/work-orders/${id}`);
  const locs = useApi<Location[]>("/api/masters/locations");
  const sups = useApi<Supplier[]>("/api/masters/suppliers");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [send, setSend] = useState<SendForm | null>(null);
  const [fail, setFail] = useState<{ seq: number; note: string } | null>(null);
  const [mat, setMat] = useState<{ item: ItemRow | null; q: string; loc: string }>({ item: null, q: "", loc: "" });
  const [done, setDone] = useState<{ q: string; loc: string; cost: string } | null>(null);

  if (wo.error) return <ErrorState error={wo.error} onRetry={wo.reload} />;
  const w = wo.data;
  if (!w) return <Spinner />;
  const active = w.status === "OPEN" || w.status === "IN_PROGRESS";
  const allPassed = w.ops.every((o) => o.status === "QC_PASSED");
  const nextSeq = w.ops.find((o) => o.status !== "QC_PASSED")?.seq;

  async function act(key: string, body: Record<string, unknown>, path = `/api/work-orders/${id}/ops/${body.seq}`, okText = "") {
    setBusy(key); setMsg(null);
    try { await api(path, { method: "POST", json: body }); if (okText) setMsg({ ok: true, text: okText }); wo.reload(); onChanged(); return true; }
    catch (e) { setMsg({ ok: false, text: (e as ApiError).message }); return false; } finally { setBusy(null); }
  }
  const op = (seq: number, action: string, extra: Record<string, unknown> = {}) => act(`${action}${seq}`, { seq, action, ...extra });

  return (
    <div className="divide-y divide-line">
      <section className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-primary">{w.number}</span>
          <Badge tone={WO_TONE[w.status]}>{w.status.toLowerCase().replace("_", " ")}</Badge>
          {w.requisition_number && <Badge tone={w.requisition_status === "FULFILLED" ? "success" : "neutral"}>{w.requisition_number} · {w.requisition_status?.toLowerCase().replace("_", " ")}</Badge>}
        </div>
        <h2 className="mt-1 text-lg font-semibold">{w.item_name}</h2>
        <p className="text-sm text-muted">
          {w.item_code} · {qty(w.qty_completed)} of {qty(w.quantity)} {w.uom} made
          {w.so_number && ` · ${w.so_number}`}{w.pad_number && ` · ${w.pad_number}`}{w.required_date && ` · needed by ${dateFmt(w.required_date)}`}
        </p>
        {w.estimate && (
          <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-surface-2 p-3 text-center">
            <div><p className="text-[11px] text-muted">In-house</p><p className="tabular text-sm font-semibold">{Number(w.estimate.in_house_hours).toFixed(1)} h · {w.estimate.in_house_days} d</p></div>
            <div><p className="text-[11px] text-muted">Outside job-work</p><p className="tabular text-sm font-semibold">{w.estimate.outside_days} d</p></div>
            <div><p className="text-[11px] text-muted">Make time</p><p className="tabular text-sm font-semibold text-primary">{w.estimate.total_days} working days</p></div>
          </div>
        )}
        {msg && <div className="mt-3"><Alert tone={msg.ok ? "success" : "danger"}>{msg.text}</Alert></div>}
      </section>

      <section className="px-5 py-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Process steps — QC after every step</h3>
        <ol className="space-y-2">
          {w.ops.map((o) => {
            const isNext = active && o.seq === nextSeq;
            return (
              <li key={o.seq} className={cx("rounded-lg border px-3 py-2.5 text-[13px]", isNext ? "border-primary/50 bg-primary-soft/30" : "border-line",
                o.status === "QC_PASSED" && "opacity-80")}>
                <div className="flex flex-wrap items-start gap-2">
                  <span className="mt-0.5 w-5 shrink-0 font-mono text-xs text-muted">{o.seq}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink">{o.operation}</p>
                    <p className="text-xs text-muted">
                      {o.work_center ?? "—"}
                      {o.mode === "IN_HOUSE" ? ` · ${Number(o.setup_min)} min setup + ${Number(o.run_min)} min/${w.uom.toLowerCase()}` : ` · ${o.outside_days} days at vendor`}
                      {o.supplier && ` · ${o.supplier.name}`}
                      {o.challan_no && <> · challan {o.challan_id
                        ? <Link href={`/production/challans/${o.challan_id}`} className="inline-flex items-center gap-0.5 font-medium text-primary"><FileText className="size-3" />{o.challan_no}</Link>
                        : o.challan_no}</>}
                    </p>
                    {(o.done_at || o.qc_at || o.rework_count > 0) && (
                      <p className="mt-0.5 text-[11px] text-muted">
                        {o.done_at && `Done ${dateTime(o.done_at)}${o.done_by ? ` by ${o.done_by}` : ""}. `}
                        {o.qc_at && `QC ${o.status === "QC_PASSED" ? "passed" : "failed"} ${dateTime(o.qc_at)}${o.qc_by ? ` by ${o.qc_by}` : ""}${o.qc_note ? ` — ${o.qc_note}` : ""}. `}
                        {o.rework_count > 0 && <span className="text-warning">Reworked {o.rework_count}×.</span>}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="flex gap-1"><ModeBadge mode={o.mode} /><Badge tone={OP_TONE[o.status]}>{OP_LABEL[o.status]}</Badge></span>
                    {isNext && (
                      <div className="flex flex-wrap justify-end gap-1">
                        {can("production.manage") && o.mode === "IN_HOUSE" && o.status === "PENDING" &&
                          <Button size="sm" icon={<Play className="size-3.5" />} loading={busy === `start${o.seq}`} onClick={() => op(o.seq, "start")}>Start</Button>}
                        {can("production.manage") && o.mode === "IN_HOUSE" && o.status === "IN_PROGRESS" &&
                          <Button size="sm" icon={<Square className="size-3.5" />} loading={busy === `finish${o.seq}`} onClick={() => op(o.seq, "finish")}>Finish</Button>}
                        {can("production.manage") && o.mode === "OUTSIDE" && o.status === "PENDING" &&
                          <Button size="sm" icon={<Send className="size-3.5" />} onClick={() => setSend({
                            seq: o.seq, supplier: String(o.supplier?.id ?? ""), challan: "", process_nature: o.operation.toUpperCase(), po_number: "", po_date: "",
                            vehicle_no: "", transporter: "", waybill_no: "",
                            expected_return_date: o.outside_days ? new Date(Date.now() + o.outside_days * 864e5).toISOString().slice(0, 10) : "",
                          })}>Send to vendor</Button>}
                        {can("production.manage") && o.mode === "OUTSIDE" && o.status === "AT_VENDOR" &&
                          <Button size="sm" icon={<Undo2 className="size-3.5" />} loading={busy === `receive${o.seq}`} onClick={() => op(o.seq, "receive")}>Receive back</Button>}
                        {can("qc.hold") && o.status === "DONE" && <>
                          <Button size="sm" variant="success" icon={<ShieldCheck className="size-3.5" />} loading={busy === `qc${o.seq}`} onClick={() => op(o.seq, "qc", { passed: true })}>QC pass</Button>
                          <Button size="sm" variant="danger" icon={<ShieldX className="size-3.5" />} onClick={() => setFail({ seq: o.seq, note: "" })}>QC fail</Button>
                        </>}
                        {o.status === "DONE" && !can("qc.hold") && <span className="text-[11px] text-muted">Waiting for QC</span>}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="px-5 py-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Material issued to this work order</h3>
        {w.movements.filter((m) => m.type === "ISSUE").length === 0 ? <p className="text-sm text-muted">Nothing issued yet.</p> : (
          <table className="mb-3 w-full text-[13px]">
            <tbody>{w.movements.filter((m) => m.type === "ISSUE").map((m) => (
              <tr key={m.number} className="border-t border-line"><Td className="py-1.5 font-mono text-xs">{m.number}</Td><Td className="py-1.5">{m.item_code} {m.item_name}</Td>
                <Td className="tabular py-1.5 text-right">{qty(m.quantity)}</Td><Td className="py-1.5 text-xs text-muted">{dateTime(m.created_at)}</Td></tr>
            ))}</tbody>
          </table>
        )}
        {active && can("stock.issue") && (
          <div className="grid gap-2 sm:grid-cols-[1fr_90px_130px_auto] sm:items-end">
            <Field label="Raw material / input"><ItemPicker value={mat.item} onChange={(it) => setMat({ ...mat, item: it, loc: String(it?.location ? locs.data?.find((l) => l.code === it.location)?.id ?? "" : "") })} /></Field>
            <Field label="Qty"><Input type="number" min={0} step="any" value={mat.q} onChange={(e) => setMat({ ...mat, q: e.target.value })} /></Field>
            <Field label="From"><Select value={mat.loc} onChange={(e) => setMat({ ...mat, loc: e.target.value })}><option value="">…</option>{locs.data?.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</Select></Field>
            <Button icon={<PackagePlus className="size-4" />} loading={busy === "mat"} disabled={!mat.item || !(Number(mat.q) > 0) || !mat.loc}
              onClick={async () => { if (await act("mat", { item_id: mat.item!.id, quantity: mat.q, location_id: Number(mat.loc) }, `/api/work-orders/${id}/materials`, `Issued ${mat.q} ${mat.item!.uom} of ${mat.item!.item_code}`)) setMat({ item: null, q: "", loc: "" }); }}>Issue</Button>
          </div>
        )}
      </section>

      {active && can("production.manage") && (
        <section className="flex flex-wrap items-center gap-2 px-5 py-4">
          <Button variant="success" icon={<CheckCircle2 className="size-4" />} disabled={!allPassed}
            title={allPassed ? undefined : "Every step must pass QC first"}
            onClick={() => setDone({ q: String(Number(w.quantity) - Number(w.qty_completed)), loc: String(w.location_id ?? ""), cost: "" })}>Complete → book into stores</Button>
          {!allPassed && <span className="text-xs text-muted">Every step must pass QC first.</span>}
          <Button variant="ghost" className="ml-auto" icon={<XCircle className="size-4" />} onClick={async () => {
            const reason = prompt("Reason for cancelling this work order");
            if (reason) await act("cancel", { reason }, `/api/work-orders/${id}/cancel`, "Work order cancelled");
          }}>Cancel</Button>
        </section>
      )}

      {send && (
        <Modal open onClose={() => setSend(null)} title={`Send step ${send.seq} to job-work vendor`} width="max-w-2xl"
          footer={<><Button variant="secondary" onClick={() => setSend(null)}>Cancel</Button>
            <Button loading={busy === `send${send.seq}`} disabled={!send.supplier || !send.process_nature.trim()} icon={<Send className="size-4" />} onClick={async () => {
              const opt = (v: string) => v.trim() || undefined;
              if (await op(send.seq, "send", {
                supplier_id: Number(send.supplier), challan_no: opt(send.challan),
                challan: { process_nature: send.process_nature, po_number: opt(send.po_number), po_date: opt(send.po_date), vehicle_no: opt(send.vehicle_no),
                  transporter: opt(send.transporter), waybill_no: opt(send.waybill_no), expected_return_date: opt(send.expected_return_date) },
              })) setSend(null);
            }}>Send &amp; raise challan</Button></>}>
          <p className="mb-3 text-sm text-muted">
            Raises a delivery challan (job work) for the open quantity, {qty(Number(w.quantity) - Number(w.qty_completed))} {w.uom}. The material stays in WIP until it comes back.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Vendor (consignee)" required className="sm:col-span-2"><Select value={send.supplier} onChange={(e) => setSend({ ...send, supplier: e.target.value })}>
              <option value="">Select…</option>{sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            <Field label="Process nature" required><Input value={send.process_nature} onChange={(e) => setSend({ ...send, process_nature: e.target.value.toUpperCase() })} placeholder="HARDENING AND TEMPERING" /></Field>
            <Field label="Challan no." hint="Blank = next number, e.g. U4-26-27/0650"><Input value={send.challan} onChange={(e) => setSend({ ...send, challan: e.target.value })} /></Field>
            <Field label="Job-work PO no."><Input value={send.po_number} onChange={(e) => setSend({ ...send, po_number: e.target.value })} placeholder="174637" /></Field>
            <Field label="PO date"><Input type="date" value={send.po_date} onChange={(e) => setSend({ ...send, po_date: e.target.value })} /></Field>
            <Field label="Vehicle number"><Input value={send.vehicle_no} onChange={(e) => setSend({ ...send, vehicle_no: e.target.value.toUpperCase() })} placeholder="TN 66 AK 5769" /></Field>
            <Field label="Transporter"><Input value={send.transporter} onChange={(e) => setSend({ ...send, transporter: e.target.value })} /></Field>
            <Field label="Waybill / e-way bill no."><Input value={send.waybill_no} onChange={(e) => setSend({ ...send, waybill_no: e.target.value })} /></Field>
            <Field label="Expected back by"><Input type="date" value={send.expected_return_date} onChange={(e) => setSend({ ...send, expected_return_date: e.target.value })} /></Field>
          </div>
          <p className="mt-3 text-xs text-muted">Vehicle, transporter and waybill can still be filled in on the challan before printing.</p>
        </Modal>
      )}
      {fail && (
        <Modal open onClose={() => setFail(null)} title={`QC failed — step ${fail.seq}`}
          footer={<><Button variant="secondary" onClick={() => setFail(null)}>Cancel</Button>
            <Button variant="danger" loading={busy === `qc${fail.seq}`} disabled={fail.note.trim().length < 3} onClick={async () => {
              if (await op(fail.seq, "qc", { passed: false, note: fail.note })) setFail(null);
            }}>Send back for rework</Button></>}>
          <p className="mb-3 text-sm text-muted">The step goes back to pending and must be done again before the next step can start.</p>
          <Field label="Reason" required><Input value={fail.note} onChange={(e) => setFail({ ...fail, note: e.target.value })} placeholder="e.g. burr on edges, coating thickness low" /></Field>
        </Modal>
      )}
      {done && (
        <Modal open onClose={() => setDone(null)} title="Complete work order"
          footer={<><Button variant="secondary" onClick={() => setDone(null)}>Cancel</Button>
            <Button variant="success" loading={busy === "done"} disabled={!(Number(done.q) > 0) || !done.loc} onClick={async () => {
              if (await act("done", { quantity: done.q, location_id: Number(done.loc), unit_cost: done.cost || null }, `/api/work-orders/${id}/complete`,
                `Booked ${done.q} ${w.uom} into stores${w.requisition_number ? `; ${w.requisition_number} closed when fully made` : ""}`)) setDone(null);
            }}>Book into stores</Button></>}>
          <p className="mb-3 text-sm text-muted">Every step has passed QC. The made quantity goes into stores as available stock; a linked requisition closes and the waiting sales order is allocated.</p>
          <div className="grid grid-cols-3 gap-3">
            <Field label={`Qty (${w.uom})`} required><Input type="number" min={0} step="any" value={done.q} onChange={(e) => setDone({ ...done, q: e.target.value })} /></Field>
            <Field label="Into location" required><Select value={done.loc} onChange={(e) => setDone({ ...done, loc: e.target.value })}><option value="">…</option>{locs.data?.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</Select></Field>
            <Field label="Unit cost (₹)"><Input type="number" min={0} step="any" value={done.cost} onChange={(e) => setDone({ ...done, cost: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
