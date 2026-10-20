"""The editor's part of test_drawio_inline.py: the tests that need inkflow-editor."""

from __future__ import annotations

from pathlib import Path

MXFILE = (
    '&lt;mxfile compressed="false"&gt;&lt;diagram id="p"&gt;'
    + "&lt;mxGraphModel&gt;&lt;root&gt;"
    + '&lt;mxCell id="0"/&gt;&lt;mxCell id="1" parent="0"/&gt;'
    + '&lt;mxCell id="client" vertex="1" parent="1"/&gt;'
    + '&lt;UserObject id="note" label="code"&gt;'
    + '&lt;mxCell vertex="1" parent="1"/&gt;&lt;/UserObject&gt;'
    + '&lt;mxCell id="e1" edge="1" parent="1" source="client" target="note"/&gt;'
    + '&lt;mxCell id="e1-label" vertex="1" parent="e1"/&gt;'
    + "&lt;/root&gt;&lt;/mxGraphModel&gt;&lt;/diagram&gt;&lt;/mxfile&gt;"
)


DIAGRAM = (
    '<svg xmlns="http://www.w3.org/2000/svg" style="color-scheme: light dark;"'
    + ' width="442px" height="202px" viewBox="0 0 442 202" id="ge-svg-x"'
    + f' content="{MXFILE.replace(chr(34), "&quot;")}">'
    + "<style>#ge-svg-x { --ge-adaptive-bg: light-dark(#ffffff, #121212); }</style>"
    + '<defs><linearGradient id="grad"/></defs>'
    + '<g data-cell-id="0"><g data-cell-id="1">'
    + '<g data-cell-id="client"><rect width="160" height="70" fill="#dae8fc"'
    + ' stroke="#6c8ebf" style="fill: light-dark(rgb(218, 232, 252), rgb(29, 41, 59));'
    + ' stroke: light-dark(rgb(108, 142, 191), rgb(92, 121, 163));"/>'
    + '<switch><foreignObject width="100%" height="100%">'
    + '<div xmlns="http://www.w3.org/1999/xhtml" style="font-family: Helvetica;'
    + ' color: light-dark(#000000, #ffffff);">Client</div></foreignObject>'
    + '<text font-family="Helvetica" fill="#000000">Client</text></switch></g>'
    + '<g data-cell-id="note"><rect width="100" height="40" fill="url(#grad)"/>'
    + '<text font-family="Courier New" fill="#ffffff">code</text></g>'
    + "</g></g></svg>"
)


def _project(tmp_path: Path) -> Path:
    (tmp_path / "diagrams").mkdir()
    (tmp_path / "diagrams" / "flow.drawio.svg").write_text(DIAGRAM, encoding="utf-8")
    return tmp_path


def test_renaming_a_diagram_keeps_its_shapes_arrows_and_animations(
    tmp_path: Path,
) -> None:
    from inkflow.deps import file_hash
    from inkflow.provenance import child_path
    from inkflow_editor.session import EditorSession
    from inkflow_editor.svgops import SvgFile

    project = _project(tmp_path)
    (project / "slides").mkdir()
    slide = project / "slides" / "s.svg"
    slide.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"'
        + ' viewBox="0 0 1920 1080"><image id="flow" inkflow:drawio="inline"'
        + ' href="../diagrams/flow.drawio.svg" width="442" height="202"/>'
        + '<path id="a" d="M0 0L1 1" inkflow:connector="straight"'
        + ' inkflow:connect-start="flow:left" inkflow:connect-end="flow-client:top"/>'
        + "</svg>",
        encoding="utf-8",
    )
    (project / "deck.py").write_text(
        "from inkflow import Deck, Slide, animations\n\n\n"
        + "def main() -> Deck:\n"
        + "    return Deck(\n"
        + "        slides=[\n"
        + "            Slide(\n"
        + '                "slides/s.svg",\n'
        + '                animations=[animations.FadeIn("flow-client")],\n'
        + "            ),\n"
        + "        ],\n"
        + "    )\n",
        encoding="utf-8",
    )
    session = EditorSession(project / "deck.py")
    svg = SvgFile.from_bytes(slide, slide.read_bytes())
    image = svg.root.find(".//*[@id='flow']")
    assert image is not None
    from inkflow.server import load_deck

    result = session.apply(
        {
            "action": "svg",
            "file": str(slide),
            "hash": file_hash(slide.read_bytes()),
            "ops": [
                {
                    "kind": "id",
                    "loc": f"0:{child_path(image)}",
                    "id": "chart",
                    "from": "flow",
                }
            ],
        },
        load_deck(project / "deck.py"),
    )
    assert result["ok"]
    text = slide.read_text()
    assert 'inkflow:connect-start="chart:left"' in text
    assert 'inkflow:connect-end="chart-client:top"' in text
    assert 'FadeIn("chart-client")' in (project / "deck.py").read_text()
