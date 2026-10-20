"""``inkflow fonts``: where each font the deck uses comes from
(``fontreport``), so a deck looks the same on every machine.

Plugins add subcommands to the group (inkflow-editor: ``fonts bundle`` and
``fonts set``, which change the deck).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import click

from inkflow.cli._common import Project, deck_option, main
from inkflow.fontreport import FamilyReport, Where, font_report
from inkflow.logging import report

_STYLE = {
    Where.PROJECT: "green",
    Where.THEME: "green",
    Where.MACHINE: "yellow",
    Where.MISSING: "red",
    Where.GENERIC: "yellow",
}


def _print_family(family: FamilyReport, project_dir: Path) -> None:
    faces = ", ".join(f.label for f in family.faces)
    report(
        family.where.value,
        f"{family.family}  [{faces}]  ({', '.join(family.used_by[:3])}"
        + (" …" if len(family.used_by) > 3 else "")
        + ")",
        style=_STYLE[family.where],
    )
    for file in family.files:
        try:
            shown = file.path.relative_to(project_dir).as_posix()
        except ValueError:
            shown = str(file.path)
        report("", f"{shown}", style="dim")
    if family.licence is not None and family.where is Where.MACHINE:
        licence = family.licence
        name = licence.name or "no licence found"
        report("", f"licence: {name} ({licence.status})", style="dim")
    if not family.portable:
        report("", family.message(), style=_STYLE[family.where])


@main.group("fonts", invoke_without_command=True)
@deck_option
@click.option("--json", "as_json", is_flag=True, help="Print the report as JSON.")
@click.pass_context
def fonts_group(ctx: click.Context, deck_path: Path, as_json: bool) -> None:
    """Where each font the deck uses comes from.

    Every family the deck names (theme font tokens, styles.css, SVG text,
    Markdown and chart text), with the weights and styles it uses, resolves
    to one of: `project` (the deck's fonts/, committed), `theme` (shipped
    with inkflow or the deck's theme), `machine` (this computer's font
    folders only: other machines show another font), `missing` (nowhere), or
    `generic` (a stack starting with sans-serif/serif/monospace: each OS
    picks its own). `inkflow fonts bundle` copies the `machine` ones into
    fonts/.
    """
    if ctx.invoked_subcommand is not None:
        ctx.obj = {"deck": deck_path}
        return
    project = Project.load(deck_path)
    result = font_report(project.deck, project.dir)
    if as_json:
        click.echo(json.dumps(result.json(project.dir), indent=2))
        return
    if not result.families:
        report("Fonts", "the deck names no font", style="dim")
        return
    for family in result.families:
        _print_family(family, project.dir)
    problems = result.problems
    if problems:
        report(
            "Portable",
            f"no: {len(problems)} of {len(result.families)} famil"
            + ("y" if len(result.families) == 1 else "ies")
            + " depend on this machine",
            style="yellow",
        )
    else:
        report("Portable", "every font travels with the deck")


def group_deck(ctx: click.Context, deck_path: Path | None) -> Path:
    if deck_path is not None and deck_path != Path("deck.py"):
        return deck_path
    parent = cast("dict[str, object] | None", ctx.obj)
    if isinstance(parent, dict) and isinstance(parent.get("deck"), Path):
        return cast("Path", parent["deck"])
    return deck_path or Path("deck.py")
