"""The layouts and overlays a deck offers, and which slides use each.

What ``inkflow layouts`` lists with its slide counts, and what a frontend's
slide-master view can be built from: every layout in the deck's shape (the
project's own winning over a theme's of the same name), its parent, the
slides built on it directly and every slide whose chain goes through it; the
deck's overlays, a slide's own, and overlay files nothing uses yet.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from inkflow.layout import (
    AssetKind,
    builtin_theme_dir,
    discover_assets,
    layouts_for,
    resolve_chain,
    theme_ref,
)
from inkflow.manifest import Deck
from inkflow.overlay import Overlay
from inkflow.pipeline import resolve_overlay_chains, resolve_slide_src

if TYPE_CHECKING:
    from inkflow.themes import Theme


@dataclass
class LayoutEntry:
    name: str
    path: Path
    """The file slides get: the project's own when it has one."""
    source: str
    """``local`` (the project's own), ``theme`` or ``builtin``."""
    shadows: bool = False
    """A project layout named like a theme's: it replaces the theme's for
    slides naming it, not inside the theme's chains."""
    parent: str | None = None
    slides: list[int] = field(default_factory=list)
    """Deck indices of the slides built directly on it."""
    reach: list[int] = field(default_factory=list)
    """Deck indices of every slide whose chain goes through it."""


def _layout_entries(deck: Deck, project_dir: Path) -> dict[str, LayoutEntry]:
    found = discover_assets(AssetKind.LAYOUT, project_dir, deck.theme)
    shown = layouts_for(found, deck.effective_size)
    by_name: dict[str, dict[str, Path]] = {}
    for label, path in found:
        by_name.setdefault(path.stem, {})[label] = path
    names = list(dict.fromkeys(p.stem for _, p in shown))
    entries: dict[str, LayoutEntry] = {}
    for name in names:
        sources = by_name[name]
        source = next(s for s in ("local", "theme", "builtin") if s in sources)
        path = sources[source]
        shadows = source == "local" and len(sources) > 1
        entry = LayoutEntry(name, path, source, shadows=shadows)
        try:
            chain = resolve_chain(path, project_dir, deck.theme)
        except ValueError:
            chain = []
        entry.parent = chain[-1].stem if chain else None
        entries[name] = entry
    return entries


def slide_layouts(
    deck: Deck, project_dir: Path
) -> list[tuple[Path | None, list[Path]]]:
    """For each deck slide: the layout it is built on directly and every
    layout of its chain (resolved paths)."""
    out: list[tuple[Path | None, list[Path]]] = []
    for slide in deck.slides:
        try:
            src = resolve_slide_src(slide.src, project_dir, deck.theme)
            chain = [p.resolve() for p in resolve_chain(src, project_dir, deck.theme)]
        except (ValueError, OSError):
            out.append((None, []))
            continue
        if _is_layout_file(src, project_dir, deck.theme):
            out.append((src.resolve(), [*chain, src.resolve()]))
        else:
            out.append((chain[-1] if chain else None, chain))
    return out


def _is_layout_file(path: Path, project_dir: Path, theme: Theme | None) -> bool:
    folder = path.resolve().parent
    dirs = [project_dir / "layouts", builtin_theme_dir() / "layouts"]
    if theme is not None:
        dirs.append(theme.layouts_dir)
    return any(folder == d.resolve() for d in dirs)


def layout_entries(deck: Deck, project_dir: Path) -> dict[str, LayoutEntry]:
    """Every layout the deck offers (`layouts_for`), the project's own
    winning, with its parent and the slides using it."""
    entries = _layout_entries(deck, project_dir)
    by_path = {e.path.resolve(): e for e in entries.values()}
    for i, (direct, chain) in enumerate(slide_layouts(deck, project_dir)):
        if direct is not None and direct in by_path:
            by_path[direct].slides.append(i)
        for p in chain:
            if p in by_path:
                by_path[p].reach.append(i)
    return entries


def background_name(entries: dict[str, LayoutEntry]) -> str | None:
    """The layout behind every slide: the root of the chains (``base``)."""
    roots = [e for e in entries.values() if e.parent is None]
    if not roots:
        return None
    if "base" in entries and entries["base"].parent is None:
        return "base"

    def weight(e: LayoutEntry) -> tuple[int, int]:
        children = sum(1 for x in entries.values() if x.parent == e.name)
        return (len(e.reach), children)

    return max(roots, key=weight).name


@dataclass
class OverlayEntry:
    src: str
    """As deck.py (or the theme) names it."""
    name: str
    path: Path | None
    source: str
    deck: bool = True
    """Among the deck's default overlays (else: a slide's own or a draft)."""
    slides: list[int] = field(default_factory=list)


def _overlay_source(path: Path, project_dir: Path, theme: Theme | None) -> str:
    ref = theme_ref(path, theme, AssetKind.OVERLAY)
    if ref is not None:
        return ref.partition(":")[0]
    return "local" if path.resolve().is_relative_to(project_dir.resolve()) else "other"


def resolve_overlay(
    overlay: Overlay, project_dir: Path, theme: Theme | None
) -> Path | None:
    try:
        return resolve_overlay_chains([overlay], project_dir, theme)[0][-1]
    except (ValueError, OSError):
        return None


def overlay_entries(deck: Deck, project_dir: Path) -> list[OverlayEntry]:
    """The deck's overlays (its own or its theme's), then any a slide names
    itself, then the project's overlay files nothing uses yet."""
    out: list[OverlayEntry] = []
    seen: dict[Path, OverlayEntry] = {}

    def add(overlay: Overlay, in_deck: bool) -> OverlayEntry:
        path = resolve_overlay(overlay, project_dir, deck.theme)
        key = path.resolve() if path is not None else Path(overlay.src)
        if key in seen:
            return seen[key]
        entry = OverlayEntry(
            overlay.src,
            Path(overlay.src).stem,
            path,
            _overlay_source(path, project_dir, deck.theme) if path else "missing",
            in_deck,
        )
        seen[key] = entry
        out.append(entry)
        return entry

    for overlay in deck.effective_overlays:
        _ = add(overlay, True)
    for i, slide in enumerate(deck.slides):
        overlays = slide.overlays if slide.overlays is not None else None
        for overlay in overlays if overlays is not None else deck.effective_overlays:
            add(overlay, overlays is None).slides.append(i)
    folder = project_dir / "overlays"
    if folder.is_dir():
        for path in sorted(folder.glob("*.svg")):
            if path.resolve() not in seen:
                entry = OverlayEntry(path.stem, path.stem, path, "local", False)
                seen[path.resolve()] = entry
                out.append(entry)
    return out
