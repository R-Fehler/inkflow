"""The visual editor's backend: provenance, write-back operations and the model."""

from __future__ import annotations

import base64
import json
import textwrap
from pathlib import Path
from typing import cast

import pytest

from inkflow.animations import FadeIn, SlideIn
from inkflow.editor.codegen import Code, coerce_fields, field_schema
from inkflow.editor.context import format_context, read_context, write_context
from inkflow.editor.deckedit import DeckEditError, DeckSource
from inkflow.editor.model import build_model
from inkflow.editor.provenance import INK, INK_TOP, is_element, locate, parse_locator
from inkflow.editor.session import EditError, EditorSession
from inkflow.editor.svgops import SvgFile, SvgOpError, apply_ops, group, ungroup
from inkflow.enums import Direction, Easing, Trigger
from inkflow.manifest import Deck
from inkflow.pipeline import process_deck
from inkflow.server import load_deck
from inkflow.svgio import parse_svg, parse_svg_file
from inkflow.transitions import Push
from inkflow.zones import replace_zone_text, zone_spans

SVG_NS = "http://www.w3.org/2000/svg"

DRAWING = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
         viewBox="0 0 1920 1080">
      <!-- a comment before the shapes -->
      <rect id="box" x="100" y="100" width="200" height="100"/>
      <text id="label" x="120" y="160">Hello</text>
      <g id="grp" transform="rotate(10)">
        <circle id="dot" cx="10" cy="10" r="5"/>
      </g>
      <g inkscape:groupmode="layer" id="layer1">
        <rect id="inlayer" x="0" y="0" width="10" height="10"/>
      </g>
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
    from inkflow import Deck, Slide, animations


    def main() -> Deck:
        return Deck(
            slides=[
                # The drawn slide.
                Slide(
                    "drawing.svg",
                    notes="notes/drawing.md",
                    animations=[animations.FadeIn("box")],
                ),
                Slide("two", md="text.md"),
                Slide("two", zones={"title": "Hello"}),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "layouts").mkdir()
    (tmp_path / "notes").mkdir()
    (tmp_path / "slides" / "drawing.svg").write_text(DRAWING, encoding="utf-8")
    (tmp_path / "layouts" / "two.svg").write_text(LAYOUT, encoding="utf-8")
    (tmp_path / "slides" / "text.md").write_text("# Title\n\nBody\n", encoding="utf-8")
    (tmp_path / "notes" / "drawing.md").write_text("Speak.\n", encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


def _deck(project: Path) -> Deck:
    return load_deck(project / "deck.py")


# ── Provenance ────────────────────────────────────────────────────────────────


class TestProvenance:
    def test_editor_build_stamps_locators_that_resolve(self, project: Path) -> None:
        deck = _deck(project)
        slides = process_deck(deck, project, project / "deck.py", editor=True)
        edit = slides[0].get("edit")
        assert edit is not None
        root = parse_svg(slides[0]["svg"])
        box = root.find(f".//{{{SVG_NS}}}rect[@id='box']")
        assert box is not None and box.get(INK_TOP) == ""
        key, path = parse_locator(box.get(INK, ""))
        source = parse_svg_file(Path(edit["sources"][key]))
        assert locate(source, path).get("id") == "box"

    def test_layer_children_are_objects_layers_are_not(self, project: Path) -> None:
        deck = _deck(project)
        slides = process_deck(deck, project, project / "deck.py", editor=True)
        root = parse_svg(slides[0]["svg"])
        layer = root.find(".//*[@id='layer1']")
        inner = root.find(".//*[@id='inlayer']")
        dot = root.find(".//*[@id='dot']")
        assert layer is not None and inner is not None and dot is not None
        assert layer.get(INK_TOP) is None
        assert inner.get(INK_TOP) == ""
        assert dot.get(INK_TOP) is None  # inside a group, not top level

    def test_filled_zone_keeps_its_rect_locator(self, project: Path) -> None:
        deck = _deck(project)
        slides = process_deck(deck, project, project / "deck.py", editor=True)
        root = parse_svg(slides[2]["svg"])
        title = root.find(".//*[@id='zone-title']")
        assert title is not None
        assert title.tag == f"{{{SVG_NS}}}foreignObject"
        assert title.get("data-ink-tag") == "rect"
        assert title.get(INK, "").startswith("0:")

    def test_empty_zones_and_origins_are_reported(self, project: Path) -> None:
        deck = _deck(project)
        slides = process_deck(deck, project, project / "deck.py", editor=True)
        md_slide = slides[1].get("edit")
        deck_slide = slides[2].get("edit")
        assert md_slide is not None and deck_slide is not None
        assert md_slide["zoneOrigins"] == {"title": "md", "content": "md"}
        assert deck_slide["zoneOrigins"] == {"title": "deck"}
        assert [z["zone"] for z in deck_slide["emptyZones"]] == ["content"]

    def test_plain_build_has_no_provenance(self, project: Path) -> None:
        deck = _deck(project)
        slides = process_deck(deck, project, project / "deck.py")
        assert "data-ink" not in slides[0]["svg"]
        assert "edit" not in slides[0]


# ── SVG operations ────────────────────────────────────────────────────────────


def _svg(text: str = DRAWING) -> SvgFile:
    return SvgFile.from_bytes(Path("x.svg"), text.encode())


def _loc(svg: SvgFile, element_id: str) -> str:
    from inkflow.editor.provenance import child_path

    el = svg.root.find(f".//*[@id='{element_id}']")
    assert el is not None
    return f"0:{child_path(el)}"


class TestSvgOps:
    def test_attrs_change_only_that_element(self) -> None:
        svg = _svg()
        apply_ops(svg, [{"kind": "attrs", "loc": _loc(svg, "box"), "set": {"x": "5"}}])
        out = svg.to_bytes().decode()
        assert '<rect id="box" x="5" y="100"' in out
        assert "<!-- a comment before the shapes -->" in out

    def test_attrs_cannot_set_event_handlers(self) -> None:
        svg = _svg()
        with pytest.raises(SvgOpError):
            apply_ops(
                svg,
                [{"kind": "attrs", "loc": _loc(svg, "box"), "set": {"onclick": "x"}}],
            )

    def test_paint_with_a_theme_token_replaces_inline_colour(self) -> None:
        svg = _svg(
            '<svg xmlns="http://www.w3.org/2000/svg">'
            + '<rect style="fill:#f00;stroke:#00f"/></svg>'
        )
        apply_ops(
            svg, [{"kind": "paint", "loc": "0:0", "prop": "fill", "token": "accent"}]
        )
        rect = svg.root[0]
        assert rect.get("class") == "inkflow-fill-accent"
        assert rect.get("style") == "stroke:#00f"
        apply_ops(
            svg, [{"kind": "paint", "loc": "0:0", "prop": "fill", "color": "#123456"}]
        )
        assert rect.get("class") is None
        assert "fill:#123456" in (rect.get("style") or "")

    def test_paint_rejects_unknown_tokens_and_bad_colours(self) -> None:
        svg = _svg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
        with pytest.raises(SvgOpError):
            apply_ops(
                svg, [{"kind": "paint", "loc": "0:0", "prop": "fill", "token": "nope"}]
            )
        with pytest.raises(SvgOpError):
            apply_ops(
                svg,
                [{"kind": "paint", "loc": "0:0", "prop": "fill", "color": "url(evil)"}],
            )

    def test_text_single_and_multi_line(self) -> None:
        svg = _svg()
        loc = _loc(svg, "label")
        apply_ops(svg, [{"kind": "text", "loc": loc, "lines": ["Hi"]}])
        label = svg.root.find(".//*[@id='label']")
        assert label is not None and label.text == "Hi"
        apply_ops(svg, [{"kind": "text", "loc": loc, "lines": ["One", "Two"]}])
        spans = list(label)
        assert [s.text for s in spans] == ["One", "Two"]
        assert spans[1].get("dy") == "1.2em"

    def test_text_keeps_inkscape_line_spacing(self) -> None:
        svg = _svg(
            '<svg xmlns="http://www.w3.org/2000/svg"><text>'
            + '<tspan x="5" y="10" style="font-weight:bold">a</tspan>'
            + '<tspan x="5" y="40">b</tspan></text></svg>'
        )
        apply_ops(svg, [{"kind": "text", "loc": "0:0", "lines": ["1", "2", "3"]}])
        spans = list(svg.root[0])
        assert [s.get("y") for s in spans] == ["10", "40", "70"]
        assert all(s.get("style") == "font-weight:bold" for s in spans)

    def test_batch_resolves_targets_before_deleting(self) -> None:
        svg = _svg()
        box, label = _loc(svg, "box"), _loc(svg, "label")
        apply_ops(
            svg,
            [
                {"kind": "delete", "loc": box},
                {"kind": "attrs", "loc": label, "set": {"x": "1"}},
            ],
        )
        assert svg.root.find(".//*[@id='box']") is None
        el = svg.root.find(".//*[@id='label']")
        assert el is not None and el.get("x") == "1"

    def test_duplicate_gets_fresh_ids_and_offset(self) -> None:
        svg = _svg()
        result = apply_ops(
            svg,
            [
                {
                    "kind": "duplicate",
                    "loc": _loc(svg, "grp"),
                    "offset": [10, 5],
                    "key": "d",
                }
            ],
        )
        new_id = result.ids["d"]
        assert new_id == "grp-2"
        clone = svg.root.find(f".//*[@id='{new_id}']")
        assert clone is not None
        assert clone.get("transform") == "translate(10,5) rotate(10)"
        assert svg.root.find(".//*[@id='dot-2']") is not None
        assert result.structural

    def test_insert_assigns_a_unique_id_and_sanitises(self) -> None:
        svg = _svg()
        result = apply_ops(
            svg,
            [
                {
                    "kind": "insert",
                    "parent": "0:",
                    "xml": '<rect id="box" onclick="x()" width="1"/>',
                    "key": "n",
                }
            ],
        )
        assert result.ids["n"] == "box-2"
        new = svg.root.find(".//*[@id='box-2']")
        assert new is not None and new.get("onclick") is None

    def test_insert_refuses_scripts(self) -> None:
        svg = _svg()
        with pytest.raises(SvgOpError):
            apply_ops(
                svg,
                [
                    {
                        "kind": "insert",
                        "parent": "0:",
                        "xml": "<script>alert(1)</script>",
                    }
                ],
            )

    def test_insert_into_layer(self) -> None:
        svg = _svg()
        apply_ops(
            svg,
            [
                {
                    "kind": "insert",
                    "parent": _loc(svg, "layer1"),
                    "xml": '<circle id="c" r="2"/>',
                }
            ],
        )
        layer = svg.root.find(".//*[@id='layer1']")
        assert layer is not None and layer[-1].get("id") == "c"

    def test_order_front_and_back(self) -> None:
        svg = _svg()
        apply_ops(svg, [{"kind": "order", "loc": _loc(svg, "box"), "to": "front"}])
        painted = [el.get("id") for el in svg.root if is_element(el)]
        assert painted[-1] == "box"
        apply_ops(svg, [{"kind": "order", "loc": _loc(svg, "box"), "to": "back"}])
        painted = [el.get("id") for el in svg.root if is_element(el)]
        assert painted[0] == "box"

    def test_rename_refuses_a_taken_id(self) -> None:
        svg = _svg()
        with pytest.raises(SvgOpError):
            apply_ops(svg, [{"kind": "id", "loc": _loc(svg, "box"), "id": "label"}])

    def test_ensure_id_and_marker(self) -> None:
        svg = _svg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
        result = apply_ops(
            svg,
            [
                {"kind": "ensure-id", "loc": "0:0", "key": "t", "base": "rect"},
                {"kind": "ensure-marker"},
                {"kind": "ensure-marker"},
            ],
        )
        assert result.ids["t"] == "rect"
        markers = svg.root.findall(f".//{{{SVG_NS}}}marker")
        assert len(markers) == 1

    def test_group_and_ungroup(self) -> None:
        svg = _svg()
        group_id = group(svg, [_loc(svg, "box"), _loc(svg, "label")])
        g = svg.root.find(f".//*[@id='{group_id}']")
        assert g is not None and [c.get("id") for c in g] == ["box", "label"]
        ungroup(svg, _loc(svg, "grp"))
        dot = svg.root.find(".//*[@id='dot']")
        assert dot is not None and dot.getparent() is svg.root
        assert dot.get("transform") == "rotate(10)"

    def test_stale_locator_raises(self) -> None:
        svg = _svg()
        with pytest.raises(SvgOpError):
            apply_ops(svg, [{"kind": "attrs", "loc": "0:99", "set": {"x": "1"}}])


# ── Markdown zone spans ──────────────────────────────────────────────────────


class TestZoneSpans:
    def test_auto_extracted_heading_and_body(self) -> None:
        text = "# Title\n\n## Sub\n\nbody\nmore\n"
        spans = zone_spans(text)
        assert {k: text[a:b] for k, (a, b) in spans.items()} == {
            "title": "# Title",
            "subtitle": "## Sub",
            "content": "body\nmore",
        }

    def test_markers_override_auto_content(self) -> None:
        text = "intro\n::title::\nHello\n\n::content align=center::\n- a\n"
        spans = zone_spans(text)
        assert text[slice(*spans["content"])] == "- a"
        assert text[slice(*spans["title"])] == "Hello"

    def test_replace_keeps_other_sections(self) -> None:
        text = "# T\n\nBody\n\n::aside::\nSide\n"
        out = replace_zone_text(text, "aside", "New side")
        assert out == "# T\n\nBody\n\n::aside::\nNew side\n"

    def test_replace_title_keeps_it_a_heading(self) -> None:
        assert (
            replace_zone_text("# T\n\nBody\n", "title", "Fresh") == "# Fresh\n\nBody\n"
        )

    def test_new_zones_are_appended_or_prepended(self) -> None:
        assert replace_zone_text("Body\n", "title", "T") == "# T\n\nBody\n"
        assert replace_zone_text("# T\n", "media", "x") == "# T\n\n::media::\nx\n"
        assert replace_zone_text("", "content", "x") == "x\n"


# ── deck.py edits ─────────────────────────────────────────────────────────────


class TestDeckSource:
    def test_slide_calls_found(self) -> None:
        calls = DeckSource(DECK).slide_calls(expected=3)
        assert calls is not None and len(calls) == 3

    def test_non_literal_slides_are_not_editable(self) -> None:
        code = "def main():\n    return Deck(slides=[Slide(x) for x in 'ab'])\n"
        assert DeckSource(code).slide_calls() is None
        with pytest.raises(DeckEditError):
            DeckSource(code).move_slide(0, 1)

    def test_slides_bound_to_a_name_are_followed(self) -> None:
        code = (
            "SLIDES = [Slide('a'), Slide('b')]\n"
            + "def main():\n    return Deck(slides=SLIDES)\n"
        )
        source = DeckSource(code)
        source.move_slide(1, 0)
        assert "SLIDES = [Slide('b'), Slide('a')]" in source.code

    def test_move_carries_the_comment_above_a_slide(self) -> None:
        source = DeckSource(DECK)
        source.move_slide(0, 2)
        code = source.code
        assert code.index('Slide("two", zones') < code.index("# The drawn slide.")
        assert code.index("# The drawn slide.") < code.index('"drawing.svg"')
        compile(code, "deck.py", "exec")

    def test_insert_remove_and_duplicate(self) -> None:
        source = DeckSource(DECK)
        source.insert_slide(1, 'Slide("new.svg")')
        source.duplicate_slide(2, {"id": '"copy"'})
        source.remove_slide(0)
        calls = source.slide_calls()
        assert calls is not None
        code = source.code
        assert code.count("Slide(") == 4
        assert 'Slide("new.svg"),' in code
        assert 'id="copy"' in code
        compile(code, "deck.py", "exec")

    def test_last_slide_cannot_be_removed(self) -> None:
        source = DeckSource("Deck(slides=[Slide('a')])\n")
        with pytest.raises(DeckEditError):
            source.remove_slide(0)

    def test_set_and_remove_keyword_arguments(self) -> None:
        source = DeckSource(DECK)
        source.set_slide_arg(1, "transition", "transitions.Fade()")
        source.set_slide_arg(0, "notes", None)
        source.set_slide_arg(2, "src", '"other"')
        code = source.code
        assert 'Slide("two", md="text.md", transition=transitions.Fade())' in code
        assert "notes=" not in code
        assert 'Slide("other", zones' in code

    def test_multiline_call_gains_an_argument_on_its_own_line(self) -> None:
        source = DeckSource(DECK)
        source.set_slide_arg(0, "title", '"Drawn"')
        assert '\n                title="Drawn",\n            ),' in source.code

    def test_animation_list_edits(self) -> None:
        source = DeckSource(DECK)
        source.edit_animations(0, insert=(1, 'animations.FadeOut("box")'))
        source.edit_animations(0, move=(1, 0))
        source.edit_animations(0, replace=(1, 'animations.FadeIn("label")'))
        code = source.code
        assert code.index('FadeOut("box")') < code.index('FadeIn("label")')
        source.edit_animations(0, remove=0)
        source.edit_animations(0, remove=0)
        assert "animations=" not in source.code
        source.edit_animations(1, insert=(0, 'animations.FadeIn("x")'))
        assert 'animations=[animations.FadeIn("x")]' in source.code

    def test_zone_edits(self) -> None:
        source = DeckSource(DECK)
        source.set_zone(2, "title", '"Bye"')
        source.set_zone(2, "content", '"More"')
        assert 'zones={"title": "Bye", "content": "More"}' in source.code
        source.set_zone(2, "title", None)
        source.set_zone(2, "content", None)
        assert "zones=" not in source.code
        source.set_zone(1, "media", 'Image("a.png")')
        assert 'zones={"media": Image("a.png")}' in source.code

    def test_ensure_imports_extends_the_inkflow_import(self) -> None:
        source = DeckSource(DECK)
        source.ensure_imports({"Trigger", "transitions", "Deck"})
        first = source.code.splitlines()[0]
        assert (
            first == "from inkflow import Deck, Slide, Trigger, animations, transitions"
        )

    def test_ensure_imports_skips_classes_defined_in_the_deck(self) -> None:
        source = DeckSource("from inkflow import Deck\nclass Flicker:\n    pass\n")
        source.ensure_imports({"Flicker"})
        assert source.code.splitlines()[0] == "from inkflow import Deck"


# ── Code generation ───────────────────────────────────────────────────────────


class TestCodegen:
    def test_defaults_are_left_out(self) -> None:
        code = Code()
        assert code.call(FadeIn("box")) == 'animations.FadeIn("box")'
        assert code.imports == {"animations"}

    def test_values_are_spelled_like_an_author_would(self) -> None:
        code = Code()
        anim = SlideIn(
            "box",
            Trigger.WITH_PREVIOUS,
            direction=Direction.DOWN,
            distance=300,
            easing=Easing.cubic_bezier(0.2, 0, 0.3, 1),
        )
        assert code.call(anim) == (
            'animations.SlideIn("box", Trigger.WITH_PREVIOUS, '
            + "easing=Easing.cubic_bezier(0.2, 0, 0.3, 1), "
            + "direction=Direction.DOWN, distance=300)"
        )
        assert code.imports == {"animations", "Trigger", "Easing", "Direction"}

    def test_pinned_trigger_and_transitions(self) -> None:
        code = Code()
        assert (
            code.call(FadeIn("a", Trigger.at(3)))
            == 'animations.FadeIn("a", Trigger.at(3))'
        )
        assert code.call(Push(direction=Direction.LEFT)) == "transitions.Push()"

    def test_coerce_fields_converts_and_validates(self) -> None:
        fields = coerce_fields(
            SlideIn,
            {
                "direction": "up",
                "distance": "12",
                "trigger": "with-previous",
                "bogus": 1,
            },
        )
        assert fields == {
            "direction": Direction.UP,
            "distance": 12.0,
            "trigger": Trigger.WITH_PREVIOUS,
        }
        with pytest.raises(ValueError):
            coerce_fields(SlideIn, {"trigger": "whenever"})

    def test_field_schema_lists_choices(self) -> None:
        schema = {f["name"]: f for f in field_schema(SlideIn)}
        assert schema["direction"]["kind"] == "enum"
        assert "left" in cast("list[str]", schema["direction"]["choices"])
        assert schema["trigger"]["kind"] == "trigger"
        assert "element" not in schema


# ── Session (end to end on files) ─────────────────────────────────────────────


def _hash(path: Path) -> str:
    from inkflow.editor.svgops import file_hash

    return file_hash(path.read_bytes())


class TestSession:
    def test_svg_edit_and_undo_redo(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        svg_path = project / "slides" / "drawing.svg"
        before = svg_path.read_text()
        svg = _svg(before)
        result = session.apply(
            {
                "action": "svg",
                "file": str(svg_path),
                "hash": _hash(svg_path),
                "ops": [{"kind": "attrs", "loc": _loc(svg, "box"), "set": {"x": "7"}}],
            },
            _deck(project),
        )
        assert result["ok"] and result["canUndo"]
        assert 'id="box" x="7"' in svg_path.read_text()
        session.apply({"action": "undo"}, None)
        assert svg_path.read_text() == before
        session.apply({"action": "redo"}, None)
        assert 'id="box" x="7"' in svg_path.read_text()

    def test_stale_hash_is_refused(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        svg_path = project / "slides" / "drawing.svg"
        with pytest.raises(EditError, match="changed on disk"):
            session.apply(
                {"action": "svg", "file": str(svg_path), "hash": "stale", "ops": []},
                _deck(project),
            )

    def test_files_outside_the_project_are_refused(
        self, project: Path, tmp_path_factory: pytest.TempPathFactory
    ) -> None:
        outside = tmp_path_factory.mktemp("out") / "x.svg"
        outside.write_text(DRAWING)
        session = EditorSession(project / "deck.py")
        with pytest.raises(EditError, match="outside the project"):
            session.apply(
                {"action": "svg", "file": str(outside), "ops": []}, _deck(project)
            )

    def test_undo_refuses_after_an_outside_edit(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "notes", "slide": 0, "text": "New notes"}, _deck(project)
        )
        (project / "notes" / "drawing.md").write_text("Edited elsewhere")
        with pytest.raises(EditError, match="changed outside the editor"):
            session.apply({"action": "undo"}, None)

    def test_coalesced_steps_undo_together(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        notes = project / "notes" / "drawing.md"
        for text in ("a", "ab", "abc"):
            session.apply(
                {"action": "notes", "slide": 0, "text": text, "coalesce": "typing"},
                _deck(project),
            )
        assert len(session.history.done) == 1
        session.apply({"action": "undo"}, None)
        assert notes.read_text() == "Speak.\n"

    def test_zone_text_in_markdown(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "zone-text", "slide": 1, "zone": "content", "text": "New body"},
            _deck(project),
        )
        assert (project / "slides" / "text.md").read_text() == "# Title\n\nNew body\n"

    def test_zone_text_in_deck(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "zone-text", "slide": 2, "zone": "title", "text": "Bye"},
            _deck(project),
        )
        assert 'zones={"title": "Bye"}' in (project / "deck.py").read_text()

    def test_new_notes_file(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "notes", "slide": 1, "text": "Hi", "name": "text"},
            _deck(project),
        )
        assert (project / "notes" / "text.md").read_text() == "Hi"
        assert 'notes="notes/text.md"' in (project / "deck.py").read_text()

    def test_slide_lifecycle(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "slide", "op": "new", "after": 0, "layout": "two"},
            _deck(project),
        )
        deck = _deck(project)
        assert len(deck.slides) == 4
        assert deck.slides[1].src == "slide.svg"
        new_svg = project / "slides" / "slide.svg"
        assert 'inkflow:parent="two"' in new_svg.read_text()
        session.apply(
            {"action": "slide", "op": "duplicate", "slide": 0}, _deck(project)
        )
        deck = _deck(project)
        assert deck.slides[1].src == "drawing-copy.svg"
        assert (project / "slides" / "drawing-copy.svg").exists()
        session.apply(
            {"action": "slide", "op": "move", "from": 0, "to": 4}, _deck(project)
        )
        assert _deck(project).slides[4].src == "drawing.svg"
        session.apply(
            {"action": "slide", "op": "hide", "slide": 0, "hidden": True},
            _deck(project),
        )
        assert _deck(project).slides[0].visible is False
        session.apply({"action": "slide", "op": "delete", "slide": 0}, _deck(project))
        assert len(_deck(project).slides) == 4

    def test_detach_never_shadows_a_layout(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "slide", "op": "detach", "slide": 2, "name": "two"},
            _deck(project),
        )
        deck = _deck(project)
        assert deck.slides[2].src == "two-slide.svg"
        assert deck.slides[1].src == "two"

    def test_transition_and_animation(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {
                "action": "slide",
                "op": "transition",
                "slide": 0,
                "spec": {"type": "Push", "fields": {"direction": "up"}},
            },
            _deck(project),
        )
        code = (project / "deck.py").read_text()
        assert "transition=transitions.Push(direction=Direction.UP)" in code
        assert "Direction" in code.splitlines()[0]
        svg_path = project / "slides" / "drawing.svg"
        svg_path.write_text(svg_path.read_text().replace(' id="dot"', ""))
        svg = _svg(svg_path.read_text())
        grp = svg.root.find(".//*[@id='grp']")
        assert grp is not None
        from inkflow.editor.provenance import child_path

        # The target has no id yet: it gets one in the same step.
        session.apply(
            {
                "action": "anim",
                "slide": 0,
                "op": "insert",
                "index": 1,
                "spec": {
                    "type": "SlideIn",
                    "element": "",
                    "fields": {"trigger": "with-previous"},
                },
                "target": {
                    "file": str(svg_path),
                    "loc": f"0:{child_path(grp[0])}",
                    "base": "circle",
                },
            },
            _deck(project),
        )
        deck = _deck(project)
        assert [type(c).__name__ for c in deck.slides[0].animations] == [
            "FadeIn",
            "SlideIn",
        ]
        assert deck.slides[0].animations[1].element == "circle"
        assert 'id="circle"' in svg_path.read_text()

    def test_rename_updates_animations(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        svg_path = project / "slides" / "drawing.svg"
        svg = _svg(svg_path.read_text())
        session.apply(
            {
                "action": "svg",
                "file": str(svg_path),
                "ops": [
                    {"kind": "id", "loc": _loc(svg, "box"), "id": "hero", "from": "box"}
                ],
            },
            _deck(project),
        )
        assert _deck(project).slides[0].animations[0].element == "hero"

    def test_upload_reuses_identical_files(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        data = base64.b64encode(b"\x89PNG fake").decode()
        first = session.apply(
            {"action": "upload", "name": "My Pic.png", "data": data}, None
        )
        second = session.apply(
            {"action": "upload", "name": "My Pic.png", "data": data}, None
        )
        assert first["rel"] == second["rel"] == "assets/my-pic.png"
        with pytest.raises(EditError):
            session.apply({"action": "upload", "name": "x.exe", "data": data}, None)


# ── Model ────────────────────────────────────────────────────────────────────


def test_model_describes_slides_and_types(project: Path) -> None:
    deck = _deck(project)
    slides = process_deck(deck, project, project / "deck.py", editor=True)
    model = build_model(deck, project / "deck.py", slides)
    assert model["deckEditable"] is True
    entries = cast("list[dict[str, object]]", model["slides"])
    assert entries[0]["srcShared"] is False
    assert entries[1]["srcShared"] is True  # a layout used by two slides
    assert entries[1]["zoneText"] == {"title": "# Title", "content": "Body"}
    assert entries[2]["zoneText"] == {"title": "Hello"}
    sources = cast("list[dict[str, object]]", entries[0]["sources"])
    assert sources[0]["role"] == "slide" and sources[0]["writable"] is True
    types = [
        t["type"] for t in cast("list[dict[str, object]]", model["animationTypes"])
    ]
    assert "FadeIn" in types and "PlayVideo" in types
    assert "two" in [
        layout["name"] for layout in cast("list[dict[str, str]]", model["layouts"])
    ]


# ── Context for agents ───────────────────────────────────────────────────────


def test_context_round_trip_and_format(tmp_path: Path) -> None:
    write_context(
        tmp_path,
        {
            "slide": {
                "number": 2,
                "total": 5,
                "id": "intro",
                "title": "Intro",
                "svg": "slides/intro.svg",
                "deckIndex": 1,
            },
            "selection": [
                {
                    "id": "box",
                    "tag": "rect",
                    "file": "slides/intro.svg",
                    "box": {"x": 1, "y": 2, "width": 3, "height": 4},
                },
                {
                    "zone": "title",
                    "id": "zone-title",
                    "tag": "foreignObject",
                    "text": "Hello",
                },
            ],
        },
    )
    assert (tmp_path / ".inkflow" / ".gitignore").read_text() == "*\n"
    data = read_context(tmp_path)
    assert data is not None
    text = format_context(data)
    assert "slide 2/5: Intro (id: intro)" in text
    assert "<rect> #box in slides/intro.svg at (1, 2) size 3x4" in text
    assert "zone 'title' #zone-title" in text
    assert format_context(data, max_age=-1) == ""


def test_context_ignores_malformed_input(tmp_path: Path) -> None:
    write_context(tmp_path, "nope")
    assert read_context(tmp_path) is None
    (tmp_path / ".inkflow").mkdir(exist_ok=True)
    (tmp_path / ".inkflow" / "context.json").write_text("{not json")
    assert read_context(tmp_path) is None
    assert json.loads('{"a": 1}') == {"a": 1}
