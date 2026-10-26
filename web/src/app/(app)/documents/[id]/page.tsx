"use client";

import { AlertTriangle, ArrowLeft, CheckCircle2, Minus, Plus, RotateCw, Save, ShieldCheck, ShieldX, Sparkles, Trash2, XCircle, ZoomIn, ZoomOut } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card, CardHeader, ErrorState, Field, Input, Modal, Spinner, Textarea, cx } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { STATUS_LABEL, STATUS_TONE, usePageUrl, type Check, type DocConfig, type DocDetail, type Line } from "@/lib/documents";
import { dateTime } from "@/lib/format";
import { useApi } from "@/lib/hooks";

type Form = { header: Record<string, string>; lines: Record<string, string>[]; notes: string };

function toForm(d: DocDetail, lineKeys: string[]): Form {
  return {
    header: Object.fromEntries(Object.entries(d.data.header).map(([k, f]) => [k, f.value])),
    lines: d.data.lines.map((l) => Object.fromEntries(lineKeys.map((k) => [k, (l[k] as string) ?? ""]))),
    notes: d.notes ?? "",
  };
}

export default function DocumentReviewPage() {
  const { id } = useParams<{ id: string }>();
  const { can, user } = useAuth();
  const router = useRouter();
  const doc = useApi<DocDetail>(`/api/documents/${id}`);
  const cfg = useApi<DocConfig>("/api/documents/config");
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);

  const type = cfg.data?.doc_types.find((t) => t.code === doc.data?.doc_type);
  const lineKeys = useMemo(() => type?.lines.map((l) => l.key) ?? [], [type]);
  useEffect(() => {
    if (doc.data && type) setForm(toForm(doc.data, lineKeys));
  }, [doc.data, type, lineKeys]);

  if (doc.error) return <ErrorState error={doc.error} onRetry={doc.reload} />;
  const d = doc.data;
  if (!d || !type || !form || !cfg.data) return <Spinner />;

  const locked = d.status === "APPROVED" || d.status === "REJECTED";
  const canEdit = !locked && (can("purchase.manage") || can("stock.receive") || can("production.manage") || can("imports.create"));
  const canDecide = d.status === "EXTRACTED" && (can("purchase.approve") || can("imports.approve")) && user?.id !== d.created_by_id;
  const original = toForm(d, lineKeys);
  const dirty = JSON.stringify(original) !== JSON.stringify(form);
  const fieldChecks = new Map<string, Check[]>();
  for (const c of d.checks) if (c.field) fieldChecks.set(c.field, [...(fieldChecks.get(c.field) ?? []), c]);
  const failed = d.checks.filter((c) => c.status === "fail");
  const low = cfg.data.low_confidence;

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      doc.reload();
      setMsg({ ok: true, text: ok });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
      return false;
    } finally {
      setBusy(null);
    }
  }
  const save = () => run("save", () => api(`/api/documents/${id}/data`, { method: "PUT", json: form }), "Saved — checks re-run");

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link href="/documents" className="inline-flex items-center gap-1 text-sm text-primary"><ArrowLeft className="size-4" /> Documents</Link>
        <span className="font-mono text-sm font-semibold">{d.number}</span>
        <Badge tone="primary">{d.doc_type_label}</Badge>
        <Badge tone={STATUS_TONE[d.status]} dot>{STATUS_LABEL[d.status]}</Badge>
        <span className="text-xs text-muted">Uploaded by {d.created_by} · {dateTime(d.created_at)}
          {d.extracted_at && ` · read by ${d.model} ${dateTime(d.extracted_at)}`}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {canEdit && cfg.data.configured && (
            <Button variant="secondary" size="sm" icon={<Sparkles className="size-4" />} loading={busy === "extract"}
              onClick={() => (!dirty && d.status !== "EXTRACTED") || confirm("Re-run AI extraction? It replaces the current fields, including your corrections.")
                ? run("extract", () => api(`/api/documents/${id}/extract`, { method: "POST" }), "Extraction finished") : undefined}>
              {d.status === "FAILED" || d.status === "UPLOADED" ? "Extract with AI" : "Re-run AI"}
            </Button>
          )}
          {canEdit && <Button size="sm" icon={<Save className="size-4" />} disabled={!dirty} loading={busy === "save"} onClick={save}>Save</Button>}
          {d.status !== "APPROVED" && (can("purchase.manage") || can("stock.receive") || can("production.manage") || can("imports.create")) && (
            <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} loading={busy === "delete"} onClick={async () => {
              if (!confirm(`Delete ${d.number} and its uploaded file(s)? This cannot be undone.`)) return;
              setBusy("delete");
              setMsg(null);
              try {
                await api(`/api/documents/${id}`, { method: "DELETE" });
                router.push("/documents");
              } catch (e) {
                setMsg({ ok: false, text: (e as ApiError).message });
                setBusy(null);
              }
            }}>Delete</Button>
          )}
          {canDecide && <>
            <Button size="sm" variant="success" icon={<ShieldCheck className="size-4" />} disabled={dirty} title={dirty ? "Save first" : undefined} onClick={() => setDecision("approve")}>Approve</Button>
            <Button size="sm" variant="danger" icon={<ShieldX className="size-4" />} onClick={() => setDecision("reject")}>Reject</Button>
          </>}
        </div>
      </div>

      {msg && <div className="mb-3"><Alert tone={msg.ok ? "success" : "danger"}>{msg.text}</Alert></div>}
      {d.extraction_error && d.status === "FAILED" && <div className="mb-3"><Alert tone="warning" title="AI extraction did not finish">{d.extraction_error}. Enter the fields by hand, or re-run when fixed.</Alert></div>}
      {locked && <div className="mb-3"><Alert tone={d.status === "APPROVED" ? "success" : "warning"} title={`${STATUS_LABEL[d.status]} by ${d.reviewed_by ?? "—"} · ${d.reviewed_at ? dateTime(d.reviewed_at) : ""}`}>
        {d.decision_note || "No note."}{d.status === "APPROVED" && d.doc_type === "SUPPLIER_INVOICE" && " Ready for posting when the Accounts module is enabled."}</Alert></div>}
      {d.status === "EXTRACTED" && !canDecide && user?.id === d.created_by_id && (can("purchase.approve") || can("imports.approve")) && (
        <div className="mb-3"><Alert tone="info">You uploaded this document, so another approver must approve it (maker–checker).</Alert></div>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Viewer d={d} />

        <div className="space-y-5">
          <Card>
            <CardHeader title="Extracted fields" subtitle={<>Amber = hard to read (below {Math.round(low * 100)}% confidence) · red = failed a check · <span className="text-success">edited</span> = corrected by a person</>} />
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              {type.header.map(({ key, label }) => {
                const f = d.data.header[key];
                const issues = fieldChecks.get(key) ?? [];
                const fail = issues.some((c) => c.status === "fail");
                const unsure = f && f.value && !f.edited && f.confidence < low && form.header[key] === f.value;
                return (
                  <Field key={key} label={<span className="flex items-center gap-1.5">{label}
                    {f?.edited && <span className="text-[10px] font-medium text-success">edited</span>}
                    {f && f.value && !f.edited && <span className={cx("text-[10px] tabular", unsure ? "font-semibold text-warning" : "text-muted")}>{Math.round(f.confidence * 100)}%</span>}
                  </span>} className={key.endsWith("address") ? "sm:col-span-2" : undefined}
                    hint={issues.filter((c) => c.status !== "pass").map((c) => c.message).join(" · ") || undefined}>
                    <Input id={`doc-field-${key}`} value={form.header[key] ?? ""} disabled={!canEdit}
                      onChange={(e) => setForm({ ...form, header: { ...form.header, [key]: e.target.value } })}
                      className={cx(fail ? "border-danger ring-1 ring-danger/30" : unsure ? "border-warning bg-warning-soft/40" : "")} />
                  </Field>
                );
              })}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title={`Line items (${form.lines.length})`} actions={canEdit &&
              <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setForm({ ...form, lines: [...form.lines, Object.fromEntries(lineKeys.map((k) => [k, ""]))] })}>Add line</Button>} />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-[12.5px]">
                <thead><tr className="border-b border-line bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-2 py-2">#</th>{type.lines.map((c) => <th key={c.key} className="px-1 py-2 font-semibold">{c.label}</th>)}<th />
                </tr></thead>
                <tbody>{form.lines.map((row, i) => {
                  const src: Line | undefined = d.data.lines[i];
                  return (
                    <tr key={i} className="border-b border-line align-top">
                      <td className="px-2 py-1.5 text-muted">{i + 1}{src && !src.edited && (src.confidence ?? 1) < low && <AlertTriangle className="ml-0.5 inline size-3 text-warning" />}</td>
                      {lineKeys.map((k) => {
                        const issues = fieldChecks.get(`lines.${i}.${k}`) ?? [];
                        const unsure = src && !src.edited && (src.uncertain_fields ?? []).includes(k) && row[k] === src[k];
                        return (
                          <td key={k} className="px-0.5 py-1">
                            <input value={row[k] ?? ""} disabled={!canEdit} title={issues.map((c) => c.message).join(" · ") || undefined}
                              onChange={(e) => setForm({ ...form, lines: form.lines.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)) })}
                              className={cx("w-full min-w-[70px] rounded border bg-surface px-1.5 py-1 text-[12.5px] text-ink disabled:bg-transparent",
                                k === "description" || k === "item_description" ? "min-w-[180px]" : "",
                                issues.some((c) => c.status === "fail") ? "border-danger" : unsure ? "border-warning bg-warning-soft/40" : "border-line")} />
                          </td>
                        );
                      })}
                      <td className="px-1 py-1">{canEdit && <button onClick={() => setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) })}
                        className="rounded p-1 text-muted hover:text-danger" aria-label={`Remove line ${i + 1}`}><Trash2 className="size-3.5" /></button>}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
              {form.lines.length === 0 && <p className="px-4 py-3 text-sm text-muted">No line items.</p>}
            </div>
          </Card>

          <Card>
            <CardHeader title="Validation" subtitle="Arithmetic, GST, supplier / PO / goods-receipt match and duplicates — re-run on every save"
              actions={<span className="flex gap-1">{failed.length > 0 && <Badge tone="danger">{failed.length} failed</Badge>}
                <Badge tone="warning">{d.checks.filter((c) => c.status === "warn").length} to check</Badge></span>} />
            {d.checks.length === 0 ? <p className="p-4 text-sm text-muted">No checks yet — extract or enter the data.</p> : (
              <ul className="divide-y divide-line">
                {[...d.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]).map((c, i) => (
                  <li key={i} className="flex items-start gap-2 px-4 py-2 text-[13px]">
                    {c.status === "fail" ? <XCircle className="mt-0.5 size-4 shrink-0 text-danger" /> : c.status === "warn"
                      ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />}
                    <span className="flex-1 text-ink-2">{c.message}</span>
                    {c.field && !c.field.startsWith("lines.") && canEdit && <button className="text-xs text-primary" onClick={() => { const el = document.getElementById(`doc-field-${c.field}`); el?.scrollIntoView({ block: "center" }); el?.focus(); }}>Fix</button>}
                  </li>
                ))}
              </ul>
            )}
            {d.data.notes.length > 0 && (
              <div className="border-t border-line px-4 py-3 text-[13px]">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Reader&apos;s notes</p>
                <ul className="list-disc space-y-0.5 pl-5 text-ink-2">{d.data.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </div>
            )}
            <div className="border-t border-line p-4">
              <Field label="Internal note"><Textarea rows={2} value={form.notes} disabled={!canEdit} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
            </div>
          </Card>
        </div>
      </div>

      {decision && <DecisionModal id={d.id} approve={decision === "approve"} failed={failed} onClose={() => setDecision(null)}
        onDone={(text) => { setDecision(null); doc.reload(); setMsg({ ok: true, text }); }} />}
    </>
  );
}

const ORDER = { fail: 0, warn: 1, pass: 2 } as const;

function Viewer({ d }: { d: DocDetail }) {
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const file = usePageUrl(d.id, d.pages.length ? page : null);
  const current = d.pages.find((p) => p.page_no === page);
  return (
    <Card className="flex h-fit flex-col overflow-hidden xl:sticky xl:top-4">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="flex gap-1">
          {d.pages.map((p) => (
            <button key={p.page_no} onClick={() => setPage(p.page_no)}
              className={cx("rounded px-2 py-0.5 text-xs", p.page_no === page ? "bg-primary text-white" : "bg-surface-3 text-ink-2 hover:bg-surface-2")}>{p.page_no}</button>
          ))}
        </div>
        <span className="truncate text-xs text-muted">{current?.filename}</span>
        {current?.content_type.startsWith("image/") && (
          <div className="ml-auto flex gap-1">
            <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} className="rounded p-1 hover:bg-surface-2" aria-label="Zoom out"><ZoomOut className="size-4" /></button>
            <span className="tabular w-10 text-center text-xs leading-6">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(4, z + 0.25))} className="rounded p-1 hover:bg-surface-2" aria-label="Zoom in"><ZoomIn className="size-4" /></button>
            <button onClick={() => setZoom(1)} className="rounded p-1 hover:bg-surface-2" aria-label="Fit"><Minus className="size-4" /></button>
            <button onClick={() => setRotate((r) => (r + 90) % 360)} className="rounded p-1 hover:bg-surface-2" aria-label="Rotate"><RotateCw className="size-4" /></button>
          </div>
        )}
      </div>
      <div className="h-[75vh] overflow-auto bg-surface-3">
        {file.error ? <div className="p-4"><Alert>{file.error}</Alert></div> : !file.url ? <Spinner label="Loading page…" /> :
          file.type === "application/pdf"
            ? <iframe src={file.url} title={current?.filename} className="h-full w-full bg-white" />
            // eslint-disable-next-line @next/next/no-img-element -- private blob URL, not optimisable by next/image
            : <img src={file.url} alt={`Page ${page}`} style={{ width: `${zoom * 100}%`, transform: `rotate(${rotate}deg)`, transformOrigin: "center" }}
                className="mx-auto max-w-none transition-transform" />}
      </div>
    </Card>
  );
}

function DecisionModal({ id, approve, failed, onClose, onDone }: {
  id: number; approve: boolean; failed: Check[]; onClose: () => void; onDone: (text: string) => void;
}) {
  const [note, setNote] = useState("");
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needsNote = !approve || (failed.length > 0);
  return (
    <Modal open onClose={onClose} title={approve ? "Approve document" : "Reject document"} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant={approve ? "success" : "danger"} loading={busy} disabled={(needsNote && note.trim().length < 5) || (approve && failed.length > 0 && !override)}
        onClick={async () => {
          setBusy(true); setErr(null);
          try {
            await api(`/api/documents/${id}/decision`, { method: "POST", json: { approve, note: note.trim() || null, override } });
            onDone(approve ? "Approved" : "Rejected");
          } catch (e) { setErr((e as ApiError).message); setBusy(false); }
        }}>{approve ? "Approve" : "Reject"}</Button>
    </>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        {approve && failed.length > 0 && (
          <Alert tone="danger" title={`${failed.length} check(s) failed`}>
            <ul className="list-disc pl-4">{failed.map((c, i) => <li key={i}>{c.message}</li>)}</ul>
            <label className="mt-2 flex items-center gap-2 font-medium"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />Approve anyway (recorded in the audit trail)</label>
          </Alert>
        )}
        <Field label={needsNote ? "Reason" : "Note (optional)"} required={needsNote}>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={approve ? "e.g. checked against GRN and PO" : "e.g. duplicate of DOC-00012"} />
        </Field>
      </div>
    </Modal>
  );
}
