# Extending inkflow

inkflow reads a deck, builds it, presents it, exports and checks it. A
**plugin** adds to that from outside: an installed Python package that adds
commands, checks and completions, and that inkflow finds without knowing what
it is (a word counter, a linter for a house style, commands for an agent, a
visual editor running in the deck's server).

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
    loaded = load_md(slide.md, project_dir) if slide.md is not None else None
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
| `slide_checks()` / `deck_checks()` | Lines of `inkflow verify`, per slide and once for the whole deck (`--no-deck-checks` skips those) |
| `server_extensions(config)` | Pages, messages and build steps on the deck's server (below) |
| `serve_options()` | Options of `inkflow serve`, read back as `config.options` |
| `completion_spec()` | Its commands in `inkflow completion carapace` |
| `current_slide(project_dir)` | The slide `inkflow render` shows when none is named |

A check that raises is reported as a warning line naming the plugin, not as
a crash of `verify`; a plugin whose commands fail to load is logged and
skipped. `INKFLOW_NO_PLUGINS=1` runs inkflow without any plugin.

## A server extension

The server `inkflow serve` runs builds the deck on every change, serves the
presenter and the deck's files on one port, and relays positions and ink
between windows over a WebSocket on that port (`/_inkflow/ws`). A `ServerExtension`
lives in it:

```python
import json

from inkflow.extensions import Build, HttpRequest, ServerContext, ServerExtension


class Outline(ServerExtension):
    """`/outline.json`: each slide's title."""

    name = "outline"

    def __init__(self) -> None:
        self.server: ServerContext | None = None
        self.outline: list[str] = []

    async def start(self, server: ServerContext) -> None:
        self.server = server

    def build(self, build: Build) -> None:  # in a worker thread, inside the build
        self.outline = [s["title"] for s in build.slides]

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
  state, who is connected and the door (`access`), `send`/`broadcast`/
  `send_owners`/`notify`, `rebuild` (`full=True`: keep nothing from earlier
  builds), `open_deck(path)` (serve another deck on the same port: this one
  is closed, open pages reconnect to the new one), `shutdown`, and
  `serve_connection`/`serve_request` for a page that reached it another way
  (through a relay, say), run exactly as one from the network, for its role;
- `open(deck_path)` / `close(switching=…)` for each deck served
  (`switching`: another deck follows);
- `before_build()` and `build(build)` in a worker thread, inside each build
  (raising fails the build); `built(build)` once the pages have the new
  slides; `build_failed(...)`. With `provenance = True` every element is
  stamped with `data-ink="<source>:<child path>"` and each slide carries its
  `edit` facts (the files it is drawn from, its empty zones, where each
  zone's content is written; `inkflow.provenance.locate` finds an element in
  its file again): what an editor needs to write a change back. The pages get
  the same slides without the `edit` facts (`build.served`, each with a
  `key`, a digest of its content). A served deck processes only the slides a
  change touched and keeps the others from the last build; `build.fresh`
  says nothing was kept (the first build, <kbd>r</kbd> in the terminal, or
  another deck), so an extension's own caches should start over too;
- `messages`: the WebSocket message types it handles, each with the least role
  that may send it (`"owner"`, `"editor"`, `"viewer"`); `message(...)` gets
  them, `hello(...)` tells it what each page is (`{"type": "hello", "role":
  "editor"}`), and again with `resync=True` when a page that missed a build
  asks for everything (`{"type": "resync"}`), `disconnected(...)` when it
  goes, `welcome(client)` adds fields to the first message a page gets (the
  presenter shows a "back to the editor" button, and takes <kbd>E</kbd> for
  it, when one names the editor's page: `{"editor": "/edit"}`);
- `http(request)` for every request the core does not answer itself (the
  deck's files come first, the presenter last);
- `home`: the page the owner opens instead of the presenter (an editor's
  `/edit`): where the owner link, the terminal's <kbd>o</kbd> and its SSH
  hint, an editor link, and another inkflow finding this server send them;
- `keys()`: keys in the server's terminal, shown on its help line;
- `share_status()`/`share_op(op, msg)`/`share_lines()`: its part of the
  owner's Share dialog (`{"type": "share", "op": …}` messages, answered with
  `share-status`) and of the terminal's share lines; `ServerContext.share_changed()`
  refreshes both.

Who may connect, and as whom, is the core's decision, made at the door before
any extension sees a request ([Sharing a served deck](../presenting/sharing.md)):
every request must name this machine (`Host`, against DNS rebinding), a
WebSocket must come from a page this server served (`Origin`, against
cross-site sockets), and then it is the **owner** (this machine; in SSH mode
the owner link), or an **editor** or **viewer** with a share link. A message
from a lesser role than an extension's `messages` names never reaches it, and
`HttpRequest.role`/`.token` say who asks for a page. The server offers editor
links only when an extension takes a message from editors. An `edit-op` no
extension takes is the core's: it answers only the presenter's ink "Keep"
(`action: "ink"`, from the owner or an editor link), writing the slide's ink
file itself; an extension that edits the deck takes `edit-op` in its
`messages` and makes ink one of its edits. Every page also may
ask `{"type": "build-status"}`: which deck.py the server built last
(`deckHash`), so a program that edited it can wait for its own edit to build.

A server may also run with **no deck** (`serve(None, ...)`), when an
extension says `serves_without_deck = True`: nothing is built or watched, its
`open` gets `None`, and its `http` answers every page (a start page that lists
decks, say) until it calls `open_deck`. Without such an extension, `serve`
refuses to start without a deck.

A page that says `{"type": "hello", "patch": true}` is sent each rebuild as
what changed: in an `update`'s `slides`, a slide the page already holds is its
`key` (a string) instead of the slide, and the deck's stylesheet (`styles`)
and colour mode (`mode`) come only when they changed. On `hello` it gets the
current slides by key; a key it does not hold means it missed a build, and it
sends `{"type": "resync"}` to get every slide whole. `src/ts/shared/patch.ts`
(`applyPatch`) puts the list together. A page that never says so is sent
whole lists.

## API

::: inkflow.plugins.Plugin

::: inkflow.extensions.ServerExtension

::: inkflow.extensions.ServerContext

::: inkflow.extensions.Build

::: inkflow.extensions.HttpRequest

::: inkflow.provenance
