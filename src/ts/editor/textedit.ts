// In-place text editing.
//
// SVG <text> has no editable state of its own, so double-clicking one lays a
// borderless textarea over it in the same font and size; committing writes the
// lines back (one tspan per line, as Inkscape does). A zone filled with Markdown
// opens a textarea on its source Markdown with a small formatting bar, and the
// slide re-renders live as you type (each keystroke batch is one undo step).

import { clear, h, icon, toast } from "./dom";
import { edit } from "./net";
import { currentSlide, ed } from "./state";

const layer = document.getElementById("text-layer")!;
const dock = document.getElementById("zone-dock")!;

function closeDock(): void {
    clear(dock);
    document.body.classList.remove("editing-zone");
}

let active: { commit: () => Promise<void>; cancel: () => void } | null = null;

export function isEditingText(): boolean {
    return active !== null;
}

export async function finishTextEdit(): Promise<void> {
    const a = active;
    if (!a) return;
    // Cleared before committing: removing the textarea blurs it, and that blur
    // must find nothing left to finish.
    active = null;
    clear(layer);
    closeDock();
    await a.commit();
}

function cancel(): void {
    const a = active;
    if (!a) return;
    active = null;
    clear(layer);
    closeDock();
    a.cancel();
}

function linesOf(el: Element): string[] {
    const spans = [...el.children].filter((c) => c.localName === "tspan");
    if (!spans.length) return [el.textContent ?? ""];
    return spans.map((s) => s.textContent ?? "");
}

export function editSvgText(
    el: SVGGraphicsElement,
    sourcePath: string,
    hash: () => string,
    loc: string,
): void {
    void finishTextEdit();
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const ctm = el.getScreenCTM();
    const fontPx =
        parseFloat(style.fontSize) * (ctm ? Math.hypot(ctm.a, ctm.b) : 1);
    const original = linesOf(el);
    const area = h("textarea", {
        class: "svg-text-editor",
        spellcheck: "true",
    });
    area.value = original.join("\n");
    const anchor = style.textAnchor;
    Object.assign(area.style, {
        left: `${rect.left - 6}px`,
        top: `${rect.top - 4}px`,
        minWidth: `${Math.max(rect.width + 24, 80)}px`,
        minHeight: `${rect.height + 8}px`,
        fontSize: `${fontPx}px`,
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        lineHeight: "1.2",
        color: style.fill.startsWith("rgb") ? style.fill : "inherit",
        textAlign:
            anchor === "middle"
                ? "center"
                : anchor === "end"
                  ? "right"
                  : "left",
    });
    const autosize = () => {
        area.style.height = "auto";
        area.style.height = `${area.scrollHeight}px`;
        area.style.width = "auto";
        area.style.width = `${Math.max(area.scrollWidth + 8, rect.width + 24)}px`;
    };
    area.addEventListener("input", autosize);
    el.style.visibility = "hidden";
    layer.append(area);
    autosize();
    area.focus();
    area.select();
    active = {
        commit: async () => {
            el.style.visibility = "";
            const lines = area.value.replace(/\r/g, "").split("\n");
            if (lines.join("\n") === original.join("\n")) return;
            // Preview immediately; the rebuild then replaces it with the real render.
            if (lines.length === 1 && !el.querySelector("tspan")) {
                el.textContent = lines[0];
            }
            await edit({
                action: "svg",
                file: sourcePath,
                hash: hash(),
                ops: [{ kind: "text", loc, lines }],
                label: "Edit text",
            });
        },
        cancel: () => {
            el.style.visibility = "";
        },
    };
    area.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
            e.preventDefault();
            cancel();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void finishTextEdit();
        }
    });
    area.addEventListener("blur", () => void finishTextEdit());
}

// ── Markdown zones ──

function wrapSelection(
    area: HTMLTextAreaElement,
    before: string,
    after = before,
): void {
    const { selectionStart: s, selectionEnd: e, value } = area;
    const inner = value.slice(s, e) || "text";
    area.value = value.slice(0, s) + before + inner + after + value.slice(e);
    area.selectionStart = s + before.length;
    area.selectionEnd = s + before.length + inner.length;
    area.dispatchEvent(new Event("input"));
    area.focus();
}

function prefixLines(area: HTMLTextAreaElement, prefix: string): void {
    const { selectionStart: s, selectionEnd: e, value } = area;
    const start = value.lastIndexOf("\n", s - 1) + 1;
    const end = value.indexOf("\n", e);
    const stop = end === -1 ? value.length : end;
    const block = value
        .slice(start, stop)
        .split("\n")
        .map((line) =>
            line.startsWith(prefix) ? line.slice(prefix.length) : prefix + line,
        )
        .join("\n");
    area.value = value.slice(0, start) + block + value.slice(stop);
    area.selectionStart = start;
    area.selectionEnd = start + block.length;
    area.dispatchEvent(new Event("input"));
    area.focus();
}

export function editZoneText(zone: string, box: DOMRect): void {
    void finishTextEdit();
    const slide = currentSlide();
    if (!slide) return;
    const origin = slide.zoneOrigins?.[zone];
    const original = slide.zoneText?.[zone] ?? "";
    const deckIndex = slide.deckIndex;
    if (!ed.model?.deckEditable && (origin === "deck" || !slide.md)) {
        toast(
            "deck.py builds its slides in code; edit this zone there",
            "error",
        );
        return;
    }
    const area = h("textarea", { class: "zone-editor", spellcheck: "true" });
    area.value = original;
    let sent = original;
    let timer = 0;
    const coalesce = `zone-${deckIndex}-${zone}-${Date.now()}`;
    const send = async () => {
        window.clearTimeout(timer);
        if (area.value === sent) return;
        const before = sent;
        sent = area.value;
        const result = await edit(
            {
                action: "zone-text",
                slide: deckIndex,
                zone,
                text: area.value,
                origin,
                coalesce,
            },
            { retrying: true },
        );
        if (!result.ok) {
            sent = before;
            timer = window.setTimeout(() => void send(), 800);
        }
    };
    area.addEventListener("input", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void send(), 450);
    });
    const button = (name: string, title: string, fn: () => void) =>
        h(
            "button",
            {
                type: "button",
                class: "fmt-btn",
                title,
                onmousedown: (e: Event) => {
                    e.preventDefault();
                    fn();
                },
            },
            name,
        );
    const bar = h(
        "div",
        { class: "zone-toolbar" },
        h("span", { class: "zone-label" }, `${zone} · Markdown`),
        button("B", "Bold (Ctrl+B)", () => wrapSelection(area, "**")),
        button("I", "Italic (Ctrl+I)", () => wrapSelection(area, "*")),
        button("H", "Heading", () => prefixLines(area, "## ")),
        button("•", "Bullet list", () => prefixLines(area, "- ")),
        button("1.", "Numbered list", () => prefixLines(area, "1. ")),
        button("`", "Code", () => wrapSelection(area, "`")),
        button("∑", "Math", () => wrapSelection(area, "$")),
        button("⏵", "Reveal on click: insert a ::step:: marker", () => {
            const pos = area.selectionStart;
            area.value = `${area.value.slice(0, pos)}\n::step::\n${area.value.slice(pos)}`;
            area.dispatchEvent(new Event("input"));
        }),
        h(
            "button",
            {
                type: "button",
                class: "fmt-btn done",
                title: "Done (Ctrl+Enter)",
                onmousedown: (e: Event) => {
                    e.preventDefault();
                    void finishTextEdit();
                },
            },
            icon("select", 13),
            " Done",
        ),
    );
    // Docked under the slide (in place of the notes), so the zone itself stays
    // in view and re-renders live as you type.
    void box;
    const wrap = h("div", { class: "zone-edit-wrap" }, bar, area);
    dock.append(wrap);
    document.body.classList.add("editing-zone");
    area.focus();
    active = {
        commit: async () => {
            await send();
        },
        cancel: () => {
            window.clearTimeout(timer);
            if (sent !== original) {
                // Escape restores what the zone said when editing began.
                area.value = original;
                void send();
            }
        },
    };
    area.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
            e.preventDefault();
            cancel();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void finishTextEdit();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
            e.preventDefault();
            wrapSelection(area, "**");
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") {
            e.preventDefault();
            wrapSelection(area, "*");
        }
    });
    area.addEventListener("blur", (e) => {
        const next = (e as FocusEvent).relatedTarget as Node | null;
        if (next && wrap.contains(next)) return;
        void finishTextEdit();
    });
}
