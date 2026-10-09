// The slide list on the left: thumbnails of every slide in deck order, hidden
// slides included (dimmed). Click to edit a slide, drag to reorder, and the
// context menu / "+" button add, duplicate, hide and delete slides. Every
// change is a structured edit of the Deck(slides=[...]) list in deck.py.

import { parseViewBox } from "../shared/viewbox";
import {
    copySlides,
    cutSlides,
    followPastedSlides,
    pasteFromClipboard,
} from "./clipboard";
import { clear, h, icon, toast } from "./dom";
import { openGallery } from "./gallery";
import { edit } from "./net";
import { ed, emit, on } from "./state";
import type { SlideModel } from "./types";

const list = document.getElementById("sorter-list")!;
const addBtn = document.getElementById("sorter-add")!;
const menu = document.getElementById("context-menu")!;

let dragFrom: number | null = null;

// Click picks one slide; Ctrl/Cmd adds or removes one, Shift a range (for
// copying, cutting or deleting several at once).
export function pickSlide(i: number, e: MouseEvent): void {
    ed.focus = "sorter";
    if (e.shiftKey) {
        const [a, b] = [Math.min(ed.current, i), Math.max(ed.current, i)];
        for (let k = a; k <= b; k++) ed.slideSelection.add(k);
        renderSorter();
        return;
    }
    if (e.ctrlKey || e.metaKey) {
        if (!ed.slideSelection.size) ed.slideSelection.add(ed.current);
        if (ed.slideSelection.has(i)) ed.slideSelection.delete(i);
        else ed.slideSelection.add(i);
        renderSorter();
        if (ed.slideSelection.has(i)) gotoSlide(i);
        return;
    }
    ed.slideSelection.clear();
    if (i === ed.current) renderSorter();
    else gotoSlide(i);
}

export async function deleteSlides(): Promise<void> {
    const indices = [...ed.slideSelection].sort((a, b) => a - b);
    if (indices.length <= 1) {
        await deleteSlide(indices[0] ?? ed.current);
        return;
    }
    if (
        !window.confirm(
            `Delete ${indices.length} slides from the deck? (Their files stay on disk.)`,
        )
    ) {
        return;
    }
    const result = await edit({
        action: "slide",
        op: "delete",
        slides: indices,
    });
    if (result.ok) {
        ed.slideSelection.clear();
        ed.current = Math.max(0, indices[0] - 1);
        emit("slide");
    }
}

export function gotoSlide(deckIndex: number): void {
    const n = ed.model?.slides.length ?? 0;
    if (!n) return;
    const i = Math.max(0, Math.min(n - 1, deckIndex));
    if (i === ed.current) return;
    ed.current = i;
    ed.selection = [];
    ed.scope = null;
    emit("slide");
}

// Thumbnails keyed by their SVG: an edit re-renders only the slides it changed.
// Each view (the slide list, the grid) keeps its own cache, since a DOM node can
// only be in one place.
export class Thumbs {
    private cache = new Map<string, HTMLElement>();
    private used = new Map<string, HTMLElement>();

    begin(): void {
        this.used = new Map();
    }

    end(): void {
        this.cache = this.used;
    }

    thumb(slide: SlideModel): HTMLElement {
        const box = h("div", { class: "thumb" });
        if (slide.visibleIndex == null) {
            box.append(h("div", { class: "thumb-hidden" }, icon("eyeOff", 18)));
            return box;
        }
        const data = ed.slides[slide.visibleIndex];
        if (!data) return box;
        const cached = this.cache.get(data.svg);
        if (cached && !this.used.has(data.svg)) {
            this.used.set(data.svg, cached);
            return cached;
        }
        this.used.set(data.svg, box);
        box.innerHTML = data.svg;
        const svg = box.querySelector("svg");
        if (svg) {
            const vb = parseViewBox(svg.getAttribute("viewBox"));
            svg.setAttribute("width", "100%");
            svg.setAttribute("height", "100%");
            svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
            svg.style.aspectRatio = `${vb.w} / ${vb.h}`;
            // Thumbnails show the slide's final state, not its first build step.
            svg.querySelectorAll(".anim-pending").forEach((el) => {
                el.classList.remove("anim-pending");
            });
            svg.querySelectorAll("video").forEach((v) => {
                v.removeAttribute("autoplay");
            });
            // Ids inside thumbnails would shadow the canvas's own for url(#…)
            // lookups only if they came first in the document; the canvas does
            // (see editor.html).
        }
        return box;
    }
}

const thumbs = new Thumbs();

export function renderSorter(): void {
    clear(list);
    thumbs.begin();
    const slides = ed.model?.slides ?? [];
    slides.forEach((slide, i) => {
        const item = h(
            "div",
            {
                class: `sorter-item${i === ed.current ? " active" : ""}${ed.slideSelection.has(i) ? " picked" : ""}${slide.visible ? "" : " hidden-slide"}`,
                draggable: ed.model?.deckEditable ? "true" : null,
                title: slide.title ?? slide.id ?? slide.src,
                "data-index": i,
            },
            h("span", { class: "sorter-num" }, String(i + 1)),
            thumbs.thumb(slide),
        );
        item.addEventListener("click", (e) => pickSlide(i, e));
        item.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            ed.focus = "sorter";
            if (!ed.slideSelection.has(i)) {
                ed.slideSelection.clear();
                gotoSlide(i);
            }
            openSlideMenu(e.clientX, e.clientY, i);
        });
        item.addEventListener("dragstart", (e) => {
            dragFrom = i;
            e.dataTransfer?.setData("text/plain", String(i));
            item.classList.add("dragging");
        });
        item.addEventListener("dragend", () => {
            dragFrom = null;
            item.classList.remove("dragging");
            list.querySelectorAll(".drop-before, .drop-after").forEach((el) => {
                el.classList.remove("drop-before", "drop-after");
            });
        });
        item.addEventListener("dragover", (e) => {
            if (dragFrom == null) return;
            e.preventDefault();
            const r = item.getBoundingClientRect();
            const after = e.clientY > r.top + r.height / 2;
            item.classList.toggle("drop-after", after);
            item.classList.toggle("drop-before", !after);
        });
        item.addEventListener("dragleave", () => {
            item.classList.remove("drop-before", "drop-after");
        });
        item.addEventListener("drop", (e) => {
            e.preventDefault();
            if (dragFrom == null) return;
            const r = item.getBoundingClientRect();
            const after = e.clientY > r.top + r.height / 2;
            let to = after ? i + 1 : i;
            if (dragFrom < to) to -= 1;
            void moveSlide(dragFrom, to);
        });
        list.append(item);
    });
    thumbs.end();
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

export async function moveSlide(from: number, to: number): Promise<void> {
    if (from === to) return;
    const result = await edit({ action: "slide", op: "move", from, to });
    if (result.ok) {
        ed.current = to;
        emit("slide");
    }
}

export async function newSlide(
    layout: string | null,
    after = ed.current,
): Promise<void> {
    const result = await edit({
        action: "slide",
        op: "new",
        after,
        layout,
        name: "slide",
    });
    if (result.ok && result.select != null) pendingSelect = result.select;
}

export async function duplicateSlide(i = ed.current): Promise<void> {
    const result = await edit({ action: "slide", op: "duplicate", slide: i });
    if (result.ok && result.select != null) pendingSelect = result.select;
}

export async function deleteSlide(i = ed.current): Promise<void> {
    const slide = ed.model?.slides[i];
    if (!slide) return;
    const name = slide.title ?? slide.id ?? `slide ${i + 1}`;
    if (
        !window.confirm(
            `Delete “${name}” from the deck? (Its files stay on disk.)`,
        )
    ) {
        return;
    }
    const result = await edit({ action: "slide", op: "delete", slide: i });
    if (result.ok) {
        ed.current = Math.max(0, i - 1);
        emit("slide");
    }
}

export async function toggleHidden(i = ed.current): Promise<void> {
    const slide = ed.model?.slides[i];
    if (!slide) return;
    await edit({
        action: "slide",
        op: "hide",
        slide: i,
        hidden: slide.visible,
    });
}

// After an insert, follow the new slide once the rebuild lists it.
let pendingSelect: number | null = null;

export function closeMenu(): void {
    menu.classList.remove("open");
    clear(menu);
}

export function menuItem(
    label: string,
    fn: () => void,
    disabled = false,
): HTMLElement {
    return h(
        "button",
        {
            type: "button",
            class: "menu-item",
            disabled,
            onclick: () => {
                closeMenu();
                fn();
            },
        },
        label,
    );
}

export function openSlideMenu(x: number, y: number, i: number): void {
    const slide = ed.model?.slides[i];
    const editable = !!ed.model?.deckEditable;
    const many = ed.slideSelection.size > 1;
    clear(menu);
    menu.append(
        menuItem(
            many ? `Copy ${ed.slideSelection.size} slides` : "Copy",
            () => void copySlides(),
        ),
    );
    menu.append(
        menuItem(
            many ? "Cut slides" : "Cut",
            () => void cutSlides(),
            !editable,
        ),
    );
    menu.append(
        menuItem(
            "Paste after this slide",
            () => void pasteFromClipboard(),
            !editable,
        ),
    );
    if (many) {
        menu.append(
            menuItem(
                `Delete ${ed.slideSelection.size} slides`,
                () => void deleteSlides(),
                !editable,
            ),
        );
        showMenu(x, y);
        return;
    }
    menu.append(
        menuItem(
            "New slide after…",
            () => void openGallery({ mode: "insert", after: i }),
            !editable,
        ),
    );
    menu.append(menuItem("Duplicate", () => void duplicateSlide(i), !editable));
    menu.append(
        menuItem(
            slide?.visible ? "Hide (skip in presentation)" : "Show",
            () => void toggleHidden(i),
            !editable,
        ),
    );
    menu.append(menuItem("Delete", () => void deleteSlide(i), !editable));
    showMenu(x, y);
}

export function showMenu(x: number, y: number): void {
    menu.classList.add("open");
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
}

export function initSorter(): void {
    on("model", () => {
        followPastedSlides();
        const n = ed.model?.slides.length ?? 0;
        if (pendingSelect != null && pendingSelect < n) {
            ed.current = pendingSelect;
            pendingSelect = null;
            emit("slide");
        }
        if (ed.current >= n) ed.current = Math.max(0, n - 1);
        renderSorter();
    });
    on("slide", renderSorter);
    on("slide-selection", renderSorter);
    addBtn.addEventListener("click", () => {
        if (!ed.model?.deckEditable) {
            toast(
                "deck.py builds its slides in code; add slides there",
                "error",
            );
            return;
        }
        void openGallery({ mode: "insert", after: ed.current });
    });
    document.addEventListener("pointerdown", (e) => {
        if (!menu.contains(e.target as Node)) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMenu();
    });
}
