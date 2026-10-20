# Extending inkflow

inkflow reads a deck, builds it, presents it, exports and checks it. A
**plugin** adds to that from outside: an installed Python package that adds
commands, checks and completions, and that inkflow finds without knowing what
it is (a word counter, a linter for a house style, commands for an agent).

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
| `completion_spec()` | Its commands in `inkflow completion carapace` |

A check that raises is reported as a warning line naming the plugin, not as
a crash of `verify`; a plugin whose commands fail to load is logged and
skipped. `INKFLOW_NO_PLUGINS=1` runs inkflow without any plugin.

## API

::: inkflow.plugins.Plugin
