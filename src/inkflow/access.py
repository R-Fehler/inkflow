"""Who may reach a running server, and as whom.

Three roles: the **owner** is a page or command on this machine (a loopback
connection that names the server by a loopback name and came through no
proxy, so an SSH tunnel counts and a reverse proxy does not); an **editor**
and a **viewer** come with a share link, whose token sets a cookie. Every
request is checked twice before anything else: its ``Host`` must be a name
this machine answers to (no DNS rebinding: a page on ``evil.example`` whose
name now points at 127.0.0.1 still says ``Host: evil.example``), and a
WebSocket handshake that carries an ``Origin`` must come from a page this
server served (no cross-site WebSocket hijacking: any web page may open a
socket to localhost, but its ``Origin`` is its own).

Pure: no sockets are opened here except to list this machine's addresses.
"""

from __future__ import annotations

import contextlib
import ipaddress
import secrets
import socket
import sys
from dataclasses import dataclass, field
from html import escape
from typing import Literal, cast
from urllib.parse import parse_qsl, quote, urlsplit

Role = Literal["owner", "editor", "viewer"]

WS_PATH = "/_inkflow/ws"
"""Where pages open the server's WebSocket (on the HTTP port)."""

COOKIE_PREFIX = "inkflow-"
TOKEN_PARAM = "k"

_LOOPBACK_NAMES = frozenset({"localhost", "127.0.0.1", "::1"})
_FORWARDED = (
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-real-ip",
    "tailscale-user-login",
)
"""Headers a reverse proxy adds: a request carrying one came from elsewhere,
whatever the connection's own address says."""


@dataclass(frozen=True)
class Request:
    """One HTTP request head, as far as routing and access need it."""

    method: str
    target: str
    path: str
    query: dict[str, str]
    headers: dict[str, str]
    """Lower-case names; a repeated header keeps its first value (cookies
    are joined)."""

    @property
    def host(self) -> str | None:
        return self.headers.get("host")

    @property
    def is_websocket(self) -> bool:
        return "websocket" in self.headers.get("upgrade", "").lower()

    def without_token(self) -> str:
        """The request's target with the share token taken out."""
        rest = [
            (k, v)
            for k, v in parse_qsl(urlsplit(self.target).query, keep_blank_values=True)
            if k != TOKEN_PARAM
        ]
        query = "&".join(f"{quote(k)}={quote(v)}" for k, v in rest)
        return self.path + (f"?{query}" if query else "")


def parse_request(head: bytes) -> Request | None:
    """The request line and headers of ``head`` (bytes up to the blank line)."""
    lines = head.decode("latin-1").split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) < 2:
        return None
    method, target = parts[0], parts[1]
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if not line:
            break
        name, sep, value = line.partition(":")
        if not sep:
            continue
        key, value = name.strip().lower(), value.strip()
        if key == "cookie" and key in headers:
            headers[key] += "; " + value
        else:
            _ = headers.setdefault(key, value)
    split = urlsplit(target)
    query = dict(parse_qsl(split.query, keep_blank_values=True))
    return Request(method, target, split.path or "/", query, headers)


def split_host(value: str) -> tuple[str, int | None]:
    """``("::1", 7777)`` from ``"[::1]:7777"``; the name lower-cased."""
    value = value.strip().lower()
    port: int | None = None
    if value.startswith("["):
        name, _, rest = value[1:].partition("]")
        if rest.startswith(":") and rest[1:].isdigit():
            port = int(rest[1:])
        return name, port
    name, sep, rest = value.rpartition(":")
    if sep and rest.isdigit() and ":" not in name:
        return name, int(rest)
    return value, None


def is_ip(name: str) -> bool:
    try:
        _ = ipaddress.ip_address(name)
    except ValueError:
        return False
    return True


def is_loopback_ip(address: str | None) -> bool:
    if not address:
        return False
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return ip.ipv4_mapped.is_loopback
    return ip.is_loopback


def is_loopback_name(name: str) -> bool:
    return (
        name in _LOOPBACK_NAMES or name.endswith(".localhost") or is_loopback_ip(name)
    )


def peer_host(peername: object) -> str | None:
    """The address of a socket's peer (``peername`` as asyncio gives it)."""
    if isinstance(peername, tuple) and peername:
        return str(peername[0])  # pyright: ignore[reportUnknownArgumentType]
    return str(peername) if isinstance(peername, str) else None


def machine_names() -> set[str]:
    """Names this machine answers to besides IP literals: its host name,
    that name in mDNS (``.local``) and its fully qualified name."""
    names: set[str] = set()
    with contextlib.suppress(OSError):
        host = socket.gethostname().lower()
        if host:
            names |= {host, f"{host.split('.')[0]}.local"}
    with contextlib.suppress(OSError):
        fqdn = socket.getfqdn().lower()
        if fqdn and fqdn != "localhost":
            names.add(fqdn)
    return names


def lan_addresses() -> list[str]:
    """This machine's addresses other machines can reach it at: LAN, VPN
    (a Tailscale or WireGuard interface is one more), never loopback or
    link-local. IPv4 first."""
    found: list[str] = []

    def add(address: str) -> None:
        try:
            ip = ipaddress.ip_address(address.split("%", 1)[0])
        except ValueError:
            return
        if ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast:
            return
        if str(ip) not in found:
            found.append(str(ip))

    # The address of the default route (no packet is sent).
    for family, probe in (
        (socket.AF_INET, "192.0.2.1"),
        (socket.AF_INET6, "2001:db8::1"),
    ):
        with (
            contextlib.suppress(OSError),
            socket.socket(family, socket.SOCK_DGRAM) as s,
        ):
            s.connect((probe, 9))
            add(str(cast("tuple[object, ...]", s.getsockname())[0]))
    if sys.platform.startswith("linux"):
        for address in _linux_ipv4_addresses():
            add(address)
    with contextlib.suppress(OSError):
        for info in socket.getaddrinfo(socket.gethostname(), None):
            add(str(info[4][0]))
    return sorted(found, key=lambda a: (":" in a, found.index(a)))


def _linux_ipv4_addresses() -> list[str]:
    """Every interface's IPv4 address (a VPN's too), by ioctl."""
    import fcntl
    import struct

    out: list[str] = []
    with (
        contextlib.suppress(OSError),
        socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s,
    ):
        for _index, name in socket.if_nameindex():
            packed = struct.pack("256s", name.encode()[:15])
            try:
                answer = fcntl.ioctl(s.fileno(), 0x8915, packed)  # SIOCGIFADDR
            except OSError:
                continue
            out.append(socket.inet_ntoa(answer[20:24]))
    return out


def url_host(address: str) -> str:
    return f"[{address}]" if ":" in address else address


def new_token() -> str:
    """128 bits and more, URL-safe."""
    return secrets.token_urlsafe(18)


@dataclass
class Access:
    """The server's door: allowed names, share tokens, and who a request is."""

    port: int
    """The port this server listens on (cookies are named after it)."""
    allow_hosts: set[str] = field(default_factory=set)
    """Further names to answer to (a reverse proxy's, ``--allow-host``)."""
    tls: bool = False
    sharing: bool = False
    """Whether share links admit anyone now."""
    editor_token: str = field(default_factory=new_token)
    viewer_token: str = field(default_factory=new_token)
    names: set[str] = field(default_factory=machine_names)

    @property
    def scheme(self) -> str:
        return "https" if self.tls else "http"

    @property
    def cookie_name(self) -> str:
        return f"{COOKIE_PREFIX}{self.port}"

    def rotate(self) -> None:
        """New links: the old ones (and the cookies they set) stop working."""
        self.editor_token = new_token()
        self.viewer_token = new_token()

    # ── Names ──

    def host_ok(self, host: str | None) -> bool:
        """Whether a request's ``Host`` names this machine. An IP literal
        always does (a page cannot rebind a literal address); a name only
        when it is a loopback name, this machine's own, or allowed."""
        if not host:
            return False
        name, _port = split_host(host)
        if not name:
            return False
        if is_ip(name) or is_loopback_name(name):
            return True
        return name in self.names or name in {h.lower() for h in self.allow_hosts}

    def origin_ok(
        self, origin: str | None, host: str | None, *, port: int | None = None
    ) -> bool:
        """Whether a WebSocket handshake's ``Origin`` is a page of this server:
        same host and port as the request's ``Host`` (whatever name or
        forwarded port it was reached by), or, on the old separate WebSocket
        port, this server's HTTP ``port``. No ``Origin`` at all is a program,
        not a browser page (an agent's command), and is let through."""
        if origin is None:
            return True
        split = urlsplit(origin.strip().lower())
        if split.scheme not in ("http", "https") or not split.hostname:
            return False
        try:
            origin_port = split.port
        except ValueError:
            return False
        origin_port = origin_port or (443 if split.scheme == "https" else 80)
        if not self.host_ok(split.netloc):
            return False
        if host is None:
            return False
        name, host_port = split_host(host)
        same_name = split_host(split.netloc)[0] == name
        if host_port is None:
            # No port named: the default one of whichever scheme the page
            # used (an HTTPS proxy in front, such as ``tailscale serve``,
            # passes its own Host on to this plain-HTTP server).
            host_port = 443 if split.scheme == "https" else 80
        if same_name and origin_port == host_port:
            return True
        return port is not None and origin_port == port

    # ── People ──

    def is_owner(self, peer: str | None, request: Request) -> bool:
        """This machine's own page or program: a loopback connection naming
        the server by a loopback name (an SSH tunnel's ``localhost``), not
        relayed by a proxy on this machine."""
        if not is_loopback_ip(peer):
            return False
        if any(h in request.headers for h in _FORWARDED):
            return False
        return is_loopback_name(split_host(request.host or "")[0])

    def token_role(self, token: str | None) -> Role | None:
        if not token or not self.sharing:
            return None
        # Both compared, whichever matches, in constant time.
        editor = secrets.compare_digest(token.encode(), self.editor_token.encode())
        viewer = secrets.compare_digest(token.encode(), self.viewer_token.encode())
        return "editor" if editor else "viewer" if viewer else None

    def cookie_token(self, request: Request) -> str | None:
        for part in request.headers.get("cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == self.cookie_name:
                return value.strip()
        return None

    def admit(
        self, peer: str | None, request: Request
    ) -> tuple[Role | None, str | None]:
        """Who the request is and the token that admitted it (None for the
        owner): the owner, a token in the URL (``?k=``), or the cookie one
        set."""
        if self.is_owner(peer, request):
            return "owner", None
        for token in (request.query.get(TOKEN_PARAM), self.cookie_token(request)):
            role = self.token_role(token)
            if role is not None:
                return role, token
        return None, None

    def set_cookie(self, token: str) -> str:
        secure = "; Secure" if self.tls else ""
        return f"{self.cookie_name}={token}; Path=/; HttpOnly; SameSite=Strict{secure}"

    def links(self, addresses: list[str]) -> list[dict[str, str]]:
        """The two share links for each address (and ``<host>.local``)."""
        out: list[dict[str, str]] = []
        for address in addresses:
            base = f"{self.scheme}://{url_host(address)}:{self.port}"
            out.append(
                {
                    "address": address,
                    "editor": f"{base}/edit?{TOKEN_PARAM}={self.editor_token}",
                    "view": f"{base}/?{TOKEN_PARAM}={self.viewer_token}",
                }
            )
        return out


def redacted(token: str) -> str:
    """A token as logs may show it."""
    return token[:4] + "…"


def page(title: str, text: str) -> bytes:
    """A short HTML page for a refusal (401/403)."""
    return (
        "<!doctype html><meta charset=utf-8>"
        + '<meta name=viewport content="width=device-width,initial-scale=1">'
        + f"<title>{escape(title)}</title>"
        + "<body style='font:16px/1.5 system-ui,sans-serif;max-width:32em;"
        + "margin:4em auto;padding:0 16px;color:#222;background:#fafafa'>"
        + f"<h1 style='font-size:1.3em'>{escape(title)}</h1><p>{escape(text)}</p>"
    ).encode()


def enter_page(target: str) -> bytes:
    """The page a share link answers with: its cookie is set by the response,
    and this page moves on to the link without its token. Not a redirect: a
    ``SameSite=Strict`` cookie set on the way through a redirect that began
    on another site (a chat app) is not sent to the redirect's target."""
    quoted = escape(target, quote=True)
    js_target = target.replace("\\", "\\\\").replace('"', '\\"').replace("<", "\\u003c")
    return (
        "<!doctype html><meta charset=utf-8>"
        + f'<meta http-equiv="refresh" content="0;url={quoted}">'
        + "<title>Inkflow</title>"
        + f'<script>location.replace("{js_target}")</script>'
        + f'<a href="{quoted}">Continue</a>'
    ).encode()
