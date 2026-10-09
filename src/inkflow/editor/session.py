"""Apply one editor request to the project's files, as one undoable step.

Every request from the browser is a small JSON message. ``EditorSession.apply``
validates it against the current build, turns it into new bytes for one or more
files (an SVG, a Markdown file, ``deck.py``), writes them, and records the step
so ``undo``/``redo`` can restore exactly those bytes. Nothing here rebuilds: the
file watcher picks the writes up like any other edit, which is also how the
editor and an agent editing the same files stay in step.
"""

from __future__ import annotations

import base64
import dataclasses
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from inkflow import animations as animations_module
from inkflow import transitions as transitions_module
from inkflow.animations import Cue
from inkflow.editor.codegen import Code, coerce_fields
from inkflow.editor.deckedit import DeckEditError, DeckSource
from inkflow.editor.svgops import (
    SvgFile,
    SvgOpError,
    apply_ops,
    file_hash,
    group,
    ungroup,
)
from inkflow.layout import create_slide
from inkflow.manifest import Deck, Inline, Slide, TextBox
from inkflow.pipeline import resolve_slide_src
from inkflow.transitions import Transition
from inkflow.zones import replace_zone_text

DECK_MODULE = "_inkflow_deck"
_MAX_UPLOAD = 50 * 1024 * 1024
_UPLOAD_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp4", ".webm"}


class EditError(Exception):
    """A request that cannot be applied; the message is shown to the user."""


@dataclass
class _Change:
    path: Path
    before: bytes | None
    after: bytes | None


@dataclass
class _Step:
    label: str
    changes: list[_Change]
    coalesce: str | None = None
    """Consecutive steps with the same key merge into one (typing, nudging)."""


@dataclass
class History:
    """Undo/redo over whole-file snapshots of the files each step wrote."""

    done: list[_Step] = field(default_factory=list)
    undone: list[_Step] = field(default_factory=list)
    limit: int = 200

    def record(self, step: _Step) -> None:
        last = self.done[-1] if self.done else None
        if (
            step.coalesce is not None
            and last is not None
            and last.coalesce == step.coalesce
        ):
            befores = {c.path: c.before for c in last.changes}
            merged = [
                _Change(c.path, befores.get(c.path, c.before), c.after)
                for c in step.changes
            ]
            merged += [
                c for c in last.changes if c.path not in {m.path for m in merged}
            ]
            self.done[-1] = _Step(last.label, merged, step.coalesce)
            self.undone.clear()
            return
        self.done.append(step)
        del self.done[: -self.limit]
        self.undone.clear()

    def _swap(self, step: _Step, forward: bool) -> None:
        for change in step.changes:
            expected = change.before if forward else change.after
            current = change.path.read_bytes() if change.path.exists() else None
            if current != expected:
                raise EditError(
                    f"{change.path.name} changed outside the editor; "
                    + "cannot undo past that edit"
                )
        for change in step.changes:
            target = change.after if forward else change.before
            if target is None:
                change.path.unlink(missing_ok=True)
            else:
                change.path.parent.mkdir(parents=True, exist_ok=True)
                change.path.write_bytes(target)

    def undo(self) -> _Step:
        if not self.done:
            raise EditError("nothing to undo")
        step = self.done[-1]
        self._swap(step, forward=False)
        self.undone.append(self.done.pop())
        return step

    def redo(self) -> _Step:
        if not self.undone:
            raise EditError("nothing to redo")
        step = self.undone[-1]
        self._swap(step, forward=True)
        self.done.append(self.undone.pop())
        return step


class _Txn:
    """The files one request writes, staged in memory until commit."""

    project_dir: Path
    staged: dict[Path, bytes]
    originals: dict[Path, bytes | None]

    def __init__(self, project_dir: Path) -> None:
        self.project_dir = project_dir
        self.staged = {}
        self.originals = {}

    def read(self, path: Path) -> bytes:
        path = self._check(path)
        if path in self.staged:
            return self.staged[path]
        if path not in self.originals:
            self.originals[path] = path.read_bytes() if path.exists() else None
        data = self.originals[path]
        if data is None:
            raise EditError(f"{path.name} does not exist")
        return data

    def write(self, path: Path, data: bytes) -> None:
        path = self._check(path)
        if path not in self.originals:
            self.originals[path] = path.read_bytes() if path.exists() else None
        self.staged[path] = data

    def _check(self, path: Path) -> Path:
        resolved = path.resolve()
        if not resolved.is_relative_to(self.project_dir.resolve()):
            raise EditError(f"{path} is outside the project")
        return resolved

    def commit(self, label: str) -> _Step:
        changes = [
            _Change(path, self.originals[path], data)
            for path, data in self.staged.items()
            if self.originals[path] != data
        ]
        for change in changes:
            change.path.parent.mkdir(parents=True, exist_ok=True)
            assert change.after is not None
            change.path.write_bytes(change.after)
        return _Step(label, changes)


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "slide"


def _unique_path(directory: Path, stem: str, suffix: str) -> Path:
    candidate = directory / f"{stem}{suffix}"
    n = 2
    while candidate.exists():
        candidate = directory / f"{stem}-{n}{suffix}"
        n += 1
    return candidate


def _py(value: object) -> str:
    return Code().literal(value)


class EditorSession:
    deck_path: Path
    project_dir: Path
    history: History

    def __init__(self, deck_path: Path) -> None:
        self.deck_path = deck_path.resolve()
        self.project_dir = self.deck_path.parent
        self.history = History()

    # ── Entry point ──

    def apply(self, msg: dict[str, object], deck: Deck | None) -> dict[str, object]:
        action = msg.get("action")
        if action == "undo":
            step = self.history.undo()
            return self._result(step, undo=True)
        if action == "redo":
            step = self.history.redo()
            return self._result(step)
        if action == "upload":
            return self._upload(msg)
        if deck is None:
            raise EditError("the deck has not built yet")
        txn = _Txn(self.project_dir)
        extra: dict[str, object] = {}
        handler = {
            "svg": self._svg,
            "zone-text": self._zone_text,
            "zone-media": self._zone_media,
            "md-text": self._md_text,
            "notes": self._notes,
            "slide": self._slide,
            "anim": self._anim,
        }.get(cast("str", action))
        if handler is None:
            raise EditError(f"unknown action {action!r}")
        try:
            label = handler(msg, deck, txn, extra)
        except (DeckEditError, SvgOpError, ValueError, KeyError, TypeError) as exc:
            raise EditError(str(exc)) from exc
        step = txn.commit(label)
        coalesce = msg.get("coalesce")
        step.coalesce = coalesce if isinstance(coalesce, str) else None
        if step.changes:
            self.history.record(step)
        return {**self._result(step), **extra}

    def _result(self, step: _Step, undo: bool = False) -> dict[str, object]:
        hashes: dict[str, str] = {}
        for change in step.changes:
            data = change.before if undo else change.after
            hashes[str(change.path)] = file_hash(data) if data is not None else ""
        return {
            "ok": True,
            "label": step.label,
            "hashes": hashes,
            "canUndo": bool(self.history.done),
            "canRedo": bool(self.history.undone),
        }

    # ── Helpers ──

    def _deck_slide(self, deck: Deck, msg: dict[str, object]) -> tuple[int, Slide]:
        index = msg.get("slide")
        if not isinstance(index, int) or not 0 <= index < len(deck.slides):
            raise EditError("no such slide")
        return index, deck.slides[index]

    def _deck_source(self, txn: _Txn) -> DeckSource:
        return DeckSource(txn.read(self.deck_path).decode("utf-8"))

    def _save_deck(self, txn: _Txn, source: DeckSource, imports: set[str]) -> None:
        if imports:
            source.ensure_imports(imports)
        txn.write(self.deck_path, source.code.encode("utf-8"))

    def _deck_class(self, name: str, base: type) -> type:
        module = sys.modules.get(DECK_MODULE)
        for mod in (animations_module, transitions_module, module):
            cls = getattr(mod, name, None) if mod is not None else None
            if isinstance(cls, type) and issubclass(cls, base):
                return cls
        raise EditError(f"unknown type {name!r}")

    # ── SVG ──

    def _svg(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        path = Path(cast("str", msg.get("file")))
        data = txn.read(path)
        expected = msg.get("hash")
        if isinstance(expected, str) and expected and file_hash(data) != expected:
            raise EditError(f"{path.name} changed on disk; wait for the reload")
        svg = SvgFile.from_bytes(path, data)
        ops = cast("list[dict[str, object]]", msg.get("ops") or [])
        result_ids: dict[str, str] = {}
        structural = False
        for op in ops:
            if op.get("kind") == "group":
                result_ids["group"] = group(svg, cast("list[str]", op.get("locs")))
                structural = True
            elif op.get("kind") == "ungroup":
                ungroup(svg, cast("str", op.get("loc")))
                structural = True
        plain = [op for op in ops if op.get("kind") not in ("group", "ungroup")]
        if plain:
            result = apply_ops(svg, plain)
            result_ids.update(result.ids)
            structural = structural or result.structural
        txn.write(path, svg.to_bytes())
        renames = {
            str(op["from"]): str(op["id"])
            for op in plain
            if op.get("kind") == "id" and isinstance(op.get("from"), str)
        }
        if renames:
            self._rename_cues(deck, path, renames, txn)
        extra["ids"] = result_ids
        extra["structural"] = structural
        return str(msg.get("label") or "Edit shape")

    def _rename_cues(
        self, deck: Deck, path: Path, renames: dict[str, str], txn: _Txn
    ) -> None:
        """Keep ``animations=[...]`` pointing at an element whose id changed."""
        source = self._deck_source(txn)
        if source.slide_calls(expected=len(deck.slides)) is None:
            return
        code = Code()
        changed = False
        for index, slide in enumerate(deck.slides):
            try:
                src = resolve_slide_src(slide.src, self.project_dir, deck.theme)
            except Exception:
                continue
            if src.resolve() != path.resolve():
                continue
            if source.animation_count(index) != len(slide.animations):
                continue
            for i, cue in enumerate(slide.animations):
                if cue.element in renames:
                    new = dataclasses.replace(cue, element=renames[cue.element])
                    source.edit_animations(index, replace=(i, code.call(new)))
                    changed = True
        if changed:
            self._save_deck(txn, source, code.imports)

    # ── Zone content ──

    def _zone_text(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        index, slide = self._deck_slide(deck, msg)
        zone = str(msg.get("zone"))
        text = str(msg.get("text", ""))
        origin = msg.get("origin")
        if zone in slide.zones or (origin == "deck"):
            current = slide.zones.get(zone)
            source = self._deck_source(txn)
            code = Code()
            if isinstance(current, TextBox):
                value = code.call(dataclasses.replace(current, text=text))
            elif text.strip():
                value = code.literal(text)
            else:
                value = None
            source.set_zone(index, zone, value)
            self._save_deck(txn, source, code.imports)
            return f"Edit {zone}"
        if slide.md is not None and not isinstance(slide.md, Inline):
            md_path = self._md_path(slide)
            source_text = txn.read(md_path).decode("utf-8")
            if origin == "md-file":
                new = text.rstrip() + "\n"
            else:
                new = replace_zone_text(source_text, zone, text)
            txn.write(md_path, new.encode("utf-8"))
            return f"Edit {zone}"
        if isinstance(slide.md, Inline):
            new = replace_zone_text(str(slide.md), zone, text)
            source = self._deck_source(txn)
            source.set_slide_arg(index, "md", f"Inline({_py(new)})")
            self._save_deck(txn, source, {"Inline"})
            return f"Edit {zone}"
        source = self._deck_source(txn)
        source.set_zone(index, zone, _py(text) if text.strip() else None)
        self._save_deck(txn, source, set())
        return f"Edit {zone}"

    def _zone_media(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        """Put an image (or video) into a zone via ``zones={...}`` in deck.py."""
        index, _ = self._deck_slide(deck, msg)
        zone = str(msg.get("zone"))
        src = msg.get("src")
        source = self._deck_source(txn)
        if src is None:
            source.set_zone(index, zone, None)
            self._save_deck(txn, source, set())
            return f"Clear {zone}"
        rel = self._deck_rel(Path(str(src)))
        kind = "Video" if Path(rel).suffix.lower() in (".mp4", ".webm") else "Image"
        fit = msg.get("fit")
        args = [_py(rel)]
        if isinstance(fit, str) and fit in ("cover", "contain"):
            args.append(f"fit=MediaFit.{fit.upper()}")
        source.set_zone(index, zone, f"{kind}({', '.join(args)})")
        imports = {kind}
        if len(args) > 1:
            imports.add("MediaFit")
        self._save_deck(txn, source, imports)
        return f"Set {zone} media"

    def _deck_rel(self, path: Path) -> str:
        resolved = path if path.is_absolute() else self.project_dir / path
        try:
            return resolved.resolve().relative_to(self.project_dir).as_posix()
        except ValueError as exc:
            raise EditError(f"{path} is outside the project") from exc

    def _md_path(self, slide: Slide) -> Path:
        from inkflow.loaders import load_md

        loaded = load_md(slide.md, self.project_dir)
        if loaded is None or loaded.path is None:
            raise EditError("this slide has no Markdown file")
        return loaded.path

    def _md_text(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        index, slide = self._deck_slide(deck, msg)
        text = str(msg.get("text", ""))
        if isinstance(slide.md, Inline):
            source = self._deck_source(txn)
            source.set_slide_arg(index, "md", f"Inline({_py(text)})")
            self._save_deck(txn, source, {"Inline"})
        elif slide.md is not None:
            txn.write(self._md_path(slide), text.encode("utf-8"))
        else:
            md_dir = self.project_dir / "slides"
            path = _unique_path(md_dir, _slug(str(msg.get("name") or "slide")), ".md")
            txn.write(path, text.encode("utf-8"))
            source = self._deck_source(txn)
            source.set_slide_arg(index, "md", _py(path.name))
            self._save_deck(txn, source, set())
        return "Edit Markdown"

    def _notes(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        index, slide = self._deck_slide(deck, msg)
        text = str(msg.get("text", ""))
        notes = slide.notes
        if isinstance(notes, Inline):
            source = self._deck_source(txn)
            source.set_slide_arg(
                index, "notes", f"Inline({_py(text)})" if text else None
            )
            self._save_deck(txn, source, {"Inline"} if text else set())
        elif notes:
            path = Path(str(notes))
            path = path if path.is_absolute() else self.project_dir / path
            txn.write(path, text.encode("utf-8"))
        elif text.strip():
            stem = _slug(str(msg.get("name") or "slide"))
            path = _unique_path(self.project_dir / "notes", stem, ".md")
            txn.write(path, text.encode("utf-8"))
            source = self._deck_source(txn)
            source.set_slide_arg(
                index, "notes", _py(path.relative_to(self.project_dir).as_posix())
            )
            self._save_deck(txn, source, set())
        return "Edit notes"

    # ── Slides ──

    def _slide(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        op = msg.get("op")
        source = self._deck_source(txn)
        if source.slide_calls(expected=len(deck.slides)) is None:
            raise EditError(
                "deck.py builds its slide list in code; edit it by hand or with Claude"
            )
        imports: set[str] = set()
        label = "Edit slide"
        if op == "move":
            src, dst = int(cast("int", msg["from"])), int(cast("int", msg["to"]))
            source.move_slide(src, dst)
            label = "Move slide"
        elif op == "delete":
            index, _ = self._deck_slide(deck, msg)
            source.remove_slide(index)
            label = "Delete slide"
        elif op == "hide":
            index, _ = self._deck_slide(deck, msg)
            hidden = bool(msg.get("hidden"))
            source.set_slide_arg(index, "visible", "False" if hidden else None)
            label = "Hide slide" if hidden else "Show slide"
        elif op == "title":
            index, _ = self._deck_slide(deck, msg)
            title = str(msg.get("title") or "").strip()
            source.set_slide_arg(index, "title", _py(title) if title else None)
            label = "Rename slide"
        elif op == "font-size":
            index, _ = self._deck_slide(deck, msg)
            size = msg.get("size")
            source.set_slide_arg(
                index, "font_size", str(int(cast("int", size))) if size else None
            )
            label = "Font size"
        elif op == "transition":
            index, _ = self._deck_slide(deck, msg)
            spec = msg.get("spec")
            if spec is None:
                source.set_slide_arg(index, "transition", None)
            else:
                code = Code()
                obj = self._build(cast("dict[str, object]", spec), Transition)
                source.set_slide_arg(index, "transition", code.call(obj))
                imports |= code.imports
            label = "Set transition"
        elif op == "duplicate":
            index, slide = self._deck_slide(deck, msg)
            overrides = self._copy_files(slide, deck, txn)
            source.duplicate_slide(index, overrides)
            extra["select"] = index + 1
            label = "Duplicate slide"
        elif op == "new":
            after = int(cast("int", msg.get("after", len(deck.slides) - 1)))
            layout = msg.get("layout")
            name = self._new_slide_file(
                str(layout) if layout else None,
                str(msg.get("name") or "slide"),
                txn,
                deck,
            )
            source.insert_slide(after + 1, f"Slide({_py(name)})")
            imports.add("Slide")
            extra["select"] = after + 1
            label = "New slide"
        elif op == "detach":
            index, slide = self._deck_slide(deck, msg)
            name = self._new_slide_file(
                slide.src, slide.id or Path(slide.src).stem, txn, deck
            )
            source.set_slide_arg(index, "src", _py(name))
            label = "Give slide its own drawing"
        elif op == "layout":
            index, slide = self._deck_slide(deck, msg)
            layout = str(msg.get("layout"))
            src_path = resolve_slide_src(slide.src, self.project_dir, deck.theme)
            if self._is_own(src_path, deck):
                svg = SvgFile.from_bytes(src_path, txn.read(src_path))
                svg.root.set("{urn:inkflow}parent", layout)
                txn.write(src_path, svg.to_bytes())
            else:
                source.set_slide_arg(index, "src", _py(layout))
            label = "Change layout"
        else:
            raise EditError(f"unknown slide operation {op!r}")
        self._save_deck(txn, source, imports)
        return label

    def _is_own(self, path: Path, deck: Deck) -> bool:
        resolved = path.resolve()
        if "layouts" in resolved.parts or not resolved.is_relative_to(self.project_dir):
            return False
        users = 0
        for s in deck.slides:
            try:
                if (
                    resolve_slide_src(s.src, self.project_dir, deck.theme).resolve()
                    == resolved
                ):
                    users += 1
            except Exception:
                continue
        return users == 1

    def _new_slide_file(
        self, parent: str | None, stem: str, txn: _Txn, deck: Deck
    ) -> str:
        slides_dir = self.project_dir / "slides"
        slides_dir.mkdir(exist_ok=True)
        path = _unique_path(slides_dir, _slug(stem), ".svg")
        # create_slide resolves the parent and injects the Inkscape preview layers.
        try:
            create_slide(parent, path, self.project_dir, deck.theme)
        except ValueError as exc:
            raise EditError(str(exc)) from exc
        data = path.read_bytes()
        path.unlink()
        txn.write(path, data)
        return path.name

    def _copy_files(self, slide: Slide, deck: Deck, txn: _Txn) -> dict[str, str | None]:
        """Copy the slide's own files so the duplicate can diverge from it."""
        overrides: dict[str, str | None] = {}
        src_path = resolve_slide_src(slide.src, self.project_dir, deck.theme)
        if self._is_own(src_path, deck):
            new = _unique_path(
                src_path.parent, f"{src_path.stem}-copy", src_path.suffix
            )
            txn.write(new, txn.read(src_path))
            overrides["src"] = _py(
                new.name if src_path.parent.name == "slides" else self._deck_rel(new)
            )
        if slide.md is not None and not isinstance(slide.md, Inline):
            md_path = self._md_path(slide)
            new = _unique_path(md_path.parent, f"{md_path.stem}-copy", md_path.suffix)
            txn.write(new, txn.read(md_path))
            written = Path(str(slide.md))
            overrides["md"] = _py(
                new.name
                if len(written.parts) == 1
                else str(written.with_name(new.name))
            )
        if slide.notes and not isinstance(slide.notes, Inline):
            path = Path(str(slide.notes))
            path = path if path.is_absolute() else self.project_dir / path
            if path.is_file():
                new = _unique_path(path.parent, f"{path.stem}-copy", path.suffix)
                txn.write(new, txn.read(path))
                overrides["notes"] = _py(self._deck_rel(new))
        if slide.id:
            overrides["id"] = _py(f"{slide.id}-copy")
        return overrides

    # ── Animations ──

    def _build(self, spec: dict[str, object], base: type) -> object:
        cls = self._deck_class(str(spec.get("type")), base)
        fields = coerce_fields(cls, cast("dict[str, object]", spec.get("fields") or {}))
        if issubclass(cls, Cue):
            fields["element"] = str(spec.get("element") or "")
            if not fields["element"]:
                raise EditError("an animation needs a target element")
        try:
            return cast("Callable[..., object]", cls)(**fields)
        except TypeError as exc:
            raise EditError(str(exc)) from exc

    def _anim(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        index, slide = self._deck_slide(deck, msg)
        op = msg.get("op")
        spec = cast("dict[str, object] | None", msg.get("spec"))
        target = cast("dict[str, object] | None", msg.get("target"))
        if spec is not None and target is not None and not spec.get("element"):
            # The element has no id yet: give it one in its SVG, in the same step.
            path = Path(str(target.get("file")))
            svg = SvgFile.from_bytes(path, txn.read(path))
            result = apply_ops(
                svg,
                [
                    {
                        "kind": "ensure-id",
                        "loc": target.get("loc"),
                        "key": "target",
                        "base": target.get("base"),
                    }
                ],
            )
            txn.write(path, svg.to_bytes())
            spec = {**spec, "element": result.ids["target"]}
            extra["ids"] = result.ids
        source = self._deck_source(txn)
        code = Code()
        n = len(slide.animations)
        position = int(cast("int", msg.get("index", n)))
        if op == "insert":
            assert spec is not None
            obj = self._build(spec, Cue)
            source.edit_animations(index, insert=(position, code.call(obj)))
            label = "Add animation"
        elif op == "replace":
            assert spec is not None
            obj = self._build(spec, Cue)
            source.edit_animations(index, replace=(position, code.call(obj)))
            label = "Edit animation"
        elif op == "remove":
            source.edit_animations(index, remove=position)
            label = "Remove animation"
        elif op == "move":
            to = int(cast("int", msg.get("to")))
            source.edit_animations(index, move=(position, to))
            label = "Reorder animation"
        else:
            raise EditError(f"unknown animation operation {op!r}")
        self._save_deck(txn, source, code.imports)
        return label

    # ── Uploads ──

    def _upload(self, msg: dict[str, object]) -> dict[str, object]:
        name = Path(str(msg.get("name") or "upload")).name
        suffix = Path(name).suffix.lower()
        if suffix not in _UPLOAD_SUFFIXES:
            raise EditError(f"cannot insert {suffix or 'this'} files")
        try:
            data = base64.b64decode(str(msg.get("data") or ""), validate=True)
        except ValueError as exc:
            raise EditError("upload is not valid base64") from exc
        if len(data) > _MAX_UPLOAD:
            raise EditError("file is larger than 50 MB")
        assets = self.project_dir / "assets"
        assets.mkdir(exist_ok=True)
        stem = _slug(Path(name).stem)
        existing = [
            p for p in assets.glob(f"{stem}*{suffix}") if p.read_bytes() == data
        ]
        path = existing[0] if existing else _unique_path(assets, stem, suffix)
        if not existing:
            path.write_bytes(data)
        return {"ok": True, "path": str(path), "rel": self._deck_rel(path)}
