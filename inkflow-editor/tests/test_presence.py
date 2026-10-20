"""Who is editing (names, colours, whose undo steps), and what Share via SSH
writes its commands from."""

from __future__ import annotations

from pathlib import Path

from inkflow.collab import People
from inkflow_editor.presence import Presence

"""A request relayed from elsewhere: whatever its socket, not the owner's."""


def test_people_get_distinct_colours() -> None:
    people = People()
    presence = Presence()
    clients = [people.join(object(), "editor", None, None) for _ in range(5)]
    assert len({presence.of(c).color for c in clients}) == 5


def test_presence_keeps_names_and_whose_steps_are_whose() -> None:
    people = People()
    presence = Presence()
    owner = people.join(object(), "owner", None, None)
    guest = people.join(object(), "editor", "tok", "10.0.0.2")
    assert presence.author(owner) == "owner"
    assert presence.author(guest) == f"guest:{guest.id}"
    assert presence.update(
        guest, {"page": "editor", "name": "  Ana  B ", "key": "k" * 12, "slide": 2}
    )
    assert presence.author(guest) == "guest:" + "k" * 12
    listed = presence.listing(people)
    assert [p["name"] for p in listed] == ["Ana B"]  # the owner has no page yet
    assert "key" not in listed[0] and "token" not in listed[0]


def test_share_via_ssh_knows_where_the_deck_lives(tmp_path: Path) -> None:
    import subprocess

    from inkflow_editor import sshshare

    assert (
        sshshare.strip_credentials("https://user:tok@github.com/o/r.git")
        == "https://github.com/o/r.git"
    )
    assert sshshare.strip_credentials("git@github.com:o/r.git") == (
        "git@github.com:o/r.git"
    )
    assert sshshare.strip_credentials("ssh://git@host:2222/o/r") == (
        "ssh://git@host:2222/o/r"
    )
    repo = tmp_path / "my talks"
    deck = repo / "keynote" / "deck.py"
    deck.parent.mkdir(parents=True)
    deck.write_text("# deck\n", encoding="utf-8")
    (repo / "pyproject.toml").write_text(
        '[project]\nname = "talks"\nversion = "0"\ndependencies = ["inkflow"]\n',
        encoding="utf-8",
    )
    info = sshshare.details(deck, 7777)
    assert info["inRepo"] is False and info["remote"] is None
    for args in (
        ["init", "-q", "-b", "main"],
        ["remote", "add", "origin", "https://x:secret@example.com/o/talks.git"],
    ):
        _ = subprocess.run(["git", "-C", str(repo), *args], check=True)
    info = sshshare.details(deck, 7777)
    # Cloned on the server into the repository's name, as git clone does.
    assert info["inRepo"] is True and info["folder"] == "talks"
    assert sshshare.clone_folder("git@host:me/talks.git", "x") == "talks"
    assert sshshare.clone_folder("ssh://git@host:22/g/sub/r/", "x") == "r"
    assert sshshare.clone_folder(None, "my talks") == "my talks"
    assert info["remote"] == "https://example.com/o/talks.git"
    assert info["deck"] == "keynote/deck.py"
    assert info["pinned"] is True and info["project"] == ""
    assert info["port"] == 7777 and info["branch"] == "main"
