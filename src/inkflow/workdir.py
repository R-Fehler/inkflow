"""The project's ``.inkflow/`` folder: inkflow's own working files.

Caches (converted PDF pages), and whatever tools built on inkflow keep beside
a deck (an editor's context for agents, its starred slides, staged uploads),
live here. The folder ignores itself in git and the server's file watcher
never looks inside it, so nothing written here is ever a deck change.
"""

from __future__ import annotations

from pathlib import Path

WORK_DIR = ".inkflow"
"""The folder's name, at the project root (next to deck.py)."""


def work_dir(project_dir: Path) -> Path:
    """The project's ``.inkflow/``, created ignoring itself in git."""
    directory = project_dir / WORK_DIR
    directory.mkdir(exist_ok=True)
    ignore = directory / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8")
    return directory
