"""The editor with upstream's camera cue (`animations.Frame`): listed as a
camera cue (never a video's), its click found, written back as authors
write it."""

from __future__ import annotations

from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner

from inkflow.cli import main
from inkflow.pipeline import process_deck
from inkflow.server import load_deck
from inkflow_editor.model import build_model

DECK = """\
from inkflow import Deck, Slide, animations


def main():
    return Deck(
        slides=[
            Slide(
                "slides/one.svg",
                animations=[
                    animations.Frame("box", margin=4),
                    animations.Frame(),
                ],
            )
        ]
    )
"""

SLIDE = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
    '<rect id="box" x="10" y="10" width="100" height="100"/></svg>'
)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "one.svg").write_text(SLIDE)
    (tmp_path / "deck.py").write_text(DECK)
    return tmp_path


def test_the_model_lists_frames_as_camera_cues(project: Path) -> None:
    deck_path = project / "deck.py"
    deck = load_deck(deck_path)
    built = process_deck(deck, project, deck_path, editor=True)
    model = build_model(deck, deck_path, built)
    slides = cast("list[dict[str, object]]", model["slides"])
    cues = cast("list[dict[str, object]]", slides[0]["animations"])
    assert [(c["type"], c["slug"], c["kind"], c["element"]) for c in cues] == [
        ("Frame", "frame", "camera", "box"),
        ("Frame", "frame", "camera", "@full-slide"),
    ]
    catalog = cast("list[dict[str, object]]", model["animationTypes"])
    types = {t["type"]: t for t in catalog}
    assert types["Frame"]["kind"] == "camera"
    assert types["PlayVideo"]["kind"] == "video"


def test_anim_lists_and_adds_frames(project: Path) -> None:
    deck = str(project / "deck.py")
    listed = CliRunner().invoke(main, ["anim", "list", "-s", "1", "--deck", deck])
    assert listed.exit_code == 0, listed.output
    assert "#box" in listed.output and "(full slide)" in listed.output
    added = CliRunner().invoke(
        main, ["anim", "add", "frame", "full-slide", "-s", "1", "--deck", deck]
    )
    assert added.exit_code == 0, added.output
    code = (project / "deck.py").read_text()
    assert code.count("animations.Frame()") == 2
    assert len(load_deck(project / "deck.py").slides[0].animations) == 3
