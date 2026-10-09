// The editing canvas: renders the current slide, picks what a click selects,
// draws selection handles, and turns drags into move / resize / rotate edits.
//
// Every rendered element carries a `data-ink` locator ("<source>:<path>") that
// names the file and position it came from (inkflow/editor/provenance.py). A
// drag previews by setting attributes on the live DOM, then sends the same
// attribute plan to the server, which writes it into that source file. The
// rebuild that follows replaces the DOM with the authoritative render.

import { applyStepInstant } from "../shared/step";
import { parseViewBox } from "../shared/viewbox";
import { h, svgEl, toast } from "./dom";
import {
    type AttrPlan,
    type Box,
    type ElementGeom,
    IDENTITY,
    invert,
    type Mat,
    mat,
    multiply,
    parseTransform,
    planMove,
    planResize,
    planRotate,
    transformBox,
    unionBoxes,
} from "./geom";
import { edit } from "./net";
import { type SnapTargets, snapBox, snapEdges, targetsFor } from "./snap";
import { currentRendered, currentSlide, ed, emit, on, sourceOf } from "./state";
import type { Selected, SvgOp } from "./types";

const canvas = document.getElementById("canvas")!;
const paper = document.getElementById("paper")!;
const host = document.getElementById("slide-host")!;
const overlay = document.getElementById("overlay") as unknown as SVGSVGElement;

const NON_ZONES = new Set(["zone-slide-number", "zone-slide-total"]);
const DRAG_THRESHOLD = 3;
const SNAP_PX = 6;

// Hooks other modules install (kept as callbacks to avoid import cycles).
export const hooks = {
    editText: (_el: SVGGraphicsElement): void => {},
    editZone: (_zone: string, _box: DOMRect): void => {},
    zoneMedia: (_zone: string): void => {},
    toolDown: (_e: PointerEvent, _pt: { x: number; y: number }): boolean =>
        false,
};

// ── Rendering ──

export function slideRoot(): SVGSVGElement | null {
    return host.querySelector(":scope > svg");
}

function viewBoxSize(): { w: number; h: number } {
    const svg = slideRoot();
    const vb = parseViewBox(svg?.getAttribute("viewBox") ?? null);
    return { w: vb.w || 1920, h: vb.h || 1080 };
}

export function scale(): number {
    const { w, h } = viewBoxSize();
    if (ed.zoom > 0) return ed.zoom;
    const pad = 48;
    const availW = Math.max(100, canvas.clientWidth - pad);
    const availH = Math.max(100, canvas.clientHeight - pad);
    return Math.min(availW / w, availH / h);
}

export function layoutPaper(): void {
    const svg = slideRoot();
    const { w, h } = viewBoxSize();
    const s = scale();
    const pw = Math.round(w * s);
    const ph = Math.round(h * s);
    paper.style.width = `${pw}px`;
    paper.style.height = `${ph}px`;
    svg?.setAttribute("width", String(pw));
    svg?.setAttribute("height", String(ph));
    overlay.setAttribute("width", String(pw));
    overlay.setAttribute("height", String(ph));
    overlay.setAttribute("viewBox", `0 0 ${pw} ${ph}`);
    canvas.classList.toggle("zoomed", ed.zoom > 0);
    drawOverlay();
}

// Remembered across a re-render so the same objects stay selected.
interface SelKey {
    loc: string;
    id: string | null;
}

export function render(): void {
    if (ed.interacting) {
        ed.renderPending = true;
        return;
    }
    ed.renderPending = false;
    const keep: SelKey[] = ed.selection.map((s) => ({
        loc: s.loc,
        id: s.el.getAttribute("id"),
    }));
    const scopeKey = ed.scope?.getAttribute("data-ink") ?? null;
    // After a structural edit, positions shifted: re-select by id only.
    const trustLoc = !ed.structuralPending;
    if (ed.rebuilt) ed.structuralPending = false;
    ed.rebuilt = false;
    const data = currentRendered();
    host.innerHTML = data ? data.svg : "";
    const hidden = currentSlide();
    if (!data && hidden && !hidden.visible) {
        // Hidden slides are not built (the presenter skips them entirely).
        host.append(
            h(
                "div",
                { class: "hidden-note" },
                h("p", {}, "This slide is hidden: the presentation skips it."),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        onclick: () =>
                            void edit({
                                action: "slide",
                                op: "hide",
                                slide: hidden.deckIndex,
                                hidden: false,
                            }),
                    },
                    "Show it again to edit",
                ),
            ),
        );
    }
    const svg = slideRoot();
    if (svg) {
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        svg.style.display = "block";
        prepareForEditing(svg);
    }
    ed.scope = scopeKey
        ? (host.querySelector(`[data-ink="${scopeKey}"]`) as SVGGElement | null)
        : null;
    ed.selection = [];
    for (const k of keep) {
        const el = findElement(k, trustLoc);
        if (el) addToSelection(el, false);
    }
    layoutPaper();
    emit("render");
    emit("selection");
}

function findElement(k: SelKey, trustLoc: boolean): SVGGraphicsElement | null {
    const svg = slideRoot();
    if (!svg) return null;
    if (k.id) {
        const byId = svg.querySelector(`[id="${CSS.escape(k.id)}"]`);
        if (byId?.hasAttribute("data-ink")) return byId as SVGGraphicsElement;
    }
    if (!trustLoc) return null;
    return svg.querySelector(
        `[data-ink="${k.loc}"]`,
    ) as SVGGraphicsElement | null;
}

// The editor shows every element by default: build state (enter animations
// starting hidden) only applies when previewing a step.
function prepareForEditing(svg: SVGSVGElement): void {
    svg.querySelectorAll("video").forEach((v) => {
        v.pause();
        v.removeAttribute("autoplay");
        // Show the frame a trimmed clip starts on, not its first one.
        const start = parseFloat(v.dataset.start ?? "");
        if (start > 0) v.currentTime = start;
    });
    if (ed.step == null) {
        svg.querySelectorAll(".anim-pending").forEach((el) => {
            el.classList.remove("anim-pending");
        });
    } else {
        applyStepInstant(svg, ed.step);
    }
    // Links in Markdown zones must not navigate away from the editor.
    svg.querySelectorAll("a").forEach((a) => {
        a.addEventListener("click", (e) => e.preventDefault());
    });
}

// ── Coordinates ──

function rootCTM(): Mat {
    const svg = slideRoot();
    const m = svg?.getScreenCTM();
    return m ? mat(m) : { ...IDENTITY };
}

function paperOrigin(): { x: number; y: number } {
    const r = paper.getBoundingClientRect();
    return { x: r.left, y: r.top };
}

// Slide user units → paper CSS px.
export function slideToPaper(): Mat {
    const o = paperOrigin();
    return multiply({ a: 1, b: 0, c: 0, d: 1, e: -o.x, f: -o.y }, rootCTM());
}

export function clientToSlide(x: number, y: number): { x: number; y: number } {
    const inv = invert(rootCTM());
    return {
        x: inv.a * x + inv.c * y + inv.e,
        y: inv.b * x + inv.d * y + inv.f,
    };
}

export function slideBox(el: Element): Box | null {
    const g = el as SVGGraphicsElement;
    if (typeof g.getBBox !== "function") return null;
    try {
        const bbox = g.getBBox();
        const ctm = g.getScreenCTM();
        if (!ctm) return null;
        const toSlide = multiply(invert(rootCTM()), mat(ctm));
        return transformBox(toSlide, {
            x: bbox.x,
            y: bbox.y,
            width: bbox.width,
            height: bbox.height,
        });
    } catch {
        return null;
    }
}

export function slideSize(): Box {
    const svg = slideRoot();
    const vb = parseViewBox(svg?.getAttribute("viewBox") ?? null);
    return { x: vb.x, y: vb.y, width: vb.w || 1920, height: vb.h || 1080 };
}

const GEOM_ATTRS = [
    "x",
    "y",
    "width",
    "height",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "x1",
    "y1",
    "x2",
    "y2",
    "transform",
];

export function elementGeom(el: SVGGraphicsElement): ElementGeom {
    const parent = el.parentElement as unknown as SVGGraphicsElement | null;
    const parentCTM = parent?.getScreenCTM?.();
    const attrs: Record<string, string | null> = {};
    for (const a of GEOM_ATTRS) attrs[a] = el.getAttribute(a);
    let box = { x: 0, y: 0, width: 0, height: 0 };
    try {
        const b = el.getBBox();
        box = { x: b.x, y: b.y, width: b.width, height: b.height };
    } catch {
        // not rendered
    }
    return {
        tag: el.localName,
        sourceTag: el.getAttribute("data-ink-tag") ?? el.localName,
        attrs,
        own: parseTransform(el.getAttribute("transform")),
        parentToSlide: parentCTM
            ? multiply(invert(rootCTM()), mat(parentCTM))
            : { ...IDENTITY },
        localBox: box,
    };
}

// ── What a click may select ──

export function isZone(el: Element): boolean {
    const id = el.getAttribute("id") ?? "";
    return id.startsWith("zone-") && !NON_ZONES.has(id);
}

export function zoneName(el: Element): string {
    return (el.getAttribute("id") ?? "").replace(/^zone-/, "");
}

// The media zone under a point, empty (its placeholder) or holding an image or
// video already: where a dropped file fills the zone instead of floating free.
export function mediaZoneAt(clientX: number, clientY: number): string | null {
    const inside = (r: DOMRect) =>
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom;
    for (const el of overlay.querySelectorAll("[data-media-zone]")) {
        if (inside(el.getBoundingClientRect()))
            return el.getAttribute("data-media-zone");
    }
    const slide = currentSlide();
    const svg = slideRoot();
    if (!slide || !svg) return null;
    for (const el of svg.querySelectorAll('[id^="zone-"]')) {
        const name = zoneName(el);
        const kind = slide.zones[name]?.kind;
        if (
            (kind === "image" || kind === "video") &&
            inside(el.getBoundingClientRect())
        )
            return name;
    }
    return null;
}

export function keyOf(el: Element): number {
    const loc = el.getAttribute("data-ink") ?? "";
    return parseInt(loc.split(":")[0] ?? "", 10);
}

function inLockedLayer(el: Element): boolean {
    return el.closest("[data-ink-locked]") !== null;
}

// The slide's own drawing (not a layout, overlay, or a file other slides share).
export function isOwn(el: Element): boolean {
    const src = sourceOf(keyOf(el));
    const slide = currentSlide();
    return (
        !!src &&
        src.role === "slide" &&
        !!slide &&
        !slide.srcShared &&
        src.writable
    );
}

export function selectable(el: Element): boolean {
    if (!el.hasAttribute("data-ink") || inLockedLayer(el)) return false;
    const src = sourceOf(keyOf(el));
    if (!src) return false;
    if (ed.layoutMode) return src.writable;
    return isOwn(el) || (el.hasAttribute("data-ink-top") && isZone(el));
}

// May the element be moved/resized here (vs. only its content edited)?
export function canTransform(el: Element): boolean {
    const src = sourceOf(keyOf(el));
    if (!src?.writable) return false;
    return ed.layoutMode || isOwn(el);
}

// The object a click at a point selects: inside an entered group, its child;
// otherwise the top-level object (or zone) under the pointer.
export function pick(x: number, y: number): SVGGraphicsElement | null {
    const svg = slideRoot();
    if (!svg) return null;
    for (const hit of document.elementsFromPoint(x, y)) {
        if (!svg.contains(hit)) continue;
        let node: Element | null = hit;
        // HTML inside a filled zone: climb to the foreignObject.
        if (!(node instanceof SVGElement)) node = node.closest("foreignObject");
        while (node && node !== svg) {
            if (ed.scope) {
                if (
                    (node.parentElement as Element | null) === ed.scope &&
                    node.hasAttribute("data-ink")
                ) {
                    return selectable(node)
                        ? (node as SVGGraphicsElement)
                        : null;
                }
            } else if (node.hasAttribute("data-ink-top") && selectable(node)) {
                return node as SVGGraphicsElement;
            }
            node = node.parentElement;
        }
    }
    return pickByBox(svg, x, y);
}

// A click that lands in a gap of a shape (between a logo's strokes, inside an
// unfilled outline) still selects it, as slide editors do: the topmost
// selectable object whose box contains the point. Slide-sized boxes are left
// out so clicking an empty area still clears the selection.
function pickByBox(
    svg: SVGSVGElement,
    x: number,
    y: number,
): SVGGraphicsElement | null {
    const pt = clientToSlide(x, y);
    const slide = slideSize();
    const pool = ed.scope
        ? [...ed.scope.children].filter((el) => el.hasAttribute("data-ink"))
        : [...svg.querySelectorAll("[data-ink-top]")];
    for (let i = pool.length - 1; i >= 0; i--) {
        const el = pool[i];
        if (!selectable(el)) continue;
        const b = slideBox(el);
        if (!b || b.width * b.height > slide.width * slide.height * 0.8)
            continue;
        if (
            pt.x >= b.x &&
            pt.x <= b.x + b.width &&
            pt.y >= b.y &&
            pt.y <= b.y + b.height
        ) {
            return el as SVGGraphicsElement;
        }
    }
    return null;
}

// ── Selection ──

function toSelected(el: SVGGraphicsElement): Selected {
    const loc = el.getAttribute("data-ink") ?? "";
    return { el, key: keyOf(el), loc };
}

export function addToSelection(el: SVGGraphicsElement, notify = true): void {
    if (ed.selection.some((s) => s.el === el)) return;
    ed.selection.push(toSelected(el));
    if (notify) {
        drawOverlay();
        emit("selection");
    }
}

export function select(els: SVGGraphicsElement[]): void {
    ed.selection = els.map(toSelected);
    drawOverlay();
    emit("selection");
}

export function clearSelection(): void {
    if (!ed.selection.length) return;
    ed.selection = [];
    drawOverlay();
    emit("selection");
}

export function selectAll(): void {
    const svg = slideRoot();
    if (!svg) return;
    const scope = ed.scope ?? svg;
    const els = [...scope.querySelectorAll("[data-ink]")].filter(
        (el) =>
            (ed.scope
                ? (el.parentElement as Element | null) === ed.scope
                : el.hasAttribute("data-ink-top")) &&
            selectable(el) &&
            (canTransform(el) || ed.scope !== null),
    ) as SVGGraphicsElement[];
    select(els);
}

export function enterGroup(g: SVGGElement | null): void {
    ed.scope = g;
    clearSelection();
    drawOverlay();
    emit("selection");
}

// ── Overlay ──

let hoverEl: Element | null = null;
let guides: { xs: number[]; ys: number[] } = { xs: [], ys: [] };
let marquee: Box | null = null;

function poly(
    points: { x: number; y: number }[],
    cls: string,
): SVGPolygonElement {
    return svgEl("polygon", {
        points: points.map((p) => `${p.x},${p.y}`).join(" "),
        class: cls,
    });
}

function elementCorners(
    el: SVGGraphicsElement,
): { x: number; y: number }[] | null {
    try {
        const b = el.getBBox();
        const ctm = el.getScreenCTM();
        if (!ctm) return null;
        const o = paperOrigin();
        const m = mat(ctm);
        return [
            { x: b.x, y: b.y },
            { x: b.x + b.width, y: b.y },
            { x: b.x + b.width, y: b.y + b.height },
            { x: b.x, y: b.y + b.height },
        ].map((p) => ({
            x: m.a * p.x + m.c * p.y + m.e - o.x,
            y: m.b * p.x + m.d * p.y + m.f - o.y,
        }));
    } catch {
        return null;
    }
}

function toPaperBox(b: Box): Box {
    return transformBox(slideToPaper(), b);
}

export function selectionBox(): Box | null {
    return unionBoxes(
        ed.selection
            .map((s) => slideBox(s.el))
            .filter((b): b is Box => b !== null),
    );
}

export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number] | "rot";

function handlePoint(h: Handle, b: Box): { x: number; y: number } {
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const r = b.x + b.width;
    const btm = b.y + b.height;
    switch (h) {
        case "nw":
            return { x: b.x, y: b.y };
        case "n":
            return { x: cx, y: b.y };
        case "ne":
            return { x: r, y: b.y };
        case "e":
            return { x: r, y: cy };
        case "se":
            return { x: r, y: btm };
        case "s":
            return { x: cx, y: btm };
        case "sw":
            return { x: b.x, y: btm };
        case "w":
            return { x: b.x, y: cy };
        case "rot":
            return { x: cx, y: b.y - 28 };
    }
}

export function drawOverlay(): void {
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    const svg = slideRoot();
    if (!svg) return;
    drawPlaceholders();
    if (ed.scope) {
        const c = elementCorners(ed.scope);
        if (c) overlay.append(poly(c, "scope-outline"));
    }
    if (hoverEl && !ed.selection.some((s) => s.el === hoverEl)) {
        const c = elementCorners(hoverEl as SVGGraphicsElement);
        if (c) overlay.append(poly(c, "hover-outline"));
    }
    for (const s of ed.selection) {
        const c = elementCorners(s.el);
        if (c) {
            overlay.append(
                poly(
                    c,
                    canTransform(s.el)
                        ? "sel-outline"
                        : "sel-outline content-only",
                ),
            );
        }
    }
    const transformable = ed.selection.filter((s) => canTransform(s.el));
    const box =
        transformable.length === ed.selection.length ? selectionBox() : null;
    if (box && ed.step == null) {
        const pb = toPaperBox(box);
        if (ed.selection.length > 1) {
            overlay.append(
                svgEl("rect", {
                    x: pb.x,
                    y: pb.y,
                    width: pb.width,
                    height: pb.height,
                    class: "group-outline",
                }),
            );
        }
        const top = handlePoint("n", pb);
        const rot = handlePoint("rot", pb);
        overlay.append(
            svgEl("line", {
                x1: top.x,
                y1: top.y,
                x2: rot.x,
                y2: rot.y,
                class: "rot-stem",
            }),
        );
        const rh = svgEl("circle", {
            cx: rot.x,
            cy: rot.y,
            r: 6,
            class: "handle rot",
        });
        rh.dataset.handle = "rot";
        overlay.append(rh);
        for (const h of HANDLES) {
            const p = handlePoint(h, pb);
            const r = svgEl("rect", {
                x: p.x - 5,
                y: p.y - 5,
                width: 10,
                height: 10,
                class: `handle h-${h}`,
            });
            r.dataset.handle = h;
            overlay.append(r);
        }
    }
    for (const x of guides.xs) {
        const p = toPaperBox({ x, y: 0, width: 0, height: slideSize().height });
        overlay.append(
            svgEl("line", {
                x1: p.x,
                y1: p.y,
                x2: p.x,
                y2: p.y + p.height,
                class: "guide",
            }),
        );
    }
    for (const y of guides.ys) {
        const p = toPaperBox({ x: 0, y, width: slideSize().width, height: 0 });
        overlay.append(
            svgEl("line", {
                x1: p.x,
                y1: p.y,
                x2: p.x + p.width,
                y2: p.y,
                class: "guide",
            }),
        );
    }
    if (marquee) {
        const p = toPaperBox(marquee);
        overlay.append(
            svgEl("rect", {
                x: p.x,
                y: p.y,
                width: p.width,
                height: p.height,
                class: "marquee",
            }),
        );
    }
}

const MEDIA_ZONES = /media|image|img|picture|photo|figure|video|logo/;

function drawPlaceholders(): void {
    const slide = currentSlide();
    if (!slide?.emptyZones || ed.step != null) return;
    for (const z of slide.emptyZones) {
        const key = parseInt(z.locator.split(":")[0] ?? "", 10);
        const src = sourceOf(key);
        if (!src || z.zone === "slide-number" || z.zone === "slide-total")
            continue;
        const own = parseTransform(z.transform);
        const box = transformBox(own, z);
        const pb = toPaperBox(box);
        // The dashed outline is only a hint and lets clicks through, so a zone
        // a drawing deliberately covers stays out of the way; the small label
        // in its corner is what adds content.
        const media = MEDIA_ZONES.test(z.zone);
        const outline = svgEl("rect", {
            x: pb.x,
            y: pb.y,
            width: pb.width,
            height: pb.height,
            rx: 4,
            class: "placeholder-outline",
        });
        if (media) outline.setAttribute("data-media-zone", z.zone);
        overlay.append(outline);
        const g = svgEl("g", { class: "placeholder" });
        const text = media ? `+ media · ${z.zone}` : `+ ${z.zone}`;
        const w = 14 + text.length * 7.2;
        const tx = pb.x + 6;
        const ty = pb.y + 6;
        g.append(svgEl("rect", { x: tx, y: ty, width: w, height: 22, rx: 11 }));
        const label = svgEl("text", {
            x: tx + w / 2,
            y: ty + 15,
            "text-anchor": "middle",
        });
        label.textContent = text;
        g.append(label);
        const title = svgEl("title");
        title.textContent = media
            ? `Add an image or video to the ${z.zone} zone`
            : `Add ${z.zone} text (Markdown)`;
        g.append(title);
        g.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (media) hooks.zoneMedia(z.zone);
            else {
                const r = paper.getBoundingClientRect();
                hooks.editZone(
                    z.zone,
                    new DOMRect(
                        r.left + pb.x,
                        r.top + pb.y,
                        pb.width,
                        pb.height,
                    ),
                );
            }
        });
        overlay.append(g);
    }
}

// ── Sending plans ──

function opsByFile(
    plans: { sel: Selected; ops: SvgOp[] }[],
): Map<string, SvgOp[]> {
    const out = new Map<string, SvgOp[]>();
    for (const { sel, ops } of plans) {
        const src = sourceOf(sel.key);
        if (!src) continue;
        const list = out.get(src.path) ?? [];
        list.push(...ops);
        out.set(src.path, list);
    }
    return out;
}

export async function sendSvgOps(
    plans: { sel: Selected; ops: SvgOp[] }[],
    label: string,
    coalesce?: string,
): Promise<boolean> {
    const slide = currentSlide();
    if (!slide) return false;
    if (ed.structuralPending) {
        toast("One moment: the last change is still being applied");
        return false;
    }
    // One request at a time, each with the hash the previous one returned
    // (held arrow keys send nudges faster than results come back).
    const run = queue.then(() => sendQueued(plans, label, coalesce));
    queue = run.catch(() => false);
    return run;
}

let queue: Promise<unknown> = Promise.resolve();

async function sendQueued(
    plans: { sel: Selected; ops: SvgOp[] }[],
    label: string,
    coalesce?: string,
): Promise<boolean> {
    const slide = currentSlide();
    if (!slide) return false;
    let ok = true;
    for (const [path, ops] of opsByFile(plans)) {
        const src = slide.sources?.find((s) => s.path === path);
        if (src && src.usedBy.length > 1 && ed.layoutMode) {
            // Layout edits change every slide built on the file; say so once.
            toast(`Edited ${src.rel}: affects ${src.usedBy.length} slides`);
        }
        const result = await edit({
            action: "svg",
            file: path,
            hash: src?.hash ?? "",
            ops,
            label,
            coalesce,
        });
        ok = ok && result.ok;
    }
    return ok;
}

export function applyPlanToDom(el: Element, plan: AttrPlan): void {
    for (const [k, v] of Object.entries(plan)) {
        if (v == null) el.removeAttribute(k);
        else el.setAttribute(k, v);
    }
}

function textChildren(el: Element): Element[] {
    return [...el.querySelectorAll("tspan")].filter(
        (t) => t.hasAttribute("x") || t.hasAttribute("y"),
    );
}

// A move as attribute ops for one element (and its positioned tspans).
export function moveOps(sel: Selected, dx: number, dy: number): SvgOp[] {
    const kids = textChildren(sel.el);
    const plan = planMove(
        elementGeom(sel.el),
        dx,
        dy,
        kids.map((k) => ({
            attrs: { x: k.getAttribute("x"), y: k.getAttribute("y") },
        })),
    );
    const ops: SvgOp[] = [{ kind: "attrs", loc: sel.loc, set: plan.attrs }];
    applyPlanToDom(sel.el, plan.attrs);
    plan.children?.forEach((p, i) => {
        const loc = kids[i].getAttribute("data-ink");
        if (loc && Object.keys(p).length) {
            ops.push({ kind: "attrs", loc, set: p });
            applyPlanToDom(kids[i], p);
        }
    });
    return ops;
}

export async function nudge(dx: number, dy: number): Promise<void> {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (!sels.length) return;
    const plans = sels.map((sel) => ({ sel, ops: moveOps(sel, dx, dy) }));
    drawOverlay();
    await sendSvgOps(plans, "Nudge", "nudge");
}

// ── Pointer interaction ──

interface Snapshot {
    sel: Selected;
    attrs: Record<string, string | null>;
    kids: { el: Element; x: string | null; y: string | null }[];
    box: Box;
    geom: ElementGeom;
}

function snapshot(sel: Selected): Snapshot {
    const attrs: Record<string, string | null> = {};
    for (const a of GEOM_ATTRS) attrs[a] = sel.el.getAttribute(a);
    return {
        sel,
        attrs,
        kids: textChildren(sel.el).map((el) => ({
            el,
            x: el.getAttribute("x"),
            y: el.getAttribute("y"),
        })),
        box: slideBox(sel.el) ?? { x: 0, y: 0, width: 0, height: 0 },
        geom: elementGeom(sel.el),
    };
}

function restore(snaps: Snapshot[]): void {
    for (const s of snaps) {
        applyPlanToDom(s.sel.el, s.attrs);
        for (const k of s.kids) {
            applyPlanToDom(k.el, { x: k.x, y: k.y });
        }
    }
}

function snapTargets(exclude: Set<Element>): SnapTargets {
    const svg = slideRoot();
    const boxes: Box[] = [];
    if (svg) {
        for (const el of svg.querySelectorAll("[data-ink-top]")) {
            if (exclude.has(el) || [...exclude].some((x) => x.contains(el)))
                continue;
            const b = slideBox(el);
            // Skip full-bleed backgrounds: their edges are the slide's own.
            if (b && b.width > 0 && b.height > 0) boxes.push(b);
        }
    }
    return targetsFor(slideSize(), boxes);
}

type Drag =
    | { kind: "move"; snaps: Snapshot[]; start: Box; targets: SnapTargets }
    | {
          kind: "resize";
          handle: Handle;
          snaps: Snapshot[];
          start: Box;
          targets: SnapTargets;
      }
    | { kind: "rotate"; snaps: Snapshot[]; center: { x: number; y: number } }
    | { kind: "marquee"; additive: boolean };

let pointer: {
    id: number;
    x: number;
    y: number;
    started: boolean;
    drag: Drag | null;
    clickTarget: SVGGraphicsElement | null;
    shift: boolean;
} | null = null;

function beginDrag(handle: Handle | null): Drag | null {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (!sels.length || sels.length !== ed.selection.length || ed.step != null)
        return null;
    const snaps = sels.map(snapshot);
    const start = unionBoxes(snaps.map((s) => s.box));
    if (!start) return null;
    const targets = snapTargets(new Set(sels.map((s) => s.el)));
    if (handle === "rot") {
        return {
            kind: "rotate",
            snaps,
            center: {
                x: start.x + start.width / 2,
                y: start.y + start.height / 2,
            },
        };
    }
    if (handle) return { kind: "resize", handle, snaps, start, targets };
    return { kind: "move", snaps, start, targets };
}

function resizedBox(
    start: Box,
    handle: Handle,
    dx: number,
    dy: number,
    keepAspect: boolean,
): Box {
    let { x, y, width, height } = start;
    if (handle.includes("w")) {
        x += dx;
        width -= dx;
    }
    if (handle.includes("e")) width += dx;
    if (handle.includes("n")) {
        y += dy;
        height -= dy;
    }
    if (handle.includes("s")) height += dy;
    if (keepAspect && start.width > 0 && start.height > 0) {
        const ratio = start.width / start.height;
        const corner = handle.length === 2;
        if (corner || handle === "e" || handle === "w") {
            const h2 = width / ratio;
            if (handle.includes("n")) y += height - h2;
            else if (!corner) y = start.y + (start.height - h2) / 2;
            height = h2;
        } else {
            const w2 = height * ratio;
            x = start.x + (start.width - w2) / 2;
            width = w2;
        }
    }
    // Dragging past the opposite edge flips the box rather than inverting it.
    if (width < 0) {
        x += width;
        width = -width;
    }
    if (height < 0) {
        y += height;
        height = -height;
    }
    return { x, y, width: Math.max(width, 1), height: Math.max(height, 1) };
}

function keepsAspect(snaps: Snapshot[], shift: boolean): boolean {
    const natural = snaps.some((s) =>
        ["text", "image", "circle"].includes(s.geom.sourceTag),
    );
    return natural !== shift;
}

function mapBox(b: Box, from: Box, to: Box): Box {
    const sx = from.width ? to.width / from.width : 1;
    const sy = from.height ? to.height / from.height : 1;
    return {
        x: to.x + (b.x - from.x) * sx,
        y: to.y + (b.y - from.y) * sy,
        width: b.width * sx,
        height: b.height * sy,
    };
}

let lastPlans: { sel: Selected; ops: SvgOp[] }[] = [];

function updateDrag(drag: Drag, e: PointerEvent): void {
    if (!pointer) return;
    const p0 = clientToSlide(pointer.x, pointer.y);
    const p1 = clientToSlide(e.clientX, e.clientY);
    let dx = p1.x - p0.x;
    let dy = p1.y - p0.y;
    const threshold = SNAP_PX / scale();
    guides = { xs: [], ys: [] };
    if (drag.kind === "move") {
        if (e.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy)) dy = 0;
            else dx = 0;
        }
        if (!e.altKey) {
            const moved = {
                ...drag.start,
                x: drag.start.x + dx,
                y: drag.start.y + dy,
            };
            const snap = snapBox(moved, drag.targets, threshold);
            dx += snap.dx;
            dy += snap.dy;
            guides = { xs: snap.guidesX, ys: snap.guidesY };
        }
        restore(drag.snaps);
        lastPlans = drag.snaps.map((s) => ({
            sel: s.sel,
            ops: moveOps(s.sel, dx, dy),
        }));
    } else if (drag.kind === "resize") {
        if (!e.altKey) {
            const h = drag.handle;
            const edgesX: number[] = [];
            const edgesY: number[] = [];
            if (h.includes("w")) edgesX.push(drag.start.x + dx);
            if (h.includes("e"))
                edgesX.push(drag.start.x + drag.start.width + dx);
            if (h.includes("n")) edgesY.push(drag.start.y + dy);
            if (h.includes("s"))
                edgesY.push(drag.start.y + drag.start.height + dy);
            const snap = snapEdges(edgesX, edgesY, drag.targets, threshold);
            dx += snap.dx;
            dy += snap.dy;
            guides = { xs: snap.guidesX, ys: snap.guidesY };
        }
        const to = resizedBox(
            drag.start,
            drag.handle,
            dx,
            dy,
            keepsAspect(drag.snaps, e.shiftKey),
        );
        restore(drag.snaps);
        lastPlans = drag.snaps.map((s) => {
            const plan = planResize(
                s.geom,
                s.box,
                mapBox(s.box, drag.start, to),
            );
            applyPlanToDom(s.sel.el, plan);
            return {
                sel: s.sel,
                ops: [{ kind: "attrs", loc: s.sel.loc, set: plan }],
            };
        });
    } else if (drag.kind === "rotate") {
        const c = drag.center;
        const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
        const a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
        let deg = ((a1 - a0) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        restore(drag.snaps);
        lastPlans = drag.snaps.map((s) => {
            const plan = planRotate(s.geom, deg, c);
            applyPlanToDom(s.sel.el, plan);
            return {
                sel: s.sel,
                ops: [{ kind: "attrs", loc: s.sel.loc, set: plan }],
            };
        });
    } else if (drag.kind === "marquee") {
        marquee = {
            x: Math.min(p0.x, p1.x),
            y: Math.min(p0.y, p1.y),
            width: Math.abs(p1.x - p0.x),
            height: Math.abs(p1.y - p0.y),
        };
    }
    drawOverlay();
}

async function endDrag(drag: Drag): Promise<void> {
    guides = { xs: [], ys: [] };
    if (drag.kind === "marquee") {
        const m = marquee;
        marquee = null;
        if (!m) return;
        const svg = slideRoot();
        if (!svg) return;
        const hits = [...svg.querySelectorAll("[data-ink-top]")].filter(
            (el) => {
                if (!selectable(el) || !canTransform(el)) return false;
                const b = slideBox(el);
                return (
                    !!b &&
                    b.x >= m.x &&
                    b.y >= m.y &&
                    b.x + b.width <= m.x + m.width &&
                    b.y + b.height <= m.y + m.height
                );
            },
        ) as SVGGraphicsElement[];
        if (drag.additive) {
            for (const el of hits) addToSelection(el, false);
            select(ed.selection.map((s) => s.el));
        } else select(hits);
        return;
    }
    const plans = lastPlans;
    lastPlans = [];
    drawOverlay();
    if (!plans.length) return;
    const label =
        drag.kind === "move"
            ? "Move"
            : drag.kind === "resize"
              ? "Resize"
              : "Rotate";
    const ok = await sendSvgOps(plans, label);
    if (!ok) restore(drag.snaps);
    drawOverlay();
}

function onPointerDown(e: PointerEvent): void {
    ed.focus = "canvas";
    if (ed.slideSelection.size) {
        ed.slideSelection.clear();
        emit("slide-selection");
    }
    if (e.button !== 0 || !slideRoot()) return;
    const target = e.target as Element;
    const handle = (target.closest("[data-handle]") as SVGElement | null)
        ?.dataset.handle as Handle | undefined;
    const pt = clientToSlide(e.clientX, e.clientY);
    if (!handle && ed.tool !== "select") {
        if (hooks.toolDown(e, pt)) return;
    }
    paper.setPointerCapture(e.pointerId);
    e.preventDefault();
    ed.interacting = true;
    let clickTarget: SVGGraphicsElement | null = null;
    let drag: Drag | null = null;
    if (handle) {
        drag = beginDrag(handle);
    } else {
        clickTarget = pick(e.clientX, e.clientY);
        if (clickTarget) {
            const already = ed.selection.some((s) => s.el === clickTarget);
            if (e.shiftKey || e.metaKey || e.ctrlKey) {
                if (already) {
                    ed.selection = ed.selection.filter(
                        (s) => s.el !== clickTarget,
                    );
                    drawOverlay();
                    emit("selection");
                    clickTarget = null;
                } else addToSelection(clickTarget);
            } else if (!already) select([clickTarget]);
        } else {
            if (!e.shiftKey) {
                if (ed.scope && !ed.scope.contains(target)) enterGroup(null);
                clearSelection();
            }
            drag = { kind: "marquee", additive: e.shiftKey };
        }
    }
    pointer = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        started: false,
        drag,
        clickTarget,
        shift: e.shiftKey,
    };
}

function onPointerMove(e: PointerEvent): void {
    if (!pointer) {
        if (ed.tool === "select" && e.buttons === 0) {
            const el = pick(e.clientX, e.clientY);
            if (el !== hoverEl) {
                hoverEl = el;
                drawOverlay();
            }
        }
        return;
    }
    if (e.pointerId !== pointer.id) return;
    if (!pointer.started) {
        const dist = Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y);
        if (dist < DRAG_THRESHOLD) return;
        pointer.started = true;
        if (!pointer.drag && pointer.clickTarget)
            pointer.drag = beginDrag(null);
        if (
            pointer.drag?.kind === "move" &&
            !canTransform(pointer.clickTarget!)
        ) {
            pointer.drag = null;
        }
    }
    if (pointer.drag) updateDrag(pointer.drag, e);
}

async function onPointerUp(e: PointerEvent): Promise<void> {
    if (!pointer || e.pointerId !== pointer.id) return;
    const p = pointer;
    pointer = null;
    try {
        if (p.drag && p.started) await endDrag(p.drag);
        else if (p.drag?.kind === "marquee") marquee = null;
    } finally {
        ed.interacting = false;
        if (ed.renderPending) render();
        else drawOverlay();
    }
}

function textUnder(x: number, y: number): SVGGraphicsElement | null {
    const svg = slideRoot();
    for (const hit of document.elementsFromPoint(x, y)) {
        const t = hit.closest("text");
        if (t && svg?.contains(t) && t.hasAttribute("data-ink")) {
            return t as SVGGraphicsElement;
        }
    }
    return null;
}

function onDoubleClick(e: MouseEvent): void {
    const el = pick(e.clientX, e.clientY);
    if (!el) return;
    if (isZone(el)) {
        hooks.editZone(zoneName(el), el.getBoundingClientRect());
        return;
    }
    // Text inside a group is edited straight away, as in any slide editor; the
    // group is entered so the selection shows what is being edited.
    const text = textUnder(e.clientX, e.clientY);
    if (text && el.contains(text)) {
        if (text !== el && !text.hasAttribute("data-ink-top")) {
            enterGroup(text.parentElement as unknown as SVGGElement);
        }
        select([text]);
        hooks.editText(text);
        return;
    }
    if (el.localName === "g") {
        enterGroup(el as unknown as SVGGElement);
        const inner = pick(e.clientX, e.clientY);
        if (inner) select([inner]);
    }
}

export function initCanvas(): void {
    paper.addEventListener("pointerdown", onPointerDown);
    paper.addEventListener("pointermove", onPointerMove);
    paper.addEventListener("pointerup", (e) => void onPointerUp(e));
    paper.addEventListener("pointercancel", (e) => void onPointerUp(e));
    paper.addEventListener("dblclick", onDoubleClick);
    paper.addEventListener("pointerleave", () => {
        if (hoverEl) {
            hoverEl = null;
            drawOverlay();
        }
    });
    new ResizeObserver(() => layoutPaper()).observe(canvas);
    canvas.addEventListener(
        "wheel",
        (e) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            setZoom(scale() * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        },
        { passive: false },
    );
    // Clicking the grey area around the slide clears the selection.
    canvas.addEventListener("pointerdown", (e) => {
        if (e.target === canvas) {
            enterGroup(null);
            clearSelection();
        }
    });
    on("model", render);
}

export function setZoom(z: number): void {
    ed.zoom = z <= 0 ? 0 : Math.max(0.05, Math.min(z, 8));
    layoutPaper();
    emit("zoom");
}
