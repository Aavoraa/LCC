"use client";

import { CheckCircle2, CircleAlert } from "lucide-react";
import Link from "next/link";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Spinner, StockBadge, Td, Th } from "@/components/ui";
import { money, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { itemTypeLabel, type ItemRow } from "@/lib/types";

export default function ReportsPage() {
  const low = useApi<{ items: ItemRow[] }>("/api/items?stock_status=LOW&page_size=200");
  const out = useApi<{ items: ItemRow[] }>("/api/items?stock_status=OUT&page_size=200");
  const all = useApi<{ items: ItemRow[]; total: number }>("/api/items?page_size=500");
  const rec = useApi<{ balanced: boolean; mismatches: { item_id: number; location_id: number; ledger_qty: string; balance_qty: string }[] }>("/api/stock/reconcile");

  const valuation = (all.data?.items ?? []).reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.item_type]: (acc[i.item_type] ?? 0) + Number(i.valuation) }), {});
  const shortages = [...(out.data?.items ?? []), ...(low.data?.items ?? [])];

  return (
    <>
      <PageHeader title="Reports & analytics" description="Live operational reports from the ledger. Financial registers, ageing and GL reports arrive with the Accounts module (Phase 6–7)." />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Ledger reconciliation" subtitle="Balance projection re-derived from every stock movement" />
          <div className="p-4">
            {!rec.data ? <Spinner /> : rec.data.balanced ? (
              <p className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="size-5" /> All stock balances reconcile to the ledger.</p>
            ) : (
              <>
                <p className="flex items-center gap-2 text-sm text-danger"><CircleAlert className="size-5" /> {rec.data.mismatches.length} balance(s) differ from the ledger.</p>
                <ul className="mt-2 text-xs">{rec.data.mismatches.map((m) => <li key={`${m.item_id}-${m.location_id}`}>Item {m.item_id} @ location {m.location_id}: ledger {m.ledger_qty} vs balance {m.balance_qty}</li>)}</ul>
              </>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Stock valuation by stream" subtitle="Weighted average cost × on hand" />
          <table className="w-full text-[13px]">
            <tbody>
              {Object.entries(valuation).sort((a, b) => b[1] - a[1]).map(([t, v]) => (
                <tr key={t}><Td className="h-9">{itemTypeLabel(t)}</Td><Td className="tabular text-right font-medium">{money(v)}</Td></tr>
              ))}
              <tr><Td className="h-10 font-semibold text-ink">Total</Td><Td className="tabular text-right font-semibold text-ink">{money(Object.values(valuation).reduce((a, b) => a + b, 0))}</Td></tr>
            </tbody>
          </table>
        </Card>
        <Card className="overflow-hidden xl:col-span-2">
          <CardHeader title="Low-stock & out-of-stock report" subtitle="Available quantity at or below the reorder level" actions={<Badge tone="warning">{shortages.length} items</Badge>} />
          {!low.data || !out.data ? <Spinner /> : shortages.length === 0 ? <EmptyState title="No shortages" /> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-[13px]">
                <thead><tr><Th>Item</Th><Th>Type</Th><Th className="text-right">Available</Th><Th className="text-right">Reorder level</Th><Th className="text-right">Suggested order</Th><Th>Status</Th></tr></thead>
                <tbody>{shortages.map((i) => (
                  <tr key={i.id} className="hover:bg-surface-2">
                    <Td className="h-9"><Link href={`/inventory?item=${i.id}`} className="font-mono text-xs font-semibold text-primary">{i.item_code}</Link> {i.name}</Td>
                    <Td className="text-xs">{itemTypeLabel(i.item_type)}</Td>
                    <Td className="tabular text-right">{qty(i.available)} {i.uom}</Td>
                    <Td className="tabular text-right">{qty(i.reorder_level)}</Td>
                    <Td className="tabular text-right font-medium">{qty(Math.max(0, Number(i.reorder_level) * 2 - Number(i.available)))}</Td>
                    <Td><StockBadge status={i.stock_status} /></Td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <p className="border-t border-line px-4 py-2 text-xs text-muted">Suggested order = 2 × reorder level − available (placeholder rule until max-stock based replenishment is configured).</p>
        </Card>
      </div>
    </>
  );
}
