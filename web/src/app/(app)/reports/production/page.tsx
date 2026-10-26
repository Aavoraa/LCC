"use client";

import { FileSpreadsheet, Search } from "lucide-react";
import { useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, PageHeader, Spinner, Td, Th, cx } from "@/components/ui";
import { ApiError, download } from "@/lib/api";
import { money, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";

interface Row {
  org: string; job_type: string; job_no: string; work_order_id: number; item_id: number; item_no: string; item_desc: string;
  transaction_qty: string; primary_qty: string; transaction_uom: string; transaction_date: string; remarks: "COMPLETED" | "PARTIAL COMPLETION";
  wip_value: string; start_qty: string; qty_completed: string; job_status: string; cost_incurred: string; cost_relieved: string;
}
interface Report {
  date_from: string; date_to: string; rows: Row[];
  totals: { transactions: number; jobs: number; quantity: string; wip_value: string; completed: number };
}

const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
/** 08-OCT-2026, as the Oracle report prints dates. */
const oracleDate = (v: string) => new Date(`${v}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase().replace(/ /g, "-");

export default function ProductionDetailsPage() {
  const [draft, setDraft] = useState({ from: istToday(), to: istToday(), q: "" });
  const [applied, setApplied] = useState(draft);
  const [err, setErr] = useState<string | null>(null);
  const qs = new URLSearchParams({ date_from: applied.from, date_to: applied.to, ...(applied.q ? { q: applied.q } : {}) }).toString();
  const rep = useApi<Report>(`/api/reports/production?${qs}`);

  return (
    <>
      <PageHeader title="Production details for given date" description="Every work-order completion (job completion transaction) in the period — the Oracle “LCC Production Details” report."
        actions={<Button variant="secondary" icon={<FileSpreadsheet className="size-4" />} disabled={!rep.data?.rows.length}
          onClick={() => download(`/api/reports/production.xlsx?${qs}`, `LCC Production Details ${applied.from} to ${applied.to}.xlsx`).catch((e: ApiError) => setErr(e.message))}>Excel</Button>} />
      <Card className="mb-5 p-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setApplied(draft); }}>
          <Field label="From date" className="w-44"><Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></Field>
          <Field label="To date" className="w-44"><Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Field>
          <Field label="Job / item" className="min-w-[200px] flex-1"><Input value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder="WO number, item no or description" /></Field>
          <Button type="submit" icon={<Search className="size-4" />}>Run report</Button>
        </form>
        {err && <div className="mt-3"><Alert>{err}</Alert></div>}
      </Card>

      {rep.data && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {([["Transactions", rep.data.totals.transactions], ["Jobs", rep.data.totals.jobs], ["Quantity completed", qty(rep.data.totals.quantity)],
            ["Jobs completed", rep.data.totals.completed], ["WIP value", money(rep.data.totals.wip_value)]] as [string, React.ReactNode][]).map(([l, v]) => (
            <div key={l} className="rounded-lg border border-line bg-surface p-3 shadow-card">
              <p className="text-xs text-muted">{l}</p><p className="tabular text-lg font-semibold">{v}</p>
            </div>
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="border-b border-line px-4 py-2 text-xs text-muted">
          From Date: <span className="font-semibold text-ink">{oracleDate(applied.from)}</span> · To Date: <span className="font-semibold text-ink">{oracleDate(applied.to)}</span>
        </div>
        {rep.error ? <ErrorState error={rep.error} onRetry={rep.reload} /> : !rep.data ? <Spinner /> : rep.data.rows.length === 0 ? (
          <EmptyState title="No completions in this period" description="Rows appear when Production completes quantity on a work order." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1500px] text-[12.5px]">
              <thead><tr>
                <Th>Org</Th><Th>Job type</Th><Th>Job no</Th><Th>Item no</Th><Th>Item desc</Th><Th className="text-right">Transaction qty</Th>
                <Th className="text-right">Primary qty</Th><Th>Txn UOM</Th><Th>Transaction date</Th><Th>Remarks</Th><Th className="text-right">WIP value</Th>
                <Th className="text-right">Start qty</Th><Th className="text-right">Qty completed</Th><Th>Job status</Th><Th className="text-right">Cost incurred</Th>
                <Th className="text-right">Cost relieved</Th>
              </tr></thead>
              <tbody>{rep.data.rows.map((r, i) => (
                <tr key={`${r.job_no}-${i}`} className="hover:bg-surface-2">
                  <Td className="h-9">{r.org}</Td>
                  <Td className="text-xs">{r.job_type}</Td>
                  <Td className="font-mono text-xs">{r.job_no}</Td>
                  <Td className="font-mono text-xs"><a href={`/locator?item=${r.item_id}`} className="text-primary">{r.item_no}</a></Td>
                  <Td className="max-w-[320px] truncate" title={r.item_desc}>{r.item_desc}</Td>
                  <Td className="tabular text-right">{qty(r.transaction_qty)}</Td>
                  <Td className="tabular text-right">{qty(r.primary_qty)}</Td>
                  <Td>{r.transaction_uom}</Td>
                  <Td className="whitespace-nowrap">{oracleDate(r.transaction_date)}</Td>
                  <Td><Badge tone={r.remarks === "COMPLETED" ? "success" : "warning"}>{r.remarks}</Badge></Td>
                  <Td className="tabular text-right">{Number(r.wip_value).toFixed(2)}</Td>
                  <Td className="tabular text-right">{qty(r.start_qty)}</Td>
                  <Td className="tabular text-right">{qty(r.qty_completed)}</Td>
                  <Td className={cx("text-xs font-medium", r.job_status === "COMPLETED" ? "text-success" : "text-ink-2")}>{r.job_status}</Td>
                  <Td className="tabular text-right">{Number(r.cost_incurred) ? Number(r.cost_incurred).toFixed(2) : ""}</Td>
                  <Td className="tabular text-right">{Number(r.cost_relieved) ? Number(r.cost_relieved).toFixed(2) : ""}</Td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-4 py-2 text-xs text-muted">
          WIP value = value of the quantity completed in that transaction. Cost incurred = material issued to the job (less returns); cost relieved = completions booked into stores.
        </p>
      </Card>
    </>
  );
}
