"""Server extensions: a frontend of our own gets the builds, its messages
(gated by role at the door), its pages, terminal keys, and adds to the
welcome."""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import cast

import click
import pytest
from typing_extensions import override
from websockets.asyncio.server import ServerConnection
from websockets.exceptions import InvalidStatus

from inkflow import instances, plugins, server
from inkflow.access import Role
from inkflow.collab import Client
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
from tests.serving import (
    GUEST,
    UI,
    get,
    make_project,
    open_ws,
    serve_on_a_thread,
    until,
)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    return make_project(tmp_path)


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
def served(project: Path) -> Iterator[tuple[Recorder, int]]:
    recorder = Recorder()
    for port in serve_on_a_thread(project / "deck.py", [recorder]):
        yield recorder, port


def test_an_extension_follows_the_server_and_its_builds(
    served: tuple[Recorder, int],
) -> None:
    recorder, _ = served
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
    served: tuple[Recorder, int],
) -> None:
    recorder, port = served
    with open_ws(port) as ws:
        assert until(ws, "welcome")["frontend"] == "recorder"
        ws.send(json.dumps({"type": "hello", "role": "presenter"}))
        ws.send(json.dumps({"type": "secret"}))
        assert until(ws, "pong") == {
            "type": "pong",
            "role": "owner",
            "asked": "secret",
        }
        ws.send(json.dumps({"type": "build-status"}))
        status = until(ws, "build-status")
        assert status["deckHash"] == recorder.builds[-1].deck_hash
        assert status["failedHash"] is None
    assert recorder.hellos[0]["role"] == "presenter"


def test_another_sites_page_never_reaches_an_extension(
    served: tuple[Recorder, int],
) -> None:
    """A page of another site in the owner's browser reaches the socket on
    loopback too: its ``Origin`` says it is not this server's, and the door
    refuses it before any extension sees it."""
    _, port = served
    with pytest.raises(InvalidStatus) as refused:
        open_ws(port, origin="http://evil.example")
    assert refused.value.response.status_code == 403


def test_a_viewer_gets_only_the_messages_a_viewer_may_send(
    served: tuple[Recorder, int],
) -> None:
    _, port = served
    viewer = {
        **GUEST,
        "Cookie": f"inkflow-{port}={server._share.access.viewer_token}",  # pyright: ignore[reportPrivateUsage]
    }
    with open_ws(port, viewer) as ws:
        assert until(ws, "welcome")["role"] == "viewer"
        ws.send(json.dumps({"type": "secret"}))  # owner only: dropped
        ws.send(json.dumps({"type": "ping"}))
        assert until(ws, "pong")["asked"] == "ping"


def test_an_extension_answers_its_pages(served: tuple[Recorder, int]) -> None:
    _, port = served
    assert get(port, "/mine") == (200, b"mine for the owner")
    viewer = {
        **GUEST,
        "Cookie": f"inkflow-{port}={server._share.access.viewer_token}",  # pyright: ignore[reportPrivateUsage]
    }
    assert get(port, "/mine", viewer) == (200, b"mine for the viewer")
    # A name that is not this machine's (DNS rebinding) never gets that far.
    assert get(port, "/mine", {"Host": f"evil.example:{port}"})[0] == 403
    status, body = get(port, "/")
    assert status == 200 and b"<svg" in body  # the presenter is still the core's


def test_the_extension_hears_a_page_leave(served: tuple[Recorder, int]) -> None:
    recorder, port = served
    with open_ws(port) as ws:
        _ = until(ws, "welcome")
        ws.send(json.dumps({"type": "hello", "role": "presenter"}))
        ws.send(json.dumps({"type": "ping"}))
        _ = until(ws, "pong")
    for _ in range(100):
        if "gone presenter" in recorder.events:
            break
        threading.Event().wait(0.05)
    assert "gone presenter" in recorder.events


def test_a_failed_build_is_said(served: tuple[Recorder, int], project: Path) -> None:
    recorder, _ = served
    (project / "deck.py").write_text("raise RuntimeError('broken')\n")

    class _Quiet(UI):
        @override
        def set_error(self, trace: str) -> None:
            pass

    quiet = cast("LiveUI", cast("object", _Quiet()))
    asyncio.run(server.rebuild(project / "deck.py", quiet, resolve_levels()))
    assert recorder.events[-1] == "failed"
    assert server.build_status()["failedHash"] is not None


def test_the_door_gates_an_extensions_messages_by_role() -> None:
    recorder = Recorder()
    server._served.extensions = [recorder]  # pyright: ignore[reportPrivateUsage]
    try:
        assert server.allowed("owner", {"type": "secret"})
        assert not server.allowed("editor", {"type": "secret"})
        assert server.allowed("viewer", {"type": "ping"})
        # The core's own: sharing and opening programs are the owner's, a
        # viewer moves no one's slide, an editor page is an editor's.
        assert not server.allowed("editor", {"type": "share", "op": "on"})
        assert not server.allowed("editor", {"type": "edit", "path": "x"})
        assert not server.allowed("viewer", {"type": "nav", "slideIndex": 1})
        assert server.allowed("editor", {"type": "nav", "slideIndex": 1})
        assert not server.allowed("viewer", {"type": "hello", "role": "editor"})
        assert server.allowed("viewer", {"type": "hello", "role": "presenter"})
        assert server.allowed("viewer", {"type": "sync-request"})
    finally:
        server._served.extensions = []  # pyright: ignore[reportPrivateUsage]


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

    async def fake_serve(*args: object, **kwargs: object) -> None:
        del args
        seen.append(list(cast("Sequence[ServerExtension]", kwargs["extensions"])))

    monkeypatch.setattr("inkflow.cli.present._serve", fake_serve)
    monkeypatch.setattr(instances, "_dir", lambda: project / "servers")
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
