"""A deck served as ``inkflow edit`` serves it, on a thread, for tests: the
core's server (``inkflow.server.listening``) with the ``EditorExtension``
(and any other extension), built once, its watcher rebuilding on changes."""

from __future__ import annotations

import asyncio
import contextlib
import os
import threading
from collections.abc import Callable, Coroutine, Generator, Sequence
from pathlib import Path
from typing import TypeVar, cast

import pytest

from inkflow import instances, server
from inkflow.extensions import ServerExtension
from inkflow.logging import resolve_levels
from inkflow.tui import LiveUI
from inkflow_editor.server import EditorExtension
from inkflow_editor.session import EditorSession

T = TypeVar("T")


class UI:
    """The terminal UI, doing nothing."""

    def refresh(self) -> None:
        pass

    def set_building(self) -> None:
        pass

    def set_ok(self, *_args: object, **_kwargs: object) -> None:
        pass

    def set_error(self, _trace: str) -> None:
        pass


def ui() -> LiveUI:
    return cast("LiveUI", cast("object", UI()))


class Served:
    """A running server: its port, the editor extension, its event loop."""

    def __init__(
        self, port: int, editor: EditorExtension, loop: asyncio.AbstractEventLoop
    ) -> None:
        self.port: int = port
        self.editor: EditorExtension = editor
        self.loop: asyncio.AbstractEventLoop = loop

    def call(self, work: Callable[[], Coroutine[object, object, T]]) -> T:
        """Run ``work()`` (a coroutine function) on the server's loop."""
        return asyncio.run_coroutine_threadsafe(work(), self.loop).result(30)


@contextlib.contextmanager
def serve_deck(
    session: EditorSession,
    monkeypatch: pytest.MonkeyPatch | None = None,
    *,
    extensions: Sequence[ServerExtension] = (),
    watch: bool = True,
) -> Generator[Served]:
    """Serve ``session``'s deck until the block ends; ``instances.serving``
    finds it (for ``inkflow slide`` and friends) when ``monkeypatch`` given."""
    deck_path = session.deck_path
    the_ui = ui()
    levels = resolve_levels()
    started = threading.Event()
    port: list[int] = []
    loop = asyncio.new_event_loop()
    stop = asyncio.Event()
    editor = EditorExtension(session=session)

    async def run() -> None:
        async with server.listening(the_ui, deck_path, [editor, *extensions]) as bound:
            port.append(bound)
            await server.rebuild(deck_path, the_ui, levels)
            watcher = (
                asyncio.create_task(
                    server._watch(deck_path, the_ui, asyncio.Lock(), levels)  # pyright: ignore[reportPrivateUsage]
                )
                if watch
                else None
            )
            await asyncio.sleep(0.3)  # the watcher is watching
            started.set()
            await stop.wait()
            if watcher is not None:
                _ = watcher.cancel()
            # A rebuild still running would be destroyed pending, and its
            # complaint logged into some later test's output.
            rest = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
            for task in rest:
                _ = task.cancel()
            _ = await asyncio.gather(*rest, return_exceptions=True)

    thread = threading.Thread(target=lambda: loop.run_until_complete(run()))
    thread.start()
    assert started.wait(20)
    if monkeypatch is not None:
        record = instances.Instance(
            os.getpid(), "127.0.0.1", port[0], port[0], str(deck_path)
        )

        def serving(_deck: Path, _exclude_pid: int | None = None) -> instances.Instance:
            return record

        monkeypatch.setattr(instances, "serving", serving)
    try:
        yield Served(port[0], editor, loop)
    finally:
        loop.call_soon_threadsafe(stop.set)
        thread.join(10)
        loop.close()
        reset()


def reset() -> None:
    """What a served deck leaves in the server's module state, cleared."""
    state = server._state  # pyright: ignore[reportPrivateUsage]
    state["ws_clients"].clear()
    state["error"] = None
    state["slides"] = []
