# pyright: reportUnknownMemberType=false
"""A deck that looks the same everywhere: where its fonts come from
(``inkflow fonts``), the plan for bringing them into the deck, and the other
building blocks (``pack.py``): the pinned project and lock, git rules,
committed PDF pages, a zip, and what a new deck starts with."""

from __future__ import annotations

import json
import os
import subprocess
import textwrap
import zipfile
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner

from inkflow import fontreport, instances, lfs, pack, pdf
from inkflow.cli import main
from inkflow.fontreport import Face, Where, font_report, plan_bundle, token_value
from inkflow.manifest import Deck, Slide
from inkflow.pipeline import SlideData
from inkflow.server import load_deck
from inkflow.themes import Theme


def make_font(
    path: Path,
    family: str,
    *,
    weight: int = 400,
    italic: bool = False,
    licence: str = "",
    fs_type: int = 0,
) -> Path:
    """A one-glyph TrueType font named ``family`` at ``weight``/``italic``."""
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    pen = TTGlyphPen(None)
    pen.moveTo((0, 0))
    pen.lineTo((0, 700))
    pen.lineTo((500, 700))
    pen.closePath()
    fb = FontBuilder(unitsPerEm=1000, isTTF=True)
    fb.setupGlyphOrder([".notdef", "A"])
    fb.setupCharacterMap({0x41: "A"})
    fb.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "A": pen.glyph()})
    fb.setupHorizontalMetrics({".notdef": (600, 0), "A": (600, 0)})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    style = ("Bold " if weight >= 700 else "") + ("Italic" if italic else "")
    names: dict[str, str] = {
        "familyName": family,
        "styleName": style.strip() or "Regular",
    }
    if licence:
        names["licenseDescription"] = licence
    fb.setupNameTable(names)
    fb.setupOS2(
        usWeightClass=weight,
        fsSelection=0x01 if italic else 0x40,
        fsType=fs_type,
    )
    fb.setupPost()
    path.parent.mkdir(parents=True, exist_ok=True)
    fb.save(str(path))
    return path


class DirTheme(Theme):
    def __init__(self, asset_dir: Path) -> None:
        super().__init__()
        self._asset_dir: Path = asset_dir

    def asset_dir(self) -> Path:  # pyright: ignore[reportImplicitOverride]
        return self._asset_dir


@pytest.fixture
def machine(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fake font folder of "this computer" (the only one searched beside the
    deck's and the theme's)."""
    folder = tmp_path / "machine-fonts"
    folder.mkdir()

    def font_dirs(project_dir: Path, theme_fonts_dir: Path | None) -> list[Path]:
        dirs = [project_dir / "fonts", *([theme_fonts_dir] if theme_fonts_dir else [])]
        return [d for d in [*dirs, folder] if d.exists()]

    monkeypatch.setattr("inkflow.fonts._font_dirs", font_dirs)
    return folder


def _slide(body: str) -> SlideData:
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
        + body
        + "</svg>"
    )
    return {"svg": svg, "title": "", "id": "one", "notes": "", "editableFiles": []}


def _styles(project: Path, **tokens: str) -> None:
    decls = "".join(
        f"    --inkflow-{role}-font: {value};\n" for role, value in tokens.items()
    )
    (project / "styles.css").write_text(f":root {{\n{decls}}}\n", encoding="utf-8")


def test_each_family_is_classified_by_where_it_comes_from(
    tmp_path: Path, machine: Path
) -> None:
    project = tmp_path / "deck"
    theme_dir = tmp_path / "theme"
    make_font(project / "fonts" / "Own.ttf", "Ownface")
    make_font(theme_dir / "fonts" / "Themed.ttf", "Themeface")
    make_font(machine / "here" / "Here.ttf", "Hereface")
    (machine / "here" / "OFL.txt").write_text(
        "SIL Open Font License 1.1\n", encoding="utf-8"
    )
    _styles(project, body="Hereface, sans-serif", heading="Themeface", mono="monospace")
    deck = Deck(slides=[Slide("x")], theme=DirTheme(theme_dir))
    slides = [
        _slide(
            '<text font-family="Ownface">a</text>'
            + '<text style="font-family: Gone Sans, serif; font-weight: bold">b</text>'
        )
    ]
    report = font_report(deck, project, slides)
    where = {f.family: f.where for f in report.families}
    assert where == {
        "Ownface": Where.PROJECT,
        "Themeface": Where.THEME,
        "Hereface": Where.MACHINE,
        "Gone Sans": Where.MISSING,
        "monospace": Where.GENERIC,
    }
    here = report.by_family("Hereface")
    assert here is not None and here.licence is not None
    assert here.licence.status == "open"
    assert here.files[0].path == machine / "here" / "Here.ttf"
    gone = report.by_family("Gone Sans")
    assert gone is not None and gone.faces == [Face(700)]
    assert "comes from this machine" in here.message()
    assert str(machine / "here" / "Here.ttf") in here.message()
    assert [f.family for f in report.problems] == [
        "monospace",
        "Gone Sans",
        "Hereface",
    ]


def test_a_project_override_replaces_the_themes_font(
    tmp_path: Path, machine: Path
) -> None:
    project = tmp_path / "deck"
    project.mkdir()
    make_font(machine / "Here.ttf", "Hereface")
    css = ":root { --inkflow-body-font: Hereface, sans-serif; }\n"
    (project / "styles.css").write_text(css, encoding="utf-8")
    report = font_report(Deck(slides=[Slide("x")]), project, [_slide("")])
    assert report.tokens["body"] == "Hereface, sans-serif"
    assert report.by_family("Hereface") is not None
    # The built-in theme's own body font is no longer the deck's.
    assert all(
        f.used_by != ["body font"] or f.family == "Hereface" for f in report.families
    )


def test_body_faces_follow_the_text(tmp_path: Path, machine: Path) -> None:
    project = tmp_path / "deck"
    project.mkdir()
    make_font(machine / "Here.ttf", "Hereface")
    _styles(project, body="Hereface")
    html = (
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">'
        + "<p>plain <strong>bold</strong> <em>slanted</em></p></div></foreignObject>"
    )
    report = font_report(Deck(slides=[Slide("x")]), project, [_slide(html)])
    family = report.by_family("Hereface")
    assert family is not None
    assert family.faces == [Face(400), Face(400, True), Face(700), Face(700, True)]
    plain = font_report(Deck(slides=[Slide("x")]), project, [_slide("")])
    assert cast("fontreport.FamilyReport", plain.by_family("Hereface")).faces == [
        Face(400)
    ]


def _machine_family(machine: Path, family: str = "Hereface") -> None:
    folder = machine / family.lower()
    make_font(folder / f"{family}-Regular.ttf", family)
    make_font(folder / f"{family}-Bold.ttf", family, weight=700)
    make_font(folder / f"{family}-Light.ttf", family, weight=300)
    make_font(folder / f"{family}-Italic.ttf", family, italic=True)
    (folder / "OFL.txt").write_text("SIL Open Font License 1.1\n", encoding="utf-8")


def test_bundle_copies_only_the_used_weights_with_licence_and_readme(
    tmp_path: Path, machine: Path
) -> None:
    project = tmp_path / "deck"
    project.mkdir()
    _machine_family(machine)
    _styles(project, body="Hereface, sans-serif")
    report = font_report(Deck(slides=[Slide("x")]), project, [_slide("")])
    plan = plan_bundle(report, project)
    assert sorted(c.dst.relative_to(project).as_posix() for c in plan.copies) == [
        "fonts/hereface/Hereface-Regular.ttf",
        "fonts/hereface/OFL.txt",
    ]
    assert plan.warnings == []
    assert plan.readme is not None
    assert "| Hereface | `hereface/` |" in plan.readme
    assert "SIL Open Font License" in plan.readme
    every = plan_bundle(report, project, all_weights=True)
    assert len([c for c in every.copies if c.dst.suffix == ".ttf"]) == 4


def test_a_system_font_or_one_without_a_licence_is_bundled_with_a_warning(
    tmp_path: Path, machine: Path
) -> None:
    project = tmp_path / "deck"
    project.mkdir()
    make_font(machine / "arial" / "arial.ttf", "Arial")
    make_font(machine / "odd" / "Odd.ttf", "Oddface")
    make_font(machine / "shut" / "Shut.ttf", "Shutface")
    (machine / "shut" / "LICENSE.txt").write_text(
        "This font may not be redistributed.\n", encoding="utf-8"
    )
    slides = [
        _slide(
            '<text font-family="Arial">a</text><text font-family="Oddface">b</text>'
            + '<text font-family="Shutface">c</text>'
        )
    ]
    report = font_report(Deck(slides=[Slide("x")]), project, slides)
    plan = plan_bundle(report, project)
    assert sorted(plan.families) == ["Arial", "Oddface", "Shutface"]
    text = "\n".join(plan.warnings)
    assert '"Arial" is a Microsoft/Monotype system font' in text
    assert "Arimo" in text
    assert '"Oddface": no licence found' in text
    assert '"Shutface" has a proprietary licence' in text
    arial = report.by_family("Arial")
    assert arial is not None and "pick an open font such as Arimo" in arial.message()


def test_a_licence_only_in_the_font_is_written_beside_it(
    tmp_path: Path, machine: Path
) -> None:
    project = tmp_path / "deck"
    project.mkdir()
    make_font(
        machine / "Named.ttf",
        "Namedface",
        licence="This Font Software is licensed under the SIL Open Font License",
    )
    report = font_report(
        Deck(slides=[Slide("x")]),
        project,
        [_slide('<text font-family="Namedface">a</text>')],
    )
    plan = plan_bundle(report, project)
    assert plan.warnings == []
    [(path, text)] = plan.texts.items()
    assert path == project / "fonts" / "namedface" / "LICENSE-from-font.txt"
    assert "SIL Open Font License" in text


def test_a_generic_first_family_is_refused() -> None:
    assert token_value("body", "Inter") == "Inter, sans-serif"
    assert token_value("mono", "JetBrains Mono") == "JetBrains Mono, monospace"
    assert token_value("heading", "Fira 3D") == '"Fira 3D", sans-serif'
    assert token_value("body", "Inter, Arial, sans-serif") == "Inter, Arial, sans-serif"
    with pytest.raises(fontreport.FontSetError, match="generic family"):
        token_value("body", "sans-serif, Inter")
    with pytest.raises(fontreport.FontSetError, match="no font role"):
        token_value("title", "Inter")


DECK_PY = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(slides=[Slide("one")])
""")


SLIDE = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
    + '<text x="10" y="50">Hello</text></svg>'
)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    deck = tmp_path / "deck"
    (deck / "slides").mkdir(parents=True)
    (deck / "slides" / "one.svg").write_text(SLIDE, encoding="utf-8")
    (deck / "deck.py").write_text(DECK_PY, encoding="utf-8")
    return deck


@pytest.fixture(autouse=True)
def _no_server(monkeypatch: pytest.MonkeyPatch) -> None:
    def serving(_deck: Path, _exclude_pid: int | None = None) -> None:
        return None

    monkeypatch.setattr(instances, "serving", serving)


def _cli(project: Path, *args: str) -> str:
    result = CliRunner().invoke(main, [*args, "--deck", str(project / "deck.py")])
    assert result.exit_code == 0, result.output
    return result.output


def test_cli_report(project: Path, machine: Path) -> None:
    _machine_family(machine)
    _styles(project, body="Hereface, sans-serif")
    report = cast(
        "dict[str, list[dict[str, object]]]",
        json.loads(_cli(project, "fonts", "--json")),
    )
    by_family = {str(f["family"]): f for f in report["families"]}
    assert by_family["Hereface"]["where"] == "machine"
    licence = cast("dict[str, str]", by_family["Hereface"]["licence"])
    assert licence["status"] == "open"
    out = _cli(project, "fonts")
    assert "machine" in out and "Hereface" in out
    assert "depend on this machine" in " ".join(out.split())
    pack.bundle_fonts_now(load_deck(project / "deck.py"), project)
    assert (project / "fonts" / "hereface" / "Hereface-Regular.ttf").is_file()
    out = _cli(project, "fonts")
    assert "every font travels with the deck" in " ".join(out.split())


def test_gitattributes_are_merged_once_and_respect_the_lfs_opt_out(
    project: Path,
) -> None:
    attrs = project / ".gitattributes"
    attrs.write_text("*.psd binary\n", encoding="utf-8")
    plan = pack.plan_attributes(project)
    assert plan.text is not None
    assert plan.text.startswith("*.psd binary\n")
    assert pack.EOL_MARKER in plan.text and pack.DIFF_LINE in plan.text
    assert lfs.ON_MARKER in plan.text
    attrs.write_text(plan.text, encoding="utf-8")
    assert pack.plan_attributes(project).text is None
    # A deck that chose git only keeps that choice.
    attrs.write_text(lfs.block(False), encoding="utf-8")
    plan = pack.plan_attributes(project)
    assert plan.text is not None and "filter=lfs" not in plan.text
    assert plan.lfs == []
    # LFS on but from before fonts were in it: only the font rules come.
    attrs.write_text(lfs.ON_MARKER + "\n" + lfs.rule("*.png") + "\n", encoding="utf-8")
    plan = pack.plan_attributes(project)
    assert plan.lfs == ["*.ttf", "*.otf", "*.woff", "*.woff2"]
    # A repository-wide `* text=auto eol=lf` covers the line endings.
    attrs.write_text("* text=auto eol=lf\n*.svg diff=inkscape-svg\n", encoding="utf-8")
    assert pack.plan_attributes(project).eol == []


def test_an_existing_pyproject_gets_the_pin_added(project: Path) -> None:
    (project / "pyproject.toml").write_text(
        '[project]\nname = "talk"\ndependencies = [\n    "rich",\n]\n',
        encoding="utf-8",
    )
    plan = pack.plan_pyproject(load_deck(project / "deck.py"), project)
    assert plan.text is not None
    assert plan.added and plan.added[0].startswith("inkflow")
    assert '"rich",' in plan.text and f'"{plan.added[0]}",' in plan.text
    (project / "pyproject.toml").write_text(plan.text, encoding="utf-8")
    assert pack.plan_pyproject(load_deck(project / "deck.py"), project).text is None


def test_the_zip_holds_the_source_tree_without_ignored_files(project: Path) -> None:
    (project / ".gitignore").write_text("/notes-private/\n*.log\n", encoding="utf-8")
    (project / "notes-private").mkdir()
    (project / "notes-private" / "x.md").write_text("x", encoding="utf-8")
    (project / "debug.log").write_text("x", encoding="utf-8")
    (project / ".inkflow").mkdir()
    (project / ".inkflow" / "context.json").write_text("{}", encoding="utf-8")
    (project / "build").mkdir()
    (project / "build" / "index.html").write_text("x", encoding="utf-8")
    out = project.parent / "deck.zip"
    names = pack.make_zip(project, out)
    assert sorted(names) == [
        "deck/.gitignore",
        "deck/deck.py",
        "deck/slides/one.svg",
    ]
    with zipfile.ZipFile(out) as archive:
        assert archive.read("deck/deck.py").decode() == DECK_PY


def test_the_zip_follows_git_in_a_repository(project: Path) -> None:
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    subprocess.run(["git", "init", "-q"], cwd=project, check=True, env=env)
    (project / ".gitignore").write_text("secret.txt\n", encoding="utf-8")
    (project / "secret.txt").write_text("x", encoding="utf-8")
    names = pack.make_zip(project, project / "deck.zip")
    assert "deck/secret.txt" not in names
    assert "deck/deck.zip" not in names
    assert "deck/slides/one.svg" in names


def test_a_committed_pdf_page_stands_in_while_the_pdf_is_unchanged(
    tmp_path: Path,
) -> None:
    figure = tmp_path / "figure.pdf"
    figure.write_bytes(b"%PDF-1.4 fake")
    page = pdf.committed_path(figure, 1)
    assert page.name == "figure.pdf.p1.svg"
    page.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" '
        + f'{pdf.DIGEST_ATTR}="{pdf.digest(figure)}"/>',
        encoding="utf-8",
    )
    assert pdf.committed_page(figure, 1) == page
    assert pdf.committed_page(figure, 2) is None
    from inkflow.assets import AssetRoots

    pages = pdf.PdfPages(AssetRoots(tmp_path), tool=None)
    assert pages.page("figure.pdf#page=1") == ("figure.pdf.p1.svg", "")
    figure.write_bytes(b"%PDF-1.4 changed")
    assert pdf.committed_page(figure, 1) is None


def test_init_writes_line_endings_and_tries_the_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[Path] = []

    def lock(project_dir: Path, timeout: float = 0) -> tuple[bool, str]:
        del timeout
        calls.append(project_dir)
        return False, "uv lock failed (offline? run it again with a network)"

    monkeypatch.setattr("inkflow.pack.run_uv_lock", lock)
    monkeypatch.setattr("inkflow.pack.uv_available", lambda: True)
    target = tmp_path / "talk"
    out = CliRunner().invoke(main, ["init", str(target), "--no-git"])
    assert out.exit_code == 0, out.output
    attrs = (target / ".gitattributes").read_text(encoding="utf-8")
    assert "*.md text eol=lf" in attrs and pack.DIFF_LINE in attrs
    assert calls == [target.resolve()]
    assert "offline?" in " ".join(out.output.split())


def test_the_report_resolves_fonts_as_the_build_does(
    tmp_path: Path, machine: Path
) -> None:
    """The shipped variable Inter covers every weight, so a static Inter Bold
    on this machine is not what the build embeds; a generic attribute is mapped
    to the deck's own font, and a family a slide defines itself travels inside
    it: none of these is machine-dependent."""
    project = tmp_path / "deck"
    project.mkdir()
    make_font(machine / "Inter-Bold.ttf", "Inter", weight=700)
    deck = Deck(slides=[Slide("x")])  # the built-in theme: the shipped fonts
    slides = [
        _slide(
            "<style>@font-face { font-family: 'Logo Sans'; src: url(data:,x) }</style>"
            + '<text font-family="sans-serif">a</text>'
            + '<text font-family="Logo Sans">b</text>'
            + "<foreignObject><div xmlns='http://www.w3.org/1999/xhtml'>"
            + "<strong>bold</strong></div></foreignObject>"
        )
    ]
    report = font_report(deck, project, slides)
    inter = report.by_family("Inter")
    assert inter is not None and inter.where is Where.THEME
    assert {f.path.name for f in inter.files} == {"InterVariable.woff2"}
    assert report.by_family("sans-serif") is None
    assert report.by_family("Logo Sans") is None
    assert report.problems == []
