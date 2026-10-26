"use client";

import { Camera, CameraOff, Keyboard } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";

/** Camera QR scanner (ZXing) with a manual item-code / payload fallback. */
export function Scanner({ onResult, paused }: { onResult: (payload: string) => void; paused?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const lastRef = useRef<{ v: string; t: number }>({ v: "", t: 0 });
  const cbRef = useRef(onResult);
  cbRef.current = onResult;

  useEffect(() => {
    if (!active || paused) return;
    let controls: { stop: () => void } | undefined;
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera API unavailable — use HTTPS or localhost, or enter the code manually.");
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 150 });
        controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } } },
          videoRef.current!,
          (result) => {
            if (!result) return;
            const v = result.getText();
            const now = Date.now();
            if (v === lastRef.current.v && now - lastRef.current.t < 2500) return; // debounce repeated frames
            lastRef.current = { v, t: now };
            navigator.vibrate?.(60);
            cbRef.current(v);
          },
        );
        if (cancelled) controls.stop();
      } catch (e) {
        setError((e as Error).message || "Could not start the camera");
        setActive(false);
      }
    })();
    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, [active, paused]);

  return (
    <div className="space-y-3">
      <div className="relative aspect-[4/3] max-h-[340px] w-full overflow-hidden rounded-2xl bg-[#0b1430] sm:aspect-[16/10]">
        <video ref={videoRef} className={`h-full w-full object-cover ${active && !paused ? "" : "hidden"}`} muted playsInline />
        {active && !paused && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-[#0b1430]/30">
            <div className="relative size-[min(56%,220px)] aspect-square">
              <span className="absolute left-0 top-0 size-10 rounded-tl-2xl border-l-4 border-t-4 border-white" />
              <span className="absolute right-0 top-0 size-10 rounded-tr-2xl border-r-4 border-t-4 border-white" />
              <span className="absolute bottom-0 left-0 size-10 rounded-bl-2xl border-b-4 border-l-4 border-white" />
              <span className="absolute bottom-0 right-0 size-10 rounded-br-2xl border-b-4 border-r-4 border-white" />
              <span className="absolute inset-x-4 top-1/2 h-[3px] rounded-full bg-accent" />
            </div>
            <p className="absolute inset-x-0 top-3 text-center text-[13px] font-semibold text-white/90">Point at an item or bin QR label</p>
          </div>
        )}
        {(!active || paused) && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-navy-text">
            <div>
              <span className="mx-auto mb-3 grid size-14 place-items-center rounded-2xl bg-white/10"><Camera className="size-7 text-white" /></span>
              <p className="text-sm font-semibold text-white">{paused ? "Scanner paused" : "Scan an item or bin QR label"}</p>
              {error && <p className="mt-2 text-xs text-[#ff8a98]">{error}</p>}
              {!paused && <Button className="mt-4 h-11 rounded-xl px-5" onClick={() => { setError(null); setActive(true); }} icon={<Camera className="size-4" />}>Start camera</Button>}
            </div>
          </div>
        )}
        {active && !paused && (
          <button onClick={() => setActive(false)} className="absolute bottom-3 right-3 grid size-12 place-items-center rounded-full bg-white/15 text-white" aria-label="Stop camera">
            <CameraOff className="size-5" />
          </button>
        )}
      </div>
      <form
        className="flex h-[52px] items-center gap-2 rounded-xl border border-line-strong bg-surface pl-3.5 pr-1.5 focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/15"
        onSubmit={(e) => {
          e.preventDefault();
          if (manual.trim()) onResult(manual.trim());
          setManual("");
        }}
      >
        <Keyboard className="size-[18px] shrink-0 text-muted" aria-hidden />
        <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Or type item code, e.g. M502303790" aria-label="Item code"
               className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted/80" />
        <Button type="submit" className="h-10 rounded-lg bg-navy px-4 hover:bg-navy-2">Find</Button>
      </form>
    </div>
  );
}
