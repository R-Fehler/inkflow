"""The layouts and overlays a deck offers, and which slides use each."""

from __future__ import annotations

from pathlib import Path

import pytest

from inkflow.catalog import (
    background_name,
    layout_entries,
    overlay_entries,
    slide_layouts,
)
from inkflow.layout import builtin_theme_dir, layout_zones
from inkflow.manifest import Deck, Slide
from inkflow.overlay import Overlay
from inkflow.pipeline import process_deck
from inkflow.server import load_deck

_OWN = (
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"'
    + ' inkflow:parent="content" viewBox="0 0 1920 1080">'
    + '<rect id="zone-aside" x="0" y="0" width="10" height="10"/></svg>'
)
_FOOTER = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
    + '<text id="footer" x="10" y="1070">Footer</text></svg>'
)

# The built-in 16:9 layouts and their zones, as docs/design/layouts.md lists them.
_BUILT_IN = {
    "agenda": {"title", "content"},
    "three-cols": {"title", "left", "middle", "right"},
    "comparison": {"title", "left-title", "left", "right-title", "right"},
    "quad": {"title", "top-left", "top-right", "bottom-left", "bottom-right"},
    "three-cards": {
        "title",
        *(f"media-{n}" for n in (1, 2, 3)),
        *(f"card-{n}" for n in (1, 2, 3)),
    },
    "title-media": {"title", "media", "caption"},
    "full-media": {"media", "title", "subtitle"},
}


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "layouts").mkdir()
    (tmp_path / "layouts" / "own.svg").write_text(_OWN, encoding="utf-8")
    (tmp_path / "overlays").mkdir()
    (tmp_path / "overlays" / "footer.svg").write_text(_FOOTER, encoding="utf-8")
    (tmp_path / "overlays" / "draft.svg").write_text(_FOOTER, encoding="utf-8")
    return tmp_path


def _deck() -> Deck:
    return Deck(
        overlays=[Overlay("footer")],
        slides=[
            Slide("cover"),
            Slide("content"),
            Slide("own"),
            Slide("quad", overlays=[]),
        ],
    )


def test_layout_entries_count_direct_slides_and_reach(project: Path) -> None:
    entries = layout_entries(_deck(), project)
    assert entries["own"].source == "local"
    assert entries["own"].parent == "content"
    assert entries["own"].slides == [2]
    assert entries["content"].slides == [1]
    # content's chain carries the slide on own too; title every one built on it.
    assert entries["content"].reach == [1, 2]
    assert entries["title"].slides == [] and entries["title"].reach == [1, 2, 3]
    assert entries["base"].reach == [0, 1, 2, 3]
    assert entries["agenda"].slides == [] and entries["agenda"].reach == []
    # The deck is 16:9: the poster layouts are not offered.
    assert not any(name.startswith("poster-") for name in entries)
    assert background_name(entries) == "base"


def test_a_project_layout_of_a_theme_name_shadows_it(project: Path) -> None:
    (project / "layouts" / "agenda.svg").write_text(_OWN, encoding="utf-8")
    deck = Deck(slides=[Slide("agenda")])
    entries = layout_entries(deck, project)
    assert entries["agenda"].source == "local" and entries["agenda"].shadows
    assert entries["agenda"].slides == [0]
    assert not entries["own"].shadows


def test_slide_layouts(project: Path) -> None:
    deck = Deck(slides=[Slide("own"), Slide("missing")])
    (direct, chain), (none, empty) = slide_layouts(deck, project)
    assert direct == (project / "layouts" / "own.svg").resolve()
    assert [p.stem for p in chain] == ["base", "numbered", "title", "content", "own"]
    assert none is None and empty == []


def test_overlay_entries(project: Path) -> None:
    entries = overlay_entries(_deck(), project)
    by_name = {e.name: e for e in entries}
    assert by_name["footer"].deck and by_name["footer"].source == "local"
    assert by_name["footer"].slides == [0, 1, 2]  # quad has overlays=[]
    assert not by_name["draft"].deck and by_name["draft"].slides == []
    assert [e.name for e in entries] == ["footer", "draft"]


@pytest.mark.parametrize("name", sorted(_BUILT_IN))
def test_built_in_layout_zones(name: str) -> None:
    path = builtin_theme_dir() / "layouts" / f"{name}.svg"
    info = layout_zones(path, None, None)
    assert set(info.zones) == _BUILT_IN[name]
    assert info.numbered == (name != "full-media")


def test_showcase_walks_through_every_built_in_layout() -> None:
    showcase = builtin_theme_dir() / "showcase"
    deck = load_deck(showcase / "deck.py")
    entries = layout_entries(deck, showcase)
    unused = {name for name, e in entries.items() if not e.slides}
    assert unused == {"base", "numbered", "title"}
    slides = process_deck(deck, showcase, showcase / "deck.py")
    for slide, source in zip(slides, deck.slides, strict=True):
        assert f"layout-{source.src}" in slide["svg"]
        # Every zone the layout has was filled (unfilled ones are pruned).
        for zone in _BUILT_IN.get(source.src, set()):
            assert f'id="zone-{zone}"' in slide["svg"], (source.src, zone)
