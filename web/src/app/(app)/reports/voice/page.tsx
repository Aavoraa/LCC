"use client";

import { Download, Mic, Pause, Play, Printer, Square, Volume2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Input, PageHeader, Select, Spinner, Td, Th, cx } from "@/components/ui";
import { dateTime, money, qty } from "@/lib/format";
import { useApi, useLocalState } from "@/lib/hooks";
import { LANG_KEY, useSpeaker, useSpeechInput, type Lang } from "@/lib/speech";
import { ITEM_TYPES, type ItemType } from "@/lib/types";
import {
  EXAMPLES, STATUS_LABEL, TYPE_LABEL, UI, describeFilters, helpSentence, notUnderstood, parseCommand, rowSentence, summarySentence,
  type Command, type ReportFilters, type StockReport, type StockReportRow, type StockStatus,
} from "@/lib/voiceReport";

function reportPath(f: ReportFilters) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const s = p.toString();
  return `/api/reports/stock${s ? `?${s}` : ""}`;
}

function understood(cmd: Command, lang: Lang) {
  const t = UI[lang];
  if (cmd.kind === "stop") return t.stop;
  if (cmd.kind === "pause") return t.pause;
  if (cmd.kind === "resume") return t.resume;
  if (cmd.kind === "help") return lang === "ta" ? "உதவி" : "Help";
  if (cmd.kind === "read") return cmd.read ? t.readAll : t.readSummary;
  if (cmd.kind === "report") return describeFilters(cmd.filters, lang) + (cmd.read ? ` · ${t.readAll}` : "");
  return "?";
}

const STATUS_TONE = { OUT: "danger", LOW: "warning", OK: "success" } as const;

function downloadCsv(rows: StockReportRow[], lang: Lang) {
  const t = UI[lang];
  const head = [t.code, t.item, t.type, "Category", t.locations, t.physical, t.reserved, t.qc, t.available, "UOM", t.status, t.belowMin, t.restock, t.value];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((r) => [
    r.item_code, r.name, TYPE_LABEL[lang][r.item_type], r.category, r.locations.map((l) => `${l.code} (${Number(l.on_hand)})`).join("; ") || r.default_location,
    r.physical, r.reserved, r.qc_hold, r.available, r.uom, STATUS_LABEL[lang][r.stock_status], r.below_min ? "Y" : "", r.restock_qty ?? "", r.valuation,
  ].map(esc).join(","));
  const blob = new Blob(["﻿" + [head.map(esc).join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" }); // BOM: Excel reads Tamil
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `stock-report-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function VoiceReportPage() {
  const [lang, setLang] = useLocalState<Lang>(LANG_KEY, "en");
  const [rate, setRate] = useLocalState<number>("lm_voice_rate", 1);
  const t = UI[lang];
  const [filters, setFilters] = useState<ReportFilters>({});
  const [draft, setDraft] = useState({ q: "", location: "" });
  const path = reportPath(filters);
  const report = useApi<StockReport>(path);
  const speaker = useSpeaker(lang, rate);
  const [heard, setHeard] = useState<{ text: string; meaning: string } | null>(null);
  const [typed, setTyped] = useState("");
  // A command waits for the report it asked for (new data object), then reads it.
  const [pending, setPending] = useState<{ read: boolean; lang: Lang; after: StockReport | undefined; filters: ReportFilters } | null>(null);
  const [readingRows, setReadingRows] = useState<StockReportRow[] | null>(null);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());

  const readReport = useCallback((data: StockReport, f: ReportFilters, l: Lang, all: boolean) => {
    const parts = [summarySentence(data, f, l, all && data.rows.length > 0)];
    if (all) parts.push(...data.rows.map((r, i) => rowSentence(r, i + 1, l)));
    setReadingRows(all ? data.rows : null);
    speaker.speak(parts);
  }, [speaker]);

  useEffect(() => {
    if (!pending) return;
    if (report.error) {
      setPending(null);
      return;
    }
    if (report.data && report.data !== pending.after && !report.loading) {
      readReport(report.data, pending.filters, pending.lang, pending.read);
      setPending(null);
    }
  }, [pending, report.data, report.error, report.loading, readReport]);

  const runCommand = useCallback((text: string) => {
    const cmd = parseCommand(text);
    const l = cmd.lang ?? lang;
    if (cmd.lang && cmd.lang !== lang) setLang(cmd.lang);
    setHeard({ text: cmd.heard, meaning: understood(cmd, l) });
    switch (cmd.kind) {
      case "stop": speaker.stop(); setReadingRows(null); return;
      case "pause": speaker.pause(); return;
      case "resume": speaker.resume(); return;
      case "help": speaker.speak([helpSentence(l)]); return;
      case "none": speaker.speak([notUnderstood(l, cmd.heard)]); return;
      case "read":
        setPending({ read: cmd.read, lang: l, after: report.data, filters });
        report.reload();
        return;
      case "report":
        setPending({ read: cmd.read, lang: l, after: report.data, filters: cmd.filters });
        setDraft({ q: cmd.filters.q ?? "", location: cmd.filters.location ?? "" });
        if (reportPath(cmd.filters) === path) report.reload();
        else setFilters(cmd.filters);
    }
  }, [lang, setLang, speaker, report, filters, path]);

  const mic = useSpeechInput(lang, runCommand);

  const currentRowId = readingRows && speaker.speaking && speaker.index > 0 ? readingRows[speaker.index - 1]?.id : undefined;
  useEffect(() => {
    if (currentRowId != null) rowRefs.current.get(currentRowId)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentRowId]);

  const setFilter = (patch: ReportFilters) => {
    const next = { ...filters, ...patch };
    for (const k of Object.keys(next) as (keyof ReportFilters)[]) if (!next[k]) delete next[k];
    setFilters(next);
  };
  const data = report.data;
  const s = data?.summary;
  const noTamilVoice = lang === "ta" && speaker.supported && speaker.voicesLoaded && !speaker.hasVoice;

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.subtitle}
        actions={<>
          <div className="no-print inline-flex rounded-md border border-line-strong p-0.5" role="group" aria-label="Language">
            {(["en", "ta"] as Lang[]).map((l) => (
              <button key={l} onClick={() => { speaker.stop(); setLang(l); }} aria-pressed={lang === l}
                className={cx("rounded px-3 py-1 text-sm font-medium", lang === l ? "bg-primary text-white" : "text-ink-2 hover:bg-surface-2")}>
                {l === "en" ? "English" : "தமிழ்"}
              </button>
            ))}
          </div>
          <Button variant="secondary" className="no-print" icon={<Printer className="size-4" />} onClick={() => window.print()}>{t.print}</Button>
          <Button variant="secondary" className="no-print" icon={<Download className="size-4" />} disabled={!data?.rows.length} onClick={() => data && downloadCsv(data.rows, lang)}>{t.csv}</Button>
        </>}
      />

      <Card className="no-print mb-5">
        <div className="grid gap-5 p-4 lg:grid-cols-[auto_1fr]">
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={() => (mic.listening ? mic.stop() : (speaker.stop(), mic.start()))}
              aria-label={mic.listening ? t.listening : t.speak}
              className={cx("relative grid size-24 place-items-center rounded-full text-white shadow-card transition-colors",
                mic.listening ? "bg-danger" : "bg-primary hover:bg-primary-hover")}
            >
              {mic.listening && <span className="absolute inset-0 animate-ping rounded-full bg-danger/40" aria-hidden />}
              <Mic className="relative size-10" />
            </button>
            <span className="text-sm font-medium text-ink-2">{mic.listening ? t.listening : t.speak}</span>
          </div>

          <div className="min-w-0 space-y-3">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) { runCommand(typed); setTyped(""); } }}>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t.typeCommand} aria-label={t.typeCommand} />
              <Button type="submit" variant="secondary">{t.run}</Button>
            </form>
            {(mic.listening && mic.interim) || heard ? (
              <p className="text-sm">
                <span className="text-muted">{t.heard}: </span>
                <span className="font-medium text-ink">“{mic.listening && mic.interim ? mic.interim : heard?.text}”</span>
                {!mic.listening && heard && <Badge tone={heard.meaning === "?" ? "danger" : "primary"} className="ml-2">{heard.meaning}</Badge>}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">{t.tryThese}:</span>
              {EXAMPLES[lang].map((ex) => (
                <button key={ex} onClick={() => runCommand(ex)} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-2 hover:border-primary hover:text-primary">{ex}</button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <Button size="sm" icon={<Volume2 className="size-4" />} disabled={!data || !speaker.supported} onClick={() => data && readReport(data, filters, lang, false)}>{t.readSummary}</Button>
              <Button size="sm" variant="secondary" icon={<Play className="size-4" />} disabled={!data?.rows.length || !speaker.supported} onClick={() => data && readReport(data, filters, lang, true)}>{t.readAll}</Button>
              {speaker.speaking && (speaker.paused
                ? <Button size="sm" variant="secondary" icon={<Play className="size-4" />} onClick={speaker.resume}>{t.resume}</Button>
                : <Button size="sm" variant="secondary" icon={<Pause className="size-4" />} onClick={speaker.pause}>{t.pause}</Button>)}
              {speaker.speaking && <Button size="sm" variant="danger" icon={<Square className="size-4" />} onClick={() => { speaker.stop(); setReadingRows(null); }}>{t.stop}</Button>}
              <label className="ml-auto flex items-center gap-2 text-xs text-muted">
                {t.speed}
                <Select value={String(rate)} onChange={(e) => setRate(Number(e.target.value))} className="h-8 w-20">
                  {[0.75, 1, 1.25, 1.5].map((r) => <option key={r} value={r}>{r}×</option>)}
                </Select>
              </label>
            </div>
            {speaker.voiceName && <p className="text-[11px] text-muted">Voice: {speaker.voiceName}</p>}
            {mic.error && <Alert tone="warning">{mic.error}</Alert>}
            {!mic.supported && <Alert tone="info">{t.noRecognition}</Alert>}
            {noTamilVoice && (
              <Alert tone="warning">
                {UI.ta.noVoice}
                <span className="mt-1 block text-xs">No Tamil voice on this device. Use Microsoft Edge, or add Tamil (with speech) in Windows Settings → Time &amp; language → Language &amp; region. Android Chrome includes a Tamil voice.</span>
              </Alert>
            )}
            {lang === "ta" && <p className="text-xs text-muted">{t.tamilSearchHint}</p>}
          </div>
        </div>
      </Card>

      <div className="no-print mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <form onSubmit={(e) => { e.preventDefault(); setFilter({ q: draft.q.trim() || undefined }); }}>
          <Input value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} onBlur={() => setFilter({ q: draft.q.trim() || undefined })} placeholder={t.search} aria-label={t.search} />
        </form>
        <Select value={filters.item_type ?? ""} onChange={(e) => setFilter({ item_type: (e.target.value || undefined) as ItemType | undefined })} aria-label={t.type}>
          <option value="">{t.allTypes}</option>
          {ITEM_TYPES.filter((x) => x.value !== "SERVICE").map((x) => <option key={x.value} value={x.value}>{TYPE_LABEL[lang][x.value]}</option>)}
        </Select>
        <Select value={filters.stock_status ?? ""} onChange={(e) => setFilter({ stock_status: (e.target.value || undefined) as StockStatus | undefined })} aria-label={t.status}>
          <option value="">{t.allStatus}</option>
          {(["OUT", "LOW", "MIN", "OK"] as StockStatus[]).map((x) => <option key={x} value={x}>{STATUS_LABEL[lang][x]}</option>)}
        </Select>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setFilter({ location: draft.location.trim() || undefined }); }}>
          <Input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} onBlur={() => setFilter({ location: draft.location.trim() || undefined })} placeholder={t.location} aria-label={t.location} />
          {Object.keys(filters).length > 0 && <Button type="button" variant="ghost" onClick={() => { setFilters({}); setDraft({ q: "", location: "" }); }}>{t.clear}</Button>}
        </form>
      </div>

      <div className="hidden print:mb-3 print:block">
        <h2 className="text-lg font-semibold">{t.title} — {describeFilters(filters, lang)}</h2>
        {data && <p className="text-xs">{t.generated}: {dateTime(data.generated_at)}</p>}
      </div>

      {s && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {([
            [t.items, s.items, undefined, "neutral"],
            [t.out, s.out, "OUT", "danger"],
            [t.low, s.low, "LOW", "warning"],
            [t.belowMin, s.below_min, "MIN", "warning"],
            [t.ok, s.ok, "OK", "success"],
          ] as [string, number, StockStatus | undefined, string][]).map(([label, value, status, tone]) => (
            <button key={label} onClick={() => setFilter({ stock_status: status })} disabled={!status && !filters.stock_status}
              className={cx("rounded-lg border bg-surface p-3 text-left shadow-card transition-colors hover:border-line-strong",
                filters.stock_status && filters.stock_status === status ? "border-primary" : "border-line")}>
              <p className="text-xs text-muted">{label}</p>
              <p className={cx("tabular text-xl font-semibold", tone === "danger" && "text-danger", tone === "warning" && "text-warning", tone === "success" && "text-success")}>{value}</p>
            </button>
          ))}
          <div className="rounded-lg border border-line bg-surface p-3 shadow-card">
            <p className="text-xs text-muted">{t.value}</p>
            <p className="tabular text-xl font-semibold">{money(s.valuation)}</p>
          </div>
        </div>
      )}

      <Card className="overflow-hidden">
        <CardHeader title={`${t.title} — ${describeFilters(filters, lang)}`} subtitle={data ? `${t.generated} ${dateTime(data.generated_at)}` : undefined}
          className="print:hidden" actions={report.loading && data ? <Spinner label="" /> : undefined} />
        {report.error ? <ErrorState error={report.error} onRetry={report.reload} /> : !data ? <Spinner /> : data.rows.length === 0 ? <EmptyState title={t.none} /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-[13px]">
              <thead><tr>
                <Th>#</Th><Th>{t.code}</Th><Th>{t.item}</Th><Th>{t.type}</Th><Th>{t.locations}</Th>
                <Th className="text-right">{t.physical}</Th><Th className="text-right">{t.reserved}</Th><Th className="text-right">{t.qc}</Th>
                <Th className="text-right">{t.available}</Th><Th>{t.status}</Th><Th className="text-right">{t.restock}</Th><Th className="no-print" />
              </tr></thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={r.id} ref={(el) => { if (el) rowRefs.current.set(r.id, el); else rowRefs.current.delete(r.id); }}
                    className={cx("align-top", currentRowId === r.id ? "bg-primary-soft" : "hover:bg-surface-2")}>
                    <Td className="tabular py-2 text-xs text-muted">{i + 1}</Td>
                    <Td className="py-2"><Link href={`/locator?item=${r.id}`} className="font-mono text-xs font-semibold text-primary">{r.item_code}</Link></Td>
                    <Td className="py-2"><span className="text-ink">{r.name}</span>{r.category && <span className="block text-[11px] text-muted">{r.category}</span>}</Td>
                    <Td className="py-2 text-xs">{TYPE_LABEL[lang][r.item_type]}</Td>
                    <Td className="py-2 font-mono text-xs">
                      {r.locations.length ? r.locations.map((l) => <span key={l.code} className="block">{l.code} <span className="text-muted">({qty(l.on_hand)})</span></span>)
                        : <span className="text-muted">{r.default_location ?? "—"}</span>}
                    </Td>
                    <Td className="tabular py-2 text-right">{qty(r.physical)}</Td>
                    <Td className="tabular py-2 text-right">{qty(r.reserved)}</Td>
                    <Td className="tabular py-2 text-right">{qty(r.qc_hold)}</Td>
                    <Td className="tabular py-2 text-right font-semibold text-ink">{qty(r.available)} <span className="text-[11px] font-normal text-muted">{r.uom}</span></Td>
                    <Td className="py-2">
                      <Badge tone={STATUS_TONE[r.stock_status]} dot>{STATUS_LABEL[lang][r.stock_status]}</Badge>
                      {r.below_min && <Badge tone="warning" className="ml-1">{STATUS_LABEL[lang].MIN}</Badge>}
                    </Td>
                    <Td className="tabular py-2 text-right">{r.restock_qty ? qty(r.restock_qty) : "—"}</Td>
                    <Td className="no-print py-1">
                      <button onClick={() => { setReadingRows(null); speaker.speak([rowSentence(r, i + 1, lang)]); }} className="rounded p-1.5 text-muted hover:bg-surface-3 hover:text-primary" aria-label={`Read ${r.name} aloud`}>
                        <Volume2 className="size-4" />
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
