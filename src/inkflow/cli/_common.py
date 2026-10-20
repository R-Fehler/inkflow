from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import click
from typing_extensions import override

from inkflow import logging as inkflow_logging
from inkflow import sync
from inkflow.deps import file_hash
from inkflow.enums import ColorMode
from inkflow.manifest import Deck
from inkflow.pipeline import slide_ids
from inkflow.server import DeckError, load_deck
from inkflow.themes import Theme

_level_choice = click.Choice(inkflow_logging.LEVEL_NAMES)


class _Group(click.Group):
    """Reports a deck.py that does not load as one line, not a traceback: the
    reader (often an agent) needs the file, line and error to fix it."""

    @override
    def invoke(self, ctx: click.Context) -> object:
        try:
            return cast(object, super().invoke(ctx))
        except DeckError as exc:
            raise click.ClickException(str(exc)) from exc


@click.group(cls=_Group)
@click.version_option()
@click.option(
    "--log-level",
    type=_level_choice,
    default=None,
    help="Baseline level for every sink (console, file, browser).",
)
@click.option(
    "--log-level-console",
    type=_level_choice,
    default=None,
    help="Console/TUI level [default: warning]. Overrides --log-level.",
)
@click.option(
    "--log-level-file",
    type=_level_choice,
    default=None,
    help="File level [default: off]. Overrides --log-level.",
)
@click.option(
    "--log-level-browser",
    type=_level_choice,
    default=None,
    help="Presenter banner level [default: warning]. Overrides --log-level.",
)
@click.option(
    "--log-file",
    type=click.Path(dir_okay=False),
    default=None,
    metavar="PATH",
    help="File-sink destination (default: per-user log dir). Does not enable the sink.",
)
@click.pass_context
def main(
    ctx: click.Context,
    log_level: str | None,
    log_level_console: str | None,
    log_level_file: str | None,
    log_level_browser: str | None,
    log_file: str | None,
) -> None:
    """Beautiful slides from SVG. Your editor, your style."""
    # `serve` owns the terminal with a Rich Live display, so it surfaces records
    # itself (collected per rebuild, shown in the TUI and browser); every other
    # command renders through the shared stderr console. Each sink resolves its own
    # level (flags + INKFLOW_LOG_LEVEL* env, per-sink beating the --log-level baseline).
    levels = inkflow_logging.resolve_levels(
        log_level=log_level,
        console=log_level_console,
        file=log_level_file,
        browser=log_level_browser,
        log_file=log_file,
    )
    inkflow_logging.configure(
        levels, attach_console=ctx.invoked_subcommand not in ("serve", "edit")
    )
    # `serve` reads the resolved levels back to filter its per-rebuild log collection
    # for the TUI and browser sinks.
    ctx.obj = levels


def resolve_deck_path(deck_path: Path) -> Path:
    resolved = deck_path.resolve()
    if not resolved.exists():
        raise click.ClickException(f"deck not found: {resolved}")
    return resolved


@dataclass(frozen=True)
class Target:
    """A file to operate on: its resolved path plus the label shown to the user."""

    path: Path
    label: str


def resolve_targets(files: Iterable[Path]) -> list[Target]:
    """Resolve each file, raising on the first that does not exist (exit 1)."""
    targets: list[Target] = []
    for file in files:
        resolved = file.resolve()
        if not resolved.exists():
            raise click.ClickException(f"file not found: {resolved}")
        targets.append(Target(resolved, file.as_posix()))
    return targets


@dataclass(frozen=True)
class Project:
    """A loaded deck together with the directory paths resolve against."""

    deck: Deck
    dir: Path

    @classmethod
    def load(cls, deck_path: Path) -> Project:
        resolved = resolve_deck_path(deck_path)
        return cls(load_deck(resolved), resolved.parent)

    @property
    def theme(self) -> Theme:
        return self.deck.theme

    def slide_targets(self) -> list[Target]:
        """Every project-local SVG the deck resolves to, deduplicated.

        For each slide this collects its base SVG plus every ancestor in its layout
        chain, then adds the project's overlay files (which no slide *is* backed by,
        yet still want a backdrop and preview styles), and keeps only files inside
        the project directory. Built-in and theme layouts, and anything referenced by
        a path outside the project, are left out of the default sweep — name them
        explicitly to touch them.
        """
        try:
            backing = sync.slides_by_file(self.deck, self.dir, self.theme)
            overlays = sync.overlay_files(self.deck, self.dir, self.theme)
        except ValueError as exc:
            raise click.ClickException(str(exc)) from exc

        seen: dict[Path, Target] = {}
        for resolved in [*backing, *sorted(overlays)]:
            if resolved in seen or not resolved.is_relative_to(self.dir):
                continue
            seen[resolved] = Target(resolved, resolved.relative_to(self.dir).as_posix())
        return list(seen.values())

    def preview_context(self, dark_mode: bool) -> sync.PreviewContext:
        """The per-run data every preview plan for this project derives from."""
        try:
            return sync.build_context(self.deck, self.dir, self.theme, dark_mode)
        except ValueError as exc:
            raise click.ClickException(str(exc)) from exc


def load_project_or_none(deck_path: Path, no_deck: bool) -> Project | None:
    return None if no_deck else Project.load(deck_path)


def targets_or_deck_slides(
    files: tuple[Path, ...], project: Project | None
) -> list[Target]:
    """Explicit FILES if given, else every project-local SVG the deck uses.

    The fallback covers each slide's base SVG plus its local layout ancestors
    (see ``Project.slide_targets``). Raises if FILES is omitted with no deck to
    fall back on (``--no-deck``).
    """
    if files:
        return resolve_targets(files)
    if project is None:
        raise click.UsageError("FILES required with --no-deck")
    return project.slide_targets()


def resolve_dark_mode(
    color_mode: str | None, deck_obj: Deck | None, no_deck: bool
) -> bool:
    if no_deck or deck_obj is None:
        return color_mode != "light"
    if color_mode is None:
        return deck_obj.effective_mode == ColorMode.DARK
    return color_mode == "dark"


deck_option = click.option(
    "-d",
    "--deck",
    "deck_path",
    default="deck.py",
    type=click.Path(path_type=Path),
    help="Path to deck.py (default: deck.py in cwd)",
)

no_deck_option = click.option(
    "--no-deck",
    "no_deck",
    is_flag=True,
    help=(
        "Operate without a deck.py (for theme authoring). "
        "Only builtin: and relative-path parents are allowed."
    ),
)

mode_option = click.option(
    "--mode",
    "color_mode",
    type=click.Choice(["dark", "light"]),
    default=None,
    help="Color mode for preview style (default: deck mode; dark with --no-deck).",
)


@dataclass(frozen=True)
class DeckSlides:
    """The deck as a command addresses it: numbers and ids by deck index."""

    deck: Deck
    path: Path
    hash: str
    ids: list[str]
    numbers: list[int | None]
    """Presentation number per deck index; None for a hidden slide."""

    @classmethod
    def load(cls, deck_path: Path) -> DeckSlides:
        resolved = resolve_deck_path(deck_path)
        deck_hash = file_hash(resolved.read_bytes())
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

    @property
    def project_dir(self) -> Path:
        return self.path.parent

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


def slide_number(deck_path: Path, ref: str) -> int:
    """SLIDE as the presenter numbers it: a number, or a slide id."""
    ref = ref.strip()
    if ref.isdigit():
        return int(ref)
    slides = DeckSlides.load(deck_path)
    number = slides.numbers[slides.index(ref)]
    if number is None:
        raise click.BadParameter(f"slide {ref!r} is hidden", param_hint="SLIDE")
    return number
