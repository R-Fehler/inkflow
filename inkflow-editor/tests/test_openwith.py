"""The editor's "Open in…" menu: which programs it offers for a file."""

from __future__ import annotations

from pathlib import Path

import pytest

from inkflow.edit import EditCommands
from inkflow_editor import openwith

_ENV_VARS = ("INKFLOW_EDIT_CMD", "INKFLOW_EDIT_CMD_SVG")


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch: pytest.MonkeyPatch):
    for name in _ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    yield


def test_open_choices_offer_installed_programs_then_the_system_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name in ("inkscape", "code") else None

    monkeypatch.setattr("inkflow_editor.openwith.shutil.which", which)
    choices = openwith.open_choices(
        Path("slide.svg"), EditCommands(default=None, svg=None)
    )
    assert [c.id for c in choices] == ["inkscape", "code", "system"]
    assert choices[0].command == "inkscape {path}"
    image = openwith.open_choices(Path("a.png"), EditCommands(default=None, svg=None))
    assert [c.id for c in image] == ["system"]
    configured = openwith.open_choices(
        Path("a.png"), EditCommands(default="nano {path}", svg=None)
    )
    assert configured[0].id == "configured"


def test_video_editors_are_offered_installed_or_as_flatpaks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name in ("shotcut", "flatpak") else None

    monkeypatch.setattr("inkflow_editor.openwith.shutil.which", which)

    def flatpak(app_id: str) -> bool:
        return app_id == "no.mifi.losslesscut"

    monkeypatch.setattr("inkflow_editor.openwith._flatpak_installed", flatpak)
    choices = openwith.open_choices(
        Path("clip.mp4"), EditCommands(default=None, svg=None)
    )
    assert [(c.id, c.command) for c in choices[:2]] == [
        ("losslesscut", "flatpak run no.mifi.losslesscut {path}"),
        ("shotcut", "shotcut {path}"),
    ]


def test_open_with_offers_draw_io(monkeypatch: pytest.MonkeyPatch) -> None:
    def which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name in ("drawio", "inkscape") else None

    monkeypatch.setattr("inkflow_editor.openwith.shutil.which", which)
    choices = openwith.open_choices(Path("flow.drawio.svg"), EditCommands(None, None))
    assert [c.id for c in choices][:2] == ["drawio", "inkscape"]
