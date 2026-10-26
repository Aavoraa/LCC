"use client";

import { ArrowLeft, CheckCircle2, CloudOff, MapPin, RefreshCw, RotateCcw, Send } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Scanner } from "@/components/Scanner";
import { Alert, Badge, Button, Card, CardHeader, Field, Input, PageHeader, Select, Textarea, cx } from "@/components/ui";
import { api, ApiError, uuid } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateTime, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { discard, enqueue, readQueue, syncQueue, type QueuedTxn } from "@/lib/offline";
import { itemTypeLabel, type ItemDetail, type Location, type Movement, type Resolve, type Totals } from "@/lib/types";

type Txn = "RECEIPT" | "ISSUE" | "TRANSFER" | "RETURN" | "QC_HOLD" | "QC_RELEASE" | "ADJUST";
const TXNS: { key: Txn; label: string; perm: string; hint: string }[] = [
  { key: "RECEIPT", label: "Receive", perm: "stock.receive", hint: "Goods into a store location" },
  { key: "ISSUE", label: "Issue", perm: "stock.issue", hint: "Against SO / PO / PAD / WIP / assembly / requisition" },
  { key: "TRANSFER", label: "Transfer", perm: "stock.transfer", hint: "Between racks or bins" },
  { key: "RETURN", label: "Return", perm: "stock.return", hint: "Unused material back to stores" },
  { key: "QC_HOLD", label: "QC hold", perm: "qc.hold", hint: "Block quantity pending inspection" },
  { key: "QC_RELEASE", label: "QC release", perm: "qc.hold", hint: "Release inspected quantity" },
  { key: "ADJUST", label: "Adjustment", perm: "stock.adjust.request", hint: "Request a correction (needs approval)" },
];
const REF_TYPES = [["SALES_ORDER", "Sales order"], ["PURCHASE_ORDER", "Purchase order"], ["PAD", "PAD"], ["WIP", "WIP"],
  ["ASSEMBLY_REQUEST", "Assembly request"], ["REQUISITION", "Internal requisition"], ["SUPPLIER_RETURN", "Return to supplier"]];

export default function ScanPage() {
  return <Suspense><Scan /></Suspense>;
}

interface Scanned { item: ItemDetail["item"]; totals: Totals; balances: ItemDetail["balances"] }

function Scan() {
  const { can } = useAuth();
  const params = useSearchParams();
  const locs = useApi<Location[]>("/api/masters/locations");
  const [scanned, setScanned] = useState<Scanned | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [binLoc, setBinLoc] = useState<Location | null>(null);
  const [txn, setTxn] = useState<Txn | null>(null);
  const [form, setForm] = useState({ quantity: "", from: "", to: "", refType: "", refNo: "", unitCost: "", notes: "", qcHold: false, delta: "" });
  const [stage, setStage] = useState<"form" | "confirm" | "done">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ movement?: Movement; totals?: Totals; queued?: boolean; adjustment?: string } | null>(null);
  const [txnId, setTxnId] = useState(uuid());

  const allowed = TXNS.filter((t) => can(t.perm));

  const load = useCallback(async (payload: string) => {
    setScanError(null);
    try {
      const r = await api<Resolve>(`/api/qr/resolve?payload=${encodeURIComponent(payload)}&verify=true`);
      if (r.kind === "location" && r.location) {
        setBinLoc(r.location);
        return;
      }
      setScanned({ item: r.item!, totals: r.totals, balances: r.balances });
      setTxn(null);
      setStage("form");
      setResult(null);
    } catch (e) {
      setScanError((e as ApiError).message);
    }
  }, []);

  useEffect(() => {
    const id = params.get("item");
    if (id) api<ItemDetail>(`/api/items/${id}`).then((d) => setScanned({ item: d.item, totals: d.totals, balances: d.balances })).catch(() => {});
    const p = params.get("payload");
    if (p) load(p);
  }, [params, load]);

  function chooseTxn(t: Txn) {
    if (!scanned) return;
    const def = String(scanned.item.default_location?.id ?? "");
    const bin = binLoc ? String(binLoc.id) : "";
    const stocked = scanned.balances.find((b) => Number(b.qty_available) > 0)?.location.id;
    setTxn(t);
    setStage("form");
    setError(null);
    setTxnId(uuid());
    setForm({
      quantity: "", refType: t === "ISSUE" ? "SALES_ORDER" : "", refNo: "", unitCost: "", notes: "", qcHold: false, delta: "",
      to: ["RECEIPT", "RETURN", "TRANSFER"].includes(t) ? (bin || def) : "",
      from: ["ISSUE", "TRANSFER", "QC_HOLD", "QC_RELEASE", "ADJUST"].includes(t) ? (t === "TRANSFER" ? String(stocked ?? def) : bin || String(stocked ?? def)) : "",
    });
  }

  const sourceBal = useMemo(() => scanned?.balances.find((b) => String(b.location.id) === form.from), [scanned, form.from]);
  const locCode = (id: string) => locs.data?.find((l) => String(l.id) === id)?.code ?? "—";

  function validate(): string | null {
    if (!scanned || !txn) return "Select a transaction";
    if (txn === "ADJUST") {
      if (!form.delta || Number(form.delta) === 0) return "Enter a non-zero adjustment (e.g. -2 or 5)";
      if (form.notes.trim().length < 5) return "A reason of at least 5 characters is required";
      return form.from ? null : "Select the location";
    }
    const q = Number(form.quantity);
    if (!(q > 0)) return "Quantity must be greater than zero";
    const dec = scanned.item.uom.decimals;
    if (!Number.isInteger(q * 10 ** dec)) return `${scanned.item.uom.code} allows ${dec} decimal places`;
    if (["ISSUE", "TRANSFER", "QC_HOLD"].includes(txn)) {
      const avail = Number(sourceBal?.qty_available ?? 0);
      if (q > avail) return `Only ${qty(avail)} ${scanned.item.uom.code} available at ${locCode(form.from)}`;
    }
    if (txn === "QC_RELEASE" && q > Number(sourceBal?.qty_qc_hold ?? 0)) return `Only ${qty(sourceBal?.qty_qc_hold ?? 0)} on QC hold here`;
    if (txn === "ISSUE" && (!form.refType || !form.refNo.trim())) return "Issues need an authorized document reference";
    if (txn === "TRANSFER" && form.from === form.to) return "Choose a different destination";
    return null;
  }

  async function submit() {
    if (!scanned || !txn) return;
    setBusy(true);
    setError(null);
    try {
      if (txn === "ADJUST") {
        const r = await api<{ number: string }>("/api/stock/adjustments", { method: "POST", json: {
          item_id: scanned.item.id, location_id: Number(form.from), qty_delta: form.delta, reason: form.notes } });
        setResult({ adjustment: r.number });
        setStage("done");
        return;
      }
      const body = {
        txn_uuid: txnId, movement_type: txn, item_id: scanned.item.id, quantity: form.quantity,
        from_location_id: form.from ? Number(form.from) : null, to_location_id: form.to ? Number(form.to) : null,
        unit_cost: txn === "RECEIPT" && form.unitCost ? form.unitCost : null,
        ref_doc_type: form.refType || null, ref_doc_no: form.refNo.trim() || null, notes: form.notes || null,
        into_qc_hold: txn === "RECEIPT" && form.qcHold, source: /android/i.test(navigator.userAgent) ? "android" : "web",
        device_captured_at: new Date().toISOString(),
      };
      try {
        const r = await api<{ movement: Movement; totals: Totals }>("/api/stock/movements", { method: "POST", json: body });
        setResult({ movement: r.movement, totals: r.totals });
        const fresh = await api<ItemDetail>(`/api/items/${scanned.item.id}`);
        setScanned({ item: fresh.item, totals: fresh.totals, balances: fresh.balances });
      } catch (e) {
        if ((e as ApiError).status === 0) {
          enqueue(body, `${txn} ${form.quantity} ${scanned.item.uom.code} · ${scanned.item.item_code}`);
          setResult({ queued: true });
        } else throw e;
      }
      setStage("done");
    } catch (e) {
      setError((e as ApiError).message);
      setStage("form");
    } finally {
      setBusy(false);
    }
  }

  const v = stage === "confirm" ? null : validate();

  return (
    <>
      <PageHeader title="Scan & transact" description="Scan an item label, choose a transaction, confirm. Every movement is posted to the central ledger." />
      <PendingSync />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,420px)_1fr]">
        <div className="space-y-3">
          <Card className="p-3"><Scanner onResult={load} paused={stage === "confirm"} /></Card>
          {scanError && <Alert>{scanError}</Alert>}
          {binLoc && (
            <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary-soft px-3 py-2 text-sm">
              <span className="flex items-center gap-2"><MapPin className="size-4 text-primary" /> Bin scanned: <b className="font-mono">{binLoc.code}</b></span>
              <button className="text-xs text-muted hover:text-ink" onClick={() => setBinLoc(null)}>Clear</button>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {!scanned ? (
            <Card className="grid min-h-[280px] place-items-center p-8 text-center">
              <div>
                <p className="text-sm font-medium">No item scanned</p>
                <p className="mt-1 text-sm text-muted">Scan a QR label or type an item code to fetch its live balance.</p>
              </div>
            </Card>
          ) : (
            <>
              <Card>
                <div className="flex items-start justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2"><span className="font-mono text-sm font-semibold text-primary">{scanned.item.item_code}</span><Badge tone="primary">{itemTypeLabel(scanned.item.item_type)}</Badge></div>
                    <p className="mt-1 text-base font-semibold">{scanned.item.name}</p>
                    <p className="text-xs text-muted">Default location {scanned.item.default_location?.code ?? "—"}</p>
                  </div>
                  <Link href={`/inventory?item=${scanned.item.id}`} className="shrink-0 text-xs font-medium text-primary hover:underline">Details</Link>
                </div>
                <div className="grid grid-cols-4 border-t border-line text-center">
                  {[["Physical", scanned.totals.on_hand], ["Reserved", scanned.totals.reserved], ["QC hold", scanned.totals.qc_hold], ["Available", scanned.totals.available]].map(([l, val]) => (
                    <div key={l} className="border-r border-line py-3 last:border-0">
                      <p className="text-[11px] text-muted">{l}</p>
                      <p className={cx("tabular text-lg font-semibold", l === "Available" && "text-success")}>{qty(val)}</p>
                    </div>
                  ))}
                </div>
                {scanned.balances.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 border-t border-line px-4 py-2.5">
                    {scanned.balances.map((b) => <span key={b.location.id} className="rounded bg-surface-3 px-2 py-0.5 font-mono text-[11px]">{b.location.code}: {qty(b.qty_available)}</span>)}
                  </div>
                )}
              </Card>

              {stage === "done" && result ? (
                <Card className="p-6 text-center">
                  {result.queued ? <CloudOff className="mx-auto size-9 text-warning" /> : <CheckCircle2 className="mx-auto size-9 text-success" />}
                  <p className="mt-2 font-semibold">
                    {result.queued ? "Saved offline — pending sync" : result.adjustment ? `Adjustment ${result.adjustment} submitted for approval` : `Posted ${result.movement?.number}`}
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    {result.queued ? "Not yet confirmed. Server stock is unchanged until this syncs." : result.adjustment ? "Stock changes only after a different authorized user approves." :
                      <>New available balance: <b className="text-ink">{qty(result.totals?.available)} {scanned.item.uom.code}</b></>}
                  </p>
                  <div className="mt-4 flex justify-center gap-2">
                    <Button variant="secondary" icon={<RotateCcw className="size-4" />} onClick={() => chooseTxn(txn!)}>Another {TXNS.find((t) => t.key === txn)?.label.toLowerCase()}</Button>
                    <Button onClick={() => { setScanned(null); setTxn(null); setResult(null); setStage("form"); }}>Scan next item</Button>
                  </div>
                </Card>
              ) : (
                <Card>
                  <CardHeader title="Transaction" subtitle={txn ? TXNS.find((t) => t.key === txn)?.hint : "Choose what you are doing with this item"} />
                  <div className="grid grid-cols-3 gap-2 p-4 sm:grid-cols-4 xl:grid-cols-7">
                    {allowed.map((t) => (
                      <button key={t.key} onClick={() => chooseTxn(t.key)}
                              className={cx("h-12 rounded-md border text-sm font-medium transition-colors",
                                txn === t.key ? "border-primary bg-primary text-white" : "border-line-strong bg-surface hover:border-primary hover:text-primary")}>
                        {t.label}
                      </button>
                    ))}
                    {allowed.length === 0 && <p className="col-span-full text-sm text-muted">Your role can view stock but not record transactions.</p>}
                  </div>
                  {txn && stage === "form" && (
                    <div className="space-y-4 border-t border-line p-4">
                      {error && <Alert>{error}</Alert>}
                      <div className="grid gap-4 sm:grid-cols-2">
                        {txn === "ADJUST" ? (
                          <Field label={`Quantity change (${scanned.item.uom.code})`} required hint="Negative to reduce, positive to increase">
                            <Input inputMode="decimal" value={form.delta} onChange={(e) => setForm({ ...form, delta: e.target.value })} placeholder="-2" autoFocus />
                          </Field>
                        ) : (
                          <Field label={`Quantity (${scanned.item.uom.code})`} required
                                 hint={sourceBal ? `${qty(txn === "QC_RELEASE" ? sourceBal.qty_qc_hold : sourceBal.qty_available)} ${txn === "QC_RELEASE" ? "on hold" : "available"} at source` : undefined}>
                            <Input inputMode="decimal" type="number" min={0} step="any" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                                   className="h-12 text-lg" autoFocus />
                          </Field>
                        )}
                        {["ISSUE", "TRANSFER", "QC_HOLD", "QC_RELEASE", "ADJUST"].includes(txn) && (
                          <Field label={txn === "ADJUST" ? "Location" : "From location"} required>
                            <Select value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })}>
                              <option value="">Select…</option>
                              {locs.data?.map((l) => {
                                const b = scanned.balances.find((x) => x.location.id === l.id);
                                return <option key={l.id} value={l.id}>{l.code}{b ? ` — ${qty(b.qty_available)} avail` : ""}</option>;
                              })}
                            </Select>
                          </Field>
                        )}
                        {["RECEIPT", "TRANSFER", "RETURN"].includes(txn) && (
                          <Field label="To location" required>
                            <Select value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })}>
                              <option value="">Select…</option>{locs.data?.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}
                            </Select>
                          </Field>
                        )}
                        {txn !== "ADJUST" && (
                          <>
                            <Field label="Document type" required={txn === "ISSUE"}>
                              <Select value={form.refType} onChange={(e) => setForm({ ...form, refType: e.target.value })}>
                                <option value="">{txn === "ISSUE" ? "Select…" : "None"}</option>{REF_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                              </Select>
                            </Field>
                            <Field label="Document number" required={txn === "ISSUE"}><Input value={form.refNo} onChange={(e) => setForm({ ...form, refNo: e.target.value })} placeholder="e.g. SO-2026-0142" /></Field>
                          </>
                        )}
                        {txn === "RECEIPT" && (
                          <>
                            <Field label="Unit cost (₹)" hint="Updates the weighted average"><Input type="number" min={0} step="any" value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value })} /></Field>
                            <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={form.qcHold} onChange={(e) => setForm({ ...form, qcHold: e.target.checked })} /> Place on QC hold pending inspection</label>
                          </>
                        )}
                        <Field label={txn === "ADJUST" ? "Reason" : "Notes"} required={txn === "ADJUST"} className="sm:col-span-2">
                          <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                        </Field>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs text-danger">{v}</p>
                        <Button size="lg" disabled={!!v} onClick={() => setStage("confirm")}>Review</Button>
                      </div>
                    </div>
                  )}
                  {txn && stage === "confirm" && (
                    <div className="space-y-4 border-t border-line p-4">
                      <div className="rounded-lg border border-primary/30 bg-primary-soft/60 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-primary">Confirm {TXNS.find((t) => t.key === txn)?.label}</p>
                        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                          <dt className="text-muted">Item</dt><dd className="font-medium">{scanned.item.item_code} · {scanned.item.name}</dd>
                          <dt className="text-muted">Quantity</dt><dd className="tabular text-lg font-semibold">{txn === "ADJUST" ? form.delta : form.quantity} {scanned.item.uom.code}</dd>
                          {form.from && <><dt className="text-muted">From</dt><dd className="font-mono">{locCode(form.from)}</dd></>}
                          {form.to && <><dt className="text-muted">To</dt><dd className="font-mono">{locCode(form.to)}</dd></>}
                          {form.refNo && <><dt className="text-muted">Against</dt><dd>{form.refType.replace(/_/g, " ").toLowerCase()} {form.refNo}</dd></>}
                          {form.qcHold && <><dt className="text-muted">QC</dt><dd>Goes to quality hold</dd></>}
                          {form.notes && <><dt className="text-muted">{txn === "ADJUST" ? "Reason" : "Notes"}</dt><dd>{form.notes}</dd></>}
                        </dl>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" size="lg" icon={<ArrowLeft className="size-4" />} onClick={() => setStage("form")}>Edit</Button>
                        <Button size="lg" variant="success" loading={busy} icon={<Send className="size-4" />} onClick={submit}>{txn === "ADJUST" ? "Submit request" : "Post transaction"}</Button>
                      </div>
                    </div>
                  )}
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function PendingSync() {
  const [queue, setQueue] = useState<QueuedTxn[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => setQueue(readQueue());
    refresh();
    window.addEventListener("lm:queue", refresh);
    window.addEventListener("online", refresh);
    return () => { window.removeEventListener("lm:queue", refresh); window.removeEventListener("online", refresh); };
  }, []);
  if (!queue.length) return null;
  return (
    <Card className="mb-5 border-warning/40">
      <CardHeader title={<span className="flex items-center gap-2"><CloudOff className="size-4 text-warning" /> Pending synchronization ({queue.length})</span>}
        subtitle="Captured while offline. Not confirmed server stock."
        actions={<Button size="sm" loading={busy} icon={<RefreshCw className="size-4" />} onClick={async () => {
          setBusy(true); setMsg(null);
          try { const r = await syncQueue(); setMsg(`${r.confirmed} confirmed, ${r.rejected} rejected`); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
        }}>Sync now</Button>} />
      <ul className="divide-y divide-line text-sm">
        {queue.map((q) => (
          <li key={q.body.txn_uuid} className="flex items-center gap-3 px-4 py-2">
            <Badge tone={q.status === "REJECTED" ? "danger" : "warning"}>{q.status === "REJECTED" ? "Rejected" : "Pending"}</Badge>
            <span className="flex-1">{q.label}{q.error && <span className="block text-xs text-danger">{q.error}</span>}</span>
            <span className="text-xs text-muted">{dateTime(q.queued_at)}</span>
            <button className="text-xs text-muted hover:text-danger" onClick={() => discard(q.body.txn_uuid)}>Discard</button>
          </li>
        ))}
      </ul>
      {msg && <p className="border-t border-line px-4 py-2 text-xs text-muted">{msg}</p>}
    </Card>
  );
}
