from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable, Sequence
from pathlib import Path

import click

from inkflow import instances
from inkflow.access import over_ssh
from inkflow.cli._common import deck_option, main, resolve_deck_path
from inkflow.export import build_pdf, build_static_html
from inkflow.extensions import ServeConfig
from inkflow.logging import Levels, report
from inkflow.server import (
    DEFAULT_PORT,
    Sharing,
    extensions_for,
    open_browser,
    pick_port,
)
from inkflow.server import serve as _serve

host_option = click.option(
    "--host",
    default="localhost",
    show_default=True,
    help="Bind address. Any other than this machine's own (127.0.0.1, "
    + "localhost) shares the deck, as --share does.",
)
ws_port_option = click.option(
    "--ws-port",
    type=int,
    default=None,
    help="Deprecated: the WebSocket is on the HTTP port (/_inkflow/ws). Given, "
    + "it is also opened on this port, on this machine only.",
)


def share_options(f: Callable[..., None]) -> Callable[..., None]:
    """``--share``, ``--allow-host``, ``--tls`` and ``--ssh/--no-ssh``, for
    any command that starts a server (a plugin's too)."""
    f = click.option(
        "--ssh/--no-ssh",
        "ssh",
        default=None,
        help="SSH mode, for a machine other people log in to: only the owner "
        + "link inkflow prints is the owner (anyone else on this machine "
        + "would otherwise be the owner too), and share links name localhost, "
        + "for each guest to open through their own `ssh -L` tunnel; "
        + "nothing listens on the network. [default: on when started from an "
        + "SSH login (SSH_CONNECTION or SSH_CLIENT set)]",
    )(f)
    f = click.option(
        "--tls",
        nargs=2,
        type=click.Path(exists=True, dir_okay=False, path_type=Path),
        default=None,
        metavar="CERT KEY",
        help="Serve HTTPS (and WSS) with this certificate and key, such as "
        + "`tailscale cert` makes.",
    )(f)
    f = click.option(
        "--allow-host",
        "allow_hosts",
        multiple=True,
        metavar="NAME",
        help="Also answer to this host name (a reverse proxy's, a VPN name); "
        + "requests naming any other host are refused. Repeatable.",
    )(f)
    return click.option(
        "--share",
        is_flag=True,
        help="Share on the local network (or VPN): listen on every interface "
        + "(or --host) and print a view link (and an editor link, when a "
        + "plugin edits) for each address. Without it only this machine can "
        + "connect. In SSH mode: the links work from the start, through tunnels.",
    )(f)


def sharing(
    share: bool,
    allow_hosts: tuple[str, ...],
    tls: tuple[Path, Path] | None,
    ssh: bool | None,
) -> Sharing:
    """The ``Sharing`` those options ask for."""
    return Sharing(
        share=share,
        allow_hosts=allow_hosts,
        tls=tls or None,
        ssh=over_ssh() if ssh is None else ssh,
    )


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
@click.pass_obj
def serve(
    levels: Levels,
    deck_path: Path,
    host: str,
    port: int | None,
    ws_port: int | None,
    share: bool,
    allow_hosts: tuple[str, ...],
    tls: tuple[Path, Path] | None,
    ssh: bool | None,
    **plugin_options: object,
) -> None:
    """Start the presentation server with live reload.

    Serves the deck at `http://{host}:{port}` and pushes slide updates over a
    WebSocket on the same port whenever a source file changes, swapping
    content in place without a full page reload. Only this machine can
    connect, unless `--share`: then the server also listens on the network
    and prints a view link for each address (and an editor link, when a
    plugin edits); other machines need one of them.

    On a machine other people log in to (SSH mode, the default from an SSH
    login; `--no-ssh` turns it off), being on the machine is not enough:
    open the owner link the server prints, through `ssh -L`.

    Keyboard shortcuts in the terminal:

    - `o`: open the presentation in a browser
    - `r`: force a rebuild
    - `t`: toggle the error trace
    - `q`: quit (Ctrl-D and Ctrl-C also work)
    """
    resolved = resolve_deck_path(deck_path)
    if already_served(resolved, "/", open_it=False):
        return
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
                auto_ports=auto,
                sharing=sharing(share, allow_hosts, tls, ssh),
                extensions=extensions_for(
                    ServeConfig(resolved, host, port, plugin_options)
                ),
            )
        )


def add_serve_options(options: Sequence[click.Option]) -> None:
    """Options a plugin adds to ``inkflow serve`` (``Plugin.serve_options``):
    their values go to the extensions as ``ServeConfig.options``."""
    serve.params.extend(options)


def port_for(host: str, port: int | None) -> int:
    """The port to serve on; says so when the default one is taken (another
    deck's server), since the address is then not the usual one."""
    picked = pick_port(host, port)
    if port is None and picked != DEFAULT_PORT:
        report("Port", f"{DEFAULT_PORT} is taken: using {picked}")
    return picked


def already_served(deck_py: Path, path: str, *, open_it: bool) -> bool:
    """One server per deck: when another inkflow already serves ``deck_py``,
    say where (and open it) instead of starting a second one that would write
    the same files."""
    other = instances.serving(deck_py)
    if other is None:
        return False
    report("Already open", f"{other.owner_url(path)} (process {other.pid})")
    if open_it:
        open_browser(other.owner_url(path))
    return True


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
        build_pdf(resolved, out, chromium, no_sandbox, size=parsed_size)
    except (RuntimeError, ValueError) as exc:
        raise click.ClickException(str(exc)) from exc
    report("Exported", str(out))
