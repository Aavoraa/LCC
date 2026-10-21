"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, Spinner, Td, Th } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";

interface U { id: number; username: string; full_name: string; is_active: boolean; roles: { code: string; name: string }[] }
interface R { code: string; name: string; permissions: string[] }
interface S { key: string; value: string; description: string }

export default function SettingsPage() {
  const { can } = useAuth();
  const users = useApi<U[]>("/api/users");
  const roles = useApi<R[]>("/api/users/roles");
  const settings = useApi<S[]>("/api/masters/settings");
  const [newUser, setNewUser] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <>
      <PageHeader title="Users, roles & settings" description="Permissions are enforced by the API on every request — the interface only hides what a role cannot do."
        actions={can("users.manage") && <Button icon={<Plus className="size-4" />} onClick={() => setNewUser(true)}>New user</Button>} />
      {msg && <div className="mb-4"><Alert tone="danger">{msg}</Alert></div>}
      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title="Users" />
          {!users.data ? <Spinner /> : (
            <table className="w-full text-[13px]">
              <thead><tr><Th>User</Th><Th>Roles</Th><Th>Status</Th></tr></thead>
              <tbody>{users.data.map((u) => (
                <tr key={u.id}><Td className="h-10"><span className="font-medium text-ink">{u.full_name}</span> <span className="text-xs text-muted">@{u.username}</span></Td>
                  <Td>{u.roles.map((r) => <Badge key={r.code} tone="primary" className="mr-1">{r.name}</Badge>)}</Td>
                  <Td>{u.is_active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</Td></tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title="Business rules" subtitle="Used by the delivery estimator and duplicate detection" />
          {!settings.data ? <Spinner /> : (
            <table className="w-full text-[13px]">
              <tbody>{settings.data.map((s) => (
                <tr key={s.key}>
                  <Td className="py-2"><p className="text-ink">{s.description}</p><p className="font-mono text-[11px] text-muted">{s.key}</p></Td>
                  <Td className="w-28 py-2">
                    <Input defaultValue={s.value} disabled={!can("users.manage")} className="h-8 text-right" aria-label={s.description} onBlur={async (e) => {
                      if (e.target.value === s.value) return;
                      setMsg(null);
                      try { await api(`/api/masters/settings/${s.key}`, { method: "PUT", json: { value: e.target.value } }); settings.reload(); }
                      catch (err) { setMsg((err as ApiError).message); e.target.value = s.value; }
                    }} />
                  </Td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <Card className="overflow-hidden xl:col-span-2">
          <CardHeader title="Role permissions" />
          {!roles.data ? <Spinner /> : (
            <div className="divide-y divide-line">
              {roles.data.map((r) => (
                <div key={r.code} className="grid gap-2 px-4 py-3 sm:grid-cols-[180px_1fr]">
                  <p className="text-sm font-medium">{r.name}</p>
                  <div className="flex flex-wrap gap-1">{r.permissions.map((p) => <span key={p} className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{p}</span>)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      {newUser && <NewUser roles={roles.data ?? []} onClose={() => setNewUser(false)} onDone={users.reload} />}
    </>
  );
}

function NewUser({ roles, onClose, onDone }: { roles: R[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ username: "", full_name: "", email: "", password: "", roles: [] as string[] });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title="New user" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={async () => {
      try { await api("/api/users", { method: "POST", json: { ...f, email: f.email || null } }); onDone(); onClose(); } catch (e) { setErr((e as ApiError).message); }
    }}>Create user</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {err && <div className="sm:col-span-2"><Alert>{err}</Alert></div>}
        <Field label="Username" required hint="lowercase, digits, . _ -"><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} /></Field>
        <Field label="Full name" required><Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Initial password" required hint="At least 8 characters"><Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <fieldset className="sm:col-span-2"><legend className="mb-1.5 text-[13px] font-medium text-ink-2">Roles</legend>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">{roles.map((r) => (
            <label key={r.code} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.roles.includes(r.code)}
              onChange={(e) => setF({ ...f, roles: e.target.checked ? [...f.roles, r.code] : f.roles.filter((x) => x !== r.code) })} />{r.name}</label>
          ))}</div>
        </fieldset>
      </div>
    </Modal>
  );
}
