"use client";

import { ArrowRightLeft, CalendarClock, CheckCircle2, CircleAlert, FileText, Save, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { ItemPicker } from "@/components/ItemPicker";
import { MachineSelect } from "@/components/sales/MachineSelect";
import { OrdersPanel } from "@/components/sales/OrdersPanel";
import { ConvertModal, QuotationsPanel, QuoteModal } from "@/components/sales/QuotationsPanel";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, RiskBadge, Select, Spinner, Tabs, Td, Textarea, Th, cx } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateFmt, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import type { Customer, Enquiry, Estimate, ItemRow, Quotation, SalesOrder } from "@/lib/types";

type Tab = "enquiry" | "quotations" | "orders";

export default function SalesPage() {
  const { can } = useAuth();
  const customers = useApi<Customer[]>("/api/masters/customers");
  const enquiries = useApi<Enquiry[]>("/api/sales/enquiries");
  const quotations = useApi<Quotation[]>("/api/sales/quotations");
  const orders = useApi<SalesOrder[]>("/api/sales/orders", { pollMs: 30000 });
  const [tab, setTab] = useState<Tab>("enquiry");
  const [openOrder, setOpenOrder] = useState<number | null>(null);
  const [quoting, setQuoting] = useState<Enquiry | null>(null);
  const [converting, setConverting] = useState<Enquiry | null>(null);
  const atRisk = orders.data?.filter((o) => o.at_risk).length ?? 0;
  // Deep link from the order tracker: /sales?tab=orders&order=<id>
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tab");
    if (t === "orders" || t === "quotations" || t === "enquiry") setTab(t as Tab);
    if (q.get("order")) { setTab("orders"); setOpenOrder(Number(q.get("order"))); }
  }, []);

  function showOrder(so: SalesOrder) {
    orders.reload(); enquiries.reload(); setTab("orders"); setOpenOrder(so.id);
  }
  const [item, setItem] = useState<ItemRow | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [f, setF] = useState({ customer_id: "", reference: "", quantity: "", required_date: "", customer_location: "", notes: "" });
  const [est, setEst] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => { setEst(null); setSaved(null); }, [item, f.quantity, f.customer_id, f.required_date]);

  async function check() {
    if (!item || !(Number(f.quantity) > 0)) return;
    setBusy(true); setError(null);
    try {
      setEst(await api<Estimate>("/api/sales/estimate", { method: "POST", json: {
        item_id: item.id, quantity: f.quantity, customer_id: f.customer_id ? Number(f.customer_id) : null, required_date: f.required_date || null } }));
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  }

  async function save() {
    if (!item) return;
    setBusy(true); setError(null);
    try {
      const r = await api<Enquiry>("/api/sales/enquiries", { method: "POST", json: {
        customer_id: Number(f.customer_id), reference: f.reference || null, item_id: item.id, quantity: f.quantity,
        required_date: f.required_date || null, customer_location: f.customer_location || null,
        notes: [model && `Model: ${model}`, f.notes].filter(Boolean).join("\n") || null } });
      setSaved(r.number);
      enquiries.reload();
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  }

  const a = est?.availability;
  return (
    <>
      <PageHeader title="Sales & customer enquiries" description="Check live available-to-promise stock and a rule-based delivery estimate, quote it, then confirm the order to reserve stock." />
      <Tabs className="mb-5" value={tab} onChange={setTab} tabs={[
        { id: "enquiry", label: "Enquiry & estimate" },
        { id: "quotations", label: "Quotations", count: quotations.data?.filter((q) => q.status === "DRAFT" || q.status === "SENT" || q.status === "ACCEPTED").length },
        { id: "orders", label: <>Sales orders{atRisk > 0 && <span className="text-danger"> · {atRisk} at risk</span>}</>, count: orders.data?.filter((o) => o.status === "DRAFT" || o.status === "CONFIRMED").length },
      ]} />
      {tab === "quotations" && <QuotationsPanel quotations={quotations} onOrderCreated={showOrder} />}
      {tab === "orders" && <OrdersPanel orders={orders} openId={openOrder} onOpen={setOpenOrder} />}
      {tab === "enquiry" && <>
      <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
        <Card className="h-fit">
          <CardHeader title="Enquiry" />
          <form className="space-y-4 p-4" onSubmit={(e) => { e.preventDefault(); check(); }}>
            <MachineSelect value={item} onChange={setItem} onModelChange={setModel} />
            <Field label="Machine or spare" required hint="Chosen from the dropdowns above, or search any item"><ItemPicker value={item} onChange={setItem} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Quantity${item ? ` (${item.uom})` : ""}`} required><Input type="number" min={0} step="any" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
              <Field label="Required by"><Input type="date" value={f.required_date} onChange={(e) => setF({ ...f, required_date: e.target.value })} /></Field>
            </div>
            <Field label="Customer" required={can("sales.enquiry")} hint="Transport days come from the customer master">
              <Select value={f.customer_id} onChange={(e) => setF({ ...f, customer_id: e.target.value })}>
                <option value="">Select…</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}{c.city ? ` — ${c.city}` : ""}</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Enquiry reference"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
              <Field label="Customer location"><Input value={f.customer_location} onChange={(e) => setF({ ...f, customer_location: e.target.value })} /></Field>
            </div>
            <Field label="Notes"><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
            {error && <Alert>{error}</Alert>}
            <Button type="submit" className="w-full" size="lg" loading={busy && !est} disabled={!item || !(Number(f.quantity) > 0)} icon={<Search className="size-4" />}>Check availability & estimate</Button>
          </form>
        </Card>

        <div className="space-y-5">
          {!est ? (
            <Card><EmptyState icon={<CalendarClock className="size-5" />} title="No estimate yet" description="Pick an item and quantity to see free stock, incoming supply and a preliminary delivery date." /></Card>
          ) : (
            <>
              <Card>
                <CardHeader title={`${a!.item_code} · ${a!.item_name}`} subtitle="Available-to-promise excludes reserved and QC-hold stock" />
                <div className="grid grid-cols-2 divide-line sm:grid-cols-4 sm:divide-x">
                  {[["Physical", a!.physical], ["Reserved", a!.reserved], ["Quality hold", a!.quality_hold], ["Available to promise", a!.available_to_promise]].map(([l, v]) => (
                    <div key={l} className="p-4">
                      <p className="text-xs text-muted">{l}</p>
                      <p className={cx("tabular mt-1 text-xl font-semibold", l === "Available to promise" && "text-success")}>{qty(v)} <span className="text-xs font-normal text-muted">{a!.uom}</span></p>
                    </div>
                  ))}
                </div>
                <div className="grid gap-4 border-t border-line p-4 sm:grid-cols-2">
                  <div>
                    <p className="text-xs font-medium text-muted">Incoming (approved POs, not yet available)</p>
                    {a!.incoming.length === 0 ? <p className="mt-1 text-sm text-ink-2">None</p> : (
                      <ul className="mt-1 space-y-1 text-sm">{a!.incoming.map((i) => <li key={i.po_number}><b className="tabular">{qty(i.open_qty)}</b> · {i.po_number} · {i.supplier} · due {dateFmt(i.expected_date)}</li>)}</ul>
                    )}
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted">Shortage for this enquiry</p>
                    <p className={cx("tabular mt-1 text-xl font-semibold", Number(a!.shortage) > 0 ? "text-danger" : "text-success")}>{qty(a!.shortage)} {a!.uom}</p>
                    {a!.committed_demand.length > 0 && <p className="mt-1 text-xs text-muted">Committed: {a!.committed_demand.map((c) => `${c.ref} (${qty(c.quantity)})`).join(", ")}</p>}
                  </div>
                </div>
              </Card>

              <Card>
                <CardHeader title={<span className="flex items-center gap-2">Preliminary delivery estimate <Badge tone="neutral">Not a commitment</Badge></span>}
                  actions={<RiskBadge risk={est.risk} />} />
                <div className="flex flex-wrap items-center gap-6 p-4">
                  <div>
                    <p className="text-xs text-muted">Estimated delivery</p>
                    <p className="text-2xl font-semibold tracking-tight">{dateFmt(est.estimated_date)}</p>
                  </div>
                  {est.meets_required_date !== null && (
                    <div className={cx("flex items-center gap-2 rounded-md px-3 py-2 text-sm", est.meets_required_date ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
                      {est.meets_required_date ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4" />}
                      {est.meets_required_date ? "Meets the required date" : `Misses required date ${dateFmt(f.required_date)}`}
                    </div>
                  )}
                </div>
                <div className="overflow-x-auto border-t border-line">
                  <table className="w-full text-[13px]">
                    <thead><tr><Th>Step</Th><Th>Owner</Th><Th className="text-right">Working days</Th><Th>Complete by</Th></tr></thead>
                    <tbody>{est.steps.map((s) => (
                      <tr key={s.step}><Td className="h-9 text-ink">{s.step}</Td><Td>{s.owner}</Td><Td className="tabular text-right">{s.days}</Td><Td className="tabular">{dateFmt(s.complete_by)}</Td></tr>
                    ))}</tbody>
                  </table>
                </div>
                <div className="grid gap-4 border-t border-line p-4 text-sm sm:grid-cols-2">
                  <div><p className="mb-1 text-xs font-medium text-muted">Critical dependencies</p>
                    {est.critical_dependencies.length ? <ul className="list-disc space-y-0.5 pl-4 text-ink-2">{est.critical_dependencies.map((d) => <li key={d}>{d}</li>)}</ul> : <p className="text-ink-2">None</p>}</div>
                  <div><p className="mb-1 text-xs font-medium text-muted">Assumptions</p>
                    <ul className="list-disc space-y-0.5 pl-4 text-ink-2">{est.assumptions.map((d) => <li key={d}>{d}</li>)}</ul></div>
                </div>
                {can("sales.enquiry") && (
                  <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-2 px-4 py-3">
                    {saved ? <span className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="size-4" /> Saved as {saved}</span>
                      : <span className="text-xs text-muted">{f.customer_id ? "Save to record this enquiry and estimate." : "Select a customer to save the enquiry."}</span>}
                    <Button icon={<Save className="size-4" />} loading={busy} disabled={!f.customer_id || !!saved} onClick={save}>Save enquiry</Button>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      </div>

      <Card className="mt-5 overflow-hidden">
        <CardHeader title="Recent enquiries" subtitle="Quote a saved enquiry, or convert it straight into a sales order" />
        {!enquiries.data ? <Spinner /> : enquiries.data.length === 0 ? <EmptyState title="No enquiries yet" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-[13px]">
              <thead><tr><Th>Enquiry</Th><Th>Customer</Th><Th>Item</Th><Th className="text-right">Qty</Th><Th>Required</Th><Th>Estimated</Th><Th>Risk</Th><Th>Status</Th><Th /></tr></thead>
              <tbody>{enquiries.data.map((e) => (
                <tr key={e.id} className="h-10 hover:bg-surface-2">
                  <Td className="font-mono text-xs">{e.number}</Td><Td className="text-ink">{e.customer}</Td>
                  <Td><span className="font-mono text-xs text-primary">{e.item_code}</span> {e.item_name}</Td>
                  <Td className="tabular text-right">{qty(e.quantity)}</Td><Td>{dateFmt(e.required_date)}</Td><Td>{dateFmt(e.estimated_date)}</Td>
                  <Td><RiskBadge risk={e.risk} /></Td><Td><Badge tone={e.status === "WON" ? "success" : e.status === "LOST" ? "danger" : e.status === "QUOTED" ? "info" : "neutral"}>{e.status.toLowerCase()}</Badge></Td>
                  <Td className="text-right">
                    {can("sales.order") && (e.status === "OPEN" || e.status === "QUOTED") && (
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="secondary" icon={<FileText className="size-3.5" />} onClick={() => setQuoting(e)}>Quote</Button>
                        <Button size="sm" variant="ghost" icon={<ArrowRightLeft className="size-3.5" />} onClick={() => setConverting(e)}>Order</Button>
                      </div>
                    )}
                  </Td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      </>}
      {quoting && <QuoteModal enquiry={quoting} onClose={() => setQuoting(null)} onDone={() => { enquiries.reload(); quotations.reload(); setTab("quotations"); }} />}
      {converting && <ConvertModal source={{ enquiry: converting }} onClose={() => setConverting(null)} onDone={showOrder} />}
    </>
  );
}
