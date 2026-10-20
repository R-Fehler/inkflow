"""draw.io diagrams (*.drawio.svg): the source inside, stored uncompressed;
the editor's load/save; git's view of them; opening them elsewhere."""

from __future__ import annotations

import base64
import urllib.parse
import zlib
from pathlib import Path

import pytest
from click.testing import CliRunner

from inkflow import drawio
from inkflow.cli import main
from inkflow.edit import EditCommands, open_choices

MODEL = (
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
    + '<mxCell id="a" value="Client" vertex="1" parent="1">'
    + '<mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>'
    + "</root></mxGraphModel>"
)


def _compressed(model: str) -> str:
    deflate = zlib.compressobj(9, zlib.DEFLATED, -15)
    raw = deflate.compress(urllib.parse.quote(model).encode()) + deflate.flush()
    return base64.b64encode(raw).decode()


def _svg(mxfile: str, width: int = 200, height: int = 100) -> str:
    content = (
        mxfile.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}px" '
        + f'height="{height}px" viewBox="-0.5 -0.5 {width} {height}" '
        + f'content="{content}"><rect width="80" height="40"/></svg>'
    )


COMPRESSED = _svg(
    f'<mxfile host="test"><diagram id="p" name="Page-1">{_compressed(MODEL)}'
    + "</diagram></mxfile>"
)


def test_the_source_comes_out_uncompressed() -> None:
    data = COMPRESSED.encode()
    assert drawio.is_drawio_svg(data)
    assert not drawio.is_drawio_svg(b"<svg xmlns='http://www.w3.org/2000/svg'/>")
    source = drawio.source(data)
    assert 'value="Client"' in source and 'compressed="false"' in source
    stored = drawio.normalize(data).decode()
    assert "&lt;mxGraphModel&gt;" in stored  # readable in the file itself
    assert drawio.size(data) == (200.0, 100.0)
    # git's view: one tag a line
    text = drawio.textconv(data)
    assert '\n        <mxCell id="a" value="Client"' in text
    with pytest.raises(drawio.DrawioError, match=r"no draw\.io diagram"):
        drawio.normalize(b"<svg xmlns='http://www.w3.org/2000/svg'/>")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    deck = tmp_path / "deck"
    (deck / "slides").mkdir(parents=True)
    (deck / "deck.py").write_text("# deck\n", encoding="utf-8")
    (deck / "slides" / "s.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
        + '<image id="pic" href="../diagrams/flow.drawio.svg" x="100" y="100"'
        + ' width="400" height="200"/></svg>',
        encoding="utf-8",
    )
    return deck


def test_clean_leaves_diagrams_alone_and_diffs_show_the_source(
    project: Path,
) -> None:
    diagram = project / "flow.drawio.svg"
    diagram.write_text(COMPRESSED, encoding="utf-8")
    runner = CliRunner()
    result = runner.invoke(main, ["clean", str(diagram)])
    assert result.exit_code == 0 and diagram.read_text() == COMPRESSED
    result = runner.invoke(main, ["clean", "--stdout", str(diagram)])
    assert result.exit_code == 0 and "<mxfile" in result.output
    assert 'value="Client"' in result.output


def test_open_with_offers_draw_io(monkeypatch: pytest.MonkeyPatch) -> None:
    def which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name in ("drawio", "inkscape") else None

    monkeypatch.setattr("inkflow.edit.shutil.which", which)
    choices = open_choices(Path("flow.drawio.svg"), EditCommands(None, None))
    assert [c.id for c in choices][:2] == ["drawio", "inkscape"]
