"""The editor's part of test_backgrounds.py: the tests that need inkflow-editor."""

from __future__ import annotations

from inkflow import Image
from inkflow_editor.codegen import Code


def test_deck_source() -> None:
    assert (
        Code().call(Image("figures/plot.pdf", background="paper"))
        == 'Image("figures/plot.pdf", background="paper")'
    )
