"use client";

/**
 * Offline capture queue. Entries carry their own txn_uuid so the server can de-duplicate,
 * and stay visibly PENDING until the server confirms them — never shown as stock.
 */
import { api } from "./api";

const KEY = "lm_offline_queue";

export interface QueuedTxn {
  body: Record<string, unknown> & { txn_uuid: string };
  label: string;
  queued_at: string;
  status: "PENDING" | "REJECTED";
  error?: string;
}

export function readQueue(): QueuedTxn[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

function write(q: QueuedTxn[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(q));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("lm:queue"));
}

export function enqueue(body: QueuedTxn["body"], label: string) {
  write([...readQueue().filter((q) => q.body.txn_uuid !== body.txn_uuid), { body, label, queued_at: new Date().toISOString(), status: "PENDING" }]);
}

export function discard(txn: string) {
  write(readQueue().filter((q) => q.body.txn_uuid !== txn));
}

export async function syncQueue(): Promise<{ confirmed: number; rejected: number }> {
  const queue = readQueue().filter((q) => q.status === "PENDING");
  if (!queue.length) return { confirmed: 0, rejected: 0 };
  const res = await api<{ results: { txn_uuid: string; status: string; error?: string }[] }>("/api/stock/movements/sync", {
    method: "POST",
    json: queue.map((q) => q.body),
  });
  const byId = new Map(res.results.map((r) => [r.txn_uuid, r]));
  let confirmed = 0;
  let rejected = 0;
  const next = readQueue().flatMap((q) => {
    const r = byId.get(q.body.txn_uuid);
    if (!r) return [q];
    if (r.status === "REJECTED") {
      rejected++;
      return [{ ...q, status: "REJECTED" as const, error: r.error }];
    }
    confirmed++;
    return [];
  });
  write(next);
  return { confirmed, rejected };
}
