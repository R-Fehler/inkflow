"""Sections: named groups of consecutive slides, written as ``Section(...)``
entries in ``Deck(slides=[...])`` and edited through the session's ``slide``
action as one undoable step each."""

from __future__ import annotations

import pytest

from inkflow import Deck, Section, Slide


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
