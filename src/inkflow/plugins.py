"""Plugins: packages that build on inkflow and add to it.

inkflow is the core: it reads a deck, builds it, presents it, exports and
checks it. Anything that wants to do more (a visual editor, commands for an
agent, another kind of frontend) is a plugin: an installed package that names
a ``Plugin`` under the ``inkflow.plugins`` entry-point group::

    [project.entry-points."inkflow.plugins"]
    wordcount = "inkflow_wordcount:plugin"

The entry point names a ``Plugin`` instance (or a callable returning one).
Every method has a do-nothing default, so a plugin overrides only what it
adds:

- ``register_cli`` adds commands (or subcommands to an existing group) to the
  ``inkflow`` command line;
- ``slide_checks`` / ``deck_checks`` add lines to ``inkflow verify``;
- ``server_extensions`` adds pages, messages and build steps to the server
  (``inkflow.extensions.ServerExtension``), ``serve_options`` options to
  ``inkflow serve`` for them;
- ``completion_spec`` adds its commands to the shell completion spec;
- ``requirement`` is pinned beside inkflow in a new deck's pyproject.toml;
- ``current_slide`` says which slide the author is looking at, for commands
  that default to it (``inkflow render``).

Plugins are found once per process. ``INKFLOW_NO_PLUGINS=1`` turns them all
off (the core on its own, as a test or a bug report wants it); ``register``
adds one by hand (tests, embedding).
"""

from __future__ import annotations

import os
from collections.abc import Callable, Sequence
from importlib.metadata import entry_points
from pathlib import Path
from typing import TYPE_CHECKING, cast

from inkflow.logging import logger

if TYPE_CHECKING:
    import click

    from inkflow.extensions import ServeConfig, ServerExtension
    from inkflow.manifest import Deck, Slide

GROUP = "inkflow.plugins"
"""The entry-point group plugins are listed under."""

Issue = tuple[str, str]
"""One ``inkflow verify`` line: (``"error"`` or ``"warn"``, message)."""

SlideCheck = Callable[["Slide", Path, "Deck | None"], list[Issue]]
"""A check of one slide: the slide, the project folder, the deck (None when
verify runs without one)."""

DeckCheck = Callable[["Deck", Path, Path], list[Issue]]
"""A check of the deck as a whole: the deck, the project folder, deck.py."""


class Plugin:
    """What a plugin adds. Subclass it and override what you need."""

    name: str = "plugin"

    def register_cli(self, main: click.Group) -> None:
        """Add commands to ``inkflow`` (``main.add_command``, or subcommands
        on one of its groups)."""
        del main

    def slide_checks(self) -> Sequence[SlideCheck]:
        """Checks ``inkflow verify`` runs on every slide."""
        return ()

    def deck_checks(self) -> Sequence[DeckCheck]:
        """Checks ``inkflow verify`` runs once on the whole deck."""
        return ()

    def serve_options(self) -> Sequence[click.Option]:
        """Options this plugin adds to ``inkflow serve``; their values reach
        ``server_extensions`` as ``config.options`` (by parameter name)."""
        return ()

    def server_extensions(self, config: ServeConfig) -> Sequence[ServerExtension]:
        """Extensions of a server about to start (``inkflow serve``, or a
        plugin's own command calling ``inkflow.server.serve``)."""
        del config
        return ()

    def completion_spec(self) -> str | None:
        """Carapace command blocks for ``inkflow completion carapace``: YAML
        list items (``  - name: …``) as the core's spec lists its commands;
        a block named like a core command replaces the core's."""
        return None

    def requirement(self) -> str | None:
        """What a deck's ``pyproject.toml`` should depend on for this plugin's
        commands to work in a clone of it (``inkflow-wordcount~=0.1.0``): a new
        deck pins it beside inkflow."""
        return None

    def current_slide(self, project_dir: Path) -> int | None:
        """The slide (presentation number, 1-based) the author has open, if
        this plugin knows it."""
        del project_dir
        return None


_loaded: list[Plugin] | None = None
_extra: list[Plugin] = []


def _discover() -> list[Plugin]:
    found: list[Plugin] = []
    for entry in entry_points(group=GROUP):
        try:
            obj = cast("object", entry.load())
            plugin = obj() if callable(obj) and not isinstance(obj, Plugin) else obj
        except Exception:
            logger.exception(f"plugin {entry.name!r} failed to load")
            continue
        if isinstance(plugin, Plugin):
            found.append(plugin)
        else:
            logger.warning(f"plugin {entry.name!r} is not an inkflow Plugin: skipped")
    return found


def enabled() -> bool:
    """Whether installed plugins are used (``INKFLOW_NO_PLUGINS`` unset)."""
    return os.environ.get("INKFLOW_NO_PLUGINS", "") in ("", "0")


def loaded() -> list[Plugin]:
    """The installed plugins (found on first use), then any registered by
    hand."""
    global _loaded
    if _loaded is None:
        _loaded = _discover() if enabled() else []
    return [*_loaded, *_extra]


def register(plugin: Plugin) -> None:
    """Use ``plugin`` besides the installed ones (tests, embedding)."""
    if plugin not in _extra:
        _extra.append(plugin)


def unregister(plugin: Plugin) -> None:
    if plugin in _extra:
        _extra.remove(plugin)
