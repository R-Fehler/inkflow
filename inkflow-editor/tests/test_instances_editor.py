"""The editor's part of test_instances.py: the tests that need inkflow-editor."""

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
from inkflow_editor.session import EditError, EditorSession


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


def test_opening_a_deck_another_server_has_goes_there(
    other_server: tuple[instances.Instance, Path],
) -> None:
    record, deck = other_server
    session = EditorSession(None)
    result = session.apply(
        {"action": "open-deck", "path": str(deck.parent), "_local": True}, None
    )
    assert result["redirect"] == record.url("/edit")
    assert result["opening"] is False and session.switch_to is None


def test_quit_is_local_only() -> None:
    session = EditorSession(None)
    with pytest.raises(EditError, match="this machine"):
        session.apply({"action": "quit"}, None)
    assert session.apply({"action": "quit", "_local": True}, None) == {"ok": True}
    assert session.quit_requested
