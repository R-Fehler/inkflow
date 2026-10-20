"""One server per deck: the registry of running servers (instances.py), and
a second ``inkflow serve`` of a deck pointing at the server that has it."""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from typing_extensions import override

from inkflow import instances


@pytest.fixture(autouse=True)
def _state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(instances, "_dir", lambda: tmp_path / "servers")


def _answering(pid: int, deck: str | None) -> Iterator[int]:
    """A stand-in server answering the instance probe; yields its port."""

    class Handler(BaseHTTPRequestHandler):
        @override
        def log_message(self, format: str, *args: object) -> None:
            pass

        def do_GET(self) -> None:
            body = json.dumps({"pid": pid, "deck": deck}).encode()
            self.send_response(200 if self.path == instances.PROBE_PATH else 404)
            self.end_headers()
            _ = self.wfile.write(body)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()


@pytest.fixture
def other_server(tmp_path: Path) -> Iterator[tuple[instances.Instance, Path]]:
    deck = tmp_path / "talk" / "deck.py"
    deck.parent.mkdir()
    deck.write_text("# deck\n", encoding="utf-8")
    pid = os.getpid() + 100000  # another process, as far as the registry knows
    for port in _answering(pid, str(deck.resolve())):
        record = instances.Instance(pid, "127.0.0.1", port, port + 1, str(deck))
        instances.register(record)
        yield record, deck


def test_a_deck_open_in_another_server_is_found(
    other_server: tuple[instances.Instance, Path], tmp_path: Path
) -> None:
    record, deck = other_server
    found = instances.serving(deck)
    assert found is not None and found.port == record.port
    assert found.url() == f"http://127.0.0.1:{record.port}/"
    assert instances.serving(deck, exclude_pid=record.pid) is None
    assert instances.serving(tmp_path / "other" / "deck.py") is None


def test_stale_records_are_dropped(tmp_path: Path) -> None:
    for port in _answering(4242, None):
        # The port answers, but as another process: not that server.
        instances.register(instances.Instance(1, "127.0.0.1", port, port + 1, None))
    instances.register(instances.Instance(2, "127.0.0.1", 1, 2, None))  # gone
    (tmp_path / "servers" / "junk.json").write_text("{", encoding="utf-8")
    assert instances.running() == []
    assert list((tmp_path / "servers").iterdir()) == []


def test_serve_points_at_the_server_that_has_the_deck(
    other_server: tuple[instances.Instance, Path],
) -> None:
    from click.testing import CliRunner

    from inkflow.cli import main

    record, deck = other_server
    result = CliRunner().invoke(main, ["serve", "--deck", str(deck)])
    assert result.exit_code == 0, result.output
    assert "Already open" in result.output
    assert f"http://127.0.0.1:{record.port}/" in result.output


def test_a_record_is_this_users_alone(tmp_path: Path) -> None:
    import stat

    instances.register(
        instances.Instance(7, "localhost", 7777, 7777, None, owner_token="secret")
    )
    folder = tmp_path / "servers"
    assert stat.S_IMODE(folder.stat().st_mode) == 0o700
    assert stat.S_IMODE((folder / "7.json").stat().st_mode) == 0o600
    record = instances.Instance(7, "localhost", 7777, 7777, None, owner_token="t+k")
    assert record.owner_url("/") == "http://localhost:7777/?k=t%2Bk"
    assert record.ws_url() == "ws://localhost:7777/_inkflow/ws?k=t%2Bk"
    assert record.url() == "http://localhost:7777/"  # never the token
    assert record.cookie() == "inkflow-owner-7777=t+k"
    instances.unregister(7)
    assert not (folder / "7.json").exists()
