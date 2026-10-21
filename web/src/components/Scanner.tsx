"use client";

import { Camera, CameraOff, Keyboard } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Input } from "./ui";

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
      <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-navy">
        <video ref={videoRef} className={`h-full w-full object-cover ${active && !paused ? "" : "hidden"}`} muted playsInline />
        {active && !paused && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="size-[58%] rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(7,13,30,0.45)]" />
          </div>
        )}
        {(!active || paused) && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-navy-text">
            <div>
              <Camera className="mx-auto mb-3 size-8 opacity-70" />
              <p className="text-sm">{paused ? "Scanner paused" : "Point the camera at an item or bin QR label"}</p>
              {error && <p className="mt-2 text-xs text-[#ff8a98]">{error}</p>}
              {!paused && <Button className="mt-4" onClick={() => { setError(null); setActive(true); }} icon={<Camera className="size-4" />}>Start camera</Button>}
            </div>
          </div>
        )}
        {active && !paused && (
          <button onClick={() => setActive(false)} className="absolute right-2 top-2 rounded-md bg-black/50 p-2 text-white" aria-label="Stop camera">
            <CameraOff className="size-4" />
          </button>
        )}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (manual.trim()) onResult(manual.trim());
          setManual("");
        }}
      >
        <div className="relative flex-1">
          <Keyboard className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
          <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Or type item code (e.g. PI-000001)" className="pl-8" aria-label="Manual item code lookup" />
        </div>
        <Button type="submit" variant="secondary">Look up</Button>
      </form>
    </div>
  );
}
