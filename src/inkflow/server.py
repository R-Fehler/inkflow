"""The presentation server: builds the deck on every change, serves the
presenter and the deck's files, and relays positions between windows.

Frontends plug in as server extensions (``inkflow.extensions``): they get the
builds, messages of their own, pages of their own, and terminal keys.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import errno
import functools
import hashlib
import importlib.resources
import importlib.util
import ipaddress
import json
import os
import sys
import time
import traceback
import webbrowser
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from html import escape as escape_html
from pathlib import Path
from typing import Literal, cast
from urllib.parse import unquote, urlsplit

from rich.console import Console
from rich.live import Live
from rich.text import Text
from watchfiles import awatch  # pyright: ignore[reportUnknownVariableType]
from websockets.asyncio.server import ServerConnection
from websockets.asyncio.server import serve as ws_serve

from inkflow import plugins
from inkflow.assets import MIME_TYPES, AssetRoots
from inkflow.collab import ROLE_RANK, Client, People, Role
from inkflow.edit import (
    NO_EDIT_COMMANDS,
    EditCommands,
    command_for,
    open_in_editor,
    resolve_edit_commands,
)
from inkflow.enums import ColorMode
from inkflow.extensions import (
    Build,
    HttpRequest,
    ResponseWriter,
    ServeConfig,
    ServerExtension,
    State,
)
from inkflow.fonts import embed_fonts_css
from inkflow.loaders import load_deck_scripts, load_deck_styles
from inkflow.logging import Levels, collect_logs, logger, report
from inkflow.manifest import Deck
from inkflow.os_compat import install_shutdown_handler, raw_keypresses
from inkflow.pipeline import SlideData, process_deck, resolve_transitions
from inkflow.titles import resolve_deck_title
from inkflow.tui import LiveUI

# ── Shared mutable state ──────────────────────────────────────────────────────


_state: State = {
    "slides": [],
    "transitions": [],
    "ws_clients": set(),
    "error": None,
    "styles_css": "",
    "scripts_js": "",
    "mode": ColorMode.DARK,
    "position": {"slideIndex": 0, "step": 0},
    "logs": [],
    "title": "Inkflow",
    "theme_dir": None,
}


@dataclass
class _Served:
    """The deck being served and what the server keeps of it."""

    deck_path: Path | None = None
    deck: Deck | None = None
    """The last deck that built."""
    built_hash: str | None = None
    """deck.py's hash in the last good build (``build-status``)."""
    failed_hash: str | None = None
    """Hash of the deck.py whose build failed last (None after a good build),
    so a program waiting for its edit to build learns that it never will."""
    extensions: list[ServerExtension] = field(default_factory=list)
    """The server's extensions (``inkflow.extensions``)."""
    people: People = field(default_factory=People)
    edit_commands: EditCommands = NO_EDIT_COMMANDS
    address: dict[str, object] = field(default_factory=dict)
    shutdown: asyncio.Event | None = None
    rebuild: Callable[[], Awaitable[None]] | None = None
    """Build the served deck again (set while serving)."""


_served = _Served()


def file_hash(data: bytes) -> str:
    """A short digest of a file's bytes: which version of deck.py a build ran
    (``build-status``, ``Build.deck_hash``)."""
    return hashlib.sha256(data).hexdigest()[:16]


# ── Deck loader ───────────────────────────────────────────────────────────────


def load_deck(deck_path: Path) -> Deck:
    spec = importlib.util.spec_from_file_location("_inkflow_deck", deck_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module from {deck_path}")
    mod = importlib.util.module_from_spec(spec)
    # Keep the module in sys.modules for the process lifetime. Besides being the
    # recommended importlib pattern, it keeps any custom Animation/Transition
    # subclasses the deck defines strongly referenced, so `type=<Name>` markers
    # can still resolve them via Animation.__subclasses__() (a marker only holds
    # the class *name*, so nothing else keeps the class from being collected).
    # A live-reload re-load replaces this entry with the fresh module.
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    if not hasattr(mod, "main"):
        raise AttributeError(f"{deck_path} must define a main() -> Deck function")
    return cast(Callable[[], Deck], mod.main)()


# ── Build pipeline ────────────────────────────────────────────────────────────


async def _each_extension(
    what: str, call: Callable[[ServerExtension], Awaitable[None]]
) -> None:
    """Run one hook of every extension; one that fails is logged and the
    others still run."""
    for ext in list(_served.extensions):
        try:
            await call(ext)
        except Exception:
            logger.exception(f"{ext.name}: {what} failed")


async def rebuild(deck_path: Path, ui: LiveUI, levels: Levels) -> None:
    ui.set_building()

    async def _animate() -> None:
        while True:
            await asyncio.sleep(0.1)
            ui.refresh()

    spin = asyncio.create_task(_animate())
    t0 = time.monotonic()
    deck_hash: str | None = None
    extensions = list(_served.extensions)
    build: Build | None = None
    try:
        # Collected, not printed, so records reach the TUI/browser without racing the
        # Live display. Floored at the lower surface level, then filtered per surface.
        with collect_logs(min(levels.console, levels.browser)) as entries:
            for ext in extensions:
                await asyncio.to_thread(ext.before_build)
            deck_hash = file_hash(deck_path.read_bytes())
            deck = await asyncio.to_thread(load_deck, deck_path)
            project_dir = deck_path.parent
            # An extension may ask for source locators on every element; the
            # presenter ignores them, so one build serves every page.
            built = await asyncio.to_thread(
                functools.partial(
                    process_deck, editor=any(ext.provenance for ext in extensions)
                ),
                deck,
                project_dir,
                deck_path,
            )
            build = Build(deck, deck_path, deck_hash, built)
            for ext in extensions:
                await asyncio.to_thread(ext.build, build)
            slides = [_without_edit(s) for s in built]
            build.served = slides
            transitions = resolve_transitions(deck)
            styles_css = await asyncio.to_thread(load_deck_styles, deck, project_dir)
            if deck.embed_fonts:
                font_css = await asyncio.to_thread(
                    embed_fonts_css, slides, project_dir, deck.theme.fonts_dir
                )
            else:
                font_css = ""
            if font_css:
                styles_css = (font_css + "\n" + styles_css).strip()
            scripts_js = await asyncio.to_thread(load_deck_scripts, deck, project_dir)
        tui_logs = [e for e in entries if e.levelno >= levels.console]
        browser_logs = [
            {"level": e.level, "message": e.message}
            for e in entries
            if e.levelno >= levels.browser
        ]
        _state["slides"] = slides
        _state["transitions"] = transitions
        _state["styles_css"] = styles_css
        _state["scripts_js"] = scripts_js
        _state["mode"] = deck.effective_mode
        _state["title"] = resolve_deck_title(deck, project_dir)
        _state["theme_dir"] = deck.theme.asset_dir()
        _served.deck = deck
        _state["error"] = None
        _state["logs"] = browser_logs
        if slides:
            cur = _state["position"]["slideIndex"]
            _state["position"]["slideIndex"] = max(0, min(len(slides) - 1, cur))
        else:
            _state["position"]["slideIndex"] = 0
        _state["position"]["step"] = 0
        ui.set_ok(len(slides), time.monotonic() - t0, logs=tui_logs)
        await broadcast(
            json.dumps(
                {
                    "type": "update",
                    "slides": slides,
                    "transitions": transitions,
                    "logs": browser_logs,
                }
            )
        )
    except Exception:
        # Outside collect_logs, so a fatal error reaches only the file sink. The overlay
        # and TUI error phase show it instead, never the banner.
        logger.exception("rebuild failed")
        tb = traceback.format_exc()
        _state["error"] = tb
        _served.failed_hash = deck_hash
        ui.set_error(tb)
        await broadcast(json.dumps({"type": "error", "message": tb}))
        await _each_extension(
            "build_failed", lambda ext: ext.build_failed(deck_hash, tb)
        )
    else:
        done = build
        await _each_extension("built", lambda ext: ext.built(done))
        # Said only now, once the extensions hold this build too: a program
        # waiting for its edit to build (``build-status``) then finds every
        # part of the server on it.
        _served.built_hash = deck_hash
        _served.failed_hash = None
    finally:
        spin.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await spin
        ui.refresh()


def _without_edit(slide: SlideData) -> SlideData:
    """The pages' copy of a slide: the editor facts stay with the extensions."""
    if "edit" not in slide:
        return slide
    data = slide.copy()
    del data["edit"]
    return data


def build_status() -> dict[str, object]:
    """Which deck.py the server last built (or failed to): a program that
    changed it waits for the build of its own edit."""
    return {
        "type": "build-status",
        "deckHash": _served.built_hash,
        "failedHash": _served.failed_hash,
        "error": _state["error"],
    }


# ── WebSocket broadcast ───────────────────────────────────────────────────────


async def broadcast(msg: str, sender: ServerConnection | None = None) -> None:
    dead: set[ServerConnection] = set()
    for ws in list(_state["ws_clients"]):
        if ws is sender:
            continue
        try:
            await ws.send(msg)
        except Exception:
            dead.add(ws)
    _state["ws_clients"] -= dead


NotifyStyle = Literal["green", "yellow", "red"]


async def notify(
    target: ServerConnection | None, message: str, *, style: NotifyStyle = "green"
) -> None:
    """Push a transient, colour-coded notification: to one client (a reply) when
    `target` is given, otherwise to every connected client.

    A pure transport primitive, independent of the rebuild-cycle log banner
    (`collect_logs`) above. Whether the event is also worth a `logger` call is the
    caller's decision, not this function's — the two are separate concerns.
    """
    payload = json.dumps({"type": "notify", "message": message, "style": style})
    if target is None:
        await broadcast(payload)
    else:
        await target.send(payload)


# ── WebSocket handler ─────────────────────────────────────────────────────────


def _coerce_nav_position(
    msg: dict[str, object], n_slides: int
) -> dict[str, int] | None:
    """Validate and clamp a `nav` payload's slideIndex/step.

    Returns None when the values cannot be coerced to ints (a hostile or buggy
    sender), so the caller can drop the frame instead of tearing down the
    connection. slideIndex is clamped to [0, n_slides-1] (or 0 for an empty deck)
    and step to >= 0, so the stored position is always valid regardless of sender.
    """
    try:
        slide_index = int(cast(int, msg.get("slideIndex", 0)))
        step = int(cast(int, msg.get("step", 0)))
    except (ValueError, TypeError):
        return None
    slide_index = max(0, min(n_slides - 1, slide_index)) if n_slides > 0 else 0
    step = max(0, step)
    return {"slideIndex": slide_index, "step": step}


def _resolve_edit_request(
    msg: dict[str, object], slides: list[SlideData], edit_commands: EditCommands
) -> tuple[Path, str] | None:
    """Validate an `edit` payload and resolve its launch command, if any.

    The path must belong to the *current* build's own `editableFiles` (not just be
    a well-formed path) — this guards against a stale client message surviving a
    deck rebuild, the same spirit as `_coerce_nav_position`'s clamping. Returns
    None when the path is missing/unknown or no command is configured for its kind
    (the client already handled that case as a clipboard copy; nothing to launch).
    """
    path_str = msg.get("path")
    if not isinstance(path_str, str):
        return None
    valid_paths = {f["path"] for slide in slides for f in slide["editableFiles"]}
    if path_str not in valid_paths:
        return None
    template = command_for(Path(path_str), edit_commands)
    if template is None:
        return None
    return Path(path_str), template


# ── Who is asking ────────────────────────────────────────────────────────────


def is_loopback_name(host: str) -> bool:
    """Whether a host name (no port) names this machine's loopback."""
    host = host.strip("[]").rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def role_for(peer: str | None, *, host: str | None, origin: str | None) -> Role:
    """Who a request or connection is: the owner when it comes from this
    machine (a loopback peer) through a loopback name (``Host``, and a
    WebSocket's ``Origin`` when sent), so neither another site's page in the
    owner's browser (``Origin``) nor a DNS-rebound name (``Host``) is the
    owner. Anyone else is a viewer."""
    if peer is None or not is_loopback_name(peer):
        return "viewer"
    for value in (host, origin):
        if value is None:
            continue
        name = urlsplit(value if "//" in value else f"//{value}").hostname
        if name is None or not is_loopback_name(name):
            return "viewer"
    return "owner"


def _header(raw: bytes, name: str) -> str | None:
    """One header of a request head (first match, case-insensitive)."""
    prefix = name.lower().encode() + b":"
    for line in raw.split(b"\r\n")[1:]:
        if not line:
            break
        if line.lower().startswith(prefix):
            return line[len(prefix) :].strip().decode("latin-1")
    return None


def _extension_for(kind: object) -> tuple[ServerExtension, Role] | None:
    """The extension that handles message type ``kind``, and the least role
    that may send it."""
    if not isinstance(kind, str):
        return None
    for ext in _served.extensions:
        role = ext.messages.get(kind)
        if role is not None:
            return ext, role
    return None


def _welcome(client: Client) -> dict[str, object]:
    msg: dict[str, object] = {"type": "welcome", "id": client.id, "role": client.role}
    for ext in _served.extensions:
        try:
            msg.update(ext.welcome(client))
        except Exception:
            logger.exception(f"{ext.name}: welcome failed")
    return msg


def make_ws_handler(
    ui: LiveUI, edit_commands: EditCommands
) -> Callable[[ServerConnection], Awaitable[None]]:
    async def handler(websocket: ServerConnection) -> None:
        remote = cast("tuple[object, ...] | None", websocket.remote_address)
        peer = str(remote[0]) if remote else None
        headers = websocket.request.headers if websocket.request else None
        origin = headers.get("Origin") if headers is not None else None
        role = role_for(peer, host=None, origin=origin)
        client = _served.people.join(websocket, role, peer)
        _state["ws_clients"].add(websocket)
        logger.debug(f"client connected ({len(_state['ws_clients'])} total)")
        ui.refresh()
        try:
            pos = _state["position"]
            await websocket.send(json.dumps(_welcome(client)))
            await websocket.send(
                json.dumps(
                    {
                        "type": "position",
                        "slideIndex": pos["slideIndex"],
                        "step": pos["step"],
                    }
                )
            )
            async for raw in websocket:
                try:
                    parsed = cast(object, json.loads(raw))
                except (ValueError, TypeError):
                    continue
                if not isinstance(parsed, dict):
                    continue
                msg = cast(dict[str, object], parsed)
                msg_type = msg.get("type")
                handled = _extension_for(msg_type)
                if handled is not None:
                    ext, least = handled
                    if ROLE_RANK[client.role] < ROLE_RANK[least]:
                        continue
                    try:
                        await ext.message(websocket, client, msg)
                    except Exception:
                        logger.exception(f"{ext.name}: {msg_type} failed")
                elif msg_type == "hello":
                    # A page says what it is (``presenter``, ``editor``…).
                    if not client.page and isinstance(msg.get("role"), str):
                        client.page = str(msg.get("role"))
                    for ext in list(_served.extensions):
                        try:
                            await ext.hello(websocket, client, msg, resync=False)
                        except Exception:
                            logger.exception(f"{ext.name}: hello failed")
                elif msg_type == "build-status":
                    await websocket.send(json.dumps(build_status()))
                elif msg_type == "sync-request":
                    # A client that just switched into a receiving sync mode asks
                    # for the current position. Reply to it alone, not a broadcast.
                    cur = _state["position"]
                    await websocket.send(
                        json.dumps(
                            {
                                "type": "position",
                                "slideIndex": cur["slideIndex"],
                                "step": cur["step"],
                            }
                        )
                    )
                elif msg_type == "nav":
                    pos = _coerce_nav_position(msg, len(_state["slides"]))
                    if pos is None:
                        continue
                    _state["position"] = pos
                    position_msg: dict[str, object] = {
                        "type": "position",
                        "slideIndex": pos["slideIndex"],
                        "step": pos["step"],
                    }
                    nav_transition = msg.get("transition")
                    if nav_transition:
                        position_msg["transition"] = nav_transition
                    if msg.get("snap"):
                        position_msg["snap"] = True
                    await broadcast(json.dumps(position_msg), sender=websocket)
                elif msg_type == "edit":
                    request = _resolve_edit_request(
                        msg, _state["slides"], edit_commands
                    )
                    if request is not None:
                        error = open_in_editor(*request)
                        if error is not None:
                            await notify(websocket, error, style="red")
        finally:
            _state["ws_clients"].discard(websocket)
            # Gone from the registry first: what an extension says about who
            # is left must not list this one.
            _ = _served.people.leave(websocket)
            await _each_extension(
                "disconnected", lambda ext: ext.disconnected(websocket, client)
            )
            logger.debug(f"client disconnected ({len(_state['ws_clients'])} total)")
            ui.refresh()

    return handler


# ── HTTP handler ──────────────────────────────────────────────────────────────

_StreamHandler = Callable[[asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]]


@functools.cache
def favicon_data_uri() -> str:
    """Base64 data URI for the built-in adaptive favicon, computed once."""
    pkg = importlib.resources.files("inkflow")
    svg_bytes = pkg.joinpath("theme", "icon.svg").read_bytes()
    b64 = base64.b64encode(svg_bytes).decode()
    return f"data:image/svg+xml;base64,{b64}"


def build_html(
    state: State,
    ws_port: int | None,
    edit_commands: EditCommands = NO_EDIT_COMMANDS,
) -> bytes:
    pkg = importlib.resources.files("inkflow")
    template = pkg.joinpath("presenter.html").read_text(encoding="utf-8")
    css = pkg.joinpath("bundles", "presenter.css").read_text(encoding="utf-8")
    js = pkg.joinpath("bundles", "presenter.js").read_text(encoding="utf-8")
    data_theme = "" if state["mode"] == ColorMode.DARK else "light"
    ws_port_js = "null" if ws_port is None else str(ws_port)
    edit_commands_json = json.dumps(
        {
            "default": edit_commands.default is not None,
            "svg": edit_commands.svg is not None,
        }
    )
    html = (
        template.replace("/* __CSS__ */", css)
        .replace("/* __JS__ */", js)
        .replace("/* __STYLES__ */", state["styles_css"])
        .replace("__DATA_THEME__", data_theme)
        .replace("__SLIDES_JSON__", json.dumps(state["slides"]))
        .replace("__TRANSITIONS_JSON__", json.dumps(state["transitions"]))
        .replace("/* __SCRIPTS__ */", state["scripts_js"])
        .replace("__WS_PORT__", ws_port_js)
        .replace("__EDIT_COMMANDS_JSON__", edit_commands_json)
        .replace("__ERROR_JSON__", json.dumps(state["error"]))
        .replace("__LOGS_JSON__", json.dumps(state["logs"]))
        .replace("__FAVICON__", favicon_data_uri())
        .replace("__TITLE__", escape_html(state["title"]))
    )
    return html.encode("utf-8")


_SERVED_SUFFIXES = set(MIME_TYPES)


def _resolve_asset(roots: AssetRoots, request_path: str) -> Path | None:
    """Map a request path to a file, or ``None`` if it names nothing servable.

    The request path is a canonical asset reference: the pipeline wrote it into
    the slide SVG, so ``AssetRoots.locate`` is the same answer ``build`` copies
    to, and containment against the allowed roots is enforced there.
    """
    decoded = unquote(request_path).lstrip("/")
    located = roots.locate(decoded)
    if located is None:
        return None
    if located.suffix.lower() not in _SERVED_SUFFIXES:
        return None
    resolved = located.resolve()
    if not resolved.is_file():
        return None
    return resolved


async def _respond(
    writer: ResponseWriter,
    status: str,
    body: bytes,
    content_type: str,
    extra: bytes = b"",
) -> None:
    header = (
        f"HTTP/1.1 {status}\r\n".encode()
        + f"Content-Type: {content_type}\r\n".encode()
        + b"Cache-Control: no-store\r\n"
        + b"Connection: close\r\n"
        + extra
        + b"Content-Length: "
        + str(len(body)).encode()
        + b"\r\n\r\n"
    )
    writer.write(header + body)
    await writer.drain()


async def _refuse(writer: ResponseWriter, status: str, title: str, text: str) -> None:
    body = (
        "<!doctype html><meta charset=utf-8>"
        + f"<title>{escape_html(title)}</title>"
        + f"<h1>{escape_html(title)}</h1><p>{escape_html(text)}</p>"
    ).encode()
    await _respond(writer, status, body, "text/html; charset=utf-8")


def _http_request(
    method: str, target: str, raw: bytes, role: Role, writer: ResponseWriter
) -> HttpRequest:
    """The request as an extension gets it, with the core's ways to answer."""

    async def respond(
        status: str, body: bytes, content_type: str, extra: bytes = b""
    ) -> None:
        await _respond(writer, status, body, content_type, extra)

    async def send_file(path: Path) -> None:
        mime = MIME_TYPES.get(path.suffix.lower(), "application/octet-stream")
        await _respond(writer, "200 OK", path.read_bytes(), mime)

    async def refuse(status: str, title: str, text: str) -> None:
        await _refuse(writer, status, title, text)

    return HttpRequest(method, target, raw, role, writer, respond, send_file, refuse)


def make_http_handler(
    ws_port: int,
    project_dir: Path | None = None,
    edit_commands: EditCommands = NO_EDIT_COMMANDS,
) -> _StreamHandler:
    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            raw = await asyncio.wait_for(reader.read(4096), timeout=10)
            request_line = raw.split(b"\r\n", 1)[0].decode(errors="replace")
            parts = request_line.split(" ", 2)
            method = parts[0] if parts else "GET"
            request_path = parts[1] if len(parts) >= 2 else "/"

            if project_dir is not None and request_path != "/":
                roots = AssetRoots(project_dir, _state["theme_dir"])
                asset_path = _resolve_asset(roots, request_path)
                if asset_path is not None:
                    mime = MIME_TYPES[asset_path.suffix.lower()]
                    body = asset_path.read_bytes()
                    header = (
                        b"HTTP/1.1 200 OK\r\n"
                        + f"Content-Type: {mime}\r\n".encode()
                        + b"Cache-Control: no-store\r\n"
                        + b"Connection: close\r\n"
                        + b"Content-Length: "
                        + str(len(body)).encode()
                        + b"\r\n\r\n"
                    )
                    writer.write(header + body)
                    await writer.drain()
                    return

            if _served.extensions:
                peer = cast(
                    "tuple[object, ...] | None", writer.get_extra_info("peername")
                )
                role = role_for(
                    str(peer[0]) if peer else None,
                    host=_header(raw, "Host"),
                    origin=None,
                )
                request = _http_request(method, request_path, raw, role, writer)
                for ext in list(_served.extensions):
                    if await ext.http(request):
                        return

            body = build_html(_state, ws_port, edit_commands)
            header = (
                b"HTTP/1.1 200 OK\r\n"
                + b"Content-Type: text/html; charset=utf-8\r\n"
                + b"Cache-Control: no-store\r\n"
                + b"Connection: close\r\n"
                + b"Content-Length: "
                + str(len(body)).encode()
                + b"\r\n\r\n"
            )
            writer.write(header + body)

            await writer.drain()
        except Exception:
            # File sink only, never the TUI. The client still gets the 500 body below.
            logger.exception("error handling HTTP request")
            body = traceback.format_exc().encode()
            try:
                header = (
                    b"HTTP/1.1 500 Internal Server Error\r\n"
                    + b"Content-Type: text/plain; charset=utf-8\r\n"
                    + b"Cache-Control: no-store\r\n"
                    + b"Connection: close\r\n"
                    + b"Content-Length: "
                    + str(len(body)).encode()
                    + b"\r\n\r\n"
                )
                writer.write(header + body)
                await writer.drain()
            except Exception:
                pass
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    return handler


# ── File watcher ──────────────────────────────────────────────────────────────


async def _watch(
    deck_path: Path, ui: LiveUI, lock: asyncio.Lock, levels: Levels
) -> None:
    async for changes in awatch(str(deck_path.parent)):
        logger.debug(f"change detected in {len(changes)} file(s), rebuilding")
        async with lock:
            await rebuild(deck_path, ui, levels)


# ── Keyboard handler ──────────────────────────────────────────────────────────


def _open_browser(url: str) -> None:
    # Redirect fd 1/2 to /dev/null so the browser process can't write startup
    # noise to the terminal and corrupt the Rich Live cursor tracking.
    devnull = os.open(os.devnull, os.O_WRONLY)
    saved_out = os.dup(1)
    saved_err = os.dup(2)
    try:
        os.dup2(devnull, 1)
        os.dup2(devnull, 2)
        webbrowser.open(url)
    finally:
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        os.close(devnull)
        os.close(saved_out)
        os.close(saved_err)


async def _read_keys(
    deck_path: Path,
    host: str,
    http_port: int,
    ui: LiveUI,
    lock: asyncio.Lock,
    shutdown: asyncio.Event,
    levels: Levels,
) -> None:
    if not sys.stdin.isatty():
        return

    extra = {
        key: action
        for ext in _served.extensions
        for key, (_, action) in ext.keys().items()
    }
    loop = asyncio.get_running_loop()
    async with raw_keypresses(loop) as queue:
        while True:
            ch = await queue.get()
            if ch in ("\x04", "q"):  # Ctrl-D, q (Ctrl-C handled via SIGINT)
                shutdown.set()
                return
            elif ch == "o":
                _open_browser(f"http://{host}:{http_port}")
            elif ch == "r":
                async with lock:
                    await rebuild(deck_path, ui, levels)
            elif ch == "t":
                ui.toggle_trace()
            elif ch in extra:
                try:
                    extra[ch]()
                except Exception:
                    logger.exception(f"key {ch!r} failed")


# ── Extensions ────────────────────────────────────────────────────────────────


class _Context:
    """The ``ServerContext`` extensions act through (``inkflow.extensions``)."""

    @property
    def state(self) -> State:
        return _state

    @property
    def people(self) -> People:
        return _served.people

    @property
    def deck_path(self) -> Path:
        assert _served.deck_path is not None, "the server is not serving yet"
        return _served.deck_path

    @property
    def last_deck(self) -> Deck | None:
        return _served.deck

    @property
    def address(self) -> dict[str, object]:
        return dict(_served.address)

    @property
    def edit_commands(self) -> EditCommands:
        return _served.edit_commands

    async def send(self, conn: ServerConnection, payload: dict[str, object]) -> None:
        with contextlib.suppress(Exception):
            await conn.send(json.dumps(payload))

    async def broadcast(
        self,
        payload: dict[str, object],
        sender: ServerConnection | None = None,
    ) -> None:
        await broadcast(json.dumps(payload), sender)

    async def notify(
        self, conn: ServerConnection | None, message: str, style: str = "green"
    ) -> None:
        await notify(conn, message, style=cast("NotifyStyle", style))

    async def rebuild(self) -> None:
        if _served.rebuild is not None:
            await _served.rebuild()

    def shutdown(self) -> None:
        if _served.shutdown is not None:
            _served.shutdown.set()


context = _Context()
"""The server as extensions see it (one per process, like the server)."""


def extensions_for(config: ServeConfig) -> list[ServerExtension]:
    """The installed plugins' extensions of a server about to start."""
    found: list[ServerExtension] = []
    for plugin in plugins.loaded():
        try:
            found += plugin.server_extensions(config)
        except Exception:
            logger.exception(f"{plugin.name}: its server extension failed to load")
    return found


# ── Public entry point ────────────────────────────────────────────────────────


async def serve(
    deck_path: Path,
    host: str,
    http_port: int,
    ws_port: int,
    levels: Levels,
    extensions: Sequence[ServerExtension] | None = None,
) -> None:
    """Serve ``deck_path`` until quit.

    ``extensions`` add to the server (``inkflow.extensions``); by default the
    installed plugins' (``extensions_for``).
    """
    if extensions is None:
        extensions = extensions_for(ServeConfig(deck_path, host, http_port))
    await start_extensions(
        extensions, deck_path, {"host": host, "port": http_port, "wsPort": ws_port}
    )
    try:
        await _serve(deck_path, host, http_port, ws_port, levels)
    finally:
        await stop_extensions()


async def start_extensions(
    extensions: Sequence[ServerExtension],
    deck_path: Path,
    address: dict[str, object],
) -> None:
    """Start ``extensions`` on the deck about to be served (``serve`` does;
    so does a program embedding the server's handlers, such as a test)."""
    _served.deck_path = deck_path
    _served.address = address
    _served.edit_commands = resolve_edit_commands()
    started: list[ServerExtension] = []
    for ext in extensions:
        try:
            await ext.start(context)
            await ext.open(deck_path)
            started.append(ext)
        except Exception:
            logger.exception(f"{ext.name}: start failed")
    _served.extensions = started


async def stop_extensions() -> None:
    """Close the deck for the extensions and stop them."""
    await _each_extension("close", lambda ext: ext.close(switching=False))
    await _each_extension("stop", lambda ext: ext.stop())
    _served.extensions = []
    _served.deck_path = None


async def _serve(
    deck_path: Path, host: str, http_port: int, ws_port: int, levels: Levels
) -> None:
    console = Console()
    rebuild_lock = asyncio.Lock()
    shutdown = asyncio.Event()
    _served.shutdown = shutdown

    loop = asyncio.get_running_loop()
    uninstall_shutdown_handler = install_shutdown_handler(loop, shutdown)

    try:
        edit_commands = _served.edit_commands
        http_handler = make_http_handler(ws_port, deck_path.parent, edit_commands)
        # Bind before the Live UI so port conflicts fail fast with a clean message
        try:
            http_server = await asyncio.start_server(http_handler, host, http_port)
        except OSError as e:
            if e.errno == errno.EADDRINUSE:
                report(
                    "Error",
                    f"port {http_port} in use — pass --port to use another",
                    style="red",
                )
                return
            raise

        with Live(Text(""), console=console, auto_refresh=False) as live:
            ui = LiveUI(
                live,
                host,
                http_port,
                deck_path.parent,
                get_clients=lambda: len(_state["ws_clients"]),
            )
            ui.set_keys(
                [
                    (key, label)
                    for ext in _served.extensions
                    for key, (label, _) in ext.keys().items()
                ]
            )

            async def again() -> None:
                async with rebuild_lock:
                    await rebuild(deck_path, ui, levels)

            _served.rebuild = again
            try:
                async with (
                    http_server,
                    ws_serve(make_ws_handler(ui, edit_commands), host, ws_port),
                ):
                    await rebuild(deck_path, ui, levels)
                    tasks = [
                        asyncio.create_task(http_server.serve_forever()),
                        asyncio.create_task(
                            _watch(deck_path, ui, rebuild_lock, levels)
                        ),
                        asyncio.create_task(
                            _read_keys(
                                deck_path,
                                host,
                                http_port,
                                ui,
                                rebuild_lock,
                                shutdown,
                                levels,
                            )
                        ),
                    ]
                    await shutdown.wait()
                    for t in tasks:
                        t.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
            except OSError as e:
                if e.errno == errno.EADDRINUSE:
                    report(
                        "Error",
                        f"port {ws_port} in use — pass --ws-port to use another",
                        style="red",
                    )
                else:
                    raise
    finally:
        _served.rebuild = None
        _served.shutdown = None
        uninstall_shutdown_handler()
