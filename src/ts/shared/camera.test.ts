import { describe, expect, test } from "vitest";
import {
    type CameraCue,
    cameraTimeline,
    fitFrame,
    parseCameraCues,
    type ResolveView,
    restingCamera,
    zoomPath,
} from "./camera";
import type { ViewBox } from "./viewbox";

const BASE: ViewBox = { x: 0, y: 0, w: 1920, h: 1080 };

const FRAMES: Record<string, ViewBox> = {
    left: { x: 0, y: 0, w: 480, h: 270 },
    right: { x: 1440, y: 810, w: 480, h: 270 },
    middle: { x: 720, y: 405, w: 480, h: 270 },
};

const resolve: ResolveView = (cue) =>
    cue.target === null ? BASE : FRAMES[cue.target];

function cue(
    step: number,
    target: string | null,
    timing: Partial<CameraCue["opts"]> & { offset?: number } = {},
): CameraCue {
    const { offset = 0, ...opts } = timing;
    return {
        step,
        offset,
        target,
        margin: 0,
        opts: { duration: 1, delay: 0, easing: "linear", ...opts },
    };
}

function expectViewClose(actual: ViewBox, expected: ViewBox): void {
    expect(actual.x).toBeCloseTo(expected.x, 6);
    expect(actual.y).toBeCloseTo(expected.y, 6);
    expect(actual.w).toBeCloseTo(expected.w, 6);
    expect(actual.h).toBeCloseTo(expected.h, 6);
}

describe("parseCameraCues", () => {
    test("missing or malformed data is no cues", () => {
        expect(parseCameraCues(null)).toEqual([]);
        expect(parseCameraCues("{not json")).toEqual([]);
    });
});

describe("fitFrame", () => {
    test("a wide strip grows vertically to the slide aspect around its centre", () => {
        const view = fitFrame({ x: 560, y: 500, w: 800, h: 80 }, 0, BASE);
        expect(view).toEqual({ x: 560, y: 315, w: 800, h: 450 });
    });

    test("a tall column grows horizontally", () => {
        const view = fitFrame({ x: 900, y: 270, w: 120, h: 540 }, 0, BASE);
        expect(view).toEqual({ x: 480, y: 270, w: 960, h: 540 });
    });

    test("the margin pads every side before fitting", () => {
        const view = fitFrame({ x: 800, y: 450, w: 320, h: 90 }, 80, BASE);
        expect(view).toEqual({ x: 720, y: 360, w: 480, h: 270 });
    });

    test("a frame at the canvas edge is shifted inside", () => {
        const view = fitFrame({ x: -40, y: 0, w: 480, h: 270 }, 0, BASE);
        expect(view).toEqual({ x: 0, y: 0, w: 480, h: 270 });
    });

    test("a frame larger than the canvas is the full slide", () => {
        const view = fitFrame({ x: -100, y: -100, w: 4000, h: 300 }, 0, BASE);
        expect(view).toEqual(BASE);
    });

    test("a target with no extent frames the full slide", () => {
        expect(fitFrame({ x: 300, y: 300, w: 0, h: 0 }, 0, BASE)).toEqual(BASE);
    });
});

describe("zoomPath", () => {
    test("lands exactly on both ends", () => {
        const path = zoomPath(BASE, FRAMES.right);
        expect(path(0)).toEqual(BASE);
        expect(path(1)).toEqual(FRAMES.right);
    });

    test("a pure zoom scales geometrically, not linearly", () => {
        const from: ViewBox = { x: 0, y: 0, w: 1600, h: 900 };
        const to: ViewBox = { x: 700, y: 393.75, w: 200, h: 112.5 };
        const half = zoomPath(from, to)(0.5);
        expect(half.w).toBeCloseTo(Math.sqrt(1600 * 200), 6);
        expect(half.x + half.w / 2).toBeCloseTo(800, 6);
        expect(half.y + half.h / 2).toBeCloseTo(450, 6);
    });

    test("keeps the aspect ratio along the way", () => {
        const path = zoomPath(FRAMES.left, FRAMES.right);
        for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
            const view = path(t);
            expect(view.h / view.w).toBeCloseTo(BASE.h / BASE.w, 9);
        }
    });

    test("a long pan between small frames zooms out mid-path", () => {
        const middle = zoomPath(FRAMES.left, FRAMES.right)(0.5);
        expect(middle.w).toBeGreaterThan(FRAMES.left.w * 2);
    });

    test("the centre moves monotonically toward the target", () => {
        const path = zoomPath(FRAMES.left, FRAMES.right);
        let previous = path(0).x + path(0).w / 2;
        for (let t = 0.05; t <= 1; t += 0.05) {
            const centre = path(t).x + path(t).w / 2;
            expect(centre).toBeGreaterThanOrEqual(previous - 1e-9);
            previous = centre;
        }
    });
});

describe("cameraTimeline", () => {
    test("one cue runs from the start view to its frame", () => {
        const timeline = cameraTimeline([cue(1, "left")], BASE, resolve);
        expect(timeline.totalMs).toBe(1000);
        expect(timeline.at(0)).toEqual(BASE);
        expect(timeline.at(1000)).toEqual(FRAMES.left);
        expect(timeline.at(Number.POSITIVE_INFINITY)).toEqual(FRAMES.left);
    });

    test("delay holds the start view until the move begins", () => {
        const timeline = cameraTimeline(
            [cue(1, "left", { delay: 0.5 })],
            BASE,
            resolve,
        );
        expect(timeline.totalMs).toBe(1500);
        expect(timeline.at(400)).toEqual(BASE);
        expect(timeline.at(1500)).toEqual(FRAMES.left);
    });

    test("a chained cue starts from where the previous one landed", () => {
        const timeline = cameraTimeline(
            [cue(1, "left"), cue(1, "right", { offset: 1 })],
            BASE,
            resolve,
        );
        expect(timeline.totalMs).toBe(2000);
        expect(timeline.at(1000)).toEqual(FRAMES.left);
        expectViewClose(
            timeline.at(1500),
            zoomPath(FRAMES.left, FRAMES.right)(0.5),
        );
        expect(timeline.at(2000)).toEqual(FRAMES.right);
    });

    test("a cue starting mid-move takes over from the current view", () => {
        const timeline = cameraTimeline(
            [cue(1, "left"), cue(1, "right", { offset: 0.5 })],
            BASE,
            resolve,
        );
        const handover = zoomPath(BASE, FRAMES.left)(0.5);
        expectViewClose(timeline.at(500), handover);
        expect(timeline.at(1500)).toEqual(FRAMES.right);
    });

    test("an instant cue is in place at time 0", () => {
        const timeline = cameraTimeline(
            [cue(0, "middle", { duration: 0 })],
            BASE,
            resolve,
        );
        expect(timeline.totalMs).toBe(0);
        expect(timeline.at(0)).toEqual(FRAMES.middle);
    });

    test("the cue's easing shapes progress along the path", () => {
        const timeline = cameraTimeline(
            [cue(1, "left", { easing: "ease-in" })],
            BASE,
            resolve,
        );
        const linear = zoomPath(BASE, FRAMES.left)(0.5);
        expect(timeline.at(500).w).toBeGreaterThan(linear.w);
    });
});

describe("restingCamera", () => {
    const cues = [cue(1, "left"), cue(2, "right"), cue(4, null)];

    test("no cue reached yet is the authored view", () => {
        expect(restingCamera(cues, 0, BASE, resolve)).toEqual(BASE);
    });

    test("each step rests on its last frame, carried through steps without cues", () => {
        expect(restingCamera(cues, 1, BASE, resolve)).toEqual(FRAMES.left);
        expect(restingCamera(cues, 3, BASE, resolve)).toEqual(FRAMES.right);
        expect(restingCamera(cues, 4, BASE, resolve)).toEqual(BASE);
    });

    test("a zero-length step-0 zoom is already in place on arrival", () => {
        const opening = [cue(0, "middle", { duration: 0 }), ...cues];
        expect(restingCamera(opening, -1, BASE, resolve)).toEqual(
            FRAMES.middle,
        );
        expect(restingCamera(opening, 0, BASE, resolve)).toEqual(FRAMES.middle);
    });

    test("a timed step-0 zoom arrives at the full slide and plays after", () => {
        const diveIn = [cue(0, "middle"), ...cues];
        expect(restingCamera(diveIn, -1, BASE, resolve)).toEqual(BASE);
        expect(restingCamera(diveIn, 0, BASE, resolve)).toEqual(FRAMES.middle);
    });

    test("a delayed or later-slotted step-0 zoom does not count as instant", () => {
        const delayed = [cue(0, "middle", { duration: 0, delay: 0.2 })];
        const slotted = [cue(0, "middle", { duration: 0, offset: 0.4 })];
        expect(restingCamera(delayed, -1, BASE, resolve)).toEqual(BASE);
        expect(restingCamera(slotted, -1, BASE, resolve)).toEqual(BASE);
    });
});
