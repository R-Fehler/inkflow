// The shapes of a draw.io diagram drawn into its slide (drawio_inline.py):
// each draw.io cell is a <g data-cell-id> named <diagram id>-<cell id>, which
// is what an animation targets.

export interface DiagramShape {
    id: string;
    label: string;
    el: SVGGElement;
}

/** The diagram's shapes and arrows, in drawing order. */
export function diagramShapes(svg: Element): DiagramShape[] {
    const shapes: DiagramShape[] = [];
    for (const g of svg.querySelectorAll<SVGGElement>("g[data-cell-id]")) {
        const parent = g.parentElement?.closest("g[data-cell-id]");
        // The root cell and its layers hold everything.
        if (!parent?.parentElement?.closest("g[data-cell-id]")) continue;
        const id = g.getAttribute("id");
        if (id) shapes.push({ id, label: cellLabel(g), el: g });
    }
    return shapes;
}

// A cell's own label (not the labels of cells inside it), read from its HTML
// label, else its SVG text (draw.io writes both, the text as a fallback).
function cellLabel(g: Element): string {
    const own = (sel: string) =>
        [...g.querySelectorAll(sel)].filter(
            (el) => el.closest("g[data-cell-id]") === g,
        );
    for (const el of [...own("foreignObject"), ...own("text")]) {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) return text;
    }
    return "";
}
