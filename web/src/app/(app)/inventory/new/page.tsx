"use client";

import { CheckCircle2, Download, Printer, ScanLine } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { QrImage } from "@/components/QrImage";
import { Alert, Badge, Button, Card, CardHeader, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { api, ApiError, download } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { ITEM_TYPES, type Category, type ItemDetail, type Location, type Supplier, type Uom } from "@/lib/types";

interface Dup { item_id: number; item_code: string; name: string; make_model: string | null; score: number; reason: string }

const EMPTY = {
  item_code: "", name: "", description: "", item_type: "PURCHASED_ITEM", category_id: "", subcategory_id: "", uom_id: "", manufacturer: "", supplier_id: "",
  make_model: "", specifications: "", min_stock: "0", reorder_level: "0", max_stock: "0", restock_order_qty: "0", default_location_id: "", tracking: "NONE",
  valuation_method: "WEIGHTED_AVERAGE", hsn_code: "", gst_rate: "", purchase_lead_days: "", production_lead_days: "0", opening_qty: "", opening_unit_cost: "",
};

export default function NewItemPage() {
  const { can } = useAuth();
  const uoms = useApi<Uom[]>("/api/masters/uoms");
  const cats = useApi<Category[]>("/api/masters/categories");
  const locs = useApi<Location[]>("/api/masters/locations");
  const sups = useApi<Supplier[]>("/api/masters/suppliers");
  const [f, setF] = useState(EMPTY);
  const [dups, setDups] = useState<Dup[]>([]);
  const [confirmDup, setConfirmDup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ItemDetail | null>(null);
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    if (f.name.trim().length < 3) { setDups([]); return; }
    const t = setTimeout(() => {
      const s = new URLSearchParams({ name: f.name });
      if (f.make_model) s.set("make_model", f.make_model);
      if (f.manufacturer) s.set("manufacturer", f.manufacturer);
      api<Dup[]>(`/api/items/duplicate-check?${s}`).then(setDups).catch(() => setDups([]));
    }, 350);
    return () => clearTimeout(t);
  }, [f.name, f.make_model, f.manufacturer]);

  useEffect(() => {
    if (!f.uom_id && uoms.data?.length) setF((x) => ({ ...x, uom_id: String(uoms.data!.find((u) => u.code === "NOS")?.id ?? uoms.data![0].id) }));
  }, [uoms.data, f.uom_id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const num = (v: string) => (v === "" ? null : v);
    const int = (v: string) => (v === "" ? null : Number(v));
    try {
      const res = await api<ItemDetail>("/api/items", {
        method: "POST",
        json: {
          item_code: num(f.item_code), name: f.name, description: num(f.description), item_type: f.item_type, category_id: int(f.category_id), subcategory_id: int(f.subcategory_id),
          uom_id: Number(f.uom_id), manufacturer: num(f.manufacturer), supplier_id: int(f.supplier_id), make_model: num(f.make_model),
          specifications: num(f.specifications), min_stock: f.min_stock || "0", reorder_level: f.reorder_level || "0", max_stock: f.max_stock || "0", restock_order_qty: f.restock_order_qty || "0",
          default_location_id: int(f.default_location_id), tracking: f.tracking, valuation_method: f.valuation_method, hsn_code: num(f.hsn_code),
          gst_rate: num(f.gst_rate), purchase_lead_days: int(f.purchase_lead_days), production_lead_days: Number(f.production_lead_days || 0),
          opening_qty: num(f.opening_qty), opening_unit_cost: num(f.opening_unit_cost), allow_duplicate: confirmDup,
        },
      });
      setCreated(res);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const { item, qr } = created;
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-6 text-center">
          <CheckCircle2 className="mx-auto size-10 text-success" />
          <h1 className="mt-3 text-lg font-semibold">Item created</h1>
          <p className="mt-1 text-sm text-muted">The QR label is ready. It carries only an opaque identifier — no cost or supplier data.</p>
          <div className="mx-auto mt-5 w-fit rounded-lg border border-line bg-white p-4 text-left text-black">
            {qr && <QrImage itemId={item.id} token={qr.token} className="mx-auto size-40" />}
            <p className="mt-2 text-center font-mono text-sm font-bold">{item.item_code}</p>
            <p className="max-w-48 text-center text-xs">{item.name}</p>
          </div>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link href={`/qr/print?ids=${item.id}`}><Button icon={<Printer className="size-4" />}>Preview & print label</Button></Link>
            <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => download(`/api/items/${item.id}/qr.png?scale=12`, `${item.item_code}.png`)}>PNG</Button>
            <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => download(`/api/items/${item.id}/qr.svg`, `${item.item_code}.svg`)}>SVG</Button>
            <Link href={`/scan?item=${item.id}`}><Button variant="secondary" icon={<ScanLine className="size-4" />}>Receive stock</Button></Link>
          </div>
          <div className="mt-6 flex justify-center gap-4 border-t border-line pt-4 text-sm">
            <button className="font-medium text-primary hover:underline" onClick={() => { setCreated(null); setF({ ...EMPTY, uom_id: f.uom_id }); setConfirmDup(false); }}>Add another item</button>
            <Link href={`/inventory?item=${item.id}`} className="font-medium text-primary hover:underline">Open in inventory</Link>
          </div>
        </Card>
      </div>
    );
  }

  const topCats = cats.data?.filter((c) => !c.parent_id) ?? [];
  const subCats = cats.data?.filter((c) => c.parent_id && String(c.parent_id) === f.category_id) ?? [];

  return (
    <form onSubmit={submit}>
      <PageHeader title="Add new item" description="A QR label is generated on save. Keep your existing item number (e.g. Oracle M502940160), or leave it blank for the next code."
        actions={<><Link href="/inventory"><Button type="button" variant="secondary">Cancel</Button></Link><Button type="submit" loading={busy}>Save item & generate QR</Button></>} />
      {error && <div className="mb-4"><Alert title="Could not save">{error}</Alert></div>}
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card>
            <CardHeader title="Identity" subtitle="The item code never changes once saved." />
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <Field label="Item number" hint="Existing / Oracle item no. — blank assigns the next PI-, RM-… code" className="sm:col-span-2">
                <Input value={f.item_code} onChange={(e) => setF({ ...f, item_code: e.target.value.toUpperCase() })} maxLength={32} placeholder="e.g. M502940160 or A401112106" className="font-mono" />
              </Field>
              <Field label="Item name" required className="sm:col-span-2"><Input value={f.name} onChange={set("name")} required minLength={2} placeholder="e.g. Deep Groove Ball Bearing 6205-2RS" /></Field>
              <Field label="Item type" required>
                <Select value={f.item_type} onChange={set("item_type")}>{ITEM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select>
              </Field>
              <Field label="Unit of measurement" required>
                <Select value={f.uom_id} onChange={set("uom_id")} required>{uoms.data?.map((u) => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}</Select>
              </Field>
              <Field label="Category">
                <Select value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value, subcategory_id: "" })}>
                  <option value="">—</option>{topCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="Subcategory">
                <Select value={f.subcategory_id} onChange={set("subcategory_id")} disabled={!subCats.length}>
                  <option value="">{subCats.length ? "—" : "No subcategories"}</option>{subCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="Description" className="sm:col-span-2"><Textarea value={f.description} onChange={set("description")} rows={2} /></Field>
            </div>
          </Card>
          <Card>
            <CardHeader title="Make & specification" />
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <Field label="Manufacturer"><Input value={f.manufacturer} onChange={set("manufacturer")} /></Field>
              <Field label="Make / model"><Input value={f.make_model} onChange={set("make_model")} /></Field>
              <Field label="Preferred supplier">
                <Select value={f.supplier_id} onChange={set("supplier_id")}><option value="">—</option>{sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
              </Field>
              <Field label="Purchase lead time (days)" hint="Blank uses the supplier's lead time"><Input type="number" min={0} value={f.purchase_lead_days} onChange={set("purchase_lead_days")} /></Field>
              <Field label="Technical specifications" className="sm:col-span-2"><Textarea value={f.specifications} onChange={set("specifications")} rows={3} /></Field>
            </div>
          </Card>
          <Card>
            <CardHeader title="Stock control & storage" />
            <div className="grid gap-4 p-4 sm:grid-cols-3">
              <Field label="Minimum stock"><Input type="number" min={0} step="any" value={f.min_stock} onChange={set("min_stock")} /></Field>
              <Field label="Reorder level"><Input type="number" min={0} step="any" value={f.reorder_level} onChange={set("reorder_level")} /></Field>
              <Field label="Maximum stock"><Input type="number" min={0} step="any" value={f.max_stock} onChange={set("max_stock")} /></Field>
              <Field label="Restock order qty" hint="Ordered when stock reaches the minimum; 0 = refill to max"><Input type="number" min={0} step="any" value={f.restock_order_qty} onChange={set("restock_order_qty")} /></Field>
              <Field label="Default location (rack / bin)" className="sm:col-span-2">
                <Select value={f.default_location_id} onChange={set("default_location_id")}><option value="">—</option>{locs.data?.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</Select>
              </Field>
              <Field label="Tracking">
                <Select value={f.tracking} onChange={set("tracking")}><option value="NONE">None</option><option value="BATCH">Batch</option><option value="SERIAL">Serial</option></Select>
              </Field>
              <Field label="Valuation method">
                <Select value={f.valuation_method} onChange={set("valuation_method")}><option value="WEIGHTED_AVERAGE">Weighted average</option><option value="FIFO" disabled>FIFO (not yet supported)</option></Select>
              </Field>
              {(f.item_type === "PROCESSED_SPARE" || f.item_type === "FINISHED_GOOD") && (
                <Field label="Production lead time (days)" hint="Used by the delivery estimator"><Input type="number" min={0} value={f.production_lead_days} onChange={set("production_lead_days")} /></Field>
              )}
            </div>
          </Card>
        </div>
        <div className="space-y-5">
          <Card className={dups.length ? "border-warning/50" : ""}>
            <CardHeader title="Duplicate check" subtitle="Matches by normalized name and make/model" />
            <div className="p-4">
              {dups.length === 0 ? <p className="text-sm text-muted">{f.name.length < 3 ? "Start typing a name to check for duplicates." : "No similar items found."}</p> : (
                <>
                  <ul className="space-y-2">
                    {dups.map((d) => (
                      <li key={d.item_id} className="rounded-md border border-line p-2.5 text-sm">
                        <div className="flex items-center justify-between"><Link href={`/inventory?item=${d.item_id}`} target="_blank" className="font-mono text-xs font-semibold text-primary">{d.item_code}</Link><Badge tone="warning">{Math.round(d.score * 100)}%</Badge></div>
                        <p className="mt-0.5 text-ink">{d.name}</p>
                        <p className="text-xs text-muted">{d.reason}</p>
                      </li>
                    ))}
                  </ul>
                  {can("items.duplicate_override") ? (
                    <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={confirmDup} onChange={(e) => setConfirmDup(e.target.checked)} />I reviewed these and this is a different item.</label>
                  ) : <p className="mt-3 text-xs text-warning">Saving will be blocked. Use the existing item, or ask an authorized user to override.</p>}
                </>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title="Tax" />
            <div className="grid grid-cols-2 gap-4 p-4">
              <Field label="HSN / SAC"><Input value={f.hsn_code} onChange={set("hsn_code")} inputMode="numeric" pattern="[0-9]{4,8}" /></Field>
              <Field label="GST %"><Select value={f.gst_rate} onChange={set("gst_rate")}><option value="">—</option>{["0", "5", "12", "18", "28"].map((g) => <option key={g} value={g}>{g}%</option>)}</Select></Field>
            </div>
          </Card>
          {can("stock.receive") && (
            <Card>
              <CardHeader title="Opening balance" subtitle="Posted to the ledger as a receipt at the default location" />
              <div className="grid grid-cols-2 gap-4 p-4">
                <Field label="Quantity"><Input type="number" min={0} step="any" value={f.opening_qty} onChange={set("opening_qty")} /></Field>
                <Field label="Unit cost (₹)"><Input type="number" min={0} step="any" value={f.opening_unit_cost} onChange={set("opening_unit_cost")} /></Field>
              </div>
            </Card>
          )}
        </div>
      </div>
    </form>
  );
}
