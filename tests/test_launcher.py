"""The desktop launcher (``inkflow setup-desktop``)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from click.testing import CliRunner

from inkflow import launcher
from inkflow.cli import main


def test_launcher_starts_this_installation_on_the_start_page() -> None:
    assert launcher.command() == [sys.executable, "-m", "inkflow", "edit", "--start"]


@pytest.mark.skipif(sys.platform in ("darwin", "win32"), reason="freedesktop only")
def test_linux_menu_entry_and_icon(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    result = CliRunner().invoke(main, ["setup-desktop"])
    assert result.exit_code == 0, result.output
    entry = (tmp_path / "applications" / "inkflow.desktop").read_text()
    assert "Exec=" in entry and "-m inkflow edit --start" in entry
    assert "Terminal=true" in entry
    icon = tmp_path / "icons" / "hicolor" / "scalable" / "apps" / "inkflow.svg"
    assert f"Icon={icon}" in entry and icon.read_bytes().startswith(b"<")
    result = CliRunner().invoke(main, ["setup-desktop", "--remove"])
    assert result.exit_code == 0
    assert not (tmp_path / "applications" / "inkflow.desktop").exists()
    assert not icon.exists()


def test_python_dash_m_runs_the_cli() -> None:
    import subprocess

    out = subprocess.run(
        [sys.executable, "-m", "inkflow", "--help"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "Usage: inkflow" in out
