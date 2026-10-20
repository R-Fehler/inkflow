"""A deck served on the one port for tests: the server's own listener
(``server.listening``) on a thread of its own, and a page's or a guest's
requests to it."""

from __future__ import annotations

import asyncio
import http.client
import json
import threading
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import cast

from websockets.sync.client import ClientConnection, connect

from inkflow import server
from inkflow.access import Access
from inkflow.extensions import ServerExtension
from inkflow.logging import resolve_levels
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


def make_project(folder: Path) -> Path:
    """A two-slide deck (``one``, ``two``) in ``folder``."""
    (folder / "slides").mkdir()
    for name in ("one", "two"):
        (folder / "slides" / f"{name}.svg").write_text(SLIDE)
    (folder / "deck.py").write_text(DECK)
    return folder


class UI:
    def refresh(self) -> None:
        pass

    def set_building(self) -> None:
        pass

    def set_ok(self, *_args: object, **_kwargs: object) -> None:
        pass

    def set_error(self, trace: str) -> None:
        raise AssertionError(trace)


def serve_on_a_thread(
    deck_path: Path, extensions: Sequence[ServerExtension]
) -> Iterator[int]:
    """The deck served on the one port (``server.listening``) on a thread of
    its own, built once, shared with share links (``Access.sharing``);
    yields the port."""
    ui = cast("LiveUI", cast("object", UI()))
    loop = asyncio.new_event_loop()
    started = threading.Event()
    stop = asyncio.Event()
    port: list[int] = []

    async def run() -> None:
        async with server.listening(ui, deck_path, extensions) as bound:
            port.append(bound)
            server._share.access = Access(bound, sharing=True, names=set())  # pyright: ignore[reportPrivateUsage]
            await server.rebuild(deck_path, ui, resolve_levels())
            started.set()
            await stop.wait()

    thread = threading.Thread(target=lambda: loop.run_until_complete(run()))
    thread.start()
    assert started.wait(20)
    try:
        yield port[0]
    finally:
        loop.call_soon_threadsafe(stop.set)
        thread.join(10)
        loop.close()
        server._state["ws_clients"].clear()  # pyright: ignore[reportPrivateUsage]
        server._state["error"] = None  # pyright: ignore[reportPrivateUsage]
        server._state["position"] = {"slideIndex": 0, "step": 0}  # pyright: ignore[reportPrivateUsage]
        server._share.access = Access(server.DEFAULT_PORT)  # pyright: ignore[reportPrivateUsage]


GUEST = {"X-Forwarded-For": "192.0.2.50"}
"""A request relayed from elsewhere: whatever its socket, not the owner's."""


def open_ws(
    port: int,
    headers: dict[str, str] | None = None,
    origin: str | None = "",
) -> ClientConnection:
    """A page's WebSocket on the one port (origin: its own page by default;
    None: a program, which sends none)."""
    page = f"http://localhost:{port}" if origin == "" else origin
    return connect(
        f"ws://localhost:{port}/_inkflow/ws",
        proxy=None,
        open_timeout=5,
        origin=cast("object", page),  # pyright: ignore[reportArgumentType]
        additional_headers=headers or {},
    )


def until(ws: ClientConnection, kind: str) -> dict[str, object]:
    while True:
        msg = cast("dict[str, object]", json.loads(ws.recv(timeout=5)))
        if msg.get("type") == kind:
            return msg


def fetch(
    port: int, path: str, headers: dict[str, str] | None = None
) -> tuple[int, dict[str, str], bytes]:
    """A GET naming ``localhost`` (unless ``headers`` say another ``Host``):
    status, headers (lower-case names) and body."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("GET", path, headers={"Host": f"localhost:{port}", **(headers or {})})
    response = conn.getresponse()
    body = response.read()
    conn.close()
    return response.status, {k.lower(): v for k, v in response.getheaders()}, body


def get(
    port: int, path: str, headers: dict[str, str] | None = None
) -> tuple[int, bytes]:
    status, _, body = fetch(port, path, headers)
    return status, body


def upgrade(port: int, host: str, origin: str) -> int:
    """The status a WebSocket handshake naming ``host`` from ``origin`` gets."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request(
        "GET",
        "/_inkflow/ws",
        headers={
            "Host": host,
            "Origin": origin,
            "Upgrade": "websocket",
            "Connection": "Upgrade",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version": "13",
        },
    )
    status = conn.getresponse().status
    conn.close()
    return status


def guest(port: int, token: str) -> dict[str, str]:
    """A guest's request headers: relayed from elsewhere, with the cookie a
    share link set."""
    return {**GUEST, "Cookie": f"inkflow-{port}={token}"}
