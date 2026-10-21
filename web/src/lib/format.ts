const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });

export const money = (v: string | number | null | undefined, decimals = false) =>
  v == null ? "—" : (decimals ? inr2 : inr).format(Number(v));
export const qty = (v: string | number | null | undefined) => (v == null ? "—" : num.format(Number(v)));

export function compactMoney(v: string | number) {
  const n = Number(v);
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return inr.format(n);
}

export const dateFmt = (v: string | null | undefined) =>
  v ? new Date(v.length === 10 ? `${v}T00:00:00` : v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";

export const dateTime = (v: string) =>
  new Date(v.endsWith("Z") || v.includes("+") ? v : `${v}Z`).toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });

export const MOVEMENT_LABEL: Record<string, string> = {
  OPENING: "Opening", RECEIPT: "Receipt", ISSUE: "Issue", TRANSFER: "Transfer", RETURN: "Return",
  ADJUSTMENT_IN: "Adjustment +", ADJUSTMENT_OUT: "Adjustment −", QC_HOLD: "QC hold", QC_RELEASE: "QC release",
};
export const isInbound = (t: string) => ["OPENING", "RECEIPT", "RETURN", "ADJUSTMENT_IN"].includes(t);
export const isOutbound = (t: string) => ["ISSUE", "ADJUSTMENT_OUT"].includes(t);
