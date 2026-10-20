"""Commands that connect an agent (Claude Code) to the visual editor.

``context`` reads what the author has selected in ``inkflow edit``; ``outline``
says what is on every slide; ``goto``/``select`` point the author's
editor at something; ``setup-claude`` installs the prompt hook and skill that
tie these together in a project.
"""

from __future__ import annotations

import dataclasses
import json
import shutil
import sys
from importlib.resources import files
from pathlib import Path
from typing import cast

import click

from inkflow.cli._common import deck_option, main, resolve_deck_path, slide_number
from inkflow.cli.render import running_as_root
from inkflow.instances import WS_PATH
from inkflow.logging import report
from inkflow.render import SlideBoxes, render_slides
from inkflow_editor.context import format_context, read_context

# The prompt hook stays quiet once the editor has not reported for this long.
_HOOK_MAX_AGE = 2 * 60 * 60


@main.command()
@deck_option
@click.option("--json", "as_json", is_flag=True, help="Print the raw JSON.")
@click.option(
    "--hook",
    is_flag=True,
    help="Prompt-hook mode: print nothing when stale or absent, never fail.",
)
def context(deck_path: Path, as_json: bool, hook: bool) -> None:
    """Show what is selected in the visual editor right now.

    `inkflow edit` records the current slide, build step and selection in
    `.inkflow/context.json`; this prints it as text an agent can act on (which
    file and element "this" is). `--hook` is for a Claude Code
    `UserPromptSubmit` hook (see `inkflow setup-claude`): it prints the context
    only while it is fresh and exits 0 whatever happens.
    """
    if hook:
        # Hooks receive the event JSON on stdin; nothing in it is needed here.
        if not sys.stdin.isatty():
            sys.stdin.read()
        try:
            data = read_context(deck_path.resolve().parent)
            text = format_context(data, max_age=_HOOK_MAX_AGE) if data else ""
        except Exception:
            text = ""
        if text:
            click.echo(text)
        return
    resolved = resolve_deck_path(deck_path)
    data = read_context(resolved.parent)
    if data is None:
        raise click.ClickException(
            "no editor context yet: open the deck with `inkflow edit` first"
        )
    if as_json:
        click.echo(json.dumps(data, indent=2))
    else:
        click.echo(format_context(data))


@main.command()
@deck_option
@click.option(
    "--slide",
    "-s",
    "slide",
    default=None,
    help="Show one slide (number or id) in detail: full zone texts, zone boxes, "
    + "element ids, animations as deck.py writes them.",
)
@click.option("--json", "as_json", is_flag=True, help="Print the full structure.")
@click.option(
    "--starred",
    is_flag=True,
    help="Only the slides starred in the editor (every slide's line says STARRED"
    + " when it is; `inkflow slide star` sets one).",
)
@click.option(
    "--boxes",
    is_flag=True,
    help="With --slide: add every element's box as the browser draws it"
    + " (`inkflow render --boxes`; needs Chromium).",
)
def outline(
    deck_path: Path, slide: str | None, as_json: bool, starred: bool, boxes: bool
) -> None:
    """Print what is on every slide, in a few lines each.

    For each slide: its number, id, title and position in deck.py's
    `slides=[...]`, its SVG and layout chain, Markdown, notes and ink files,
    its own transition, then each zone (where its content is written and the
    start of its text, or the media/chart file) and the animations with the
    clicks they take. Start here instead of reading deck.py and every file.

    A slide the author starred in the editor says STARRED; `--starred` prints
    only those ("the slides I starred").
    """
    from inkflow.pipeline import process_deck
    from inkflow.server import load_deck
    from inkflow_editor.agent.outline import build_outline, format_outline, outline_json

    number = None if slide is None else slide_number(deck_path, slide)
    if boxes and number is None:
        raise click.UsageError("--boxes needs --slide N")
    resolved = resolve_deck_path(deck_path)
    try:
        deck = load_deck(resolved)
        slides = process_deck(deck, resolved.parent, resolved, editor=True)
        result = build_outline(deck, resolved, slides)
    except Exception as exc:
        raise click.ClickException(f"cannot build the deck: {exc}") from exc
    if as_json:
        data = outline_json(result)
        if number is not None:
            picked = [
                s
                for s in cast("list[dict[str, object]]", data["slides"])
                if s["number"] == number
            ]
            if not picked:
                raise click.ClickException(f"no slide {number}")
            data = picked[0]
            if boxes:
                data["boxes"] = dataclasses.asdict(_boxes(resolved, number))
        elif starred:
            data["slides"] = [
                s
                for s in cast("list[dict[str, object]]", data["slides"])
                if s["starred"]
            ]
        indent = 1 if sys.stdout.isatty() else None
        click.echo(json.dumps(data, indent=indent, ensure_ascii=False))
        return
    try:
        click.echo(format_outline(result, number, starred))
    except IndexError as exc:
        raise click.ClickException(f"no slide {number}") from exc
    if boxes and number is not None:
        click.echo("  boxes (as rendered, slide units):")
        for line in _boxes(resolved, number).text().splitlines()[1:]:
            click.echo(f"    {line}")


def _boxes(deck_path: Path, number: int) -> SlideBoxes:
    """One slide's rendered boxes (`inkflow render --boxes`)."""
    try:
        result = render_slides(
            deck_path,
            [number],
            None,
            boxes=True,
            contrast=False,
            no_sandbox=running_as_root(),
        )
    except (RuntimeError, ValueError) as exc:
        raise click.ClickException(str(exc)) from exc
    return result.boxes[0]


def _send(url: str, payload: dict[str, object]) -> None:
    from websockets.sync.client import connect

    from inkflow.instances import loopback_tls

    try:
        tls = loopback_tls() if url.startswith("wss:") else None
        with connect(url, open_timeout=3, proxy=None, ssl=tls) as ws:
            ws.send(json.dumps(payload))
    except OSError as exc:
        raise click.ClickException(
            f"no inkflow server at {url} ({exc}); start one with `inkflow edit`"
        ) from exc


_port_option = click.option(
    "--port",
    "--ws-port",
    "port",
    type=int,
    default=None,
    help="The server's port [default: the one editing this deck, else 7777]",
)


def _editor_url(deck_path: Path, port: int | None, host: str) -> str:
    """The WebSocket of the editor open on this deck, from its context: on
    the server's one port (or the old separate one it was started with).
    The server's own record comes first: in SSH mode it holds the owner
    token the request needs (never written to the project's context)."""
    from inkflow import instances

    serving = instances.serving(deck_path.resolve())
    if serving is not None and port in (None, serving.port):
        return serving.ws_url()
    if port is not None and (other := instances.on_port(port)) is not None:
        return other.ws_url()
    data = read_context(deck_path.resolve().parent) or {}
    raw = data.get("server")
    server = cast("dict[str, object]", raw) if isinstance(raw, dict) else {}
    scheme = "wss" if server.get("tls") is True else "ws"
    if port is None:
        found = server.get("port")
        port = found if isinstance(found, int) else 7777
        legacy = server.get("wsPort")
        if not isinstance(server.get("wsPath"), str) and isinstance(legacy, int):
            return f"{scheme}://{host}:{legacy}"  # a server before one port
    return f"{scheme}://{host}:{port}{WS_PATH}"


_host_option = click.option("--host", default="localhost", show_default=True)


@main.command()
@click.argument("slide")
@deck_option
@_port_option
@_host_option
def goto(slide: str, deck_path: Path, port: int | None, host: str) -> None:
    """Show SLIDE (a number, 1-based, or an id) in every editor open on the deck."""
    url = _editor_url(deck_path, port, host)
    number = slide_number(deck_path, slide)
    _send(url, {"type": "editor-command", "command": "goto", "slide": number})


@main.command("select")
@click.argument("ids", nargs=-1, required=True)
@click.option("--slide", default=None, help="Go to this slide (number or id) first.")
@deck_option
@_port_option
@_host_option
def select_cmd(
    ids: tuple[str, ...],
    slide: str | None,
    deck_path: Path,
    port: int | None,
    host: str,
) -> None:
    """Select elements by id in every editor open on the deck."""
    url = _editor_url(deck_path, port, host)
    if slide is not None:
        number = slide_number(deck_path, slide)
        _send(url, {"type": "editor-command", "command": "goto", "slide": number})
    _send(url, {"type": "editor-command", "command": "select", "ids": list(ids)})


def _hook_command(project_dir: Path) -> str:
    """How the hook should call inkflow from the project directory."""
    if (project_dir / "pyproject.toml").exists() and shutil.which("uv"):
        return "uv run --quiet inkflow context --hook"
    return "inkflow context --hook"


def _merge_hook(settings: dict[str, object], command: str) -> bool:
    hooks = cast("dict[str, object]", settings.setdefault("hooks", {}))
    entries = cast("list[object]", hooks.setdefault("UserPromptSubmit", []))
    for entry in entries:
        inner = (
            cast("dict[str, object]", entry).get("hooks")
            if isinstance(entry, dict)
            else None
        )
        for hook in cast("list[object]", inner or []):
            if isinstance(hook, dict) and "inkflow context" in str(
                cast("dict[str, object]", hook).get("command", "")
            ):
                return False
    entries.append({"hooks": [{"type": "command", "command": command}]})
    return True


@main.command("setup-claude")
@deck_option
@click.option(
    "--command",
    "hook_command",
    default=None,
    help="Command the prompt hook runs (default: detected).",
)
def setup_claude(deck_path: Path, hook_command: str | None) -> None:
    """Set the project up for editing alongside Claude Code.

    Adds a `UserPromptSubmit` hook to `.claude/settings.json` that hands Claude
    the visual editor's current selection with every prompt (`inkflow context
    --hook`), and an `inkflow` skill in `.claude/skills/` describing the deck's
    files, the DSL and the render/verify loop. Existing settings are kept;
    running it again changes nothing.
    """
    resolved = resolve_deck_path(deck_path)
    project_dir = resolved.parent
    claude_dir = project_dir / ".claude"
    settings_path = claude_dir / "settings.json"
    settings: dict[str, object] = {}
    if settings_path.exists():
        try:
            loaded = cast("object", json.loads(settings_path.read_text("utf-8")))
        except ValueError as exc:
            raise click.ClickException(f"{settings_path} is not valid JSON") from exc
        if not isinstance(loaded, dict):
            raise click.ClickException(f"{settings_path} is not a JSON object")
        settings = cast("dict[str, object]", loaded)
    command = hook_command or _hook_command(project_dir)
    if _merge_hook(settings, command):
        claude_dir.mkdir(exist_ok=True)
        settings_path.write_text(json.dumps(settings, indent=2) + "\n", "utf-8")
        report("Added", f"prompt hook to {settings_path.relative_to(project_dir)}")
    else:
        report("Kept", "existing inkflow prompt hook", style="yellow")
    skill = claude_dir / "skills" / "inkflow" / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    text = files("inkflow_editor").joinpath("claude", "SKILL.md").read_text("utf-8")
    skill.write_text(text, encoding="utf-8")
    report("Wrote", str(skill.relative_to(project_dir)))
    report(
        "Next",
        "run `inkflow edit`, select something, and ask Claude about it",
        style="dim",
    )


def current_slide(project_dir: Path) -> int | None:
    """The slide the editor last reported (``.inkflow/context.json``)."""
    data = read_context(project_dir) or {}
    slide = cast("dict[str, object]", data.get("slide") or {})
    number = slide.get("number")
    return number if isinstance(number, int) and number > 0 else None
