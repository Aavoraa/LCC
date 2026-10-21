"use client";

import { Download } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { MovementBadge } from "@/components/MovementBadge";
import { Button, Card, EmptyState, ErrorState, Input, PageHeader, Select, Spinner, Td, Th, cx } from "@/components/ui";
import { dateTime, isInbound, isOutbound, money, MOVEMENT_LABEL, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import type { Movement } from "@/lib/types";

export default function LedgerPage() {
  const [type, setType] = useState("");
  const [ref, setRef] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const s = new URLSearchParams({ page: String(page), page_size: "100" });
  if (type) s.set("movement_type", type);
  if (ref) s.set("ref_doc_no", ref);
  if (from) s.set("date_from", from);
  if (to) s.set("date_to", to);
  const { data, error, loading, reload } = useApi<{ movements: Movement[]; total: number }>(`/api/stock/movements?${s}`, { pollMs: 20000 });

  function exportCsv() {
    if (!data) return;
    const head = ["Number", "Date", "Type", "Item code", "Item", "From", "To", "Quantity", "Unit cost", "Value", "Ref type", "Ref no", "By", "Source"];
    const lines = data.movements.map((m) => [m.number, m.created_at, m.movement_type, m.item_code, m.item_name, m.from_location ?? "", m.to_location ?? "",
      m.quantity, m.unit_cost, m.value, m.ref_doc_type ?? "", m.ref_doc_no ?? "", m.created_by, m.source]);
    const csv = [head, ...lines].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "stock-ledger.csv" });
    a.click();
  }

  return (
    <>
      <PageHeader title="Stock ledger" description="Append-only record of every stock movement. Corrections appear as approved adjustment entries — nothing is edited in place."
        actions={<Button variant="secondary" icon={<Download className="size-4" />} onClick={exportCsv} disabled={!data?.movements.length}>Export CSV</Button>} />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-auto" aria-label="Movement type">
            <option value="">All movement types</option>{Object.entries(MOVEMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Input value={ref} onChange={(e) => { setRef(e.target.value); setPage(1); }} placeholder="Document number" className="w-48" aria-label="Document number" />
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="From date" />
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="To date" />
        </div>
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Spinner /> : !data?.movements.length ? <EmptyState title="No movements" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-[13px]">
              <thead><tr><Th>Txn</Th><Th>When</Th><Th>Type</Th><Th>Item</Th><Th>From → To</Th><Th className="text-right">Qty</Th><Th className="text-right">Value</Th><Th>Document</Th><Th>By</Th></tr></thead>
              <tbody>
                {data.movements.map((m) => (
                  <tr key={m.id} className="h-10 hover:bg-surface-2">
                    <Td className="font-mono text-xs">{m.number}</Td>
                    <Td className="whitespace-nowrap text-xs text-muted">{dateTime(m.created_at)}</Td>
                    <Td><MovementBadge type={m.movement_type} /></Td>
                    <Td><Link href={`/inventory?item=${m.item_id}`} className="font-mono text-xs font-semibold text-primary">{m.item_code}</Link> <span className="text-ink">{m.item_name}</span></Td>
                    <Td className="font-mono text-xs">{m.from_location ?? "·"} → {m.to_location ?? "·"}</Td>
                    <Td className={cx("tabular text-right font-medium", isInbound(m.movement_type) && "text-success", isOutbound(m.movement_type) && "text-danger")}>{qty(m.quantity)}</Td>
                    <Td className="tabular text-right">{money(m.value, true)}</Td>
                    <Td className="text-xs">{m.ref_doc_type ? `${m.ref_doc_type.replace(/_/g, " ").toLowerCase()} ${m.ref_doc_no}` : "—"}</Td>
                    <Td className="text-xs">{m.created_by}{m.source !== "web" && <span className="text-muted"> · {m.source}</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 100 && (
          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-muted">
            <span>Page {page} of {Math.ceil(data.total / 100)}</span>
            <div className="flex gap-1"><Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <Button size="sm" variant="secondary" disabled={page * 100 >= data.total} onClick={() => setPage(page + 1)}>Next</Button></div>
          </div>
        )}
      </Card>
    </>
  );
}
