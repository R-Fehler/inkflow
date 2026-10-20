"""``inkflow fonts bundle``/``fonts set`` and ``inkflow pack``: the changes
that make a deck look the same on every machine.

They change the deck through the editor session (``agent/remote.py``), so
with an editor open they are one undoable "Agent: …" step there. ``pack`` does
every fix at once (``pack.py``) the same way, then optionally zips the deck's
source tree. ``inkflow fonts`` itself (the report) is the core's.
"""

from __future__ import annotations

from pathlib import Path
from typing import cast

import click

from inkflow.cli._common import DeckSlides, deck_option, main
from inkflow.cli.fonts import fonts_group, group_deck
from inkflow.logging import console, report
from inkflow.pack import make_zip, tools_needed
from inkflow_editor.agent._edits import apply_edit
from inkflow_editor.agent.remote import RemoteEditError, apply_request


@fonts_group.command("bundle")
@deck_option
@click.option(
    "--all-weights",
    is_flag=True,
    help="Copy every file of each family, not only the weights the deck uses.",
)
@click.option("-n", "--dry-run", is_flag=True, help="Only say what would be copied.")
@click.argument("families", nargs=-1)
@click.pass_context
def fonts_bundle(
    ctx: click.Context,
    deck_path: Path,
    all_weights: bool,
    dry_run: bool,
    families: tuple[str, ...],
) -> None:
    """Copy the fonts only this computer has into the deck's fonts/.

    Each family goes to fonts/<family>/ with the files for the weights and
    styles the deck uses (a variable font is one file), the licence files
    found beside it (OFL.txt, LICENSE*, README*), and a line in
    fonts/README.md (family, where it came from, licence). A font whose
    licence forbids sharing, or that has none, is copied with a warning: a
    well-known system font (Arial, Segoe UI, SF Pro, Calibri…) cannot be
    shared, use an open alternative. FAMILIES limits it to those.
    """
    slides = DeckSlides.load(group_deck(ctx, deck_path))
    request: dict[str, object] = {
        "action": "fonts",
        "op": "bundle",
        "allWeights": all_weights,
        **({"families": list(families)} if families else {}),
    }
    if dry_run:
        try:
            applied = apply_request(
                slides.path, slides.deck, slides.hash, {**request, "dryRun": True}
            )
        except RemoteEditError as exc:
            raise click.ClickException(str(exc)) from exc
    else:
        applied = apply_edit(slides, request, "Bundle fonts into the deck")
    plan = cast("dict[str, object]", applied.result.get("bundle") or {})
    _print_bundle(plan, dry_run)


def _print_bundle(plan: dict[str, object], dry_run: bool) -> None:
    copies = cast("list[dict[str, str]]", plan.get("copies") or [])
    if dry_run:
        for copy in copies:
            report("Would copy", f"{copy['from']} -> {copy['to']}", style="yellow")
    if not copies and not dry_run:
        report("Fonts", "nothing to bundle: no font comes from this machine only")
    for warning in cast("list[str]", plan.get("warnings") or []):
        report("Licence", warning, style="yellow")
    for missing in cast("list[str]", plan.get("missing") or []):
        report("Missing", missing, style="red")


@fonts_group.command("set")
@deck_option
@click.argument("role", type=click.Choice(["body", "heading", "mono"]))
@click.argument("family")
@click.option(
    "--no-bundle", is_flag=True, help="Only set the font; do not copy its files in."
)
@click.pass_context
def fonts_set(
    ctx: click.Context, deck_path: Path, role: str, family: str, no_bundle: bool
) -> None:
    """Use FAMILY for the deck's body, heading or mono (code) text.

    Writes the theme token (--inkflow-ROLE-font) in the project's styles.css,
    as the editor's Theme dialog does, with a generic fallback after it
    (`Inter` becomes `Inter, sans-serif`; a whole stack is kept as given),
    and bundles the family into fonts/ when it is installed on this machine
    only. A generic family first (sans-serif, monospace…) is refused: each
    machine would show its own font.
    """
    slides = DeckSlides.load(group_deck(ctx, deck_path))
    applied = apply_edit(
        slides,
        {
            "action": "fonts",
            "op": "set",
            "role": role,
            "family": family,
            "bundle": not no_bundle,
        },
        f"Font: {role} = {family}",
    )
    result = applied.result
    info = cast("dict[str, object] | None", result.get("family"))
    if info is not None:
        where = str(info.get("where"))
        message = str(info.get("message") or "")
        if where in ("project", "theme"):
            report("Font", f"{info.get('family')} comes with the deck ({where})")
        elif message:
            bundled = cast("dict[str, object]", result.get("bundle") or {})
            if bundled.get("copies"):
                report("Bundled", f"{info.get('family')} into fonts/")
                _print_bundle(bundled, False)
            else:
                report("Font", message, style="yellow")
    note = result.get("note")
    if isinstance(note, str):
        report("Note", note, style="yellow")


# ── pack ──


@main.command("pack")
@deck_option
@click.option(
    "--zip",
    "zip_path",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    metavar="FILE",
    help="Also zip the packed deck's source tree (for someone without git).",
)
@click.option("-n", "--dry-run", is_flag=True, help="Only say what packing would do.")
@click.option(
    "--with-pdf-pages",
    is_flag=True,
    help="Convert PDF figures now and commit the SVG pages beside each PDF.",
)
@click.option(
    "--all-weights", is_flag=True, help="Bundle every weight of each font family."
)
def pack_cmd(
    deck_path: Path,
    zip_path: Path | None,
    dry_run: bool,
    with_pdf_pages: bool,
    all_weights: bool,
) -> None:
    """Make the deck self-contained: a clone builds and looks the same anywhere.

    Copies the fonts only this computer has into fonts/ (with licences),
    copies in every file the deck names outside its folder or through a
    symlink (references rewritten where they are written), pins inkflow (and
    a pip-installed theme) in pyproject.toml and runs `uv lock` when there is
    no uv.lock, and adds LF line-ending rules, the SVG diff driver and Git
    LFS rules (unless opted out) to the deck's .gitattributes. With an editor
    open it is one undoable step there. Then it lists what still depends on
    the machine: generic or missing fonts, pictures from the web, emoji and
    formulas without a font in the deck, PDF figures without committed pages
    (`--with-pdf-pages`), and the tools a build needs.
    """
    slides = DeckSlides.load(deck_path)
    request: dict[str, object] = {
        "action": "pack",
        "op": "plan" if dry_run else "apply",
        "withPdfPages": with_pdf_pages,
        "allWeights": all_weights,
    }
    if dry_run:
        try:
            applied = apply_request(slides.path, slides.deck, slides.hash, request)
        except RemoteEditError as exc:
            raise click.ClickException(str(exc)) from exc
    else:
        applied = apply_edit(slides, request, "Pack the deck")
    result = applied.result
    plan = cast("dict[str, object]", result.get("pack") or {})
    steps = cast("list[str]", plan.get("steps") or [])
    if dry_run:
        for step in steps:
            report("Would", step, style="yellow")
        assets = cast("dict[str, object]", plan.get("assets") or {})
        for copy in cast("list[dict[str, str]]", assets.get("copies") or []):
            report("Would copy", f"{copy['from']} -> {copy['to']}", style="yellow")
        for edit in cast("list[dict[str, str]]", assets.get("edits") or []):
            report(
                "Would edit",
                f"{edit['file']}: {edit['kind']} {edit['old']!r} -> {edit['new']!r}",
                style="yellow",
            )
        fonts = cast("dict[str, object]", plan.get("fonts") or {})
        for copy in cast("list[dict[str, str]]", fonts.get("copies") or []):
            report("Would copy", f"{copy['from']} -> {copy['to']}", style="yellow")
        if not steps:
            report("Packed", "nothing to do: the deck is self-contained")
    else:
        lock = result.get("lock")
        if isinstance(lock, str):
            ok = lock.startswith("uv.lock written")
            report("Lock", lock, style="green" if ok else "yellow")
    fonts = cast("dict[str, object]", plan.get("fonts") or {})
    for warning in cast("list[str]", fonts.get("warnings") or []):
        report("Licence", warning, style="yellow")
    assets = cast("dict[str, object]", plan.get("assets") or {})
    for warning in cast("list[str]", assets.get("warnings") or []):
        report("Warning", warning, style="yellow")
    items = cast("list[dict[str, object]]", plan.get("items") or [])
    remaining = [i for i in items if not i.get("fixable")]
    if remaining:
        console.print("\nStill machine-dependent:", markup=False)
        for item in remaining:
            report("-", f"{item['message']}", style="yellow")
    console.print("\nTo build elsewhere:", markup=False)
    for line in tools_needed():
        report("-", line, style="dim")
    if zip_path is not None:
        if dry_run:
            report("Would zip", str(zip_path), style="yellow")
        else:
            names = make_zip(slides.project_dir, zip_path)
            report("Zipped", f"{len(names)} files into {zip_path}")
