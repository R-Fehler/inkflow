"""Which files a piece of the build read, so it can be kept until they change.

A served deck rebuilds on every change of any file. To redo only the slides a
change touches (`inkflow.incremental`), each slide's processing is run inside
`recording()`, and every place of the pipeline that reads a file, or looks
whether one exists, says so with `note(path)`. The recording is the slide's
dependencies: each path with its `Stamp` at the time, where "not there" is a
stamp too, so a file that appears later (a slide's ink, a layout that now
shadows the theme's, a page committed beside its PDF) is a change like any
other.

Outside a recording `note` does nothing, which is every build that is not a
server's (`inkflow build`, `export`, `render`, `verify`).

Whoever adds a file read to the slide pipeline must note it: a read that is
not noted is a slide that stays as it was when that file changes.
tests/test_incremental.py holds every recorded slide to what Python saw
opened (an audit hook), and compares incremental builds with full ones.
"""

from __future__ import annotations

import os
import sys
import time
from collections.abc import Generator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

Stamp = tuple[int, int, int] | None
"""A file as a build saw it: (mtime in ns, size, inode), or None when it is
not there. The inode tells a file replaced by another of the same size and
time (a save by rename, a checkout) from the one read."""

RACY_NS = 20_000_000
"""A file changed this recently may change again without its time moving
(a file system's clock ticks every few milliseconds): its stamp is not
trusted, so the slide is processed again next time. The watcher waits longer
than this before a rebuild starts, so an edit does not land here."""

_NEVER: Stamp = (-1, -1, -1)
"""A stamp no file has: what a file too fresh to trust is recorded as."""

_recording: ContextVar[dict[str, Stamp] | None] = ContextVar(
    "inkflow_deps", default=None
)


def stamp(path: str | Path) -> Stamp:
    """The file's stamp now (None: not there, or not readable)."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size, st.st_ino)


def settled(now: Stamp) -> bool:
    """Whether a stamp can be trusted to change when the file does."""
    return now is not None and time.time_ns() - now[0] >= RACY_NS


def note(path: str | Path) -> None:
    """Say that what is being built depends on ``path``: its content, or
    whether it exists. Called before the file is read, so a change during the
    read is seen as one."""
    deps = _recording.get()
    if deps is None:
        return
    key = os.fspath(path)
    if key in deps:
        return
    now = stamp(key)
    deps[key] = now if now is None or settled(now) else _NEVER


def note_class(cls: type) -> None:
    """Say that what is being built depends on a class found by its name (a
    Markdown reveal's ``type=Shake``): on the file defining it, which for a
    deck's own animation is deck.py. inkflow's own do not change while it runs."""
    if cls.__module__ == "inkflow" or cls.__module__.startswith("inkflow."):
        return
    origin = getattr(sys.modules.get(cls.__module__), "__file__", None)
    if isinstance(origin, str):
        note(origin)


@contextmanager
def recording() -> Generator[dict[str, Stamp]]:
    """Collect the files noted inside the block (and only on this thread or
    task: other requests' reads are theirs)."""
    deps: dict[str, Stamp] = {}
    token = _recording.set(deps)
    try:
        yield deps
    finally:
        _recording.reset(token)


class Stamps:
    """Each file's stamp, looked up once per build however many slides
    depend on it."""

    def __init__(self) -> None:
        self._seen: dict[str, Stamp] = {}

    def of(self, path: str) -> Stamp:
        if path not in self._seen:
            self._seen[path] = stamp(path)
        return self._seen[path]

    def unchanged(self, deps: dict[str, Stamp]) -> bool:
        return all(self.of(path) == was for path, was in deps.items())
