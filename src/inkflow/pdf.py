"""PDF pages as pictures: a figure from a LaTeX paper, drawn as vector SVG.

Browsers show no PDF in an SVG ``<image>`` or an HTML ``<img>``, so the build
converts the page a picture names to SVG with the first converter installed:
``pdftocairo`` (poppler), ``mutool`` (MuPDF), then Inkscape. Text becomes glyph
outlines, so a LaTeX figure keeps its exact fonts. The page is cut to its own
box (the crop box, what a PDF viewer shows).

A reference picks its page with the standard fragment, ``plot.pdf#page=2``; no
fragment means the first page. Only the PDF is a source: converted pages are a
cache under ``.inkflow/cache/pdf/`` (ignored by git, unwatched), named by the
PDF's content hash and page, so a changed PDF converts again and an unchanged
one never does. The pipeline points each picture at its converted page, under
the ``_pdf/`` asset prefix (see `AssetRoots`), and keeps the PDF reference
beside it in ``data-inkflow-pdf``: what the editor shows and writes back.
"""

from __future__ import annotations

import base64
import functools
import hashlib
import os
import re
import secrets
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from html import escape
from pathlib import Path
from urllib.parse import unquote

from inkflow import ns
from inkflow.assets import PDF_CACHE, AssetRoots
from inkflow.editor.context import context_dir
from inkflow.logging import logger
from inkflow.svgio import SvgElement

SOURCE_ATTR = "data-inkflow-pdf"
"""On a picture showing a converted page: the PDF reference it was written with."""

INSTALL_HINT = (
    "install poppler-utils (pdftocairo), mupdf-tools (mutool) or Inkscape"
    + " to show PDF figures"
)

_TIMEOUT = 120


class PdfError(ValueError):
    pass


# ── References ──


def split_ref(ref: str) -> tuple[str, str]:
    """``(path, fragment)``: ``plot.pdf#page=2`` → ``("plot.pdf", "page=2")``."""
    path, _, fragment = ref.partition("#")
    return path, fragment


def is_pdf_ref(ref: str) -> bool:
    """Whether a reference names a PDF (a local file, with or without a page)."""
    path = split_ref(ref)[0].split("?", 1)[0]
    return path.lower().endswith(".pdf") and not path.startswith(
        ("http://", "https://", "//", "data:")
    )


def page_of(ref: str) -> int | None:
    """The page a reference names: 1 without one, None when it is not a page.

    The fragment follows the PDF open parameters (``#page=2&zoom=50``): only
    ``page`` matters here, the others are a viewer's business.
    """
    for param in split_ref(ref)[1].split("&"):
        name, _, value = param.partition("=")
        if name.strip().lower() == "page":
            return int(value) if value.strip().isdigit() and int(value) > 0 else None
    return 1


def with_page(path: str, page: int) -> str:
    """The reference to ``page`` of the PDF at ``path`` (the first needs no page)."""
    path = split_ref(path)[0]
    return path if page == 1 else f"{path}#page={page}"


# ── Converters ──


def _pdftocairo(pdf: Path, page: int, out: Path) -> list[str]:
    return ["pdftocairo", "-svg", "-f", str(page), "-l", str(page), str(pdf), str(out)]


def _mutool(pdf: Path, page: int, out: Path) -> list[str]:
    # Text as outlines. It may number the file even for one page (`_converted`).
    return [
        "mutool",
        "convert",
        "-F",
        "svg",
        "-O",
        "text=path",
        "-o",
        str(out),
        str(pdf),
        str(page),
    ]


def _inkscape(pdf: Path, page: int, out: Path) -> list[str]:
    # Poppler's import draws text as outlines, as the other two do.
    return [
        "inkscape",
        "--pdf-poppler",
        f"--pdf-page={page}",
        "--export-type=svg",
        "--export-plain-svg",
        f"--export-filename={out}",
        str(pdf),
    ]


CONVERTERS: dict[str, Callable[[Path, int, Path], list[str]]] = {
    "pdftocairo": _pdftocairo,
    "mutool": _mutool,
    "inkscape": _inkscape,
}
"""Converter program → its command for one page, in order of preference."""


def converter() -> str | None:
    """The first converter installed, or None."""
    return next((name for name in CONVERTERS if shutil.which(name)), None)


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command, capture_output=True, text=True, timeout=_TIMEOUT, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PdfError(f"{command[0]} failed: {exc}") from exc


def _converted(tool: str, pdf: Path, page: int, out: Path) -> None:
    """Convert one page into ``out`` with ``tool``."""
    with tempfile.TemporaryDirectory(dir=out.parent) as tmp:
        target = Path(tmp) / "page.svg"
        result = _run(CONVERTERS[tool](pdf, page, target))
        # mutool numbers the file of a multi-page run; one page may still get one.
        made = target if target.is_file() else next(Path(tmp).glob("*.svg"), None)
        if result.returncode != 0 or made is None or made.stat().st_size == 0:
            said = (result.stderr or result.stdout).strip().splitlines()
            reason = said[-1] if said else f"exit status {result.returncode}"
            raise PdfError(f"{tool} could not convert page {page}: {reason}")
        os.replace(made, out)


# ── Pages ──


@functools.lru_cache(maxsize=256)
def _digest(path: str, _mtime_ns: int, _size: int) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def digest(pdf: Path) -> str:
    """The PDF's content hash (remembered while its size and time are the same)."""
    stat = pdf.stat()
    return _digest(str(pdf), stat.st_mtime_ns, stat.st_size)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "page"


def cache_name(pdf: Path, page: int) -> str:
    """The converted page's file name: the PDF's content and the page are the
    key, the PDF's name only makes the build output readable."""
    return f"{_slug(pdf.stem)}-p{page}-{digest(pdf)[:16]}.svg"


def convert(pdf: Path, page: int, project_dir: Path, tool: str | None = None) -> Path:
    """The page as SVG in the project's cache, converted once per content and page.

    Raises `PdfError` when no converter is installed or it fails (a page past
    the end, an unreadable file).
    """
    cache = Path(os.path.abspath(project_dir / PDF_CACHE))
    target = cache / cache_name(pdf, page)
    if target.is_file():
        return target
    tool = tool or converter()
    if tool is None:
        raise PdfError(f"no PDF converter found: {INSTALL_HINT}")
    _ = context_dir(project_dir)  # ignoring itself before anything lands in it
    cache.mkdir(parents=True, exist_ok=True)
    # Into a file of its own first: a build and the editor may convert at once.
    partial = cache / f".{secrets.token_hex(6)}.svg"
    try:
        _converted(tool, pdf, page, partial)
        os.replace(partial, target)
    finally:
        partial.unlink(missing_ok=True)
    return target


_PAGES_RE = re.compile(r"^Pages:\s+(\d+)\s*$", re.MULTILINE)
_PAGE_OBJECT_RE = re.compile(rb"/Type\s*/Page(?![a-zA-Z])")


def page_count(pdf: Path) -> int | None:
    """How many pages the PDF has, or None when nothing can tell."""
    for command in (["pdfinfo", str(pdf)], ["mutool", "info", str(pdf)]):
        if shutil.which(command[0]) is None:
            continue
        try:
            result = _run(command)
        except PdfError:
            continue
        if result.returncode == 0 and (m := _PAGES_RE.search(result.stdout)):
            return int(m.group(1))
    # Without those, an uncompressed PDF still names each of its pages.
    try:
        count = len(_PAGE_OBJECT_RE.findall(pdf.read_bytes()))
    except OSError:
        return None
    return count or None


# ── Slides ──


def placeholder(label: str, reason: str) -> str:
    """A dashed box naming the PDF, as a data URI, for a page that cannot show.

    It has no size of its own, so it fills the picture's box whatever its shape.
    """
    text = 'x="50%" y="50%" text-anchor="middle" font-family="sans-serif" fill="#888"'
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">'
        + '<rect x="1%" y="1%" width="98%" height="98%"'
        + ' fill="rgba(128,128,128,0.08)" stroke="#888" stroke-width="3"'
        + ' stroke-dasharray="12 8"/>'
        + f'<text {text} font-size="24">{escape(label)}</text>'
        + f'<text {text} dy="1.6em" font-size="16">{escape(reason)}</text>'
        + "</svg>"
    )
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()


_SVG_HREFS = ("href", f"{{{ns.XLINK}}}href")


@dataclass
class PdfPages:
    """Points the PDF pictures of one build's slides at their converted pages.

    One per build, so a missing converter is reported once, not per picture.
    """

    roots: AssetRoots
    tool: str | None = field(default_factory=converter)
    warned: bool = field(default=False, init=False)

    def page(self, ref: str) -> tuple[str | None, str]:
        """``(canonical ref of the converted page, why not)`` for a canonical
        PDF reference."""
        path = unquote(split_ref(ref)[0])
        name = Path(path).name
        page = page_of(ref)
        pdf = self.roots.locate(path)
        if pdf is None or not pdf.is_file():
            logger.warning(f"PDF not found: {path}")
            return None, "PDF not found"
        if page is None:
            logger.warning(f"{name}: no page number in {ref!r} (write #page=2)")
            return None, "no such page"
        if self.tool is None:
            if not self.warned:
                self.warned = True
                logger.warning(f"cannot show {name}: {INSTALL_HINT}")
            return None, "no PDF converter installed"
        try:
            converted = convert(pdf, page, self.roots.project_dir, self.tool)
        except (PdfError, OSError) as exc:
            logger.warning(f"{name}: {exc}")
            return None, f"page {page} could not be converted"
        return self.roots.canonicalize(converted), ""

    def apply(self, root: SvgElement) -> SvgElement:
        """Point every PDF picture in a slide at its converted page, or at a
        placeholder naming it."""
        for el in root.iter(f"{{{ns.SVG}}}image", f"{{{ns.XHTML}}}img"):
            attributes = _SVG_HREFS if el.tag.endswith("}image") else ("src",)
            for attribute in attributes:
                ref = el.get(attribute)
                if ref is None or not is_pdf_ref(ref):
                    continue
                converted, reason = self.page(ref)
                if converted is None:
                    label = Path(unquote(split_ref(ref)[0])).name
                    page = page_of(ref)
                    if page is not None and page > 1:
                        label += f", page {page}"
                    converted = placeholder(label, reason)
                el.set(attribute, converted)
                el.set(SOURCE_ATTR, ref)
        return root
