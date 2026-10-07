// The DOM side of authored camera moves: finds a slide's `data-camera` cues, measures their
// targets, and writes the slide root's `viewBox`. The math lives in `camera.ts`.
//
// Targets are measured in the browser because only it knows the real extent of text and
// transformed groups. The result is in the slide's authored user space, whatever the
// current viewBox is.

import {
    type CameraTimeline,
    cameraTimeline,
    fitFrame,
    parseCameraCues,
    type ResolveView,
    restingCamera,
    stepStartView,
} from "./camera";
import { formatViewBox, parseViewBox, type ViewBox } from "./viewbox";

// The authored viewBox of each slide root, captured before the camera first writes it.
const authoredViews = new WeakMap<SVGSVGElement, ViewBox>();

// `root` is either a slide <svg> or a container holding one (the stage).
function cameraSvg(root: Element): SVGSVGElement | null {
    const svg = root.matches("svg[data-camera]")
        ? root
        : root.querySelector("svg[data-camera]");
    return svg instanceof SVGSVGElement ? svg : null;
}

function authoredView(svg: SVGSVGElement): ViewBox {
    let view = authoredViews.get(svg);
    if (!view) {
        view = parseViewBox(svg.getAttribute("viewBox"));
        authoredViews.set(svg, view);
    }
    return view;
}

// Frames are usually kept on a hidden layer so they never paint, and a `display: none`
// element has no box. Lift `display: none` on the target and its ancestors for the
// duration of `measure`, then restore it. It all happens in one task, so nothing paints.
function measureShown<T>(svg: SVGSVGElement, el: Element, measure: () => T): T {
    const lifted: { node: SVGElement; value: string; priority: string }[] = [];
    for (
        let node: Element | null = el;
        node && node !== svg;
        node = node.parentElement
    ) {
        if (
            node instanceof SVGElement &&
            getComputedStyle(node).display === "none"
        ) {
            lifted.push({
                node,
                value: node.style.getPropertyValue("display"),
                priority: node.style.getPropertyPriority("display"),
            });
            node.style.setProperty("display", "inline", "important");
        }
    }
    try {
        return measure();
    } finally {
        for (const { node, value, priority } of lifted.reverse()) {
            if (value) node.style.setProperty("display", value, priority);
            else node.style.removeProperty("display");
        }
    }
}

// The target's bounding box in the slide's user space, or null when it is missing or
// cannot be measured (a preview that is not laid out has no usable screen matrix).
// Measured like morph.ts does: getBBox() mapped through getScreenCTM(), here relative to
// the slide root's own screen matrix, so the result holds whatever the current viewBox is.
function targetRect(svg: SVGSVGElement, id: string): ViewBox | null {
    const el = svg.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!(el instanceof SVGGraphicsElement)) return null;
    return measureShown(svg, el, () => {
        const svgMatrix = svg.getScreenCTM();
        const elMatrix = el.getScreenCTM();
        if (!svgMatrix || !elMatrix) return null;
        const toSlide = DOMMatrix.fromMatrix(svgMatrix)
            .inverse()
            .multiply(DOMMatrix.fromMatrix(elMatrix));
        const box = el.getBBox();
        const corners = [
            new DOMPoint(box.x, box.y),
            new DOMPoint(box.x + box.width, box.y),
            new DOMPoint(box.x, box.y + box.height),
            new DOMPoint(box.x + box.width, box.y + box.height),
        ].map((point) => point.matrixTransform(toSlide));
        const xs = corners.map((point) => point.x);
        const ys = corners.map((point) => point.y);
        const rect = {
            x: Math.min(...xs),
            y: Math.min(...ys),
            w: Math.max(...xs) - Math.min(...xs),
            h: Math.max(...ys) - Math.min(...ys),
        };
        return Object.values(rect).every(Number.isFinite) ? rect : null;
    });
}

function resolver(svg: SVGSVGElement): ResolveView {
    const base = authoredView(svg);
    return (cue) => {
        const rect = cue.target === null ? null : targetRect(svg, cue.target);
        return rect ? fitFrame(rect, cue.margin, base) : { ...base };
    };
}

function writeView(svg: SVGSVGElement, view: ViewBox): void {
    svg.setAttribute("viewBox", formatViewBox(view));
}

// Land the camera on `step`'s resting view. No-op on a slide without camera cues.
export function applyCameraInstant(root: Element, step: number): void {
    const svg = cameraSvg(root);
    if (!svg) return;
    const cues = parseCameraCues(svg.getAttribute("data-camera"));
    writeView(svg, restingCamera(cues, step, authoredView(svg), resolver(svg)));
}

// The camera part of the run played when arriving at `step`: one seekable timeline from the
// previous step's resting view (the authored view for step 0). Null when `step` has no
// camera cues.
export function cameraRun(
    root: Element,
    step: number,
): { timeline: CameraTimeline; seek: (timeMs: number) => void } | null {
    const svg = cameraSvg(root);
    if (!svg) return null;
    const cues = parseCameraCues(svg.getAttribute("data-camera"));
    const stepCues = cues.filter((c) => c.step === step);
    if (stepCues.length === 0) return null;
    const resolve = resolver(svg);
    const timeline = cameraTimeline(
        stepCues,
        stepStartView(cues, step, authoredView(svg), resolve),
        resolve,
    );
    return { timeline, seek: (timeMs) => writeView(svg, timeline.at(timeMs)) };
}

// The highest camera step; reads only the markup, so it works on a detached tree.
export function maxCameraStep(root: Element): number {
    const svg = root.matches("[data-camera]")
        ? root
        : root.querySelector("[data-camera]");
    const cues = parseCameraCues(svg?.getAttribute("data-camera") ?? null);
    return cues.reduce((m, c) => Math.max(m, c.step), 0);
}
