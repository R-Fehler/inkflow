"""The people editing a deck together: each page's name, colour and private
key (whose undo steps are whose), and where it is (slide, selection, what it
is typing into), relayed to everyone as ``presence`` and never written
anywhere. Kept beside the core's connection registry (``inkflow.collab``),
by each connection's client id."""

from __future__ import annotations

import getpass
import re
from dataclasses import dataclass, field
from typing import cast

from inkflow.collab import Client, People

COLORS = (
    "#1971c2",
    "#2f9e44",
    "#e8590c",
    "#c2255c",
    "#7048e8",
    "#0c8599",
    "#e67700",
    "#5c940d",
    "#ae3ec9",
    "#d6336c",
)
"""Distinct on light and dark canvases; a new person takes the first one no
one connected has."""

_KEY = re.compile(r"[A-Za-z0-9_-]{8,64}")


def owner_name() -> str:
    """The owner's default display name: this computer's user."""
    try:
        name = getpass.getuser()
    except (OSError, KeyError, ImportError):
        return "Owner"
    return name or "Owner"


@dataclass
class Person:
    """What the editor knows of one connection besides its role."""

    name: str = ""
    color: str = ""
    key: str | None = None
    """The page's own secret (kept across reloads in its storage): whose
    steps are whose in the undo history. Never sent to anyone else."""
    slide: int | None = None
    selection: list[str] = field(default_factory=list)
    """``data-ink`` locators of what is selected on that slide."""
    editing: str | None = None
    """A zone or text being typed into, if any."""


def author(client: Client, person: Person | None) -> str:
    """Whose History steps are this connection's. The owner's pages and agents
    (commands on this machine) are one author; a guest is its page's key, or
    the connection when the page sent none."""
    if client.role == "owner":
        return "owner"
    key = person.key if person is not None else None
    return f"guest:{key or client.id}"


class Presence:
    """Each connection's ``Person``, by its client's id (the core's ``People``
    gives every connection one)."""

    def __init__(self) -> None:
        self._people: dict[str, Person] = {}

    def of(self, client: Client) -> Person:
        """The connection's person, met now if new (a colour no one has)."""
        person = self._people.get(client.id)
        if person is None:
            used = {p.color for p in self._people.values()}
            color = next(
                (c for c in COLORS if c not in used),
                COLORS[len(used) % len(COLORS)],
            )
            name = owner_name() if client.role == "owner" else ""
            person = Person(name=name, color=color)
            self._people[client.id] = person
        return person

    def forget(self, client: Client) -> Person | None:
        return self._people.pop(client.id, None)

    def author(self, client: Client | None) -> str:
        if client is None:
            return "owner"
        return author(client, self._people.get(client.id))

    def update(self, client: Client, msg: dict[str, object]) -> bool:
        """Apply a page's ``presence`` message; whether anything changed."""
        person = self.of(client)
        before = (public(client, person), person.key)
        name = msg.get("name")
        if isinstance(name, str) and name.strip():
            person.name = " ".join(name.split())[:40]
        key = msg.get("key")
        if isinstance(key, str) and _KEY.fullmatch(key) and person.key is None:
            person.key = key
        page = msg.get("page")
        if page in ("editor", "presenter"):
            client.page = cast("str", page)
        if "slide" in msg:
            slide = msg.get("slide")
            ok = isinstance(slide, int) and not isinstance(slide, bool) and slide >= 0
            person.slide = cast("int", slide) if ok else None
        selection = msg.get("selection")
        if isinstance(selection, list):
            person.selection = [
                s
                for s in cast("list[object]", selection)[:50]
                if isinstance(s, str) and len(s) < 200
            ]
        if "editing" in msg:
            editing = msg.get("editing")
            person.editing = editing[:100] if isinstance(editing, str) else None
        return (public(client, person), person.key) != before

    def listing(self, people: People) -> list[dict[str, object]]:
        """Everyone with a page open (programs are not people)."""
        return [public(c, self.of(c)) for _, c in people.items() if c.page]


def public(client: Client, person: Person) -> dict[str, object]:
    """What everyone sees of a person (never the key or the token)."""
    return {
        **client.public(),
        "name": person.name or ("Owner" if client.role == "owner" else "Guest"),
        "color": person.color,
        "slide": person.slide,
        "selection": person.selection,
        "editing": person.editing,
    }
