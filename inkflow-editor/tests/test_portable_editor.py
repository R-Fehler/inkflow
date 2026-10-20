"""The editor's part of test_portable.py: the tests that need inkflow-editor."""

from __future__ import annotations

import textwrap
from collections.abc import Iterator
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner

from inkflow.cli import main
from inkflow.manifest import Deck
from inkflow.server import load_deck
from inkflow_editor.filerename import plan_copy_in
from inkflow_editor.session import EditError, EditorSession
from tests.serving import serve_deck


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


def _session(project: Path) -> tuple[EditorSession, Deck]:
    return EditorSession(project / "deck.py"), load_deck(project / "deck.py")


def test_fonts_set_writes_the_theme_block_and_bundles_the_family(
    project: Path, machine: Path
) -> None:
    _machine_family(machine)
    session, deck = _session(project)
    result = session.apply(
        {
            "action": "fonts",
            "op": "set",
            "role": "body",
            "family": "Hereface",
            "_local": True,
        },
        deck,
    )
    css = (project / "styles.css").read_text(encoding="utf-8")
    assert "/* inkflow:theme" in css
    assert "--inkflow-body-font: Hereface, sans-serif;" in css
    assert (project / "fonts" / "hereface" / "Hereface-Regular.ttf").is_file()
    assert (project / "fonts" / "hereface" / "OFL.txt").is_file()
    assert result["label"] == "Font: body = Hereface, sans-serif"
    created = {c["path"] for c in cast("list[dict[str, str]]", result["changes"])}
    assert "fonts/hereface/Hereface-Regular.ttf" in created
    # One step: undo takes the token and the copied fonts back.
    session.apply({"action": "undo"}, deck)
    assert not (project / "styles.css").exists()
    assert not (project / "fonts" / "hereface" / "Hereface-Regular.ttf").exists()
    session.apply({"action": "redo"}, deck)
    assert (project / "fonts" / "hereface" / "Hereface-Regular.ttf").is_file()
    with pytest.raises(EditError, match="generic family"):
        session.apply(
            {"action": "fonts", "op": "set", "role": "body", "family": "serif"}, deck
        )


def test_a_remote_editor_sets_the_font_but_does_not_copy_this_machines_files(
    project: Path, machine: Path
) -> None:
    _machine_family(machine)
    session, deck = _session(project)
    result = session.apply(
        {"action": "fonts", "op": "set", "role": "body", "family": "Hereface"}, deck
    )
    assert "server's computer" in str(result["note"])
    assert not (project / "fonts").exists()
    with pytest.raises(EditError, match="only an editor on this machine"):
        session.apply(
            {"action": "fonts", "op": "bundle"}, load_deck(project / "deck.py")
        )


def _cli(project: Path, *args: str) -> str:
    result = CliRunner().invoke(main, [*args, "--deck", str(project / "deck.py")])
    assert result.exit_code == 0, result.output
    return result.output


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


def test_copy_in_rewrites_each_reference_where_it_is_written(scattered: Path) -> None:
    deck = load_deck(scattered / "deck.py")
    plan = plan_copy_in(scattered, scattered / "deck.py", deck)
    targets = sorted(dst.relative_to(scattered).as_posix() for _, dst in plan.copies)
    assert targets == ["assets/b.png", "assets/logo.png", "assets/pic.png"]
    edits = {(e.file, e.old, e.new) for e in plan.edits}
    assert edits == {
        ("deck.py", "../outside/pic.png", "assets/pic.png"),
        ("slides/text.md", "../../outside/b.png", "../assets/b.png"),
        ("slides/one.svg", "../linked/logo.png", "../assets/logo.png"),
    }
    assert [r.raw for r in plan.remote] == ["https://example.com/x.png"]


def test_pack_through_the_session_is_one_undoable_step(
    scattered: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def lock(project_dir: Path, timeout: float = 0) -> tuple[bool, str]:
        del timeout
        (project_dir / "uv.lock").write_text("version = 1\n", encoding="utf-8")
        return True, "uv.lock written"

    monkeypatch.setattr("inkflow.pack.run_uv_lock", lock)
    session, deck = _session(scattered)
    check = session.apply({"action": "pack", "op": "check"}, deck)
    summary = cast("dict[str, object]", check["pack"])
    assert summary["needed"] is True
    keys = {
        cast("dict[str, str]", i)["key"] for i in cast("list[object]", summary["items"])
    }
    assert {"asset", "pyproject", "lock", "eol", "lfs", "remote"} <= keys
    with pytest.raises(EditError, match="only an editor on this machine"):
        session.apply({"action": "pack", "op": "apply"}, deck)
    result = session.apply({"action": "pack", "op": "apply", "_local": True}, deck)
    assert (scattered / "assets" / "pic.png").read_bytes() == b"PNG-pic"
    assert 'Image("assets/pic.png")' in (scattered / "deck.py").read_text()
    assert "../assets/b.png" in (scattered / "slides" / "text.md").read_text()
    assert (scattered / "uv.lock").is_file()
    assert "inkflow" in (scattered / "pyproject.toml").read_text()
    attributes = (scattered / ".gitattributes").read_text()
    assert "*.svg text eol=lf" in attributes
    assert "*.ttf filter=lfs" in attributes
    assert result["lock"] == "uv.lock written"
    remaining = cast("list[dict[str, str]]", result["remaining"])
    assert "remote" in [r["key"] for r in remaining]
    assert "asset" not in [r["key"] for r in remaining]
    assert len(session.history.done) == 1
    # Packed: nothing left that packing would change.
    again = session.apply(
        {"action": "pack", "op": "check"}, load_deck(scattered / "deck.py")
    )
    assert cast("dict[str, object]", again["pack"])["needed"] is False
    # One step: undo takes all of it back, the lock file included.
    session.apply({"action": "undo"}, load_deck(scattered / "deck.py"))
    assert not (scattered / "assets").exists()
    assert not (scattered / "uv.lock").exists()
    assert not (scattered / ".gitattributes").exists()
    assert (scattered / "deck.py").read_text() == MEDIA_DECK


def test_a_new_deck_in_the_current_look_brings_its_machine_fonts(
    project: Path, machine: Path, tmp_path: Path
) -> None:
    from inkflow_editor import projects

    _machine_family(machine)
    _styles(project, body="Hereface, sans-serif")
    created = projects.create_deck(
        tmp_path / "new-talk",
        title="New",
        theme="current",
        git=False,
        current=project / "deck.py",
    )
    folder = created.parent
    assert (folder / "fonts" / "hereface" / "Hereface-Regular.ttf").is_file()
    assert "*.svg text eol=lf" in (folder / ".gitattributes").read_text()


@pytest.fixture
def served(project: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[EditorSession]:
    session = EditorSession(project / "deck.py")
    with serve_deck(session, monkeypatch):
        yield session


def test_bundle_and_pack_through_the_server_are_agent_steps(
    project: Path, machine: Path, served: EditorSession
) -> None:
    _machine_family(machine)
    _styles(project, body="Hereface, sans-serif")
    out = _cli(project, "fonts", "bundle")
    assert "Ctrl+Z in the editor" in out
    assert (project / "fonts" / "hereface" / "Hereface-Regular.ttf").is_file()
    out = _cli(project, "pack")
    assert "Ctrl+Z in the editor" in out
    assert [s.label for s in served.history.done] == [
        "Agent: Bundle fonts into the deck",
        "Agent: Pack the deck",
    ]
    served.apply({"action": "undo"}, load_deck(project / "deck.py"))
    served.apply({"action": "undo"}, load_deck(project / "deck.py"))
    assert not (project / "fonts" / "hereface").exists()
