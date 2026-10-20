"""The editor's part of test_incremental.py: the tests that need inkflow-editor."""

from __future__ import annotations

import asyncio
import gc
import json
import os
import textwrap
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from pathlib import Path
from typing import cast

import pytest
from websockets.asyncio.server import ServerConnection

from inkflow import deps, server
from inkflow.edit import NO_EDIT_COMMANDS
from inkflow.incremental import SlideCache
from inkflow.logging import resolve_levels
from inkflow.pipeline import SlideData, process_deck
from inkflow.server import load_deck
from inkflow.tui import LiveUI
from inkflow_editor.model import ModelCache, build_model
from inkflow_editor.server import EditorExtension

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <style>#zone-title { --inkflow-valign: center; }</style>
      <rect width="1920" height="1080" class="inkflow-fill-bg"/>
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
      <rect id="zone-chart" x="80" y="200" width="800" height="600"/>
      <text id="zone-slide-number" x="1800" y="1040">99</text>
      <text id="zone-slide-total" x="1840" y="1040">99</text>
    </svg>
""")


CHILD = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"
         xmlns:inkflow="urn:inkflow"
         inkflow:parent="two">
      <rect id="accent" x="0" y="0" width="1920" height="8"/>
    </svg>
""")


DRAWING = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="box" x="100" y="100" width="200" height="100"/>
      <text id="label" x="120" y="160">Hello</text>
    </svg>
""")


FOOTER = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <text id="brand" x="80" y="1040">inkflow</text>
    </svg>
""")


DECK = textwrap.dedent("""\
    from inkflow import Chart, Deck, Overlay, Slide


    def main() -> Deck:
        return Deck(
            overlays=[Overlay("footer")],
            slides=[
                Slide("drawing.svg", notes="notes/drawing.md"),
                Slide("two", md="one.md"),
                Slide("child", md="two.md", notes="notes/two.md"),
                Slide(
                    "two",
                    zones={"title": "Sales", "chart": Chart("data/sales.csv")},
                ),
                Slide("two", md="five.md", extra_style="slides/five.css"),
            ],
        )
""")


IDS = ["drawing", "one", "two", "two-2", "five"]


ONE = '            Slide("two", md="one.md"),'


TWO = '            Slide("child", md="two.md", notes="notes/two.md"),'


class Project:
    """A deck in a folder, and one cache over its builds."""

    def __init__(self, root: Path) -> None:
        self.root: Path = root
        self.deck_path: Path = root / "deck.py"
        self.cache: SlideCache = SlideCache()
        self._clock: int = 1_700_000_000_000_000_000

    def write(self, rel: str, text: str | bytes) -> Path:
        """Write a file with a time of its own, later than any before it (a
        file system's clock would give two quick writes the same one)."""
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(text, bytes):
            _ = path.write_bytes(text)
        else:
            _ = path.write_text(text, encoding="utf-8")
        self._clock += 1_000_000_000
        os.utime(path, ns=(self._clock, self._clock))
        return path

    def edit(self, rel: str, old: str, new: str) -> None:
        text = (self.root / rel).read_text(encoding="utf-8")
        assert old in text
        _ = self.write(rel, text.replace(old, new))

    def full(self) -> list[SlideData]:
        deck = load_deck(self.deck_path)
        return process_deck(deck, self.root, self.deck_path, editor=True)

    def rebuilt(self) -> list[str]:
        """Build with the cache; the ids it processed. The result is what a
        full build of the files as they are gives."""
        deck = load_deck(self.deck_path)
        built = process_deck(
            deck, self.root, self.deck_path, editor=True, cache=self.cache
        )
        assert built == self.full()
        return list(self.cache.processed)


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Project:
    # Files written by a test are milliseconds old: trusted here, where every
    # write is given a time of its own (`Project.write`).
    monkeypatch.setattr(deps, "RACY_NS", 0)
    p = Project(tmp_path)
    _ = p.write("layouts/two.svg", LAYOUT)
    _ = p.write("layouts/child.svg", CHILD)
    _ = p.write("overlays/footer.svg", FOOTER)
    _ = p.write("slides/drawing.svg", DRAWING)
    _ = p.write("slides/one.md", "# One\n\nBody one\n")
    _ = p.write("slides/two.md", "# Two\n\nBody two\n")
    _ = p.write("slides/five.md", "# Five\n\nBody five\n")
    _ = p.write("slides/five.css", "#zone-title { fill: red; }\n")
    _ = p.write("notes/drawing.md", "Speak.\n")
    _ = p.write("notes/two.md", "Second *note*.\n")
    _ = p.write("data/sales.csv", "year,revenue\n2023,10\n2024,14\n")
    _ = p.write("styles.css", ":root { --x: 1; }\n")
    _ = p.write("deck.py", DECK)
    assert p.rebuilt() == IDS
    return p


def _model(project: Project, cache: ModelCache | None) -> dict[str, object]:
    # The model lists every animation class alive, an earlier test's deck's
    # own among them until they are collected.
    _ = gc.collect()
    deck = load_deck(project.deck_path)
    slides = process_deck(deck, project.root, project.deck_path, editor=True)
    return build_model(deck, project.deck_path, slides, cache=cache)


def test_the_model_reads_only_the_slides_that_changed(project: Project) -> None:
    cache = ModelCache()
    assert _model(project, cache) == _model(project, None)
    assert cache.read == [0, 1, 2, 3, 4]
    assert _model(project, cache) == _model(project, None)
    assert cache.read == []
    project.edit("slides/one.md", "Body one", "Body one, edited")
    assert _model(project, cache) == _model(project, None)
    assert cache.read == [1]
    project.edit("notes/two.md", "Second", "Second, longer")
    model = _model(project, cache)
    assert model == _model(project, None)
    assert cache.read == [2]
    entries = cast("list[dict[str, object]]", model["slides"])
    assert "Second, longer" in str(entries[2]["notes"])
    # A layout's hash is in every slide built on it.
    project.edit("layouts/two.svg", 'y="60"', 'y="70"')
    assert _model(project, cache) == _model(project, None)
    assert cache.read == [1, 2, 3, 4]


def test_the_model_follows_moves_without_reading_again(project: Project) -> None:
    cache = ModelCache()
    _ = _model(project, cache)
    project.edit(
        "deck.py",
        f"{ONE}\n{TWO}",
        f"{TWO}\n{ONE}",
    )
    model = _model(project, cache)
    assert model == _model(project, None)
    assert cache.read == []
    entries = cast("list[dict[str, object]]", model["slides"])
    assert [e["id"] for e in entries] == ["drawing", "two", "one", "two-2", "five"]
    assert [e["deckIndex"] for e in entries] == [0, 1, 2, 3, 4]
    # Which slides share the layout, by where they stand now.
    sources = cast("list[dict[str, object]]", entries[2]["sources"])
    assert sources[0]["usedBy"] == [2, 3, 4]
    # Hidden, a slide is not built: it keeps a place in the model by index.
    project.edit(
        "deck.py",
        'Slide("two", md="one.md"),',
        'Slide("two", md="one.md", visible=False),',
    )
    assert _model(project, cache) == _model(project, None)


def test_the_model_sees_a_file_made_read_only(project: Project) -> None:
    cache = ModelCache()
    _ = _model(project, cache)
    path = project.root / "slides" / "drawing.svg"
    path.chmod(0o444)
    try:
        model = _model(project, cache)
        assert model == _model(project, None)
        if os.access(path, os.W_OK):
            pytest.skip("this user writes read-only files (root)")
        # Permissions move the file's change time, which a stamp holds.
        assert cache.read == [0]
        entries = cast("list[dict[str, object]]", model["slides"])
        sources = cast("list[dict[str, object]]", entries[0]["sources"])
        assert sources[0]["writable"] is False
    finally:
        path.chmod(0o644)


def test_the_model_says_whether_animations_are_written_out(
    project: Project,
) -> None:
    cache = ModelCache()
    assert cast("bool", _model(project, cache)["deckEditable"])
    project.edit("deck.py", "slides=[", "slides=[*[],")
    model = _model(project, cache)
    assert model == _model(project, None)
    assert model["deckEditable"] is False


class _Peer:
    """A WebSocket peer: what it sends, and what the server sends it."""

    remote_address: tuple[str, int] = ("127.0.0.1", 5000)

    def __init__(self, inbox: list[dict[str, object]] | None = None) -> None:
        self.sent: list[dict[str, object]] = []
        self.inbox: list[dict[str, object]] = inbox or []

    async def send(self, msg: str) -> None:
        self.sent.append(cast("dict[str, object]", json.loads(msg)))

    def __aiter__(self) -> AsyncIterator[str]:
        return self._messages()

    async def _messages(self) -> AsyncIterator[str]:
        for msg in self.inbox:
            yield json.dumps(msg)

    def last(self, kind: str) -> dict[str, object]:
        return [m for m in self.sent if m["type"] == kind][-1]


class _UI:
    def refresh(self) -> None:
        pass

    def set_building(self) -> None:
        pass

    def set_ok(self, *_args: object, **_kwargs: object) -> None:
        pass

    def set_error(self, trace: str) -> None:
        raise AssertionError(trace)


def _kinds(items: object) -> list[str]:
    """Each item of a sent list: named by key, or sent whole."""
    return [
        "key" if isinstance(item, str) else "whole"
        for item in cast("list[object]", items)
    ]


@pytest.fixture
def served(project: Project) -> Iterator[tuple[Project, _Peer, _Peer]]:
    """The deck built by the server with the editor extension, with two
    owner's pages connected: one that takes patches and one of an older
    inkflow that does not."""
    people = server._share.people  # pyright: ignore[reportPrivateUsage]
    state = server._state  # pyright: ignore[reportPrivateUsage]
    served = server._served  # pyright: ignore[reportPrivateUsage]
    editor = EditorExtension()
    asyncio.run(editor.start(server.context))
    asyncio.run(editor.open(project.deck_path))
    editor.problems = None  # no background checks between the loops
    served.extensions = [editor]
    served.deck_path = project.deck_path
    patching, plain = _Peer(), _Peer()
    sockets = [cast("ServerConnection", cast("object", p)) for p in (patching, plain)]
    for ws in sockets:
        _ = people.join(ws, "owner", None, "127.0.0.1")
        state["ws_clients"].add(ws)
        editor.clients.add(ws)
    client = people.get(sockets[0])
    assert client is not None
    client.patches = True
    try:
        _rebuild(project)
        yield project, patching, plain
    finally:
        served.extensions = []
        served.deck_path = None
        served.kept = None
        for ws in sockets:
            state["ws_clients"].discard(ws)
            _ = people.leave(ws)


async def _serve(
    handler: Callable[[ServerConnection], Awaitable[None]], ws: ServerConnection
) -> None:
    await handler(ws)


def _rebuild(project: Project, *, full: bool = False) -> None:
    ui = cast("LiveUI", cast("object", _UI()))
    asyncio.run(server.rebuild(project.deck_path, ui, resolve_levels(), full=full))


def test_a_rebuild_sends_a_page_the_slides_that_changed(
    served: tuple[Project, _Peer, _Peer],
) -> None:
    project, patching, plain = served
    project.edit("slides/one.md", "Body one", "Body one, edited")
    _rebuild(project)
    update = patching.last("update")
    assert _kinds(update["slides"]) == ["key", "whole", "key", "key", "key"]
    changed = cast("list[dict[str, str]]", update["slides"])[1]
    assert changed["id"] == "one" and "Body one, edited" in changed["svg"]
    model = cast("dict[str, object]", patching.last("editor-model")["model"])
    assert _kinds(model["slides"]) == ["key", "whole", "key", "key", "key"]
    # A page that never asked for patches gets every slide, as it always did.
    assert _kinds(plain.last("update")["slides"]) == ["whole"] * 5
    old = cast("dict[str, object]", plain.last("editor-model")["model"])
    assert _kinds(old["slides"]) == ["whole"] * 5
    # The keys a patch names are the ones the last build sent.
    held = cast("list[dict[str, str]]", plain.sent[0]["slides"])
    assert cast("list[object]", update["slides"])[0] == held[0]["key"]


def test_a_note_sends_its_slide_and_processes_none(
    served: tuple[Project, _Peer, _Peer],
) -> None:
    project, patching, _plain = served
    project.edit("notes/two.md", "Second", "Second, longer")
    _rebuild(project)
    kept = server._served.kept  # pyright: ignore[reportPrivateUsage]
    assert kept is not None and kept.slides.processed == []
    update = patching.last("update")
    assert _kinds(update["slides"]) == ["key", "key", "whole", "key", "key"]
    sent = cast("list[dict[str, str]]", update["slides"])[2]
    assert "Second, longer" in sent["notes"]


def test_the_stylesheet_is_sent_and_no_slide_with_it(
    served: tuple[Project, _Peer, _Peer],
) -> None:
    project, patching, _plain = served
    project.edit("styles.css", "--x: 1", "--x: 2")
    _rebuild(project)
    update = patching.last("update")
    assert "--x: 2" in str(update["styles"])
    assert _kinds(update["slides"]) == ["key"] * 5
    project.edit("slides/one.md", "Body one", "Body 1")
    _rebuild(project)
    assert "styles" not in patching.last("update")  # only when it changed


def test_a_full_rebuild_processes_every_slide_again(
    served: tuple[Project, _Peer, _Peer],
) -> None:
    project, patching, _plain = served
    _rebuild(project, full=True)
    kept = server._served.kept  # pyright: ignore[reportPrivateUsage]
    assert kept is not None and kept.slides.processed == IDS
    # The slides are what they were: a page holding them is sent their keys.
    assert _kinds(patching.last("update")["slides"]) == ["key"] * 5


def test_a_page_says_hello_and_asks_again_when_it_missed_a_build(
    served: tuple[Project, _Peer, _Peer],
) -> None:
    del served
    page = _Peer(
        [
            {"type": "hello", "role": "editor", "patch": True},
            {"type": "resync"},
        ]
    )
    ws = cast("ServerConnection", cast("object", page))
    people = server._share.people  # pyright: ignore[reportPrivateUsage]
    _ = people.join(ws, "owner", None, "127.0.0.1")
    handler = server.make_ws_handler(
        cast("LiveUI", cast("object", _UI())), NO_EDIT_COMMANDS
    )
    try:
        asyncio.run(_serve(handler, ws))
    finally:
        _ = people.leave(ws)
    sent = [m for m in page.sent if m["type"] in ("update", "editor-model")]
    assert [m["type"] for m in sent] == ["update", "editor-model"] * 2
    # On hello: the slides by key (its HTML came with them), the model whole.
    assert _kinds(sent[0]["slides"]) == ["key"] * 5
    assert (
        _kinds(cast("dict[str, object]", sent[1]["model"])["slides"]) == ["whole"] * 5
    )
    # Asked again: everything whole.
    assert _kinds(sent[2]["slides"]) == ["whole"] * 5
    assert (
        _kinds(cast("dict[str, object]", sent[3]["model"])["slides"]) == ["whole"] * 5
    )


def test_a_presenter_page_gets_slides_and_no_model(
    served: tuple[Project, _Peer, _Peer],
) -> None:
    del served
    page = _Peer([{"type": "hello", "role": "presenter", "patch": True}])
    ws = cast("ServerConnection", cast("object", page))
    people = server._share.people  # pyright: ignore[reportPrivateUsage]
    _ = people.join(ws, "viewer", "token", "192.168.1.9")
    handler = server.make_ws_handler(
        cast("LiveUI", cast("object", _UI())), NO_EDIT_COMMANDS
    )
    try:
        asyncio.run(_serve(handler, ws))
    finally:
        _ = people.leave(ws)
    kinds = [m["type"] for m in page.sent]
    assert "update" in kinds and "editor-model" not in kinds
