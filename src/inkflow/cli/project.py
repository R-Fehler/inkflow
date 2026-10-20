from __future__ import annotations

import os
import re
import subprocess
import sys
from importlib.resources import files
from pathlib import Path

import click

from inkflow import git_setup, init, plugins, sync
from inkflow.cli._common import Project, main, resolve_dark_mode
from inkflow.logging import console, logger, report


def _sync_layout_previews(target: Path) -> None:
    """Inject layout layers + theme preview colors into the scaffolded SVGs.

    Done live, against the resolved deck (so a custom ``--theme`` picks the right
    ``base`` and colors), which keeps the packaged templates lean. Best-effort: the
    injected layers are only an editor aid, so a failure warns and moves on.
    """
    try:
        project = Project.load(target / "deck.py")
        dark_mode = resolve_dark_mode(None, project.deck, False)
        sync.sync_slides(
            [t.path for t in project.slide_targets()],
            project.preview_context(dark_mode),
        )
    except Exception as exc:
        logger.warning(f"could not inject layout previews: {exc}")
        return
    report("Synced", "layout previews for editing")


@main.command("init")
@click.argument("directory", default=".", type=click.Path(path_type=Path))
@click.option(
    "--no-git",
    "no_git",
    is_flag=True,
    help="Skip git hook setup even when inside a git repository.",
)
@click.option(
    "--force",
    "force",
    is_flag=True,
    help="Scaffold even into a non-empty directory.",
)
def init_cmd(directory: Path, no_git: bool, force: bool) -> None:
    """Scaffold a new presentation project in DIRECTORY (default: current).

    Writes a starter `deck.py`, slides, and a `pyproject.toml` declaring inkflow.
    For a new project (not already inside a git repository) it also runs `git init`,
    writes a `.gitignore`, and configures the SVG git hooks. Inside an existing
    repository it leaves git alone and points you at `setup-git`. Skip all git steps
    with `--no-git`.

    Refuses to scaffold into a non-empty directory (dotfiles like `.git` are ignored)
    unless `--force` is given.
    """
    target = directory.resolve()
    if (target / "deck.py").exists():
        raise click.ClickException(f"deck.py already exists: {target / 'deck.py'}")
    if target.exists() and not force:
        clutter = [p for p in target.iterdir() if not p.name.startswith(".")]
        if clutter:
            raise click.ClickException(
                f"directory {target} is not empty — run in a new directory "
                + "(inkflow init my-talk) or pass --force"
            )
    init.scaffold(target)
    report("Created", "slides/ (title.svg, diagram.svg, guide.md, diagram.md)")
    report("Created", "notes/ (title.md, guide.md, diagram.md)")
    report("Created", "deck.py")
    report("Created", "pyproject.toml")
    _sync_layout_previews(target)
    if not no_git:
        git_setup.init_project_git(target, verbose=False)
    rel = str(directory) if str(directory) not in (".", "./") else None
    suffix = f"cd {rel} && inkflow serve" if rel else "inkflow serve"
    console.print(f"\nrun:  {suffix}", markup=False)


_COMMAND_BLOCK = re.compile(r"(?=^  - name: )", re.M)


def carapace_spec() -> str:
    """The carapace spec: the core's (``completions/inkflow.yaml``) with each
    plugin's command blocks merged in (one named like a core command
    replaces it: a group the plugin adds subcommands to)."""
    text = files("inkflow").joinpath("completions/inkflow.yaml").read_text("utf-8")
    head, _, body = text.partition("\ncommands:\n")
    blocks: dict[str, str] = {}

    def add(chunk: str) -> None:
        for block in _COMMAND_BLOCK.split(chunk):
            name = re.match(r"  - name: (\S+)", block)
            if name is not None:
                blocks[name.group(1)] = block.rstrip("\n") + "\n"

    add(body)
    for plugin in plugins.loaded():
        extra = plugin.completion_spec()
        if extra:
            add(extra)
    return head + "\ncommands:\n" + "\n".join(blocks.values())


@main.command("completion")
@click.argument("shell", type=click.Choice(["bash", "zsh", "fish", "carapace"]))
def completion_cmd(shell: str) -> None:
    """Print shell completion script for SHELL.

    Add to your shell config:

    - bash: `eval "$(inkflow completion bash)"`
    - zsh: `eval "$(inkflow completion zsh)"`
    - fish: `inkflow completion fish | source`
    - carapace: `inkflow completion carapace > ~/.config/carapace/specs/inkflow.yaml`
    """
    if shell == "carapace":
        click.echo(carapace_spec(), nl=False)
        return

    env = {**os.environ, "_INKFLOW_COMPLETE": f"{shell}_source"}
    result = subprocess.run([sys.argv[0]], env=env, capture_output=True, text=True)
    click.echo(result.stdout, nl=False)


@main.command("setup-git")
def setup_git() -> None:
    """Configure git hooks and the SVG diff driver for the current repository.

    Run once per clone. Installs a pre-commit hook that strips Inkscape editor
    metadata from staged SVGs, and registers a diff driver so `git diff` and
    GitHub show only visual changes for SVGs. Both git-config entries are local to
    the clone (never committed).
    """
    try:
        root = git_setup.git_root()
        git_setup.run_git_setup(root, verbose=True)
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc
