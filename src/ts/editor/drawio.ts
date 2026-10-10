// draw.io diagrams on slides. A diagram is a draw.io "editable SVG"
// (diagrams/<name>.drawio.svg: a picture with the diagram's source inside),
// shown on the slide as an <image>. Double-click (or "Edit diagram") opens
// draw.io full screen in embed mode, which talks to this page by
// postMessage; saving exports the editable SVG and the server writes it back
// (editor/session.py `drawio-save`: one undo step, source uncompressed).
//
// draw.io is loaded from embed.diagrams.net unless INKFLOW_DRAWIO_URL names
// another copy (self-hosted, offline). Messages are only taken from that
// frame and that origin.

import { pictureOf } from "./crop";
import { h, toast } from "./dom";
import { insertDiagramImage } from "./insert";
import { edit, request } from "./net";
import { currentSlide, sourceOf } from "./state";
import type { Selected } from "./types";

/** The slide's picture of a diagram, if this object is one. */
export function diagramOf(el: Element): SVGImageElement | null {
    const image = pictureOf(el);
    const href =
        image?.getAttribute("href") ?? image?.getAttribute("xlink:href") ?? "";
    return isDiagramHref(href) ? image : null;
}

export function isDiagramHref(href: string): boolean {
    return /\.drawio\.svg$/i.test(href.split(/[?#]/)[0]);
}

function hrefOf(image: Element): string {
    return (
        image.getAttribute("href") ??
        image.getAttribute("xlink:href") ??
        ""
    ).split(/[?#]/)[0];
}

interface Target {
    // The diagram file (project-relative, as the slide shows it); none for a
    // new diagram, which gets its file on the first save.
    path: string | null;
    // The slide's picture of it: keeps its width, follows new proportions.
    image?: { file: string; hash: string; loc: string };
}

let open: HTMLElement | null = null;

/** Edit the diagram a selected picture shows. */
export function editDiagram(sel: Selected): void {
    const image = diagramOf(sel.el);
    const src = sourceOf(sel.key);
    if (!image || !src) return;
    if (!src.writable) {
        toast("This picture lives in a layout; switch to layout mode", "error");
        return;
    }
    void openDrawio({
        path: hrefOf(image),
        image: {
            file: src.path,
            hash: src.hash,
            loc: image.getAttribute("data-ink") ?? sel.loc,
        },
    });
}

/** Draw a new diagram; it is placed on the slide when first saved. */
export function newDiagram(): void {
    if (!currentSlide()) return;
    void openDrawio({ path: null });
}

async function openDrawio(target: Target): Promise<void> {
    if (open) return;
    const res = await request({ action: "drawio-load", path: target.path });
    if (!res.ok) {
        toast(res.error ?? "Cannot open that diagram", "error");
        return;
    }
    const base = String(res.url);
    let origin: string;
    try {
        origin = new URL(base).origin;
    } catch {
        toast(`INKFLOW_DRAWIO_URL is not a web address: ${base}`, "error");
        return;
    }
    const dark = document.documentElement.dataset.theme !== "light";
    const params = new URLSearchParams({
        embed: "1",
        proto: "json",
        spin: "1",
        configure: "1",
        saveAndExit: "1",
        noSaveBtn: "0",
        libraries: "1",
        modified: "unsavedChanges",
        ui: dark ? "dark" : "kennedy",
    });
    const frame = h("iframe", {
        class: "drawio-frame",
        src: `${base}${base.includes("?") ? "&" : "?"}${params}`,
        title: "draw.io",
    }) as HTMLIFrameElement;
    const note = h(
        "div",
        { class: "drawio-note" },
        `Loading draw.io from ${origin}…`,
    );
    const wrap = h("div", { id: "drawio", class: "drawio" }, frame, note);
    document.body.append(wrap);
    open = wrap;

    let path = target.path;
    let exitAfterSave = false;
    let saving = false;
    const post = (msg: Record<string, unknown>) =>
        frame.contentWindow?.postMessage(JSON.stringify(msg), origin);

    const close = () => {
        window.removeEventListener("message", onMessage);
        wrap.remove();
        open = null;
    };

    const save = async (svg: string) => {
        const first = path === null;
        const result = await edit({
            action: "drawio-save",
            path,
            svg,
            image: first ? undefined : target.image,
        });
        saving = false;
        if (!result.ok) {
            post({ action: "status", message: "Not saved", modified: true });
            return;
        }
        if (first && typeof result.rel === "string") {
            path = result.rel;
            // Its picture goes on the slide, sized to the diagram.
            await insertDiagramImage(
                String(result.path),
                Number(result.width) || 640,
                Number(result.height) || 360,
            );
        }
        if (exitAfterSave) close();
        else post({ action: "status", message: "Saved", modified: false });
    };

    const onMessage = (e: MessageEvent) => {
        if (e.source !== frame.contentWindow || e.origin !== origin) return;
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(String(e.data));
        } catch {
            return;
        }
        switch (msg.event) {
            case "configure":
                // Uncompressed source: readable diffs (the server makes
                // sure anyway).
                post({ action: "configure", config: { compressXml: false } });
                break;
            case "init":
                note.remove();
                post({
                    action: "load",
                    xml: String(res.xml ?? ""),
                    autosave: 0,
                    title: String(res.name ?? "Diagram"),
                });
                break;
            case "save":
                if (saving) break;
                saving = true;
                exitAfterSave = !!msg.exit;
                // The editable SVG: the picture plus the diagram's source.
                post({ action: "export", format: "xmlsvg", spin: "Saving" });
                break;
            case "export": {
                const data = String(msg.data ?? "");
                const svg = decodeSvg(data);
                if (svg) void save(svg);
                else {
                    saving = false;
                    toast("draw.io sent something other than an SVG", "error");
                }
                break;
            }
            case "exit":
                close();
                break;
        }
    };
    window.addEventListener("message", onMessage);
}

/** An SVG data URI (base64 or plain) as text. */
export function decodeSvg(data: string): string | null {
    const m = data.match(/^data:image\/svg\+xml(;base64)?,(.*)$/s);
    if (!m) return data.trimStart().startsWith("<") ? data : null;
    if (!m[1]) return decodeURIComponent(m[2]);
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

export function drawioOpen(): boolean {
    return open !== null;
}
