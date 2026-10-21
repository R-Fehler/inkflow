"""The editor's "Open in…" menu: the programs that can open a deck's file.

It offers the configured command (``INKFLOW_EDIT_CMD*``, as the presenter's
edit menu resolves it in ``inkflow.edit``), then the programs found installed
for the file's kind (Inkscape for SVG; GIMP, Krita… for images; PDF viewers
for a PDF figure; text editors for Markdown and deck.py), then the system's
default app for the file.
"""

from __future__ import annotations

import functools
import os
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from inkflow.edit import KINDS, EditCommands, command_for, open_in_editor


@dataclass(frozen=True)
class App:
    id: str
    label: str
    command: str | None
    """A launch template (``{path}`` substituted); None for the system's opener."""


_TEXT_EDITORS = [
    ("code", "VS Code"),
    ("codium", "VSCodium"),
    ("zed", "Zed"),
    ("subl", "Sublime Text"),
    ("kate", "Kate"),
    ("gnome-text-editor", "Text Editor"),
    ("gedit", "gedit"),
    ("mousepad", "Mousepad"),
    ("notepad++", "Notepad++"),
]
_CANDIDATES: dict[str, list[tuple[str, str]]] = {
    "SVG": [("inkscape", "Inkscape"), *_TEXT_EDITORS],
    # A draw.io diagram (*.drawio.svg): draw.io desktop edits its source.
    "DIAGRAM": [("drawio", "draw.io"), ("inkscape", "Inkscape"), *_TEXT_EDITORS],
    "IMAGE": [("gimp", "GIMP"), ("krita", "Krita"), ("pinta", "Pinta")],
    # A figure: read in a viewer; Inkscape opens a page of it as a drawing.
    "PDF": [
        ("okular", "Okular"),
        ("evince", "Document Viewer"),
        ("zathura", "Zathura"),
        ("xreader", "Xreader"),
        ("inkscape", "Inkscape"),
    ],
    "TEXT": _TEXT_EDITORS,
    "DATA": [
        ("localc", "LibreOffice Calc"),
        ("libreoffice", "LibreOffice"),
        ("gnumeric", "Gnumeric"),
        ("numbers", "Numbers"),
        ("excel", "Microsoft Excel"),
        *_TEXT_EDITORS,
    ],
    "VIDEO": [
        ("losslesscut", "LosslessCut (trim, no re-encoding)"),
        ("shotcut", "Shotcut"),
        ("kdenlive", "Kdenlive"),
        ("avidemux3_qt5", "Avidemux"),
        ("avidemux", "Avidemux"),
        ("ghb", "HandBrake (convert)"),
        ("openshot-qt", "OpenShot"),
        ("vlc", "VLC"),
        ("mpv", "mpv"),
    ],
}
# The same programs installed as Flatpaks (no binary on PATH).
_FLATPAKS = {
    "losslesscut": "no.mifi.losslesscut",
    "shotcut": "org.shotcut.Shotcut",
    "kdenlive": "org.kde.kdenlive",
    "avidemux": "org.avidemux.Avidemux",
    "ghb": "fr.handbrake.ghb",
    "openshot-qt": "org.openshot.OpenShot",
    "vlc": "org.videolan.VLC",
    "mpv": "io.mpv.Mpv",
    "inkscape": "org.inkscape.Inkscape",
    "gimp": "org.gimp.GIMP",
    "krita": "org.kde.krita",
    "drawio": "com.jgraph.drawio.desktop",
    "okular": "org.kde.okular",
    "evince": "org.gnome.Evince",
    "libreoffice": "org.libreoffice.LibreOffice",
    "gnumeric": "org.gnome.Gnumeric",
}
# macOS apps live in /Applications rather than on PATH.
_MAC_APPS = {
    "inkscape": "Inkscape",
    "gimp": "GIMP",
    "krita": "krita",
    "code": "Visual Studio Code",
    "zed": "Zed",
    "subl": "Sublime Text",
    "vlc": "VLC",
    "losslesscut": "LosslessCut",
    "shotcut": "Shotcut",
    "kdenlive": "kdenlive",
    "ghb": "HandBrake",
    "openshot-qt": "OpenShot Video Editor",
    "drawio": "draw.io",
    "libreoffice": "LibreOffice",
    "numbers": "Numbers",
    "excel": "Microsoft Excel",
}


def _kind(path: Path) -> str | None:
    if path.name.lower().endswith(".drawio.svg"):
        return "DIAGRAM"
    suffix = path.suffix.lower().lstrip(".")
    return "SVG" if suffix == "svg" else KINDS.get(suffix)


def _installed(binary: str) -> str | None:
    if shutil.which(binary):
        return f"{shlex.quote(binary)} {{path}}"
    app = _MAC_APPS.get(binary)
    if sys.platform == "darwin" and app and Path(f"/Applications/{app}.app").exists():
        return f"open -a {shlex.quote(app)} {{path}}"
    flatpak = _FLATPAKS.get(binary)
    if flatpak and _flatpak_installed(flatpak):
        return f"flatpak run {flatpak} {{path}}"
    return None


@functools.cache
def _flatpak_installed(app_id: str) -> bool:
    """Whether a Flatpak app is installed (asked once per process)."""
    if shutil.which("flatpak") is None:
        return False
    try:
        result = subprocess.run(
            ["flatpak", "info", app_id], capture_output=True, timeout=5
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def open_choices(path: Path, commands: EditCommands) -> list[App]:
    """What the editor offers to open ``path`` with, most specific first."""
    apps: list[App] = []
    configured = command_for(path, commands)
    if configured:
        program = Path(shlex.split(configured)[0]).name
        apps.append(App("configured", f"{program} (configured)", configured))
    labels: set[str] = set()
    for binary, label in _CANDIDATES.get(_kind(path) or "", []):
        command = _installed(binary)
        if command and label not in labels:  # one Avidemux, however installed
            labels.add(label)
            apps.append(App(binary, label, command))
    apps.append(App("system", "Default app", None))
    return apps


def open_with(path: Path, app: App) -> str | None:
    """Open ``path`` with ``app``; returns an error message rather than raising."""
    if app.command is not None:
        return open_in_editor(path, app.command)
    if sys.platform == "win32":
        try:
            os.startfile(path)
        except OSError as e:
            return f"failed to open {path.name}: {e}"
        return None
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    if not shutil.which(opener):
        return f"no default app opener ({opener}) on this system"
    return open_in_editor(path, f"{opener} {{path}}")
