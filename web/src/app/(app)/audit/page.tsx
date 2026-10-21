"use client";

import { useState } from "react";
import { Button, Card, EmptyState, ErrorState, Input, PageHeader, Spinner, Td, Th } from "@/components/ui";
import { dateTime } from "@/lib/format";
import { useApi } from "@/lib/hooks";

interface Event { id: number; at: string; user: string | null; action: string; entity_type: string; entity_id: string | null; data: Record<string, unknown> | null }

export default function AuditPage() {
  const [action, setAction] = useState("");
  const [entity, setEntity] = useState("");
  const [page, setPage] = useState(1);
  const s = new URLSearchParams({ page: String(page), page_size: "100" });
  if (action) s.set("action", action);
  if (entity) s.set("entity_type", entity);
  const { data, error, loading, reload } = useApi<{ total: number; events: Event[] }>(`/api/audit?${s}`);
  const [open, setOpen] = useState<number | null>(null);

  return (
    <>
      <PageHeader title="Audit trail" description="Every state-changing action with actor, time and payload. Read-only." />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Input value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} placeholder="Action prefix, e.g. stock. or item." className="w-64" aria-label="Action" />
          <Input value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }} placeholder="Entity type, e.g. item" className="w-48" aria-label="Entity type" />
        </div>
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Spinner /> : !data?.events.length ? <EmptyState title="No events" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-[13px]">
              <thead><tr><Th>When</Th><Th>User</Th><Th>Action</Th><Th>Entity</Th><Th>Details</Th></tr></thead>
              <tbody>{data.events.map((e) => (
                <tr key={e.id} className="align-top hover:bg-surface-2">
                  <Td className="whitespace-nowrap py-2 text-xs text-muted">{dateTime(e.at)}</Td>
                  <Td className="py-2">{e.user ?? <span className="text-muted">system / anonymous</span>}</Td>
                  <Td className="py-2 font-mono text-xs">{e.action}</Td>
                  <Td className="py-2 text-xs">{e.entity_type}{e.entity_id ? ` #${e.entity_id}` : ""}</Td>
                  <Td className="py-2">
                    {e.data && (open === e.id
                      ? <pre className="max-w-xl overflow-x-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-[11px]">{JSON.stringify(e.data, null, 2)}</pre>
                      : <button className="text-xs text-primary hover:underline" onClick={() => setOpen(e.id)}>View payload</button>)}
                  </Td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {data && data.total > 100 && (
          <div className="flex justify-end gap-1 border-t border-line px-3 py-2">
            <Button size="sm" variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button size="sm" variant="secondary" disabled={page * 100 >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        )}
      </Card>
    </>
  );
}
