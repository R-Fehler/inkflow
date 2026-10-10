// The grid view (G): every slide as a large thumbnail, like the presenter's
// overview and PowerPoint's slide sorter. It works like the slide list: click
// picks (Ctrl/Shift for several), drag reorders, right-click has the slide
// menu, Ctrl+C / Ctrl+V / Delete act on the picked slides; double-click or
// Enter opens a slide for editing.

import { clear, h } from "./dom";
import {
    gotoSlide,
    moveSlide,
    openSlideMenu,
    pickSlide,
    Thumbs,
} from "./sorter";
import { ed, emit, on } from "./state";

const view = document.getElementById("grid-view")!;
const list = document.getElementById("grid-list")!;
const sizeInput = document.getElementById("grid-size") as HTMLInputElement;
const thumbs = new Thumbs();
let dragFrom: number | null = null;

export function gridOpen(): boolean {
    return !view.hidden;
}

export function toggleGrid(on: boolean = view.hidden === true): void {
    view.hidden = !on;
    document.body.classList.toggle("grid-mode", on);
    document.getElementById("btn-grid")?.classList.toggle("on", on);
    if (on) {
        ed.focus = "sorter"; // Ctrl+C / Delete act on slides here
        renderGrid();
        view.focus();
    } else {
        ed.focus = "canvas";
        emit("slide"); // the canvas re-renders the current slide
    }
}

function open(i: number): void {
    ed.slideSelection.clear();
    toggleGrid(false);
    gotoSlide(i);
}

export function renderGrid(): void {
    if (view.hidden) return;
    clear(list);
    thumbs.begin();
    const slides = ed.model?.slides ?? [];
    slides.forEach((slide, i) => {
        const item = h(
            "div",
            {
                class: `grid-item${i === ed.current ? " active" : ""}${ed.slideSelection.has(i) ? " picked" : ""}${slide.visible ? "" : " hidden-slide"}`,
                draggable: ed.model?.deckEditable ? "true" : null,
                "data-index": i,
            },
            thumbs.thumb(slide),
            h(
                "div",
                { class: "grid-caption" },
                h("span", { class: "grid-num" }, String(i + 1)),
                h(
                    "span",
                    { class: "grid-title" },
                    slide.title ?? slide.id ?? slide.src,
                ),
                slide.animations.length
                    ? h(
                          "span",
                          {
                              class: "grid-badge",
                              title: `${slide.animations.length} animation(s)`,
                          },
                          "✦",
                      )
                    : null,
            ),
        );
        item.addEventListener("click", (e) => {
            pickSlide(i, e);
            ed.focus = "sorter";
        });
        item.addEventListener("dblclick", () => open(i));
        item.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            if (!ed.slideSelection.has(i)) {
                ed.slideSelection.clear();
                gotoSlide(i);
            }
            ed.focus = "sorter";
            openSlideMenu(e.clientX, e.clientY, i);
        });
        item.addEventListener("dragstart", (e) => {
            dragFrom = i;
            e.dataTransfer?.setData("text/plain", String(i));
            item.classList.add("dragging");
        });
        item.addEventListener("dragend", () => {
            dragFrom = null;
            list.querySelectorAll(".drop-before, .drop-after").forEach((el) => {
                el.classList.remove("drop-before", "drop-after");
            });
            item.classList.remove("dragging");
        });
        item.addEventListener("dragover", (e) => {
            if (dragFrom == null) return;
            e.preventDefault();
            const r = item.getBoundingClientRect();
            const after = e.clientX > r.left + r.width / 2;
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
            let to = e.clientX > r.left + r.width / 2 ? i + 1 : i;
            if (dragFrom < to) to -= 1;
            void moveSlide(dragFrom, to);
        });
        list.append(item);
    });
    thumbs.end();
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function columns(): number {
    const items = [...list.children] as HTMLElement[];
    if (items.length < 2) return 1;
    const top = items[0].offsetTop;
    const n = items.findIndex((el) => el.offsetTop !== top);
    return n === -1 ? items.length : n;
}

function onKey(e: KeyboardEvent): void {
    if (view.hidden) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, #dialog, #find-panel")) return;
    const n = ed.model?.slides.length ?? 0;
    const move = (to: number) => {
        e.preventDefault();
        e.stopPropagation();
        ed.slideSelection.clear();
        gotoSlide(Math.max(0, Math.min(n - 1, to)));
    };
    switch (e.key) {
        case "ArrowLeft":
            move(ed.current - 1);
            break;
        case "ArrowRight":
            move(ed.current + 1);
            break;
        case "ArrowUp":
            move(ed.current - columns());
            break;
        case "ArrowDown":
            move(ed.current + columns());
            break;
        case "Home":
            move(0);
            break;
        case "End":
            move(n - 1);
            break;
        case "Enter":
            e.preventDefault();
            e.stopPropagation();
            open(ed.current);
            break;
        case "Escape":
            e.preventDefault();
            e.stopPropagation();
            toggleGrid(false);
            break;
    }
}

function setSize(px: number): void {
    view.style.setProperty("--grid-w", `${px}px`);
    try {
        localStorage.setItem("inkflow-editor-grid", String(px));
    } catch {
        // not remembered
    }
}

export function initGrid(): void {
    document
        .getElementById("btn-grid")
        ?.addEventListener("click", () => toggleGrid());
    document
        .getElementById("grid-close")
        ?.addEventListener("click", () => toggleGrid(false));
    document.addEventListener("keydown", onKey, true);
    let saved = 280;
    try {
        saved = Number(localStorage.getItem("inkflow-editor-grid")) || 280;
    } catch {
        // default size
    }
    sizeInput.value = String(saved);
    setSize(saved);
    sizeInput.addEventListener("input", () => setSize(Number(sizeInput.value)));
    on("model", renderGrid);
    on("slide", renderGrid);
    on("slide-selection", renderGrid);
}
