"use client";

import { useEffect, useState } from "react";
import { API_URL, getToken } from "@/lib/api";

/** QR images are behind auth, so fetch the SVG with the bearer token and inline it. */
export function QrImage({ itemId, token, className }: { itemId: number; token: string; className?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/items/${itemId}/qr.svg`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } })
      .then((r) => (r.ok ? r.text() : null))
      .then((t) => !cancelled && setSvg(t));
    return () => {
      cancelled = true;
    };
  }, [itemId, token]);
  return (
    <div
      className={`[&>svg]:h-full [&>svg]:w-full ${className ?? ""}`}
      role="img"
      aria-label="Item QR code"
      dangerouslySetInnerHTML={svg ? { __html: svg.replace(/<\?xml[^>]*\?>/, "") } : undefined}
    />
  );
}
