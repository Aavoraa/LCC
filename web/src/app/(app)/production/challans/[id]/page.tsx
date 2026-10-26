"use client";

import { ArrowLeft, Printer, Save } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, CardHeader, ErrorState, Field, Input, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";

export interface ChallanDoc {
  id: number; number: string; challan_date: string; status: "SENT" | "RECEIVED"; overdue: boolean;
  supplier: { id: number; code: string; name: string };
  consignee: { name: string; code: string; address: string | null; gstin: string | null; phone: string | null; email: string | null };
  process_nature: string; po_number: string | null; po_date: string | null; vehicle_no: string | null; transporter: string | null;
  waybill_no: string | null; expected_return_date: string | null; work_order: { id: number; number: string; status: string } | null; op_seq: number | null;
  lines: { line_no: number; item_code: string | null; description: string; hsn_code: string | null; quantity: string; uom: string; rate: string; value: string; qty_received: string }[];
  quantity: string; value: string; notes: string | null; created_by: string | null; received_at: string | null;
  company: Record<string, string>;
}

const COPIES = ["ORIGINAL", "DUPLICATE", "TRIPLICATE", "EXTRA COPY"] as const;
const COPY_FOR: Record<string, string> = { ORIGINAL: "for consignee", DUPLICATE: "for transporter", TRIPLICATE: "for consignor", "EXTRA COPY": "" };
const EDIT_FIELDS = ["vehicle_no", "transporter", "waybill_no", "po_number", "po_date", "process_nature", "expected_return_date"] as const;
type EditKey = (typeof EDIT_FIELDS)[number];

/** dd/mm/yyyy, as printed on the Oracle challan. */
const dmy = (v: string | null) => (v ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : "");
const rupee = (v: string | number) => Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function words(n: number): string {
  const a = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen",
    "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (x: number) => (x < 20 ? a[x] : `${b[Math.floor(x / 10)]}${x % 10 ? ` ${a[x % 10]}` : ""}`);
  const three = (x: number) => [x >= 100 ? `${a[Math.floor(x / 100)]} Hundred` : "", two(x % 100)].filter(Boolean).join(" ");
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7), lakh = Math.floor((n % 1e7) / 1e5), thousand = Math.floor((n % 1e5) / 1e3), rest = n % 1e3;
  if (crore) parts.push(`${words(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (rest) parts.push(three(rest));
  return parts.join(" ");
}
function amountInWords(v: string) {
  const n = Math.round(Number(v) * 100);
  const r = Math.floor(n / 100), p = n % 100;
  return `Rupees ${words(r)}${p ? ` and ${words(p)} Paise` : ""} Only`;
}

export default function ChallanPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const doc = useApi<ChallanDoc>(`/api/osp/challans/${id}`);
  const [form, setForm] = useState<Record<EditKey, string> | null>(null);
  const [copies, setCopies] = useState<string[]>([...COPIES]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (doc.data) setForm(Object.fromEntries(EDIT_FIELDS.map((k) => [k, (doc.data![k] as string | null) ?? ""])) as Record<EditKey, string>);
  }, [doc.data]);

  if (doc.error) return <ErrorState error={doc.error} onRetry={doc.reload} />;
  const d = doc.data;
  if (!d || !form) return <Spinner />;
  const editable = can("production.manage");
  const dirty = EDIT_FIELDS.some((k) => (d[k] ?? "") !== form[k]);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/osp/challans/${id}`, { method: "PATCH", json: Object.fromEntries(EDIT_FIELDS.filter((k) => (d![k] ?? "") !== form![k]).map((k) => [k, form![k] || null])) });
      doc.reload();
      setMsg({ ok: true, text: "Challan updated" });
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <Link href="/production/challans" className="inline-flex items-center gap-1 text-sm text-primary"><ArrowLeft className="size-4" /> OSP delivery challans</Link>
        <span className="font-mono text-sm font-semibold">{d.number}</span>
        <Badge tone={d.status === "RECEIVED" ? "success" : d.overdue ? "danger" : "warning"} dot>{d.status === "RECEIVED" ? "Received back" : d.overdue ? "Overdue at vendor" : "At vendor"}</Badge>
        {d.work_order && <Link href="/production" className="text-sm text-primary">Work order {d.work_order.number} · step {d.op_seq}</Link>}
        <div className="ml-auto flex gap-2">
          <Button icon={<Printer className="size-4" />} disabled={dirty || copies.length === 0} title={dirty ? "Save changes first" : undefined} onClick={() => window.print()}>Print</Button>
        </div>
      </div>

      <Card className="no-print mb-5">
        <CardHeader title="Transport & PO details" subtitle="Fill in before printing — the vehicle is often known only at loading" />
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          {msg && <div className="sm:col-span-2 lg:col-span-4"><Alert tone={msg.ok ? "success" : "danger"}>{msg.text}</Alert></div>}
          {([
            ["vehicle_no", "Vehicle number", "text"], ["transporter", "Transporter", "text"], ["waybill_no", "Waybill / e-way bill no.", "text"],
            ["process_nature", "Process nature", "text"], ["po_number", "PO number", "text"], ["po_date", "PO date", "date"],
            ["expected_return_date", "Expected back by", "date"],
          ] as [EditKey, string, string][]).map(([k, label, type]) => (
            <Field key={k} label={label}>
              <Input type={type} value={form[k]} disabled={!editable} onChange={(e) => setForm({ ...form, [k]: k === "vehicle_no" || k === "process_nature" ? e.target.value.toUpperCase() : e.target.value })} />
            </Field>
          ))}
          <div className="flex items-end">
            {editable && <Button icon={<Save className="size-4" />} loading={busy} disabled={!dirty} onClick={save}>Save</Button>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t border-line px-4 py-3 text-sm">
          <span className="text-muted">Copies to print:</span>
          {COPIES.map((c) => (
            <label key={c} className="flex items-center gap-1.5">
              <input type="checkbox" checked={copies.includes(c)} onChange={(e) => setCopies(e.target.checked ? COPIES.filter((x) => x === c || copies.includes(x)) : copies.filter((x) => x !== c))} />
              {c}
            </label>
          ))}
        </div>
      </Card>

      <div className="space-y-6 print:space-y-0">
        {copies.map((copy, i) => (
          <div key={copy} className={i < copies.length - 1 ? "print:break-after-page" : undefined}>
            <ChallanSheet d={d} copy={copy} />
          </div>
        ))}
      </div>
    </>
  );
}

function ChallanSheet({ d, copy }: { d: ChallanDoc; copy: string }) {
  const c = d.company;
  const label = "block text-[11px] font-bold uppercase tracking-wide text-[#4B5563]";
  const cell = "border border-[#9CA3AF] px-2 py-2.5 align-top";
  const head = "border border-[#9CA3AF] px-2 py-2 text-left text-[11px] font-extrabold uppercase tracking-wide";
  const poDate = d.po_date ? dmy(d.po_date) : "";
  return (
    <div className="mx-auto flex min-h-[1123px] w-full max-w-[794px] flex-col gap-4 bg-white px-[52px] py-12 text-[13px] leading-snug text-[#111827] shadow-card print:min-h-0 print:max-w-none print:px-0 print:py-0 print:shadow-none">
      <header className="flex items-start justify-between gap-6 border-b-[3px] border-[#12245B] pb-4">
        <div className="flex max-w-[420px] items-start gap-3.5">
          <div className="grid size-[50px] shrink-0 place-items-center rounded-xl bg-[#12245B] text-base font-extrabold text-white">LCC</div>
          <div className="space-y-1">
            <p className="text-[15px] font-extrabold leading-tight">{c.name}</p>
            <p className="whitespace-pre-line text-xs leading-relaxed text-[#374151]">
              {c.unit_name ? `${c.unit_name} · ` : ""}{c.address.replace(/\n/g, ", ")}{c.state ? `, ${c.state}` : ""}
              {"\n"}Phone {c.phone}{c.email ? ` · ${c.email}` : ""}
            </p>
            <p className="font-mono text-[11px] text-[#374151]">GSTIN {c.gstin} · PAN {c.pan} · CIN {c.cin}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 text-right">
          <p className="text-[22px] font-extrabold tracking-wide text-[#12245B]">DELIVERY CHALLAN</p>
          <p className="text-xs font-semibold text-[#374151]">For job work · CGST Rule 45 / Section 143</p>
          <p className="mt-1 rounded-md border-2 border-[#111827] px-2.5 py-1 text-xs font-extrabold tracking-wider">
            {copy}{COPY_FOR[copy] ? ` · ${COPY_FOR[copy].toUpperCase()}` : ""}
          </p>
        </div>
      </header>

      <section className="grid grid-cols-4 overflow-hidden rounded-lg border border-[#9CA3AF]">
        <div className="border-r border-[#D1D5DB] px-3 py-2.5"><span className={label}>Challan no.</span><span className="font-mono text-[15px] font-semibold">{d.number}</span></div>
        <div className="border-r border-[#D1D5DB] px-3 py-2.5"><span className={label}>Challan date</span><span className="text-[15px] font-bold">{dmy(d.challan_date)}</span></div>
        <div className="border-r border-[#D1D5DB] px-3 py-2.5"><span className={label}>PO no. / date</span><span className="text-[15px] font-bold">{d.po_number ?? "—"}{poDate ? ` · ${poDate}` : ""}</span></div>
        <div className="px-3 py-2.5"><span className={label}>Return by</span><span className="text-[15px] font-bold">{d.expected_return_date ? dmy(d.expected_return_date) : "—"}</span></div>
      </section>

      <section className="grid grid-cols-2 gap-4">
        <div className="space-y-1 rounded-lg border border-[#9CA3AF] px-3.5 py-3">
          <span className={label}>Consignee · shipped to</span>
          <p className="text-[15px] font-extrabold">{d.consignee.name}</p>
          {d.consignee.address && <p className="whitespace-pre-line leading-relaxed text-[#1F2937]">{d.consignee.address}</p>}
          {d.consignee.gstin && <p className="font-mono text-xs">GSTIN {d.consignee.gstin}</p>}
          {d.consignee.phone && <p className="text-xs">Phone {d.consignee.phone}</p>}
        </div>
        <div className="grid grid-cols-2 content-start gap-x-3 gap-y-2 rounded-lg border border-[#9CA3AF] px-3.5 py-3">
          <span className={`${label} col-span-2`}>Transport &amp; process</span>
          <p><span className="block text-[11px] text-[#4B5563]">Vehicle no.</span><span className="font-mono font-semibold">{d.vehicle_no ?? "—"}</span></p>
          <p><span className="block text-[11px] text-[#4B5563]">Transporter</span><span className="font-bold">{d.transporter ?? "—"}</span></p>
          <p><span className="block text-[11px] text-[#4B5563]">Waybill / e-way bill</span><span className="font-bold">{d.waybill_no ?? "—"}</span></p>
          <p><span className="block text-[11px] text-[#4B5563]">Work order</span><span className="font-mono font-semibold">{d.work_order ? `${d.work_order.number} · step ${d.op_seq}` : "—"}</span></p>
          <p className="col-span-2"><span className="block text-[11px] text-[#4B5563]">Nature of processing</span><span className="font-extrabold">{d.process_nature}</span></p>
        </div>
      </section>

      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-[#EEF2FA]">
            <th className={head}>Sl.</th><th className={head}>Item code</th><th className={head}>Description of goods</th><th className={head}>HSN</th>
            <th className={`${head} text-right`}>Qty</th><th className={head}>UOM</th><th className={`${head} text-right`}>Rate ₹</th><th className={`${head} text-right`}>Value ₹</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.line_no}>
              <td className={cell}>{l.line_no}</td>
              <td className={`${cell} font-mono text-xs`}>{l.item_code}</td>
              <td className={cell}><span className="font-bold">{l.description}</span>
                <span className="block text-xs text-[#374151]">For {d.process_nature.toLowerCase()}, to be returned after processing</span></td>
              <td className={cell}>{l.hsn_code}</td>
              <td className={`${cell} text-right font-bold`}>{qty(l.quantity)}</td>
              <td className={cell}>{l.uom}</td>
              <td className={`${cell} text-right`}>{rupee(l.rate)}</td>
              <td className={`${cell} text-right font-bold`}>{rupee(l.value)}</td>
            </tr>
          ))}
          <tr style={{ height: Math.max(40, 150 - (d.lines.length - 1) * 50) }}>
            {Array.from({ length: 8 }).map((_, i) => <td key={i} className="border border-[#9CA3AF]" />)}
          </tr>
          <tr className="bg-[#F9FAFB] font-extrabold">
            <td colSpan={4} className={`${cell} text-right`}>Total</td>
            <td className={`${cell} text-right`}>{qty(d.quantity)}</td>
            <td className={cell} /><td className={cell} />
            <td className={`${cell} text-right`}>{rupee(d.value)}</td>
          </tr>
        </tbody>
      </table>

      <p><span className="font-bold">Value in words (for job work only):</span> {amountInWords(d.value)}</p>

      <div className="rounded-lg border border-[#9CA3AF] px-3.5 py-3 text-xs leading-relaxed text-[#1F2937]">
        <span className="font-extrabold text-[#111827]">Declaration.</span> Goods sent for job work under Section 143 of the CGST Act, 2017 read with Rule 45 of the CGST
        Rules, 2017. This is not a supply and the goods are not for sale. The processed goods are to be returned to us within one year, together with a copy of this challan.
        {d.notes ? ` Note: ${d.notes}` : ""}
      </div>

      <div className="mt-auto grid grid-cols-2 gap-4">
        <div className="flex h-[120px] flex-col justify-between rounded-lg border border-[#9CA3AF] px-3.5 py-3 text-xs">
          <span>Received the above goods in good condition.</span>
          <span className="border-t border-[#9CA3AF] pt-1.5 font-bold">Receiver&apos;s signature &amp; seal · Date</span>
        </div>
        <div className="flex h-[120px] flex-col justify-between rounded-lg border border-[#9CA3AF] px-3.5 py-3 text-right text-xs">
          <span className="font-bold">For {c.name}</span>
          <span className="border-t border-[#9CA3AF] pt-1.5 font-bold">Authorised signatory</span>
        </div>
      </div>

      <footer className="flex justify-between gap-4 border-t border-[#D1D5DB] pt-2.5 text-[11px] text-[#4B5563]">
        <span>{c.regd_office ? `Regd. office: ${c.regd_office.replace(/\n/g, " ")}` : ""}{c.regd_phone ? ` · ${c.regd_phone}` : ""}</span>
        <span className="shrink-0">Prepared by {d.created_by ?? "—"}</span>
      </footer>
    </div>
  );
}
