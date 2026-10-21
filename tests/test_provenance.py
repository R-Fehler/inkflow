"""Source locators: the editor build stamps every element with the file and
place it was read from, and ``locate`` finds it there again."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from inkflow.pipeline import SlideData, process_deck
from inkflow.provenance import (
    INK,
    INK_LAYER,
    INK_LOCKED,
    INK_TAG,
    INK_TOP,
    child_path,
    locate,
    parse_locator,
    stamper,
    strip_provenance,
)
from inkflow.server import load_deck
from inkflow.svgio import SvgElement, parse_svg, parse_svg_file

SVG_NS = "http://www.w3.org/2000/svg"

DRAWING = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
         xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
         viewBox="0 0 1920 1080">
      <sodipodi:namedview id="view" inkscape:zoom="0.5"/>
      <!-- a comment before the shapes -->
      <rect id="box" x="100" y="100" width="200" height="100"/>
      <text id="label" x="120" y="160">Hello</text>
      <g id="grp" transform="rotate(10)">
        <circle id="dot" cx="10" cy="10" r="5"/>
      </g>
      <g inkscape:groupmode="layer" id="layer1">
        <rect id="inlayer" x="0" y="0" width="10" height="10"/>
      </g>
      <g inkscape:groupmode="layer" id="locked" sodipodi:insensitive="true">
        <rect id="inlocked" x="0" y="0" width="10" height="10"/>
      </g>
      <a href="https://example.com"><rect id="linked" width="5" height="5"/></a>
    </svg>
""")

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" class="inkflow-fill-bg"/>
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")

DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(
            slides=[
                Slide("drawing.svg"),
                Slide("two", md="text.md"),
                Slide("two", zones={"title": "Hello"}),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "layouts").mkdir()
    (tmp_path / "slides" / "drawing.svg").write_text(DRAWING, encoding="utf-8")
    (tmp_path / "layouts" / "two.svg").write_text(LAYOUT, encoding="utf-8")
    (tmp_path / "slides" / "text.md").write_text("# Title\n\nBody\n", encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


def _build(project: Path, *, editor: bool = True) -> list[SlideData]:
    deck = load_deck(project / "deck.py")
    return process_deck(deck, project, project / "deck.py", editor=editor)


def _by_id(svg: str, element_id: str) -> SvgElement:
    el = parse_svg(svg).find(f".//*[@id='{element_id}']")
    assert el is not None, element_id
    return el


def test_locators_resolve_in_the_file_as_parsed_from_disk(project: Path) -> None:
    slides = _build(project)
    edit = slides[0].get("edit")
    assert edit is not None
    for element_id in ("box", "label", "dot", "inlayer", "linked"):
        key, path = parse_locator(_by_id(slides[0]["svg"], element_id).get(INK, ""))
        # Counted before cleaning: the Inkscape view element still counts.
        source = parse_svg_file(Path(edit["sources"][key]))
        assert locate(source, path).get("id") == element_id


def test_objects_are_marked_where_a_frontend_selects(project: Path) -> None:
    svg = _build(project)[0]["svg"]
    assert _by_id(svg, "box").get(INK_TOP) == ""
    assert _by_id(svg, "grp").get(INK_TOP) == ""
    assert _by_id(svg, "dot").get(INK_TOP) is None  # inside a group
    layer = _by_id(svg, "layer1")
    assert layer.get(INK_TOP) is None and layer.get(INK_LAYER) == ""
    assert _by_id(svg, "inlayer").get(INK_TOP) == ""  # a layer's child is an object
    assert _by_id(svg, "locked").get(INK_LOCKED) == ""
    assert _by_id(svg, "inlocked").get(INK_TOP) is None
    # A link around one object is transparent: the object inside is selected.
    linked = _by_id(svg, "linked")
    assert linked.get(INK_TOP) == ""
    parent = linked.getparent()
    assert parent is not None and parent.get(INK_TOP) is None


def test_a_layouts_elements_name_the_layout(project: Path) -> None:
    slides = _build(project)
    edit = slides[2].get("edit")
    assert edit is not None
    assert [Path(p).name for p in edit["sources"]] == ["two.svg"]
    title = _by_id(slides[2]["svg"], "zone-title")
    # A filled zone keeps its shape's locator, and says what the shape was.
    assert title.tag == f"{{{SVG_NS}}}foreignObject"
    assert title.get(INK_TAG) == "rect" and title.get(INK, "").startswith("0:")


def test_empty_zones_and_where_content_is_written(project: Path) -> None:
    slides = _build(project)
    md_slide, deck_slide = slides[1].get("edit"), slides[2].get("edit")
    assert md_slide is not None and deck_slide is not None
    assert md_slide["zoneOrigins"] == {"title": "md", "content": "md"}
    assert md_slide["emptyZones"] == []
    assert deck_slide["zoneOrigins"] == {"title": "deck"}
    [empty] = deck_slide["emptyZones"]
    assert empty["zone"] == "content"
    assert (empty["x"], empty["y"], empty["width"], empty["height"]) == (
        80,
        200,
        1760,
        780,
    )
    key, path = parse_locator(empty["locator"])
    source = parse_svg_file(Path(deck_slide["sources"][key]))
    assert locate(source, path).get("id") == "zone-content"


def test_a_plain_build_has_none(project: Path) -> None:
    slides = _build(project, editor=False)
    assert all("data-ink" not in s["svg"] and "edit" not in s for s in slides)


def test_locators_round_trip_and_refuse_nonsense() -> None:
    root = parse_svg(DRAWING)
    stamper(3)(root)
    box = root.find(f"{{{SVG_NS}}}rect")
    assert box is not None
    assert box.get(INK) == f"3:{child_path(box)}"
    assert locate(root, child_path(box)) is box
    with pytest.raises(LookupError):
        locate(root, "99")
    for bad in ("x:1", "1", "1:a.b"):
        with pytest.raises(ValueError, match="malformed"):
            parse_locator(bad)
    strip_provenance(root)
    assert all(INK not in el.attrib for el in root.iter() if isinstance(el.tag, str))
