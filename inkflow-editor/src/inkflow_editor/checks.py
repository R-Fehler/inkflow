"""The editor's lines in ``inkflow verify`` (registered by its plugin).

Arrows the editor attached to shapes that have moved since (``inkflow shape
reroute`` fixes them), and what ties the deck to this machine (``inkflow
pack`` fixes most of it).
"""

from __future__ import annotations

from pathlib import Path

from inkflow.manifest import Deck, Slide
from inkflow.pipeline import slide_ids
from inkflow.plugins import Issue
from inkflow_editor.scene import Scene


def check_connectors(slide: Slide, project_dir: Path, deck: Deck | None) -> list[Issue]:
    """Arrows attached to shapes whose drawn ends no longer meet them (the
    shapes moved in Inkscape, draw.io or by hand since the arrow was routed):
    the editor's stale-arrow rule, which ``inkflow shape reroute`` fixes."""
    if deck is None:
        return []
    visible = [s for s in deck.slides if s.visible]
    shown = [i for i, s in enumerate(visible) if s is slide]
    slide_id = slide_ids(visible)[shown[0]] if shown else slide_ids([slide])[0]
    try:
        scene = Scene.compose(project_dir, deck, slide, slide_id)
    except (ValueError, OSError):
        return []  # reported by the composition checks
    issues: list[Issue] = []
    for conn in scene.attached():
        shapes = scene.stale_ends(conn)
        if shapes:
            name = f"#{conn.get('id')}" if conn.get("id") else "without an id"
            issues.append(
                (
                    "warn",
                    f"arrow {name} no longer meets {' and '.join(shapes)} "
                    + "(moved since it was routed): run `inkflow shape reroute "
                    + f"-s {slide_id}`",
                )
            )
    return issues


def check_portable(deck: Deck, project_dir: Path, deck_path: Path) -> list[Issue]:
    """What ties the deck to this machine (``inkflow pack``'s checks), one
    warning line each: fonts from this machine, missing or generic first,
    files outside the deck or behind a symlink, pictures from the web, no
    pinned inkflow, no uv.lock, no LF line-ending rules. (Git LFS has the
    editor's git menu; emoji and math fonts are ``inkflow pack``'s report.)"""
    from inkflow_editor.pack import plan_pack

    try:
        plan = plan_pack(deck, project_dir, deck_path)
    except Exception as exc:
        return [("warn", f"could not check portability: {exc}")]
    issues: list[Issue] = []
    by_key: dict[str, list[str]] = {}
    for item in plan.items:
        by_key.setdefault(item.key, []).append(item.message)
    for key in ("font", "missing-font", "generic-font"):
        issues += [("warn", message) for message in by_key.get(key, [])]
    outside = [src for src, _ in plan.copy_in.copies] + [
        dst for dst in plan.copy_in.writes if not dst.exists()
    ]
    if outside:
        names = ", ".join(p.name for p in outside[:3]) + (
            " …" if len(outside) > 3 else ""
        )
        issues.append(
            (
                "warn",
                f"{len(outside)} file(s) outside the deck or behind a symlink "
                + f"({names}): a clone will not have them; inkflow pack copies them in",
            )
        )
    remote = plan.copy_in.remote
    if remote:
        issues.append(
            (
                "warn",
                f"{len(remote)} picture(s) read from the web ({remote[0].raw}"
                + (" …" if len(remote) > 1 else "")
                + "): they need internet access",
            )
        )
    for key, hint in (
        ("pyproject", "inkflow pack"),
        ("lock", "inkflow pack (or uv lock)"),
        ("eol", "inkflow pack adds them"),
    ):
        for message in by_key.get(key, []):
            issues.append(("warn", f"{message}: {hint}"))
    return issues
