"""The core's plugin and server-extension APIs, with a frontend of our own.

inkflow-editor is the big user of these; the core keeps them working on its
own: a server extension gets the builds (with source locators when it asks),
its own messages (gated by role at the door), its own pages, and adds to the
welcome; a plugin adds commands, verify lines and the current slide."""

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
from click.testing import CliRunner
from typing_extensions import override
from websockets.asyncio.server import ServerConnection
from websockets.sync.client import ClientConnection, connect

from inkflow import plugins, server
from inkflow.access import Role
from inkflow.collab import Client
from inkflow.extensions import (
    Build,
    HttpRequest,
    ServerContext,
    ServerExtension,
)
from inkflow.logging import resolve_levels
from inkflow.manifest import Deck, Slide
from inkflow.plugins import DeckCheck, Issue, Plugin, SlideCheck
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
    """A frontend: says what it saw, answers ``/mine`` and ``ping``."""

    name: str = "recorder"
    provenance: bool = True
    messages: Mapping[str, Role] = {"ping": "editor", "secret": "owner"}

    def __init__(self) -> None:
        self.server: ServerContext | None = None
        self.events: list[str] = []
        self.builds: list[Build] = []
        self.hellos: list[dict[str, object]] = []

    @override
    async def start(self, server: ServerContext) -> None:
        self.server = server
        self.events.append("start")

    @override
    async def open(self, deck_path: Path | None) -> None:
        self.events.append(f"open {deck_path is not None}")

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
        await self.server.send(conn, {"type": "pong", "role": client.role})

    @override
    async def http(self, request: HttpRequest) -> bool:
        if request.path != "/mine":
            return False
        await request.respond("200 OK", b"mine", "text/plain", b"")
        return True


@pytest.fixture
def served(project: Path) -> Iterator[tuple[Recorder, int]]:
    recorder = Recorder()
    ui = cast("LiveUI", cast("object", _UI()))
    loop = asyncio.new_event_loop()
    started = threading.Event()
    stop = asyncio.Event()
    port: list[int] = []

    async def run() -> None:
        deck_path = project / "deck.py"
        async with server.listening(ui, deck_path, [recorder]) as bound:
            port.append(bound)
            await server.rebuild(deck_path, ui, resolve_levels())
            started.set()
            await stop.wait()

    thread = threading.Thread(target=lambda: loop.run_until_complete(run()))
    thread.start()
    assert started.wait(20)
    try:
        yield recorder, port[0]
    finally:
        loop.call_soon_threadsafe(stop.set)
        thread.join(10)
        loop.close()
        server._state["ws_clients"].clear()  # pyright: ignore[reportPrivateUsage]
        server._state["error"] = None  # pyright: ignore[reportPrivateUsage]


def _ws(port: int) -> ClientConnection:
    return connect(
        f"ws://localhost:{port}/_inkflow/ws",
        proxy=None,
        origin=cast("object", f"http://localhost:{port}"),  # pyright: ignore[reportArgumentType]
    )


def _until(ws: ClientConnection, kind: str) -> dict[str, object]:
    while True:
        msg = cast("dict[str, object]", json.loads(ws.recv(timeout=5)))
        if msg.get("type") == kind:
            return msg


def _get(port: int, path: str) -> tuple[int, bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("GET", path, headers={"Host": f"localhost:{port}"})
    response = conn.getresponse()
    body = response.read()
    conn.close()
    return response.status, body


def test_an_extension_follows_the_server_and_its_builds(
    served: tuple[Recorder, int],
) -> None:
    recorder, _ = served
    assert recorder.events == [
        "start",
        "open True",
        "before_build",
        "build",
        "built 2",
    ]
    build = recorder.builds[0]
    # It asked for provenance: every element carries its source locator, and
    # each slide its edit facts (which stay with the extensions: the pages get
    # the slides without them; the locators, inert attributes, stay).
    assert 'data-ink="' in build.slides[0]["svg"]
    assert "edit" in build.slides[0]
    assert all("edit" not in s for s in build.served)
    assert build.fresh and build.deck_hash
    assert recorder.server is not None
    assert recorder.server.last_deck is build.deck


def test_an_extension_gets_its_messages_its_pages_and_the_welcome(
    served: tuple[Recorder, int],
) -> None:
    recorder, port = served
    with _ws(port) as ws:
        assert _until(ws, "welcome")["frontend"] == "recorder"
        ws.send(json.dumps({"type": "hello", "role": "presenter", "patch": True}))
        _ = _until(ws, "update")
        ws.send(json.dumps({"type": "ping"}))
        assert _until(ws, "pong")["role"] == "owner"
        ws.send(json.dumps({"type": "build-status"}))
        status = _until(ws, "build-status")
        assert status["deckHash"] == recorder.builds[-1].deck_hash
    assert recorder.hellos[0]["role"] == "presenter"
    assert _get(port, "/mine") == (200, b"mine")
    status, body = _get(port, "/")
    assert status == 200 and b"<svg" in body  # the presenter is still the core's


def test_the_door_gates_an_extensions_messages_by_role() -> None:
    recorder = Recorder()
    server._served.extensions = [recorder]  # pyright: ignore[reportPrivateUsage]
    try:
        assert server.allowed("owner", {"type": "secret"})
        assert not server.allowed("editor", {"type": "secret"})
        assert server.allowed("editor", {"type": "ping"})
        assert not server.allowed("viewer", {"type": "ping"})
    finally:
        server._served.extensions = []  # pyright: ignore[reportPrivateUsage]


def test_without_an_editor_the_presenter_keeps_its_ink(
    project: Path,
) -> None:
    from inkflow import ink

    deck_path = project / "deck.py"
    box = (0.0, 0.0, 1920.0, 1080.0)
    path = project / "ink" / "one.svg"
    stroke = {
        "id": "ink-a1",
        "d": "M10 10L20 20Z",
        "fill": "#ff0000",
        "tool": "pen",
        "size": 4,
    }
    ink.save_ink(path, {"op": "add", "strokes": [stroke]}, box)
    assert ink.stroke_ids(path.read_bytes()) == ["ink-a1"]
    ink.save_ink(path, {"op": "erase", "ids": ["ink-a1"]}, box)
    assert not path.exists()  # no stroke left: no file
    del deck_path


# ── Plugins ──────────────────────────────────────────────────────────────────


class Checker(Plugin):
    name: str = "checker"

    @override
    def register_cli(self, main: click.Group) -> None:
        @click.command("hello-plugin")
        def hello() -> None:
            click.echo("hello from a plugin")

        main.add_command(hello)

    @override
    def slide_checks(self) -> Sequence[SlideCheck]:
        def no_two(slide: Slide, project_dir: Path, deck: Deck | None) -> list[Issue]:
            del project_dir, deck
            return [("warn", "two is here")] if "two" in slide.src else []

        return (no_two,)

    @override
    def deck_checks(self) -> Sequence[DeckCheck]:
        def whole(deck: Deck, project_dir: Path, deck_path: Path) -> list[Issue]:
            del project_dir, deck_path
            return [("warn", f"{len(deck.slides)} slides checked")]

        return (whole,)

    @override
    def current_slide(self, project_dir: Path) -> int | None:
        return 2


@pytest.fixture
def checker() -> Iterator[Checker]:
    plugin = Checker()
    plugins.register(plugin)
    try:
        yield plugin
    finally:
        plugins.unregister(plugin)


def test_a_plugin_adds_verify_lines(
    project: Path, checker: Checker, monkeypatch: pytest.MonkeyPatch
) -> None:
    from inkflow.cli import main

    del checker
    monkeypatch.chdir(project)
    result = CliRunner().invoke(main, ["verify"])
    assert "two is here" in result.output
    assert "2 slides checked" in result.output
    quiet = CliRunner().invoke(main, ["verify", "--no-deck-checks"])
    assert "slides checked" not in quiet.output


def test_a_plugin_adds_commands(checker: Checker) -> None:
    cli = click.Group("inkflow")
    checker.register_cli(cli)
    result = CliRunner().invoke(cli, ["hello-plugin"])
    assert result.output == "hello from a plugin\n"


def test_render_defaults_to_the_slide_a_plugin_says_is_open(
    project: Path, checker: Checker
) -> None:
    from inkflow.cli.render import current_slide

    del checker
    assert current_slide(project) == 2


def test_no_plugins_when_turned_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INKFLOW_NO_PLUGINS", "1")
    assert not plugins.enabled()


def test_an_ink_save_without_an_editor_writes_the_file(
    served: tuple[Recorder, int], project: Path
) -> None:
    _, port = served
    stroke = {"id": "ink-b2", "d": "M1 1L2 2Z", "fill": "#00ff00", "tool": "pen"}
    with _ws(port) as ws:
        _ = _until(ws, "welcome")
        ws.send(
            json.dumps(
                {
                    "type": "edit-op",
                    "id": "k1",
                    "action": "ink",
                    "op": "add",
                    "slideId": "two",
                    "strokes": [stroke],
                }
            )
        )
        reply = _until(ws, "edit-result")
        assert reply["ok"] is True and reply["ink"] == "ink/two.svg"
        ws.send(json.dumps({"type": "edit-op", "id": "k2", "action": "slide"}))
        refused = _until(ws, "edit-result")
        assert refused["ok"] is False and "edits the deck" in str(refused["error"])
    assert (project / "ink" / "two.svg").is_file()
