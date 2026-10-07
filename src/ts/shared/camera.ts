// Pure math for authored camera moves: the `animations.Zoom` cues that pipeline.py writes
// to a slide root's `data-camera`. Everything here is in SVG user units and independent of
// the DOM; `camera-dom.ts` measures targets and writes the `viewBox`.
//
// A step's cues form a camera timeline that its step run seeks, so a camera move reverses
// and snaps exactly like the element animations. The resting camera at a step is that
// timeline's end. The arrival state (step -1, landed while an entry transition runs) is the
// step-0 timeline at time 0: a zero-length step-0 zoom is already in place when the slide
// arrives, a timed one plays once it has.
//
// Unrelated to the `transitions.Zoom` slide transition.

import { cubicBezierEasing } from "./easing";
import type { ViewBox } from "./viewbox";
import { clampToBounds } from "./zoom-camera";

export interface CameraCue {
    step: number;
    offset: number; // seconds from its run's start where this cue's slot begins
    target: string | null; // element id, or null for the full slide
    margin: number;
    opts: { duration: number; delay: number; easing: string };
}

// Maps a cue to the view it frames; supplied by the DOM side (or a test).
export type ResolveView = (cue: CameraCue) => ViewBox;

export function parseCameraCues(raw: string | null): CameraCue[] {
    if (!raw) return [];
    try {
        return JSON.parse(raw) as CameraCue[];
    } catch {
        return [];
    }
}

// ── Framing ─────────────────────────────────────────────────────────────────────

// The view that shows `rect` plus `margin` on every side, grown to `base`'s aspect ratio
// around its centre (the slide box is sized from the viewBox, so the aspect must not
// change) and kept inside the canvas. A target with no extent frames the full slide.
export function fitFrame(
    rect: ViewBox,
    margin: number,
    base: ViewBox,
): ViewBox {
    let w = rect.w + 2 * margin;
    let h = rect.h + 2 * margin;
    if (w <= 0 && h <= 0) return { ...base };
    const aspect = base.w / base.h;
    if (w / aspect > h) h = w / aspect;
    else w = h * aspect;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    return clampToBounds({ x: cx - w / 2, y: cy - h / 2, w, h }, base);
}

// ── Path ────────────────────────────────────────────────────────────────────────

// "Smooth and efficient zooming and panning" (van Wijk & Nuij, 2003), as in d3's
// interpolateZoom: the camera zooms out while it pans and back in as it arrives, by as much
// as the distance calls for. Neighbouring frames get an almost direct move, distant ones a
// higher arc. A move with no pan reduces to interpolating the scale logarithmically, which
// a plain linear blend of the width does not do (it rushes, then crawls).
const RHO = Math.SQRT2;
const RHO2 = 2;
const RHO4 = 4;
const EPSILON2 = 1e-12;

export function zoomPath(from: ViewBox, to: ViewBox): (t: number) => ViewBox {
    const cx0 = from.x + from.w / 2;
    const cy0 = from.y + from.h / 2;
    const cx1 = to.x + to.w / 2;
    const cy1 = to.y + to.h / 2;
    const w0 = from.w;
    const w1 = to.w;
    const dx = cx1 - cx0;
    const dy = cy1 - cy0;
    const d2 = dx * dx + dy * dy;
    const aspect0 = from.h / from.w;
    const aspect1 = to.h / to.w;

    const view = (t: number, cx: number, cy: number, w: number): ViewBox => {
        const h = w * (aspect0 + (aspect1 - aspect0) * t);
        return { x: cx - w / 2, y: cy - h / 2, w, h };
    };

    let at: (t: number) => ViewBox;
    if (d2 < EPSILON2) {
        at = (t) => view(t, cx0 + dx * t, cy0 + dy * t, w0 * (w1 / w0) ** t);
    } else {
        const d1 = Math.sqrt(d2);
        const b0 = (w1 * w1 - w0 * w0 + RHO4 * d2) / (2 * w0 * RHO2 * d1);
        const b1 = (w1 * w1 - w0 * w0 - RHO4 * d2) / (2 * w1 * RHO2 * d1);
        const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
        const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
        const length = (r1 - r0) / RHO;
        at = (t) => {
            const s = t * length;
            const coshR0 = Math.cosh(r0);
            const u =
                (w0 / (RHO2 * d1)) *
                (coshR0 * Math.tanh(RHO * s + r0) - Math.sinh(r0));
            return view(
                t,
                cx0 + u * dx,
                cy0 + u * dy,
                (w0 * coshR0) / Math.cosh(RHO * s + r0),
            );
        };
    }
    return (t) => (t <= 0 ? { ...from } : t >= 1 ? { ...to } : at(t));
}

// ── Timeline ────────────────────────────────────────────────────────────────────

interface Segment {
    startMs: number;
    durationMs: number;
    ease: (progress: number) => number;
    to: ViewBox;
    path: ((t: number) => ViewBox) | null; // set once its starting view is known
}

// One step's camera cues as a seekable timeline starting from `start`. Each cue begins at
// its slot `offset` plus its `delay` and moves from wherever the camera is at that moment,
// so a cue that starts while another is still moving takes over smoothly.
export interface CameraTimeline {
    totalMs: number;
    at(timeMs: number): ViewBox;
}

export function cameraTimeline(
    cues: readonly CameraCue[],
    start: ViewBox,
    resolve: ResolveView,
): CameraTimeline {
    const segments: Segment[] = cues
        .map((cue) => ({
            startMs:
                (Math.max(0, cue.offset) + Math.max(0, cue.opts.delay)) * 1000,
            durationMs: Math.max(0, cue.opts.duration) * 1000,
            ease: cubicBezierEasing(cue.opts.easing),
            to: resolve(cue),
            path: null as ((t: number) => ViewBox) | null,
        }))
        .sort((a, b) => a.startMs - b.startMs); // stable: ties keep cue order

    const evaluate = (timeMs: number, upTo: number): ViewBox => {
        let current: Segment | null = null;
        for (let i = 0; i < upTo; i++) {
            if (segments[i].startMs <= timeMs) current = segments[i];
        }
        if (!current?.path) return { ...start };
        const progress =
            current.durationMs > 0
                ? Math.min(1, (timeMs - current.startMs) / current.durationMs)
                : 1;
        return current.path(current.ease(progress));
    };

    segments.forEach((segment, i) => {
        segment.path = zoomPath(evaluate(segment.startMs, i), segment.to);
    });

    return {
        totalMs: segments.reduce(
            (m, s) => Math.max(m, s.startMs + s.durationMs),
            0,
        ),
        at: (timeMs) => evaluate(timeMs, segments.length),
    };
}

// The view a step's timeline starts from: the previous step's resting view, or the authored
// view for step 0 (whose time-0 state is the arrival view, so it cannot start from it).
export function stepStartView(
    cues: readonly CameraCue[],
    step: number,
    base: ViewBox,
    resolve: ResolveView,
): ViewBox {
    return step <= 0
        ? { ...base }
        : restingCamera(cues, step - 1, base, resolve);
}

// The camera at rest on `step`: every step's timeline played to its end, in order, from the
// authored view. Step -1 is the arrival state, the step-0 timeline at time 0.
export function restingCamera(
    cues: readonly CameraCue[],
    step: number,
    base: ViewBox,
    resolve: ResolveView,
): ViewBox {
    let view = { ...base };
    const steps = [...new Set(cues.map((c) => c.step))].sort((a, b) => a - b);
    for (const s of steps) {
        if (s > Math.max(step, 0)) break;
        const timeline = cameraTimeline(
            cues.filter((c) => c.step === s),
            view,
            resolve,
        );
        view = timeline.at(step < 0 ? 0 : Number.POSITIVE_INFINITY);
    }
    return view;
}
