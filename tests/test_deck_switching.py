"""One server, one deck after another: an extension opens another deck on the
same port (``ServerContext.open_deck``), a server may run with no deck when
an extension answers its pages (``serves_without_deck``), and the owner is
sent to an extension's ``home``."""

from __future__ import annotations

import asyncio
import json
import socket
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import cast

import pytest
from typing_extensions import override

from inkflow import instances, server
from inkflow.access import Access, Role
from inkflow.extensions import Build, HttpRequest, ServerContext, ServerExtension
from inkflow.logging import resolve_levels
from tests.serving import get, make_project


@pytest.fixture(autouse=True)
def _isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """The registry of running servers in a folder of the test's own; the
    server's state as it was."""
    monkeypatch.setattr(instances, "_dir", lambda: tmp_path / "servers")
    try:
        yield
    finally:
        server._state["slides"] = []  # pyright: ignore[reportPrivateUsage]
        server._state["ws_clients"].clear()  # pyright: ignore[reportPrivateUsage]
        server._state["error"] = None  # pyright: ignore[reportPrivateUsage]
        server._served.deck_path = None  # pyright: ignore[reportPrivateUsage]
        server._served.deck = None  # pyright: ignore[reportPrivateUsage]
        server._served.kept = None  # pyright: ignore[reportPrivateUsage]
        server._share.access = Access(server.DEFAULT_PORT)  # pyright: ignore[reportPrivateUsage]


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return cast("tuple[str, int]", probe.getsockname())[1]


def _serve(
    deck_path: Path | None, port: int, extensions: list[ServerExtension]
) -> None:
    asyncio.run(
        asyncio.wait_for(
            server.serve(
                deck_path,
                "127.0.0.1",
                port,
                None,
                resolve_levels(),
                extensions=extensions,
            ),
            timeout=60,
        )
    )


class Switcher(ServerExtension):
    """Opens ``decks`` one after the other as each builds, then stops the
    server; says what it saw on the way."""

    name: str = "switcher"

    def __init__(self, port: int, decks: list[Path]) -> None:
        self.port: int = port
        self.decks: list[Path] = decks
        self.server: ServerContext | None = None
        self.events: list[str] = []
        self.probes: list[object] = []

    @override
    async def start(self, server: ServerContext) -> None:
        self.server = server
        self.events.append("start")

    @override
    async def open(self, deck_path: Path | None) -> None:
        self.events.append(f"open {deck_path.parent.name if deck_path else None}")

    @override
    async def built(self, build: Build) -> None:
        assert self.server is not None
        self.events.append(f"built {build.project_dir.name} fresh={build.fresh}")
        # What this machine's other inkflow processes are told is open here.
        status, body = await asyncio.to_thread(get, self.port, instances.PROBE_PATH)
        assert status == 200
        self.probes.append(cast("dict[str, object]", json.loads(body))["deck"])
        if self.decks:
            self.server.open_deck(self.decks.pop(0))
        else:
            self.server.shutdown()

    @override
    async def close(self, *, switching: bool) -> None:
        self.events.append(f"close switching={switching}")

    @override
    async def stop(self) -> None:
        self.events.append("stop")


def test_an_extension_opens_another_deck_on_the_same_port(tmp_path: Path) -> None:
    first, second = tmp_path / "first", tmp_path / "second"
    for folder in (first, second):
        folder.mkdir()
        _ = make_project(folder)
    port = _free_port()
    switcher = Switcher(port, [second / "deck.py"])
    _serve(first / "deck.py", port, [switcher])
    assert switcher.events == [
        "start",
        "open first",
        "built first fresh=True",
        "close switching=True",
        "open second",
        "built second fresh=True",
        "close switching=False",
        "stop",
    ]
    assert switcher.probes == [
        str((first / "deck.py").resolve()),
        str((second / "deck.py").resolve()),
    ]
    assert instances.running() == []  # unregistered once it stopped


class StartPage(ServerExtension):
    """A frontend that runs without a deck: answers ``/start`` itself, and
    opens a deck when asked to (here: once it has looked around)."""

    name: str = "start-page"
    serves_without_deck: bool = True
    home: str | None = "/start"

    def __init__(self, port: int, deck: Path) -> None:
        self.port: int = port
        self.deck: Path = deck
        self.server: ServerContext | None = None
        self.events: list[str] = []
        self.seen: dict[str, object] = {}

    @override
    async def start(self, server: ServerContext) -> None:
        self.server = server

    @override
    async def open(self, deck_path: Path | None) -> None:
        self.events.append(f"open {deck_path.name if deck_path else None}")
        if deck_path is None:
            _ = asyncio.get_running_loop().create_task(self._look_around())

    async def _look_around(self) -> None:
        assert self.server is not None
        self.seen["deck_path"] = self.server.deck_path
        self.seen["start"] = await asyncio.to_thread(get, self.port, "/start")
        self.seen["presenter"] = await asyncio.to_thread(get, self.port, "/")
        self.seen["record"] = await asyncio.to_thread(instances.running)
        self.server.open_deck(self.deck)

    @override
    async def http(self, request: HttpRequest) -> bool:
        if request.path != "/start":
            return False
        await request.respond("200 OK", b"pick a deck", "text/plain", b"")
        return True

    @override
    async def built(self, build: Build) -> None:
        assert self.server is not None
        self.events.append(f"built {len(build.served)}")
        self.seen["deck_page"] = await asyncio.to_thread(get, self.port, "/")
        self.server.shutdown()

    @override
    async def close(self, *, switching: bool) -> None:
        self.events.append(f"close switching={switching}")


def test_a_server_without_a_deck_serves_an_extensions_pages(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    port = _free_port()
    start = StartPage(port, project / "deck.py")
    _serve(None, port, [start])
    assert start.events == [
        "open None",
        "close switching=True",
        "open deck.py",
        "built 2",
        "close switching=False",
    ]
    assert start.seen["deck_path"] is None
    assert start.seen["start"] == (200, b"pick a deck")
    # No deck, no presenter: only the extension's pages are there.
    status, body = cast("tuple[int, bytes]", start.seen["presenter"])
    assert status == 404 and b"No deck open" in body
    # This machine's other inkflow processes see a server with no deck, whose
    # owner opens the extension's page.
    (record,) = cast("list[instances.Instance]", start.seen["record"])
    assert record.deck is None and record.home == "/start"
    assert record.url() == f"http://127.0.0.1:{port}/start"
    status, body = cast("tuple[int, bytes]", start.seen["deck_page"])
    assert status == 200 and b"<svg" in body


def test_no_deck_and_no_extension_to_serve_without_one(
    capsys: pytest.CaptureFixture[str],
) -> None:
    _serve(None, _free_port(), [])
    assert "no deck to serve" in capsys.readouterr().err


def test_the_owner_is_sent_to_an_extensions_home() -> None:
    class Home(ServerExtension):
        home: str | None = "/mine"

    class Editing(ServerExtension):
        messages: Mapping[str, Role] = {"change": "editor"}

    access = Access(7777, names=set(), ssh=True)
    assert server.owner_page() == "/"
    assert server.owner_lines(access, 7777)[0].split("?")[0].endswith(":7777/")
    assert server.editor_page() is None  # nothing edits: view links only
    server._served.extensions = [Editing()]  # pyright: ignore[reportPrivateUsage]
    try:
        assert server.editor_page() == "/"
        server._served.extensions = [Home(), Editing()]  # pyright: ignore[reportPrivateUsage]
        assert server.owner_page() == "/mine"
        assert "/mine?k=" in server.owner_lines(access, 7777)[0]
        Editing.home = "/edit"
        assert server.editor_page() == "/edit"
    finally:
        server._served.extensions = []  # pyright: ignore[reportPrivateUsage]
