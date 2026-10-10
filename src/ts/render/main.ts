// The single-slide page `inkflow render` drives with headless Chromium: one
// slide, sized to the window, at a given build step (the final state by
// default), with no presenter chrome around it. Once everything it shows has
// loaded, `window.inkflowRendered` resolves to the layout findings (measure.ts)
// that `inkflow render` reports, and the page is ready to be screenshot.

import { applyStepInstant, maxStep } from "../shared/step";
import { type BoxEntry, measureBoxes } from "./boxes";
import { type ContrastFinding, checkContrast, hideText } from "./contrast";
import { type Finding, measureSlide } from "./measure";

declare global {
    interface Window {
        inkflowRendered?: Promise<Finding[]>;
        /** Every element's box, for `inkflow render --boxes` (boxes.ts). */
        inkflowBoxes?: () => BoxEntry[];
        /** Text contrast (contrast.ts): hide the text for the background
         * shot, then compare both shots (base64 PNGs). */
        inkflowHideText?: () => number;
        inkflowContrast?: (
            shown: string,
            hidden: string,
        ) => Promise<ContrastFinding[]>;
    }
}

const VIDEO_WAIT_MS = 3000;

const host = document.getElementById("slide")!;
host.innerHTML = __RENDER_SVG__;
const svg = host.querySelector("svg");
if (svg) {
    svg.querySelectorAll("video").forEach((v) => {
        v.removeAttribute("autoplay");
        v.preload = "auto"; // so its first frame loads, to be shown
        v.pause();
    });
    const step = __RENDER_STEP__;
    applyStepInstant(svg, step == null ? maxStep(svg) : step);
}
document.body.dataset.ready = "1";

function loaded(): Promise<void> {
    if (document.readyState === "complete") return Promise.resolve();
    return new Promise((resolve) =>
        window.addEventListener("load", () => resolve(), { once: true }),
    );
}

/** A video's first frame, or nothing once it has had its time. */
function firstFrame(video: HTMLVideoElement): Promise<void> {
    // NETWORK_NO_SOURCE: an error (say, a codec this browser lacks) came first.
    if (video.readyState >= 2 || video.error || video.networkState === 3) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const done = () => resolve();
        video.addEventListener("loadeddata", done, { once: true });
        video.addEventListener("error", done, { once: true });
        setTimeout(done, VIDEO_WAIT_MS);
    });
}

/** A deck's own CSS animations and transitions jump to their end state, as a
 * viewer would see them settle; the step engine's cues are already held. */
function settleCss(): void {
    for (const anim of document.getAnimations()) {
        const css =
            anim instanceof CSSAnimation || anim instanceof CSSTransition;
        const end = anim.effect?.getComputedTiming().endTime;
        if (css && typeof end === "number" && Number.isFinite(end)) {
            anim.finish();
        }
    }
}

function frame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

window.inkflowRendered = (async () => {
    await loaded();
    await document.fonts.ready;
    await Promise.all(
        Array.from(document.querySelectorAll("video"), firstFrame),
    );
    settleCss();
    await frame();
    await frame();
    return svg ? measureSlide(svg) : [];
})();

window.inkflowBoxes = () => (svg ? measureBoxes(svg) : []);
window.inkflowHideText = () => (svg ? hideText(svg) : 0);
window.inkflowContrast = (shown, hidden) =>
    checkContrast(shown, hidden, host.getBoundingClientRect().width);
