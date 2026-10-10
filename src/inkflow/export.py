from __future__ import annotations

import base64
import importlib.resources
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from collections.abc import Generator
from contextlib import contextmanager
from functools import partial
from html import escape as escape_html
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast

from typing_extensions import override

from inkflow.assets import (
    MIME_TYPES,
    REFERENCE_PATTERNS,
    AssetRoots,
    is_local_ref,
    rewrite_references,
)
from inkflow.enums import ColorMode
from inkflow.fonts import embed_fonts_css_subsetted
from inkflow.loaders import load_deck_scripts, load_deck_styles
from inkflow.logging import logger
from inkflow.manifest import Deck
from inkflow.pipeline import SlideData, process_deck, resolve_transitions
from inkflow.server import State, build_html, load_deck
from inkflow.titles import resolve_deck_title

# ── build ─────────────────────────────────────────────────────────────────────


def _asset_roots(deck: Deck, project_dir: Path) -> AssetRoots:
    return AssetRoots(project_dir, deck.theme.asset_dir())


def build_static_html(
    deck_path: Path, out_dir: Path, inline_assets: bool = False
) -> None:
    deck = load_deck(deck_path)
    project_dir = deck_path.parent
    slides = process_deck(deck, project_dir, deck_path)
    transitions = resolve_transitions(deck)
    styles_css = load_deck_styles(deck, project_dir)
    if deck.embed_fonts:
        font_css = embed_fonts_css_subsetted(
            slides, project_dir, deck.theme.fonts_dir, styles_css=styles_css
        )
        if font_css:
            styles_css = (font_css + "\n" + styles_css).strip()
    scripts_js = load_deck_scripts(deck, project_dir)

    # After font subsetting: inlining stuffs base64 into the same slide strings the
    # subsetter scans for used characters, and every one of them would be kept.
    roots = _asset_roots(deck, project_dir)
    if inline_assets:
        _inline_assets(slides, roots, out_dir)
    else:
        _copy_assets(slides, roots, out_dir)

    state: State = {
        "slides": slides,
        "transitions": transitions,
        "styles_css": styles_css,
        "scripts_js": scripts_js,
        "mode": deck.effective_mode,
        "ws_clients": set(),
        "error": None,
        "position": {"slideIndex": 0, "step": 0},
        "logs": [],
        "title": resolve_deck_title(deck, project_dir),
        "theme_dir": deck.theme.asset_dir(),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_bytes(build_html(state, ws_port=None))


def _local_refs(text: str) -> list[str]:
    """Copyable asset references in one produced SVG or notes fragment.

    Each pattern scans the whole text on its own rather than being folded into one
    alternation, because a `<video>` carries both a `src` and a `poster` and a
    single scan would resume past the first of them.
    """
    refs: list[str] = []
    for pattern in REFERENCE_PATTERNS:
        for ref in cast(list[str], pattern.findall(text)):
            if is_local_ref(ref):
                refs.append(ref)
    return refs


def _slide_refs(slide: SlideData) -> list[str]:
    """Every copyable asset reference one produced slide carries."""
    return _local_refs(slide["svg"]) + _local_refs(slide["notes"])


def _referenced_assets(slides: list[SlideData]) -> dict[str, str]:
    """``{ref: slide id}`` for every copyable asset the produced slides reference.

    Reading the emitted SVG and notes rather than walking the deck keeps the copy
    step honest: what a slide actually carries is what lands in the output, so a
    zone that was pruned takes its asset with it. Every reference here has been
    canonicalised by the pipeline, so it is already project-root relative.

    Deduped on the ref, since a layout's or an overlay's image is referenced once
    per slide. The id is only there to name a slide in a warning, so the first one
    to reach an asset keeps it: for a ref every slide shares, that is the earliest
    slide in deck order rather than an arbitrary one.
    """
    by_ref: dict[str, str] = {}
    for slide in slides:
        for ref in _slide_refs(slide):
            by_ref.setdefault(ref, slide["id"])
    return by_ref


def _copy_assets(slides: list[SlideData], roots: AssetRoots, out_dir: Path) -> None:
    """Copy every asset the slides reference into `out_dir`, mirroring the source tree.

    A canonical ref is relative and free of ``..`` by construction, so `out_dir /
    ref` always lands inside the output and the reference keeps working there
    unchanged. A ref that could not be canonicalised was already reported when it
    was resolved, and `locate` refuses it here.
    """
    for ref, label in _referenced_assets(slides).items():
        src = roots.locate(ref)
        if src is None:
            continue
        if not src.is_file():
            logger.warning(
                f"{label}: asset not found, not copied into the build: {ref}"
            )
            continue
        _copy_asset(src, out_dir / ref)


def _copy_asset(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def _data_uri(src: Path, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(src.read_bytes()).decode('ascii')}"


# Below this, inlining a video is unremarkable: the deck still parses quickly and
# browsers hold the blob without fuss. Past it the base64 payload dominates
# `index.html` and blanks the screen while the document loads, which is worth a word.
_INLINE_VIDEO_WARN_BYTES = 20_000_000


def _inline_assets(slides: list[SlideData], roots: AssetRoots, out_dir: Path) -> None:
    """Replace every asset reference with a data URI, leaving `index.html` alone.

    Each reference is inlined where it stands, so an asset several slides share is
    carried once per use and the output grows accordingly.

    An asset whose suffix names no media type is copied out as usual and reported.
    """
    uris: dict[str, str] = {}
    for ref, label in _referenced_assets(slides).items():
        src = roots.locate(ref)
        if src is None:
            continue
        if not src.is_file():
            logger.warning(
                f"{label}: asset not found, not inlined into the build: {ref}"
            )
            continue
        mime = MIME_TYPES.get(src.suffix.lower())
        if mime is None:
            logger.warning(
                f"{label}: unknown media type, copied beside index.html "
                + f"rather than inlined: {ref}"
            )
            _copy_asset(src, out_dir / ref)
            continue
        if mime.startswith("video/") and src.stat().st_size >= _INLINE_VIDEO_WARN_BYTES:
            size = src.stat().st_size / 1_000_000
            logger.warning(
                f"{label}: inlining a {size:.1f} MB video, whose bytes then travel "
                + f"in index.html and load before the deck renders: {ref}"
            )
        uris[ref] = _data_uri(src, mime)

    for slide in slides:
        slide["svg"] = rewrite_references(slide["svg"], uris.get)
        slide["notes"] = rewrite_references(slide["notes"], uris.get)


# ── export (PDF) ──────────────────────────────────────────────────────────────


def _slide_dimensions(svg_str: str) -> tuple[int, int]:
    """Extract slide width and height from an SVG viewBox, falling back to 1920x1080."""
    m = re.search(r'viewBox="[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)"', svg_str)
    if m:
        return int(float(m.group(1))), int(float(m.group(2)))
    return 1920, 1080


def build_pdf(
    deck_path: Path,
    output: Path,
    chromium: str | None = None,
    no_sandbox: bool = False,
    size: tuple[int, int] | None = None,
) -> None:
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
        raise RuntimeError("Cannot export a PDF: the deck has no visible slides.")
    styles_css = load_deck_styles(deck, project_dir)
    if deck.embed_fonts:
        font_css = embed_fonts_css_subsetted(
            slides, project_dir, deck.theme.fonts_dir, styles_css=styles_css
        )
        if font_css:
            styles_css = (font_css + "\n" + styles_css).strip()

    w, h = size if size is not None else _slide_dimensions(slides[0]["svg"])
    dim_css = (
        f"@page {{ size: {w}px {h}px; margin: 0; }}\n"
        f".slide {{ width: {w}px; height: {h}px; }}"
    )
    styles_css = f"{dim_css}\n{styles_css}".strip()

    pkg = importlib.resources.files("inkflow")
    template = pkg.joinpath("pdf.html").read_text(encoding="utf-8")
    data_theme = "" if deck.effective_mode == ColorMode.DARK else "light"
    title = resolve_deck_title(deck, project_dir)

    with tempfile.TemporaryDirectory() as tmp:
        _copy_assets(slides, _asset_roots(deck, project_dir), Path(tmp))
        slides_html = "\n".join(f'<div class="slide">{s["svg"]}</div>' for s in slides)
        html = (
            template.replace("/* __STYLES__ */", styles_css)
            .replace("__DATA_THEME__", data_theme)
            .replace("__SLIDES__", slides_html)
            .replace("__TITLE__", escape_html(title))
        )
        (Path(tmp) / "slides.html").write_text(html, encoding="utf-8")
        target = output.resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        # A file left from an earlier export must not pass for this one.
        target.unlink(missing_ok=True)
        with _served(Path(tmp)) as url:
            cmd = [
                exe,
                "--headless",
                "--disable-gpu",
                "--print-to-pdf-no-header",
                f"--print-to-pdf={target}",
                f"{url}/slides.html",
            ]
            if no_sandbox:
                cmd.insert(1, "--no-sandbox")
            _run_chromium(cmd, target, b"%PDF")


@contextmanager
def _served(directory: Path) -> Generator[str]:
    """Serve ``directory`` on a loopback port for the length of the block.

    The page is handed to Chromium over HTTP rather than as a ``file://`` URL:
    a Chromium installed as a snap (Ubuntu's ``chromium``) or a Flatpak has its
    own private ``/tmp`` and cannot see the temporary directory the page is
    written to, so it would print its "file not found" page instead of the
    deck. Every confined browser can still reach localhost.
    """
    handler = partial(_QuietHandler, directory=str(directory))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class _QuietHandler(SimpleHTTPRequestHandler):
    @override
    def log_message(self, format: str, *args: object) -> None:
        pass


def _run_chromium(cmd: list[str], target: Path, magic: bytes) -> None:
    """Run Chromium to write ``target`` and check that it did.

    Chromium reports most failures only on stderr, and a confined one (snap,
    Flatpak) that may not write where it was asked exits 0 without a file, so
    both the exit status and the file itself are checked, and either failure
    is raised with what Chromium said.
    """
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except OSError as exc:
        raise RuntimeError(f"could not start {cmd[0]}: {exc}") from exc
    said = _chromium_said(result.stderr)
    if result.returncode != 0:
        raise RuntimeError(
            f"{Path(cmd[0]).name} failed (exit status {result.returncode})" + said
        )
    try:
        with target.open("rb") as f:
            ok = f.read(len(magic)) == magic
    except OSError:
        ok = False
    if not ok:
        raise RuntimeError(
            f"{Path(cmd[0]).name} did not write {target}. A Chromium installed as"
            + " a snap or Flatpak may only write inside your home folder (not in"
            + " /tmp or a hidden folder): pick an output there, or pass"
            + " --chromium with another Chromium-based browser."
            + said
        )


def _chromium_said(stderr: str) -> str:
    """The last lines of Chromium's stderr that are not routine noise."""
    noise = ("dbus", "Fontconfig", "GPU", "gpu_", "Gtk-", "libva", "vaapi")
    lines = [
        line.strip()
        for line in stderr.splitlines()
        if line.strip() and not any(word in line for word in noise)
    ]
    return ("\n" + "\n".join(lines[-5:])) if lines else ""


def _hidden_window_height(base: list[str], tmp: Path, url: str) -> int:
    """How much shorter headless Chrome's viewport is than the window it shoots.

    New-style headless reserves room for browser UI it never draws, so a
    screenshot of a WxH window shows a viewport less than H tall, and nothing is
    painted below it. Measured once per run rather than assumed.
    """
    (tmp / "probe.html").write_text(
        "<html><body><script>document.body.textContent="
        + "'@'+innerHeight+'@'</script></body></html>",
        encoding="utf-8",
    )
    result = subprocess.run(
        [*base, "--window-size=800,800", "--dump-dom", f"{url}/probe.html"],
        capture_output=True,
        text=True,
        check=False,
    )
    match = re.search(r"@(\d+)@", result.stdout)
    return max(0, 800 - int(match.group(1))) if match else 0


def crop_png_height(data: bytes, height: int) -> bytes:
    """Keep the top ``height`` rows of a non-interlaced 8-bit PNG.

    Every filter type refers only to the row above, so the kept rows are still
    valid as they are: no pixel decoding is needed, just fewer of them.
    """
    import struct
    import zlib

    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos = 8
    chunks: list[tuple[bytes, bytes]] = []
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        chunks.append((kind, data[pos + 8 : pos + 8 + length]))
        pos += 12 + length
    ihdr = chunks[0][1]
    width, old_height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", ihdr)
    if depth != 8 or interlace or height >= old_height:
        return data
    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(color)
    if channels is None:
        return data
    raw = zlib.decompress(b"".join(body for kind, body in chunks if kind == b"IDAT"))
    stride = 1 + width * channels
    kept = zlib.compress(raw[: stride * height])
    new_ihdr = struct.pack(">II", width, height) + ihdr[8:]

    def chunk(kind: bytes, body: bytes) -> bytes:
        crc = zlib.crc32(kind + body) & 0xFFFFFFFF
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)

    out = [data[:8], chunk(b"IHDR", new_ihdr)]
    for kind, body in chunks[1:]:
        if kind == b"IDAT":
            continue
        if kind == b"IEND":
            out.append(chunk(b"IDAT", kept))
        out.append(chunk(kind, body))
    return b"".join(out)


def find_chromium() -> str | None:
    for name in (
        "chrome",
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "msedge",  # Chromium-based Edge, ships with Windows
    ):
        if found := shutil.which(name):
            return found
    return _playwright_chromium()


def _playwright_chromium() -> str | None:
    """A Chromium that Playwright downloaded, common on CI and agent machines."""
    roots = [
        os.environ.get("PLAYWRIGHT_BROWSERS_PATH"),
        str(Path.home() / ".cache" / "ms-playwright"),
        str(Path.home() / "Library" / "Caches" / "ms-playwright"),
    ]
    patterns = (
        "chromium-*/chrome-linux*/chrome",
        "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
        "chromium-*/chrome-win*/chrome.exe",
    )
    for root in filter(None, roots):
        base = Path(root)
        for pattern in patterns:
            found = sorted(base.glob(pattern), reverse=True)
            if found:
                return str(found[0])
    return None


# ── render (PNG) ──────────────────────────────────────────────────────────────


def render_png(
    deck_path: Path,
    slide_numbers: list[int],
    output: Path,
    *,
    step: int | None = None,
    scale: float = 1.0,
    chromium: str | None = None,
    no_sandbox: bool = False,
) -> list[Path]:
    """Screenshot slides (1-based, as the presenter numbers them) to PNG files.

    Each slide is shown at ``step`` (its final build state when ``None``) on a
    page with nothing else on it, so the image is exactly the slide. ``output`` is
    the file for a single slide, or a directory for several (``slide-N.png``).
    Returns the files written.
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
    for n in slide_numbers:
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
    template = pkg.joinpath("render.html").read_text(encoding="utf-8")
    css = pkg.joinpath("bundles", "presenter.css").read_text(encoding="utf-8")
    js = pkg.joinpath("bundles", "render.js").read_text(encoding="utf-8")
    data_theme = "" if deck.effective_mode == ColorMode.DARK else "light"
    title = escape_html(resolve_deck_title(deck, project_dir))

    single = len(slide_numbers) == 1 and output.suffix.lower() == ".png"
    if not single:
        output.mkdir(parents=True, exist_ok=True)
    base = [exe, "--headless", "--disable-gpu", "--hide-scrollbars"]
    if no_sandbox:
        base.append("--no-sandbox")
    written: list[Path] = []
    with tempfile.TemporaryDirectory() as tmp, _served(Path(tmp)) as url:
        _copy_assets(slides, _asset_roots(deck, project_dir), Path(tmp))
        lost = _hidden_window_height(base, Path(tmp), url)
        for n in slide_numbers:
            svg = slides[n - 1]["svg"]
            w, h = _slide_dimensions(svg)
            html = (
                template.replace("/* __CSS__ */", css)
                .replace("/* __STYLES__ */", styles_css)
                .replace("/* __JS__ */", js)
                .replace("__RENDER_SVG__", json.dumps(svg).replace("</", "<\\/"))
                .replace("__RENDER_STEP__", json.dumps(step))
                .replace("__DATA_THEME__", data_theme)
                .replace("__TITLE__", title)
                .replace("__W__", str(w))
                .replace("__H__", str(h))
            )
            (Path(tmp) / f"slide-{n}.html").write_text(html, encoding="utf-8")
            target = (output if single else output / f"slide-{n}.png").resolve()
            target.unlink(missing_ok=True)
            # The window is grown by what the browser keeps from the viewport, so
            # the whole slide is painted; the strip that adds is cropped off.
            cmd = [
                *base,
                f"--window-size={w},{h + lost}",
                f"--force-device-scale-factor={scale:g}",
                "--virtual-time-budget=3000",
                f"--screenshot={target}",
                f"{url}/slide-{n}.html",
            ]
            _run_chromium(cmd, target, b"\x89PNG")
            if lost:
                data = target.read_bytes()
                # Chrome clamps the scale factor, so take it from the image.
                actual = int.from_bytes(data[16:20], "big") / w
                target.write_bytes(crop_png_height(data, round(h * actual)))
            written.append(target)
    return written
