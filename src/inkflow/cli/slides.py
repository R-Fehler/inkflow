"""``inkflow slide``: add, delete, duplicate, move, hide and rename slides.

A slide is more than its ``Slide(...)`` line: its drawing, Markdown, notes and
saved ink are files named after it (``ink/<slide id>.svg`` follows the id,
which a Markdown file's name gives). These commands make the change the visual
editor makes for the same click, through the same ``EditorSession`` action, so
every file moves together and deck.py keeps its comments and formatting.

When ``inkflow edit``/``serve`` has the deck open, the change goes through that
server (``editor.remote``): it lands in the editor's undo history as
"Agent: …", and the author can take it back there with Ctrl+Z.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import click

from inkflow.cli._common import deck_option, main, resolve_deck_path
from inkflow.editor.remote import (
    Applied,
    RemoteEditError,
    apply_request,
    deck_file_hash,
)
from inkflow.logging import report
from inkflow.manifest import Deck
from inkflow.pipeline import slide_ids
from inkflow.server import load_deck


@dataclass(frozen=True)
class _Slides:
    """The deck as a command addresses it: numbers and ids by deck index."""

    deck: Deck
    path: Path
    hash: str
    ids: list[str]
    numbers: list[int | None]
    """Presentation number per deck index; None for a hidden slide."""

    @classmethod
    def load(cls, deck_path: Path) -> _Slides:
        resolved = resolve_deck_path(deck_path)
        deck_hash = deck_file_hash(resolved)
        try:
            deck = load_deck(resolved)
        except Exception as exc:
            raise click.ClickException(
                f"deck.py does not load ({type(exc).__name__}: {exc}); fix it first"
            ) from exc
        visible = [s for s in deck.slides if s.visible]
        shown = dict(zip(map(id, visible), slide_ids(visible), strict=True))
        numbers: list[int | None] = []
        count = 0
        for slide in deck.slides:
            if slide.visible:
                count += 1
            numbers.append(count if slide.visible else None)
        # A hidden slide has no id in the presentation; it goes by the one it
        # would infer, numbered on (-2, -3…) past any shown slide's id.
        taken = set(shown.values())
        ids: list[str] = []
        for slide in deck.slides:
            name = shown.get(id(slide))
            if name is None:
                raw = slide_ids([slide])[0]
                name, n = raw, 2
                while name in taken:
                    name, n = f"{raw}-{n}", n + 1
                taken.add(name)
            ids.append(name)
        return cls(deck, resolved, deck_hash, ids, numbers)

    def index(self, ref: str) -> int:
        """The deck index of SLIDE (a presentation number or an id)."""
        ref = ref.strip()
        if ref.isdigit():
            if int(ref) in self.numbers:
                return self.numbers.index(int(ref))
            shown = sum(n is not None for n in self.numbers)
            raise click.BadParameter(
                f"no slide {ref}: the deck shows {shown} slides "
                + "(a hidden slide goes by its id)",
                param_hint="SLIDE",
            )
        if ref in self.ids:  # unique: see load
            return self.ids.index(ref)
        raise click.BadParameter(f"no slide with id {ref!r}", param_hint="SLIDE")

    def name(self, index: int) -> str:
        number = self.numbers[index]
        if number is None:
            return f"hidden slide {self.ids[index]}"
        return f"slide {number} ({self.ids[index]})"


def _apply(slides: _Slides, request: dict[str, object], summary: str) -> Applied:
    """Run one session action as the agent's step ``summary``; print what it
    changed. Exits with the session's message when it is refused."""
    try:
        applied = apply_request(
            slides.path,
            slides.deck,
            slides.hash,
            {**request, "agent": summary},
        )
    except RemoteEditError as exc:
        raise click.ClickException(str(exc)) from exc
    changes = cast("list[dict[str, str]]", applied.result.get("changes") or [])
    if not changes:
        report("Unchanged", summary, style="dim")
        return applied
    report("Done", summary)
    verbs = {
        "modified": "Wrote",
        "created": "Created",
        "deleted": "Deleted",
        "renamed": "Renamed",
    }
    for change in changes:
        kind = change.get("change", "modified")
        detail = change["path"]
        if kind == "renamed":
            detail = f"{change.get('from')} -> {detail}"
        report(verbs.get(kind, kind), detail)
    links = applied.result.get("links")
    if isinstance(links, int) and links:
        report("Relinked", f"{links} slide: link{'s' if links > 1 else ''}")
    if applied.server is None:
        return applied
    report("Undo", f"Ctrl+Z in the editor at {applied.server.url()}", style="dim")
    if applied.build_error:
        last = applied.build_error.strip().splitlines()[-1:]
        report("Build", f"failed after this change: {' '.join(last)}", style="red")
    elif not applied.built:
        report("Build", "the server has not rebuilt yet", style="yellow")
    return applied


def _new_place(applied: Applied, deck_path: Path) -> None:
    """Say where a new slide (``select``: its deck index) ended up."""
    index = applied.result.get("select")
    if not isinstance(index, int):
        return
    try:
        after = _Slides.load(deck_path)
    except click.ClickException:
        return
    if 0 <= index < len(after.ids):
        report("Slide", f"{after.name(index)} is the new one")


@main.group()
def slide() -> None:
    """Add, delete, duplicate, move, hide or rename slides.

    Each command changes deck.py and the slide's own files together (its
    drawing, Markdown, notes and saved ink), exactly as the visual editor does,
    and prints every file it wrote, created, renamed or deleted.

    When `inkflow edit` (or `serve`) has the deck open, the change is made by
    that server: the editor shows it at once as "Agent: …", and Ctrl+Z there
    undoes it. Otherwise the files are changed directly.

    SLIDE is a slide number as the presenter and `inkflow goto` count them
    (1-based, hidden slides left out) or a slide id; a hidden slide goes by id.
    """


@slide.command("add")
@deck_option
@click.option(
    "--layout",
    "-l",
    default=None,
    help="Layout to build it on (see `inkflow layouts`).",
)
@click.option("--like", default=None, metavar="SLIDE", help="The same layout as SLIDE.")
@click.option(
    "--after",
    default=None,
    metavar="SLIDE",
    help="Insert after SLIDE; 0 puts it first [default: last].",
)
@click.option(
    "--id", "name", default=None, help="Name for its files, which gives its id."
)
@click.option("--title", default=None, help="Its title (a leading `# ` heading).")
@click.option(
    "--md",
    default=None,
    help="Its Markdown text (`-` reads stdin), saved as slides/<id>.md.",
)
def add(
    deck_path: Path,
    layout: str | None,
    like: str | None,
    after: str | None,
    name: str | None,
    title: str | None,
    md: str | None,
) -> None:
    """Add a slide with its own drawing, built on a layout.

    The drawing is slides/<id>.svg, on LAYOUT (or the layout of --like),
    blank without either. --title and --md fill its zones through
    slides/<id>.md, as text typed into the editor would.
    """
    if layout and like:
        raise click.UsageError("give --layout or --like, not both")
    slides = _Slides.load(deck_path)
    request: dict[str, object] = {"action": "slide", "op": "new"}
    summary = "Add a slide"
    if like:
        model = slides.index(like)
        request["like"] = model
        summary += f" like {slides.name(model)}"
    elif layout:
        request["layout"] = layout
        summary += f" on {layout}"
    if after is None:
        request["after"] = len(slides.ids) - 1
    elif after.strip() == "0":
        request["after"] = -1
    else:
        request["after"] = slides.index(after)
    if name:
        request["name"] = name
    text = sys.stdin.read() if md == "-" else (md or "")
    if title:
        text = f"# {title.strip()}\n\n{text}".rstrip() + "\n"
    if text.strip():
        request["md"] = text
    applied = _apply(slides, request, summary)
    _new_place(applied, slides.path)


@slide.command("delete")
@click.argument("refs", metavar="SLIDE...", nargs=-1, required=True)
@deck_option
@click.option(
    "--keep-files",
    is_flag=True,
    help="Leave its drawing, Markdown and notes files in place.",
)
def delete(refs: tuple[str, ...], deck_path: Path, keep_files: bool) -> None:
    """Delete slides, with the files only they use.

    Its drawing, Markdown, notes and ink go too, unless another slide uses
    them (a shared layout always stays). All the slides go in one step.
    """
    slides = _Slides.load(deck_path)
    indices = sorted({slides.index(r) for r in refs})
    names = ", ".join(slides.name(i) for i in indices)
    _apply(
        slides,
        {
            "action": "slide",
            "op": "delete",
            "slides": indices,
            "files": not keep_files,
        },
        f"Delete {names}",
    )


@slide.command("duplicate")
@click.argument("ref", metavar="SLIDE")
@deck_option
def duplicate(ref: str, deck_path: Path) -> None:
    """Copy a slide, with its own files, right after it."""
    slides = _Slides.load(deck_path)
    index = slides.index(ref)
    applied = _apply(
        slides,
        {"action": "slide", "op": "duplicate", "slide": index},
        f"Duplicate {slides.name(index)}",
    )
    _new_place(applied, slides.path)


@slide.command("move")
@click.argument("ref", metavar="SLIDE")
@click.option(
    "--to",
    "to",
    type=click.IntRange(min=1),
    required=True,
    help="The number it gets (as the presenter counts); past the end = last.",
)
@deck_option
def move(ref: str, to: int, deck_path: Path) -> None:
    """Move a slide so it becomes slide number --to."""
    slides = _Slides.load(deck_path)
    src = slides.index(ref)
    rest = [i for i in range(len(slides.ids)) if i != src]
    shown = [i for i in rest if slides.numbers[i] is not None]
    # Before the slide that number belongs to once this one is out of the way.
    dst = rest.index(shown[to - 1]) if to <= len(shown) else len(rest)
    _apply(
        slides,
        {"action": "slide", "op": "move", "from": src, "to": dst},
        f"Move {slides.name(src)} to {min(to, len(shown) + 1)}",
    )


def _set_hidden(ref: str, deck_path: Path, hidden: bool) -> None:
    slides = _Slides.load(deck_path)
    index = slides.index(ref)
    if (slides.numbers[index] is None) == hidden:
        state = "hidden" if hidden else "shown"
        report("Unchanged", f"{slides.name(index)} is already {state}", style="dim")
        return
    verb = "Hide" if hidden else "Show"
    _apply(
        slides,
        {"action": "slide", "op": "hide", "slide": index, "hidden": hidden},
        f"{verb} {slides.name(index)}",
    )


@slide.command("hide")
@click.argument("ref", metavar="SLIDE")
@deck_option
def hide(ref: str, deck_path: Path) -> None:
    """Leave a slide out of the presentation (`visible=False`); it keeps its
    files and is addressed by its id while hidden."""
    _set_hidden(ref, deck_path, hidden=True)


@slide.command("show")
@click.argument("ref", metavar="SLIDE")
@deck_option
def show(ref: str, deck_path: Path) -> None:
    """Put a hidden slide back in the presentation."""
    _set_hidden(ref, deck_path, hidden=False)


@slide.command("rename")
@click.argument("ref", metavar="SLIDE")
@click.argument("new_id", metavar="NEW_ID")
@deck_option
def rename(ref: str, new_id: str, deck_path: Path) -> None:
    """Give a slide a new id (`id=` in deck.py).

    Its saved ink follows (ink/<id>.svg), and `slide:<old id>` links in
    deck.py and the slides' files are rewritten to the new id.
    """
    slides = _Slides.load(deck_path)
    index = slides.index(ref)
    _apply(
        slides,
        {"action": "slide", "op": "id", "slide": index, "id": new_id},
        f"Rename {slides.name(index)} to {new_id}",
    )


@slide.command("title")
@click.argument("ref", metavar="SLIDE")
@click.argument("text", metavar="TITLE")
@deck_option
def title_cmd(ref: str, text: str, deck_path: Path) -> None:
    """Set a slide's title (`title=`: the overview, the outline and the tab
    title); an empty TITLE removes it. The text on the slide is not changed."""
    slides = _Slides.load(deck_path)
    index = slides.index(ref)
    _apply(
        slides,
        {"action": "slide", "op": "title", "slide": index, "title": text},
        f"Retitle {slides.name(index)}",
    )


# Shared with the other commands that edit through the session
# (`inkflow replace`, `inkflow anim`).
SlideRefs = _Slides
apply_step = _apply
