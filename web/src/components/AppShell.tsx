"use client";

import {
  Bell, ChevronDown, ChevronsLeft, ChevronsRight, CircleHelp, LayoutGrid, ListChecks, LogOut, MapPin, Menu, Moon, Plus, ScanLine, Search, Sun, X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi, useLocalState } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { NAV, QUICK_CREATE, type NavItem } from "./nav";
import { CommandPalette } from "./CommandPalette";
import { Badge, Kbd, Modal, Spinner, cx } from "./ui";

interface Notice { id: number; kind: string; title: string; body: string | null; is_read: boolean; created_at: string; entity_type: string | null; entity_id: string | null }

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [loading, user, router, pathname]);

  if (loading || !user) return <div className="grid h-screen place-items-center"><Spinner label="Signing in…" /></div>;
  return (
    <Suspense fallback={<Spinner />}>
      <Shell>{children}</Shell>
    </Suspense>
  );
}

function useTheme() {
  const [theme, setTheme] = useLocalState<"light" | "dark">("lm_theme", "light");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  return [theme, setTheme] as const;
}

const NAV_PATHS = NAV.flatMap((s) => s.items.map((i) => i.href.split("?")[0]));

function isActive(item: NavItem, pathname: string, search: URLSearchParams) {
  const [path, query] = item.href.split("?");
  if (query) return pathname === path && search.get("type") === new URLSearchParams(query).get("type");
  if (path === "/") return pathname === "/";
  if (pathname !== path && !pathname.startsWith(`${path}/`)) return false;
  // A more specific entry (e.g. /reports/voice under /reports) owns its own pages.
  if (NAV_PATHS.some((p) => p.length > path.length && p.startsWith(`${path}/`) && (pathname === p || pathname.startsWith(`${p}/`)))) return false;
  return path !== "/inventory" || !search.get("type");
}

function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout, can } = useAuth();
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const [collapsed, setCollapsed] = useLocalState("lm_sidebar_collapsed", false);
  const [closedSections, setClosedSections] = useLocalState<string[]>("lm_sidebar_closed_sections", []);
  const toggleSection = (name: string) =>
    setClosedSections(closedSections.includes(name) ? closedSections.filter((s) => s !== name) : [...closedSections, name]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [theme, setTheme] = useTheme();

  useEffect(() => setMobileOpen(false), [pathname]);

  useEffect(() => {
    let gPressed = false;
    const onKey = (e: KeyboardEvent) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (typing) return;
      if (e.key === "?") setHelpOpen(true);
      if (e.key === "/") {
        e.preventDefault();
        setPaletteOpen(true);
      }
      if (gPressed) {
        const dest: Record<string, string> = { d: "/", i: "/inventory", s: "/scan", q: "/qr", e: "/sales", l: "/stock/ledger" };
        if (dest[e.key]) router.push(dest[e.key]);
        gPressed = false;
      } else if (e.key === "g") {
        gPressed = true;
        setTimeout(() => (gPressed = false), 800);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const nav = useMemo(
    () => NAV.map((s) => ({ ...s, items: s.items.filter((i) => !i.perm || can(...i.perm)) })).filter((s) => s.items.length),
    [can],
  );
  const company = useApi<{ profile: Record<string, string> }>("/api/masters/company");

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col border-r border-line bg-surface text-ink-2">
      <div className={cx("flex h-16 items-center gap-3 px-4", collapsed && "lg:justify-center lg:px-0")}>
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-navy text-[13px] font-extrabold tracking-wide text-white">LCC</div>
        <div className={cx("min-w-0 flex-1 leading-tight", collapsed && "lg:hidden")}>
          <p className="truncate text-[15px] font-extrabold text-navy dark:text-white">Lakshmi ERP</p>
          <p className="truncate text-xs text-muted">Card Clothing · {company.data?.profile.unit_name ?? "Unit"}</p>
        </div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="hidden size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-ink lg:grid"
          aria-label={collapsed ? "Expand sidebar" : "Minimize sidebar"}
          title={collapsed ? "Expand sidebar" : "Minimize sidebar"}
        >
          {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
        </button>
      </div>
      <div className={cx("mx-3 mb-2 flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[13px] text-ink", collapsed && "lg:hidden")}>
        <span className="size-2 rounded-full bg-success" aria-hidden />
        <span className="truncate">Organisation {company.data?.profile.unit_code ?? "—"}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {nav.map((section) => {
          const sectionClosed = closedSections.includes(section.section);
          return (
          <div key={section.section} className="mb-4">
            <button
              onClick={() => toggleSection(section.section)}
              aria-expanded={!sectionClosed}
              className={cx("mb-1 flex w-full items-center justify-between rounded px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-muted hover:text-ink", collapsed && "lg:hidden")}
            >
              {section.section}
              <ChevronDown className={cx("size-3.5 transition-transform", sectionClosed && "-rotate-90")} aria-hidden />
            </button>
            {section.items.filter((item) => !sectionClosed || collapsed || isActive(item, pathname, search)).map((item) => {
              const active = isActive(item, pathname, search);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "group mb-0.5 flex h-10 items-center gap-3 rounded-xl px-2.5 text-sm transition-colors",
                    active ? "bg-nav-active font-semibold text-white" : "font-medium text-ink-2 hover:bg-surface-3 hover:text-ink",
                    collapsed && "lg:justify-center",
                  )}
                >
                  <item.icon className={cx("size-[18px] shrink-0", active ? "text-white" : "text-muted group-hover:text-ink")} aria-hidden />
                  <span className={cx("flex-1 truncate", collapsed && "lg:hidden")}>{item.label}</span>
                  {item.planned && <span className={cx("rounded-full bg-surface-3 px-2 text-[10px] font-semibold text-muted", collapsed && "lg:hidden")}>{item.planned}</span>}
                </Link>
              );
            })}
          </div>
          );
        })}
      </div>
    </nav>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className={cx("no-print hidden shrink-0 transition-[width] lg:block", collapsed ? "w-[72px]" : "w-64")}>{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-navy/50" onClick={() => setMobileOpen(false)} />
          <div className="relative h-full w-72">{sidebar}</div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex h-16 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:px-6">
          <button className="grid size-10 place-items-center rounded-xl text-muted hover:bg-surface-3 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <button
            onClick={() => setPaletteOpen(true)}
            className="hidden h-11 w-full max-w-[520px] items-center gap-2.5 rounded-xl border border-line bg-surface-2 px-3.5 text-sm text-muted hover:border-line-strong sm:flex"
          >
            <Search className="size-[18px]" /> <span className="flex-1 truncate text-left">Search items, codes, POs, challans…</span>
            <Kbd>Ctrl K</Kbd>
          </button>
          <div className="flex-1" />
          <button onClick={() => setPaletteOpen(true)} className="grid size-10 place-items-center rounded-xl border border-line text-ink hover:bg-surface-3 sm:hidden" aria-label="Search">
            <Search className="size-[18px]" />
          </button>
          {can("items.view") && (
            <Link href="/scan" className="hidden size-10 place-items-center rounded-xl border border-line text-ink hover:bg-surface-3 sm:grid" aria-label="Scan a QR code" title="Scan & transact">
              <ScanLine className="size-[18px]" />
            </Link>
          )}
          <QuickCreate />
          <Notifications />
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="grid size-10 place-items-center rounded-xl border border-line text-ink hover:bg-surface-3"
                  aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
            {theme === "dark" ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
          </button>
          <button onClick={() => setHelpOpen(true)} className="hidden size-10 place-items-center rounded-xl border border-line text-ink hover:bg-surface-3 md:grid" aria-label="Help and keyboard shortcuts">
            <CircleHelp className="size-[18px]" />
          </button>
          <UserMenu name={user!.full_name} role={user!.roles.map((r) => r.name).join(", ")} onLogout={logout} />
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1480px] px-4 pb-24 pt-5 sm:px-6 lg:py-7">{children}</div>
        </main>
        <TabBar />
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="Keyboard shortcuts & help">
        <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
          {[["Ctrl K  or  /", "Search & command palette"], ["g then d", "Dashboard"], ["g then i", "Inventory"], ["g then s", "Scan & transact"],
            ["g then q", "QR management"], ["g then e", "Sales enquiries"], ["g then l", "Stock ledger"], ["?", "This help"], ["Esc", "Close panels"]].map(([k, v]) => (
            <div key={k} className="contents"><Kbd>{k}</Kbd><span className="text-ink-2">{v}</span></div>
          ))}
        </div>
        <p className="mt-5 border-t border-line pt-4 text-xs text-muted">
          Stock balances change only through ledger transactions (receipt, issue, transfer, return, approved adjustments).
          Delivery estimates are preliminary and rule-based until a sales order is confirmed.
        </p>
      </Modal>
    </div>
  );
}

/** Phone tab bar: the four things a stores worker does most, one thumb away. */
function TabBar() {
  const pathname = usePathname();
  const { can } = useAuth();
  const tabs = [
    { href: "/", label: "Home", icon: LayoutGrid, show: true },
    { href: "/scan", label: "Scan", icon: ScanLine, show: can("items.view") },
    { href: "/locator", label: "Locate", icon: MapPin, show: can("stock.view") },
    { href: "/inventory/overview", label: "Tasks", icon: ListChecks, show: can("stock.view") },
  ].filter((t) => t.show);
  return (
    <nav aria-label="Quick" className="no-print fixed inset-x-0 bottom-0 z-30 grid border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
         style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
      {tabs.map((t) => {
        const active = t.href === "/" ? pathname === "/" : pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined}
                className={cx("flex h-16 flex-col items-center justify-center gap-1 text-[11px]", active ? "font-extrabold text-primary" : "font-semibold text-muted")}>
            <t.icon className="size-[22px]" strokeWidth={active ? 2.3 : 1.8} aria-hidden />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onOutside();
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onOutside]);
  return ref;
}

function QuickCreate() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useClickOutside(close);
  const items = QUICK_CREATE.filter((q) => can(...q.perm));
  if (!items.length) return null;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="flex h-10 items-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-bold text-white hover:bg-primary-hover"
              aria-haspopup="menu" aria-expanded={open}>
        <Plus className="size-4" /> <span className="hidden sm:inline">Create</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-30 w-52 rounded-lg border border-line bg-surface p-1 shadow-pop">
          {items.map((q) => (
            <Link key={q.href + q.label} href={q.href} onClick={close} role="menuitem"
                  className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-ink-2 hover:bg-surface-3 hover:text-ink">
              <q.icon className="size-4 text-muted" /> {q.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const { data, reload } = useApi<Notice[]>("/api/notifications", { pollMs: 30000 });
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useClickOutside(close);
  const unread = data?.filter((n) => !n.is_read).length ?? 0;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="relative grid size-10 place-items-center rounded-xl border border-line text-ink hover:bg-surface-3" aria-label={`Notifications, ${unread} unread`}>
        <Bell className="size-[18px]" />
        {unread > 0 && <span className="absolute -right-1 -top-1 grid min-w-5 place-items-center rounded-full border-2 border-surface bg-accent px-1 text-[10px] font-bold text-white">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-30 w-[340px] max-w-[calc(100vw-24px)] rounded-lg border border-line bg-surface shadow-pop">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <p className="text-sm font-semibold">Notifications & tasks</p>
            <button onClick={close} aria-label="Close" className="text-muted"><X className="size-4" /></button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {!data?.length && <p className="px-4 py-8 text-center text-sm text-muted">You&apos;re all caught up.</p>}
            {data?.map((n) => (
              <button key={n.id} onClick={async () => { await api(`/api/notifications/${n.id}/read`, { method: "POST" }); reload(); }}
                      className={cx("block w-full border-b border-line px-4 py-2.5 text-left last:border-0 hover:bg-surface-2", !n.is_read && "bg-primary-soft/40")}>
                <div className="flex items-center gap-2">
                  <Badge tone={n.kind === "reorder" ? "warning" : n.kind === "approval" ? "primary" : "neutral"}>{n.kind}</Badge>
                  <span className="text-[11px] text-muted">{dateTime(n.created_at)}</span>
                </div>
                <p className="mt-1 text-[13px] font-medium text-ink">{n.title}</p>
                {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{n.body}</p>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UserMenu({ name, role, onLogout }: { name: string; role: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useClickOutside(close);
  const initials = name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2.5 rounded-xl py-1 pl-1 pr-2 hover:bg-surface-3" aria-haspopup="menu" aria-expanded={open}>
        <span className="grid size-9 place-items-center rounded-full bg-primary-soft text-[13px] font-bold text-navy dark:text-primary">{initials}</span>
        <span className="hidden text-left leading-tight xl:block">
          <span className="block text-sm font-semibold text-ink">{name}</span>
          <span className="block max-w-36 truncate text-[11px] text-muted">{role}</span>
        </span>
        <ChevronDown className="hidden size-3.5 text-muted xl:block" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-30 w-56 rounded-lg border border-line bg-surface p-1 shadow-pop">
          <div className="border-b border-line px-3 py-2">
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-muted">{role}</p>
          </div>
          <button onClick={onLogout} role="menuitem" className="mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-ink-2 hover:bg-surface-3">
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
