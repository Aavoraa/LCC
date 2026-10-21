"use client";

import { CheckCircle2, Printer, ScanLine, Search, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Scanner } from "@/components/Scanner";
import { Badge, Button, Card, CardHeader, EmptyState, Input, PageHeader, Select, Spinner, Td, Th, cx } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { qty } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { ITEM_TYPES, type ItemRow, type Resolve } from "@/lib/types";

export default function QrManagementPage() {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [type, setType] = useState("");
  const [qrStatus, setQrStatus] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [verify, setVerify] = useState<{ ok: boolean; text: string; sub?: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setTerm(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const s = new URLSearchParams({ page_size: "200" });
  if (term) s.set("q", term);
  if (type) s.set("item_type", type);
  if (qrStatus) s.set("qr_status", qrStatus);
  const list = useApi<{ items: ItemRow[]; total: number }>(`/api/items?${s}`);
  const rows = list.data?.items ?? [];
  const all = rows.length > 0 && rows.every((r) => selected.has(r.id));

  async function onScan(payload: string) {
    try {
      const r = await api<Resolve>(`/api/qr/resolve?payload=${encodeURIComponent(payload)}&verify=true`);
      setVerify(r.kind === "item"
        ? { ok: true, text: `${r.item!.item_code} · ${r.item!.name}`, sub: `Label verified — maps to the existing item record (generation ${r.qr.generation}). Available ${qty(r.totals.available)} ${r.item!.uom.code}.` }
        : { ok: true, text: `Bin ${r.location!.code}`, sub: "Location label verified." });
    } catch (e) {
      setVerify({ ok: false, text: "Label not valid", sub: (e as ApiError).message });
    }
  }

  return (
    <>
      <PageHeader title="QR code management" description="Generate labels for new or existing items. Existing QR codes are reused — an item never gets a second active SKU label."
        actions={selected.size > 0 && <Link href={`/qr/print?ids=${[...selected].join(",")}`}><Button icon={<Printer className="size-4" />}>Print {selected.size} label{selected.size === 1 ? "" : "s"}</Button></Link>} />
      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap gap-2 border-b border-line p-3">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search existing inventory" className="pl-8" aria-label="Search" />
            </div>
            <Select value={type} onChange={(e) => setType(e.target.value)} className="w-auto" aria-label="Type">
              <option value="">All types</option>{ITEM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
            <Select value={qrStatus} onChange={(e) => setQrStatus(e.target.value)} className="w-auto" aria-label="QR status">
              <option value="">Any QR status</option><option value="NONE">Without QR</option><option value="ACTIVE">With QR</option>
            </Select>
          </div>
          {list.loading && !list.data ? <Spinner /> : rows.length === 0 ? <EmptyState title="No items found" /> : (
            <div className="max-h-[65vh] overflow-auto">
              <table className="w-full text-[13px]">
                <thead><tr>
                  <Th className="w-9"><input type="checkbox" aria-label="Select all" checked={all} onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))} /></Th>
                  <Th>Item code</Th><Th>Name</Th><Th>Location</Th><Th>QR</Th><Th className="text-right">Available</Th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={cx("h-9 cursor-pointer hover:bg-surface-2", selected.has(r.id) && "bg-primary-soft/40")}
                        onClick={() => { const n = new Set(selected); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); setSelected(n); }}>
                      <Td><input type="checkbox" readOnly checked={selected.has(r.id)} aria-label={`Select ${r.item_code}`} /></Td>
                      <Td className="font-mono text-xs font-semibold text-primary">{r.item_code}</Td>
                      <Td className="text-ink">{r.name}</Td>
                      <Td className="font-mono text-xs">{r.location ?? "—"}</Td>
                      <Td>{r.qr_status === "ACTIVE" ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Not generated</Badge>}</Td>
                      <Td className="tabular text-right">{qty(r.available)} {r.uom}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card className="h-fit">
          <CardHeader title={<span className="flex items-center gap-2"><ScanLine className="size-4" /> Verify a printed label</span>} subtitle="Scan to confirm a label maps to the right item" />
          <div className="p-3">
            <Scanner onResult={onScan} />
            {verify && (
              <div className={cx("mt-3 flex gap-2.5 rounded-md p-3 text-sm", verify.ok ? "bg-success-soft" : "bg-danger-soft")}>
                {verify.ok ? <CheckCircle2 className="size-5 shrink-0 text-success" /> : <XCircle className="size-5 shrink-0 text-danger" />}
                <div><p className="font-medium text-ink">{verify.text}</p>{verify.sub && <p className="mt-0.5 text-xs text-ink-2">{verify.sub}</p>}</div>
              </div>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
