"""Server extensions: a frontend of our own gets the builds, its messages
(gated by role), its pages, terminal keys, and adds to the welcome."""

from __future__ import annotations

import asyncio
import http.client
import json
import threading
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import cast

import click
import pytest
from typing_extensions import override
from websockets.asyncio.server import ServerConnection
from websockets.asyncio.server import serve as ws_serve
from websockets.sync.client import ClientConnection, connect

from inkflow import plugins, server
from inkflow.collab import Client, Role
from inkflow.extensions import (
    Build,
    HttpRequest,
    Key,
    ServeConfig,
    ServerContext,
    ServerExtension,
)
from inkflow.logging import resolve_levels
from inkflow.plugins import Plugin
from inkflow.tui import LiveUI

DECK = """\
from inkflow import Deck, Slide


def main():
    return Deck(slides=[Slide("slides/one.svg"), Slide("slides/two.svg")])
"""

SLIDE = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
    '<rect id="box" x="10" y="10" width="100" height="100"/></svg>'
)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    for name in ("one", "two"):
        (tmp_path / "slides" / f"{name}.svg").write_text(SLIDE)
    (tmp_path / "deck.py").write_text(DECK)
    return tmp_path


class _UI:
    def refresh(self) -> None:
        pass

    def set_building(self) -> None:
        pass

    def set_ok(self, *_args: object, **_kwargs: object) -> None:
        pass

    def set_error(self, trace: str) -> None:
        raise AssertionError(trace)


class Recorder(ServerExtension):
    """A frontend: says what it saw, answers ``/mine``, ``ping`` and
    ``secret``."""

    name: str = "recorder"
    provenance: bool = True
    messages: Mapping[str, Role] = {"ping": "viewer", "secret": "owner"}

    def __init__(self) -> None:
        self.server: ServerContext | None = None
        self.events: list[str] = []
        self.builds: list[Build] = []
        self.hellos: list[dict[str, object]] = []
        self.pressed: int = 0

    @override
    async def start(self, server: ServerContext) -> None:
        self.server = server
        self.events.append("start")

    @override
    async def open(self, deck_path: Path) -> None:
        self.events.append(f"open {deck_path.name}")

    @override
    async def close(self, *, switching: bool) -> None:
        self.events.append("close")

    @override
    async def stop(self) -> None:
        self.events.append("stop")

    @override
    def before_build(self) -> None:
        self.events.append("before_build")

    @override
    def build(self, build: Build) -> None:
        self.events.append("build")
        self.builds.append(build)

    @override
    async def built(self, build: Build) -> None:
        self.events.append(f"built {len(build.served)}")

    @override
    async def build_failed(self, deck_hash: str | None, error: str) -> None:
        self.events.append("failed")

    @override
    def welcome(self, client: Client) -> dict[str, object]:
        return {"frontend": "recorder"}

    @override
    async def hello(
        self,
        conn: ServerConnection,
        client: Client,
        msg: dict[str, object],
        *,
        resync: bool,
    ) -> None:
        self.hellos.append(msg)

    @override
    async def message(
        self, conn: ServerConnection, client: Client, msg: dict[str, object]
    ) -> None:
        assert self.server is not None
        await self.server.send(
            conn, {"type": "pong", "role": client.role, "asked": msg["type"]}
        )

    @override
    async def disconnected(self, conn: ServerConnection, client: Client) -> None:
        assert self.server is not None
        assert self.server.people.get(conn) is None
        self.events.append(f"gone {client.page}")

    @override
    async def http(self, request: HttpRequest) -> bool:
        if request.path != "/mine":
            return False
        body = f"mine for the {request.role}".encode()
        await request.respond("200 OK", body, "text/plain", b"")
        return True

    @override
    def keys(self) -> Mapping[str, Key]:
        def press() -> None:
            self.pressed += 1

        return {"x": ("press", press)}


@pytest.fixture
def served(project: Path) -> Iterator[tuple[Recorder, int, int]]:
    recorder = Recorder()
    ui = cast("LiveUI", cast("object", _UI()))
    loop = asyncio.new_event_loop()
    started = threading.Event()
    stop = asyncio.Event()
    ports: list[int] = []

    async def run() -> None:
        deck_path = project / "deck.py"
        await server.start_extensions([recorder], deck_path, {})
        http_server = await asyncio.start_server(
            server.make_http_handler(0, project), "127.0.0.1", 0
        )
        edit_commands = server.context.edit_commands
        async with (
            http_server,
            ws_serve(server.make_ws_handler(ui, edit_commands), "127.0.0.1", 0) as ws,
        ):
            http_address = cast("tuple[str, int]", http_server.sockets[0].getsockname())
            ws_address = cast("tuple[str, int]", next(iter(ws.sockets)).getsockname())
            ports.extend([http_address[1], ws_address[1]])
            await server.rebuild(deck_path, ui, resolve_levels())
            started.set()
            await stop.wait()
        await server.stop_extensions()

    thread = threading.Thread(target=lambda: loop.run_until_complete(run()))
    thread.start()
    assert started.wait(20)
    try:
        yield recorder, ports[0], ports[1]
    finally:
        loop.call_soon_threadsafe(stop.set)
        thread.join(10)
        loop.close()
        server._state["ws_clients"].clear()  # pyright: ignore[reportPrivateUsage]
        server._state["error"] = None  # pyright: ignore[reportPrivateUsage]


def _ws(port: int, origin: str | None = None) -> ClientConnection:
    return connect(
        f"ws://localhost:{port}",
        proxy=None,
        origin=cast("object", origin),  # pyright: ignore[reportArgumentType]
    )


def _until(ws: ClientConnection, kind: str) -> dict[str, object]:
    while True:
        msg = cast("dict[str, object]", json.loads(ws.recv(timeout=5)))
        if msg.get("type") == kind:
            return msg


def _get(port: int, path: str, host: str = "localhost") -> tuple[int, bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("GET", path, headers={"Host": f"{host}:{port}"})
    response = conn.getresponse()
    body = response.read()
    conn.close()
    return response.status, body


def test_an_extension_follows_the_server_and_its_builds(
    served: tuple[Recorder, int, int],
) -> None:
    recorder, _, _ = served
    assert recorder.events == [
        "start",
        "open deck.py",
        "before_build",
        "build",
        "built 2",
    ]
    build = recorder.builds[0]
    # It asked for provenance: every element carries its source locator, and
    # each slide its edit facts, which stay with the extensions (the pages get
    # the slides without them; the locators, inert attributes, stay).
    assert 'data-ink="' in build.slides[0]["svg"]
    assert "edit" in build.slides[0]
    assert all("edit" not in s for s in build.served)
    assert 'data-ink="' in build.served[0]["svg"]
    assert build.fresh and build.deck_hash
    assert build.project_dir == build.deck_path.parent
    assert recorder.server is not None
    assert recorder.server.last_deck is build.deck


def test_an_extension_gets_its_messages_and_adds_to_the_welcome(
    served: tuple[Recorder, int, int],
) -> None:
    recorder, http_port, ws_port = served
    with _ws(ws_port, f"http://localhost:{http_port}") as ws:
        assert _until(ws, "welcome")["frontend"] == "recorder"
        ws.send(json.dumps({"type": "hello", "role": "presenter"}))
        ws.send(json.dumps({"type": "secret"}))
        assert _until(ws, "pong") == {
            "type": "pong",
            "role": "owner",
            "asked": "secret",
        }
        ws.send(json.dumps({"type": "build-status"}))
        status = _until(ws, "build-status")
        assert status["deckHash"] == recorder.builds[-1].deck_hash
        assert status["failedHash"] is None
    assert recorder.hellos[0]["role"] == "presenter"


def test_another_sites_page_is_not_the_owner(
    served: tuple[Recorder, int, int],
) -> None:
    """A page of another site in the owner's browser reaches the socket on
    loopback too: its ``Origin`` says it is not this server's."""
    _, _, ws_port = served
    with _ws(ws_port, "http://evil.example") as ws:
        assert _until(ws, "welcome")["role"] == "viewer"
        ws.send(json.dumps({"type": "secret"}))  # owner only: dropped
        ws.send(json.dumps({"type": "ping"}))
        assert _until(ws, "pong")["asked"] == "ping"


def test_an_extension_answers_its_pages(served: tuple[Recorder, int, int]) -> None:
    _, http_port, _ = served
    assert _get(http_port, "/mine") == (200, b"mine for the owner")
    # A name that is not this machine's (DNS rebinding) is not the owner.
    assert _get(http_port, "/mine", "evil.example") == (200, b"mine for the viewer")
    status, body = _get(http_port, "/")
    assert status == 200 and b"<svg" in body  # the presenter is still the core's


def test_the_extension_hears_a_page_leave(served: tuple[Recorder, int, int]) -> None:
    recorder, _, ws_port = served
    with _ws(ws_port) as ws:
        _ = _until(ws, "welcome")
        ws.send(json.dumps({"type": "hello", "role": "presenter"}))
        ws.send(json.dumps({"type": "ping"}))
        _ = _until(ws, "pong")
    for _ in range(100):
        if "gone presenter" in recorder.events:
            break
        threading.Event().wait(0.05)
    assert "gone presenter" in recorder.events


def test_a_failed_build_is_said(
    served: tuple[Recorder, int, int], project: Path
) -> None:
    recorder, _, _ = served
    (project / "deck.py").write_text("raise RuntimeError('broken')\n")

    class _Quiet(_UI):
        @override
        def set_error(self, trace: str) -> None:
            pass

    quiet = cast("LiveUI", cast("object", _Quiet()))
    asyncio.run(server.rebuild(project / "deck.py", quiet, resolve_levels()))
    assert recorder.events[-1] == "failed"
    assert server.build_status()["failedHash"] is not None


@pytest.mark.parametrize(
    ("peer", "host", "origin", "role"),
    [
        ("127.0.0.1", "localhost:7777", None, "owner"),
        ("::1", "[::1]:7777", None, "owner"),
        ("127.0.0.1", "localhost:7777", "http://localhost:7777", "owner"),
        ("127.0.0.1", "evil.example:7777", None, "viewer"),
        ("127.0.0.1", None, "http://evil.example", "viewer"),
        ("192.168.1.5", "192.168.1.2:7777", None, "viewer"),
        (None, None, None, "viewer"),
    ],
)
def test_who_is_the_owner(
    peer: str | None, host: str | None, origin: str | None, role: Role
) -> None:
    assert server.role_for(peer, host=host, origin=origin) == role


# ── Plugins hand extensions to the server ─────────────────────────────────────


class Serving(Plugin):
    name: str = "serving"

    def __init__(self) -> None:
        self.config: ServeConfig | None = None

    @override
    def serve_options(self) -> Sequence[click.Option]:
        return (click.Option(["--shout"], is_flag=True, help="Shout."),)

    @override
    def server_extensions(self, config: ServeConfig) -> Sequence[ServerExtension]:
        self.config = config
        return (Recorder(),)


def test_a_plugins_serve_option_reaches_its_extensions(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from click.testing import CliRunner

    from inkflow.cli import main
    from inkflow.cli.present import add_serve_options

    plugin = Serving()
    plugins.register(plugin)
    seen: list[list[ServerExtension]] = []

    async def fake_serve(*args: object) -> None:
        seen.append(list(cast("Sequence[ServerExtension]", args[-1])))

    monkeypatch.setattr("inkflow.cli.present._serve", fake_serve)
    serve_cmd = main.commands["serve"]
    before = list(serve_cmd.params)
    try:
        add_serve_options(plugin.serve_options())
        result = CliRunner().invoke(
            main, ["serve", "--deck", str(project / "deck.py"), "--shout"]
        )
        assert result.exit_code == 0, result.output
    finally:
        serve_cmd.params[:] = before
        plugins.unregister(plugin)
    assert plugin.config is not None
    assert plugin.config.options == {"shout": True}
    assert [e.name for e in seen[0]] == ["recorder"]
