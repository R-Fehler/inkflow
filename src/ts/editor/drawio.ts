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

import { connectorsTo, isStale, rerouteConnectors } from "./canvas";
import { pictureOf } from "./crop";
import { closeDialog, openDialog } from "./dialog";
import { h, toast } from "./dom";
import { insertDiagramImage } from "./insert";
import { edit, request } from "./net";
import { currentSlide, off, on, sourceOf } from "./state";
import type { Selected } from "./types";

/**
 * A draw.io diagram on the slide: its picture, or the diagram drawn into the
 * slide (an <svg> standing in for that picture, see drawio_inline.py).
 */
export function diagramOf(el: Element): SVGGraphicsElement | null {
    const drawn = drawnDiagram(el);
    if (drawn) return drawn;
    const image = pictureOf(el);
    return image && isDiagramHref(hrefOf(image)) ? image : null;
}

/** A diagram drawn into the slide (inkflow:drawio="inline" / "themed"). */
export function drawnDiagram(el: Element): SVGSVGElement | null {
    return el.localName === "svg" && el.hasAttribute("data-drawio")
        ? (el as SVGSVGElement)
        : null;
}

export function isDiagramHref(href: string): boolean {
    return /\.drawio\.svg$/i.test(href.split(/[?#]/)[0]);
}

function hrefOf(el: Element): string {
    return (
        el.getAttribute("data-drawio") ??
        el.getAttribute("href") ??
        el.getAttribute("xlink:href") ??
        ""
    ).split(/[?#]/)[0];
}

export type DiagramMode = "picture" | "inline" | "themed";

export const DIAGRAM_MODES: { value: DiagramMode; label: string }[] = [
    { value: "picture", label: "Picture" },
    { value: "inline", label: "Drawn on the slide" },
    { value: "themed", label: "In the deck's theme" },
];

export function diagramMode(el: Element): DiagramMode {
    const mode = drawnDiagram(el)?.getAttribute("data-drawio-mode");
    return mode === "inline" || mode === "themed" ? mode : "picture";
}

interface Target {
    // The diagram file (project-relative, as the slide shows it); none for a
    // new diagram, which gets its file on the first save.
    path: string | null;
    // The slide's picture of it: keeps its width, follows new proportions.
    image?: { file: string; hash: string; loc: string };
    // Its id: arrows attached to it or its shapes follow a save.
    id?: string | null;
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
        id: image.getAttribute("id"),
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
    const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origin);
    if (!navigator.onLine && !local) {
        offerDesktop(
            target,
            `This computer is offline, and draw.io loads from ${origin}.`,
        );
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
    let path = target.path;
    let exitAfterSave = false;
    let saving = false;
    let loaded = false;
    const status = h("p", {}, `Loading draw.io from ${origin}…`);
    const note = h(
        "div",
        { class: "drawio-note" },
        h(
            "div",
            { class: "drawio-note-card" },
            status,
            h(
                "div",
                { class: "btn-row" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        title: "Draw it in the draw.io app on this computer (no internet needed)",
                        onclick: () => {
                            close();
                            void useDesktop({ ...target, path });
                        },
                    },
                    "Use draw.io desktop instead",
                ),
                h(
                    "button",
                    { type: "button", class: "pbtn", onclick: () => close() },
                    "Cancel",
                ),
            ),
        ),
    );
    const wrap = h("div", { id: "drawio", class: "drawio" }, frame, note);
    document.body.append(wrap);
    open = wrap;
    // No word from draw.io: most likely no internet (or a wrong address).
    const slow = window.setTimeout(() => {
        if (loaded) return;
        status.textContent = `draw.io did not load from ${origin}. Is this computer offline? Draw the diagram in draw.io desktop instead.`;
        note.classList.add("failed");
    }, 15000);

    const post = (msg: Record<string, unknown>) =>
        frame.contentWindow?.postMessage(JSON.stringify(msg), origin);

    const close = () => {
        window.clearTimeout(slow);
        window.removeEventListener("message", onMessage);
        wrap.remove();
        open = null;
    };

    const save = async (svg: string) => {
        const first = path === null;
        // The arrows' re-routing joins the save's undo step.
        const step = `drawio-save-${Date.now()}`;
        const result = await edit({
            action: "drawio-save",
            path,
            svg,
            image: first ? undefined : target.image,
            coalesce: step,
        });
        if (result.ok && !first && target.id) followArrows(target.id, step);
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
                loaded = true;
                // Uncompressed source: readable diffs (the server makes
                // sure anyway).
                post({ action: "configure", config: { compressXml: false } });
                break;
            case "init":
                loaded = true;
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

// Arrows attached to a diagram (or its shapes, when drawn into the slide)
// follow it once the slide shows the saved diagram.
function followArrows(id: string, step: string): void {
    const rendered = () => {
        off("render", rendered);
        window.clearTimeout(give);
        const stale = connectorsTo(id).filter(isStale);
        if (stale.length)
            void rerouteConnectors(stale, "Re-route arrows", step);
    };
    const give = window.setTimeout(() => off("render", rendered), 10000);
    on("render", rendered);
}

// ── draw.io desktop (no internet needed) ──

function offerDesktop(target: Target, why: string): void {
    openDialog(
        "Draw in draw.io desktop?",
        h(
            "div",
            { class: "deck-form" },
            h("p", {}, why),
            h(
                "p",
                { class: "hint" },
                "The diagram can be drawn in the draw.io app on this computer instead: save there, and the slide updates.",
            ),
            h(
                "div",
                { class: "btn-row end" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        onclick: () => closeDialog(),
                    },
                    "Cancel",
                ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn primary",
                        onclick: () => {
                            closeDialog();
                            void useDesktop(target);
                        },
                    },
                    "Open in draw.io desktop",
                ),
            ),
        ),
    );
}

// A new diagram first gets its file (a placeholder picture on the slide),
// then draw.io desktop opens it; saving there updates the slide.
async function useDesktop(target: Target): Promise<void> {
    let path = target.path;
    const apps = path ? await request({ action: "open-apps", path }) : null;
    if (path && !hasDesktop(apps?.apps)) {
        desktopMissing();
        return;
    }
    if (!path) {
        const made = await edit({ action: "drawio-new" });
        if (!made.ok || typeof made.rel !== "string") return;
        path = made.rel;
        const placed = await insertDiagramImage(
            String(made.path),
            Number(made.width) || 640,
            Number(made.height) || 360,
        );
        if (!placed) return;
        const found = await request({ action: "open-apps", path });
        if (!hasDesktop(found.apps)) {
            desktopMissing();
            return;
        }
    }
    const res = await request({ action: "open-file", path, app: "drawio" });
    if (!res.ok) {
        toast(res.error ?? "draw.io desktop did not start", "error");
        return;
    }
    toast("Opened in draw.io desktop: save there and the slide updates", "ok");
}

function hasDesktop(apps: unknown): boolean {
    return (
        Array.isArray(apps) &&
        apps.some((a) => (a as { id?: string }).id === "drawio")
    );
}

function desktopMissing(): void {
    openDialog(
        "draw.io desktop is not installed",
        h(
            "div",
            { class: "deck-form" },
            h(
                "p",
                {},
                "Install the draw.io app (free) on this computer, then try again:",
            ),
            h(
                "ul",
                {},
                h(
                    "li",
                    {},
                    h(
                        "a",
                        {
                            href: "https://www.drawio.com/",
                            target: "_blank",
                            rel: "noopener",
                        },
                        "drawio.com",
                    ),
                    " (Windows, macOS, Linux)",
                ),
                h(
                    "li",
                    {},
                    "Linux: flatpak install flathub com.jgraph.drawio.desktop",
                ),
            ),
            h(
                "p",
                { class: "hint" },
                "Or run draw.io on your own network (the jgraph/drawio Docker image) and start inkflow with INKFLOW_DRAWIO_URL pointing at it.",
            ),
        ),
    );
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
