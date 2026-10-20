"""The editor's own commands: ``inkflow edit``, ``setup-desktop``, ``relay``,
``pack`` and ``fonts bundle``/``set``."""

from __future__ import annotations

from importlib import import_module

import click

_COMMANDS = ("edit", "pack", "relay")


def register(main: click.Group) -> None:
    del main  # the modules decorate the core's ``main`` group themselves
    for name in _COMMANDS:
        import_module(f"inkflow_editor.cli.{name}")
