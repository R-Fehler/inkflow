"""``inkflow layout`` and ``inkflow overlay``: the slide master from the
command line.

A theme's layouts live in an installed package. ``layout copy`` gives the deck
its own copy of one (``layouts/<name>.svg``), which every slide on it then
follows, also through the theme's own chains: a copy of ``base`` is the
background of every built-in layout. ``layout revert`` deletes the copy.
``layout save`` makes a new layout (a template) from a slide. ``overlay new``
adds an overlay, drawn on top of every slide (or of one).

Like ``inkflow slide``, each command is the visual editor's own session
action (``master``), so with an editor open it is an undoable "Agent: …" step
there (``editor.remote``).
"""

from __future__ import annotations

from pathlib import Path
from typing import cast

import click

from inkflow.cli._common import deck_option, main
from inkflow.cli._edits import DeckSlides, apply_edit, report_rename
from inkflow.logging import report


@main.group("layout")
def layout_group() -> None:
    """Change the deck's layouts: the slide master behind every slide.

    A theme's layout is never written: `layout copy` gives the deck its own
    copy (layouts/NAME.svg), which every slide on that layout follows, and
    `layout revert` goes back to the theme's. Copying `base`, the background
    of every built-in layout, changes the background of every slide.
    `layout save` makes a new layout (a template) from a slide. See
    `inkflow layouts` for the names.

    When `inkflow edit` (or `serve`) has the deck open, the change is an
    undoable "Agent: …" step in that editor.
    """


@layout_group.command("copy")
@click.argument("name")
@deck_option
def layout_copy(name: str, deck_path: Path) -> None:
    """Give the deck its own copy of the theme's layout NAME.

    The copy is layouts/NAME.svg; slides on NAME (and layouts built on it)
    follow it from now on. Edit it in the editor's slide master or in
    Inkscape; `inkflow layout revert NAME` goes back to the theme's.
    """
    slides = DeckSlides.load(deck_path)
    applied = apply_edit(
        slides,
        {"action": "master", "op": "copy", "name": name},
        f"Copy layout {name} into the deck",
    )
    _note(applied.result)


@layout_group.command("revert")
@click.argument("name")
@deck_option
def layout_revert(name: str, deck_path: Path) -> None:
    """Delete the deck's copy of layout NAME: slides go back to the theme's."""
    slides = DeckSlides.load(deck_path)
    _ = apply_edit(
        slides,
        {"action": "master", "op": "revert", "name": name},
        f"Revert layout {name} to the theme's",
    )


@layout_group.command("save")
@click.argument("ref", metavar="SLIDE")
@click.argument("name")
@deck_option
@click.option(
    "--hints",
    is_flag=True,
    help="Keep the slide's text as each empty zone's placeholder prompt.",
)
@click.option(
    "--pictures",
    is_flag=True,
    help="Turn the slide's own pictures into picture placeholders.",
)
def layout_save(
    ref: str, name: str, deck_path: Path, hints: bool, pictures: bool
) -> None:
    """Save SLIDE as a new layout called NAME (a template).

    NAME is kept as typed for the editor ("customCodeExamples"); the file is
    layouts/<name in kebab case>.svg (custom-code-examples.svg). The slide's
    drawing and the layout it is built on carry over; its zones stay, empty.
    New slides then use it: `inkflow slide add --layout custom-code-examples`.
    """
    slides = DeckSlides.load(deck_path)
    index = slides.index(ref)
    applied = apply_edit(
        slides,
        {
            "action": "master",
            "op": "save",
            "slide": index,
            "name": name,
            "hints": hints,
            "pictures": pictures,
        },
        f"Save {slides.name(index)} as layout {name}",
    )
    stem = applied.result.get("layout")
    if isinstance(stem, str):
        report("Layout", f"{stem}: inkflow slide add --layout {stem}")


@layout_group.command("rename")
@click.argument("name")
@click.argument("new")
@deck_option
def layout_rename(name: str, new: str, deck_path: Path) -> None:
    """Rename the deck's own layout NAME to NEW, every reference following.

    A copy of a theme's layout keeps the theme's name (it replaces that
    layout); save a slide as a new layout instead.
    """
    slides = DeckSlides.load(deck_path)
    applied = apply_edit(
        slides,
        {"action": "master", "op": "rename", "name": name, "to": new},
        f"Rename layout {name} to {new}",
    )
    if "rename" in applied.result:
        report_rename(applied.result, dry_run=False)


@layout_group.command("delete")
@click.argument("name")
@deck_option
@click.option(
    "--move-to",
    default=None,
    metavar="LAYOUT",
    help="Move the slides (and layouts) built on NAME to LAYOUT first.",
)
def layout_delete(name: str, deck_path: Path, move_to: str | None) -> None:
    """Delete the deck's own layout NAME.

    Refused while slides or other layouts are built on it, unless --move-to
    names the layout they move to. A copy of a theme's layout is reverted
    with `inkflow layout revert` instead.
    """
    slides = DeckSlides.load(deck_path)
    request: dict[str, object] = {"action": "master", "op": "delete", "name": name}
    if move_to:
        request["moveTo"] = move_to
    _ = apply_edit(slides, request, f"Delete layout {name}")


@main.group("overlay")
def overlay_group() -> None:
    """Change the deck's overlays: what is drawn on top of every slide.

    An overlay (overlays/NAME.svg) holds the chrome every slide shows
    whatever its layout: a logo, footer text, the slide number. `overlay new`
    creates one at the deck's size and adds it to `Deck(overlays=[...])`.
    """


@overlay_group.command("new")
@click.argument("name")
@deck_option
@click.option(
    "--all",
    "every",
    is_flag=True,
    default=True,
    help="On every slide: added to Deck(overlays=[...]) [default].",
)
@click.option(
    "--slide",
    "ref",
    default=None,
    metavar="SLIDE",
    help="On SLIDE only: added to its own Slide(overlays=[...]).",
)
def overlay_new(name: str, deck_path: Path, every: bool, ref: str | None) -> None:
    """Create an empty overlay NAME and put it on top of every slide.

    It is overlays/<name>.svg at the deck's size (Deck(size=...), else the
    background layout's), added after the overlays the deck (or with --slide,
    that slide) already gets. Draw into it in the editor's slide master
    ("All slides · On top") or in Inkscape.
    """
    _ = every
    slides = DeckSlides.load(deck_path)
    request: dict[str, object] = {"action": "master", "op": "new-overlay", "name": name}
    summary = f"New overlay {name}"
    if ref is not None:
        index = slides.index(ref)
        request["slide"] = index
        summary += f" on {slides.name(index)}"
    applied = apply_edit(slides, request, summary)
    _note(applied.result)


@overlay_group.command("copy")
@click.argument("name")
@deck_option
def overlay_copy(name: str, deck_path: Path) -> None:
    """Give the deck its own copy of the theme's overlay NAME."""
    slides = DeckSlides.load(deck_path)
    applied = apply_edit(
        slides,
        {"action": "master", "op": "copy", "kind": "overlay", "name": name},
        f"Copy overlay {name} into the deck",
    )
    _note(applied.result)


@overlay_group.command("revert")
@click.argument("name")
@deck_option
def overlay_revert(name: str, deck_path: Path) -> None:
    """Delete the deck's copy of overlay NAME: the theme's is used again."""
    slides = DeckSlides.load(deck_path)
    _ = apply_edit(
        slides,
        {"action": "master", "op": "revert", "kind": "overlay", "name": name},
        f"Revert overlay {name} to the theme's",
    )


def _note(result: dict[str, object]) -> None:
    copied = result.get("copied")
    if isinstance(copied, dict):
        note = cast("dict[str, str]", copied).get("note", "")
        report("Note", note, style="dim")
    overlay = result.get("overlay")
    if isinstance(overlay, dict):
        made = cast("dict[str, str]", overlay)
        report("Overlay", f"{made.get('name')} is drawn on {made.get('where')}")
