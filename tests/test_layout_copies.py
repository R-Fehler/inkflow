"""A theme's layout copied into the deck (``inkflow:copy-of``) and what the
core does with it: resolution, the build, ``sync``/``verify`` and ``inkflow
layouts``; and what a layout says of its zones for an editor: placeholder
prompts (``<inkflow:hint>``), zones kept as dashed boxes (``keep_zones``)."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path
from typing import ClassVar, cast

import pytest
from click.testing import CliRunner
from lxml import etree
from typing_extensions import override

from inkflow import ns
from inkflow.assets import AssetSource
from inkflow.catalog import layout_entries, overlay_entries
from inkflow.cli import main
from inkflow.layout import (
    AssetKind,
    builtin_theme_dir,
    copy_of,
    deck_copy,
    label_of,
    resolve_chain,
    resolve_parent_path,
)
from inkflow.manifest import Deck, Slide
from inkflow.overlay import Overlay
from inkflow.pipeline import (
    EmptyZone,
    SlideData,
    deck_context,
    process_deck,
    process_slide,
    resolve_slide_src,
)
from inkflow.server import load_deck
from inkflow.themes import Theme

BUILTIN = builtin_theme_dir() / "layouts"

DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide("content", md="intro.md"),
                Slide("drawn.svg", md="drawn.md"),
                Slide("agenda", md="plan.md"),
                Slide("agenda", md="plan2.md"),
            ],
        )
""")

DRAWN = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="title" viewBox="0 0 1920 1080">
      <rect id="code-box" x="100" y="300" width="900" height="500"/>
      <rect id="zone-code" x="1100" y="300" width="700" height="500"/>
    </svg>
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "drawn.svg").write_text(DRAWN, encoding="utf-8")
    texts = {
        "intro": "# Intro\n\n- One\n",
        "drawn": "# Code examples\n\n::code::\n\n```py\nprint(1)\n```\n",
        "plan": "# Plan\n\n1. First\n",
        "plan2": "# Plan B\n",
    }
    for name, text in texts.items():
        (tmp_path / "slides" / f"{name}.md").write_text(text, encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


def _copy(project: Path, name: str, fill: str | None = None) -> Path:
    """The deck's copy of a built-in layout, made by hand: the theme's file
    with its parent named explicitly and ``inkflow:copy-of`` added."""
    (project / "layouts").mkdir(exist_ok=True)
    root = etree.fromstring((BUILTIN / f"{name}.svg").read_bytes())
    parent = root.get(ns.INKFLOW_PARENT)
    if parent:
        root.set(ns.INKFLOW_PARENT, "builtin:" + parent.removeprefix("./"))
    root.set(ns.INKFLOW_COPY_OF, f"builtin:{name}")
    if fill is not None:
        _ = etree.SubElement(
            root, f"{{{ns.SVG}}}rect", id="mark", width="10", height="10", fill=fill
        )
    path = project / "layouts" / f"{name}.svg"
    _ = path.write_bytes(etree.tostring(root))
    return path


def _chain(project: Path, index: int, theme: Theme | None = None) -> list[Path]:
    deck = load_deck(project / "deck.py")
    theme = theme if theme is not None else deck.theme
    src = resolve_slide_src(deck.slides[index].src, project, theme)
    return [*resolve_chain(src, project, theme), src]


def _names(paths: list[Path], project: Path) -> list[str]:
    return [
        p.relative_to(project).as_posix() if p.is_relative_to(project) else p.stem
        for p in paths
    ]


def _built(project: Path, editor: bool = False) -> list[SlideData]:
    deck = load_deck(project / "deck.py")
    return process_deck(deck, project, project / "deck.py", editor=editor)


# ── Resolution ─────────────────────────────────────────────────────────────────


def test_a_copy_of_a_theme_layout_replaces_it_for_its_slides(project: Path) -> None:
    _ = _copy(project, "agenda")
    assert _names(_chain(project, 2), project) == [
        "base",
        "numbered",
        "title",
        "layouts/agenda.svg",
    ]
    # Other layouts stay the theme's.
    assert _names(_chain(project, 0), project) == [
        "base",
        "numbered",
        "title",
        "content",
    ]


def test_a_copy_of_base_is_the_background_of_every_layout(project: Path) -> None:
    _ = _copy(project, "base")
    for index in range(4):
        chain = _names(_chain(project, index), project)
        assert chain[0] == "layouts/base.svg", chain
    # Also a reference that names the theme's explicitly.
    resolved = resolve_parent_path("builtin:base", project, project, None)
    assert resolved == project / "layouts" / "base.svg"
    assert (
        resolve_parent_path("builtin:base", project, project, None, follow_copies=False)
        == BUILTIN / "base.svg"
    )


def test_a_copy_of_the_parent_stands_in_for_the_copys_parent(project: Path) -> None:
    _ = _copy(project, "agenda")
    _ = _copy(project, "title")
    assert _names(_chain(project, 2), project) == [
        "base",
        "numbered",
        "layouts/title.svg",
        "layouts/agenda.svg",
    ]


def test_a_layout_merely_named_like_a_theme_one_stays_out_of_its_chains(
    project: Path,
) -> None:
    (project / "layouts").mkdir()
    _ = (project / "layouts" / "title.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"/>'
    )
    # agenda is built on the theme's title, not on the deck's title slide.
    assert _names(_chain(project, 2), project) == [
        "base",
        "numbered",
        "title",
        "agenda",
    ]
    assert deck_copy(BUILTIN / "title.svg", project, None) is None
    assert copy_of(project / "layouts" / "title.svg") is None


def test_a_copy_naming_another_file_is_no_copy(project: Path) -> None:
    (project / "layouts").mkdir()
    _ = (project / "layouts" / "title.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"'
        + ' inkflow:copy-of="builtin:agenda" viewBox="0 0 1920 1080"/>'
    )
    assert deck_copy(BUILTIN / "title.svg", project, None) is None
    assert _names(_chain(project, 2), project)[2] == "title"


def test_a_copy_built_on_its_own_original_is_no_loop(project: Path) -> None:
    (project / "layouts").mkdir()
    _ = (project / "layouts" / "content.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow" '
        + 'inkflow:parent="builtin:content" inkflow:copy-of="builtin:content" '
        + 'viewBox="0 0 1920 1080"/>'
    )
    assert _names(_chain(project, 0), project) == [
        "base",
        "numbered",
        "title",
        "content",
        "layouts/content.svg",
    ]


class _Builtin(Theme):
    """A theme whose files are the built-in ones (as a shipped theme's are)."""

    @override
    def asset_dir(self) -> Path:
        return builtin_theme_dir()


class _Packaged(Theme):
    """A theme with layouts and overlays of its own, as a pip-installed one has."""

    folder: ClassVar[Path] = Path()

    @override
    def asset_dir(self) -> Path:
        return self.folder


def test_copies_resolve_under_a_theme_sharing_the_builtin_files(
    project: Path,
) -> None:
    _ = _copy(project, "base")
    assert _chain(project, 2, _Builtin())[0] == project / "layouts" / "base.svg"


@pytest.fixture
def packaged(tmp_path_factory: pytest.TempPathFactory) -> _Packaged:
    folder = tmp_path_factory.mktemp("theme")
    (folder / "layouts").mkdir()
    _ = (folder / "layouts" / "agenda.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow" '
        + 'inkflow:parent="./title" viewBox="0 0 1920 1080"><rect id="mark"/></svg>'
    )
    _ = (folder / "layouts" / "title.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
        + '<rect id="zone-title"/></svg>'
    )
    (folder / "overlays").mkdir()
    _ = (folder / "overlays" / "logo.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
        + '<text id="logo">Theme</text></svg>'
    )
    _Packaged.folder = folder
    return _Packaged()


def test_a_packaged_themes_layout_is_copied_as_a_theme_ref(
    project: Path, packaged: _Packaged
) -> None:
    (project / "layouts").mkdir()
    _ = (project / "layouts" / "agenda.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow" '
        + 'inkflow:parent="theme:title" inkflow:copy-of="theme:agenda" '
        + 'viewBox="0 0 1920 1080"><rect id="mine"/></svg>'
    )
    src = resolve_slide_src("agenda", project, packaged)
    assert src == project / "layouts" / "agenda.svg"
    title = packaged.folder / "layouts" / "title.svg"
    assert resolve_chain(src, project, packaged) == [title]
    theme_agenda = packaged.folder / "layouts" / "agenda.svg"
    assert deck_copy(theme_agenda, project, packaged) == src


def test_a_copy_of_a_themes_overlay_is_worn_instead(
    project: Path, packaged: _Packaged
) -> None:
    (project / "overlays").mkdir()
    _ = (project / "overlays" / "logo.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow" '
        + 'inkflow:copy-of="theme:logo" viewBox="0 0 1920 1080">'
        + '<text id="logo">Ours</text></svg>'
    )
    resolved = resolve_parent_path(
        "theme:logo", project, project, packaged, AssetKind.OVERLAY
    )
    assert resolved == project / "overlays" / "logo.svg"
    deck = Deck(
        slides=[Slide("content")],
        theme=packaged,
        overlays=[Overlay("theme:logo")],
        embed_fonts=False,
    )
    [built] = process_deck(deck, project, project / "deck.py")
    assert "Ours" in built["svg"] and "Theme" not in built["svg"]
    [entry] = [e for e in overlay_entries(deck, project) if e.deck]
    assert entry.copy_of == "theme:logo"


# ── The build ──────────────────────────────────────────────────────────────────


def test_a_copy_of_base_paints_every_slide(project: Path) -> None:
    _ = _copy(project, "base", fill="#ff0000")
    assert all("#ff0000" in s["svg"] for s in _built(project))


def test_only_agenda_slides_follow_an_agenda_copy(project: Path) -> None:
    _ = _copy(project, "agenda", fill="#abcdef")
    built = _built(project)
    assert ["#abcdef" in s["svg"] for s in built] == [False, False, True, True]


def test_sync_puts_the_copy_into_the_previews_and_verify_agrees(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(project)
    runner = CliRunner()
    assert runner.invoke(main, ["sync"]).exit_code == 0
    assert "stale" not in runner.invoke(main, ["verify"]).output
    drawn = project / "slides" / "drawn.svg"
    assert "#ff0000" not in drawn.read_text(encoding="utf-8")
    _ = _copy(project, "base", fill="#ff0000")
    assert "stale" in runner.invoke(main, ["verify"]).output
    assert runner.invoke(main, ["sync"]).exit_code == 0
    assert "#ff0000" in drawn.read_text(encoding="utf-8")
    assert "stale" not in runner.invoke(main, ["verify"]).output


# ── What `inkflow layouts` and the catalog say ────────────────────────────────


def test_the_catalog_notes_copies_and_names(project: Path) -> None:
    _ = _copy(project, "agenda")
    (project / "layouts" / "title.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"'
        + ' inkflow:label="Big Title" viewBox="0 0 1920 1080"/>'
    )
    entries = layout_entries(load_deck(project / "deck.py"), project)
    agenda = entries["agenda"]
    assert agenda.source == "local" and agenda.copy_of == "builtin:agenda"
    assert not agenda.shadows
    assert agenda.slides == [2, 3]
    title = entries["title"]
    assert title.copy_of is None and title.shadows
    assert title.label == "Big Title" == label_of(title.path)


def test_layouts_notes_the_decks_copies(project: Path) -> None:
    _ = _copy(project, "agenda")
    result = CliRunner().invoke(
        main, ["layouts", "--json", "--deck", str(project / "deck.py")]
    )
    assert result.exit_code == 0, result.output
    data = cast("dict[str, list[dict[str, object]]]", json.loads(result.output))
    by_name = {(e["source"], e["name"]): e for e in data["layouts"]}
    assert by_name[("local", "agenda")]["note"] == "the deck's copy of builtin:agenda"
    assert by_name[("local", "agenda")]["slides"] == 2
    theirs = by_name[("builtin", "agenda")]
    assert theirs["note"] == "replaced by the deck's copy"
    assert theirs["slides"] is None


# ── Placeholder prompts and kept zones ────────────────────────────────────────

CODE = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="title" viewBox="0 0 1920 1080">
      <rect id="zone-code" x="100" y="300" width="1000" height="600"/>
      <rect id="zone-note" x="1200" y="300" width="600" height="600"/>
      <inkflow:hint zone="code">The code example</inkflow:hint>
      <inkflow:hint zone="note">A note</inkflow:hint>
    </svg>
""")

CHILD = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="code" viewBox="0 0 1920 1080">
      <inkflow:hint zone="code">Child code</inkflow:hint>
    </svg>
""")


def _empty(slide: SlideData) -> dict[str, EmptyZone]:
    edit = slide.get("edit")
    assert edit is not None
    return {z["zone"]: z for z in edit["emptyZones"]}


def test_hints_reach_the_empty_zones_and_never_the_slide(project: Path) -> None:
    (project / "layouts").mkdir()
    _ = (project / "layouts" / "code.svg").write_text(CODE, encoding="utf-8")
    _ = (project / "layouts" / "code-child.svg").write_text(CHILD, encoding="utf-8")
    _ = (project / "deck.py").write_text(
        DECK.replace('Slide("content", md="intro.md")', 'Slide("code")').replace(
            'Slide("drawn.svg", md="drawn.md")', 'Slide("code-child")'
        ),
        encoding="utf-8",
    )
    built = _built(project, editor=True)
    on_code = _empty(built[0])
    assert on_code["code"].get("hint") == "The code example"
    assert on_code["note"].get("hint") == "A note"
    assert "hint" not in on_code["title"]
    # The nearest layout's prompt wins; the others are inherited.
    on_child = _empty(built[1])
    assert on_child["code"].get("hint") == "Child code"
    assert on_child["note"].get("hint") == "A note"
    for slide in [*built, *_built(project)]:
        assert "hint" not in slide["svg"] and "The code example" not in slide["svg"]


def test_keep_zones_draws_the_unfilled_zones_as_dashed_boxes(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    ctx = deck_context(deck, project, len(deck.slides))
    slide = Slide("content")
    source = AssetSource.for_deck(ctx.assets)
    kept = process_slide(slide, ctx, 1, None, source, "content", keep_zones=True)
    assert 'id="zone-content"' in kept.svg and 'id="zone-title"' in kept.svg
    assert "stroke-dasharray: 12 8" in kept.svg
    pruned = process_slide(slide, ctx, 1, None, source, "content")
    assert 'id="zone-content"' not in pruned.svg


def test_a_shown_shape_is_an_empty_zone_and_stays_drawn(project: Path) -> None:
    _ = (project / "slides" / "drawn.svg").write_text(
        DRAWN.replace(
            '<rect id="zone-code"',
            '<rect id="zone-code" class="inkflow-fill-accent"'
            + ' inkflow:show-shape="true"',
        ),
        encoding="utf-8",
    )
    _ = (project / "slides" / "drawn.md").write_text("# Code examples\n")
    built = _built(project, editor=True)
    assert "code" in _empty(built[1])
    assert 'id="zone-code"' in built[1]["svg"]
