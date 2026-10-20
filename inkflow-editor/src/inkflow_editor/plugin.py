"""The editor as an inkflow plugin: what it adds to the core.

Found by the core through the ``inkflow.plugins`` entry point (see
``pyproject.toml``); nothing in the core imports this package.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING

from typing_extensions import override

from inkflow.plugins import DeckCheck, Plugin, SlideCheck

if TYPE_CHECKING:
    import click

    from inkflow.extensions import ServeConfig, ServerExtension


class EditorPlugin(Plugin):
    name: str = "inkflow-editor"

    @override
    def register_cli(self, main: click.Group) -> None:
        from inkflow_editor import agent, cli

        cli.register(main)
        agent.register(main)

    @override
    def slide_checks(self) -> Sequence[SlideCheck]:
        from inkflow_editor.checks import check_connectors

        return (check_connectors,)

    @override
    def deck_checks(self) -> Sequence[DeckCheck]:
        from inkflow_editor.checks import check_portable

        return (check_portable,)

    @override
    def server_extensions(self, config: ServeConfig) -> Sequence[ServerExtension]:
        from inkflow_editor.online.extension import OnlineExtension
        from inkflow_editor.server import EditorExtension

        return (EditorExtension(config), OnlineExtension())

    @override
    def completion_spec(self) -> str | None:
        from importlib.resources import files

        spec = files("inkflow_editor").joinpath("completions", "inkflow-editor.yaml")
        return spec.read_text(encoding="utf-8")

    @override
    def requirement(self) -> str | None:
        from inkflow.init import compatible_requirement

        return compatible_requirement("inkflow-editor")

    @override
    def current_slide(self, project_dir: Path) -> int | None:
        from inkflow_editor.agent.context import current_slide

        return current_slide(project_dir)


plugin = EditorPlugin()
