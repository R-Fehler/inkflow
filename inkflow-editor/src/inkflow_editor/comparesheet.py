"""``inkflow compare --sheet``: the pairs of slides that differ, side by
side on contact sheets, their changed elements outlined. One browser renders
both decks, each slide on a page of its own deck (``inkflow.render``'s page
template), at the size its cell shows it.
"""

from __future__ import annotations

import tempfile
from dataclasses import dataclass, field
from html import escape as escape_html
from pathlib import Path

from inkflow.cdp import Browser
from inkflow.export import copy_assets, find_chromium, served, slide_dimensions
from inkflow.render import (
    SHEET_GAP,
    SHEET_LABEL,
    SHEET_WIDTH,
    SheetLayout,
    page_template,
    sheet_paths,
    slide_page,
)
from inkflow_editor.compare import (
    Comparison,
    DeckFacts,
    ElementChange,
    PairDiff,
    strip_editor_attrs,
    what_changed,
)
from inkflow_editor.comparesrc import SideBuild

PAIRS_PER_SHEET = 6
_HEAD = 34


@dataclass(frozen=True)
class PairCell:
    """One row of a comparison sheet: a caption and the slide on each side
    (an image file, or None when that side lacks it), with boxes to outline
    in slide units: (change, x, y, width, height)."""

    caption: str
    status: str
    left: str | None
    right: str | None
    left_boxes: list[tuple[str, float, float, float, float]] = field(
        default_factory=list
    )
    right_boxes: list[tuple[str, float, float, float, float]] = field(
        default_factory=list
    )


def pair_sheet_layout(
    count: int, slide_width: int, slide_height: int, width: int = SHEET_WIDTH
) -> SheetLayout:
    """Rows of two slides (left | right) under one caption each."""
    thumb_width = (width - SHEET_GAP * 3) // 2
    thumb_height = round(thumb_width * slide_height / slide_width)
    height = _HEAD + SHEET_GAP + count * (SHEET_LABEL + thumb_height + SHEET_GAP)
    return SheetLayout(
        count,
        2,
        count,
        thumb_width,
        thumb_height,
        width,
        max(height, _HEAD + SHEET_GAP),
    )


_OUTLINE = {"changed": "#f2a516", "added": "#3fbf6f", "removed": "#ef5350"}


def pair_sheet_html(
    layout: SheetLayout,
    labels: tuple[str, str],
    rows: list[PairCell],
    slide_width: int,
) -> str:
    """The comparison sheet page: both sides' names on top, then one row per
    pair, its changed elements outlined (amber changed, green added, red
    removed)."""
    scale = layout.thumb_width / slide_width
    parts: list[str] = [
        f'<div class="side" style="left:{SHEET_GAP}px;width:{layout.thumb_width}px">'
        + f"{escape_html(labels[0])}</div>",
        f'<div class="side" style="left:{SHEET_GAP * 2 + layout.thumb_width}px;'
        + f'width:{layout.thumb_width}px">{escape_html(labels[1])}</div>',
    ]
    for index, row in enumerate(rows):
        y = _HEAD + SHEET_GAP + index * (SHEET_LABEL + layout.thumb_height + SHEET_GAP)
        parts.append(
            f'<div class="label s-{escape_html(row.status)}" style="left:{SHEET_GAP}px;'
            + f'top:{y}px;width:{layout.width - 2 * SHEET_GAP}px">'
            + f"{escape_html(row.caption)}</div>"
        )
        for col, (image, boxes) in enumerate(
            ((row.left, row.left_boxes), (row.right, row.right_boxes))
        ):
            x = SHEET_GAP + col * (layout.thumb_width + SHEET_GAP)
            top = y + SHEET_LABEL
            size = f"width:{layout.thumb_width}px;height:{layout.thumb_height}px"
            if image is None:
                parts.append(
                    f'<div class="none" style="left:{x}px;top:{top}px;{size}">'
                    + "not in this deck</div>"
                )
                continue
            parts.append(
                f'<img src="{escape_html(image)}" style="left:{x}px;top:{top}px;'
                + f'{size}">'
            )
            for change, bx, by, bw, bh in boxes:
                parts.append(
                    '<div class="box" style="'
                    + f"left:{x + bx * scale - 3:.1f}px;"
                    + f"top:{top + by * scale - 3:.1f}px;"
                    + f"width:{bw * scale + 6:.1f}px;height:{bh * scale + 6:.1f}px;"
                    + f'border-color:{_OUTLINE.get(change, "#f2a516")}"></div>'
                )
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'><style>"
        + "html,body{margin:0;background:#3b3d42;}"
        + f"body{{position:relative;width:{layout.width}px;"
        + f"height:{layout.height}px;font:16px/{SHEET_LABEL}px sans-serif;color:#eee}}"
        + f".side{{position:absolute;top:{SHEET_GAP // 2}px;height:{_HEAD}px;"
        + f"line-height:{_HEAD}px;font-size:19px;font-weight:bold;white-space:nowrap;"
        + "overflow:hidden;text-overflow:ellipsis}"
        + f".label{{position:absolute;height:{SHEET_LABEL}px;white-space:nowrap;"
        + "overflow:hidden;text-overflow:ellipsis}"
        + ".s-changed{color:#f7c55c}.s-added{color:#7fdc9f}.s-removed{color:#ff8a80}"
        + "img,.none{position:absolute;object-fit:contain;outline:1px solid #6b6e75}"
        + ".none{display:flex;align-items:center;justify-content:center;"
        + "color:#9a9da3;background:#2c2e33}"
        + ".box{position:absolute;box-sizing:border-box;border:3px solid;"
        + "border-radius:4px}"
        + "</style></head><body>"
        + "".join(parts)
        + "</body></html>"
    )


def _boxes(
    elements: list[ElementChange], side: str
) -> list[tuple[str, float, float, float, float]]:
    out: list[tuple[str, float, float, float, float]] = []
    for e in elements:
        loc = e.left if side == "left" else e.right
        if loc is None or loc.box is None:
            continue
        out.append((e.change, *loc.box))
    return out


def render_comparison(
    left: SideBuild,
    right: SideBuild,
    left_facts: DeckFacts,
    right_facts: DeckFacts,
    result: Comparison,
    labels: tuple[str, str],
    output: Path,
    *,
    chromium: str | None = None,
    no_sandbox: bool = False,
) -> list[Path]:
    """Side-by-side images of the pairs that differ (`inkflow compare --sheet`):
    one browser renders both decks, each slide on a page with its own deck's
    styles, at the size its cell shows it."""
    exe = chromium or find_chromium()
    if exe is None:
        raise RuntimeError(
            "Chromium not found. Install chromium or google-chrome,"
            + " or pass --chromium PATH."
        )
    pairs = result.changes()
    if not pairs:
        return []
    builds = {"left": left, "right": right}
    facts = {"left": left_facts, "right": right_facts}
    first = next(
        (s["svg"] for b in (right, left) for s in b.slides),
        "",
    )
    slide_w, slide_h = slide_dimensions(first) if first else (1920, 1080)
    pages = [
        pairs[i : i + PAIRS_PER_SHEET] for i in range(0, len(pairs), PAIRS_PER_SHEET)
    ]
    layouts = [pair_sheet_layout(len(p), slide_w, slide_h) for p in pages]
    thumb_width = layouts[0].thumb_width
    written: list[Path] = []
    with (
        tempfile.TemporaryDirectory() as tmp,
        served(Path(tmp)) as url,
        Browser.launch(exe, no_sandbox=no_sandbox) as browser,
    ):
        root = Path(tmp)
        templates: dict[str, str] = {}
        for side, build in builds.items():
            (root / side).mkdir()
            copy_assets(build.slides, build.roots, root / side)
            templates[side] = page_template(
                build.deck, build.project_dir, build.slides, build.styles, None
            )
        page = browser.new_page()

        def shot(side: str, index: int | None) -> str | None:
            if index is None:
                return None
            build = builds[side]
            visible = facts[side].slides[index].number
            if visible is None:
                return None
            svg = strip_editor_attrs(build.slides[visible - 1]["svg"])
            w, h = slide_dimensions(svg)
            name = f"{side}/slide-{index}.html"
            (root / name).write_text(slide_page(templates[side], svg), "utf-8")
            page.viewport(w, h, thumb_width / w)
            page.navigate(f"{url}/{name}")
            page.evaluate("window.inkflowRendered")
            png = f"{side}-{index}.png"
            (root / png).write_bytes(page.screenshot(w, h))
            return png

        for number, (pairs_on_page, layout, target) in enumerate(
            zip(pages, layouts, sheet_paths(output, len(pages)), strict=True), 1
        ):
            rows: list[PairCell] = []
            for pair in pairs_on_page:
                rows.append(
                    PairCell(
                        caption=pair_caption(pair, left_facts, right_facts),
                        status=pair.status,
                        left=shot("left", pair.left),
                        right=shot("right", pair.right),
                        left_boxes=_boxes(pair.elements, "left"),
                        right_boxes=_boxes(pair.elements, "right"),
                    )
                )
            name = f"sheet-{number}.html"
            (root / name).write_text(
                pair_sheet_html(layout, labels, rows, slide_w), encoding="utf-8"
            )
            page.viewport(layout.width, layout.height, 1)
            page.navigate(f"{url}/{name}")
            page.evaluate("document.fonts.ready.then(() => true)")
            target = target.resolve()
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(page.screenshot(layout.width, layout.height))
            written.append(target)
    return written


def pair_caption(pair: PairDiff, left: DeckFacts, right: DeckFacts) -> str:
    """What a sheet row says about its pair, as `inkflow compare` prints it."""
    ls = left.slides[pair.left] if pair.left is not None else None
    rs = right.slides[pair.right] if pair.right is not None else None
    shown = rs or ls
    name = shown.id if shown is not None else ""
    number = shown.number if shown is not None else None
    num = str(number) if number is not None else "·"
    if pair.status == "added":
        return f"+ {num} {name}: only on the right"
    if pair.status == "removed":
        return f"- {num} {name}: only on the left"
    what = ", ".join(what_changed(pair)) if pair.status == "changed" else ""
    if pair.moved and ls is not None and rs is not None:
        lnum = str(ls.number) if ls.number is not None else "·"
        return f"↕ {lnum} → {num} {name}" + (f": {what}" if what else "")
    return f"~ {num} {name}" + (f": {what}" if what else "")
