"""A deck that looks the same everywhere: the building blocks.

A frontend's "pack the deck" command can put these together into one plan
(with copying in the files a deck names outside its folder, which needs a
reference-rewriting engine of its own); ``inkflow init`` uses them directly
for a new deck. What each part is for:

A ``git clone`` of a deck should build and look identical on any machine and
OS. What gets in the way, and what packing does about each:

- fonts found only among this computer's fonts: copied into ``fonts/``
  (``fontreport.plan_bundle``); missing fonts and stacks that start with a
  generic family cannot be fixed by copying, and are reported;
- files the deck names outside its folder, or through a symlink: copied in,
  every reference rewritten (by the frontend);
- no ``pyproject.toml`` pinning inkflow (and a pip-installed theme), no
  ``uv.lock``: written, and ``uv lock`` run when uv is installed;
- no line-ending rules (a Windows checkout would turn every SVG into CRLF),
  no SVG diff driver line, no Git LFS rules for media and fonts: added to the
  deck's ``.gitattributes`` (an ``# inkflow: lfs off`` opt-out is kept);
- PDF figures: each page converted once and committed beside its PDF
  (``pdf.committed_path``), so a clone needs no converter.

What remains machine-dependent afterwards is listed (`Item` with
``fixable=False``): pictures read from the web, emoji and formulas with no
font in the deck to draw them, the tools a build needs.
"""

from __future__ import annotations

import fnmatch
import importlib.metadata
import os
import re
import shutil
import subprocess
import sys
import tomllib
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, cast

from inkflow import fontreport, lfs
from inkflow.fontreport import BundlePlan
from inkflow.init import deck_requirements, write_pyproject_text

if TYPE_CHECKING:
    from inkflow.manifest import Deck
    from inkflow.themes import Theme


@dataclass(frozen=True)
class Item:
    """One way the deck depends on this machine."""

    key: str
    """``font``, ``missing-font``, ``generic-font``, ``asset``, ``pyproject``,
    ``lock``, ``eol``, ``lfs``, ``remote``, ``pdf``, ``emoji``, ``math``."""
    message: str
    """What is missing, in plain words."""
    consequence: str
    """What other machines will show or lack because of it."""
    fixable: bool
    """Whether packing takes it away."""

    def json(self) -> dict[str, object]:
        return {
            "key": self.key,
            "message": self.message,
            "consequence": self.consequence,
            "fixable": self.fixable,
        }


def show_path(path: Path, project_dir: Path) -> str:
    """``path`` as a project-relative POSIX path (``../x`` outside)."""
    try:
        return path.relative_to(project_dir).as_posix()
    except ValueError:
        return os.path.relpath(path, project_dir).replace(os.sep, "/")


# ── .gitattributes ──

EOL_EXTS = ("svg", "md", "py", "css", "csv", "json", "txt")
EOL_MARKER = "# inkflow: text sources with LF line endings on every OS"
DIFF_LINE = "*.svg diff=inkscape-svg"


def _git_root(deck_dir: Path) -> Path | None:
    """The repository the deck is in (None: none, or no git)."""
    if shutil.which("git") is None:
        return None
    probe = deck_dir
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=probe,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    root = out.stdout.strip()
    return Path(root) if out.returncode == 0 and root else None


def _attribute_lines(deck_dir: Path, root: Path | None) -> list[list[str]]:
    """Every rule line of the ``.gitattributes`` from the deck up to the
    repository root (just the deck's own outside a repository)."""
    lines: list[list[str]] = []
    folder = deck_dir.resolve()
    top = root.resolve() if root is not None else folder
    while True:
        attrs = folder / ".gitattributes"
        if attrs.is_file():
            for line in attrs.read_text(
                encoding="utf-8", errors="replace"
            ).splitlines():
                parts = line.split()
                if parts and not parts[0].startswith("#"):
                    lines.append(parts)
        if folder == top or folder == folder.parent:
            return lines
        folder = folder.parent


def _covers(lines: list[list[str]], pattern: str, attr: str) -> bool:
    return any(
        parts[0] in ("*", pattern) and attr in parts[1:] for parts in lines
    ) or any(
        parts[0] == pattern
        and attr.startswith("filter=")
        and any(a.startswith("filter=") for a in parts[1:])
        for parts in lines
    )


@dataclass
class AttributesPlan:
    text: str | None
    """New text of the deck's .gitattributes (None: nothing to add)."""
    eol: list[str]
    """Patterns that had no LF rule."""
    lfs: list[str]
    """LFS patterns added (``["*"]``: the whole section)."""
    diff: bool


def plan_attributes(deck_dir: Path) -> AttributesPlan:
    """What the deck's ``.gitattributes`` lacks: LF line endings for its text
    sources, the SVG diff driver, Git LFS for media and fonts (unless the deck
    opted out of LFS). Idempotent: lines already there are not added again."""
    root = _git_root(deck_dir)
    lines = _attribute_lines(deck_dir, root)
    eol = [f"*.{e}" for e in EOL_EXTS if not _covers(lines, f"*.{e}", "eol=lf")]
    diff = not _covers(lines, "*.svg", "diff=inkscape-svg")
    mode = lfs.mode(root or deck_dir, deck_dir)
    add_lfs: list[str] = []
    if mode == "none":
        add_lfs = ["*"]
    elif mode == "on":
        add_lfs = [
            f"*.{ext}"
            for ext in lfs.PATTERNS["font"]
            if not _covers(lines, f"*.{ext}", "filter=lfs")
        ]
    path = deck_dir / ".gitattributes"
    current = path.read_text(encoding="utf-8") if path.is_file() else ""
    blocks: list[str] = []
    if eol:
        blocks.append("\n".join([EOL_MARKER, *(f"{p} text eol=lf" for p in eol)]))
    if diff:
        blocks.append(DIFF_LINE)
    if add_lfs == ["*"]:
        blocks.append(lfs.block(True).rstrip("\n"))
    elif add_lfs:
        blocks.append("\n".join(lfs.rule(p) for p in add_lfs))
    if not blocks:
        return AttributesPlan(None, [], [], False)
    text = current.rstrip("\n")
    text = (text + "\n\n" if text else "") + "\n\n".join(blocks) + "\n"
    return AttributesPlan(text, eol, add_lfs, diff)


# ── pyproject.toml and uv.lock ──


def find_pyproject(deck_dir: Path) -> Path | None:
    """The ``pyproject.toml`` that ``uv run`` in the deck folder uses: the
    nearest one up to the repository root."""
    root = _git_root(deck_dir)
    folder = deck_dir.resolve()
    top = root.resolve() if root is not None else None
    while True:
        candidate = folder / "pyproject.toml"
        if candidate.is_file():
            return candidate
        if folder == top or folder == folder.parent or top is None:
            return None
        folder = folder.parent


def theme_requirement(theme: Theme, deck_dir: Path) -> str | None:
    """A pip-installed theme's distribution pinned like inkflow (``~=``), or
    None for inkflow's own theme or one that lives with the deck."""
    module = type(theme).__module__
    top = module.split(".")[0]
    if top == "inkflow":
        return None
    file = cast("str | None", getattr(sys.modules.get(module), "__file__", None))
    if file is None or Path(file).resolve().is_relative_to(deck_dir.resolve()):
        return None
    names = importlib.metadata.packages_distributions().get(top) or []
    if not names:
        return None
    name = names[0]
    try:
        raw = importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return name
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)", raw)
    return f"{name}~={m.group(1)}.{m.group(2)}.{m.group(3)}" if m else f"{name}>={raw}"


_REQ_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")


def _req_name(requirement: str) -> str:
    m = _REQ_NAME.match(requirement)
    return re.sub(r"[-_.]+", "-", m.group(1)).lower() if m else ""


@dataclass
class ProjectPlan:
    path: Path
    text: str | None
    """New text (None: it pins what it should)."""
    added: list[str]


def plan_pyproject(deck: Deck, deck_dir: Path) -> ProjectPlan:
    """The ``pyproject.toml`` pinning inkflow, the installed plugins and the
    deck's theme: the nearest one (inkflow's own project counts as pinning
    it), else a new one in the deck's folder."""
    wanted = deck_requirements()
    theme = theme_requirement(deck.theme, deck_dir)
    if theme:
        wanted.append(theme)
    path = find_pyproject(deck_dir)
    if path is None:
        path = deck_dir / "pyproject.toml"
        return ProjectPlan(path, write_pyproject_text(deck_dir, wanted), wanted)
    text = path.read_text(encoding="utf-8")
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return ProjectPlan(path, None, [])
    project = cast("dict[str, object]", data.get("project") or {})
    deps = project.get("dependencies")
    present = {
        _req_name(str(d))
        for d in cast("list[object]", deps if isinstance(deps, list) else [])
    }
    present.add(_req_name(str(project.get("name") or "")))
    missing = [r for r in wanted if _req_name(r) not in present]
    if not missing:
        return ProjectPlan(path, None, [])
    lines = "".join(f'    "{r}",\n' for r in missing)
    m = re.search(r"(?m)^dependencies\s*=\s*\[[ \t]*\n?", text)
    if m:
        new = text[: m.end()] + ("" if text[m.end() - 1] == "\n" else "\n") + lines
        new += text[m.end() :]
    else:
        header = re.search(r"(?m)^\[project\][ \t]*\n", text)
        block = "dependencies = [\n" + lines + "]\n"
        if header:
            new = text[: header.end()] + block + text[header.end() :]
        else:
            new = text.rstrip("\n") + "\n\n[project]\n" + block
    return ProjectPlan(path, new, missing)


def uv_available() -> bool:
    return shutil.which("uv") is not None


def run_uv_lock(project_dir: Path, timeout: float = 180) -> tuple[bool, str]:
    """``uv lock`` in ``project_dir``: (worked, what it said)."""
    uv = shutil.which("uv")
    if uv is None:
        return (
            False,
            "uv is not installed: run `uv lock` where it is (docs.astral.sh/uv)",
        )
    try:
        done = subprocess.run(
            [uv, "lock"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"uv lock failed: {exc}"
    if done.returncode != 0:
        last = (done.stderr or done.stdout).strip().splitlines()[-1:]
        return False, "uv lock failed" + (f": {last[0]}" if last else "") + (
            " (offline? run it again with a network)"
        )
    return True, "uv.lock written"


# ── New decks start self-contained ──


def ensure_text_rules(deck_dir: Path) -> bool:
    """The LF line-ending rules and the SVG diff driver line in the deck's
    ``.gitattributes`` (Git LFS rules are ``git_setup.setup_lfs``'s, which
    honours ``--no-lfs``). True when the file changed."""
    root = _git_root(deck_dir)
    lines = _attribute_lines(deck_dir, root)
    eol = [f"*.{e}" for e in EOL_EXTS if not _covers(lines, f"*.{e}", "eol=lf")]
    diff = not _covers(lines, "*.svg", "diff=inkscape-svg")
    if not eol and not diff:
        return False
    path = deck_dir / ".gitattributes"
    current = path.read_text(encoding="utf-8") if path.is_file() else ""
    blocks: list[str] = []
    if eol:
        blocks.append("\n".join([EOL_MARKER, *(f"{p} text eol=lf" for p in eol)]))
    if diff:
        blocks.append(DIFF_LINE)
    text = current.rstrip("\n")
    text = (text + "\n\n" if text else "") + "\n\n".join(blocks) + "\n"
    path.write_text(text, encoding="utf-8")
    return True


def bundle_fonts_now(deck: Deck, deck_dir: Path) -> BundlePlan:
    """Copy the fonts a new deck's look names that only this machine has into
    its ``fonts/`` (plain copies: a new deck has no editing history)."""
    report = fontreport.font_report(deck, deck_dir)
    plan = fontreport.plan_bundle(report, deck_dir)
    for copy in plan.copies:
        copy.dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(copy.src, copy.dst)
    for path, text in plan.texts.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    if plan.readme is not None:
        (deck_dir / "fonts").mkdir(exist_ok=True)
        (deck_dir / "fonts" / "README.md").write_text(plan.readme, encoding="utf-8")
    return plan


def lock_new_deck(deck_dir: Path) -> tuple[bool, str]:
    """``uv lock`` for a new deck when uv is installed; offline (or any other
    failure) is a note, never an error."""
    if not uv_available():
        return False, "uv is not installed: run `uv lock` later to pin versions"
    return run_uv_lock(deck_dir, timeout=60)


def tools_needed() -> list[str]:
    """What a machine needs to build the deck beyond inkflow (for the report)."""
    return [
        "`inkflow export` (PDF) needs Chromium or Chrome; `inkflow build` does not",
        "ffmpeg is never needed to build",
    ]


# ── Zip ──

_ZIP_SKIP_DIRS = frozenset(
    {".git", ".inkflow", "build", "__pycache__", "node_modules", ".venv", "venv"}
)
LFS_POINTER = b"version https://git-lfs.github.com/spec/v1"


def zip_files(deck_dir: Path) -> list[Path]:
    """The deck's source files, as git would hand them over: tracked and
    untracked files not ignored (``.gitignore``), without ``.inkflow/`` and
    build output."""
    deck_dir = deck_dir.resolve()
    root = _git_root(deck_dir)
    found: list[Path] = []
    if root is not None:
        try:
            out = subprocess.run(
                ["git", "ls-files", "-z", "-c", "-o", "--exclude-standard", "--", "."],
                cwd=deck_dir,
                capture_output=True,
                check=True,
            ).stdout
            found = [deck_dir / p for p in out.decode().split("\0") if p]
        except (OSError, subprocess.CalledProcessError):
            root = None
    if root is None:
        ignore = _ignore_patterns(deck_dir)
        for folder, dirs, files in os.walk(deck_dir):
            here = Path(folder)
            dirs[:] = sorted(
                d
                for d in dirs
                if d not in _ZIP_SKIP_DIRS
                and not (here / d / "pyvenv.cfg").exists()
                and not _ignored(here / d, deck_dir, ignore, True)
            )
            found += [
                here / f
                for f in sorted(files)
                if not _ignored(here / f, deck_dir, ignore, False)
            ]
    return [
        p
        for p in found
        if p.is_file()
        and not set(p.relative_to(deck_dir).parts[:-1]) & _ZIP_SKIP_DIRS
        and p.relative_to(deck_dir).parts[0] not in _ZIP_SKIP_DIRS
    ]


def _ignore_patterns(deck_dir: Path) -> list[str]:
    path = deck_dir / ".gitignore"
    if not path.is_file():
        return []
    return [
        line.strip()
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines()
        if line.strip() and not line.startswith("#") and not line.startswith("!")
    ]


def _ignored(path: Path, root: Path, patterns: list[str], is_dir: bool) -> bool:
    rel = path.relative_to(root).as_posix()
    for pattern in patterns:
        dir_only = pattern.endswith("/")
        p = pattern.rstrip("/")
        if dir_only and not is_dir:
            continue
        if p.startswith("/"):
            if fnmatch.fnmatch(rel, p[1:]):
                return True
        elif fnmatch.fnmatch(path.name, p) or fnmatch.fnmatch(rel, p):
            return True
    return False


def _real_content(path: Path) -> bytes:
    """The file's bytes; an LFS pointer not checked out is fetched through
    ``git lfs smudge`` when it can be (else the pointer goes in)."""
    data = path.read_bytes()
    if not data.startswith(LFS_POINTER) or len(data) > 1024:
        return data
    try:
        done = subprocess.run(
            ["git", "lfs", "smudge", "--", path.name],
            cwd=path.parent,
            input=data,
            capture_output=True,
            timeout=300,
        )
    except (OSError, subprocess.TimeoutExpired):
        return data
    return done.stdout if done.returncode == 0 and done.stdout else data


def make_zip(deck_dir: Path, out: Path) -> list[str]:
    """A zip of the deck's source tree for someone without git; returns the
    archived names. The archive itself is left out."""
    deck_dir = deck_dir.resolve()
    out = out.resolve()
    names: list[str] = []
    top = deck_dir.name
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in zip_files(deck_dir):
            if path.resolve() == out:
                continue
            name = f"{top}/{path.relative_to(deck_dir).as_posix()}"
            archive.writestr(name, _real_content(path))
            names.append(name)
    return names
