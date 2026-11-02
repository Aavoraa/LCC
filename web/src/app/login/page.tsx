"use client";

import { ArrowRight, Eye, EyeOff, FileText, Lock, Mic, ScanLine, ShieldCheck, Smartphone, Truck, User } from "lucide-react";
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

  const field = "flex h-12 items-center gap-2.5 rounded-xl border border-line-strong bg-surface-2 px-3.5 transition-colors focus-within:bg-surface focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/15";

  return (
    <div className="app-backdrop grid min-h-screen lg:grid-cols-2">
      <section className="relative hidden flex-col justify-between gap-12 overflow-hidden bg-gradient-to-br from-primary via-[#1a3f9e] to-navy px-16 py-14 text-white lg:flex">
        <svg className="pointer-events-none absolute -bottom-32 -right-36 size-[560px]" viewBox="0 0 560 560" fill="none" stroke="#fff" strokeOpacity="0.07" strokeWidth="2" aria-hidden>
          {[270, 220, 170, 120, 70].map((r) => <circle key={r} cx="280" cy="280" r={r} />)}
          <path d="M10 280h540M280 10v540M89 89l382 382M471 89L89 471" />
        </svg>
        <svg viewBox="0 0 600 160" preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 bottom-0 h-40 w-full" aria-hidden>
          <path d="M0 110 C 160 60, 360 90, 600 20 L600 160 L0 160 Z" fill="var(--brand)" opacity="0.9" />
          <path d="M0 135 C 180 95, 380 120, 600 70 L600 160 L0 160 Z" fill="#ffffff" opacity="0.12" />
        </svg>
        <div className="relative flex items-center gap-4">
          <div className="rounded-2xl bg-white px-3 py-2 shadow-pop">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/lakshmi-logo.png" alt="Lakshmi" className="h-12 w-auto" />
          </div>
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

      <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-10 sm:px-8">
        <svg viewBox="0 0 800 140" preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 bottom-0 h-28 w-full lg:hidden" aria-hidden>
          <path d="M0 95 C 220 50, 480 80, 800 20 L800 140 L0 140 Z" fill="var(--brand)" opacity="0.9" />
          <path d="M0 118 C 240 85, 500 108, 800 62 L800 140 L0 140 Z" fill="var(--primary)" />
        </svg>
        <form onSubmit={submit} className="relative w-full max-w-[440px] rounded-3xl border border-line/70 bg-surface p-7 shadow-pop sm:p-9">
          <div className="flex flex-col items-center text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/lakshmi-logo.png" alt="Lakshmi" className="h-16 w-auto rounded-lg dark:bg-white dark:p-1.5" />
            <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted">Lakshmi ERP · Unit 4</p>
            <h2 className="mt-5 text-[28px] font-extrabold leading-tight tracking-tight text-ink">Welcome back</h2>
            <p className="mt-1.5 text-sm text-muted">Sign in with your ERP account to continue.</p>
          </div>

          <div className="mt-7 space-y-4">
            {error && <Alert>{error}</Alert>}
            <label className="block space-y-1.5">
              <span className="text-[13px] font-semibold text-ink-2">Username</span>
              <span className={field}>
                <User className="size-[18px] text-muted" aria-hidden />
                <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required
                       placeholder="e.g. admin" className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted/60" />
              </span>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[13px] font-semibold text-ink-2">Password</span>
              <span className={`${field} pr-1.5`}>
                <Lock className="size-[18px] text-muted" aria-hidden />
                <input type={show ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required
                       placeholder="Enter your password" className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted/60" />
                <button type="button" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"}
                        className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-ink">
                  {show ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
                </button>
              </span>
            </label>
            <Button type="submit" loading={busy} className="!mt-6 h-12 w-full text-[15px] font-bold" size="lg">
              Sign in {!busy && <ArrowRight className="size-[18px]" aria-hidden />}
            </Button>
          </div>

          <p className="mt-6 flex items-start gap-2.5 rounded-xl bg-surface-2 px-3.5 py-3 text-xs leading-relaxed text-muted">
            <ShieldCheck className="mt-px size-4 shrink-0 text-success" aria-hidden />
            <span>Forgot your password or need an account? Ask your administrator — logins are managed in <b className="font-semibold text-ink-2">Users, roles &amp; settings</b>.</span>
          </p>
        </form>

        <div className="relative mt-6 flex w-full max-w-[440px] flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted">
          <span>© Lakshmi Card Clothing Mfg. Co. Pvt. Ltd.</span>
          <a href="/downloads/LCC-Stores.apk" download
             className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 font-semibold text-primary shadow-card hover:bg-primary-soft">
            <Smartphone className="size-3.5" aria-hidden /> Android app
          </a>
        </div>
      </section>
    </div>
  );
}
