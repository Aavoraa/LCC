"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Card, ErrorState, PageHeader, Select, Spinner, cx } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { qty } from "@/lib/format";
import { useApi, useLocalState } from "@/lib/hooks";

interface Overview {
  organization: { code: string; name: string };
  picks: { open: number; confirmed_30d: number };
  cycle_counts: { open: number; overdue: number; late_30d: number };
  pending: { adjustments: number; imports: number };
  receipts: { expected_lines: number; overdue: number; due_7d: number; received_30d: number };
  inspection: { lines: number; qty: string };
  shipments: { next_30d: number; overdue: number; by_customer: { name: string; lines: number }[] };
  osp: { at_vendor: number; overdue: number };
  restock: { out: number; below_min: number };
}

type Group = "Inventory" | "Receipts" | "Outside processing";
const TASKS: Record<Group, { section: string; items: { label: string; href: string; perm?: string }[] }[]> = {
  Inventory: [
    { section: "Inventory", items: [
      { label: "Manage Item Quantities", href: "/locator" },
      { label: "Create Miscellaneous Transaction", href: "/scan", perm: "stock.receive" },
      { label: "Create Subinventory Transfer", href: "/scan", perm: "stock.transfer" },
      { label: "Manage Reservations and Picks", href: "/tracker", perm: "production.view" },
      { label: "Manage Pending Transactions", href: "/stock/adjustments" },
      { label: "Review Completed Transactions", href: "/stock/ledger" },
      { label: "Manage Cycle Counts", href: "/inventory/cycle-counts" },
      { label: "Review Item Supply and Demand", href: "/locator" },
      { label: "Review Replenishment Requests", href: "/inventory?status=MIN" },
      { label: "Print QR Labels", href: "/qr", perm: "qr.generate" },
      { label: "Voice Stock Report", href: "/reports/voice" },
    ] },
  ],
  Receipts: [
    { section: "Expected Shipments", items: [
      { label: "Receive Expected Shipments", href: "/purchase", perm: "purchase.view" },
    ] },
    { section: "Receipts", items: [
      { label: "Inspect Receipts", href: "/qc" },
      { label: "Put Away Receipts", href: "/qc" },
      { label: "Correct Receipts", href: "/stock/adjustments" },
      { label: "Quality Inspection Results", href: "/qc" },
    ] },
    { section: "Unordered Receipts", items: [{ label: "Receive Without Purchase Order", href: "/scan", perm: "stock.receive" }] },
    { section: "Returns", items: [{ label: "Return to Supplier", href: "/scan", perm: "stock.issue" }] },
  ],
  "Outside processing": [
    { section: "Production", items: [
      { label: "Manage Work Orders", href: "/production", perm: "production.view" },
      { label: "OSP Delivery Challans", href: "/production/challans", perm: "production.view" },
      { label: "Production Details Report", href: "/reports/production", perm: "production.view" },
    ] },
  ],
};

export default function InventoryOverviewPage() {
  const { can } = useAuth();
  const ov = useApi<Overview>("/api/inventory/overview", { pollMs: 60000 });
  const [group, setGroup] = useLocalState<Group>("lm_inv_tasks", "Inventory");

  if (ov.error) return <ErrorState error={ov.error} onRetry={ov.reload} />;
  const d = ov.data;

  return (
    <>
      <PageHeader title="Inventory management" description={d ? <>Inventory Organization <span className="font-semibold text-ink">{d.organization.code}</span> · {d.organization.name}</> : undefined} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        {!d ? <Spinner /> : (
          <div className="grid content-start gap-4 sm:grid-cols-2 2xl:grid-cols-3">
            <Tile title="Picks" sub="Stock reserved for orders, not yet issued" href="/tracker"
              main={d.picks.open} mainLabel="open" side={[["Confirmed (issued) last 30 days", d.picks.confirmed_30d]]} />
            <Tile title="Late cycle counts" sub="Open counts past their due date" href="/inventory/cycle-counts"
              main={d.cycle_counts.overdue} mainLabel="items" tone={d.cycle_counts.overdue ? "danger" : undefined}
              side={[["Over 30 days late", d.cycle_counts.late_30d], ["Open counts", d.cycle_counts.open]]} />
            <Tile title="Pending transactions" sub="Waiting for a checker's approval" href="/stock/adjustments"
              main={d.pending.adjustments} mainLabel="adjustments" tone={d.pending.adjustments ? "warning" : undefined}
              side={[["Imports to approve", d.pending.imports]]} />
            <Tile title="Receipt lines" sub="Approved PO lines still to receive" href="/purchase"
              main={d.receipts.expected_lines} mainLabel="expected" side={[["Overdue", d.receipts.overdue], ["Due in 7 days", d.receipts.due_7d], ["Received last 30 days", d.receipts.received_30d]]} />
            <Tile title="Inspected receipts" sub="Goods on QC hold awaiting inspection" href="/qc"
              main={d.inspection.lines} mainLabel="lines" tone={d.inspection.lines ? "warning" : undefined} side={[["Quantity on hold", qty(d.inspection.qty)]]} />
            <Tile title="Shipment lines for next 30 days" sub="Confirmed sales-order lines still to issue" href="/tracker"
              main={d.shipments.next_30d} mainLabel="lines" side={[["Overdue", d.shipments.overdue]]}>
              {d.shipments.by_customer.length > 0 && (
                <ul className="mt-3 space-y-1 border-t border-line pt-2 text-xs">
                  {d.shipments.by_customer.map((c) => (
                    <li key={c.name} className="flex justify-between gap-2"><span className="truncate text-ink-2">{c.name}</span><span className="tabular font-medium">{c.lines}</span></li>
                  ))}
                </ul>
              )}
            </Tile>
            <Tile title="Outside processing" sub="Job-work challans with the vendor" href="/production/challans"
              main={d.osp.at_vendor} mainLabel="at vendor" tone={d.osp.overdue ? "danger" : undefined} side={[["Overdue returns", d.osp.overdue]]} />
            <Tile title="Replenishment" sub="Items to restock" href="/inventory?status=MIN"
              main={d.restock.below_min} mainLabel="below minimum" tone={d.restock.below_min ? "warning" : undefined} side={[["Out of stock", d.restock.out]]} />
          </div>
        )}

        <Card className="h-fit p-4">
          <label className="flex items-center gap-2 text-sm font-semibold">
            Show Tasks
            <Select value={group} onChange={(e) => setGroup(e.target.value as Group)} className="h-8 w-auto flex-1">
              {(Object.keys(TASKS) as Group[]).map((g) => <option key={g} value={g}>{g}</option>)}
            </Select>
          </label>
          <div className="mt-3 space-y-4">
            {TASKS[group].map((s) => {
              const items = s.items.filter((t) => !t.perm || can(t.perm));
              if (!items.length) return null;
              return (
                <div key={s.section}>
                  <p className="mb-1 text-[13px] font-semibold text-ink">{s.section}</p>
                  <ul className="space-y-0.5">
                    {items.map((t) => (
                      <li key={t.label}>
                        <Link href={t.href} className="group flex items-center gap-1 rounded px-1.5 py-1 text-[13px] text-primary hover:bg-surface-2">
                          <ChevronRight className="size-3.5 text-muted group-hover:text-primary" />{t.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </>
  );
}

function Tile({ title, sub, href, main, mainLabel, side, tone, children }: {
  title: string; sub: string; href: string; main: number; mainLabel: string; side: [string, React.ReactNode][];
  tone?: "danger" | "warning"; children?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col p-4">
      <Link href={href} className="text-sm font-semibold text-ink hover:text-primary">{title}</Link>
      <p className="text-xs text-muted">{sub}</p>
      <p className={cx("tabular mt-3 text-4xl font-semibold", tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-ink")}>
        {main} <span className="text-sm font-normal text-muted">{mainLabel}</span>
      </p>
      <dl className="mt-2 space-y-0.5 text-xs">
        {side.map(([k, v]) => <div key={k} className="flex justify-between gap-2"><dt className="text-muted">{k}</dt><dd className="tabular font-medium text-ink-2">{v}</dd></div>)}
      </dl>
      {children}
    </Card>
  );
}
