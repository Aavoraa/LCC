"use client";

import { ClipboardList, Link2, Plus, RefreshCw, ShoppingCart, Wand2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card, CardHeader, ErrorState, Field, Input, Modal, PageHeader, Select, Spinner, Td, Textarea, Th, cx } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { money, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";

interface Suggestion { item_id: number; item_code: string; name: string; score: number; reason: string }
interface Spare {
  id: number; line_no: number; part_no: string; name: string; group: string; criticality: "A" | "B" | "C";
  qty_per_machine: string; sop_stock: string; uom: string; basis: string; source_ref: string | null; notes: string | null;
  item_id: number | null; item: { id: number; item_code: string; name: string } | null; suggestions?: Suggestion[];
}
interface MachineDetail {
  id: number; code: string; name: string; models: string | null; description: string | null; source: string | null;
  specifications: Record<string, string>; units_supported: number; spare_count: number; aligned_count: number; spares: Spare[];
}
interface CheckLine {
  spare_id: number; part_no: string; name: string; group: string; criticality: string; basis: string; uom: string;
  sop_stock: string; required: string; item_id: number | null; item_code: string | null; on_hand: string | null; reserved: string | null;
  qc_hold: string | null; available: string | null; shortage: string; open_requisition_qty: string; status: "OK" | "SHORT" | "OUT" | "NOT_IN_STORE" | "ON_DEMAND";
}
interface Check {
  units: number; lines: CheckLine[]; counts: Record<string, number>; total: number; stocked_lines: number; readiness_pct: number;
  critical_gaps: number; shortage_value: string; unpriced_shortages: number;
}

const GROUPS = ["WEAR", "TOOLING", "MECHANICAL", "ELECTRICAL", "PNEUMATIC", "INSPECTION", "CONSUMABLE", "FASTENER", "FABRICATION"];
const CRIT_TONE = { A: "danger", B: "warning", C: "neutral" } as const;
const STATUS: Record<CheckLine["status"], { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  OK: { label: "OK", tone: "success" }, SHORT: { label: "Short", tone: "warning" }, OUT: { label: "Out of stock", tone: "danger" },
  NOT_IN_STORE: { label: "Not in stores", tone: "neutral" }, ON_DEMAND: { label: "On demand", tone: "neutral" },
};

export default function MachineDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const machine = useApi<MachineDetail>(`/api/machines/${id}`);
  const [tab, setTab] = useState<"spares" | "check">("spares");
  const [msg, setMsg] = useState<{ tone: "success" | "danger" | "info"; text: React.ReactNode } | null>(null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setMsg(null);
    try { return await fn(); } catch (e) { setMsg({ tone: "danger", text: (e as ApiError).message }); } finally { setBusy(false); }
  }

  if (machine.error) return <ErrorState error={machine.error} onRetry={machine.reload} />;
  if (!machine.data) return <Spinner />;
  const m = machine.data;
  const unaligned = m.spare_count - m.aligned_count;

  return (
    <>
      <PageHeader
        title={m.name}
        description={<><span className="font-mono text-primary">{m.code}</span>{m.models ? ` · ${m.models}` : ""}{m.source ? ` · ${m.source}` : ""}</>}
        actions={can("machines.manage") && (
          <>
            <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setAddOpen(true)}>Add spare</Button>
            <Button icon={<Wand2 className="size-4" />} loading={busy} disabled={unaligned === 0} onClick={async () => {
              const r = await run(() => api<{ linked: number; created: number; needs_review: number }>(`/api/machines/${m.id}/align`, {
                method: "POST", json: { create_missing: can("items.create") } }));
              if (r) {
                setMsg({ tone: r.needs_review ? "info" : "success", text: `Aligned with stores: ${r.linked} linked to existing items, ${r.created} created as new stores items` +
                  (r.needs_review ? `, ${r.needs_review} with a similar stores item waiting for your review below.` : ".") });
                machine.reload();
              }
            }}>Align with stores{unaligned ? ` (${unaligned})` : ""}</Button>
          </>
        )}
      />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}

      <div className="mb-5 grid gap-5 xl:grid-cols-[1fr_360px]">
        <Card className="p-4">
          {m.description && <p className="text-sm leading-relaxed text-ink-2">{m.description}</p>}
          {Object.keys(m.specifications).length > 0 && (
            <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
              {Object.entries(m.specifications).map(([k, v]) => (
                <div key={k} className="flex gap-2"><dt className="shrink-0 text-muted">{k}:</dt><dd className="text-ink">{v}</dd></div>
              ))}
            </dl>
          )}
        </Card>
        <UnitsCard machine={m} onSaved={machine.reload} />
      </div>

      <div className="mb-3 flex gap-1" role="tablist">
        {([["spares", `SOP spare list (${m.spare_count})`, ClipboardList], ["check", "Stores check", ShoppingCart]] as const).map(([k, label, Icon]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                  className={cx("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm", tab === k ? "bg-surface font-medium text-ink shadow-card ring-1 ring-line" : "text-muted hover:text-ink")}>
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>

      {tab === "spares" ? <SpareList machine={m} onChanged={machine.reload} run={run} /> : <StoresCheck machine={m} />}
      {addOpen && <AddSpare machineId={m.id} onClose={() => setAddOpen(false)} onDone={machine.reload} />}
    </>
  );
}

function UnitsCard({ machine, onSaved }: { machine: MachineDetail; onSaved: () => void }) {
  const { can } = useAuth();
  const [units, setUnits] = useState(String(machine.units_supported));
  useEffect(() => setUnits(String(machine.units_supported)), [machine.units_supported]);
  return (
    <Card className="p-4">
      <p className="text-sm font-semibold">Machines supported</p>
      <p className="mt-0.5 text-xs text-muted">Stores holds the SOP stock for this many machines (installed base or units in build). Required qty = SOP stock × machines.</p>
      <div className="mt-3 flex gap-2">
        <Input type="number" min={0} max={1000} value={units} onChange={(e) => setUnits(e.target.value)} disabled={!can("machines.manage")} className="w-28" aria-label="Machines supported" />
        {can("machines.manage") && (
          <Button variant="secondary" disabled={units === String(machine.units_supported) || !(Number(units) >= 0)} onClick={async () => {
            await api(`/api/machines/${machine.id}`, { method: "PATCH", json: { units_supported: Number(units) } });
            onSaved();
          }}>Save</Button>
        )}
      </div>
    </Card>
  );
}

function SpareList({ machine, onChanged, run }: { machine: MachineDetail; onChanged: () => void; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const { can } = useAuth();
  const manage = can("machines.manage");
  const [group, setGroup] = useState("");
  const rows = machine.spares.filter((s) => !group || s.group === group);

  return (
    <Card className="overflow-hidden">
      <CardHeader title="SOP spare list" subtitle="A = critical wear part, B = important, C = order on demand. SOP stock is the minimum to hold per machine supported."
        actions={<Select value={group} onChange={(e) => setGroup(e.target.value)} className="h-8 w-40 text-xs" aria-label="Filter by group">
          <option value="">All groups</option>{GROUPS.map((g) => <option key={g} value={g}>{g.toLowerCase()}</option>)}
        </Select>} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1050px] text-[13px]">
          <thead><tr><Th>Part no</Th><Th>Spare</Th><Th>Group</Th><Th>Crit.</Th><Th className="text-right">Qty / machine</Th><Th className="text-right">SOP stock</Th><Th>Basis</Th><Th>Stores item</Th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="align-top hover:bg-surface-2">
                <Td className="whitespace-nowrap py-2.5 font-mono text-xs">{s.part_no}</Td>
                <Td className="py-2.5"><span className="font-medium text-ink">{s.name}</span>{s.notes && <span className="block text-xs text-muted">{s.notes}</span>}</Td>
                <Td className="py-2.5 text-xs">{s.group.toLowerCase()}</Td>
                <Td className="py-2.5">
                  {manage ? (
                    <Select defaultValue={s.criticality} className="h-7 w-[4.5rem] text-xs" aria-label={`Criticality of ${s.part_no}`}
                      onChange={(e) => run(() => api(`/api/machines/spares/${s.id}`, { method: "PATCH", json: { criticality: e.target.value } }))}>
                      <option>A</option><option>B</option><option>C</option>
                    </Select>
                  ) : <Badge tone={CRIT_TONE[s.criticality]}>{s.criticality}</Badge>}
                </Td>
                <Td className="tabular py-2.5 text-right">{qty(s.qty_per_machine)} {s.uom}</Td>
                <Td className="py-2.5 text-right">
                  {manage ? (
                    <Input type="number" min={0} step="any" defaultValue={Number(s.sop_stock)} className="ml-auto h-7 w-20 text-right text-xs" aria-label={`SOP stock for ${s.part_no}`}
                      onBlur={(e) => e.target.value !== String(Number(s.sop_stock)) && run(() => api(`/api/machines/spares/${s.id}`, { method: "PATCH", json: { sop_stock: e.target.value || "0" } }))} />
                  ) : <span className="tabular">{qty(s.sop_stock)}</span>}
                </Td>
                <Td className="whitespace-nowrap py-2.5 text-xs">
                  <Badge tone={s.basis === "CATALOGUE" ? "primary" : s.basis === "MANUAL" ? "neutral" : "info"}>{s.basis.toLowerCase()}</Badge>
                  <span className="ml-1 text-muted">{s.source_ref}</span>
                </Td>
                <Td className="py-2.5">
                  {s.item ? (
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      <Link href={`/inventory?item=${s.item.id}`} className="font-mono text-xs font-semibold text-primary hover:underline">{s.item.item_code}</Link>
                      {manage && <button className="text-[11px] text-muted hover:text-danger" onClick={async () => { await run(() => api(`/api/machines/spares/${s.id}/link`, { method: "POST", json: { item_id: null } })); onChanged(); }}>unlink</button>}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <Badge>Not in stores</Badge>
                      {manage && s.suggestions?.map((g) => (
                        <button key={g.item_id} title={g.reason} onClick={async () => { await run(() => api(`/api/machines/spares/${s.id}/link`, { method: "POST", json: { item_id: g.item_id } })); onChanged(); }}
                                className="flex w-full items-center gap-1.5 rounded border border-line px-2 py-1 text-left text-xs hover:border-primary">
                          <Link2 className="size-3 shrink-0 text-primary" /><span className="font-mono">{g.item_code}</span><span className="truncate text-muted">{g.name}</span>
                          <span className="ml-auto text-muted">{Math.round(g.score * 100)}%</span>
                        </button>
                      ))}
                      {manage && can("items.create") && (
                        <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={async () => { await run(() => api(`/api/machines/spares/${s.id}/create-item`, { method: "POST" })); onChanged(); }}>
                          Create in stores
                        </Button>
                      )}
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function StoresCheck({ machine }: { machine: MachineDetail }) {
  const { can } = useAuth();
  const [units, setUnits] = useState(String(machine.units_supported || 1));
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<{ tone: "success" | "danger" | "info"; text: React.ReactNode } | null>(null);
  const [busy, setBusy] = useState(false);
  const u = Math.max(0, Math.min(1000, Number(units) || 0));
  const check = useApi<Check>(`/api/machines/${machine.id}/store-check?units=${u}`);
  const lines = useMemo(() => (check.data?.lines ?? []).filter((l) => !onlyGaps || !["OK", "ON_DEMAND"].includes(l.status)), [check.data, onlyGaps]);
  const orderable = (l: CheckLine) => l.status !== "NOT_IN_STORE" && Number(l.shortage) - Number(l.open_requisition_qty) > 0;

  async function raise(spareIds?: number[]) {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ created: { number: string; item_code: string; item_name: string; quantity: string }[] }>(`/api/machines/${machine.id}/requisitions`, {
        method: "POST", json: { units: Math.max(1, u), spare_ids: spareIds ?? null } });
      setResult(r.created.length
        ? { tone: "success", text: <>Raised {r.created.length} purchase requisition{r.created.length === 1 ? "" : "s"}: {r.created.map((p) => `${p.number} (${p.item_code} × ${qty(p.quantity)})`).join(", ")}. <Link href="/purchase" className="font-medium underline">Open procurement</Link></> }
        : { tone: "info", text: "Nothing to raise — open requisitions already cover every shortage." });
      setSelected(new Set());
      check.reload();
    } catch (e) {
      setResult({ tone: "danger", text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  const c = check.data;
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-4 p-4">
        <Field label="Check for machines">
          <Input type="number" min={0} max={1000} value={units} onChange={(e) => setUnits(e.target.value)} className="w-28" />
        </Field>
        {c && (
          <div className="flex flex-1 flex-wrap items-center gap-x-6 gap-y-2">
            <div><p className="text-xs text-muted">Readiness</p><p className={cx("tabular text-xl font-semibold", c.readiness_pct >= 90 ? "text-success" : c.readiness_pct >= 50 ? "text-warning" : "text-danger")}>{c.readiness_pct}%</p></div>
            <div><p className="text-xs text-muted">Stocked lines OK</p><p className="tabular text-xl font-semibold">{c.counts.OK} / {c.stocked_lines}</p>
              {c.counts.ON_DEMAND > 0 && <p className="text-[11px] text-muted">+ {c.counts.ON_DEMAND} order-on-demand</p>}</div>
            <div><p className="text-xs text-muted">Critical (A) gaps</p><p className={cx("tabular text-xl font-semibold", c.critical_gaps ? "text-danger" : "")}>{c.critical_gaps}</p></div>
            <div><p className="text-xs text-muted">Value to restore</p><p className="tabular text-xl font-semibold">{money(c.shortage_value)}</p>
              {c.unpriced_shortages > 0 && <p className="text-[11px] text-muted">+ {c.unpriced_shortages} line(s) with no cost yet</p>}</div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} /> Gaps only</label>
          <Button variant="ghost" size="sm" icon={<RefreshCw className="size-4" />} onClick={check.reload}>Refresh</Button>
        </div>
      </Card>
      {result && <Alert tone={result.tone}>{result.text}</Alert>}
      <Card className="overflow-hidden">
        <CardHeader title="Stores check" subtitle="Available = on hand − reserved − QC hold. Shortage = required − available. Open requisitions are netted off before raising new ones."
          actions={can("machines.requisition") && (
            <>
              {selected.size > 0 && <Button size="sm" loading={busy} icon={<ShoppingCart className="size-4" />} onClick={() => raise([...selected])}>Requisition selected ({selected.size})</Button>}
              <Button size="sm" variant="secondary" loading={busy && selected.size === 0} disabled={!check.data?.lines.some(orderable)} onClick={() => raise()}>Requisition all shortages</Button>
            </>
          )} />
        {check.error ? <ErrorState error={check.error} onRetry={check.reload} /> : !c ? <Spinner /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-[13px]">
              <thead><tr>
                <Th className="w-8" /><Th>Part no</Th><Th>Spare</Th><Th>Crit.</Th><Th className="text-right">Required</Th><Th className="text-right">Available</Th>
                <Th className="text-right">On hand</Th><Th className="text-right">Reserved / QC</Th><Th className="text-right">Open PR</Th><Th className="text-right">Shortage</Th><Th>Status</Th>
              </tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.spare_id} className={cx("hover:bg-surface-2", selected.has(l.spare_id) && "bg-primary-soft/40")}>
                    <Td className="py-2">
                      {can("machines.requisition") && orderable(l) && (
                        <input type="checkbox" aria-label={`Select ${l.part_no}`} checked={selected.has(l.spare_id)} onChange={() => {
                          const n = new Set(selected); if (n.has(l.spare_id)) n.delete(l.spare_id); else n.add(l.spare_id); setSelected(n);
                        }} />
                      )}
                    </Td>
                    <Td className="whitespace-nowrap py-2 font-mono text-xs">{l.part_no}</Td>
                    <Td className="py-2">
                      <span className="text-ink">{l.name}</span>{" "}
                      {l.item_id && <Link href={`/inventory?item=${l.item_id}`} className="ml-1 whitespace-nowrap font-mono text-[11px] text-primary hover:underline">{l.item_code}</Link>}
                    </Td>
                    <Td className="py-2"><Badge tone={CRIT_TONE[l.criticality as "A" | "B" | "C"]}>{l.criticality}</Badge></Td>
                    <Td className="tabular py-2 text-right">{qty(l.required)} <span className="text-[11px] text-muted">{l.uom}</span></Td>
                    <Td className="tabular py-2 text-right font-semibold text-ink">{l.available == null ? "—" : qty(l.available)}</Td>
                    <Td className="tabular py-2 text-right text-muted">{l.on_hand == null ? "—" : qty(l.on_hand)}</Td>
                    <Td className="tabular py-2 text-right text-muted">{l.reserved == null ? "—" : `${qty(l.reserved)} / ${qty(l.qc_hold)}`}</Td>
                    <Td className="tabular py-2 text-right">{Number(l.open_requisition_qty) ? qty(l.open_requisition_qty) : "—"}</Td>
                    <Td className={cx("tabular py-2 text-right font-semibold", Number(l.shortage) > 0 ? "text-danger" : l.status === "ON_DEMAND" ? "text-muted" : "text-success")}>
                      {l.status === "ON_DEMAND" ? "—" : qty(l.shortage)}</Td>
                    <Td className="py-2"><Badge tone={STATUS[l.status].tone} dot>{STATUS[l.status].label}</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </table>
            {lines.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted">No gaps — every SOP spare has its stock available.</p>}
          </div>
        )}
        {c && c.counts.NOT_IN_STORE > 0 && (
          <p className="border-t border-line px-4 py-2.5 text-xs text-muted">{c.counts.NOT_IN_STORE} spare line(s) are not aligned with a stores item yet — use “Align with stores” or link them on the SOP spare list.</p>
        )}
      </Card>
    </div>
  );
}

function AddSpare({ machineId, onClose, onDone }: { machineId: number; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", group: "WEAR", criticality: "B", qty_per_machine: "1", sop_stock: "1", uom: "NOS", notes: "", source_ref: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title="Add spare to SOP list" footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button loading={busy} disabled={f.name.trim().length < 3} onClick={async () => {
        setBusy(true); setErr(null);
        try {
          await api(`/api/machines/${machineId}/spares`, { method: "POST", json: { ...f, notes: f.notes || null, source_ref: f.source_ref || null } });
          onDone(); onClose();
        } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
      }}>Add spare</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {err && <div className="sm:col-span-2"><Alert>{err}</Alert></div>}
        <Field label="Spare name" required className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Group"><Select value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })}>{GROUPS.map((g) => <option key={g} value={g}>{g.toLowerCase()}</option>)}</Select></Field>
        <Field label="Criticality"><Select value={f.criticality} onChange={(e) => setF({ ...f, criticality: e.target.value })}><option value="A">A — critical</option><option value="B">B — important</option><option value="C">C — on demand</option></Select></Field>
        <Field label="Qty per machine"><Input type="number" min={0} step="any" value={f.qty_per_machine} onChange={(e) => setF({ ...f, qty_per_machine: e.target.value })} /></Field>
        <Field label="SOP stock per machine"><Input type="number" min={0} step="any" value={f.sop_stock} onChange={(e) => setF({ ...f, sop_stock: e.target.value })} /></Field>
        <Field label="Unit"><Select value={f.uom} onChange={(e) => setF({ ...f, uom: e.target.value })}>{["NOS", "SET", "BOX", "KG", "MTR", "LTR"].map((x) => <option key={x}>{x}</option>)}</Select></Field>
        <Field label="Source / reference"><Input value={f.source_ref} onChange={(e) => setF({ ...f, source_ref: e.target.value })} placeholder="e.g. Service manual p.12" /></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
