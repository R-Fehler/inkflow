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
    return template.map((frame2) => {
      const out = {};
      for (const [k, v] of Object.entries(frame2)) {
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

  // src/ts/render/measure.ts
  var TOLERANCE = 2;
  var MIN_TEXT_FRACTION = 1 / 80;
  function union(a, b) {
    if (!a) return { ...b };
    return {
      left: Math.min(a.left, b.left),
      top: Math.min(a.top, b.top),
      right: Math.max(a.right, b.right),
      bottom: Math.max(a.bottom, b.bottom)
    };
  }
  function overhang(inner, outer) {
    return {
      top: Math.max(0, outer.top - inner.top),
      right: Math.max(0, inner.right - outer.right),
      bottom: Math.max(0, inner.bottom - outer.bottom),
      left: Math.max(0, outer.left - inner.left)
    };
  }
  function significant(o, tolerance = TOLERANCE) {
    const kept = { top: 0, right: 0, bottom: 0, left: 0 };
    let any = false;
    for (const side of ["top", "right", "bottom", "left"]) {
      if (o[side] > tolerance) {
        kept[side] = Math.round(o[side]);
        any = true;
      }
    }
    return any ? kept : null;
  }
  function spansCanvas(box, canvas, tolerance = TOLERANCE) {
    const wide = box.left <= canvas.left + tolerance && box.right >= canvas.right - tolerance;
    const tall = box.top <= canvas.top + tolerance && box.bottom >= canvas.bottom - tolerance;
    return wide || tall;
  }
  function disjoint(a, b) {
    return a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
  }
  function mergeFindings(findings) {
    const out = [];
    const byKey = /* @__PURE__ */ new Map();
    for (const f of findings) {
      const key = `${f.kind}\0${f.target}`;
      const seen = byKey.get(key);
      if (!seen) {
        const copy = { ...f };
        byKey.set(key, copy);
        out.push(copy);
        continue;
      }
      if (seen.kind === "small-text" && f.kind === "small-text") {
        if (f.size < seen.size) {
          seen.size = f.size;
          seen.text = f.text;
        }
      } else if (seen.kind !== "small-text" && f.kind !== "small-text") {
        for (const side of ["top", "right", "bottom", "left"]) {
          seen[side] = Math.max(seen[side], f[side]);
        }
        if (seen.kind === "outside" && f.kind === "outside") {
          seen.entirely = seen.entirely && f.entirely;
        }
      }
    }
    return out;
  }
  function snippet(text, max = 40) {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
  }
  var SVG_NS = "http://www.w3.org/2000/svg";
  var NOT_DRAWN = /* @__PURE__ */ new Set([
    "defs",
    "clipPath",
    "mask",
    "pattern",
    "marker",
    "symbol",
    "linearGradient",
    "radialGradient",
    "filter",
    "style",
    "script",
    "title",
    "desc",
    "metadata"
  ]);
  var GROUPS = /* @__PURE__ */ new Set(["g", "a", "switch"]);
  var PAINTED_SHAPES = /* @__PURE__ */ new Set([
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon"
  ]);
  var Measurer = class {
    constructor(svg2) {
      this.svg = svg2;
      const vb = svg2.viewBox.baseVal;
      const w = vb && vb.width > 0 ? vb.width : svg2.width.baseVal.value;
      const h = vb && vb.height > 0 ? vb.height : svg2.height.baseVal.value;
      const x = vb && vb.width > 0 ? vb.x : 0;
      const y = vb && vb.height > 0 ? vb.y : 0;
      this.canvas = { left: x, top: y, right: x + w, bottom: y + h };
      const ctm = svg2.getScreenCTM();
      this.toSlide = ctm ? DOMMatrix.fromMatrix(ctm).inverse() : new DOMMatrix();
      this.unit = Math.sqrt(
        Math.abs(
          this.toSlide.a * this.toSlide.d - this.toSlide.b * this.toSlide.c
        )
      );
      this.minText = h * MIN_TEXT_FRACTION;
    }
    svg;
    findings = [];
    canvas;
    toSlide;
    /** Slide units per screen px. */
    unit;
    minText;
    run() {
      this.walk(this.svg, 1);
      return mergeFindings(this.findings);
    }
    /** A screen rect as a box in slide units. */
    slideBox(r) {
      return mapBox(this.toSlide, r);
    }
    walk(parent, opacity) {
      for (const el of Array.from(parent.children)) {
        if (el.namespaceURI !== SVG_NS || NOT_DRAWN.has(el.localName))
          continue;
        const style = getComputedStyle(el);
        if (style.display === "none") continue;
        if (style.clipPath !== "none" || style.mask !== "none" && style.mask !== "")
          continue;
        const alpha = opacity * Number.parseFloat(style.opacity || "1");
        if (alpha < 0.02) continue;
        if (GROUPS.has(el.localName)) {
          this.walk(el, alpha);
          continue;
        }
        if (style.visibility === "hidden") continue;
        if (el.localName === "foreignObject") {
          this.zone(el);
        } else if (el.localName === "text") {
          this.svgText(el, style);
        } else if (el.localName === "svg") {
          this.nestedSvg(el);
        }
        if (PAINTED_SHAPES.has(el.localName) && style.fill === "none" && style.stroke === "none") {
          continue;
        }
        this.outside(el);
      }
    }
    /** Does a drawn object reach past the slide? */
    outside(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const box = this.slideBox(rect);
      const over = significant(overhang(box, this.canvas));
      if (!over || spansCanvas(box, this.canvas)) return;
      this.findings.push({
        kind: "outside",
        target: describe(el),
        entirely: disjoint(box, this.canvas),
        ...over
      });
    }
    /** A chart or crop frame: its text is checked for size, its box by `outside`. */
    nestedSvg(el) {
      for (const text of Array.from(el.querySelectorAll("text"))) {
        const style = getComputedStyle(text);
        if (style.display !== "none" && style.visibility !== "hidden") {
          this.svgText(text, style);
        }
      }
    }
    svgText(el, style) {
      const text = el.textContent ?? "";
      if (!text.trim()) return;
      const ctm = el.getScreenCTM();
      if (!ctm) return;
      const size = Number.parseFloat(style.fontSize) * scaleOf(ctm) * this.unit;
      this.smallText(el, size, text);
    }
    smallText(el, size, text) {
      if (!(size > 0) || size >= this.minText) return;
      this.findings.push({
        kind: "small-text",
        target: describe(el),
        size: Math.round(size * 10) / 10,
        min: Math.round(this.minText * 10) / 10,
        text: snippet(text)
      });
    }
    /** A zone holding HTML: does its content fit inside it? */
    zone(fo) {
      const ctm = fo.getScreenCTM();
      if (!ctm || Math.abs(ctm.b) > 1e-6 || Math.abs(ctm.c) > 1e-6) return;
      const target = describe(fo);
      const zoneBox = this.slideBox(fo.getBoundingClientRect());
      const pxToSlide = scaleOf(ctm) * this.unit;
      let content = null;
      const add = (r) => {
        if (r.width > 0 || r.height > 0)
          content = union(content, this.slideBox(r));
      };
      const range = document.createRange();
      const visit = (node) => {
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            const text = child.textContent ?? "";
            if (!text.trim()) continue;
            range.selectNodeContents(child);
            for (const r2 of Array.from(range.getClientRects())) add(r2);
            const holder = child.parentElement;
            if (holder) {
              const size = Number.parseFloat(
                getComputedStyle(holder).fontSize
              ) * pxToSlide;
              this.smallText(fo, size, text);
            }
            continue;
          }
          if (!(child instanceof Element)) continue;
          const style = getComputedStyle(child);
          if (style.display === "none" || style.visibility === "hidden")
            continue;
          if (child.namespaceURI === SVG_NS) {
            add(child.getBoundingClientRect());
            if (child instanceof SVGSVGElement) this.nestedSvg(child);
            continue;
          }
          const replaced = [
            "img",
            "video",
            "canvas",
            "iframe",
            "object",
            "embed"
          ];
          if (replaced.includes(child.localName)) {
            add(child.getBoundingClientRect());
            continue;
          }
          const scrolls = style.overflowX !== "visible" || style.overflowY !== "visible";
          if (scrolls && child instanceof HTMLElement) {
            add(child.getBoundingClientRect());
            this.clipped(child, target, pxToSlide);
            this.textSizes(child, fo, pxToSlide);
            continue;
          }
          const r = child.getBoundingClientRect();
          if (style.display !== "inline") add(r);
          visit(child);
        }
      };
      const wrapper = fo.querySelector(
        ":scope > .inkflow-wrapper > .inkflow-content"
      );
      if (wrapper) {
        visit(wrapper);
      } else if (fo.querySelector(":scope > img, :scope > video")) {
        return;
      } else {
        visit(fo);
      }
      if (!content) return;
      const over = significant(overhang(content, zoneBox));
      if (over) this.findings.push({ kind: "overflow", target, ...over });
    }
    /** A box with scrollable overflow shows only part of its content. */
    clipped(el, target, pxToSlide) {
      const over = significant({
        top: 0,
        left: 0,
        right: (el.scrollWidth - el.clientWidth) * pxToSlide,
        bottom: (el.scrollHeight - el.clientHeight) * pxToSlide
      });
      if (over) {
        const what = el.localName === "pre" ? "code block" : `<${el.localName}>`;
        this.findings.push({ kind: "clipped", target, what, ...over });
      }
    }
    textSizes(el, fo, pxToSlide) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent ?? "";
        if (!text.trim() || !n.parentElement) continue;
        const size = Number.parseFloat(getComputedStyle(n.parentElement).fontSize) * pxToSlide;
        this.smallText(fo, size, text);
      }
    }
  };
  function scaleOf(m) {
    const a = m.a ?? 1;
    const b = m.b ?? 0;
    const c = m.c ?? 0;
    const d = m.d ?? 1;
    return Math.sqrt(Math.abs(a * d - b * c));
  }
  function mapBox(m, r) {
    const corners = [
      m.transformPoint(new DOMPoint(r.left, r.top)),
      m.transformPoint(new DOMPoint(r.right, r.top)),
      m.transformPoint(new DOMPoint(r.left, r.bottom)),
      m.transformPoint(new DOMPoint(r.right, r.bottom))
    ];
    return {
      left: Math.min(...corners.map((p) => p.x)),
      top: Math.min(...corners.map((p) => p.y)),
      right: Math.max(...corners.map((p) => p.x)),
      bottom: Math.max(...corners.map((p) => p.y))
    };
  }
  function describe(el) {
    for (let e = el; e; e = e.parentElement) {
      if (e.localName === "svg" && e.parentElement?.id === "slide") break;
      if (e.id && !e.id.startsWith("inkflow-")) return `#${e.id}`;
    }
    const text = snippet(el.textContent ?? "", 30);
    return text ? `<${el.localName}> "${text}"` : `<${el.localName}>`;
  }
  function measureSlide(svg2) {
    return new Measurer(svg2).run();
  }

  // src/ts/render/boxes.ts
  var BLOCK_KINDS = {
    p: "p",
    h1: "h1",
    h2: "h2",
    h3: "h3",
    h4: "h4",
    h5: "h5",
    h6: "h6",
    ul: "list",
    ol: "list",
    dl: "list",
    pre: "code",
    table: "table",
    blockquote: "quote",
    figure: "figure",
    img: "image",
    video: "video",
    svg: "chart",
    math: "math",
    hr: "rule"
  };
  var round1 = (v) => Math.round(v * 10) / 10;
  function toRect(b) {
    return {
      x: round1(b.left),
      y: round1(b.top),
      w: round1(b.right - b.left),
      h: round1(b.bottom - b.top)
    };
  }
  function blockKind(el) {
    if (el.localName === "math" && el.getAttribute("display") !== "block")
      return null;
    return BLOCK_KINDS[el.localName] ?? null;
  }
  var BoxWalker = class {
    constructor(svg2) {
      this.svg = svg2;
      const ctm = svg2.getScreenCTM();
      this.toSlide = ctm ? DOMMatrix.fromMatrix(ctm).inverse() : new DOMMatrix();
    }
    svg;
    out = [];
    toSlide;
    box(r) {
      return mapBox(this.toSlide, r);
    }
    run() {
      this.walk(this.svg, 1, null, 0);
      return this.out;
    }
    walk(parent, opacity, listed, depth) {
      for (const el of Array.from(parent.children)) {
        if (el.namespaceURI !== SVG_NS || NOT_DRAWN.has(el.localName))
          continue;
        const style = getComputedStyle(el);
        if (style.display === "none") continue;
        const alpha = opacity * Number.parseFloat(style.opacity || "1");
        const id = el.id;
        let entry = null;
        if (id && !id.startsWith("inkflow-")) {
          entry = this.element(el, style, alpha, listed, depth);
        }
        const inner = entry ?? listed;
        const innerDepth = entry ? depth + 1 : depth;
        if (el.localName === "foreignObject") {
          this.zoneBlocks(
            el,
            entry,
            inner,
            innerDepth
          );
          continue;
        }
        this.walk(el, alpha, inner, innerDepth);
      }
    }
    element(el, style, alpha, listed, depth) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      const entry = {
        id: el.id,
        kind: el.localName,
        box: toRect(this.box(r)),
        depth
      };
      if (listed) entry.parent = listed.id;
      if (alpha < 0.02 || style.visibility === "hidden") entry.hidden = true;
      const zone = el.id.startsWith("zone-");
      if (el.localName === "foreignObject") {
        const media = el.querySelector(":scope > img, :scope > video");
        entry.kind = media ? "media" : "zone";
      } else if (el.localName === "svg" && zone) {
        entry.kind = "chart";
      }
      if (el.localName === "text" || entry.kind === "zone") {
        const text = snippet(el.textContent ?? "");
        if (text) entry.text = text;
      }
      this.out.push(entry);
      return entry;
    }
    /** The blocks of a zone's text, each with the extent of its text, and
     * the zone's content extent and free space. */
    zoneBlocks(fo, zoneEntry, listed, depth) {
      const content = fo.querySelector(
        ":scope > .inkflow-wrapper > .inkflow-content"
      );
      if (!content) return;
      const zoneId = zoneEntry?.id ?? fo.id;
      let all = null;
      let n = 0;
      for (const block of blocksOf(content)) {
        const style = getComputedStyle(block);
        if (style.display === "none") continue;
        const layout = block.getBoundingClientRect();
        if (layout.width === 0 && layout.height === 0) continue;
        const blockBox = this.box(layout);
        const ink = this.inkOf(block) ?? blockBox;
        all = union(all, ink);
        n += 1;
        const entry = {
          id: `${zoneId}/${n}`,
          kind: blockKind(block) ?? block.localName,
          box: toRect(ink),
          depth,
          zone: zoneId,
          block: toRect(blockBox)
        };
        if (listed) entry.parent = listed.id;
        const text = snippet(block.textContent ?? "");
        if (text) entry.text = text;
        if (style.visibility === "hidden" || opacityOf(block, fo) < 0.02)
          entry.hidden = true;
        this.out.push(entry);
      }
      if (zoneEntry && all) {
        zoneEntry.content = toRect(all);
        zoneEntry.free = round1(zoneEntry.box.h - (all.bottom - all.top));
      }
    }
    /** Where a block's text (and pictures) actually are: the union of its
     * line boxes, not the full width a paragraph's box takes. */
    inkOf(block) {
      if (block.namespaceURI === SVG_NS || blockKind(block) === "image") {
        return null;
      }
      let ink = null;
      const range = document.createRange();
      const walker = document.createTreeWalker(
        block,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
      );
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType === Node.TEXT_NODE) {
          if (!(n.textContent ?? "").trim()) continue;
          range.selectNodeContents(n);
          for (const r of Array.from(range.getClientRects())) {
            if (r.width > 0 || r.height > 0)
              ink = union(ink, this.box(r));
          }
        } else if (n instanceof Element && ["img", "video", "svg", "canvas"].includes(n.localName)) {
          const r = n.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) ink = union(ink, this.box(r));
        }
      }
      return ink;
    }
  };
  function blocksOf(container) {
    const out = [];
    for (const child of Array.from(container.children)) {
      if (blockKind(child)) out.push(child);
      else if (child.children.length) out.push(...blocksOf(child));
    }
    return out;
  }
  function opacityOf(el, stop) {
    let alpha = 1;
    for (let e = el; e && e !== stop; e = e.parentElement) {
      alpha *= Number.parseFloat(getComputedStyle(e).opacity || "1");
    }
    return alpha;
  }
  function measureBoxes(svg2) {
    return new BoxWalker(svg2).run();
  }

  // src/ts/render/main.ts
  var VIDEO_WAIT_MS = 3e3;
  var host = document.getElementById("slide");
  host.innerHTML = __RENDER_SVG__;
  var svg = host.querySelector("svg");
  if (svg) {
    svg.querySelectorAll("video").forEach((v) => {
      v.removeAttribute("autoplay");
      v.preload = "auto";
      v.pause();
    });
    const step = __RENDER_STEP__;
    applyStepInstant(svg, step == null ? maxStep(svg) : step);
  }
  document.body.dataset.ready = "1";
  function loaded() {
    if (document.readyState === "complete") return Promise.resolve();
    return new Promise(
      (resolve) => window.addEventListener("load", () => resolve(), { once: true })
    );
  }
  function firstFrame(video) {
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
  function settleCss() {
    for (const anim of document.getAnimations()) {
      const css = anim instanceof CSSAnimation || anim instanceof CSSTransition;
      const end = anim.effect?.getComputedTiming().endTime;
      if (css && typeof end === "number" && Number.isFinite(end)) {
        anim.finish();
      }
    }
  }
  function frame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  window.inkflowRendered = (async () => {
    await loaded();
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.querySelectorAll("video"), firstFrame)
    );
    settleCss();
    await frame();
    await frame();
    return svg ? measureSlide(svg) : [];
  })();
  window.inkflowBoxes = () => svg ? measureBoxes(svg) : [];
})();
