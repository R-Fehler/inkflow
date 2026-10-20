"""The editor's part of test_render_boxes.py: the tests that need inkflow-editor."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
from click.testing import CliRunner

from inkflow.cli import main
from inkflow.export import find_chromium

_DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide(
                    "slide.svg",
                    zones={
                        "content": "# Title\\n\\nA paragraph.\\n\\n- one\\n- two",
                        "side": "\\n\\n".join(["A paragraph of text."] * 14),
                    },
                ),
            ],
        )
""")


_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" fill="#fff"/>
      <rect id="zone-content" x="100" y="100" width="800" height="600"/>
      <rect id="zone-side" x="1000" y="100" width="800" height="200"/>
      <g id="group" transform="translate(100 50)">
        <rect id="logo" x="1700" y="850" width="100" height="100" fill="red"/>
      </g>
      <text id="label" x="100" y="900" font-size="40">Label text</text>
    </svg>
""")


@pytest.fixture
def deck(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "slide.svg").write_text(_SVG)
    (tmp_path / "deck.py").write_text(_DECK)
    return tmp_path / "deck.py"


needs_chromium = pytest.mark.skipif(
    find_chromium() is None, reason="no Chromium available"
)


@needs_chromium
def test_outline_adds_boxes(deck: Path) -> None:
    result = CliRunner().invoke(
        main, ["outline", "--deck", str(deck), "-s", "1", "--boxes"]
    )
    assert result.exit_code == 0, result.output
    assert "boxes (as rendered, slide units):" in result.output
    assert "logo  1800,900 100x100  rect" in result.output
    result = CliRunner().invoke(main, ["outline", "--deck", str(deck), "--boxes"])
    assert result.exit_code == 2
