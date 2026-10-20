"""``inkflow pack``'s plan: everything that ties a deck to this machine, and
what packing writes (``inkflow.pack`` has the building blocks; this adds the
copy-in of files outside the deck, through ``filerename.plan_copy_in``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from inkflow import fontreport, pdf
from inkflow.fontreport import BundlePlan, FontReport, Where
from inkflow.pack import (
    Item,
    plan_attributes,
    plan_pyproject,
    show_path,
    uv_available,
)
from inkflow_editor.filerename import CopyInPlan, plan_copy_in

if TYPE_CHECKING:
    from inkflow.manifest import Deck
    from inkflow.pipeline import SlideData


@dataclass
class PackPlan:
    fonts: FontReport
    bundle: BundlePlan
    copy_in: CopyInPlan
    writes: dict[Path, bytes] = field(default_factory=dict)
    """.gitattributes, pyproject.toml, committed PDF pages."""
    lock_dir: Path | None = None
    """Where ``uv lock`` should run (no uv.lock beside the pyproject.toml)."""
    items: list[Item] = field(default_factory=list)
    steps: list[str] = field(default_factory=list)
    """What packing does, one line each, in order."""

    @property
    def needed(self) -> bool:
        """Whether packing would take something machine-dependent away."""
        return any(i.fixable for i in self.items)

    @property
    def remaining(self) -> list[Item]:
        return [i for i in self.items if not i.fixable]

    def json(self, project_dir: Path) -> dict[str, object]:
        return {
            "needed": self.needed,
            "items": [i.json() for i in self.items],
            "steps": self.steps,
            "fonts": self.bundle.json(project_dir),
            "assets": self.copy_in.summary(project_dir),
            "writes": [show_path(p, project_dir) for p in self.writes],
            "lock": show_path(self.lock_dir / "uv.lock", project_dir)
            if self.lock_dir
            else None,
        }


_EMOJI = re.compile(
    "[\U0001f300-\U0001faff\U00002600-\U000027bf\U0001f000-\U0001f2ff\U0001f900-\U0001f9ff]"
)


def _deck_fonts(report: FontReport) -> list[Path]:
    found: list[Path] = []
    for folder in [report.dirs.project, *report.dirs.theme]:
        if folder.is_dir():
            found += [
                p
                for p in sorted(folder.rglob("*"))
                if p.suffix.lower() in fontreport.FONT_SUFFIXES
            ]
    return found


def _font_has(path: Path, codepoints: set[int], table: str | None = None) -> bool:
    try:
        from fontTools.ttLib import TTFont

        font = TTFont(path, lazy=True, fontNumber=0)
        try:
            if table is not None:
                return table in font
            cmap = font.getBestCmap() or {}
            return all(c in cmap for c in codepoints)
        finally:
            font.close()
    except Exception:
        return False


def _text_needs(slides: list[SlideData]) -> tuple[set[int], bool]:
    emoji: set[int] = set()
    math = False
    for slide in slides:
        svg = slide["svg"]
        emoji |= {ord(m.group(0)) for m in _EMOJI.finditer(svg)}
        math = math or "<math" in svg
    return emoji, math


def _pdf_refs(slides: list[SlideData]) -> set[str]:
    refs: set[str] = set()
    for slide in slides:
        refs |= set(re.findall(pdf.SOURCE_ATTR + r'="([^"]+)"', slide["svg"]))
    return refs


def plan_pack(
    deck: Deck,
    project_dir: Path,
    deck_path: Path,
    *,
    with_pdf_pages: bool = False,
    all_weights: bool = False,
    slides: list[SlideData] | None = None,
) -> PackPlan:
    """Everything that ties the deck to this machine, and what packing writes
    (nothing is written here)."""
    from inkflow.assets import AssetRoots
    from inkflow.pipeline import process_deck

    if slides is None:
        slides = process_deck(deck, project_dir, deck_path)
    report = fontreport.font_report(deck, project_dir, slides)
    bundle = fontreport.plan_bundle(report, project_dir, all_weights=all_weights)
    copy_in = plan_copy_in(project_dir, deck_path, deck)
    plan = PackPlan(report, bundle, copy_in)
    items = plan.items

    for family in report.families:
        if family.where is Where.MACHINE:
            items.append(
                Item(
                    "font",
                    family.message(),
                    "Slides use a different font on machines without "
                    + f'"{family.family}"',
                    True,
                )
            )
        elif family.where is Where.MISSING:
            items.append(
                Item(
                    "missing-font",
                    family.message(),
                    f'"{family.family}" is not installed here either: every machine '
                    + "shows a fallback font",
                    False,
                )
            )
        elif family.where is Where.GENERIC:
            items.append(
                Item(
                    "generic-font",
                    family.message(),
                    f"Text set in {family.family} looks different on each OS",
                    False,
                )
            )
    if bundle.copies:
        plan.steps.append(
            f"copy {len(bundle.families)} font famil"
            + ("y" if len(bundle.families) == 1 else "ies")
            + f" into fonts/ ({', '.join(bundle.families)}) with their licences"
        )
    for src, dst in copy_in.copies:
        items.append(
            Item(
                "asset",
                f"{src} is outside the deck (or behind a symlink)",
                f"{show_path(dst, project_dir)} won't be in the repository: "
                + "others see it missing",
                True,
            )
        )
    for dst in copy_in.writes:
        if not dst.exists():
            items.append(
                Item(
                    "asset",
                    f"{show_path(dst, project_dir)} comes from outside the deck",
                    "it won't be in the repository: others see it missing",
                    True,
                )
            )
    if copy_in.copies or any(not p.exists() for p in copy_in.writes):
        plan.steps.append(
            f"copy files from outside the deck in and rewrite {len(copy_in.edits)} "
            + "reference(s) to them"
        )
    for ref in copy_in.remote:
        items.append(
            Item(
                "remote",
                f"{ref.file} reads {ref.raw} from the web",
                "it shows only with internet access, and may change or vanish",
                False,
            )
        )

    project = plan_pyproject(deck, project_dir)
    if project.text is not None:
        plan.writes[project.path] = project.text.encode("utf-8")
        what = (
            "write"
            if not project.path.exists()
            else "pin " + ", ".join(project.added) + " in"
        )
        plan.steps.append(f"{what} {show_path(project.path, project_dir)}")
        items.append(
            Item(
                "pyproject",
                "no pyproject.toml pins the inkflow version"
                if not project.path.exists()
                else f"{show_path(project.path, project_dir)} does not pin "
                + ", ".join(project.added),
                "others may build it with another inkflow (or theme) version",
                True,
            )
        )
    lock = project.path.parent / "uv.lock"
    if not lock.is_file():
        plan.lock_dir = project.path.parent
        fixable = uv_available()
        plan.steps.append(
            f"run uv lock in {show_path(project.path.parent, project_dir) or '.'}"
            if fixable
            else "uv.lock: uv is not installed, run `uv lock` where it is"
        )
        items.append(
            Item(
                "lock",
                "no uv.lock",
                "versions are not locked: another machine may install different ones",
                fixable,
            )
        )

    attributes = plan_attributes(project_dir)
    if attributes.text is not None:
        plan.writes[project_dir / ".gitattributes"] = attributes.text.encode("utf-8")
        added: list[str] = []
        if attributes.eol:
            added.append("LF line endings")
            items.append(
                Item(
                    "eol",
                    "no line-ending rules for the deck's text files",
                    "a Windows checkout may rewrite every SVG and Markdown file "
                    + "with CRLF line endings",
                    True,
                )
            )
        if attributes.diff:
            added.append("the SVG diff driver")
        if attributes.lfs:
            added.append("Git LFS rules")
            items.append(
                Item(
                    "lfs",
                    "no Git LFS rules for fonts and media",
                    "fonts, pictures and videos are stored whole in every version, "
                    + "growing the repository",
                    True,
                )
            )
        plan.steps.append(f"add {', '.join(added)} to .gitattributes")

    roots = AssetRoots(project_dir, deck.theme.asset_dir())
    pages = _pdf_refs(slides)
    uncommitted: list[str] = []
    for ref in sorted(pages):
        file = roots.locate(pdf.split_ref(ref)[0])
        page = pdf.page_of(ref)
        if file is None or not file.is_file() or page is None:
            continue
        if pdf.committed_page(file, page) is not None:
            continue
        if with_pdf_pages and pdf.converter() is not None:
            try:
                text = pdf.page_for_commit(file, page, project_dir)
            except (pdf.PdfError, OSError) as exc:
                uncommitted.append(f"{ref} ({exc})")
                continue
            plan.writes[pdf.committed_path(file, page)] = text.encode("utf-8")
        else:
            uncommitted.append(ref)
    if with_pdf_pages and len(uncommitted) < len(pages):
        plan.steps.append("commit the PDF figures' pages as SVG beside each PDF")
    if uncommitted:
        hint = (
            "pack --with-pdf-pages commits the pages"
            if pdf.converter() is not None
            else pdf.install_hint()
        )
        items.append(
            Item(
                "pdf",
                f"{len(uncommitted)} PDF figure page(s) need a PDF converter to "
                + f"build ({hint})",
                "a machine without one shows a placeholder instead of the figure",
                False,
            )
        )

    emoji, math = _text_needs(slides)
    deck_fonts = _deck_fonts(report)
    if emoji and not any(_font_has(p, emoji) for p in deck_fonts):
        items.append(
            Item(
                "emoji",
                "emoji are drawn by each machine's own emoji font",
                "emoji look different on each OS (put an emoji font in fonts/)",
                False,
            )
        )
    if math and not any(_font_has(p, set(), "MATH") for p in deck_fonts):
        items.append(
            Item(
                "math",
                "formulas are drawn with each machine's math font",
                "formulas may look different on each OS (put a math font in fonts/)",
                False,
            )
        )
    return plan
