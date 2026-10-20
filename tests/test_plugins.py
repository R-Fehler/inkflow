"""Plugins: installed packages that add commands, verify lines and completions."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from pathlib import Path

import click
import pytest
from click.testing import CliRunner
from typing_extensions import override

from inkflow import plugins
from inkflow.manifest import Deck, Slide
from inkflow.plugins import DeckCheck, Issue, Plugin, SlideCheck

DECK = """\
from inkflow import Deck, Slide


def main():
    return Deck(slides=[Slide("slides/one.svg"), Slide("slides/two.svg")])
"""

SLIDE = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
    '<rect id="box" x="10" y="10" width="100" height="100"/></svg>'
)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    for name in ("one", "two"):
        (tmp_path / "slides" / f"{name}.svg").write_text(SLIDE)
    (tmp_path / "deck.py").write_text(DECK)
    return tmp_path


class Checker(Plugin):
    name: str = "checker"

    @override
    def register_cli(self, main: click.Group) -> None:
        @click.command("hello-plugin")
        def hello() -> None:
            click.echo("hello from a plugin")

        main.add_command(hello)

    @override
    def slide_checks(self) -> Sequence[SlideCheck]:
        def no_two(slide: Slide, project_dir: Path, deck: Deck | None) -> list[Issue]:
            del project_dir, deck
            return [("warn", "two is here")] if "two" in slide.src else []

        def broken(slide: Slide, project_dir: Path, deck: Deck | None) -> list[Issue]:
            del slide, project_dir, deck
            raise RuntimeError("oops")

        return (no_two, broken)

    @override
    def deck_checks(self) -> Sequence[DeckCheck]:
        def whole(deck: Deck, project_dir: Path, deck_path: Path) -> list[Issue]:
            del project_dir, deck_path
            return [("warn", f"{len(deck.slides)} slides checked")]

        return (whole,)

    @override
    def completion_spec(self) -> str | None:
        return "  - name: hello-plugin\n    description: Say hello\n"


@pytest.fixture
def checker() -> Iterator[Checker]:
    plugin = Checker()
    plugins.register(plugin)
    try:
        yield plugin
    finally:
        plugins.unregister(plugin)


def test_a_plugin_adds_verify_lines(
    project: Path, checker: Checker, monkeypatch: pytest.MonkeyPatch
) -> None:
    from inkflow.cli import main

    del checker
    monkeypatch.chdir(project)
    result = CliRunner().invoke(main, ["verify"])
    assert "two is here" in result.output
    assert "2 slides checked" in result.output
    # A check that raises is a line of its own, not a crash of verify.
    assert "checker: check failed: oops" in result.output
    quiet = CliRunner().invoke(main, ["verify", "--no-deck-checks"])
    assert "two is here" in quiet.output
    assert "slides checked" not in quiet.output


def test_a_plugin_adds_commands(checker: Checker) -> None:
    cli = click.Group("inkflow")
    checker.register_cli(cli)
    result = CliRunner().invoke(cli, ["hello-plugin"])
    assert result.output == "hello from a plugin\n"


def test_a_plugin_adds_to_the_completion_spec(checker: Checker) -> None:
    from inkflow.cli.project import carapace_spec

    del checker
    spec = carapace_spec()
    assert "  - name: hello-plugin\n" in spec
    assert "  - name: verify\n" in spec  # the core's are all still there


def test_no_plugins_when_turned_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INKFLOW_NO_PLUGINS", "1")
    assert not plugins.enabled()
