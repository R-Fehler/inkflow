from __future__ import annotations

import asyncio
import contextlib
import os
from pathlib import Path

import click

from inkflow import instances
from inkflow.cli._common import deck_option, main, resolve_deck_path
from inkflow.editor.session import Exporters
from inkflow.export import build_pdf, build_static_html
from inkflow.logging import Levels, report
from inkflow.server import DEFAULT_PORT, open_browser, pick_ports
from inkflow.server import serve as _serve

# The editor's Export dialog runs the same builds as the commands below.
EXPORTERS = Exporters(html=build_static_html, pdf=build_pdf)


@main.command()
@deck_option
@click.option(
    "--host",
    default="localhost",
    show_default=True,
    help="Bind address",
)
@click.option(
    "--port",
    type=int,
    default=None,
    help="HTTP port [default: 7777, or the next free one]",
)
@click.option(
    "--ws-port",
    type=int,
    default=None,
    help="WebSocket port [default: the HTTP port + 1, or the next free one]",
)
@click.pass_obj
def serve(
    levels: Levels, deck_path: Path, host: str, port: int | None, ws_port: int | None
) -> None:
    """Start the presentation server with live reload.

    Serves the deck at `http://{host}:{port}` and pushes slide updates over a
    WebSocket whenever a source file changes, swapping content in place without a
    full page reload. Use `--host 0.0.0.0` to expose the server on all interfaces.

    Keyboard shortcuts in the terminal:

    - `o`: open the presentation in a browser
    - `r`: force a rebuild
    - `t`: toggle the error trace
    - `q`: quit (Ctrl-D and Ctrl-C also work)
    """
    resolved = resolve_deck_path(deck_path)
    if _already_served(resolved, "/", open_it=False):
        return
    auto = port is None and ws_port is None
    port, ws_port = _ports(host, port, ws_port)
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(
            _serve(
                resolved,
                host,
                port,
                ws_port,
                levels,
                exporters=EXPORTERS,
                auto_ports=auto,
            )
        )


def _ports(host: str, port: int | None, ws_port: int | None) -> tuple[int, int]:
    """The ports to serve on; says so when the default ones are taken (another
    deck's server, such as the author's editor while an agent previews its
    worktree), since the address is then not the usual one."""
    picked = pick_ports(host, port, ws_port)
    if port is None and picked[0] != DEFAULT_PORT:
        report("Ports", f"{DEFAULT_PORT} is taken: using {picked[0]} (and {picked[1]})")
    return picked


def _already_served(deck_py: Path, path: str, *, open_it: bool) -> bool:
    """One server per deck: when another inkflow already serves ``deck_py``,
    say where (and open it) instead of starting a second one that would write
    the same files."""
    other = instances.serving(deck_py)
    if other is None:
        return False
    report("Already open", f"{other.url(path)} (process {other.pid})")
    if open_it:
        open_browser(other.url(path))
    return True


@main.command()
@deck_option
@click.option(
    "--host",
    default="localhost",
    show_default=True,
    help="Bind address",
)
@click.option(
    "--port",
    type=int,
    default=None,
    help="HTTP port [default: 7777, or the next free one]",
)
@click.option(
    "--ws-port",
    type=int,
    default=None,
    help="WebSocket port [default: the HTTP port + 1, or the next free one]",
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
@click.pass_obj
def edit(
    levels: Levels,
    deck_path: Path,
    host: str,
    port: int | None,
    ws_port: int | None,
    no_open: bool,
    start: bool,
    quit_when_idle: float | None,
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

    Keyboard shortcuts in the terminal are those of `serve`, plus `e` to open the
    editor again.
    """
    resolved: Path | None
    if start or (deck_path == Path("deck.py") and not deck_path.exists()):
        resolved = None
        report("Starting", "no deck here: the editor opens on its start page")
    else:
        resolved = resolve_deck_path(deck_path)
        if _already_served(resolved, "/edit", open_it=not no_open):
            return
    open_path = None if no_open else "/edit"
    auto = port is None and ws_port is None
    port, ws_port = _ports(host, port, ws_port)
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(
            _serve(
                resolved,
                host,
                port,
                ws_port,
                levels,
                open_path,
                exporters=EXPORTERS,
                quit_when_idle=quit_when_idle,
                auto_ports=auto,
            )
        )


@main.command("build")
@deck_option
@click.option(
    "--output",
    "-o",
    default=None,
    help="Output directory (default: build/ next to deck.py)",
)
@click.option(
    "--inline-assets",
    "inline_assets",
    is_flag=True,
    help="Embed images and video as data URIs so the build is index.html alone.",
)
def build_cmd(deck_path: Path, output: str | None, inline_assets: bool) -> None:
    """Export a self-contained presentation directory for offline use.

    Produces an `index.html` with every slide inlined and copies any assets the
    deck references into the output directory. No server is required to view it.
    Defaults to a `build/` directory next to `deck.py`.

    `--inline-assets` embeds those assets in the HTML instead of copying them, so
    the whole deck is one file that cannot be separated from its images — worth it
    when the deck travels through a file picker, a chat window, or a sandboxed
    browser that only ever hands over the file you point at. The file grows by
    roughly a third of every asset, counted once per reference rather than once
    per file, and every byte of it loads before the first slide renders.
    """
    resolved = resolve_deck_path(deck_path)
    out_dir = Path(output).resolve() if output else resolved.parent / "build"
    try:
        build_static_html(resolved, out_dir, inline_assets=inline_assets)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    index = out_dir / "index.html"
    size = f" ({index.stat().st_size / 1_000_000:.1f} MB)" if inline_assets else ""
    report("Built", f"{index}{size}")


@main.command("export")
@deck_option
@click.option(
    "--output",
    "-o",
    default=None,
    help="Output PDF path (default: <deck-stem>.pdf next to deck.py)",
)
@click.option(
    "--chromium",
    default=None,
    help="Path to chromium/chrome binary (auto-detected if not set)",
)
@click.option(
    "--no-sandbox",
    "no_sandbox",
    is_flag=True,
    help="Pass --no-sandbox to Chromium (needed when running as root or in Docker).",
)
@click.option(
    "--size",
    default=None,
    metavar="WxH",
    help="Override PDF page size, e.g. 1280x720. Auto-detected from slides if not set.",
)
def export_cmd(
    deck_path: Path,
    output: str | None,
    chromium: str | None,
    no_sandbox: bool,
    size: str | None,
) -> None:
    """Export a PDF via headless Chromium — one page per slide, no animations.

    Requires a Chromium-based browser on the system; point `--chromium` at it if
    it is not auto-detected. Pass `--no-sandbox` when running as root or in
    Docker. Defaults to `<deck-stem>.pdf` next to `deck.py`.
    """
    resolved = resolve_deck_path(deck_path)
    out = Path(output).resolve() if output else resolved.with_suffix(".pdf")
    parsed_size: tuple[int, int] | None = None
    if size is not None:
        try:
            parts = size.lower().split("x")
            parsed_size = (int(parts[0]), int(parts[1]))
        except (ValueError, IndexError):
            raise click.ClickException(
                f"--size must be WxH (e.g. 1920x1080), got: {size!r}"
            ) from None
    try:
        build_pdf(
            resolved,
            out,
            chromium,
            no_sandbox or (hasattr(os, "geteuid") and os.geteuid() == 0),
            size=parsed_size,
        )
    except (RuntimeError, ValueError) as exc:
        raise click.ClickException(str(exc)) from exc
    report("Exported", str(out))
