"""What the agent-facing edit commands share (``inkflow slide``, ``inkflow shape``).

They address slides as the presenter numbers them (or by id), send the visual
editor's own session actions through ``editor.remote`` (the running editor
server, as an undoable "Agent: …" step, else the files directly), and print
what changed in the same terse lines.
"""

from __future__ import annotations

from typing import cast

import click

from inkflow.cli._common import DeckSlides
from inkflow.logging import report
from inkflow_editor.agent.remote import Applied, RemoteEditError, apply_request


def apply_edit(slides: DeckSlides, request: dict[str, object], summary: str) -> Applied:
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


def report_rename(result: dict[str, object], dry_run: bool) -> None:
    """Print what a rename changes (``rename`` in a session result): the
    files that move and every reference rewritten, file by file."""
    plan = cast("dict[str, object]", result.get("rename") or {})
    moves = cast("list[dict[str, str]]", plan.get("moves") or [])
    edits = cast("list[dict[str, str]]", plan.get("edits") or [])
    if dry_run:
        for move in moves:
            report("Would move", f"{move['from']} -> {move['to']}", style="yellow")
    for edit in edits:
        report(
            "Would edit" if dry_run else "Reference",
            f"{edit['file']}: {edit['kind']} {edit['old']!r} -> {edit['new']!r}",
            style="yellow" if dry_run else "dim",
        )
    ids = cast("dict[str, str]", plan.get("ids") or {})
    for old, new in ids.items():
        report("Slide id", f"{old} -> {new} (its ink and slide: links follow)")
    for shared in cast("list[str]", plan.get("shared") or []):
        report("Kept", f"{shared}: not this slide's alone", style="dim")
    count, files = plan.get("references", 0), plan.get("files", 0)
    report(
        "References",
        f"{count} in {files} file{'' if files == 1 else 's'}"
        + (" would be updated" if dry_run else " updated"),
        style="yellow" if dry_run else "green",
    )
    for warning in cast("list[str]", plan.get("warnings") or []):
        report("Warning", warning, style="yellow")


def rename_request(
    slides: DeckSlides, request: dict[str, object], summary: str, dry_run: bool
) -> None:
    """Run a ``rename`` session action (``inkflow mv``, ``inkflow slide
    rename-files``): with ``dry_run`` only print what it would change."""
    if not dry_run:
        applied = apply_edit(slides, request, summary)
        report_rename(applied.result, dry_run=False)
        return
    try:
        applied = apply_request(
            slides.path, slides.deck, slides.hash, {**request, "dryRun": True}
        )
    except RemoteEditError as exc:
        raise click.ClickException(str(exc)) from exc
    report_rename(applied.result, dry_run=True)


def _names(paths: list[str], limit: int = 4) -> str:
    shown = ", ".join(paths[:limit])
    return shown + (f" and {len(paths) - limit} more" if len(paths) > limit else "")


def deletion_warnings(
    deleted: list[dict[str, object]], repo: bool, undo: bool
) -> list[tuple[str, str, str]]:
    """What can bring back the files a step deletes, as (verb, words, style)
    lines: the editor's delete dialog says the same. ``undo``: the step is in
    an open editor's History (else nothing but git can restore them)."""
    if not deleted:
        return []
    if not repo:
        words = (
            "deleted files come back only with Undo in the editor, while it is open."
            if undo
            else "deleted files cannot be brought back."
        )
        return [("Warning", f"this deck is not in a git repository: {words}", "yellow")]
    lost = [str(d["path"]) for d in deleted if d.get("git") in ("untracked", "ignored")]
    changed = [str(d["path"]) for d in deleted if d.get("git") == "modified"]
    lines: list[tuple[str, str, str]] = []
    if lost:
        n = len(lost)
        them = "it" if n == 1 else "them"
        after = (
            f"Undo in the editor brings {them} back only while it stays open."
            if undo
            else f"Nothing else can bring {them} back."
        )
        lines.append(
            (
                "Not in git",
                f"{n} file{'' if n == 1 else 's'} ({_names(lost)}) can't be restored "
                + f"from version control. {after}",
                "yellow",
            )
        )
    if changed:
        n = len(changed)
        lines.append(
            (
                "Uncommitted changes",
                f"in {n} file{'' if n == 1 else 's'} ({_names(changed)}): git keeps "
                + f"only {'its' if n == 1 else 'their'} last committed version.",
                "yellow",
            )
        )
    if not lines:
        lines.append(
            (
                "In git",
                "all of them: `git restore` (the editor's Git menu → Discard "
                + "changes) brings them back.",
                "dim",
            )
        )
    return lines


def report_deleted(result: dict[str, object], dry_run: bool, undo: bool) -> None:
    """Print the files a step deletes (``deleted`` in its result, with what
    git could bring back of each) when ``dry_run``, then the git warnings."""
    deleted = cast("list[dict[str, object]]", result.get("deleted") or [])
    if dry_run:
        for d in deleted:
            report("Would delete", f"{d['path']}  ({d.get('git')})", style="yellow")
    for verb, words, style in deletion_warnings(
        deleted, bool(result.get("repo")), undo
    ):
        report(verb, words, style=style)
