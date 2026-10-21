"""Who may reach the server and as whom (access.py: DNS rebinding, cross-site
WebSockets, share links and their roles, SSH mode), the one port (pages and
WebSocket), and sharing (on/off, new links, sending a guest away)."""

from __future__ import annotations

import asyncio
import json
import socket
import threading
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import cast

import pytest
from typing_extensions import override
from websockets.exceptions import ConnectionClosed, InvalidStatus

from inkflow import server
from inkflow.access import (
    Access,
    Request,
    Role,
    enter_page,
    lan_addresses,
    parse_request,
    split_host,
)
from inkflow.extensions import ServerExtension
from tests.serving import (
    GUEST,
    UI,
    fetch,
    guest,
    make_project,
    open_ws,
    serve_on_a_thread,
    until,
    upgrade,
)


def _req(target: str = "/", **headers: str) -> Request:
    head = f"GET {target} HTTP/1.1\r\n" + "".join(
        f"{k}: {v}\r\n" for k, v in headers.items()
    )
    parsed = parse_request((head + "\r\n").encode())
    assert parsed is not None
    return parsed


@pytest.mark.parametrize(
    ("host", "ok"),
    [
        ("localhost:7777", True),
        ("127.0.0.1:7777", True),
        ("[::1]:7777", True),
        ("deck.localhost", True),
        ("192.168.1.5:7777", True),
        ("100.101.102.103", True),  # a tailnet address
        ("[fd7a:115c::1]:7777", True),
        ("evil.example:7777", False),  # DNS rebinding: a name not ours
        ("localhost.evil.example", False),
        ("", False),
        (None, False),
    ],
)
def test_host_names_this_machine_or_nothing(host: str | None, ok: bool) -> None:
    access = Access(7777, names={"studio", "studio.local"})
    assert access.host_ok(host) is ok


def test_own_names_and_allowed_ones() -> None:
    access = Access(7777, names={"studio", "studio.local"}, allow_hosts={"box.ts.net"})
    assert access.host_ok("studio:7777") and access.host_ok("STUDIO.local:7777")
    assert access.host_ok("box.ts.net")
    assert not access.host_ok("other.ts.net")


@pytest.mark.parametrize(
    ("origin", "host", "ok"),
    [
        (None, "localhost:7777", True),  # a program, not a page
        ("http://localhost:7777", "localhost:7777", True),
        ("http://127.0.0.1:7777", "127.0.0.1:7777", True),
        ("http://localhost:8000", "localhost:8000", True),  # through ssh -L
        ("http://192.168.1.5:7777", "192.168.1.5:7777", True),
        ("http://evil.example", "localhost:7777", False),  # hijacking
        ("http://evil.example:7777", "evil.example:7777", False),  # rebinding
        ("null", "localhost:7777", False),
        ("http://localhost:7777", "localhost:7778", False),
        ("http://localhost:9999", "localhost:7777", False),
        ("file://", "localhost:7777", False),
    ],
)
def test_origin_is_a_page_of_this_server(
    origin: str | None, host: str, ok: bool
) -> None:
    assert Access(7777, names=set()).origin_ok(origin, host) is ok


def test_an_https_proxy_in_front_passes_its_name() -> None:
    # tailscale serve: https://box.tail1234.ts.net -> http://localhost:7777,
    # Host passed on without a port.
    access = Access(7777, allow_hosts={"box.tail1234.ts.net"}, names=set())
    assert access.origin_ok("https://box.tail1234.ts.net", "box.tail1234.ts.net")
    assert not access.origin_ok("https://evil.example", "box.tail1234.ts.net")
    assert not access.origin_ok(
        "https://box.tail1234.ts.net:8443", "box.tail1234.ts.net"
    )
    # Relayed by a proxy on this machine: a guest, never the owner.
    request = _req("/", Host="box.tail1234.ts.net", **{"Tailscale-User-Login": "a"})
    assert not access.is_owner("127.0.0.1", request)


def test_old_websocket_port_takes_the_http_ports_pages() -> None:
    access = Access(7777, names=set())
    page = "http://localhost:7777"
    assert not access.origin_ok(page, "localhost:7778")
    assert access.origin_ok(page, "localhost:7778", port=7777)
    assert not access.origin_ok("http://evil.example:7777", "localhost:7778", port=7777)


def test_the_owner_is_this_machine_by_its_own_name() -> None:
    access = Access(7777, names=set())
    assert access.is_owner("127.0.0.1", _req(Host="localhost:7777"))
    assert access.is_owner("::1", _req(Host="[::1]:7777"))
    assert access.is_owner("::ffff:127.0.0.1", _req(Host="127.0.0.1:7777"))
    # A reverse proxy on this machine relays others: they are guests.
    assert not access.is_owner("127.0.0.1", _req(Host="box.ts.net"))
    assert not access.is_owner(
        "127.0.0.1", _req(Host="localhost:7777", **{"X-Forwarded-For": "10.0.0.2"})
    )
    assert not access.is_owner("192.168.1.9", _req(Host="localhost:7777"))
    assert not access.is_owner(None, _req(Host="localhost:7777"))


def test_tokens_admit_while_shared_and_until_new_links() -> None:
    access = Access(7777, names=set())
    lan = "192.168.1.9"
    editor, viewer = access.editor_token, access.viewer_token
    assert len(editor) >= 22 and editor != viewer
    link = _req(f"/edit?k={editor}", Host="192.168.1.5:7777")
    assert access.admit(lan, link) == (None, None)  # not shared
    access.sharing = True
    assert access.admit(lan, link) == ("editor", editor)
    cookie = _req("/", Host="h", Cookie=f"a=b; inkflow-7777={viewer}")
    assert access.admit(lan, cookie) == ("viewer", viewer)
    other_port = _req("/", Host="h", Cookie=f"inkflow-7779={viewer}")
    assert access.admit(lan, other_port) == (None, None)
    assert access.admit(lan, _req("/?k=nope", Host="h")) == (None, None)
    access.rotate()
    assert access.admit(lan, link) == (None, None)
    assert access.admit(lan, cookie) == (None, None)


def test_cookie_and_links() -> None:
    access = Access(7777, names=set(), sharing=True)
    assert access.set_cookie("t") == "inkflow-7777=t; Path=/; HttpOnly; SameSite=Strict"
    assert access.set_cookie("t").endswith(
        "Strict"
    ) and "Secure" not in access.set_cookie("t")
    assert Access(7777, tls=True).set_cookie("t").endswith("; Secure")
    links = access.links(["192.168.1.5", "fd7a::1"])
    assert "editor" not in links[0]  # nothing on the server edits
    assert links[0]["view"] == f"http://192.168.1.5:7777/?k={access.viewer_token}"
    assert links[1]["view"].startswith("http://[fd7a::1]:7777/?k=")
    links = access.links(["192.168.1.5"], "/edit")
    assert links[0]["editor"] == f"http://192.168.1.5:7777/edit?k={access.editor_token}"


def test_the_token_leaves_the_address() -> None:
    req = _req("/edit?k=secret&compare=HEAD%7E1#x", Host="h")
    assert req.without_token() == "/edit?compare=HEAD~1"
    assert _req("/?k=secret", Host="h").without_token() == "/"
    page = enter_page('/edit?a="<x>').decode()
    assert "secret" not in page and "\\u003cx>" in page and "&lt;x&gt;" in page


def test_split_host() -> None:
    assert split_host("[::1]:7777") == ("::1", 7777)
    assert split_host("Box.Local:80") == ("box.local", 80)
    assert split_host("localhost") == ("localhost", None)
    assert split_host("::1") == ("::1", None)


def test_lan_addresses_are_never_loopback() -> None:
    for address in lan_addresses():
        assert not address.startswith("127.") and address != "::1"


def test_sharing_moves_the_listener_and_keeps_connections() -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = cast("tuple[str, int]", probe.getsockname())[1]
    got: list[bytes] = []

    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        while line := await reader.readline():
            writer.write(line)
            await writer.drain()
        writer.close()

    async def run() -> None:
        listener = server.Listener(handler, port, None)
        await listener.open("127.0.0.1")
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        await listener.move(None)  # every interface: shared
        writer.write(b"still here\n")
        await writer.drain()
        got.append(await reader.readline())
        r2, w2 = await asyncio.open_connection("127.0.0.1", port)
        w2.write(b"new\n")
        await w2.drain()
        got.append(await r2.readline())
        await listener.move("127.0.0.1")
        writer.close()
        w2.close()
        listener.close()

    asyncio.run(run())
    assert got == [b"still here\n", b"new\n"]


def test_tls_serves_on_the_one_port(tmp_path: Path) -> None:
    import shutil
    import subprocess

    from inkflow.instances import Instance, loopback_tls

    openssl = shutil.which("openssl")
    if openssl is None:
        pytest.skip("no openssl to make a certificate")
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    made = subprocess.run(
        [
            openssl,
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-keyout",
            str(key),
            "-out",
            str(cert),
        ],
        capture_output=True,
        check=False,
    )
    if made.returncode != 0:
        pytest.skip("openssl could not make a certificate")
    context = server._tls_context((cert, key))  # pyright: ignore[reportPrivateUsage]
    got: list[bytes] = []

    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        writer.write(await reader.readline())
        await writer.drain()
        writer.close()

    async def run() -> None:
        listener = server.Listener(handler, 0, context)
        await listener.open("127.0.0.1")
        assert listener.server is not None
        port = cast("tuple[str, int]", listener.server.sockets[0].getsockname())[1]
        reader, writer = await asyncio.open_connection(
            "127.0.0.1", port, ssl=loopback_tls()
        )
        writer.write(b"over tls\n")
        await writer.drain()
        got.append(await reader.readline())
        writer.close()
        listener.close()

    asyncio.run(run())
    assert got == [b"over tls\n"]
    instance = Instance(1, "localhost", 7777, 7777, None, tls=True)
    assert instance.ws_url() == "wss://localhost:7777/_inkflow/ws"
    assert instance.url("/edit") == "https://localhost:7777/edit"
    assert (
        Access(7777, tls=True, sharing=True)
        .links(["10.0.0.2"])[0]["view"]
        .startswith("https://10.0.0.2:7777/?k=")
    )


def test_where_a_shared_server_listens() -> None:
    lan_host = server._lan_host  # pyright: ignore[reportPrivateUsage]
    assert lan_host("localhost") is None  # --share: every interface
    assert lan_host("0.0.0.0") is None
    # A VPN address only, and this machine for the owner's own pages.
    assert lan_host("100.101.102.103") == ["100.101.102.103", "localhost"]
    assert server._shares("100.101.102.103") and not server._shares("127.0.0.1")  # pyright: ignore[reportPrivateUsage]


def test_in_ssh_mode_this_machine_needs_the_owner_token() -> None:
    access = Access(7777, names=set(), ssh=True)
    owner = access.owner_token
    local = "127.0.0.1"
    page = _req("/edit", Host="localhost:7777")
    assert access.admit(local, page) == (None, None)  # another user, say
    link = _req(f"/edit?k={owner}", Host="localhost:7777")
    assert access.admit(local, link) == ("owner", owner)
    cookie = _req("/edit", Host="localhost:7777", Cookie=f"inkflow-7777={owner}")
    assert access.admit(local, cookie) == ("owner", owner)
    assert access.is_owner(local, cookie) and not access.is_owner(local, page)
    # Only from this machine (a tunnel's end), never relayed or from afar.
    assert access.admit("192.168.1.9", link) == (None, None)
    relayed = _req(f"/edit?k={owner}", Host="localhost:7777", **GUEST)
    assert access.admit(local, relayed) == (None, None)
    # Share links through the tunnels, while shared.
    editor = _req(f"/edit?k={access.editor_token}", Host="localhost:7777")
    viewer = _req(f"/?k={access.viewer_token}", Host="localhost:7777")
    assert access.admit(local, editor) == (None, None)
    access.sharing = True
    assert access.admit(local, editor) == ("editor", access.editor_token)
    assert access.admit(local, viewer) == ("viewer", access.viewer_token)
    # New links leave the owner in.
    access.rotate()
    assert access.admit(local, editor) == (None, None)
    assert access.admit(local, cookie) == ("owner", owner)
    assert access.owner_path("/edit") == f"/edit?k={owner}"
    assert access.owner_path("/edit?compare=x") == f"/edit?compare=x&k={owner}"


def test_the_owner_cookie_survives_opening_a_share_link() -> None:
    access = Access(7777, names=set(), ssh=True, sharing=True)
    owner, editor = access.owner_token, access.editor_token
    assert access.set_cookie(owner, "localhost:8000").startswith(
        f"inkflow-owner-8000={owner};"
    )
    assert access.set_cookie(editor, "localhost:8000").startswith(
        f"inkflow-8000={editor};"
    )
    # The owner's browser opened an editor link: both cookies now.
    both = f"inkflow-owner-8000={owner}; inkflow-8000={editor}"
    page = _req("/edit", Host="localhost:8000", Cookie=both)
    assert access.admit("127.0.0.1", page) == ("owner", owner)
    # The owner cookie counts only from this machine.
    assert access.admit("192.168.1.9", page)[0] != "owner"


def test_without_ssh_mode_this_machine_is_the_owner_as_ever() -> None:
    access = Access(7777, names=set())
    page = _req("/edit", Host="localhost:7777")
    assert access.admit("127.0.0.1", page) == ("owner", None)
    # The owner token means nothing outside SSH mode.
    link = _req(f"/edit?k={access.owner_token}", Host="192.168.1.5:7777")
    assert access.admit("192.168.1.9", link) == (None, None)
    assert access.owner_path("/edit") == "/edit"


def test_a_different_local_port_keeps_its_cookie_and_origin() -> None:
    # ssh -L 8000:localhost:7777: the browser sees localhost:8000.
    access = Access(7777, names=set(), ssh=True, sharing=True)
    token = access.editor_token
    assert access.set_cookie(token, "localhost:8000").startswith(
        f"inkflow-8000={token}; Path=/; HttpOnly; SameSite=Strict"
    )
    assert access.set_cookie(token, "box.example").startswith("inkflow-7777=")
    back = _req("/edit", Host="localhost:8000", Cookie=f"inkflow-8000={token}")
    assert access.admit("127.0.0.1", back) == ("editor", token)
    # Another server tunnelled to 8001 keeps its own cookie beside it.
    other = _req("/edit", Host="localhost:8001", Cookie=f"inkflow-8000={token}")
    assert access.admit("127.0.0.1", other) == (None, None)
    assert access.origin_ok("http://localhost:8000", "localhost:8000")
    assert not access.origin_ok("http://localhost:7777", "localhost:8000")


def test_ssh_mode_defaults_to_an_ssh_login(monkeypatch: pytest.MonkeyPatch) -> None:
    from inkflow.access import over_ssh, ssh_server_address
    from inkflow.cli.present import sharing

    login = "203.0.113.7 51234 198.51.100.2 22"
    assert over_ssh({"SSH_CONNECTION": login})
    assert over_ssh({"SSH_CLIENT": "203.0.113.7 51234 22"})
    assert not over_ssh({})
    assert ssh_server_address({"SSH_CONNECTION": login}) == "198.51.100.2"
    assert ssh_server_address({"SSH_CONNECTION": "::1 5 ::1 22"}) is None
    monkeypatch.delenv("SSH_CLIENT", raising=False)
    monkeypatch.setenv("SSH_CONNECTION", login)
    assert sharing(False, (), None, None).ssh
    assert not sharing(False, (), None, False).ssh  # --no-ssh
    monkeypatch.delenv("SSH_CONNECTION")
    assert not sharing(False, (), None, None).ssh
    assert sharing(False, (), None, True).ssh  # --ssh


def test_ssh_mode_never_listens_on_the_network() -> None:
    listen = server._listen_hosts  # pyright: ignore[reportPrivateUsage]
    assert listen("localhost", shared=True, ssh=False) is None  # the LAN
    assert listen("localhost", shared=True, ssh=True) == "localhost"
    assert listen("localhost", shared=False, ssh=True) == "localhost"
    # An explicit --host is the user's own choice, in either mode.
    assert listen("100.101.102.103", shared=False, ssh=True) == [
        "100.101.102.103",
        "localhost",
    ]


# ── The door, end to end ──────────────────────────────────────────────────────


@pytest.fixture
def shared(tmp_path: Path) -> Iterator[int]:
    """A deck served on the one port by the core alone, shared with links."""
    project = make_project(tmp_path)
    yield from serve_on_a_thread(project / "deck.py", [])


def _closed_with(ws: object) -> int | None:
    """Read until the server closes the connection; its close code."""
    from websockets.sync.client import ClientConnection

    conn = cast("ClientConnection", ws)
    with pytest.raises(ConnectionClosed) as closed:
        while True:
            _ = conn.recv(timeout=5)
    return closed.value.rcvd.code if closed.value.rcvd is not None else None


def test_pages_and_websocket_share_one_port(shared: int) -> None:
    port = shared
    status, headers, body = fetch(port, "/")
    # The page opens the socket on its own address, never a fixed host.
    assert status == 200 and b"<svg" in body and b"ws://localhost" not in body
    assert headers["x-frame-options"] == "SAMEORIGIN"
    assert headers["referrer-policy"] == "no-referrer"
    with open_ws(port) as ws:
        assert until(ws, "welcome")["role"] == "owner"
        ws.send(json.dumps({"type": "build-status"}))
        assert until(ws, "build-status")["deckHash"]
    # A deck's file, whole and by byte range (Safari's video).
    status, headers, body = fetch(port, "/slides/one.svg")
    assert status == 200 and headers["accept-ranges"] == "bytes"
    status, headers, part = fetch(port, "/slides/one.svg", {"Range": "bytes=5-9"})
    assert status == 206 and part == body[5:10]
    assert headers["content-range"] == f"bytes 5-9/{len(body)}"
    status, _, _ = fetch(port, "/slides/one.svg", {"Range": "bytes=99999-"})
    assert status == 416


def test_a_foreign_host_name_is_refused(shared: int) -> None:
    """DNS rebinding: a page on evil.example whose name now points at this
    machine still says ``Host: evil.example``."""
    port = shared
    evil = f"evil.example:{port}"
    for path in ("/", "/slides/one.svg", "/_inkflow/instance"):
        status, _, body = fetch(port, path, {"Host": evil})
        assert status == 403 and b"Unknown host" in body
    assert upgrade(port, evil, f"http://{evil}") == 403
    # The same handshake by the server's own name is taken.
    assert upgrade(port, f"localhost:{port}", f"http://localhost:{port}") == 101


def test_another_sites_page_cannot_open_the_websocket(shared: int) -> None:
    port = shared
    for origin in ("http://evil.example", "null", f"http://localhost:{port + 1}"):
        with pytest.raises(InvalidStatus) as refused:
            _ = open_ws(port, origin=origin)
        assert refused.value.response.status_code == 403
    with open_ws(port, origin=None) as ws:  # a program (a command)
        assert until(ws, "welcome")["role"] == "owner"


def test_guests_need_a_link(shared: int) -> None:
    port = shared
    access = server._share.access  # pyright: ignore[reportPrivateUsage]
    for path in ("/", "/slides/one.svg", "/_inkflow/instance"):
        assert fetch(port, path, GUEST)[0] == 401
    with pytest.raises(InvalidStatus) as refused:
        _ = open_ws(port, GUEST)
    assert refused.value.response.status_code == 401
    assert fetch(port, "/", guest(port, "not-a-token"))[0] == 401
    # The link sets the cookie and moves on without the token.
    status, headers, body = fetch(port, f"/?k={access.viewer_token}&x=1", GUEST)
    assert status == 200
    assert headers["set-cookie"] == (
        f"inkflow-{port}={access.viewer_token}; Path=/; HttpOnly; SameSite=Strict"
    )
    assert access.viewer_token not in body.decode() and "/?x=1" in body.decode()
    assert headers["referrer-policy"] == "no-referrer"


def test_a_viewer_follows_and_moves_no_one(shared: int) -> None:
    port = shared
    viewer = guest(port, server._share.access.viewer_token)  # pyright: ignore[reportPrivateUsage]
    assert fetch(port, "/", viewer)[0] == 200
    assert fetch(port, "/slides/one.svg", viewer)[0] == 200
    assert fetch(port, "/_inkflow/instance", viewer)[0] == 404  # the owner's
    # The handout shows the speaker notes: not for a view link.
    status, _, body = fetch(port, "/handout", viewer)
    assert status == 403 and b"View-only" in body
    status, _, body = fetch(port, "/handout?layout=compact&paper=letter")
    assert status == 200 and b"layout-compact" in body and b"8.5in 11in" in body
    status, _, body = fetch(port, "/_inkflow/instance")
    probe = cast("dict[str, object]", json.loads(body))
    assert status == 200 and str(probe["deck"]).endswith("deck.py")
    with open_ws(port, viewer) as ws, open_ws(port) as owner:
        assert until(ws, "welcome")["role"] == "viewer"
        _ = until(owner, "welcome")
        _ = until(owner, "position")  # where everyone is, on connecting
        # Its navigation moves no one; the owner's reaches it.
        ws.send(json.dumps({"type": "nav", "slideIndex": 1, "step": 0}))
        ws.send(json.dumps({"type": "share", "op": "rotate"}))  # the owner's
        owner.send(json.dumps({"type": "sync-request"}))
        assert until(owner, "position")["slideIndex"] == 0
        owner.send(json.dumps({"type": "nav", "slideIndex": 1, "step": 0}))
        while until(ws, "position")["slideIndex"] != 1:
            pass
    assert fetch(port, "/", viewer)[0] == 200  # the links still work


def test_the_owner_sees_and_sends_guests_away(shared: int) -> None:
    port = shared
    access = server._share.access  # pyright: ignore[reportPrivateUsage]
    with open_ws(port) as owner, open_ws(port, guest(port, access.viewer_token)) as ws:
        me = until(ws, "welcome")
        ws.send(json.dumps({"type": "hello", "role": "presenter"}))
        _ = until(owner, "welcome")
        while True:
            owner.send(json.dumps({"type": "share", "op": "status"}))
            status = until(owner, "share-status")
            people = cast("list[dict[str, object]]", status["people"])
            if any(p["id"] == me["id"] for p in people):
                break
        assert status["sharing"] is True and status["ssh"] is False
        links = cast("list[dict[str, str]]", status["links"])
        # Nothing on this server edits: view links only.
        assert all("editor" not in link for link in links)
        owner.send(json.dumps({"type": "share", "op": "kick", "id": me["id"]}))
        assert _closed_with(ws) == server.SENT_AWAY


def test_new_links_and_stopping_disconnect_guests(shared: int) -> None:
    port = shared
    access = server._share.access  # pyright: ignore[reportPrivateUsage]
    old = guest(port, access.viewer_token)
    with open_ws(port) as owner, open_ws(port, old) as ws:
        _ = until(ws, "welcome")
        owner.send(json.dumps({"type": "share", "op": "rotate"}))
        assert until(owner, "share-status")["sharing"] is True
        assert _closed_with(ws) == server.SENT_AWAY
    assert fetch(port, "/", old)[0] == 401
    fresh = guest(port, access.viewer_token)
    assert fetch(port, "/", fresh)[0] == 200
    with open_ws(port) as owner, open_ws(port, fresh) as ws:
        _ = until(ws, "welcome")
        owner.send(json.dumps({"type": "share", "op": "off"}))
        assert until(owner, "share-status")["sharing"] is False
        assert _closed_with(ws) == server.SENT_AWAY
    assert fetch(port, "/", fresh)[0] == 401
    assert fetch(port, "/")[0] == 200  # the owner, as ever


class _Editing(ServerExtension):
    """An extension that takes editors (one of its messages is theirs)."""

    name: str = "editing"
    messages: Mapping[str, Role] = {"change": "editor"}

    def __init__(self) -> None:
        self.extra_ops: list[str] = []

    @override
    async def share_op(self, op: str, msg: dict[str, object]) -> str | bool | None:
        del msg
        if op != "relay-on":
            return False
        self.extra_ops.append(op)
        return None

    @override
    def share_status(self) -> dict[str, object]:
        return {"relay": len(self.extra_ops)}

    @override
    def share_lines(self) -> list[str]:
        return ["relay  off"]


def test_editor_links_only_when_an_extension_edits(tmp_path: Path) -> None:
    project = make_project(tmp_path)
    editing = _Editing()
    for port in serve_on_a_thread(project / "deck.py", [editing]):
        access = server._share.access  # pyright: ignore[reportPrivateUsage]
        editor = guest(port, access.editor_token)
        assert fetch(port, "/", editor)[0] == 200
        with open_ws(port, editor) as ws, open_ws(port) as owner:
            assert until(ws, "welcome")["role"] == "editor"
            # An editor may say it is an editor page; it may not share.
            ws.send(json.dumps({"type": "share", "op": "rotate"}))
            owner.send(json.dumps({"type": "hello", "role": "dialog"}))
            owner.send(json.dumps({"type": "share", "op": "relay-on"}))
            status = until(owner, "share-status")
            assert status["relay"] == 1 and editing.extra_ops == ["relay-on"]
            links = cast("list[dict[str, str]]", status["links"])
            assert all(
                link["editor"].endswith(f"/?k={access.editor_token}") for link in links
            )
        assert fetch(port, "/", editor)[0] == 200  # not rotated by the editor
        lines = server.share_lines(access, port)
        assert lines[-1] == "relay  off"
        assert any(line.startswith("edit  ") for line in lines) or not links


def test_ssh_mode_asks_this_machine_for_the_owner_link(shared: int) -> None:
    port = shared
    access = Access(port, names=set(), ssh=True)
    server._share.access = access  # pyright: ignore[reportPrivateUsage]
    status, _, body = fetch(port, "/")
    assert status == 401 and b"Open the owner link" in body
    with pytest.raises(InvalidStatus) as refused:
        _ = open_ws(port)
    assert refused.value.response.status_code == 401
    status, headers, _ = fetch(port, f"/?k={access.owner_token}")
    assert status == 200
    cookie = headers["set-cookie"].split(";")[0]
    assert cookie == f"inkflow-owner-{port}={access.owner_token}"
    assert fetch(port, "/", {"Cookie": cookie})[0] == 200
    with open_ws(port, {"Cookie": cookie}) as ws:
        assert until(ws, "welcome")["role"] == "owner"
    # Never from another machine, whatever it carries.
    assert fetch(port, "/", {**GUEST, "Cookie": cookie})[0] == 401
    assert server.owner_lines(access, port)[0] == (
        f"http://localhost:{port}/?k={access.owner_token}"
    )


def test_the_old_websocket_port_has_the_same_door(shared: int) -> None:
    from websockets.asyncio.server import serve as ws_serve
    from websockets.sync.client import connect

    from inkflow.edit import NO_EDIT_COMMANDS
    from inkflow.tui import LiveUI

    port = shared
    ready = threading.Event()
    loop = asyncio.new_event_loop()
    stop = asyncio.Event()
    legacy: list[int] = []

    async def run() -> None:
        ui = cast("LiveUI", cast("object", UI()))
        handler = server.make_ws_handler(ui, NO_EDIT_COMMANDS)
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
    try:
        with pytest.raises(InvalidStatus):
            _ = connect(url, proxy=None, origin=cast("object", "http://evil.example"))  # pyright: ignore[reportArgumentType]
        page = cast("object", f"http://localhost:{port}")
        with connect(url, proxy=None, origin=page) as ws:  # pyright: ignore[reportArgumentType]
            assert until(ws, "welcome")["role"] == "owner"
    finally:
        loop.call_soon_threadsafe(stop.set)
        thread.join(10)
        loop.close()


class _Writer:
    def __init__(self) -> None:
        self.data: bytes = b""

    def write(self, data: bytes) -> None:
        self.data += data

    async def drain(self) -> None:
        pass


class _Virtual:
    """A page connection that came another way (a relay's), sending one
    message and then going away."""

    def __init__(self, messages: list[str]) -> None:
        self.sent: list[dict[str, object]] = []
        self._messages: list[str] = messages

    async def send(self, message: str) -> None:
        self.sent.append(cast("dict[str, object]", json.loads(message)))

    async def close(self, code: int = 1000, reason: str = "") -> None:
        del code, reason

    def __aiter__(self) -> _Virtual:
        return self

    async def __anext__(self) -> str:
        if not self._messages:
            raise StopAsyncIteration
        return self._messages.pop(0)


def test_connections_and_requests_that_came_another_way(tmp_path: Path) -> None:
    from inkflow.edit import NO_EDIT_COMMANDS
    from inkflow.tui import LiveUI

    project = make_project(tmp_path)
    ui = cast("LiveUI", cast("object", UI()))
    server._share.ws_handler = server.make_ws_handler(ui, NO_EDIT_COMMANDS)  # pyright: ignore[reportPrivateUsage]
    server._share.route = server.make_http_route(7777, project)  # pyright: ignore[reportPrivateUsage]
    server._state["position"] = {"slideIndex": 0, "step": 0}  # pyright: ignore[reportPrivateUsage]
    try:
        conn = _Virtual([json.dumps({"type": "nav", "slideIndex": 1, "step": 0})])
        asyncio.run(server.context.serve_connection(conn, "viewer"))
        assert conn.sent[0] == {
            "type": "welcome",
            "id": conn.sent[0]["id"],
            "role": "viewer",
        }
        assert server._state["position"]["slideIndex"] == 0  # pyright: ignore[reportPrivateUsage]
        assert server.context.people.get(conn) is None  # gone when it closed
        writer = _Writer()
        asyncio.run(
            server.context.serve_request(
                "/slides/one.svg", "bytes=0-4", "viewer", writer
            )
        )
        assert writer.data.startswith(b"HTTP/1.1 206 Partial Content")
        assert writer.data.endswith(b"<svg ")
    finally:
        server._share.ws_handler = None  # pyright: ignore[reportPrivateUsage]
        server._share.route = None  # pyright: ignore[reportPrivateUsage]


def test_ports_are_picked_from_7777_up(monkeypatch: pytest.MonkeyPatch) -> None:
    with socket.socket() as busy:
        busy.bind(("localhost", 0))
        busy.listen()
        port = cast("int", busy.getsockname()[1])
        # Given, a port is used as given (a clash is reported when binding).
        assert server.pick_port("localhost", port) == port
        assert not server._port_free("localhost", port)  # pyright: ignore[reportPrivateUsage]
        monkeypatch.setattr(server, "DEFAULT_PORT", port)
        assert server.pick_port("localhost", None) != port


def test_byte_ranges() -> None:
    assert server.byte_range(100, None) is None
    assert server.byte_range(100, (0, None)) == (0, 99)
    assert server.byte_range(100, (10, 19)) == (10, 19)
    assert server.byte_range(100, (90, 500)) == (90, 99)
    assert server.byte_range(100, (None, 10)) == (90, 99)
    with pytest.raises(ValueError):
        _ = server.byte_range(100, (100, None))
