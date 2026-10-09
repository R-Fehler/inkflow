// Creating things: the shape and text tools, images and videos (picked, dropped
// or pasted), and copy/paste of selected objects.
//
// New objects are written into the slide's own SVG. A slide that is still drawn
// straight from a shared layout gets its own SVG first (built on that layout,
// so it looks the same), which is what makes "just draw on any slide" possible.

import {
    candidatesAt,
    clearSelection,
    clientToSlide,
    drawOverlay,
    hooks,
    isConnector,
    keyOf,
    mediaZoneAt,
    newConnectorPath,
    showSites,
    siteAt,
    slideRoot,
    slideToPaper,
} from "./canvas";
import { pasteText } from "./clipboard";
import type { End, Site } from "./connectors";
import { svgEl, toast } from "./dom";
import { fmt, invert, mat, multiply, relativePath, transformBox } from "./geom";
import { edit, request } from "./net";
import { currentSlide, ed, emit, off, on } from "./state";
import type { SlideModel } from "./types";

const overlay = document.getElementById("overlay") as unknown as SVGSVGElement;

// Ids to select once the rebuild that contains them has rendered.
export const afterRender: { ids: string[]; editText: boolean } = {
    ids: [],
    editText: false,
};

export function setTool(tool: typeof ed.tool): void {
    ed.tool = tool;
    document.body.dataset.tool = tool;
    emit("tool");
}

function waitForModel(
    pred: (s: SlideModel) => boolean,
    ms = 5000,
): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            off("model", check);
            resolve(ok);
        };
        const deadline = window.setTimeout(() => finish(false), ms);
        const check = () => {
            const s = currentSlide();
            if (s && pred(s)) {
                window.clearTimeout(deadline);
                finish(true);
            }
        };
        on("model", check);
    });
}

// Make sure the current slide has an SVG of its own to draw into.
export async function ensureOwnDrawing(): Promise<boolean> {
    const slide = currentSlide();
    if (!slide) return false;
    if (!slide.srcShared) return true;
    if (!ed.model?.deckEditable) {
        toast(
            "deck.py builds its slides in code; cannot add a drawing here",
            "error",
        );
        return false;
    }
    const deckIndex = slide.deckIndex;
    const result = await edit({
        action: "slide",
        op: "detach",
        slide: deckIndex,
        name: slide.id ?? slide.explicitId ?? "slide",
    });
    if (!result.ok) return false;
    toast("This slide now has its own SVG (built on its layout)");
    return waitForModel((s) => s.deckIndex === deckIndex && !s.srcShared);
}

export function ownSource() {
    return currentSlide()?.sources?.find((s) => s.role === "slide") ?? null;
}

// Where new objects go: the entered group, else the topmost unlocked layer of
// the slide's own file, else its root.
export function insertParent(): { loc: string; el: Element | null } {
    const svg = slideRoot();
    if (ed.scope?.getAttribute("data-ink")?.startsWith("0:")) {
        return { loc: ed.scope.getAttribute("data-ink")!, el: ed.scope };
    }
    const layers = svg
        ? [...svg.querySelectorAll('[data-ink-layer][data-ink^="0:"]')].filter(
              (l) => !l.hasAttribute("data-ink-locked"),
          )
        : [];
    const layer = layers[layers.length - 1];
    if (layer) return { loc: layer.getAttribute("data-ink")!, el: layer };
    return { loc: "0:", el: null };
}

// Slide coordinates → the insertion parent's user space.
function toParent(
    el: Element | null,
    x: number,
    y: number,
): { x: number; y: number } {
    const svg = slideRoot();
    if (!el || !svg) return { x, y };
    const p = (el as SVGGraphicsElement).getScreenCTM?.();
    const r = svg.getScreenCTM();
    if (!p || !r) return { x, y };
    const m = multiply(invert(mat(p)), mat(r));
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export async function insertXml(
    xml: string | (() => string),
    base: string,
    opts: {
        editText?: boolean;
        marker?: boolean;
        before?: () => Record<string, unknown>[];
    } = {},
): Promise<boolean> {
    if (!(await ensureOwnDrawing())) return false;
    const src = ownSource();
    if (!src) return false;
    const parent = insertParent();
    const ops: Record<string, unknown>[] = [...(opts.before?.() ?? [])];
    if (opts.marker) ops.push({ kind: "ensure-marker" });
    if (typeof xml === "function") xml = xml();
    ops.push({ kind: "insert", parent: parent.loc, xml, base, key: "new" });
    const result = await edit({
        action: "svg",
        file: src.path,
        hash: src.hash,
        ops,
        label: `Insert ${base}`,
    });
    if (!result.ok) return false;
    const id = result.ids?.new;
    if (id) {
        afterRender.ids = [id];
        afterRender.editText = !!opts.editText;
    }
    return true;
}

// ── Shape tools ──

const SHAPE_STYLE = {
    rect: 'class="inkflow-fill-surface inkflow-stroke-accent" style="stroke-width:4"',
    ellipse:
        'class="inkflow-fill-surface inkflow-stroke-accent" style="stroke-width:4"',
    line: 'class="inkflow-stroke-text" style="fill:none;stroke-width:6;stroke-linecap:round"',
};

function shapeXml(
    tool: string,
    a: { x: number; y: number },
    b: { x: number; y: number },
): string {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    switch (tool) {
        case "rect":
            return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="16" ${SHAPE_STYLE.rect}/>`;
        default:
            return `<ellipse cx="${fmt(x + w / 2)}" cy="${fmt(y + h / 2)}" rx="${fmt(w / 2)}" ry="${fmt(h / 2)}" ${SHAPE_STYLE.ellipse}/>`;
    }
}

function textXml(p: { x: number; y: number }): string {
    return `<text x="${fmt(p.x)}" y="${fmt(p.y)}" class="inkflow-fill-text" style="font-size:56px;font-family:var(--inkflow-body-font, sans-serif)">Text</text>`;
}

let draft: SVGElement | null = null;

function drawDraft(
    tool: string,
    a: { x: number; y: number },
    b: { x: number; y: number },
) {
    draft?.remove();
    const m = slideToPaper();
    const pa = { x: m.a * a.x + m.e, y: m.d * a.y + m.f };
    const pb = { x: m.a * b.x + m.e, y: m.d * b.y + m.f };
    if (tool === "line" || tool === "arrow") {
        draft = svgEl("line", {
            x1: pa.x,
            y1: pa.y,
            x2: pb.x,
            y2: pb.y,
            class: "draft",
        });
    } else {
        const box = transformBox(m, {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            width: Math.abs(b.x - a.x),
            height: Math.abs(b.y - a.y),
        });
        draft =
            tool === "ellipse"
                ? svgEl("ellipse", {
                      cx: box.x + box.width / 2,
                      cy: box.y + box.height / 2,
                      rx: box.width / 2,
                      ry: box.height / 2,
                      class: "draft",
                  })
                : svgEl("rect", {
                      x: box.x,
                      y: box.y,
                      width: box.width,
                      height: box.height,
                      class: "draft",
                  });
    }
    overlay.append(draft);
}

// A line or arrow is a connector: a <path> whose ends attach to the shapes
// they were drawn from and to (inkflow:connect-start/-end), so it follows
// them when they move.
async function insertConnector(
    tool: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    startHit: { el: Element; site: Site } | null,
    endHit: { el: Element; site: Site } | null,
): Promise<void> {
    let a: End = startHit ? startHit.site : from;
    let b: End = endHit ? endHit.site : to;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 8) {
        // A click: a default-length line from there.
        a = { x: from.x - 150, y: from.y };
        b = { x: from.x + 150, y: from.y };
        startHit = null;
        endHit = null;
    }
    const before: Record<string, unknown>[] = [];
    const taken = new Set<string>();
    const attach = (hit: { el: Element; site: Site } | null): string | null => {
        if (!hit) return null;
        let id = hit.el.getAttribute("id");
        // A shape in the slide's own drawing gets an id if it has none; one in
        // another file without an id cannot be attached to.
        if (!id && keyOf(hit.el) === 0) {
            const svg = slideRoot();
            let n = 1;
            const base = hit.el.localName;
            while (
                svg?.querySelector(`[id="${base}-${n}"]`) ||
                taken.has(`${base}-${n}`)
            )
                n++;
            id = `${base}-${n}`;
            taken.add(id);
            hit.el.setAttribute("id", id);
            before.push({
                kind: "id",
                loc: hit.el.getAttribute("data-ink"),
                id,
            });
        }
        return id ? `${id}:${hit.site.name}` : null;
    };
    const startAt = attach(startHit);
    const endAt = attach(endHit);
    const attrs = [
        'inkflow:connector="straight"',
        startAt ? `inkflow:connect-start="${startAt}"` : "",
        endAt ? `inkflow:connect-end="${endAt}"` : "",
        tool === "arrow" ? 'marker-end="url(#inkflow-arrow)"' : "",
    ]
        .filter(Boolean)
        .join(" ");
    await insertXml(
        // Routed into the insertion parent's space once it is known (a slide
        // drawn from a layout gets its own SVG first).
        () =>
            `<path d="${newConnectorPath("straight", a, b, insertParent().el)}" ${SHAPE_STYLE.line} ${attrs}/>`,
        tool,
        { marker: tool === "arrow", before: () => before },
    );
}

function onToolDown(e: PointerEvent, start: { x: number; y: number }): boolean {
    const tool = ed.tool;
    if (tool === "select") return false;
    e.preventDefault();
    clearSelection();
    const paperEl = e.currentTarget as HTMLElement;
    paperEl.setPointerCapture(e.pointerId);
    ed.interacting = true;
    const connecting = tool === "line" || tool === "arrow";
    // Lines and arrows start and end on connection sites when near one.
    const startHit = connecting && !e.altKey ? siteAt(start, null) : null;
    if (startHit) start = { x: startHit.site.x, y: startHit.site.y };
    let endHit: { el: Element; site: Site } | null = null;
    let end = start;
    const move = (ev: PointerEvent) => {
        end = clientToSlide(ev.clientX, ev.clientY);
        if (connecting) {
            endHit = ev.altKey ? null : siteAt(end, null);
            if (endHit) end = { x: endHit.site.x, y: endHit.site.y };
            const under = candidatesAt(ev.clientX, ev.clientY).find(
                (el) => !isConnector(el),
            );
            showSites([
                ...(under
                    ? [
                          {
                              el: under as Element,
                              active: endHit?.el === under ? endHit.site : null,
                          },
                      ]
                    : []),
                ...(endHit && endHit.el !== under
                    ? [{ el: endHit.el, active: endHit.site }]
                    : []),
                ...(startHit
                    ? [{ el: startHit.el, active: startHit.site }]
                    : []),
            ]);
        }
        if (ev.shiftKey && (tool === "rect" || tool === "ellipse")) {
            const d = Math.max(
                Math.abs(end.x - start.x),
                Math.abs(end.y - start.y),
            );
            end = {
                x: start.x + Math.sign(end.x - start.x || 1) * d,
                y: start.y + Math.sign(end.y - start.y || 1) * d,
            };
        }
        drawDraft(tool, start, end);
    };
    const up = () => {
        paperEl.removeEventListener("pointermove", move);
        paperEl.removeEventListener("pointerup", up);
        draft?.remove();
        draft = null;
        ed.interacting = false;
        let a = start;
        let b = end;
        if (connecting) {
            showSites([]);
            void insertConnector(tool, start, end, startHit, endHit);
            setTool("select");
            drawOverlay();
            return;
        }
        if (tool === "text") {
            void insertTextBox(start, end);
            setTool("select");
            drawOverlay();
            return;
        }
        if (Math.hypot(b.x - a.x, b.y - a.y) < 8) {
            // A click: a default-sized shape centred there.
            const w = 360;
            const h = 220;
            a = { x: start.x - w / 2, y: start.y - h / 2 };
            b = { x: start.x + w / 2, y: start.y + h / 2 };
        }
        const parent = insertParent().el;
        const pa = toParent(parent, a.x, a.y);
        const pb = toParent(parent, b.x, b.y);
        void insertXml(shapeXml(tool, pa, pb), tool);
        setTool("select");
        if (ed.renderPending) emit("model");
        drawOverlay();
    };
    paperEl.addEventListener("pointermove", move);
    paperEl.addEventListener("pointerup", up);
    return true;
}

// ── Text boxes ──

// A text box wraps its text and holds Markdown (bold words, lists, links…):
// a zone of its own on the slide, edited in place. Where there is nowhere to
// keep its Markdown (a deck built in code, a layout being edited), the text
// tool falls back to a plain SVG text line.
async function insertTextBox(
    a: { x: number; y: number },
    b: { x: number; y: number },
): Promise<void> {
    const slide = currentSlide();
    if (!slide) return;
    const vb = slideRoot()?.viewBox.baseVal;
    const vw = vb?.width || 1920;
    let box = {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y),
    };
    if (box.width < 40 || box.height < 20) {
        // A click: a box from there to near the slide's right edge.
        box = {
            x: a.x,
            y: a.y - 40,
            width: Math.max(300, Math.min(900, vw - a.x - 60)),
            height: 100,
        };
    }
    const plain = ed.layoutMode || (!ed.model?.deckEditable && !slide.md);
    if (plain) {
        const p = toParent(insertParent().el, a.x, a.y);
        await insertXml(textXml(p), "text", { editText: true });
        return;
    }
    if (!(await ensureOwnDrawing())) return;
    const src = ownSource();
    const current = currentSlide();
    if (!src || !current) return;
    const parent = insertParent();
    const p0 = toParent(parent.el, box.x, box.y);
    const p1 = toParent(parent.el, box.x + box.width, box.y + box.height);
    const result = await edit({
        action: "insert-textbox",
        slide: current.deckIndex,
        file: src.path,
        hash: src.hash,
        parent: parent.loc,
        x: Math.round(Math.min(p0.x, p1.x)),
        y: Math.round(Math.min(p0.y, p1.y)),
        width: Math.round(Math.abs(p1.x - p0.x)),
        height: Math.round(Math.abs(p1.y - p0.y)),
        text: "Text",
    });
    const id = result.ids?.new;
    if (result.ok && id) {
        afterRender.ids = [id];
        afterRender.editText = true;
    }
}

// ── Text in shapes ──

export async function typeInto(el: Element): Promise<void> {
    const slide = currentSlide();
    const loc = el.getAttribute("data-ink");
    const src = slide?.sources?.[keyOf(el)];
    if (!slide || !loc || !src) return;
    if (!ed.model?.deckEditable && !slide.md) {
        toast(
            "deck.py builds its slides in code; there is nowhere to keep the text",
            "error",
        );
        return;
    }
    const result = await edit({
        action: "shape-text",
        slide: slide.deckIndex,
        file: src.path,
        hash: src.hash,
        loc,
    });
    const id = result.ids?.new;
    if (result.ok && id) {
        afterRender.ids = [id];
        afterRender.editText = true;
    }
}

// ── Images ──

function readBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const url = String(reader.result);
            resolve(url.slice(url.indexOf(",") + 1));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

export async function upload(
    file: File,
): Promise<{ path: string; rel: string } | null> {
    const data = await readBase64(file);
    const result = await request({ action: "upload", name: file.name, data });
    if (!result.ok || !result.path || !result.rel) {
        toast(result.error ?? "upload failed", "error");
        return null;
    }
    return { path: result.path, rel: result.rel };
}

function naturalSize(rel: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () =>
            resolve({
                w: img.naturalWidth || 400,
                h: img.naturalHeight || 300,
            });
        img.onerror = () => resolve({ w: 400, h: 300 });
        img.src = `/${rel}`;
    });
}

function videoSize(rel: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve) => {
        const video = document.createElement("video");
        const fallback = { w: 1280, h: 720 };
        // A format the browser cannot decode never loads its metadata.
        const timer = window.setTimeout(() => resolve(fallback), 3000);
        video.preload = "metadata";
        video.muted = true;
        video.onloadedmetadata = () => {
            window.clearTimeout(timer);
            resolve(
                video.videoWidth && video.videoHeight
                    ? { w: video.videoWidth, h: video.videoHeight }
                    : fallback,
            );
        };
        video.onerror = () => {
            window.clearTimeout(timer);
            resolve(fallback);
        };
        video.src = `/${rel}`;
    });
}

export function isVideo(file: File): boolean {
    return (
        file.type.startsWith("video/") ||
        /\.(mp4|webm|ogg|mov)$/i.test(file.name)
    );
}

// A video goes into a zone of its own: a new rect in the slide's SVG, filled
// through zones={...} in deck.py, so it plays like any other Video (and its
// settings show in the panel). Both files change in one undoable step.
export async function insertVideoFile(
    file: File,
    at?: { x: number; y: number },
): Promise<void> {
    if (!(await ensureOwnDrawing())) return;
    const up = await upload(file);
    const src = ownSource();
    const slide = currentSlide();
    if (!up || !src || !slide) return;
    const size = await videoSize(up.rel);
    const vb = slideRoot()?.viewBox.baseVal;
    const vw = vb?.width || 1920;
    const vh = vb?.height || 1080;
    const k = Math.min((vw * 0.6) / size.w, (vh * 0.6) / size.h);
    const w = size.w * k;
    const h = size.h * k;
    // Centred on the drop point, but kept on the slide.
    const cx = Math.min(Math.max(at?.x ?? vw / 2, w / 2), vw - w / 2);
    const cy = Math.min(Math.max(at?.y ?? vh / 2, h / 2), vh - h / 2);
    const parent = insertParent();
    const a = toParent(parent.el, cx - w / 2, cy - h / 2);
    const b = toParent(parent.el, cx + w / 2, cy + h / 2);
    const result = await edit({
        action: "insert-video",
        slide: slide.deckIndex,
        file: src.path,
        hash: src.hash,
        parent: parent.loc,
        x: Math.round(Math.min(a.x, b.x)),
        y: Math.round(Math.min(a.y, b.y)),
        width: Math.round(Math.abs(b.x - a.x)),
        height: Math.round(Math.abs(b.y - a.y)),
        src: up.path,
    });
    const id = result.ids?.new;
    if (result.ok && id) afterRender.ids = [id];
}

export async function insertVideo(): Promise<void> {
    const file = await pickFile(
        "video/mp4,video/webm,video/ogg,video/quicktime",
    );
    if (file) await insertVideoFile(file);
}

// A dropped or pasted file: into the media zone under it if there is one,
// else onto the slide as a free image or video.
export async function insertFile(
    file: File,
    at?: { x: number; y: number; clientX: number; clientY: number },
): Promise<void> {
    const zone = at ? mediaZoneAt(at.clientX, at.clientY) : null;
    if (zone) {
        await fillZone(zone, file);
        return;
    }
    if (isVideo(file)) await insertVideoFile(file, at);
    else if (file.type.startsWith("image/")) await insertImageFile(file, at);
    else toast(`Cannot insert ${file.name}`, "error");
}

export async function insertImageFile(
    file: File,
    at?: { x: number; y: number },
) {
    if (!(await ensureOwnDrawing())) return;
    const up = await upload(file);
    const src = ownSource();
    if (!up || !src) return;
    const size = await naturalSize(up.rel);
    const svg = slideRoot();
    const vb = svg?.viewBox.baseVal;
    const maxW = (vb?.width || 1920) * 0.5;
    const maxH = (vb?.height || 1080) * 0.5;
    const k = Math.min(1, maxW / size.w, maxH / size.h);
    const w = size.w * k;
    const h = size.h * k;
    const cx = at?.x ?? (vb?.width || 1920) / 2;
    const cy = at?.y ?? (vb?.height || 1080) / 2;
    const parent = insertParent().el;
    const p = toParent(parent, cx - w / 2, cy - h / 2);
    const href = relativePath(src.path, up.path);
    await insertXml(
        `<image href="${href}" x="${fmt(p.x)}" y="${fmt(p.y)}" width="${fmt(w)}" height="${fmt(h)}" preserveAspectRatio="xMidYMid meet"/>`,
        "image",
    );
}

export function pickFile(accept: string): Promise<File | null> {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.click();
    });
}

export async function insertImage(): Promise<void> {
    const file = await pickFile("image/*");
    if (file) await insertImageFile(file);
}

const MEDIA_ACCEPT = "image/*,video/mp4,video/webm,video/ogg,video/quicktime";

async function fillZone(zone: string, file: File): Promise<void> {
    const slide = currentSlide();
    if (!slide) return;
    const up = await upload(file);
    if (!up) return;
    await edit({
        action: "zone-media",
        slide: slide.deckIndex,
        zone,
        src: up.path,
        fit: slide.zones[zone]?.fit ?? "cover",
    });
}

export async function zoneMedia(zone: string): Promise<void> {
    const file = await pickFile(MEDIA_ACCEPT);
    if (file) await fillZone(zone, file);
}

// ── Copy / paste ──

export function cleanForPaste(el: Element): string {
    const copy = el.cloneNode(true) as Element;
    for (const node of [copy, ...copy.querySelectorAll("*")]) {
        for (const attr of [...node.attributes]) {
            const name = attr.name;
            if (name.startsWith("data-")) node.removeAttribute(name);
            else if (name === "xlink:href") {
                node.setAttribute("href", attr.value);
                node.removeAttribute(name);
            } else if (name.includes(":") && !name.startsWith("xml:")) {
                node.removeAttribute(name);
            } else if (name === "class") {
                const kept = attr.value
                    .split(/\s+/)
                    .filter((c) => c && !c.startsWith("anim-"));
                if (kept.length) node.setAttribute("class", kept.join(" "));
                else node.removeAttribute("class");
            }
        }
        (node as HTMLElement).style?.removeProperty?.("visibility");
    }
    return new XMLSerializer().serializeToString(copy);
}

// ── Wiring ──

export function initInsert(): void {
    hooks.toolDown = onToolDown;
    hooks.typeInto = (el) => void typeInto(el);
    hooks.zoneMedia = (zone) => void zoneMedia(zone);
    const canvas = document.getElementById("canvas")!;
    canvas.addEventListener("dragover", (e) => {
        if (e.dataTransfer?.types.includes("Files")) {
            e.preventDefault();
            canvas.classList.add("drop");
        }
    });
    canvas.addEventListener("dragleave", () => canvas.classList.remove("drop"));
    canvas.addEventListener("drop", (e) => {
        canvas.classList.remove("drop");
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        e.preventDefault();
        void insertFile(file, {
            ...clientToSlide(e.clientX, e.clientY),
            clientX: e.clientX,
            clientY: e.clientY,
        });
    });
    document.addEventListener("paste", (e) => {
        const target = e.target as HTMLElement;
        if (target.closest("textarea, input")) return;
        const file = [...(e.clipboardData?.files ?? [])].find(
            (f) => f.type.startsWith("image/") || isVideo(f),
        );
        if (file) {
            e.preventDefault();
            void insertFile(file);
            return;
        }
        e.preventDefault();
        void pasteText(e.clipboardData?.getData("text/plain") ?? "");
    });
}
