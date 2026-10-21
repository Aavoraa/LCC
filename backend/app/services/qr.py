from __future__ import annotations

import io

import segno

from ..config import settings


def qr_content(token: str) -> str:
    """Opaque inventory URL. Phones without the app open the web lookup; the app/scanner parses the token."""
    return f"{settings.public_base_url.rstrip('/')}/q/{token}"


def render_png(token: str, scale: int = 10) -> bytes:
    buf = io.BytesIO()
    segno.make(qr_content(token), error="m").save(buf, kind="png", scale=scale, border=2)
    return buf.getvalue()


def render_svg(token: str, scale: int = 4, inline: bool = False) -> str:
    buf = io.BytesIO()
    segno.make(qr_content(token), error="m").save(
        buf, kind="svg", scale=scale, border=2, xmldecl=not inline, svgns=True, nl=False, svgclass=None, lineclass=None,
        omitsize=True,  # emit a viewBox so labels scale to any print size
    )
    return buf.getvalue().decode()
