# pyright: reportPrivateUsage=none, reportUnknownMemberType=false, reportAny=false
# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false
# pyright: reportPrivateLocalImportUsage=false
"""The fonts inkflow ships, and how decks and the interface embed them."""

from __future__ import annotations

import base64
import importlib.resources
import io
import re
import textwrap
import tomllib
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fontTools.ttLib import TTFont

from inkflow import fonts
from inkflow.export import build_static_html
from inkflow.fonts import (
    SHIPPED_FONTS_DIR,
    embed_fonts_css,
    embed_fonts_css_subsetted,
    is_shipped,
    shipped_font_file,
    shipped_font_url,
    ui_fonts_css,
)
from inkflow.loaders import load_deck_styles
from inkflow.manifest import Deck
from inkflow.pipeline import SlideData, process_deck
from inkflow.server import load_deck
from inkflow.svg import theme_generic_fonts
from inkflow.svgio import parse_svg, serialize_svg
from inkflow.themes import Builtin, Theme, Typography
from tests.serving import GUEST, fetch, make_project, serve_on_a_thread

SHIPPED = {
    "InterVariable.woff2": "Inter",
    "InterVariable-Italic.woff2": "Inter",
    "JetBrainsMono-Variable.woff2": "JetBrains Mono",
    "JetBrainsMono-Variable-Italic.woff2": "JetBrains Mono",
    "STIXTwoMath-Regular.woff2": "STIX Two Math",
    "TwemojiMozilla.woff2": "Twemoji Mozilla",
}
LICENCES = (
    "OFL-Inter.txt",
    "OFL-JetBrainsMono.txt",
    "OFL-STIXTwo.txt",
    "LICENSE-Twemoji.md",
    "README.md",
)


@pytest.fixture
def no_system_fonts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A computer with no fonts of its own: no user dir, no system dirs."""
    empty = tmp_path / "no-fonts"
    empty.mkdir()
    monkeypatch.setattr(fonts.platformdirs, "user_fonts_dir", lambda: str(empty))
    monkeypatch.setattr(fonts.sys, "platform", "inkflow-test")
    real = fonts._font_dirs

    def dirs(project_dir: Path, theme_fonts_dir: Path | None) -> list[Path]:
        system = (Path("/usr/local/share/fonts"), Path("/usr/share/fonts"))
        return [d for d in real(project_dir, theme_fonts_dir) if d not in system]

    monkeypatch.setattr(fonts, "_font_dirs", dirs)
    fonts._index_cache.clear()


# ── The files ─────────────────────────────────────────────────────────────────


def test_the_package_carries_the_fonts_and_their_licences() -> None:
    folder = importlib.resources.files("inkflow").joinpath("theme", "fonts")
    names = {p.name for p in folder.iterdir()}
    assert set(SHIPPED) | set(LICENCES) <= names
    for name, family in SHIPPED.items():
        font = TTFont(io.BytesIO(folder.joinpath(name).read_bytes()))
        assert font.flavor == "woff2"
        assert family.replace(" ", "") in (font["name"].getDebugName(1) or "").replace(
            " ", ""
        )
    # Every OFL text, the Twemoji credit in the font itself (CC BY 4.0).
    for name in LICENCES[:3]:
        assert "SIL OPEN FONT LICENSE" in folder.joinpath(name).read_text().upper()
    emoji = TTFont(io.BytesIO(folder.joinpath("TwemojiMozilla.woff2").read_bytes()))
    assert "CC BY 4.0" in (emoji["name"].getDebugName(0) or "")


def test_the_wheel_takes_the_theme_folder_whole() -> None:
    root = Path(__file__).resolve().parents[1]
    config = tomllib.loads((root / "pyproject.toml").read_text())
    wheel = config["tool"]["hatch"]["build"]["targets"]["wheel"]
    assert "src/inkflow/theme/**" in wheel["artifacts"]
    assert not any("fonts" in pattern for pattern in wheel.get("exclude", []))
    assert root / "src" / "inkflow" / "theme" / "fonts" == SHIPPED_FONTS_DIR


def test_the_shipped_fonts_stay_within_budget() -> None:
    total = sum(p.stat().st_size for p in SHIPPED_FONTS_DIR.iterdir())
    assert total < 3_000_000


# ── Theme defaults ────────────────────────────────────────────────────────────


def test_every_theme_names_the_shipped_fonts_first() -> None:
    t = Typography()
    assert t.body_font.startswith('"Inter"') and t.body_font.endswith("sans-serif")
    assert t.mono_font.startswith('"JetBrains Mono"')
    assert t.math_font.startswith('"STIX Two Math"')
    assert '"Twemoji Mozilla"' in t.body_font
    css = Builtin().render_tokens_css()
    assert '--inkflow-body-font: "Inter", "Twemoji Mozilla", sans-serif;' in css
    assert '--inkflow-math-font: "STIX Two Math", math;' in css


def test_a_theme_naming_other_fonts_keeps_them() -> None:
    class Serif(Theme):
        typography: Typography = Typography(body_font='"Fraunces", serif')

    css = Serif().render_tokens_css()
    assert '--inkflow-body-font: "Fraunces", serif;' in css


# ── Discovery ─────────────────────────────────────────────────────────────────


@pytest.mark.usefixtures("no_system_fonts")
def test_found_on_a_computer_without_fonts(tmp_path: Path) -> None:
    index = fonts._build_index(tmp_path, None, force=True)
    for family in ("inter", "jetbrains mono", "stix two math", "twemoji mozilla"):
        assert index[family], family
        assert all(is_shipped(r.path) for r in index[family])
    # "Inter Variable" (the file's own name) is Inter too.
    assert fonts._lookup(index, "Inter Variable") == index["inter"]
    inter = fonts._best_match(index["inter"], 700, False)
    assert inter.weight_range == (100, 900) and not inter.is_italic
    assert fonts._best_match(index["inter"], 400, True).is_italic


@pytest.mark.usefixtures("no_system_fonts")
def test_found_whatever_the_theme(
    tmp_path: Path, dir_theme: Callable[[Path], Theme]
) -> None:
    theme = dir_theme(tmp_path / "other-theme")
    (theme.fonts_dir).mkdir(parents=True)
    index = fonts._build_index(tmp_path, theme.fonts_dir, force=True)
    assert index["inter"] and index["stix two math"]


@pytest.mark.usefixtures("no_system_fonts")
def test_project_fonts_win_over_the_shipped_ones(tmp_path: Path) -> None:
    (tmp_path / "fonts").mkdir()
    jbm = (SHIPPED_FONTS_DIR / "JetBrainsMono-Variable.woff2").read_bytes()
    font = TTFont(io.BytesIO(jbm))
    font["name"].setName("Inter", 1, 3, 1, 0x409)
    font["name"].setName("Inter", 16, 3, 1, 0x409)
    font.save(str(tmp_path / "fonts" / "MyInter.woff2"))
    index = fonts._build_index(tmp_path, None, force=True)
    match = fonts._best_match(index["inter"], 400, False)
    assert match.path == tmp_path / "fonts" / "MyInter.woff2"


# ── A deck's fonts ────────────────────────────────────────────────────────────

_SLIDE = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <text x="10" y="50" font-family="sans-serif">Plain text</text>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")


def _deck(tmp_path: Path, md: str) -> Path:
    (tmp_path / "slides").mkdir(exist_ok=True)
    (tmp_path / "slides" / "s.svg").write_text(_SLIDE, encoding="utf-8")
    (tmp_path / "slides" / "s.md").write_text(md, encoding="utf-8")
    deck = tmp_path / "deck.py"
    deck.write_text(
        "from inkflow import Deck, Slide\n\n\n"
        + "def main() -> Deck:\n"
        + '    return Deck(slides=[Slide("slides/s.svg", md="s")])\n',
        encoding="utf-8",
    )
    return deck


def _built(deck_path: Path) -> tuple[Deck, list[SlideData], str]:
    deck = load_deck(deck_path)
    slides = process_deck(deck, deck_path.parent, deck_path)
    return deck, slides, load_deck_styles(deck, deck_path.parent)


def _faces(css: str) -> dict[tuple[str, str], TTFont]:
    out: dict[tuple[str, str], TTFont] = {}
    for m in re.finditer(
        r'font-family: "([^"]+)";\s*src: url\("data:[^;]+;base64,([^"]+)"', css
    ):
        style = (
            "italic"
            if "font-style: italic" in css[m.end() : m.end() + 400].split("}")[0]
            else "normal"
        )
        out[(m.group(1), style)] = TTFont(io.BytesIO(base64.b64decode(m.group(2))))
    return out


def _ligature(font: TTFont, text: str) -> bool:
    """Whether the font's GSUB joins `text` (an emoji sequence) into one glyph."""
    cmap = font.getBestCmap() or {}
    try:
        first, *rest = [cmap[ord(c)] for c in text]
    except KeyError:
        return False
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for sub in lookup.SubTable:
            ligatures = getattr(sub, "ligatures", None)
            if sub.LookupType == 7:
                ligatures = getattr(sub.ExtSubTable, "ligatures", None)
            for lig in (ligatures or {}).get(first, []):
                if list(lig.Component) == rest:
                    return True
    return False


@pytest.mark.usefixtures("no_system_fonts")
def test_a_build_embeds_the_shipped_fonts_subset(tmp_path: Path) -> None:
    deck_path = _deck(
        tmp_path,
        "::content::\n# Title\n\nSome *text* and `code`, $x^2 + \\sqrt{y}$ 👩‍💻 🇩🇪\n",
    )
    _, slides, styles = _built(deck_path)
    css = embed_fonts_css_subsetted(slides, tmp_path, None, styles_css=styles)
    faces = _faces(css)
    assert set(faces) >= {
        ("Inter", "normal"),
        ("Inter", "italic"),
        ("JetBrains Mono", "normal"),
        ("STIX Two Math", "normal"),
        ("Twemoji Mozilla", "normal"),
    }
    inter = faces[("Inter", "normal")]
    cmap = inter.getBestCmap() or {}
    assert {ord(c) for c in "TitleSomext"} <= set(cmap)
    assert ord("Ж") not in cmap  # subset: what the deck does not use is left out
    assert "fvar" in inter  # still variable: every weight from one face
    assert "font-weight: 100 900" in css
    # Maths: the MATH table, and the italic x a browser draws for <mi>x</mi>.
    math = faces[("STIX Two Math", "normal")]
    assert "MATH" in math
    assert {0x1D465, 0x221A} <= set(math.getBestCmap() or {})
    # Emoji: the ZWJ sequence's ligature and the flag survive the subset.
    emoji = faces[("Twemoji Mozilla", "normal")]
    assert _ligature(emoji, "\U0001f469\u200d\U0001f4bb")
    assert _ligature(emoji, "\U0001f1e9\U0001f1ea")
    assert len(emoji.getGlyphOrder()) < 200
    assert "COLR" in emoji and "CPAL" in emoji


@pytest.mark.usefixtures("no_system_fonts")
def test_maths_and_emoji_only_when_the_deck_has_them(tmp_path: Path) -> None:
    deck_path = _deck(tmp_path, "::content::\n# Title\n\nJust words.\n")
    _, slides, styles = _built(deck_path)
    css = embed_fonts_css_subsetted(slides, tmp_path, None, styles_css=styles)
    families = {family for family, _ in _faces(css)}
    assert "Inter" in families
    assert "STIX Two Math" not in families
    assert "Twemoji Mozilla" not in families


@pytest.mark.usefixtures("no_system_fonts")
def test_serve_links_the_shipped_fonts_instead_of_inlining_them(tmp_path: Path) -> None:
    _, slides, styles = _built(_deck(tmp_path, "::content::\nHi\n"))
    css = embed_fonts_css(
        slides, tmp_path, None, styles_css=styles, font_url=shipped_font_url
    )
    assert 'url("/_inkflow/fonts/InterVariable.woff2") format("woff2")' in css
    assert "base64" not in css
    index = fonts._build_index(tmp_path, None)
    for match in fonts._matches(fonts.extract_font_specs(slides), index):
        assert is_shipped(match.record.path), match.family


def test_the_font_route_reaches_only_shipped_fonts() -> None:
    assert shipped_font_file("/_inkflow/fonts/InterVariable.woff2") is not None
    assert shipped_font_file("/_inkflow/fonts/InterVariable.woff2?v=1") is not None
    for bad in (
        "/_inkflow/fonts/../fonts.py",
        "/_inkflow/fonts/README.md",
        "/_inkflow/fonts/",
        "/_inkflow/fonts/sub/x.woff2",
        "/assets/x.woff2",
    ):
        assert shipped_font_file(bad) is None, bad


@pytest.fixture
def served(tmp_path: Path) -> Iterator[int]:
    yield from serve_on_a_thread(make_project(tmp_path) / "deck.py", [])


def test_the_server_serves_shipped_fonts_behind_the_door(served: int) -> None:
    status, headers, body = fetch(served, "/_inkflow/fonts/InterVariable.woff2")
    assert status == 200
    assert headers["content-type"] == "font/woff2"
    assert "max-age" in headers["cache-control"]
    assert body == (SHIPPED_FONTS_DIR / "InterVariable.woff2").read_bytes()
    # A guest with no share link gets nothing, fonts included.
    status, _, _ = fetch(served, "/_inkflow/fonts/InterVariable.woff2", GUEST)
    assert status == 401
    # Anything else in the folder is not a font: the presenter answers.
    status, headers, body = fetch(served, "/_inkflow/fonts/README.md")
    assert headers["content-type"].startswith("text/html")
    assert b"Fonts shipped with inkflow" not in body
    # The page names the interface fonts by their URL.
    _, _, page = fetch(served, "/")
    assert b'"Inkflow UI Mono"' in page and b"/_inkflow/fonts/" in page


# ── Generic families in slides ────────────────────────────────────────────────


def test_generic_families_in_inline_styles_become_the_deck_fonts() -> None:
    root = parse_svg(
        '<svg xmlns="http://www.w3.org/2000/svg">'
        + '<text style="font-size:24px;font-family:sans-serif;'
        + "-inkscape-font-specification:'sans-serif, Normal'\">a</text>"
        + "<text style=\"font-family:'Noto Sans', Sans\">b</text>"
        + '<text style="font-family:monospace">c</text>'
        + '<text style="font-family:Fira Sans">d</text></svg>'
    )
    out = serialize_svg(theme_generic_fonts(root))
    assert "font-family:var(--inkflow-body-font);" in out
    assert "-inkscape-font-specification:'sans-serif, Normal'" in out
    assert "font-family:'Noto Sans', var(--inkflow-body-font)" in out
    assert "font-family:var(--inkflow-mono-font)" in out
    assert "font-family:Fira Sans" in out


def test_contract_maps_the_attribute_form_and_maths() -> None:
    css = importlib.resources.files("inkflow").joinpath("contract.css").read_text()
    assert '[font-family="sans-serif" i]' in css
    assert '[font-family="monospace" i]' in css
    assert "font-family: var(--inkflow-math-font);" in css


@pytest.mark.usefixtures("no_system_fonts")
def test_a_slide_carrying_its_own_font_is_not_looked_up(tmp_path: Path) -> None:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "s.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>'
        + "@font-face { font-family: 'Logo Face';"
        + " src: url('data:font/woff2;base64,AAAA'); }"
        + ".logo { font-family: 'Logo Face'; }</style>"
        + '<text class="logo">x</text></svg>',
        encoding="utf-8",
    )
    deck = tmp_path / "deck.py"
    deck.write_text(
        "from inkflow import Deck, Slide\n\n\ndef main() -> Deck:\n"
        + '    return Deck(slides=[Slide("slides/s.svg")])\n'
    )
    _, slides, _ = _built(deck)
    svg = slides[0]["svg"]
    # The face is lifted out of the slide's @scope (not allowed in there).
    assert svg.index("@font-face") < svg.index("@scope")
    assert fonts.extract_font_specs(slides) == []


# ── The interface ─────────────────────────────────────────────────────────────


def test_interface_fonts_served_by_url_and_built_inline() -> None:
    served = ui_fonts_css()
    assert '"Inkflow UI"' in served and '"Inkflow UI Mono"' in served
    assert "/_inkflow/fonts/InterVariable.woff2" in served
    built = ui_fonts_css("Slide one ⏸")
    assert "base64" in built and "/_inkflow/" not in built
    # A fallback face only for characters the first two lack.
    assert '"Inkflow UI Symbols"' in built
    assert '"Inkflow UI Emoji"' not in ui_fonts_css("plain words")


# ── A static build ────────────────────────────────────────────────────────────


@pytest.mark.usefixtures("no_system_fonts")
def test_a_static_build_carries_every_font_inside(tmp_path: Path) -> None:
    deck = _deck(tmp_path, "::content::\n# Fonts\n\n$e^{i\\pi}$ 🎉\n")
    out = tmp_path / "out"
    build_static_html(deck, out)
    html = (out / "index.html").read_text(encoding="utf-8")
    for family in ("Inter", "STIX Two Math", "Twemoji Mozilla", "Inkflow UI Mono"):
        assert f'font-family: "{family}";' in html, family
    # Nothing loaded from a server: a static build has none.
    assert "/_inkflow/fonts/" not in html
