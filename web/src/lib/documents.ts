"use client";

import { useEffect, useState } from "react";
import { API_URL, getToken } from "./api";

export type DocStatus = "UPLOADED" | "EXTRACTED" | "FAILED" | "APPROVED" | "REJECTED";
export interface FieldDef { key: string; label: string }
export interface DocTypeDef { code: string; label: string; header: FieldDef[]; lines: FieldDef[] }
export interface DocConfig {
  provider: string; model: string; configured: boolean; max_image_mb: number; max_pdf_mb: number; max_files: number;
  low_confidence: number; doc_types: DocTypeDef[];
}
export interface Check { code: string; status: "pass" | "warn" | "fail"; message: string; field: string | null }
export interface DocBrief {
  id: number; number: string; doc_type: string; doc_type_label: string; status: DocStatus; title: string; page_count: number;
  party_name: string | null; party_gstin: string | null; reference_no: string | null; document_date: string | null; total: string | null;
  failed: number; warnings: number; created_by: string | null; created_at: string; reviewed_by: string | null; reviewed_at: string | null;
}
export interface HeaderField { value: string; confidence: number; edited: boolean }
export type Line = Record<string, string> & { confidence?: number; uncertain_fields?: string[]; edited?: boolean };
export interface DocDetail extends DocBrief {
  data: { detected_document_type: string; document_type_matches: boolean; notes: string[]; header: Record<string, HeaderField>; lines: Line[] };
  checks: Check[]; notes: string | null; provider: string | null; model: string | null; extracted_at: string | null; extraction_error: string | null;
  created_by_id: number; decision_note: string | null; supplier_id: number | null; purchase_order_id: number | null;
  pages: { page_no: number; filename: string; content_type: string; size: number }[];
}

export const STATUS_TONE: Record<DocStatus, "neutral" | "info" | "danger" | "success" | "warning"> = {
  UPLOADED: "neutral", EXTRACTED: "info", FAILED: "danger", APPROVED: "success", REJECTED: "warning",
};
export const STATUS_LABEL: Record<DocStatus, string> = {
  UPLOADED: "Uploaded", EXTRACTED: "To review", FAILED: "Extraction failed", APPROVED: "Approved", REJECTED: "Rejected",
};

/** Photos straight off a phone are often 4–12 MB; the vision API takes up to 5 MB per image. Re-encode anything large
 *  as a JPEG no bigger than 2400 px on the long side — plenty for reading an invoice. PDFs pass through unchanged. */
export async function prepareUpload(file: File): Promise<File> {
  const accepted = ["image/jpeg", "image/png", "image/webp"].includes(file.type);
  if (!file.type.startsWith("image/") || (accepted && file.size < 1.5 * 1024 * 1024)) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
  return blob ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
}

/** Object URL for a private page file, fetched with the user's token. */
export function usePageUrl(docId: number, pageNo: number | null) {
  const [state, setState] = useState<{ url: string | null; type: string; error: string | null }>({ url: null, type: "", error: null });
  useEffect(() => {
    if (pageNo == null) return;
    let url: string | null = null;
    let cancelled = false;
    setState({ url: null, type: "", error: null });
    fetch(`${API_URL}/api/documents/${docId}/pages/${pageNo}`, { headers: { Authorization: `Bearer ${getToken() ?? ""}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Could not load the page (${r.status})`);
        const blob = await r.blob();
        url = URL.createObjectURL(blob);
        if (!cancelled) setState({ url, type: blob.type, error: null });
      })
      .catch((e: Error) => !cancelled && setState({ url: null, type: "", error: e.message }));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [docId, pageNo]);
  return state;
}
