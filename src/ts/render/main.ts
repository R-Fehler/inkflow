// The single-slide page `inkflow render` screenshots with headless Chromium:
// one slide, sized to the window, at a given build step (the final state by
// default), with no presenter chrome around it.

import { applyStepInstant, maxStep } from "../shared/step";

const host = document.getElementById("slide")!;
host.innerHTML = __RENDER_SVG__;
const svg = host.querySelector("svg");
if (svg) {
    svg.querySelectorAll("video").forEach((v) => {
        v.removeAttribute("autoplay");
        v.pause();
    });
    const step = __RENDER_STEP__;
    applyStepInstant(svg, step == null ? maxStep(svg) : step);
}
document.body.dataset.ready = "1";
