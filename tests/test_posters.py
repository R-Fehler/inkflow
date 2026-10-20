"""Posters: the built-in poster layouts and scaffolding."""

from __future__ import annotations

from pathlib import Path

import pytest
from click.testing import CliRunner

from inkflow.cli import main
from inkflow.init import poster_layout, scaffold_poster
from inkflow.layout import discover_layouts, layout_canvas, layouts_for
from inkflow.pipeline import process_deck
from inkflow.server import load_deck
from inkflow.sizes import PageSize
from inkflow.svgio import parse_svg
from inkflow.themes import Builtin

POSTER_LAYOUTS = {
    "poster-2col": (3179, 4494, 2),
    "poster-3col": (3179, 4494, 3),
    "poster-landscape-3col": (4494, 3179, 3),
    "poster-landscape-4col": (4494, 3179, 4),
}


def _layouts() -> dict[str, Path]:
    return {p.stem: p for _, p in discover_layouts(None, Builtin())}


@pytest.mark.parametrize("name", sorted(POSTER_LAYOUTS))
def test_poster_layouts_are_a_shaped_with_their_zones(name: str) -> None:
    from inkflow.layout import layout_zones

    w, h, cols = POSTER_LAYOUTS[name]
    path = _layouts()[name]
    assert layout_canvas(path) == (w, h)
    zones = set(layout_zones(path, None, Builtin()).zones)
    assert {f"col-{i}" for i in range(1, cols + 1)} <= zones
    assert {"title", "authors", "affiliations", "logos", "references", "contact"} <= (
        zones
    )
    assert f"col-{cols + 1}" not in zones


def test_poster_decks_are_offered_poster_layouts(tmp_path: Path) -> None:
    found = discover_layouts(tmp_path, Builtin())
    screen = {p.stem for _, p in layouts_for(found, PageSize.WIDESCREEN)}
    assert "content" in screen
    assert not any(name.startswith("poster") for name in screen)
    portrait = {p.stem for _, p in layouts_for(found, PageSize.A1)}
    assert portrait == {"poster-base", "poster-2col", "poster-3col"}
    landscape = {p.stem for _, p in layouts_for(found, PageSize("a0-landscape"))}
    assert landscape == {
        "poster-landscape-base",
        "poster-landscape-3col",
        "poster-landscape-4col",
    }
    # A shape no built-in layout has: every layout is offered.
    assert len(layouts_for(found, PageSize.LETTER)) == len(found)


def test_project_layouts_are_offered_whatever_their_shape(tmp_path: Path) -> None:
    (tmp_path / "layouts").mkdir()
    (tmp_path / "layouts" / "mine.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 768"/>'
    )
    found = discover_layouts(tmp_path, Builtin())
    names = {p.stem for _, p in layouts_for(found, PageSize.A0)}
    assert "mine" in names


@pytest.fixture
def poster(tmp_path: Path) -> Path:
    scaffold_poster(tmp_path / "poster")
    return tmp_path / "poster"


def test_scaffold_poster(poster: Path) -> None:
    deck = load_deck(poster / "deck.py")
    assert deck.size == "a0"
    assert deck.slides[0].src == "poster-3col"
    for rel in ("slides/poster.md", "figures/method.svg", "figures/logo.svg"):
        assert (poster / rel).is_file()
    slides = process_deck(deck, poster, poster / "deck.py")
    svg = slides[0]["svg"]
    root = parse_svg(svg)
    assert root.get("viewBox") == "0 0 3179 4494"
    for zone in ("title", "authors", "col-1", "col-2", "col-3", "references"):
        assert f'id="zone-{zone}"' in svg
    assert "<table" in svg  # the results, a Markdown table
    assert "method.svg" in svg


def test_scaffold_poster_landscape_and_refusals(tmp_path: Path) -> None:
    sheet = scaffold_poster(tmp_path / "wide", "a1-landscape")
    assert sheet == "a1-landscape"
    assert load_deck(tmp_path / "wide" / "deck.py").slides[0].src == (
        "poster-landscape-3col"
    )
    assert poster_layout(PageSize.A2) == "poster-3col"
    with pytest.raises(ValueError, match="paper size"):
        scaffold_poster(tmp_path / "screen", "16:9")


def test_init_poster_cli(tmp_path: Path) -> None:
    target = tmp_path / "my-poster"
    result = CliRunner().invoke(main, ["init", str(target), "--size", "a1", "--no-git"])
    assert result.exit_code == 0, result.output
    assert "A1 portrait" in result.output
    assert 'size="a1"' in (target / "deck.py").read_text()
    bad = CliRunner().invoke(main, ["init", str(tmp_path / "x"), "--size", "4:3"])
    assert bad.exit_code != 0 and "paper size" in bad.output
