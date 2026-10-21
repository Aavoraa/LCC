"use client";

import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Alert, Button, Card, EmptyState, ErrorState, Input, PageHeader, Spinner, Td, Th } from "@/components/ui";
import { api, ApiError, uuid } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateTime, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";

interface Bal { item_id: number; item_code: string; item_name: string; uom: string; location_id: number; location: string; qty_on_hand: string; qty_qc_hold: string; updated_at: string }

export default function QcPage() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<Bal[]>("/api/stock/balances?qc_only=true");
  const [release, setRelease] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function doRelease(b: Bal) {
    const key = `${b.item_id}-${b.location_id}`;
    const q = release[key] ?? b.qty_qc_hold;
    setMsg(null);
    try {
      await api("/api/stock/movements", { method: "POST", json: { txn_uuid: uuid(), movement_type: "QC_RELEASE", item_id: b.item_id, quantity: q, from_location_id: b.location_id, notes: "Released after inspection" } });
      setMsg({ ok: true, text: `Released ${q} ${b.uom} of ${b.item_code}` });
      reload();
    } catch (e) { setMsg({ ok: false, text: (e as ApiError).message }); }
  }

  return (
    <>
      <PageHeader title="Quality control" description="Stock on quality hold is excluded from available-to-promise until released. Full inspection plans and rejection handling arrive in Phase 4." />
      {msg && <div className="mb-4"><Alert tone={msg.ok ? "success" : "danger"}>{msg.text}</Alert></div>}
      <Card className="overflow-hidden">
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Spinner /> : !data?.length ? (
          <EmptyState icon={<ShieldCheck className="size-5" />} title="Nothing pending inspection" description="Receipts flagged for QC hold will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead><tr><Th>Item</Th><Th>Location</Th><Th className="text-right">On hand</Th><Th className="text-right">On QC hold</Th><Th>Since</Th><Th className="text-right">Release</Th></tr></thead>
              <tbody>{data.map((b) => {
                const key = `${b.item_id}-${b.location_id}`;
                return (
                  <tr key={key}>
                    <Td className="py-2"><span className="font-mono text-xs font-semibold text-primary">{b.item_code}</span> {b.item_name}</Td>
                    <Td className="py-2 font-mono text-xs">{b.location}</Td>
                    <Td className="tabular py-2 text-right">{qty(b.qty_on_hand)}</Td>
                    <Td className="tabular py-2 text-right font-semibold text-warning">{qty(b.qty_qc_hold)} {b.uom}</Td>
                    <Td className="py-2 text-xs text-muted">{dateTime(b.updated_at)}</Td>
                    <Td className="py-2">
                      {can("qc.hold") ? (
                        <div className="flex justify-end gap-2">
                          <Input type="number" min={0} max={Number(b.qty_qc_hold)} step="any" className="h-8 w-24" aria-label="Release quantity"
                                 value={release[key] ?? b.qty_qc_hold} onChange={(e) => setRelease({ ...release, [key]: e.target.value })} />
                          <Button size="sm" variant="success" onClick={() => doRelease(b)}>Release</Button>
                        </div>
                      ) : <span className="block text-right text-xs text-muted">QC role required</span>}
                    </Td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
