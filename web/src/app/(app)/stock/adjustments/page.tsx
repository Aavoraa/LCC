"use client";

import { Check, X } from "lucide-react";
import { useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Modal, PageHeader, Spinner, Td, Th, Textarea, cx } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateTime, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";

interface Adj { id: number; number: string; item_code: string; item_name: string; location: string; qty_delta: string; reason: string; status: string; requested_by: string; decided_by: string | null; decision_note: string | null; created_at: string }

export default function AdjustmentsPage() {
  const { can, user } = useAuth();
  const [status, setStatus] = useState("PENDING");
  const { data, error, loading, reload } = useApi<Adj[]>(`/api/stock/adjustments${status ? `?status=${status}` : ""}`);
  const [deciding, setDeciding] = useState<{ adj: Adj; approve: boolean } | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <PageHeader title="Stock adjustments" description="Corrections are requested by one user and approved by another (maker–checker). Approval posts a traceable adjustment movement." />
      <div className="mb-3 flex gap-1">
        {["PENDING", "APPROVED", "REJECTED", ""].map((s) => (
          <button key={s} onClick={() => setStatus(s)} className={cx("rounded-md px-3 py-1.5 text-sm", status === s ? "bg-surface font-medium text-ink shadow-card ring-1 ring-line" : "text-muted hover:text-ink")}>
            {s ? s[0] + s.slice(1).toLowerCase() : "All"}
          </button>
        ))}
      </div>
      <Card className="overflow-hidden">
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Spinner /> : !data?.length ? <EmptyState title="Nothing here" description="Adjustment requests are raised from Scan & transact." /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-[13px]">
              <thead><tr><Th>Request</Th><Th>Item</Th><Th>Location</Th><Th className="text-right">Change</Th><Th>Reason</Th><Th>Requested</Th><Th>Status</Th><Th /></tr></thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.id} className="hover:bg-surface-2">
                    <Td className="py-2.5 font-mono text-xs">{a.number}</Td>
                    <Td className="py-2.5"><span className="font-mono text-xs font-semibold text-primary">{a.item_code}</span> {a.item_name}</Td>
                    <Td className="py-2.5 font-mono text-xs">{a.location}</Td>
                    <Td className={cx("tabular py-2.5 text-right font-semibold", Number(a.qty_delta) < 0 ? "text-danger" : "text-success")}>{Number(a.qty_delta) > 0 ? "+" : ""}{qty(a.qty_delta)}</Td>
                    <Td className="max-w-xs py-2.5 text-xs">{a.reason}</Td>
                    <Td className="py-2.5 text-xs">{a.requested_by}<span className="block text-muted">{dateTime(a.created_at)}</span></Td>
                    <Td className="py-2.5"><Badge tone={a.status === "APPROVED" ? "success" : a.status === "REJECTED" ? "danger" : "warning"}>{a.status.toLowerCase()}</Badge>
                      {a.decided_by && <span className="block text-[11px] text-muted">by {a.decided_by}</span>}</Td>
                    <Td className="py-2.5 text-right">
                      {a.status === "PENDING" && can("stock.adjust.approve") && (a.requested_by === user?.full_name
                        ? <span className="text-xs text-muted">Your request</span>
                        : <div className="flex justify-end gap-1">
                            <Button size="sm" variant="success" icon={<Check className="size-3.5" />} onClick={() => { setDeciding({ adj: a, approve: true }); setNote(""); setErr(null); }}>Approve</Button>
                            <Button size="sm" variant="secondary" icon={<X className="size-3.5" />} onClick={() => { setDeciding({ adj: a, approve: false }); setNote(""); setErr(null); }}>Reject</Button>
                          </div>)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Modal open={!!deciding} onClose={() => setDeciding(null)} title={`${deciding?.approve ? "Approve" : "Reject"} ${deciding?.adj.number}`}
        footer={<><Button variant="secondary" onClick={() => setDeciding(null)}>Cancel</Button>
          <Button variant={deciding?.approve ? "success" : "danger"} loading={busy} onClick={async () => {
            setBusy(true); setErr(null);
            try { await api(`/api/stock/adjustments/${deciding!.adj.id}/decision`, { method: "POST", json: { approve: deciding!.approve, note: note || null } }); setDeciding(null); reload(); }
            catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
          }}>{deciding?.approve ? "Approve & post" : "Reject"}</Button></>}>
        {deciding && (
          <div className="space-y-3 text-sm">
            {err && <Alert>{err}</Alert>}
            <p>{deciding.adj.item_code} · {deciding.adj.item_name} at <b className="font-mono">{deciding.adj.location}</b>: <b>{Number(deciding.adj.qty_delta) > 0 ? "+" : ""}{qty(deciding.adj.qty_delta)}</b></p>
            <p className="text-muted">Reason: {deciding.adj.reason}</p>
            <Textarea placeholder="Decision note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        )}
      </Modal>
    </>
  );
}
