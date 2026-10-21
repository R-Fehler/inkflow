"""The server ``inkflow serve`` runs: one port for the presenter's pages, the
deck's assets and fonts, and the WebSocket (``/_inkflow/ws``) that pushes
every rebuild (only what changed, ``inkflow.incremental``) and relays
positions and ink between windows.

Who may connect, and as whom, is decided at the door (``inkflow.access``):
the owner (this machine), or a share link's editor or viewer.

Frontends plug in as server extensions (``inkflow.extensions``): they get the
builds, their own WebSocket messages and pages, terminal keys and a
``ServerContext`` to act through. The core never knows what they are.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import errno
import functools
import importlib.resources
import importlib.util
import json
import os
import re
import socket
import ssl
import sys
import time
import traceback
import webbrowser
from collections.abc import (
    AsyncGenerator,
    Awaitable,
    Callable,
    Collection,
    Sequence,
)
from dataclasses import dataclass, field
from html import escape as escape_html
from pathlib import Path
from typing import Literal, cast
from urllib.parse import unquote

from rich.console import Console
from rich.live import Live
from rich.text import Text
from typing_extensions import override
from watchfiles import (
    Change,
    DefaultFilter,
    awatch,  # pyright: ignore[reportUnknownVariableType]
)
from websockets.asyncio.server import ServerConnection
from websockets.asyncio.server import serve as ws_serve
from websockets.http11 import Request as WsRequest
from websockets.http11 import Response as WsResponse

from inkflow import ink, instances, plugins
from inkflow.access import (
    TOKEN_PARAM,
    WS_PATH,
    Access,
    Role,
    enter_page,
    is_loopback_name,
    lan_addresses,
    login_user,
    page,
    parse_request,
    peer_host,
    redacted,
    server_names,
    split_host,
)
from inkflow.access import Request as AccessRequest
from inkflow.assets import MIME_TYPES, AssetRoots, is_local_ref, rewrite_references
from inkflow.collab import Client, People
from inkflow.deps import file_hash
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
    VirtualConnection,
)
from inkflow.fonts import (
    embed_fonts_css,
    font_mime,
    shipped_font_file,
    shipped_font_url,
    ui_fonts_css,
)
from inkflow.incremental import SlideCache, as_patch, keys_of, set_keys
from inkflow.loaders import load_deck_scripts, load_deck_styles
from inkflow.logging import Levels, collect_logs, logger, report, resolve_levels
from inkflow.manifest import Deck
from inkflow.os_compat import install_shutdown_handler, raw_keypresses
from inkflow.pipeline import (
    SlideData,
    process_deck,
    resolve_slide_src,
    resolve_transitions,
    slide_ids,
)
from inkflow.svgio import parse_svg_file
from inkflow.titles import resolve_deck_title
from inkflow.tui import LiveUI
from inkflow.wsbridge import Bridge

DEFAULT_PORT = 7777

# ── Shared mutable state ──────────────────────────────────────────────────────


@dataclass
class Kept:
    """One deck's builds, slide by slide: a rebuild processes the slides a
    change touched and takes the others from here (`inkflow.incremental`)."""

    deck_path: Path
    slides: SlideCache


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
    kept: Kept | None = None
    """What is kept from one build of the served deck to the next."""
    extensions: list[ServerExtension] = field(default_factory=list)
    """The server's extensions (``inkflow.extensions``)."""
    edit_commands: EditCommands = NO_EDIT_COMMANDS
    address: dict[str, object] = field(default_factory=dict)
    """Where this machine's own pages and programs reach the server."""
    switch_to: Path | None = None
    """The deck an extension asked to serve next (``open_deck``)."""
    switch: asyncio.Event | None = None
    shutdown: asyncio.Event | None = None
    rebuild: Callable[[bool], Awaitable[None]] | None = None
    """Build the served deck again (set while serving)."""


_served = _Served()


class _Share:
    """Who may connect (``access.Access``), who is connected
    (``collab.People``), and the listener sharing turns on and off."""

    access: Access
    people: People
    rebind: Callable[[bool], Awaitable[None]] | None
    """Set while serving: listen on the LAN (True) or this machine only
    (in SSH mode: where it listens already, links on or off)."""
    route: Route | None
    """How the one port answers a request: requests that came another way
    (``ServerContext.serve_request``) too."""
    ws_handler: Callable[[ServerConnection], Awaitable[None]] | None
    """The WebSocket handler of the deck being served: connections that came
    another way (``ServerContext.serve_connection``) run through it too."""
    on_change: Callable[[], None] | None
    """Refresh the terminal's share lines (set while serving)."""

    def __init__(self) -> None:
        self.access = Access(DEFAULT_PORT)
        self.people = People()
        self.rebind = None
        self.route = None
        self.ws_handler = None
        self.on_change = None


_share = _Share()


# ── Deck loader ───────────────────────────────────────────────────────────────


class DeckError(Exception):
    """deck.py did not load: the file, line and error, without the traceback
    through inkflow (the cause stays chained for the server's error overlay)."""


def _deck_failure(deck_path: Path, exc: BaseException) -> str:
    """Where in deck.py ``exc`` happened, as ``deck.py:41: NameError: …``."""
    lineno, line = None, None
    if isinstance(exc, SyntaxError) and exc.filename == str(deck_path):
        lineno, line = exc.lineno, exc.text
    else:
        frames = [
            f
            for f in traceback.extract_tb(exc.__traceback__)
            if f.filename == str(deck_path)
        ]
        if frames:
            lineno, line = frames[-1].lineno, frames[-1].line
    where = f"{deck_path.name}:{lineno}" if lineno else deck_path.name
    detail = f"\n    {line.strip()}" if line and line.strip() else ""
    return f"{where}: {type(exc).__name__}: {exc}{detail}"


def load_deck(deck_path: Path) -> Deck:
    """Run deck.py's ``main()``; any failure in it is a ``DeckError``."""
    try:
        return _load_deck(deck_path)
    except DeckError:
        raise
    except Exception as exc:
        raise DeckError(_deck_failure(deck_path, exc)) from exc


def _load_deck(deck_path: Path) -> Deck:
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


def _kept_for(deck_path: Path, full: bool) -> tuple[Kept, bool]:
    """The served deck's kept builds, and whether they start empty (after
    ``full``, for another deck than the last, or the first build)."""
    kept = _served.kept
    if kept is None or kept.deck_path != deck_path or full:
        kept = Kept(deck_path, SlideCache())
        _served.kept = kept
        return kept, True
    return kept, False


def _update_message(
    slides: Sequence[object], changed: dict[str, object] | None = None
) -> str:
    return json.dumps(
        {
            "type": "update",
            "slides": slides,
            "transitions": _state["transitions"],
            "logs": _state["logs"],
            **(changed or {}),
        }
    )


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


async def rebuild(
    deck_path: Path, ui: LiveUI, levels: Levels, *, full: bool = False
) -> None:
    """Build the deck and tell the pages. Slides whose files and settings
    are as the last build read them are not processed again, and a page is
    sent only the slides that changed; ``full`` forgets the last builds (the
    terminal's ``r``)."""
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
            kept, fresh = _kept_for(deck_path, full)
            # An extension may ask for source locators on every element; the
            # presenter ignores them, so one build serves every page.
            built = await asyncio.to_thread(
                functools.partial(
                    process_deck,
                    editor=any(ext.provenance for ext in extensions),
                    cache=kept.slides,
                ),
                deck,
                project_dir,
                deck_path,
            )
            build = Build(deck, deck_path, deck_hash, built, fresh=fresh)
            for ext in extensions:
                await asyncio.to_thread(ext.build, build)
            roots = AssetRoots(project_dir, deck.theme.asset_dir())
            slides = [_versioned(_without_edit(s), roots) for s in built]
            set_keys(slides)
            build.served = slides
            transitions = resolve_transitions(deck)
            styles_css = await asyncio.to_thread(load_deck_styles, deck, project_dir)
            if deck.embed_fonts:
                font_css = await asyncio.to_thread(
                    functools.partial(
                        embed_fonts_css,
                        styles_css=styles_css,
                        font_url=shipped_font_url,
                    ),
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
        # What a page that saw the last build holds: named, not sent again.
        held = keys_of(_state["slides"])
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
        ui.set_ok(
            len(slides),
            time.monotonic() - t0,
            logs=tui_logs,
            processed=len(kept.slides.processed),
        )
        patching = {
            ws
            for ws in _state["ws_clients"]
            if (c := _share.people.get(ws)) is not None and c.patches
        }
        if patching:
            patch = _update_message(as_patch(slides, held), changed)
            await broadcast(patch, skip=_state["ws_clients"] - patching)
        if _state["ws_clients"] - patching:
            # A page of an older inkflow (a tab left open across an update).
            await broadcast(_update_message(slides, changed), skip=patching)
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
    data = slide.copy()
    data.pop("edit", None)
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


async def broadcast(
    msg: str,
    sender: ServerConnection | None = None,
    *,
    skip: Collection[ServerConnection] = (),
) -> None:
    dead: set[ServerConnection] = set()
    for ws in list(_state["ws_clients"]):
        if ws is sender or ws in skip:
            continue
        try:
            await ws.send(msg)
        except Exception:
            dead.add(ws)
    _state["ws_clients"] -= dead


async def send_owners(payload: dict[str, object]) -> None:
    """To the owner's pages other than the presenter's (where a Share dialog
    lives); never to a program (a command's socket says no page)."""
    msg = json.dumps(payload)
    for conn, client in _share.people.items():
        if client.role == "owner" and client.page not in ("", "presenter"):
            with contextlib.suppress(Exception):
                await cast("ServerConnection", conn).send(msg)


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


# ── Sharing ───────────────────────────────────────────────────────────────────


def _link_addresses(access: Access) -> list[str]:
    """Where share links point: this machine's network addresses, or in SSH
    mode ``localhost`` (each guest opens it through their own tunnel)."""
    return ["localhost"] if access.ssh else lan_addresses()


def share_status() -> dict[str, object]:
    """What the owner's Share dialog shows (extensions add their part)."""
    access = _share.access
    status: dict[str, object] = {
        "type": "share-status",
        "sharing": access.sharing,
        "links": access.links(_link_addresses(access), editor_page())
        if access.sharing
        else [],
        "names": []
        if access.ssh
        else sorted(
            {n for n in access.names if n.endswith(".local")} | access.allow_hosts
        ),
        "port": access.port,
        "ssh": access.ssh,
        "people": _share.people.listing(),
    }
    for ext in _served.extensions:
        try:
            status.update(ext.share_status())
        except Exception:
            logger.exception(f"{ext.name}: share status failed")
    return status


SENT_AWAY = 4001
"""Close code of a guest connection sent away (the page says why and does
not reconnect: its link stopped working, or the owner disconnected it)."""


async def _disconnect(
    which: Callable[[Client], bool], reason: str, code: int = SENT_AWAY
) -> int:
    """Close every guest connection ``which`` picks (one the owner sent away,
    or every guest of links that stopped working); their pages say why and
    stop reconnecting."""
    gone = 0
    for conn, client in _share.people.items():
        if client.role != "owner" and which(client):
            gone += 1
            with contextlib.suppress(Exception):
                await cast("ServerConnection", conn).close(code, reason)
    return gone


async def _handle_share(websocket: ServerConnection, msg: dict[str, object]) -> None:
    """The owner's Share dialog: status, on/off, new links, disconnect, and
    whatever an extension adds (``share_op``)."""
    op = msg.get("op")
    access = _share.access
    error: str | None = None
    core_op = op in ("status", "on", "off", "rotate", "kick")
    changed = op in ("on", "off", "rotate")
    try:
        if op == "on" and not access.sharing:
            access.sharing = True
            if _share.rebind is not None:
                await _share.rebind(True)
            logger.info("sharing on")
        elif op == "off" and access.sharing:
            access.sharing = False
            if _share.rebind is not None:
                await _share.rebind(False)
            _ = await _disconnect(lambda c: not c.online, "sharing stopped")
            logger.info("sharing off")
        elif op == "rotate":
            access.rotate()
            gone = await _disconnect(lambda c: not c.online, "new links")
            logger.info(f"new share links ({gone} guests disconnected)")
        elif op == "kick":
            target = str(msg.get("id") or "")
            _ = await _disconnect(lambda c: c.id == target, "disconnected by the owner")
        if isinstance(op, str):
            # Every extension sees every operation (after the core's own), so
            # one adding to the dialog can refresh what it adds on `status`.
            for ext in _served.extensions:
                answer = await ext.share_op(op, msg)
                if answer is not False and not core_op:
                    error = answer if isinstance(answer, str) else None
                    changed = True
                    break
    except OSError as exc:
        access.sharing = False
        error = f"cannot listen on the network: {exc}"
        if _share.rebind is not None:
            with contextlib.suppress(OSError):
                await _share.rebind(False)
    reply = share_status()
    if error:
        reply["error"] = error
    await websocket.send(json.dumps(reply))
    if changed:
        await send_owners(share_status())


def _share_changed() -> None:
    """An extension's part of sharing changed: the terminal and the owner's
    Share dialog say so."""
    if _share.on_change is not None:
        _share.on_change()
    _spawn(send_owners(share_status()))


_background: set[asyncio.Task[None]] = set()


def _spawn(work: Awaitable[None]) -> None:
    async def run() -> None:
        await work

    task = asyncio.get_running_loop().create_task(run())
    _background.add(task)
    task.add_done_callback(_background.discard)


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


def _ink_file(
    deck: Deck, project_dir: Path, slide_id: str
) -> tuple[Path, tuple[float, float, float, float]]:
    """Slide ``slide_id``'s ink file and its canvas (what a new file takes)."""
    visible = [s for s in deck.slides if s.visible]
    slide = next(
        (s for s, i in zip(visible, slide_ids(visible), strict=True) if i == slide_id),
        None,
    )
    if slide is None:
        raise ink.InkError(f"no slide {slide_id!r}")
    try:
        src = resolve_slide_src(slide.src, project_dir, deck.theme)
        box = ink.view_box(parse_svg_file(src))
    except (OSError, ValueError):
        box = None
    canvas = box or (0.0, 0.0, *deck.effective_size.canvas)
    return ink.ink_path(slide, slide_id, project_dir), canvas


async def _save_ink(websocket: ServerConnection, msg: dict[str, object]) -> None:
    """An ``edit-op`` when no extension edits the deck: only the presenter's
    "Keep" (``action: "ink"``) is answered, writing the ink file directly."""
    reply: dict[str, object] = {"type": "edit-result", "id": msg.get("id")}
    deck = _served.deck
    slide_id = msg.get("slideId")
    try:
        if msg.get("action") != "ink":
            raise ink.InkError("nothing on this server edits the deck")
        if deck is None or _served.deck_path is None:
            raise ink.InkError("the deck has not built")
        if not isinstance(slide_id, str):
            raise ink.InkError("which slide?")
        project_dir = _served.deck_path.parent
        path, canvas = _ink_file(deck, project_dir, slide_id)
        await asyncio.to_thread(ink.save_ink, path, msg, canvas)
        reply.update(ok=True, ink=path.relative_to(project_dir).as_posix())
    except (ink.InkError, OSError) as exc:
        reply.update(ok=False, error=str(exc))
    await websocket.send(json.dumps(reply))


_ROLE_RANK: dict[Role, int] = {"viewer": 0, "editor": 1, "owner": 2}

_OWNER_ONLY = frozenset({"edit", "share"})
"""Messages only the owner's pages and programs send: opening a program on
this machine, and sharing itself."""


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


def allowed(role: Role, msg: dict[str, object]) -> bool:
    """Whether ``role`` may send this message at all: the core's own by its
    rules, an extension's by the least role it names."""
    kind = msg.get("type")
    if kind in _OWNER_ONLY:
        return role == "owner"
    handled = _extension_for(kind)
    if handled is not None:
        return _ROLE_RANK[role] >= _ROLE_RANK[handled[1]]
    if kind == "edit-op":
        # The presenter's "Keep" with no editor: the ink file, written directly.
        return role in ("owner", "editor")
    if kind == "hello" and msg.get("role") == "editor":
        return role in ("owner", "editor")
    if role == "viewer":
        # A viewer follows: it moves no one else's slide and draws on no one
        # else's screen (it may ask for the ink already drawn).
        if kind == "nav":
            return False
        if kind == "ink":
            return msg.get("op") == "request"
    return True


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
    """The handler of every page connection, once the door let it in (its
    ``Client`` joined ``People`` with its role)."""

    async def handler(websocket: ServerConnection) -> None:
        client = _share.people.get(websocket)
        if client is None:
            # Not admitted at the door (cannot happen through the listeners).
            await websocket.close(4003, "not admitted")
            return
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
                if not allowed(client.role, msg):
                    if msg_type == "edit-op":
                        await websocket.send(
                            json.dumps(
                                {
                                    "type": "edit-result",
                                    "id": msg.get("id"),
                                    "ok": False,
                                    "error": "this link is view-only",
                                }
                            )
                        )
                    continue
                handled = _extension_for(msg_type)
                if handled is not None:
                    try:
                        await handled[0].message(websocket, client, msg)
                    except Exception:
                        logger.exception(f"{handled[0].name}: {msg_type} failed")
                elif msg_type in ("hello", "resync"):
                    # A page says what it is (``presenter``, ``editor``…) and
                    # which rebuilds it takes (``patch``: what changed), and
                    # is told which slides the deck has now: by key when it
                    # may hold them (the ones its HTML came with), whole when
                    # it found it does not (``resync``).
                    if msg_type == "hello":
                        client.patches = bool(msg.get("patch"))
                        if not client.page and isinstance(msg.get("role"), str):
                            client.page = str(msg.get("role"))
                    if client.patches and _state["error"] is None:
                        whole = msg_type == "resync"
                        slides = _state["slides"]
                        await websocket.send(
                            _update_message(
                                slides if whole else as_patch(slides, keys_of(slides))
                            )
                        )
                    for ext in list(_served.extensions):
                        try:
                            await ext.hello(
                                websocket, client, msg, resync=msg_type == "resync"
                            )
                        except Exception:
                            logger.exception(f"{ext.name}: {msg_type} failed")
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
                elif msg_type == "ink":
                    # Ink drawn without "Keep" is relayed like a position: the
                    # server holds none of it, every other window draws it.
                    # Saving is an ``edit-op`` (an extension's, else _save_ink).
                    await broadcast(json.dumps(msg), sender=websocket)
                elif msg_type == "edit-op":
                    await _save_ink(websocket, msg)
                elif msg_type == "share":
                    await _handle_share(websocket, msg)
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
            _ = _share.people.leave(websocket)
            await _each_extension(
                "disconnected", lambda ext: ext.disconnected(websocket, client)
            )
            logger.debug(f"client disconnected ({len(_state['ws_clients'])} total)")
            ui.refresh()

    return handler


# ── HTTP handler ──────────────────────────────────────────────────────────────

_StreamHandler = Callable[[asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]]


Route = Callable[
    [AccessRequest, bytes, Role, str | None, ResponseWriter], Awaitable[None]
]
"""Answer one admitted request (see ``make_http_route``)."""


@functools.cache
def favicon_data_uri() -> str:
    """Base64 data URI for the built-in adaptive favicon, computed once."""
    pkg = importlib.resources.files("inkflow")
    svg_bytes = pkg.joinpath("theme", "icon.svg").read_bytes()
    b64 = base64.b64encode(svg_bytes).decode()
    return f"data:image/svg+xml;base64,{b64}"


@functools.cache
def served_ui_fonts() -> str:
    return ui_fonts_css()


def build_html(
    state: State,
    ws_port: int | None,
    edit_commands: EditCommands = NO_EDIT_COMMANDS,
    ui_fonts: str | None = None,
) -> bytes:
    """The presenter page. ``ui_fonts`` are the interface's ``@font-face``
    rules: by default loaded from this server (`ui_fonts_css`); a static build
    passes them subset and inline."""
    pkg = importlib.resources.files("inkflow")
    template = pkg.joinpath("presenter.html").read_text(encoding="utf-8")
    css = pkg.joinpath("bundles", "presenter.css").read_text(encoding="utf-8")
    css = (served_ui_fonts() if ui_fonts is None else ui_fonts) + "\n" + css
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


def _versioned(slide: SlideData, roots: AssetRoots) -> SlideData:
    """The slide with each local asset reference stamped with its file's
    modification time (``assets/x.png?v=…``), for serving only.

    A page keeps the pictures it has loaded by URL, so a diagram or picture
    changed on disk (Inkscape, GIMP) would stay as it was on screen: with the
    stamp, the changed file is a changed slide (pushed as usual) at a new URL.
    The slide cache never reads pictures (`inkflow.incremental`): this runs
    on every build, outside it. ``_resolve_asset`` ignores the query; build
    and export never stamp, and a frontend that writes references back drops
    it first.
    """

    def stamp(ref: str) -> str | None:
        if not is_local_ref(ref) or "?" in ref:
            return None
        located = roots.locate(unquote(ref))
        try:
            mtime = located.stat().st_mtime_ns if located is not None else None
        except OSError:
            return None
        return f"{ref}?v={mtime:x}" if mtime else None

    out = slide.copy()
    out["svg"] = rewrite_references(slide["svg"], stamp)
    out["notes"] = rewrite_references(slide["notes"], stamp)
    return out


def _resolve_asset(roots: AssetRoots, request_path: str) -> Path | None:
    """Map a request path to a file, or ``None`` if it names nothing servable.

    The request path is a canonical asset reference: the pipeline wrote it into
    the slide SVG, so ``AssetRoots.locate`` is the same answer ``build`` copies
    to, and containment against the allowed roots is enforced there. A query
    (the version stamp ``_versioned`` adds) is not part of the name.
    """
    decoded = unquote(request_path.split("?", 1)[0]).lstrip("/")
    located = roots.locate(decoded)
    if located is None:
        return None
    if located.suffix.lower() not in _SERVED_SUFFIXES:
        return None
    resolved = located.resolve()
    if not resolved.is_file():
        return None
    return resolved


_RANGE = re.compile(rb"^range:\s*bytes=(\d*)-(\d*)\s*$", re.I | re.M)
_CHUNK = 1024 * 1024


def _range_header(raw: bytes) -> tuple[int | None, int | None] | None:
    """The single byte range a request asks for (``Range: bytes=a-b``)."""
    m = _RANGE.search(raw.split(b"\r\n\r\n", 1)[0])
    if m is None or (not m.group(1) and not m.group(2)):
        return None
    return (
        int(m.group(1)) if m.group(1) else None,
        int(m.group(2)) if m.group(2) else None,
    )


def byte_range(
    size: int, wanted: tuple[int | None, int | None] | None
) -> tuple[int, int] | None:
    """The inclusive span to send for a ``Range`` request, or None for all of
    it. ``(None, n)`` is the last n bytes. Raises ValueError when the range
    lies outside the file."""
    if wanted is None:
        return None
    start, end = wanted
    if start is None:
        if not end:
            raise ValueError("empty suffix range")
        start, end = max(0, size - end), size - 1
    else:
        end = size - 1 if end is None else min(end, size - 1)
    if start >= size or start > end:
        raise ValueError("range outside the file")
    return start, end


async def _send_file(
    writer: ResponseWriter,
    path: Path,
    wanted: tuple[int | None, int | None] | None,
) -> None:
    """Stream a file, or the byte range asked for (206): a video seeks and
    plays in every browser (Safari asks for ranges), and a large file is never
    read into memory whole."""
    mime = MIME_TYPES.get(path.suffix.lower(), "application/octet-stream")
    size = path.stat().st_size
    try:
        span = byte_range(size, wanted)
    except ValueError:
        writer.write(
            b"HTTP/1.1 416 Range Not Satisfiable\r\n"
            + f"Content-Range: bytes */{size}\r\n".encode()
            + b"Connection: close\r\nContent-Length: 0\r\n\r\n"
        )
        await writer.drain()
        return
    start, end = span if span else (0, size - 1)
    length = max(0, end - start + 1)
    status = b"206 Partial Content" if span else b"200 OK"
    header = (
        b"HTTP/1.1 "
        + status
        + b"\r\n"
        + f"Content-Type: {mime}\r\n".encode()
        + b"Accept-Ranges: bytes\r\n"
        + (f"Content-Range: bytes {start}-{end}/{size}\r\n".encode() if span else b"")
        + b"Cache-Control: no-store\r\n"
        + b"Connection: close\r\n"
        + f"Content-Length: {length}\r\n\r\n".encode()
    )
    writer.write(header)
    with path.open("rb") as f:
        _ = f.seek(start)
        left = length
        while left > 0:
            chunk = f.read(min(_CHUNK, left))
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
            left -= len(chunk)


_HTML_HEADERS = (
    b"Cache-Control: no-store\r\n"
    # Never inside another site's frame (a click on a page that its user did
    # not mean), and no share token in a Referer.
    + b"X-Frame-Options: SAMEORIGIN\r\n"
    + b"Content-Security-Policy: frame-ancestors 'self'\r\n"
    + b"Referrer-Policy: no-referrer\r\n"
)


async def _respond(
    writer: ResponseWriter,
    status: str,
    body: bytes,
    content_type: str = "text/html; charset=utf-8",
    extra: bytes = b"",
) -> None:
    writer.write(
        f"HTTP/1.1 {status}\r\n".encode()
        + f"Content-Type: {content_type}\r\n".encode()
        + _HTML_HEADERS
        + extra
        + b"Connection: close\r\n"
        + f"Content-Length: {len(body)}\r\n\r\n".encode()
        + body
    )
    await writer.drain()


async def _refuse(writer: ResponseWriter, status: str, title: str, text: str) -> None:
    await _respond(writer, status, page(title, text))


_SSH_401 = (
    "This inkflow server runs on a machine other people can log in to, so "
    + "being on it is not enough. If you started it, open the owner "
    + "link it printed in its terminal (http://localhost:<port>/…?k=…, "
    + "with your tunnel's local port if you forwarded another one). If someone "
    + "shared the deck with you, open the link they sent."
)


def _probe_body() -> bytes:
    deck = _served.deck_path
    return json.dumps(
        {"pid": os.getpid(), "deck": str(deck) if deck is not None else None}
    ).encode()


def _http_request(
    request: AccessRequest,
    raw: bytes,
    role: Role,
    token: str | None,
    writer: ResponseWriter,
) -> HttpRequest:
    """The request as an extension gets it, with the core's ways to answer."""

    async def respond(
        status: str, body: bytes, content_type: str, extra: bytes = b""
    ) -> None:
        await _respond(writer, status, body, content_type, extra)

    async def send_file(path: Path) -> None:
        await _send_file(writer, path, _range_header(raw))

    async def refuse(status: str, title: str, text: str) -> None:
        await _refuse(writer, status, title, text)

    return HttpRequest(request, raw, role, token, writer, respond, send_file, refuse)


def make_http_route(
    ws_port: int,
    project_dir: Path | None = None,
    edit_commands: EditCommands = NO_EDIT_COMMANDS,
) -> Route:
    """Everything the one port answers once it knows who asks (``role``,
    and the share ``token`` that admitted them): pages, pictures, fonts,
    and whatever the extensions answer. A request that came another way
    (``ServerContext.serve_request``) is answered by this too, so what each
    role may fetch is decided here once. Without a ``project_dir`` (serving
    no deck) only the extensions' pages are there."""

    async def route(
        request: AccessRequest,
        raw: bytes,
        role: Role,
        token: str | None,
        writer: ResponseWriter,
    ) -> None:
        access = _share.access
        path = request.path
        if token is not None and TOKEN_PARAM in request.query:
            # A share link (or the owner link): the cookie keeps them in;
            # the page moves on to the same address without the token.
            who = "owner signed in" if role == "owner" else f"guest joined as {role}"
            logger.info(f"{who} with {redacted(token)}")
            cookie = access.set_cookie(token, request.host)
            await _respond(
                writer,
                "200 OK",
                enter_page(request.without_token()),
                extra=f"Set-Cookie: {cookie}\r\n".encode(),
            )
            return

        if path == instances.PROBE_PATH:
            # Who is serving here (see instances.py): another inkflow
            # opening a deck asks before starting a second server for it.
            if role != "owner":
                await _refuse(writer, "404 Not Found", "Not found", "")
                return
            await _respond(writer, "200 OK", _probe_body(), "application/json")
            return

        font = shipped_font_file(path)
        if font is not None:
            # A font inkflow ships (the deck's and the interface's): the
            # same bytes for as long as this inkflow is installed.
            body = await asyncio.to_thread(font.read_bytes)
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                + f"Content-Type: {font_mime(font)}\r\n".encode()
                + b"Cache-Control: public, max-age=86400\r\n"
                + b"Access-Control-Allow-Origin: *\r\n"
                + b"Connection: close\r\n"
                + f"Content-Length: {len(body)}\r\n\r\n".encode()
                + body
            )
            await writer.drain()
            return

        if project_dir is not None and path != "/":
            roots = AssetRoots(project_dir, _state["theme_dir"])
            asset_path = _resolve_asset(roots, path)
            if asset_path is not None:
                await _send_file(writer, asset_path, _range_header(raw))
                return

        extension_request = _http_request(request, raw, role, token, writer)
        for ext in list(_served.extensions):
            if await ext.http(extension_request):
                return

        if project_dir is None:
            # Serving without a deck: only the extensions' pages exist.
            await _refuse(
                writer, "404 Not Found", "No deck open", "This server has no deck open."
            )
            return
        # Opening a source file in a program is the owner's alone.
        body = build_html(
            _state, ws_port, edit_commands if role == "owner" else NO_EDIT_COMMANDS
        )
        await _respond(writer, "200 OK", body)

    return route


def make_http_handler(
    ws_port: int,
    project_dir: Path | None = None,
    edit_commands: EditCommands = NO_EDIT_COMMANDS,
    bridge: Bridge | None = None,
) -> _StreamHandler:
    """The server's one port: pages, pictures, and (handed to ``bridge``)
    the WebSocket at ``/_inkflow/ws``, each behind the door. ``ws_port`` is
    what the pages are told (they connect to their own address; it only says
    the deck is served)."""
    route = make_http_route(ws_port, project_dir, edit_commands)

    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        handed_off = False
        try:
            try:
                raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
            except (
                asyncio.IncompleteReadError,
                asyncio.LimitOverrunError,
                TimeoutError,
            ):
                return
            request = parse_request(raw)
            if request is None:
                await _refuse(writer, "400 Bad Request", "Bad request", "")
                return
            access = _share.access
            if not access.host_ok(request.host):
                # A name this machine does not answer to: a page whose name
                # was pointed at this machine (DNS rebinding).
                await _refuse(
                    writer,
                    "403 Forbidden",
                    "Unknown host name",
                    "This inkflow server answers to its own names and addresses "
                    + "only (add one with --allow-host).",
                )
                return
            peer = peer_host(cast("object", writer.get_extra_info("peername")))
            role, token = access.admit(peer, request)

            if request.path == WS_PATH:
                if not access.origin_ok(request.headers.get("origin"), request.host):
                    # Another site's page opening a socket to this server.
                    await _refuse(writer, "403 Forbidden", "Forbidden", "")
                    return
                if role is None:
                    await _refuse(writer, "401 Unauthorized", "Not shared", "")
                    return
                if bridge is None or not request.is_websocket:
                    await _refuse(writer, "400 Bad Request", "Bad request", "")
                    return
                connection = bridge.adopt(writer, raw)
                _ = _share.people.join(connection, role, token, peer)
                handed_off = True
                return

            if role is None:
                logger.debug(f"refused {peer}: no valid share link")
                if access.ssh and not access.presents_token(request):
                    await _refuse(
                        writer, "401 Unauthorized", "Open the owner link", _SSH_401
                    )
                    return
                await _refuse(
                    writer,
                    "401 Unauthorized",
                    "This deck is not shared with you",
                    "Open the link the person sharing it gave you. A link stops "
                    + "working when they make new ones or stop sharing.",
                )
                return
            await route(request, raw, role, token, writer)
        except Exception:
            # File sink only, never the TUI. The client still gets the 500 body below.
            logger.exception("error handling HTTP request")
            body = traceback.format_exc().encode()
            with contextlib.suppress(Exception):
                await _respond(
                    writer,
                    "500 Internal Server Error",
                    body,
                    "text/plain; charset=utf-8",
                )
        finally:
            if not handed_off:
                writer.close()
                with contextlib.suppress(Exception):
                    await writer.wait_closed()

    return handler


# ── File watcher ──────────────────────────────────────────────────────────────


class _WatchFilter(DefaultFilter):
    """The default ignores, plus ``.inkflow/`` (what inkflow and its plugins
    write for themselves) and ``build/`` (where ``inkflow build`` writes),
    both matched below the watched folder only: a deck that itself lives
    somewhere under a ``.inkflow/`` (a worktree kept there) is watched like
    any other."""

    ignore_dirs: Sequence[str] = (*DefaultFilter.ignore_dirs, ".inkflow", "build")

    def __init__(self, root: Path) -> None:
        super().__init__()
        self._root: str = str(root)

    @override
    def __call__(self, change: Change, path: str) -> bool:
        rel = os.path.relpath(path, self._root)
        if rel == os.curdir or rel.startswith(os.pardir):
            return super().__call__(change, path)
        return super().__call__(change, rel)


async def _watch(
    deck_path: Path, ui: LiveUI, lock: asyncio.Lock, levels: Levels
) -> None:
    root = deck_path.parent
    async for changes in awatch(str(root), watch_filter=_WatchFilter(root)):
        logger.debug(f"change detected in {len(changes)} file(s), rebuilding")
        async with lock:
            await rebuild(deck_path, ui, levels)


# ── Keyboard handler ──────────────────────────────────────────────────────────


def open_browser(url: str) -> None:
    """Open ``url`` in the browser without its startup noise reaching the
    terminal."""
    _open_browser(url)


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
    deck_path: Path | None,
    base: str,
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
                _open_browser(
                    f"{base}:{http_port}{_share.access.owner_path(owner_page())}"
                )
            elif ch == "r" and deck_path is not None:
                # Asked for by hand: every slide again, whatever is kept.
                async with lock:
                    await rebuild(deck_path, ui, levels, full=True)
            elif ch == "t":
                ui.toggle_trace()
            elif ch in extra:
                try:
                    extra[ch]()
                except Exception:
                    logger.exception(f"key {ch!r} failed")


# ── Ports ─────────────────────────────────────────────────────────────────────


def _port_free(host: str, port: int) -> bool:
    """Whether ``port`` can be bound on every address ``host`` names, as the
    servers bind it (``localhost`` is 127.0.0.1 and ::1: a program on either
    takes the port)."""
    try:
        infos = socket.getaddrinfo(
            host or None, port, type=socket.SOCK_STREAM, flags=socket.AI_PASSIVE
        )
    except socket.gaierror:
        infos = []
    addresses = {(info[0], info[4]) for info in infos} or {
        (socket.AF_INET, (host, port))
    }
    for family, address in addresses:
        try:
            sock = socket.socket(family, socket.SOCK_STREAM)
        except OSError:
            continue  # (no IPv6 here: nothing can take the port there)
        with sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if family == socket.AF_INET6:
                sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            try:
                sock.bind(address)
            except OSError as exc:
                if exc.errno == errno.EADDRNOTAVAIL:
                    continue
                return False
    return True


def pick_port(host: str, port: int | None) -> int:
    """The port to serve on: as given, else the first free one from 7777 up,
    so a second server for another deck comes up next to the first."""
    if port is not None:
        return port
    for candidate in range(DEFAULT_PORT, DEFAULT_PORT + 200):
        if _port_free(host, candidate):
            return candidate
    return DEFAULT_PORT


# ── Sharing: where the server listens, what the terminal says ─────────────────


@dataclass(frozen=True)
class Sharing:
    """How a server is shared (``--share``)."""

    share: bool = False
    """Share links work from the start (and the server listens on the LAN,
    except in SSH mode)."""
    ssh: bool = False
    """SSH mode (``--ssh``): only the owner link makes the owner, links name
    ``localhost`` for each guest's tunnel, nothing listens on the network."""
    allow_hosts: tuple[str, ...] = ()
    """More names to answer to: a reverse proxy's, a tailnet name."""
    tls: tuple[Path, Path] | None = None
    """Certificate and key: HTTPS and WSS on the one port."""


def _local_host(host: str) -> str:
    """Where the server listens while not shared."""
    return host if is_loopback_name(split_host(host)[0]) else "localhost"


Hosts = str | list[str] | None
"""What ``asyncio.start_server`` listens on (None: every interface)."""


def _lan_host(host: str) -> Hosts:
    """Where it listens while shared: every interface (None), or the address
    asked for (a VPN's, say) and this machine's own name too, so the owner's
    pages and commands still reach it as the owner."""
    name = split_host(host)[0]
    if is_loopback_name(name) or name in ("", "0.0.0.0", "::"):
        return None
    return [host, "localhost"]


def _listen_hosts(host: str, *, shared: bool, ssh: bool) -> Hosts:
    """Where the server listens for ``--host``, shared or not. In SSH mode
    links are opened through tunnels to this machine, so sharing never moves
    the listener onto the network (only an explicit ``--host`` does)."""
    if ssh:
        shared = _shares(host)
    return _lan_host(host) if shared else _local_host(host)


def _shares(host: str) -> bool:
    """Whether a ``--host`` lets other machines in (so it shares)."""
    return not is_loopback_name(split_host(host)[0])


def editor_page() -> str | None:
    """Where an editor link leads, when an extension takes editors (one of its
    messages is for editors): its ``home``, else the presenter. None: nothing
    on this server edits, so it offers view links only."""
    for ext in _served.extensions:
        if "editor" in ext.messages.values():
            return ext.home or "/"
    return None


def owner_page() -> str:
    """The page the owner opens: the first extension's ``home`` (an editor's
    page), else the presenter."""
    return next((e.home for e in _served.extensions if e.home), "/")


def owner_lines(access: Access, port: int) -> list[str]:
    """In SSH mode, the owner link (the one thing the person who started the
    server opens, through their tunnel) and the tunnel to open it through."""
    if not access.ssh:
        return []
    server = next(iter(server_names()), "<this server>")
    user = login_user() or "<you>"
    return [
        f"{access.scheme}://localhost:{port}{access.owner_path(owner_page())}",
        f"open it through: ssh -L {port}:localhost:{port} {user}@{server}",
    ]


def _extension_lines() -> list[str]:
    lines: list[str] = []
    for ext in _served.extensions:
        try:
            lines += ext.share_lines()
        except Exception:
            logger.exception(f"{ext.name}: share lines failed")
    return lines


def share_lines(access: Access, port: int) -> list[str]:
    """What the terminal says about sharing: the links per address, the mDNS
    name, and how to reach the server through SSH instead; then what the
    extensions add. In SSH mode the links name ``localhost``, for each
    guest's own tunnel."""
    if not access.sharing:
        return _extension_lines()
    lines: list[str] = []
    links = access.links(_link_addresses(access), editor_page())
    for link in links:
        if "editor" in link:
            lines.append(f"edit  {link['editor']}")
        lines.append(f"view  {link['view']}")
    if access.ssh:
        lines.append(
            f"guests: ssh -N -L {port}:localhost:{port} <their login>@<this "
            + "server>, then their link"
        )
        return lines + _extension_lines()
    names = {n for n in access.names if n.endswith(".local")} | access.allow_hosts
    for name in sorted(names):
        lines.append(f"also  {access.scheme}://{name}:{port} (same ?k= links)")
    if not links:
        lines.append("no network address found: use --host <address>")
    lines.append(
        f"ssh   ssh -L {port}:localhost:{port} <you>@<this machine>, "
        + f"then http://localhost:{port}{owner_page()} (as the owner)"
    )
    return lines + _extension_lines()


# ── Extensions ────────────────────────────────────────────────────────────────


class _Context:
    """The ``ServerContext`` extensions act through (``inkflow.extensions``)."""

    @property
    def state(self) -> State:
        return _state

    @property
    def people(self) -> People:
        return _share.people

    @property
    def access(self) -> Access:
        return _share.access

    @property
    def deck_path(self) -> Path | None:
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

    async def send_owners(self, payload: dict[str, object]) -> None:
        await send_owners(payload)

    async def notify(
        self, conn: ServerConnection | None, message: str, style: str = "green"
    ) -> None:
        await notify(conn, message, style=cast("NotifyStyle", style))

    async def rebuild(self, *, full: bool = False) -> None:
        if _served.rebuild is not None:
            await _served.rebuild(full)

    def open_deck(self, deck_path: Path) -> None:
        _served.switch_to = deck_path
        if _served.switch is not None:
            _served.switch.set()

    def shutdown(self) -> None:
        if _served.shutdown is not None:
            _served.shutdown.set()

    def share_changed(self) -> None:
        _share_changed()

    async def serve_connection(self, conn: VirtualConnection, role: Role) -> None:
        handler = _share.ws_handler
        if handler is None:
            await conn.close(1013, "the server is starting")
            return
        client = _share.people.join(conn, role, None, "online")
        client.online = True
        await handler(cast("ServerConnection", cast("object", conn)))

    async def serve_request(
        self, path: str, range_: str | None, role: Role, writer: ResponseWriter
    ) -> None:
        route = _share.route
        head = f"GET {path} HTTP/1.1\r\nHost: online\r\n"
        if range_:
            head += f"Range: {range_}\r\n"
        raw = (head + "\r\n").encode("latin-1", "replace")
        request = parse_request(raw)
        if route is None or request is None:
            await _respond(writer, "503 Service Unavailable", b"", "text/plain")
            return
        await route(request, raw, role, None, writer)


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
    deck_path: Path | None,
    host: str,
    http_port: int,
    ws_port: int | None,
    levels: Levels,
    open_path: str | None = None,
    quit_when_idle: float | None = None,
    auto_ports: bool = False,
    sharing: Sharing | None = None,
    extensions: Sequence[ServerExtension] | None = None,
) -> None:
    """Serve ``deck_path`` (or no deck) until quit. ``open_path`` (``"/"``)
    opens a browser on that page once the first build is done. With
    ``quit_when_idle`` (seconds) it stops once no page has been connected for
    that long (a server started without a terminal to stop it from).

    One port carries everything: pages, pictures and the WebSocket
    (``/_inkflow/ws``). ``ws_port`` additionally opens the old separate
    WebSocket port (deprecated; for scripts that still use it).

    ``auto_ports``: the port came from ``pick_port``, not the user, so one
    taken in the meantime (another inkflow starting at the same moment) means
    picking the next free one.

    ``sharing``: share links (``--share``); a non-loopback ``host`` shares
    too, since other machines can reach it.

    ``extensions`` add to the server (``inkflow.extensions``); by default the
    installed plugins' (``extensions_for``). Without a deck (``None``) only
    an extension that ``serves_without_deck`` can answer the pages.

    When an extension opens another deck (``ServerContext.open_deck``), the
    server closes this one and starts again on the same port for that deck;
    open pages reconnect to it.
    """
    sharing = sharing or Sharing()
    _share.access = Access(
        http_port,
        allow_hosts={h.lower() for h in sharing.allow_hosts},
        tls=sharing.tls is not None,
        sharing=sharing.share or _shares(host),
        ssh=sharing.ssh,
    )
    if extensions is None:
        extensions = extensions_for(ServeConfig(deck_path, host, http_port))
    if deck_path is None and not any(e.serves_without_deck for e in extensions):
        report("Error", "no deck to serve", style="red")
        return
    _served.extensions = list(extensions)
    _served.address = _address(_local_host(host), http_port, ws_port, sharing.tls)
    started: list[ServerExtension] = []
    try:
        for ext in list(_served.extensions):
            try:
                await ext.start(context)
                started.append(ext)
            except Exception:
                logger.exception(f"{ext.name}: start failed")
        await _serve_decks(
            deck_path,
            host,
            http_port,
            ws_port,
            levels,
            open_path,
            quit_when_idle,
            auto_ports,
            sharing,
            started,
        )
    finally:
        _served.extensions = started
        await _each_extension("stop", lambda ext: ext.stop())
        _served.extensions = []


def _address(
    host: str, port: int, ws_port: int | None, tls: object | None
) -> dict[str, object]:
    return {
        "host": host,
        "port": port,
        "wsPath": WS_PATH,
        "wsPort": ws_port if ws_port is not None else port,
        "tls": tls is not None,
    }


async def _serve_decks(
    deck_path: Path | None,
    host: str,
    http_port: int,
    ws_port: int | None,
    levels: Levels,
    open_path: str | None,
    quit_when_idle: float | None,
    auto_ports: bool,
    sharing: Sharing,
    extensions: Sequence[ServerExtension],
) -> None:
    """``serve``'s loop: one deck after another, as extensions open them."""
    retries = 5 if auto_ports else 0
    while True:
        # Each deck is opened by every extension that started (one whose
        # ``open`` failed for the last deck gets this one all the same).
        _served.extensions = list(extensions)
        try:
            next_deck = await _serve_deck(
                deck_path,
                host,
                http_port,
                ws_port,
                levels,
                sharing,
                open_path,
                quit_when_idle,
            )
        except _PortBusy as busy:
            if retries <= 0:
                report("Error", busy.message, style="red")
                return
            retries -= 1
            http_port = pick_port(host, None)
            _share.access.port = http_port
            _served.address = _address(
                _local_host(host), http_port, ws_port, sharing.tls
            )
            continue
        if next_deck is None:
            return
        report("Opening", str(next_deck))
        # The new deck starts from nothing: no slides, position or error of
        # the last one reach its pages.
        deck_path, open_path = next_deck, None
        _state["slides"] = []
        _state["position"] = {"slideIndex": 0, "step": 0}
        _state["error"] = None
        _served.deck = None
        _served.built_hash = None
        _served.failed_hash = None


class _PortBusy(Exception):
    """A port was taken when the server bound it."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message: str = message


async def _quit_when_idle(shutdown: asyncio.Event, delay: float) -> None:
    """Stop once no page has been connected for ``delay`` seconds.

    The delay covers a reload, and the moment a deck switch restarts the
    server, so only closing the last tab (or never opening one) stops it.
    """
    idle = 0.0
    while True:
        await asyncio.sleep(1)
        idle = 0.0 if _state["ws_clients"] else idle + 1
        if idle >= delay:
            report("Stopping", f"no page open for {delay:g} seconds")
            shutdown.set()
            return


@contextlib.asynccontextmanager
async def listening(
    ui: LiveUI,
    deck_path: Path | None = None,
    extensions: Sequence[ServerExtension] = (),
    host: str = "127.0.0.1",
    port: int = 0,
    edit_commands: EditCommands = NO_EDIT_COMMANDS,
) -> AsyncGenerator[int]:
    """The one port as ``serve`` opens it (pages, files, the WebSocket at
    ``/_inkflow/ws``, behind the door), without the terminal UI, watcher or
    keyboard, serving ``deck_path`` (or no deck) with ``extensions`` (started
    and opened; nothing built yet): for tests and for embedding. Yields the
    port it listens on."""
    project_dir = deck_path.parent if deck_path is not None else None
    handler = make_ws_handler(ui, edit_commands)
    bridge = Bridge(handler, forget=_share.people.leave)
    handlers: list[_StreamHandler] = []

    async def http(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await handlers[0](reader, writer)

    listener = await asyncio.start_server(http, host, port)
    actual = cast("tuple[str, int]", listener.sockets[0].getsockname())[1]
    handlers.append(make_http_handler(actual, project_dir, edit_commands, bridge))
    _share.ws_handler = handler
    _share.route = make_http_route(actual, project_dir, edit_commands)
    _served.extensions = list(extensions)
    _served.deck_path = deck_path
    _served.edit_commands = edit_commands
    _served.address = _address("127.0.0.1", actual, None, None)
    lock = asyncio.Lock()

    async def again(full: bool) -> None:
        if deck_path is not None:
            async with lock:
                await rebuild(deck_path, ui, resolve_levels(), full=full)

    _served.rebuild = again
    try:
        for ext in _served.extensions:
            await ext.start(context)
            await ext.open(deck_path)
        yield actual
    finally:
        listener.close()
        await bridge.shutdown()
        await _each_extension("close", lambda ext: ext.close(switching=False))
        await _each_extension("stop", lambda ext: ext.stop())
        _share.ws_handler = None
        _share.route = None
        _served.extensions = []
        _served.deck_path = None
        _served.rebuild = None
        _served.deck = None
        _served.built_hash = None
        _served.failed_hash = None
        _served.kept = None


class Listener:
    """The HTTP port's listening socket, which sharing moves between this
    machine only and the network without dropping a connection: closing a
    listening socket leaves the connections it accepted open."""

    def __init__(
        self, handler: _StreamHandler, port: int, tls: ssl.SSLContext | None
    ) -> None:
        self._handler: _StreamHandler = handler
        self._port: int = port
        self._tls: ssl.SSLContext | None = tls
        self.server: asyncio.Server | None = None
        self.host: Hosts = None

    async def open(self, host: Hosts) -> None:
        self.server = await asyncio.start_server(
            self._handler, host, self._port, ssl=self._tls
        )
        self.host = host

    async def move(self, host: Hosts) -> None:
        """Listen on ``host`` instead (None: every interface)."""
        if self.server is not None and host == self.host:
            return
        previous = self.host
        self.close()
        try:
            await self.open(host)
        except OSError:
            await self.open(previous)
            raise

    def close(self) -> None:
        if self.server is not None:
            self.server.close()
            self.server = None


def _ws_check(port: int) -> Callable[[ServerConnection, WsRequest], WsResponse | None]:
    """The door of the old separate WebSocket port: the same checks as the
    one port's (host, origin of the HTTP port's pages, who)."""

    def check(connection: ServerConnection, request: WsRequest) -> WsResponse | None:
        headers = request.headers
        parsed = parse_request(
            f"GET {request.path} HTTP/1.1\r\n".encode()
            + b"".join(
                f"{k}: {v}\r\n".encode("latin-1", "replace")
                for k, v in headers.raw_items()
            )
        )
        access = _share.access
        if parsed is None or not access.host_ok(parsed.host):
            return connection.respond(403, "Unknown host name\n")
        if not access.origin_ok(parsed.headers.get("origin"), parsed.host, port=port):
            return connection.respond(403, "Forbidden\n")
        peer = peer_host(cast("object", connection.remote_address))
        role, token = access.admit(peer, parsed)
        if role is None:
            return connection.respond(401, "Not shared\n")
        _ = _share.people.join(connection, role, token, peer)
        return None

    return check


def _tls_context(tls: tuple[Path, Path] | None) -> ssl.SSLContext | None:
    if tls is None:
        return None
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.load_cert_chain(str(tls[0]), str(tls[1]))
    return context


async def _serve_deck(
    deck_path: Path | None,
    host: str,
    http_port: int,
    ws_port: int | None,
    levels: Levels,
    sharing: Sharing,
    open_path: str | None = None,
    quit_when_idle: float | None = None,
) -> Path | None:
    """Serve one deck until quit (None) or until an extension opens another
    (its deck.py, returned). Without a deck only the extensions' pages are
    served: nothing is built or watched, and no files are served."""
    console = Console()
    rebuild_lock = asyncio.Lock()
    shutdown = asyncio.Event()
    switch = asyncio.Event()
    _served.switch = switch
    _served.switch_to = None
    _served.shutdown = shutdown
    _served.deck_path = deck_path
    access = _share.access
    scheme = access.scheme
    tls = sharing.tls
    local_host = _local_host(host)
    # Where this machine's own pages and commands reach it (as the owner).
    browse_host = local_host

    loop = asyncio.get_running_loop()
    uninstall_shutdown_handler = install_shutdown_handler(loop, shutdown)
    bridge: Bridge | None = None
    listener: Listener | None = None
    opened: list[ServerExtension] = []
    registered = False

    try:
        edit_commands = resolve_edit_commands()
        _served.edit_commands = edit_commands
        project_dir = deck_path.parent if deck_path is not None else None
        if deck_path is None:
            _state["title"] = "Inkflow"
        ui_ref: list[LiveUI] = []

        async def ws_entry(connection: ServerConnection) -> None:
            await make_ws_handler(ui_ref[0], edit_commands)(connection)

        bridge = Bridge(ws_entry, forget=_share.people.leave)
        http_handler = make_http_handler(http_port, project_dir, edit_commands, bridge)
        _share.ws_handler = ws_entry
        _share.route = make_http_route(http_port, project_dir, edit_commands)
        listener = Listener(http_handler, http_port, _tls_context(tls))

        def listen_on(shared: bool) -> Hosts:
            return _listen_hosts(host, shared=shared, ssh=access.ssh)

        # Bind before the Live UI so port conflicts fail fast with a clean message
        try:
            await listener.open(listen_on(access.sharing))
        except OSError as e:
            if e.errno == errno.EADDRINUSE:
                raise _PortBusy(
                    f"port {http_port} in use — pass --port to use another"
                ) from e
            raise

        async def rebind(shared: bool) -> None:
            assert listener is not None
            await listener.move(listen_on(shared))
            ui_ref[0].set_share(share_lines(access, http_port))

        _share.rebind = rebind
        for ext in list(_served.extensions):
            try:
                await ext.open(deck_path)
                opened.append(ext)
            except Exception:
                logger.exception(f"{ext.name}: open failed")
        _served.extensions = list(opened)
        # Other inkflow processes find this server (and its deck) here; in
        # SSH mode with the owner token, which only this user can read.
        instances.register(
            instances.Instance(
                pid=os.getpid(),
                host=browse_host,
                port=http_port,
                ws_port=ws_port if ws_port is not None else http_port,
                deck=str(deck_path.resolve()) if deck_path is not None else None,
                tls=tls is not None,
                owner_token=access.owner_token if access.ssh else None,
                home=owner_page(),
            )
        )
        registered = True
        owner = owner_lines(access, http_port)
        if owner:
            console.print(
                "[bold]SSH mode[/bold]  being on this machine is not enough: "
                + "open the owner link, through your SSH tunnel",
                highlight=False,
            )
            console.print(
                f"[bold]Owner[/bold]  {owner[0]}", highlight=False, soft_wrap=True
            )
            console.print(f"       {owner[1]}", highlight=False)
        for line in share_lines(access, http_port):
            console.print(f"[bold]Sharing[/bold]  {line}", highlight=False)

        with Live(Text(""), console=console, auto_refresh=False) as live:
            ui = LiveUI(
                live,
                browse_host,
                http_port,
                project_dir or Path.home(),
                get_clients=lambda: len(_state["ws_clients"]),
                scheme=scheme,
            )
            ui.set_owner(owner)
            ui.set_share(share_lines(access, http_port))
            ui.set_keys(
                [
                    (key, label)
                    for ext in _served.extensions
                    for key, (label, _) in ext.keys().items()
                ]
            )
            ui_ref.append(ui)
            _share.on_change = lambda: ui.set_share(share_lines(access, http_port))

            async def again(full: bool) -> None:
                if deck_path is not None:
                    async with rebuild_lock:
                        await rebuild(deck_path, ui, levels, full=full)

            _served.rebuild = again
            try:
                async with contextlib.AsyncExitStack() as stack:
                    if ws_port is not None:
                        _ = await stack.enter_async_context(
                            ws_serve(
                                make_ws_handler(ui, edit_commands),
                                local_host,
                                ws_port,
                                process_request=_ws_check(http_port),
                                ssl=_tls_context(tls),
                            )
                        )
                    if deck_path is not None:
                        await rebuild(deck_path, ui, levels)
                    if open_path is not None:
                        _open_browser(
                            f"{scheme}://{browse_host}:{http_port}"
                            + access.owner_path(open_path)
                        )
                    tasks: list[asyncio.Task[None]] = []
                    if deck_path is not None:
                        tasks.append(
                            asyncio.create_task(
                                _watch(deck_path, ui, rebuild_lock, levels)
                            )
                        )
                    if quit_when_idle is not None:
                        tasks.append(
                            asyncio.create_task(
                                _quit_when_idle(shutdown, quit_when_idle)
                            )
                        )
                    tasks.append(
                        asyncio.create_task(
                            _read_keys(
                                deck_path,
                                f"{scheme}://{browse_host}",
                                http_port,
                                ui,
                                rebuild_lock,
                                shutdown,
                                levels,
                            )
                        )
                    )
                    waits = [
                        asyncio.create_task(shutdown.wait()),
                        asyncio.create_task(switch.wait()),
                    ]
                    _ = await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
                    for t in [*tasks, *waits]:
                        _ = t.cancel()
                    _ = await asyncio.gather(*tasks, return_exceptions=True)
                    listener.close()
                    await bridge.shutdown()
            except OSError as e:
                if e.errno == errno.EADDRINUSE:
                    raise _PortBusy(
                        f"port {ws_port} in use — pass --ws-port to use another"
                    ) from e
                raise
    finally:
        uninstall_shutdown_handler()
        if listener is not None:
            listener.close()
        if bridge is not None:
            await bridge.shutdown()
        _share.rebind = None
        _share.on_change = None
        _share.ws_handler = None
        _share.route = None
        _served.rebuild = None
        # Another deck follows (``open_deck``), unless the server stops.
        switching = switch.is_set() and not shutdown.is_set()
        for ext in opened:
            try:
                await ext.close(switching=switching)
            except Exception:
                logger.exception(f"{ext.name}: close failed")
        _served.switch = None
        _served.shutdown = None
        if registered:
            instances.unregister(os.getpid())
    if switch.is_set() and not shutdown.is_set():
        return _served.switch_to
    return None
