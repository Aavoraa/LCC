"use client";

import { Boxes, QrCode, ShieldCheck } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

function Login() {
  const { login, user } = useAuth();
  const router = useRouter();
  const next = useSearchParams().get("next") || "/";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) router.replace(next.startsWith("/") ? next : "/");
  }, [user, next, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim().toLowerCase(), password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-navy p-10 text-navy-text lg:flex">
        <div className="pointer-events-none absolute -right-40 -top-40 size-[520px] rounded-full bg-[#1e4fd8]/25 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg bg-gradient-to-br from-[#2f62f0] to-[#1a3fae] font-bold text-white">LM</div>
          <div>
            <p className="font-semibold text-white">Lakshmi Machine</p>
            <p className="text-xs text-navy-text/70">Enterprise Resource Planning</p>
          </div>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-white">One ledger for stores, sales and delivery.</h1>
          <p className="mt-3 text-sm leading-relaxed text-navy-text/80">
            QR-tracked inventory, live available-to-promise for Sales, and rule-based delivery estimates — no stock cards, no phone calls to Stores.
          </p>
          <ul className="mt-8 space-y-3 text-sm">
            {[[QrCode, "Scan to receive, issue and transfer stock"], [Boxes, "Append-only stock ledger with weighted-average valuation"],
              [ShieldCheck, "Role-based access with maker–checker approvals"]].map(([Icon, text]) => {
              const I = Icon as typeof QrCode;
              return (
                <li key={text as string} className="flex items-center gap-3"><I className="size-4 text-[#7fa2ff]" /> {text as string}</li>
              );
            })}
          </ul>
        </div>
        <p className="relative text-xs text-navy-text/50">Authorized personnel only. All activity is audited.</p>
      </div>
      <div className="flex items-center justify-center bg-bg p-6">
        <form onSubmit={submit} className="w-full max-w-sm">
          <h2 className="text-xl font-semibold tracking-tight">Sign in</h2>
          <p className="mt-1 text-sm text-muted">Use your ERP account to continue.</p>
          <div className="mt-6 space-y-4">
            {error && <Alert>{error}</Alert>}
            <Field label="Username">
              <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </Field>
            <Field label="Password">
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Button type="submit" loading={busy} className="w-full" size="lg">Sign in</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
