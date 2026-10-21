"use client";

import { Building2, Factory, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { Alert, Badge, Button, Input, Modal, Select, Spinner, cx } from "./ui";

type Mode = "IN_HOUSE" | "OUTSIDE";
interface Step {
  seq: number; operation: string; work_center: string | null; mode: Mode;
  setup_min: string; run_min: string; outside_days: number; notes: string | null;
}
interface Route {
  item_id: number; applicable: boolean; standard_route: string; batch_qty: string; production_lead_days: number;
  steps: Step[];
  estimate: null | {
    qty: string; hours_per_day: number; steps: { seq: number; minutes: string | null; days: number | null }[];
    in_house_hours: string; in_house_days: number; outside_days: number; total_days: number;
    in_house_steps: number; outside_steps: number;
  };
}

const hours = (min: number) => (min >= 60 ? `${(min / 60).toFixed(1)} h` : `${Math.round(min)} min`);

function ModeBadge({ mode }: { mode: Mode }) {
  return mode === "IN_HOUSE"
    ? <Badge tone="success"><Factory className="mr-1 inline size-3" />In-house</Badge>
    : <Badge tone="warning"><Building2 className="mr-1 inline size-3" />Outside</Badge>;
}

/** Manufacturing route of a made item: operations, in-house vs outside job-work, and the make-time estimate. */
export function ProcessRoute({ itemId, uom, onChanged }: { itemId: number; uom: string; onChanged?: () => void }) {
  const { can } = useAuth();
  const [batch, setBatch] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(batch), 350); return () => clearTimeout(t); }, [batch]);
  const route = useApi<Route>(`/api/items/${itemId}/process${Number(debounced) > 0 ? `?qty=${debounced}` : ""}`);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const r = route.data;
  if (!r) return <Spinner />;
  if (!r.applicable) return null;
  const est = r.estimate;
  const perStep = new Map(est?.steps.map((s) => [s.seq, s]) ?? []);

  async function resetStandard() {
    setBusy(true); setErr(null);
    try { await api(`/api/items/${itemId}/process/standard`, { method: "POST" }); route.reload(); onChanged?.(); }
    catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }

  return (
    <section className="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Manufacturing process</h3>
        {can("items.edit") && (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>Edit route</Button>
            <Button size="sm" variant="ghost" loading={busy} icon={<RotateCcw className="size-3.5" />} onClick={resetStandard}
              title={`Replace with the standard "${r.standard_route.replace(/_/g, " ")}" route`}>Standard</Button>
          </div>
        )}
      </div>
      {err && <div className="mb-3"><Alert>{err}</Alert></div>}

      {r.steps.length === 0 ? (
        <p className="text-sm text-muted">No route yet. {can("items.edit") && "Use Standard to start from the usual route for this kind of part."}</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-3 rounded-lg bg-surface-2 p-3">
            <label className="text-[11px] text-muted">
              Batch qty ({uom})
              <Input type="number" min={1} step="any" className="mt-0.5 h-8 w-24" placeholder={qty(r.batch_qty)} value={batch}
                onChange={(e) => setBatch(e.target.value)} aria-label="Batch quantity" />
            </label>
            {est && (
              <div className="grid flex-1 grid-cols-3 gap-2 text-center">
                <div><p className="text-[11px] text-muted">In-house</p><p className="tabular text-sm font-semibold">{Number(est.in_house_hours).toFixed(1)} h · {est.in_house_days} d</p></div>
                <div><p className="text-[11px] text-muted">Outside</p><p className="tabular text-sm font-semibold">{est.outside_days} d</p></div>
                <div><p className="text-[11px] text-muted">Make time</p><p className="tabular text-base font-semibold text-primary">{est.total_days} working days</p></div>
              </div>
            )}
          </div>
          <ol className="space-y-1.5">
            {r.steps.map((s) => {
              const t = perStep.get(s.seq);
              return (
                <li key={s.seq} className={cx("flex items-start gap-3 rounded-md border px-3 py-2 text-[13px]",
                  s.mode === "OUTSIDE" ? "border-warning/40 bg-warning-soft/30" : "border-line")}>
                  <span className="mt-0.5 w-5 shrink-0 font-mono text-xs text-muted">{s.seq}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink">{s.operation}</p>
                    <p className="text-xs text-muted">
                      {s.work_center ?? "—"}
                      {s.mode === "IN_HOUSE" && ` · setup ${Number(s.setup_min)} min + ${Number(s.run_min)} min/${uom.toLowerCase()}`}
                      {s.notes && ` · ${s.notes}`}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <ModeBadge mode={s.mode} />
                    <p className="tabular mt-0.5 text-xs font-medium text-ink-2">
                      {s.mode === "OUTSIDE" ? `${s.outside_days} days` : t?.minutes != null ? hours(Number(t.minutes)) : "—"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
          {est && (
            <p className="mt-2 text-xs text-muted">
              {est.in_house_steps} in-house and {est.outside_steps} outside steps for {qty(est.qty)} {uom}. In-house time is
              converted at {est.hours_per_day} shop hours/day; outside days include transport. Production lead time used for
              delivery estimates: {r.production_lead_days} days (standard batch {qty(r.batch_qty)}).
            </p>
          )}
        </>
      )}
      {editing && <RouteEditor itemId={itemId} steps={r.steps} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); route.reload(); onChanged?.(); }} />}
    </section>
  );
}

type Draft = { operation: string; work_center: string; mode: Mode; setup_min: string; run_min: string; outside_days: string; notes: string };
const blank: Draft = { operation: "", work_center: "", mode: "IN_HOUSE", setup_min: "0", run_min: "0", outside_days: "0", notes: "" };

function RouteEditor({ itemId, steps, onClose, onSaved }: { itemId: number; steps: Step[]; onClose: () => void; onSaved: () => void }) {
  const [rows, setRows] = useState<Draft[]>(() => steps.map((s) => ({
    operation: s.operation, work_center: s.work_center ?? "", mode: s.mode, setup_min: String(Number(s.setup_min)),
    run_min: String(Number(s.run_min)), outside_days: String(s.outside_days), notes: s.notes ?? "",
  })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (i: number, patch: Partial<Draft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api(`/api/items/${itemId}/process`, { method: "PUT", json: { steps: rows.map((r) => ({
        operation: r.operation, work_center: r.work_center || null, mode: r.mode, notes: r.notes || null,
        setup_min: r.mode === "IN_HOUSE" ? r.setup_min || "0" : "0", run_min: r.mode === "IN_HOUSE" ? r.run_min || "0" : "0",
        outside_days: r.mode === "OUTSIDE" ? Number(r.outside_days || 0) : 0,
      })) } });
      onSaved();
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Edit manufacturing route" width="max-w-4xl"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save route</Button></>}>
      {err && <div className="mb-3"><Alert>{err}</Alert></div>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead className="text-left text-[11px] text-muted">
            <tr><th className="w-6">#</th><th>Operation</th><th>Work centre / vendor trade</th><th className="w-32">Where</th>
              <th className="w-20">Setup min</th><th className="w-20">Run min/unit</th><th className="w-20">Vendor days</th><th className="w-8" /></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line align-top">
                <td className="py-1.5 font-mono text-xs text-muted">{i + 1}</td>
                <td className="py-1.5 pr-1"><Input className="h-8" value={r.operation} onChange={(e) => set(i, { operation: e.target.value })} aria-label="Operation" /></td>
                <td className="py-1.5 pr-1"><Input className="h-8" value={r.work_center} onChange={(e) => set(i, { work_center: e.target.value })} aria-label="Work centre" /></td>
                <td className="py-1.5 pr-1">
                  <Select className="h-8" value={r.mode} onChange={(e) => set(i, { mode: e.target.value as Mode })} aria-label="In-house or outside">
                    <option value="IN_HOUSE">In-house</option><option value="OUTSIDE">Outside</option>
                  </Select>
                </td>
                <td className="py-1.5 pr-1"><Input className="h-8" type="number" min={0} step="any" disabled={r.mode !== "IN_HOUSE"} value={r.setup_min} onChange={(e) => set(i, { setup_min: e.target.value })} aria-label="Setup minutes" /></td>
                <td className="py-1.5 pr-1"><Input className="h-8" type="number" min={0} step="any" disabled={r.mode !== "IN_HOUSE"} value={r.run_min} onChange={(e) => set(i, { run_min: e.target.value })} aria-label="Run minutes per unit" /></td>
                <td className="py-1.5 pr-1"><Input className="h-8" type="number" min={0} step={1} disabled={r.mode !== "OUTSIDE"} value={r.outside_days} onChange={(e) => set(i, { outside_days: e.target.value })} aria-label="Vendor days" /></td>
                <td className="py-1.5"><Button size="sm" variant="ghost" aria-label="Remove step" icon={<Trash2 className="size-3.5" />} onClick={() => setRows(rows.filter((_, j) => j !== i))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button className="mt-3" size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => setRows([...rows, { ...blank }])}>Add step</Button>
      <p className="mt-2 text-xs text-muted">Steps run in order. Saving recalculates the item&apos;s production lead time.</p>
    </Modal>
  );
}
