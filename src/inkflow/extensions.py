"""Server extensions: how a frontend plugs into the server inkflow runs.

``inkflow serve`` is the core's server: it builds the deck on every change,
serves the presenter and the deck's files, and relays positions between
windows over a WebSocket. An extension adds to that without the core knowing
what it is: a visual editor, a review tool, a remote control.

An extension is a ``ServerExtension`` subclass, handed to ``serve`` by the
command that starts the server (or by a plugin, see ``inkflow.plugins``).
Every hook has a do-nothing default. In the order they happen:

- ``start(server)`` once, with the ``ServerContext`` it keeps: what the
  server knows and the things it can do (send, broadcast, rebuild, stop);
- ``open(deck_path)`` for the deck served;
- per build: ``before_build`` and ``build`` run in a worker thread, inside
  the build (an exception there fails the build: the error overlay);
  ``built`` runs after the pages got the new slides, ``build_failed`` when a
  build failed. ``provenance = True`` asks for the editor build: every element
  stamped with its source locator (``inkflow.provenance``, inert attributes
  every page gets) and each slide's ``edit`` facts (``SlideData.edit``,
  which stay with the extensions: the pages' copies drop them);
- per page: ``welcome`` adds fields to the first message a page gets;
  ``hello`` when a page said what it is (``{"type": "hello", "role": ...}``);
  ``message`` for each message type the extension lists in ``messages``
  (with the least role that may send it: anything else from a lesser role is
  dropped); ``disconnected`` when it goes;
- ``http(request)`` for every request the core does not answer itself (the
  deck's assets come first, the presenter last);
- ``keys()``: keys in the server's terminal;
- ``close()`` when the deck stops being served, ``stop()`` when the server
  stops.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Protocol, TypedDict

if TYPE_CHECKING:
    from websockets.asyncio.server import ServerConnection

    from inkflow.collab import Client, People, Role
    from inkflow.edit import EditCommands
    from inkflow.enums import ColorMode
    from inkflow.manifest import Deck
    from inkflow.pipeline import SlideData


class ResponseWriter(Protocol):
    """Where a response is written (a socket's ``asyncio.StreamWriter``)."""

    def write(self, data: bytes) -> None: ...

    async def drain(self) -> None: ...


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


@dataclass(frozen=True)
class ServeConfig:
    """How a server is about to run, for plugins making its extensions."""

    deck_path: Path
    host: str
    port: int
    options: Mapping[str, object] = field(default_factory=dict[str, object])
    """Values of the options plugins added to ``inkflow serve``
    (``Plugin.serve_options``), by parameter name."""


@dataclass
class Build:
    """One build of the served deck, as the extensions see it."""

    deck: Deck
    deck_path: Path
    deck_hash: str
    """deck.py's content hash (``file_hash``): which version of it this build
    ran, so a program that edited it can wait for its own edit's build."""
    slides: list[SlideData]
    """The slides as built: with source locators and ``edit`` facts when an
    extension asked for ``provenance``."""
    served: list[SlideData] = field(default_factory=list)
    """The pages' copies (set once the build is done): no ``edit`` facts."""
    fresh: bool = True
    """Nothing was kept from earlier builds: an extension's own caches should
    start over too."""

    @property
    def project_dir(self) -> Path:
        return self.deck_path.parent


@dataclass
class HttpRequest:
    """A request the core did not answer itself, with who asks."""

    method: str
    target: str
    """The path with its query, as requested."""
    raw: bytes
    """The request head as read (headers included)."""
    role: Role
    writer: ResponseWriter
    respond: Callable[[str, bytes, str, bytes], Awaitable[None]]
    """``respond(status, body, content_type, extra_headers)``."""
    send_file: Callable[[Path], Awaitable[None]]
    """Send a file (its type from ``inkflow.assets.MIME_TYPES``)."""
    refuse: Callable[[str, str, str], Awaitable[None]]
    """``refuse(status, title, text)``: a small HTML page saying why."""

    @property
    def path(self) -> str:
        """The path without its query."""
        return self.target.split("?", 1)[0]


class ServerContext(Protocol):
    """What an extension may use of the server it runs in."""

    @property
    def state(self) -> State:
        """The served deck as the pages have it: slides, styles, colour mode,
        title, error, position (read it; the server owns it)."""
        ...

    @property
    def people(self) -> People:
        """Who is connected: each connection's ``Client`` (role, page)."""
        ...

    @property
    def deck_path(self) -> Path: ...

    @property
    def last_deck(self) -> Deck | None:
        """The last deck that built (None: none yet)."""
        ...

    @property
    def address(self) -> dict[str, object]:
        """Where this server listens: ``host``, ``port``, ``wsPort``."""
        ...

    @property
    def edit_commands(self) -> EditCommands:
        """The configured ``INKFLOW_EDIT_CMD*`` programs (``inkflow.edit``)."""
        ...

    async def send(self, conn: ServerConnection, payload: dict[str, object]) -> None:
        """One message to one page (errors from a page that is gone are
        swallowed)."""
        ...

    async def broadcast(
        self,
        payload: dict[str, object],
        sender: ServerConnection | None = None,
    ) -> None:
        """One message to every page but ``sender``."""
        ...

    async def notify(
        self, conn: ServerConnection | None, message: str, style: str = "green"
    ) -> None:
        """A transient note on one page (or all)."""
        ...

    async def rebuild(self) -> None:
        """Build the deck again now."""
        ...

    def shutdown(self) -> None:
        """Stop the server."""
        ...


Key = tuple[str, Callable[[], None]]
"""A terminal key: what it does (for the help line) and the action."""


class ServerExtension:
    """Base class of a server extension: override what you add."""

    name: str = "extension"
    provenance: bool = False
    """Build with source locators (the editor build, ``inkflow.provenance``)."""
    messages: Mapping[str, Role] = {}
    """WebSocket message types this extension handles, each with the least
    role that may send it (``"owner"``, ``"editor"`` or ``"viewer"``)."""

    async def start(self, server: ServerContext) -> None:
        del server

    async def stop(self) -> None:
        pass

    async def open(self, deck_path: Path) -> None:
        del deck_path

    async def close(self, *, switching: bool) -> None:
        """The deck stops being served (``switching``: another one follows)."""
        del switching

    def before_build(self) -> None:
        """In a worker thread, before deck.py runs."""

    def build(self, build: Build) -> None:
        """In a worker thread, once the slides are built; raising fails the
        build."""
        del build

    async def built(self, build: Build) -> None:
        del build

    async def build_failed(self, deck_hash: str | None, error: str) -> None:
        del deck_hash, error

    def welcome(self, client: Client) -> dict[str, object]:
        """Fields added to the page's ``welcome`` message."""
        del client
        return {}

    async def hello(
        self,
        conn: ServerConnection,
        client: Client,
        msg: dict[str, object],
        *,
        resync: bool,
    ) -> None:
        del conn, client, msg, resync

    async def message(
        self, conn: ServerConnection, client: Client, msg: dict[str, object]
    ) -> None:
        del conn, client, msg

    async def disconnected(self, conn: ServerConnection, client: Client) -> None:
        """The page is gone (already out of ``ServerContext.people``)."""
        del conn, client

    async def http(self, request: HttpRequest) -> bool:
        """Answer ``request`` and return True, or leave it (False)."""
        del request
        return False

    def keys(self) -> Mapping[str, Key]:
        """Terminal keys (one character each) this extension adds."""
        return {}
