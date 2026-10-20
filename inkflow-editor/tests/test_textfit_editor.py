"""The editor's part of test_textfit.py: the tests that need inkflow-editor."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from inkflow.manifest import TextBox, format_text_scale, parse_text_scale
from inkflow.pipeline import process_deck
from inkflow.server import load_deck
from inkflow.svgio import parse_svg
from inkflow_editor.agent.outline import build_outline, format_outline
from inkflow_editor.codegen import Code
from inkflow_editor.session import EditError, EditorSession

XHTML = "http://www.w3.org/1999/xhtml"


def _wrapper_style(svg: str, zone: str) -> str:
    fo = parse_svg(svg).find(f'.//*[@id="zone-{zone}"]')
    assert fo is not None
    wrapper = fo.find(f"{{{XHTML}}}div")
    assert wrapper is not None
    return wrapper.get("style") or ""


class TestTextScale:
    @pytest.mark.parametrize(
        ("text", "scale"), [("80%", 0.8), ("0.8", 0.8), ("150 %", 1.5), ("25%", 0.25)]
    )
    def test_parse(self, text: str, scale: float) -> None:
        assert parse_text_scale(text) == pytest.approx(scale)

    @pytest.mark.parametrize("text", ["20%", "3.5", "big", "80"])
    def test_refused(self, text: str) -> None:
        with pytest.raises(ValueError):
            parse_text_scale(text)

    def test_format(self) -> None:
        assert format_text_scale(0.8) == "80%"
        assert format_text_scale(0.67) == "67%"
        assert format_text_scale(1.125) == "112.5%"

    def test_textbox_checks_its_size(self) -> None:
        assert TextBox("x", size=0.8).size == 0.8
        with pytest.raises(ValueError, match="between"):
            TextBox("x", size=5)

    def test_codegen_writes_the_new_fields(self) -> None:
        code = Code().call(TextBox("Hi", size=0.8, fit=False))
        assert code == 'TextBox(text="Hi", size=0.8, fit=False)'


LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")


DRAWN = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="two" viewBox="0 0 1920 1080">
      <rect id="zone-note" x="100" y="700" width="600" height="200"/>
    </svg>
""")


DECK = textwrap.dedent("""\
    from inkflow import Deck, Inline, Slide, TextBox


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide("two", md="text.md"),
                Slide("two", zones={"title": "Hello", "content": TextBox("Boxed")}),
                Slide("two", md=Inline("# Inline\\n\\nBody")),
                Slide("drawn.svg", md="drawn.md"),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for sub in ("slides", "layouts"):
        (tmp_path / sub).mkdir()
    (tmp_path / "layouts" / "two.svg").write_text(LAYOUT, encoding="utf-8")
    (tmp_path / "slides" / "drawn.svg").write_text(DRAWN, encoding="utf-8")
    (tmp_path / "slides" / "text.md").write_text("# Title\n\nBody\n", encoding="utf-8")
    (tmp_path / "slides" / "drawn.md").write_text("::note::\nNote\n", encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


def _deck(project: Path):
    return load_deck(project / "deck.py")


def _format(project: Path, **msg: object) -> dict[str, object]:
    session = EditorSession(project / "deck.py")
    return session.apply({"action": "zone-format", **msg}, _deck(project))


class TestZoneFormat:
    def test_markdown_zone_gets_a_marker_param(self, project: Path) -> None:
        _format(project, slide=0, zone="content", size=0.8)
        md = (project / "slides" / "text.md").read_text()
        assert md == "# Title\n\n::content size=80%::\nBody\n"
        svg = process_deck(_deck(project), project, project / "deck.py")[0]["svg"]
        assert "--inkflow-font-scale:0.8" in _wrapper_style(svg, "content")
        # Fit off, then back to the default: the marker loses it again.
        _format(project, slide=0, zone="content", fit="none")
        assert (
            "::content size=80% fit=none::" in (project / "slides/text.md").read_text()
        )
        _format(project, slide=0, zone="content", fit=None, size=None)
        assert "::content::" in (project / "slides" / "text.md").read_text()

    def test_one_undo_step(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        before = (project / "slides" / "text.md").read_text()
        session.apply(
            {"action": "zone-format", "slide": 0, "zone": "title", "size": "150%"},
            _deck(project),
        )
        assert "::title size=150%::" in (project / "slides" / "text.md").read_text()
        session.apply({"action": "undo"}, _deck(project))
        assert (project / "slides" / "text.md").read_text() == before

    def test_textbox_gets_its_fields(self, project: Path) -> None:
        _format(project, slide=1, zone="content", size=0.67, fit="none")
        box = _deck(project).slides[1].zones["content"]
        assert box == TextBox("Boxed", size=0.67, fit=False)
        _format(project, slide=1, zone="content", fit="shrink")
        box = _deck(project).slides[1].zones["content"]
        assert isinstance(box, TextBox) and box.fit is True and box.size == 0.67

    def test_deck_string_moves_to_markdown(self, project: Path) -> None:
        _format(project, slide=1, zone="title", size=1.15)
        slide = _deck(project).slides[1]
        assert "title" not in slide.zones
        md = (project / "slides" / f"{slide.md}").read_text()
        assert "size=115%" in md and "Hello" in md

    def test_inline_markdown(self, project: Path) -> None:
        _format(project, slide=2, zone="content", fit="none")
        inline = str(_deck(project).slides[2].md)
        assert "::content fit=none::" in inline and "Body" in inline

    def test_refusals(self, project: Path) -> None:
        with pytest.raises(EditError, match="between"):
            _format(project, slide=0, zone="content", size=9)
        with pytest.raises(EditError, match="shrink or none"):
            _format(project, slide=0, zone="content", fit="sometimes")


def test_outline_shows_size_and_fit(project: Path) -> None:
    (project / "slides" / "text.md").write_text(
        "# Title\n\n::content size=80% fit=none::\nBody\n"
    )
    (project / "slides" / "drawn.svg").write_text(
        DRAWN.replace(
            'height="200"/>', 'height="200" style="--inkflow-font-scale:1.5"/>'
        )
    )
    deck = _deck(project)
    deck_path = project / "deck.py"
    outline = build_outline(
        deck, deck_path, process_deck(deck, project, deck_path, editor=True)
    )
    one = format_outline(outline, 1)
    assert "size 80%" in one and "fit off" in one
    assert "size 150%" in format_outline(outline, 4)
