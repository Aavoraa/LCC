"use client";

import { ClipboardList, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Spinner, Td, Th } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateFmt } from "@/lib/format";
import { useApi } from "@/lib/hooks";

export interface CountBrief {
  id: number; number: string; scope: string; due_date: string; status: "OPEN" | "SUBMITTED" | "CANCELLED"; notes: string | null;
  lines_total: number; lines_counted: number; variances: number; overdue: boolean; created_by: string | null; created_at: string;
  submitted_by: string | null; submitted_at: string | null;
}

export default function CycleCountsPage() {
  const { can } = useAuth();
  const counts = useApi<CountBrief[]>("/api/inventory/cycle-counts");
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader title="Cycle counts" description="Count the stock at a rack or bin. Differences from the ledger become adjustment requests that a second user approves."
        actions={can("stock.adjust.request") && <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New count</Button>} />
      <Card className="overflow-hidden">
        {counts.error ? <ErrorState error={counts.error} onRetry={counts.reload} /> : !counts.data ? <Spinner /> : counts.data.length === 0 ? (
          <EmptyState icon={<ClipboardList className="size-8" />} title="No cycle counts yet" description="Start one for a rack (e.g. MAIN-R01) or a single bin." />
        ) : (
          <table className="w-full text-[13px]">
            <thead><tr><Th>Count</Th><Th>Locations</Th><Th>Due</Th><Th className="text-right">Counted</Th><Th className="text-right">Variances</Th><Th>Status</Th><Th>Raised by</Th></tr></thead>
            <tbody>{counts.data.map((c) => (
              <tr key={c.id} className="hover:bg-surface-2">
                <Td className="h-10"><Link href={`/inventory/cycle-counts/${c.id}`} className="font-mono text-xs font-semibold text-primary">{c.number}</Link></Td>
                <Td className="font-mono text-xs">{c.scope}</Td>
                <Td>{dateFmt(c.due_date)}</Td>
                <Td className="tabular text-right">{c.lines_counted} / {c.lines_total}</Td>
                <Td className="tabular text-right">{c.status === "SUBMITTED" ? c.variances : "—"}</Td>
                <Td><Badge tone={c.status === "SUBMITTED" ? "success" : c.status === "CANCELLED" ? "neutral" : c.overdue ? "danger" : "warning"} dot>
                  {c.status === "OPEN" ? (c.overdue ? "Late" : "Open") : c.status.toLowerCase()}</Badge></Td>
                <Td className="text-xs">{c.created_by}</Td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {creating && <NewCount onClose={() => setCreating(false)} />}
    </>
  );
}

function NewCount({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [f, setF] = useState({ scope: "", due_date: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title="New cycle count" footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button loading={busy} disabled={!f.scope.trim()} onClick={async () => {
        setBusy(true); setErr(null);
        try {
          const c = await api<CountBrief>("/api/inventory/cycle-counts", { method: "POST", json: { scope: f.scope, due_date: f.due_date || null, notes: f.notes || null } });
          router.push(`/inventory/cycle-counts/${c.id}`);
        } catch (e) { setErr((e as ApiError).message); setBusy(false); }
      }}>Create count sheet</Button>
    </>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <Field label="Locations" required hint="Part of a location code: MAIN-R01 counts the whole rack, R03-B02 one bin">
          <Input value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value.toUpperCase() })} placeholder="MAIN-R01" autoFocus />
        </Field>
        <Field label="Due date" hint="Blank = today"><Input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
        <Field label="Notes"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
