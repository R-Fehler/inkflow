"""The editor's part of test_collab.py: the tests that need inkflow-editor."""

from __future__ import annotations

import asyncio
import contextlib
import http.client
import json
import socket
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import cast

import pytest
from websockets.exceptions import ConnectionClosed, InvalidStatus
from websockets.sync.client import ClientConnection, connect

from inkflow import server
from inkflow.access import (
    Access,
)
from inkflow.server import load_deck
from inkflow_editor.session import (
    EditError,
    EditorSession,
    History,
    _Change,  # pyright: ignore[reportPrivateUsage]
    _Step,  # pyright: ignore[reportPrivateUsage]
)
from tests import serving
from tests import test_slides_cli as slides_tests
from tests.test_ink_editor import _stroke  # pyright: ignore[reportPrivateUsage]

project = slides_tests.project


served = slides_tests.served


GUEST = {"X-Forwarded-For": "192.0.2.50"}


"""A request relayed from elsewhere: whatever its socket, not the owner's."""


@pytest.fixture
def shared(served: tuple[EditorSession, int]) -> Iterator[tuple[EditorSession, int]]:
    """The deck served (see test_slides_cli.served), shared with links."""
    session, port = served
    server._share.access = Access(port, sharing=True, names=set())  # pyright: ignore[reportPrivateUsage]
    try:
        yield session, port
    finally:
        server._share.access = Access(server.DEFAULT_PORT)  # pyright: ignore[reportPrivateUsage]


def _get(
    port: int, path: str, headers: dict[str, str] | None = None
) -> tuple[int, dict[str, str], bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("GET", path, headers={"Host": f"localhost:{port}", **(headers or {})})
    response = conn.getresponse()
    body = response.read()
    conn.close()
    return response.status, {k.lower(): v for k, v in response.getheaders()}, body


def _cookie(port: int, token: str) -> dict[str, str]:
    return {**GUEST, "Cookie": f"inkflow-{port}={token}"}


def _ws(
    port: int,
    headers: dict[str, str] | None = None,
    origin: str | None = "",
) -> ClientConnection:
    """A page's WebSocket (origin: its own page by default)."""
    page = f"http://localhost:{port}" if origin == "" else origin
    return connect(
        f"ws://localhost:{port}/_inkflow/ws",
        proxy=None,
        max_size=None,
        open_timeout=5,
        origin=cast("object", page),  # pyright: ignore[reportArgumentType]
        additional_headers=headers or {},
    )


def _upgrade(port: int, host: str, origin: str) -> int:
    """The status a WebSocket handshake naming ``host`` gets."""
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


def _until(ws: ClientConnection, kind: str, timeout: float = 5) -> dict[str, object]:
    while True:
        msg = cast("dict[str, object]", json.loads(ws.recv(timeout=timeout)))
        if msg.get("type") == kind:
            return msg


def _edit(ws: ClientConnection, request: dict[str, object]) -> dict[str, object]:
    ident = f"t{id(request)}"
    ws.send(json.dumps({"type": "edit-op", "id": ident, **request}))
    while True:
        msg = _until(ws, "edit-result")
        if msg.get("id") == ident:
            return msg


def test_pages_and_websocket_share_one_port(shared: tuple[EditorSession, int]) -> None:
    _, port = shared
    status, _, body = _get(port, "/edit")
    # The pages open the socket on their own address, never a fixed host.
    assert status == 200 and b"/_inkflow/ws" in body and b"ws://localhost" not in body
    assert b"ws://localhost" not in _get(port, "/")[2]
    with _ws(port) as ws:
        welcome = _until(ws, "welcome")
        assert welcome["role"] == "owner"
        ws.send(json.dumps({"type": "build-status"}))
        assert _until(ws, "build-status")["deckHash"]


def test_a_foreign_host_name_is_refused(shared: tuple[EditorSession, int]) -> None:
    _, port = shared
    status, _, body = _get(port, "/", {"Host": f"evil.example:{port}"})
    assert status == 403 and b"Unknown host" in body
    evil = f"evil.example:{port}"
    assert _upgrade(port, evil, f"http://{evil}") == 403
    # The same handshake by the server's own name is taken.
    assert _upgrade(port, f"localhost:{port}", f"http://localhost:{port}") == 101


def test_another_sites_page_cannot_open_the_websocket(
    shared: tuple[EditorSession, int],
) -> None:
    _, port = shared
    for origin in ("http://evil.example", "null", f"http://localhost:{port + 1}"):
        with pytest.raises(InvalidStatus) as refused:
            _ws(port, origin=origin)
        assert refused.value.response.status_code == 403
    with _ws(port, origin=None) as ws:  # a program (an agent's command)
        assert _until(ws, "welcome")["role"] == "owner"


def test_guests_need_a_link(shared: tuple[EditorSession, int]) -> None:
    _, port = shared
    access = server._share.access  # pyright: ignore[reportPrivateUsage]
    for path in ("/", "/edit", "/slides/drawn.svg", "/_inkflow/instance"):
        assert _get(port, path, GUEST)[0] == 401
    with pytest.raises(InvalidStatus) as refused:
        _ws(port, GUEST)
    assert refused.value.response.status_code == 401
    # The link sets the cookie and moves on without the token.
    status, headers, body = _get(port, f"/?k={access.viewer_token}&x=1", GUEST)
    assert status == 200
    assert headers["set-cookie"] == (
        f"inkflow-{port}={access.viewer_token}; Path=/; HttpOnly; SameSite=Strict"
    )
    assert access.viewer_token not in body.decode() and "/?x=1" in body.decode()
    assert headers["referrer-policy"] == "no-referrer"


def test_a_viewer_watches_and_does_not_edit(shared: tuple[EditorSession, int]) -> None:
    session, port = shared
    viewer = _cookie(port, server._share.access.viewer_token)  # pyright: ignore[reportPrivateUsage]
    assert _get(port, "/", viewer)[0] == 200
    assert _get(port, "/slides/drawn.svg", viewer)[0] == 200
    # (The handout shows the speaker notes.)
    for path in ("/edit", "/edit/", "/_export/x/y.pdf", "/_cmp/x/y.png", "/handout"):
        status, _, body = _get(port, path, viewer)
        assert status == 403 and b"View-only" in body
    status, _, body = _get(port, "/handout?layout=compact&paper=letter")
    assert status == 200 and b"layout-compact" in body and b"8.5in 11in" in body
    assert _get(port, "/_inkflow/instance", viewer)[0] == 404
    with _ws(port, viewer) as ws, _ws(port) as owner:
        assert _until(ws, "welcome")["role"] == "viewer"
        reply = _edit(ws, {"action": "notes", "slide": 0, "text": "x"})
        assert reply["ok"] is False and "view-only" in str(reply["error"])
        _until(owner, "welcome")
        _until(owner, "position")  # where everyone is, on connecting
        # Its navigation moves no one; the owner's reaches it.
        ws.send(json.dumps({"type": "nav", "slideIndex": 2, "step": 0}))
        owner.send(json.dumps({"type": "nav", "slideIndex": 1, "step": 0}))
        while _until(ws, "position")["slideIndex"] != 1:
            pass
        owner.send(json.dumps({"type": "sync-request"}))
        assert _until(owner, "position")["slideIndex"] == 1
    assert not session.history.done


OWNER_ONLY: list[dict[str, object]] = [
    {"action": "open-file", "path": "slides/drawn.svg", "app": "system"},
    {"action": "open-apps", "path": "slides/drawn.svg"},
    {"action": "git", "op": "commit", "message": "x"},
    {"action": "git", "op": "push"},
    {"action": "git", "op": "init"},
    {"action": "git", "op": "switch", "name": "main"},
    {"action": "new-deck", "path": "/tmp/x"},
    {"action": "open-deck", "path": "/tmp/x"},
    {"action": "browse", "path": "/"},
    {"action": "system-pick"},
    {"action": "places-set", "op": "add", "path": "/"},
    {"action": "quit"},
    {"action": "import-path", "path": "/etc/hostname"},
    {"action": "convert", "path": "/etc/hostname"},
    {"action": "media-info", "path": "/etc/hostname"},
    {"action": "worktree", "op": "add", "name": "x"},
    {"action": "worktree", "op": "merge", "branch": "x"},
    {"action": "worktree", "op": "remove", "name": "x"},
    {"action": "publish", "op": "setup", "host": "github"},
    {"action": "pack", "op": "apply"},
    {"action": "export", "format": "pdf", "output": "/tmp/stolen.pdf"},
]


def test_a_shared_editor_edits_but_not_this_computer(
    shared: tuple[EditorSession, int],
) -> None:
    session, port = shared
    editor = _cookie(port, server._share.access.editor_token)  # pyright: ignore[reportPrivateUsage]
    assert _get(port, "/edit", editor)[0] == 200
    with _ws(port, editor) as ws:
        assert _until(ws, "welcome")["role"] == "editor"
        ws.send(json.dumps({"type": "hello", "role": "editor"}))
        _until(ws, "editor-model")
        for request in OWNER_ONLY:
            reply = _edit(ws, request)
            assert reply["ok"] is False, request
            assert "machine" in str(reply["error"]) or "outside" in str(
                reply["error"]
            ), (request, reply["error"])
        info = _edit(ws, {"action": "project-info"})
        assert info["recent"] == [] and info["places"] == []
        # What only the owner's pages send is ignored.
        ws.send(json.dumps({"type": "share", "op": "rotate"}))
        ws.send(json.dumps({"type": "editor-context", "context": {"x": 1}}))
        reply = _edit(ws, {"action": "notes", "slide": 0, "text": "From a guest"})
        assert reply["ok"] is True
    assert (session.project_dir / "notes" / "drawn.md").read_text() == "From a guest"
    assert not (session.project_dir / ".inkflow" / "context.json").exists()
    assert not Path("/tmp/stolen.pdf").exists()


def test_presence_reaches_everyone_and_the_key_does_not(
    shared: tuple[EditorSession, int],
) -> None:
    _, port = shared
    editor = _cookie(port, server._share.access.editor_token)  # pyright: ignore[reportPrivateUsage]
    with _ws(port) as owner, _ws(port, editor) as guest:
        me = _until(guest, "welcome")
        owner.send(json.dumps({"type": "hello", "role": "editor"}))
        guest.send(
            json.dumps(
                {
                    "type": "presence",
                    "page": "editor",
                    "name": "  Ana   Lima ",
                    "key": "secret-key-1234567890",
                    "slide": 2,
                    "selection": ["0:1"],
                }
            )
        )
        while True:
            people = cast(
                "list[dict[str, object]]", _until(owner, "presence")["people"]
            )
            ana = next((p for p in people if p["id"] == me["id"]), None)
            if ana is not None:
                break
        assert ana["name"] == "Ana Lima" and ana["role"] == "editor"
        assert ana["slide"] == 2 and ana["selection"] == ["0:1"]
        assert ana["color"] == me["color"]
        assert "secret-key" not in json.dumps(people)
        # The owner's dialog lists them, and can send them away.
        owner.send(json.dumps({"type": "share", "op": "status"}))
        status = _until(owner, "share-status")
        assert any(
            p["id"] == me["id"]
            for p in cast("list[dict[str, object]]", status["people"])
        )
        owner.send(json.dumps({"type": "share", "op": "kick", "id": me["id"]}))
        with pytest.raises(ConnectionClosed) as closed:
            while True:
                guest.recv(timeout=5)
        assert closed.value.rcvd is not None and closed.value.rcvd.code == 4001
        # Gone from everyone's list.
        while True:
            people = cast(
                "list[dict[str, object]]", _until(owner, "presence")["people"]
            )
            if all(p["id"] != me["id"] for p in people):
                break


def test_new_links_and_stopping_disconnect_guests(
    shared: tuple[EditorSession, int],
) -> None:
    _, port = shared
    access = server._share.access  # pyright: ignore[reportPrivateUsage]
    old = _cookie(port, access.editor_token)
    with _ws(port) as owner, _ws(port, old) as guest:
        _until(guest, "welcome")
        owner.send(json.dumps({"type": "share", "op": "rotate"}))
        assert _until(owner, "share-status")["sharing"] is True
        with pytest.raises(ConnectionClosed) as closed:
            while True:
                guest.recv(timeout=5)
        assert closed.value.rcvd is not None and closed.value.rcvd.code == 4001
    assert _get(port, "/edit", old)[0] == 401
    fresh = _cookie(port, access.editor_token)
    assert _get(port, "/edit", fresh)[0] == 200
    with _ws(port) as owner, _ws(port, fresh) as guest:
        _until(guest, "welcome")
        owner.send(json.dumps({"type": "share", "op": "off"}))
        assert _until(owner, "share-status")["sharing"] is False
        with pytest.raises(ConnectionClosed):
            while True:
                guest.recv(timeout=5)
    assert _get(port, "/edit", fresh)[0] == 401
    assert _get(port, "/edit")[0] == 200  # the owner, as ever


def test_the_old_websocket_port_has_the_same_door(
    shared: tuple[EditorSession, int],
) -> None:
    from websockets.asyncio.server import serve as ws_serve

    from inkflow.edit import NO_EDIT_COMMANDS

    _, port = shared
    ready = threading.Event()
    loop = asyncio.new_event_loop()
    stop = asyncio.Event()
    legacy: list[int] = []

    async def run() -> None:
        handler = server.make_ws_handler(serving.ui(), NO_EDIT_COMMANDS)
        check = server._ws_check(port)  # pyright: ignore[reportPrivateUsage]
        async with ws_serve(handler, "127.0.0.1", 0, process_request=check) as ws:
            legacy.append(
                cast("tuple[str, int]", next(iter(ws.sockets)).getsockname())[1]
            )
            ready.set()
            await stop.wait()

    thread = threading.Thread(target=lambda: loop.run_until_complete(run()))
    thread.start()
    assert ready.wait(10)
    url = f"ws://127.0.0.1:{legacy[0]}"
    with pytest.raises(InvalidStatus):
        connect(url, proxy=None, origin=cast("object", "http://evil.example"))  # pyright: ignore[reportArgumentType]
    page = cast("object", f"http://localhost:{port}")
    with connect(url, proxy=None, origin=page) as ws:  # pyright: ignore[reportArgumentType]
        assert _until(ws, "welcome")["role"] == "owner"
    loop.call_soon_threadsafe(stop.set)
    thread.join(10)
    loop.close()


def _step(history: History, author: str, name: str, path: Path, text: str) -> _Step:
    before = path.read_bytes() if path.exists() else None
    path.write_text(text)
    step = _Step(
        f"{name} wrote",
        [_Change(path, before, text.encode())],
        author=author,
        name=name,
    )
    history.record(step)
    return step


def test_undo_takes_back_your_own_step_past_others(tmp_path: Path) -> None:
    a, b = tmp_path / "a.md", tmp_path / "b.md"
    history = History()
    _step(history, "guest:ana", "Ana", a, "ana 1")
    _step(history, "owner", "Owner", b, "owner 1")
    assert history.state("guest:ana")["undoLabel"] == "Ana wrote"
    # Ana's step is not the last one, but nothing after it touched a.md.
    history.undo(author="guest:ana")
    assert not a.exists() and b.read_text() == "owner 1"
    assert history.state("guest:ana")["canUndo"] is False
    assert history.state("owner")["canUndo"] is True
    history.redo(author="guest:ana")
    assert a.read_text() == "ana 1"
    with pytest.raises(EditError, match="nothing to redo"):
        history.redo(author="owner")


def test_undo_is_refused_when_someone_changed_the_same_file(tmp_path: Path) -> None:
    a = tmp_path / "a.md"
    history = History()
    _step(history, "owner", "Owner", a, "owner")
    _step(history, "guest:ana", "Ana", a, "ana")
    assert history.state("owner")["undoBlockedBy"] == "Ana"
    with pytest.raises(EditError, match=r"Ana changed a\.md after you") as refused:
        history.undo(author="owner")
    assert refused.value.extra == {"blocked": True}
    assert a.read_text() == "ana"
    history.undo(author="guest:ana")
    assert a.read_text() == "owner"
    history.undo(author="owner")
    assert not a.exists()


def test_typing_does_not_merge_across_people(tmp_path: Path) -> None:
    a = tmp_path / "a.md"
    history = History()
    first = _step(history, "owner", "Owner", a, "1")
    first.coalesce = "typing"
    second = _Step("x", [_Change(a, b"1", b"2")], coalesce="typing", author="guest:ana")
    a.write_text("2")
    history.record(second)
    assert len(history.done) == 2


def test_a_new_step_clears_only_its_authors_redo(tmp_path: Path) -> None:
    a, b = tmp_path / "a.md", tmp_path / "b.md"
    history = History()
    _step(history, "guest:ana", "Ana", a, "ana")
    history.undo(author="guest:ana")
    _step(history, "owner", "Owner", b, "owner")
    assert history.state("guest:ana")["canRedo"] is True


def test_session_undo_is_per_person(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    ana = {"_author": "guest:ana", "_name": "Ana", "_role": "editor"}
    session.apply(
        {"action": "notes", "slide": 0, "text": "owner", "_local": True}, deck
    )
    session.apply({"action": "notes", "slide": 1, "text": "ana", **ana}, deck)
    # Ctrl+Z on each page takes back its own person's step.
    out = session.apply({"action": "undo", **ana}, deck)
    assert out["canUndo"] is False
    assert (project / "notes" / "intro.md").read_text() == "intro notes\n"
    assert (project / "notes" / "drawn.md").read_text() == "owner"
    assert session.history_state()["canUndo"] is True
    session.apply({"action": "notes", "slide": 0, "text": "ana too", **ana}, deck)
    with pytest.raises(EditError, match=r"Ana changed (notes/)?drawn\.md"):
        session.apply({"action": "undo", "_local": True}, deck)


def _ana(base: int) -> dict[str, object]:
    return {
        "_author": "guest:ana",
        "_name": "Ana",
        "_role": "editor",
        "baseBuild": base,
    }


def _bo(base: int) -> dict[str, object]:
    return {"_author": "guest:bo", "_name": "Bo", "_role": "editor", "baseBuild": base}


def _stale(session: EditorSession, request: dict[str, object], deck: object) -> str:
    with pytest.raises(EditError) as refused:
        session.apply(request, deck)  # pyright: ignore[reportArgumentType]
    assert refused.value.extra.get("stale") is True, str(refused.value)
    return str(refused.value)


@pytest.mark.parametrize(
    ("first", "second", "file"),
    [
        (  # Markdown: a zone's text
            {"action": "zone-text", "slide": 1, "zone": "content", "text": "Ana"},
            {"action": "zone-text", "slide": 1, "zone": "content", "text": "Bo"},
            "slides/intro.md",
        ),
        (  # Markdown: two zones of one file
            {"action": "zone-text", "slide": 1, "zone": "title", "text": "Ana"},
            {"action": "zone-text", "slide": 1, "zone": "content", "text": "Bo"},
            "slides/intro.md",
        ),
        (  # speaker notes
            {"action": "notes", "slide": 1, "text": "Ana"},
            {"action": "notes", "slide": 1, "text": "Bo"},
            "notes/intro.md",
        ),
        (  # deck.py: the slide list and Slide(...) arguments
            {"action": "slide", "op": "title", "slide": 0, "title": "Ana"},
            {"action": "slide", "op": "hide", "slide": 2},
            "deck.py",
        ),
        (  # deck.py read, another file written: slide numbers moved
            {"action": "slide", "op": "move", "from": 0, "to": 2},
            {"action": "notes", "slide": 1, "text": "Bo"},
            "deck.py",
        ),
        (  # ink
            {
                "action": "ink",
                "op": "add",
                "slideId": "drawn",
                "strokes": [_stroke("ink-a")],
            },
            {
                "action": "ink",
                "op": "add",
                "slideId": "drawn",
                "strokes": [_stroke("ink-b")],
            },
            "ink/drawn.svg",
        ),
    ],
)
def test_a_write_behind_someone_elses_is_refused(
    project: Path, first: dict[str, object], second: dict[str, object], file: str
) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    base = session.snapshot()
    before = {p: p.read_bytes() for p in project.rglob("*") if p.is_file()}
    session.apply({**first, **_ana(base)}, deck)
    written = {p: p.read_bytes() for p in project.rglob("*") if p.is_file()}
    assert written != before
    message = _stale(session, {**second, **_bo(base)}, deck)
    assert message.startswith(f"Ana changed {file} meanwhile")
    assert {p: p.read_bytes() for p in project.rglob("*") if p.is_file()} == written
    # Ana's own next edit from the same page goes through (her rebuild is
    # on its way), and so does Bo's once his page has the newer build.
    session.apply({**first, **_ana(base)}, deck)
    fresh = session.snapshot()
    session.apply({**second, **_bo(fresh)}, load_deck(project / "deck.py"))


def test_an_svg_edit_behind_someone_elses_names_them(project: Path) -> None:
    from inkflow.deps import file_hash

    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    drawn = project / "slides" / "drawn.svg"
    seen = file_hash(drawn.read_bytes())
    base = session.snapshot()

    def move(x: int) -> dict[str, object]:
        return {
            "action": "svg",
            "file": str(drawn),
            "hash": seen,
            "ops": [{"kind": "attrs", "loc": "0:0", "set": {"x": str(x)}}],
        }

    session.apply({**move(5), **_ana(base)}, deck)
    assert _stale(session, {**move(9), **_bo(base)}, deck).startswith(
        "Ana changed slides/drawn.svg meanwhile"
    )


def test_chart_data_behind_someone_elses_is_refused(tmp_path: Path) -> None:
    from tests import test_chartedit

    for name, text in {
        "slides/drawing.svg": test_chartedit.DRAWING,
        "data/sales.csv": test_chartedit.SALES,
        "deck.py": test_chartedit.DECK,
    }.items():
        (tmp_path / name).parent.mkdir(exist_ok=True)
        (tmp_path / name).write_text(text)
    deck = load_deck(tmp_path / "deck.py")
    session = EditorSession(tmp_path / "deck.py")
    base = session.snapshot()

    def save(cost: str) -> dict[str, object]:
        columns = ["quarter", "revenue", "cost"]
        table = {"columns": columns, "rows": [["Q1", "1", cost]]}
        return {
            "action": "chart-save-data",
            "slide": 1,
            "zone": "sales",
            "table": table,
        }

    session.apply({**save("2"), **_ana(base)}, deck)
    assert _stale(session, {**save("3"), **_bo(base)}, deck).startswith(
        "Ana changed data/sales.csv meanwhile"
    )


def test_a_change_outside_the_editor_is_not_overwritten(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    base = session.snapshot()
    notes = project / "notes" / "intro.md"
    notes.write_text("typed in a text editor\n")
    message = _stale(
        session, {"action": "notes", "slide": 1, "text": "x", **_ana(base)}, deck
    )
    assert "outside the editor" in message
    assert notes.read_text() == "typed in a text editor\n"
    # Without a build to compare with (an agent's command), as before.
    session.apply(
        {"action": "notes", "slide": 1, "text": "agent", "_local": True}, deck
    )


def test_a_page_too_far_behind_is_told_to_update(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    assert "out of date" in _stale(
        session, {"action": "notes", "slide": 1, "text": "x", **_ana(12345)}, deck
    )


@pytest.mark.parametrize(
    "rel",
    [
        "helpers.py",
        "assets/run.sh",
        "pyproject.toml",
        ".git/hooks/pre-commit",
        ".env",
        "assets/.hidden.png",
    ],
)
def test_a_guest_never_writes_code_or_hidden_files(project: Path, rel: str) -> None:
    import base64

    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    drawn = project / "slides" / "drawn.svg"
    paste: dict[str, object] = {
        "action": "paste-objects",
        "file": str(drawn),
        "fragments": [],
        "files": {
            rel: {"role": "asset", "data": base64.b64encode(b"echo hi").decode()}
        },
    }
    before = drawn.read_bytes()
    with pytest.raises(EditError, match="only an editor on this machine"):
        session.apply({**paste, "_author": "guest:ana", "_role": "editor"}, deck)
    assert not (project / rel).exists() and drawn.read_bytes() == before
    assert not session.history.done
    # The owner pastes what their own clipboard holds.
    _ = session.apply({**paste, "_local": True}, deck)
    assert (project / rel).exists()


def test_a_guest_still_edits_deck_py(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    guest = {"_author": "guest:ana", "_role": "editor"}
    _ = session.apply(
        {"action": "slide", "op": "title", "slide": 1, "title": "Ana", **guest}, deck
    )
    assert 'title="Ana"' in (project / "deck.py").read_text()


def test_a_guest_copies_pictures_not_hidden_files(project: Path) -> None:
    _ = (project / ".env").write_text("SECRET=1")
    session = EditorSession(project / "deck.py")
    request: dict[str, object] = {"action": "copy-assets", "refs": [".env"]}
    guest = session.apply({**request, "_role": "editor"}, None)
    assert guest["files"] == {}
    owner = session.apply({**request, "_local": True}, None)
    assert ".env" in cast("dict[str, object]", owner["files"])


def _forward(target: int) -> tuple[int, threading.Event]:
    """A local port forwarded to ``target``, as ``ssh -L`` does: the server
    sees a connection from this machine, naming the forwarded port."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    listener.settimeout(0.2)
    port = cast("tuple[str, int]", listener.getsockname())[1]
    stop = threading.Event()

    def pipe(a: socket.socket, b: socket.socket) -> None:
        try:
            while data := a.recv(65536):
                b.sendall(data)
        except OSError:
            pass
        finally:
            for s in (a, b):
                with contextlib.suppress(OSError):
                    s.shutdown(socket.SHUT_RDWR)

    def accept() -> None:
        with listener:
            while not stop.is_set():
                try:
                    client = listener.accept()[0]
                except TimeoutError:
                    continue
                upstream = socket.create_connection(("127.0.0.1", target))
                for a, b in ((client, upstream), (upstream, client)):
                    threading.Thread(target=pipe, args=(a, b), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    return port, stop


def test_an_ssh_tunnel_is_the_owner(shared: tuple[EditorSession, int]) -> None:
    _, port = shared
    forwarded, stop = _forward(port)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", forwarded, timeout=10)
        conn.request("GET", "/edit", headers={"Host": f"localhost:{forwarded}"})
        assert conn.getresponse().status == 200
        conn.close()
        # The page at the forwarded address opens the socket there.
        with connect(
            f"ws://localhost:{forwarded}/_inkflow/ws",
            proxy=None,
            origin=cast("object", f"http://localhost:{forwarded}"),  # pyright: ignore[reportArgumentType]
        ) as ws:
            assert _until(ws, "welcome")["role"] == "owner"
    finally:
        stop.set()


def test_the_terminal_shows_the_owner_link_in_ssh_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from inkflow_editor.server import EditorExtension

    # With the editor on the server, the owner's page is the editor.
    monkeypatch.setattr(server._served, "extensions", [EditorExtension()])  # pyright: ignore[reportPrivateUsage]
    access = Access(7777, names=set(), ssh=True, sharing=True)
    owner = server.owner_lines(access, 7777)
    assert owner[0] == f"http://localhost:7777/edit?k={access.owner_token}"
    assert owner[1].startswith("open it through: ssh -L 7777:localhost:7777 ")
    lines = server.share_lines(access, 7777)
    assert lines[0] == f"edit  http://localhost:7777/edit?k={access.editor_token}"
    assert any("ssh -N -L 7777:localhost:7777" in line for line in lines)
    assert server.owner_lines(Access(7777, names=set()), 7777) == []


@pytest.fixture
def ssh_mode(served: tuple[EditorSession, int]) -> Iterator[tuple[EditorSession, int]]:
    """The deck served in SSH mode, not shared yet."""
    session, port = served
    server._share.access = Access(port, names=set(), ssh=True)  # pyright: ignore[reportPrivateUsage]
    try:
        yield session, port
    finally:
        server._share.access = Access(server.DEFAULT_PORT)  # pyright: ignore[reportPrivateUsage]
        server._share.ssh_info = None  # pyright: ignore[reportPrivateUsage]


def test_ssh_mode_asks_this_machine_for_the_owner_link(
    ssh_mode: tuple[EditorSession, int],
) -> None:
    _, port = ssh_mode
    owner = server._share.access.owner_token  # pyright: ignore[reportPrivateUsage]
    status, _, body = _get(port, "/edit")
    assert status == 401 and b"owner link" in body and owner.encode() not in body
    with pytest.raises(InvalidStatus) as refused:
        _ws(port)
    assert refused.value.response.status_code == 401
    status, headers, body = _get(port, f"/edit?k={owner}")
    assert status == 200 and owner not in body.decode()
    assert headers["set-cookie"].startswith(f"inkflow-owner-{port}={owner};")
    signed_in = {"Cookie": f"inkflow-owner-{port}={owner}"}
    assert _get(port, "/edit", signed_in)[0] == 200
    with _ws(port, signed_in) as ws:
        assert _until(ws, "welcome")["role"] == "owner"
    url = f"ws://localhost:{port}/_inkflow/ws?k={owner}"
    with connect(url, proxy=None) as ws:  # a command, with the token
        assert _until(ws, "welcome")["role"] == "owner"


def test_ssh_mode_shares_through_tunnels(ssh_mode: tuple[EditorSession, int]) -> None:
    _, port = ssh_mode
    access = server._share.access  # pyright: ignore[reportPrivateUsage]
    signed_in = {"Cookie": f"inkflow-{port}={access.owner_token}"}
    with _ws(port, signed_in) as owner:
        owner.send(json.dumps({"type": "share", "op": "status"}))
        status = _until(owner, "share-status")
        assert status["ssh"] is True and status["sharing"] is False
        info = cast("dict[str, object]", status["sshInfo"])
        assert info["port"] == port and info["deck"] == "deck.py"
        assert isinstance(info["serverNames"], list) and info["user"]
        owner.send(json.dumps({"type": "share", "op": "on"}))
        status = _until(owner, "share-status")
        assert status["sharing"] is True and status["names"] == []
        links = cast("list[dict[str, str]]", status["links"])
        assert [link["address"] for link in links] == ["localhost"]
        assert links[0]["editor"] == (
            f"http://localhost:{port}/edit?k={access.editor_token}"
        )
    # A collaborator forwards another local port: ssh -L <forwarded>:…:<port>.
    forwarded, stop = _forward(port)
    try:
        here = f"localhost:{forwarded}"

        def get(path: str, headers: dict[str, str]) -> tuple[int, str]:
            conn = http.client.HTTPConnection("127.0.0.1", forwarded, timeout=10)
            conn.request("GET", path, headers={"Host": here, **headers})
            response = conn.getresponse()
            _ = response.read()
            conn.close()
            return response.status, response.getheader("set-cookie") or ""

        assert get("/edit", {})[0] == 401
        status, cookie = get(f"/edit?k={access.editor_token}", {})
        assert status == 200
        assert cookie.startswith(f"inkflow-{forwarded}={access.editor_token};")
        guest = {"Cookie": cookie.split(";")[0]}
        assert get("/edit", guest)[0] == 200
        with connect(
            f"ws://{here}/_inkflow/ws",
            proxy=None,
            origin=cast("object", f"http://{here}"),  # pyright: ignore[reportArgumentType]
            additional_headers=guest,
        ) as ws:
            assert _until(ws, "welcome")["role"] == "editor"
        viewer = f"inkflow-{forwarded}={access.viewer_token}"
        assert get("/edit", {"Cookie": viewer})[0] == 403
    finally:
        stop.set()


def test_commands_on_this_machine_send_the_owner_token(
    ssh_mode: tuple[EditorSession, int],
    project: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import os
    import stat

    from click.testing import CliRunner

    from inkflow import instances
    from inkflow.cli import main

    _, port = ssh_mode
    token = server._share.access.owner_token  # pyright: ignore[reportPrivateUsage]
    deck = str(project / "deck.py")
    record = instances.Instance(
        os.getpid(), "127.0.0.1", port, port, deck, owner_token=token
    )
    instances.register(record)
    folder = instances._dir()  # pyright: ignore[reportPrivateUsage]
    if os.name == "posix":
        assert stat.S_IMODE(folder.stat().st_mode) == 0o700
        written = folder / f"{os.getpid()}.json"
        assert stat.S_IMODE(written.stat().st_mode) == 0o600
    found = instances.running()
    assert found == [record] and found[0].owner_token == token
    assert record.ws_url() == f"ws://127.0.0.1:{port}/_inkflow/ws?k={token}"
    assert record.owner_url("/edit") == f"http://127.0.0.1:{port}/edit?k={token}"
    assert record.url("/edit") == f"http://127.0.0.1:{port}/edit"
    without = instances.Instance(os.getpid(), "127.0.0.1", port, port, deck)
    assert instances.probe(without) is None  # refused: not the owner

    def serving(_deck: Path, _exclude_pid: int | None = None) -> instances.Instance:
        return record

    monkeypatch.setattr(instances, "serving", serving)
    goto = CliRunner().invoke(main, ["goto", "2", "--deck", deck])
    assert goto.exit_code == 0, goto.output
    out = slides_tests._ok(project, "hide", "2")  # pyright: ignore[reportPrivateUsage]
    assert "Ctrl+Z in the editor" in out  # applied by the server, as the owner
