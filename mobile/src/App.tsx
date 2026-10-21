import { CameraView, useCameraPermissions } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import * as Api from "./api";

const C = { navy: "#0b1a3a", primary: "#1e4fd8", bg: "#f3f5f8", surface: "#fff", line: "#e2e7ef", text: "#0f172a", muted: "#64748b",
  success: "#0f8a6c", warning: "#b45309", danger: "#c8102e", soft: "#e8eefc" };

type Screen = "home" | "scan" | "txn" | "pending" | "history" | "search";
const TXNS = [
  { key: "RECEIPT", label: "Receive", perm: "stock.receive" },
  { key: "ISSUE", label: "Issue", perm: "stock.issue" },
  { key: "TRANSFER", label: "Transfer", perm: "stock.transfer" },
  { key: "RETURN", label: "Return", perm: "stock.return" },
] as const;
const REFS = ["SALES_ORDER", "PURCHASE_ORDER", "PAD", "WIP", "ASSEMBLY_REQUEST", "REQUISITION"];

export default function App() {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Api.Me | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [scanned, setScanned] = useState<Api.Resolve | null>(null);
  const [binHint, setBinHint] = useState<Api.Location | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  const refreshPending = useCallback(async () => setPendingCount((await Api.readQueue()).length), []);

  useEffect(() => {
    Api.init().then(async ({ token }) => {
      if (token) {
        try { setMe(await Api.api<Api.Me>("/api/auth/me")); } catch { await Api.logout(); }
      }
      await refreshPending();
      setReady(true);
    });
  }, [refreshPending]);

  async function resolve(payload: string) {
    try {
      const r = await Api.api<Api.Resolve>(`/api/qr/resolve?payload=${encodeURIComponent(payload)}&verify=true`);
      if (r.kind === "location") { setBinHint(r.location); Alert.alert("Bin scanned", `${r.location?.code} will be pre-selected. Now scan the item.`); return; }
      setScanned(r);
      setScreen("txn");
    } catch (e) {
      Alert.alert("Not found", (e as Error).message);
    }
  }

  if (!ready) return <Center><ActivityIndicator color={C.primary} /></Center>;
  if (!me) return <Login onDone={setMe} />;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style="light" />
      <View style={s.header}>
        {screen !== "home" ? <Pressable onPress={() => setScreen("home")} hitSlop={12}><Text style={s.headerBtn}>‹ Back</Text></Pressable> : <Text style={s.headerTitle}>LM Stores</Text>}
        <Text style={s.headerSub}>{me.full_name}</Text>
      </View>
      {screen === "home" && (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          <Big label="Scan QR" sub="Item or bin label" onPress={() => setScreen("scan")} primary />
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Big label="Search" sub="By code or name" onPress={() => setScreen("search")} />
            <Big label={`Pending sync${pendingCount ? ` (${pendingCount})` : ""}`} sub="Offline captures" onPress={() => setScreen("pending")} warn={pendingCount > 0} />
          </View>
          <Big label="Transaction history" sub="Latest ledger postings" onPress={() => setScreen("history")} />
          {binHint && <Text style={s.hint}>Bin {binHint.code} pre-selected for the next transaction.</Text>}
          <Pressable onPress={async () => { await Api.logout(); setMe(null); }}><Text style={[s.link, { marginTop: 24 }]}>Sign out</Text></Pressable>
        </ScrollView>
      )}
      {screen === "scan" && <Scan onResult={resolve} />}
      {screen === "search" && <Search onPick={(code) => resolve(code)} />}
      {screen === "txn" && scanned?.item && (
        <Txn me={me} data={scanned} bin={binHint} onDone={async () => { await refreshPending(); setBinHint(null); }} onRescan={() => setScreen("scan")}
             onRefresh={async () => setScanned(await Api.api<Api.Resolve>(`/api/qr/resolve?payload=${encodeURIComponent(scanned.item!.item_code)}`))} />
      )}
      {screen === "pending" && <Pending onChange={refreshPending} />}
      {screen === "history" && <History />}
    </SafeAreaView>
  );
}

function Login({ onDone }: { onDone: (m: Api.Me) => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [server, setServer] = useState(Api.getServer());
  const [busy, setBusy] = useState(false);
  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: C.navy, justifyContent: "center", padding: 24 }}>
      <Text style={{ color: "#fff", fontSize: 26, fontWeight: "700" }}>LM Stores</Text>
      <Text style={{ color: "#c7d2ea", marginBottom: 24 }}>Lakshmi Machine ERP</Text>
      <TextInput style={s.input} placeholder="Username" autoCapitalize="none" value={u} onChangeText={setU} />
      <TextInput style={s.input} placeholder="Password" secureTextEntry value={p} onChangeText={setP} />
      <TextInput style={[s.input, { fontSize: 13 }]} placeholder="Server URL" autoCapitalize="none" value={server} onChangeText={setServer} />
      <Pressable style={[s.btn, busy && { opacity: 0.6 }]} disabled={busy} onPress={async () => {
        setBusy(true);
        try { await Api.setServer(server); onDone(await Api.login(u.trim().toLowerCase(), p)); }
        catch (e) { Alert.alert("Sign-in failed", (e as Error).message); } finally { setBusy(false); }
      }}><Text style={s.btnText}>{busy ? "Signing in…" : "Sign in"}</Text></Pressable>
    </KeyboardAvoidingView>
  );
}

function Scan({ onResult }: { onResult: (v: string) => void }) {
  const [perm, request] = useCameraPermissions();
  const last = useRef({ v: "", t: 0 });
  const [manual, setManual] = useState("");
  if (!perm) return <Center><ActivityIndicator /></Center>;
  if (!perm.granted) {
    return <Center><Text style={{ marginBottom: 12, color: C.text }}>Camera access is needed to scan labels.</Text>
      <Pressable style={s.btn} onPress={request}><Text style={s.btnText}>Allow camera</Text></Pressable></Center>;
  }
  return (
    <View style={{ flex: 1 }}>
      <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          const now = Date.now();
          if (data === last.current.v && now - last.current.t < 2500) return;
          last.current = { v: data, t: now };
          onResult(data);
        }} />
      <View style={{ padding: 12, flexDirection: "row", gap: 8, backgroundColor: C.surface }}>
        <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Or type item code" autoCapitalize="characters" value={manual} onChangeText={setManual} />
        <Pressable style={[s.btn, { paddingHorizontal: 16, marginTop: 0 }]} onPress={() => manual && onResult(manual)}><Text style={s.btnText}>Go</Text></Pressable>
      </View>
    </View>
  );
}

function Search({ onPick }: { onPick: (code: string) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<{ id: number; item_code: string; name: string; available: string; uom: string }[]>([]);
  useEffect(() => {
    if (q.length < 2) return;
    const t = setTimeout(() => Api.api<{ items: typeof rows }>(`/api/items?q=${encodeURIComponent(q)}&page_size=30`).then((r) => setRows(r.items)).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <View style={{ flex: 1, padding: 16 }}>
      <TextInput style={s.input} placeholder="Search code or name" value={q} onChangeText={setQ} autoFocus />
      <FlatList data={rows} keyExtractor={(r) => String(r.id)} renderItem={({ item }) => (
        <Pressable style={s.row} onPress={() => onPick(item.item_code)}>
          <Text style={s.code}>{item.item_code}</Text><Text style={{ flex: 1, color: C.text }} numberOfLines={1}>{item.name}</Text>
          <Text style={{ color: C.muted }}>{item.available} {item.uom}</Text>
        </Pressable>
      )} />
    </View>
  );
}

function Txn({ me, data, bin, onDone, onRescan, onRefresh }: {
  me: Api.Me; data: Api.Resolve; bin: Api.Location | null; onDone: () => void; onRescan: () => void; onRefresh: () => Promise<void>;
}) {
  const item = data.item!;
  const allowed = TXNS.filter((t) => me.permissions.includes(t.perm));
  const [type, setType] = useState<string>(allowed[0]?.key ?? "");
  const [qty, setQty] = useState("");
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [refType, setRefType] = useState("SALES_ORDER");
  const [refNo, setRefNo] = useState("");
  const [locations, setLocations] = useState<Api.Location[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [txnId, setTxnId] = useState(Api.newTxnId());
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => { Api.api<Api.Location[]>("/api/masters/locations").then(setLocations).catch(() => {}); }, []);
  useEffect(() => {
    const stocked = data.balances.find((b) => Number(b.qty_available) > 0)?.location.id ?? null;
    const def = bin?.id ?? item.default_location?.id ?? null;
    setFrom(["ISSUE", "TRANSFER"].includes(type) ? (bin?.id ?? stocked ?? def) : null);
    setTo(["RECEIPT", "RETURN", "TRANSFER"].includes(type) ? (type === "TRANSFER" ? null : def) : null);
    setConfirm(false); setResult(null); setTxnId(Api.newTxnId());
  }, [type, data, bin, item.default_location]);

  const avail = Number(data.balances.find((b) => b.location.id === from)?.qty_available ?? 0);
  const q = Number(qty);
  const error = !(q > 0) ? "Enter a quantity" : ["ISSUE", "TRANSFER"].includes(type) && q > avail ? `Only ${avail} available at source`
    : type === "ISSUE" && !refNo.trim() ? "Document number required" : ["ISSUE", "TRANSFER"].includes(type) && !from ? "Choose source"
    : ["RECEIPT", "RETURN", "TRANSFER"].includes(type) && !to ? "Choose destination" : type === "TRANSFER" && from === to ? "Destination must differ" : null;

  async function submit() {
    const body: Api.MovementBody = {
      txn_uuid: txnId, movement_type: type, item_id: item.id, quantity: qty, from_location_id: from, to_location_id: to,
      ref_doc_type: refNo ? refType : null, ref_doc_no: refNo || null, notes: null, source: "android", device_captured_at: new Date().toISOString(),
    };
    setBusy(true);
    try {
      const r = await Api.api<{ movement: { number: string }; totals: Api.Totals }>("/api/stock/movements", { method: "POST", json: body });
      setResult(`Posted ${r.movement.number}. Available now ${r.totals.available} ${item.uom.code}.`);
      await onRefresh();
    } catch (e) {
      if ((e as Api.ApiError).status === 0) {
        await Api.enqueue(body, `${type} ${qty} ${item.uom.code} · ${item.item_code}`);
        setResult("Saved offline — PENDING SYNC. Server stock is unchanged until synced.");
      } else Alert.alert("Rejected", (e as Error).message);
    } finally { setBusy(false); setConfirm(false); onDone(); }
  }

  const LocPicker = ({ value, onChange }: { value: number | null; onChange: (v: number) => void }) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
      {locations.map((l) => (
        <Pressable key={l.id} onPress={() => onChange(l.id)} style={[s.chip, value === l.id && s.chipOn]}><Text style={[s.chipText, value === l.id && { color: "#fff" }]}>{l.code}</Text></Pressable>
      ))}
    </ScrollView>
  );

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <View style={s.card}>
        <Text style={s.code}>{item.item_code}</Text>
        <Text style={{ fontSize: 17, fontWeight: "600", color: C.text, marginTop: 2 }}>{item.name}</Text>
        <View style={{ flexDirection: "row", marginTop: 12 }}>
          {([["Physical", data.totals.on_hand], ["Reserved", data.totals.reserved], ["QC", data.totals.qc_hold], ["Available", data.totals.available]] as const).map(([l, v]) => (
            <View key={l} style={{ flex: 1, alignItems: "center" }}><Text style={{ color: C.muted, fontSize: 11 }}>{l}</Text>
              <Text style={{ fontSize: 18, fontWeight: "700", color: l === "Available" ? C.success : C.text }}>{Number(v)}</Text></View>
          ))}
        </View>
      </View>
      {result ? (
        <View style={[s.card, { alignItems: "center" }]}>
          <Text style={{ color: result.startsWith("Saved offline") ? C.warning : C.success, fontWeight: "600", textAlign: "center" }}>{result}</Text>
          <Pressable style={s.btn} onPress={onRescan}><Text style={s.btnText}>Scan next</Text></Pressable>
          <Pressable onPress={() => { setResult(null); setQty(""); setTxnId(Api.newTxnId()); }}><Text style={[s.link, { marginTop: 12 }]}>Another transaction on this item</Text></Pressable>
        </View>
      ) : confirm ? (
        <View style={s.card}>
          <Text style={{ fontWeight: "700", color: C.primary, marginBottom: 8 }}>CONFIRM {type}</Text>
          <Text style={s.confirm}>{qty} {item.uom.code} of {item.item_code}</Text>
          {from && <Text style={s.confirm}>From {locations.find((l) => l.id === from)?.code}</Text>}
          {to && <Text style={s.confirm}>To {locations.find((l) => l.id === to)?.code}</Text>}
          {refNo ? <Text style={s.confirm}>Against {refType} {refNo}</Text> : null}
          <Pressable style={[s.btn, { backgroundColor: C.success }]} disabled={busy} onPress={submit}><Text style={s.btnText}>{busy ? "Posting…" : "Post transaction"}</Text></Pressable>
          <Pressable onPress={() => setConfirm(false)}><Text style={[s.link, { marginTop: 12 }]}>Edit</Text></Pressable>
        </View>
      ) : (
        <View style={s.card}>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 14 }}>
            {allowed.map((t) => (
              <Pressable key={t.key} onPress={() => setType(t.key)} style={[s.seg, type === t.key && s.segOn]}><Text style={[s.segText, type === t.key && { color: "#fff" }]}>{t.label}</Text></Pressable>
            ))}
          </View>
          {!allowed.length && <Text style={{ color: C.muted }}>Your role cannot record stock transactions.</Text>}
          <Text style={s.label}>Quantity ({item.uom.code})</Text>
          <TextInput style={[s.input, { fontSize: 22 }]} keyboardType="decimal-pad" value={qty} onChangeText={setQty} />
          {["ISSUE", "TRANSFER"].includes(type) && <><Text style={s.label}>From location {from ? `· ${avail} available` : ""}</Text><LocPicker value={from} onChange={setFrom} /></>}
          {["RECEIPT", "RETURN", "TRANSFER"].includes(type) && <><Text style={s.label}>To location</Text><LocPicker value={to} onChange={setTo} /></>}
          {type === "ISSUE" && (
            <>
              <Text style={s.label}>Against document</Text>
              <ScrollView horizontal style={{ marginBottom: 8 }}>{REFS.map((r) => (
                <Pressable key={r} onPress={() => setRefType(r)} style={[s.chip, refType === r && s.chipOn]}><Text style={[s.chipText, refType === r && { color: "#fff" }]}>{r.replace(/_/g, " ")}</Text></Pressable>
              ))}</ScrollView>
              <TextInput style={s.input} placeholder="Document number" autoCapitalize="characters" value={refNo} onChangeText={setRefNo} />
            </>
          )}
          {error && qty !== "" && <Text style={{ color: C.danger, marginBottom: 8 }}>{error}</Text>}
          <Pressable style={[s.btn, !!error && { opacity: 0.5 }]} disabled={!!error} onPress={() => setConfirm(true)}><Text style={s.btnText}>Review</Text></Pressable>
        </View>
      )}
    </ScrollView>
  );
}

function Pending({ onChange }: { onChange: () => void }) {
  const [q, setQ] = useState<Api.Queued[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setQ(await Api.readQueue()), []);
  useEffect(() => { load(); }, [load]);
  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ color: C.muted, marginBottom: 12 }}>Captured offline. These are NOT confirmed server stock until synced.</Text>
      <Pressable style={[s.btn, { marginTop: 0, marginBottom: 12 }]} disabled={busy || !q.length} onPress={async () => {
        setBusy(true);
        try { const r = await Api.sync(); Alert.alert("Sync complete", `${r.confirmed} confirmed, ${r.rejected} rejected`); }
        catch (e) { Alert.alert("Sync failed", (e as Error).message); } finally { setBusy(false); await load(); onChange(); }
      }}><Text style={s.btnText}>{busy ? "Syncing…" : "Sync now"}</Text></Pressable>
      <FlatList data={q} keyExtractor={(x) => x.body.txn_uuid} ListEmptyComponent={<Text style={{ color: C.muted }}>Nothing pending.</Text>} renderItem={({ item }) => (
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: item.status === "REJECTED" ? C.danger : C.warning, fontWeight: "600", fontSize: 12 }}>{item.status}</Text>
            <Text style={{ color: C.text }}>{item.label}</Text>
            {item.error && <Text style={{ color: C.danger, fontSize: 12 }}>{item.error}</Text>}
          </View>
          <Pressable onPress={async () => { await Api.discard(item.body.txn_uuid); await load(); onChange(); }}><Text style={{ color: C.muted }}>Discard</Text></Pressable>
        </View>
      )} />
    </View>
  );
}

function History() {
  const [rows, setRows] = useState<Api.Movement[] | null>(null);
  useEffect(() => { Api.api<{ movements: Api.Movement[] }>("/api/stock/movements?page_size=50").then((r) => setRows(r.movements)).catch(() => setRows([])); }, []);
  if (!rows) return <Center><ActivityIndicator /></Center>;
  return (
    <FlatList contentContainerStyle={{ padding: 16 }} data={rows} keyExtractor={(m) => String(m.id)} renderItem={({ item: m }) => (
      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.text, fontWeight: "600" }}>{m.movement_type} · {Number(m.quantity)} · {m.item_code}</Text>
          <Text style={{ color: C.muted, fontSize: 12 }}>{m.number} · {[m.from_location, m.to_location].filter(Boolean).join(" → ")} · {m.created_by}</Text>
        </View>
      </View>
    )} />
  );
}

function Big({ label, sub, onPress, primary, warn }: { label: string; sub: string; onPress: () => void; primary?: boolean; warn?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[s.big, primary && { backgroundColor: C.primary, borderColor: C.primary, minHeight: 120 }, warn && { borderColor: C.warning }]}>
      <Text style={{ fontSize: primary ? 22 : 16, fontWeight: "700", color: primary ? "#fff" : C.text }}>{label}</Text>
      <Text style={{ color: primary ? "#dbe4ff" : C.muted, marginTop: 4 }}>{sub}</Text>
    </Pressable>
  );
}

const Center = ({ children }: { children: React.ReactNode }) => <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>{children}</View>;

const s = StyleSheet.create({
  header: { backgroundColor: C.navy, paddingHorizontal: 16, paddingTop: 40, paddingBottom: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
  headerBtn: { color: "#fff", fontSize: 16 },
  headerSub: { color: "#c7d2ea", fontSize: 12 },
  input: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, marginBottom: 12, color: C.text },
  btn: { backgroundColor: C.primary, borderRadius: 8, paddingVertical: 14, alignItems: "center", marginTop: 8 },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  link: { color: C.primary, textAlign: "center", fontWeight: "600" },
  card: { backgroundColor: C.surface, borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 16, marginBottom: 12 },
  code: { fontFamily: Platform.OS === "android" ? "monospace" : "Menlo", color: C.primary, fontWeight: "700", marginRight: 8 },
  label: { color: C.muted, fontSize: 13, marginBottom: 6, fontWeight: "600" },
  seg: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingVertical: 12, alignItems: "center" },
  segOn: { backgroundColor: C.primary, borderColor: C.primary },
  segText: { fontWeight: "600", color: C.text },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, marginRight: 8 },
  chipOn: { backgroundColor: C.navy, borderColor: C.navy },
  chipText: { color: C.text, fontSize: 13 },
  confirm: { fontSize: 16, color: C.text, marginBottom: 4 },
  row: { backgroundColor: C.surface, borderRadius: 8, borderWidth: 1, borderColor: C.line, padding: 12, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  big: { flex: 1, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 18, minHeight: 90, justifyContent: "center" },
  hint: { color: C.primary, backgroundColor: C.soft, padding: 10, borderRadius: 8 },
});
