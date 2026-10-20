"""Editing together: who may reach the server and as whom (access.py), the
one port (pages and WebSocket), sharing, presence, undo per person, and
writes refused when the page was behind someone else's edit."""

from __future__ import annotations

import asyncio
import socket
from pathlib import Path
from typing import cast

import pytest

from inkflow import server
from inkflow.access import (
    Access,
    Request,
    enter_page,
    lan_addresses,
    parse_request,
    split_host,
)

GUEST = {"X-Forwarded-For": "192.0.2.50"}


"""A request relayed from elsewhere: whatever its socket, not the owner's."""


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
