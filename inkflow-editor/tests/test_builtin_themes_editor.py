"""The editor's part of test_builtin_themes.py: the tests that need inkflow-editor."""

from __future__ import annotations

from pathlib import Path
from typing import cast

import pytest

from inkflow import ColorMode, Paper, Stage, init
from inkflow.builtin_themes import THEMES
from inkflow.server import load_deck
from inkflow.themes import Builtin, Theme
from inkflow_editor import projects
from inkflow_editor.session import EditError, EditorSession


@pytest.fixture
def _recent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(projects, "_recent_file", lambda: tmp_path / "recent.json")


@pytest.mark.usefixtures("_recent")
@pytest.mark.parametrize(("look", "cls"), [("paper", Paper), ("stage", Stage)])
def test_new_deck_looks(look: str, cls: type[Theme], tmp_path: Path) -> None:
    deck_py = projects.create_deck(tmp_path / look, title="Mine", theme=look, git=False)
    deck = load_deck(deck_py)
    assert isinstance(deck.theme, cls) and deck.title == "Mine"
    assert (deck_py.parent / "slides" / "title.svg").is_file()


@pytest.mark.usefixtures("_recent")
def test_new_deck_info_previews_each_look() -> None:
    info = projects.new_deck_info(None, None)
    looks = {
        cast("str", t["id"]): t for t in cast("list[dict[str, object]]", info["themes"])
    }
    assert {"starter", "paper", "stage", "poster"} <= set(looks)
    paper = cast("dict[str, str]", looks["paper"]["preview"])
    stage = cast("dict[str, str]", looks["stage"]["preview"])
    assert paper["bg"] == Paper.light.bg and paper["accent"] == Paper.light.accent
    assert stage["bg"] == Stage.dark.bg
    assert cast("dict[str, str]", looks["poster"]["preview"])["bg"] == (
        Builtin.light.bg
    )


def test_theme_dialog_switches_the_deck_theme(tmp_path: Path) -> None:
    init.scaffold(tmp_path)
    deck_py = tmp_path / "deck.py"
    session = EditorSession(deck_py)
    info = cast(
        "dict[str, object]",
        session.apply({"action": "theme-get"}, load_deck(deck_py))["theme"],
    )
    assert info["theme"] == "default"
    assert [t["id"] for t in cast("list[dict[str, str]]", info["themes"])] == list(
        THEMES
    )

    session.apply({"action": "theme-set", "theme": "paper"}, load_deck(deck_py))
    code = deck_py.read_text(encoding="utf-8")
    assert "theme=Paper()" in code and "Paper" in code.splitlines()[0]
    assert isinstance(load_deck(deck_py).theme, Paper)

    session.apply(
        {"action": "theme-set", "theme": "stage", "mode": "light"},
        load_deck(deck_py),
    )
    deck = load_deck(deck_py)
    assert isinstance(deck.theme, Stage) and deck.mode == ColorMode.LIGHT
    info = cast(
        "dict[str, object]", session.apply({"action": "theme-get"}, deck)["theme"]
    )
    assert info["theme"] == "stage" and info["name"] == "Stage"

    session.apply({"action": "theme-set", "theme": "default"}, load_deck(deck_py))
    assert type(load_deck(deck_py).theme) is Builtin
    assert "theme=" not in deck_py.read_text(encoding="utf-8")
    with pytest.raises(EditError, match="unknown theme"):
        session.apply({"action": "theme-set", "theme": "nord"}, load_deck(deck_py))

    # One undoable step each.
    session.apply({"action": "undo"}, load_deck(deck_py))
    assert isinstance(load_deck(deck_py).theme, Stage)
