"""Launching an external program on a deck's source file, from the presenter.

The presenter's edit menu resolves a command from env vars only
(``INKFLOW_EDIT_CMD``, ``INKFLOW_EDIT_CMD_SVG``, and per extension or kind:
``INKFLOW_EDIT_CMD_PNG``, ``INKFLOW_EDIT_CMD_IMAGE``, ``INKFLOW_EDIT_CMD_TEXT``…);
when none applies it copies the path to the clipboard. No command is bundled
by default because "jump an already-open editor to this file" is inherently
editor- and machine-specific.
"""

from __future__ import annotations

import os
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path

from inkflow.logging import logger


@dataclass(frozen=True)
class EditCommands:
    default: str | None
    svg: str | None
    overrides: tuple[tuple[str, str], ...] = ()
    """Other ``INKFLOW_EDIT_CMD_<NAME>`` vars: an extension (``PNG``, ``MD``) or
    a kind (``IMAGE``, ``TEXT``, ``VIDEO``, ``PDF``, ``DATA``), upper-case, in
    env order."""


NO_EDIT_COMMANDS = EditCommands(default=None, svg=None)
"""Shared "nothing configured" value, so callers with no real commands to pass
(export.py's build_html call, default handler args) don't each construct their own
equal-but-distinct instance — and so it can be used as a default argument without
ruff's B008 (no function call in a default value)."""


_PREFIX = "INKFLOW_EDIT_CMD_"

KINDS: dict[str, str] = {
    **dict.fromkeys(
        ("png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"), "IMAGE"
    ),
    **dict.fromkeys(("md", "py", "css", "js", "txt", "toml", "json", "yaml"), "TEXT"),
    **dict.fromkeys(("mp4", "webm", "mov", "ogg"), "VIDEO"),
    "pdf": "PDF",
    # A chart's table: a spreadsheet opens it as one.
    **dict.fromkeys(("csv", "tsv"), "DATA"),
}
"""File extension → the kind an ``INKFLOW_EDIT_CMD_<KIND>`` var covers."""


def resolve_edit_commands() -> EditCommands:
    overrides = tuple(
        (name.removeprefix(_PREFIX).upper(), value)
        for name, value in os.environ.items()
        if name.startswith(_PREFIX) and name != f"{_PREFIX}SVG" and value
    )
    return EditCommands(
        default=os.environ.get("INKFLOW_EDIT_CMD"),
        svg=os.environ.get("INKFLOW_EDIT_CMD_SVG"),
        overrides=overrides,
    )


def command_for(path: Path, commands: EditCommands) -> str | None:
    """The most specific configured command: ``INKFLOW_EDIT_CMD_<EXT>`` (``_SVG``
    for SVG files), then ``INKFLOW_EDIT_CMD_<KIND>``, then ``INKFLOW_EDIT_CMD``."""
    suffix = path.suffix.lower().lstrip(".")
    if suffix == "svg" and commands.svg is not None:
        return commands.svg
    named = dict(commands.overrides)
    if suffix.upper() in named:
        return named[suffix.upper()]
    kind = KINDS.get(suffix)
    if kind and kind in named:
        return named[kind]
    return commands.default


def configured_suffixes(commands: EditCommands) -> list[str]:
    """Every extension a command is configured for (the presenter's menu)."""
    known = ["svg", *KINDS]
    return [s for s in known if command_for(Path(f"x.{s}"), commands) is not None]


def open_in_editor(path: Path, template: str) -> str | None:
    """Launch ``template`` with ``path`` substituted, detached from this process.

    ``{path}`` is substituted into every token that contains it; if no token does,
    the path is appended as a final argument (the ``$EDITOR file`` convention).
    Never raises: a bad template or missing binary is logged and returned as a
    message (e.g. so the caller can also report it back to the requesting
    browser tab, which is otherwise the only place nothing visibly happens),
    not raised as a crash.
    """
    args = shlex.split(template)
    substituted = [a.replace("{path}", str(path)) for a in args]
    if not any("{path}" in a for a in args):
        substituted.append(str(path))

    devnull = os.open(os.devnull, os.O_WRONLY)
    try:
        subprocess.Popen(
            substituted,
            stdout=devnull,
            stderr=devnull,
            stdin=subprocess.DEVNULL,
        )
    except OSError as e:
        message = f"failed to launch edit command {template!r}: {e}"
        logger.warning(message)
        return message
    finally:
        os.close(devnull)
    return None
