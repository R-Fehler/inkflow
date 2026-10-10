"""Edits to the shapes of a draw.io diagram, made on the slide.

With "Edit shapes here" on, the editor selects the shapes of a diagram drawn
into its slide (drawio_inline.py) and edits them in the diagram's source,
the ``<mxfile>`` in the picture's ``content``: a shape's geometry, label and
colours, or the shape itself. The source stays draw.io's to read, so the
diagram keeps opening in draw.io as before.

draw.io draws the picture from the source, and the editor asks it to (a
hidden draw.io frame, then ``drawio-save`` in the same undo step). Until it
does, or when draw.io cannot be reached, the picture is patched here so the
slide shows the change at once: a moved shape's drawing is put under a
transform (``data-drawn-geometry`` keeps the box it was drawn at), a
relabelled one shows its new text, a recoloured one its colour, a deleted one
is gone. draw.io's own arrows catch up when it next draws the diagram.
"""

from __future__ import annotations

import html
import re
from collections.abc import Iterable
from typing import cast

from lxml import etree

from inkflow import drawio, ns
from inkflow.drawio_inline import DRAWN_GEOMETRY, DiagramMode, drawn_svg
from inkflow.editor.provenance import is_element
from inkflow.svgio import SvgElement, parse_svg, serialize_svg


class DiagramEditError(ValueError):
    pass


# Colours a shape's style can take, and what they paint in its drawing.
STYLE_KEYS = {
    "fillColor": "fill",
    "strokeColor": "stroke",
    "fontColor": "color",
    "strokeWidth": "stroke-width",
    "opacity": "opacity",
}
_COLOR = re.compile(r"^(#[0-9a-fA-F]{6}|none)$")


def apply_cell_ops(data: bytes, ops: Iterable[dict[str, object]]) -> bytes:
    """``data`` (a ``*.drawio.svg``) with the ops applied to its source, and
    its picture patched to match until draw.io redraws it."""
    try:
        picture = parse_svg(data)
    except etree.XMLSyntaxError as exc:
        raise DiagramEditError(f"not an SVG: {exc}") from exc
    content = picture.get("content")
    if not content or not content.lstrip().startswith("<mxfile"):
        raise DiagramEditError("this SVG has no draw.io diagram inside")
    try:
        mxfile = drawio.model(content)
    except (drawio.DrawioError, etree.XMLSyntaxError) as exc:
        raise DiagramEditError(str(exc)) from exc
    for op in ops:
        cell_id = op.get("cell")
        if not isinstance(cell_id, str):
            raise DiagramEditError("which shape?")
        kind = op.get("kind")
        if kind == "cell-geometry":
            _geometry(mxfile, picture, cell_id, op)
        elif kind == "cell-delete":
            _delete(mxfile, picture, cell_id)
        elif kind == "cell-style":
            _style(mxfile, picture, cell_id, op)
        elif kind == "cell-label":
            _label(mxfile, picture, cell_id, op.get("text"))
        else:
            raise DiagramEditError(
                "that change to a diagram's shape is made in draw.io (Edit diagram)"
            )
    picture.set("content", etree.tostring(mxfile, encoding="unicode"))
    return serialize_svg(picture).encode("utf-8")


def _cell(mxfile: SvgElement, cell_id: str) -> tuple[SvgElement, SvgElement]:
    found = drawio.cell_elements(mxfile).get(cell_id)
    if found is None or found[1].get("vertex") != "1":
        raise DiagramEditError(f"the diagram has no shape {cell_id!r}")
    return found


def _drawn(picture: SvgElement, cell_id: str) -> SvgElement | None:
    for el in picture.iter():
        if is_element(el) and el.get("data-cell-id") == cell_id:
            return el
    return None


def _number(op: dict[str, object], key: str) -> float:
    value = op.get(key)
    if not isinstance(value, int | float):
        raise DiagramEditError(f"{key} must be a number")
    return float(value)


def _fmt(value: float) -> str:
    return f"{round(value, 2):g}"


# ── Geometry ──


def _geometry(
    mxfile: SvgElement, picture: SvgElement, cell_id: str, op: dict[str, object]
) -> None:
    """A shape's new box, in page coordinates (``x y width height``); the
    picture's drawing of it moves by ``offset``, where the page sits on the
    picture (draw.io crops its pictures to the drawing)."""
    _, inner = _cell(mxfile, cell_id)
    box = tuple(_number(op, k) for k in ("x", "y", "width", "height"))
    if box[2] <= 0 or box[3] <= 0:
        raise DiagramEditError("a shape needs a size")
    before = drawio.cells(etree.tostring(mxfile, encoding="unicode"))
    cell = before[cell_id]
    parent = before.get(inner.get("parent") or "")
    px, py = (parent.box[0], parent.box[1]) if parent and parent.box else (0, 0)
    geometry = inner.find("mxGeometry")
    if geometry is None:
        geometry = etree.SubElement(inner, "mxGeometry", {"as": "geometry"})
    geometry.set("x", _fmt(box[0] - px))
    geometry.set("y", _fmt(box[1] - py))
    geometry.set("width", _fmt(box[2]))
    geometry.set("height", _fmt(box[3]))
    # Shapes inside it move with it (their geometry is relative to it).
    old = cell.box
    drawn = _drawn(picture, cell_id)
    if drawn is None or old is None:
        return
    offset = op.get("offset")
    if not isinstance(offset, list) or len(cast("list[object]", offset)) != 2:
        return
    ox, oy = (float(cast("float", v)) for v in cast("list[object]", offset))
    shown = drawn.get(DRAWN_GEOMETRY)
    if shown is None:
        shown = " ".join(_fmt(v) for v in old)
        drawn.set(DRAWN_GEOMETRY, shown)
    sx0, sy0, sw0, sh0 = (float(v) for v in shown.split())
    sx = box[2] / sw0 if sw0 else 1.0
    sy = box[3] / sh0 if sh0 else 1.0
    # Its drawing at (shown + offset) goes to (box + offset).
    tx = box[0] + ox - sx * (sx0 + ox)
    ty = box[1] + oy - sy * (sy0 + oy)
    drawn.set(
        "transform",
        f"matrix({_fmt(sx)} 0 0 {_fmt(sy)} {_fmt(tx)} {_fmt(ty)})",
    )


# ── Removing ──


def _delete(mxfile: SvgElement, picture: SvgElement, cell_id: str) -> None:
    """The shape, the shapes inside it, and the arrows to or from any of them."""
    _cell(mxfile, cell_id)
    elements = drawio.cell_elements(mxfile)
    gone = {cell_id}
    changed = True
    while changed:
        changed = False
        for other, (_, inner) in elements.items():
            if other in gone:
                continue
            if (
                inner.get("parent") in gone
                or inner.get("source") in gone
                or inner.get("target") in gone
            ):
                gone.add(other)
                changed = True
    for other in gone:
        outer, _ = elements[other]
        parent = outer.getparent()
        if parent is not None:
            parent.remove(outer)
        drawn = _drawn(picture, other)
        if drawn is not None and (up := drawn.getparent()) is not None:
            up.remove(drawn)


# ── Style ──


def _style_map(style: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for part in style.split(";"):
        if not part:
            continue
        key, eq, value = part.partition("=")
        out.append((key, value) if eq else (key, ""))
    return out


def _style_text(pairs: list[tuple[str, str]]) -> str:
    return "".join(f"{k}={v};" if v != "" or "=" in k else f"{k};" for k, v in pairs)


def _style(
    mxfile: SvgElement, picture: SvgElement, cell_id: str, op: dict[str, object]
) -> None:
    _, inner = _cell(mxfile, cell_id)
    key = op.get("key")
    value = op.get("value")
    if key not in STYLE_KEYS:
        raise DiagramEditError(f"cannot set {key!r} on a diagram shape")
    if key in ("fillColor", "strokeColor", "fontColor"):
        if not isinstance(value, str) or not _COLOR.match(value):
            raise DiagramEditError(f"{key} must be a #rrggbb colour or none")
    elif not isinstance(value, int | float) or value < 0:
        raise DiagramEditError(f"{key} must be a number")
    text = _fmt(value) if isinstance(value, int | float) else str(value)
    if key == "opacity":
        text = _fmt(min(100.0, float(cast("float", value)) * 100))
    pairs = [(k, v) for k, v in _style_map(inner.get("style") or "") if k != key]
    pairs.append((str(key), text))
    inner.set("style", _style_text(pairs))
    drawn = _drawn(picture, cell_id)
    if drawn is not None:
        _paint(drawn, str(key), value)


def _own(drawn: SvgElement) -> list[SvgElement]:
    """The elements drawing this shape (not the shapes inside it)."""
    out: list[SvgElement] = []
    for el in drawn.iterdescendants():
        if not is_element(el):
            continue
        holder = next(
            (a for a in el.iterancestors() if a.get("data-cell-id") is not None),
            None,
        )
        if holder is drawn and el.get("data-cell-id") is None:
            out.append(el)
    return out


def _paint(drawn: SvgElement, key: str, value: object) -> None:
    prop = STYLE_KEYS[key]
    own = _own(drawn)
    label = [
        el for el in own if any(a.tag.endswith("switch") for a in el.iterancestors())
    ]
    shapes = [el for el in own if el not in label and not el.tag.endswith("switch")]
    if prop == "opacity":
        drawn.set("opacity", _fmt(float(cast("float", value))))
        return
    if prop == "color":
        for el in label:
            if el.tag.endswith("}text"):
                _set_style(el, "fill", str(value))
            elif "color" in (el.get("style") or ""):
                _set_style(el, "color", str(value))
        return
    for el in shapes:
        if prop == "stroke-width":
            if el.get("stroke") not in (None, "none") or "stroke" in (
                el.get("style") or ""
            ):
                _set_style(el, "stroke-width", _fmt(float(cast("float", value))))
        elif el.get(prop) not in (None, "none"):
            _set_style(el, prop, str(value))


def _set_style(el: SvgElement, prop: str, value: str) -> None:
    decls = [
        d
        for d in (el.get("style") or "").split(";")
        if d.strip() and d.split(":", 1)[0].strip() != prop
    ]
    decls.append(f"{prop}: {value}")
    el.set("style", "; ".join(d.strip() for d in decls))
    if el.get(prop) is not None:
        el.set(prop, value)


# ── Label ──


def _label(mxfile: SvgElement, picture: SvgElement, cell_id: str, text: object) -> None:
    if not isinstance(text, str):
        raise DiagramEditError("a label is text")
    outer, inner = _cell(mxfile, cell_id)
    html_label = "html=1" in (inner.get("style") or "")
    value = (
        "<br>".join(html.escape(line) for line in text.split("\n"))
        if html_label
        else text
    )
    if outer is inner:
        inner.set("value", value)
    else:
        outer.set("label", value)
    drawn = _drawn(picture, cell_id)
    if drawn is None:
        return
    for el in _own(drawn):
        if el.tag.endswith("}text"):
            for kid in list(el):
                el.remove(kid)
            el.text = text.replace("\n", " ")
        elif etree.QName(el).localname == "div" and not any(
            etree.QName(k).localname == "div" for k in el
        ):
            # The innermost <div> of draw.io's HTML label holds the text.
            for kid in list(el):
                el.remove(kid)
            lines = text.split("\n")
            el.text = lines[0]
            for line in lines[1:]:
                br = etree.SubElement(el, el.tag.replace("div", "br"))
                br.tail = line


# ── Converting a diagram into the slide's own shapes (one way) ──

BACKUP = f"{{{ns.INKFLOW}}}drawio-backup"
"""On shapes converted from a diagram: the draw.io file kept as a backup,
relative to the slide's SVG ("Restore diagram" brings it back)."""
BACKUP_VIEWBOX = f"{{{ns.INKFLOW}}}drawio-viewbox"
BACKUP_MODE = f"{{{ns.INKFLOW}}}drawio-mode"

_CELL_DATA = ("data-cell-id", "data-cell-kind", "data-cell-geometry", DRAWN_GEOMETRY)


def converted(
    image: SvgElement, diagram: SvgElement, mode: DiagramMode, href: str
) -> SvgElement:
    """A group of the slide's own shapes drawing the diagram ``image`` shows,
    where it shows it. Its id stays the picture's and each shape keeps the
    name it had drawn into the slide (``<id>-<cell>``), so animations and
    arrows attached to them carry over."""
    prefix = image.get("id") or "diagram"
    drawn = drawn_svg(image, diagram, prefix, href, mode)
    group = image.makeelement(f"{{{ns.SVG}}}g", {})
    group.set("id", prefix)
    for name in ("class", "style", "opacity", "display", ns.INKFLOW_LOCKED):
        value = drawn.get(name)
        if value is not None:
            group.set(name, value)
    box = [float(v) for v in (drawn.get("viewBox") or "0 0 1 1").split()]
    group.set(
        "transform",
        " ".join(filter(None, [image.get("transform"), _fit(image, box)])),
    )
    group.set(BACKUP_VIEWBOX, " ".join(_fmt(v) for v in box))
    group.set(BACKUP_MODE, str(mode))
    for kid in list(drawn):
        group.append(kid)
    _flatten(group)
    labels: list[SvgElement] = []
    for el in group.iter():
        if not is_element(el):
            continue
        for name in _CELL_DATA:
            if name in el.attrib:
                del el.attrib[name]
        if etree.QName(el).localname == "switch":
            labels.append(el)
    for label in labels:  # (settling one replaces it: not while iterating)
        _settle_label(label)
    return group


def _fit(image: SvgElement, box: list[float]) -> str:
    """The transform drawing the viewBox ``box`` into the picture's box, as
    ``preserveAspectRatio`` places it (meet; slice is drawn uncropped)."""

    def num(name: str) -> float:
        try:
            return float(image.get(name) or 0)
        except ValueError:
            return 0.0

    x, y, w, h = num("x"), num("y"), num("width"), num("height")
    vx, vy, vw, vh = box
    if not vw or not vh or not w or not h:
        return ""
    par = (image.get("preserveAspectRatio") or "xMidYMid meet").split()
    if par[0] == "none":
        sx, sy, ax, ay = w / vw, h / vh, 0.0, 0.0
    else:
        s = max(w / vw, h / vh) if par[-1] == "slice" else min(w / vw, h / vh)
        sx = sy = s
        align = par[0]
        ax = {"xMin": 0.0, "xMax": w - vw * s}.get(align[:4], (w - vw * s) / 2)
        ay = {"YMin": 0.0, "YMax": h - vh * s}.get(align[4:], (h - vh * s) / 2)
    return (
        f"matrix({_fmt(sx)} 0 0 {_fmt(sy)} "
        + f"{_fmt(x + ax - sx * vx)} {_fmt(y + ay - sy * vy)})"
    )


def _flatten(group: SvgElement) -> None:
    """draw.io nests every shape in its root cell and a layer: with one
    layer its shapes become the group's children; several stay groups."""
    for top in [k for k in group if etree.QName(k).localname == "g"]:
        root_cell = top.find("{*}g[@data-cell-id]")
        if root_cell is None:
            continue
        layers = [k for k in root_cell if k.get("data-cell-id") is not None]
        at = list(group).index(top)
        group.remove(top)
        if len(layers) == 1:
            for kid in list(layers[0]):
                group.insert(at, kid)
                at += 1
        else:
            for layer in layers:
                group.insert(at, layer)
                at += 1
    # draw.io's notice for viewers without HTML labels ("Text is not SVG"),
    # positioned against a page the slide does not have.
    for kid in list(group):
        if etree.QName(kid).localname == "switch" and kid.find(".//{*}a") is not None:
            group.remove(kid)


_PX = re.compile(r"(margin-left|padding-top|width)\s*:\s*(-?[\d.]+)px")


def _settle_label(switch: SvgElement) -> None:
    """A label as the slide's own text: plain short labels become the SVG
    ``<text>`` draw.io writes beside its HTML (editable in place); others keep
    the HTML, in a frame around the label instead of draw.io's whole page."""
    fo = switch.find("{*}foreignObject")
    text = switch.find("{*}text")
    if fo is None:
        return
    divs = [el for el in fo.iter() if etree.QName(el).localname == "div"]
    inner = divs[-1] if divs else None
    plain = (
        inner is not None
        and len(inner) == 0
        and "\n" not in (inner.text or "")
        and all(len([k for k in d if is_element(k)]) <= 1 for d in divs)
        # An SVG <text> has no background box (an arrow's label has one).
        and not any("background" in (d.get("style") or "") for d in divs)
    )
    label = (inner.text or "").strip() if inner is not None else ""
    parent = switch.getparent()
    if (
        plain
        and text is not None
        and parent is not None
        and "".join(str(t) for t in text.itertext()).strip() == label
    ):
        parent.replace(switch, text)
        return
    outer = divs[0] if divs else None
    if outer is None:
        return
    style = outer.get("style") or ""
    found = {m.group(1): float(m.group(2)) for m in _PX.finditer(style)}
    left, top = found.get("margin-left", 0.0), found.get("padding-top", 0.0)
    width = found.get("width", 0.0)
    if width <= 1:  # a label that does not wrap: centred on margin-left
        x, width = left - 150, 300.0
    else:
        x = left
    y, height = top - 60, 120.0
    fo.set("x", _fmt(x))
    fo.set("y", _fmt(y))
    fo.set("width", _fmt(width))
    fo.set("height", _fmt(height))
    shift = {"margin-left": x, "padding-top": y, "width": 0.0}

    def moved(m: re.Match[str]) -> str:
        return f"{m.group(1)}: {_fmt(float(m.group(2)) - shift[m.group(1)])}px"

    outer.set("style", _PX.sub(moved, style))


_N = r"([-\d.e]+)"
_SCALE_MOVE = re.compile(
    rf"matrix\(\s*{_N}[ ,]+0[ ,]+0[ ,]+{_N}[ ,]+{_N}[ ,]+{_N}\s*\)"
)


def restored(group: SvgElement, href: str) -> SvgElement:
    """The picture of a diagram converted into ``group``, back in its place."""
    image = group.makeelement(f"{{{ns.SVG}}}image", {})
    image.set("href", href)
    vx, vy, vw, vh = (
        float(v) for v in (group.get(BACKUP_VIEWBOX) or "0 0 1 1").split()
    )
    transform = (group.get("transform") or "").strip()
    match = _SCALE_MOVE.fullmatch(transform)
    if match:
        sx, sy, tx, ty = (float(v) for v in match.groups())
        image.set("x", _fmt(tx + sx * vx))
        image.set("y", _fmt(ty + sy * vy))
        image.set("width", _fmt(sx * vw))
        image.set("height", _fmt(sy * vh))
    else:
        image.set("x", _fmt(vx))
        image.set("y", _fmt(vy))
        image.set("width", _fmt(vw))
        image.set("height", _fmt(vh))
        if transform:
            image.set("transform", transform)
    image.set("preserveAspectRatio", "xMidYMid meet")
    for name in ("id", "style", "opacity", "display", ns.INKFLOW_LOCKED):
        value = group.get(name)
        if value is not None:
            image.set(name, value)
    mode = group.get(BACKUP_MODE) or ""
    if mode in (DiagramMode.INLINE, DiagramMode.THEMED):
        image.set(ns.INKFLOW_DRAWIO, mode)
    return image
