"use client";

import { AlertTriangle, Boxes, ClipboardCheck, PackageX, RefreshCw, ShoppingCart, Sparkles, Wallet } from "lucide-react";
import Link from "next/link";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, PageHeader, Skeleton, Stat, Td, Th, cx } from "@/components/ui";
import { MovementBadge } from "@/components/MovementBadge";
import { useAuth } from "@/lib/auth";
import { compactMoney, dateFmt, dateTime, isInbound, isOutbound, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { itemTypeLabel, type Movement } from "@/lib/types";

interface NotBuilt { value: null; available: false; note: string }
interface Summary {
  generated_at: string;
  inventory_valuation: string;
  total_items: number;
  low_stock_items: number;
  out_of_stock_items: number;
  stock_on_hand_qty: string;
  reserved_qty: string;
  qc_hold_qty: string;
  available_qty: string;
  valuation_by_type: Record<string, string>;
  movements_14d: { date: string; in: number; out: number }[];
  recent_movements: Movement[];
  pending_adjustments: number;
  pending_import_approvals: number;
  open_purchase_orders: number;
  purchase_orders_awaiting_approval: number;
  goods_pending_qc_qty: string;
  open_enquiries: number;
  // Phase 5 fields: optional so the page still renders against an older API.
  orders_at_risk?: number;
  orders_at_risk_list?: { id: number; number: string; customer: string; forecast_date: string | null; target_date: string | null; target: "committed" | "required" }[];
  open_sales_orders?: number;
  pending_commit_approvals?: number;
  open_requisitions?: number;
  work_in_progress: NotBuilt;
  outside_processing_outstanding: NotBuilt;
  accounts_receivable: NotBuilt;
  accounts_payable: NotBuilt;
  cash_and_bank: NotBuilt;
  invoice_extraction_pending: NotBuilt;
}

export default function DashboardPage() {
  const { user, can } = useAuth();
  const { data: raw, error, loading, reload } = useApi<Summary>(can("dashboard.view") ? "/api/dashboard/summary" : null, { pollMs: 15000 });

  const data = raw && {
    ...raw,
    orders_at_risk: raw.orders_at_risk ?? 0,
    orders_at_risk_list: raw.orders_at_risk_list ?? [],
    open_sales_orders: raw.open_sales_orders ?? raw.open_enquiries,
    pending_commit_approvals: raw.pending_commit_approvals ?? 0,
    open_requisitions: raw.open_requisitions ?? 0,
  };

  if (!can("dashboard.view")) return <EmptyState title="No dashboard access" description="Use the sidebar to open the modules assigned to your role." />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <>
      <PageHeader
        title={`Good ${greeting()}, ${user?.full_name.split(" ")[0]}`}
        description={data ? <>Live figures from the stock ledger · updated {dateTime(data.generated_at)}</> : "Loading live figures…"}
        actions={<Button variant="secondary" icon={<RefreshCw className="size-4" />} onClick={reload}>Refresh</Button>}
      />
      {loading || !data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[108px]" />)}</div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Inventory valuation" value={compactMoney(data.inventory_valuation)} sub="Weighted average cost" icon={<Wallet className="size-4" />} tone="primary" />
            <Stat label="Stock items" value={data.total_items} sub={`${qty(data.stock_on_hand_qty)} units on hand`} icon={<Boxes className="size-4" />} href="/inventory" />
            <Stat label="Low stock" value={data.low_stock_items} sub="At or below reorder level" icon={<AlertTriangle className="size-4" />} tone="warning" href="/inventory?status=LOW" />
            <Stat label="Out of stock" value={data.out_of_stock_items} sub="Zero on hand" icon={<PackageX className="size-4" />} tone="danger" href="/inventory?status=OUT" />
            <Stat label="Open sales orders" value={data.open_sales_orders} sub={<>{data.orders_at_risk > 0 ? <span className="text-danger">{data.orders_at_risk} at risk of late delivery</span> : "None at risk"} · {data.open_enquiries} open enquiries</>} icon={<Sparkles className="size-4" />} tone={data.orders_at_risk > 0 ? "danger" : "info"} href="/sales" />
            <Stat label="Open purchase orders" value={data.open_purchase_orders} sub={`${data.purchase_orders_awaiting_approval} awaiting approval · ${data.open_requisitions} requisitions open`} icon={<ShoppingCart className="size-4" />} href="/purchase" />
            <Stat label="Goods pending QC" value={qty(data.goods_pending_qc_qty)} sub="Units on quality hold" icon={<ClipboardCheck className="size-4" />} tone="warning" href="/qc" />
            <Stat label="Approvals pending" value={data.pending_adjustments + data.pending_import_approvals + data.pending_commit_approvals}
                  sub={`${data.pending_adjustments} adjustments · ${data.pending_import_approvals} imports · ${data.pending_commit_approvals} delivery dates`} icon={<ClipboardCheck className="size-4" />} tone="primary" href="/stock/adjustments" />
          </div>

          {data.orders_at_risk_list.length > 0 && (
            <Card className="overflow-hidden border-danger/30">
              <CardHeader title={<span className="flex items-center gap-2 text-danger"><AlertTriangle className="size-4" /> Sales orders at risk</span>}
                subtitle="Recalculated forecast is later than the committed or required date" actions={<Link href="/sales" className="text-xs font-medium text-primary hover:underline">Open sales</Link>} />
              <ul className="divide-y divide-line text-sm">
                {data.orders_at_risk_list.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                    <span><span className="font-mono text-xs text-primary">{o.number}</span> · {o.customer}</span>
                    <span className="tabular text-xs text-muted">forecast <b className="text-danger">{dateFmt(o.forecast_date)}</b> vs {o.target} {dateFmt(o.target_date)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="grid gap-5 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title="Stock movements — last 14 days" subtitle="Inbound vs outbound transactions per day" />
              <MovementChart data={data.movements_14d} />
            </Card>
            <Card>
              <CardHeader title="Available vs committed" subtitle="Units across all locations" />
              <AvailabilityBar s={data} />
              <div className="border-t border-line px-4 py-3">
                <p className="mb-2 text-xs font-medium text-muted">Valuation by stream</p>
                <TypeBars data={data.valuation_by_type} />
              </div>
            </Card>
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <Card className="overflow-hidden xl:col-span-2">
              <CardHeader title="Recent stock transactions" actions={<Link href="/stock/ledger" className="text-xs font-medium text-primary hover:underline">View ledger</Link>} />
              {data.recent_movements.length === 0 ? (
                <EmptyState title="No transactions yet" description="Scan an item to record the first receipt." action={<Link href="/scan"><Button>Open scanner</Button></Link>} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead><tr><Th>Txn</Th><Th>Item</Th><Th>Type</Th><Th className="text-right">Qty</Th><Th>Location</Th><Th>By</Th><Th>When</Th></tr></thead>
                    <tbody>
                      {data.recent_movements.map((m) => (
                        <tr key={m.id} className="h-10 hover:bg-surface-2">
                          <Td className="font-mono text-xs">{m.number}</Td>
                          <Td><Link href={`/inventory?item=${m.item_id}`} className="font-medium text-ink hover:text-primary">{m.item_code}</Link> <span className="text-muted">{m.item_name}</span></Td>
                          <Td><MovementBadge type={m.movement_type} /></Td>
                          <Td className={cx("tabular text-right font-medium", isInbound(m.movement_type) ? "text-success" : isOutbound(m.movement_type) ? "text-danger" : "")}>
                            {isInbound(m.movement_type) ? "+" : isOutbound(m.movement_type) ? "−" : ""}{qty(m.quantity)}
                          </Td>
                          <Td className="text-xs">{m.to_location ?? m.from_location}</Td>
                          <Td className="text-xs">{m.created_by}</Td>
                          <Td className="whitespace-nowrap text-xs text-muted">{dateTime(m.created_at)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card>
              <CardHeader title="Other modules" subtitle="Shown once their module is live — never estimated" />
              <ul className="divide-y divide-line text-sm">
                {([["Work in progress", data.work_in_progress], ["Outside processing outstanding", data.outside_processing_outstanding],
                   ["Accounts receivable", data.accounts_receivable], ["Accounts payable", data.accounts_payable],
                   ["Cash & bank", data.cash_and_bank], ["Invoices pending review", data.invoice_extraction_pending]] as [string, NotBuilt][]).map(([label]) => (
                  <li key={label} className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-ink-2">{label}</span>
                    <Badge>Not yet available</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

function MovementChart({ data }: { data: Summary["movements_14d"] }) {
  const max = Math.max(1, ...data.map((d) => Math.max(d.in, d.out)));
  const total = data.reduce((a, d) => a + d.in + d.out, 0);
  return (
    <div className="px-4 pb-4 pt-3">
      <div className="mb-3 flex gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-success" /> Inbound</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-primary" /> Outbound</span>
        <span className="ml-auto tabular">{total} transactions</span>
      </div>
      <div className="flex h-44 items-end gap-1.5" role="img" aria-label="Bar chart of daily inbound and outbound movements">
        {data.map((d) => (
          <div key={d.date} className="group relative flex h-full flex-1 flex-col justify-end">
            <div className="flex h-full items-end justify-center gap-[2px]">
              <div className="w-1/2 max-w-3 rounded-t-sm bg-success/85" style={{ height: `${(d.in / max) * 100}%`, minHeight: d.in ? 3 : 0 }} />
              <div className="w-1/2 max-w-3 rounded-t-sm bg-primary/85" style={{ height: `${(d.out / max) * 100}%`, minHeight: d.out ? 3 : 0 }} />
            </div>
            <span className="pointer-events-none absolute -top-7 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded bg-navy px-1.5 py-0.5 text-[11px] text-white group-hover:block">
              {d.in} in · {d.out} out
            </span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5 border-t border-line pt-1.5">
        {data.map((d, i) => (
          <span key={d.date} className="flex-1 text-center text-[10px] text-muted">{i % 2 === 0 ? new Date(`${d.date}T00:00:00`).getDate() : ""}</span>
        ))}
      </div>
    </div>
  );
}

function AvailabilityBar({ s }: { s: Summary }) {
  const total = Number(s.stock_on_hand_qty) || 1;
  const seg = [
    { label: "Available", v: Number(s.available_qty), c: "bg-success" },
    { label: "Reserved", v: Number(s.reserved_qty), c: "bg-primary" },
    { label: "QC hold", v: Number(s.qc_hold_qty), c: "bg-warning" },
  ];
  return (
    <div className="px-4 py-4">
      <div className="flex h-3 overflow-hidden rounded-full bg-surface-3">
        {seg.map((x) => <div key={x.label} className={x.c} style={{ width: `${(x.v / total) * 100}%` }} />)}
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2">
        {seg.map((x) => (
          <div key={x.label}>
            <dt className="flex items-center gap-1.5 text-xs text-muted"><span className={cx("size-2 rounded-full", x.c)} /> {x.label}</dt>
            <dd className="tabular mt-0.5 text-sm font-semibold">{qty(x.v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TypeBars({ data }: { data: Record<string, string> }) {
  const entries = Object.entries(data).sort((a, b) => Number(b[1]) - Number(a[1]));
  const max = Math.max(1, ...entries.map(([, v]) => Number(v)));
  if (!entries.length) return <p className="text-xs text-muted">No stock valued yet.</p>;
  return (
    <ul className="space-y-2">
      {entries.map(([k, v]) => (
        <li key={k}>
          <div className="flex justify-between text-xs"><span className="text-ink-2">{itemTypeLabel(k)}</span><span className="tabular font-medium">{compactMoney(v)}</span></div>
          <div className="mt-1 h-1.5 rounded-full bg-surface-3"><div className="h-full rounded-full bg-primary" style={{ width: `${(Number(v) / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}
