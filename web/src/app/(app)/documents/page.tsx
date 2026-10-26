"use client";

import { Camera, FileText, ImagePlus, Loader2, ScanLine, Sparkles, Upload, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Spinner, Td, Th, cx } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { STATUS_LABEL, STATUS_TONE, prepareUpload, type DocBrief, type DocConfig, type DocDetail } from "@/lib/documents";
import { dateFmt, dateTime, money } from "@/lib/format";
import { useApi } from "@/lib/hooks";

export default function DocumentsPage() {
  return <Suspense><Documents /></Suspense>;
}

function Documents() {
  const { can } = useAuth();
  const params = useSearchParams();
  const cfg = useApi<DocConfig>("/api/documents/config");
  const [filters, setFilters] = useState({ doc_type: params.get("type") ?? "", status: "", q: "" });
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const list = useApi<DocBrief[]>(`/api/documents${qs ? `?${qs}` : ""}`);
  const canUpload = can("purchase.manage") || can("stock.receive") || can("production.manage") || can("imports.create");

  return (
    <>
      <PageHeader title="Invoice scanner & AI extraction"
        description="Upload or photograph supplier invoices, delivery challans and production reports. AI reads the fields; you review, the system validates, and a second person approves." />
      {cfg.data && !cfg.data.configured && (
        <div className="mb-4">
          <Alert tone="warning" title="AI extraction is not set up on the server">
            Add <code className="font-mono">ANTHROPIC_API_KEY=…</code> to <code className="font-mono">backend/.env</code> and restart the API.
            Until then documents are still stored and you can enter the fields by hand.
          </Alert>
        </div>
      )}
      {canUpload && cfg.data && <UploadPanel cfg={cfg.data} initialType={params.get("type") ?? "SUPPLIER_INVOICE"} />}

      <Card className="mt-5 overflow-hidden">
        <CardHeader title="Documents" actions={
          <div className="flex flex-wrap gap-2">
            <Input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} placeholder="Search number, party, reference" className="h-8 w-56" />
            <Select value={filters.doc_type} onChange={(e) => setFilters({ ...filters, doc_type: e.target.value })} className="h-8 w-auto">
              <option value="">All types</option>{cfg.data?.doc_types.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </Select>
            <Select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} className="h-8 w-auto">
              <option value="">All statuses</option>
              {(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </Select>
          </div>
        } />
        {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Spinner /> : list.data.length === 0 ? (
          <EmptyState icon={<ScanLine className="size-8" />} title="No documents yet" description="Upload a PDF or photograph an invoice to get started." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-[13px]">
              <thead><tr><Th>Document</Th><Th>Type</Th><Th>Party</Th><Th>Reference</Th><Th>Date</Th><Th className="text-right">Total</Th>
                <Th>Checks</Th><Th>Status</Th><Th>Uploaded</Th></tr></thead>
              <tbody>{list.data.map((d) => (
                <tr key={d.id} className="hover:bg-surface-2">
                  <Td className="h-10"><Link href={`/documents/${d.id}`} className="font-mono text-xs font-semibold text-primary">{d.number}</Link>
                    <span className="block max-w-[180px] truncate text-[11px] text-muted" title={d.title}>{d.title}{d.page_count > 1 ? ` · ${d.page_count} pages` : ""}</span></Td>
                  <Td className="text-xs">{d.doc_type_label}</Td>
                  <Td>{d.party_name ?? "—"}{d.party_gstin && <span className="block font-mono text-[11px] text-muted">{d.party_gstin}</span>}</Td>
                  <Td className="font-mono text-xs">{d.reference_no ?? "—"}</Td>
                  <Td className="text-xs">{dateFmt(d.document_date)}</Td>
                  <Td className="tabular text-right">{d.total != null ? money(d.total, true) : "—"}</Td>
                  <Td>{d.failed > 0 ? <Badge tone="danger">{d.failed} failed</Badge> : d.warnings > 0 ? <Badge tone="warning">{d.warnings} to check</Badge>
                    : d.status === "UPLOADED" || d.status === "FAILED" ? "—" : <Badge tone="success">OK</Badge>}</Td>
                  <Td><Badge tone={STATUS_TONE[d.status]} dot>{STATUS_LABEL[d.status]}</Badge></Td>
                  <Td className="text-xs">{d.created_by}<span className="block text-muted">{dateTime(d.created_at)}</span></Td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function UploadPanel({ cfg, initialType }: { cfg: DocConfig; initialType: string }) {
  const router = useRouter();
  const [docType, setDocType] = useState(cfg.doc_types.some((t) => t.code === initialType) ? initialType : "SUPPLIER_INVOICE");
  const [files, setFiles] = useState<File[]>([]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [webcam, setWebcam] = useState(false);
  const pickRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  async function add(list: FileList | File[]) {
    setError(null);
    const prepared = await Promise.all(Array.from(list).map(prepareUpload));
    const bad = prepared.find((f) => !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(f.type));
    if (bad) setError(`${bad.name}: only PDF, JPG, PNG or WEBP files`);
    setFiles((cur) => [...cur, ...prepared.filter((f) => f !== bad)].slice(0, cfg.max_files));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const body = new FormData();
    body.append("doc_type", docType);
    if (notes.trim()) body.append("notes", notes.trim());
    body.append("extract", String(cfg.configured));
    files.forEach((f) => body.append("files", f, f.name));
    try {
      const doc = await api<DocDetail>("/api/documents", { method: "POST", body });
      router.push(`/documents/${doc.id}`);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="New document" subtitle={`PDF up to ${cfg.max_pdf_mb} MB, or photos (one per page, up to ${cfg.max_files}). Large photos are reduced before upload.`} />
      <div className="grid gap-4 p-4 lg:grid-cols-[260px_1fr]">
        <div className="space-y-3">
          <Field label="Document type">
            <Select value={docType} onChange={(e) => setDocType(e.target.value)}>{cfg.doc_types.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</Select>
          </Field>
          <Field label="Note (optional)"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. received with lorry TN 66 AK 5769" /></Field>
          <Button className="w-full" icon={busy ? undefined : cfg.configured ? <Sparkles className="size-4" /> : <Upload className="size-4" />} loading={busy}
            disabled={!files.length} onClick={submit}>{cfg.configured ? "Upload & extract with AI" : "Upload for manual entry"}</Button>
          {busy && cfg.configured && <p className="flex items-center gap-1.5 text-xs text-muted"><Loader2 className="size-3.5 animate-spin" />Reading the document — this can take up to a minute for long invoices.</p>}
          {error && <Alert>{error}</Alert>}
        </div>
        <div>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
            className={cx("flex min-h-[150px] flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-5 text-center transition-colors",
              drag ? "border-primary bg-primary-soft/40" : "border-line-strong")}>
            <Upload className="size-7 text-muted" />
            <p className="text-sm text-ink-2">Drag files here, or</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="secondary" size="sm" icon={<FileText className="size-4" />} onClick={() => pickRef.current?.click()}>Choose files</Button>
              <Button variant="secondary" size="sm" icon={<ImagePlus className="size-4" />} onClick={() => photoRef.current?.click()}>Take photo</Button>
              <Button variant="secondary" size="sm" icon={<Camera className="size-4" />} onClick={() => setWebcam(true)}>Use camera</Button>
            </div>
            <input ref={pickRef} type="file" multiple hidden accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
            <input ref={photoRef} type="file" hidden accept="image/*" capture="environment"
              onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
          </div>
          {files.length > 0 && (
            <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {files.map((f, i) => <Thumb key={`${f.name}-${i}`} file={f} n={i + 1} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />)}
            </ul>
          )}
        </div>
      </div>
      {webcam && <WebcamCapture onClose={() => setWebcam(false)} onCapture={(f) => setFiles((cur) => [...cur, f].slice(0, cfg.max_files))} count={files.length} />}
    </Card>
  );
}

function Thumb({ file, n, onRemove }: { file: File; n: number; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <li className="relative overflow-hidden rounded-md border border-line bg-surface-2">
      <div className="grid aspect-[3/4] place-items-center">
        {/* eslint-disable-next-line @next/next/no-img-element -- local preview blob, not optimisable by next/image */}
        {url ? <img src={url} alt={`Page ${n}`} className="h-full w-full object-cover" /> : <FileText className="size-8 text-muted" />}
      </div>
      <p className="truncate px-1.5 py-1 text-[11px]">{n}. {file.name} <span className="text-muted">({(file.size / 1024 / 1024).toFixed(1)} MB)</span></p>
      <button onClick={onRemove} className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white" aria-label={`Remove ${file.name}`}><X className="size-3.5" /></button>
    </li>
  );
}

/** Desktop / tablet webcam: capture one page at a time into the upload. */
function WebcamCapture({ onClose, onCapture, count }: { onClose: () => void; onCapture: (f: File) => void; count: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState(0);

  useEffect(() => {
    let stream: MediaStream | null = null;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera not available — use HTTPS or localhost, or choose files instead.");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 2560 }, height: { ideal: 1920 } } });
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (e) {
        setError((e as Error).message || "Could not start the camera");
      }
    })();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  function snap() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = Object.assign(document.createElement("canvas"), { width: v.videoWidth, height: v.videoHeight });
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      onCapture(await prepareUpload(new File([blob], `page-${count + taken + 1}.jpg`, { type: "image/jpeg" })));
      setTaken((t) => t + 1);
    }, "image/jpeg", 0.9);
  }

  return (
    <Modal open onClose={onClose} title="Scan with camera" width="max-w-3xl"
      footer={<><span className="mr-auto text-sm text-muted">{taken} page(s) captured</span><Button variant="secondary" onClick={onClose}>Done</Button>
        <Button icon={<Camera className="size-4" />} onClick={snap} disabled={!!error}>Capture page</Button></>}>
      {error ? <Alert>{error}</Alert> : (
        <div className="relative overflow-hidden rounded-lg bg-black">
          <video ref={videoRef} autoPlay playsInline muted className="max-h-[60vh] w-full object-contain" />
          <p className="absolute inset-x-0 bottom-2 text-center text-xs text-white/80">Fill the frame with the page, flat and well lit. Capture each page in order.</p>
        </div>
      )}
    </Modal>
  );
}
