"""The editor's current focus, shared with agents through ``.inkflow/context.json``.

The browser editor reports which slide, step and elements are selected; the
server writes that here. ``inkflow context`` reads it back as text an agent can
act on, so "align these" in a Claude Code prompt resolves to the elements the
author has selected in the editor. The directory ignores itself in git and is
excluded from the file watcher.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import cast

CONTEXT_DIR = ".inkflow"
CONTEXT_FILE = "context.json"
_MAX_SELECTION = 50


def context_path(project_dir: Path) -> Path:
    return project_dir / CONTEXT_DIR / CONTEXT_FILE


def write_context(project_dir: Path, context: object) -> None:
    """Persist the editor's focus. Malformed input is dropped, not trusted."""
    if not isinstance(context, dict):
        return
    data = cast("dict[str, object]", context)
    selection = data.get("selection")
    if isinstance(selection, list):
        data["selection"] = cast("list[object]", selection)[:_MAX_SELECTION]
    data["updatedAt"] = time.time()
    directory = project_dir / CONTEXT_DIR
    directory.mkdir(exist_ok=True)
    ignore = directory / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8")
    tmp = directory / f"{CONTEXT_FILE}.tmp"
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(context_path(project_dir))


def read_context(project_dir: Path) -> dict[str, object] | None:
    path = context_path(project_dir)
    try:
        data = cast("object", json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None
    return cast("dict[str, object]", data) if isinstance(data, dict) else None


def _fmt_box(box: object) -> str:
    if not isinstance(box, dict):
        return ""
    b = cast("dict[str, object]", box)
    try:
        x, y = float(cast("float", b["x"])), float(cast("float", b["y"]))
        w, h = float(cast("float", b["width"])), float(cast("float", b["height"]))
    except (KeyError, TypeError, ValueError):
        return ""
    return f" at ({x:.0f}, {y:.0f}) size {w:.0f}x{h:.0f}"


def format_context(context: dict[str, object], *, max_age: float | None = None) -> str:
    """Plain text an agent can act on. Empty when the context is older than
    ``max_age`` seconds (the editor was closed long ago)."""
    updated = context.get("updatedAt")
    age = time.time() - float(cast("float", updated)) if updated else None
    if max_age is not None and (age is None or age > max_age):
        return ""
    slide = cast("dict[str, object]", context.get("slide") or {})
    lines = ["inkflow editor context (what the author is looking at right now):"]
    if slide:
        number = slide.get("number")
        total = slide.get("total")
        title = slide.get("title") or slide.get("id") or ""
        lines.append(f"- slide {number}/{total}: {title} (id: {slide.get('id')})")
        for label, key in (
            ("slide SVG", "svg"),
            ("markdown", "md"),
            ("notes", "notes"),
        ):
            value = slide.get(key)
            if value:
                lines.append(f"  {label}: {value}")
        lines.append(f"  deck.py: Slide #{slide.get('deckIndex')} in the slides list")
    step = context.get("step")
    if step:
        lines.append(f"- previewing animation step {step}")
    if context.get("layoutMode"):
        lines.append("- editing in layout mode (changes affect every slide on it)")
    selection = context.get("selection")
    if isinstance(selection, list) and selection:
        lines.append("- selected:")
        for item in cast("list[object]", selection):
            if not isinstance(item, dict):
                continue
            sel = cast("dict[str, object]", item)
            zone = sel.get("zone")
            kind = f"zone '{zone}'" if zone else f"<{sel.get('tag')}>"
            ident = f" #{sel['id']}" if sel.get("id") else " (no id)"
            where = f" in {sel.get('file')}" if sel.get("file") else ""
            text = sel.get("text")
            snippet = f' "{str(text)[:80]}"' if text else ""
            lines.append(f"  - {kind}{ident}{where}{_fmt_box(sel.get('box'))}{snippet}")
    else:
        lines.append("- nothing selected")
    return "\n".join(lines)
