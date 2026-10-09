// Creating things: the shape and text tools, images (picked, dropped or pasted),
// and copy/paste of selected objects.
//
// New objects are written into the slide's own SVG. A slide that is still drawn
// straight from a shared layout gets its own SVG first (built on that layout,
// so it looks the same), which is what makes "just draw on any slide" possible.

import {
    clearSelection,
    clientToSlide,
    drawOverlay,
    hooks,
    slideRoot,
    slideToPaper,
} from "./canvas";
import { svgEl, toast } from "./dom";
import { fmt, invert, mat, multiply, relativePath, transformBox } from "./geom";
import { edit, request } from "./net";
import { currentSlide, ed, emit, on } from "./state";
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
        const deadline = window.setTimeout(() => resolve(false), ms);
        const check = () => {
            const s = currentSlide();
            if (s && pred(s)) {
                window.clearTimeout(deadline);
                resolve(true);
            } else on("model", check);
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
    });
    if (!result.ok) return false;
    toast("This slide now has its own SVG (built on its layout)");
    return waitForModel((s) => s.deckIndex === deckIndex && !s.srcShared);
}

function ownSource() {
    return currentSlide()?.sources?.find((s) => s.role === "slide") ?? null;
}

// Where new objects go: the entered group, else the topmost unlocked layer of
// the slide's own file, else its root.
function insertParent(): { loc: string; el: Element | null } {
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
    xml: string,
    base: string,
    opts: { editText?: boolean; marker?: boolean } = {},
): Promise<boolean> {
    if (!(await ensureOwnDrawing())) return false;
    const src = ownSource();
    if (!src) return false;
    const parent = insertParent();
    const ops: Record<string, unknown>[] = [];
    if (opts.marker) ops.push({ kind: "ensure-marker" });
    ops.push({ kind: "insert", parent: parent.loc, xml, base, key: "new" });
    const result = await edit({
        action: "svg",
        file: src.path,
        hash: src.hash,
        ops: ops.map((o) =>
            o.kind === "ensure-marker" ? { ...o, loc: undefined } : o,
        ),
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
        case "ellipse":
            return `<ellipse cx="${fmt(x + w / 2)}" cy="${fmt(y + h / 2)}" rx="${fmt(w / 2)}" ry="${fmt(h / 2)}" ${SHAPE_STYLE.ellipse}/>`;
        case "arrow":
            return `<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}" ${SHAPE_STYLE.line} marker-end="url(#inkflow-arrow)"/>`;
        default:
            return `<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}" ${SHAPE_STYLE.line}/>`;
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

function onToolDown(e: PointerEvent, start: { x: number; y: number }): boolean {
    const tool = ed.tool;
    if (tool === "select") return false;
    e.preventDefault();
    clearSelection();
    if (tool === "text") {
        const p = toParent(insertParent().el, start.x, start.y);
        void insertXml(textXml(p), "text", { editText: true });
        setTool("select");
        return true;
    }
    const paperEl = e.currentTarget as HTMLElement;
    paperEl.setPointerCapture(e.pointerId);
    ed.interacting = true;
    let end = start;
    const move = (ev: PointerEvent) => {
        end = clientToSlide(ev.clientX, ev.clientY);
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
        if (Math.hypot(b.x - a.x, b.y - a.y) < 8) {
            // A click: a default-sized shape centred there.
            const w = tool === "line" || tool === "arrow" ? 300 : 360;
            const h = tool === "line" || tool === "arrow" ? 0 : 220;
            a = { x: start.x - w / 2, y: start.y - h / 2 };
            b = { x: start.x + w / 2, y: start.y + h / 2 };
        }
        const parent = insertParent().el;
        const pa = toParent(parent, a.x, a.y);
        const pb = toParent(parent, b.x, b.y);
        void insertXml(shapeXml(tool, pa, pb), tool, {
            marker: tool === "arrow",
        });
        setTool("select");
        if (ed.renderPending) emit("model");
        drawOverlay();
    };
    paperEl.addEventListener("pointermove", move);
    paperEl.addEventListener("pointerup", up);
    return true;
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

async function upload(
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

export async function insertImageFile(
    file: File,
    at?: { x: number; y: number },
) {
    if (/^video\//.test(file.type)) {
        toast("Drop a video onto a media zone, or add it in deck.py", "error");
        return;
    }
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

async function zoneMedia(zone: string): Promise<void> {
    const slide = currentSlide();
    if (!slide) return;
    const file = await pickFile("image/*,video/mp4,video/webm");
    if (!file) return;
    const up = await upload(file);
    if (!up) return;
    await edit({
        action: "zone-media",
        slide: slide.deckIndex,
        zone,
        src: up.path,
        fit: "cover",
    });
}

// ── Copy / paste ──

function cleanForPaste(el: Element): string {
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

export function copySelection(): boolean {
    const own = ed.selection.filter((s) => s.el.localName !== "foreignObject");
    if (!own.length) return false;
    ed.clip = {
        fragments: own.map((s) => cleanForPaste(s.el)),
        sourceFile: currentSlide()?.sources?.[own[0].key]?.path ?? "",
    };
    toast(`Copied ${own.length} object${own.length > 1 ? "s" : ""}`);
    return true;
}

// Image references are written project-relative in the rendered slide; a pasted
// copy must point at the same file from wherever it lands.
function retarget(xml: string, targetFile: string): string {
    const projectDir = ed.model?.projectDir ?? "";
    return xml.replace(/\shref="([^"]+)"/g, (whole, href: string) => {
        if (/^(data:|https?:|#|\/)/.test(href)) return whole;
        return ` href="${relativePath(targetFile, `${projectDir}/${href}`)}"`;
    });
}

export async function pasteClip(): Promise<void> {
    const clip = ed.clip;
    if (!clip) return;
    if (!(await ensureOwnDrawing())) return;
    const src = ownSource();
    if (!src) return;
    const sameFile = clip.sourceFile === src.path;
    const parent = insertParent();
    const result = await edit({
        action: "svg",
        file: src.path,
        hash: src.hash,
        // Copies on the same slide are offset so they do not hide the original.
        ops: clip.fragments.map((xml, i) => {
            const frag = retarget(xml, src.path);
            return {
                kind: "insert",
                parent: parent.loc,
                xml: sameFile ? offsetFragment(frag, 24) : frag,
                key: `paste${i}`,
            };
        }),
        label: "Paste",
    });
    if (result.ok && result.ids) {
        afterRender.ids = Object.values(result.ids);
    }
}

function offsetFragment(xml: string, d: number): string {
    // Prepend a translate to the element's own transform.
    const m = xml.match(/^<(\w+)([^>]*)>/s) ?? xml.match(/^<(\w+)([^>]*)\/>/s);
    if (!m) return xml;
    const tagStart = `<${m[1]}`;
    const attrs = m[2];
    const t = attrs.match(/\stransform="([^"]*)"/);
    const newAttrs = t
        ? attrs.replace(t[0], ` transform="translate(${d},${d}) ${t[1]}"`)
        : `${attrs} transform="translate(${d},${d})"`;
    return tagStart + newAttrs + xml.slice(tagStart.length + attrs.length);
}

// ── Wiring ──

export function initInsert(): void {
    hooks.toolDown = onToolDown;
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
        void insertImageFile(file, clientToSlide(e.clientX, e.clientY));
    });
    document.addEventListener("paste", (e) => {
        const target = e.target as HTMLElement;
        if (target.closest("textarea, input")) return;
        const file = [...(e.clipboardData?.files ?? [])].find((f) =>
            f.type.startsWith("image/"),
        );
        if (file) {
            e.preventDefault();
            void insertImageFile(file);
        } else if (ed.clip) {
            e.preventDefault();
            void pasteClip();
        }
    });
}
