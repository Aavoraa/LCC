"use client";

import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { qty } from "@/lib/format";
import type { ItemRow } from "@/lib/types";
import { Input, cx } from "./ui";

export function ItemPicker({ value, onChange, placeholder = "Search item code or name" }: {
  value: ItemRow | null; onChange: (item: ItemRow | null) => void; placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<ItemRow[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (q.trim().length < 1) { setResults([]); return; }
    const t = setTimeout(() => api<{ items: ItemRow[] }>(`/api/items?q=${encodeURIComponent(q)}&page_size=10`).then((r) => { setResults(r.items); setActive(0); }).catch(() => {}), 180);
    return () => clearTimeout(t);
  }, [q]);

  if (value) {
    return (
      <div className="flex h-9 items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-3 text-sm">
        <span className="font-mono text-xs font-semibold text-primary">{value.item_code}</span>
        <span className="flex-1 truncate">{value.name}</span>
        <button type="button" onClick={() => onChange(null)} aria-label="Clear item" className="text-muted hover:text-ink"><X className="size-4" /></button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
      <Input value={q} placeholder={placeholder} className="pl-8" onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} role="combobox" aria-expanded={open && results.length > 0}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === "Enter" && results[active]) { e.preventDefault(); onChange(results[active]); setQ(""); }
        }} />
      {open && results.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-line bg-surface p-1 shadow-pop" role="listbox">
          {results.map((r, i) => (
            <li key={r.id}>
              <button type="button" role="option" aria-selected={i === active} onMouseDown={() => { onChange(r); setQ(""); }}
                      className={cx("flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm", i === active ? "bg-primary-soft" : "hover:bg-surface-2")}>
                <span className="font-mono text-xs font-semibold text-primary">{r.item_code}</span>
                <span className="flex-1 truncate">{r.name}</span>
                <span className="tabular text-xs text-muted">{qty(r.available)} {r.uom}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
