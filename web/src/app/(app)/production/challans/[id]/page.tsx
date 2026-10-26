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
  const cell = "border border-black px-2 py-1 align-top";
  return (
    <div className="mx-auto max-w-[800px] bg-white p-4 text-[12px] leading-snug text-black shadow-card print:max-w-none print:p-0 print:shadow-none">
      <table className="w-full border-collapse">
        <tbody>
          <tr><td colSpan={3} className={`${cell} text-center text-xl font-bold tracking-wide`}>DELIVERY CHALLAN (JOB WORK)</td></tr>
          <tr>
            <td colSpan={2} className={`${cell} text-[15px] font-semibold`}>{c.name}{c.unit_name ? `  - ${c.unit_name}` : ""}</td>
            <td className={`${cell} w-[30%] text-center`}>Delivery Challan<br />For<br />Job Work</td>
          </tr>
          <tr>
            <td className={`${cell} w-[42%] whitespace-pre-line`}>
              {c.address}{"\n"}State : {c.state}{"\n"}Phone : {c.phone}{c.fax ? `\nFax: ${c.fax}` : ""}
              {c.regd_office ? `\nRegd Office : ${c.regd_office}` : ""}{c.regd_phone ? `\nPhone : ${c.regd_phone}` : ""}
              {c.email ? `\nE-mail : ${c.email}` : ""}{"\n"}GSTIN : {c.gstin}
            </td>
            <td className={cell}>
              <table className="w-full"><tbody>
                <tr><td className="w-14">CIN</td><td className="w-3">:</td><td>{c.cin}</td></tr>
                <tr><td>PAN</td><td>:</td><td>{c.pan}</td></tr>
                <tr><td>GSTIN</td><td>:</td><td>{c.gstin}</td></tr>
              </tbody></table>
            </td>
            <td className={`${cell} p-0`}>
              <div className="border-b border-black px-2 py-1">No. <span className="font-semibold">{d.number}</span></div>
              <div className="border-b border-black px-2 py-1">Dt. <span className="font-semibold">{dmy(d.challan_date)}</span></div>
              <div className="space-y-1.5 px-2 py-2">
                {COPIES.map((x) => (
                  <p key={x} className={x === copy ? "font-bold" : "text-black/50"}>{x === copy ? "☑ " : "☐ "}{x}{x === copy && COPY_FOR[x] ? ` ${COPY_FOR[x].toUpperCase()}` : ""}</p>
                ))}
              </div>
              <div className="grid grid-cols-2 border-t border-black"><span className="border-r border-black px-2 py-1">PO No.</span><span className="px-2 py-1 font-semibold">{d.po_number ?? ""}</span></div>
              <div className="grid grid-cols-2 border-t border-black"><span className="border-r border-black px-2 py-1">PO Dt.</span><span className="px-2 py-1 font-semibold">{d.po_date ? new Date(`${d.po_date}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }).toUpperCase().replace(/ /g, "-") : ""}</span></div>
            </td>
          </tr>
          <tr>
            <td className={`${cell} whitespace-pre-line`}>
              <span className="font-semibold underline">Details Of Consignee:</span>{"\n"}
              <span className="font-semibold">{d.consignee.name}</span>{d.consignee.address ? `\n${d.consignee.address}` : ""}
              {d.consignee.gstin ? `\nGSTIN : ${d.consignee.gstin}` : ""}{d.consignee.phone ? `\nPhone : ${d.consignee.phone}` : ""}
            </td>
            <td className={`${cell} whitespace-pre-line`}>
              <span className="font-semibold underline">Shipped To:</span>{"\n"}
              <span className="font-semibold">{d.consignee.name}</span>{d.consignee.address ? `\n${d.consignee.address}` : ""}
            </td>
            <td className={`${cell} whitespace-pre-line`}>
              Vehicle No : <span className="font-semibold">{d.vehicle_no ?? ""}</span>{"\n"}
              Transporter : {d.transporter ?? ""}{"\n"}
              Waybill No : {d.waybill_no ?? ""}{"\n"}
              Process Nature : <span className="font-semibold">{d.process_nature}</span>
              {d.expected_return_date ? `\nReturn by : ${dmy(d.expected_return_date)}` : ""}
            </td>
          </tr>
        </tbody>
      </table>

      <table className="mt-[-1px] w-full border-collapse">
        <thead>
          <tr className="text-left">
            {["Sl.", "Item Code", "Description of Goods", "HSN", "Qty", "UOM", "Rate (₹)", "Value (₹)"].map((h, i) => (
              <th key={h} className={`${cell} font-semibold ${i >= 4 && i !== 5 ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.line_no}>
              <td className={cell}>{l.line_no}</td>
              <td className={`${cell} font-mono`}>{l.item_code}</td>
              <td className={cell}>{l.description}{d.work_order && <span className="block text-[11px]">Job: {d.work_order.number} · for {d.process_nature.toLowerCase()}</span>}</td>
              <td className={cell}>{l.hsn_code}</td>
              <td className={`${cell} text-right`}>{qty(l.quantity)}</td>
              <td className={cell}>{l.uom}</td>
              <td className={`${cell} text-right`}>{rupee(l.rate)}</td>
              <td className={`${cell} text-right`}>{rupee(l.value)}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td colSpan={4} className={`${cell} text-right`}>Total</td>
            <td className={`${cell} text-right`}>{qty(d.quantity)}</td>
            <td className={cell} />
            <td className={cell} />
            <td className={`${cell} text-right`}>{rupee(d.value)}</td>
          </tr>
          <tr><td colSpan={8} className={cell}>Value (approx., for job work only): <span className="font-semibold">{amountInWords(d.value)}</span></td></tr>
          <tr>
            <td colSpan={8} className={`${cell} text-[11px]`}>
              Goods sent for job work under Section 143 of the CGST Act, 2017 read with Rule 45 of the CGST Rules, 2017 — not a supply, not for sale.
              The processed goods are to be returned to us after {d.process_nature.toLowerCase()}, together with a copy of this challan.
              {d.notes ? ` Note: ${d.notes}` : ""}
            </td>
          </tr>
          <tr>
            <td colSpan={4} className={`${cell} h-20`}>Received the above goods in good condition.<br /><br /><br />Receiver&apos;s signature &amp; seal</td>
            <td colSpan={4} className={`${cell} text-right`}>For {c.name}<br /><br /><br />Authorised Signatory</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-1 text-[10px]">Prepared by {d.created_by ?? "—"}</p>
    </div>
  );
}
