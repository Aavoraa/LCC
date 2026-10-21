"use client";

import { Ban, CalendarClock, Check, ClipboardList, PackageCheck, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { useState } from "react";
import { ItemPicker } from "@/components/ItemPicker";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Spinner, Td, Textarea, Th } from "@/components/ui";
import { api, ApiError, uuid } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateFmt, money, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import type { ItemRow, Location, Requisition, Supplier } from "@/lib/types";

interface POLine { id: number; item_id: number; item_code: string; item_name: string; qty_ordered: string; qty_received: string; unit_price: string; expected_date: string }
interface PO { id: number; number: string; supplier: string; status: string; order_date: string; total: string; lines: POLine[] }

export default function PurchasePage() {
  const { can } = useAuth();
  const pos = useApi<PO[]>("/api/purchase/orders");
  const sups = useApi<Supplier[]>("/api/masters/suppliers");
  const locs = useApi<Location[]>("/api/masters/locations");
  const reqs = useApi<Requisition[]>("/api/purchase/requisitions");
  const [converting, setConverting] = useState<Requisition | null>(null);
  const [cancelling, setCancelling] = useState<Requisition | null>(null);
  const [rescheduling, setRescheduling] = useState<{ po: PO; line: POLine } | null>(null);
  const openReqs = reqs.data?.filter((r) => r.status === "OPEN") ?? [];
  const [creating, setCreating] = useState(false);
  const [supOpen, setSupOpen] = useState(false);
  const [receiving, setReceiving] = useState<{ po: PO; line: POLine } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  return (
    <>
      <PageHeader title="Procurement & suppliers" description="Approved purchase orders feed incoming supply into Sales availability. Goods receipts post to the ledger and default to QC hold."
        actions={<>
          {can("masters.manage") && <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setSupOpen(true)}>Supplier</Button>}
          {can("purchase.manage") && <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Purchase order</Button>}
        </>} />
      {err && <div className="mb-4"><Alert>{err}</Alert></div>}
      <Card className="mb-5 overflow-hidden">
        <CardHeader title={<span className="flex items-center gap-2">Purchase requisitions {openReqs.length > 0 && <Badge tone="warning">{openReqs.length} open</Badge>}</span>}
          subtitle="Raised from sales-order shortages and from machine SOP spare shortages (Machines & SOP spares → Stores check)" />
        {reqs.error ? <ErrorState error={reqs.error} onRetry={reqs.reload} /> : !reqs.data ? <Spinner /> : reqs.data.length === 0 ? <EmptyState icon={<ClipboardList className="size-5" />} title="No requisitions" description="Shortages on confirmed sales orders and machine SOP spares appear here." /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[13px]">
              <thead><tr><Th>Requisition</Th><Th>Type</Th><Th>Item</Th><Th className="text-right">Qty</Th><Th>Needed by</Th><Th>Sales order</Th><Th>Status</Th><Th /></tr></thead>
              <tbody>{reqs.data.map((r) => (
                <tr key={r.id} className="h-10 hover:bg-surface-2">
                  <Td className="font-mono text-xs">{r.number}</Td>
                  <Td><Badge tone={r.kind === "PURCHASE" ? "info" : "primary"}>{r.kind === "PURCHASE" ? "buy" : "make"}</Badge></Td>
                  <Td><span className="font-mono text-xs text-primary">{r.item_code}</span> {r.item_name}</Td>
                  <Td className="tabular text-right">{qty(r.quantity)} <span className="text-muted">{r.uom}</span></Td>
                  <Td>{dateFmt(r.required_date)}</Td>
                  <Td className="font-mono text-xs">{r.so_number ?? "—"}</Td>
                  <Td><Badge tone={r.status === "OPEN" ? "warning" : r.status === "ORDERED" ? "primary" : "neutral"}>{r.status.toLowerCase()}{r.po_number ? " · " + r.po_number : ""}</Badge></Td>
                  <Td className="text-right">
                    {r.status === "OPEN" && can("purchase.manage") && (
                      <div className="flex justify-end gap-1.5">
                        {r.kind === "PURCHASE" ? <Button size="sm" icon={<ShoppingCart className="size-3.5" />} onClick={() => setConverting(r)}>Raise PO</Button>
                          : <span className="self-center text-xs text-muted">Production work order</span>}
                        <Button size="sm" variant="ghost" aria-label="Cancel requisition" onClick={() => setCancelling(r)}><Ban className="size-3.5" /></Button>
                      </div>
                    )}
                  </Td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <Card className="overflow-hidden">
          <CardHeader title="Purchase orders" />
          {pos.error ? <ErrorState error={pos.error} onRetry={pos.reload} /> : !pos.data ? <Spinner /> : pos.data.length === 0 ? <EmptyState title="No purchase orders" /> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-[13px]">
                <thead><tr><Th>PO</Th><Th>Supplier</Th><Th>Item</Th><Th className="text-right">Ordered</Th><Th className="text-right">Received</Th><Th>Expected</Th><Th>Status</Th><Th /></tr></thead>
                <tbody>
                  {pos.data.flatMap((po) => po.lines.map((l, i) => (
                    <tr key={l.id} className="hover:bg-surface-2">
                      <Td className="py-2 font-mono text-xs">{i === 0 && po.number}</Td>
                      <Td className="py-2">{i === 0 && po.supplier}</Td>
                      <Td className="py-2"><span className="font-mono text-xs text-primary">{l.item_code}</span> {l.item_name}</Td>
                      <Td className="tabular py-2 text-right">{qty(l.qty_ordered)}</Td>
                      <Td className="tabular py-2 text-right">{qty(l.qty_received)}</Td>
                      <Td className="py-2">{dateFmt(l.expected_date)}</Td>
                      <Td className="py-2">{i === 0 && <Badge tone={po.status === "APPROVED" ? "primary" : po.status === "CLOSED" ? "success" : "warning"}>{po.status.toLowerCase()}</Badge>}</Td>
                      <Td className="py-2 text-right">
                        {i === 0 && po.status === "DRAFT" && can("purchase.approve") && (
                          <Button size="sm" variant="success" icon={<Check className="size-3.5" />} onClick={async () => {
                            setErr(null);
                            try { await api(`/api/purchase/orders/${po.id}/approve`, { method: "POST" }); pos.reload(); } catch (e) { setErr((e as ApiError).message); }
                          }}>Approve</Button>
                        )}
                        <div className="flex justify-end gap-1.5">
                          {(po.status === "DRAFT" || po.status === "APPROVED") && Number(l.qty_received) < Number(l.qty_ordered) && can("purchase.manage") && (
                            <Button size="sm" variant="ghost" icon={<CalendarClock className="size-3.5" />} onClick={() => setRescheduling({ po, line: l })}>Reschedule</Button>
                          )}
                          {po.status === "APPROVED" && Number(l.qty_received) < Number(l.qty_ordered) && can("stock.receive") && (
                            <Button size="sm" variant="secondary" icon={<PackageCheck className="size-3.5" />} onClick={() => setReceiving({ po, line: l })}>Receive</Button>
                          )}
                        </div>
                      </Td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card className="h-fit overflow-hidden">
          <CardHeader title="Suppliers" />
          {!sups.data?.length ? <EmptyState title="No suppliers" /> : (
            <ul className="divide-y divide-line text-sm">
              {sups.data.map((s) => (
                <li key={s.id} className="px-4 py-2.5"><p className="font-medium">{s.name}</p><p className="text-xs text-muted">{s.code} · {s.gstin ?? "No GSTIN"} · {s.lead_time_days} day lead time</p></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {creating && <CreatePO suppliers={sups.data ?? []} onClose={() => setCreating(false)} onDone={pos.reload} />}
      {supOpen && <CreateSupplier onClose={() => setSupOpen(false)} onDone={sups.reload} />}
      {converting && <ConvertRequisition req={converting} suppliers={sups.data ?? []} onClose={() => setConverting(null)} onDone={() => { reqs.reload(); pos.reload(); }} />}
      {cancelling && <CancelRequisition req={cancelling} onClose={() => setCancelling(null)} onDone={reqs.reload} />}
      {rescheduling && <Reschedule po={rescheduling.po} line={rescheduling.line} onClose={() => setRescheduling(null)} onDone={pos.reload} />}
      {receiving && <Receive po={receiving.po} line={receiving.line} locations={locs.data ?? []} onClose={() => setReceiving(null)} onDone={pos.reload} />}
    </>
  );
}

function CreatePO({ suppliers, onClose, onDone }: { suppliers: Supplier[]; onClose: () => void; onDone: () => void }) {
  const [supplier, setSupplier] = useState("");
  const [lines, setLines] = useState<{ item: ItemRow | null; qty: string; price: string; date: string }[]>([{ item: null, qty: "", price: "", date: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = supplier && lines.every((l) => l.item && Number(l.qty) > 0 && l.price !== "" && l.date);
  return (
    <Modal open onClose={onClose} title="New purchase order" width="max-w-3xl"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!valid} onClick={async () => {
        setBusy(true); setErr(null);
        try {
          await api("/api/purchase/orders", { method: "POST", json: { supplier_id: Number(supplier), lines: lines.map((l) => ({ item_id: l.item!.id, qty_ordered: l.qty, unit_price: l.price, expected_date: l.date })) } });
          onDone(); onClose();
        } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
      }}>Create draft PO</Button></>}>
      <div className="space-y-4">
        {err && <Alert>{err}</Alert>}
        <Field label="Supplier" required><Select value={supplier} onChange={(e) => setSupplier(e.target.value)}><option value="">Select…</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_90px_110px_140px_auto] items-end gap-2">
            <Field label={i === 0 ? "Item" : ""}><ItemPicker value={l.item} onChange={(item) => setLines(lines.map((x, j) => (j === i ? { ...x, item } : x)))} /></Field>
            <Field label={i === 0 ? "Qty" : ""}><Input type="number" min={0} value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></Field>
            <Field label={i === 0 ? "Unit price" : ""}><Input type="number" min={0} step="any" value={l.price} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} /></Field>
            <Field label={i === 0 ? "Expected" : ""}><Input type="date" value={l.date} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} /></Field>
            <Button variant="ghost" size="sm" className="mb-0.5" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        <Button variant="secondary" size="sm" icon={<Plus className="size-4" />} onClick={() => setLines([...lines, { item: null, qty: "", price: "", date: "" }])}>Add line</Button>
        <p className="text-xs text-muted">Total {money(lines.reduce((a, l) => a + Number(l.qty || 0) * Number(l.price || 0), 0), true)} · a different user must approve before it counts as incoming supply.</p>
      </div>
    </Modal>
  );
}

function CreateSupplier({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", gstin: "", phone: "", email: "", lead_time_days: "14" });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title="New supplier" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={f.name.length < 2} onClick={async () => {
      try {
        await api("/api/masters/suppliers", { method: "POST", json: { ...f, gstin: f.gstin || null, phone: f.phone || null, email: f.email || null, lead_time_days: Number(f.lead_time_days) } });
        onDone(); onClose();
      } catch (e) { setErr((e as ApiError).message); }
    }}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {err && <div className="sm:col-span-2"><Alert>{err}</Alert></div>}
        <Field label="Name" required className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="GSTIN" hint="15 characters"><Input value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} maxLength={15} /></Field>
        <Field label="Lead time (days)"><Input type="number" min={0} value={f.lead_time_days} onChange={(e) => setF({ ...f, lead_time_days: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function Receive({ po, line, locations, onClose, onDone }: { po: PO; line: POLine; locations: Location[]; onClose: () => void; onDone: () => void }) {
  const open = Number(line.qty_ordered) - Number(line.qty_received);
  const [q, setQ] = useState(String(open));
  const [loc, setLoc] = useState(String(locations.find((l) => l.code.includes("QC"))?.id ?? ""));
  const [qc, setQc] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [txn] = useState(uuid());
  return (
    <Modal open onClose={onClose} title={`Goods receipt — ${po.number}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="success" loading={busy} disabled={!loc || !(Number(q) > 0)} onClick={async () => {
      setBusy(true); setErr(null);
      try { await api(`/api/purchase/orders/${po.id}/receive`, { method: "POST", json: { line_id: line.id, quantity: q, to_location_id: Number(loc), into_qc_hold: qc, txn_uuid: txn } }); onDone(); onClose(); }
      catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
    }}>Post receipt</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <p className="text-sm"><span className="font-mono text-xs text-primary">{line.item_code}</span> {line.item_name} · open {qty(open)}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity received"><Input type="number" min={0} max={open} value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <Field label="Location"><Select value={loc} onChange={(e) => setLoc(e.target.value)}><option value="">Select…</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</Select></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={qc} onChange={(e) => setQc(e.target.checked)} /> Hold for incoming quality inspection</label>
      </div>
    </Modal>
  );
}

function ConvertRequisition({ req, suppliers, onClose, onDone }: { req: Requisition; suppliers: Supplier[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ supplier_id: "", unit_price: "", expected_date: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title={`Raise PO for ${req.number}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={f.unit_price === ""} onClick={async () => {
      setBusy(true); setErr(null);
      try {
        await api(`/api/purchase/requisitions/${req.id}/convert`, { method: "POST", json: { supplier_id: f.supplier_id ? Number(f.supplier_id) : null, unit_price: f.unit_price, expected_date: f.expected_date || null } });
        onDone(); onClose();
      } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
    }}>Create draft PO</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <p className="text-sm"><span className="font-mono text-xs text-primary">{req.item_code}</span> {req.item_name} · {qty(req.quantity)} {req.uom} for {req.so_number}</p>
        <Field label="Supplier" hint="Leave blank to use the item's default supplier"><Select value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}><option value="">Item default</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Unit price" required><Input type="number" min={0} step="any" value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value })} /></Field>
          <Field label="Expected date" hint="Blank = supplier lead time"><Input type="date" value={f.expected_date} onChange={(e) => setF({ ...f, expected_date: e.target.value })} /></Field>
        </div>
        <p className="text-xs text-muted">The draft PO counts as incoming supply for the order once a different user approves it.</p>
      </div>
    </Modal>
  );
}

function CancelRequisition({ req, onClose, onDone }: { req: Requisition; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title={`Cancel ${req.number}`} footer={<><Button variant="secondary" onClick={onClose}>Keep</Button><Button variant="danger" disabled={reason.trim().length < 5} onClick={async () => {
      try { await api(`/api/purchase/requisitions/${req.id}/cancel`, { method: "POST", json: { reason } }); onDone(); onClose(); } catch (e) { setErr((e as ApiError).message); }
    }}>Cancel requisition</Button></>}>
      <div className="space-y-3">{err && <Alert>{err}</Alert>}<Field label="Reason" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
    </Modal>
  );
}

function Reschedule({ po, line, onClose, onDone }: { po: PO; line: POLine; onClose: () => void; onDone: () => void }) {
  const [d, setD] = useState(line.expected_date);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title={`Reschedule ${po.number}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!d || d === line.expected_date || reason.trim().length < 3} onClick={async () => {
      setBusy(true); setErr(null);
      try { await api(`/api/purchase/orders/${po.id}/lines/${line.id}`, { method: "PATCH", json: { expected_date: d, reason } }); onDone(); onClose(); }
      catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
    }}>Save new date</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <p className="text-sm"><span className="font-mono text-xs text-primary">{line.item_code}</span> {line.item_name} · currently due {dateFmt(line.expected_date)}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="New expected date" required><Input type="date" value={d} onChange={(e) => setD(e.target.value)} /></Field>
          <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Supplier advised delay" /></Field>
        </div>
        <p className="text-xs text-muted">Sales-order forecasts that depend on this supply are recalculated; orders that would miss their committed date are flagged.</p>
      </div>
    </Modal>
  );
}
