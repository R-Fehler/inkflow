"""The editor's part of test_pdf.py: the tests that need inkflow-editor."""

from __future__ import annotations

import shutil
from collections.abc import Callable
from pathlib import Path
from typing import cast

import pytest

from inkflow import pdf
from inkflow.assets import AssetRoots
from inkflow.deps import file_hash
from inkflow.pipeline import process_deck
from inkflow.server import (
    load_deck,
)
from inkflow.svgio import parse_svg
from inkflow_editor.session import EditError, EditorSession
from inkflow_editor.transfer import export_assets, retarget_fragment

needs_pdftocairo = pytest.mark.skipif(
    shutil.which("pdftocairo") is None, reason="pdftocairo (poppler) not installed"
)


_SVG = "http://www.w3.org/2000/svg"


_XHTML = "http://www.w3.org/1999/xhtml"


def make_pdf(pages: list[tuple[float, float, str]]) -> bytes:
    """A small valid PDF: one page per ``(width, height, content stream)``."""
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"",  # the page tree, once the pages are numbered
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    kids: list[int] = []
    for width, height, content in pages:
        data = content.encode()
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(data), data))
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %g %g] /Contents %d 0 R"
            % (width, height, len(objects))
            + b" /Resources << /Font << /F1 3 0 R >> >> >>"
        )
        kids.append(len(objects))
    refs = b" ".join(b"%d 0 R" % k for k in kids)
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (refs, len(kids))
    out = b"%PDF-1.4\n"
    offsets: list[int] = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\n" % (len(objects) + 1)
    return out + b"startxref\n%d\n%%%%EOF\n" % xref


FIGURE = make_pdf(
    [
        (
            300,
            160,
            "0.2 0.4 0.8 rg 20 20 100 60 re f 0 0 0 RG 2 w 20 20 m 260 140 l S"
            + " BT /F1 18 Tf 140 30 Td (y = x) Tj ET",
        ),
        (100, 100, "0.8 0.2 0.2 rg 10 10 80 80 re f"),
    ]
)


def _project(tmp_path: Path) -> Path:
    (tmp_path / "figures").mkdir(parents=True)
    (tmp_path / "figures" / "plot.pdf").write_bytes(FIGURE)
    (tmp_path / "slides").mkdir()
    return tmp_path


def _slide_svg(project: Path, body: str) -> None:
    (project / "slides" / "s.svg").write_text(
        f'<svg xmlns="{_SVG}" viewBox="0 0 1920 1080">{body}'
        + '<rect id="zone-media" x="1000" y="100" width="800" height="600"/></svg>',
        encoding="utf-8",
    )


def _installed(*names: str) -> Callable[[str], str | None]:
    """A ``shutil.which`` that finds only ``names``."""
    return lambda name: f"/usr/bin/{name}" if name in names else None


def _images(svg: str) -> list[dict[str, str]]:
    root = parse_svg(svg)
    return [
        {str(k): str(v) for k, v in el.attrib.items()}
        for el in root.iter(f"{{{_SVG}}}image", f"{{{_XHTML}}}img")
        if el.get("data-inkflow-pdf")
    ]


DECK_PY = """\
from inkflow import Deck, Image, Slide


def main() -> Deck:
    return Deck(
        slides=[Slide("slides/s.svg", zones={"media": Image("figures/plot.pdf")})],
        embed_fonts=False,
    )
"""


@needs_pdftocairo
def test_editor_writes_back_the_pdf_reference(tmp_path: Path) -> None:
    from inkflow.provenance import INK

    project = _project(tmp_path)
    _slide_svg(
        project,
        '<image id="fig" href="../figures/plot.pdf#page=2" x="0" y="0"'
        + ' width="400" height="400"/>',
    )
    (project / "deck.py").write_text(DECK_PY, encoding="utf-8")
    deck = load_deck(project / "deck.py")
    slides = process_deck(deck, project, project / "deck.py", editor=True)
    image = next(i for i in _images(slides[0]["svg"]) if i.get("id") == "fig")
    session = EditorSession(project / "deck.py")
    svg = project / "slides" / "s.svg"
    # Moving it (what the canvas sends), then cropping it.
    for ops in (
        [{"kind": "attrs", "loc": image[INK], "set": {"x": "50"}}],
        [{"kind": "crop-frame", "loc": image[INK]}],
    ):
        result = session.apply(
            {
                "action": "svg",
                "file": str(svg),
                "hash": file_hash(svg.read_bytes()),
                "ops": ops,
            },
            deck,
        )
        assert result["ok"]
    text = svg.read_text()
    assert "_pdf" not in text and "data-inkflow-pdf" not in text
    written = parse_svg(text).find(f".//{{{_SVG}}}image")
    assert written is not None and written.get("href") == "../figures/plot.pdf#page=2"
    frame = written.getparent()
    assert frame is not None and frame.tag == f"{{{_SVG}}}svg"  # cropped

    # The zone's page, picked in its panel.
    session.apply(
        {
            "action": "zone-media",
            "slide": 0,
            "zone": "media",
            "src": str(project / "figures" / "plot.pdf"),
            "page": 2,
        },
        deck,
    )
    assert 'Image("figures/plot.pdf#page=2")' in (project / "deck.py").read_text()


@needs_pdftocairo
def test_page_picker_actions(tmp_path: Path) -> None:
    project = _project(tmp_path)
    (project / "deck.py").write_text(DECK_PY, encoding="utf-8")
    session = EditorSession(project / "deck.py")
    info = session.apply({"action": "pdf-pages", "path": "figures/plot.pdf"}, None)
    assert info["pages"] == 2 and info["converter"] == pdf.converter()
    assert info["ignored"] is False
    page = session.apply(
        {"action": "pdf-page", "path": "figures/plot.pdf#page=2", "page": 2}, None
    )
    url = cast("str", page["url"])
    assert url.startswith("_pdf/plot-p2-")
    assert AssetRoots(project).locate(url) is not None
    for bad in ("../x.pdf", "deck.py", "figures/none.pdf"):
        with pytest.raises(EditError):
            session.apply({"action": "pdf-pages", "path": bad}, None)
    with pytest.raises(EditError, match="could not convert page 9"):
        session.apply(
            {"action": "pdf-page", "path": "figures/plot.pdf", "page": 9}, None
        )


def test_pdfs_upload_and_open(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from inkflow.edit import open_choices, resolve_edit_commands
    from inkflow_editor import media

    project = _project(tmp_path)
    staged = project / "upload.part"
    staged.write_bytes(FIGURE)
    assert media.settle(project, staged, "Figure 3.pdf") == project / "assets" / (
        "figure-3.pdf"
    )
    monkeypatch.setattr(
        "inkflow.edit.shutil.which",
        _installed("okular", "inkscape"),
    )
    apps = open_choices(project / "figures" / "plot.pdf", resolve_edit_commands())
    assert [a.id for a in apps] == ["okular", "inkscape", "system"]


def test_copied_objects_bring_the_pdf_and_keep_the_page(tmp_path: Path) -> None:
    project = _project(tmp_path)
    files = export_assets(project, ["figures/plot.pdf#page=2"])
    assert list(files) == ["figures/plot.pdf"]
    xml = '<image href="figures/plot.pdf#page=2"/>'
    moved = retarget_fragment(xml, "slides/s.svg", {"figures/plot.pdf": "a/p.pdf"})
    assert moved == '<image href="../a/p.pdf#page=2"/>'
