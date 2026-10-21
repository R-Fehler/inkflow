"""``inkflow render``: what slides look like, and their layout problems.

Headless Chromium draws each slide as the presenter shows it; the PNGs are
what an agent (or a person) reads back to check an edit, and the measured
findings (text overflowing its zone, objects off the slide, low contrast)
are what ``--check`` exits on.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import click

from inkflow import plugins
from inkflow.cli._common import deck_option, main, resolve_deck_path, slide_number
from inkflow.render import render_json, render_slides, summary
from inkflow.workdir import work_dir


def current_slide(project_dir: Path) -> int:
    """The slide to render when none is named: the one a plugin says the
    author is looking at (an editor's current slide), else the first."""
    for plugin in plugins.loaded():
        number = plugin.current_slide(project_dir)
        if number is not None and number > 0:
            return number
    return 1


@main.command()
@deck_option
@click.option(
    "--slide",
    "-s",
    "slides",
    multiple=True,
    help="Slide number (1-based) or id; repeatable. Default: the slide a plugin"
    + " reports open (an editor's), else the first (every slide with --sheet"
    + " or --check).",
)
@click.option("--all", "all_slides", is_flag=True, help="Render every slide.")
@click.option(
    "--step",
    type=int,
    default=None,
    help="Build step to show (default: the final state, everything revealed).",
)
@click.option(
    "--sheet",
    is_flag=True,
    help="One contact-sheet PNG with the slides in a grid, labelled with their"
    + " numbers and ids, instead of one image per slide.",
)
@click.option(
    "--check",
    is_flag=True,
    help="Only measure the layout: write no images, exit 1 on a problem.",
)
@click.option(
    "--output",
    "-o",
    default=None,
    help="PNG file for one slide or a sheet, or a directory"
    + " (default: .inkflow/render/).",
)
@click.option(
    "--by-id",
    "by_id",
    is_flag=True,
    help="Name the images after the slides' ids (`<id>.png`) instead of their"
    + " numbers (`slide-N.png`): a name that stays when slides are added.",
)
@click.option(
    "--scale",
    type=float,
    default=0.5,
    show_default=True,
    help="Image scale relative to the slide's own size.",
)
@click.option(
    "--boxes",
    is_flag=True,
    help="Print every element's rendered box in slide units (ids, zones with"
    + " their content's extent and free space, each block of a zone's text);"
    + " writes no images unless --output is given.",
)
@click.option(
    "--no-contrast",
    "no_contrast",
    is_flag=True,
    help="Skip the text contrast check (two more screenshots per slide).",
)
@click.option("--json", "as_json", is_flag=True, help="Print the result as JSON.")
@click.option("--chromium", default=None, help="Path to a Chromium/Chrome binary.")
@click.option(
    "--no-sandbox", "no_sandbox", is_flag=True, help="Pass --no-sandbox to Chromium."
)
def render(
    deck_path: Path,
    slides: tuple[str, ...],
    all_slides: bool,
    step: int | None,
    sheet: bool,
    check: bool,
    output: str | None,
    by_id: bool,
    scale: float,
    boxes: bool,
    no_contrast: bool,
    as_json: bool,
    chromium: str | None,
    no_sandbox: bool,
) -> None:
    """Render slides to PNG images and report layout problems.

    Uses headless Chromium, like `export`. Without `--slide`, renders the
    slide a plugin reports open (an editor's), or the first. Prints the path
    of every image written, which is what an agent reads back to check its
    own edits, then one line per layout problem: text that overflows its
    zone, a code block cut off, an object outside the slide, text too small
    to read (a hint), text whose contrast with what is behind it is below 3:1
    (between 3:1 and 4.5:1 for text under 24px on a 1080px slide: a hint).

    `--sheet` puts the slides on one contact sheet (16 per image at most).
    `--check` measures without writing images and exits 1 if anything other
    than a hint was found.

    `--boxes` prints where the browser drew everything, in slide units, one
    line per element (`id  x,y wxh  kind  "text"`): each element with an id,
    each zone with the extent of its content and the space left in it, and
    each block of a zone's text (paragraph, list, heading, code, table,
    picture) with the extent of its text, so things can be placed against
    real text instead of guessed sizes.
    """
    if check and sheet:
        raise click.UsageError("--check writes no images; drop --sheet or --check")
    if boxes and sheet:
        raise click.UsageError("--boxes measures slides one by one; drop --sheet")
    resolved = resolve_deck_path(deck_path)
    project_dir = resolved.parent
    numbers: list[int] | None
    if all_slides or (not slides and (sheet or check)):
        numbers = None
    else:
        numbers = [slide_number(resolved, s) for s in slides] or [
            current_slide(project_dir)
        ]
    out: Path | None = None
    # --boxes alone writes no images; with --output it does both.
    if not check and not (boxes and output is None):
        out = Path(output) if output else work_dir(project_dir) / "render"
    try:
        result = render_slides(
            resolved,
            numbers,
            out,
            sheet=sheet,
            step=step,
            scale=scale,
            chromium=chromium,
            no_sandbox=no_sandbox or running_as_root(),
            boxes=boxes,
            contrast=not no_contrast,
            by_id=by_id,
        )
    except (RuntimeError, ValueError) as exc:
        raise click.ClickException(str(exc)) from exc
    if as_json:
        click.echo(json.dumps(render_json(result), ensure_ascii=False))
        if check and any(f.is_problem for f in result.findings):
            sys.exit(1)
        return
    for slide_boxes in result.boxes:
        click.echo(slide_boxes.text())
    for path in result.images:
        click.echo(str(path))
    for finding in result.findings:
        click.echo(finding.message())
    if check:
        click.echo(summary(result.findings, len(result.slides)))
        if any(f.is_problem for f in result.findings):
            sys.exit(1)


def running_as_root() -> bool:
    # Chromium refuses to start sandboxed as root (containers, CI).
    return hasattr(os, "geteuid") and os.geteuid() == 0
