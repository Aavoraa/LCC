"use client";

import { Construction } from "lucide-react";
import { useParams } from "next/navigation";
import { Badge, Card, PageHeader } from "@/components/ui";

const MODULES: Record<string, { title: string; phase: string; scope: string[] }> = {
  production: {
    title: "Production & Planning", phase: "Phase 4",
    scope: ["Configurable process-routing master (Process 1–4, in-house / outsourced per operation)", "PAD / WIP documents and BOMs",
      "Outside-processing dispatch and return tracking", "Inter-operation and final QC", "Work-centre capacity for the delivery estimator"],
  },
  accounts: {
    title: "Accounts & Finance", phase: "Phase 6",
    scope: ["Chart of accounts, journals and vouchers", "Sales and purchase invoices, receipts and payments",
      "Inventory-to-GL posting rules with unique source references", "Period locking, reversal entries, trial balance, P&L, balance sheet", "Configurable GST — subject to review by the company's accountant"],
  },
  "invoice-scanner": {
    title: "Invoice Scanner & AI Extraction", phase: "Phase 6",
    scope: ["Upload / camera capture of PDF, JPG, PNG documents to private storage", "Claude Vision extraction behind a provider interface (server-side API key)",
      "Split-screen review with confidence and uncertain-field highlighting", "Arithmetic, tax, PO/GRN and duplicate-invoice validation", "Post to accounts only after approval"],
  },
};

export default function PlannedModule() {
  const { module } = useParams<{ module: string }>();
  const m = MODULES[module] ?? { title: module, phase: "Later phase", scope: [] };
  return (
    <>
      <PageHeader title={m.title} description="This module is not implemented yet. No placeholder data is shown." />
      <Card className="max-w-2xl p-6">
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-warning-soft p-2 text-warning"><Construction className="size-5" /></div>
          <div><p className="font-medium">Planned for delivery</p><Badge tone="warning">{m.phase}</Badge></div>
        </div>
        {m.scope.length > 0 && (
          <ul className="mt-5 list-disc space-y-1.5 pl-5 text-sm text-ink-2">{m.scope.map((s) => <li key={s}>{s}</li>)}</ul>
        )}
      </Card>
    </>
  );
}
