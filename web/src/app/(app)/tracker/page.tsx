"use client";

import { ArrowRight, Check, ChevronLeft, CircleDashed, Clock, Hourglass, MinusCircle, Route } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, cx } from "@/components/ui";
import { dateFmt, qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";

type StageStatus = "done" | "current" | "waiting" | "todo" | "skipped";
interface Action { label: string; href: string; who: string; stage?: string }
interface Stage { key: string; title: string; status: StageStatus; summary?: string; checks?: { label: string; done: boolean }[]; action?: Action | null }
interface SoInfo {
  id: number; number: string; status: string; customer: string; customer_po_ref: string | null;
  items: { item_code: string; name: string; quantity: string; uom: string }[];
  required_date: string | null; committed_date: string | null; forecast_date: string | null; at_risk: boolean;
}
interface Tracker { so: SoInfo; kind: "MACHINE" | "SPARES"; stages: Stage[]; next: Action | null; progress: number }

const HELP: Record<string, string> = {
  sell: "Enquiry → quote → customer PO → confirm the order and approve the delivery date.",
  plan: "Planning & Design makes the parts list (WIP/PAD) from the machine's standard SOP and sends it to Stores.",
  parts: "Stores checks every part. Missing bought parts are purchased; missing processed parts are made on work orders.",
  assemble: "Parts are issued to assembly and the machine is built on its assembly work order.",
  deliver: "The finished machine is reserved for this order and dispatched to the customer.",
};

export default function TrackerPage() {
  return <Suspense><TrackerInner /></Suspense>;
}

function TrackerInner() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const order = params.get("order");
  const open = (id: number | null) => router.replace(id ? `${pathname}?order=${id}` : pathname, { scroll: false });
  return order ? <OrderView id={Number(order)} onBack={() => open(null)} /> : <OrderList onOpen={open} />;
}

function StageDots({ stages }: { stages: { title: string; status: StageStatus }[] }) {
  return (
    <div className="flex items-center gap-1">
      {stages.map((s, i) => (
        <span key={s.title} className="flex items-center gap-1" title={`${s.title}: ${s.status}`}>
          <span className={cx("size-2.5 rounded-full",
            s.status === "done" ? "bg-success" : s.status === "current" ? "bg-primary" : s.status === "waiting" ? "bg-warning" : s.status === "skipped" ? "bg-surface-3" : "border border-line-strong")} />
          {i < stages.length - 1 && <span className="h-px w-3 bg-line-strong" />}
        </span>
      ))}
    </div>
  );
}

function OrderList({ onOpen }: { onOpen: (id: number) => void }) {
  const list = useApi<(Omit<Tracker, "stages"> & { stages: { key: string; title: string; status: StageStatus }[] })[]>("/api/tracker", { pollMs: 30000 });
  return (
    <>
      <PageHeader title="Order tracker" description="Every sales order in five simple stages — Sell, Plan, Get parts, Assemble, Deliver — with the one thing to do next." />
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <Spinner /> : list.data.length === 0 ? (
        <Card><EmptyState icon={<Route className="size-5" />} title="No open sales orders" description="Orders appear here as soon as they are created on the Sales page." /></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.data.map((t) => (
            <button key={t.so.id} onClick={() => onOpen(t.so.id)}
              className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 text-left shadow-card transition hover:border-primary/40 hover:shadow-pop">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-xs font-semibold text-primary">{t.so.number}</p>
                  <p className="truncate text-sm font-semibold text-ink">{t.so.customer}</p>
                  <p className="truncate text-xs text-muted">{t.so.items.map((i) => `${i.name} × ${qty(i.quantity)}`).join(", ")}</p>
                </div>
                <span className="tabular text-2xl font-semibold text-ink">{t.progress}%</span>
              </div>
              <StageDots stages={t.stages} />
              {t.next ? (
                <p className="flex items-start gap-1.5 rounded-md bg-primary-soft/50 px-2.5 py-2 text-xs text-ink-2">
                  <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-primary" />
                  <span><b className="text-ink">Next:</b> {t.next.label} <span className="text-muted">— {t.next.who}</span></span>
                </p>
              ) : <p className="text-xs text-success">Nothing pending</p>}
              {t.so.at_risk && <Badge tone="danger">At risk of late delivery</Badge>}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function OrderView({ id, onBack }: { id: number; onBack: () => void }) {
  const t = useApi<Tracker>(`/api/tracker/${id}`, { pollMs: 15000 });
  if (t.error) return <ErrorState error={t.error} onRetry={t.reload} />;
  const d = t.data;
  if (!d) return <Spinner />;
  const due = d.so.committed_date ?? d.so.required_date;
  return (
    <>
      <button onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><ChevronLeft className="size-4" />All orders</button>
      <PageHeader title={`${d.so.number} — ${d.so.customer}`}
        description={`${d.so.items.map((i) => `${i.name} × ${qty(i.quantity)} ${i.uom}`).join(", ")}${d.so.customer_po_ref ? ` · customer PO ${d.so.customer_po_ref}` : ""}`} />

      <Card className="mb-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-[200px] flex-1">
            <div className="flex items-baseline gap-2">
              <span className="tabular text-3xl font-semibold">{d.progress}%</span>
              <span className="text-sm text-muted">complete</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-success transition-all" style={{ width: `${d.progress}%` }} /></div>
            <p className="mt-2 text-xs text-muted">
              {due ? `Deliver by ${dateFmt(due)}` : "No delivery date yet"}{d.so.forecast_date && ` · forecast ${dateFmt(d.so.forecast_date)}`}
              {d.so.at_risk && <span className="text-danger"> · at risk</span>}
            </p>
          </div>
          {d.next ? (
            <div className="w-full max-w-md rounded-xl border border-primary/40 bg-primary-soft/40 p-4 sm:w-auto">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">Next action · {d.next.stage}</p>
              <p className="mt-1 text-base font-semibold text-ink">{d.next.label}</p>
              <p className="text-xs text-muted">Done by: {d.next.who}</p>
              <Link href={d.next.href}><Button className="mt-3 w-full" icon={<ArrowRight className="size-4" />}>Go do it</Button></Link>
            </div>
          ) : (
            <div className="rounded-xl border border-success/40 bg-success-soft/40 p-4 text-sm font-medium text-success">
              <Check className="mr-1 inline size-4" />{d.so.status === "COMPLETED" ? "Delivered — order complete" : "Nothing to do right now"}
            </div>
          )}
        </div>
      </Card>

      <ol className="relative space-y-3">
        {d.stages.map((s, i) => (
          <li key={s.key} className="flex gap-4">
            <div className="flex flex-col items-center">
              <StageIcon status={s.status} n={i + 1} />
              {i < d.stages.length - 1 && <span className={cx("mt-1 w-0.5 flex-1 rounded", s.status === "done" ? "bg-success" : "bg-line")} />}
            </div>
            <Card className={cx("mb-1 flex-1 p-4", s.status === "current" && "border-primary/50", s.status === "skipped" && "opacity-60")}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold">{s.title}</h3>
                <Badge tone={s.status === "done" ? "success" : s.status === "current" ? "primary" : s.status === "waiting" ? "warning" : "neutral"}>
                  {s.status === "todo" ? "not started" : s.status === "current" ? "in progress" : s.status}
                </Badge>
                {s.summary && <span className="text-xs text-muted">{s.summary}</span>}
              </div>
              <p className="mt-1 text-xs text-muted">{HELP[s.key]}</p>
              {s.checks && s.checks.length > 0 && (
                <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
                  {s.checks.map((c) => (
                    <li key={c.label} className="flex items-center gap-2 text-[13px]">
                      {c.done ? <Check className="size-4 text-success" /> : <CircleDashed className="size-4 text-muted" />}
                      <span className={c.done ? "text-ink" : "text-ink-2"}>{c.label}</span>
                    </li>
                  ))}
                </ul>
              )}
              {s.action && s.status !== "done" && (
                <Link href={s.action.href} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                  {s.action.label} <span className="text-xs font-normal text-muted">({s.action.who})</span><ArrowRight className="size-3.5" />
                </Link>
              )}
            </Card>
          </li>
        ))}
      </ol>
    </>
  );
}

function StageIcon({ status, n }: { status: StageStatus; n: number }) {
  const base = "flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold";
  if (status === "done") return <span className={cx(base, "bg-success text-white")}><Check className="size-4" /></span>;
  if (status === "current") return <span className={cx(base, "bg-primary text-white")}>{n}</span>;
  if (status === "waiting") return <span className={cx(base, "bg-warning text-white")}><Hourglass className="size-4" /></span>;
  if (status === "skipped") return <span className={cx(base, "bg-surface-3 text-muted")}><MinusCircle className="size-4" /></span>;
  return <span className={cx(base, "border border-line-strong text-muted")}>{n === 0 ? <Clock className="size-4" /> : n}</span>;
}
