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
from pathlib import Path

import click

from inkflow.cli._common import deck_option, main
from inkflow.cli._edits import DeckSlides as _Slides
from inkflow.cli._edits import apply_edit as _apply
from inkflow.editor.remote import Applied
from inkflow.logging import report


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
