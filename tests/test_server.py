from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import cast

import pytest

from inkflow.assets import AssetRoots
from inkflow.edit import EditCommands
from inkflow.enums import ColorMode
from inkflow.extensions import State
from inkflow.pipeline import EditableFile, SlideData
from inkflow.server import (
    _coerce_nav_position,  # pyright: ignore[reportPrivateUsage]
    _resolve_asset,  # pyright: ignore[reportPrivateUsage]
    _resolve_edit_request,  # pyright: ignore[reportPrivateUsage]
    _versioned,  # pyright: ignore[reportPrivateUsage]
    _WatchFilter,  # pyright: ignore[reportPrivateUsage]
    build_html,
)

_EMPTY_STATE: State = {
    "slides": [],
    "transitions": [],
    "ws_clients": set(),
    "error": None,
    "styles_css": "",
    "scripts_js": "",
    "mode": ColorMode.DARK,
    "position": {"slideIndex": 0, "step": 0},
    "logs": [],
    "title": "Inkflow",
    "theme_dir": None,
}


def _state(**overrides: object) -> State:
    return cast(State, {**_EMPTY_STATE, **overrides})  # pyright: ignore[reportInvalidCast]


# ── build_html ────────────────────────────────────────────────────────────────

_TOKENS = [
    "__CSS__",
    "__JS__",
    "__STYLES__",
    "__DATA_THEME__",
    "__SLIDES_JSON__",
    "__WS_PORT__",
    "__EDIT_COMMANDS_JSON__",
    "__ERROR_JSON__",
    "__TRANSITIONS_JSON__",
    "__LOGS_JSON__",
]


def test_build_html_no_tokens_remain() -> None:
    html = build_html(_state(), ws_port=7778).decode()
    for token in _TOKENS:
        assert token not in html, f"unreplaced token: {token}"


def test_build_html_returns_bytes() -> None:
    result = build_html(_state(), ws_port=7778)
    assert isinstance(result, bytes)
    assert result  # non-empty


def test_build_html_ws_port_embedded() -> None:
    html = build_html(_state(), ws_port=9001).decode()
    assert "9001" in html


def test_build_html_ws_port_null_when_none() -> None:
    html = build_html(_state(), ws_port=None).decode()
    assert "null" in html


def test_build_html_styles_css_embedded() -> None:
    html = build_html(
        _state(styles_css="body { color: hotpink; }"), ws_port=7778
    ).decode()
    assert "body { color: hotpink; }" in html


def test_build_html_dark_mode() -> None:
    dark = build_html(_state(mode=ColorMode.DARK), ws_port=7778).decode()
    light = build_html(_state(mode=ColorMode.LIGHT), ws_port=7778).decode()
    assert dark != light


def test_build_html_light_mode_data_theme() -> None:
    html = build_html(_state(mode=ColorMode.LIGHT), ws_port=7778).decode()
    assert "light" in html


def test_build_html_slides_json_embedded() -> None:
    html = build_html(
        _state(slides=["<svg>a</svg>", "<svg>b</svg>"]), ws_port=7778
    ).decode()
    assert json.dumps(["<svg>a</svg>", "<svg>b</svg>"]) in html


def test_build_html_error_json_embedded() -> None:
    html = build_html(_state(error="traceback goes here"), ws_port=7778).decode()
    assert "traceback goes here" in html


def test_build_html_null_error_when_no_error() -> None:
    html = build_html(_state(error=None), ws_port=7778).decode()
    assert "null" in html


def test_build_html_transitions_json_embedded() -> None:
    html = build_html(_state(transitions=[{"type": "fade"}]), ws_port=7778).decode()
    assert json.dumps([{"type": "fade"}]) in html


def test_build_html_edit_commands_default_both_false() -> None:
    html = build_html(_state(), ws_port=7778).decode()
    assert json.dumps({"default": False, "svg": False, "suffixes": []}) in html


def test_build_html_edit_commands_reflects_configured() -> None:
    html = build_html(
        _state(),
        ws_port=7778,
        edit_commands=EditCommands(svg="code {path}", default=None),
    ).decode()
    assert json.dumps({"default": False, "svg": True, "suffixes": ["svg"]}) in html


def test_build_html_logs_json_embedded() -> None:
    logs = [
        {"level": "warning", "message": 'font "Inter" not found in any font directory'}
    ]
    html = build_html(_state(logs=logs), ws_port=7778).decode()
    assert json.dumps(logs) in html


# ── _resolve_asset ────────────────────────────────────────────────────────────


def test_served_slides_name_each_asset_with_its_version(tmp_path: Path) -> None:
    import os

    (tmp_path / "assets").mkdir()
    picture = tmp_path / "assets" / "flow.svg"
    picture.write_text("<svg/>", encoding="utf-8")
    roots = AssetRoots(tmp_path)
    slide: SlideData = {
        "id": "s",
        "svg": '<svg><image href="assets/flow.svg"/>'
        + '<image href="missing.png"/><image href="https://x.org/a.png"/></svg>',
        "title": "",
        "notes": '<img src="assets/flow.svg">',
        "editableFiles": [],
    }
    first = _versioned(slide, roots)
    assert 'href="assets/flow.svg?v=' in first["svg"]
    assert 'href="missing.png"' in first["svg"]  # nothing to version
    assert 'href="https://x.org/a.png"' in first["svg"]
    assert 'src="assets/flow.svg?v=' in first["notes"]
    assert _versioned(slide, roots) == first  # same file, same slide
    # The file changes (Inkscape, GIMP): the slide changes with it.
    stat = picture.stat()
    os.utime(picture, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    assert _versioned(slide, roots)["svg"] != first["svg"]
    # The version is not part of the file's name when it is served.
    stamped = first["svg"].split('href="')[1].split('"')[0]
    assert _resolve_asset(roots, "/" + stamped) == picture.resolve()


def test_resolve_asset_path_traversal(tmp_path: Path) -> None:
    assert _resolve_asset(AssetRoots(tmp_path), "/../etc/passwd.png") is None


def test_resolve_asset_url_encoded_traversal(tmp_path: Path) -> None:
    assert _resolve_asset(AssetRoots(tmp_path), "/%2e%2e/etc/passwd.png") is None


def test_resolve_asset_disallowed_suffix(tmp_path: Path) -> None:
    (tmp_path / "secret.txt").write_bytes(b"secret")
    assert _resolve_asset(AssetRoots(tmp_path), "/secret.txt") is None


def test_resolve_asset_missing_file(tmp_path: Path) -> None:
    assert _resolve_asset(AssetRoots(tmp_path), "/nonexistent.png") is None


def test_resolve_asset_valid(tmp_path: Path) -> None:
    img = tmp_path / "slide.png"
    img.write_bytes(b"\x89PNG")
    result = _resolve_asset(AssetRoots(tmp_path), "/slide.png")
    assert result == img


def test_resolve_asset_theme_namespace(tmp_path: Path) -> None:
    # The canonical form the pipeline writes for a theme asset must resolve to the
    # theme, not to a project directory that happens to share the name.
    theme = tmp_path / "theme"
    theme.mkdir()
    logo = theme / "logo.png"
    logo.write_bytes(b"\x89PNG")
    project = tmp_path / "project"
    project.mkdir()
    roots = AssetRoots(project, theme)
    assert _resolve_asset(roots, "/_theme/logo.png") == logo


def test_resolve_asset_theme_traversal(tmp_path: Path) -> None:
    theme = tmp_path / "theme"
    theme.mkdir()
    project = tmp_path / "project"
    project.mkdir()
    roots = AssetRoots(project, theme)
    assert _resolve_asset(roots, "/_theme/../../etc/passwd.png") is None


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="creating symlinks needs Developer Mode/admin rights on Windows",
)
def test_resolve_asset_symlink_outside_project(tmp_path: Path) -> None:
    # A symlink inside project_dir that points outside it should be served.
    outside = tmp_path / "shared"
    outside.mkdir()
    real_img = outside / "photo.png"
    real_img.write_bytes(b"\x89PNG")
    project = tmp_path / "project"
    project.mkdir()
    (project / "photo.png").symlink_to(real_img)
    result = _resolve_asset(AssetRoots(project), "/photo.png")
    assert result == real_img.resolve()


# ── _coerce_nav_position ──────────────────────────────────────────────────────


def test_coerce_nav_non_numeric_index_is_dropped() -> None:
    assert _coerce_nav_position({"slideIndex": "x", "step": 0}, 5) is None


def test_coerce_nav_null_index_is_dropped() -> None:
    assert _coerce_nav_position({"slideIndex": None, "step": 0}, 5) is None


def test_coerce_nav_non_numeric_step_is_dropped() -> None:
    assert _coerce_nav_position({"slideIndex": 2, "step": "y"}, 5) is None


def test_coerce_nav_clamps_high_index() -> None:
    assert _coerce_nav_position({"slideIndex": 99, "step": 3}, 5) == {
        "slideIndex": 4,
        "step": 3,
    }


def test_coerce_nav_clamps_negative_index_and_step() -> None:
    assert _coerce_nav_position({"slideIndex": -2, "step": -1}, 5) == {
        "slideIndex": 0,
        "step": 0,
    }


def test_coerce_nav_empty_deck_pins_index_to_zero() -> None:
    assert _coerce_nav_position({"slideIndex": 2, "step": 1}, 0) == {
        "slideIndex": 0,
        "step": 1,
    }


def test_coerce_nav_defaults_when_fields_absent() -> None:
    assert _coerce_nav_position({}, 5) == {"slideIndex": 0, "step": 0}


# ── _resolve_edit_request ──────────────────────────────────────────────────────


def _slide_with_files(*files: EditableFile) -> SlideData:
    return {
        "id": "s",
        "svg": "",
        "title": "",
        "notes": "",
        "editableFiles": list(files),
    }


def test_resolve_edit_request_valid_path_and_configured_command() -> None:
    slides = [
        _slide_with_files(
            {"label": "Layout", "name": "slide.svg", "path": "/deck/slide.svg"}
        )
    ]
    commands = EditCommands(svg="code -r {path}", default=None)
    assert _resolve_edit_request({"path": "/deck/slide.svg"}, slides, commands) == (
        Path("/deck/slide.svg"),
        "code -r {path}",
    )


def test_resolve_edit_request_unknown_path_dropped() -> None:
    slides = [
        _slide_with_files(
            {"label": "Layout", "name": "slide.svg", "path": "/deck/slide.svg"}
        )
    ]
    commands = EditCommands(svg="code -r {path}", default=None)
    assert _resolve_edit_request({"path": "/etc/passwd"}, slides, commands) is None


def test_resolve_edit_request_missing_path_field_dropped() -> None:
    slides = [
        _slide_with_files(
            {"label": "Layout", "name": "slide.svg", "path": "/deck/slide.svg"}
        )
    ]
    commands = EditCommands(svg="code -r {path}", default=None)
    assert _resolve_edit_request({}, slides, commands) is None


def test_resolve_edit_request_no_command_configured_dropped() -> None:
    slides = [
        _slide_with_files(
            {"label": "Layout", "name": "slide.svg", "path": "/deck/slide.svg"}
        )
    ]
    commands = EditCommands(svg=None, default=None)
    assert _resolve_edit_request({"path": "/deck/slide.svg"}, slides, commands) is None


# ── File watcher ──────────────────────────────────────────────────────────────


def test_the_watcher_skips_what_inkflow_writes_below_the_deck(tmp_path: Path) -> None:
    from watchfiles import Change

    deck = tmp_path / ".inkflow" / "worktrees" / "talk"
    watch = _WatchFilter(deck)
    assert watch(Change.modified, str(deck / "slides" / "one.svg"))
    assert not watch(Change.modified, str(deck / ".inkflow" / "context.json"))
    assert not watch(Change.added, str(deck / "build" / "index.html"))
    # A deck living below some .inkflow/ folder is watched like any other.
    assert watch(Change.modified, str(deck / "deck.py"))


# ── Loading deck.py ───────────────────────────────────────────────────────────

_TITLED_DECK = """\
from inkflow import Deck, Slide


def main() -> Deck:
    return Deck(slides=[Slide("slides/{name}.svg")])
"""


def test_an_edit_keeping_size_and_time_is_loaded(tmp_path: Path) -> None:
    """deck.py is compiled from its source each time: the bytecode cache
    checks only the whole-second time and the size, which two slides
    swapped within a second both keep."""
    import os

    from inkflow.server import load_deck

    deck_py = tmp_path / "deck.py"
    deck_py.write_text(_TITLED_DECK.format(name="aaa"), encoding="utf-8")
    stamp = deck_py.stat()
    assert load_deck(deck_py).slides[0].src == "slides/aaa.svg"
    deck_py.write_text(_TITLED_DECK.format(name="bbb"), encoding="utf-8")
    os.utime(deck_py, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    assert load_deck(deck_py).slides[0].src == "slides/bbb.svg"


def test_another_deck_loads_as_a_module_of_its_own(tmp_path: Path) -> None:
    from inkflow.server import load_deck

    for name in ("one", "two"):
        (tmp_path / name).mkdir()
        (tmp_path / name / "deck.py").write_text(
            _TITLED_DECK.format(name=name), encoding="utf-8"
        )
    _ = load_deck(tmp_path / "one" / "deck.py")
    other = load_deck(tmp_path / "two" / "deck.py", module="_other_deck")
    assert other.slides[0].src == "slides/two.svg"
    assert "one" in str(sys.modules["_inkflow_deck"].__file__)
    assert "two" in str(sys.modules["_other_deck"].__file__)


def test_the_largest_message_is_the_most_an_extension_asks_for() -> None:
    from inkflow.extensions import ServerExtension
    from inkflow.server import DEFAULT_MAX_MESSAGE, max_message_size

    class Pastes(ServerExtension):
        name: str = "pastes"
        max_message_size: int | None = 80 * 2**20

    assert max_message_size([]) == DEFAULT_MAX_MESSAGE
    assert max_message_size([ServerExtension()]) == DEFAULT_MAX_MESSAGE
    assert max_message_size([ServerExtension(), Pastes()]) == 80 * 2**20
