"""The connections a server has: who each one is (its role at the door, the
share token that admitted it) and what it is (a page, and which, or a
program). Frontends keep more about the people behind them (an editor's
names, colours and selections) in extensions of their own."""

from __future__ import annotations

import itertools
import secrets
from dataclasses import dataclass

from inkflow.access import Role


@dataclass
class Client:
    """One connection: a page (presenter, editor…) or a program."""

    id: str
    """Public, per connection: what a share dialog's "Disconnect" names."""
    role: Role
    token: str | None = None
    """The share token that admitted it (None: the owner)."""
    peer: str | None = None
    page: str = ""
    """What the page said it is in ``hello`` (``presenter``, ``editor``);
    "" for a program, which never says."""
    online: bool = False
    """Came another way than this server's port (``serve_connection``: a
    relay), so sharing on the network and the other way stop separately."""

    def public(self) -> dict[str, object]:
        return {
            "id": self.id,
            "role": self.role,
            "page": self.page,
            "online": self.online,
        }


class People:
    """The connected clients, keyed by their connection object."""

    def __init__(self) -> None:
        self._clients: dict[object, Client] = {}
        self._serial: itertools.count[int] = itertools.count(1)

    def join(
        self, conn: object, role: Role, token: str | None, peer: str | None
    ) -> Client:
        client = Client(
            id=f"p{next(self._serial)}{secrets.token_hex(3)}",
            role=role,
            token=token,
            peer=peer,
        )
        self._clients[conn] = client
        return client

    def leave(self, conn: object) -> Client | None:
        return self._clients.pop(conn, None)

    def get(self, conn: object) -> Client | None:
        return self._clients.get(conn)

    def items(self) -> list[tuple[object, Client]]:
        return list(self._clients.items())

    def by_id(self, client_id: str) -> tuple[object, Client] | None:
        for conn, client in self._clients.items():
            if client.id == client_id:
                return conn, client
        return None

    def listing(self) -> list[dict[str, object]]:
        """Every page open (programs are not people)."""
        return [c.public() for c in self._clients.values() if c.page]
