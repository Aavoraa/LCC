"use client";

import clsx from "clsx";
import { AlertTriangle, Inbox, Loader2, Lock, X } from "lucide-react";
import { forwardRef, useEffect } from "react";
import type { ApiError } from "@/lib/api";

export const cx = clsx;

// ------------------------------------------------------------------ buttons
type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover shadow-[0_8px_18px_-8px_rgb(31_79_196/0.6)]",
  secondary: "bg-surface text-ink border border-line hover:bg-surface-2 shadow-card",
  ghost: "text-ink-2 hover:bg-surface-3",
  danger: "bg-danger text-white hover:opacity-90",
  success: "bg-success text-white hover:opacity-90",
};

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: React.ReactNode }
>(function Button({ variant = "primary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-full font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap",
        size === "sm" && "h-8 px-2.5 text-[13px]",
        size === "md" && "h-10 px-5 text-sm",
        size === "lg" && "h-12 px-5 text-base",
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

// ------------------------------------------------------------------ form controls
// Width defaults to full unless the caller passes its own w-* class.
const width = (className?: string) => (/(^|\s)w-/.test(className ?? "") ? "" : "w-full");
const control =
  "rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-muted/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:bg-surface-3 disabled:text-muted";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, onWheel, ...p }, ref) {
  return (
    <input
      ref={ref}
      className={cx(control, width(className), "h-10", className)}
      // Scrolling the page over a focused number field must never change a quantity or cost.
      onWheel={(e) => {
        if (p.type === "number") e.currentTarget.blur();
        onWheel?.(e);
      }}
      {...p}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...p },
  ref,
) {
  return <textarea ref={ref} className={cx(control, width(className), "min-h-20 py-2", className)} {...p} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...p },
  ref,
) {
  return (
    <select ref={ref} className={cx(control, width(className), "h-10 pr-8", className)} {...p}>
      {children}
    </select>
  );
});

export function Field({ label, hint, error, required, children, className }: {
  label: React.ReactNode; hint?: string; error?: string; required?: boolean; children: React.ReactNode; className?: string;
}) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-[13px] font-medium text-ink-2">
        {label}
        {required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
      </span>
      {children}
      {error ? <span className="text-xs text-danger">{error}</span> : hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

// ------------------------------------------------------------------ surfaces
export function Card({ className, children, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("rounded-2xl border border-line/70 bg-surface shadow-card", className)} {...p}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, actions, className }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-start justify-between gap-3 px-5 pb-3 pt-5", className)}>
      <div className="min-w-0 border-l-[3px] border-brand pl-3">
        <h3 className="text-base font-extrabold leading-5 text-ink">{title}</h3>
        {subtitle && <p className="mt-1 text-xs text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="border-l-4 border-brand pl-3.5">
        <h1 className="text-[26px] font-extrabold leading-8 tracking-tight text-ink sm:text-3xl">{title}</h1>
        {description && <p className="mt-1.5 text-sm text-ink-2/80">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: {
  tabs: { id: T; label: React.ReactNode; count?: number }[]; value: T; onChange: (id: T) => void; className?: string;
}) {
  return (
    <div role="tablist" className={cx("flex gap-1 overflow-x-auto border-b border-line", className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            "-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            value === t.id ? "border-primary text-primary" : "border-transparent text-muted hover:text-ink",
          )}
        >
          {t.label}
          {t.count != null && <span className="tabular rounded bg-surface-3 px-1.5 text-[11px] text-ink-2">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ status
type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info" | "accent" | "violet" | "teal" | "brand";
const TONE: Record<Tone, string> = {
  neutral: "bg-surface-3 text-ink-2",
  primary: "bg-primary-soft text-primary",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  accent: "bg-accent-soft text-accent-ink",
  violet: "bg-violet-soft text-violet",
  teal: "bg-teal-soft text-teal",
  brand: "bg-brand-soft text-brand",
};
const BAR: Record<Tone, string> = {
  neutral: "bg-muted", primary: "bg-primary", success: "bg-success", warning: "bg-warning", danger: "bg-danger", info: "bg-info",
  accent: "bg-accent", violet: "bg-violet", teal: "bg-teal", brand: "bg-brand",
};
const STROKE: Record<Tone, string> = {
  neutral: "var(--muted)", primary: "var(--primary)", success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)", info: "var(--info)",
  accent: "var(--accent)", violet: "var(--violet)", teal: "var(--teal)", brand: "var(--brand)",
};

export function Badge({ tone = "neutral", children, className, dot }: { tone?: Tone; children: React.ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold leading-4", TONE[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function StockBadge({ status }: { status: "OK" | "LOW" | "OUT" }) {
  if (status === "OUT") return <Badge tone="danger" dot>Out of stock</Badge>;
  if (status === "LOW") return <Badge tone="warning" dot>Low</Badge>;
  return <Badge tone="success" dot>In stock</Badge>;
}

export function RiskBadge({ risk }: { risk: string | null | undefined }) {
  if (!risk) return null;
  return <Badge tone={risk === "LOW" ? "success" : risk === "MEDIUM" ? "warning" : "danger"} dot>{risk.toLowerCase()} risk</Badge>;
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded bg-surface-3", className)} />;
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 rounded-full bg-surface-3 p-3 text-muted">{icon ?? <Inbox className="size-5" />}</div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError | Error; onRetry?: () => void }) {
  const status = (error as ApiError).status;
  if (status === 403) {
    return <EmptyState icon={<Lock className="size-5" />} title="You don't have access" description={error.message} />;
  }
  return (
    <EmptyState
      icon={<AlertTriangle className="size-5 text-danger" />}
      title="Something went wrong"
      description={error.message}
      action={onRetry && <Button variant="secondary" onClick={onRetry}>Try again</Button>}
    />
  );
}

export function Alert({ tone = "danger", children, title }: { tone?: Tone; title?: string; children: React.ReactNode }) {
  return (
    <div role="alert" className={cx("rounded-md border px-3 py-2.5 text-sm", TONE[tone], "border-current/15")}>
      {title && <p className="font-medium">{title}</p>}
      <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>
    </div>
  );
}

// ------------------------------------------------------------------ overlays
export function Drawer({ open, onClose, title, children, width = "max-w-xl" }: {
  open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode; width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-navy/40" onClick={onClose} aria-hidden />
      <div className={cx("relative flex h-full w-full flex-col border-l border-line bg-surface shadow-pop", width)}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div className="min-w-0 text-sm font-semibold">{title}</div>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-3" aria-label="Close panel">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = "max-w-lg" }: {
  open: boolean; onClose: () => void; title: string; children: React.ReactNode; footer?: React.ReactNode; width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[10vh]" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-navy/50" onClick={onClose} aria-hidden />
      <div className={cx("relative w-full rounded-2xl border border-line bg-surface shadow-pop", width)}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-3" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-surface-2 px-1.5 py-px font-mono text-[11px] text-muted">{children}</kbd>;
}

// ------------------------------------------------------------------ data
/** Small area sparkline (no axes) for KPI tiles; values are drawn left to right, last point marked. */
export function Sparkline({ values, tone = "primary", className, label }: { values: number[]; tone?: Tone; className?: string; label?: string }) {
  if (values.length < 2) return null;
  const w = 120, h = 48, pad = 4;
  const max = Math.max(...values), min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, pad + (1 - (v - min) / span) * (h - pad * 2)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const id = `spark-${tone}`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cx("h-12 w-28 overflow-visible", className)} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {label && <title>{label}</title>}
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={STROKE[tone]} stopOpacity="0.28" />
          <stop offset="100%" stopColor={STROKE[tone]} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={STROKE[tone]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="3.5" fill={STROKE[tone]} stroke="var(--surface)" strokeWidth="1.5" />
    </svg>
  );
}

/** KPI tile in the Lakshmi style: icon circle and label, big value, sub-line, and either a sparkline or a progress bar (0–1). */
export function Stat({ label, value, sub, tone, icon, href, bar, spark, sparkLabel, tint }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; icon?: React.ReactNode; href?: string; bar?: number;
  spark?: number[]; sparkLabel?: string; tint?: boolean;
}) {
  const t = tone ?? "neutral";
  const body = (
    <Card className={cx("relative flex h-full flex-col gap-3 overflow-hidden p-5", tint && "bg-gradient-to-br from-brand-soft/70 to-surface",
                        href && "transition-shadow hover:shadow-pop")}>
      <div className="flex items-center gap-3">
        {icon && <span className={cx("grid size-12 shrink-0 place-items-center rounded-full", TONE[t])}>{icon}</span>}
        <span className="text-sm font-semibold text-ink-2">{label}</span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="tabular text-3xl font-extrabold tracking-tight text-ink">{value}</div>
          {sub && <div className="mt-1.5 text-xs text-muted">{sub}</div>}
        </div>
        {spark && <Sparkline values={spark} tone={t} label={sparkLabel} className="shrink-0" />}
      </div>
      {!spark && bar != null && (
        <div className={cx("h-1.5 rounded-full", TONE[t].split(" ")[0])} aria-hidden>
          <div className={cx("h-1.5 rounded-full", BAR[t])} style={{ width: `${Math.round(Math.min(1, Math.max(0, bar)) * 100)}%` }} />
        </div>
      )}
    </Card>
  );
  return href ? <a href={href} className="block focus-visible:rounded-2xl">{body}</a> : body;
}

export function Th({ children, className, ...p }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={cx("sticky top-0 z-10 border-b border-line bg-surface-2 px-3 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted", className)} {...p}>
      {children}
    </th>
  );
}

export function Td({ children, className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cx("border-b border-line px-3 text-ink-2", className)} {...p}>{children}</td>;
}
