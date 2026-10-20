"""The editor's part of test_sizes.py: the tests that need inkflow-editor."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from inkflow.pipeline import process_deck
from inkflow.server import load_deck
from inkflow.svgio import parse_svg_file
from inkflow_editor.agent.outline import build_outline, format_outline
from inkflow_editor.model import build_model
from inkflow_editor.session import EditorSession

POSTER_DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(size="a0", slides=[Slide("poster.svg")])
""")


POSTER_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3179 4494">'
    '<rect id="box" x="100" y="100" width="400" height="300"/></svg>'
)


@pytest.fixture
def poster(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "poster.svg").write_text(POSTER_SVG, encoding="utf-8")
    (tmp_path / "deck.py").write_text(POSTER_DECK, encoding="utf-8")
    return tmp_path


def test_editor_new_slide_is_poster_sized(poster: Path) -> None:
    session = EditorSession(poster / "deck.py")
    session.apply(
        {"action": "slide", "op": "new", "after": 0}, load_deck(poster / "deck.py")
    )
    deck = load_deck(poster / "deck.py")
    assert len(deck.slides) == 2
    new = parse_svg_file(poster / "slides" / deck.slides[1].src)
    assert new.get("viewBox") == "0 0 3179 4494"


def test_model_and_outline_report_the_size(poster: Path) -> None:
    deck = load_deck(poster / "deck.py")
    slides = process_deck(deck, poster, poster / "deck.py", editor=True)
    model = build_model(deck, poster / "deck.py", slides)
    size = model["deckSize"]
    assert size == {
        "name": "a0",
        "label": "A0 portrait (841 x 1189 mm)",
        "canvas": [3179, 4494],
        "page": [2383.94, 3370.39],
        "print": True,
        "fontSize": 40,
    }
    text = format_outline(build_outline(deck, poster / "deck.py", slides))
    head = text.splitlines()[0]
    assert "size a0: A0 portrait (841 x 1189 mm), canvas 3179x4494" in head
    assert "mode light" in head
