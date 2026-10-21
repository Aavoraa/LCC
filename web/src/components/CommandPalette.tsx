"use client";

import { Clock, CornerDownLeft, Package, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { ItemRow } from "@/lib/types";
import { NAV, QUICK_CREATE } from "./nav";
import { cx } from "./ui";

const RECENT_KEY = "lm_recent";

export function pushRecent(entry: { label: string; href: string; sub?: string }) {
  try {
    const list: typeof entry[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    const next = [entry, ...list.filter((e) => e.href !== entry.href)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function readRecent(): { label: string; href: string; sub?: string }[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

interface Entry { key: string; label: string; sub?: string; href: string; group: string; icon?: React.ReactNode }

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { can } = useAuth();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ItemRow[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2 || !can("items.view")) {
      setItems([]);
      return;
    }
    const t = setTimeout(() => {
      api<{ items: ItemRow[] }>(`/api/items?q=${encodeURIComponent(q.trim())}&page_size=8`).then((r) => setItems(r.items)).catch(() => setItems([]));
    }, 180);
    return () => clearTimeout(t);
  }, [q, open, can]);

  const entries = useMemo<Entry[]>(() => {
    const term = q.trim().toLowerCase();
    const pages = NAV.flatMap((s) => s.items)
      .filter((i) => !i.perm || can(...i.perm))
      .filter((i) => !term || i.label.toLowerCase().includes(term))
      .map((i) => ({ key: `p${i.href}`, label: i.label, href: i.href, group: "Pages", icon: <i.icon className="size-4" /> }));
    const actions = QUICK_CREATE.filter((a) => can(...a.perm))
      .filter((a) => !term || a.label.toLowerCase().includes(term))
      .map((a) => ({ key: `a${a.href}${a.label}`, label: a.label, href: a.href, group: "Actions", icon: <a.icon className="size-4" /> }));
    const found = items.map((i) => ({
      key: `i${i.id}`, label: `${i.item_code} · ${i.name}`, sub: `${i.available} ${i.uom} available`, href: `/inventory?item=${i.id}`,
      group: "Items", icon: <Package className="size-4" />,
    }));
    const recent = term ? [] : readRecent().map((r) => ({ key: `r${r.href}`, ...r, group: "Recent", icon: <Clock className="size-4" /> }));
    return [...found, ...recent, ...actions, ...pages].slice(0, 30);
  }, [q, items, can]);

  useEffect(() => setActive(0), [q, items]);

  if (!open) return null;
  const go = (e: Entry) => {
    onClose();
    router.push(e.href);
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 bg-navy/50" onClick={onClose} />
      <div className="relative w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="size-4 text-muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, entries.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              if (e.key === "Enter" && entries[active]) go(entries[active]);
            }}
            placeholder="Search by item code, name, make — or jump to a page"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
          />
        </div>
        <ul id="palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
          {entries.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">No matches.</li>}
          {entries.map((e, i) => {
            const header = e.group !== lastGroup ? e.group : null;
            lastGroup = e.group;
            return (
              <li key={e.key}>
                {header && <p className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted">{header}</p>}
                <button
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(e)}
                  className={cx("flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm", i === active ? "bg-primary-soft text-ink" : "text-ink-2")}
                >
                  <span className="text-muted">{e.icon}</span>
                  <span className="flex-1 truncate">{e.label}</span>
                  {e.sub && <span className="text-xs text-muted">{e.sub}</span>}
                  {i === active && <CornerDownLeft className="size-3.5 text-muted" />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
