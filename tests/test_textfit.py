"""A text zone's size (``--inkflow-font-scale``) and shrink-to-fit
(``--inkflow-fit``): where each is written (the zone shape's style, a Markdown
marker's ``size=``/``fit=``, ``TextBox(size=, fit=)``), how the build emits
them, a marker's parameters written back, the readable minimum a printed
slide carries for the browser's fitting (src/ts/shared/fit.ts), and `inkflow
render` measuring a zone after the browser fitted it."""

from __future__ import annotations

import subprocess
import textwrap
from pathlib import Path

import pytest
from lxml import etree

from inkflow import export
from inkflow.content import substitute_content
from inkflow.export import find_chromium
from inkflow.manifest import TextBox
from inkflow.pipeline import process_deck
from inkflow.render import render_slides
from inkflow.server import load_deck
from inkflow.sizes import PRINT_MIN_TEXT, PageSize, print_body_pt
from inkflow.svgio import SvgElement, parse_svg
from inkflow.zones import (
    parse_markdown_zones,
    replace_zone_text,
    set_zone_params,
    zone_params,
)

XHTML = "http://www.w3.org/1999/xhtml"


class TestMarkers:
    def test_size_and_fit_reach_the_textbox(self) -> None:
        from inkflow.assets import AssetRoots, AssetSource
        from inkflow.zones import build_slide_content

        source = AssetSource.for_deck(AssetRoots(Path.cwd()))
        parsed = parse_markdown_zones(
            "::content size=80% fit=none::\nText\n\n::side size=0.5::\nMore\n"
        )
        content = build_slide_content(parsed, {}, source, source).content
        box = content["zone-content"]
        assert isinstance(box, TextBox)
        assert (box.size, box.fit) == (pytest.approx(0.8), False)
        side = content["zone-side"]
        assert isinstance(side, TextBox)
        assert (side.size, side.fit) == (pytest.approx(0.5), None)

    def test_a_bad_value_is_ignored(self, caplog: pytest.LogCaptureFixture) -> None:
        from inkflow.assets import AssetRoots, AssetSource
        from inkflow.zones import build_slide_content

        source = AssetSource.for_deck(AssetRoots(Path.cwd()))
        parsed = parse_markdown_zones("::content size=9000% fit=maybe::\nText\n")
        box = build_slide_content(parsed, {}, source, source).content["zone-content"]
        assert isinstance(box, TextBox)
        assert (box.size, box.fit) == (None, None)
        assert "size=9000%" in caplog.text and "fit=maybe" in caplog.text

    def test_set_params_on_a_marker_keeps_the_others(self) -> None:
        md = "# T\n\n::content align=center::\nBody\n"
        out = set_zone_params(md, "content", {"size": "80%", "fit": "none"})
        assert out == "# T\n\n::content align=center size=80% fit=none::\nBody\n"
        assert zone_params(out, "content") == {
            "align": "center",
            "size": "80%",
            "fit": "none",
        }
        back = set_zone_params(out, "content", {"size": None, "fit": None})
        assert back == md

    def test_auto_zones_get_markers(self) -> None:
        md = "# Title\n\nBody text\n"
        out = set_zone_params(md, "title", {"size": "80%"})
        assert out == "::title size=80%::\n# Title\n\n::content::\nBody text\n"
        parsed = parse_markdown_zones(out)
        assert parsed.params["title"] == {"size": "80%"}
        assert set(parsed.zones) == {"title", "content"}

    def test_a_zone_the_file_does_not_name_gets_an_empty_marker(self) -> None:
        out = set_zone_params("Just text\n", "body", {"fit": "none"})
        assert out == "Just text\n\n::body fit=none::\n"
        assert parse_markdown_zones(out).params["body"] == {"fit": "none"}
        assert set_zone_params("x\n", "body", {"size": None}) == "x\n"

    def test_writing_text_keeps_the_marker_params(self) -> None:
        md = "::content size=80%::\nOld\n"
        assert replace_zone_text(md, "content", "New") == "::content size=80%::\nNew\n"


ZONE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-a" x="0" y="0" width="400" height="100"
            style="--inkflow-font-scale:0.9;--inkflow-fit:none"/>
    </svg>
""")


class TestBuild:
    def test_textbox_fields_go_on_the_wrapper(self) -> None:
        root = parse_svg(ZONE_SVG)
        substitute_content(root, {"zone-a": TextBox("Hi", size=0.8, fit=True)})
        fo = root.find('.//*[@id="zone-a"]')
        assert fo is not None
        # The shape's own values on the box (inherited)...
        assert "--inkflow-font-scale:0.9" in (fo.get("style") or "")
        # ...the slide's text's values on the wrapper inside it, which win.
        wrapper = fo.find(f"{{{XHTML}}}div")
        assert wrapper is not None
        style = wrapper.get("style") or ""
        assert "--inkflow-font-scale:0.8" in style
        assert "--inkflow-fit:shrink" in style

    def test_unset_fields_write_nothing(self) -> None:
        root = parse_svg(ZONE_SVG)
        substitute_content(root, {"zone-a": TextBox("Hi")})
        fo = root.find('.//*[@id="zone-a"]')
        assert fo is not None
        wrapper = fo.find(f"{{{XHTML}}}div")
        assert wrapper is not None
        assert wrapper.get("style") is None

    def test_contract_css_multiplies_both_factors(self) -> None:
        css = (Path(__file__).parent.parent / "src/inkflow/contract.css").read_text()
        flat = " ".join(css.split())
        assert "var(--inkflow-font-scale, 1) * var(--inkflow-fit-scale, 1)" in flat

    def test_a_printed_slide_carries_its_readable_minimum(self, tmp_path: Path) -> None:
        (tmp_path / "deck.py").write_text(
            textwrap.dedent("""\
                from inkflow import Deck, Slide


                def main() -> Deck:
                    return Deck(
                        size="a0", embed_fonts=False, slides=[Slide("poster-base")]
                    )
            """)
        )
        deck = load_deck(tmp_path / "deck.py")
        svg = process_deck(deck, tmp_path, tmp_path / "deck.py")[0]["svg"]
        root = parse_svg(svg)
        size = PageSize("a0")
        w, h = size.page_pt
        cw, ch = size.canvas
        expected = print_body_pt(w, h) * PRINT_MIN_TEXT / min(w / cw, h / ch)
        assert float(root.get("data-inkflow-min-text", "0")) == pytest.approx(
            expected, rel=1e-3
        )

    def test_a_screen_slide_has_none(self, tmp_path: Path) -> None:
        (tmp_path / "deck.py").write_text(
            textwrap.dedent("""\
                from inkflow import Deck, Slide


                def main() -> Deck:
                    return Deck(embed_fonts=False, slides=[Slide("content")])
            """)
        )
        deck = load_deck(tmp_path / "deck.py")
        svg = process_deck(deck, tmp_path, tmp_path / "deck.py")[0]["svg"]
        assert "data-inkflow-min-text" not in svg


needs_chromium = pytest.mark.skipif(
    find_chromium() is None, reason="no Chromium available"
)


FIT_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" fill="#fff"/>
      <rect id="zone-roomy" x="100" y="100" width="800" height="600"/>
      <rect id="zone-shrinks" x="1000" y="100" width="800" height="300"/>
      <rect id="zone-off" x="100" y="800" width="800" height="120"
            style="--inkflow-fit:none"/>
    </svg>
""")


FIT_DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide(
                    "slide.svg",
                    zones={
                        "roomy": "A short line.",
                        "shrinks": "\\n\\n".join(["A paragraph of text."] * 8),
                        "off": "\\n\\n".join(["A paragraph of text."] * 4),
                    },
                ),
            ],
        )
""")


@needs_chromium
def test_the_pdf_page_fits_text_to_its_box(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The PDF export's page runs fit.js: what Chromium prints is the page
    after fitting. Its DOM is dumped instead of printed, to read the result."""
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "slide.svg").write_text(FIT_SVG)
    (tmp_path / "deck.py").write_text(FIT_DECK)
    dumped: list[str] = []
    run = subprocess.run

    def dump_dom(cmd: list[str], **_kwargs: object) -> object:
        args = [a for a in cmd if not a.startswith("--print-to-pdf")]
        out = run([*args[:-1], "--dump-dom", args[-1]], capture_output=True, text=True)
        dumped.append(out.stdout)
        # Stands in for the printed file the export checks for.
        target = next(a for a in cmd if a.startswith("--print-to-pdf="))
        _ = Path(target.split("=", 1)[1]).write_bytes(b"%PDF-1.4\n")
        return out

    monkeypatch.setattr(subprocess, "run", dump_dom)
    export.build_pdf(tmp_path / "deck.py", tmp_path / "out.pdf", no_sandbox=True)
    root = etree.fromstring(dumped[0], etree.HTMLParser())

    def zone(name: str) -> SvgElement:
        return next(el for el in root.iter() if el.get("id") == f"zone-{name}")

    assert zone("roomy").get("data-inkflow-fit") is None
    shrunk = zone("shrinks")
    assert 0.33 <= float(shrunk.get("data-inkflow-fit", "1")) < 1
    assert shrunk.get("data-inkflow-overflow") is None
    off = zone("off")
    assert off.get("data-inkflow-fit") is None
    assert off.get("data-inkflow-overflow") == ""


RENDER_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" fill="#fff"/>
      <rect id="zone-shrinks" x="100" y="100" width="800" height="300"/>
      <rect id="zone-floor" x="1000" y="100" width="800" height="120"/>
      <rect id="zone-off" x="100" y="600" width="800" height="120"
            style="--inkflow-fit:none"/>
    </svg>
""")


RENDER_DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide(
                    "slide.svg",
                    zones={
                        "shrinks": "\\n\\n".join(["A paragraph of text."] * 8),
                        "floor": "\\n\\n".join(["A paragraph of text."] * 30),
                        "off": "\\n\\n".join(["A paragraph of text."] * 4),
                    },
                ),
            ],
        )
""")


@needs_chromium
def test_render_measures_text_after_fitting(tmp_path: Path) -> None:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "slide.svg").write_text(RENDER_SVG)
    (tmp_path / "deck.py").write_text(RENDER_DECK)
    result = render_slides(
        tmp_path / "deck.py", None, None, no_sandbox=True, contrast=False
    )
    overflow = {f.target: f for f in result.findings if f.kind == "overflow"}
    # Shrunk until it fits: nothing to report.
    assert "#zone-shrinks" not in overflow
    # At the floor and still too much: a problem saying how far it shrank,
    # the readable minimum (1080/80 = 13.5 of 36: 37.5 %) above the 33 % floor.
    floor = overflow["#zone-floor"]
    assert floor.is_problem
    assert floor.size == pytest.approx(0.375, abs=0.001)
    assert "even shrunk to 38%" in floor.message()
    # Shrinking off: overflows at its own size.
    assert overflow["#zone-off"].size == 0
    assert not any(f.kind == "small-text" for f in result.findings)


def test_a_text_size_is_written_as_its_marker_reads_it() -> None:
    from inkflow.manifest import format_text_scale, parse_text_scale

    assert format_text_scale(0.8) == "80%"
    assert format_text_scale(0.67) == "67%"
    assert format_text_scale(1.125) == "112.5%"
    assert parse_text_scale(format_text_scale(1.125)) == 1.125
