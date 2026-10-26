"use client";

import { ArrowLeft, Boxes, ChevronRight, MapPin, Mic, QrCode, ScanLine, Search, Square, Volume2, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useState } from "react";
import { pushRecent } from "@/components/CommandPalette";
import { MovementBadge } from "@/components/MovementBadge";
import { QrImage } from "@/components/QrImage";
import { Scanner } from "@/components/Scanner";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Input, PageHeader, Spinner, StockBadge, Tabs, Td, Th, cx } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { dateFmt, dateTime, isInbound, isOutbound, money, qty } from "@/lib/format";
import { useApi, useLocalState } from "@/lib/hooks";
import { LANG_KEY, useSpeaker, useSpeechInput, type Lang } from "@/lib/speech";
import { itemTypeLabel, type ItemHistory, type LocatorFind } from "@/lib/types";
import { locatorSentence } from "@/lib/voiceReport";

export default function LocatorPage() {
  return <Suspense><Locator /></Suspense>;
}

function Locator() {
  const params = useSearchParams();
  const router = useRouter();
  const itemId = Number(params.get("item")) || null;
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<LocatorFind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [lang, setLang] = useLocalState<Lang>(LANG_KEY, "en");

  const find = useCallback(async (text: string, auto = true) => {
    const q = text.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<LocatorFind>(`/api/locator/find?query=${encodeURIComponent(q)}`);
      setFound(r);
      if (r.item_id && auto) {
        setScanning(false);
        router.push(`/locator?item=${r.item_id}`);
      } else if (r.candidates.length === 0) {
        setError(`No item found for “${q}”. Try another name or the item number.`);
      }
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }, [router]);

  // Item names are in English, so voice search listens in English (Indian accent) whatever the read-aloud language.
  const mic = useSpeechInput("en", (text) => {
    setQuery(text);
    find(text);
  });

  // Suggestions while typing; Enter opens an exact or single match.
  useEffect(() => {
    if (query.trim().length < 2) return;
    const t = setTimeout(() => find(query, false), 250);
    return () => clearTimeout(t);
  }, [query, find]);

  const showList = !itemId || scanning || (query.trim().length >= 2 && found);

  return (
    <>
      <PageHeader
        title="Item Locator"
        description="Scan a QR label, type a product name or item number, or say it. Shows where the item is stored, what is available, and its full purchase and stock history."
        actions={
          <div className="inline-flex rounded-md border border-line-strong p-0.5" role="group" aria-label="Read-aloud language">
            {(["en", "ta"] as Lang[]).map((l) => (
              <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l}
                className={cx("rounded px-3 py-1 text-sm font-medium", lang === l ? "bg-primary text-white" : "text-ink-2 hover:bg-surface-2")}>
                {l === "en" ? "English" : "தமிழ்"}
              </button>
            ))}
          </div>
        }
      />

      <Card className="mb-5 p-4">
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); find(query); }}>
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
            <Input value={query} onChange={(e) => { setQuery(e.target.value); if (e.target.value.trim().length < 2) setFound(null); }} placeholder="Product name or item number, e.g. bearing 6205 or PI-000001"
              className="pl-8" aria-label="Product name or item number" autoFocus={!itemId} />
          </div>
          <Button type="submit" loading={busy} icon={<Search className="size-4" />}>Find</Button>
          <Button type="button" variant={mic.listening ? "danger" : "secondary"} icon={<Mic className="size-4" />}
            onClick={() => (mic.listening ? mic.stop() : mic.start())} title="Say the product name or item number">
            {mic.listening ? "Listening…" : "Speak"}
          </Button>
          <Button type="button" variant={scanning ? "primary" : "secondary"} icon={<ScanLine className="size-4" />} onClick={() => setScanning((s) => !s)}>
            {scanning ? "Close scanner" : "Scan QR"}
          </Button>
        </form>
        {mic.listening && mic.interim && <p className="mt-2 text-sm text-muted">Heard: “{mic.interim}”</p>}
        {mic.error && <div className="mt-3"><Alert tone="warning">{mic.error}</Alert></div>}
        {scanning && (
          <div className="mt-4 max-w-md">
            <Scanner onResult={(payload) => { setQuery(""); find(payload); }} />
          </div>
        )}
        {error && <div className="mt-3"><Alert tone="warning">{error}</Alert></div>}
        {found?.warning && <div className="mt-3"><Alert tone="warning">{found.warning}</Alert></div>}
        {showList && found && !found.item_id && found.candidates.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {found.kind === "location" ? <>Items in bin <span className="font-mono">{found.location}</span></> : `${found.candidates.length} matching items`}
            </p>
            <ul className="divide-y divide-line rounded-md border border-line">
              {found.candidates.map((c) => (
                <li key={c.id}>
                  <Link href={`/locator?item=${c.id}`} onClick={() => setFound(null)} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-surface-2">
                    <span className="font-mono text-xs font-semibold text-primary">{c.item_code}</span>
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className="hidden text-xs text-muted sm:inline">{itemTypeLabel(c.item_type)}</span>
                    {c.location && <span className="flex items-center gap-1 font-mono text-xs text-muted"><MapPin className="size-3" />{c.location}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {itemId ? <History itemId={itemId} lang={lang} /> : !found && (
        <Card><EmptyState icon={<QrCode className="size-8" />} title="Find an item" description="Scan its QR label, or search by product name or item number." /></Card>
      )}
    </>
  );
}

type Tab = "purchase" | "movements" | "demand" | "details";

function History({ itemId, lang }: { itemId: number; lang: Lang }) {
  const h = useApi<ItemHistory>(`/api/locator/items/${itemId}`);
  const speaker = useSpeaker(lang);
  const [tab, setTab] = useState<Tab>("purchase");

  useEffect(() => {
    if (h.data) pushRecent({ label: `${h.data.item.item_code} · ${h.data.item.name}`, href: `/locator?item=${itemId}`, sub: "Item locator" });
  }, [h.data, itemId]);

  if (h.error) return <ErrorState error={h.error} onRetry={h.reload} />;
  if (!h.data) return <Spinner />;
  const d = h.data;
  const { item, totals, balances, purchase: p, movement_summary: ms } = d;
  const uom = item.uom.code;
  const stocked = balances.filter((b) => Number(b.qty_on_hand) > 0 || Number(b.qty_reserved) > 0);
  const demandCount = d.reservations.length + d.sales_orders.length + d.requisitions.length + d.work_orders.length + d.machines.length;

  const readAloud = () => {
    const last = ms.last_receipt;
    speaker.speak([locatorSentence(lang, {
      name: item.name, code: item.item_code, uom, available: totals.available, physical: totals.on_hand, status: d.stock_status,
      locations: stocked.length ? stocked.map((b) => b.location.code) : item.default_location ? [item.default_location.code] : [],
      lastReceipt: last ? {
        qty: last.quantity, ref: last.ref_doc_no,
        date: new Date(last.created_at.endsWith("Z") || last.created_at.includes("+") ? last.created_at : `${last.created_at}Z`)
          .toLocaleDateString(lang === "ta" ? "ta-IN" : "en-IN", { day: "numeric", month: "long", year: "numeric" }),
      } : null,
      openPo: p.open_qty,
    })]);
  };

  // Stock on hand after each movement, worked back from today's balance (newest first).
  let running = Number(totals.on_hand);
  const balanceAfter = d.movements.map((m) => {
    const after = running;
    running -= isInbound(m.movement_type) ? Number(m.quantity) : isOutbound(m.movement_type) ? -Number(m.quantity) : 0;
    return after;
  });

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-start gap-4 p-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold text-primary">{item.item_code}</span>
              <Badge tone="primary">{itemTypeLabel(item.item_type)}</Badge>
              <StockBadge status={d.stock_status} />
              {d.below_min && <Badge tone="warning" dot>Below minimum</Badge>}
              {!item.is_active && <Badge tone="danger">Inactive</Badge>}
            </div>
            <h2 className="mt-1 text-xl font-semibold leading-snug">{item.name}</h2>
            <p className="mt-0.5 text-sm text-muted">
              {[item.category?.name, item.make_model, item.manufacturer].filter(Boolean).join(" · ") || item.description || "—"}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {speaker.speaking
                ? <Button size="sm" variant="danger" icon={<Square className="size-4" />} onClick={speaker.stop}>Stop</Button>
                : <Button size="sm" icon={<Volume2 className="size-4" />} onClick={readAloud} disabled={!speaker.supported}>{lang === "ta" ? "சத்தமாக வாசி" : "Read aloud"}</Button>}
              <Link href={`/scan?item=${item.id}`}><Button size="sm" variant="secondary" icon={<ScanLine className="size-4" />}>Transact</Button></Link>
              <Link href={`/inventory?item=${item.id}`}><Button size="sm" variant="secondary" icon={<Boxes className="size-4" />}>Open in inventory</Button></Link>
              <Link href="/locator"><Button size="sm" variant="ghost" icon={<X className="size-4" />}>Clear</Button></Link>
            </div>
            {lang === "ta" && speaker.supported && speaker.voicesLoaded && !speaker.hasVoice && (
              <p className="mt-2 text-xs text-warning">No Tamil voice on this device — use Microsoft Edge or Android Chrome, or add Tamil speech in Windows settings.</p>
            )}
          </div>
          {d.qr && <QrImage itemId={item.id} token={d.qr.token} className="size-28 shrink-0 rounded-md border border-line bg-white p-1" />}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card>
          <CardHeader title="Where to find it" subtitle="Storage locations holding this item" />
          <div className="space-y-2 p-4">
            {stocked.length === 0 && (
              <div className="rounded-lg border border-dashed border-line-strong p-3 text-sm">
                <p className="text-muted">No stock in any location.</p>
                {item.default_location && <p className="mt-1">Assigned location: <span className="font-mono font-semibold">{item.default_location.code}</span></p>}
              </div>
            )}
            {stocked.map((b) => (
              <div key={b.location.id} className="flex items-center gap-3 rounded-lg border border-line p-3">
                <MapPin className="size-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-base font-semibold text-ink">{b.location.code}</p>
                  <p className="text-xs text-muted">
                    {b.location.warehouse.name} · Rack {b.location.rack} · Bin {b.location.bin}
                    {item.default_location?.id === b.location.id && " · default"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="tabular text-lg font-semibold text-success">{qty(b.qty_available)} <span className="text-xs font-normal text-muted">{uom}</span></p>
                  <p className="tabular text-[11px] text-muted">
                    on hand {qty(b.qty_on_hand)}{Number(b.qty_reserved) > 0 && ` · reserved ${qty(b.qty_reserved)}`}{Number(b.qty_qc_hold) > 0 && ` · QC ${qty(b.qty_qc_hold)}`}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Stock position" subtitle={`${item.uom.name} · weighted average ${money(item.avg_cost, true)}`} />
          <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3">
            {([
              ["On hand", qty(totals.on_hand)], ["Reserved", qty(totals.reserved)], ["QC hold", qty(totals.qc_hold)],
              ["Available", qty(totals.available)], ["Stock value", money(totals.valuation)], ["Due on open POs", qty(p.open_qty)],
              ["Min / reorder / max", `${qty(item.min_stock)} / ${qty(item.reorder_level)} / ${qty(item.max_stock)}`],
              ["Restock qty", totals.restock_qty ? qty(totals.restock_qty) : "—"],
              ["Last received", ms.last_receipt ? `${qty(ms.last_receipt.quantity)} on ${dateFmt(ms.last_receipt.created_at)}` : "—"],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label} className="bg-surface p-3">
                <p className="text-[11px] text-muted">{label}</p>
                <p className={cx("tabular text-base font-semibold", label === "Available" && "text-success")}>{value}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <ItemQuantities d={d} />

      <Card className="overflow-hidden">
        <Tabs<Tab> className="px-2" value={tab} onChange={setTab} tabs={[
          { id: "purchase", label: "Purchase history", count: p.lines.length },
          { id: "movements", label: "Stock history", count: ms.count },
          { id: "demand", label: "Demand & usage", count: demandCount },
          { id: "details", label: "Item details" },
        ]} />

        {tab === "purchase" && (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-line p-4 text-sm sm:grid-cols-4">
              <Fact label="Purchase orders" value={p.count} />
              <Fact label="Ordered / received" value={`${qty(p.total_ordered)} / ${qty(p.total_received)} ${uom}`} />
              <Fact label="Total purchase value" value={money(p.total_amount)} />
              <Fact label="Last price" value={p.last_price ? money(p.last_price, true) : "—"} />
              <Fact label="Average price" value={p.avg_price ? money(p.avg_price, true) : "—"} />
              <Fact label="Price range" value={p.min_price ? `${money(p.min_price, true)} – ${money(p.max_price, true)}` : "—"} />
              <Fact label="Suppliers" value={p.suppliers.join(", ") || "—"} className="sm:col-span-2" />
            </div>
            {p.lines.length === 0 ? <EmptyState title="No purchase orders for this item" description="Receipts recorded without a PO appear under Stock history." /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-[13px]">
                  <thead><tr><Th>PO</Th><Th>Order date</Th><Th>Supplier</Th><Th>Status</Th><Th className="text-right">Ordered</Th><Th className="text-right">Received</Th>
                    <Th className="text-right">Open</Th><Th className="text-right">Unit price</Th><Th className="text-right">Amount</Th><Th>Expected</Th></tr></thead>
                  <tbody>{p.lines.map((l, i) => (
                    <tr key={`${l.po_id}-${i}`} className="hover:bg-surface-2">
                      <Td className="h-9 font-mono text-xs font-semibold">{l.po_number}</Td>
                      <Td>{dateFmt(l.order_date)}</Td>
                      <Td>{l.supplier}</Td>
                      <Td><Badge tone={l.status === "CLOSED" ? "success" : l.status === "CANCELLED" ? "danger" : l.status === "APPROVED" ? "primary" : "neutral"}>{l.status.toLowerCase()}</Badge></Td>
                      <Td className="tabular text-right">{qty(l.qty_ordered)}</Td>
                      <Td className="tabular text-right">{qty(l.qty_received)}</Td>
                      <Td className="tabular text-right">{Number(l.qty_open) > 0 ? qty(l.qty_open) : "—"}</Td>
                      <Td className="tabular text-right">{money(l.unit_price, true)}</Td>
                      <Td className="tabular text-right font-medium">{money(l.amount)}</Td>
                      <Td>{dateFmt(l.expected_date)}</Td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === "movements" && (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-line p-4 text-sm sm:grid-cols-4">
              <Fact label="Opening" value={`${qty(ms.opening)} ${uom}`} />
              <Fact label="Received" value={`${qty(ms.received)} ${uom}`} />
              <Fact label="Issued" value={`${qty(ms.issued)} ${uom}`} />
              <Fact label="Returned" value={`${qty(ms.returned)} ${uom}`} />
              <Fact label="Adjusted + / −" value={`${qty(ms.adjusted_in)} / ${qty(ms.adjusted_out)}`} />
              <Fact label="First movement" value={ms.first_at ? dateFmt(ms.first_at) : "—"} />
              <Fact label="Last receipt" value={ms.last_receipt ? `${dateFmt(ms.last_receipt.created_at)} · ${ms.last_receipt.ref_doc_no ?? ms.last_receipt.number}` : "—"} />
              <Fact label="Last issue" value={ms.last_issue ? `${dateFmt(ms.last_issue.created_at)} · ${ms.last_issue.ref_doc_no ?? ms.last_issue.number}` : "—"} />
            </div>
            {d.movements.length === 0 ? <EmptyState title="No stock movements yet" /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-[13px]">
                  <thead><tr><Th>Date</Th><Th>Type</Th><Th className="text-right">Qty</Th><Th className="text-right">Balance after</Th><Th>From → to</Th>
                    <Th>Reference</Th><Th className="text-right">Unit cost</Th><Th className="text-right">Value</Th><Th>By</Th></tr></thead>
                  <tbody>{d.movements.map((m, i) => (
                    <tr key={m.id} className="hover:bg-surface-2">
                      <Td className="h-9 whitespace-nowrap text-xs">{dateTime(m.created_at)}</Td>
                      <Td><MovementBadge type={m.movement_type} /></Td>
                      <Td className={cx("tabular text-right font-semibold", isInbound(m.movement_type) && "text-success", isOutbound(m.movement_type) && "text-danger")}>
                        {isOutbound(m.movement_type) ? "−" : isInbound(m.movement_type) ? "+" : ""}{qty(m.quantity)}
                      </Td>
                      <Td className="tabular text-right">{qty(balanceAfter[i])}</Td>
                      <Td className="font-mono text-xs">{[m.from_location, m.to_location].filter(Boolean).join(" → ") || "—"}</Td>
                      <Td className="text-xs">{m.ref_doc_type ? `${m.ref_doc_type.replace(/_/g, " ").toLowerCase()} ${m.ref_doc_no ?? ""}` : m.number}</Td>
                      <Td className="tabular text-right">{Number(m.unit_cost) ? money(m.unit_cost, true) : "—"}</Td>
                      <Td className="tabular text-right">{Number(m.value) ? money(m.value) : "—"}</Td>
                      <Td className="text-xs">{m.created_by}{m.source === "android" && " · Android"}</Td>
                    </tr>
                  ))}</tbody>
                </table>
                {ms.count > d.movements.length && <p className="px-4 py-2 text-xs text-muted">Showing the latest {d.movements.length} of {ms.count} movements. <Link className="text-primary" href="/stock/ledger">Open the stock ledger</Link> for the rest.</p>}
              </div>
            )}
          </>
        )}

        {tab === "demand" && (
          demandCount === 0 ? <EmptyState title="No open demand" description="No reservations, open sales orders, requisitions, work orders or machines use this item." /> : (
            <div className="divide-y divide-line">
              {d.reservations.length > 0 && (
                <Section title="Reserved stock">
                  {d.reservations.map((r, i) => <Row key={i} left={`${r.ref_doc_type.replace(/_/g, " ").toLowerCase()} ${r.ref_doc_no}`} mid={r.location} right={`${qty(r.qty_open)} ${uom}`} />)}
                </Section>
              )}
              {d.sales_orders.length > 0 && (
                <Section title="Open sales orders">
                  {d.sales_orders.map((s) => <Row key={`${s.so_id}-${s.quantity}`} left={`${s.so_number} · ${s.customer}`} mid={`${s.status.toLowerCase()}${s.forecast_date ? ` · forecast ${dateFmt(s.forecast_date)}` : ""}`} right={`${qty(s.qty_issued)} / ${qty(s.quantity)} issued`} />)}
                </Section>
              )}
              {d.requisitions.length > 0 && (
                <Section title="Requisitions">
                  {d.requisitions.map((r) => <Row key={r.number} left={`${r.number} · ${r.kind.toLowerCase()}`} mid={`${r.status.toLowerCase()}${r.required_date ? ` · need by ${dateFmt(r.required_date)}` : ""}`} right={`${qty(r.quantity)} ${uom}`} />)}
                </Section>
              )}
              {d.work_orders.length > 0 && (
                <Section title="Work orders">
                  {d.work_orders.map((w) => <Row key={w.number} left={w.number} mid={w.status.toLowerCase().replace("_", " ")} right={`${qty(w.qty_completed)} / ${qty(w.quantity)} done`} />)}
                </Section>
              )}
              {d.machines.length > 0 && (
                <Section title="Used in machines (SOP spares)">
                  {d.machines.map((m) => <Row key={m.machine_id} left={<Link className="text-primary" href={`/machines/${m.machine_id}`}>{m.code} · {m.name}</Link>} mid={`SOP stock ${qty(m.sop_stock)}`} right={`${qty(m.qty_per_machine)} per machine`} />)}
                </Section>
              )}
            </div>
          )
        )}

        {tab === "details" && (
          <div className="p-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px] sm:grid-cols-3">
              {([
                ["Category", [item.category?.name, item.subcategory?.name].filter(Boolean).join(" / ")],
                ["Default location", item.default_location?.code], ["Unit", `${item.uom.code} (${item.uom.name})`],
                ["Manufacturer", item.manufacturer], ["Make / model", item.make_model], ["Supplier", item.supplier?.name],
                ["HSN / GST", [item.hsn_code, item.gst_rate && `${Number(item.gst_rate)}%`].filter(Boolean).join(" · ")],
                ["Tracking", item.tracking.toLowerCase()], ["Valuation", item.valuation_method.replace("_", " ").toLowerCase()],
                ["Purchase lead", item.purchase_lead_days ? `${item.purchase_lead_days} days` : "Supplier default"],
                ["QR label", d.qr ? `Generation ${d.qr.generation} · printed ${d.qr.printed_count}×` : "No active QR"],
                ["Created", dateFmt(item.created_at)],
              ] as [string, string | null | undefined][]).map(([k, v]) => (
                <div key={k}><dt className="text-[11px] text-muted">{k}</dt><dd className="text-ink-2">{v || "—"}</dd></div>
              ))}
            </dl>
            {item.description && <p className="mt-3 text-sm text-ink-2">{item.description}</p>}
            {item.specifications && <p className="mt-3 whitespace-pre-wrap rounded bg-surface-2 p-2.5 text-xs text-ink-2">{item.specifications}</p>}
          </div>
        )}
      </Card>

      <Link href="/locator" className="inline-flex items-center gap-1 text-sm text-primary"><ArrowLeft className="size-4" /> Find another item</Link>
    </div>
  );
}

/** Oracle "Manage Item Quantities" view: item → organisation → subinventory → locator. */
function ItemQuantities({ d }: { d: ItemHistory }) {
  const q = d.quantities;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const num = "tabular w-24 text-right";
  const Row = ({ depth, label, on, inbound, qc, avail, toggle, isOpen }: {
    depth: number; label: React.ReactNode; on: string; inbound?: string; qc: string; avail?: string; toggle?: () => void; isOpen?: boolean;
  }) => (
    <tr className="border-t border-line">
      <td className="py-2" style={{ paddingLeft: `${12 + depth * 22}px` }}>
        {toggle ? <button onClick={toggle} className="inline-flex items-center gap-1.5 text-ink hover:text-primary" aria-expanded={isOpen}>
          <ChevronRight className={cx("size-3.5 transition-transform", isOpen && "rotate-90")} />{label}</button> : <span className="pl-5">{label}</span>}
      </td>
      <td className={num}>{qty(on)}</td>
      <td className={num}>{inbound == null ? "" : qty(inbound)}</td>
      <td className={num}>{qty(qc)}</td>
      <td className={cx(num, "font-medium")}>{avail == null ? "" : qty(avail)}</td>
      <td className="w-24 px-3 text-xs text-muted">{q.uom_name}</td>
    </tr>
  );
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Item quantities" subtitle={`View by item · organisation ${q.organization}${q.category ? ` · category ${q.category}` : ""}`} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead><tr className="text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="px-3 py-2 font-semibold">Item / organisation / subinventory / locator</th><th className="w-24 py-2 text-right font-semibold">On hand</th>
            <th className="w-24 py-2 text-right font-semibold">Receiving inbound</th><th className="w-24 py-2 text-right font-semibold">QC hold</th>
            <th className="w-24 py-2 text-right font-semibold">Available</th><th className="w-24 px-3 py-2 font-semibold">UOM</th>
          </tr></thead>
          <tbody>
            <Row depth={0} label={<><span className="font-mono font-semibold">Item {d.item.item_code}</span> <span className="text-muted">{d.item.name}</span></>}
              on={q.on_hand} inbound={q.receiving_inbound} qc={q.qc_hold} avail={d.totals.available} />
            <Row depth={1} label={`Organization ${q.organization}`} on={q.on_hand} inbound={q.receiving_inbound} qc={q.qc_hold} avail={d.totals.available} />
            {q.subinventories.map((s) => (
              <Fragment key={s.code}>
                <Row depth={2} label={<>Subinventory <span className="font-mono font-semibold">{s.code}</span> <span className="text-xs text-muted">{s.name}</span></>}
                  on={s.on_hand} qc={s.qc_hold} avail={s.available} toggle={() => setOpen({ ...open, [s.code]: !open[s.code] })} isOpen={open[s.code]} />
                {open[s.code] && s.locators.map((l) => (
                  <Row key={l.code} depth={3} label={<>Locator <span className="font-mono">{l.code}</span> <span className="text-xs text-muted">rack {l.rack} · bin {l.bin}</span></>}
                    on={l.on_hand} qc={l.qc_hold} avail={l.available} />
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {q.subinventories.length === 0 && <p className="px-4 py-3 text-sm text-muted">No quantity in any subinventory.</p>}
    </Card>
  );
}

function Fact({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p className="text-[11px] text-muted">{label}</p>
      <p className="tabular font-medium text-ink">{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="px-4 py-3">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <ul className="divide-y divide-line">{children}</ul>
    </section>
  );
}

function Row({ left, mid, right }: { left: React.ReactNode; mid: React.ReactNode; right: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 py-1.5 text-[13px]">
      <span className="min-w-0 flex-1 font-medium text-ink">{left}</span>
      <span className="text-xs text-muted">{mid}</span>
      <span className="tabular w-36 text-right">{right}</span>
    </li>
  );
}
