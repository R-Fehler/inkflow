# Extending inkflow

inkflow is the core: it reads a deck, builds it, presents it, exports and
checks it, and serves it with live reload. Everything else, the visual editor
included, is built on top of it as a **plugin**: an installed Python package
that adds commands, checks and server extensions, and that inkflow finds
without knowing what it is. [inkflow-editor](../editor/index.md) is one; this
page is for writing another (a remote control, a review tool, an editor for
another kind of device).

## A plugin

A plugin is a `Plugin` named under the `inkflow.plugins` entry point of its
package:

```toml
# pyproject.toml of your package
[project]
name = "inkflow-wordcount"
dependencies = ["inkflow"]

[project.entry-points."inkflow.plugins"]
wordcount = "inkflow_wordcount:plugin"
```

Every method has a do-nothing default, so a plugin overrides what it adds:

```python
# inkflow_wordcount/__init__.py
from pathlib import Path

import click

from inkflow.loaders import load_md
from inkflow.manifest import Deck, Slide
from inkflow.plugins import Issue, Plugin


def too_wordy(slide: Slide, project_dir: Path, deck: Deck | None) -> list[Issue]:
    """An `inkflow verify` line for slides with long Markdown."""
    loaded = load_md(slide.md, project_dir)
    words = len(loaded.text.split()) if loaded is not None else 0
    return [("warn", f"{words} words: split it?")] if words > 120 else []


class WordCount(Plugin):
    name = "wordcount"

    def register_cli(self, main: click.Group) -> None:
        @main.command("words")
        def words() -> None:
            """Count the words on every slide."""
            ...

    def slide_checks(self):
        return (too_wordy,)


plugin = WordCount()
```

What a plugin can add:

| Method | Where it shows |
|---|---|
| `register_cli(main)` | Commands on `inkflow` (or subcommands on one of its groups) |
| `slide_checks()` / `deck_checks()` | Lines of `inkflow verify`, per slide and for the whole deck |
| `server_extensions(config)` | Pages, messages and build steps on the deck's server (below) |
| `serve_options()` | Options of `inkflow serve`, read back as `config.options` |
| `completion_spec()` | Its commands in `inkflow completion carapace` |
| `requirement()` | Pinned beside inkflow in a new deck's `pyproject.toml` (`init`, `pack`), so its commands work in a clone |
| `current_slide(project_dir)` | The slide `inkflow render` shows when none is named |

`INKFLOW_NO_PLUGINS=1` runs inkflow without any plugin.

## A server extension

The server `inkflow serve` runs builds the deck on every change, serves the
presenter and the deck's files on one port, and relays positions and ink
between windows over a WebSocket (`/_inkflow/ws`). A `ServerExtension` lives
in it:

```python
import json

from inkflow.extensions import Build, HttpRequest, ServerContext, ServerExtension


class Outline(ServerExtension):
    """`/outline.json`: each slide's id and the files it is drawn from."""

    name = "outline"
    provenance = True  # build with source locators and each slide's edit facts

    def __init__(self) -> None:
        self.server: ServerContext | None = None
        self.outline: list[dict[str, object]] = []

    async def start(self, server: ServerContext) -> None:
        self.server = server

    def build(self, build: Build) -> None:  # in a worker thread, inside the build
        self.outline = [
            {"id": s["id"], "sources": s["edit"]["sources"]} for s in build.slides
        ]

    async def http(self, request: HttpRequest) -> bool:
        if request.path != "/outline.json":
            return False
        body = json.dumps(self.outline).encode()
        await request.respond("200 OK", body, "application/json", b"")
        return True
```

A plugin hands it to the server from `server_extensions(config)` (or a command
of its own passes `extensions=[...]` to `inkflow.server.serve`). The hooks, in
the order they happen:

- `start(server)` once, with the `ServerContext` to act through: the served
  state, who is connected and the door, `send`/`broadcast`/`notify`, `rebuild`,
  `open_deck` (serve another deck on the same port), `shutdown`, and
  `serve_connection`/`serve_request` for a page that reached it another way
  (through a relay, say);
- `open(deck_path)` / `close(switching=…)` for each deck served;
- `before_build()` and `build(build)` in a worker thread, inside each build
  (raising fails the build); `built(build)` once the pages have the new
  slides; `build_failed(...)`. With `provenance = True` every element is
  stamped with `data-ink="<source>:<child path>"` and each slide carries its
  `edit` facts (`inkflow.provenance.locate` finds the element in its file
  again): what an editor needs to write a change back;
- `messages`: the WebSocket message types it handles, each with the least role
  that may send it (`"owner"`, `"editor"`, `"viewer"`); `message(...)` gets
  them, `hello(...)` tells it what each page is, `disconnected(...)` when it
  goes, `welcome(client)` adds fields to the first message a page gets (the
  presenter's "back to the editor" button appears when one says
  `{"editor": "/edit"}`);
- `http(request)` for every request the core does not answer itself (the
  presenter, the handout, fonts and the deck's files come first);
- `home`: the page the owner link and the terminal point to (an editor's
  `/edit`); `keys()`: keys in the server's terminal; `share_status`/`share_op`/
  `share_lines`: its part of the Share dialog and the terminal's share lines.

Who may connect, and as whom, is the core's decision: the owner (this
machine), or a share link's editor or viewer. An extension's message from a
lesser role never reaches it.

## In the browser

The presenter's client code is a library a frontend's bundle can import:
`src/ts/shared` in the repository (the step engine that plays animations,
shrink-to-fit, rebuilds as patches, ink, touch gestures, the socket to the
server). inkflow-editor imports it as `@inkflow/shared/*` through a
TypeScript path alias.

## API

::: inkflow.plugins.Plugin

::: inkflow.extensions.ServerExtension

::: inkflow.extensions.ServerContext

::: inkflow.extensions.Build

::: inkflow.extensions.HttpRequest
