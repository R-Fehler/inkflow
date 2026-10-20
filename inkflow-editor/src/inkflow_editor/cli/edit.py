"""``inkflow edit`` (the visual editor on the deck's server) and
``inkflow setup-desktop`` (a launcher for it in the application menu)."""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from urllib.parse import quote

import click

from inkflow.cli._common import deck_option, main, resolve_deck_path
from inkflow.cli.present import (
    already_served,
    host_option,
    port_for,
    share_options,
    sharing,
    ws_port_option,
)
from inkflow.extensions import ServeConfig, ServerExtension
from inkflow.logging import Levels, report
from inkflow.server import extensions_for
from inkflow.server import serve as _serve
from inkflow_editor.online.extension import OnlineExtension
from inkflow_editor.server import EditorExtension


def _extensions(
    deck_path: Path | None, host: str, port: int, share_online: bool
) -> list[ServerExtension]:
    """The editor's extensions, sharing online from the start if asked, and
    every other plugin's."""
    config = ServeConfig(deck_path, host, port)
    others = [
        ext
        for ext in extensions_for(config)
        if not isinstance(ext, (EditorExtension, OnlineExtension))
    ]
    return [
        EditorExtension(config),
        OnlineExtension(start_online=share_online),
        *others,
    ]


@main.command()
@deck_option
@host_option
@click.option(
    "--port",
    type=int,
    default=None,
    help="Port [default: 7777, or the next free one]",
)
@ws_port_option
@share_options
@click.option(
    "--share-online",
    "share_online",
    is_flag=True,
    help="Share online through your relay (see `inkflow relay`): prints "
    + "an editor link and a view link that work from anywhere, end-to-end "
    + "encrypted. Needs `inkflow relay set` (or `relay deploy cloudflare`) "
    + "once.",
)
@click.option(
    "--no-open",
    "no_open",
    is_flag=True,
    help="Do not open the editor in a browser on start.",
)
@click.option(
    "--start",
    "start",
    is_flag=True,
    help="Open the start page (new deck, open a deck, recent decks) instead of a deck.",
)
@click.option(
    "--quit-when-idle",
    "quit_when_idle",
    type=float,
    is_flag=False,
    flag_value=60.0,
    default=None,
    metavar="SECONDS",
    help="Stop once no editor or presenter page has been open this long "
    + "[default when given: 60]. For a server without a terminal.",
)
@click.option(
    "--compare",
    "compare_with",
    default=None,
    metavar="REV|PATH",
    help="Open the compare view: the working copy beside a git revision "
    + "(branch, tag, sha, HEAD~2) or another deck folder.",
)
@click.pass_obj
def edit(
    levels: Levels,
    deck_path: Path,
    host: str,
    port: int | None,
    ws_port: int | None,
    share: bool,
    allow_hosts: tuple[str, ...],
    tls: tuple[Path, Path] | None,
    ssh: bool | None,
    share_online: bool,
    no_open: bool,
    start: bool,
    quit_when_idle: float | None,
    compare_with: str | None,
) -> None:
    """Open the visual editor: click, drag and type on your slides.

    Runs the same server as `serve` and opens `http://{host}:{port}/edit`. Every
    change is written straight back to the deck's own files (slide SVGs, Markdown,
    `deck.py`), so the editor, Inkscape, your text editor and an agent such as
    Claude Code can all work on the deck at once; each sees the others' edits live.
    The presenter stays at `/`. Run it once per deck to edit several side by
    side: each picks the next free ports, and slides copied in one editor paste
    into another.

    Without a deck (`--start`, or no `deck.py` here and no `--deck`), the
    editor opens on its start page: create a new deck, open one from a folder,
    or pick a recent one. `inkflow setup-desktop` adds a launcher for that to
    the desktop's application menu.

    One server per deck: if another inkflow already has the deck open, this
    opens its editor instead of starting a second server for the same files.

    Share the deck with people on the same network (or VPN) with `--share`:
    each address gets an editor link and a view link (the editor's Share…
    button shows them too, with QR codes, and turns sharing on and off).

    On a server you and others log in to over SSH: `ssh -L
    7777:localhost:7777 you@server`, run `inkflow edit --no-open` there, and
    open the owner link it prints (`http://localhost:7777/edit?k=…`) on your
    own computer. Started from an SSH login, inkflow is in SSH mode (`--ssh`,
    `--no-ssh` to turn it off): only that link makes you the owner, and
    Share → Share via SSH writes out the commands and links for your
    collaborators, who open them through tunnels of their own.

    Share it with anyone, anywhere, with `--share-online` (or Share… →
    Online): through a relay on your Cloudflare account or your own server
    (`inkflow relay`), end-to-end encrypted; the relay never sees the deck.

    Keyboard shortcuts in the terminal are those of `serve`, plus `e` to open the
    editor again.
    """
    resolved: Path | None
    page = "/edit"
    if compare_with:
        # A path is passed as one the server can find from anywhere.
        candidate = Path(compare_with).expanduser()
        spec = str(candidate.resolve()) if candidate.exists() else compare_with
        page = f"/edit?compare={quote(spec, safe='')}"
    if start or (deck_path == Path("deck.py") and not deck_path.exists()):
        resolved = None
        report("Starting", "no deck here: the editor opens on its start page")
    else:
        resolved = resolve_deck_path(deck_path)
        if already_served(resolved, page, open_it=not no_open):
            return
    open_path = None if no_open else page
    auto = port is None
    port = port_for(host, port)
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(
            _serve(
                resolved,
                host,
                port,
                ws_port,
                levels,
                open_path,
                quit_when_idle=quit_when_idle,
                auto_ports=auto,
                sharing=sharing(share, allow_hosts, tls, ssh),
                extensions=_extensions(resolved, host, port, share_online),
            )
        )


@main.command("setup-desktop")
@click.option(
    "--remove",
    "remove",
    is_flag=True,
    help="Remove the launcher instead.",
)
@click.option(
    "--terminal",
    "terminal",
    is_flag=True,
    help="Run the server in a terminal window (its status; closing it stops it).",
)
def setup_desktop(remove: bool, terminal: bool) -> None:
    """Add Inkflow to the desktop's application menu.

    The launcher runs `inkflow edit --start`: the editor comes up in the
    browser on its start page (a new deck, open a deck, recent decks). The
    server runs hidden and stops a minute after its last tab closes, or at
    "Quit Inkflow" in the deck menu; with `--terminal` it runs in a terminal
    window instead. Each launch is its own server, but a deck already open in
    one is never opened in a second: you are taken to the first. It starts
    this installation of inkflow (for example the one `uv tool install
    inkflow` made).

    Linux: a `.desktop` entry and icon under `~/.local/share`. macOS:
    `~/Applications/Inkflow.app`. Windows: a Start menu shortcut.
    """
    from inkflow_editor import launcher

    if remove:
        removed = launcher.uninstall()
        for path in removed:
            report("Removed", str(path))
        if not removed:
            report("Nothing", "no launcher was installed", style="yellow")
        return
    try:
        written = launcher.install(terminal)
    except launcher.LauncherError as exc:
        raise click.ClickException(str(exc)) from exc
    for path in written:
        report("Wrote", str(path))
    report("Runs", " ".join(launcher.command(terminal)))
