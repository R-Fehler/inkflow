"""The editor's CLI part of the core's tests (moved with the commands)."""

from __future__ import annotations

import json
import textwrap
import zipfile
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner

from inkflow.cli import main


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


def _styles(project: Path, **tokens: str) -> None:
    decls = "".join(
        f"    --inkflow-{role}-font: {value};\n" for role, value in tokens.items()
    )
    (project / "styles.css").write_text(f":root {{\n{decls}}}\n", encoding="utf-8")


def _machine_family(machine: Path, family: str = "Hereface") -> None:
    folder = machine / family.lower()
    make_font(folder / f"{family}-Regular.ttf", family)
    make_font(folder / f"{family}-Bold.ttf", family, weight=700)
    make_font(folder / f"{family}-Light.ttf", family, weight=300)
    make_font(folder / f"{family}-Italic.ttf", family, italic=True)
    (folder / "OFL.txt").write_text("SIL Open Font License 1.1\n", encoding="utf-8")


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


def _cli(project: Path, *args: str) -> str:
    result = CliRunner().invoke(main, [*args, "--deck", str(project / "deck.py")])
    assert result.exit_code == 0, result.output
    return result.output


def _families(out: str) -> dict[str, dict[str, object]]:
    report = cast("dict[str, list[dict[str, object]]]", json.loads(out))
    return {str(f["family"]): f for f in report["families"]}


def test_cli_report_bundle_and_set_offline(project: Path, machine: Path) -> None:
    _machine_family(machine)
    _machine_family(machine, "Codeface")
    _styles(project, body="Hereface, sans-serif")
    by_family = _families(_cli(project, "fonts", "--json"))
    assert by_family["Hereface"]["where"] == "machine"
    licence = cast("dict[str, str]", by_family["Hereface"]["licence"])
    assert licence["status"] == "open"
    out = _cli(project, "fonts")
    assert "machine" in out and "Hereface" in out
    dry = _cli(project, "fonts", "bundle", "--dry-run")
    assert "Would copy" in dry and not (project / "fonts").exists()
    out = _cli(project, "fonts", "bundle")
    assert "Created" in out
    assert (project / "fonts" / "hereface" / "Hereface-Regular.ttf").is_file()
    assert _families(_cli(project, "fonts", "--json"))["Hereface"]["where"] == (
        "project"
    )
    out = _cli(project, "fonts", "set", "mono", "Codeface")
    assert "Bundled" in out
    assert (project / "fonts" / "codeface" / "Codeface-Regular.ttf").is_file()
    refused = CliRunner().invoke(
        main, ["fonts", "set", "body", "monospace", "--deck", str(project / "deck.py")]
    )
    assert refused.exit_code == 1
    assert "generic family" in refused.output


MEDIA_DECK = textwrap.dedent("""\
    from inkflow import Deck, Image, Slide


    def main() -> Deck:
        return Deck(
            slides=[
                Slide(
                    "content", md="text", zones={"media": Image("../outside/pic.png")}
                ),
                Slide("one"),
            ]
        )
""")


@pytest.fixture
def scattered(project: Path) -> Path:
    """A deck naming a picture outside its folder (deck.py), another from its
    Markdown, and a third through a symlinked folder (its SVG)."""
    outside = project.parent / "outside"
    shared = project.parent / "shared"
    outside.mkdir()
    shared.mkdir()
    (outside / "pic.png").write_bytes(b"PNG-pic")
    (outside / "b.png").write_bytes(b"PNG-b")
    (shared / "logo.png").write_bytes(b"PNG-logo")
    (project / "linked").symlink_to(shared, target_is_directory=True)
    (project / "deck.py").write_text(MEDIA_DECK, encoding="utf-8")
    (project / "slides" / "text.md").write_text(
        "::content::\n\n![b](../../outside/b.png)\n", encoding="utf-8"
    )
    (project / "slides" / "one.svg").write_text(
        SLIDE.replace(
            "<text",
            '<image href="../linked/logo.png" width="9" height="9"/>'
            + '<image href="https://example.com/x.png" width="9" height="9"/><text',
        ),
        encoding="utf-8",
    )
    return project


def test_cli_pack_dry_run_then_pack_and_zip(scattered: Path) -> None:
    dry = _cli(scattered, "pack", "--dry-run")
    assert "Would" in dry and "assets/pic.png" in dry
    assert not (scattered / "assets").exists()
    out = CliRunner().invoke(
        main,
        [
            "pack",
            "--deck",
            str(scattered / "deck.py"),
            "--zip",
            str(scattered.parent / "out.zip"),
        ],
    )
    assert out.exit_code == 0, out.output
    assert "Still machine-dependent" in out.output
    assert "https://example.com/x.png" in out.output
    assert "uv lock skipped in tests" in out.output
    with zipfile.ZipFile(scattered.parent / "out.zip") as archive:
        assert "deck/assets/pic.png" in archive.namelist()


def test_verify_names_what_ties_the_deck_to_this_machine(
    scattered: Path, machine: Path
) -> None:
    _machine_family(machine)
    _styles(scattered, body="Hereface, sans-serif")
    out = CliRunner().invoke(main, ["verify", "--deck", str(scattered / "deck.py")])
    text = " ".join(out.output.split())
    assert 'font "Hereface" comes from this machine' in text
    assert "inkflow fonts bundle" in text
    assert "3 file(s) outside the deck or behind a symlink" in text
    assert "picture(s) read from the web" in text
    assert "no uv.lock" in text
    assert "no line-ending rules" in text
    quiet = CliRunner().invoke(
        main, ["verify", "--no-portable", "--deck", str(scattered / "deck.py")]
    )
    assert "comes from this machine" not in quiet.output
