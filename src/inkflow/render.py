"""`inkflow render`: slides as PNG images, a contact sheet, and layout findings.

One headless Chromium (driven over the DevTools protocol, `cdp.py`) loads each
slide on its own page (`render.html` + the render bundle), waits until what it
shows has loaded, measures its layout (`src/ts/render/measure.ts`: text that does
not fit its zone, objects outside the slide, text too small to read) and, unless
only checking, screenshots it. The viewport is set to the slide's exact size, so
the image is exactly the slide.

A contact sheet lays the slides out in a grid on one more page, each under a
label with its number and id, so the whole deck is one image to look at.
"""

from __future__ import annotations

import importlib.resources
import json
import math
import tempfile
from dataclasses import dataclass, field
from html import escape as escape_html
from pathlib import Path
from typing import cast

from inkflow.cdp import Browser, Page
from inkflow.enums import ColorMode
from inkflow.export import (
    asset_roots,
    copy_assets,
    find_chromium,
    served,
    slide_dimensions,
)
from inkflow.fonts import embed_fonts_css_subsetted
from inkflow.loaders import load_deck_styles
from inkflow.logging import logger
from inkflow.pipeline import SlideData, process_deck
from inkflow.server import load_deck
from inkflow.titles import resolve_deck_title

# ── findings ──────────────────────────────────────────────────────────────────

_SIDES = ("top", "right", "bottom", "left")


@dataclass(frozen=True)
class Finding:
    """One layout problem on one slide, measured in slide units."""

    slide: int
    slide_id: str
    kind: str  # overflow | clipped | outside | small-text
    target: str
    top: int = 0
    right: int = 0
    bottom: int = 0
    left: int = 0
    entirely: bool = False
    size: float = 0.0
    minimum: float = 0.0
    text: str = ""

    @property
    def is_problem(self) -> bool:
        """Small text is a hint; everything else is something to fix."""
        return self.kind != "small-text"

    def _sides(self) -> list[str]:
        return [side for side in _SIDES if getattr(self, side) > 0]

    def _reach(self) -> str:
        return ", ".join(f"{getattr(self, side)}px ({side})" for side in self._sides())

    def message(self) -> str:
        where = f"slide {self.slide}"
        if self.slide_id:
            where += f" ({self.slide_id})"
        if self.kind == "overflow":
            said = f"text overflows its zone by {self._reach()}"
        elif self.kind == "clipped":
            said = f"{self.text or 'a box'} is cut off by {self._reach()}"
        elif self.kind == "outside" and self.entirely:
            sides = ", ".join(self._sides())
            said = f"lies entirely outside the slide ({sides}), so it is not shown"
        elif self.kind == "outside" and len(self._sides()) == 1:
            side = self._sides()[0]
            said = f"lies {getattr(self, side)}px outside the slide ({side})"
        elif self.kind == "outside":
            said = f"lies outside the slide by {self._reach()}"
        else:
            said = f"text {self.size:g}px tall is likely too small to read"
            if self.minimum:
                said += f" (below {self.minimum:g}px)"
            if self.text:
                said += f': "{self.text}"'
        return f"{where}: {self.target}: {said}"


def parse_findings(slide: int, slide_id: str, raw: object) -> list[Finding]:
    """The findings the render page measured, as `Finding`s (unknown ones dropped)."""
    if not isinstance(raw, list):
        return []
    found: list[Finding] = []
    for item in cast("list[object]", raw):
        if not isinstance(item, dict):
            continue
        data = cast("dict[str, object]", item)
        kind = data.get("kind")
        target = data.get("target")
        if kind not in ("overflow", "clipped", "outside", "small-text"):
            continue
        if not isinstance(target, str):
            continue

        def number(key: str) -> float:
            value = data.get(key)  # noqa: B023
            return float(value) if isinstance(value, int | float) else 0.0

        text = data.get("what") if kind == "clipped" else data.get("text")
        found.append(
            Finding(
                slide=slide,
                slide_id=slide_id,
                kind=kind,
                target=target,
                top=round(number("top")),
                right=round(number("right")),
                bottom=round(number("bottom")),
                left=round(number("left")),
                entirely=data.get("entirely") is True,
                size=number("size"),
                minimum=number("min"),
                text=text if isinstance(text, str) else "",
            )
        )
    return found


def summary(findings: list[Finding], slide_count: int) -> str:
    """One line closing a check: how many problems and hints in how many slides."""
    problems = sum(1 for f in findings if f.is_problem)
    hints = len(findings) - problems
    slides = f"{slide_count} slide" + ("" if slide_count == 1 else "s")
    if not findings:
        return f"no layout problems in {slides}"
    parts: list[str] = []
    if problems:
        parts.append(f"{problems} layout problem" + ("" if problems == 1 else "s"))
    if hints:
        parts.append(f"{hints} hint" + ("" if hints == 1 else "s"))
    return f"{' and '.join(parts)} in {slides}"


# ── contact sheet ─────────────────────────────────────────────────────────────

SHEET_WIDTH = 1600
SHEET_PER_PAGE = 16
_GAP = 16
_LABEL = 30


def sheet_columns(count: int) -> int:
    """Columns for ``count`` slides: a square-ish grid, at most four across."""
    for columns, fits in ((1, 1), (2, 4), (3, 9)):
        if count <= fits:
            return columns
    return 4


@dataclass(frozen=True)
class SheetLayout:
    """Where each slide goes on one contact sheet, in CSS px."""

    count: int
    columns: int
    rows: int
    thumb_width: int
    thumb_height: int
    width: int
    height: int

    def cell(self, index: int) -> tuple[int, int]:
        """Top-left corner of the ``index``-th cell (its label sits on top)."""
        row, col = divmod(index, self.columns)
        return (
            _GAP + col * (self.thumb_width + _GAP),
            _GAP + row * (_LABEL + self.thumb_height + _GAP),
        )


def sheet_layout(
    count: int, slide_width: int, slide_height: int, width: int = SHEET_WIDTH
) -> SheetLayout:
    columns = sheet_columns(count)
    rows = max(1, math.ceil(count / columns))
    thumb_width = (width - _GAP * (columns + 1)) // columns
    thumb_height = round(thumb_width * slide_height / slide_width)
    height = _GAP + rows * (_LABEL + thumb_height + _GAP)
    return SheetLayout(count, columns, rows, thumb_width, thumb_height, width, height)


def sheet_pages(numbers: list[int], per_page: int = SHEET_PER_PAGE) -> list[list[int]]:
    """Slides split into sheets of at most ``per_page``, evenly sized."""
    if not numbers:
        return []
    pages = math.ceil(len(numbers) / per_page)
    size = math.ceil(len(numbers) / pages)
    return [numbers[i : i + size] for i in range(0, len(numbers), size)]


def sheet_paths(output: Path, pages: int) -> list[Path]:
    """The files the sheets go to: ``output`` itself if it is a .png, else in it."""
    if output.suffix.lower() == ".png":
        if pages == 1:
            return [output]
        return [output.with_name(f"{output.stem}-{i}.png") for i in range(1, pages + 1)]
    if pages == 1:
        return [output / "sheet.png"]
    return [output / f"sheet-{i}.png" for i in range(1, pages + 1)]


def sheet_html(layout: SheetLayout, cells: list[tuple[int, str, str, int]]) -> str:
    """The sheet page: ``cells`` are (number, slide id, image file, problems)."""
    parts: list[str] = []
    for index, (number, slide_id, image, problems) in enumerate(cells):
        x, y = layout.cell(index)
        flag = (
            f'<span class="flag">{problems} problem{"" if problems == 1 else "s"}'
            + "</span>"
            if problems
            else ""
        )
        parts.append(
            f'<div class="label" style="left:{x}px;top:{y}px;'
            + f'width:{layout.thumb_width}px"><b>{number}</b> '
            + f"{escape_html(slide_id)}{flag}</div>"
            + f'<img src="{escape_html(image)}" style="left:{x}px;'
            + f"top:{y + _LABEL}px;width:{layout.thumb_width}px;"
            + f'height:{layout.thumb_height}px">'
        )
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'><style>"
        + "html,body{margin:0;background:#3b3d42;}"
        + f"body{{position:relative;width:{layout.width}px;"
        + f"height:{layout.height}px;font:16px/{_LABEL}px sans-serif;color:#eee}}"
        + f".label{{position:absolute;height:{_LABEL}px;white-space:nowrap;"
        + "overflow:hidden;text-overflow:ellipsis}"
        + ".label b{font-size:19px;margin-right:4px}"
        + ".flag{margin-left:10px;padding:1px 6px;border-radius:4px;"
        + "background:#d9480f;color:#fff;font-size:14px}"
        + "img{position:absolute;object-fit:contain;outline:1px solid #6b6e75}"
        + "</style></head><body>"
        + "".join(parts)
        + "</body></html>"
    )


# ── rendering ─────────────────────────────────────────────────────────────────


@dataclass
class RenderResult:
    images: list[Path] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    slides: list[int] = field(default_factory=list)


def render_slides(
    deck_path: Path,
    slide_numbers: list[int] | None,
    output: Path | None,
    *,
    sheet: bool = False,
    step: int | None = None,
    scale: float = 1.0,
    chromium: str | None = None,
    no_sandbox: bool = False,
) -> RenderResult:
    """Render slides (1-based, as the presenter numbers them; ``None`` = all).

    Each slide is shown at ``step`` (its final build state when ``None``) on a
    page with nothing else on it and measured. With an ``output``, it is also
    written as a PNG: ``output`` is the file for a single slide or a directory
    for several (``slide-N.png``); with ``sheet``, the slides go onto contact
    sheets instead (`sheet_paths`). Without one, nothing is written.
    """
    exe = chromium or find_chromium()
    if exe is None:
        raise RuntimeError(
            "Chromium not found. Install chromium or google-chrome,"
            + " or pass --chromium PATH."
        )
    deck = load_deck(deck_path)
    project_dir = deck_path.parent
    slides = process_deck(deck, project_dir, deck_path)
    if not slides:
        raise RuntimeError("Cannot render: the deck has no visible slides.")
    numbers = (
        list(range(1, len(slides) + 1)) if slide_numbers is None else slide_numbers
    )
    for n in numbers:
        if not 1 <= n <= len(slides):
            raise ValueError(f"no slide {n}: the deck has {len(slides)} slides")
    styles_css = load_deck_styles(deck, project_dir)
    if deck.embed_fonts:
        font_css = embed_fonts_css_subsetted(
            slides, project_dir, deck.theme.fonts_dir, styles_css=styles_css
        )
        if font_css:
            styles_css = (font_css + "\n" + styles_css).strip()

    pkg = importlib.resources.files("inkflow")
    template = (
        pkg.joinpath("render.html")
        .read_text(encoding="utf-8")
        .replace("/* __CSS__ */", pkg.joinpath("bundles", "presenter.css").read_text())
        .replace("/* __STYLES__ */", styles_css)
        .replace("/* __JS__ */", pkg.joinpath("bundles", "render.js").read_text())
        .replace("__RENDER_STEP__", json.dumps(step))
        .replace(
            "__DATA_THEME__", "" if deck.effective_mode == ColorMode.DARK else "light"
        )
        .replace("__TITLE__", escape_html(resolve_deck_title(deck, project_dir)))
    )

    single = (
        output is not None
        and not sheet
        and len(numbers) == 1
        and output.suffix.lower() == ".png"
    )
    if output is not None and not single and not sheet:
        output.mkdir(parents=True, exist_ok=True)
    pages = sheet_pages(numbers) if sheet else []
    layouts = [
        sheet_layout(len(p), *slide_dimensions(slides[p[0] - 1]["svg"])) for p in pages
    ]
    # Each slide is shot at the size its cell shows it, so nothing is resampled.
    thumb_width = {
        n: layout.thumb_width
        for p, layout in zip(pages, layouts, strict=True)
        for n in p
    }

    result = RenderResult(slides=numbers)
    shots: dict[int, str] = {}
    with (
        tempfile.TemporaryDirectory() as tmp,
        served(Path(tmp)) as url,
        Browser.launch(exe, no_sandbox=no_sandbox) as browser,
    ):
        copy_assets(slides, asset_roots(deck, project_dir), Path(tmp))
        page = browser.new_page()
        for n in numbers:
            svg = slides[n - 1]["svg"]
            w, h = slide_dimensions(svg)
            html = template.replace(
                "__RENDER_SVG__", json.dumps(svg).replace("</", "<\\/")
            )
            html = html.replace("__W__", str(w)).replace("__H__", str(h))
            (Path(tmp) / f"slide-{n}.html").write_text(html, encoding="utf-8")
            density = thumb_width[n] / w if sheet else scale
            page.viewport(w, h, density)
            page.navigate(f"{url}/slide-{n}.html")
            raw = page.evaluate("window.inkflowRendered")
            if raw is None:
                logger.warning(f"slide {n}: the render page did not measure it")
            result.findings += parse_findings(n, slides[n - 1]["id"], raw)
            if output is None:
                continue
            png = page.screenshot(w, h)
            if sheet:
                shots[n] = f"thumb-{n}.png"
                (Path(tmp) / shots[n]).write_bytes(png)
                continue
            assert output is not None
            target = (output if single else output / f"slide-{n}.png").resolve()
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(png)
            result.images.append(target)
        if sheet and output is not None:
            result.images += _write_sheets(
                page,
                url,
                Path(tmp),
                list(zip(pages, layouts, strict=True)),
                output,
                slides,
                result.findings,
                shots,
            )
    return result


def _write_sheets(
    page: Page,
    url: str,
    tmp: Path,
    pages: list[tuple[list[int], SheetLayout]],
    output: Path,
    slides: list[SlideData],
    findings: list[Finding],
    shots: dict[int, str],
) -> list[Path]:
    problems: dict[int, int] = {}
    for f in findings:
        if f.is_problem:
            problems[f.slide] = problems.get(f.slide, 0) + 1
    written: list[Path] = []
    for index, ((numbers, layout), target) in enumerate(
        zip(pages, sheet_paths(output, len(pages)), strict=True), start=1
    ):
        cells = [
            (n, slides[n - 1]["id"], shots[n], problems.get(n, 0)) for n in numbers
        ]
        name = f"sheet-{index}.html"
        (tmp / name).write_text(sheet_html(layout, cells), encoding="utf-8")
        page.viewport(layout.width, layout.height, 1)
        page.navigate(f"{url}/{name}")
        page.evaluate("document.fonts.ready.then(() => true)")
        target = target.resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(page.screenshot(layout.width, layout.height))
        written.append(target)
    return written
