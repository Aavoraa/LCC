import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";

const DEFAULT_URL: string = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? "http://10.0.2.2:8000";
const TOKEN = "lm_token";
const SERVER = "lm_server";
const QUEUE = "lm_queue";

let token: string | null = null;
let baseUrl = DEFAULT_URL;

export async function init() {
  token = await AsyncStorage.getItem(TOKEN);
  baseUrl = (await AsyncStorage.getItem(SERVER)) ?? DEFAULT_URL;
  return { token, baseUrl };
}

export const getServer = () => baseUrl;
export async function setServer(url: string) {
  baseUrl = url.replace(/\/$/, "");
  await AsyncStorage.setItem(SERVER, baseUrl);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
  } catch {
    throw new ApiError(0, "No connection to the server");
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const d = await res.json();
      msg = typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export async function login(username: string, password: string) {
  const r = await api<{ access_token: string; user: Me }>("/api/auth/login", { method: "POST", json: { username, password } });
  token = r.access_token;
  await AsyncStorage.setItem(TOKEN, token);
  return r.user;
}

export async function logout() {
  token = null;
  await AsyncStorage.removeItem(TOKEN);
}

export const newTxnId = () => Crypto.randomUUID();

// ------------------------------------------------------------ offline queue
export interface Queued { body: MovementBody; label: string; queuedAt: string; status: "PENDING" | "REJECTED"; error?: string }

export async function readQueue(): Promise<Queued[]> {
  return JSON.parse((await AsyncStorage.getItem(QUEUE)) ?? "[]");
}
async function writeQueue(q: Queued[]) {
  await AsyncStorage.setItem(QUEUE, JSON.stringify(q));
}
export async function enqueue(body: MovementBody, label: string) {
  const q = (await readQueue()).filter((x) => x.body.txn_uuid !== body.txn_uuid);
  await writeQueue([...q, { body, label, queuedAt: new Date().toISOString(), status: "PENDING" }]);
}
export async function discard(txn: string) {
  await writeQueue((await readQueue()).filter((x) => x.body.txn_uuid !== txn));
}
export async function sync() {
  const pending = (await readQueue()).filter((q) => q.status === "PENDING");
  if (!pending.length) return { confirmed: 0, rejected: 0 };
  const r = await api<{ results: { txn_uuid: string; status: string; error?: string }[] }>("/api/stock/movements/sync", {
    method: "POST",
    json: pending.map((p) => p.body),
  });
  const byId = new Map(r.results.map((x) => [x.txn_uuid, x]));
  let confirmed = 0;
  let rejected = 0;
  const next: Queued[] = [];
  for (const q of await readQueue()) {
    const res = byId.get(q.body.txn_uuid);
    if (!res) next.push(q);
    else if (res.status === "REJECTED") {
      rejected++;
      next.push({ ...q, status: "REJECTED", error: res.error });
    } else confirmed++;
  }
  await writeQueue(next);
  return { confirmed, rejected };
}

// ------------------------------------------------------------ types
export interface Me { id: number; full_name: string; roles: { code: string; name: string }[]; permissions: string[] }
export interface Location { id: number; code: string }
export interface Totals { on_hand: string; reserved: string; qc_hold: string; available: string }
export interface Item { id: number; item_code: string; name: string; uom: { code: string; decimals: number }; default_location: Location | null }
export interface Balance { location: Location; qty_on_hand: string; qty_available: string; qty_qc_hold: string }
export interface Resolve { kind: "item" | "location"; item: Item | null; totals: Totals; balances: Balance[]; location: Location | null }
export interface MovementBody {
  txn_uuid: string;
  movement_type: string;
  item_id: number;
  quantity: string;
  from_location_id: number | null;
  to_location_id: number | null;
  ref_doc_type: string | null;
  ref_doc_no: string | null;
  notes: string | null;
  source: "android";
  device_captured_at: string;
}
export interface Movement { id: number; number: string; movement_type: string; item_code: string; item_name: string; quantity: string; from_location: string | null; to_location: string | null; created_at: string; created_by: string }
