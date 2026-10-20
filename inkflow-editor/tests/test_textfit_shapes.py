"""The editor's CLI part of the core's tests (moved with the commands)."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
from click.testing import CliRunner

from inkflow.cli import main

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


def _shape(project: Path, *args: str) -> str:
    result = CliRunner().invoke(
        main, ["shape", *args, "--deck", str(project / "deck.py")]
    )
    assert result.exit_code == 0, result.output
    return result.output


class TestShapeStyle:
    def test_own_text_box_gets_its_style(self, project: Path) -> None:
        _shape(project, "style", "-s", "4", "note", "--font-scale", "80%")
        _shape(project, "style", "-s", "4", "note", "--fit", "none")
        svg = (project / "slides" / "drawn.svg").read_text()
        assert 'style="--inkflow-font-scale:0.8;--inkflow-fit:none"' in svg
        _shape(
            project, "style", "-s", "4", "note", "--font-scale", "1", "--fit", "shrink"
        )
        assert "--inkflow" not in (project / "slides" / "drawn.svg").read_text()

    def test_layout_zone_is_set_on_the_slide(self, project: Path) -> None:
        _shape(project, "style", "-s", "1", "content", "--font-scale", "0.5")
        assert "::content size=50%::" in (project / "slides" / "text.md").read_text()
        # The layout is left alone.
        assert "inkflow" not in (project / "layouts" / "two.svg").read_text()

    def test_bad_values(self, project: Path) -> None:
        result = CliRunner().invoke(
            main,
            [
                "shape",
                "style",
                "-s",
                "4",
                "note",
                "--font-scale",
                "9",
                "--deck",
                str(project / "deck.py"),
            ],
        )
        assert result.exit_code != 0
