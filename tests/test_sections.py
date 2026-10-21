"""Sections: named groups of consecutive slides, written as ``Section(...)``
entries in ``Deck(slides=[...])``; each built slide says which one it is in."""

from __future__ import annotations

import os
import textwrap
from pathlib import Path

import pytest

from inkflow import Deck, Section, Slide, deps
from inkflow.incremental import SlideCache
from inkflow.pipeline import process_deck
from inkflow.server import load_deck


class TestDeck:
    def test_sections_flatten_into_the_slide_list(self) -> None:
        a, b, c, d = (Slide(x) for x in "abcd")
        deck = Deck(
            slides=[
                a,
                Section("Method", slides=[b, c]),
                Section("Empty"),
                Section("End", [d]),
            ]
        )
        assert deck.slides == [a, b, c, d]
        assert [s.name for s in deck.sections] == ["Method", "Empty", "End"]
        assert deck.section_ranges() == [range(1, 3), range(3, 3), range(3, 4)]
        assert [deck.section_of(i) for i in range(4)] == [None, 0, 0, 2]

    def test_a_deck_without_sections_is_unchanged(self) -> None:
        deck = Deck(slides=[Slide("a")])
        assert deck.sections == [] and deck.section_ranges() == []
        assert Deck().slides == []
        deck.slides = [Slide("b")]  # assigning a plain list still works
        assert [s.src for s in deck.slides] == ["b"]

    def test_hidden_slides_keep_their_section(self) -> None:
        deck = Deck(slides=[Section("S", slides=[Slide("a", visible=False)])])
        assert deck.section_of(0) == 0

    def test_a_slide_after_a_section_is_refused(self) -> None:
        with pytest.raises(ValueError, match="belongs in one"):
            Deck(slides=[Section("A", slides=[Slide("a")]), Slide("b")])

    def test_names_are_required_but_may_repeat(self) -> None:
        with pytest.raises(ValueError, match="needs a name"):
            Section("  ")
        deck = Deck(slides=[Section("Part"), Section("Part")])
        assert len(deck.sections) == 2

    def test_sections_do_not_nest(self) -> None:
        with pytest.raises(TypeError, match="do not nest"):
            Section("A", slides=[Section("B")])  # pyright: ignore[reportArgumentType]

    def test_only_slides_and_sections(self) -> None:
        with pytest.raises(TypeError, match="Slide and Section"):
            Deck(slides=["a"])  # pyright: ignore[reportArgumentType]


LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
    </svg>
""")

DECK = textwrap.dedent("""\
    from inkflow import Deck, Section, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide("plain", title="Title"),
                Section(
                    "Method",
                    slides=[
                        Slide("plain", title="Setup"),
                        Slide("plain", title="Data"),
                    ],
                ),
                Section("Results", slides=[Slide("plain", title="Plots")]),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "layouts").mkdir()
    (tmp_path / "layouts" / "plain.svg").write_text(LAYOUT, encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


def test_built_slides_carry_their_section(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    deck.slides[1].visible = False  # hidden: its section still counts it
    slides = process_deck(deck, project, project / "deck.py")
    assert [s["title"] for s in slides] == ["Title", "Data", "Plots"]
    assert "section" not in slides[0]
    assert slides[1].get("section") == {"name": "Method", "index": 0}
    assert slides[2].get("section") == {"name": "Results", "index": 1}


def test_sections_share_a_name_but_not_an_index(project: Path) -> None:
    deck = Deck(
        embed_fonts=False,
        slides=[
            Section("Part", slides=[Slide("plain", title="a")]),
            Section("Part", slides=[Slide("plain", title="b")]),
        ],
    )
    slides = process_deck(deck, project, project / "deck.py")
    assert [s.get("section") for s in slides] == [
        {"name": "Part", "index": 0},
        {"name": "Part", "index": 1},
    ]


def test_a_kept_slide_takes_its_new_section(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Sections are the deck's, outside the slide cache: renaming one or
    moving a slide into another processes no slide."""
    # Files just written are not trusted by their time stamps: give them old ones.
    monkeypatch.setattr(deps, "RACY_NS", 0)
    old = 1_700_000_000_000_000_000
    for path in project.rglob("*.*"):
        os.utime(path, ns=(old, old))
    cache = SlideCache()
    deck_path = project / "deck.py"
    _ = process_deck(load_deck(deck_path), project, deck_path, cache=cache)
    deck_path.write_text(
        DECK.replace('"Method"', '"How"')
        .replace(
            'Section("Results", slides=[',
            'Section("Results", slides=[Slide("plain", title="Data"), ',
        )
        .replace('                    Slide("plain", title="Data"),\n', "", 1),
        encoding="utf-8",
    )
    slides = process_deck(load_deck(deck_path), project, deck_path, cache=cache)
    assert cache.processed == []
    assert [(s["title"], s.get("section")) for s in slides] == [
        ("Title", None),
        ("Setup", {"name": "How", "index": 0}),
        ("Data", {"name": "Results", "index": 1}),
        ("Plots", {"name": "Results", "index": 1}),
    ]
