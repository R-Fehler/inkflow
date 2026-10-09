"""Git for the editor: the everyday version-control operations behind its Git menu.

Everything shells out to the ``git`` binary in the deck's directory (``git -C``),
never prompting: ``GIT_TERMINAL_PROMPT=0`` makes a push that needs a password
fail with git's own message instead of hanging the server. Each operation
returns or raises; the session turns a ``GitError`` into the editor's error
toast with git's message.

The deck may be one folder of a larger repository, so "the deck's files" are
the paths under its directory: history is filtered to them, and discard /
restore only touch them. Commit and push work on the repository as a whole,
since that is what git does.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

MAX_LOG = 100
_TIMEOUT = 60


class GitError(Exception):
    pass


def available() -> bool:
    return shutil.which("git") is not None


def run(cwd: Path, *args: str, timeout: float = _TIMEOUT) -> str:
    """``git <args>`` in ``cwd``; its stdout, or a ``GitError`` with its message."""
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "",
        "LC_ALL": "C",
        # The editor never opens an editor: `revert --no-edit` and friends.
        "GIT_EDITOR": "true",
    }
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), *args],
            capture_output=True,
            text=True,
            env=env,
            timeout=timeout,
            stdin=subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        raise GitError("git is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git {args[0]} took too long and was stopped") from exc
    if result.returncode != 0:
        message = (result.stderr or result.stdout).strip()
        raise GitError(message or f"git {args[0]} failed")
    return result.stdout


def _try(cwd: Path, *args: str) -> str | None:
    try:
        return run(cwd, *args).strip()
    except GitError:
        return None


def repo_root(directory: Path) -> Path | None:
    """The repository ``directory`` is in, or None (also when git is missing)."""
    if not available():
        return None
    probe = directory
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    root = _try(probe, "rev-parse", "--show-toplevel")
    return Path(root) if root else None


@dataclass
class Repo:
    root: Path
    deck_dir: Path

    @property
    def scope(self) -> str:
        """The deck directory as a pathspec relative to the repository root."""
        rel = self.deck_dir.resolve().relative_to(self.root.resolve()).as_posix()
        return rel if rel != "." else ""

    def git(self, *args: str, timeout: float = _TIMEOUT) -> str:
        return run(self.root, *args, timeout=timeout)

    def in_deck(self, path: str) -> bool:
        return not self.scope or path == self.scope or path.startswith(f"{self.scope}/")


def open_repo(deck_dir: Path) -> Repo | None:
    root = repo_root(deck_dir)
    return Repo(root, deck_dir) if root else None


# ── Status ──


_STATUS = {
    "M": "modified",
    "A": "added",
    "D": "deleted",
    "R": "renamed",
    "C": "copied",
    "U": "conflict",
    "?": "new",
}


def changes(repo: Repo) -> list[dict[str, object]]:
    """Changed files, relative to the repository root, deck files first."""
    out = repo.git("status", "--porcelain=v1", "-z", "--untracked-files=all")
    entries = out.split("\0")
    items: list[dict[str, object]] = []
    i = 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        code, path = entry[:2], entry[3:]
        if code[0] in "RC":
            i += 1  # the rename's source path follows
        letter = next((c for c in code if c not in " "), "M")
        items.append(
            {
                "path": path,
                "status": _STATUS.get(letter, "modified"),
                "inDeck": repo.in_deck(path),
            }
        )
    items.sort(key=lambda c: (not c["inDeck"], str(c["path"])))
    return items


def status(deck_dir: Path) -> dict[str, object]:
    if not available():
        return {"repo": False, "git": False}
    repo = open_repo(deck_dir)
    if repo is None:
        return {"repo": False, "git": True}
    branch = _try(repo.root, "symbolic-ref", "--quiet", "--short", "HEAD")
    head = _try(repo.root, "rev-parse", "--short", "HEAD")
    upstream = _try(repo.root, "rev-parse", "--abbrev-ref", "@{upstream}")
    ahead = behind = 0
    if upstream:
        counts = _try(repo.root, "rev-list", "--left-right", "--count", "@{u}...HEAD")
        if counts:
            behind, ahead = (int(n) for n in counts.split())
    last = None
    if head:
        raw = _try(repo.root, "log", "-1", "--format=%h%x00%s%x00%ar")
        if raw:
            sha, subject, when = raw.split("\0")
            last = {"sha": sha, "subject": subject, "when": when}
    remotes = (_try(repo.root, "remote") or "").split()
    return {
        "repo": True,
        "git": True,
        "root": str(repo.root),
        "scope": repo.scope,
        "branch": branch,
        "detached": head if branch is None and head else None,
        "hasCommits": head is not None,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "remotes": remotes,
        "changes": changes(repo),
        "last": last,
        "identity": bool(
            _try(repo.root, "config", "user.name")
            and _try(repo.root, "config", "user.email")
        ),
        "canUndoCommit": _can_undo_commit(repo),
        "suggestedMessage": default_message(),
    }


def default_message(now: datetime | None = None) -> str:
    return f"Update slides ({(now or datetime.now()).strftime('%Y-%m-%d %H:%M')})"


# ── Committing ──


def set_identity(repo: Repo, name: str, email: str) -> None:
    """Who commits, for this repository only."""
    if not name.strip() or "@" not in email:
        raise GitError("give a name and an email address to commit with")
    repo.git("config", "user.name", name.strip())
    repo.git("config", "user.email", email.strip())


def commit(repo: Repo, message: str, paths: list[str] | None) -> str:
    """Commit ``paths`` (relative to the repository root; all changes when None)."""
    if not message.strip():
        raise GitError("write a commit message")
    if paths is not None:
        paths = [p for p in paths if p]
        if not paths:
            raise GitError("choose at least one file to commit")
        repo.git("add", "-A", "--", *paths)
        repo.git("commit", "-q", "-m", message, "--", *paths)
    else:
        repo.git("add", "-A")
        repo.git("commit", "-q", "-m", message)
    return repo.git("rev-parse", "--short", "HEAD").strip()


def _can_undo_commit(repo: Repo) -> bool:
    """The last commit can be taken back while nobody else can have it: it has
    a parent, we are on a branch, and no remote branch contains it yet."""
    if _try(repo.root, "rev-parse", "--verify", "--quiet", "HEAD~1") is None:
        return False
    if _try(repo.root, "symbolic-ref", "--quiet", "HEAD") is None:
        return False
    return not _try(repo.root, "branch", "-r", "--contains", "HEAD")


def undo_commit(repo: Repo) -> None:
    """Take the last commit back, keeping its changes as uncommitted edits."""
    if not _can_undo_commit(repo):
        raise GitError("the last commit was pushed already (revert it instead)")
    repo.git("reset", "--soft", "HEAD~1")


# ── Remotes ──


def push(repo: Repo) -> str:
    branch = _try(repo.root, "symbolic-ref", "--quiet", "--short", "HEAD")
    if branch is None:
        raise GitError("switch to a branch before pushing")
    if _try(repo.root, "rev-parse", "--abbrev-ref", "@{upstream}"):
        repo.git("push", timeout=180)
        return f"Pushed {branch}"
    remotes = (_try(repo.root, "remote") or "").split()
    if not remotes:
        raise GitError("this repository has no remote to push to")
    remote = "origin" if "origin" in remotes else remotes[0]
    repo.git("push", "-u", remote, branch, timeout=180)
    return f"Pushed {branch} to {remote}"


def pull(repo: Repo) -> str:
    if not _try(repo.root, "rev-parse", "--abbrev-ref", "@{upstream}"):
        raise GitError("this branch does not track a remote branch yet (push it first)")
    out = repo.git("pull", "--ff-only", timeout=180)
    return "Already up to date" if "Already up to date" in out else "Pulled"


# ── Discarding and restoring ──


def _names(out: str) -> set[str]:
    return {name for name in out.split("\0") if name}


def discard(repo: Repo, paths: list[str]) -> None:
    """Put ``paths`` back as they were in the last commit; new files are deleted."""
    if not paths:
        return
    tracked = _names(repo.git("ls-files", "-z", "--", *paths))
    in_head: set[str] = set()
    if _try(repo.root, "rev-parse", "--verify", "--quiet", "HEAD"):
        in_head = _names(
            repo.git("ls-tree", "-r", "-z", "--name-only", "HEAD", "--", *paths)
        )
    if in_head:
        repo.git(
            "restore", "--source=HEAD", "--staged", "--worktree", "--", *sorted(in_head)
        )
    # Added since the last commit (staged or not): remove them.
    added = tracked - in_head
    if added:
        repo.git("rm", "-q", "-f", "--cached", "--", *sorted(added))
    for path in paths:
        target = repo.root / path
        if path not in in_head and target.is_file():
            target.unlink()


def restore_deck(repo: Repo, sha: str) -> None:
    """Make the deck's files what they were at ``sha``, as uncommitted changes."""
    _check_sha(sha)
    scope = repo.scope or "."
    then = _names(repo.git("ls-tree", "-r", "-z", "--name-only", sha, "--", scope))
    now = _names(repo.git("ls-files", "-z", "--", scope))
    if then:
        repo.git("restore", f"--source={sha}", "--staged", "--worktree", "--", scope)
    gone = sorted(now - then)
    if gone:
        # (restore already removes them where git can; whatever is left goes.)
        repo.git("rm", "-q", "-f", "--ignore-unmatch", "--", *gone)


def revert(repo: Repo, sha: str) -> None:
    """A new commit that undoes ``sha`` (history is kept)."""
    _check_sha(sha)
    try:
        repo.git("revert", "--no-edit", sha)
    except GitError as exc:
        _try(repo.root, "revert", "--abort")
        raise GitError(f"could not revert {sha[:7]} cleanly: {exc}") from exc


# ── Branches and commits ──


def branches(repo: Repo) -> list[dict[str, object]]:
    out = repo.git(
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)%00%(HEAD)%00%(committerdate:relative)",
        "refs/heads",
    )
    items: list[dict[str, object]] = []
    for line in out.splitlines():
        name, head, when = line.split("\0")
        items.append({"name": name, "current": head == "*", "when": when})
    return items


def _check_branch(repo: Repo, name: str) -> str:
    name = name.strip()
    if not name or _try(repo.root, "check-ref-format", "--branch", name) is None:
        raise GitError(f"{name!r} is not a valid branch name")
    return name


def create_branch(repo: Repo, name: str) -> None:
    """A new branch from here, switched to (uncommitted changes come along)."""
    repo.git("switch", "-c", _check_branch(repo, name))


def switch(repo: Repo, name: str) -> None:
    repo.git("switch", _check_branch(repo, name))


_SHA = re.compile(r"^[0-9a-f]{4,40}$")


def _check_sha(sha: str) -> None:
    if not _SHA.match(sha):
        raise GitError(f"{sha!r} is not a commit")


def view_commit(repo: Repo, sha: str) -> None:
    """Look at an older version (detached HEAD); switch back to a branch after."""
    _check_sha(sha)
    repo.git("switch", "--detach", sha)


def log(repo: Repo, limit: int = MAX_LOG) -> list[dict[str, object]]:
    """The deck's history: commits that touched its directory, newest first."""
    if _try(repo.root, "rev-parse", "--verify", "--quiet", "HEAD") is None:
        return []
    out = repo.git(
        "log",
        f"-n{limit}",
        "--format=%H%x00%h%x00%an%x00%ar%x00%s%x00%D",
        "--",
        repo.scope or ".",
    )
    head = repo.git("rev-parse", "HEAD").strip()
    items: list[dict[str, object]] = []
    for line in out.splitlines():
        sha, short, author, when, subject, refs = line.split("\0")
        items.append(
            {
                "sha": sha,
                "short": short,
                "author": author,
                "when": when,
                "subject": subject,
                "refs": [r.strip() for r in refs.split(",") if r.strip()],
                "head": sha == head,
            }
        )
    return items


def init(directory: Path) -> None:
    """A new repository for the deck, with the SVG hooks (see git_setup)."""
    from inkflow.git_setup import init_project_git

    if repo_root(directory) is not None:
        raise GitError("this deck is already in a git repository")
    init_project_git(directory)
    if repo_root(directory) is None:
        raise GitError("git init failed")
