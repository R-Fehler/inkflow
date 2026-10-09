"""Structured edits to ``deck.py`` that keep the author's formatting.

``deck.py`` is ordinary Python, so the editor can only change the parts that have
a recognisable shape: the ``Deck(slides=[...])`` list (a literal list, or a name
bound to one), each ``Slide(...)`` call in it, and that call's keyword arguments
(``animations=[...]``, ``zones={...}``, ``transition=``, ``notes=`` …). Anything
built by a loop or a helper function is reported as not editable rather than
guessed at.

libcst keeps comments and whitespace, and the sequence edits below move an item
together with the comment lines written above it, so reordering slides carries
their explanatory comments along.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import libcst as cst
from typing_extensions import override

# ── Bracketed sequences (list, dict, call arguments) ───────────────────────────


@dataclass
class _Item:
    node: cst.CSTNode
    """The element without its comma (``Element``, ``DictElement`` or ``Arg``)."""
    leading: Sequence[cst.EmptyLine]
    """Comment lines written above the item."""
    trailing: cst.TrailingWhitespace | None
    """A comment on the item's own line, after its comma."""


def _ws_parts(
    ws: cst.BaseParenthesizableWhitespace,
) -> tuple[cst.TrailingWhitespace | None, Sequence[cst.EmptyLine]]:
    if isinstance(ws, cst.ParenthesizedWhitespace):
        return ws.first_line, ws.empty_lines
    return None, ()


class _Seq:
    """A list, dict or argument list viewed as items separated by gaps.

    ``gaps[0]`` sits before the first item, ``gaps[k]`` between items ``k-1`` and
    ``k``, and ``gaps[n]`` before the closing bracket. An item owns the comment
    lines in the gap above it and the end-of-line comment in the gap after it.
    """

    node: cst.List | cst.Dict | cst.Call
    trailing_comma: bool
    gaps: list[cst.BaseParenthesizableWhitespace]
    items: list[_Item]
    template: cst.ParenthesizedWhitespace | None

    def __init__(self, node: cst.List | cst.Dict | cst.Call) -> None:
        self.node = node
        elements = self._elements()
        gaps: list[cst.BaseParenthesizableWhitespace] = [self._open()]
        for el in elements[:-1]:
            comma = el.comma
            gaps.append(
                comma.whitespace_after
                if isinstance(comma, cst.Comma)
                else cst.SimpleWhitespace(" ")
            )
        self.trailing_comma = bool(elements) and isinstance(
            elements[-1].comma, cst.Comma
        )
        gaps.append(self._close(elements))
        self.gaps = gaps
        self.items = []
        for i, el in enumerate(elements):
            _, leading = _ws_parts(gaps[i])
            trailing, _ = _ws_parts(gaps[i + 1])
            self.items.append(_Item(self._strip(el), leading, trailing))
        self.template = next(
            (g for g in gaps[:-1] if isinstance(g, cst.ParenthesizedWhitespace)), None
        )

    def _elements(self) -> list[cst.Element | cst.DictElement | cst.Arg]:
        if isinstance(self.node, cst.Call):
            return list(self.node.args)
        return cast(
            "list[cst.Element | cst.DictElement | cst.Arg]", list(self.node.elements)
        )

    def _open(self) -> cst.BaseParenthesizableWhitespace:
        if isinstance(self.node, cst.Call):
            return self.node.whitespace_before_args
        if isinstance(self.node, cst.List):
            return self.node.lbracket.whitespace_after
        return self.node.lbrace.whitespace_after

    def _close(
        self, elements: Sequence[cst.Element | cst.DictElement | cst.Arg]
    ) -> cst.BaseParenthesizableWhitespace:
        if isinstance(self.node, cst.Call):
            if not elements:
                return cst.SimpleWhitespace("")
            last = elements[-1]
            if isinstance(last.comma, cst.Comma):
                return last.comma.whitespace_after
            return cast("cst.Arg", last).whitespace_after_arg
        if isinstance(self.node, cst.List):
            return self.node.rbracket.whitespace_before
        return self.node.rbrace.whitespace_before

    @staticmethod
    def _strip(el: cst.Element | cst.DictElement | cst.Arg) -> cst.CSTNode:
        if isinstance(el, cst.Arg):
            return el.with_changes(
                comma=cst.MaybeSentinel.DEFAULT,
                whitespace_after_arg=cst.SimpleWhitespace(""),
            )
        return el.with_changes(comma=cst.MaybeSentinel.DEFAULT)

    def _gap(
        self,
        trailing: cst.TrailingWhitespace | None,
        leading: Sequence[cst.EmptyLine],
    ) -> cst.BaseParenthesizableWhitespace:
        if self.template is None:
            return cst.SimpleWhitespace(" ")
        return self.template.with_changes(
            first_line=trailing or cst.TrailingWhitespace(),
            empty_lines=leading,
        )

    def build(self) -> cst.List | cst.Dict | cst.Call:
        n = len(self.items)
        if n == 0:
            empty = cst.SimpleWhitespace("")
            if isinstance(self.node, cst.Call):
                return self.node.with_changes(args=[], whitespace_before_args=empty)
            if isinstance(self.node, cst.List):
                return self.node.with_changes(
                    elements=[],
                    lbracket=cst.LeftSquareBracket(),
                    rbracket=cst.RightSquareBracket(),
                )
            return self.node.with_changes(
                elements=[], lbrace=cst.LeftCurlyBrace(), rbrace=cst.RightCurlyBrace()
            )
        opening = self.gaps[0]
        if isinstance(opening, cst.ParenthesizedWhitespace):
            opening = opening.with_changes(empty_lines=self.items[0].leading)
        closing = self.gaps[-1]
        if isinstance(closing, cst.ParenthesizedWhitespace):
            closing = closing.with_changes(
                first_line=self.items[-1].trailing or cst.TrailingWhitespace()
            )
        trailing_comma = self.trailing_comma or (
            self.template is not None
            and isinstance(closing, cst.ParenthesizedWhitespace)
        )
        elements: list[cst.CSTNode] = []
        for i, item in enumerate(self.items):
            last = i == n - 1
            node = item.node
            if not last:
                gap = self._gap(item.trailing, self.items[i + 1].leading)
                node = node.with_changes(comma=cst.Comma(whitespace_after=gap))
            elif isinstance(self.node, cst.Call):
                if trailing_comma:
                    node = node.with_changes(comma=cst.Comma(whitespace_after=closing))
                else:
                    node = node.with_changes(whitespace_after_arg=closing)
            elif trailing_comma:
                node = node.with_changes(comma=cst.Comma())
            elements.append(node)
        if isinstance(self.node, cst.Call):
            return self.node.with_changes(args=elements, whitespace_before_args=opening)
        if isinstance(self.node, cst.List):
            return self.node.with_changes(
                elements=elements,
                lbracket=self.node.lbracket.with_changes(whitespace_after=opening),
                rbracket=self.node.rbracket.with_changes(whitespace_before=closing),
            )
        return self.node.with_changes(
            elements=elements,
            lbrace=self.node.lbrace.with_changes(whitespace_after=opening),
            rbrace=self.node.rbrace.with_changes(whitespace_before=closing),
        )

    def insert(self, index: int, node: cst.CSTNode) -> None:
        self.items.insert(index, _Item(node, (), None))

    def remove(self, index: int) -> _Item:
        item = self.items.pop(index)
        # The removed item's leading comments describe it, so they go with it.
        return item

    def move(self, src: int, dst: int) -> None:
        item = self.items.pop(src)
        self.items.insert(dst, item)


# ── Locating things in deck.py ──────────────────────────────────────────────────


class DeckEditError(Exception):
    """An edit that cannot be applied to this ``deck.py`` as written."""


def _callee(node: cst.BaseExpression) -> str | None:
    if isinstance(node, cst.Call):
        func = node.func
        if isinstance(func, cst.Name):
            return func.value
        if isinstance(func, cst.Attribute):
            return func.attr.value
    return None


def _kwarg(call: cst.Call, name: str) -> cst.Arg | None:
    for arg in call.args:
        if arg.keyword is not None and arg.keyword.value == name:
            return arg
    return None


class _Finder(cst.CSTVisitor):
    def __init__(self) -> None:
        super().__init__()
        self.deck_calls: list[cst.Call] = []
        self.assignments: dict[str, list[cst.BaseExpression]] = {}
        self.imports: list[cst.ImportFrom] = []
        self.last_import: cst.CSTNode | None = None

    @override
    def visit_Call(self, node: cst.Call) -> None:
        if _callee(node) == "Deck" and _kwarg(node, "slides") is not None:
            self.deck_calls.append(node)

    @override
    def visit_Assign(self, node: cst.Assign) -> None:
        for target in node.targets:
            if isinstance(target.target, cst.Name):
                self.assignments.setdefault(target.target.value, []).append(node.value)

    @override
    def visit_AnnAssign(self, node: cst.AnnAssign) -> None:
        if isinstance(node.target, cst.Name) and node.value is not None:
            self.assignments.setdefault(node.target.value, []).append(node.value)

    @override
    def visit_ImportFrom(self, node: cst.ImportFrom) -> None:
        module = node.module
        if isinstance(module, cst.Name) and module.value == "inkflow":
            self.imports.append(node)


class DeckSource:
    """One ``deck.py``, parsed once per edit; ``code`` is the edited text."""

    module: cst.Module

    def __init__(self, code: str) -> None:
        self.module = cst.parse_module(code)

    @classmethod
    def read(cls, path: Path) -> DeckSource:
        return cls(path.read_text(encoding="utf-8"))

    @property
    def code(self) -> str:
        return self.module.code

    def _find(self) -> _Finder:
        finder = _Finder()
        self.module.visit(finder)
        return finder

    def slides_list(self) -> cst.List | None:
        finder = self._find()
        if len(finder.deck_calls) != 1:
            return None
        arg = _kwarg(finder.deck_calls[0], "slides")
        value = arg.value if arg is not None else None
        if isinstance(value, cst.Name):
            bound = finder.assignments.get(value.value, [])
            value = bound[0] if len(bound) == 1 else None
        return value if isinstance(value, cst.List) else None

    def slide_calls(self, expected: int | None = None) -> list[cst.Call] | None:
        """The ``Slide(...)`` calls, in deck order, or ``None`` if the list is not
        a plain literal of them (or does not match ``expected`` slides)."""
        slides = self.slides_list()
        if slides is None:
            return None
        calls: list[cst.Call] = []
        for el in slides.elements:
            if not isinstance(el, cst.Element) or _callee(el.value) != "Slide":
                return None
            calls.append(cast("cst.Call", el.value))
        if expected is not None and len(calls) != expected:
            return None
        return calls

    def _slides(self) -> tuple[cst.List, list[cst.Call]]:
        slides = self.slides_list()
        calls = self.slide_calls()
        if slides is None or calls is None:
            raise DeckEditError(
                "deck.py's slides are not a plain list of Slide(...) calls"
            )
        return slides, calls

    def _replace(self, old: cst.CSTNode, new: cst.CSTNode) -> None:
        self.module = cast("cst.Module", self.module.deep_replace(old, new))

    # ── Slide list ──

    def move_slide(self, src: int, dst: int) -> None:
        slides, calls = self._slides()
        _check_index(src, len(calls))
        _check_index(dst, len(calls))
        seq = _Seq(slides)
        seq.move(src, dst)
        self._replace(slides, seq.build())

    def remove_slide(self, index: int) -> None:
        slides, calls = self._slides()
        _check_index(index, len(calls))
        if len(calls) == 1:
            raise DeckEditError("a deck needs at least one slide")
        seq = _Seq(slides)
        seq.remove(index)
        self._replace(slides, seq.build())

    def insert_slide(self, index: int, code: str) -> None:
        slides, calls = self._slides()
        if not 0 <= index <= len(calls):
            raise DeckEditError(f"slide index {index} out of range")
        seq = _Seq(slides)
        seq.insert(index, cst.Element(cst.parse_expression(code)))
        self._replace(slides, seq.build())

    def duplicate_slide(self, index: int, kwargs: dict[str, str | None]) -> None:
        """Insert a copy of slide ``index`` after it, with ``kwargs`` overridden
        (values are source code; ``None`` removes the argument)."""
        slides, calls = self._slides()
        _check_index(index, len(calls))
        copy = calls[index]
        for name, code in kwargs.items():
            copy = _set_arg(copy, name, code)
        seq = _Seq(slides)
        seq.insert(index + 1, cst.Element(copy))
        self._replace(slides, seq.build())

    # ── One slide's arguments ──

    def slide_call(self, index: int) -> cst.Call:
        _, calls = self._slides()
        _check_index(index, len(calls))
        return calls[index]

    def set_slide_arg(self, index: int, name: str, code: str | None) -> None:
        """Set (``code``) or remove (``None``) one argument of ``Slide`` ``index``.

        ``src`` is the first positional argument; everything else is a keyword.
        """
        call = self.slide_call(index)
        self._replace(call, _set_arg(call, name, code))

    # ── animations=[...] ──

    def _animations(self, index: int) -> tuple[cst.Call, cst.List | None]:
        call = self.slide_call(index)
        arg = _kwarg(call, "animations")
        if arg is None:
            return call, None
        if not isinstance(arg.value, cst.List):
            raise DeckEditError("this slide's animations are not a literal list")
        return call, arg.value

    def animation_count(self, index: int) -> int | None:
        try:
            _, anims = self._animations(index)
        except DeckEditError:
            return None
        return 0 if anims is None else len(anims.elements)

    def edit_animations(
        self,
        index: int,
        *,
        insert: tuple[int, str] | None = None,
        replace: tuple[int, str] | None = None,
        remove: int | None = None,
        move: tuple[int, int] | None = None,
    ) -> None:
        call, anims = self._animations(index)
        if anims is None:
            if insert is None:
                raise DeckEditError("this slide has no animations")
            new_call = _set_arg(call, "animations", f"[{insert[1]}]")
            self._replace(call, new_call)
            return
        seq = _Seq(anims)
        n = len(seq.items)
        if insert is not None:
            if not 0 <= insert[0] <= n:
                raise DeckEditError("animation index out of range")
            seq.insert(insert[0], cst.Element(cst.parse_expression(insert[1])))
        if replace is not None:
            _check_index(replace[0], n)
            item = seq.items[replace[0]]
            item.node = cast("cst.Element", item.node).with_changes(
                value=cst.parse_expression(replace[1])
            )
        if remove is not None:
            _check_index(remove, n)
            seq.remove(remove)
        if move is not None:
            _check_index(move[0], n)
            _check_index(move[1], n)
            seq.move(*move)
        if not seq.items:
            self._replace(call, _set_arg(call, "animations", None))
            return
        self._replace(anims, seq.build())

    # ── zones={...} ──

    def set_zone(self, index: int, zone: str, code: str | None) -> None:
        call = self.slide_call(index)
        arg = _kwarg(call, "zones")
        if arg is None:
            if code is None:
                return
            self._replace(call, _set_arg(call, "zones", f"{{{_py_str(zone)}: {code}}}"))
            return
        if not isinstance(arg.value, cst.Dict):
            raise DeckEditError("this slide's zones are not a literal dict")
        zones = arg.value
        seq = _Seq(zones)
        for i, item in enumerate(seq.items):
            el = item.node
            if (
                isinstance(el, cst.DictElement)
                and isinstance(el.key, cst.SimpleString)
                and el.key.evaluated_value == zone
            ):
                if code is None:
                    seq.remove(i)
                else:
                    item.node = el.with_changes(value=cst.parse_expression(code))
                break
        else:
            if code is None:
                return
            seq.insert(
                len(seq.items),
                cst.DictElement(
                    cst.SimpleString(_py_str(zone)), cst.parse_expression(code)
                ),
            )
        if not seq.items:
            self._replace(call, _set_arg(call, "zones", None))
            return
        self._replace(zones, seq.build())

    # ── Imports ──

    def ensure_imports(self, names: set[str]) -> None:
        """Make each name importable from ``inkflow`` at module level."""
        finder = self._find()
        have: set[str] = set()
        for imp in finder.imports:
            if isinstance(imp.names, cst.ImportStar):
                return
            for alias in imp.names:
                bound = alias.asname.name if alias.asname else alias.name
                if isinstance(bound, cst.Name):
                    have.add(bound.value)
        missing = sorted(names - have - self._local_names())
        if not missing:
            return
        if finder.imports:
            imp = finder.imports[0]
            assert not isinstance(imp.names, cst.ImportStar)
            seq = _ImportSeq(imp)
            for name in missing:
                seq.add(name)
            self._replace(imp, seq.build())
            return
        stmt = cst.parse_statement(f"from inkflow import {', '.join(missing)}\n")
        body = list(self.module.body)
        insert_at = 0
        for i, node in enumerate(body):
            if _is_import(node) or _is_docstring(node, i):
                insert_at = i + 1
        body.insert(insert_at, stmt)
        self.module = self.module.with_changes(body=body)

    def _local_names(self) -> set[str]:
        """Classes defined in deck.py itself (custom animations/transitions)."""
        return {
            node.name.value
            for node in self.module.body
            if isinstance(node, cst.ClassDef)
        }


class _ImportSeq:
    """Adds names to a ``from inkflow import (...)``, keeping it sorted-ish."""

    imp: cst.ImportFrom
    names: list[cst.ImportAlias]

    def __init__(self, imp: cst.ImportFrom) -> None:
        self.imp = imp
        self.names = list(cast("Sequence[cst.ImportAlias]", imp.names))

    def add(self, name: str) -> None:
        alias = cst.ImportAlias(name=cst.Name(name))
        # Insert in case-sensitive sorted position, as isort/ruff would.
        keys = [_alias_key(a) for a in self.names]
        pos = next((i for i, k in enumerate(keys) if k > _sort_key(name)), len(keys))
        self.names.insert(pos, alias)

    def build(self) -> cst.ImportFrom:
        multiline = self.imp.lpar is not None and any(
            isinstance(a.comma, cst.Comma)
            and isinstance(a.comma.whitespace_after, cst.ParenthesizedWhitespace)
            for a in cast("Sequence[cst.ImportAlias]", self.imp.names)
        )
        template = None
        if multiline:
            for a in cast("Sequence[cst.ImportAlias]", self.imp.names):
                if isinstance(a.comma, cst.Comma) and isinstance(
                    a.comma.whitespace_after, cst.ParenthesizedWhitespace
                ):
                    template = a.comma.whitespace_after
                    break
        original = cast("Sequence[cst.ImportAlias]", self.imp.names)
        last_comma = original[-1].comma if original else cst.MaybeSentinel.DEFAULT
        out: list[cst.ImportAlias] = []
        for i, alias in enumerate(self.names):
            if i < len(self.names) - 1:
                ws = template if template is not None else cst.SimpleWhitespace(" ")
                out.append(alias.with_changes(comma=cst.Comma(whitespace_after=ws)))
            elif isinstance(last_comma, cst.Comma):
                # The original last comma carries the newline before ")".
                out.append(alias.with_changes(comma=last_comma))
            else:
                out.append(alias.with_changes(comma=cst.MaybeSentinel.DEFAULT))
        return self.imp.with_changes(names=out)


def _sort_key(name: str) -> tuple[int, str]:
    # ruff/isort order: CONSTANTS, Classes, functions/modules.
    if name.isupper():
        return (0, name)
    if name[:1].isupper():
        return (1, name)
    return (2, name)


def _alias_key(alias: cst.ImportAlias) -> tuple[int, str]:
    name = alias.name
    return _sort_key(name.value if isinstance(name, cst.Name) else "")


def _is_import(node: cst.CSTNode) -> bool:
    return isinstance(node, cst.SimpleStatementLine) and any(
        isinstance(s, cst.Import | cst.ImportFrom) for s in node.body
    )


def _is_docstring(node: cst.CSTNode, index: int) -> bool:
    return (
        index == 0
        and isinstance(node, cst.SimpleStatementLine)
        and len(node.body) == 1
        and isinstance(node.body[0], cst.Expr)
        and isinstance(node.body[0].value, cst.SimpleString)
    )


def _check_index(index: int, n: int) -> None:
    if not 0 <= index < n:
        raise DeckEditError(f"index {index} out of range")


def _py_str(value: str) -> str:
    import json

    return json.dumps(value, ensure_ascii=False)


def _src_arg(call: cst.Call) -> cst.Arg | None:
    if call.args and call.args[0].keyword is None:
        return call.args[0]
    return _kwarg(call, "src")


def _set_arg(call: cst.Call, name: str, code: str | None) -> cst.Call:
    if name == "src":
        arg = _src_arg(call)
        if arg is None or code is None:
            raise DeckEditError("a slide's src cannot be removed")
        new_args = [
            a.with_changes(value=cst.parse_expression(code)) if a is arg else a
            for a in call.args
        ]
        return call.with_changes(args=new_args)
    seq = _Seq(call)
    for i, item in enumerate(seq.items):
        arg = cast("cst.Arg", item.node)
        if arg.keyword is not None and arg.keyword.value == name:
            if code is None:
                seq.remove(i)
            else:
                item.node = arg.with_changes(value=cst.parse_expression(code))
            return cast("cst.Call", seq.build())
    if code is None:
        return call
    seq.insert(
        len(seq.items),
        cst.Arg(
            value=cst.parse_expression(code),
            keyword=cst.Name(name),
            equal=cst.AssignEqual(
                whitespace_before=cst.SimpleWhitespace(""),
                whitespace_after=cst.SimpleWhitespace(""),
            ),
        ),
    )
    return cast("cst.Call", seq.build())
