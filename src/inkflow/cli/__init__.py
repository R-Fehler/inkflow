"""The ``inkflow`` command-line interface.

The command group lives in ``_common`` alongside the shared options and helpers;
the per-area submodules register their commands on it by import side effect.
Then every installed plugin (``inkflow.plugins``) adds its own. This module
wires them together and re-exports ``main`` as the console-script entry point
(``inkflow.cli:main``).
"""

from __future__ import annotations

from importlib import import_module

from inkflow import plugins
from inkflow.cli._common import main
from inkflow.cli.present import add_serve_options
from inkflow.logging import logger

# Import each submodule for its side effect: registering commands on ``main``.
for _submodule in ("authoring", "color", "present", "project", "verify"):
    import_module(f"inkflow.cli.{_submodule}")

for _plugin in plugins.loaded():
    try:
        _plugin.register_cli(main)
        add_serve_options(_plugin.serve_options())
    except Exception:
        logger.exception(f"plugin {_plugin.name!r}: its commands failed to load")

__all__ = ["main"]
