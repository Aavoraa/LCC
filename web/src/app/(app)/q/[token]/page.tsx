"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { Spinner } from "@/components/ui";

/** Target of the URL encoded in every QR label: opens the scan workflow for that token. */
export default function QrLanding() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/scan?payload=${encodeURIComponent(token)}`);
  }, [token, router]);
  return <Spinner label="Opening item…" />;
}
