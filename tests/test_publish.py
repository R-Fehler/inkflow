"""Publishing on GitHub Pages and GitLab Pages (publish.py): the CI files for
each kind of project, the address the slides get, refusing to overwrite, and
the CLI and editor entry points."""

from __future__ import annotations

from pathlib import Path

import pytest

from inkflow import init, publish
from inkflow.fonts import (
    _FontIndexKey,  # pyright: ignore[reportPrivateUsage]
    _FontRecord,  # pyright: ignore[reportPrivateUsage]
    _index_cache,  # pyright: ignore[reportPrivateUsage]
    font_sources,
)
from inkflow.pipeline import SlideData
from inkflow.server import load_deck


@pytest.fixture(autouse=True)
def _isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for who in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{who}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{who}_EMAIL", "test@example.com")


def _deck(folder: Path, *, pyproject: bool = True) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    init.scaffold(folder)
    if not pyproject:
        (folder / "pyproject.toml").unlink()
    return folder / "deck.py"


@pytest.mark.parametrize(
    ("url", "host", "path"),
    [
        ("https://github.com/Ada/talk.git", "github.com", ("Ada", "talk")),
        ("https://github.com/Ada/talk", "github.com", ("Ada", "talk")),
        ("git@github.com:Ada/talk.git", "github.com", ("Ada", "talk")),
        ("ssh://git@github.com/Ada/talk.git", "github.com", ("Ada", "talk")),
        (
            "https://user:token@gitlab.com/group/sub/talk.git",
            "gitlab.com",
            ("group", "sub", "talk"),
        ),
        (
            "ssh://git@gitlab.example.org:2222/team/talk.git",
            "gitlab.example.org",
            ("team", "talk"),
        ),
    ],
)
def test_parse_remote(url: str, host: str, path: tuple[str, ...]) -> None:
    remote = publish.parse_remote(url)
    assert remote is not None
    assert (remote.host, remote.path) == (host, path)


def test_parse_remote_rejects_what_is_no_hosted_repository() -> None:
    assert publish.parse_remote("/srv/git/talk.git") is None
    assert publish.parse_remote("https://github.com/talk") is None
    assert publish.parse_remote("file:///srv/git/a/b.git") is None


def test_web_address_keeps_an_https_port_only() -> None:
    https = publish.parse_remote("https://git.example.org:8443/team/talk.git")
    ssh = publish.parse_remote("ssh://git@git.example.org:2222/team/talk.git")
    assert https is not None and ssh is not None
    assert https.project_url == "https://git.example.org:8443/team/talk"
    assert ssh.project_url == "https://git.example.org/team/talk"


@pytest.mark.parametrize(
    ("host", "url", "pages", "settings"),
    [
        (
            "github",
            "git@github.com:Ada-L/talk.git",
            "https://ada-l.github.io/talk/",
            "https://github.com/Ada-L/talk/settings/pages",
        ),
        (
            "github",
            "https://github.com/Ada-L/ada-l.github.io.git",
            "https://ada-l.github.io/",
            "https://github.com/Ada-L/ada-l.github.io/settings/pages",
        ),
        (
            "gitlab",
            "git@gitlab.com:team/talk.git",
            "https://team.gitlab.io/talk/",
            "https://gitlab.com/team/talk/pages",
        ),
        (
            "gitlab",
            "https://gitlab.com/team/courses/2026/talk.git",
            "https://team.gitlab.io/courses/2026/talk/",
            "https://gitlab.com/team/courses/2026/talk/pages",
        ),
        (
            "gitlab",
            "https://gitlab.com/team/team.gitlab.io.git",
            "https://team.gitlab.io/",
            "https://gitlab.com/team/team.gitlab.io/pages",
        ),
        (
            "gitlab",
            "https://gitlab.example.org/team/talk.git",
            None,
            "https://gitlab.example.org/team/talk/pages",
        ),
        (
            "github",
            "https://github.example.com/team/talk.git",
            None,
            "https://github.example.com/team/talk/settings/pages",
        ),
    ],
)
def test_pages_address(
    host: publish.Host, url: str, pages: str | None, settings: str
) -> None:
    remote = publish.parse_remote(url)
    assert publish.pages_url(host, remote) == pages
    assert publish.settings_url(host, remote) == settings
    assert publish.host_of(remote) == host


def test_font_sources_name_the_file_or_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    font = tmp_path / "system" / "Inter.ttf"
    font.parent.mkdir()
    font.write_bytes(b"x")
    record = _FontRecord(path=font, family="Inter", weight_class=400, is_italic=False)
    monkeypatch.setitem(
        _index_cache, _FontIndexKey(tmp_path, None), {"inter": [record]}
    )
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg"><text font-family="Inter">a</text>'
        + '<text font-family="Nope, sans-serif">b</text></svg>'
    )
    slide: SlideData = {
        "svg": svg,
        "title": "",
        "id": "",
        "notes": "",
        "editableFiles": [],
    }
    assert font_sources([slide], tmp_path) == [("Inter", font), ("Nope", None)]


def test_font_warnings_name_fonts_only_this_computer_has(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    deck_path = _deck(tmp_path / "talk")
    project = deck_path.parent
    shipped = project / "fonts" / "Shipped.ttf"
    shipped.parent.mkdir()
    shipped.write_bytes(b"x")
    found: list[tuple[str, Path | None]] = [
        ("Shipped", shipped),
        ("Local Sans", tmp_path / "home" / ".fonts" / "Local.ttf"),
        ("Local Sans", shipped),
        ("Gone", None),
    ]

    def sources(*_args: object, **_kwargs: object) -> list[tuple[str, Path | None]]:
        return found

    monkeypatch.setattr("inkflow.fonts.font_sources", sources)
    warnings = publish.font_warnings(load_deck(deck_path), project, deck_path)
    assert len(warnings) == 2
    assert warnings[0].startswith('"Local Sans" is installed on this computer only')
    assert "fonts/" in warnings[0]
    assert warnings[1].startswith('"Gone" is not installed here either')
