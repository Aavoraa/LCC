"use client";

import { ArrowRight, Eye, EyeOff, FileText, Lock, Mic, ScanLine, ShieldCheck, Truck, User } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Alert, Button } from "@/components/ui";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

const FEATURES = [
  [ScanLine, "QR scan to receive, issue and locate stock"],
  [Truck, "Job-work challans and production reports"],
  [FileText, "Invoice scanner with GST and GRN checks"],
  [Mic, "Voice stock report in English and தமிழ்"],
] as const;

function Login() {
  const { login, user } = useAuth();
  const router = useRouter();
  const next = useSearchParams().get("next") || "/";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
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

  const field = "flex h-[52px] items-center gap-2.5 rounded-xl border border-line-strong bg-surface px-3.5 focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/15";

  return (
    <div className="grid min-h-screen bg-bg lg:grid-cols-2">
      <section className="relative hidden flex-col justify-between gap-12 overflow-hidden bg-navy px-16 py-14 text-white lg:flex">
        <svg className="pointer-events-none absolute -bottom-32 -right-36 size-[560px]" viewBox="0 0 560 560" fill="none" stroke="#fff" strokeOpacity="0.07" strokeWidth="2" aria-hidden>
          {[270, 220, 170, 120, 70].map((r) => <circle key={r} cx="280" cy="280" r={r} />)}
          <path d="M10 280h540M280 10v540M89 89l382 382M471 89L89 471" />
        </svg>
        <div className="relative flex items-center gap-3.5">
          <div className="grid size-13 place-items-center rounded-2xl bg-white text-lg font-extrabold tracking-wide text-navy" style={{ width: 52, height: 52 }}>LCC</div>
          <div>
            <p className="text-xl font-extrabold">Lakshmi ERP</p>
            <p className="text-[13px] text-navy-text">Lakshmi Card Clothing Mfg. Co. · Unit 4</p>
          </div>
        </div>
        <div className="relative max-w-[520px] space-y-7">
          <h1 className="text-[44px] font-extrabold leading-[1.12] tracking-tight [text-wrap:balance]">Every bin, order and job card in one ledger.</h1>
          <p className="text-[17px] leading-relaxed text-navy-text">Stores, purchase, production and job work for Unit 4 — scan a label and the stock is right, everywhere.</p>
          <ul className="space-y-3.5">
            {FEATURES.map(([Icon, text]) => (
              <li key={text} className="flex items-center gap-3.5 text-[15px]">
                <span className="grid size-9 place-items-center rounded-xl bg-white/10"><Icon className="size-[18px]" aria-hidden /></span>{text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs leading-relaxed text-navy-text/80">S.R.K.V. Post, Perianaickenpalayam, Coimbatore · Authorised personnel only — all activity is audited.</p>
      </section>

      <section className="flex items-center justify-center px-6 py-12 sm:px-8">
        <form onSubmit={submit} className="w-full max-w-[420px] space-y-5">
          <div className="mb-2 flex items-center gap-3 lg:hidden">
            <div className="grid size-11 place-items-center rounded-xl bg-navy text-sm font-extrabold text-white">LCC</div>
            <div><p className="font-extrabold text-navy dark:text-white">Lakshmi ERP</p><p className="text-xs text-muted">Card Clothing · Unit 4</p></div>
          </div>
          <div>
            <h2 className="text-3xl font-extrabold tracking-tight">Sign in</h2>
            <p className="mt-2 text-[15px] text-muted">Use your ERP account to continue.</p>
          </div>
          {error && <Alert>{error}</Alert>}
          <label className="block space-y-2">
            <span className="text-sm font-semibold text-ink-2">Username</span>
            <span className={field}>
              <User className="size-[18px] text-muted" aria-hidden />
              <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required
                     className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none" />
            </span>
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-semibold text-ink-2">Password</span>
            <span className={`${field} pr-1.5`}>
              <Lock className="size-[18px] text-muted" aria-hidden />
              <input type={show ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required
                     className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none" />
              <button type="button" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"}
                      className="grid size-10 place-items-center rounded-lg bg-surface-3 text-ink-2 hover:text-ink">
                {show ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
              </button>
            </span>
          </label>
          <Button type="submit" loading={busy} className="h-[52px] w-full rounded-xl text-base font-bold" size="lg">
            Sign in {!busy && <ArrowRight className="size-[18px]" aria-hidden />}
          </Button>
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3.5">
            <ShieldCheck className="size-5 shrink-0 text-teal" aria-hidden />
            <span className="text-[13px] leading-relaxed text-ink-2">No account yet, or forgot your password? Your administrator manages logins under <b>Users, roles &amp; settings</b>.</span>
          </div>
          <p className="flex flex-wrap justify-between gap-2 pt-1 text-xs text-muted">
            <span>© Lakshmi Card Clothing Mfg. Co. Pvt. Ltd.</span>
          </p>
        </form>
      </section>
    </div>
  );
}
