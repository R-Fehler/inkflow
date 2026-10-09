from __future__ import annotations

import asyncio
import base64
import contextlib
import errno
import functools
import importlib.resources
import importlib.util
import io
import json
import os
import socket
import sys
import time
import traceback
import webbrowser
import zipfile
from collections.abc import Awaitable, Callable, Sequence
from html import escape as escape_html
from pathlib import Path
from typing import Literal, TypedDict, cast
from urllib.parse import unquote

from rich.console import Console
from rich.live import Live
from rich.text import Text
from watchfiles import (
    DefaultFilter,
    awatch,  # pyright: ignore[reportUnknownVariableType]
)
from websockets.asyncio.server import ServerConnection
from websockets.asyncio.server import serve as ws_serve

from inkflow.assets import MIME_TYPES, AssetRoots
from inkflow.edit import (
    NO_EDIT_COMMANDS,
    EditCommands,
    command_for,
    open_in_editor,
    resolve_edit_commands,
)
from inkflow.editor.context import write_context
from inkflow.editor.model import build_model
from inkflow.editor.session import EditError, EditorSession, Exporters
from inkflow.editor.svgops import file_hash
from inkflow.enums import ColorMode
from inkflow.fonts import embed_fonts_css
from inkflow.loaders import load_deck_scripts, load_deck_styles
from inkflow.logging import Levels, collect_logs, logger, report
from inkflow.manifest import Deck
from inkflow.os_compat import install_shutdown_handler, raw_keypresses
from inkflow.pipeline import SlideData, process_deck, resolve_transitions
from inkflow.titles import resolve_deck_title
from inkflow.tui import LiveUI

# ── Shared mutable state ──────────────────────────────────────────────────────


class State(TypedDict):
    slides: list[SlideData]
    transitions: list[dict[str, object]]
    ws_clients: set[ServerConnection]
    error: str | None
    styles_css: str
    scripts_js: str
    mode: ColorMode
    position: dict[str, int]
    logs: list[dict[str, str]]
    title: str
    theme_dir: Path | None
    """Active theme's asset directory, the second root an asset may live under.
    ``None`` until a deck has loaded, which is exactly when nothing can reference
    one yet."""


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


class EditorState(TypedDict):
    deck: Deck | None
    """The last deck that built, which editor requests are validated against."""
    model: dict[str, object] | None
    """The visual editor's model for the last build (see ``editor.model``)."""
    clients: set[ServerConnection]
    """Connections that identified as an editor page."""
    session: EditorSession | None
    """Undo history and file writes for the editor (one per server)."""


_editor: EditorState = {"deck": None, "model": None, "clients": set(), "session": None}


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
    # Compiled from source every time rather than through the loader: the
    # bytecode cache validates by mtime (whole seconds) and size, so an edit
    # that keeps the size (the editor reordering slides) within the same second
    # would load the stale cached code.
    code = compile(deck_path.read_bytes(), str(deck_path), "exec")
    exec(code, mod.__dict__)
    if not hasattr(mod, "main"):
        raise AttributeError(f"{deck_path} must define a main() -> Deck function")
    return cast(Callable[[], Deck], mod.main)()


# ── Build pipeline ────────────────────────────────────────────────────────────


async def rebuild(deck_path: Path, ui: LiveUI, levels: Levels) -> None:
    ui.set_building()

    async def _animate() -> None:
        while True:
            await asyncio.sleep(0.1)
            ui.refresh()

    spin = asyncio.create_task(_animate())
    t0 = time.monotonic()
    try:
        # Collected, not printed, so records reach the TUI/browser without racing the
        # Live display. Floored at the lower surface level, then filtered per surface.
        with collect_logs(min(levels.console, levels.browser)) as entries:
            deck_hash = file_hash(deck_path.read_bytes())
            deck = await asyncio.to_thread(load_deck, deck_path)
            project_dir = deck_path.parent
            # The editor build stamps source locators on every element; the
            # presenter ignores them, so one build serves both pages.
            edit_slides = await asyncio.to_thread(
                functools.partial(process_deck, editor=True),
                deck,
                project_dir,
                deck_path,
            )
            model = await asyncio.to_thread(build_model, deck, deck_path, edit_slides)
            slides = [_without_edit(s) for s in edit_slides]
            transitions = resolve_transitions(deck)
            styles_css = await asyncio.to_thread(load_deck_styles, deck, project_dir)
            if deck.embed_fonts:
                font_css = await asyncio.to_thread(
                    functools.partial(embed_fonts_css, styles_css=styles_css),
                    slides,
                    project_dir,
                    deck.theme.fonts_dir,
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
        # Styles and colour mode change rarely (a theme edit) and can be large
        # (embedded fonts): they ride along only when they changed.
        changed: dict[str, object] = {}
        if styles_css != _state["styles_css"]:
            changed["styles"] = styles_css
        if deck.effective_mode != _state["mode"]:
            changed["mode"] = "" if deck.effective_mode == ColorMode.DARK else "light"
        _state["slides"] = slides
        _state["transitions"] = transitions
        _state["styles_css"] = styles_css
        _state["scripts_js"] = scripts_js
        _state["mode"] = deck.effective_mode
        _state["title"] = resolve_deck_title(deck, project_dir)
        _state["theme_dir"] = deck.theme.asset_dir()
        _editor["deck"] = deck
        _editor["model"] = model
        if _editor["session"] is not None:
            _editor["session"].built_hash = deck_hash
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
                    **changed,
                }
            )
        )
        await _send_editors(_model_message())
    except Exception:
        # Outside collect_logs, so a fatal error reaches only the file sink. The overlay
        # and TUI error phase show it instead, never the banner.
        logger.exception("rebuild failed")
        tb = traceback.format_exc()
        _state["error"] = tb
        ui.set_error(tb)
        await broadcast(json.dumps({"type": "error", "message": tb}))
    finally:
        spin.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await spin
        ui.refresh()


def _model_message() -> dict[str, object]:
    session = _editor["session"]
    return {
        "type": "editor-model",
        "model": _editor["model"],
        "history": {
            "canUndo": bool(session and session.history.done),
            "canRedo": bool(session and session.history.undone),
        },
    }


def _without_edit(slide: SlideData) -> SlideData:
    """The presenter's copy of a slide: the editor facts travel in its model."""
    data = slide.copy()
    data.pop("edit", None)
    return data


# ── WebSocket broadcast ───────────────────────────────────────────────────────


async def _send_editors(payload: dict[str, object]) -> None:
    msg = json.dumps(payload)
    for ws in list(_editor["clients"]):
        try:
            await ws.send(msg)
        except Exception:
            _editor["clients"].discard(ws)


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


async def _handle_edit_op(
    websocket: ServerConnection, msg: dict[str, object], session: EditorSession
) -> None:
    """Apply one editor request and answer the sender with its result."""
    request_id = msg.get("id")
    try:
        result = await asyncio.to_thread(session.apply, msg, _editor["deck"])
    except EditError as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception as exc:
        logger.exception("editor request failed")
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    await websocket.send(
        json.dumps({"type": "edit-result", "id": request_id, **result})
    )


def make_ws_handler(
    ui: LiveUI,
    edit_commands: EditCommands,
    session: EditorSession | None = None,
) -> Callable[[ServerConnection], Awaitable[None]]:
    async def handler(websocket: ServerConnection) -> None:
        _state["ws_clients"].add(websocket)
        logger.debug(f"client connected ({len(_state['ws_clients'])} total)")
        ui.refresh()
        try:
            pos = _state["position"]
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
                if msg_type == "sync-request":
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
                elif msg_type == "hello" and msg.get("role") == "editor":
                    _editor["clients"].add(websocket)
                    if _editor["model"] is not None:
                        await websocket.send(json.dumps(_model_message()))
                elif msg_type == "edit-op" and session is not None:
                    await _handle_edit_op(websocket, msg, session)
                elif msg_type == "editor-context" and session is not None:
                    raw_context: object = msg.get("context")
                    context: object = raw_context
                    if isinstance(raw_context, dict):
                        # Which server this editor talks to: `inkflow goto`
                        # and `select` find it here when several are running.
                        context = {
                            **cast("dict[str, object]", raw_context),
                            "server": session.server,
                        }
                    await asyncio.to_thread(write_context, session.project_dir, context)
                elif msg_type == "editor-command":
                    # From `inkflow goto/select`: steer every open editor.
                    await _send_editors(msg)
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
            _editor["clients"].discard(websocket)
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


def build_editor_html(state: State, editor: EditorState, ws_port: int) -> bytes:
    """The visual editor page: its own shell and bundle, the deck's styles."""
    pkg = importlib.resources.files("inkflow")
    template = pkg.joinpath("editor.html").read_text(encoding="utf-8")
    css = pkg.joinpath("bundles", "editor.css").read_text(encoding="utf-8")
    js = pkg.joinpath("bundles", "editor.js").read_text(encoding="utf-8")
    data_theme = "" if state["mode"] == ColorMode.DARK else "light"
    html = (
        template.replace("/* __CSS__ */", css)
        .replace("/* __JS__ */", js)
        .replace("/* __STYLES__ */", state["styles_css"])
        .replace("__DATA_THEME__", data_theme)
        .replace("__SLIDES_JSON__", json.dumps(state["slides"]))
        .replace("__MODEL_JSON__", json.dumps(editor["model"]))
        .replace("__WS_PORT__", str(ws_port))
        .replace("__ERROR_JSON__", json.dumps(state["error"]))
        .replace("__FAVICON__", favicon_data_uri())
        .replace("__TITLE__", escape_html(f"Edit · {state['title']}"))
    )
    return html.encode("utf-8")


def _is_editor_path(request_path: str) -> bool:
    path = request_path.split("?", 1)[0].split("#", 1)[0]
    return path == "/edit" or path.startswith("/edit/")


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


def _read_export(path: Path) -> tuple[str, str, bytes]:
    """An exported file, or an exported folder as a zip, for download."""
    if path.is_dir():
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in sorted(path.rglob("*")):
                if f.is_file():
                    zf.write(f, f"{path.name}/{f.relative_to(path).as_posix()}")
        return f"{path.name}.zip", "application/zip", buf.getvalue()
    mime = {".pdf": "application/pdf", ".html": "text/html; charset=utf-8"}.get(
        path.suffix.lower(), "application/octet-stream"
    )
    return path.name, mime, path.read_bytes()


def _export_download(
    request_path: str,
) -> tuple[Callable[[Path], tuple[str, str, bytes]], Path] | None:
    """``/_export/<token>/<name>``: a file the editor exported in this session.

    Only paths the session recorded under a random token are served, so this
    route cannot reach any other file."""
    parts = request_path.split("?", 1)[0].split("/")
    if len(parts) < 3 or parts[1] != "_export":
        return None
    session = _editor["session"]
    path = session.exports.get(parts[2]) if session is not None else None
    if path is None or not path.exists():
        return None
    return _read_export, path


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
            request_path = parts[1] if len(parts) >= 2 else "/"

            download = _export_download(request_path)
            if download is not None:
                name, mime, body = await asyncio.to_thread(*download)
                header = (
                    b"HTTP/1.1 200 OK\r\n"
                    + f"Content-Type: {mime}\r\n".encode()
                    + f'Content-Disposition: attachment; filename="{name}"\r\n'.encode()
                    + b"Cache-Control: no-store\r\n"
                    + b"Connection: close\r\n"
                    + b"Content-Length: "
                    + str(len(body)).encode()
                    + b"\r\n\r\n"
                )
                writer.write(header + body)
                await writer.drain()
                return

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

            if _is_editor_path(request_path):
                body = build_editor_html(_state, _editor, ws_port)
            else:
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


class _WatchFilter(DefaultFilter):
    """The default ignores, plus ``.inkflow/`` (editor context the server writes)."""

    # build/ is where `inkflow build` and the editor's export write: never input.
    ignore_dirs: Sequence[str] = (*DefaultFilter.ignore_dirs, ".inkflow", "build")


async def _watch(
    deck_path: Path, ui: LiveUI, lock: asyncio.Lock, levels: Levels
) -> None:
    async for changes in awatch(str(deck_path.parent), watch_filter=_WatchFilter()):
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

    loop = asyncio.get_running_loop()
    async with raw_keypresses(loop) as queue:
        while True:
            ch = await queue.get()
            if ch in ("\x04", "q"):  # Ctrl-D, q (Ctrl-C handled via SIGINT)
                shutdown.set()
                return
            elif ch == "o":
                _open_browser(f"http://{host}:{http_port}")
            elif ch == "e":
                _open_browser(f"http://{host}:{http_port}/edit")
            elif ch == "r":
                async with lock:
                    await rebuild(deck_path, ui, levels)
            elif ch == "t":
                ui.toggle_trace()


# ── Ports ─────────────────────────────────────────────────────────────────────

DEFAULT_PORT = 7777


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def pick_ports(host: str, port: int | None, ws_port: int | None) -> tuple[int, int]:
    """The HTTP and WebSocket ports to serve on.

    Explicit ports are used as given (a clash is then reported as before).
    Unset ones take the first free pair from 7777 up, so a second
    ``inkflow edit`` for another deck simply comes up next to the first.
    """
    if port is not None and ws_port is not None:
        return port, ws_port
    if port is not None:
        ws = port + 1
        while not _port_free(host, ws):
            ws += 1
        return port, ws
    candidate = DEFAULT_PORT
    for _ in range(200):
        ws = ws_port if ws_port is not None else candidate + 1
        if (
            candidate != ws
            and _port_free(host, candidate)
            and (ws_port is not None or _port_free(host, ws))
        ):
            return candidate, ws
        candidate += 2 if ws_port is None else 1
    return DEFAULT_PORT, ws_port if ws_port is not None else DEFAULT_PORT + 1


# ── Public entry point ────────────────────────────────────────────────────────


async def serve(
    deck_path: Path,
    host: str,
    http_port: int,
    ws_port: int,
    levels: Levels,
    open_path: str | None = None,
    exporters: Exporters | None = None,
) -> None:
    """Run the server until quit. ``open_path`` (e.g. ``"/edit"``) opens a
    browser on that page once the first build is done; ``exporters`` enable
    the editor's Export dialog."""
    console = Console()
    rebuild_lock = asyncio.Lock()
    shutdown = asyncio.Event()

    loop = asyncio.get_running_loop()
    uninstall_shutdown_handler = install_shutdown_handler(loop, shutdown)

    try:
        edit_commands = resolve_edit_commands()
        session = EditorSession(deck_path, exporters)
        session.server = {"host": host, "port": http_port, "wsPort": ws_port}
        _editor["session"] = session
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
            try:
                async with (
                    http_server,
                    ws_serve(
                        make_ws_handler(ui, edit_commands, session),
                        host,
                        ws_port,
                        # Image uploads from the editor arrive as base64 frames.
                        max_size=80 * 1024 * 1024,
                    ),
                ):
                    await rebuild(deck_path, ui, levels)
                    if open_path is not None:
                        _open_browser(f"http://{host}:{http_port}{open_path}")
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
        uninstall_shutdown_handler()
