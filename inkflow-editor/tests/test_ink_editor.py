"""The editor's part of test_ink.py: the tests that need inkflow-editor."""

from __future__ import annotations

import asyncio
import json
import textwrap
from collections.abc import AsyncIterator
from pathlib import Path
from typing import cast

import pytest
from websockets.asyncio.server import ServerConnection

from inkflow import server
from inkflow.access import Role
from inkflow.ink import (
    Stroke,
    add_strokes,
    stroke_ids,
)
from inkflow.pipeline import process_deck
from inkflow.server import load_deck
from inkflow.svgio import parse_svg
from inkflow_editor.model import build_model
from inkflow_editor.server import EditorExtension
from inkflow_editor.session import EditError, EditorSession

BOX = (0.0, 0.0, 1920.0, 1080.0)


SLIDE = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="box" x="100" y="100" width="200" height="100"/>
    </svg>
""")


LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" class="inkflow-fill-bg"/>
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
    </svg>
""")


OVERLAY = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="logo" x="1800" y="1000" width="40" height="40"/>
    </svg>
""")


DECK = textwrap.dedent("""\
    from inkflow import Deck, Overlay, Slide


    def main() -> Deck:
        return Deck(
            overlays=[Overlay("chrome")],
            slides=[
                Slide("drawn.svg"),
                Slide("plain", zones={"title": "One"}),
                Slide("plain", zones={"title": "Two"}),
                Slide("drawn.svg", id="named", ink="notes/named-ink.svg"),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for sub in ("slides", "layouts", "overlays", "notes"):
        (tmp_path / sub).mkdir()
    (tmp_path / "slides" / "drawn.svg").write_text(SLIDE, encoding="utf-8")
    (tmp_path / "layouts" / "plain.svg").write_text(LAYOUT, encoding="utf-8")
    (tmp_path / "overlays" / "chrome.svg").write_text(OVERLAY, encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


def _stroke(stroke_id: str = "ink-a1", **fields: object) -> dict[str, object]:
    return {
        "id": stroke_id,
        "d": "M10 10Q20 20 30 30 40 10 50 50Z",
        "fill": "#ff0000",
        "tool": "pen",
        "size": 6,
        **fields,
    }


def _write_ink(path: Path, *ids: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = add_strokes(None, [Stroke.from_json(_stroke(i)) for i in ids], BOX)
    path.write_bytes(data)


def _build(project: Path, *, editor: bool = False):
    deck = load_deck(project / "deck.py")
    return deck, process_deck(deck, project, project / "deck.py", editor=editor)


def test_an_editor_build_names_the_ink_file_and_stamps_its_strokes(
    project: Path,
) -> None:
    _write_ink(project / "ink" / "drawn.svg", "ink-a1")
    deck, slides = _build(project, editor=True)
    edit = slides[0].get("edit")
    assert edit is not None
    assert edit["ink"] == str(project / "ink" / "drawn.svg")
    stroke = parse_svg(slides[0]["svg"]).find(".//*[@id='ink-a1']")
    assert stroke is not None and stroke.get("data-ink-top") == ""
    model = build_model(deck, project / "deck.py", slides)
    entry = cast("list[dict[str, object]]", model["slides"])[0]
    roles = {s["role"] for s in cast("list[dict[str, str]]", entry["sources"])}
    assert "ink" in roles
    assert cast("dict[str, object]", entry["ink"])["exists"] is True


def _ink_request(**fields: object) -> dict[str, object]:
    return {"action": "ink", "_local": True, **fields}


def test_session_appends_a_stroke_as_one_undoable_step(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    target = project / "ink" / "plain-2.svg"
    out = session.apply(
        _ink_request(op="add", slideId="plain-2", strokes=[_stroke("ink-a")]), deck
    )
    assert out["ok"] and out["ink"] == "ink/plain-2.svg"
    session.apply(_ink_request(op="add", slide=2, strokes=[_stroke("ink-b")]), deck)
    assert stroke_ids(target.read_bytes()) == ["ink-a", "ink-b"]
    assert parse_svg(target.read_bytes()).get("viewBox") == "0 0 1920 1080"
    session.apply({"action": "undo"}, None)
    assert stroke_ids(target.read_bytes()) == ["ink-a"]
    session.apply({"action": "undo"}, None)
    assert not target.exists()


def test_session_erases_and_clears(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    target = project / "ink" / "drawn.svg"
    _write_ink(target, "ink-a", "ink-b", "ink-c")
    session.apply(_ink_request(op="erase", slide=0, ids=["ink-b"]), deck)
    assert stroke_ids(target.read_bytes()) == ["ink-a", "ink-c"]
    session.apply(_ink_request(op="clear", slide=0), deck)
    assert not target.exists()
    session.apply({"action": "undo"}, None)
    assert stroke_ids(target.read_bytes()) == ["ink-a", "ink-c"]


@pytest.mark.parametrize("local", [False, "true", None])
def test_only_a_page_on_this_machine_saves_ink(project: Path, local: object) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    request = {**_ink_request(op="add", slide=0, strokes=[_stroke()]), "_local": local}
    with pytest.raises(EditError, match="on this machine"):
        session.apply(request, deck)
    assert not (project / "ink").exists()


def test_a_shared_editor_saves_ink_and_a_viewer_does_not(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    request = _ink_request(op="add", slide=0, strokes=[_stroke()])
    with pytest.raises(EditError, match="only an editor"):
        session.apply({**request, "_role": "viewer"}, deck)
    assert not (project / "ink").exists()
    assert session.apply({**request, "_role": "editor"}, deck)["ok"] is True
    assert (project / "ink" / "drawn.svg").exists()


def test_a_malformed_stroke_writes_nothing(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    with pytest.raises(EditError, match="colour"):
        session.apply(
            _ink_request(op="add", slide=0, strokes=[_stroke(fill="javascript:")]),
            deck,
        )
    assert not (project / "ink").exists()


def test_detaching_a_slide_renames_its_ink(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    _write_ink(project / "ink" / "plain-2.svg", "ink-second")
    _write_ink(project / "ink" / "plain.svg", "ink-first")
    session.apply(
        {"action": "slide", "op": "detach", "slide": 2, "name": "second"}, deck
    )
    assert not (project / "ink" / "plain-2.svg").exists()
    assert stroke_ids((project / "ink" / "second.svg").read_bytes()) == ["ink-second"]
    assert stroke_ids((project / "ink" / "plain.svg").read_bytes()) == ["ink-first"]
    _, slides = _build(project)
    assert "ink-second" in slides[2]["svg"] and "ink-first" in slides[1]["svg"]
    session.apply({"action": "undo"}, None)
    assert (project / "ink" / "plain-2.svg").exists()
    assert not (project / "ink" / "second.svg").exists()


def test_deleting_a_slide_deletes_its_ink(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    _write_ink(project / "ink" / "drawn.svg", "ink-a")
    session.apply({"action": "slide", "op": "delete", "slide": 0}, deck)
    assert not (project / "ink" / "drawn.svg").exists()
    session.apply({"action": "undo"}, None)
    assert (project / "ink" / "drawn.svg").exists()


def test_a_duplicate_gets_its_own_copy_of_the_ink(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    _write_ink(project / "ink" / "drawn.svg", "ink-a")
    _write_ink(project / "notes" / "named-ink.svg", "ink-named")
    session.apply({"action": "slide", "op": "duplicate", "slide": 0}, deck)
    _, slides = _build(project)
    # slides/drawn.svg is shared, so the copy keeps it and is "drawn-2".
    assert [s["id"] for s in slides][:2] == ["drawn", "drawn-2"]
    assert "ink-a" in slides[0]["svg"] and "ink-a" in slides[1]["svg"]
    deck = load_deck(project / "deck.py")
    session.apply({"action": "slide", "op": "duplicate", "slide": 4}, deck)
    copy = load_deck(project / "deck.py").slides[5]
    assert copy.ink == "notes/named-ink-copy.svg"
    assert (project / "notes" / "named-ink-copy.svg").exists()


def test_moving_a_slide_keeps_each_ink_with_its_slide(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    _write_ink(project / "ink" / "plain.svg", "ink-one")
    _write_ink(project / "ink" / "plain-2.svg", "ink-two")
    # The two "plain" slides swap places, and with them their inferred ids.
    session.apply({"action": "slide", "op": "move", "from": 2, "to": 1}, deck)
    _, slides = _build(project)
    one = next(s for s in slides if "One" in s["svg"])
    two = next(s for s in slides if "Two" in s["svg"])
    assert "ink-one" in one["svg"] and "ink-two" in two["svg"]


def test_slide_edits_that_keep_ids_leave_ink_alone(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    _write_ink(project / "ink" / "drawn.svg", "ink-a")
    session.apply({"action": "slide", "op": "new", "after": 0, "layout": "plain"}, deck)
    session.apply(
        {"action": "slide", "op": "title", "slide": 0, "title": "Renamed"},
        load_deck(project / "deck.py"),
    )
    assert stroke_ids((project / "ink" / "drawn.svg").read_bytes()) == ["ink-a"]
    _, slides = _build(project)
    assert "ink-a" in slides[0]["svg"]


def test_ink_in_the_way_is_never_overwritten(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    _write_ink(project / "ink" / "plain-2.svg", "ink-second")
    # Someone else's file already where the renamed ink would go.
    _write_ink(project / "ink" / "second.svg", "ink-stray")
    session.apply(
        {"action": "slide", "op": "detach", "slide": 2, "name": "second"}, deck
    )
    assert stroke_ids((project / "ink" / "second.svg").read_bytes()) == ["ink-stray"]
    assert (project / "ink" / "plain-2.svg").exists()


class _Peer:
    """A WebSocket peer: what it sends, and what the server sends it."""

    remote_address: tuple[str, int]
    sent: list[str]
    inbox: list[str]

    def __init__(self, host: str, inbox: list[str] | None = None) -> None:
        self.remote_address = (host, 5000)
        self.sent = []
        self.inbox = inbox or []

    async def send(self, msg: str) -> None:
        self.sent.append(msg)

    def __aiter__(self) -> AsyncIterator[str]:
        return self._messages()

    async def _messages(self) -> AsyncIterator[str]:
        for msg in self.inbox:
            yield msg


def _join(peer: _Peer, role: Role) -> None:
    """Admit a fake connection as the door would (see access.py)."""
    people = server._share.people  # pyright: ignore[reportPrivateUsage]
    _ = people.join(peer, role, None, peer.remote_address[0])


def _leave(*peers: _Peer) -> None:
    for peer in peers:
        _ = server._share.people.leave(peer)  # pyright: ignore[reportPrivateUsage]


def test_a_save_from_a_view_link_is_refused(project: Path) -> None:
    session = EditorSession(project / "deck.py")
    editor = EditorExtension(session=session)
    asyncio.run(editor.start(server.context))
    editor.deck = load_deck(project / "deck.py")
    request: dict[str, object] = {
        "type": "edit-op",
        "id": "ink-1",
        "action": "ink",
        "op": "add",
        "slide": 0,
        "strokes": [_stroke()],
        "_local": True,  # what a page claims is overwritten by the server
        "_role": "owner",
    }
    viewer = _Peer("192.168.1.20")
    _join(viewer, "viewer")
    local = _Peer("127.0.0.1")
    _join(local, "owner")
    people = server._share.people  # pyright: ignore[reportPrivateUsage]

    def send(peer: _Peer) -> dict[str, object]:
        conn = cast("ServerConnection", cast("object", peer))
        client = people.get(conn)
        assert client is not None
        asyncio.run(editor.edit_op(conn, client, dict(request), session))
        return cast("dict[str, object]", json.loads(peer.sent[0]))

    try:
        reply = send(viewer)
        assert reply["id"] == "ink-1" and reply["ok"] is False
        # The core never hands a view link's edit to the editor at all.
        assert not server.allowed("viewer", request)
        assert not (project / "ink").exists()
        assert send(local)["ok"] is True
        assert (project / "ink" / "drawn.svg").exists()
    finally:
        _leave(viewer, local)
