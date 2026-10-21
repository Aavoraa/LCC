"use client";

import { CheckCircle2, FileSpreadsheet, Upload } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, PageHeader, Select, Td, Th, cx } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { useApi } from "@/lib/hooks";

interface Row { id: number; row_no: number; raw: Record<string, string>; mapped: Record<string, string>; status: string; errors: string[]; duplicate_item_id: number | null; resolution: string | null; result_item_id: number | null }
interface Batch { id: number; number: string; filename: string; status: string; headers: string[]; mapping: Record<string, string>; summary: Record<string, number>; uploaded_by: string; uploaded_by_id: number; created_at: string; fields: Record<string, { label: string; required: boolean }>; rows: Row[] | null }

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "primary"> = { VALID: "success", DUPLICATE: "warning", INVALID: "danger", IMPORTED: "primary", SKIPPED: "neutral", PENDING: "neutral" };

export default function ImportPage() {
  const { can, user } = useAuth();
  const history = useApi<Batch[]>("/api/imports");
  const [batch, setBatch] = useState<Batch | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  }

  async function upload(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const b = await run(() => api<Batch>("/api/imports", { method: "POST", body: fd }));
    if (b) { setBatch(b); setMapping(b.mapping); history.reload(); }
  }

  async function open(id: number) {
    const b = await run(() => api<Batch>(`/api/imports/${id}`));
    if (b) { setBatch(b); setMapping(b.mapping); }
  }

  const step = !batch ? 1 : batch.status === "UPLOADED" ? 2 : batch.status === "VALIDATED" ? 3 : 4;
  const rows = (batch?.rows ?? []).filter((r) => !filter || r.status === filter);
  const isUploader = batch?.uploaded_by_id === user?.id;

  return (
    <>
      <PageHeader title="Import existing inventory" description="Upload CSV or Excel → map columns → review validation and duplicates → approval posts opening stock." />
      <ol className="mb-5 flex flex-wrap gap-2 text-sm">
        {["Upload", "Map columns", "Review & resolve", "Approved"].map((s, i) => (
          <li key={s} className={cx("flex items-center gap-2 rounded-full border px-3 py-1", step > i + 1 ? "border-success/40 bg-success-soft text-success" : step === i + 1 ? "border-primary bg-primary-soft font-medium text-primary" : "border-line text-muted")}>
            <span className="grid size-5 place-items-center rounded-full bg-current/10 text-xs">{i + 1}</span>{s}
          </li>
        ))}
      </ol>
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      {step === 1 && (
        <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
          <Card>
            <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-line-strong p-12 text-center hover:border-primary"
                   onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) upload(f); }}>
              <FileSpreadsheet className="size-10 text-primary" />
              <span className="text-sm font-medium">Drop a .csv or .xlsx file, or click to browse</span>
              <span className="text-xs text-muted">First row must contain column headers · up to 20,000 rows · 10 MB</span>
              <input type="file" accept=".csv,.xlsx,.xlsm" className="sr-only" disabled={!can("imports.create") || busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              <span className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-sm font-medium text-white"><Upload className="size-4" /> Choose file</span>
            </label>
          </Card>
          <Card>
            <CardHeader title="Recent batches" />
            {!history.data?.length ? <EmptyState title="No imports yet" /> : (
              <ul className="divide-y divide-line">
                {history.data.map((b) => (
                  <li key={b.id}><button onClick={() => open(b.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-surface-2">
                    <span className="flex-1"><span className="font-mono text-xs font-semibold">{b.number}</span> <span className="text-ink-2">{b.filename}</span>
                      <span className="block text-xs text-muted">{b.uploaded_by} · {dateTime(b.created_at)}</span></span>
                    <Badge tone={b.status === "APPROVED" ? "success" : b.status === "REJECTED" ? "danger" : "warning"}>{b.status.toLowerCase()}</Badge>
                  </button></li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {batch && step === 2 && (
        <Card>
          <CardHeader title={`Map columns — ${batch.filename}`} subtitle={`${batch.rows?.length ?? 0} data rows · suggested matches are pre-filled`}
            actions={<><Button variant="secondary" onClick={() => setBatch(null)}>Cancel</Button>
              <Button loading={busy} onClick={async () => { const b = await run(() => api<Batch>(`/api/imports/${batch.id}/validate`, { method: "POST", json: { mapping } })); if (b) setBatch(b); }}>Validate rows</Button></>} />
          <div className="grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {Object.entries(batch.fields).map(([key, meta]) => (
              <label key={key} className="flex items-center gap-3 text-sm">
                <span className="w-36 shrink-0 text-ink-2">{meta.label}{meta.required && <span className="text-danger"> *</span>}</span>
                <Select value={mapping[key] ?? ""} onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}>
                  <option value="">— not mapped —</option>{batch.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </Select>
              </label>
            ))}
          </div>
          <p className="border-t border-line px-4 py-3 text-xs text-muted">Item types accept values such as “Raw material”, “Purchased”, “Consumable”, “Spare”, “Finished good”. Units must match configured UOM codes.</p>
        </Card>
      )}

      {batch && step >= 3 && (
        <Card className="overflow-hidden">
          <CardHeader title={`${batch.number} · ${batch.filename}`}
            subtitle={step === 4 ? `Approved — ${batch.summary.created ?? 0} created, ${batch.summary.linked ?? 0} linked to existing items, ${batch.summary.opening_movements ?? 0} opening-stock postings`
              : `${batch.summary.VALID ?? 0} valid · ${batch.summary.DUPLICATE ?? 0} duplicates · ${batch.summary.INVALID ?? 0} rejected`}
            actions={step === 3 ? (<>
              <Button variant="secondary" onClick={() => setBatch({ ...batch, status: "UPLOADED" })}>Back to mapping</Button>
              {can("imports.approve") && <Button variant="danger" loading={busy} onClick={async () => { const b = await run(() => api<Batch>(`/api/imports/${batch.id}/reject`, { method: "POST" })); if (b) { setBatch(null); history.reload(); } }}>Reject</Button>}
              {can("imports.approve") && <Button variant="success" loading={busy} disabled={isUploader} title={isUploader ? "Maker–checker: another user must approve" : undefined}
                onClick={async () => { const b = await run(() => api<Batch>(`/api/imports/${batch.id}/approve`, { method: "POST" })); if (b) { setBatch(b); history.reload(); } }}>Approve & post opening stock</Button>}
            </>) : <Link href="/inventory"><Button icon={<CheckCircle2 className="size-4" />}>View inventory</Button></Link>} />
          {step === 3 && !can("imports.approve") && <div className="border-b border-line px-4 py-2.5 text-sm text-muted">Resolve duplicates below, then ask an approver (Management or Finance) to approve this batch.</div>}
          {step === 3 && isUploader && can("imports.approve") && <div className="border-b border-line px-4 py-2.5 text-sm text-warning">You uploaded this batch — a different approver must approve it.</div>}
          <div className="flex gap-1 border-b border-line px-3 py-2">
            {["", "VALID", "DUPLICATE", "INVALID", "IMPORTED", "SKIPPED"].map((f) => (
              <button key={f} onClick={() => setFilter(f)} className={cx("rounded px-2.5 py-1 text-xs", filter === f ? "bg-primary-soft font-medium text-primary" : "text-muted hover:bg-surface-3")}>{f ? f.toLowerCase() : "all"}</button>
            ))}
          </div>
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full min-w-[900px] text-[13px]">
              <thead><tr><Th>Row</Th><Th>Status</Th><Th>Name</Th><Th>Type</Th><Th>Unit</Th><Th>Location</Th><Th className="text-right">Opening qty</Th><Th>Issues</Th><Th>Resolution</Th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <Td className="py-2 tabular text-muted">{r.row_no}</Td>
                    <Td className="py-2"><Badge tone={STATUS_TONE[r.status]}>{r.status.toLowerCase()}</Badge></Td>
                    <Td className="py-2 text-ink">{r.mapped.name ?? r.raw[batch.mapping.name]}</Td>
                    <Td className="py-2 text-xs">{r.mapped.item_type?.replace(/_/g, " ").toLowerCase() ?? "—"}</Td>
                    <Td className="py-2 text-xs">{r.mapped.uom ?? "—"}</Td>
                    <Td className="py-2 font-mono text-xs">{r.mapped.location ?? "—"}</Td>
                    <Td className="py-2 tabular text-right">{r.mapped.opening_qty ?? "—"}</Td>
                    <Td className="py-2 text-xs text-ink-2">{r.errors.join("; ") || "—"}</Td>
                    <Td className="py-2">
                      {step === 3 && r.status !== "INVALID" ? (
                        <Select value={r.resolution ?? ""} className="h-8 w-40 text-xs" onChange={async (e) => {
                          const updated = await run(() => api<Row>(`/api/imports/${batch.id}/rows/${r.id}/resolve`, { method: "POST", json: { resolution: e.target.value } }));
                          if (updated) setBatch({ ...batch, rows: batch.rows!.map((x) => (x.id === r.id ? updated : x)) });
                        }}>
                          <option value="CREATE">Create new item</option>
                          {r.duplicate_item_id && <option value="LINK">Link to existing</option>}
                          <option value="SKIP">Skip row</option>
                        </Select>
                      ) : r.result_item_id ? <Link href={`/inventory?item=${r.result_item_id}`} className="text-xs text-primary hover:underline">View item</Link> : <span className="text-xs text-muted">{r.resolution?.toLowerCase() ?? "—"}</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
