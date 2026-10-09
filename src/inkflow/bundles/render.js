"use strict";
(() => {
  // src/ts/shared/keyframes.ts
  var templates = /* @__PURE__ */ new Map();
  function parseOffsets(keyText) {
    return keyText.split(",").map((part) => {
      const t = part.trim();
      if (t === "from") return 0;
      if (t === "to") return 1;
      return Number.parseFloat(t) / 100;
    }).filter((n) => Number.isFinite(n));
  }
  function kebabToCamel(prop) {
    return prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }
  function ruleToKeyframes(rule) {
    const frames = [];
    for (const raw of Array.from(rule.cssRules)) {
      const kf = raw;
      const style = kf.style;
      const props = {};
      for (let i = 0; i < style.length; i++) {
        const name = style[i];
        props[kebabToCamel(name)] = style.getPropertyValue(name).trim();
      }
      for (const offset of parseOffsets(kf.keyText)) {
        frames.push({ offset, ...props });
      }
    }
    frames.sort((a, b) => a.offset - b.offset);
    return frames;
  }
  function findKeyframes(name, rules) {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSKeyframesRule) {
        if (rule.name === name) return rule;
        continue;
      }
      const grouping = rule;
      if (grouping.cssRules) {
        const found = findKeyframes(name, grouping.cssRules);
        if (found) return found;
      }
    }
    return null;
  }
  function templateFor(name) {
    const cached = templates.get(name);
    if (cached !== void 0) return cached;
    let result = null;
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      const rule = findKeyframes(name, rules);
      if (rule) {
        result = ruleToKeyframes(rule);
        break;
      }
    }
    templates.set(name, result);
    return result;
  }
  var VAR_ANIM = /var\(\s*--anim-([\w-]+)\s*(?:,[^()]*)?\)/g;
  function substituteVars(value, vars) {
    return value.replace(
      VAR_ANIM,
      (match, key) => key in vars ? vars[key] : match
    );
  }
  function buildKeyframes(name, vars) {
    const template = templateFor(name);
    if (!template) return [];
    if (Object.keys(vars).length === 0) return template;
    return template.map((frame) => {
      const out = {};
      for (const [k, v] of Object.entries(frame)) {
        out[k] = typeof v === "string" ? substituteVars(v, vars) : v;
      }
      return out;
    });
  }

  // src/ts/shared/step.ts
  var elementCues = /* @__PURE__ */ new WeakMap();
  var rootStep = /* @__PURE__ */ new WeakMap();
  function parseCues(el) {
    const raw = el.getAttribute("data-cues");
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  function cueStates(el) {
    let states = elementCues.get(el);
    if (!states) {
      states = parseCues(el).map((cue) => ({ cue, anim: null }));
      elementCues.set(el, states);
    }
    return states;
  }
  function ensureAnim(el, st) {
    if (!st.anim) {
      const { name, vars, opts } = st.cue;
      const anim = el.animate(buildKeyframes(`anim-${name}`, vars), {
        duration: Math.max(0, opts.duration * 1e3),
        delay: Math.max(0, opts.delay * 1e3),
        easing: opts.easing || "linear",
        iterations: opts.iterations ?? 1,
        fill: "both"
      });
      anim.pause();
      st.anim = anim;
    }
    return st.anim;
  }
  function holdAtEnd(anim) {
    anim.playbackRate = 1;
    try {
      anim.play();
      anim.finish();
    } catch {
    }
  }
  function restingActions(cues, step) {
    let gov = -1;
    cues.forEach((c, i) => {
      if (c.kind !== "emphasis" && c.step <= step) gov = i;
    });
    return cues.map((_, i) => i === gov ? "hold" : "cancel");
  }
  function applyCodeHighlights(root, step) {
    root.querySelectorAll(
      ".inkflow-codeblock[data-hl-spec][data-base-step]"
    ).forEach((block) => {
      const spec = JSON.parse(block.dataset.hlSpec);
      const baseStep = +(block.dataset.baseStep ?? "0");
      const specIdx = Math.min(Math.max(step - baseStep, 0), spec.length - 1);
      const active = spec[specIdx];
      const hasHL = active !== null;
      block.querySelectorAll(".code-line").forEach((line) => {
        const n = +(line.dataset.line ?? "0");
        line.classList.toggle("hl-active", hasHL && active.includes(n));
        line.classList.toggle("hl-dim", hasHL && !active.includes(n));
        if (!hasHL) line.classList.remove("hl-active", "hl-dim");
      });
    });
  }
  function maxStep(root) {
    let m = 0;
    root.querySelectorAll("[data-cues]").forEach((el) => {
      for (const c of parseCues(el)) if (c.step > m) m = c.step;
    });
    root.querySelectorAll("[data-play-on-step]").forEach((el) => {
      const s = +(el.getAttribute("data-play-on-step") ?? "0");
      if (s > m) m = s;
    });
    root.querySelectorAll(
      ".inkflow-codeblock[data-hl-spec][data-base-step]"
    ).forEach((block) => {
      const spec = JSON.parse(block.dataset.hlSpec);
      const baseStep = +(block.dataset.baseStep ?? "0");
      const last = baseStep + spec.length - 1;
      if (last > m) m = last;
    });
    return m;
  }
  function applyStepInstant(root, step) {
    root.querySelectorAll("[data-cues]").forEach((el) => {
      const states = cueStates(el);
      const actions = restingActions(
        states.map((s) => s.cue),
        step
      );
      states.forEach((st, i) => {
        if (actions[i] === "hold") holdAtEnd(ensureAnim(el, st));
        else st.anim?.cancel();
      });
    });
    applyCodeHighlights(root, step);
    rootStep.set(root, step);
  }

  // src/ts/render/main.ts
  var host = document.getElementById("slide");
  host.innerHTML = __RENDER_SVG__;
  var svg = host.querySelector("svg");
  if (svg) {
    svg.querySelectorAll("video").forEach((v) => {
      v.removeAttribute("autoplay");
      v.pause();
    });
    const step = __RENDER_STEP__;
    applyStepInstant(svg, step == null ? maxStep(svg) : step);
  }
  document.body.dataset.ready = "1";
})();
