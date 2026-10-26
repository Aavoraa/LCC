"use client";

import { Download, FileText, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, PageHeader, Select, Spinner, Td, Th } from "@/components/ui";
import { dateFmt, money, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import type { Supplier } from "@/lib/types";

interface ChallanRow {
  id: number; number: string; challan_date: string; status: "SENT" | "RECEIVED"; overdue: boolean;
  supplier: { id: number; code: string; name: string }; process_nature: string; po_number: string | null; po_date: string | null;
  vehicle_no: string | null; transporter: string | null; waybill_no: string | null; expected_return_date: string | null;
  work_order: { id: number; number: string } | null; op_seq: number | null; items: string; quantity: string; value: string;
}

const EMPTY = { date_from: "", date_to: "", number: "", po_number: "", vehicle_no: "", process_nature: "", supplier_id: "", status: "" };

export default function ChallanRegisterPage() {
  const [draft, setDraft] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v)).toString();
  const rows = useApi<ChallanRow[]>(`/api/osp/challans${qs ? `?${qs}` : ""}`);
  const sups = useApi<Supplier[]>("/api/masters/suppliers");
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.target.value });

  function csv() {
    if (!rows.data) return;
    const head = ["Challan No", "Challan Date", "Vendor", "Process Nature", "Items", "Quantity", "Value", "PO No", "PO Date", "Vehicle No",
      "Transporter", "Waybill No", "Work Order", "Expected Back", "Status"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = rows.data.map((r) => [r.number, r.challan_date, r.supplier.name, r.process_nature, r.items, r.quantity, r.value, r.po_number, r.po_date,
      r.vehicle_no, r.transporter, r.waybill_no, r.work_order?.number, r.expected_return_date, r.status].map(esc).join(","));
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob(["﻿" + [head.map(esc).join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" })),
      download: "LCC OSP Delivery Challans.csv",
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <PageHeader title="OSP delivery challans" description="Job-work challans raised when a work-order step goes to an outside processor. Open one to fill in transport details and print."
        actions={<Button variant="secondary" icon={<Download className="size-4" />} disabled={!rows.data?.length} onClick={csv}>Export</Button>} />
      <Card className="mb-5 p-4">
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); setApplied(draft); }}>
          <Field label="Challan date from"><Input type="date" value={draft.date_from} onChange={set("date_from")} /></Field>
          <Field label="Challan date to"><Input type="date" value={draft.date_to} onChange={set("date_to")} /></Field>
          <Field label="Challan number"><Input value={draft.number} onChange={set("number")} placeholder="U4-26-27/0649" /></Field>
          <Field label="PO number"><Input value={draft.po_number} onChange={set("po_number")} placeholder="174637" /></Field>
          <Field label="Vehicle number"><Input value={draft.vehicle_no} onChange={set("vehicle_no")} placeholder="TN 66 AK 5769" /></Field>
          <Field label="Process nature"><Input value={draft.process_nature} onChange={set("process_nature")} placeholder="HARDENING" /></Field>
          <Field label="Vendor"><Select value={draft.supplier_id} onChange={set("supplier_id")}><option value="">All vendors</option>
            {sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Status"><Select value={draft.status} onChange={set("status")}><option value="">All</option><option value="SENT">At vendor</option><option value="RECEIVED">Received back</option></Select></Field>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit" icon={<Search className="size-4" />}>Apply</Button>
            <Button type="button" variant="ghost" onClick={() => { setDraft(EMPTY); setApplied(EMPTY); }}>Clear</Button>
          </div>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {rows.error ? <ErrorState error={rows.error} onRetry={rows.reload} /> : !rows.data ? <Spinner /> : rows.data.length === 0 ? (
          <EmptyState icon={<FileText className="size-8" />} title="No challans" description="Challans are raised from Production when an outside step is sent to a vendor." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-[13px]">
              <thead><tr><Th>Challan no.</Th><Th>Date</Th><Th>Vendor</Th><Th>Process nature</Th><Th>Item</Th><Th className="text-right">Qty</Th>
                <Th className="text-right">Value</Th><Th>PO no. / date</Th><Th>Vehicle</Th><Th>Work order</Th><Th>Back by</Th><Th>Status</Th></tr></thead>
              <tbody>{rows.data.map((r) => (
                <tr key={r.id} className="hover:bg-surface-2">
                  <Td className="h-10"><Link href={`/production/challans/${r.id}`} className="font-mono text-xs font-semibold text-primary">{r.number}</Link></Td>
                  <Td>{dateFmt(r.challan_date)}</Td>
                  <Td>{r.supplier.name}</Td>
                  <Td className="text-xs">{r.process_nature}</Td>
                  <Td className="max-w-[240px] truncate text-xs" title={r.items}>{r.items}</Td>
                  <Td className="tabular text-right">{qty(r.quantity)}</Td>
                  <Td className="tabular text-right">{money(r.value)}</Td>
                  <Td className="text-xs">{r.po_number ?? "—"}{r.po_date && <span className="block text-muted">{dateFmt(r.po_date)}</span>}</Td>
                  <Td className="font-mono text-xs">{r.vehicle_no ?? "—"}</Td>
                  <Td className="font-mono text-xs">{r.work_order ? `${r.work_order.number} / ${r.op_seq}` : "—"}</Td>
                  <Td className="text-xs">{dateFmt(r.expected_return_date)}</Td>
                  <Td><Badge tone={r.status === "RECEIVED" ? "success" : r.overdue ? "danger" : "warning"} dot>{r.status === "RECEIVED" ? "Received" : r.overdue ? "Overdue" : "At vendor"}</Badge></Td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
