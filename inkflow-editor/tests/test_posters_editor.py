"""The editor's part of test_posters.py: the tests that need inkflow-editor."""

from __future__ import annotations

from pathlib import Path
from typing import cast

import pytest

from inkflow.init import scaffold_poster
from inkflow.pipeline import process_deck
from inkflow.server import load_deck
from inkflow_editor import projects
from inkflow_editor.model import build_model
from inkflow_editor.previews import layout_previews


@pytest.fixture
def poster(tmp_path: Path) -> Path:
    scaffold_poster(tmp_path / "poster")
    return tmp_path / "poster"


def test_new_deck_poster_look(tmp_path: Path) -> None:
    info = projects.new_deck_info(None, None)
    assert any(t["id"] == "poster" for t in projects.THEMES)
    sizes = info["posterSizes"]
    assert (
        isinstance(sizes, list)
        and {"id": "a0", "label": "A0 portrait (841 x 1189 mm)"} in sizes
    )
    deck_py = projects.create_deck(
        tmp_path / "conf", title="Our poster", theme="poster", git=False, size="a1"
    )
    text = deck_py.read_text()
    assert 'size="a1"' in text and 'title="Our poster"' in text
    with pytest.raises(projects.ProjectError, match="paper size"):
        projects.create_deck(
            tmp_path / "bad", title="", theme="poster", git=False, size="9:16"
        )


def test_editor_model_and_gallery_for_a_poster(poster: Path) -> None:
    deck = load_deck(poster / "deck.py")
    slides = process_deck(deck, poster, poster / "deck.py", editor=True)
    model = build_model(deck, poster / "deck.py", slides)
    layouts = cast("list[dict[str, str]]", model["layouts"])
    names = [entry["name"] for entry in layouts]
    assert names == ["poster-2col", "poster-3col"]
    previews = layout_previews(deck, poster / "deck.py")
    assert [p["name"] for p in previews] == ["poster-3col", "poster-2col"]
    assert "Section" in str(previews[0]["svg"])
