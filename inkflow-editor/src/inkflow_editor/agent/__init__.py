"""Commands for an agent (Claude Code) working on a deck, beside the author.

Each command is a client of the editing session (``inkflow_editor.session``):
it sends the same requests the visual editor's page sends, through the server
that has the deck open when there is one (an undoable "Agent: …" step in the
author's editor), else straight to the files (``remote.py``). They read the
deck through the core (``outline``, ``context``) and the editor's own files
(``.inkflow/context.json``, stars, comments).
"""

from __future__ import annotations

from importlib import import_module

import click

_COMMANDS = (
    "anim",
    "comments",
    "compare",
    "context",
    "files",
    "master",
    "shapes",
    "slides",
    "text",
    "worktree",
)


def register(main: click.Group) -> None:
    """Add the agent commands to ``inkflow`` (each module registers its own
    on ``main`` as it is imported)."""
    del main  # the modules decorate the core's ``main`` group themselves
    for name in _COMMANDS:
        import_module(f"inkflow_editor.agent.{name}")
