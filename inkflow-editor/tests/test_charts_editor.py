"""The editor's part of test_charts.py: the tests that need inkflow-editor."""

from __future__ import annotations

import logging
import textwrap
from pathlib import Path

import pytest

from inkflow.assets import AssetRoots, AssetSource
from inkflow.charts import (
    ChartError,
    Table,
    parse_delimited,
    parse_fence,
    resolve,
)
from inkflow.enums import ChartKind
from inkflow.logging import collect_logs
from inkflow.manifest import Chart, Deck, Slide
from inkflow.pipeline import process_deck
from inkflow.server import load_deck
from inkflow.svgio import parse_svg
from inkflow_editor.codegen import Code

SVG_NS = "http://www.w3.org/2000/svg"


SALES = "quarter,revenue,cost\nQ1,120,80\nQ2,150,95\nQ3,,110\nQ4,210,130\n"


def _table() -> Table:
    return parse_delimited(SALES)


class TestChartDsl:
    def test_needs_exactly_one_source(self) -> None:
        with pytest.raises(ValueError, match="exactly one"):
            Chart()
        with pytest.raises(ValueError, match="exactly one"):
            Chart("a.csv", data={"a": [1]})

    def test_strings_are_accepted(self) -> None:
        chart = Chart("a.csv", kind="line", y="b")  # pyright: ignore[reportArgumentType]
        assert chart.kind is ChartKind.LINE
        assert chart.y == ["b"]

    def test_codegen_round_trip(self) -> None:
        chart = Chart(
            "data/sales.csv",
            kind=ChartKind.LINE,
            y=["revenue", "cost"],
            title="Sales",
            labels=True,
        )
        code = Code()
        source = code.call(chart)
        assert source == (
            'Chart("data/sales.csv", kind=ChartKind.LINE, y=["revenue", "cost"], '
            + 'title="Sales", labels=True)'
        )
        assert code.imports == {"Chart", "ChartKind"}
        assert eval(source, {"Chart": Chart, "ChartKind": ChartKind}) == chart
        inline = Chart(data={"a": ["x", "y"], "b": [1, 2.5]})
        inline_code = Code().call(inline)
        assert inline_code == 'Chart(data={"a": ["x", "y"], "b": [1, 2.5]})'
        assert eval(inline_code, {"Chart": Chart}) == inline

    def test_resolve_against_the_file_written_in(self, tmp_path: Path) -> None:
        (tmp_path / "data").mkdir()
        (tmp_path / "data" / "s.csv").write_text(SALES)
        roots = AssetRoots(tmp_path)
        resolved = resolve(Chart("data/s.csv"), AssetSource.for_deck(roots))
        assert resolved.table == _table()
        md = AssetSource.for_file(roots, tmp_path / "slides" / "a.md")
        assert resolve(Chart("../data/s.csv"), md).table == _table()
        with collect_logs(logging.WARNING) as logs:
            missing = resolve(Chart("data/none.csv"), AssetSource.for_deck(roots))
        assert missing.table is None and missing.error is not None
        assert any("none.csv" in r.message for r in logs)
        remote = resolve(Chart("https://x/a.csv"), AssetSource.for_deck(roots))
        assert remote.table is None


FENCE = textwrap.dedent("""\
    # Numbers

    ```chart
    kind: pie
    donut: true
    title: Where & why
    id: share
    | os | share |
    |----|-------|
    | Linux | 48 |
    | macOS | 52 |
    ```
""")


LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="800" height="700"/>
      <rect id="zone-sales" x="1000" y="200" width="840" height="700"/>
    </svg>
""")


DECK = textwrap.dedent("""\
    from inkflow import Chart, Deck, Slide, animations


    def main() -> Deck:
        return Deck(
            slides=[
                Slide(
                    "two",
                    md="slides/a.md",
                    zones={"sales": Chart("data/sales.csv", title="Sales")},
                    animations=[animations.FadeIn("sales-series-revenue")],
                ),
            ],
        )
""")


class TestPipeline:
    @pytest.fixture
    def project(self, tmp_path: Path) -> Path:
        for d in ("layouts", "slides", "data"):
            (tmp_path / d).mkdir()
        (tmp_path / "layouts" / "two.svg").write_text(LAYOUT)
        (tmp_path / "slides" / "a.md").write_text(
            FENCE.replace(
                "| os | share |\n|----|-------|\n| Linux | 48 |\n| macOS | 52 |\n",
                "data: ../data/share.csv\n",
            )
        )
        (tmp_path / "data" / "sales.csv").write_text(SALES)
        (tmp_path / "data" / "share.csv").write_text("os,share\nLinux,48\nmacOS,52\n")
        (tmp_path / "deck.py").write_text(DECK)
        return tmp_path

    def test_zone_and_fence_charts(self, project: Path) -> None:
        deck = load_deck(project / "deck.py")
        slide = process_deck(deck, project, project / "deck.py")[0]
        root = parse_svg(slide["svg"])
        zone = root.find(".//*[@id='zone-sales']")
        assert zone is not None and zone.tag == f"{{{SVG_NS}}}svg"
        assert zone.get("x") == "1000" and zone.get("width") == "840"
        assert zone.get("viewBox") == "0 0 840 700"
        revenue = root.find(".//*[@id='sales-series-revenue']")
        assert revenue is not None and "fade-in" in revenue.get("data-cues", "")
        # The fence's chart is inline SVG inside the content zone's HTML, in
        # the SVG namespace (lxml must not drop its xmlns on the way).
        share = root.find(f".//{{{SVG_NS}}}svg[@id='share']")
        assert share is not None
        assert share.find(".//*[@id='share-slice-linux']") is not None

    def test_editor_build_keeps_provenance(self, project: Path) -> None:
        deck = load_deck(project / "deck.py")
        slide = process_deck(deck, project, project / "deck.py", editor=True)[0]
        root = parse_svg(slide["svg"])
        zone = root.find(".//*[@id='zone-sales']")
        assert zone is not None
        assert zone.get("data-ink") and zone.get("data-ink-tag") == "rect"
        assert slide.get("edit", {}).get("zoneOrigins", {}).get("sales") == "deck"

    def test_deck_built_in_python(self, tmp_path: Path) -> None:
        (tmp_path / "layouts").mkdir()
        (tmp_path / "layouts" / "two.svg").write_text(LAYOUT)
        deck = Deck(
            slides=[
                Slide(
                    "two",
                    zones={"sales": Chart(data={"q": ["a", "b"], "v": [1, 2]})},
                )
            ]
        )
        svg = process_deck(deck, tmp_path, tmp_path / "deck.py")[0]["svg"]
        assert 'id="sales-series-v"' in svg


def test_range_and_second_axis_in_a_fence_and_in_deck_source() -> None:
    fence = parse_fence(
        "kind: line\ndata: x.csv\ny-min: 0\ny_max: 300\ny2: rate\ny2_max: 1"
    )
    chart = fence.chart
    assert (chart.y_min, chart.y_max, chart.y2, chart.y2_max) == (0, 300, ["rate"], 1)
    with pytest.raises(ChartError, match="not a number"):
        parse_fence("data: x.csv\ny_min: low")
    assert (
        Code().call(Chart("data/x.csv", y_min=0.0, y2=["rate"]))
        == 'Chart("data/x.csv", y_min=0.0, y2=["rate"])'
    )
