"use client";

import { ArrowLeft, Printer, Save, Send } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, CardHeader, ErrorState, Input, Spinner, Td, Th, cx } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateFmt, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import type { CountBrief } from "../page";

interface Line {
  id: number; item_id: number; item_code: string; item_name: string; uom: string; location: string;
  counted_qty: string | null; system_qty: string | null; variance: string | null; adjustment_id: number | null;
}
interface CountDetail extends CountBrief { lines: Line[]; adjustments?: string[] }

export default function CycleCountPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const c = useApi<CountDetail>(`/api/inventory/cycle-counts/${id}`);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (c.data) setCounts(Object.fromEntries(c.data.lines.map((l) => [l.id, l.counted_qty == null ? "" : String(Number(l.counted_qty))])));
  }, [c.data]);

  if (c.error) return <ErrorState error={c.error} onRetry={c.reload} />;
  const d = c.data;
  if (!d) return <Spinner />;
  const open = d.status === "OPEN" && can("stock.adjust.request");
  const changed = d.lines.filter((l) => (l.counted_qty == null ? "" : String(Number(l.counted_qty))) !== (counts[l.id] ?? ""));

  async function save() {
    await api(`/api/inventory/cycle-counts/${id}/lines`, { method: "PUT",
      json: changed.map((l) => ({ line_id: l.id, counted_qty: counts[l.id] === "" ? null : counts[l.id] })) });
  }
  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key); setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); c.reload(); } catch (e) { setMsg({ ok: false, text: (e as ApiError).message }); } finally { setBusy(null); }
  }

  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <Link href="/inventory/cycle-counts" className="inline-flex items-center gap-1 text-sm text-primary"><ArrowLeft className="size-4" /> Cycle counts</Link>
        <span className="font-mono text-sm font-semibold">{d.number}</span>
        <Badge tone={d.status === "SUBMITTED" ? "success" : d.overdue ? "danger" : "warning"} dot>{d.status === "OPEN" ? (d.overdue ? "Late" : "Open") : d.status.toLowerCase()}</Badge>
        <span className="text-sm text-muted">Locations <span className="font-mono">{d.scope}</span> · due {dateFmt(d.due_date)}</span>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" icon={<Printer className="size-4" />} onClick={() => window.print()}>Print count sheet</Button>
          {open && <>
            <Button variant="secondary" icon={<Save className="size-4" />} disabled={!changed.length} loading={busy === "save"} onClick={() => run("save", async () => { await save(); return "Counts saved"; })}>Save</Button>
            <Button icon={<Send className="size-4" />} loading={busy === "submit"} onClick={() => run("submit", async () => {
              if (changed.length) await save();
              const r = await api<CountDetail>(`/api/inventory/cycle-counts/${id}/submit`, { method: "POST" });
              return r.adjustments?.length ? `Submitted — ${r.adjustments.length} adjustment request(s) sent for approval: ${r.adjustments.join(", ")}` : "Submitted — stock matches the ledger";
            })}>Submit count</Button>
            <Button variant="ghost" loading={busy === "cancel"} onClick={() => confirm("Cancel this count?") && run("cancel", async () => {
              await api(`/api/inventory/cycle-counts/${id}/cancel`, { method: "POST" }); return "Count cancelled";
            })}>Cancel count</Button>
          </>}
        </div>
      </div>
      {msg && <div className="no-print mb-4"><Alert tone={msg.ok ? "success" : "danger"}>{msg.text}</Alert></div>}

      <Card className="overflow-hidden">
        <CardHeader title={`Count sheet ${d.number}`} subtitle={d.status === "OPEN" ? "Blind count: the ledger quantity is shown after you submit. Enter 0 for items not found." : `Submitted by ${d.submitted_by ?? "—"}`} />
        <table className="w-full text-[13px]">
          <thead><tr><Th>Location</Th><Th>Item</Th><Th>UOM</Th><Th className="text-right">Counted</Th>
            {d.status !== "OPEN" && <><Th className="text-right">Ledger</Th><Th className="text-right">Variance</Th><Th>Adjustment</Th></>}</tr></thead>
          <tbody>{d.lines.map((l) => (
            <tr key={l.id} className="hover:bg-surface-2">
              <Td className="h-10 font-mono text-xs">{l.location}</Td>
              <Td><span className="font-mono text-xs font-semibold text-primary">{l.item_code}</span> {l.item_name}</Td>
              <Td className="text-xs">{l.uom}</Td>
              <Td className="w-36 text-right">
                {open ? <Input type="number" min={0} step="any" inputMode="decimal" value={counts[l.id] ?? ""} aria-label={`Counted ${l.item_name}`}
                  onChange={(e) => setCounts({ ...counts, [l.id]: e.target.value })} className="h-8 text-right print:border-0" />
                  : <span className="tabular">{l.counted_qty == null ? "—" : qty(l.counted_qty)}</span>}
              </Td>
              {d.status !== "OPEN" && <>
                <Td className="tabular text-right">{l.system_qty == null ? "—" : qty(l.system_qty)}</Td>
                <Td className={cx("tabular text-right font-semibold", Number(l.variance) < 0 && "text-danger", Number(l.variance) > 0 && "text-success")}>
                  {l.variance == null ? "—" : `${Number(l.variance) > 0 ? "+" : ""}${qty(l.variance)}`}</Td>
                <Td className="text-xs">{l.adjustment_id ? <Link href="/stock/adjustments" className="text-primary">Awaiting approval</Link> : "—"}</Td>
              </>}
            </tr>
          ))}</tbody>
        </table>
      </Card>
    </>
  );
}
