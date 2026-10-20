"""The editor's part of test_print_export.py: the tests that need inkflow-editor."""

from __future__ import annotations

import struct
import textwrap
import zlib
from pathlib import Path

import pytest

from inkflow.sizes import PageSize


def _svg(view_box: str, extra: str = "") -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}"{extra}></svg>'


def _png(width: int, height: int) -> bytes:
    def chunk(kind: bytes, body: bytes) -> bytes:
        crc = zlib.crc32(kind + body) & 0xFFFFFFFF
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)

    row = bytes(3 * width)
    raw = b"".join(
        b"\x00" + bytes((i * 7 + j) % 256 for j in range(len(row)))
        for i in range(height)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


_POSTER_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3179 4494">
      <rect width="3179" height="4494" fill="#eef"/>
      <text x="200" y="400" font-size="120" font-family="sans-serif">Poster title</text>
      <image href="photo.png" x="200" y="600" width="800" height="800"/>
    </svg>
""")


_MM_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 841 1189"
         width="841mm" height="1189mm">
      <text x="50" y="100" font-size="40" font-family="sans-serif">In mm</text>
    </svg>
""")


def _deck(tmp_path: Path, size: str | None, *srcs: str) -> Path:
    slides = ", ".join(f'Slide("slides/{s}")' for s in srcs)
    arg = f"size={size!r}, " if size else ""
    deck = tmp_path / "deck.py"
    deck.write_text(
        "from inkflow import Deck, Slide\n\n\n"
        + f"def main() -> Deck:\n    return Deck({arg}slides=[{slides}])\n"
    )
    return deck


@pytest.fixture
def poster(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "poster.svg").write_text(_POSTER_SVG)
    (tmp_path / "slides" / "photo.png").write_bytes(_png(1200, 900))
    (tmp_path / "slides" / "mm.svg").write_text(_MM_SVG)
    (tmp_path / "slides" / "wide.svg").write_text(_svg("0 0 1920 1080"))
    return tmp_path


def test_editor_export_passes_print_marks(poster: Path) -> None:
    from inkflow_editor.session import EditorSession, Exporters

    calls: list[dict[str, object]] = []

    def html(deck_path: Path, out_dir: Path, inline_assets: bool = True) -> None:
        del deck_path, out_dir, inline_assets
        raise AssertionError("not asked for")

    def pdf(
        deck_path: Path,
        output: Path,
        chromium: str | None = None,
        no_sandbox: bool = False,
        size: PageSize | str | tuple[float, float] | None = None,
        bleed: str | float | None = None,
        crop_marks: bool = False,
    ) -> None:
        del deck_path, chromium, no_sandbox, size
        calls.append({"bleed": bleed, "marks": crop_marks})
        output.write_bytes(b"%PDF")

    deck = _deck(poster, "a0", "poster.svg")
    session = EditorSession(deck, Exporters(html=html, pdf=pdf))
    session.apply({"action": "export", "format": "pdf"}, None)
    session.apply({"action": "export", "format": "pdf", "printMarks": True}, None)
    assert calls == [
        {"bleed": None, "marks": False},
        {"bleed": "3mm", "marks": True},
    ]
