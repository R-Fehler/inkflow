"""``inkflow slide``: add, delete, duplicate, move, hide and rename slides,
and group them in sections (``inkflow slide section``).

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

    def section(self, ref: str) -> int:
        """The index of SECTION (a name, any case, or a 1-based position)."""
        names = [s.name for s in self.deck.sections]
        if not names:
            raise click.BadParameter("the deck has no sections", param_hint="SECTION")
        ref = ref.strip()
        if ref.isdigit() and 1 <= int(ref) <= len(names):
            return int(ref) - 1
        found = [k for k, name in enumerate(names) if name.casefold() == ref.casefold()]
        if len(found) == 1:
            return found[0]
        if found:
            places = ", ".join(str(k + 1) for k in found)
            raise click.BadParameter(
                f"{len(found)} sections are called {ref!r} ({places}): "
                + "give its number",
                param_hint="SECTION",
            )
        raise click.BadParameter(
            f"no section {ref!r} (sections: {', '.join(names)})", param_hint="SECTION"
        )

    def section_name(self, k: int) -> str:
        return repr(self.deck.sections[k].name)

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
    """Add, delete, duplicate, move, hide or rename slides; group them in sections.

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
    default=None,
    help="The number it gets (as the presenter counts); past the end = last.",
)
@click.option(
    "--section",
    "section_ref",
    default=None,
    metavar="SECTION",
    help="The section it joins (at its end, or at --to within it).",
)
@deck_option
def move(ref: str, to: int | None, section_ref: str | None, deck_path: Path) -> None:
    """Move a slide so it becomes slide number --to, or into --section.

    With --to alone it joins the section of the slide it lands before.
    """
    if to is None and section_ref is None:
        raise click.UsageError("give --to, --section or both")
    slides = _Slides.load(deck_path)
    src = slides.index(ref)
    rest = [i for i in range(len(slides.ids)) if i != src]
    shown = [i for i in rest if slides.numbers[i] is not None]
    request: dict[str, object] = {"action": "slide", "op": "move", "from": src}
    where: list[str] = []
    if to is not None:
        # Before the slide that number belongs to once this one is out of the way.
        request["to"] = rest.index(shown[to - 1]) if to <= len(shown) else len(rest)
        where.append(f"to {min(to, len(shown) + 1)}")
    else:
        request["to"] = len(rest)  # the session keeps it inside the section
    if section_ref is not None:
        k = slides.section(section_ref)
        request["section"] = k
        where.append(f"into section {slides.section_name(k)}")
    _apply(slides, request, f"Move {slides.name(src)} {' '.join(where)}")


# ── Sections ──────────────────────────────────────────────────────────────────


@slide.group("section")
def section_group() -> None:
    """Add, rename, move or remove sections (named groups of slides).

    SECTION is a section's name (any case) or its 1-based position among the
    sections. Slides before the first section belong to none. Each command is
    one step, undoable in an open editor like the other slide commands.
    """


@section_group.command("add")
@click.argument("name")
@click.option(
    "--at",
    default=None,
    metavar="SLIDE",
    help="The slide it starts at; it takes the rest of that slide's section "
    + "[default: a new empty section at the end].",
)
@deck_option
def section_add(name: str, at: str | None, deck_path: Path) -> None:
    """Start a section called NAME at slide --at."""
    slides = _Slides.load(deck_path)
    request: dict[str, object] = {"action": "slide", "op": "section-add", "name": name}
    summary = f"Add section {name}"
    if at is not None:
        index = slides.index(at)
        request["slide"] = index
        summary += f" at {slides.name(index)}"
    _apply(slides, request, summary)


@section_group.command("rename")
@click.argument("ref", metavar="SECTION")
@click.argument("name", metavar="NEW_NAME")
@deck_option
def section_rename(ref: str, name: str, deck_path: Path) -> None:
    """Rename a section."""
    slides = _Slides.load(deck_path)
    k = slides.section(ref)
    _apply(
        slides,
        {"action": "slide", "op": "section-rename", "section": k, "name": name},
        f"Rename section {slides.section_name(k)} to {name}",
    )


@section_group.command("move")
@click.argument("ref", metavar="SECTION")
@click.option(
    "--to",
    type=click.IntRange(min=1),
    default=None,
    help="The position it gets among the sections (1 = first).",
)
@click.option(
    "--before", default=None, metavar="SECTION", help="Put it before SECTION."
)
@deck_option
def section_move(ref: str, to: int | None, before: str | None, deck_path: Path) -> None:
    """Move a section, with all its slides, among the sections.

    Slides before the first section stay first.
    """
    if (to is None) == (before is None):
        raise click.UsageError("give --to or --before")
    slides = _Slides.load(deck_path)
    k = slides.section(ref)
    count = len(slides.deck.sections)
    if before is not None:
        other = slides.section(before)
        dst = other - 1 if other > k else other
        where = f"before {slides.section_name(other)}"
    else:
        assert to is not None
        dst = min(to, count) - 1
        where = f"to {dst + 1}"
    _apply(
        slides,
        {"action": "slide", "op": "section-move", "section": k, "to": dst},
        f"Move section {slides.section_name(k)} {where}",
    )


@section_group.command("remove")
@click.argument("ref", metavar="SECTION")
@click.option(
    "--with-slides",
    is_flag=True,
    help="Delete its slides too (with the files only they use).",
)
@click.option(
    "--keep-files",
    is_flag=True,
    help="With --with-slides: leave the slides' files in place.",
)
@deck_option
def section_remove(
    ref: str, with_slides: bool, keep_files: bool, deck_path: Path
) -> None:
    """Remove a section; its slides join the section before it (or none).

    With --with-slides its slides are deleted as `inkflow slide delete` does.
    """
    slides = _Slides.load(deck_path)
    k = slides.section(ref)
    summary = f"Remove section {slides.section_name(k)}"
    if with_slides:
        summary += " and its slides"
    _apply(
        slides,
        {
            "action": "slide",
            "op": "section-remove",
            "section": k,
            "slides": with_slides,
            "files": with_slides and not keep_files,
        },
        summary,
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
