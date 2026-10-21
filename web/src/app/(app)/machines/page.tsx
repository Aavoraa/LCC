"use client";

import { AlertTriangle, ChevronRight, Cpu } from "lucide-react";
import Link from "next/link";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Skeleton, cx } from "@/components/ui";
import { money } from "@/lib/format";
import { useApi } from "@/lib/hooks";

interface MachineRow {
  id: number;
  code: string;
  name: string;
  models: string | null;
  source: string | null;
  units_supported: number;
  spare_count: number;
  aligned_count: number;
  readiness_pct: number;
  counts: { OK: number; SHORT: number; OUT: number; NOT_IN_STORE: number; ON_DEMAND: number };
  critical_gaps: number;
  shortage_value: string;
  unpriced_shortages: number;
  stocked_lines: number;
}

export default function MachinesPage() {
  const { data, error, loading, reload } = useApi<MachineRow[]>("/api/machines", { pollMs: 30000 });
  const totals = (data ?? []).reduce(
    (a, m) => ({ spares: a.spares + m.spare_count, stocked: a.stocked + m.stocked_lines, ok: a.ok + m.counts.OK, gaps: a.gaps + m.critical_gaps,
                 value: a.value + Number(m.shortage_value ?? 0), unpriced: a.unpriced + m.unpriced_shortages }),
    { spares: 0, stocked: 0, ok: 0, gaps: 0, value: 0, unpriced: 0 },
  );

  return (
    <>
      <PageHeader
        title="Machines & SOP spares"
        description="Standard spare list for each machine, aligned with the stores item master. Readiness = spare lines with at least the SOP stock available."
      />
      {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : !data?.length ? (
        <EmptyState icon={<Cpu className="size-5" />} title="No machines loaded" description="Load the catalogue with: python -m app.machine_catalog --align --create-missing" />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {([["Machines", data.length, null], ["SOP spare lines", totals.spares, `${totals.spares - totals.stocked} order-on-demand`],
              ["Stocked lines at SOP level", `${totals.ok} / ${totals.stocked}`, `${totals.gaps} critical gaps`],
              ["Value to restore SOP stock", money(totals.value), totals.unpriced ? `+ ${totals.unpriced} lines with no cost yet` : "At weighted average cost"]] as const).map(([l, v, sub]) => (
              <Card key={l} className="p-4">
                <p className="text-[12.5px] font-medium text-muted">{l}</p>
                <p className="tabular mt-1 text-xl font-semibold">{v}</p>
                {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
              </Card>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.map((m) => {
              const tone = m.readiness_pct >= 90 ? "bg-success" : m.readiness_pct >= 50 ? "bg-warning" : "bg-danger";
              return (
                <Link key={m.id} href={`/machines/${m.id}`} className="group block focus-visible:rounded-lg">
                  <Card className="flex h-full flex-col p-4 transition-colors group-hover:border-line-strong">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-xs font-semibold text-primary">{m.code}</p>
                        <p className="mt-0.5 font-semibold leading-snug text-ink">{m.name}</p>
                        {m.models && <p className="text-xs text-muted">{m.models}</p>}
                      </div>
                      <ChevronRight className="mt-1 size-4 shrink-0 text-muted group-hover:text-ink" />
                    </div>
                    <div className="mt-4">
                      <div className="flex items-baseline justify-between text-xs">
                        <span className="text-muted">Stores readiness</span>
                        <span className="tabular text-sm font-semibold text-ink">{m.readiness_pct}%</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                        <div className={cx("h-full rounded-full", tone)} style={{ width: `${m.readiness_pct}%` }} />
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5 text-[11.5px]">
                      <Badge tone="success">{m.counts.OK} OK</Badge>
                      {m.counts.SHORT > 0 && <Badge tone="warning">{m.counts.SHORT} short</Badge>}
                      {m.counts.OUT > 0 && <Badge tone="danger">{m.counts.OUT} out</Badge>}
                      {m.counts.NOT_IN_STORE > 0 && <Badge>{m.counts.NOT_IN_STORE} not in stores</Badge>}
                      {m.counts.ON_DEMAND > 0 && <Badge>{m.counts.ON_DEMAND} on demand</Badge>}
                    </div>
                    <div className="mt-auto flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
                      <span>{m.spare_count} spares · {m.aligned_count} aligned · {m.units_supported} machine{m.units_supported === 1 ? "" : "s"}</span>
                      {m.critical_gaps > 0 && <span className="flex items-center gap-1 font-medium text-danger"><AlertTriangle className="size-3.5" /> {m.critical_gaps} critical</span>}
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-muted">Source: {data[0].source?.split(", pages")[0]}. Spares marked “derived” come from the machine’s described features and specifications rather than a named catalogue part.</p>
        </>
      )}
    </>
  );
}
