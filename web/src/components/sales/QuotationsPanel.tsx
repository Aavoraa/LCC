"use client";

import { ArrowRightLeft, Check, FileText, Send, X } from "lucide-react";
import { useState } from "react";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Modal, RiskBadge, Spinner, Td, Textarea, Th } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateFmt, money, qty } from "@/lib/format";
import type { Query } from "@/lib/hooks";
import type { Enquiry, Quotation, SalesOrder } from "@/lib/types";

export const QUOTE_TONE: Record<string, "neutral" | "info" | "success" | "danger" | "primary"> = {
  DRAFT: "neutral", SENT: "info", ACCEPTED: "success", REJECTED: "danger", CONVERTED: "primary",
};

export function QuotationsPanel({ quotations, onOrderCreated }: { quotations: Query<Quotation[]>; onOrderCreated: (so: SalesOrder) => void }) {
  const { can } = useAuth();
  const [err, setErr] = useState<string | null>(null);
  const [converting, setConverting] = useState<Quotation | null>(null);

  async function setStatus(q: Quotation, status: string) {
    setErr(null);
    try { await api(`/api/sales/quotations/${q.id}/status`, { method: "POST", json: { status } }); quotations.reload(); }
    catch (e) { setErr((e as ApiError).message); }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader title="Quotations" subtitle="Each carries the preliminary delivery estimate of its enquiry — a commitment is approved separately on the sales order" />
      {err && <div className="p-4 pb-0"><Alert>{err}</Alert></div>}
      {!quotations.data ? <Spinner /> : quotations.data.length === 0 ? (
        <EmptyState icon={<FileText className="size-5" />} title="No quotations yet" description="Create one from a saved enquiry on the Enquiries tab." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-[13px]">
            <thead><tr><Th>Quotation</Th><Th>Customer</Th><Th>Item</Th><Th className="text-right">Qty</Th><Th className="text-right">Amount</Th><Th>Preliminary date</Th><Th>Valid until</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>{quotations.data.map((q) => (
              <tr key={q.id} className="h-11 hover:bg-surface-2">
                <Td><span className="font-mono text-xs">{q.number}</span><p className="text-[11px] text-muted">{q.enquiry_number}</p></Td>
                <Td className="text-ink">{q.customer}</Td>
                <Td><span className="font-mono text-xs text-primary">{q.item_code}</span> {q.item_name}</Td>
                <Td className="tabular text-right">{qty(q.quantity)} <span className="text-muted">{q.uom}</span></Td>
                <Td className="tabular text-right">{money(q.amount)}</Td>
                <Td><span className="flex items-center gap-2">{dateFmt(q.preliminary_date)} <RiskBadge risk={q.risk} /></span></Td>
                <Td>{dateFmt(q.valid_until)}</Td>
                <Td><Badge tone={QUOTE_TONE[q.status]}>{q.status.toLowerCase()}</Badge></Td>
                <Td className="text-right">
                  {can("sales.order") && (
                    <div className="flex justify-end gap-1.5">
                      {q.status === "DRAFT" && <Button size="sm" variant="ghost" icon={<Send className="size-3.5" />} onClick={() => setStatus(q, "SENT")}>Sent</Button>}
                      {(q.status === "DRAFT" || q.status === "SENT") && <>
                        <Button size="sm" variant="success" icon={<Check className="size-3.5" />} onClick={() => setStatus(q, "ACCEPTED")}>Accepted</Button>
                        <Button size="sm" variant="ghost" aria-label="Mark rejected" onClick={() => setStatus(q, "REJECTED")}><X className="size-3.5" /></Button>
                      </>}
                      {q.status === "ACCEPTED" && <Button size="sm" icon={<ArrowRightLeft className="size-3.5" />} onClick={() => setConverting(q)}>Convert to order</Button>}
                    </div>
                  )}
                </Td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {converting && <ConvertModal source={{ quotation: converting }} onClose={() => setConverting(null)}
        onDone={(so) => { quotations.reload(); onOrderCreated(so); }} />}
    </Card>
  );
}

export function QuoteModal({ enquiry, onClose, onDone }: { enquiry: Enquiry; onClose: () => void; onDone: (q: Quotation) => void }) {
  const [f, setF] = useState({ unit_price: "", valid_days: "30", notes: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title={`Quotation from ${enquiry.number}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={f.unit_price === "" || Number(f.unit_price) < 0} onClick={async () => {
        setBusy(true); setErr(null);
        try {
          onDone(await api<Quotation>("/api/sales/quotations", { method: "POST", json: { enquiry_id: enquiry.id, unit_price: f.unit_price, valid_days: Number(f.valid_days), notes: f.notes || null } }));
          onClose();
        } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
      }}>Create quotation</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <p className="text-sm"><b>{enquiry.customer}</b> · <span className="font-mono text-xs text-primary">{enquiry.item_code}</span> {enquiry.item_name} × {qty(enquiry.quantity)}</p>
        <div className="rounded-md bg-surface-2 px-3 py-2 text-sm">
          Preliminary delivery estimate <b>{dateFmt(enquiry.estimated_date)}</b> <RiskBadge risk={enquiry.risk} />
          <p className="mt-0.5 text-xs text-muted">Calculated from rules and live stock when the enquiry was saved. It is not a commitment.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Unit price (₹)" required><Input type="number" min={0} step="any" value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value })} /></Field>
          <Field label="Valid for (days)"><Input type="number" min={1} max={365} value={f.valid_days} onChange={(e) => setF({ ...f, valid_days: e.target.value })} /></Field>
        </div>
        <Field label="Notes"><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

export function ConvertModal({ source, onClose, onDone }: {
  source: { quotation?: Quotation; enquiry?: Enquiry }; onClose: () => void; onDone: (so: SalesOrder) => void;
}) {
  const [f, setF] = useState({ customer_po_ref: "", required_date: source.enquiry?.required_date ?? "", notes: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = source.quotation?.number ?? source.enquiry?.number;
  return (
    <Modal open onClose={onClose} title={`Convert ${label} to a sales order`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={async () => {
        setBusy(true); setErr(null);
        try {
          const so = await api<SalesOrder>("/api/sales/orders", { method: "POST", json: {
            quotation_id: source.quotation?.id ?? null, enquiry_id: source.quotation ? null : source.enquiry?.id,
            customer_po_ref: f.customer_po_ref || null, required_date: f.required_date || null, notes: f.notes || null } });
          onDone(so); onClose();
        } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
      }}>Create draft order</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <p className="text-sm text-muted">The order starts as a draft. Confirming it re-checks stock, reserves what is free and raises requisitions for any shortage.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer PO reference"><Input value={f.customer_po_ref} onChange={(e) => setF({ ...f, customer_po_ref: e.target.value })} /></Field>
          <Field label="Required by" hint="Defaults to the enquiry's date"><Input type="date" value={f.required_date} onChange={(e) => setF({ ...f, required_date: e.target.value })} /></Field>
        </div>
        <Field label="Notes"><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
