"""The editor as a server extension: everything ``/edit`` needs from the
server the core runs (``inkflow.extensions``).

Per served deck it keeps one ``EditorSession`` (undo History, file writes),
the compare views (``comparehub``), the slides' problem marks (``problems``)
and the editor's model of each build (``model.build_model``). It answers:

- the pages ``/edit`` (and, while no deck is open, the start page at any
  path), ``/_export/<token>/…`` (what the Export dialog made) and
  ``/_cmp/<token>/…`` (a compared deck's pictures); never to a view link;
- the editor's messages: ``edit-op`` (a session request: any action, from a
  page or an agent's command), ``compare-*``, ``problems-check``, and from
  the owner ``editor-context`` (what is selected, for agents) and
  ``editor-command`` (an agent's ``goto``/``select``, to every editor);
- after each build, ``editor-model`` to every editor page (as a patch to
  pages that take one), the problem marks, the compare views' live side.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import zipfile
from collections.abc import Callable, Mapping
from html import escape as escape_html
from importlib import resources
from pathlib import Path
from typing import TYPE_CHECKING, cast

from typing_extensions import override

from inkflow.access import Role
from inkflow.enums import ColorMode
from inkflow.extensions import (
    Build,
    HttpRequest,
    Key,
    ServeConfig,
    ServerContext,
    ServerExtension,
)
from inkflow.incremental import as_patch, keys_of, set_keys
from inkflow.logging import logger
from inkflow.manifest import Deck
from inkflow.pipeline import SlideData
from inkflow.server import favicon_data_uri, open_browser, served_ui_fonts
from inkflow_editor import projects
from inkflow_editor.comparehub import CompareHub, side_build_from
from inkflow_editor.comparesrc import CompareError
from inkflow_editor.context import write_context
from inkflow_editor.model import ModelCache, build_model, starred_ids
from inkflow_editor.problems import Problems
from inkflow_editor.session import EditError, EditorSession, Exporters

if TYPE_CHECKING:
    from websockets.asyncio.server import ServerConnection

    from inkflow.collab import Client


def default_exporters() -> Exporters:
    """The Export dialog's builds: the same as ``inkflow build``/``export``,
    and ``render``'s layout check for the problem marks."""
    from inkflow.export import build_handout_pdf, build_pdf, build_static_html
    from inkflow.render import check_built

    return Exporters(
        html=build_static_html,
        pdf=build_pdf,
        layout=check_built,
        handout=build_handout_pdf,
    )


def is_editor_path(request_path: str) -> bool:
    path = request_path.split("?", 1)[0].split("#", 1)[0]
    return path == "/edit" or path.startswith("/edit/")


_VIEW_ONLY = (
    "This link shows the presentation only. Ask the person sharing the deck "
    + "for an editor link to change it."
)


def read_export(path: Path) -> tuple[str, str, bytes]:
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


class EditorExtension(ServerExtension):
    """The visual editor on a deck's server."""

    name: str = "inkflow-editor"
    provenance: bool = True
    serves_without_deck: bool = True
    messages: Mapping[str, Role] = {
        "edit-op": "editor",
        "compare-open": "editor",
        "compare-close": "editor",
        "compare-sources": "editor",
        "problems-check": "editor",
        # Opening a program, the agents' context file and commands.
        "editor-context": "owner",
        "editor-command": "owner",
    }

    def __init__(
        self,
        config: ServeConfig | None = None,
        *,
        exporters: Exporters | None = None,
        session: EditorSession | None = None,
    ) -> None:
        del config
        self.exporters: Exporters | None = exporters or default_exporters()
        self._given: EditorSession | None = session
        """A session made by the caller (tests), used for its own deck."""
        self.server: ServerContext | None = None
        self.session: EditorSession | None = None
        self.compare: CompareHub | None = None
        self.problems: Problems | None = None
        self.clients: set[ServerConnection] = set()
        """Connections that identified as an editor page."""
        self.deck: Deck | None = None
        """The last deck that built, which editor requests are validated against."""
        self.model: dict[str, object] | None = None
        """The editor's model for the last build (see ``model``)."""
        self.model_patch: dict[str, object] | None = None
        """The model as sent to a page that holds the build before it: the
        slides' entries that build already had are named by key."""
        self.models: ModelCache = ModelCache()
        self.edit_slides: list[SlideData] | None = None
        """The last build's slides (what the layout check measures)."""
        self.deck_hash: str | None = None
        self._build_id: int = 0
        self._pending: tuple[dict[str, object], dict[str, object]] | None = None
        self._problems_lock: asyncio.Lock = asyncio.Lock()
        self._background: set[asyncio.Task[None]] = set()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    @override
    async def start(self, server: ServerContext) -> None:
        self.server = server

    @override
    async def open(self, deck_path: Path | None) -> None:
        server = self._ctx
        given = self._given
        if given is not None and (
            (deck_path is None and not given.has_deck)
            or (deck_path is not None and given.deck_path == deck_path.resolve())
        ):
            session = given
            if session.exporters is None:
                session.exporters = self.exporters
        else:
            session = EditorSession(deck_path, self.exporters)
        session.edit_commands = server.edit_commands
        session.server = server.address
        self.session = session
        self.compare = CompareHub(deck_path, _load_deck) if deck_path else None
        self.problems = Problems() if deck_path else None
        self.edit_slides = None
        self.deck = None
        self.model = None
        self.model_patch = None
        self.models = ModelCache()
        if deck_path is not None:
            projects.remember(deck_path)

    @override
    async def close(self, *, switching: bool) -> None:
        del switching
        if self.compare is not None:
            self.compare.close_all()
            self.compare = None
        self.clients.clear()

    # ── Builds ────────────────────────────────────────────────────────────────

    @override
    def before_build(self) -> None:
        # The files as this build reads them: a page's write to one that
        # changed since its build is refused (several people editing).
        session = self.session
        self._build_id = session.snapshot() if session is not None else 0

    @override
    def build(self, build: Build) -> None:
        if build.fresh:
            self.models = ModelCache()
        model = build_model(
            build.deck, build.deck_path, build.slides, cache=self.models
        )
        model["build"] = self._build_id
        set_keys(cast("list[dict[str, object]]", model["slides"]))
        old = self.model
        held = keys_of(cast("list[dict[str, object]]", old["slides"]) if old else [])
        patch = {
            **model,
            "slides": as_patch(cast("list[dict[str, object]]", model["slides"]), held),
        }
        self._pending = (model, patch)

    @override
    async def built(self, build: Build) -> None:
        if self._pending is None:
            return
        self.model, self.model_patch = self._pending
        self._pending = None
        self.deck = build.deck
        if self.session is not None:
            self.session.built_hash = build.deck_hash
            self.session.live = (build.slides, self.model)
        await self.send_editors(self._model_message)
        self.edit_slides = build.slides
        self.deck_hash = build.deck_hash
        self.check_problems()
        if self.compare is not None:
            await self.compare.live_built(
                await asyncio.to_thread(
                    side_build_from,
                    build.deck,
                    build.deck_path,
                    build.slides,
                    self.model,
                )
            )

    @override
    async def build_failed(self, deck_hash: str | None, error: str) -> None:
        self._pending = None

    # ── Pages ─────────────────────────────────────────────────────────────────

    @override
    def welcome(self, client: Client) -> dict[str, object]:
        # The presenter's "back to the editor" button goes here.
        return {} if client.role == "viewer" else {"editor": "/edit"}

    @override
    async def hello(
        self,
        conn: ServerConnection,
        client: Client,
        msg: dict[str, object],
        *,
        resync: bool,
    ) -> None:
        if not resync and msg.get("role") == "editor":
            self.clients.add(conn)
        if conn not in self.clients:
            return
        if self.model is not None:
            await conn.send(json.dumps(self._model_message(client, whole=True)))
        if resync:
            return
        if (problems_msg := self._problems_message()) is not None:
            await conn.send(json.dumps(problems_msg))
        await conn.send(
            json.dumps({"type": "presence", "people": self._ctx.people.listing()})
        )

    @override
    async def message(
        self, conn: ServerConnection, client: Client, msg: dict[str, object]
    ) -> None:
        kind = msg.get("type")
        session = self.session
        if kind == "edit-op":
            if session is not None:
                await self.edit_op(conn, client, msg, session)
        elif kind in ("compare-open", "compare-close", "compare-sources"):
            await self._compare(conn, client, msg)
        elif kind == "problems-check":
            # The Problems list's layout check (and its contrast setting),
            # for everyone editing this deck.
            if self.problems is not None:
                self.problems.layout_on = msg.get("on") is not False
                self.problems.contrast = msg.get("contrast") is True
                self.check_problems()
        elif kind == "editor-context" and session is not None:
            raw_context: object = msg.get("context")
            context: object = raw_context
            if isinstance(raw_context, dict):
                # Which server this editor talks to: `inkflow goto` and
                # `select` find it here when several are running.
                context = {
                    **cast("dict[str, object]", raw_context),
                    "server": session.server,
                }
            await asyncio.to_thread(write_context, session.project_dir, context)
        elif kind == "editor-command":
            # From `inkflow goto/select`: steer every open editor.
            await self.send_editors(msg)

    @override
    async def disconnected(self, conn: ServerConnection, client: Client) -> None:
        del client
        self.clients.discard(conn)
        if self.compare is not None:
            self.compare.close(conn)

    @override
    async def http(self, request: HttpRequest) -> bool:
        path, target = request.path, request.target
        session = self.session
        starting = session is not None and not session.has_deck
        mine = is_editor_path(target) or path.startswith(("/_export/", "/_cmp/"))
        if not mine and not starting:
            return False
        if request.role == "viewer":
            if starting:
                return False  # the core says nothing is shared yet
            await request.refuse("403 Forbidden", "View-only link", _VIEW_ONLY)
            return True
        if path.startswith("/_export/"):
            exported = self.export_file(path)
            if exported is None:
                await request.respond("404 Not Found", b"", "text/plain", b"")
                return True
            name, mime, body = await asyncio.to_thread(read_export, exported)
            await request.respond(
                "200 OK",
                body,
                mime,
                f'Content-Disposition: attachment; filename="{name}"\r\n'.encode(),
            )
            return True
        if path.startswith("/_cmp/"):
            # A compared deck's picture, inside that deck's own roots.
            compared = self.compare.asset(target) if self.compare is not None else None
            if compared is None:
                await request.respond(
                    "404 Not Found", b"", "text/html; charset=utf-8", b""
                )
            else:
                await request.send_file(compared)
            return True
        if starting and request.role != "owner":
            return False
        body = self.editor_html()
        await request.respond("200 OK", body, "text/html; charset=utf-8", b"")
        return True

    @override
    def keys(self) -> Mapping[str, Key]:
        return {"e": ("edit", self._open_editor)}

    def _open_editor(self) -> None:
        server = self._ctx
        address = server.address
        scheme = "https" if address.get("tls") else "http"
        path = server.access.owner_path("/edit")
        open_browser(f"{scheme}://{address['host']}:{address['port']}{path}")

    def editor_html(self) -> bytes:
        """The visual editor page: its own shell and bundle, the deck's styles."""
        state = self._ctx.state
        pkg = resources.files("inkflow_editor")
        template = pkg.joinpath("editor.html").read_text(encoding="utf-8")
        css = pkg.joinpath("bundles", "editor.css").read_text(encoding="utf-8")
        css = served_ui_fonts() + "\n" + css
        js = pkg.joinpath("bundles", "editor.js").read_text(encoding="utf-8")
        data_theme = "" if state["mode"] == ColorMode.DARK else "light"
        html = (
            template.replace("/* __CSS__ */", css)
            .replace("/* __JS__ */", js)
            .replace("/* __STYLES__ */", state["styles_css"])
            .replace("__DATA_THEME__", data_theme)
            .replace("__SLIDES_JSON__", json.dumps(state["slides"]))
            .replace("__MODEL_JSON__", json.dumps(self.model))
            .replace("__WS_PORT__", str(self._ctx.address.get("port")))
            .replace("__ERROR_JSON__", json.dumps(state["error"]))
            .replace("__FAVICON__", favicon_data_uri())
            .replace("__TITLE__", escape_html(f"Edit · {state['title']}"))
        )
        return html.encode("utf-8")

    def export_file(self, path: str) -> Path | None:
        """``/_export/<token>/<name>``: a file the editor exported in this
        session. Only paths the session recorded under a random token are
        served, so this cannot reach any other file."""
        parts = path.split("/")
        session = self.session
        if len(parts) < 3 or session is None:
            return None
        found = session.exports.get(parts[2])
        return found if found is not None and found.exists() else None

    # ── Messages to the editor pages ──────────────────────────────────────────

    @property
    def _ctx(self) -> ServerContext:
        if self.server is None:
            raise RuntimeError("the editor extension has not started")
        return self.server

    async def send_editors(
        self,
        payload: dict[str, object] | Callable[[Client | None], dict[str, object]],
    ) -> None:
        """To every editor page: one message, or one per person (a callable
        given each one's client, for what differs: their undo history)."""
        people = self._ctx.people
        for ws in list(self.clients):
            msg = payload(people.get(ws)) if callable(payload) else payload
            try:
                await ws.send(json.dumps(msg))
            except Exception:
                self.clients.discard(ws)

    def history_state(self, client: Client | None) -> dict[str, object]:
        """Undo/Redo for one person: their own steps (see ``History``)."""
        session = self.session
        if session is None:
            return {"canUndo": False, "canRedo": False}
        return session.history_state(client.author if client else "owner")

    def _model_message(
        self, client: Client | None = None, *, whole: bool = False
    ) -> dict[str, object]:
        """The editor's model for one person's page: as what changed since
        the last build when the page takes patches, unless ``whole`` (a page
        just connected, or one that asked again)."""
        takes = client is not None and client.patches
        patch = self.model_patch
        return {
            "type": "editor-model",
            "model": patch if takes and patch is not None and not whole else self.model,
            "history": self.history_state(client),
        }

    def stars(self) -> list[str]:
        """The starred slides as the model lists them, read anew (a star
        changes no build), and put into the model a page gets on hello."""
        session, model = self.session, self.model
        if session is None or model is None:
            return []
        entries = cast("list[dict[str, object]]", model["slides"])
        starred = starred_ids(session.project_dir, entries)
        for held in (model, self.model_patch):
            if held is not None:
                held["stars"] = starred
        return starred

    # ── Problems ──────────────────────────────────────────────────────────────

    def check_problems(self) -> None:
        """Check the slides' problems again in the background (after a build,
        or when an editor asks for the layout check)."""
        task = asyncio.get_running_loop().create_task(self._refresh_problems())
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    def _problems_message(self) -> dict[str, object] | None:
        problems, model, slides = self.problems, self.model, self.edit_slides
        if problems is None or model is None or slides is None:
            return None
        return problems.json(model, slides)

    async def _refresh_problems(self) -> None:
        """verify's checks for the slides whose entry changed, then (when on)
        the layout check for the slides whose SVG changed; editors are told
        after each. One at a time, each on the latest build."""
        async with self._problems_lock:
            problems, deck, model = self.problems, self.deck, self.model
            slides, session = self.edit_slides, self.session
            if (
                problems is None
                or deck is None
                or model is None
                or slides is None
                or session is None
            ):
                return
            try:
                await asyncio.to_thread(
                    problems.verify,
                    deck,
                    session.project_dir,
                    model,
                    self.deck_hash or "",
                )
            except Exception:
                logger.exception("checking the slides failed")
                return
            if (msg := self._problems_message()) is not None:
                await self.send_editors(msg)
            if not problems.layout_on:
                return
            problems.running = True
            if (msg := self._problems_message()) is not None:
                await self.send_editors(msg)
            check = session.exporters.layout if session.exporters else None
            try:
                if check is None:
                    problems.error = "the layout check is not available here"
                else:
                    await asyncio.to_thread(
                        problems.measure, deck, session.project_dir, slides, check
                    )
            finally:
                problems.running = False
            if (msg := self._problems_message()) is not None:
                await self.send_editors(msg)

    # ── Edits ─────────────────────────────────────────────────────────────────

    async def edit_op(
        self,
        websocket: ServerConnection,
        client: Client,
        msg: dict[str, object],
        session: EditorSession,
    ) -> None:
        """Apply one editor request and answer the sender with its result."""
        request_id = msg.get("id")
        # Who asks is decided here, from the connection, never by the page:
        # keys starting with "_" are the server's (whether a program may open
        # on this machine's screen, whose undo history the step joins).
        for key in [k for k in msg if k.startswith("_")]:
            del msg[key]
        role: Role = client.role
        msg["_local"] = role == "owner"
        msg["_role"] = role
        msg["_author"] = client.author
        msg["_name"] = client.name
        hub = self.compare
        try:
            if role not in ("owner", "editor"):
                raise EditError("this link is view-only")
            if msg.get("action") == "compare-take":
                if hub is None:
                    raise EditError("no comparison is open")
                try:
                    msg["_take"] = await asyncio.to_thread(
                        hub.take_request, websocket, msg
                    )
                except CompareError as exc:
                    raise EditError(str(exc)) from exc
            result = await asyncio.to_thread(session.apply, msg, self.deck)
        except EditError as exc:
            result = {"ok": False, "error": str(exc), **exc.extra}
        except Exception as exc:
            logger.exception("editor request failed")
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        await websocket.send(
            json.dumps({"type": "edit-result", "id": request_id, **result})
        )
        if result.get("ok") and msg.get("action") == "star":
            # No file of the deck changed and nothing rebuilds: every editor
            # page is told which slides are starred now.
            await self.send_editors({"type": "stars", "stars": self.stars()})
        if result.get("ok") and msg.get("action") == "comment":
            # Likewise every editor page is told the review comments now.
            threads = result.get("comments")
            for held in (self.model, self.model_patch):
                if held is not None:
                    held["comments"] = threads
            await self.send_editors({"type": "comments", "comments": threads})
        if result.get("ok") and (
            result.get("changes") or msg.get("action") in ("undo", "redo")
        ):
            # Everyone's Undo/Redo may have changed (a step of theirs is now
            # blocked, or free again); an agent's edit (``inkflow slide``) also
            # says so, with an undo of that very step for the owner's pages.
            agent = bool(msg.get("agent")) and bool(result.get("changes"))
            author = msg["_author"]

            def per_person(c: Client | None) -> dict[str, object]:
                return {
                    "type": "agent-edit" if agent else "history",
                    "label": result.get("label"),
                    "step": result.get("step"),
                    "mine": (c.author if c is not None else "owner") == author,
                    **self.history_state(c),
                }

            await self.send_editors(per_person)
        if session.switch_to is not None:
            self._ctx.open_deck(session.switch_to)
        if session.quit_requested:
            self._ctx.shutdown()

    async def _compare(
        self, websocket: ServerConnection, client: Client, msg: dict[str, object]
    ) -> None:
        """The compare view's messages (see comparehub.py)."""
        hub = self.compare
        kind = msg.get("type")
        if kind == "compare-close":
            if hub is not None:
                hub.close(websocket)
            return
        try:
            if hub is None:
                raise CompareError("open a deck first")
            if kind == "compare-sources":
                reply = await asyncio.to_thread(hub.sources)
            else:
                reply = await hub.open(websocket, msg, local=client.role == "owner")
        except Exception as exc:
            if not isinstance(exc, CompareError):
                logger.exception("compare failed")
            reply = {
                "type": "compare-error",
                "view": msg.get("view"),
                "for": kind,
                "message": str(exc) or type(exc).__name__,
            }
        with contextlib.suppress(Exception):
            await websocket.send(json.dumps(reply))


def _load_deck(deck_path: Path, module: str = "_inkflow_deck") -> Deck:
    from inkflow.server import load_deck

    return load_deck(deck_path, module)
