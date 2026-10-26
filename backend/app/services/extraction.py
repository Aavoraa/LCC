"""Document data extraction behind a provider interface.

The default provider sends the scanned pages (images or a PDF) to Claude's vision model with a JSON schema built from
the document type, so the reply is always the same shape: every header field and line field as a string with a
confidence score. The API key stays on the server (``ANTHROPIC_API_KEY`` in backend/.env); the browser never sees it.

Configuration (environment):
* ``EXTRACTION_PROVIDER`` – ``claude`` (default) or ``none`` (manual entry only).
* ``EXTRACTION_MODEL`` – defaults to ``claude-opus-5-5``.
* ``EXTRACTION_EFFORT`` – ``low`` / ``medium`` / ``high`` (default) / ``xhigh`` / ``max``.
"""
from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Protocol

log = logging.getLogger("erp.extraction")


class ExtractionError(Exception):
    """Extraction could not run or returned nothing usable; the message is shown to the user."""


@dataclass
class Page:
    filename: str
    content_type: str
    content: bytes


@dataclass
class DocSpec:
    code: str
    label: str
    header: list[tuple[str, str]]  # (key, label)
    lines: list[tuple[str, str]]
    guidance: str


@dataclass
class ExtractionResult:
    data: dict
    provider: str
    model: str
    usage: dict = field(default_factory=dict)


class ExtractionProvider(Protocol):
    name: str
    model: str

    @property
    def configured(self) -> bool: ...

    def extract(self, spec: DocSpec, pages: list[Page]) -> ExtractionResult: ...


def build_schema(spec: DocSpec) -> dict:
    """Strict JSON schema for the reply. Fields are (name, value, confidence) entries keyed by an enum rather than one
    property per field: a property per field compiles to a grammar the API rejects as too large. Missing values are
    empty strings (no nulls), numbers are digit strings, confidence is 0–1."""
    header_keys = [k for k, _ in spec.header]
    line_keys = [k for k, _ in spec.lines]
    obj = lambda props: {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}  # noqa: E731
    return obj({
        "detected_document_type": {"type": "string"},
        "document_type_matches": {"type": "boolean"},
        "fields": {"type": "array", "items": obj({"field": {"type": "string", "enum": header_keys}, "value": {"type": "string"},
                                                  "confidence": {"type": "number"}})},
        "lines": {"type": "array", "items": obj({
            "cells": {"type": "array", "items": obj({"field": {"type": "string", "enum": line_keys}, "value": {"type": "string"}})},
            "confidence": {"type": "number"},
            "uncertain_fields": {"type": "array", "items": {"type": "string", "enum": line_keys}},
        })},
        "notes": {"type": "array", "items": {"type": "string"}},
    })


def to_tables(raw: dict) -> dict:
    """Reply in the schema's list form → ``header: {field: {value, confidence}}`` and ``lines: [{field: value, …}]``."""
    header = {f["field"]: {"value": f.get("value", ""), "confidence": f.get("confidence", 0)} for f in raw.get("fields") or []}
    lines = []
    for line in raw.get("lines") or []:
        row = {c["field"]: c.get("value", "") for c in line.get("cells") or []}
        row["confidence"] = line.get("confidence", 0)
        row["uncertain_fields"] = line.get("uncertain_fields") or []
        lines.append(row)
    return {**{k: v for k, v in raw.items() if k not in ("fields", "lines")}, "header": header, "lines": lines}


SYSTEM = """You extract data from scanned business documents for an Indian manufacturing company's ERP (stores, \
purchase, production). Documents may be photographs, scans or PDFs; they can be skewed, faint, handwritten in places, \
or span several pages. Read every page.

Rules for values:
- Copy text exactly as printed (item codes, GSTINs, invoice and PO numbers keep their letters, digits and separators).
- Dates as YYYY-MM-DD. Indian documents write dates day first (09/10/2026 is 2026-10-09; 03-OCT-26 is 2026-10-03).
- Amounts and quantities as plain numbers: digits with a "." decimal point, no thousands separators, currency \
symbols or units (1,23,456.50 becomes 123456.50). Put the unit of measure in its own field.
- If a field is not on the document, or you cannot read it, return an empty string. Never guess or compute a value \
that is not printed - the system recomputes totals itself and compares them with what you read.
- confidence is your certainty (0 to 1) that the value is exactly what the document shows: below 0.8 when the print \
is blurred, cut off, overwritten or ambiguous; 0 for empty fields.
- Give one entry in fields for every header field listed, including empty ones.
- One entry in lines per printed line item, in document order, with one cell per line field (empty value if not \
printed). In uncertain_fields list the line fields you are unsure of. Skip sub-total, tax and total rows - they \
belong in the header fields.
- In notes, mention anything a reviewer should check (stamps over figures, handwritten corrections, missing pages, \
more than one document in the upload).
- Set detected_document_type to what the document actually is and document_type_matches to false if it is not \
the expected type."""


class ClaudeVisionProvider:
    name = "claude"

    def __init__(self) -> None:
        self.model = os.environ.get("EXTRACTION_MODEL", "claude-opus-5-5")
        self.effort = os.environ.get("EXTRACTION_EFFORT", "high")

    @property
    def configured(self) -> bool:
        try:
            import anthropic  # noqa: F401
        except ImportError:
            return False
        return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))

    def extract(self, spec: DocSpec, pages: list[Page]) -> ExtractionResult:
        try:
            import anthropic
        except ImportError as e:
            raise ExtractionError("The Anthropic SDK is not installed on the server (pip install -r requirements.txt)") from e
        if not self.configured:
            raise ExtractionError("AI extraction is not set up: add ANTHROPIC_API_KEY to backend/.env and restart the API")

        content: list[dict] = []
        for p in pages:
            data = base64.standard_b64encode(p.content).decode("ascii")
            if p.content_type == "application/pdf":
                content.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": data}})
            else:
                content.append({"type": "image", "source": {"type": "base64", "media_type": p.content_type, "data": data}})
        fields = "\n".join(f"- {k}: {label}" for k, label in spec.header)
        line_fields = "\n".join(f"- {k}: {label}" for k, label in spec.lines)
        content.append({"type": "text", "text": (
            f"Expected document type: {spec.label}.\n{spec.guidance}\n\n"
            f"Header fields:\n{fields}\n\nLine item fields:\n{line_fields}\n\n"
            f"The upload has {len(pages)} file(s). Extract the data."
        )})

        client = anthropic.Anthropic()
        try:
            # Streaming keeps long, many-line documents clear of HTTP timeouts. On a safety decline the API re-runs the
            # request on Anthropic's recommended fallback model (fallbacks="default").
            with client.beta.messages.stream(
                model=self.model,
                max_tokens=32000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                thinking={"type": "adaptive"},
                output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": build_schema(spec)}},
                system=SYSTEM,
                messages=[{"role": "user", "content": content}],
            ) as stream:
                msg = stream.get_final_message()
        except anthropic.AuthenticationError as e:
            raise ExtractionError("The ANTHROPIC_API_KEY on the server was rejected - check the key") from e
        except anthropic.PermissionDeniedError as e:
            raise ExtractionError("The API key is not allowed to use this model") from e
        except anthropic.RateLimitError as e:
            raise ExtractionError("AI extraction is busy (rate limited) - try again in a minute") from e
        except anthropic.BadRequestError as e:
            raise ExtractionError(f"The document could not be processed: {e.message}") from e
        except anthropic.APIConnectionError as e:
            raise ExtractionError("Cannot reach the AI service - check the server's internet connection") from e
        except anthropic.APIStatusError as e:
            log.warning('"extraction failed status=%s request_id=%s"', e.status_code, getattr(e, "request_id", None))
            raise ExtractionError(f"AI service error ({e.status_code}) - try again later") from e

        if msg.stop_reason == "refusal":
            raise ExtractionError("The AI service declined to read this document")
        if msg.stop_reason == "max_tokens":
            raise ExtractionError("The document has too many lines to read in one pass - upload fewer pages at a time")
        text = next((b.text for b in msg.content if b.type == "text"), "")
        try:
            data = to_tables(json.loads(text))
        except (json.JSONDecodeError, KeyError, TypeError, AttributeError) as e:
            raise ExtractionError("The AI service returned an unreadable answer - try again") from e
        u = msg.usage
        usage = {"input_tokens": u.input_tokens, "output_tokens": u.output_tokens, "request_id": getattr(msg, "_request_id", None), "served_by": msg.model}
        return ExtractionResult(data=data, provider=self.name, model=msg.model, usage=usage)


class ManualOnlyProvider:
    name = "none"
    model = ""
    configured = False

    def extract(self, spec: DocSpec, pages: list[Page]) -> ExtractionResult:
        raise ExtractionError("AI extraction is turned off (EXTRACTION_PROVIDER=none) - enter the fields by hand")


def get_provider() -> ExtractionProvider:
    return ManualOnlyProvider() if os.environ.get("EXTRACTION_PROVIDER", "claude").lower() == "none" else ClaudeVisionProvider()
