"use client";

import { ArrowLeft, Printer } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Alert, Button, Card, ErrorState, Field, PageHeader, Select, Spinner, cx } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { Label } from "@/lib/types";

const SIZES = {
  "50x25": { label: "50 × 25 mm (bin label)", w: "50mm", h: "25mm", qr: "21mm", cols: 4 },
  "75x50": { label: "75 × 50 mm (package)", w: "75mm", h: "50mm", qr: "38mm", cols: 2 },
  "100x50": { label: "100 × 50 mm (large)", w: "100mm", h: "50mm", qr: "42mm", cols: 2 },
} as const;

export default function PrintPage() {
  return <Suspense><Print /></Suspense>;
}

function Print() {
  const ids = (useSearchParams().get("ids") ?? "").split(",").map(Number).filter(Boolean);
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [size, setSize] = useState<keyof typeof SIZES>("75x50");
  const [copies, setCopies] = useState(1);
  const key = ids.join(",");

  useEffect(() => {
    if (!key) return;
    api<Label[]>("/api/qr/labels", { method: "POST", json: { item_ids: key.split(",").map(Number) } }).then(setLabels).catch(setError);
  }, [key]);

  async function print() {
    await api("/api/qr/labels", { method: "POST", json: { item_ids: ids, mark_printed: true } }).catch(() => {});
    window.print();
  }

  if (!ids.length) return <Alert tone="warning">Select items to print from Inventory or QR Code Management.</Alert>;
  if (error) return <ErrorState error={error} />;
  if (!labels) return <Spinner label="Preparing labels…" />;
  const s = SIZES[size];
  const created = labels.filter((l) => l.created).length;

  return (
    <>
      <div className="no-print">
        <PageHeader title="Print QR labels" description={`${labels.length} item${labels.length === 1 ? "" : "s"} · preview below matches the printed output`}
          actions={<><Link href="/qr"><Button variant="secondary" icon={<ArrowLeft className="size-4" />}>Back</Button></Link><Button icon={<Printer className="size-4" />} onClick={print}>Print</Button></>} />
        {created > 0 && <div className="mb-4"><Alert tone="info">{created} item{created === 1 ? " had" : "s had"} no QR — one was generated. Existing QR codes were reused unchanged.</Alert></div>}
        <Card className="mb-5 flex flex-wrap items-end gap-4 p-4">
          <Field label="Label size"><Select value={size} onChange={(e) => setSize(e.target.value as keyof typeof SIZES)} className="w-60">
            {Object.entries(SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select></Field>
          <Field label="Copies per item"><Select value={copies} onChange={(e) => setCopies(Number(e.target.value))} className="w-28">
            {[1, 2, 3, 4, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
          <p className="pb-2 text-xs text-muted">Tip: set the printer margin to none and scale to 100%.</p>
        </Card>
      </div>
      <div className="rounded-lg border border-dashed border-line-strong bg-white p-4 print:border-0 print:p-0">
        <div className="flex flex-wrap gap-[3mm]">
          {labels.flatMap((l) => Array.from({ length: copies }, (_, i) => (
            <div key={`${l.item_id}-${i}`} className="flex items-center gap-[2.5mm] overflow-hidden rounded-[1.5mm] border border-black/70 bg-white p-[2mm] text-black break-inside-avoid"
                 style={{ width: s.w, height: s.h }}>
              <div className="shrink-0 [&>svg]:h-full [&>svg]:w-full" style={{ width: s.qr, height: s.qr }} dangerouslySetInnerHTML={{ __html: l.svg }} />
              <div className="min-w-0 flex-1 leading-tight">
                <p className={cx("font-mono font-bold", size === "50x25" ? "text-[8pt]" : "text-[11pt]")}>{l.item_code}</p>
                <p className={cx("mt-[1mm] line-clamp-3 font-medium", size === "50x25" ? "text-[6pt]" : "text-[8.5pt]")}>{l.name}</p>
                {size !== "50x25" && <p className="mt-[1.5mm] text-[7pt] text-black/70">{l.uom}{l.location ? ` · ${l.location}` : ""}</p>}
                {size !== "50x25" && <p className="mt-[1mm] text-[6pt] text-black/60">Lakshmi Machine</p>}
              </div>
            </div>
          )))}
        </div>
      </div>
    </>
  );
}
