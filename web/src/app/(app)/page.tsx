"use client";

import { AlertTriangle, Boxes, CalendarDays, ClipboardList, FileText, IndianRupee, Plus, RefreshCw, ShoppingCart, TrendingUp, Truck } from "lucide-react";
import Link from "next/link";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, PageHeader, Skeleton, Stat, Td, Th, cx } from "@/components/ui";
import { MovementBadge } from "@/components/MovementBadge";
import { useAuth } from "@/lib/auth";
import { compactMoney, dateFmt, dateTime, isInbound, isOutbound, qty } from "@/lib/format";
import { useApi, useLocalState } from "@/lib/hooks";
import type { Movement } from "@/lib/types";

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
  movements_14d: { date: string; in: number; out: number }[];
  movements_days?: number;
  recent_movements: Movement[];
  pending_adjustments: number;
  pending_import_approvals: number;
  open_purchase_orders: number;
  purchase_orders_awaiting_approval: number;
  goods_pending_qc_qty: string;
  open_enquiries: number;
  orders_at_risk?: number;
  orders_at_risk_list?: { id: number; number: string; customer: string; forecast_date: string | null; target_date: string | null; target: "committed" | "required" }[];
  open_sales_orders?: number;
  pending_commit_approvals?: number;
  open_requisitions?: number;
}
interface Alerts {
  out: AlertRow[]; below_min: AlertRow[]; out_count: number; below_min_count: number;
}
interface AlertRow { id: number; item_code: string; name: string; uom: string; location: string | null; available: string; restock_qty: string | null }
interface WoBrief { id: number; number: string; status: string; qty_completed: string; current_step: { mode: string; status: string } | null }
interface ChallanRow { id: number; number: string; supplier: { name: string }; expected_return_date: string | null; overdue: boolean }

export default function DashboardPage() {
  const { user, can } = useAuth();
  const [days, setDays] = useLocalState<number>("lm_dash_days", 14);
  const { data: raw, error, loading, reload } = useApi<Summary>(can("dashboard.view") ? `/api/dashboard/summary?days=${days}` : null, { pollMs: 15000 });
  const alerts = useApi<Alerts>(can("items.view") ? "/api/items/restock-alerts?limit=5" : null, { pollMs: 60000 });
  const wos = useApi<WoBrief[]>(can("production.view") ? "/api/work-orders" : null, { pollMs: 60000 });
  const atVendor = useApi<ChallanRow[]>(can("production.view") ? "/api/osp/challans?status=SENT" : null, { pollMs: 60000 });
  const toReview = useApi<{ id: number }[]>(can("stock.view") ? "/api/documents?status=EXTRACTED" : null, { pollMs: 60000 });

  if (!can("dashboard.view")) return <EmptyState title="No dashboard access" description="Use the sidebar to open the modules assigned to your role." />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const d = raw && {
    ...raw,
    orders_at_risk: raw.orders_at_risk ?? 0,
    orders_at_risk_list: raw.orders_at_risk_list ?? [],
    open_sales_orders: raw.open_sales_orders ?? 0,
    pending_commit_approvals: raw.pending_commit_approvals ?? 0,
  };

  return (
    <>
      <PageHeader
        title="Executive dashboard"
        description={d ? <>Good {greeting()}, {user?.full_name.split(" ")[0]} · live from the stock ledger, updated {dateTime(d.generated_at)}</> : "Loading live figures…"}
        actions={<>
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface pl-3.5 pr-2 text-[13px] font-semibold text-ink shadow-card hover:bg-surface-2 focus-within:ring-2 focus-within:ring-primary/20">
            <CalendarDays className="size-4" aria-hidden />
            <span className="sr-only">Chart period</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="cursor-pointer bg-transparent pr-1 font-semibold outline-none">
              {[7, 14, 30, 90].map((n) => <option key={n} value={n}>Last {n} days</option>)}
            </select>
            {loading && raw && <RefreshCw className="size-3.5 animate-spin text-muted" aria-label="Updating" />}
          </label>
          <Button variant="secondary" icon={<RefreshCw className="size-4" />} onClick={reload}>Refresh</Button>
          {can("stock.receive", "stock.issue") && <Link href="/scan"><Button icon={<Plus className="size-4" />}>New transaction</Button></Link>}
        </>}
      />
      {!d ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[168px] rounded-2xl" />)}</div>
      ) : (
        <div className="space-y-5">
          <section aria-label="Key figures" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Inventory value" value={compactMoney(d.inventory_valuation)} tone="primary" icon={<IndianRupee className="size-5" />}
                  bar={Number(d.stock_on_hand_qty) ? Number(d.available_qty) / Number(d.stock_on_hand_qty) : 0}
                  sub={<>{qty(d.available_qty)} of {qty(d.stock_on_hand_qty)} units free to use</>} />
            <Stat label="Items in stores" value={d.total_items.toLocaleString("en-IN")} tone="accent" icon={<Boxes className="size-5" />} href="/inventory"
                  bar={d.total_items ? (d.total_items - d.out_of_stock_items) / d.total_items : 0}
                  sub={<><span className="font-bold text-danger">{d.out_of_stock_items} out of stock</span> · {d.low_stock_items} low</>} />
            <Stat label="Open purchase orders" value={d.open_purchase_orders} tone="teal" icon={<ShoppingCart className="size-5" />} href="/purchase"
                  bar={d.open_purchase_orders ? (d.open_purchase_orders - d.purchase_orders_awaiting_approval) / d.open_purchase_orders : 0}
                  sub={<>{d.purchase_orders_awaiting_approval} awaiting approval · {raw?.open_requisitions ?? 0} requisitions open</>} />
            <Stat label="Open sales orders" value={d.open_sales_orders} tone="violet" icon={<TrendingUp className="size-5" />} href="/sales"
                  bar={d.open_sales_orders ? (d.open_sales_orders - d.orders_at_risk) / d.open_sales_orders : 0}
                  sub={d.orders_at_risk > 0 ? <span className="font-bold text-danger">{d.orders_at_risk} at risk of late delivery</span> : <>None at risk · {d.open_enquiries} open enquiries</>} />
          </section>

          {d.orders_at_risk_list.length > 0 && (
            <Card className="overflow-hidden border-danger/30">
              <CardHeader title={<span className="flex items-center gap-2 text-danger"><AlertTriangle className="size-4" /> Sales orders at risk</span>}
                subtitle="Recalculated forecast is later than the committed or required date" actions={<Link href="/sales" className="text-[13px] font-semibold text-primary hover:underline">Open sales</Link>} />
              <ul className="divide-y divide-line text-sm">
                {d.orders_at_risk_list.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <span><span className="font-mono text-xs text-primary">{o.number}</span> · {o.customer}</span>
                    <span className="tabular text-xs text-muted">forecast <b className="text-danger">{dateFmt(o.forecast_date)}</b> vs {o.target} {dateFmt(o.target_date)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="grid gap-5 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title="Stock movements" subtitle={`Receipts and issues posted per day · last ${d.movements_days ?? d.movements_14d.length} days`}
                actions={<div className="flex gap-4 text-xs text-ink-2">
                  <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-primary" /> Receipts</span>
                  <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-accent" /> Issues</span>
                </div>} />
              <MovementChart data={d.movements_14d} />
            </Card>
            <RestockCard alerts={alerts.data} />
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <Card className="overflow-hidden xl:col-span-2">
              <CardHeader title="Recent stock movements" actions={<Link href="/stock/ledger" className="text-[13px] font-semibold text-primary hover:underline">Stock ledger</Link>} />
              {d.recent_movements.length === 0 ? (
                <EmptyState title="No transactions yet" description="Scan an item to record the first receipt." action={<Link href="/scan"><Button>Open scanner</Button></Link>} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-[13px]">
                    <thead><tr><Th className="pl-5">Item</Th><Th>Type</Th><Th className="text-right">Qty</Th><Th>Reference</Th><Th className="pr-5">By</Th></tr></thead>
                    <tbody>
                      {d.recent_movements.map((m) => (
                        <tr key={m.id} className="hover:bg-surface-2">
                          <Td className="py-2.5 pl-5">
                            <Link href={`/locator?item=${m.item_id}`} className="block font-semibold text-ink hover:text-primary">{m.item_name}</Link>
                            <span className="font-mono text-[11px] text-muted">{m.item_code}</span>
                          </Td>
                          <Td><MovementBadge type={m.movement_type} /></Td>
                          <Td className={cx("tabular text-right font-bold", isInbound(m.movement_type) ? "text-success" : isOutbound(m.movement_type) ? "text-danger" : "text-ink")}>
                            {isInbound(m.movement_type) ? "+" : isOutbound(m.movement_type) ? "−" : ""}{qty(m.quantity)}
                          </Td>
                          <Td className="text-xs">{m.ref_doc_no ?? [m.from_location, m.to_location].filter(Boolean).join(" → ")}</Td>
                          <Td className="pr-5 text-xs">{m.created_by}<span className="block text-muted">{dateTime(m.created_at)}</span></Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <div className="space-y-5">
              {can("production.view") && <ProductionCard wos={wos.data} challans={atVendor.data} />}
              <ApprovalsCard adjustments={d.pending_adjustments} pos={d.purchase_orders_awaiting_approval} imports={d.pending_import_approvals}
                             commits={d.pending_commit_approvals} docs={toReview.data?.length ?? 0} canDocs={can("stock.view")} />
            </div>
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
  const peak = Math.max(1, ...data.map((x) => Math.max(x.in, x.out)));
  const top = Math.max(4, Math.ceil(peak / 4) * 4);
  const ticks = [top, (top * 3) / 4, top / 2, top / 4, 0];
  const total = data.reduce((a, x) => a + x.in + x.out, 0);
  const every = data.length > 31 ? 15 : data.length > 14 ? 5 : 1;  // keep date labels legible on long periods
  return (
    <div className="px-5 pb-5 pt-4">
      <div className="flex gap-3">
        <div className="flex h-56 flex-col justify-between pb-6 text-[11px] text-muted" aria-hidden>{ticks.map((t) => <span key={t} className="tabular">{t}</span>)}</div>
        <div className="min-w-0 flex-1">
          <div className={cx("relative flex items-end justify-between border-b border-line", data.length > 31 ? "gap-px" : data.length > 14 ? "gap-0.5" : "gap-1.5")} style={{ height: 200 }}
               role="img" aria-label={`Bar chart: ${total} stock movements in the last ${data.length} days, receipts and issues per day`}>
            {ticks.slice(0, 4).map((t, i) => <span key={t} className="pointer-events-none absolute inset-x-0 border-t border-surface-3" style={{ top: `${i * 25}%` }} aria-hidden />)}
            {data.map((x) => (
              <div key={x.date} className={cx("group relative flex h-full flex-1 items-end justify-center", data.length > 31 ? "gap-0" : "gap-[3px]")}>
                <div className="w-[42%] max-w-3.5 rounded-t-sm bg-primary" style={{ height: `${(x.in / top) * 100}%`, minHeight: x.in ? 3 : 0 }} />
                <div className="w-[42%] max-w-3.5 rounded-t-sm bg-accent" style={{ height: `${(x.out / top) * 100}%`, minHeight: x.out ? 3 : 0 }} />
                <span className="pointer-events-none absolute -top-7 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-navy px-2 py-0.5 text-[11px] text-white group-hover:block">
                  {dateFmt(x.date)}: {x.in} in · {x.out} out
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between">
            {data.map((x, i) => (
              <span key={x.date} className="flex-1 text-center text-[11px] text-muted">
                {i % every === 0 || i === data.length - 1 ? new Date(`${x.date}T00:00:00`).toLocaleDateString("en-IN", data.length > 14 ? { day: "numeric", month: "short" } : { day: "numeric" }) : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function RestockCard({ alerts }: { alerts: Alerts | undefined }) {
  const rows = alerts ? [...alerts.out.map((r) => ({ ...r, out: true })), ...alerts.below_min.map((r) => ({ ...r, out: false }))].slice(0, 5) : [];
  return (
    <Card className="flex flex-col">
      <CardHeader title="Restock alerts" actions={<Link href="/inventory?status=MIN" className="text-[13px] font-semibold text-primary hover:underline">View all</Link>} />
      <div className="flex flex-1 flex-col gap-3 px-5 pb-3 pt-4">
        <div className="grid grid-cols-2 gap-2">
          <Link href="/inventory?status=OUT" className="rounded-xl bg-danger-soft px-3 py-2.5 text-xs font-semibold text-danger">
            <span className="tabular block text-xl font-extrabold">{alerts?.out_count ?? "—"}</span>Out of stock
          </Link>
          <Link href="/inventory?status=MIN" className="rounded-xl bg-warning-soft px-3 py-2.5 text-xs font-semibold text-warning">
            <span className="tabular block text-xl font-extrabold">{alerts?.below_min_count ?? "—"}</span>At or below minimum
          </Link>
        </div>
        {alerts && rows.length === 0 ? <p className="py-6 text-center text-sm text-muted">Nothing to restock.</p> : (
          <ul className="divide-y divide-surface-3">
            {rows.map((r) => (
              <li key={r.id}>
                <Link href={`/locator?item=${r.id}`} className="flex items-center gap-3 py-2.5">
                  <span className={cx("size-2.5 shrink-0 rounded-full", r.out ? "bg-danger" : "bg-warning")} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-ink">{r.name}</span>
                    <span className="font-mono text-[11px] text-muted">{r.item_code}{r.location ? ` · ${r.location}` : ""}</span>
                  </span>
                  <span className="text-right">
                    <span className="tabular block text-[13px] font-bold text-ink">{qty(r.available)} {r.uom}</span>
                    {r.restock_qty && <span className="text-[11px] text-muted">order {qty(r.restock_qty)}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function ProductionCard({ wos, challans }: { wos: WoBrief[] | undefined; challans: ChallanRow[] | undefined }) {
  const open = (wos ?? []).filter((w) => w.status !== "CANCELLED");
  const groups = [
    { label: "completed", n: open.filter((w) => w.status === "COMPLETED").length, c: "bg-success" },
    { label: "partly completed", n: open.filter((w) => w.status !== "COMPLETED" && Number(w.qty_completed) > 0).length, c: "bg-primary" },
    { label: "at job-work vendor", n: open.filter((w) => w.status !== "COMPLETED" && Number(w.qty_completed) === 0 && w.current_step?.status === "AT_VENDOR").length, c: "bg-accent" },
  ];
  const rest = open.length - groups.reduce((a, g) => a + g.n, 0);
  groups.push({ label: "in progress or not started", n: rest, c: "bg-muted" });
  const next = challans?.[0];
  return (
    <Card>
      <CardHeader title="Production" actions={<Link href="/production" className="text-[13px] font-semibold text-primary hover:underline">{open.length} work orders</Link>} />
      <div className="space-y-4 px-5 py-4">
        {open.length > 0 && (
          <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
            {groups.filter((g) => g.n).map((g) => <span key={g.label} className={g.c} style={{ flex: `${g.n} 1 0` }} />)}
          </div>
        )}
        <ul className="grid grid-cols-2 gap-2 text-xs text-ink-2">
          {groups.map((g) => <li key={g.label} className="flex items-center gap-2"><span className={cx("size-2.5 rounded-full", g.c)} aria-hidden /><b className="tabular">{g.n}</b> {g.label}</li>)}
        </ul>
        {next && (
          <Link href={`/production/challans/${next.id}`} className="flex items-center gap-3 rounded-xl bg-accent-soft px-3.5 py-3 text-accent-ink">
            <Truck className="size-5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 text-xs">
              <span className="block text-[13px] font-bold">Challan {next.number}</span>
              At {next.supplier.name}{next.expected_return_date ? ` · back by ${dateFmt(next.expected_return_date)}` : ""}
            </span>
            {next.overdue && <Badge tone="danger">Overdue</Badge>}
            {challans && challans.length > 1 && <span className="text-xs font-bold">+{challans.length - 1}</span>}
          </Link>
        )}
      </div>
    </Card>
  );
}

function ApprovalsCard({ adjustments, pos, imports, commits, docs, canDocs }: {
  adjustments: number; pos: number; imports: number; commits: number; docs: number; canDocs: boolean;
}) {
  const rows = [
    { label: "Stock adjustments", sub: "Cycle counts and corrections", n: adjustments, href: "/stock/adjustments", icon: ClipboardList, tone: "bg-warning-soft text-warning" },
    { label: "Purchase orders", sub: "Drafts waiting for a checker", n: pos, href: "/purchase", icon: ShoppingCart, tone: "bg-teal-soft text-teal" },
    ...(canDocs ? [{ label: "Scanned documents", sub: "Invoices and challans to review", n: docs, href: "/documents", icon: FileText, tone: "bg-primary-soft text-primary" }] : []),
    { label: "Imports and delivery dates", sub: "Inventory imports · committed dates", n: imports + commits, href: "/inventory/import", icon: CalendarDays, tone: "bg-violet-soft text-violet" },
  ];
  return (
    <Card>
      <CardHeader title="Waiting for approval" />
      <ul className="px-5 pb-2">
        {rows.map((r) => (
          <li key={r.label} className="border-t border-surface-3 first:border-0">
            <Link href={r.href} className="flex items-center gap-3 py-3">
              <span className={cx("grid size-9 shrink-0 place-items-center rounded-xl", r.tone)}><r.icon className="size-[17px]" aria-hidden /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-ink">{r.label}</span>
                <span className="block truncate text-xs text-muted">{r.sub}</span>
              </span>
              <span className={cx("tabular text-sm font-extrabold", r.n ? "text-ink" : "text-muted")}>{r.n}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
