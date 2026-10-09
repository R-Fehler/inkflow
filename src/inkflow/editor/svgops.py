"""Write-back operations on one source SVG file.

Each operation names its target by the locator path the pipeline stamped on the
rendered element (see ``provenance``). A batch resolves every target before
applying anything, so a delete early in the batch cannot shift the meaning of a
later locator. The file is parsed and re-serialised with the same hardened lxml
parser the pipeline uses; only the touched nodes change.
"""

from __future__ import annotations

import copy
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from lxml import etree

from inkflow import ns
from inkflow.colors import SVG_TOKENS
from inkflow.editor.provenance import PROVENANCE_ATTRS, is_element, locate
from inkflow.svgio import SvgElement, svg_parser


class SvgOpError(Exception):
    """An operation that cannot be applied (bad locator, malformed input)."""


def file_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


# ── File round trip ─────────────────────────────────────────────────────────────


@dataclass
class SvgFile:
    path: Path
    tree: etree._ElementTree  # pyright: ignore[reportPrivateUsage]
    declaration: bool

    @classmethod
    def from_bytes(cls, path: Path, data: bytes) -> SvgFile:
        try:
            root = etree.fromstring(data, parser=svg_parser())
        except etree.XMLSyntaxError as exc:
            raise SvgOpError(f"invalid SVG {path}: {exc}") from exc
        return cls(path, root.getroottree(), data.lstrip().startswith(b"<?xml"))

    @property
    def root(self) -> SvgElement:
        return self.tree.getroot()

    def to_bytes(self) -> bytes:
        data = etree.tostring(
            self.tree,
            xml_declaration=self.declaration,
            encoding="UTF-8",
        )
        return data if data.endswith(b"\n") else data + b"\n"


# ── Operations ──────────────────────────────────────────────────────────────────

_SVG = f"{{{ns.SVG}}}"
_XLINK_HREF = f"{{{ns.XLINK}}}href"
_ALLOWED_TAGS = frozenset(
    _SVG + t
    for t in (
        "g",
        "rect",
        "circle",
        "ellipse",
        "line",
        "polyline",
        "polygon",
        "path",
        "text",
        "tspan",
        "image",
        "defs",
        "marker",
        "linearGradient",
        "radialGradient",
        "stop",
        "title",
        "desc",
        "use",
        "clipPath",
    )
)
_ID_RE = re.compile(r"^[A-Za-z_][\w.-]*$")
_TOKEN_CLASS = re.compile(r"^inkflow-(fill|stroke)-([\w-]+)$")


@dataclass
class OpResult:
    ids: dict[str, str] = field(default_factory=dict)
    """Ids assigned during the batch: request-local key → id."""
    structural: bool = False
    """Whether element positions changed (locators into this file are stale)."""


def _resolve(root: SvgElement, loc: object) -> SvgElement:
    if not isinstance(loc, str):
        raise SvgOpError("missing locator")
    path = loc.partition(":")[2] if ":" in loc else loc
    try:
        el = locate(root, path)
    except (LookupError, ValueError) as exc:
        raise SvgOpError(str(exc)) from exc
    if el is root:
        raise SvgOpError("the root element cannot be edited")
    return el


def all_ids(root: SvgElement) -> set[str]:
    return {i for el in root.iter() if is_element(el) and (i := el.get("id"))}


def unique_id(root: SvgElement, base: str, taken: set[str] | None = None) -> str:
    ids = taken if taken is not None else all_ids(root)
    base = re.sub(r"[^\w.-]", "-", base).strip("-") or "el"
    if not base[0].isalpha() and base[0] != "_":
        base = f"el-{base}"
    if base not in ids:
        ids.add(base)
        return base
    n = 2
    while f"{base}-{n}" in ids:
        n += 1
    ids.add(f"{base}-{n}")
    return f"{base}-{n}"


def _local(tag: object) -> str:
    return tag.split("}")[-1] if isinstance(tag, str) else ""


def _drop(el: SvgElement, name: str) -> None:
    if name in el.attrib:
        del el.attrib[name]


def _parse_style(style: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in style.split(";"):
        name, sep, value = part.partition(":")
        if sep and name.strip():
            out[name.strip()] = value.strip()
    return out


def _format_style(props: dict[str, str]) -> str:
    return ";".join(f"{k}:{v}" for k, v in props.items())


def set_style(el: SvgElement, props: dict[str, str | None]) -> None:
    """Set CSS properties in ``style`` (``None`` removes), dropping any
    presentation attribute of the same name so there is a single source."""
    style = _parse_style(el.get("style", ""))
    for name, value in props.items():
        if value is None:
            style.pop(name, None)
        else:
            style[name] = value
        if name in el.attrib:
            del el.attrib[name]
    if style:
        el.set("style", _format_style(style))
    elif "style" in el.attrib:
        del el.attrib["style"]


def _paint(el: SvgElement, prop: str, token: object, color: object) -> None:
    if prop not in ("fill", "stroke"):
        raise SvgOpError(f"cannot paint {prop!r}")
    classes = [
        c
        for c in el.get("class", "").split()
        if not ((m := _TOKEN_CLASS.match(c)) and m.group(1) == prop)
    ]
    if isinstance(token, str):
        if token not in SVG_TOKENS:
            raise SvgOpError(f"unknown colour token {token!r}")
        classes.append(f"inkflow-{prop}-{token}")
        set_style(el, {prop: None})
    elif isinstance(color, str):
        if not re.fullmatch(r"#[0-9a-fA-F]{3,8}|none|transparent|currentColor", color):
            raise SvgOpError(f"invalid colour {color!r}")
        set_style(el, {prop: color})
    else:
        set_style(el, {prop: None})
    if classes:
        el.set("class", " ".join(classes))
    elif "class" in el.attrib:
        del el.attrib["class"]


def _set_text(el: SvgElement, lines: list[str], line_height: float | None) -> None:
    if _local(el.tag) != "text":
        raise SvgOpError("only <text> elements hold editable text")
    tspans = [c for c in el if _local(c.tag) == "tspan"]
    if not tspans:
        for child in list(el):
            el.remove(child)
        if len(lines) == 1:
            el.text = lines[0]
            return
        el.text = None
        x = el.get("x", "0")
        for i, line in enumerate(lines):
            span = etree.SubElement(el, _SVG + "tspan")
            span.set("x", x)
            if i == 0:
                span.set("y", el.get("y", "0"))
            else:
                span.set("dy", "1.2em")
            span.text = line
        return
    # Keep the first span's attributes as the template for every line, which is
    # how Inkscape writes multi-line text (one tspan per line, absolute x/y).
    first = tspans[0]
    el.text = None
    for span in tspans:
        el.remove(span)
    x = first.get("x")
    y = first.get("y")
    step = line_height
    if step is None and len(tspans) > 1:
        try:
            step = float(tspans[1].get("y", "")) - float(y or "")
        except ValueError:
            step = None
    for i, line in enumerate(lines):
        span = copy.deepcopy(first)
        for child in list(span):
            span.remove(child)
        span.text = line
        span.tail = None
        if i > 0:
            if x is not None:
                span.set("x", x)
            if y is not None and step is not None:
                span.set("y", f"{float(y) + i * step:g}")
                _drop(span, "dy")
            else:
                _drop(span, "y")
                span.set("dy", "1.2em")
            if "id" in span.attrib:
                del span.attrib["id"]
        el.append(span)


def _sanitize(el: SvgElement) -> None:
    for node in list(el.iter()):
        if not is_element(node):
            continue
        if node.tag not in _ALLOWED_TAGS:
            raise SvgOpError(f"element <{_local(node.tag)}> cannot be inserted")
        for name in list(node.attrib):
            local = str(name).split("}")[-1].lower()
            value = node.get(name) or ""
            if (
                local.startswith("on")
                or local in PROVENANCE_ATTRS
                or (local == "href" and value.strip().lower().startswith("javascript:"))
            ):
                del node.attrib[name]


def _parse_fragment(xml: str) -> SvgElement:
    wrapped = (
        f'<svg xmlns="{ns.SVG}" xmlns:xlink="{ns.XLINK}" '
        f'xmlns:inkflow="{ns.INKFLOW}">{xml}</svg>'
    )
    try:
        holder = etree.fromstring(wrapped.encode(), parser=svg_parser())
    except etree.XMLSyntaxError as exc:
        raise SvgOpError(f"malformed element: {exc}") from exc
    if len(holder) != 1:
        raise SvgOpError("insert exactly one element")
    el = holder[0]
    _sanitize(el)
    return el


def _renumber_ids(el: SvgElement, root: SvgElement) -> None:
    taken = all_ids(root)
    for node in el.iter():
        if is_element(node) and node.get("id"):
            node.set("id", unique_id(root, node.get("id", ""), taken))


def _translate(el: SvgElement, dx: float, dy: float) -> None:
    if dx == 0 and dy == 0:
        return
    existing = el.get("transform")
    move = f"translate({dx:g},{dy:g})"
    el.set("transform", f"{move} {existing}" if existing else move)


def apply_ops(svg: SvgFile, ops: list[dict[str, object]]) -> OpResult:
    """Apply one batch of operations to ``svg`` in place."""
    root = svg.root
    result = OpResult()
    # Resolve every target first, so structural changes cannot shift them.
    targets: list[SvgElement | None] = []
    for op in ops:
        kind = op.get("kind")
        if kind == "insert":
            parent_loc = op.get("parent")
            path = str(parent_loc).partition(":")[2] if parent_loc else ""
            targets.append(root if not path else _resolve(root, parent_loc))
        elif kind == "ensure-marker":
            targets.append(root)
        else:
            targets.append(_resolve(root, op.get("loc")))

    for op, el in zip(ops, targets, strict=True):
        assert el is not None
        kind = op.get("kind")
        if kind == "attrs":
            values = cast("dict[str, object]", op.get("set") or {})
            for name, value in values.items():
                if name in ("id",) or name.lower().startswith("on"):
                    raise SvgOpError(f"attribute {name!r} cannot be set here")
                if value is None:
                    _drop(el, name)
                else:
                    el.set(name, str(value))
        elif kind == "style":
            values = cast("dict[str, object]", op.get("set") or {})
            set_style(el, {k: None if v is None else str(v) for k, v in values.items()})
        elif kind == "paint":
            _paint(el, str(op.get("prop")), op.get("token"), op.get("color"))
        elif kind == "text":
            lines = op.get("lines")
            if not isinstance(lines, list) or not all(
                isinstance(s, str) for s in cast("list[object]", lines)
            ):
                raise SvgOpError("text needs a list of lines")
            lh = op.get("lineHeight")
            _set_text(
                el,
                cast("list[str]", lines) or [""],
                float(cast("float", lh)) if isinstance(lh, int | float) else None,
            )
        elif kind == "id":
            new_id = op.get("id")
            if not isinstance(new_id, str) or not _ID_RE.match(new_id):
                raise SvgOpError(f"invalid id {new_id!r}")
            if new_id != el.get("id") and new_id in all_ids(root):
                raise SvgOpError(f"id {new_id!r} is already used in this file")
            el.set("id", new_id)
        elif kind == "ensure-id":
            if not el.get("id"):
                el.set("id", unique_id(root, str(op.get("base") or _local(el.tag))))
            result.ids[str(op.get("key", op.get("loc")))] = el.get("id", "")
        elif kind == "delete":
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
            result.structural = True
        elif kind == "duplicate":
            clone = copy.deepcopy(el)
            _renumber_ids(clone, root)
            offset = cast("list[float]", op.get("offset") or [0, 0])
            _translate(clone, float(offset[0]), float(offset[1]))
            el.addnext(clone)
            clone.tail = el.tail
            if clone.get("id"):
                result.ids[str(op.get("key", "duplicate"))] = clone.get("id", "")
            result.structural = True
        elif kind == "insert":
            new = _parse_fragment(str(op.get("xml", "")))
            if not new.get("id"):
                new.set("id", unique_id(root, str(op.get("base") or _local(new.tag))))
            else:
                new.set("id", unique_id(root, new.get("id", "")))
            index = op.get("index")
            if isinstance(index, int) and 0 <= index <= len(el):
                el.insert(index, new)
            else:
                # Above the last painted child, keeping a trailing comment last.
                el.append(new)
            _fix_tail(el, new)
            result.ids[str(op.get("key", "insert"))] = new.get("id", "")
            result.structural = True
        elif kind == "order":
            _reorder(el, str(op.get("to")))
            result.structural = True
        elif kind == "ensure-marker":
            ensure_arrow_marker(root)
        else:
            raise SvgOpError(f"unknown operation {kind!r}")
    return result


ARROW_MARKER = "inkflow-arrow"


def ensure_arrow_marker(root: SvgElement) -> None:
    """Add the arrowhead ``<marker>`` new arrows reference, once per file.

    ``context-stroke`` paints the head in the line's own stroke colour, so one
    marker serves every arrow whatever its colour or theme token.
    """
    if any(el.get("id") == ARROW_MARKER for el in root.iter(_SVG + "marker")):
        return
    defs = root.find(_SVG + "defs")
    if defs is None:
        defs = etree.Element(_SVG + "defs")
        root.insert(0, defs)
        defs.tail = "\n"
    marker = _parse_fragment(
        f'<marker id="{ARROW_MARKER}" viewBox="0 0 10 10" refX="8" refY="5" '
        + 'markerWidth="4" markerHeight="4" orient="auto-start-reverse" '
        + 'markerUnits="strokeWidth">'
        + '<path d="M 0 0 L 10 5 L 0 10 z" style="fill:context-stroke;stroke:none"/>'
        + "</marker>"
    )
    defs.append(marker)


def _fix_tail(parent: SvgElement, new: SvgElement) -> None:
    """Give an inserted element the same indentation as its siblings.

    An element appended last takes over the whitespace before the closing tag,
    and the element before it gets the usual between-siblings indentation.
    """
    # The whitespace before the first child is the children's indentation.
    lead = parent.text if parent.text and "\n" in parent.text else None
    indent = "\n" + lead.rsplit("\n", 1)[1] if lead else "\n"
    prev = new.getprevious()
    if new.getnext() is None and prev is not None:
        new.tail = prev.tail or "\n"
        prev.tail = indent
    else:
        new.tail = indent
        if prev is not None and not (prev.tail or "").strip("\n "):
            prev.tail = prev.tail if prev.tail and "\n" in prev.tail else indent


def _reorder(el: SvgElement, to: str) -> None:
    parent = el.getparent()
    if parent is None:
        return
    painted = [c for c in parent if is_element(c) and c.tag in _ALLOWED_TAGS]
    painted = [c for c in painted if _local(c.tag) not in ("defs", "title", "desc")]
    pos = painted.index(el) if el in painted else -1
    if pos < 0:
        return
    tail = el.tail
    if to == "front":
        target = painted[-1]
        if target is not el:
            target.addnext(el)
    elif to == "back":
        target = painted[0]
        if target is not el:
            target.addprevious(el)
    elif to == "forward" and pos < len(painted) - 1:
        painted[pos + 1].addnext(el)
    elif to == "backward" and pos > 0:
        painted[pos - 1].addprevious(el)
    else:
        return
    el.tail = tail


def group(svg: SvgFile, locs: list[str]) -> str:
    """Wrap the elements at ``locs`` (same parent) in a new ``<g>``; returns its id."""
    root = svg.root
    els = [_resolve(root, loc) for loc in locs]
    if not els:
        raise SvgOpError("nothing to group")
    parent = els[0].getparent()
    if parent is None or any(e.getparent() is not parent for e in els):
        raise SvgOpError("only siblings can be grouped")
    els.sort(key=parent.index)
    g = etree.Element(_SVG + "g")
    g.set("id", unique_id(root, "group"))
    els[-1].addnext(g)
    g.tail = els[-1].tail
    for e in els:
        g.append(e)
    return g.get("id", "")


def ungroup(svg: SvgFile, loc: str) -> None:
    """Replace a ``<g>`` by its children, folding its transform into theirs."""
    g = _resolve(svg.root, loc)
    if _local(g.tag) != "g":
        raise SvgOpError("not a group")
    parent = g.getparent()
    if parent is None:
        raise SvgOpError("not a group")
    transform = g.get("transform")
    for child in list(g):
        if is_element(child) and transform:
            own = child.get("transform")
            child.set("transform", f"{transform} {own}" if own else transform)
        g.addprevious(child)
    parent.remove(g)


# ── Whole new files ────────────────────────────────────────────────────────────


def new_slide_svg(parent: str | None, width: float, height: float) -> bytes:
    """A blank slide SVG built on ``parent`` (an ``inkflow:parent`` value)."""
    attrs = f' inkflow:parent="{parent}"' if parent else ""
    return (
        f'<svg xmlns="{ns.SVG}" xmlns:inkflow="{ns.INKFLOW}"{attrs} '
        f'viewBox="0 0 {width:g} {height:g}" width="{width:g}" height="{height:g}">\n'
        "</svg>\n"
    ).encode()
