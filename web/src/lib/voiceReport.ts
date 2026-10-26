// Voice stock report: understands spoken / typed commands in English and Tamil, and turns report data into
// sentences to read aloud in either language.

import type { Lang } from "./speech";
import type { ItemType } from "./types";

export type StockStatus = "OK" | "LOW" | "OUT" | "MIN";

export interface ReportFilters {
  q?: string;
  item_type?: ItemType;
  stock_status?: StockStatus;
  location?: string;
}

export interface StockReportRow {
  id: number;
  item_code: string;
  name: string;
  item_type: ItemType;
  category: string | null;
  uom: string;
  default_location: string | null;
  locations: { code: string; on_hand: string; available: string }[];
  physical: string;
  reserved: string;
  qc_hold: string;
  available: string;
  min_stock: string;
  reorder_level: string;
  max_stock: string;
  avg_cost: string;
  valuation: string;
  stock_status: "OK" | "LOW" | "OUT";
  below_min: boolean;
  restock_qty: string | null;
}

export interface StockReport {
  generated_at: string;
  summary: { items: number; out: number; low: number; ok: number; below_min: number; valuation: string; by_type: Record<string, number> };
  rows: StockReportRow[];
}

export type CommandKind = "report" | "read" | "stop" | "pause" | "resume" | "help" | "none";

export interface Command {
  kind: CommandKind;
  heard: string;
  filters: ReportFilters;
  read: boolean; // read every item, not only the summary
  lang?: Lang;
}

// ------------------------------------------------------------------ labels
export const UI: Record<Lang, Record<string, string>> = {
  en: {
    title: "Voice Stock Report",
    subtitle: "Every stores item with stock by location. Speak or type a command; the report is read aloud.",
    speak: "Tap and speak",
    listening: "Listening…",
    typeCommand: "Or type a command, e.g. low stock raw materials",
    run: "Run",
    heard: "Heard",
    tryThese: "Try saying",
    readSummary: "Read summary",
    readAll: "Read every item",
    pause: "Pause",
    resume: "Resume",
    stop: "Stop",
    speed: "Speed",
    search: "Search item, code, make",
    allTypes: "All item types",
    allStatus: "All stock status",
    location: "Location (e.g. R01)",
    clear: "Clear",
    items: "Items",
    out: "Out of stock",
    low: "Low stock",
    belowMin: "Below minimum",
    ok: "In stock",
    value: "Stock value",
    code: "Code",
    item: "Item",
    type: "Type",
    locations: "Location",
    physical: "On hand",
    reserved: "Reserved",
    qc: "QC hold",
    available: "Available",
    status: "Status",
    restock: "Order qty",
    none: "No items match this report.",
    generated: "Generated",
    print: "Print",
    csv: "CSV",
    noRecognition: "Voice commands need Chrome or Edge. You can still type commands and listen to the report.",
    noVoice: "",
    tamilSearchHint: "",
  },
  ta: {
    title: "குரல் இருப்பு அறிக்கை",
    subtitle: "ஒவ்வொரு ஸ்டோர்ஸ் பொருளும், இடம் வாரியான இருப்புடன். கட்டளையைப் பேசவும் அல்லது தட்டச்சு செய்யவும்; அறிக்கை சத்தமாக வாசிக்கப்படும்.",
    speak: "தட்டிப் பேசவும்",
    listening: "கேட்கிறது…",
    typeCommand: "அல்லது கட்டளையைத் தட்டச்சு செய்யவும், எ.கா. குறைவான இருப்பு மூலப்பொருட்கள்",
    run: "இயக்கு",
    heard: "கேட்டது",
    tryThese: "இப்படிச் சொல்லுங்கள்",
    readSummary: "சுருக்கத்தை வாசி",
    readAll: "எல்லாப் பொருட்களையும் வாசி",
    pause: "இடைநிறுத்து",
    resume: "தொடர்",
    stop: "நிறுத்து",
    speed: "வேகம்",
    search: "பொருள், குறியீடு தேடவும்",
    allTypes: "அனைத்து வகைகளும்",
    allStatus: "அனைத்து இருப்பு நிலைகளும்",
    location: "இடம் (எ.கா. R01)",
    clear: "அழி",
    items: "பொருட்கள்",
    out: "இருப்பு இல்லை",
    low: "குறைவான இருப்பு",
    belowMin: "குறைந்தபட்சத்திற்குக் கீழ்",
    ok: "போதுமான இருப்பு",
    value: "இருப்பு மதிப்பு",
    code: "குறியீடு",
    item: "பொருள்",
    type: "வகை",
    locations: "இடம்",
    physical: "கையிருப்பு",
    reserved: "ஒதுக்கப்பட்டது",
    qc: "தரச் சோதனையில்",
    available: "கிடைக்கும்",
    status: "நிலை",
    restock: "ஆர்டர் அளவு",
    none: "இந்த அறிக்கைக்குப் பொருட்கள் எதுவும் இல்லை.",
    generated: "உருவாக்கப்பட்டது",
    print: "அச்சிடு",
    csv: "CSV",
    noRecognition: "குரல் கட்டளைகளுக்கு Chrome அல்லது Edge தேவை. கட்டளையைத் தட்டச்சு செய்தும் அறிக்கையைக் கேட்கலாம்.",
    noVoice: "இந்தக் கணினியில் தமிழ் குரல் இல்லை. Microsoft Edge-ஐப் பயன்படுத்தவும், அல்லது Windows Settings → Time & language → Language & region-இல் தமிழ் (Speech) சேர்க்கவும். Android Chrome-இல் தமிழ் குரல் உள்ளது.",
    tamilSearchHint: "பொருளின் பெயர்கள் ஆங்கிலத்தில் உள்ளன — பெயரைத் தேட, அதைத் தட்டச்சு செய்யவும் அல்லது English-இல் பேசவும்.",
  },
};

export const TYPE_LABEL: Record<Lang, Record<ItemType, string>> = {
  en: {
    RAW_MATERIAL: "Raw materials", PURCHASED_ITEM: "Purchased items", DAILY_CONSUMABLE: "Daily consumables",
    PROCESSED_SPARE: "Processed spares", FINISHED_GOOD: "Finished goods", SERVICE: "Services",
  },
  ta: {
    RAW_MATERIAL: "மூலப்பொருட்கள்", PURCHASED_ITEM: "வாங்கிய பொருட்கள்", DAILY_CONSUMABLE: "தினசரி நுகர்பொருட்கள்",
    PROCESSED_SPARE: "பதப்படுத்திய உதிரிபாகங்கள்", FINISHED_GOOD: "முடிக்கப்பட்ட பொருட்கள்", SERVICE: "சேவைகள்",
  },
};

export const STATUS_LABEL: Record<Lang, Record<StockStatus, string>> = {
  en: { OUT: "Out of stock", LOW: "Low stock", MIN: "Below minimum", OK: "In stock" },
  ta: { OUT: "இருப்பு இல்லை", LOW: "குறைவான இருப்பு", MIN: "குறைந்தபட்சத்திற்குக் கீழ்", OK: "போதுமான இருப்பு" },
};

export const EXAMPLES: Record<Lang, string[]> = {
  en: ["Full stock report", "Out of stock items", "Low stock raw materials", "Below minimum", "Show bearing stock", "Rack 1 stock", "Read all items", "Stop"],
  ta: ["முழு இருப்பு அறிக்கை", "இருப்பு இல்லாத பொருட்கள்", "குறைவான இருப்பு மூலப்பொருட்கள்", "குறைந்தபட்ச அளவு", "ரேக் 1 இருப்பு", "எல்லாவற்றையும் படி", "நிறுத்து"],
};

// ------------------------------------------------------------------ parsing
// English phrases match whole words (optional plural "s"); Tamil phrases match the start of a word so case
// endings (இருப்பை, பொருட்களை …) still match.
const STOP = ["stop", "cancel", "quiet", "silence", "நிறுத்து", "நிறுத்தவும்", "போதும்"];
const PAUSE = ["pause", "wait", "hold on", "இடைநிறுத்து", "காத்திரு"];
const RESUME = ["resume", "continue", "go on", "தொடர்"];
const HELP = ["help", "what can i say", "உதவி"];
const READ = ["read out", "read", "speak", "tell", "say", "list", "படி", "வாசி", "சொல்", "கூறு"];
const ALL = ["everything", "every", "all", "entire", "complete", "full", "whole", "அனைத்து", "எல்லா", "முழு", "மொத்த"];
const TO_TAMIL = ["in tamil", "tamil", "தமிழ"]; // stem: தமிழ், தமிழில்
const TO_ENGLISH = ["in english", "english", "ஆங்கில", "இங்கிலீஷ்"];

const STATUS_WORDS: [StockStatus, string[]][] = [
  ["OUT", ["out of stock", "no stock", "zero stock", "nil stock", "stock out", "stockout", "not available", "unavailable", "empty",
    "இருப்பு இல்லை", "இருப்பில் இல்லை", "இருப்பில்லா", "இருப்பு இல்லா", "ஸ்டாக் இல்லை", "தீர்ந்த", "காலியான"]],
  ["MIN", ["below minimum", "under minimum", "below min", "minimum", "min stock", "குறைந்தபட்ச"]],
  ["LOW", ["low stock", "running low", "low", "shortage", "short", "reorder", "குறைவான", "குறைவு", "குறைந்த", "பற்றாக்குறை", "லோ ஸ்டாக்"]],
  ["OK", ["in stock", "sufficient", "healthy", "okay", "ok", "போதுமான", "இருப்பில் உள்ள"]],
];

const TYPE_WORDS: [ItemType, string[]][] = [
  ["RAW_MATERIAL", ["raw material", "raw", "மூலப்பொரு", "மூலப் பொரு", "ரா மெட்டீரியல்"]],
  ["DAILY_CONSUMABLE", ["daily consumable", "consumable", "நுகர்பொரு", "நுகர்வு", "கன்ஸ்யூமபிள்"]],
  ["PROCESSED_SPARE", ["processed spare", "spare part", "processed", "spare", "உதிரி", "ஸ்பேர்"]],
  ["FINISHED_GOOD", ["finished good", "finished product", "finished", "முடிக்கப்பட்ட", "தயாரான"]],
  ["PURCHASED_ITEM", ["purchased item", "purchased", "bought out", "bought", "வாங்கிய", "வாங்கப்பட்ட", "கொள்முதல்"]],
];

const FILLER = new Set([
  "show", "me", "give", "get", "open", "display", "report", "stock", "item", "items", "product", "products", "of", "the", "a", "an",
  "for", "in", "on", "with", "what", "is", "are", "which", "please", "store", "stores", "inventory", "detail", "details", "status",
  "and", "at", "level", "levels", "how", "much", "many", "quantity", "qty", "position", "now", "today", "current", "my", "our", "us",
  "position", "check", "find", "only", "about", "them", "it", "to", "we", "have", "do", "there", "summary", "material", "materials",
]);
// Word stems (no final vowel sign) so every case ending matches: இருப்ப → இருப்பு, இருப்பை, இருப்பைக் …
const TAMIL_FILLER = ["காட்ட", "காண்பி", "அறிக்க", "இருப்ப", "பொருட்க", "பொருள", "பாக", "ஸ்டாக்", "ரிப்போர்ட்", "எனக்க", "என்ன", "உள்ள",
  "விவர", "நிலை", "ஸ்டோர", "தயவ", "எவ்வளவ", "எத்தனை", "அளவ", "மற்றும்", "இப்போத", "இன்ற", "சுருக்க", "பட்டியல", "எல்லாவற்ற", "கொட"];

const isTamil = (s: string) => /[஀-௿]/.test(s);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function phraseRegex(p: string) {
  return isTamil(p) ? new RegExp(`(^|\\s)${escape(p)}\\S*`, "u") : new RegExp(`(^|\\s)${escape(p)}s?(?=\\s|$)`, "u");
}

/** Removes the first phrase found from ``state.text``; returns whether one matched. */
function take(state: { text: string }, phrases: string[]): boolean {
  for (const p of [...phrases].sort((a, b) => b.length - a.length)) {
    const re = phraseRegex(p);
    if (re.test(state.text)) {
      state.text = state.text.replace(re, " ");
      return true;
    }
  }
  return false;
}

const pad2 = (n: string) => n.padStart(2, "0");

function takeLocation(state: { text: string }): string | undefined {
  let loc = "";
  const rack = /(^|\s)(?:rack|rak|ரேக்|ராக்)\S*\s*(?:r\s*)?(\d{1,3})(?=\s|$)/u.exec(state.text);
  if (rack) {
    loc += `R${pad2(rack[2])}`;
    state.text = state.text.replace(rack[0], " ");
  }
  const bin = /(^|\s)(?:bin|பின்)\S*\s*(?:b\s*)?(\d{1,3})(?=\s|$)/u.exec(state.text);
  if (bin) {
    loc += `B${pad2(bin[2])}`;
    state.text = state.text.replace(bin[0], " ");
  }
  const named = /(^|\s)(?:location|place|இடம்)\S*\s+([a-z]*\d[a-z0-9-]*)(?=\s|$)/u.exec(state.text);
  if (named) {
    loc += named[2].toUpperCase();
    state.text = state.text.replace(named[0], " ");
  }
  return loc || undefined;
}

/** Words left after the command phrases are the item search. Item names are stored in English, so Tamil words
 *  cannot match; they are returned separately so an unrecognised Tamil sentence is reported as not understood. */
function searchText(rest: string): { q?: string; unknownTamil: boolean } {
  const words = rest.split(/\s+/).filter(Boolean);
  const unknownTamil = words.some((w) => isTamil(w) && !TAMIL_FILLER.some((f) => w.startsWith(f)));
  const latin = words.filter((w) => !isTamil(w) && !FILLER.has(w))
    .map((w) => (/^[a-z]{4,}s$/.test(w) && !w.endsWith("ss") ? w.slice(0, -1) : w)); // bearings → bearing
  return { q: latin.join(" ").trim() || undefined, unknownTamil };
}

export function parseCommand(input: string): Command {
  const heard = input.trim();
  const state = { text: ` ${heard.toLowerCase().replace(/[.,!?।"'“”]/g, " ").replace(/\s+/g, " ")} ` };
  const base = { heard, filters: {}, read: false };

  if (take(state, STOP)) return { ...base, kind: "stop" };
  if (take(state, PAUSE)) return { ...base, kind: "pause" };
  if (take(state, RESUME)) return { ...base, kind: "resume" };
  if (take(state, HELP)) return { ...base, kind: "help" };

  let lang: Lang | undefined;
  if (take(state, TO_TAMIL)) lang = "ta";
  else if (take(state, TO_ENGLISH)) lang = "en";

  const filters: ReportFilters = {};
  for (const [status, words] of STATUS_WORDS) {
    if (take(state, words)) {
      filters.stock_status = status;
      break;
    }
  }
  for (const [type, words] of TYPE_WORDS) {
    if (take(state, words)) {
      filters.item_type = type;
      break;
    }
  }
  filters.location = takeLocation(state);
  const all = take(state, ALL);
  const read = take(state, READ);
  const search = searchText(state.text);
  filters.q = search.q;
  if (!filters.location) delete filters.location;
  if (!filters.q) delete filters.q;

  const hasFilter = Object.keys(filters).length > 0;
  if (!hasFilter && read) return { ...base, kind: "read", read: true, lang }; // "read all items" reads the report on screen
  if (hasFilter || all) return { ...base, kind: "report", filters, read, lang };
  if (lang && !search.unknownTamil) return { ...base, kind: "read", read: false, lang }; // language switch: re-read the summary
  return { ...base, kind: "none" };
}

// ------------------------------------------------------------------ speaking
const UNIT: Record<Lang, Record<string, string>> = {
  en: { NOS: "numbers", SET: "sets", BOX: "boxes", KG: "kilograms", MTR: "metres", LTR: "litres" },
  ta: { NOS: "எண்ணிக்கை", SET: "செட்", BOX: "பெட்டி", KG: "கிலோ", MTR: "மீட்டர்", LTR: "லிட்டர்" },
};

const n = (v: string | number | null | undefined) => {
  const x = Number(v ?? 0);
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(3)));
};
const unit = (lang: Lang, uom: string) => UNIT[lang][uom] ?? uom;
const rupees = (v: string | number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(v));

/** "PI-000123" → "P I 123" so the code is spelled out, not read as a word. */
export function spokenCode(code: string) {
  const m = /^([A-Z]+)-0*(\d+)$/.exec(code);
  return m ? `${m[1].split("").join(" ")} ${m[2]}` : code.replace(/-/g, " ");
}

/** "MAIN-R01-B02" → "main store, rack 1, bin 2". */
export function spokenLocation(code: string, lang: Lang) {
  const parts = code.split("-");
  const rack = parts.find((p) => /^R\d+$/i.test(p));
  const bin = parts.find((p) => /^B\d+$/i.test(p));
  if (!rack && !bin) return code.replace(/-/g, " ");
  const wh = parts[0] && parts[0] !== rack ? parts[0] : "";
  const r = rack ? String(Number(rack.slice(1))) : "";
  const b = bin ? String(Number(bin.slice(1))) : "";
  if (lang === "ta") return [wh && `${wh} ஸ்டோர்`, r && `ரேக் ${r}`, b && `பின் ${b}`].filter(Boolean).join(", ");
  return [wh && `${wh.toLowerCase()} store`, r && `rack ${r}`, b && `bin ${b}`].filter(Boolean).join(", ");
}

export function describeFilters(f: ReportFilters, lang: Lang): string {
  const parts: string[] = [];
  if (f.item_type) parts.push(TYPE_LABEL[lang][f.item_type]);
  if (f.stock_status) parts.push(STATUS_LABEL[lang][f.stock_status]);
  if (f.q) parts.push(lang === "ta" ? `"${f.q}" தேடல்` : `matching "${f.q}"`);
  if (f.location) parts.push(lang === "ta" ? `இடம் ${f.location}` : `at location ${f.location}`);
  if (parts.length === 0) return lang === "ta" ? "அனைத்து ஸ்டோர்ஸ் பொருட்கள்" : "all stores items";
  return parts.join(", ");
}

export function summarySentence(r: StockReport, f: ReportFilters, lang: Lang, willReadAll: boolean): string {
  const s = r.summary;
  const scope = describeFilters(f, lang);
  if (lang === "ta") {
    if (s.items === 0) return `இருப்பு அறிக்கை: ${scope}. பொருட்கள் எதுவும் கிடைக்கவில்லை.`;
    return [
      `இருப்பு அறிக்கை: ${scope}.`,
      `மொத்தம் ${s.items} பொருட்கள்.`,
      `${s.out} பொருட்கள் இருப்பு இல்லை. ${s.low} பொருட்கள் குறைவான இருப்பில் உள்ளன. ${s.below_min} பொருட்கள் குறைந்தபட்ச அளவுக்குக் கீழே உள்ளன. ${s.ok} பொருட்கள் போதுமான இருப்பில் உள்ளன.`,
      `மொத்த இருப்பு மதிப்பு ${rupees(s.valuation)} ரூபாய்.`,
      willReadAll ? "இப்போது ஒவ்வொரு பொருளையும் வாசிக்கிறேன்." : "ஒவ்வொரு பொருளையும் கேட்க, 'படி' என்று சொல்லுங்கள்.",
    ].join(" ");
  }
  if (s.items === 0) return `Stock report for ${scope}. No items found.`;
  return [
    `Stock report for ${scope}.`,
    `${s.items} ${s.items === 1 ? "item" : "items"}.`,
    `${s.out} out of stock, ${s.low} low on stock, ${s.below_min} below minimum, and ${s.ok} in stock.`,
    `Total stock value ${rupees(s.valuation)} rupees.`,
    willReadAll ? "Reading every item now." : "Say read, to hear every item.",
  ].join(" ");
}

export function rowSentence(row: StockReportRow, pos: number, lang: Lang): string {
  const u = unit(lang, row.uom);
  const where = row.locations.length ? row.locations.map((l) => spokenLocation(l.code, lang)).join("; ")
    : row.default_location ? spokenLocation(row.default_location, lang) : "";
  const restock = row.restock_qty && Number(row.restock_qty) > 0 ? n(row.restock_qty) : null;
  const held = Number(row.physical) !== Number(row.available);
  if (lang === "ta") {
    return [
      `${pos}. ${spokenCode(row.item_code)}, ${row.name}.`,
      row.stock_status === "OUT" ? "இருப்பு இல்லை." : `கிடைக்கும் இருப்பு ${n(row.available)} ${u}.${held ? ` கையிருப்பு ${n(row.physical)}.` : ""}`,
      row.stock_status === "LOW" ? "குறைவான இருப்பு." : "",
      row.below_min ? "குறைந்தபட்ச அளவுக்குக் கீழே உள்ளது." : "",
      where ? `இடம்: ${where}.` : "",
      restock ? `ஆர்டர் செய்ய வேண்டியது ${restock} ${u}.` : "",
    ].filter(Boolean).join(" ");
  }
  return [
    `${pos}. ${spokenCode(row.item_code)}, ${row.name}.`,
    row.stock_status === "OUT" ? "Out of stock." : `Available ${n(row.available)} ${u}.${held ? ` On hand ${n(row.physical)}.` : ""}`,
    row.stock_status === "LOW" ? "Low stock." : "",
    row.below_min ? "Below minimum stock." : "",
    where ? `Location: ${where}.` : "",
    restock ? `Order ${restock} ${u}.` : "",
  ].filter(Boolean).join(" ");
}

export function helpSentence(lang: Lang) {
  return lang === "ta"
    ? `நீங்கள் சொல்லலாம்: ${EXAMPLES.ta.join(", ")}.`
    : `You can say: ${EXAMPLES.en.join(", ")}.`;
}

export function notUnderstood(lang: Lang, heard: string) {
  return lang === "ta" ? `"${heard}" புரியவில்லை. உதவி என்று சொல்லுங்கள்.` : `Sorry, I did not understand "${heard}". Say help for examples.`;
}

/** Spoken summary for the item locator. */
export function locatorSentence(lang: Lang, d: {
  name: string; code: string; uom: string; available: string; physical: string; status: string;
  locations: string[]; lastReceipt?: { qty: string; date: string; ref: string | null } | null; openPo: string;
}) {
  const u = unit(lang, d.uom);
  const where = d.locations.map((l) => spokenLocation(l, lang)).join("; ");
  const openPo = Number(d.openPo) > 0 ? n(d.openPo) : null;
  if (lang === "ta") {
    return [
      `${d.name}, ${spokenCode(d.code)}.`,
      d.status === "OUT" ? "இருப்பு இல்லை." : `கிடைக்கும் இருப்பு ${n(d.available)} ${u}. கையிருப்பு ${n(d.physical)}.`,
      where ? `இடம்: ${where}.` : "இடம் பதிவு செய்யப்படவில்லை.",
      d.lastReceipt ? `கடைசியாக ${d.lastReceipt.date} அன்று ${n(d.lastReceipt.qty)} ${u} பெறப்பட்டது.` : "",
      openPo ? `கொள்முதல் ஆர்டரில் இன்னும் ${openPo} ${u} வர வேண்டும்.` : "",
    ].filter(Boolean).join(" ");
  }
  return [
    `${d.name}, ${spokenCode(d.code)}.`,
    d.status === "OUT" ? "Out of stock." : `${n(d.available)} ${u} available, ${n(d.physical)} on hand.`,
    where ? `Find it at ${where}.` : "No storage location recorded.",
    d.lastReceipt ? `Last received ${n(d.lastReceipt.qty)} ${u} on ${d.lastReceipt.date}.` : "",
    openPo ? `${openPo} ${u} still due on open purchase orders.` : "",
  ].filter(Boolean).join(" ");
}
