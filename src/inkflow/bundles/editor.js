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
  function applyCodeHighlights(root2, step) {
    root2.querySelectorAll(
      ".inkflow-codeblock[data-hl-spec][data-base-step]"
    ).forEach((block) => {
      const spec = JSON.parse(block.dataset.hlSpec);
      const baseStep = +(block.dataset.baseStep ?? "0");
      const specIdx = Math.min(Math.max(step - baseStep, 0), spec.length - 1);
      const active2 = spec[specIdx];
      const hasHL = active2 !== null;
      block.querySelectorAll(".code-line").forEach((line) => {
        const n = +(line.dataset.line ?? "0");
        line.classList.toggle("hl-active", hasHL && active2.includes(n));
        line.classList.toggle("hl-dim", hasHL && !active2.includes(n));
        if (!hasHL) line.classList.remove("hl-active", "hl-dim");
      });
    });
  }
  function maxStep(root2) {
    let m = 0;
    root2.querySelectorAll("[data-cues]").forEach((el) => {
      for (const c of parseCues(el)) if (c.step > m) m = c.step;
    });
    root2.querySelectorAll("[data-play-on-step]").forEach((el) => {
      const s = +(el.getAttribute("data-play-on-step") ?? "0");
      if (s > m) m = s;
    });
    root2.querySelectorAll(
      ".inkflow-codeblock[data-hl-spec][data-base-step]"
    ).forEach((block) => {
      const spec = JSON.parse(block.dataset.hlSpec);
      const baseStep = +(block.dataset.baseStep ?? "0");
      const last = baseStep + spec.length - 1;
      if (last > m) m = last;
    });
    return m;
  }
  function applyStepInstant(root2, step) {
    root2.querySelectorAll("[data-cues]").forEach((el) => {
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
    applyCodeHighlights(root2, step);
    rootStep.set(root2, step);
  }

  // src/ts/shared/viewbox.ts
  var DEFAULT_VIEWBOX = "0 0 1920 1080";
  function parseViewBox(attr, fallback = DEFAULT_VIEWBOX) {
    const parts = (attr ?? "").trim().split(/[\s,]+/).map(Number);
    const valid = parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0;
    const [x, y, w, h2] = valid ? parts : fallback.split(/[\s,]+/).map(Number);
    return { x, y, w, h: h2 };
  }

  // src/ts/editor/dom.ts
  function h(tag, attrs2 = {}, ...children2) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs2)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2), v);
      } else if (k === "value" && "value" in el) {
        el.value = String(v);
      } else if (v === true) {
        el.setAttribute(k, "");
      } else {
        el.setAttribute(k, String(v));
      }
    }
    for (const c of children2) {
      if (c == null || c === false) continue;
      el.append(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  }
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }
  var SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs2 = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs2)) el.setAttribute(k, String(v));
    return el;
  }
  var ICON_PATHS = {
    undo: '<path d="M4 7h7a3.5 3.5 0 0 1 0 7H8"/><path d="M6.5 4.5 4 7l2.5 2.5"/>',
    redo: '<path d="M12 7H5a3.5 3.5 0 0 0 0 7h3"/><path d="M9.5 4.5 12 7 9.5 9.5"/>',
    select: '<path d="M3 2l9 5-4 1.2L6.5 12z"/>',
    text: '<path d="M3 3.5h10M8 3.5V13M6 13h4"/>',
    rect: '<rect x="2.5" y="4" width="11" height="8" rx="1.2"/>',
    ellipse: '<ellipse cx="8" cy="8" rx="5.5" ry="4.2"/>',
    line: '<path d="M3 13 13 3"/>',
    arrow: '<path d="M3 13 13 3"/><path d="M7.5 3H13v5.5"/>',
    image: '<rect x="2" y="3" width="12" height="10" rx="1.2"/><circle cx="5.8" cy="6.5" r="1.2"/><path d="m2.5 12 4-4 3 3 2-2 2.5 2.5"/>',
    play: '<path d="M5 3.2 12.5 8 5 12.8Z"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    minus: '<path d="M3 8h10"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>',
    copy: '<rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 10.5V3h7.5"/>',
    layers: '<path d="M8 2 14 5.5 8 9 2 5.5 8 2Z"/><path d="M2 9 8 12.5 14 9"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15"/>',
    eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>',
    eyeOff: '<path d="M2 2l12 12M6.5 4A6.6 6.6 0 0 1 14.5 8a9 9 0 0 1-1.8 2.3M9.9 11.9A6.3 6.3 0 0 1 1.5 8 9.5 9.5 0 0 1 4 5"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
    unlock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/>',
    up: '<path d="M4 10l4-4 4 4"/>',
    down: '<path d="M4 6l4 4 4-4"/>',
    front: '<rect x="5" y="5" width="8" height="8" rx="1" fill="currentColor"/><path d="M3 10.5V3h7.5"/>',
    back: '<rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 10.5V3h7.5" /><rect x="3" y="3" width="7.5" height="7.5" fill="currentColor" opacity=".35" stroke="none"/>',
    group: '<rect x="2" y="2" width="12" height="12" rx="1" stroke-dasharray="2 1.5"/><rect x="4.5" y="4.5" width="4" height="4"/><rect x="8" y="8" width="3.5" height="3.5"/>',
    code: '<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"/>',
    fit: '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>'
  };
  function icon(name, size = 16) {
    const wrap2 = document.createElement("span");
    wrap2.innerHTML = `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] ?? ""}</svg>`;
    return wrap2.firstElementChild;
  }
  var toastTimer = 0;
  function toast(message, kind = "info") {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.className = `show ${kind}`;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(
      () => {
        el.className = "";
      },
      kind === "error" ? 6e3 : 2600
    );
  }

  // src/ts/editor/geom.ts
  var IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  function mat(m) {
    return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
  }
  function multiply(p, q) {
    return {
      a: p.a * q.a + p.c * q.b,
      b: p.b * q.a + p.d * q.b,
      c: p.a * q.c + p.c * q.d,
      d: p.b * q.c + p.d * q.d,
      e: p.a * q.e + p.c * q.f + p.e,
      f: p.b * q.e + p.d * q.f + p.f
    };
  }
  function invert(m) {
    const det = m.a * m.d - m.b * m.c;
    if (Math.abs(det) < 1e-12) return { ...IDENTITY };
    return {
      a: m.d / det,
      b: -m.b / det,
      c: -m.c / det,
      d: m.a / det,
      e: (m.c * m.f - m.d * m.e) / det,
      f: (m.b * m.e - m.a * m.f) / det
    };
  }
  function apply(m, p) {
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  }
  function applyVector(m, p) {
    return { x: m.a * p.x + m.c * p.y, y: m.b * p.x + m.d * p.y };
  }
  function translate(x, y) {
    return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
  }
  function scaleAbout(sx, sy, origin) {
    return {
      a: sx,
      b: 0,
      c: 0,
      d: sy,
      e: origin.x - sx * origin.x,
      f: origin.y - sy * origin.y
    };
  }
  function rotateAbout(degrees, origin) {
    const r = degrees * Math.PI / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return multiply(
      translate(origin.x, origin.y),
      multiply(
        { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 },
        translate(-origin.x, -origin.y)
      )
    );
  }
  var EPS = 1e-6;
  function isTranslateOnly(m) {
    return Math.abs(m.a - 1) < EPS && Math.abs(m.d - 1) < EPS && Math.abs(m.b) < EPS && Math.abs(m.c) < EPS;
  }
  function isAxisAligned(m) {
    return Math.abs(m.b) < EPS && Math.abs(m.c) < EPS;
  }
  function transformBox(m, box) {
    const pts = [
      apply(m, { x: box.x, y: box.y }),
      apply(m, { x: box.x + box.width, y: box.y }),
      apply(m, { x: box.x, y: box.y + box.height }),
      apply(m, { x: box.x + box.width, y: box.y + box.height })
    ];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  function unionBoxes(boxes) {
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const r = Math.max(...boxes.map((b) => b.x + b.width));
    const btm = Math.max(...boxes.map((b) => b.y + b.height));
    return { x, y, width: r - x, height: btm - y };
  }
  function fmt(n) {
    const r = Math.round(n * 1e3) / 1e3;
    return Object.is(r, -0) ? "0" : String(r);
  }
  function formatTransform(m) {
    if (isTranslateOnly(m)) {
      if (Math.abs(m.e) < EPS && Math.abs(m.f) < EPS) return null;
      return `translate(${fmt(m.e)},${fmt(m.f)})`;
    }
    const r = (n) => String(Math.round(n * 1e6) / 1e6);
    return `matrix(${r(m.a)},${r(m.b)},${r(m.c)},${r(m.d)},${fmt(m.e)},${fmt(m.f)})`;
  }
  var BOX_TAGS = /* @__PURE__ */ new Set(["rect", "image", "foreignObject", "use", "svg"]);
  function num(v, fallback = 0) {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? n : fallback;
  }
  function usesBoxAttrs(g) {
    return BOX_TAGS.has(g.sourceTag) && g.sourceTag !== "use" && g.attrs.width != null && g.attrs.height != null && isTranslateOnly(g.own);
  }
  function transformPlan(g, slideChange) {
    const p = g.parentToSlide;
    const inParent = multiply(invert(p), multiply(slideChange, p));
    return { transform: formatTransform(multiply(inParent, g.own)) };
  }
  function shiftList(value, delta) {
    if (value == null) return null;
    const parts = value.trim().split(/[\s,]+/);
    if (!parts.length || parts.some((p) => !Number.isFinite(parseFloat(p))))
      return null;
    return parts.map((p) => fmt(parseFloat(p) + delta)).join(" ");
  }
  function planMove(g, dx, dy, textChildren2 = []) {
    const delta = applyVector(invert(g.parentToSlide), { x: dx, y: dy });
    if (isTranslateOnly(g.own)) {
      if (usesBoxAttrs(g)) {
        return {
          attrs: {
            x: fmt(num(g.attrs.x) + delta.x),
            y: fmt(num(g.attrs.y) + delta.y)
          }
        };
      }
      if (g.sourceTag === "circle" || g.sourceTag === "ellipse") {
        return {
          attrs: {
            cx: fmt(num(g.attrs.cx) + delta.x),
            cy: fmt(num(g.attrs.cy) + delta.y)
          }
        };
      }
      if (g.sourceTag === "line") {
        return {
          attrs: {
            x1: fmt(num(g.attrs.x1) + delta.x),
            y1: fmt(num(g.attrs.y1) + delta.y),
            x2: fmt(num(g.attrs.x2) + delta.x),
            y2: fmt(num(g.attrs.y2) + delta.y)
          }
        };
      }
      if (g.sourceTag === "text") {
        const xs = shiftList(g.attrs.x ?? "0", delta.x);
        const ys = shiftList(g.attrs.y ?? "0", delta.y);
        const kids = textChildren2.map((c) => {
          const plan = {};
          const cx = shiftList(c.attrs.x, delta.x);
          const cy = shiftList(c.attrs.y, delta.y);
          if (cx != null) plan.x = cx;
          if (cy != null) plan.y = cy;
          return plan;
        });
        if (xs != null && ys != null) {
          return { attrs: { x: xs, y: ys }, children: kids };
        }
      }
    }
    return { attrs: { transform: prependTranslate(g.attrs.transform, delta) } };
  }
  var LEADING_TRANSLATE = /^\s*translate\(\s*([-+.\deE]+)(?:[\s,]+([-+.\deE]+))?\s*\)\s*(.*)$/s;
  function prependTranslate(transform, d) {
    const original = (transform ?? "").trim();
    const m = original.match(LEADING_TRANSLATE);
    let x = d.x;
    let y = d.y;
    let rest = original;
    if (m) {
      x += parseFloat(m[1]);
      y += parseFloat(m[2] ?? "0");
      rest = m[3].trim();
    }
    const mm = rest.match(/^matrix\(([^)]*)\)$/);
    const nums = mm?.[1].split(/[\s,]+/).filter(Boolean).map(Number) ?? [];
    if (!m && nums.length === 6 && nums.every(Number.isFinite)) {
      const [a, b, c, dd, e, f] = nums;
      return `matrix(${a},${b},${c},${dd},${fmt(e + x)},${fmt(f + y)})`;
    }
    const zero = Math.abs(x) < EPS && Math.abs(y) < EPS;
    if (zero) return rest || null;
    const t = `translate(${fmt(x)},${fmt(y)})`;
    return rest ? `${t} ${rest}` : t;
  }
  function planResize(g, from, to) {
    const sx = from.width > EPS ? to.width / from.width : 1;
    const sy = from.height > EPS ? to.height / from.height : 1;
    const change = multiply(
      translate(to.x, to.y),
      multiply(
        scaleAbout(sx, sy, { x: 0, y: 0 }),
        translate(-from.x, -from.y)
      )
    );
    const p = g.parentToSlide;
    const inParent = multiply(invert(p), multiply(change, p));
    if (isTranslateOnly(g.own) && isAxisAligned(inParent)) {
      const t = { x: g.own.e, y: g.own.f };
      const mapBox2 = (b) => {
        const shifted = { ...b, x: b.x + t.x, y: b.y + t.y };
        const out = transformBox(inParent, shifted);
        return { ...out, x: out.x - t.x, y: out.y - t.y };
      };
      if (usesBoxAttrs(g)) {
        const b = mapBox2({
          x: num(g.attrs.x),
          y: num(g.attrs.y),
          width: num(g.attrs.width),
          height: num(g.attrs.height)
        });
        return {
          x: fmt(b.x),
          y: fmt(b.y),
          width: fmt(b.width),
          height: fmt(b.height)
        };
      }
      if (g.sourceTag === "ellipse" || g.sourceTag === "circle") {
        const rx = num(g.attrs.rx ?? g.attrs.r);
        const ry = num(g.attrs.ry ?? g.attrs.r);
        const b = mapBox2({
          x: num(g.attrs.cx) - rx,
          y: num(g.attrs.cy) - ry,
          width: 2 * rx,
          height: 2 * ry
        });
        const cx = fmt(b.x + b.width / 2);
        const cy = fmt(b.y + b.height / 2);
        if (g.sourceTag === "circle") {
          return { cx, cy, r: fmt((b.width + b.height) / 4) };
        }
        return { cx, cy, rx: fmt(b.width / 2), ry: fmt(b.height / 2) };
      }
      if (g.sourceTag === "line") {
        const tt = translate(t.x, t.y);
        const m = multiply(invert(tt), multiply(inParent, tt));
        const p1 = apply(m, { x: num(g.attrs.x1), y: num(g.attrs.y1) });
        const p2 = apply(m, { x: num(g.attrs.x2), y: num(g.attrs.y2) });
        return {
          x1: fmt(p1.x),
          y1: fmt(p1.y),
          x2: fmt(p2.x),
          y2: fmt(p2.y)
        };
      }
    }
    return { transform: formatTransform(multiply(inParent, g.own)) };
  }
  function planCrop(g, from, to) {
    const vb = (g.attrs.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) return null;
    if (!usesBoxAttrs(g)) return null;
    const frame = {
      x: num(g.attrs.x),
      y: num(g.attrs.y),
      width: num(g.attrs.width),
      height: num(g.attrs.height)
    };
    if (frame.width <= EPS || frame.height <= EPS) return null;
    const sx = from.width > EPS ? to.width / from.width : 1;
    const sy = from.height > EPS ? to.height / from.height : 1;
    const change = multiply(
      translate(to.x, to.y),
      multiply(
        scaleAbout(sx, sy, { x: 0, y: 0 }),
        translate(-from.x, -from.y)
      )
    );
    const p = g.parentToSlide;
    const inParent = multiply(invert(p), multiply(change, p));
    if (!isAxisAligned(inParent)) return null;
    const t = { x: g.own.e, y: g.own.f };
    const moved = transformBox(inParent, {
      ...frame,
      x: frame.x + t.x,
      y: frame.y + t.y
    });
    const next = { ...moved, x: moved.x - t.x, y: moved.y - t.y };
    const kx = vb[2] / frame.width;
    const ky = vb[3] / frame.height;
    return {
      x: fmt(next.x),
      y: fmt(next.y),
      width: fmt(next.width),
      height: fmt(next.height),
      viewBox: [
        vb[0] + (next.x - frame.x) * kx,
        vb[1] + (next.y - frame.y) * ky,
        next.width * kx,
        next.height * ky
      ].map(fmt).join(" ")
    };
  }
  function planRotate(g, degrees, center) {
    return transformPlan(g, rotateAbout(degrees, center));
  }
  function parseTransform(value) {
    if (!value) return { ...IDENTITY };
    let m = { ...IDENTITY };
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
    for (const match of value.matchAll(re)) {
      const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
      let t = { ...IDENTITY };
      switch (match[1]) {
        case "matrix":
          if (args.length === 6) {
            t = {
              a: args[0],
              b: args[1],
              c: args[2],
              d: args[3],
              e: args[4],
              f: args[5]
            };
          }
          break;
        case "translate":
          t = translate(args[0] ?? 0, args[1] ?? 0);
          break;
        case "scale":
          t = scaleAbout(args[0] ?? 1, args[1] ?? args[0] ?? 1, {
            x: 0,
            y: 0
          });
          break;
        case "rotate":
          t = rotateAbout(args[0] ?? 0, {
            x: args[1] ?? 0,
            y: args[2] ?? 0
          });
          break;
        case "skewX":
          t = {
            ...IDENTITY,
            c: Math.tan((args[0] ?? 0) * Math.PI / 180)
          };
          break;
        case "skewY":
          t = {
            ...IDENTITY,
            b: Math.tan((args[0] ?? 0) * Math.PI / 180)
          };
          break;
      }
      m = multiply(m, t);
    }
    return m;
  }
  function rotationOf(m) {
    return Math.atan2(m.b, m.a) * 180 / Math.PI;
  }
  function relativePath(fromFile, target) {
    const from = fromFile.split("/").slice(0, -1).filter(Boolean);
    const to = target.split("/").filter(Boolean);
    let i = 0;
    while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
    const up = from.slice(i).map(() => "..");
    return [...up, ...to.slice(i)].join("/");
  }

  // src/ts/shared/deck-styles.ts
  function applyDeckStyles(msg) {
    if (msg.styles !== void 0) {
      const el = document.getElementById("deck-styles");
      if (el) el.textContent = msg.styles;
    }
    if (msg.mode !== void 0)
      document.documentElement.dataset.theme = msg.mode;
  }

  // src/ts/editor/state.ts
  var ed = {
    model: null,
    slides: [],
    // rendered SVG per *visible* slide
    current: 0,
    // deck index of the slide being edited
    selection: [],
    scope: null,
    // group entered by double-click
    layoutMode: false,
    step: null,
    // null: every element shown, no build state
    zoom: 0,
    // 0 = fit to window, else device px per slide unit
    tool: "select",
    interacting: false,
    // a drag is in progress: defer re-renders
    richEditing: false,
    // a zone is being edited in place: defer re-renders
    cropMode: false,
    // the selected image's handles crop instead of scaling
    renderPending: false,
    canUndo: false,
    canRedo: false,
    slideSelection: /* @__PURE__ */ new Set(),
    // deck indices picked in the slide list
    focus: "canvas",
    // where Delete / copy apply
    error: null,
    // A structural edit was sent and its rebuild has not been rendered yet.
    structuralPending: false,
    rebuilt: false
    // a model arrived since the last render
  };
  var listeners = /* @__PURE__ */ new Map();
  function on(event, fn) {
    let set = listeners.get(event);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      listeners.set(event, set);
    }
    set.add(fn);
  }
  function off(event, fn) {
    listeners.get(event)?.delete(fn);
  }
  function emit(event) {
    for (const fn of [...listeners.get(event) ?? []]) fn();
  }
  function currentSlide() {
    return ed.model?.slides[ed.current] ?? null;
  }
  function currentRendered() {
    const s = currentSlide();
    if (!s || s.visibleIndex == null) return null;
    return ed.slides[s.visibleIndex] ?? null;
  }
  function sourceOf(key) {
    return currentSlide()?.sources?.[key] ?? null;
  }

  // src/ts/editor/net.ts
  var ws = null;
  var nextId = 1;
  var pending = /* @__PURE__ */ new Map();
  var commandHandler = () => {
  };
  var pendingSlides = null;
  function onCommand(fn) {
    commandHandler = fn;
  }
  function connect(port) {
    const host4 = location.hostname || "localhost";
    const sock = new WebSocket(`ws://${host4}:${port}`);
    ws = sock;
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: "hello", role: "editor" }));
      document.body.classList.remove("offline");
    };
    sock.onclose = () => {
      document.body.classList.add("offline");
      for (const resolve of pending.values()) {
        resolve({ ok: false, error: "disconnected from the server" });
      }
      pending.clear();
      window.setTimeout(() => connect(port), 1500);
    };
    sock.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "update":
          pendingSlides = msg.slides;
          applyDeckStyles(msg);
          ed.error = null;
          emit("error");
          break;
        case "editor-model":
          if (pendingSlides) {
            ed.slides = pendingSlides;
            pendingSlides = null;
          }
          ed.model = msg.model;
          ed.rebuilt = true;
          if (msg.history) {
            const h2 = msg.history;
            ed.canUndo = h2.canUndo;
            ed.canRedo = h2.canRedo;
            emit("history");
          }
          emit("model");
          break;
        case "error":
          ed.error = String(msg.message ?? "build error");
          emit("error");
          break;
        case "edit-result": {
          const resolve = pending.get(msg.id);
          pending.delete(msg.id);
          resolve?.(msg);
          break;
        }
        case "editor-command":
          commandHandler(msg);
          break;
        case "notify":
          toast(String(msg.message ?? ""));
          break;
      }
    };
  }
  function request(req) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast("Not connected to the inkflow server", "error");
      return Promise.resolve({ ok: false, error: "not connected" });
    }
    const id = nextId++;
    const sock = ws;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      sock.send(JSON.stringify({ type: "edit-op", id, ...req }));
    });
  }
  var pendingTimer = 0;
  var TRANSIENT = /since the last build|wait for the reload/;
  async function edit(req, opts = {}) {
    const result = await request(req);
    if (!result.ok && !(opts.retrying && TRANSIENT.test(result.error ?? ""))) {
      toast(result.error ?? "edit failed", "error");
    }
    if (result.ok) {
      ed.canUndo = result.canUndo ?? ed.canUndo;
      ed.canRedo = result.canRedo ?? ed.canRedo;
      if (result.structural || req.action === "undo" || req.action === "redo") {
        ed.structuralPending = true;
        window.clearTimeout(pendingTimer);
        pendingTimer = window.setTimeout(() => {
          ed.structuralPending = false;
        }, 4e3);
      } else {
        updateHashes(result.hashes ?? {});
      }
      emit("history");
    }
    return result;
  }
  function updateHashes(hashes) {
    for (const slide of ed.model?.slides ?? []) {
      for (const src of slide.sources ?? []) {
        if (src.path in hashes) src.hash = hashes[src.path];
      }
    }
  }
  function sendRaw(payload) {
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify(payload));
  }

  // src/ts/editor/snap.ts
  function targetsFor(slide, others) {
    const xs = [slide.x, slide.x + slide.width / 2, slide.x + slide.width];
    const ys = [slide.y, slide.y + slide.height / 2, slide.y + slide.height];
    for (const b of others) {
      xs.push(b.x, b.x + b.width / 2, b.x + b.width);
      ys.push(b.y, b.y + b.height / 2, b.y + b.height);
    }
    return { xs, ys };
  }
  function best(edges, targets, threshold) {
    let delta = 0;
    let dist = threshold + 1;
    for (const e of edges) {
      for (const t of targets) {
        const d = Math.abs(t - e);
        if (d < dist - 1e-9) {
          dist = d;
          delta = t - e;
        }
      }
    }
    if (dist > threshold) return { delta: 0, at: [] };
    const at = /* @__PURE__ */ new Set();
    for (const e of edges) {
      for (const t of targets) {
        if (Math.abs(t - (e + delta)) < 1e-6) at.add(t);
      }
    }
    return { delta, at: [...at] };
  }
  function snapBox(box, targets, threshold) {
    const x = best(
      [box.x, box.x + box.width / 2, box.x + box.width],
      targets.xs,
      threshold
    );
    const y = best(
      [box.y, box.y + box.height / 2, box.y + box.height],
      targets.ys,
      threshold
    );
    return { dx: x.delta, dy: y.delta, guidesX: x.at, guidesY: y.at };
  }
  function snapEdges(edgesX, edgesY, targets, threshold) {
    const x = best(edgesX, targets.xs, threshold);
    const y = best(edgesY, targets.ys, threshold);
    return { dx: x.delta, dy: y.delta, guidesX: x.at, guidesY: y.at };
  }
  function distribute(boxes, axis) {
    const size = axis === "x" ? "width" : "height";
    const order2 = boxes.map((b, i) => ({ b, i })).sort((p, q) => p.b[axis] - q.b[axis]);
    const out = boxes.map((b) => b[axis]);
    if (order2.length < 3) return out;
    const first = order2[0].b;
    const last = order2[order2.length - 1].b;
    const total = order2.reduce((s, o) => s + o.b[size], 0);
    const span = last[axis] + last[size] - first[axis];
    const gap = (span - total) / (order2.length - 1);
    let pos = first[axis];
    for (const o of order2) {
      out[o.i] = pos;
      pos += o.b[size] + gap;
    }
    return out;
  }

  // src/ts/editor/canvas.ts
  var canvas = document.getElementById("canvas");
  var paper = document.getElementById("paper");
  var host = document.getElementById("slide-host");
  var overlay = document.getElementById("overlay");
  var NON_ZONES = /* @__PURE__ */ new Set(["zone-slide-number", "zone-slide-total"]);
  var DRAG_THRESHOLD = 3;
  var SNAP_PX = 6;
  var hooks = {
    editText: (_el) => {
    },
    editZone: (_zone, _el, _at) => {
    },
    // The element being edited in place (clicks inside it place the caret),
    // and how to finish that edit when the pointer goes elsewhere.
    editingHost: () => null,
    finishEditing: () => {
    },
    crop: (_el) => {
    },
    zoneMedia: (_zone) => {
    },
    toolDown: (_e, _pt) => false
  };
  function slideRoot() {
    return host.querySelector(":scope > svg");
  }
  function viewBoxSize() {
    const svg = slideRoot();
    const vb = parseViewBox(svg?.getAttribute("viewBox") ?? null);
    return { w: vb.w || 1920, h: vb.h || 1080 };
  }
  function scale() {
    const { w, h: h2 } = viewBoxSize();
    if (ed.zoom > 0) return ed.zoom;
    const pad = 48;
    const availW = Math.max(100, canvas.clientWidth - pad);
    const availH = Math.max(100, canvas.clientHeight - pad);
    return Math.min(availW / w, availH / h2);
  }
  function layoutPaper() {
    const svg = slideRoot();
    const { w, h: h2 } = viewBoxSize();
    const s = scale();
    const pw = Math.round(w * s);
    const ph = Math.round(h2 * s);
    paper.style.width = `${pw}px`;
    paper.style.height = `${ph}px`;
    svg?.setAttribute("width", String(pw));
    svg?.setAttribute("height", String(ph));
    overlay.setAttribute("width", String(pw));
    overlay.setAttribute("height", String(ph));
    overlay.setAttribute("viewBox", `0 0 ${pw} ${ph}`);
    canvas.classList.toggle("zoomed", ed.zoom > 0);
    drawOverlay();
  }
  function render() {
    if (ed.interacting || ed.richEditing) {
      ed.renderPending = true;
      return;
    }
    ed.renderPending = false;
    const keep = ed.selection.map((s) => ({
      loc: s.loc,
      id: s.el.getAttribute("id")
    }));
    const scopeKey = ed.scope?.getAttribute("data-ink") ?? null;
    const trustLoc = !ed.structuralPending;
    if (ed.rebuilt) ed.structuralPending = false;
    ed.rebuilt = false;
    const data = currentRendered();
    host.innerHTML = data ? data.svg : "";
    const hidden = currentSlide();
    if (!data && hidden && !hidden.visible) {
      host.append(
        h(
          "div",
          { class: "hidden-note" },
          h("p", {}, "This slide is hidden: the presentation skips it."),
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => void edit({
                action: "slide",
                op: "hide",
                slide: hidden.deckIndex,
                hidden: false
              })
            },
            "Show it again to edit"
          )
        )
      );
    }
    const svg = slideRoot();
    if (svg) {
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.style.display = "block";
      prepareForEditing(svg);
    }
    ed.scope = scopeKey ? host.querySelector(`[data-ink="${scopeKey}"]`) : null;
    ed.selection = [];
    for (const k of keep) {
      const el = findElement(k, trustLoc);
      if (el && selectable(el)) addToSelection(el, false);
    }
    layoutPaper();
    emit("render");
    emit("selection");
  }
  function findElement(k, trustLoc) {
    const svg = slideRoot();
    if (!svg) return null;
    if (k.id) {
      const byId = svg.querySelector(`[id="${CSS.escape(k.id)}"]`);
      if (byId?.hasAttribute("data-ink")) return byId;
    }
    if (!trustLoc) return null;
    return svg.querySelector(
      `[data-ink="${k.loc}"]`
    );
  }
  function prepareForEditing(svg) {
    svg.querySelectorAll("video").forEach((v) => {
      v.pause();
      v.removeAttribute("autoplay");
      const start = parseFloat(v.dataset.start ?? "");
      if (start > 0) v.currentTime = start;
    });
    if (ed.step == null) {
      svg.querySelectorAll(".anim-pending").forEach((el) => {
        el.classList.remove("anim-pending");
      });
    } else {
      applyStepInstant(svg, ed.step);
    }
    svg.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", (e) => e.preventDefault());
    });
  }
  function rootCTM() {
    const svg = slideRoot();
    const m = svg?.getScreenCTM();
    return m ? mat(m) : { ...IDENTITY };
  }
  function paperOrigin() {
    const r = paper.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }
  function slideToPaper() {
    const o = paperOrigin();
    return multiply({ a: 1, b: 0, c: 0, d: 1, e: -o.x, f: -o.y }, rootCTM());
  }
  function clientToSlide(x, y) {
    const inv = invert(rootCTM());
    return {
      x: inv.a * x + inv.c * y + inv.e,
      y: inv.b * x + inv.d * y + inv.f
    };
  }
  function measure(el) {
    const g = el;
    if (typeof g.getBBox !== "function") return null;
    if (el.localName === "svg" && el !== slideRoot()) {
      const s = el;
      const ctm2 = el.parentElement?.getScreenCTM?.();
      if (!ctm2) return null;
      return {
        bbox: {
          x: s.x.baseVal.value,
          y: s.y.baseVal.value,
          width: s.width.baseVal.value,
          height: s.height.baseVal.value
        },
        ctm: ctm2
      };
    }
    const b = g.getBBox();
    const ctm = g.getScreenCTM();
    if (!ctm) return null;
    return { bbox: { x: b.x, y: b.y, width: b.width, height: b.height }, ctm };
  }
  function slideBox(el) {
    try {
      const m = measure(el);
      if (!m) return null;
      const { bbox, ctm } = m;
      const toSlide = multiply(invert(rootCTM()), mat(ctm));
      return transformBox(toSlide, {
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height
      });
    } catch {
      return null;
    }
  }
  function slideSize() {
    const svg = slideRoot();
    const vb = parseViewBox(svg?.getAttribute("viewBox") ?? null);
    return { x: vb.x, y: vb.y, width: vb.w || 1920, height: vb.h || 1080 };
  }
  var GEOM_ATTRS = [
    "x",
    "y",
    "width",
    "height",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "x1",
    "y1",
    "x2",
    "y2",
    "transform",
    "viewBox"
  ];
  function elementGeom(el) {
    const parent = el.parentElement;
    const parentCTM = parent?.getScreenCTM?.();
    const attrs2 = {};
    for (const a of GEOM_ATTRS) attrs2[a] = el.getAttribute(a);
    let box = { x: 0, y: 0, width: 0, height: 0 };
    try {
      box = measure(el)?.bbox ?? box;
    } catch {
    }
    return {
      tag: el.localName,
      sourceTag: el.getAttribute("data-ink-tag") ?? el.localName,
      attrs: attrs2,
      own: parseTransform(el.getAttribute("transform")),
      parentToSlide: parentCTM ? multiply(invert(rootCTM()), mat(parentCTM)) : { ...IDENTITY },
      localBox: box
    };
  }
  function isZone(el) {
    const id = el.getAttribute("id") ?? "";
    return id.startsWith("zone-") && !NON_ZONES.has(id);
  }
  function zoneName(el) {
    return (el.getAttribute("id") ?? "").replace(/^zone-/, "");
  }
  function mediaZoneAt(clientX, clientY) {
    const inside = (r) => clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    for (const el of overlay.querySelectorAll("[data-media-zone]")) {
      if (inside(el.getBoundingClientRect()))
        return el.getAttribute("data-media-zone");
    }
    const slide = currentSlide();
    const svg = slideRoot();
    if (!slide || !svg) return null;
    for (const el of svg.querySelectorAll('[id^="zone-"]')) {
      const name = zoneName(el);
      const kind = slide.zones[name]?.kind;
      if ((kind === "image" || kind === "video") && inside(el.getBoundingClientRect()))
        return name;
    }
    return null;
  }
  function keyOf(el) {
    const loc = el.getAttribute("data-ink") ?? "";
    return parseInt(loc.split(":")[0] ?? "", 10);
  }
  function isLocked(el) {
    return el.closest("[data-ink-locked]") !== null;
  }
  function isOwn(el) {
    const src = sourceOf(keyOf(el));
    const slide = currentSlide();
    return !!src && src.role === "slide" && !!slide && !slide.srcShared && src.writable;
  }
  function selectable(el) {
    if (!el.hasAttribute("data-ink") || isLocked(el)) return false;
    const src = sourceOf(keyOf(el));
    if (!src) return false;
    if (ed.layoutMode) return src.writable;
    return isOwn(el) || el.hasAttribute("data-ink-top") && isZone(el);
  }
  function canTransform(el) {
    const src = sourceOf(keyOf(el));
    if (!src?.writable) return false;
    return ed.layoutMode || isOwn(el);
  }
  function pick(x, y) {
    const svg = slideRoot();
    if (!svg) return null;
    for (const hit of document.elementsFromPoint(x, y)) {
      if (!svg.contains(hit)) continue;
      let node = hit;
      if (!(node instanceof SVGElement)) node = node.closest("foreignObject");
      while (node && node !== svg) {
        if (ed.scope) {
          if (node.parentElement === ed.scope && node.hasAttribute("data-ink")) {
            return selectable(node) ? node : null;
          }
        } else if (node.hasAttribute("data-ink-top") && selectable(node)) {
          return node;
        }
        node = node.parentElement;
      }
    }
    return pickByBox(svg, x, y);
  }
  function pickByBox(svg, x, y) {
    const pt = clientToSlide(x, y);
    const slide = slideSize();
    const pool = ed.scope ? [...ed.scope.children].filter((el) => el.hasAttribute("data-ink")) : [...svg.querySelectorAll("[data-ink-top]")];
    for (let i = pool.length - 1; i >= 0; i--) {
      const el = pool[i];
      if (!selectable(el)) continue;
      const b = slideBox(el);
      if (!b || b.width * b.height > slide.width * slide.height * 0.8)
        continue;
      if (pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height) {
        return el;
      }
    }
    return null;
  }
  function candidatesAt(x, y) {
    const svg = slideRoot();
    if (!svg) return [];
    const out = [];
    const add = (el) => {
      if (el && !out.includes(el) && selectable(el)) {
        out.push(el);
      }
    };
    const owner = (node) => {
      while (node && node !== svg) {
        if (ed.scope) {
          if (node.parentElement === ed.scope) return node;
        } else if (node.hasAttribute("data-ink-top")) return node;
        node = node.parentElement;
      }
      return null;
    };
    for (const hit of document.elementsFromPoint(x, y)) {
      if (!svg.contains(hit)) continue;
      const node = hit instanceof SVGElement ? hit : hit.closest("foreignObject");
      add(owner(node));
    }
    const pt = clientToSlide(x, y);
    const pool = ed.scope ? [...ed.scope.children] : [...svg.querySelectorAll("[data-ink-top]")];
    for (let i = pool.length - 1; i >= 0; i--) {
      const b = slideBox(pool[i]);
      if (b && pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height) {
        add(pool[i]);
      }
    }
    return out;
  }
  var cycle = null;
  function cycleSelect(e) {
    const near = cycle !== null && Math.hypot(cycle.x - e.clientX, cycle.y - e.clientY) < 6;
    const all = candidatesAt(e.clientX, e.clientY);
    if (!all.length) {
      clearSelection();
      return;
    }
    const current = ed.selection.length === 1 ? ed.selection[0].el : null;
    let index = near && cycle ? cycle.index + 1 : 0;
    if (!near && current && all[0] === current) index = 1;
    index %= all.length;
    cycle = { x: e.clientX, y: e.clientY, index };
    select([all[index]]);
    if (all.length > 1) {
      const name = all[index].getAttribute("id") ?? all[index].localName;
      toast(`${index + 1} of ${all.length} here: ${name}`);
    }
  }
  function setHover(el) {
    if (el !== hoverEl) {
      hoverEl = el;
      drawOverlay();
    }
  }
  function toSelected(el) {
    const loc = el.getAttribute("data-ink") ?? "";
    return { el, key: keyOf(el), loc };
  }
  function addToSelection(el, notify = true) {
    if (ed.selection.some((s) => s.el === el)) return;
    ed.selection.push(toSelected(el));
    if (notify) {
      drawOverlay();
      emit("selection");
    }
  }
  function select(els) {
    ed.selection = els.map(toSelected);
    drawOverlay();
    emit("selection");
  }
  function clearSelection() {
    if (!ed.selection.length) return;
    ed.selection = [];
    drawOverlay();
    emit("selection");
  }
  function selectAll() {
    const svg = slideRoot();
    if (!svg) return;
    const scope = ed.scope ?? svg;
    const els = [...scope.querySelectorAll("[data-ink]")].filter(
      (el) => (ed.scope ? el.parentElement === ed.scope : el.hasAttribute("data-ink-top")) && selectable(el) && (canTransform(el) || ed.scope !== null)
    );
    select(els);
  }
  function enterGroup(g) {
    ed.scope = g;
    clearSelection();
    drawOverlay();
    emit("selection");
  }
  var hoverEl = null;
  var guides = { xs: [], ys: [] };
  var marquee = null;
  function poly(points, cls) {
    return svgEl("polygon", {
      points: points.map((p) => `${p.x},${p.y}`).join(" "),
      class: cls
    });
  }
  function elementCorners(el) {
    try {
      const measured = measure(el);
      if (!measured) return null;
      const b = measured.bbox;
      const ctm = measured.ctm;
      const o = paperOrigin();
      const m = mat(ctm);
      return [
        { x: b.x, y: b.y },
        { x: b.x + b.width, y: b.y },
        { x: b.x + b.width, y: b.y + b.height },
        { x: b.x, y: b.y + b.height }
      ].map((p) => ({
        x: m.a * p.x + m.c * p.y + m.e - o.x,
        y: m.b * p.x + m.d * p.y + m.f - o.y
      }));
    } catch {
      return null;
    }
  }
  function toPaperBox(b) {
    return transformBox(slideToPaper(), b);
  }
  function selectionBox() {
    return unionBoxes(
      ed.selection.map((s) => slideBox(s.el)).filter((b) => b !== null)
    );
  }
  var HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  function handlePoint(h2, b) {
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const r = b.x + b.width;
    const btm = b.y + b.height;
    switch (h2) {
      case "nw":
        return { x: b.x, y: b.y };
      case "n":
        return { x: cx, y: b.y };
      case "ne":
        return { x: r, y: b.y };
      case "e":
        return { x: r, y: cy };
      case "se":
        return { x: r, y: btm };
      case "s":
        return { x: cx, y: btm };
      case "sw":
        return { x: b.x, y: btm };
      case "w":
        return { x: b.x, y: cy };
      case "rot":
        return { x: cx, y: b.y - 28 };
    }
  }
  function drawOverlay() {
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    const svg = slideRoot();
    if (!svg) return;
    drawPlaceholders();
    if (ed.scope) {
      const c = elementCorners(ed.scope);
      if (c) overlay.append(poly(c, "scope-outline"));
    }
    if (hoverEl && !ed.selection.some((s) => s.el === hoverEl)) {
      const c = elementCorners(hoverEl);
      if (c) overlay.append(poly(c, "hover-outline"));
    }
    for (const s of ed.selection) {
      const c = elementCorners(s.el);
      if (c) {
        overlay.append(
          poly(
            c,
            canTransform(s.el) ? "sel-outline" : "sel-outline content-only"
          )
        );
      }
    }
    if (ed.cropMode) drawCropGhost();
    const transformable = ed.selection.filter((s) => canTransform(s.el));
    const box = transformable.length === ed.selection.length ? selectionBox() : null;
    if (box && ed.step == null) {
      const pb = toPaperBox(box);
      if (ed.selection.length > 1) {
        overlay.append(
          svgEl("rect", {
            x: pb.x,
            y: pb.y,
            width: pb.width,
            height: pb.height,
            class: "group-outline"
          })
        );
      }
      const top = handlePoint("n", pb);
      const rot = handlePoint("rot", pb);
      overlay.append(
        svgEl("line", {
          x1: top.x,
          y1: top.y,
          x2: rot.x,
          y2: rot.y,
          class: "rot-stem"
        })
      );
      const rh = svgEl("circle", {
        cx: rot.x,
        cy: rot.y,
        r: 6,
        class: "handle rot"
      });
      rh.dataset.handle = "rot";
      const frames = ed.selection.some((s) => s.el.localName === "svg");
      if (!ed.cropMode && !frames) overlay.append(rh);
      for (const h2 of HANDLES) {
        const p = handlePoint(h2, pb);
        const r = svgEl("rect", {
          x: p.x - 5,
          y: p.y - 5,
          width: 10,
          height: 10,
          class: `handle h-${h2}`
        });
        r.dataset.handle = h2;
        overlay.append(r);
      }
    }
    for (const x of guides.xs) {
      const p = toPaperBox({ x, y: 0, width: 0, height: slideSize().height });
      overlay.append(
        svgEl("line", {
          x1: p.x,
          y1: p.y,
          x2: p.x,
          y2: p.y + p.height,
          class: "guide"
        })
      );
    }
    for (const y of guides.ys) {
      const p = toPaperBox({ x: 0, y, width: slideSize().width, height: 0 });
      overlay.append(
        svgEl("line", {
          x1: p.x,
          y1: p.y,
          x2: p.x + p.width,
          y2: p.y,
          class: "guide"
        })
      );
    }
    if (marquee) {
      const p = toPaperBox(marquee);
      overlay.append(
        svgEl("rect", {
          x: p.x,
          y: p.y,
          width: p.width,
          height: p.height,
          class: "marquee"
        })
      );
    }
  }
  function drawCropGhost() {
    const frame = ed.selection[0]?.el;
    const image = frame ? [...frame.children].find((c2) => c2.localName === "image") : void 0;
    if (!image) return;
    const c = elementCorners(image);
    if (!c) return;
    const xs = c.map((p) => p.x);
    const ys = c.map((p) => p.y);
    const ghost = svgEl("image", {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      href: image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "",
      preserveAspectRatio: image.getAttribute("preserveAspectRatio") ?? "xMidYMid meet",
      class: "crop-ghost"
    });
    overlay.append(ghost, poly(c, "crop-extent"));
  }
  var MEDIA_ZONES = /media|image|img|picture|photo|figure|video|logo/;
  function drawPlaceholders() {
    const slide = currentSlide();
    if (!slide?.emptyZones || ed.step != null) return;
    for (const z of slide.emptyZones) {
      const key = parseInt(z.locator.split(":")[0] ?? "", 10);
      const src = sourceOf(key);
      if (!src || z.zone === "slide-number" || z.zone === "slide-total")
        continue;
      const own = parseTransform(z.transform);
      const box = transformBox(own, z);
      const pb = toPaperBox(box);
      const media = MEDIA_ZONES.test(z.zone);
      const outline = svgEl("rect", {
        x: pb.x,
        y: pb.y,
        width: pb.width,
        height: pb.height,
        rx: 4,
        class: "placeholder-outline"
      });
      if (media) outline.setAttribute("data-media-zone", z.zone);
      overlay.append(outline);
      const g = svgEl("g", { class: "placeholder" });
      const text = media ? `+ media \xB7 ${z.zone}` : `+ ${z.zone}`;
      const w = 14 + text.length * 7.2;
      const tx = pb.x + 6;
      const ty = pb.y + 6;
      g.append(svgEl("rect", { x: tx, y: ty, width: w, height: 22, rx: 11 }));
      const label3 = svgEl("text", {
        x: tx + w / 2,
        y: ty + 15,
        "text-anchor": "middle"
      });
      label3.textContent = text;
      g.append(label3);
      const title = svgEl("title");
      title.textContent = media ? `Add an image or video to the ${z.zone} zone` : `Add ${z.zone} text (Markdown)`;
      g.append(title);
      g.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (media) hooks.zoneMedia(z.zone);
        else hooks.editZone(z.zone, null);
      });
      overlay.append(g);
    }
  }
  function opsByFile(plans) {
    const out = /* @__PURE__ */ new Map();
    for (const { sel, ops } of plans) {
      const src = sourceOf(sel.key);
      if (!src) continue;
      const list2 = out.get(src.path) ?? [];
      list2.push(...ops);
      out.set(src.path, list2);
    }
    return out;
  }
  async function sendSvgOps(plans, label3, coalesce) {
    const slide = currentSlide();
    if (!slide) return false;
    if (ed.structuralPending) {
      toast("One moment: the last change is still being applied");
      return false;
    }
    const run = queue.then(() => sendQueued(plans, label3, coalesce));
    queue = run.catch(() => false);
    return run;
  }
  var queue = Promise.resolve();
  async function sendQueued(plans, label3, coalesce) {
    const slide = currentSlide();
    if (!slide) return false;
    let ok = true;
    for (const [path, ops] of opsByFile(plans)) {
      const src = slide.sources?.find((s) => s.path === path);
      if (src && src.usedBy.length > 1 && ed.layoutMode) {
        toast(`Edited ${src.rel}: affects ${src.usedBy.length} slides`);
      }
      const result = await edit({
        action: "svg",
        file: path,
        hash: src?.hash ?? "",
        ops,
        label: label3,
        coalesce,
        // Deleting or duplicating a zone takes its content along (not in
        // layout mode: a layout's zones are filled by every slide).
        zoneSlide: ed.layoutMode ? void 0 : slide.deckIndex
      });
      ok = ok && result.ok;
    }
    return ok;
  }
  function applyPlanToDom(el, plan) {
    for (const [k, v] of Object.entries(plan)) {
      if (v == null) el.removeAttribute(k);
      else el.setAttribute(k, v);
    }
  }
  function textChildren(el) {
    return [...el.querySelectorAll("tspan")].filter(
      (t) => t.hasAttribute("x") || t.hasAttribute("y")
    );
  }
  function moveOps(sel, dx, dy) {
    const kids = textChildren(sel.el);
    const plan = planMove(
      elementGeom(sel.el),
      dx,
      dy,
      kids.map((k) => ({
        attrs: { x: k.getAttribute("x"), y: k.getAttribute("y") }
      }))
    );
    const ops = [{ kind: "attrs", loc: sel.loc, set: plan.attrs }];
    applyPlanToDom(sel.el, plan.attrs);
    plan.children?.forEach((p, i) => {
      const loc = kids[i].getAttribute("data-ink");
      if (loc && Object.keys(p).length) {
        ops.push({ kind: "attrs", loc, set: p });
        applyPlanToDom(kids[i], p);
      }
    });
    return ops;
  }
  async function nudge(dx, dy) {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (!sels.length) return;
    const plans = sels.map((sel) => ({ sel, ops: moveOps(sel, dx, dy) }));
    drawOverlay();
    await sendSvgOps(plans, "Nudge", "nudge");
  }
  function snapshot(sel) {
    const attrs2 = {};
    for (const a of GEOM_ATTRS) attrs2[a] = sel.el.getAttribute(a);
    return {
      sel,
      attrs: attrs2,
      kids: textChildren(sel.el).map((el) => ({
        el,
        x: el.getAttribute("x"),
        y: el.getAttribute("y")
      })),
      box: slideBox(sel.el) ?? { x: 0, y: 0, width: 0, height: 0 },
      geom: elementGeom(sel.el)
    };
  }
  function restore(snaps) {
    for (const s of snaps) {
      applyPlanToDom(s.sel.el, s.attrs);
      for (const k of s.kids) {
        applyPlanToDom(k.el, { x: k.x, y: k.y });
      }
    }
  }
  function snapTargets(exclude) {
    const svg = slideRoot();
    const boxes = [];
    if (svg) {
      for (const el of svg.querySelectorAll("[data-ink-top]")) {
        if (exclude.has(el) || [...exclude].some((x) => x.contains(el)))
          continue;
        const b = slideBox(el);
        if (b && b.width > 0 && b.height > 0) boxes.push(b);
      }
    }
    return targetsFor(slideSize(), boxes);
  }
  var pointer = null;
  function beginDrag(handle) {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (!sels.length || sels.length !== ed.selection.length || ed.step != null)
      return null;
    const snaps = sels.map(snapshot);
    const start = unionBoxes(snaps.map((s) => s.box));
    if (!start) return null;
    const targets = snapTargets(new Set(sels.map((s) => s.el)));
    if (handle === "rot") {
      return {
        kind: "rotate",
        snaps,
        center: {
          x: start.x + start.width / 2,
          y: start.y + start.height / 2
        }
      };
    }
    if (handle) return { kind: "resize", handle, snaps, start, targets };
    return { kind: "move", snaps, start, targets };
  }
  function resizedBox(start, handle, dx, dy, keepAspect) {
    let { x, y, width, height } = start;
    if (handle.includes("w")) {
      x += dx;
      width -= dx;
    }
    if (handle.includes("e")) width += dx;
    if (handle.includes("n")) {
      y += dy;
      height -= dy;
    }
    if (handle.includes("s")) height += dy;
    if (keepAspect && start.width > 0 && start.height > 0) {
      const ratio = start.width / start.height;
      const corner = handle.length === 2;
      if (corner || handle === "e" || handle === "w") {
        const h2 = width / ratio;
        if (handle.includes("n")) y += height - h2;
        else if (!corner) y = start.y + (start.height - h2) / 2;
        height = h2;
      } else {
        const w2 = height * ratio;
        x = start.x + (start.width - w2) / 2;
        width = w2;
      }
    }
    if (width < 0) {
      x += width;
      width = -width;
    }
    if (height < 0) {
      y += height;
      height = -height;
    }
    return { x, y, width: Math.max(width, 1), height: Math.max(height, 1) };
  }
  function keepsAspect(snaps, shift) {
    const natural = snaps.some(
      (s) => ["text", "image", "circle"].includes(s.geom.sourceTag)
    );
    return natural !== shift;
  }
  function mapBox(b, from, to) {
    const sx = from.width ? to.width / from.width : 1;
    const sy = from.height ? to.height / from.height : 1;
    return {
      x: to.x + (b.x - from.x) * sx,
      y: to.y + (b.y - from.y) * sy,
      width: b.width * sx,
      height: b.height * sy
    };
  }
  var lastPlans = [];
  function updateDrag(drag, e) {
    if (!pointer) return;
    const p0 = clientToSlide(pointer.x, pointer.y);
    const p1 = clientToSlide(e.clientX, e.clientY);
    let dx = p1.x - p0.x;
    let dy = p1.y - p0.y;
    const threshold = SNAP_PX / scale();
    guides = { xs: [], ys: [] };
    if (drag.kind === "move") {
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      if (!e.altKey) {
        const moved = {
          ...drag.start,
          x: drag.start.x + dx,
          y: drag.start.y + dy
        };
        const snap = snapBox(moved, drag.targets, threshold);
        dx += snap.dx;
        dy += snap.dy;
        guides = { xs: snap.guidesX, ys: snap.guidesY };
      }
      restore(drag.snaps);
      lastPlans = drag.snaps.map((s) => ({
        sel: s.sel,
        ops: moveOps(s.sel, dx, dy)
      }));
    } else if (drag.kind === "resize") {
      if (!e.altKey) {
        const h2 = drag.handle;
        const edgesX = [];
        const edgesY = [];
        if (h2.includes("w")) edgesX.push(drag.start.x + dx);
        if (h2.includes("e"))
          edgesX.push(drag.start.x + drag.start.width + dx);
        if (h2.includes("n")) edgesY.push(drag.start.y + dy);
        if (h2.includes("s"))
          edgesY.push(drag.start.y + drag.start.height + dy);
        const snap = snapEdges(edgesX, edgesY, drag.targets, threshold);
        dx += snap.dx;
        dy += snap.dy;
        guides = { xs: snap.guidesX, ys: snap.guidesY };
      }
      const cropping = ed.cropMode && drag.snaps.length === 1;
      const to = resizedBox(
        drag.start,
        drag.handle,
        dx,
        dy,
        !cropping && keepsAspect(drag.snaps, e.shiftKey)
      );
      restore(drag.snaps);
      lastPlans = drag.snaps.map((s) => {
        const target = mapBox(s.box, drag.start, to);
        const plan = cropping && planCrop(s.geom, s.box, target) || planResize(s.geom, s.box, target);
        applyPlanToDom(s.sel.el, plan);
        return {
          sel: s.sel,
          ops: [{ kind: "attrs", loc: s.sel.loc, set: plan }]
        };
      });
    } else if (drag.kind === "rotate") {
      const c = drag.center;
      const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
      const a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
      let deg = (a1 - a0) * 180 / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      restore(drag.snaps);
      lastPlans = drag.snaps.map((s) => {
        const plan = planRotate(s.geom, deg, c);
        applyPlanToDom(s.sel.el, plan);
        return {
          sel: s.sel,
          ops: [{ kind: "attrs", loc: s.sel.loc, set: plan }]
        };
      });
    } else if (drag.kind === "marquee") {
      marquee = {
        x: Math.min(p0.x, p1.x),
        y: Math.min(p0.y, p1.y),
        width: Math.abs(p1.x - p0.x),
        height: Math.abs(p1.y - p0.y)
      };
    }
    drawOverlay();
  }
  async function endDrag(drag) {
    guides = { xs: [], ys: [] };
    if (drag.kind === "marquee") {
      const m = marquee;
      marquee = null;
      if (!m) return;
      const svg = slideRoot();
      if (!svg) return;
      const hits = [...svg.querySelectorAll("[data-ink-top]")].filter(
        (el) => {
          if (!selectable(el) || !canTransform(el)) return false;
          const b = slideBox(el);
          return !!b && b.x >= m.x && b.y >= m.y && b.x + b.width <= m.x + m.width && b.y + b.height <= m.y + m.height;
        }
      );
      if (drag.additive) {
        for (const el of hits) addToSelection(el, false);
        select(ed.selection.map((s) => s.el));
      } else select(hits);
      return;
    }
    const plans = lastPlans;
    lastPlans = [];
    drawOverlay();
    if (!plans.length) return;
    const label3 = drag.kind === "move" ? "Move" : drag.kind === "resize" ? ed.cropMode ? "Crop" : "Resize" : "Rotate";
    const ok = await sendSvgOps(plans, label3);
    if (!ok) restore(drag.snaps);
    drawOverlay();
  }
  function onPointerDown(e) {
    ed.focus = "canvas";
    if (ed.slideSelection.size) {
      ed.slideSelection.clear();
      emit("slide-selection");
    }
    const target = e.target;
    const editing = hooks.editingHost();
    if (editing) {
      if (editing.contains(target)) return;
      hooks.finishEditing();
    }
    if (!slideRoot()) return;
    if (e.button === 1 || e.button === 0 && e.altKey && ed.tool === "select") {
      e.preventDefault();
      cycleSelect(e);
      return;
    }
    if (e.button !== 0) return;
    const handle = target.closest("[data-handle]")?.dataset.handle;
    const pt = clientToSlide(e.clientX, e.clientY);
    if (!handle && ed.tool !== "select") {
      if (hooks.toolDown(e, pt)) return;
    }
    paper.setPointerCapture(e.pointerId);
    e.preventDefault();
    ed.interacting = true;
    let clickTarget = null;
    let drag = null;
    if (handle) {
      drag = beginDrag(handle);
    } else {
      clickTarget = pick(e.clientX, e.clientY);
      if (clickTarget) {
        const already = ed.selection.some((s) => s.el === clickTarget);
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          if (already) {
            ed.selection = ed.selection.filter(
              (s) => s.el !== clickTarget
            );
            drawOverlay();
            emit("selection");
            clickTarget = null;
          } else addToSelection(clickTarget);
        } else if (!already) select([clickTarget]);
      } else {
        if (!e.shiftKey) {
          if (ed.scope && !ed.scope.contains(target)) enterGroup(null);
          clearSelection();
        }
        drag = { kind: "marquee", additive: e.shiftKey };
      }
    }
    pointer = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      started: false,
      drag,
      clickTarget,
      shift: e.shiftKey
    };
  }
  function onPointerMove(e) {
    if (!pointer) {
      if (ed.tool === "select" && e.buttons === 0) {
        const el = pick(e.clientX, e.clientY);
        if (el !== hoverEl) {
          hoverEl = el;
          drawOverlay();
        }
      }
      return;
    }
    if (e.pointerId !== pointer.id) return;
    if (!pointer.started) {
      const dist = Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y);
      if (dist < DRAG_THRESHOLD) return;
      pointer.started = true;
      if (!pointer.drag && pointer.clickTarget)
        pointer.drag = beginDrag(null);
      if (pointer.drag?.kind === "move" && !canTransform(pointer.clickTarget)) {
        pointer.drag = null;
      }
    }
    if (pointer.drag) updateDrag(pointer.drag, e);
  }
  async function onPointerUp(e) {
    if (!pointer || e.pointerId !== pointer.id) return;
    const p = pointer;
    pointer = null;
    try {
      if (p.drag && p.started) await endDrag(p.drag);
      else if (p.drag?.kind === "marquee") marquee = null;
    } finally {
      ed.interacting = false;
      if (ed.renderPending) render();
      else drawOverlay();
    }
  }
  function textUnder(x, y) {
    const svg = slideRoot();
    for (const hit of document.elementsFromPoint(x, y)) {
      const t = hit.closest("text");
      if (t && svg?.contains(t) && t.hasAttribute("data-ink")) {
        return t;
      }
    }
    return null;
  }
  function onDoubleClick(e) {
    if (hooks.editingHost()?.contains(e.target)) return;
    const el = pick(e.clientX, e.clientY);
    if (!el) return;
    if (isZone(el)) {
      hooks.editZone(zoneName(el), el, { x: e.clientX, y: e.clientY });
      return;
    }
    const text = textUnder(e.clientX, e.clientY);
    if (text && el.contains(text)) {
      if (text !== el && !text.hasAttribute("data-ink-top")) {
        enterGroup(text.parentElement);
      }
      select([text]);
      hooks.editText(text);
      return;
    }
    if (el.localName === "g") {
      enterGroup(el);
      const inner = pick(e.clientX, e.clientY);
      if (inner) select([inner]);
      return;
    }
    if (canTransform(el) && (el.localName === "image" || el.localName === "svg" && [...el.children].some((c) => c.localName === "image"))) {
      hooks.crop(el);
    }
  }
  function initCanvas() {
    paper.addEventListener("pointerdown", onPointerDown);
    for (const type of ["mousedown", "auxclick"]) {
      paper.addEventListener(type, (e) => {
        if (e.button === 1) e.preventDefault();
      });
    }
    paper.addEventListener("pointermove", onPointerMove);
    paper.addEventListener("pointerup", (e) => void onPointerUp(e));
    paper.addEventListener("pointercancel", (e) => void onPointerUp(e));
    paper.addEventListener("dblclick", onDoubleClick);
    paper.addEventListener("pointerleave", () => {
      if (hoverEl) {
        hoverEl = null;
        drawOverlay();
      }
    });
    new ResizeObserver(() => layoutPaper()).observe(canvas);
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        setZoom(scale() * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      },
      { passive: false }
    );
    canvas.addEventListener("pointerdown", (e) => {
      if (e.target === canvas) {
        enterGroup(null);
        clearSelection();
      }
    });
    on("model", render);
    on("rerender", render);
  }
  function setZoom(z) {
    ed.zoom = z <= 0 ? 0 : Math.max(0.05, Math.min(z, 8));
    layoutPaper();
    emit("zoom");
  }

  // src/ts/editor/insert.ts
  var overlay2 = document.getElementById("overlay");
  var afterRender = {
    ids: [],
    editText: false
  };
  function setTool(tool) {
    ed.tool = tool;
    document.body.dataset.tool = tool;
    emit("tool");
  }
  function waitForModel(pred, ms = 5e3) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        off("model", check);
        resolve(ok);
      };
      const deadline = window.setTimeout(() => finish(false), ms);
      const check = () => {
        const s = currentSlide();
        if (s && pred(s)) {
          window.clearTimeout(deadline);
          finish(true);
        }
      };
      on("model", check);
    });
  }
  async function ensureOwnDrawing() {
    const slide = currentSlide();
    if (!slide) return false;
    if (!slide.srcShared) return true;
    if (!ed.model?.deckEditable) {
      toast(
        "deck.py builds its slides in code; cannot add a drawing here",
        "error"
      );
      return false;
    }
    const deckIndex = slide.deckIndex;
    const result = await edit({
      action: "slide",
      op: "detach",
      slide: deckIndex,
      name: slide.id ?? slide.explicitId ?? "slide"
    });
    if (!result.ok) return false;
    toast("This slide now has its own SVG (built on its layout)");
    return waitForModel((s) => s.deckIndex === deckIndex && !s.srcShared);
  }
  function ownSource() {
    return currentSlide()?.sources?.find((s) => s.role === "slide") ?? null;
  }
  function insertParent() {
    const svg = slideRoot();
    if (ed.scope?.getAttribute("data-ink")?.startsWith("0:")) {
      return { loc: ed.scope.getAttribute("data-ink"), el: ed.scope };
    }
    const layers = svg ? [...svg.querySelectorAll('[data-ink-layer][data-ink^="0:"]')].filter(
      (l) => !l.hasAttribute("data-ink-locked")
    ) : [];
    const layer2 = layers[layers.length - 1];
    if (layer2) return { loc: layer2.getAttribute("data-ink"), el: layer2 };
    return { loc: "0:", el: null };
  }
  function toParent(el, x, y) {
    const svg = slideRoot();
    if (!el || !svg) return { x, y };
    const p = el.getScreenCTM?.();
    const r = svg.getScreenCTM();
    if (!p || !r) return { x, y };
    const m = multiply(invert(mat(p)), mat(r));
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }
  async function insertXml(xml, base, opts = {}) {
    if (!await ensureOwnDrawing()) return false;
    const src = ownSource();
    if (!src) return false;
    const parent = insertParent();
    const ops = [];
    if (opts.marker) ops.push({ kind: "ensure-marker" });
    ops.push({ kind: "insert", parent: parent.loc, xml, base, key: "new" });
    const result = await edit({
      action: "svg",
      file: src.path,
      hash: src.hash,
      ops,
      label: `Insert ${base}`
    });
    if (!result.ok) return false;
    const id = result.ids?.new;
    if (id) {
      afterRender.ids = [id];
      afterRender.editText = !!opts.editText;
    }
    return true;
  }
  var SHAPE_STYLE = {
    rect: 'class="inkflow-fill-surface inkflow-stroke-accent" style="stroke-width:4"',
    ellipse: 'class="inkflow-fill-surface inkflow-stroke-accent" style="stroke-width:4"',
    line: 'class="inkflow-stroke-text" style="fill:none;stroke-width:6;stroke-linecap:round"'
  };
  function shapeXml(tool, a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h2 = Math.abs(b.y - a.y);
    switch (tool) {
      case "rect":
        return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h2)}" rx="16" ${SHAPE_STYLE.rect}/>`;
      case "ellipse":
        return `<ellipse cx="${fmt(x + w / 2)}" cy="${fmt(y + h2 / 2)}" rx="${fmt(w / 2)}" ry="${fmt(h2 / 2)}" ${SHAPE_STYLE.ellipse}/>`;
      case "arrow":
        return `<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}" ${SHAPE_STYLE.line} marker-end="url(#inkflow-arrow)"/>`;
      default:
        return `<line x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}" ${SHAPE_STYLE.line}/>`;
    }
  }
  function textXml(p) {
    return `<text x="${fmt(p.x)}" y="${fmt(p.y)}" class="inkflow-fill-text" style="font-size:56px;font-family:var(--inkflow-body-font, sans-serif)">Text</text>`;
  }
  var draft = null;
  function drawDraft(tool, a, b) {
    draft?.remove();
    const m = slideToPaper();
    const pa = { x: m.a * a.x + m.e, y: m.d * a.y + m.f };
    const pb = { x: m.a * b.x + m.e, y: m.d * b.y + m.f };
    if (tool === "line" || tool === "arrow") {
      draft = svgEl("line", {
        x1: pa.x,
        y1: pa.y,
        x2: pb.x,
        y2: pb.y,
        class: "draft"
      });
    } else {
      const box = transformBox(m, {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y)
      });
      draft = tool === "ellipse" ? svgEl("ellipse", {
        cx: box.x + box.width / 2,
        cy: box.y + box.height / 2,
        rx: box.width / 2,
        ry: box.height / 2,
        class: "draft"
      }) : svgEl("rect", {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        class: "draft"
      });
    }
    overlay2.append(draft);
  }
  function onToolDown(e, start) {
    const tool = ed.tool;
    if (tool === "select") return false;
    e.preventDefault();
    clearSelection();
    const paperEl = e.currentTarget;
    paperEl.setPointerCapture(e.pointerId);
    ed.interacting = true;
    let end = start;
    const move = (ev) => {
      end = clientToSlide(ev.clientX, ev.clientY);
      if (ev.shiftKey && (tool === "rect" || tool === "ellipse")) {
        const d = Math.max(
          Math.abs(end.x - start.x),
          Math.abs(end.y - start.y)
        );
        end = {
          x: start.x + Math.sign(end.x - start.x || 1) * d,
          y: start.y + Math.sign(end.y - start.y || 1) * d
        };
      }
      drawDraft(tool, start, end);
    };
    const up = () => {
      paperEl.removeEventListener("pointermove", move);
      paperEl.removeEventListener("pointerup", up);
      draft?.remove();
      draft = null;
      ed.interacting = false;
      let a = start;
      let b = end;
      if (tool === "text") {
        void insertTextBox(start, end);
        setTool("select");
        drawOverlay();
        return;
      }
      if (Math.hypot(b.x - a.x, b.y - a.y) < 8) {
        const w = tool === "line" || tool === "arrow" ? 300 : 360;
        const h2 = tool === "line" || tool === "arrow" ? 0 : 220;
        a = { x: start.x - w / 2, y: start.y - h2 / 2 };
        b = { x: start.x + w / 2, y: start.y + h2 / 2 };
      }
      const parent = insertParent().el;
      const pa = toParent(parent, a.x, a.y);
      const pb = toParent(parent, b.x, b.y);
      void insertXml(shapeXml(tool, pa, pb), tool, {
        marker: tool === "arrow"
      });
      setTool("select");
      if (ed.renderPending) emit("model");
      drawOverlay();
    };
    paperEl.addEventListener("pointermove", move);
    paperEl.addEventListener("pointerup", up);
    return true;
  }
  async function insertTextBox(a, b) {
    const slide = currentSlide();
    if (!slide) return;
    const vb = slideRoot()?.viewBox.baseVal;
    const vw = vb?.width || 1920;
    let box = {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y)
    };
    if (box.width < 40 || box.height < 20) {
      box = {
        x: a.x,
        y: a.y - 40,
        width: Math.max(300, Math.min(900, vw - a.x - 60)),
        height: 100
      };
    }
    const plain2 = ed.layoutMode || !ed.model?.deckEditable && !slide.md;
    if (plain2) {
      const p = toParent(insertParent().el, a.x, a.y);
      await insertXml(textXml(p), "text", { editText: true });
      return;
    }
    if (!await ensureOwnDrawing()) return;
    const src = ownSource();
    const current = currentSlide();
    if (!src || !current) return;
    const parent = insertParent();
    const p0 = toParent(parent.el, box.x, box.y);
    const p1 = toParent(parent.el, box.x + box.width, box.y + box.height);
    const result = await edit({
      action: "insert-textbox",
      slide: current.deckIndex,
      file: src.path,
      hash: src.hash,
      parent: parent.loc,
      x: Math.round(Math.min(p0.x, p1.x)),
      y: Math.round(Math.min(p0.y, p1.y)),
      width: Math.round(Math.abs(p1.x - p0.x)),
      height: Math.round(Math.abs(p1.y - p0.y)),
      text: "Text"
    });
    const id = result.ids?.new;
    if (result.ok && id) {
      afterRender.ids = [id];
      afterRender.editText = true;
    }
  }
  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        resolve(url.slice(url.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
  async function upload(file) {
    const data = await readBase64(file);
    const result = await request({ action: "upload", name: file.name, data });
    if (!result.ok || !result.path || !result.rel) {
      toast(result.error ?? "upload failed", "error");
      return null;
    }
    return { path: result.path, rel: result.rel };
  }
  function naturalSize(rel) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({
        w: img.naturalWidth || 400,
        h: img.naturalHeight || 300
      });
      img.onerror = () => resolve({ w: 400, h: 300 });
      img.src = `/${rel}`;
    });
  }
  function videoSize(rel) {
    return new Promise((resolve) => {
      const video = document.createElement("video");
      const fallback = { w: 1280, h: 720 };
      const timer3 = window.setTimeout(() => resolve(fallback), 3e3);
      video.preload = "metadata";
      video.muted = true;
      video.onloadedmetadata = () => {
        window.clearTimeout(timer3);
        resolve(
          video.videoWidth && video.videoHeight ? { w: video.videoWidth, h: video.videoHeight } : fallback
        );
      };
      video.onerror = () => {
        window.clearTimeout(timer3);
        resolve(fallback);
      };
      video.src = `/${rel}`;
    });
  }
  function isVideo(file) {
    return file.type.startsWith("video/") || /\.(mp4|webm|ogg|mov)$/i.test(file.name);
  }
  async function insertVideoFile(file, at) {
    if (!await ensureOwnDrawing()) return;
    const up = await upload(file);
    const src = ownSource();
    const slide = currentSlide();
    if (!up || !src || !slide) return;
    const size = await videoSize(up.rel);
    const vb = slideRoot()?.viewBox.baseVal;
    const vw = vb?.width || 1920;
    const vh = vb?.height || 1080;
    const k = Math.min(vw * 0.6 / size.w, vh * 0.6 / size.h);
    const w = size.w * k;
    const h2 = size.h * k;
    const cx = Math.min(Math.max(at?.x ?? vw / 2, w / 2), vw - w / 2);
    const cy = Math.min(Math.max(at?.y ?? vh / 2, h2 / 2), vh - h2 / 2);
    const parent = insertParent();
    const a = toParent(parent.el, cx - w / 2, cy - h2 / 2);
    const b = toParent(parent.el, cx + w / 2, cy + h2 / 2);
    const result = await edit({
      action: "insert-video",
      slide: slide.deckIndex,
      file: src.path,
      hash: src.hash,
      parent: parent.loc,
      x: Math.round(Math.min(a.x, b.x)),
      y: Math.round(Math.min(a.y, b.y)),
      width: Math.round(Math.abs(b.x - a.x)),
      height: Math.round(Math.abs(b.y - a.y)),
      src: up.path
    });
    const id = result.ids?.new;
    if (result.ok && id) afterRender.ids = [id];
  }
  async function insertVideo() {
    const file = await pickFile(
      "video/mp4,video/webm,video/ogg,video/quicktime"
    );
    if (file) await insertVideoFile(file);
  }
  async function insertFile(file, at) {
    const zone = at ? mediaZoneAt(at.clientX, at.clientY) : null;
    if (zone) {
      await fillZone(zone, file);
      return;
    }
    if (isVideo(file)) await insertVideoFile(file, at);
    else if (file.type.startsWith("image/")) await insertImageFile(file, at);
    else toast(`Cannot insert ${file.name}`, "error");
  }
  async function insertImageFile(file, at) {
    if (!await ensureOwnDrawing()) return;
    const up = await upload(file);
    const src = ownSource();
    if (!up || !src) return;
    const size = await naturalSize(up.rel);
    const svg = slideRoot();
    const vb = svg?.viewBox.baseVal;
    const maxW = (vb?.width || 1920) * 0.5;
    const maxH = (vb?.height || 1080) * 0.5;
    const k = Math.min(1, maxW / size.w, maxH / size.h);
    const w = size.w * k;
    const h2 = size.h * k;
    const cx = at?.x ?? (vb?.width || 1920) / 2;
    const cy = at?.y ?? (vb?.height || 1080) / 2;
    const parent = insertParent().el;
    const p = toParent(parent, cx - w / 2, cy - h2 / 2);
    const href = relativePath(src.path, up.path);
    await insertXml(
      `<image href="${href}" x="${fmt(p.x)}" y="${fmt(p.y)}" width="${fmt(w)}" height="${fmt(h2)}" preserveAspectRatio="xMidYMid meet"/>`,
      "image"
    );
  }
  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.click();
    });
  }
  async function insertImage() {
    const file = await pickFile("image/*");
    if (file) await insertImageFile(file);
  }
  var MEDIA_ACCEPT = "image/*,video/mp4,video/webm,video/ogg,video/quicktime";
  async function fillZone(zone, file) {
    const slide = currentSlide();
    if (!slide) return;
    const up = await upload(file);
    if (!up) return;
    await edit({
      action: "zone-media",
      slide: slide.deckIndex,
      zone,
      src: up.path,
      fit: slide.zones[zone]?.fit ?? "cover"
    });
  }
  async function zoneMedia(zone) {
    const file = await pickFile(MEDIA_ACCEPT);
    if (file) await fillZone(zone, file);
  }
  function cleanForPaste(el) {
    const copy2 = el.cloneNode(true);
    for (const node of [copy2, ...copy2.querySelectorAll("*")]) {
      for (const attr of [...node.attributes]) {
        const name = attr.name;
        if (name.startsWith("data-")) node.removeAttribute(name);
        else if (name === "xlink:href") {
          node.setAttribute("href", attr.value);
          node.removeAttribute(name);
        } else if (name.includes(":") && !name.startsWith("xml:")) {
          node.removeAttribute(name);
        } else if (name === "class") {
          const kept = attr.value.split(/\s+/).filter((c) => c && !c.startsWith("anim-"));
          if (kept.length) node.setAttribute("class", kept.join(" "));
          else node.removeAttribute("class");
        }
      }
      node.style?.removeProperty?.("visibility");
    }
    return new XMLSerializer().serializeToString(copy2);
  }
  function initInsert() {
    hooks.toolDown = onToolDown;
    hooks.zoneMedia = (zone) => void zoneMedia(zone);
    const canvas2 = document.getElementById("canvas");
    canvas2.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        canvas2.classList.add("drop");
      }
    });
    canvas2.addEventListener("dragleave", () => canvas2.classList.remove("drop"));
    canvas2.addEventListener("drop", (e) => {
      canvas2.classList.remove("drop");
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      void insertFile(file, {
        ...clientToSlide(e.clientX, e.clientY),
        clientX: e.clientX,
        clientY: e.clientY
      });
    });
    document.addEventListener("paste", (e) => {
      const target = e.target;
      if (target.closest("textarea, input")) return;
      const file = [...e.clipboardData?.files ?? []].find(
        (f) => f.type.startsWith("image/") || isVideo(f)
      );
      if (file) {
        e.preventDefault();
        void insertFile(file);
        return;
      }
      e.preventDefault();
      void pasteText(e.clipboardData?.getData("text/plain") ?? "");
    });
  }

  // src/ts/editor/clipboard.ts
  var PREFIX = "inkflow-clipboard:";
  var lastCopied = null;
  async function put(payload) {
    const text = PREFIX + JSON.stringify(payload);
    lastCopied = text;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast("Copied for this tab only: the browser blocked the clipboard");
    }
  }
  function selectedSlides() {
    const picked = [...ed.slideSelection].sort((a, b) => a - b);
    return picked.length ? picked : [ed.current];
  }
  async function copySlides(indices = selectedSlides()) {
    const result = await request({ action: "copy-slides", slides: indices });
    if (!result.ok) {
      toast(result.error ?? "could not copy", "error");
      return false;
    }
    const bundle = result.bundle;
    await put(bundle);
    const dropped = bundle.dropped ?? [];
    const n = indices.length;
    toast(
      `Copied ${n} slide${n > 1 ? "s" : ""}` + (dropped.length ? `; left out ${dropped.join(", ")}` : "")
    );
    return true;
  }
  async function cutSlides() {
    const indices = selectedSlides();
    if (!await copySlides(indices)) return;
    const result = await edit({
      action: "slide",
      op: "delete",
      slides: indices
    });
    if (result.ok) {
      ed.slideSelection.clear();
      ed.current = Math.max(0, Math.min(...indices) - 1);
      emit("slide");
    }
  }
  function imageRefs(xml) {
    const refs = /* @__PURE__ */ new Set();
    for (const m of xml.matchAll(
      /<image\b[^>]*?\b(?:xlink:)?href="([^"]*)"/g
    )) {
      if (!/^(data:|https?:|#|\/)/.test(m[1])) refs.add(m[1]);
    }
    return [...refs];
  }
  async function copyObjects(cut2 = false) {
    const sels = ed.selection.filter((s) => s.el.localName !== "foreignObject");
    if (!sels.length) return false;
    const fragments = sels.map((s) => cleanForPaste(s.el));
    const refs = fragments.flatMap(imageRefs);
    let files = {};
    if (refs.length) {
      const result = await request({ action: "copy-assets", refs });
      files = result.files ?? {};
    }
    await put({
      type: "inkflow-objects",
      version: 1,
      project: ed.model?.projectDir,
      sourceFile: currentSlide()?.sources?.[sels[0].key]?.path ?? "",
      fragments,
      files
    });
    const n = sels.length;
    toast(`${cut2 ? "Cut" : "Copied"} ${n} object${n > 1 ? "s" : ""}`);
    if (cut2) emit("delete");
    return true;
  }
  function copy() {
    if (ed.selection.length) void copyObjects();
    else void copySlides();
  }
  function cut() {
    if (ed.selection.some((s) => canTransform(s.el))) void copyObjects(true);
    else void cutSlides();
  }
  async function pasteSlides(bundle) {
    const after = ed.current;
    const result = await edit({ action: "paste-slides", after, bundle });
    if (!result.ok) return;
    const n = result.pasted;
    toast(`Pasted ${n} slide${n > 1 ? "s" : ""}`, "ok");
    ed.slideSelection.clear();
    afterSlides = after + 1;
  }
  var afterSlides = null;
  function followPastedSlides() {
    if (afterSlides != null && afterSlides < (ed.model?.slides.length ?? 0)) {
      const target = afterSlides;
      afterSlides = null;
      gotoSlide(target);
    }
  }
  async function pasteObjects(bundle) {
    if (!await ensureOwnDrawing()) return;
    const src = ownSource();
    if (!src) return;
    const sameFile = bundle.sourceFile === src.path;
    clearSelection();
    const result = await edit({
      action: "paste-objects",
      file: src.path,
      hash: src.hash,
      parent: insertParent().loc,
      fragments: bundle.fragments,
      files: bundle.files,
      // Copies on the same slide are offset so they do not hide the original.
      offset: sameFile ? [24, 24] : null
    });
    if (result.ok && result.ids) afterRender.ids = Object.values(result.ids);
  }
  async function pasteText(text) {
    const raw = text.startsWith(PREFIX) ? text : lastCopied;
    if (!raw?.startsWith(PREFIX)) return;
    let bundle;
    try {
      bundle = JSON.parse(raw.slice(PREFIX.length));
    } catch {
      toast("The clipboard holds damaged inkflow data", "error");
      return;
    }
    if (bundle.type === "inkflow-slides") await pasteSlides(bundle);
    else if (bundle.type === "inkflow-objects") await pasteObjects(bundle);
  }
  async function pasteFromClipboard() {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = lastCopied ?? "";
    }
    await pasteText(text);
  }

  // src/ts/editor/gallery.ts
  var LABELS = {
    numbered: ["Blank", "Background and slide number"],
    title: ["Title only", "A title; draw the rest"],
    content: ["Title and content", "The everyday text slide"],
    "two-cols": ["Two columns", "Side by side under one title"],
    "three-cols": ["Three columns", "Three short columns"],
    comparison: ["Comparison", "Two headed columns"],
    agenda: ["Agenda", "A numbered outline"],
    quad: ["Four quadrants", "A two-by-two grid"],
    "three-cards": ["Three cards", "An image over text, three times"],
    "media-left": ["Media and text", "Image or video on the left"],
    "media-right": ["Text and media", "Image or video on the right"],
    "title-media": ["Title and media", "One large image or video"],
    "full-media": ["Full-bleed media", "A photo or video edge to edge"],
    cover: ["Cover", "The opening slide"],
    section: ["Section header", "Divides the deck into parts"],
    center: ["Centered", "One centered block"],
    fact: ["Big number", "One number or claim"],
    quote: ["Quote", "A pull quote with attribution"],
    end: ["Closing", "The last slide"]
  };
  var root = document.getElementById("gallery");
  var cache = null;
  function layoutLabel(name) {
    return LABELS[name]?.[0] ?? name;
  }
  async function previews() {
    if (cache) return cache;
    const result = await request({ action: "layout-previews" });
    if (!result.ok) {
      toast(result.error ?? "could not load the layouts", "error");
      return [];
    }
    cache = result.layouts;
    return cache;
  }
  function thumbnail(p) {
    const box = h("div", { class: "gallery-thumb" });
    box.innerHTML = p.svg;
    const svg = box.querySelector("svg");
    if (svg) {
      const vb = parseViewBox(svg.getAttribute("viewBox"));
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.querySelectorAll(".anim-pending").forEach((el) => {
        el.classList.remove("anim-pending");
      });
      for (const z of p.emptyZones) {
        if (z.zone === "slide-number" || z.zone === "slide-total") continue;
        box.append(
          h(
            "div",
            {
              class: "gallery-media",
              style: `left:${z.x / vb.w * 100}%;top:${z.y / vb.h * 100}%;width:${z.width / vb.w * 100}%;height:${z.height / vb.h * 100}%`
            },
            "Image or video"
          )
        );
      }
    }
    return box;
  }
  function lostZones(p) {
    const slide = currentSlide();
    if (!slide) return [];
    const used2 = /* @__PURE__ */ new Set([
      ...Object.keys(slide.zoneOrigins ?? {}),
      ...Object.keys(slide.zones)
    ]);
    return [...used2].filter((z) => !p.zones.includes(z));
  }
  function close() {
    root.classList.remove("open");
    clear(root);
  }
  async function openGallery(opts) {
    if (!ed.model?.deckEditable) {
      toast(
        "deck.py builds its slide list in code; change it there",
        "error"
      );
      return;
    }
    clear(root);
    const grid = h(
      "div",
      { class: "gallery-grid" },
      h("p", { class: "hint" }, "Rendering layouts\u2026")
    );
    const title = opts.mode === "insert" ? "New slide" : "Change layout";
    root.append(
      h(
        "div",
        { class: "gallery-box", role: "dialog", "aria-label": title },
        h(
          "div",
          { class: "gallery-head" },
          h("h2", {}, title),
          h(
            "span",
            { class: "hint" },
            opts.mode === "insert" ? "Every layout, in this deck's theme" : "The slide keeps its content; zones the new layout lacks are not shown"
          ),
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: close,
              title: "Close (Esc)"
            },
            "\xD7"
          )
        ),
        grid
      )
    );
    root.classList.add("open");
    const layouts = await previews();
    clear(grid);
    for (const p of layouts) {
      const [label3, description] = LABELS[p.name] ?? [p.name, ""];
      const lost = opts.mode === "change" ? lostZones(p) : [];
      const current = opts.mode === "change" && p.name === opts.current;
      const card = h(
        "button",
        {
          type: "button",
          class: `gallery-card${current ? " current" : ""}`,
          title: p.name,
          onclick: () => void choose(p, opts, lost)
        },
        thumbnail(p),
        h(
          "div",
          { class: "gallery-label" },
          h("strong", {}, label3),
          p.source === "local" && h("span", { class: "badge" }, "project")
        ),
        description && h("div", { class: "gallery-desc" }, description),
        lost.length > 0 && h(
          "div",
          { class: "gallery-warn" },
          `Hides: ${lost.join(", ")}`
        )
      );
      grid.append(card);
    }
    (grid.querySelector(".current") ?? grid.querySelector("button"))?.scrollIntoView({
      block: "nearest"
    });
    grid.querySelector(".current, button")?.focus();
  }
  async function choose(p, opts, lost) {
    if (opts.mode === "insert") {
      close();
      await newSlide(p.name, opts.after);
      return;
    }
    if (p.name === opts.current) {
      close();
      return;
    }
    if (lost.length && !window.confirm(
      `${layoutLabel(p.name)} has no ${lost.join(", ")} zone; that content stays in your files but is not shown. Switch anyway?`
    )) {
      return;
    }
    close();
    const slide = currentSlide();
    if (!slide) return;
    await edit({
      action: "slide",
      op: "layout",
      slide: slide.deckIndex,
      layout: p.name
    });
  }
  function initGallery() {
    on("model", () => {
      cache = null;
    });
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) close();
    });
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && root.classList.contains("open")) {
          e.stopPropagation();
          close();
        }
      },
      true
    );
  }

  // src/ts/editor/sorter.ts
  var list = document.getElementById("sorter-list");
  var addBtn = document.getElementById("sorter-add");
  var menu = document.getElementById("context-menu");
  var dragFrom = null;
  function pick2(i, e) {
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
  async function deleteSlides() {
    const indices = [...ed.slideSelection].sort((a, b) => a - b);
    if (indices.length <= 1) {
      await deleteSlide(indices[0] ?? ed.current);
      return;
    }
    if (!window.confirm(
      `Delete ${indices.length} slides from the deck? (Their files stay on disk.)`
    )) {
      return;
    }
    const result = await edit({
      action: "slide",
      op: "delete",
      slides: indices
    });
    if (result.ok) {
      ed.slideSelection.clear();
      ed.current = Math.max(0, indices[0] - 1);
      emit("slide");
    }
  }
  function gotoSlide(deckIndex) {
    const n = ed.model?.slides.length ?? 0;
    if (!n) return;
    const i = Math.max(0, Math.min(n - 1, deckIndex));
    if (i === ed.current) return;
    ed.current = i;
    ed.selection = [];
    ed.scope = null;
    emit("slide");
  }
  var thumbs = /* @__PURE__ */ new Map();
  var used = /* @__PURE__ */ new Map();
  function thumb(slide) {
    const box = h("div", { class: "thumb" });
    if (slide.visibleIndex == null) {
      box.append(h("div", { class: "thumb-hidden" }, icon("eyeOff", 18)));
      return box;
    }
    const data = ed.slides[slide.visibleIndex];
    if (!data) return box;
    const cached = thumbs.get(data.svg);
    if (cached && !used.has(data.svg)) {
      used.set(data.svg, cached);
      return cached;
    }
    used.set(data.svg, box);
    box.innerHTML = data.svg;
    const svg = box.querySelector("svg");
    if (svg) {
      const vb = parseViewBox(svg.getAttribute("viewBox"));
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.style.aspectRatio = `${vb.w} / ${vb.h}`;
      svg.querySelectorAll(".anim-pending").forEach((el) => {
        el.classList.remove("anim-pending");
      });
      svg.querySelectorAll("video").forEach((v) => {
        v.removeAttribute("autoplay");
      });
    }
    return box;
  }
  function renderSorter() {
    clear(list);
    used = /* @__PURE__ */ new Map();
    const slides = ed.model?.slides ?? [];
    slides.forEach((slide, i) => {
      const item = h(
        "div",
        {
          class: `sorter-item${i === ed.current ? " active" : ""}${ed.slideSelection.has(i) ? " picked" : ""}${slide.visible ? "" : " hidden-slide"}`,
          draggable: ed.model?.deckEditable ? "true" : null,
          title: slide.title ?? slide.id ?? slide.src,
          "data-index": i
        },
        h("span", { class: "sorter-num" }, String(i + 1)),
        thumb(slide)
      );
      item.addEventListener("click", (e) => pick2(i, e));
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        ed.focus = "sorter";
        if (!ed.slideSelection.has(i)) {
          ed.slideSelection.clear();
          gotoSlide(i);
        }
        openMenu(e.clientX, e.clientY, i);
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
    thumbs = used;
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }
  async function moveSlide(from, to) {
    if (from === to) return;
    const result = await edit({ action: "slide", op: "move", from, to });
    if (result.ok) {
      ed.current = to;
      emit("slide");
    }
  }
  async function newSlide(layout, after = ed.current) {
    const result = await edit({
      action: "slide",
      op: "new",
      after,
      layout,
      name: "slide"
    });
    if (result.ok && result.select != null) pendingSelect = result.select;
  }
  async function duplicateSlide(i = ed.current) {
    const result = await edit({ action: "slide", op: "duplicate", slide: i });
    if (result.ok && result.select != null) pendingSelect = result.select;
  }
  async function deleteSlide(i = ed.current) {
    const slide = ed.model?.slides[i];
    if (!slide) return;
    const name = slide.title ?? slide.id ?? `slide ${i + 1}`;
    if (!window.confirm(
      `Delete \u201C${name}\u201D from the deck? (Its files stay on disk.)`
    )) {
      return;
    }
    const result = await edit({ action: "slide", op: "delete", slide: i });
    if (result.ok) {
      ed.current = Math.max(0, i - 1);
      emit("slide");
    }
  }
  async function toggleHidden(i = ed.current) {
    const slide = ed.model?.slides[i];
    if (!slide) return;
    await edit({
      action: "slide",
      op: "hide",
      slide: i,
      hidden: slide.visible
    });
  }
  var pendingSelect = null;
  function closeMenu() {
    menu.classList.remove("open");
    clear(menu);
  }
  function menuItem(label3, fn, disabled = false) {
    return h(
      "button",
      {
        type: "button",
        class: "menu-item",
        disabled,
        onclick: () => {
          closeMenu();
          fn();
        }
      },
      label3
    );
  }
  function openMenu(x, y, i) {
    const slide = ed.model?.slides[i];
    const editable = !!ed.model?.deckEditable;
    const many = ed.slideSelection.size > 1;
    clear(menu);
    menu.append(
      menuItem(
        many ? `Copy ${ed.slideSelection.size} slides` : "Copy",
        () => void copySlides()
      )
    );
    menu.append(
      menuItem(
        many ? "Cut slides" : "Cut",
        () => void cutSlides(),
        !editable
      )
    );
    menu.append(
      menuItem(
        "Paste after this slide",
        () => void pasteFromClipboard(),
        !editable
      )
    );
    if (many) {
      menu.append(
        menuItem(
          `Delete ${ed.slideSelection.size} slides`,
          () => void deleteSlides(),
          !editable
        )
      );
      showMenu(x, y);
      return;
    }
    menu.append(
      menuItem(
        "New slide after\u2026",
        () => void openGallery({ mode: "insert", after: i }),
        !editable
      )
    );
    menu.append(menuItem("Duplicate", () => void duplicateSlide(i), !editable));
    menu.append(
      menuItem(
        slide?.visible ? "Hide (skip in presentation)" : "Show",
        () => void toggleHidden(i),
        !editable
      )
    );
    menu.append(menuItem("Delete", () => void deleteSlide(i), !editable));
    showMenu(x, y);
  }
  function showMenu(x, y) {
    menu.classList.add("open");
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  }
  function initSorter() {
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
          "error"
        );
        return;
      }
      void openGallery({ mode: "insert", after: ed.current });
    });
    document.addEventListener("pointerdown", (e) => {
      if (!menu.contains(e.target)) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMenu();
    });
  }

  // src/ts/editor/context.ts
  var timer = 0;
  function snapshot2() {
    const slide = currentSlide();
    const visible = ed.model?.slides.filter((s) => s.visible).length ?? 0;
    return {
      deck: ed.model?.deckPath,
      slide: slide && {
        number: (slide.visibleIndex ?? -1) + 1 || null,
        total: visible,
        deckIndex: slide.deckIndex,
        id: slide.id ?? slide.explicitId,
        title: slide.title,
        svg: slide.srcRel,
        sharedLayout: slide.srcShared,
        md: slide.md?.rel ?? (slide.md ? "inline in deck.py" : null),
        notes: slide.notes.rel
      },
      step: ed.step,
      layoutMode: ed.layoutMode,
      selection: ed.selection.map((s) => {
        const box = slideBox(s.el);
        const text = (s.el.textContent ?? "").replace(/\s+/g, " ").trim();
        return {
          id: s.el.getAttribute("id"),
          tag: s.el.localName,
          zone: isZone(s.el) ? zoneName(s.el) : null,
          file: sourceOf(s.key)?.rel,
          locator: s.loc,
          box: box && {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height)
          },
          text: text.slice(0, 200) || null
        };
      })
    };
  }
  function report() {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      sendRaw({ type: "editor-context", context: snapshot2() });
    }, 250);
  }
  function initContext() {
    on("selection", report);
    on("slide", report);
    on("model", report);
    on("step", report);
    onCommand((msg) => {
      if (msg.command === "goto") {
        const n = Number(msg.slide);
        const slides = ed.model?.slides ?? [];
        const target = slides.find((s) => s.visibleIndex === n - 1);
        if (target) gotoSlide(target.deckIndex);
      } else if (msg.command === "select") {
        const ids = msg.ids ?? [];
        const svg = slideRoot();
        if (!svg) return;
        const els = ids.map((id) => svg.querySelector(`[id="${CSS.escape(id)}"]`)).filter(
          (el) => el instanceof SVGGraphicsElement
        );
        enterGroup(null);
        select(els);
        emit("flash");
      }
    });
  }

  // src/ts/editor/crop.ts
  function pictureOf(el) {
    if (el.localName === "image") return el;
    if (el.localName !== "svg" || !el.getAttribute("viewBox")) return null;
    const images = [...el.children].filter((c) => c.localName === "image");
    return images.length === 1 ? images[0] : null;
  }
  function isCropped(el) {
    return el.localName === "svg" && pictureOf(el) !== null;
  }
  function setCropMode(on2) {
    if (ed.cropMode === on2) return;
    ed.cropMode = on2;
    document.body.classList.toggle("crop-mode", on2);
    drawOverlay();
    emit("crop");
  }
  async function startCrop(sel) {
    if (isCropped(sel.el)) {
      setCropMode(true);
      return;
    }
    if (sel.el.localName !== "image") return;
    const src = sourceOf(sel.key);
    const slide = currentSlide();
    if (!src?.writable || !slide) return;
    const result = await edit({
      action: "svg",
      file: src.path,
      hash: src.hash,
      ops: [
        { kind: "ensure-id", loc: sel.loc, base: "image", key: "img" },
        { kind: "crop-frame", loc: sel.loc }
      ],
      label: "Crop"
    });
    const id = result.ids?.img;
    if (!result.ok || !id) return;
    afterRender.ids = [id];
    ed.cropMode = true;
    document.body.classList.add("crop-mode");
    toast("Drag the handles to crop; Enter or Esc when done");
  }
  async function resetCrop(sel) {
    if (!isCropped(sel.el)) return;
    setCropMode(false);
    await sendSvgOps(
      [{ sel, ops: [{ kind: "uncrop", loc: sel.loc }] }],
      "Reset crop"
    );
  }

  // src/ts/editor/dialog.ts
  var host2 = document.getElementById("dialog");
  var onClose = null;
  function openDialog(title, body2, opts = {}) {
    closeDialog();
    onClose = opts.onClose ?? null;
    const box = h(
      "div",
      { class: `dialog-box${opts.wide ? " wide" : ""}`, role: "dialog" },
      h(
        "div",
        { class: "dialog-head" },
        h("h2", {}, title),
        opts.hint ? h("span", { class: "hint" }, opts.hint) : null,
        h(
          "button",
          {
            type: "button",
            class: "dialog-close",
            title: "Close (Esc)",
            onclick: () => closeDialog()
          },
          "\xD7"
        )
      ),
      h("div", { class: "dialog-body" }, body2)
    );
    host2.append(box);
    host2.classList.add("open");
    return box;
  }
  function closeDialog() {
    if (!host2.classList.contains("open")) return;
    host2.classList.remove("open");
    clear(host2);
    const fn = onClose;
    onClose = null;
    fn?.();
  }
  function dialogOpen() {
    return host2.classList.contains("open");
  }
  function initDialog() {
    host2.addEventListener("pointerdown", (e) => {
      if (e.target === host2) closeDialog();
    });
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && dialogOpen()) {
          e.preventDefault();
          e.stopPropagation();
          closeDialog();
        }
      },
      true
    );
    host2.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
    });
  }

  // src/ts/editor/notes.ts
  var area = document.getElementById("notes-input");
  var label = document.getElementById("notes-file");
  var timer2 = 0;
  var slideIndex = -1;
  var sent = "";
  var burst = "";
  async function save() {
    window.clearTimeout(timer2);
    const slide = ed.model?.slides[slideIndex];
    if (!slide || area.value === sent) return;
    const before = sent;
    sent = area.value;
    const result = await edit(
      {
        action: "notes",
        slide: slide.deckIndex,
        text: area.value,
        name: slide.id ?? "slide",
        coalesce: burst
      },
      { retrying: true }
    );
    if (!result.ok) {
      sent = before;
      timer2 = window.setTimeout(() => void save(), 800);
    }
  }
  function load() {
    const slide = currentSlide();
    if (!slide) return;
    if (document.activeElement === area && slideIndex === slide.deckIndex)
      return;
    slideIndex = slide.deckIndex;
    area.value = slide.notes.text;
    sent = area.value;
    label.textContent = slide.notes.kind === "file" ? slide.notes.rel ?? "" : slide.notes.kind === "inline" ? "inline in deck.py" : "new notes file on first edit";
  }
  function initNotes() {
    area.addEventListener("focus", () => {
      burst = `notes-${Date.now()}`;
    });
    area.addEventListener("input", () => {
      window.clearTimeout(timer2);
      timer2 = window.setTimeout(() => void save(), 600);
    });
    area.addEventListener("blur", () => void save());
    area.addEventListener("keydown", (e) => e.stopPropagation());
    on("slide", () => {
      void save().then(load);
    });
    on("model", load);
  }

  // src/ts/editor/objects.ts
  var host3 = document.getElementById("objects");
  var body = document.getElementById("props-body");
  var tabs = document.getElementById("panel-tabs");
  var NAMES = {
    g: "Group",
    rect: "Rectangle",
    circle: "Circle",
    ellipse: "Ellipse",
    line: "Line",
    polyline: "Polyline",
    polygon: "Polygon",
    path: "Path",
    text: "Text",
    image: "Image",
    svg: "Image",
    use: "Clone",
    foreignObject: "Content",
    a: "Link"
  };
  var collapsed = /* @__PURE__ */ new Set();
  function label2(el) {
    if (isZone(el)) return `Zone \xB7 ${zoneName(el)}`;
    const id = el.getAttribute("id");
    const kind = el.hasAttribute("data-ink-layer") ? "Layer" : NAMES[el.localName] ?? el.localName;
    if (el.localName === "text") {
      const t = (el.textContent ?? "").trim().replace(/\s+/g, " ");
      return id ? `${id} \xB7 \u201C${t.slice(0, 24)}\u201D` : `\u201C${t.slice(0, 32)}\u201D`;
    }
    return id ?? kind;
  }
  function isHidden(el) {
    return el.style?.display === "none" || el.getAttribute("display") === "none";
  }
  function children(el) {
    return [...el.children].filter(
      (c) => c.hasAttribute("data-ink") && !["title", "desc", "defs", "style", "metadata"].includes(
        c.localName
      ) && // A cropped picture's own <image> is part of the picture.
      el.localName !== "svg"
    );
  }
  function selFor(el) {
    return {
      el,
      key: keyOf(el),
      loc: el.getAttribute("data-ink") ?? ""
    };
  }
  async function toggleHidden2(el) {
    await sendSvgOps(
      [
        {
          sel: selFor(el),
          ops: [
            {
              kind: "style",
              loc: el.getAttribute("data-ink") ?? "",
              set: { display: isHidden(el) ? null : "none" }
            }
          ]
        }
      ],
      isHidden(el) ? "Show" : "Hide"
    );
  }
  async function toggleLocked(el) {
    const own = el.hasAttribute("data-ink-locked");
    if (!own && isLocked(el)) {
      toast("It is inside a locked layer or group: unlock that instead");
      return;
    }
    await sendSvgOps(
      [
        {
          sel: selFor(el),
          ops: [
            {
              kind: "lock",
              loc: el.getAttribute("data-ink") ?? "",
              locked: !own
            }
          ]
        }
      ],
      own ? "Unlock" : "Lock"
    );
  }
  function rename(el, nameEl) {
    const src = sourceOf(keyOf(el));
    if (!src?.writable || isZone(el)) return;
    const id = el.getAttribute("id") ?? "";
    const input = h("input", { type: "text", class: "obj-rename", value: id });
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save3) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save3 && v && v !== id) {
        void edit({
          action: "svg",
          file: src.path,
          hash: src.hash,
          ops: [
            {
              kind: "id",
              loc: el.getAttribute("data-ink"),
              id: v,
              from: id || void 0
            }
          ],
          label: "Rename"
        });
      }
      renderObjects();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }
  function pickFromList(el) {
    if (isLocked(el)) {
      toast("Locked: unlock it to select it");
      return;
    }
    const parent = el.parentElement;
    if (parent && !el.hasAttribute("data-ink-top") && parent.localName === "g" && !parent.hasAttribute("data-ink-layer")) {
      enterGroup(parent);
    } else if (ed.scope && !ed.scope.contains(el)) {
      enterGroup(null);
    }
    if (!selectable(el)) {
      toast(
        ed.layoutMode ? "This object cannot be edited here" : "From a layout or overlay: use Edit layout to change it"
      );
      return;
    }
    select([el]);
  }
  function row(el, depth) {
    const loc = el.getAttribute("data-ink") ?? "";
    const src = sourceOf(keyOf(el));
    const writable = !!src?.writable && (canTransform(el) || ed.layoutMode || isOwnObject(el));
    const kids = children(el);
    const group = kids.length > 0;
    const open = group && !collapsed.has(loc);
    const selected = ed.selection.some((s) => s.el === el);
    const locked = el.hasAttribute("data-ink-locked");
    const hidden = isHidden(el);
    const name = h("span", { class: "obj-name" }, label2(el));
    const out = [];
    const item = h(
      "div",
      {
        class: `obj-row${selected ? " on" : ""}${writable ? "" : " foreign"}${hidden ? " hidden-obj" : ""}`,
        title: src ? `${label2(el)} \xB7 ${src.rel}` : label2(el),
        style: `padding-left:${8 + depth * 14}px`
      },
      h(
        "button",
        {
          type: "button",
          class: `obj-twisty${group ? "" : " none"}`,
          title: open ? "Collapse" : "Expand",
          onclick: (e) => {
            e.stopPropagation();
            if (collapsed.has(loc)) collapsed.delete(loc);
            else collapsed.add(loc);
            renderObjects();
          }
        },
        group ? open ? "\u25BE" : "\u25B8" : ""
      ),
      name,
      writable ? h(
        "button",
        {
          type: "button",
          class: `obj-toggle${hidden ? " on" : ""}`,
          title: hidden ? "Hidden: click to show" : "Hide (on the slide and in the presentation)",
          onclick: (e) => {
            e.stopPropagation();
            void toggleHidden2(el);
          }
        },
        icon(hidden ? "eyeOff" : "eye", 14)
      ) : null,
      writable ? h(
        "button",
        {
          type: "button",
          class: `obj-toggle${locked ? " on" : ""}`,
          title: locked ? "Locked: click to unlock" : "Lock (cannot be selected on the slide)",
          onclick: (e) => {
            e.stopPropagation();
            void toggleLocked(el);
          }
        },
        icon(locked ? "lock" : "unlock", 14)
      ) : h("span", { class: "obj-badge" }, src?.role ?? "")
    );
    item.addEventListener("click", () => pickFromList(el));
    item.addEventListener("dblclick", () => rename(el, name));
    item.addEventListener("mouseenter", () => setHover(el));
    item.addEventListener("mouseleave", () => setHover(null));
    out.push(item);
    if (open) {
      for (const k of [...kids].reverse()) out.push(...row(k, depth + 1));
    }
    return out;
  }
  function isOwnObject(el) {
    const src = sourceOf(keyOf(el));
    return !!src && src.role === "slide" && src.writable;
  }
  function renderObjects() {
    if (host3.hidden) return;
    clear(host3);
    const svg = slideRoot();
    if (!svg) return;
    const top = [...svg.querySelectorAll("[data-ink-top], [data-ink-layer]")].filter((el) => {
      const parent = el.parentElement?.closest(
        "[data-ink-top], [data-ink-layer]"
      );
      return !parent || !svg.contains(parent);
    }).reverse();
    if (!top.length) {
      host3.append(h("p", { class: "hint" }, "No objects on this slide."));
      return;
    }
    host3.append(
      h(
        "p",
        { class: "hint" },
        "Top of the stack first. Middle-click (or Alt+click) on the slide steps through overlapping objects."
      )
    );
    for (const el of top) host3.append(...row(el, 0));
  }
  function showTab(tab) {
    for (const b of tabs.querySelectorAll("[data-tab]")) {
      b.classList.toggle("on", b.dataset.tab === tab);
      b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    }
    host3.hidden = tab !== "objects";
    body.hidden = tab === "objects";
    try {
      localStorage.setItem("inkflow-editor-tab", tab);
    } catch {
    }
    renderObjects();
  }
  function initObjects() {
    tabs.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-tab]")?.dataset.tab;
      if (tab) showTab(tab);
    });
    let saved = "props";
    try {
      saved = localStorage.getItem("inkflow-editor-tab") ?? "props";
    } catch {
    }
    showTab(saved === "objects" ? "objects" : "props");
    on("render", renderObjects);
    on("selection", renderObjects);
  }

  // src/ts/editor/props.ts
  var panel = document.getElementById("props-body");
  function section(title, ...body2) {
    return h(
      "section",
      { class: "props-section" },
      h("h3", {}, title),
      ...body2.filter((b) => !!b)
    );
  }
  function row2(label3, ...controls) {
    return h(
      "label",
      { class: "prop-row" },
      h("span", { class: "prop-label" }, label3),
      ...controls
    );
  }
  function numberInput(value, commit, opts = {}) {
    const input = h("input", {
      type: "number",
      class: "num",
      step: opts.step ?? 1,
      min: opts.min ?? null,
      placeholder: opts.placeholder ?? "",
      value: value == null ? "" : String(Math.round(value * 100) / 100)
    });
    const fire = () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) commit(v);
      else if (input.value.trim() === "") opts.onClear?.();
    };
    input.addEventListener("change", fire);
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") input.blur();
    });
    return input;
  }
  function textInput(value, commit, placeholder = "") {
    const input = h("input", { type: "text", value, placeholder });
    input.addEventListener("change", () => commit(input.value));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") input.blur();
    });
    return input;
  }
  function selectInput(options, value, commit) {
    const sel = h("select", {});
    for (const o of options) {
      const opt = h("option", { value: o.value }, o.label);
      if (o.value === value) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener("change", () => commit(sel.value));
    return sel;
  }
  function button(label3, title, fn, cls = "") {
    return h(
      "button",
      { type: "button", class: `pbtn ${cls}`, title, onclick: fn },
      label3
    );
  }
  function fieldControl(f, value, commit) {
    switch (f.kind) {
      case "trigger": {
        const labels = {
          "on-click": "On click",
          "with-previous": "With previous",
          "after-previous": "After previous"
        };
        const v = String(value ?? f.default ?? "on-click");
        const opts = f.choices.map((c) => ({
          value: c,
          label: labels[c] ?? c
        }));
        if (!f.choices.includes(v))
          opts.push({ value: v, label: `At step ${v}` });
        return selectInput(opts, v, commit);
      }
      case "enum":
      case "easing": {
        const v = String(value ?? f.default ?? "");
        const opts = f.choices.map((c) => ({ value: c, label: c }));
        if (v && !f.choices.includes(v)) opts.push({ value: v, label: v });
        return selectInput(opts, v, commit);
      }
      case "bool": {
        const cb = h("input", { type: "checkbox" });
        cb.checked = Boolean(value);
        cb.addEventListener("change", () => commit(cb.checked));
        return cb;
      }
      case "int":
      case "float":
        return numberInput(
          typeof value === "number" ? value : null,
          (v) => commit(f.kind === "int" ? Math.round(v) : v),
          {
            step: f.kind === "int" ? 1 : 0.05,
            placeholder: f.optional ? "none" : "",
            onClear: f.optional ? () => commit(null) : void 0
          }
        );
      default:
        return textInput(value == null ? "" : String(value), commit);
    }
  }
  function fieldsEditor(schema, values, commit) {
    const box = h("div", { class: "fields" });
    for (const f of schema) {
      const label3 = f.name.replace(/_/g, " ");
      box.append(
        row2(
          label3,
          fieldControl(
            f,
            values[f.name] ?? f.default,
            (v) => commit({ ...values, [f.name]: v })
          )
        )
      );
    }
    return box;
  }
  var MEDIA_LABELS = {
    fit: "Fit",
    align: "Anchor",
    controls: "Controls",
    autoplay: "Autoplay",
    muted: "Mute",
    loop: "Loop",
    poster: "Poster",
    start: "Trim start",
    end: "Trim end"
  };
  function mediaSection(slide, zone, media) {
    const kind = media.kind === "video" ? "video" : "image";
    const schema = ed.model?.mediaTypes?.[kind] ?? [];
    const values = media.fields ?? {};
    const commit = (name, v) => void edit({
      action: "media-props",
      slide: slide.deckIndex,
      zone,
      fields: { [name]: v }
    });
    const rows = [];
    for (const f of schema) {
      const label3 = MEDIA_LABELS[f.name] ?? f.name.replace(/_/g, " ");
      if (f.name === "poster") {
        const poster = values.poster;
        rows.push(
          h(
            "div",
            { class: "prop-row" },
            h("span", { class: "prop-label" }, label3),
            h(
              "span",
              { class: "media-poster" },
              poster ? String(poster).split("/").pop() : "None"
            ),
            button(
              poster ? "Change\u2026" : "Pick\u2026",
              poster ? `Poster: ${poster}` : "Still image shown before playback",
              async () => {
                const file = await pickFile("image/*");
                const up = file ? await upload(file) : null;
                if (up) commit("poster", up.path);
              }
            ),
            poster ? button(
              "\u2715",
              "Remove the poster",
              () => commit("poster", null)
            ) : null
          )
        );
        continue;
      }
      if (f.name === "muted") {
        const opts = [
          { value: "auto", label: "When autoplaying" },
          { value: "on", label: "Always" },
          { value: "off", label: "Never" }
        ];
        rows.push(
          row2(
            label3,
            selectInput(
              opts,
              String(values.muted ?? "auto"),
              (v) => commit("muted", v)
            )
          )
        );
        continue;
      }
      if (f.name === "start" || f.name === "end") {
        const v = values[f.name];
        rows.push(
          row2(
            label3,
            numberInput(
              typeof v === "number" ? v : null,
              (n) => commit(f.name, n),
              {
                step: 0.1,
                min: 0,
                placeholder: "seconds",
                onClear: () => commit(f.name, null)
              }
            )
          )
        );
        continue;
      }
      rows.push(
        row2(
          label3,
          fieldControl(
            f,
            values[f.name] ?? f.default,
            (v) => commit(f.name, v)
          )
        )
      );
    }
    if (kind === "video") {
      rows.push(
        h(
          "p",
          { class: "hint" },
          "To start it on a click instead, add a Play video animation below."
        )
      );
    }
    return section(kind === "video" ? "Video" : "Image", ...rows);
  }
  function typeInfo(list2, type) {
    return list2.find((t) => t.type === type) ?? null;
  }
  function renderSlidePanel() {
    const slide = currentSlide();
    const model = ed.model;
    if (!slide || !model) return;
    const editable = model.deckEditable;
    const di = slide.deckIndex;
    const root2 = slideRoot();
    const parent = root2?.getAttribute("inkflow:parent") ?? null;
    const currentLayout = slide.srcShared ? slide.src.replace(/\.svg$/, "") : parent;
    panel.append(
      section(
        "Slide",
        row2(
          "Title",
          textInput(slide.title ?? "", (v) => {
            void edit({
              action: "slide",
              op: "title",
              slide: di,
              title: v
            });
          })
        ),
        row2(
          "Layout",
          button(
            `${currentLayout ? layoutLabel(currentLayout) : "None"} \u25BE`,
            "Pick a layout from previews",
            () => void openGallery({
              mode: "change",
              current: currentLayout
            }),
            "wide"
          )
        ),
        row2(
          "Font size",
          numberInput(
            slide.fontSize,
            (v) => void edit({
              action: "slide",
              op: "font-size",
              slide: di,
              size: v
            }),
            { placeholder: "deck default" }
          )
        ),
        row2(
          "Hidden",
          (() => {
            const cb = h("input", { type: "checkbox" });
            cb.checked = !slide.visible;
            cb.disabled = !editable;
            cb.addEventListener("change", () => {
              void edit({
                action: "slide",
                op: "hide",
                slide: di,
                hidden: cb.checked
              });
            });
            return cb;
          })()
        ),
        !editable && h(
          "p",
          { class: "hint" },
          "deck.py builds its slide list in code, so slide-level settings are read-only here."
        )
      )
    );
    panel.append(transitionSection(slide.transition, di));
    panel.append(animationList(slide.animations, slide.animationsEditable, di));
    const files = h("div", { class: "files" });
    const addFile = (label3, rel) => {
      if (rel)
        files.append(
          h(
            "div",
            { class: "file" },
            h("span", {}, label3),
            h("code", {}, rel)
          )
        );
    };
    addFile("Drawing", slide.srcShared ? null : slide.srcRel);
    addFile("Layout", slide.srcShared ? slide.srcRel : null);
    addFile("Markdown", slide.md?.rel);
    addFile("Notes", slide.notes.rel);
    panel.append(section("Files", files));
    if (slide.srcShared) {
      panel.append(
        h(
          "p",
          { class: "hint" },
          "This slide is drawn by a shared layout. Draw on it (or insert anything) and it gets its own SVG built on that layout. Use \u201CEdit layout\u201D to change the layout itself."
        )
      );
    }
  }
  function transitionSection(current, di) {
    const model = ed.model;
    const types = model.transitionTypes;
    const value = current?.type ?? "";
    const opts = [
      { value: "", label: `Deck default (${model.defaultTransition.type})` },
      ...types.map((t) => ({ value: t.type, label: t.type }))
    ];
    const send = (spec) => void edit({ action: "slide", op: "transition", slide: di, spec });
    const body2 = [
      row2(
        "Type",
        selectInput(opts, value, (v) => {
          if (!v) send(null);
          else send({ type: v, fields: {} });
        })
      )
    ];
    if (current) {
      const info2 = typeInfo(types, current.type);
      if (info2) {
        body2.push(
          fieldsEditor(
            info2.fields,
            current.fields,
            (fields) => send({ type: current.type, fields })
          )
        );
      }
    }
    return section("Transition into this slide", ...body2);
  }
  function triggerLabel(t) {
    if (t === "with-previous") return "with previous";
    if (t === "after-previous") return "after previous";
    if (t === "on-click" || t == null) return "on click";
    return `step ${t}`;
  }
  function animationList(cues, editable, di) {
    const list2 = h("div", { class: "anim-list" });
    if (!cues.length)
      list2.append(h("p", { class: "hint" }, "No animations on this slide."));
    cues.forEach((cue, i) => {
      const item = h(
        "div",
        { class: "anim-item" },
        h("span", { class: `anim-kind k-${cue.kind}` }),
        h(
          "button",
          {
            type: "button",
            class: "anim-target",
            title: "Select this element",
            onclick: () => selectById(cue.element)
          },
          `#${cue.element}`
        ),
        h("span", { class: "anim-type" }, cue.type),
        h(
          "span",
          { class: "anim-trigger" },
          triggerLabel(cue.fields.trigger ?? null)
        ),
        editable && button(icon("up", 12), "Earlier", () => {
          if (i > 0)
            void edit({
              action: "anim",
              slide: di,
              op: "move",
              index: i,
              to: i - 1
            });
        }),
        editable && button(icon("down", 12), "Later", () => {
          if (i < cues.length - 1) {
            void edit({
              action: "anim",
              slide: di,
              op: "move",
              index: i,
              to: i + 1
            });
          }
        }),
        editable && button(icon("trash", 12), "Remove", () => {
          void edit({
            action: "anim",
            slide: di,
            op: "remove",
            index: i
          });
        })
      );
      list2.append(item);
    });
    if (!editable && cues.length) {
      list2.append(
        h(
          "p",
          { class: "hint" },
          "Animations are built in code in deck.py; read-only."
        )
      );
    }
    return section("Animation order", list2);
  }
  function selectById(id) {
    const svg = slideRoot();
    const el = svg?.querySelector(`[id="${CSS.escape(id)}"]`);
    if (el) {
      enterGroup(null);
      select([el]);
    } else toast(`#${id} is not on this slide`, "error");
  }
  function elementAnimations(sel) {
    const slide = currentSlide();
    const model = ed.model;
    const id = sel.el.getAttribute("id");
    const di = slide.deckIndex;
    const editable = slide.animationsEditable && model.deckEditable;
    const body2 = h("div", { class: "anim-list" });
    const elementName = isZone(sel.el) ? zoneName(sel.el) : id;
    slide.animations.forEach((cue, index) => {
      if (!elementName || cue.element !== (cue.kind === "video" ? zoneName(sel.el) : id))
        return;
      const info2 = typeInfo(model.animationTypes, cue.type);
      const send = (type, fields) => void edit({
        action: "anim",
        slide: di,
        op: "replace",
        index,
        spec: { type, element: cue.element, fields }
      });
      const header = h(
        "div",
        { class: "anim-head" },
        h("span", { class: `anim-kind k-${cue.kind}` }),
        editable ? selectInput(
          model.animationTypes.map((t) => ({
            value: t.type,
            label: t.type
          })),
          cue.type,
          (v) => send(v, {
            trigger: cue.fields.trigger ?? "on-click"
          })
        ) : h("span", {}, cue.type),
        editable && button(icon("trash", 12), "Remove", () => {
          void edit({
            action: "anim",
            slide: di,
            op: "remove",
            index
          });
        })
      );
      body2.append(
        h(
          "div",
          { class: "anim-card" },
          header,
          info2 && editable ? fieldsEditor(
            info2.fields,
            cue.fields,
            (f) => send(cue.type, f)
          ) : null
        )
      );
    });
    if (editable) {
      const groups = {};
      for (const t of model.animationTypes) {
        if (t.kind === "video" && !isZone(sel.el)) continue;
        const kind = t.kind ?? "other";
        groups[kind] = [...groups[kind] ?? [], t];
      }
      const add = h("select", { class: "add-anim" });
      add.append(h("option", { value: "" }, "+ Add animation\u2026"));
      for (const [kind, types] of Object.entries(groups)) {
        const og = h("optgroup", { label: kind });
        for (const t of types)
          og.append(h("option", { value: t.type }, t.type));
        add.append(og);
      }
      add.addEventListener("change", () => {
        const type = add.value;
        if (!type) return;
        const video = typeInfo(model.animationTypes, type)?.kind === "video";
        const element = video ? zoneName(sel.el) : id;
        const src = sourceOf(sel.key);
        void edit({
          action: "anim",
          slide: di,
          op: "insert",
          index: slide.animations.length,
          spec: { type, element: element ?? "", fields: {} },
          target: element || !src ? void 0 : {
            file: src.path,
            loc: sel.loc,
            base: sel.el.localName
          }
        });
      });
      body2.append(add);
    } else if (!slide.animationsEditable) {
      body2.append(
        h(
          "p",
          { class: "hint" },
          "This slide's animations are built in code."
        )
      );
    }
    return section("Animations", body2);
  }
  var TAG_NAMES = {
    g: "Group",
    rect: "Rectangle",
    circle: "Circle",
    ellipse: "Ellipse",
    line: "Line",
    polyline: "Polyline",
    polygon: "Polygon",
    path: "Path",
    text: "Text",
    image: "Image",
    svg: "Image (cropped)",
    use: "Clone",
    foreignObject: "Embedded content"
  };
  function tokenOf(el, prop) {
    for (const c of el.classList) {
      const m = c.match(/^inkflow-(fill|stroke)-(.+)$/);
      if (m && m[1] === prop) return m[2];
    }
    return null;
  }
  function rgbToHex(rgb) {
    const m = rgb.match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return "#000000";
    return `#${m.slice(0, 3).map((v) => Math.round(Number(v)).toString(16).padStart(2, "0")).join("")}`;
  }
  function paintRow(sel, prop) {
    const first = sel[0].el;
    const token = tokenOf(first, prop);
    const computed = getComputedStyle(first)[prop];
    const send = (paint) => {
      const plans = sel.map((s) => ({
        sel: s,
        ops: [{ kind: "paint", loc: s.loc, prop, ...paint }]
      }));
      void sendSvgOps(plans, prop === "fill" ? "Fill" : "Stroke");
    };
    const swatches = h("div", { class: "swatches" });
    for (const t of ed.model?.colorTokens ?? []) {
      swatches.append(
        h("button", {
          type: "button",
          class: `swatch${t === token ? " active" : ""}`,
          title: t,
          style: `background: var(--inkflow-${t})`,
          onclick: () => send({ token: t })
        })
      );
    }
    const custom = h("input", {
      type: "color",
      value: computed && computed !== "none" ? rgbToHex(computed) : "#000000",
      title: "Custom colour"
    });
    custom.addEventListener("change", () => send({ color: custom.value }));
    swatches.append(custom);
    swatches.append(
      button("\u2205", "None", () => send({ color: "none" }), "none-btn")
    );
    return row2(prop === "fill" ? "Fill" : "Stroke", swatches);
  }
  function styleOps(sel, set, label3) {
    void sendSvgOps(
      sel.map((s) => ({ sel: s, ops: [{ kind: "style", loc: s.loc, set }] })),
      label3
    );
  }
  function renderObjectPanel(sel) {
    const el = sel.el;
    const src = sourceOf(sel.key);
    const zone = isZone(el);
    const movable = canTransform(el);
    const id = el.getAttribute("id") ?? "";
    const tag = zone ? `Zone \xB7 ${zoneName(el)}` : TAG_NAMES[el.localName] ?? el.localName;
    panel.append(
      section(
        tag,
        row2(
          "Id",
          zone ? h("code", {}, id) : textInput(
            id,
            (v) => {
              if (!src || !v || v === id) return;
              void edit({
                action: "svg",
                file: src.path,
                hash: src.hash,
                ops: [
                  {
                    kind: "id",
                    loc: sel.loc,
                    id: v,
                    from: id
                  }
                ],
                label: "Rename"
              });
            },
            "no id"
          )
        ),
        src && h(
          "p",
          { class: "hint" },
          `In ${src.rel}${src.role !== "slide" || currentSlide()?.srcShared ? ` \xB7 shared by ${src.usedBy.length} slide${src.usedBy.length === 1 ? "" : "s"}` : ""}`
        )
      )
    );
    if (zone) {
      const slide = currentSlide();
      const name = zoneName(el);
      const origin = slide.zoneOrigins?.[name];
      const media = slide.zones[name];
      const where = origin === "deck" ? "deck.py zones=" : origin === "md-file" ? `${slide.md?.rel ?? "Markdown"} (whole file)` : slide.md?.rel ? `${slide.md.rel} \xB7 ::${name}::` : "deck.py";
      const body2 = [
        h("p", { class: "hint" }, `Content from ${where}`)
      ];
      if (media && (media.kind === "image" || media.kind === "video")) {
        body2.push(
          h("p", { class: "hint media-src" }, media.src ?? ""),
          button(
            "Replace media\u2026",
            "Pick another image or video",
            () => void zoneMedia(name)
          ),
          button("Clear", "Empty this zone", () => {
            void edit({
              action: "zone-media",
              slide: slide.deckIndex,
              zone: name,
              src: null
            });
          })
        );
      } else {
        body2.push(
          button(
            "Edit text",
            "Edit this zone's Markdown (double-click)",
            () => {
              emit("edit-zone");
            }
          )
        );
      }
      panel.append(section("Content", ...body2));
      if (media && (media.kind === "image" || media.kind === "video")) {
        panel.append(mediaSection(slide, name, media));
      }
    }
    if (movable) panel.append(geometrySection([sel]));
    if (!zone && src?.writable && (movable || ed.layoutMode)) {
      const fills = ![
        "line",
        "polyline",
        "image",
        "foreignObject",
        "g"
      ].includes(el.localName);
      const strokeWidth = parseFloat(getComputedStyle(el).strokeWidth) || 0;
      const opacity = parseFloat(getComputedStyle(el).opacity);
      panel.append(
        section(
          "Style",
          fills && !pictureOf(el) && paintRow([sel], "fill"),
          !pictureOf(el) && el.localName !== "g" && paintRow([sel], "stroke"),
          !pictureOf(el) && el.localName !== "g" && row2(
            "Stroke width",
            numberInput(
              strokeWidth,
              (v) => styleOps(
                [sel],
                { "stroke-width": String(v) },
                "Stroke width"
              )
            )
          ),
          row2(
            "Opacity",
            (() => {
              const r = h("input", {
                type: "range",
                min: 0,
                max: 1,
                step: 0.05,
                value: String(
                  Number.isFinite(opacity) ? opacity : 1
                )
              });
              r.addEventListener(
                "change",
                () => styleOps(
                  [sel],
                  { opacity: r.value === "1" ? null : r.value },
                  "Opacity"
                )
              );
              return r;
            })()
          ),
          el.localName === "rect" && row2(
            "Corner radius",
            numberInput(
              parseFloat(el.getAttribute("rx") ?? "0") || 0,
              (v) => {
                void sendSvgOps(
                  [
                    {
                      sel,
                      ops: [
                        {
                          kind: "attrs",
                          loc: sel.loc,
                          set: {
                            rx: String(v),
                            ry: null
                          }
                        }
                      ]
                    }
                  ],
                  "Corner radius"
                );
              }
            )
          )
        )
      );
      if (el.localName === "text") panel.append(textSection(sel));
    }
    if (!zone && src?.writable && pictureOf(el)) {
      panel.append(pictureSection(sel));
    }
    if (!zone && src?.writable && (movable || ed.layoutMode)) {
      panel.append(detailsSection(sel));
    }
    if (movable) panel.append(arrangeSection([sel]));
    if (id || zone || src?.writable) panel.append(elementAnimations(sel));
  }
  var FITS = [
    { value: "contain", label: "Fit inside", par: "xMidYMid meet" },
    { value: "cover", label: "Fill (crop edges)", par: "xMidYMid slice" },
    { value: "stretch", label: "Stretch", par: "none" }
  ];
  function pictureSection(sel) {
    const image = pictureOf(sel.el);
    const loc = image.getAttribute("data-ink") ?? sel.loc;
    const src = sourceOf(sel.key);
    const href = image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "";
    const par = image.getAttribute("preserveAspectRatio") ?? "xMidYMid meet";
    const fit = FITS.find((f) => f.par === par)?.value ?? "contain";
    const imageOps = (set, label3) => void sendSvgOps([{ sel, ops: [{ kind: "attrs", loc, set }] }], label3);
    const cropped = isCropped(sel.el);
    return section(
      "Picture",
      h("p", { class: "hint media-src" }, href.split("/").pop() ?? href),
      h(
        "div",
        { class: "btn-row" },
        button(
          "Replace\u2026",
          "Pick another picture; it keeps this size and place",
          async () => {
            const file = await pickFile("image/*");
            const up = file && src ? await upload(file) : null;
            if (!up || !src) return;
            imageOps(
              {
                href: relativePath(src.path, up.path),
                "xlink:href": null
              },
              "Replace picture"
            );
          }
        ),
        ed.cropMode ? button(
          "Done cropping",
          "Enter",
          () => setCropMode(false),
          "on"
        ) : button(
          "Crop",
          "Crop (double-click the picture)",
          () => void startCrop(sel)
        ),
        cropped ? button(
          "Reset crop",
          "Show the whole picture again",
          () => void resetCrop(sel)
        ) : null
      ),
      row2(
        "Fit",
        selectInput(
          FITS.map((f) => ({ value: f.value, label: f.label })),
          fit,
          (v) => imageOps(
            {
              preserveAspectRatio: FITS.find((f) => f.value === v)?.par ?? null
            },
            "Picture fit"
          )
        )
      )
    );
  }
  function linkOf(el) {
    const a = el.parentElement;
    if (a?.localName !== "a") return "";
    const slide = a.getAttribute("data-inkflow-slide");
    if (slide) return `slide:${slide}`;
    return a.getAttribute("href") ?? a.getAttribute("xlink:href") ?? "";
  }
  function slideLinkByNumber(n) {
    const s = ed.model?.slides[n - 1];
    return s?.id ? `slide:${s.id}` : null;
  }
  function slideOptions() {
    const list2 = h("datalist", { id: "slide-link-list" });
    for (const s of ed.model?.slides ?? []) {
      if (!s.id) continue;
      list2.append(h("option", { value: `slide:${s.id}` }, s.title ?? s.id));
    }
    return list2;
  }
  function detailsSection(sel) {
    const title = [...sel.el.children].find((c) => c.localName === "title")?.textContent ?? "";
    const link = textInput(
      linkOf(sel.el),
      (v) => void sendSvgOps(
        [
          {
            sel,
            ops: [
              {
                kind: "link",
                loc: sel.loc,
                href: /^\d+$/.test(v.trim()) ? slideLinkByNumber(Number(v)) : v.trim() || null
              }
            ]
          }
        ],
        v.trim() ? "Link" : "Remove link"
      ),
      "https://\u2026 or slide:id"
    );
    link.setAttribute("list", "slide-link-list");
    return section(
      "Link & alt text",
      slideOptions(),
      row2("Link", link),
      row2(
        "Alt text",
        textInput(
          title,
          (v) => void sendSvgOps(
            [
              {
                sel,
                ops: [{ kind: "title", loc: sel.loc, text: v }]
              }
            ],
            "Alt text"
          ),
          "Describe it for screen readers"
        )
      )
    );
  }
  function textSection(sel) {
    const el = sel.el;
    const cs = getComputedStyle(el);
    const spans = [...el.querySelectorAll("tspan")];
    const setAll = (set, label3) => {
      const plans = [
        { sel, ops: [{ kind: "style", loc: sel.loc, set }] }
      ];
      for (const t of spans) {
        const loc = t.getAttribute("data-ink");
        const style = t.getAttribute("style") ?? "";
        const touched = Object.keys(set).some(
          (k) => style.includes(`${k}:`) || t.hasAttribute(k)
        );
        if (loc && touched) {
          plans[0].ops.push({ kind: "style", loc, set });
        }
      }
      void sendSvgOps(plans, label3);
    };
    const bold = parseInt(cs.fontWeight, 10) >= 600;
    const italic = cs.fontStyle === "italic";
    const anchor = cs.textAnchor;
    return section(
      "Text",
      row2(
        "Size",
        numberInput(
          parseFloat(cs.fontSize),
          (v) => setAll({ "font-size": `${v}px` }, "Font size")
        )
      ),
      row2(
        "Font",
        textInput(
          cs.fontFamily,
          (v) => setAll({ "font-family": v || null }, "Font"),
          "font-family"
        )
      ),
      h(
        "div",
        { class: "btn-row" },
        button(
          h("b", {}, "B"),
          "Bold",
          () => setAll({ "font-weight": bold ? null : "bold" }, "Bold"),
          bold ? "on" : ""
        ),
        button(
          h("i", {}, "I"),
          "Italic",
          () => setAll(
            { "font-style": italic ? null : "italic" },
            "Italic"
          ),
          italic ? "on" : ""
        ),
        button(
          "\u27F8",
          "Align start",
          () => setAll({ "text-anchor": null }, "Align"),
          anchor === "start" ? "on" : ""
        ),
        button(
          "\u21D4",
          "Align middle",
          () => setAll({ "text-anchor": "middle" }, "Align"),
          anchor === "middle" ? "on" : ""
        ),
        button(
          "\u27F9",
          "Align end",
          () => setAll({ "text-anchor": "end" }, "Align"),
          anchor === "end" ? "on" : ""
        ),
        button("Edit", "Edit text (double-click)", () => emit("edit-text"))
      )
    );
  }
  function geometrySection(sels) {
    const box = sels.length === 1 ? slideBox(sels[0].el) : selectionBox();
    if (!box) return h("div");
    const resizeTo = (to) => {
      const plans = sels.map((s) => {
        const b = slideBox(s.el);
        const sx = box.width ? to.width / box.width : 1;
        const sy = box.height ? to.height / box.height : 1;
        const target = {
          x: to.x + (b.x - box.x) * sx,
          y: to.y + (b.y - box.y) * sy,
          width: b.width * sx,
          height: b.height * sy
        };
        const plan = planResize(elementGeom(s.el), b, target);
        return {
          sel: s,
          ops: [{ kind: "attrs", loc: s.loc, set: plan }]
        };
      });
      void sendSvgOps(plans, "Resize");
    };
    const rot = sels.length === 1 ? rotationOf(parseTransform(sels[0].el.getAttribute("transform"))) : 0;
    return section(
      "Position & size",
      h(
        "div",
        { class: "grid2" },
        row2(
          "X",
          numberInput(box.x, (v) => resizeTo({ ...box, x: v }))
        ),
        row2(
          "Y",
          numberInput(box.y, (v) => resizeTo({ ...box, y: v }))
        ),
        row2(
          "W",
          numberInput(
            box.width,
            (v) => resizeTo({ ...box, width: Math.max(1, v) }),
            { min: 1 }
          )
        ),
        row2(
          "H",
          numberInput(
            box.height,
            (v) => resizeTo({ ...box, height: Math.max(1, v) }),
            { min: 1 }
          )
        )
      ),
      sels.length === 1 && row2(
        "Rotation",
        numberInput(
          rot,
          (v) => {
            const s = sels[0];
            const center = {
              x: box.x + box.width / 2,
              y: box.y + box.height / 2
            };
            const plan = planRotate(
              elementGeom(s.el),
              v - rot,
              center
            );
            void sendSvgOps(
              [
                {
                  sel: s,
                  ops: [
                    {
                      kind: "attrs",
                      loc: s.loc,
                      set: plan
                    }
                  ]
                }
              ],
              "Rotate"
            );
          },
          { step: 1 }
        )
      )
    );
  }
  function arrangeSection(sels) {
    const order2 = (to) => void sendSvgOps(
      sels.map((s) => ({
        sel: s,
        ops: [{ kind: "order", loc: s.loc, to }]
      })),
      "Arrange"
    );
    const isGroup = sels.length === 1 && sels[0].el.localName === "g";
    return section(
      "Arrange",
      h(
        "div",
        { class: "btn-row" },
        button("\u21C8", "Bring to front (Ctrl+Shift+\u2191)", () => order2("front")),
        button("\u2191", "Bring forward (Ctrl+\u2191)", () => order2("forward")),
        button("\u2193", "Send backward (Ctrl+\u2193)", () => order2("backward")),
        button("\u21CA", "Send to back (Ctrl+Shift+\u2193)", () => order2("back")),
        button(
          icon("copy", 14),
          "Duplicate (Ctrl+D)",
          () => emit("duplicate")
        ),
        sels.length > 1 && button(
          icon("group", 14),
          "Group (Ctrl+G)",
          () => emit("group")
        ),
        isGroup && button(
          "Ungroup",
          "Ungroup (Ctrl+Shift+G)",
          () => emit("ungroup")
        ),
        button(
          icon("trash", 14),
          "Delete (Del)",
          () => emit("delete"),
          "danger"
        )
      )
    );
  }
  function alignSelection(how) {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (!sels.length) return;
    const boxes = sels.map((s) => slideBox(s.el));
    const ref = sels.length === 1 ? slideSize() : selectionBox();
    let targetsX = boxes.map((b) => b.x);
    let targetsY = boxes.map((b) => b.y);
    switch (how) {
      case "left":
        targetsX = boxes.map(() => ref.x);
        break;
      case "center":
        targetsX = boxes.map((b) => ref.x + (ref.width - b.width) / 2);
        break;
      case "right":
        targetsX = boxes.map((b) => ref.x + ref.width - b.width);
        break;
      case "top":
        targetsY = boxes.map(() => ref.y);
        break;
      case "middle":
        targetsY = boxes.map((b) => ref.y + (ref.height - b.height) / 2);
        break;
      case "bottom":
        targetsY = boxes.map((b) => ref.y + ref.height - b.height);
        break;
      case "hspace":
        targetsX = distribute(boxes, "x");
        break;
      case "vspace":
        targetsY = distribute(boxes, "y");
        break;
    }
    const plans = sels.map((s, i) => ({
      sel: s,
      ops: moveOps(s, targetsX[i] - boxes[i].x, targetsY[i] - boxes[i].y)
    }));
    void sendSvgOps(plans, "Align");
  }
  function renderMultiPanel() {
    const sels = ed.selection;
    const movable = sels.every((s) => canTransform(s.el));
    panel.append(section(`${sels.length} objects`));
    if (movable) {
      const a = (label3, title, how) => button(label3, title, () => alignSelection(how));
      panel.append(
        section(
          "Align",
          h(
            "div",
            { class: "btn-row" },
            a("\u21E4", "Align left", "left"),
            a("\u2194", "Align centre", "center"),
            a("\u21E5", "Align right", "right"),
            a("\u2912", "Align top", "top"),
            a("\u2195", "Align middle", "middle"),
            a("\u2913", "Align bottom", "bottom")
          ),
          h(
            "div",
            { class: "btn-row" },
            a("\u21F9 Distribute", "Distribute horizontally", "hspace"),
            a("\u21F3 Distribute", "Distribute vertically", "vspace")
          )
        )
      );
      panel.append(geometrySection(sels));
      const styleable = sels.filter(
        (s) => !isZone(s.el) && s.el.localName !== "image"
      );
      if (styleable.length === sels.length) {
        panel.append(
          section(
            "Style",
            paintRow(sels, "fill"),
            paintRow(sels, "stroke")
          )
        );
      }
      panel.append(arrangeSection(sels));
    }
  }
  function renderProps() {
    if (document.activeElement && panel.contains(document.activeElement)) {
      refreshOnBlur = true;
      return;
    }
    clear(panel);
    if (!ed.model) return;
    if (ed.selection.length === 0) renderSlidePanel();
    else if (ed.selection.length === 1) renderObjectPanel(ed.selection[0]);
    else renderMultiPanel();
  }
  var refreshOnBlur = false;
  function initProps() {
    on("selection", renderProps);
    on("render", renderProps);
    panel.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (refreshOnBlur && !panel.contains(document.activeElement)) {
          refreshOnBlur = false;
          renderProps();
        }
      }, 0);
    });
  }

  // src/ts/editor/richtext.ts
  var Unsupported = class extends Error {
  };
  var COLOR_CLASS = /^inkflow-color-[\w-]+$/;
  var RAW_INLINE = /* @__PURE__ */ new Set(["u", "mark", "sub", "sup"]);
  function attrs(el) {
    return [...el.attributes].map((a) => a.name);
  }
  function plain(el, allowed = []) {
    return attrs(el).every(
      (a) => allowed.includes(a) || a === "style" || a === "dir"
    );
  }
  function escapeText(text) {
    return text.replace(/\\/g, "\\\\").replace(/([*`[\]<~$])/g, "\\$1").replace(/(^|\W)_|_(?=\W|$)/g, (m) => m.replace("_", "\\_")).replace(/ /g, " ");
  }
  function codeSpan(text) {
    const ticks = text.includes("`") ? "``" : "`";
    const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
    return `${ticks}${pad}${text}${pad}${ticks}`;
  }
  function wrap(inner, mark) {
    const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!m?.[2]) return inner;
    return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
  }
  function inline(node) {
    let out = "";
    for (const child of node.childNodes) out += inlineNode(child);
    return out.replace(/\\\n\n/g, "\\\n");
  }
  function inlineNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeText(
        (node.textContent ?? "").replace(/[ \t]*\n\s*/g, "\n")
      );
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node;
    const tag = el.localName;
    switch (tag) {
      case "strong":
      case "b":
        if (!plain(el)) throw new Unsupported(tag);
        return wrap(inline(el), "**");
      case "em":
      case "i":
        if (!plain(el)) throw new Unsupported(tag);
        return wrap(inline(el), "*");
      case "s":
      case "del":
      case "strike":
        if (!plain(el)) throw new Unsupported(tag);
        return wrap(inline(el), "~~");
      case "code":
        if (!plain(el)) throw new Unsupported(tag);
        return codeSpan(el.textContent ?? "");
      case "br":
        return "\\\n";
      case "a": {
        const slide = el.getAttribute("data-inkflow-slide");
        if (slide && plain(el, ["data-inkflow-slide", "title"])) {
          return `[${inline(el)}](slide:${slide})`;
        }
        if (!plain(el, ["href", "title"])) throw new Unsupported(tag);
        const href = el.getAttribute("href") ?? "";
        const title = el.getAttribute("title");
        const t = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
        return `[${inline(el)}](${href.replace(/[()\s]/g, encodeURIComponent)}${t})`;
      }
      case "span": {
        const cls = el.getAttribute("class") ?? "";
        if (!cls && plain(el)) return inline(el);
        if (COLOR_CLASS.test(cls) && plain(el, ["class"])) {
          return `<span class="${cls}">${inline(el)}</span>`;
        }
        throw new Unsupported(`span.${cls}`);
      }
      case "font":
        return inline(el);
      default:
        if (RAW_INLINE.has(tag) && plain(el)) {
          return `<${tag}>${inline(el)}</${tag}>`;
        }
        throw new Unsupported(tag);
    }
  }
  var BLOCK = /* @__PURE__ */ new Set([
    "p",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "blockquote",
    "hr",
    "table",
    "pre"
  ]);
  function isBlank(node) {
    return node.nodeType === Node.TEXT_NODE && !(node.textContent ?? "").trim();
  }
  function cellText(cell) {
    return inline(cell).replace(/\|/g, "\\|").replace(/\\\n/g, " ").trim();
  }
  function align(cell) {
    const a = cell.style?.textAlign || cell.getAttribute("align");
    return a === "center" || a === "right" || a === "left" ? a : "";
  }
  function tableMarkdown(table) {
    const rows = [...table.querySelectorAll("tr")];
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.children.length));
    const cells = rows.map((r) => {
      const out = [...r.children].map(cellText);
      while (out.length < width) out.push("");
      return out;
    });
    const aligns = [...rows[0].children].map(align);
    while (aligns.length < width) aligns.push("");
    const rule = aligns.map(
      (a) => a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---"
    );
    const line = (r) => `| ${r.join(" | ")} |`;
    return [line(cells[0]), line(rule), ...cells.slice(1).map(line)].join("\n");
  }
  function listMarkdown(list2) {
    const ordered = list2.localName === "ol";
    let n = parseInt(list2.getAttribute("start") ?? "1", 10) || 1;
    const lines = [];
    for (const li of list2.children) {
      if (li.localName !== "li") throw new Unsupported(li.localName);
      if (!plain(li)) throw new Unsupported("li with attributes");
      const marker = ordered ? `${n++}. ` : "- ";
      const pad = " ".repeat(marker.length);
      const own = [];
      const nested = [];
      for (const c of li.childNodes) {
        const el = c;
        if (c.nodeType === Node.ELEMENT_NODE && /^[ou]l$/.test(el.localName)) {
          nested.push(listMarkdown(el));
        } else if (c.nodeType === Node.ELEMENT_NODE && (el.localName === "p" || el.localName === "div")) {
          own.push(inline(el));
        } else {
          own.push(inlineNode(c));
        }
      }
      const text = own.join("").trim().replace(/\n/g, `
${pad}`);
      lines.push(`${marker}${text}`);
      for (const sub of nested) {
        lines.push(
          sub.split("\n").map((l) => pad + l).join("\n")
        );
      }
    }
    return lines.join("\n");
  }
  function blockMarkdown(el) {
    const tag = el.localName;
    if (/^h[1-6]$/.test(tag)) {
      if (!plain(el)) throw new Unsupported(tag);
      return `${"#".repeat(Number(tag[1]))} ${inline(el).trim()}`;
    }
    switch (tag) {
      case "p":
      case "div":
        if (!plain(el)) throw new Unsupported(tag);
        if ([...el.children].some((c) => BLOCK.has(c.localName))) {
          return blocks(el);
        }
        return escapeLineStart(inline(el).replace(/\\\n$/, "").trim());
      case "ul":
      case "ol":
        if (!plain(el, ["start"])) throw new Unsupported(tag);
        return listMarkdown(el);
      case "blockquote":
        if (!plain(el)) throw new Unsupported(tag);
        return blocks(el).split("\n").map((l) => l ? `> ${l}` : ">").join("\n");
      case "hr":
        return "---";
      case "table":
        if (!plain(el)) throw new Unsupported(tag);
        return tableMarkdown(el);
      default:
        throw new Unsupported(tag);
    }
  }
  function escapeLineStart(md) {
    const ordered = md.match(/^(\d+)([.)]) /);
    if (ordered) {
      return `${ordered[1]}\\${ordered[2]} ${md.slice(ordered[0].length)}`;
    }
    return /^(#{1,6} |[-+] |> )/.test(md) ? `\\${md}` : md;
  }
  function blocks(root2) {
    const out = [];
    let run = "";
    const flush = () => {
      if (run.trim()) out.push(run.trim());
      run = "";
    };
    for (const node of root2.childNodes) {
      if (isBlank(node)) continue;
      const el = node;
      if (node.nodeType === Node.ELEMENT_NODE && BLOCK.has(el.localName)) {
        flush();
        const md = blockMarkdown(el);
        if (md.trim()) out.push(md);
      } else if (node.nodeType === Node.ELEMENT_NODE && el.localName === "br") {
        flush();
      } else {
        run += inlineNode(node);
      }
    }
    flush();
    return out.join("\n\n");
  }
  function htmlToMarkdown(root2) {
    return blocks(root2);
  }
  function normalizeMarkdown(md) {
    return md.replace(/\r/g, "").replace(/ {2,}\n(?=[^\n])/g, "\\\n").split("\n").map(
      (l) => l.replace(/\s+$/, "").replace(/^(\s*)[*+] /, "$1- ").replace(/^(\s*)\d+[.)] /, "$11. ")
    ).join("\n").replace(/__(.+?)__/g, "**$1**").replace(/(^|\W)_(\S.*?)_(?=\W|$)/g, "$1*$2*").replace(/\\([\\`*_{}[\]()#+\-.!<>~$|])/g, "$1").replace(/ *\| */g, "|").replace(/\|:?-+:?/g, "|-").replace(/\n{3,}/g, "\n\n").trim();
  }
  function sameMarkdown(a, b) {
    return normalizeMarkdown(a) === normalizeMarkdown(b);
  }

  // src/ts/editor/textedit.ts
  var layer = document.getElementById("text-layer");
  var dock = document.getElementById("zone-dock");
  function closeDock() {
    clear(dock);
    document.body.classList.remove("editing-zone");
  }
  var active = null;
  function isEditingText() {
    return active !== null;
  }
  async function finishTextEdit() {
    const a = active;
    if (!a) return;
    active = null;
    clear(layer);
    closeDock();
    await a.commit();
  }
  function cancel() {
    const a = active;
    if (!a) return;
    active = null;
    clear(layer);
    closeDock();
    a.cancel();
  }
  function linesOf(el) {
    const spans = [...el.children].filter((c) => c.localName === "tspan");
    const loose = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim()
    );
    if (!spans.length || loose) return [el.textContent ?? ""];
    return spans.map((s) => s.textContent ?? "");
  }
  function editSvgText(el, sourcePath, hash, loc) {
    void finishTextEdit();
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const ctm = el.getScreenCTM();
    const fontPx = parseFloat(style.fontSize) * (ctm ? Math.hypot(ctm.a, ctm.b) : 1);
    const original = linesOf(el);
    const area2 = h("textarea", {
      class: "svg-text-editor",
      spellcheck: "true"
    });
    area2.value = original.join("\n");
    const anchor = style.textAnchor;
    Object.assign(area2.style, {
      left: `${rect.left - 6}px`,
      top: `${rect.top - 4}px`,
      minWidth: `${Math.max(rect.width + 24, 80)}px`,
      minHeight: `${rect.height + 8}px`,
      fontSize: `${fontPx}px`,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
      lineHeight: "1.2",
      color: style.fill.startsWith("rgb") ? style.fill : "inherit",
      textAlign: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left"
    });
    const autosize = () => {
      area2.style.height = "auto";
      area2.style.height = `${area2.scrollHeight}px`;
      area2.style.width = "auto";
      area2.style.width = `${Math.max(area2.scrollWidth + 8, rect.width + 24)}px`;
    };
    area2.addEventListener("input", autosize);
    el.style.visibility = "hidden";
    layer.append(area2);
    autosize();
    area2.focus();
    area2.select();
    active = {
      commit: async () => {
        el.style.visibility = "";
        const lines = area2.value.replace(/\r/g, "").split("\n");
        if (lines.join("\n") === original.join("\n")) return;
        if (lines.length === 1 && !el.querySelector("tspan")) {
          el.textContent = lines[0];
        }
        await edit({
          action: "svg",
          file: sourcePath,
          hash: hash(),
          ops: [{ kind: "text", loc, lines }],
          label: "Edit text"
        });
      },
      cancel: () => {
        el.style.visibility = "";
      }
    };
    area2.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void finishTextEdit();
      }
    });
    area2.addEventListener("blur", () => void finishTextEdit());
  }
  function wrapSelection(area2, before, after = before) {
    const { selectionStart: s, selectionEnd: e, value } = area2;
    const inner = value.slice(s, e) || "text";
    area2.value = value.slice(0, s) + before + inner + after + value.slice(e);
    area2.selectionStart = s + before.length;
    area2.selectionEnd = s + before.length + inner.length;
    area2.dispatchEvent(new Event("input"));
    area2.focus();
  }
  function prefixLines(area2, prefix) {
    const { selectionStart: s, selectionEnd: e, value } = area2;
    const start = value.lastIndexOf("\n", s - 1) + 1;
    const end = value.indexOf("\n", e);
    const stop = end === -1 ? value.length : end;
    const block = value.slice(start, stop).split("\n").map(
      (line) => line.startsWith(prefix) ? line.slice(prefix.length) : prefix + line
    ).join("\n");
    area2.value = value.slice(0, start) + block + value.slice(stop);
    area2.selectionStart = start;
    area2.selectionEnd = start + block.length;
    area2.dispatchEvent(new Event("input"));
    area2.focus();
  }
  function editZoneText(zone) {
    void finishTextEdit();
    const slide = currentSlide();
    if (!slide) return;
    const origin = slide.zoneOrigins?.[zone];
    const original = slide.zoneText?.[zone] ?? "";
    const deckIndex = slide.deckIndex;
    if (!ed.model?.deckEditable && (origin === "deck" || !slide.md)) {
      toast(
        "deck.py builds its slides in code; edit this zone there",
        "error"
      );
      return;
    }
    const area2 = h("textarea", { class: "zone-editor", spellcheck: "true" });
    area2.value = original;
    let sent2 = original;
    let timer3 = 0;
    const coalesce = `zone-${deckIndex}-${zone}-${Date.now()}`;
    const send = async () => {
      window.clearTimeout(timer3);
      if (area2.value === sent2) return;
      const before = sent2;
      sent2 = area2.value;
      const result = await edit(
        {
          action: "zone-text",
          slide: deckIndex,
          zone,
          text: area2.value,
          origin,
          coalesce
        },
        { retrying: true }
      );
      if (!result.ok) {
        sent2 = before;
        timer3 = window.setTimeout(() => void send(), 800);
      }
    };
    area2.addEventListener("input", () => {
      window.clearTimeout(timer3);
      timer3 = window.setTimeout(() => void send(), 450);
    });
    const button2 = (name, title, fn) => h(
      "button",
      {
        type: "button",
        class: "fmt-btn",
        title,
        onmousedown: (e) => {
          e.preventDefault();
          fn();
        }
      },
      name
    );
    const bar = h(
      "div",
      { class: "zone-toolbar" },
      h("span", { class: "zone-label" }, `${zone} \xB7 Markdown`),
      button2("B", "Bold (Ctrl+B)", () => wrapSelection(area2, "**")),
      button2("I", "Italic (Ctrl+I)", () => wrapSelection(area2, "*")),
      button2("H", "Heading", () => prefixLines(area2, "## ")),
      button2("\u2022", "Bullet list", () => prefixLines(area2, "- ")),
      button2("1.", "Numbered list", () => prefixLines(area2, "1. ")),
      button2("`", "Code", () => wrapSelection(area2, "`")),
      button2("\u2211", "Math", () => wrapSelection(area2, "$")),
      button2("\u23F5", "Reveal on click: insert a ::step:: marker", () => {
        const pos = area2.selectionStart;
        area2.value = `${area2.value.slice(0, pos)}
::step::
${area2.value.slice(pos)}`;
        area2.dispatchEvent(new Event("input"));
      }),
      h(
        "button",
        {
          type: "button",
          class: "fmt-btn done",
          title: "Done (Ctrl+Enter)",
          onmousedown: (e) => {
            e.preventDefault();
            void finishTextEdit();
          }
        },
        icon("select", 13),
        " Done"
      )
    );
    const wrap2 = h("div", { class: "zone-edit-wrap" }, bar, area2);
    dock.append(wrap2);
    document.body.classList.add("editing-zone");
    area2.focus();
    active = {
      commit: async () => {
        await send();
      },
      cancel: () => {
        window.clearTimeout(timer3);
        if (sent2 !== original) {
          area2.value = original;
          void send();
        }
      }
    };
    area2.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void finishTextEdit();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        wrapSelection(area2, "**");
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        wrapSelection(area2, "*");
      }
    });
    area2.addEventListener("blur", (e) => {
      const next = e.relatedTarget;
      if (next && wrap2.contains(next)) return;
      void finishTextEdit();
    });
  }
  var richHost = null;
  function editingHost() {
    return richHost;
  }
  function editZone(zone, el, opts = {}) {
    void finishTextEdit();
    if (el && editZoneRich(zone, el, opts)) return;
    editZoneText(zone);
  }
  var COLORS = [
    "text",
    "text-muted",
    "accent",
    "red",
    "orange",
    "yellow",
    "green",
    "teal",
    "blue",
    "purple",
    "pink",
    "grey"
  ];
  function editZoneRich(zone, el, opts) {
    const slide = currentSlide();
    const content2 = el.querySelector(".inkflow-content");
    if (!slide || !content2 || ed.step != null) return false;
    const origin = slide.zoneOrigins?.[zone];
    if (!ed.model?.deckEditable && (origin === "deck" || !slide.md)) {
      return false;
    }
    let start;
    try {
      start = htmlToMarkdown(content2);
    } catch {
      return false;
    }
    if (!sameMarkdown(start, slide.zoneText?.[zone] ?? "")) return false;
    const fo = el;
    const deckIndex = slide.deckIndex;
    ed.richEditing = true;
    richHost = content2;
    fo.classList.add("rich-editing");
    fo.style.overflow = "visible";
    content2.contentEditable = "true";
    content2.spellcheck = true;
    document.execCommand("defaultParagraphSeparator", false, "p");
    content2.focus();
    placeCaret(content2, opts);
    const bar = richToolbar(content2, () => {
      void finishTextEdit().then(() => editZoneText(zone));
    });
    layer.append(bar);
    positionBar(bar, fo);
    const cleanup = () => {
      richHost = null;
      content2.contentEditable = "false";
      fo.classList.remove("rich-editing");
      fo.style.overflow = "";
      bar.remove();
      document.removeEventListener("selectionchange", onSelection);
    };
    const onSelection = () => syncToolbar(bar, content2);
    document.addEventListener("selectionchange", onSelection);
    syncToolbar(bar, content2);
    active = {
      commit: async () => {
        let md;
        try {
          md = htmlToMarkdown(content2);
        } catch (err) {
          cleanup();
          ed.richEditing = false;
          emit("rerender");
          toast(
            `Not saved: ${err instanceof Unsupported ? `<${err.message}>` : "this content"} cannot be written as Markdown`,
            "error"
          );
          return;
        }
        const grow = growOp(fo, content2);
        cleanup();
        ed.richEditing = false;
        if (md === start && !grow) {
          emit("rerender");
          return;
        }
        if (!md.trim() && removeEmptyBox(fo, zone, deckIndex)) return;
        const result = await edit({
          action: "zone-text",
          slide: deckIndex,
          zone,
          text: md,
          origin,
          svg: grow
        });
        if (!result.ok) emit("rerender");
      },
      cancel: () => {
        cleanup();
        ed.richEditing = false;
        emit("rerender");
      }
    };
    content2.addEventListener("keydown", (e) => {
      e.stopPropagation();
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter" && mod) {
        e.preventDefault();
        void finishTextEdit();
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        editLink(content2);
      } else if (e.key === "Tab") {
        e.preventDefault();
        const cell = caretElement(content2)?.closest("td, th");
        if (cell) moveCell(cell, e.shiftKey ? -1 : 1);
        else if (caretElement(content2)?.closest("li")) {
          document.execCommand(e.shiftKey ? "outdent" : "indent");
        }
      }
    });
    content2.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      document.execCommand("insertText", false, text);
    });
    content2.addEventListener("focusout", (e) => {
      const next = e.relatedTarget;
      if (next && (bar.contains(next) || content2.contains(next))) return;
      if (bar.matches(":hover")) return;
      void finishTextEdit();
    });
    return true;
  }
  function placeCaret(content2, opts) {
    const sel = window.getSelection();
    if (!sel) return;
    let range = null;
    if (opts.at && !opts.selectAll) {
      range = document.caretRangeFromPoint?.(opts.at.x, opts.at.y) ?? null;
      if (range && !content2.contains(range.startContainer)) range = null;
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(content2);
      if (!opts.selectAll) range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function positionBar(bar, fo) {
    const r = fo.getBoundingClientRect();
    const top = r.top - 44 < 52 ? r.bottom + 8 : r.top - 44;
    bar.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 640))}px`;
    bar.style.top = `${top}px`;
  }
  function removeEmptyBox(fo, zone, deckIndex) {
    const slide = currentSlide();
    const loc = fo.getAttribute("data-ink");
    if (!slide || !loc || !/^text(-\d+)?$/.test(zone)) return false;
    const src = slide.sources?.[parseInt(loc.split(":")[0] ?? "", 10)];
    if (src?.role !== "slide" || slide.srcShared || !src.writable) return false;
    void edit({
      action: "svg",
      file: src.path,
      hash: src.hash,
      zoneSlide: deckIndex,
      ops: [{ kind: "delete", loc }],
      label: "Delete text box"
    });
    return true;
  }
  function growOp(fo, content2) {
    const slide = currentSlide();
    const loc = fo.getAttribute("data-ink");
    if (!slide || !loc || fo.getAttribute("data-ink-tag") !== "rect") return;
    const src = slide.sources?.[parseInt(loc.split(":")[0] ?? "", 10)];
    if (!src?.writable || src.role === "slide" && slide.srcShared) return;
    if (src.role !== "slide" && !ed.layoutMode) return;
    const wrapper = content2.parentElement;
    const have = parseFloat(fo.getAttribute("height") ?? "0");
    const need = wrapper ? wrapper.scrollHeight : 0;
    if (!have || need <= have + 2) return;
    return {
      file: src.path,
      hash: src.hash,
      ops: [{ kind: "attrs", loc, set: { height: String(Math.ceil(need)) } }]
    };
  }
  function caretElement(content2) {
    const sel = window.getSelection();
    const node = sel?.anchorNode ?? null;
    if (!node || !content2.contains(node)) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }
  function changed(content2) {
    content2.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function selectionRange(content2) {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return null;
    const range = sel.getRangeAt(0);
    return content2.contains(range.commonAncestorContainer) ? range : null;
  }
  function unwrap(el) {
    el.replaceWith(...el.childNodes);
  }
  function wrapRange(content2, make, same) {
    const range = selectionRange(content2);
    if (!range || range.collapsed) return;
    const frag = range.extractContents();
    frag.querySelectorAll(same).forEach(unwrap);
    const sel = window.getSelection();
    if (make) {
      const el = make();
      el.append(frag);
      range.insertNode(el);
      range.selectNodeContents(el);
    } else {
      const first = frag.firstChild;
      const last = frag.lastChild;
      range.insertNode(frag);
      if (first && last) {
        range.setStartBefore(first);
        range.setEndAfter(last);
      }
    }
    sel?.removeAllRanges();
    sel?.addRange(range);
    content2.querySelectorAll(same).forEach((el) => {
      if (!el.textContent) el.remove();
    });
    changed(content2);
  }
  function setColor(content2, token) {
    wrapRange(
      content2,
      token ? () => h("span", { class: `inkflow-color-${token}` }) : null,
      'span[class^="inkflow-color-"]'
    );
  }
  function toggleCode(content2) {
    const inCode = caretElement(content2)?.closest("code");
    if (inCode && content2.contains(inCode)) {
      unwrap(inCode);
      changed(content2);
      return;
    }
    wrapRange(content2, () => h("code", {}), "code");
  }
  function editLink(content2) {
    const a = caretElement(content2)?.closest("a");
    const range = selectionRange(content2);
    const current = a?.getAttribute("href") ?? "";
    const url = window.prompt(
      a ? "Link address: https://\u2026 or slide:<id> (empty removes the link)" : "Link address: https://\u2026 or slide:<id>",
      current || "https://"
    );
    if (url == null) return;
    const sel = window.getSelection();
    if (range) {
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    if (a && !url.trim()) {
      unwrap(a);
    } else if (a) {
      a.setAttribute("href", url.trim());
    } else if (url.trim() && range && !range.collapsed) {
      document.execCommand("createLink", false, url.trim());
    } else if (url.trim()) {
      document.execCommand(
        "insertHTML",
        false,
        `<a href="${encodeURI(url.trim())}">${url.trim().replace(/</g, "&lt;")}</a>`
      );
    }
    changed(content2);
  }
  function cellOf(content2) {
    const cell = caretElement(content2)?.closest("td, th");
    return cell && content2.contains(cell) ? cell : null;
  }
  function focusCell(cell) {
    const range = document.createRange();
    range.selectNodeContents(cell);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  function moveCell(cell, by) {
    const table = cell.closest("table");
    if (!table) return;
    const cells = [...table.querySelectorAll("th, td")];
    const next = cells[cells.indexOf(cell) + by];
    if (next) focusCell(next);
    else if (by > 0) {
      addRow(cell);
      const after = [...table.querySelectorAll("th, td")];
      focusCell(after[cells.length]);
    }
  }
  function newCell(tag, like) {
    const cell = document.createElement(tag);
    const align2 = like?.style.textAlign;
    if (align2) cell.style.textAlign = align2;
    cell.append(document.createElement("br"));
    return cell;
  }
  function addRow(cell) {
    const row3 = cell.parentElement;
    const table = row3.closest("table");
    let body2 = table.tBodies[0];
    if (!body2) {
      body2 = document.createElement("tbody");
      table.append(body2);
    }
    const tr = document.createElement("tr");
    for (const c of row3.children) tr.append(newCell("td", c));
    if (row3.parentElement?.localName === "thead") body2.prepend(tr);
    else row3.after(tr);
  }
  function addColumn(cell) {
    const table = cell.closest("table");
    const index = cell.cellIndex;
    for (const row3 of table.rows) {
      const ref = row3.cells[index];
      const tag = row3.parentElement?.localName === "thead" ? "th" : "td";
      const c = newCell(tag, ref);
      if (ref) ref.after(c);
      else row3.append(c);
    }
  }
  function deleteRow(cell) {
    const row3 = cell.parentElement;
    const table = row3.closest("table");
    if (table.rows.length <= 1) {
      table.remove();
      return;
    }
    if (row3.parentElement?.localName === "thead") {
      const next = table.tBodies[0]?.rows[0];
      if (!next) return;
      const head = document.createElement("tr");
      for (const c of next.cells) {
        const th = newCell("th", c);
        th.replaceChildren(...c.childNodes);
        head.append(th);
      }
      row3.replaceWith(head);
      next.remove();
      return;
    }
    row3.remove();
  }
  function deleteColumn(cell) {
    const table = cell.closest("table");
    const index = cell.cellIndex;
    if (table.rows[0]?.cells.length <= 1) {
      table.remove();
      return;
    }
    for (const row3 of [...table.rows]) row3.cells[index]?.remove();
  }
  function alignColumn(cell, align2) {
    const table = cell.closest("table");
    for (const row3 of table.rows) {
      const c = row3.cells[cell.cellIndex];
      if (c) c.style.textAlign = align2;
    }
  }
  function insertTable(content2) {
    const head = "<th>Header</th><th>Header</th><th>Header</th>";
    const row3 = "<td><br></td><td><br></td><td><br></td>";
    document.execCommand(
      "insertHTML",
      false,
      `<table><thead><tr>${head}</tr></thead><tbody><tr>${row3}</tr><tr>${row3}</tr></tbody></table><p><br></p>`
    );
    const after = caretElement(content2)?.closest("p");
    const table = after?.previousElementSibling;
    const first = table?.localName === "table" ? table.querySelector("th") : null;
    if (first) {
      const range = document.createRange();
      range.selectNodeContents(first);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    changed(content2);
  }
  function tableCommand(content2, fn) {
    const cell = cellOf(content2);
    if (!cell) return;
    fn(cell);
    changed(content2);
    syncToolbar(document.querySelector(".rich-bar"), content2);
  }
  function richToolbar(content2, toSource) {
    const btn = (label3, title, fn, cls = "") => h(
      "button",
      {
        type: "button",
        class: `fmt-btn ${cls}`,
        title,
        onmousedown: (e) => {
          e.preventDefault();
          fn();
          syncToolbar(bar, content2);
        }
      },
      label3
    );
    const exec = (cmd, value) => () => {
      document.execCommand(cmd, false, value);
      changed(content2);
    };
    const block = h("select", { class: "fmt-block", title: "Paragraph style" });
    for (const [v, l] of [
      ["p", "Text"],
      ["h1", "Title"],
      ["h2", "Heading"],
      ["h3", "Subheading"],
      ["blockquote", "Quote"]
    ]) {
      block.append(h("option", { value: v }, l));
    }
    block.addEventListener("mousedown", (e) => e.stopPropagation());
    block.addEventListener("change", () => {
      content2.focus();
      document.execCommand("formatBlock", false, `<${block.value}>`);
      changed(content2);
    });
    const swatches = h("div", { class: "fmt-colors" });
    const host4 = content2.closest("svg");
    const css = host4 ? getComputedStyle(host4) : null;
    swatches.append(
      btn(
        "A",
        "Default colour",
        () => setColor(content2, null),
        "swatch none"
      )
    );
    for (const t of COLORS) {
      const b = btn("", t, () => setColor(content2, t), "swatch");
      b.style.background = css?.getPropertyValue(`--inkflow-${t}`).trim() || "currentColor";
      swatches.append(b);
    }
    const colorBtn = btn(
      h("span", { class: "fmt-color-a" }, "A"),
      "Text colour",
      () => swatches.classList.toggle("open")
    );
    const tableTools = h(
      "span",
      { class: "fmt-table" },
      h("span", { class: "fmt-sep" }),
      btn("+row", "Add a row below", () => tableCommand(content2, addRow)),
      btn(
        "+col",
        "Add a column to the right",
        () => tableCommand(content2, addColumn)
      ),
      btn("\u2212row", "Delete this row", () => tableCommand(content2, deleteRow)),
      btn(
        "\u2212col",
        "Delete this column",
        () => tableCommand(content2, deleteColumn)
      ),
      btn(
        "\u21E4",
        "Align column left",
        () => tableCommand(content2, (c) => alignColumn(c, "left"))
      ),
      btn(
        "\u21D4",
        "Centre column",
        () => tableCommand(content2, (c) => alignColumn(c, "center"))
      ),
      btn(
        "\u21E5",
        "Align column right",
        () => tableCommand(content2, (c) => alignColumn(c, "right"))
      )
    );
    const bar = h(
      "div",
      { class: "rich-bar" },
      block,
      h("span", { class: "fmt-sep" }),
      btn(h("b", {}, "B"), "Bold (Ctrl+B)", exec("bold"), "fmt-bold"),
      btn(h("i", {}, "I"), "Italic (Ctrl+I)", exec("italic"), "fmt-italic"),
      btn(
        h("s", {}, "S"),
        "Strikethrough",
        exec("strikeThrough"),
        "fmt-strike"
      ),
      btn("</>", "Inline code", () => toggleCode(content2), "fmt-code"),
      h("span", { class: "fmt-color-wrap" }, colorBtn, swatches),
      btn("\u{1F517}", "Link (Ctrl+K)", () => editLink(content2), "fmt-link"),
      h("span", { class: "fmt-sep" }),
      btn("\u2022", "Bullet list", exec("insertUnorderedList"), "fmt-ul"),
      btn("1.", "Numbered list", exec("insertOrderedList"), "fmt-ol"),
      btn("\u25A6", "Insert a table", () => insertTable(content2)),
      tableTools,
      h("span", { class: "fmt-sep" }),
      btn("Tx", "Clear formatting", exec("removeFormat")),
      btn("M\u2193", "Edit the Markdown source (math, code, reveals\u2026)", toSource),
      btn(
        h("span", {}, icon("select", 13), " Done"),
        "Done (Ctrl+Enter)",
        () => void finishTextEdit(),
        "done"
      )
    );
    return bar;
  }
  function syncToolbar(bar, content2) {
    if (!bar) return;
    const el = caretElement(content2);
    const state = (cmd) => {
      try {
        return document.queryCommandState(cmd);
      } catch {
        return false;
      }
    };
    const on2 = (cls, v) => bar.querySelector(`.${cls}`)?.classList.toggle("on", v);
    on2("fmt-bold", state("bold"));
    on2("fmt-italic", state("italic"));
    on2("fmt-strike", state("strikeThrough"));
    on2("fmt-code", !!el?.closest("code"));
    on2("fmt-link", !!el?.closest("a"));
    on2("fmt-ul", !!el?.closest("ul"));
    on2("fmt-ol", !!el?.closest("ol"));
    const blockEl = el?.closest("p, h1, h2, h3, h4, h5, h6, blockquote, li");
    const select2 = bar.querySelector(".fmt-block");
    if (select2 && blockEl) {
      const tag = blockEl.closest("blockquote") ? "blockquote" : blockEl.localName;
      select2.value = ["p", "h1", "h2", "h3", "blockquote"].includes(tag) ? tag : "p";
    }
    bar.querySelector(".fmt-table")?.classList.toggle(
      "show",
      !!el?.closest("td, th")
    );
  }

  // src/ts/editor/theme.ts
  var SEMANTIC = [
    ["bg", "Background"],
    ["surface", "Surface (cards)"],
    ["border", "Border"],
    ["text", "Text"],
    ["text_muted", "Muted text"],
    ["heading", "Headings"],
    ["accent", "Accent"],
    ["accent_fg", "Text on accent"],
    ["link", "Links"],
    ["code_bg", "Code background"],
    ["code_text", "Code text"],
    ["blockquote", "Quote bar"]
  ];
  var NAMED = [
    "red",
    "orange",
    "yellow",
    "green",
    "teal",
    "blue",
    "purple",
    "pink",
    "grey"
  ];
  var FONTS = [
    ["body_font", "Body", "sans-serif"],
    ["heading_font", "Headings", "sans-serif"],
    ["mono_font", "Code", "monospace"]
  ];
  var info = null;
  var content = null;
  var cssVar = (name) => `--inkflow-${name.replace(/_/g, "-")}`;
  function toHex(value) {
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(value)) {
      return `#${[...value.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
    }
    const probe = h("span", {});
    probe.style.color = value;
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color.match(/\d+/g) ?? ["0", "0", "0"];
    probe.remove();
    return `#${rgb.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  }
  async function save2(body2, label3) {
    await edit({ action: "theme-set", label: label3, ...body2 });
  }
  function setToken(group, name, value) {
    void save2({ changes: { [group]: { [name]: value } } }, "Theme");
  }
  function colorCell(mode, name) {
    const t = info;
    const own = t.overrides[mode][name];
    const value = own ?? t.values[mode][name] ?? "#000000";
    const input = h("input", {
      type: "color",
      value: toHex(value),
      title: `${cssVar(name)} (${mode})${own ? " \xB7 changed" : ""}`
    });
    input.addEventListener("input", () => {
      const showing = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      if (showing === mode) {
        document.documentElement.style.setProperty(
          cssVar(name),
          input.value
        );
      }
    });
    input.addEventListener("change", () => setToken(mode, name, input.value));
    return h(
      "span",
      { class: `theme-color${own ? " changed" : ""}` },
      input,
      own ? h(
        "button",
        {
          type: "button",
          class: "theme-reset",
          title: "Back to the theme's colour",
          onclick: () => setToken(mode, name, null)
        },
        "\u21BA"
      ) : null
    );
  }
  function colorsTable() {
    const rows = [
      h(
        "div",
        { class: "theme-row head" },
        h("span", {}, ""),
        h("span", {}, "Dark"),
        h("span", {}, "Light")
      )
    ];
    const add = (name, label3) => rows.push(
      h(
        "div",
        { class: "theme-row" },
        h("span", { class: "theme-label" }, label3),
        colorCell("dark", name),
        colorCell("light", name)
      )
    );
    for (const [name, label3] of SEMANTIC) add(name, label3);
    rows.push(h("div", { class: "theme-sub" }, "Named colours"));
    for (const name of NAMED) add(name, name[0].toUpperCase() + name.slice(1));
    return h("div", { class: "theme-colors" }, ...rows);
  }
  function fontRow(name, label3, generic) {
    const t = info;
    const own = t.overrides.typography[name];
    const value = own ?? t.values.typography[name] ?? generic;
    const input = h("input", {
      type: "text",
      list: "theme-font-list",
      value,
      placeholder: generic,
      spellcheck: "false"
    });
    input.addEventListener("change", () => {
      const v = input.value.trim();
      if (!v) {
        setToken("typography", name, null);
        return;
      }
      const withFallback = v.includes(",") || v === generic ? v : `${v}, ${generic}`;
      setToken("typography", name, withFallback);
    });
    const sample = h("span", { class: "theme-font-sample" }, "Aa Bb 123");
    sample.style.fontFamily = value;
    return h(
      "div",
      { class: "theme-font" },
      h("span", { class: "theme-label" }, label3),
      input,
      sample,
      own ? h(
        "button",
        {
          type: "button",
          class: "theme-reset",
          title: "Back to the theme's font",
          onclick: () => setToken("typography", name, null)
        },
        "\u21BA"
      ) : null
    );
  }
  function render2() {
    if (!content || !info) return;
    const t = info;
    clear(content);
    const mode = h("select", {});
    for (const [v, l] of [
      ["", `Theme default (${t.themeMode})`],
      ["dark", "Dark"],
      ["light", "Light"]
    ]) {
      mode.append(h("option", { value: v }, l));
    }
    mode.value = t.deckMode ?? "";
    mode.disabled = !ed.model?.deckEditable;
    mode.addEventListener(
      "change",
      () => void save2({ mode: mode.value || null }, "Colour mode")
    );
    const size = h("input", {
      type: "number",
      min: 8,
      max: 200,
      value: t.fontSize ?? "",
      placeholder: String(t.themeFontSize)
    });
    size.disabled = !ed.model?.deckEditable;
    size.addEventListener("change", () => {
      const n = parseInt(size.value, 10);
      void save2({ fontSize: Number.isFinite(n) ? n : null }, "Font size");
    });
    const list2 = h("datalist", { id: "theme-font-list" });
    for (const f of ["sans-serif", "serif", "monospace", ...t.fonts]) {
      list2.append(h("option", { value: f }));
    }
    content.append(
      h(
        "div",
        { class: "theme-top" },
        h("label", {}, h("span", {}, "Colour mode"), mode),
        h("label", {}, h("span", {}, "Base font size (px)"), size)
      ),
      h("h3", {}, "Fonts"),
      list2,
      ...FONTS.map(([n, l, g]) => fontRow(n, l, g)),
      h(
        "p",
        { class: "hint" },
        "Fonts found in fonts/, the theme or this computer are embedded in the deck."
      ),
      h("h3", {}, "Colours"),
      colorsTable(),
      h(
        "p",
        { class: "hint" },
        "Changes are written to styles.css (one marked block) and deck.py; \u21BA goes back to the theme."
      )
    );
  }
  async function refresh() {
    const result = await request({ action: "theme-get" });
    if (!result.ok) return;
    info = result.theme;
    render2();
  }
  async function openTheme() {
    content = h(
      "div",
      { class: "theme-body" },
      h("p", { class: "hint" }, "Loading\u2026")
    );
    openDialog("Theme", content, {
      hint: "Colours, fonts and size for the whole deck",
      onClose: () => {
        content = null;
        document.documentElement.removeAttribute("style");
      }
    });
    await refresh();
  }
  function initTheme() {
    document.getElementById("btn-theme-panel")?.addEventListener("click", () => {
      void openTheme();
    });
    on("model", () => {
      document.documentElement.removeAttribute("style");
      if (content) void refresh();
    });
  }

  // src/ts/editor/toolbar.ts
  var $ = (id) => document.getElementById(id);
  async function undo() {
    await edit({ action: "undo" });
  }
  async function redo() {
    await edit({ action: "redo" });
  }
  async function deleteSelection() {
    const slide = currentSlide();
    if (!slide || !ed.selection.length) return;
    const zones = ed.selection.filter(
      (s) => isZone(s.el) && !canTransform(s.el)
    );
    const shapes = ed.selection.filter((s) => !zones.includes(s));
    for (const z of zones) {
      const name = zoneName(z.el);
      const value = slide.zones[name];
      if (slide.zoneOrigins?.[name] === "md-file") {
        toast(
          "This zone shows the whole Markdown file: edit its text instead"
        );
        continue;
      }
      if (value && (value.kind === "image" || value.kind === "video")) {
        await edit({
          action: "zone-media",
          slide: slide.deckIndex,
          zone: name,
          src: null
        });
      } else {
        await edit({
          action: "zone-text",
          slide: slide.deckIndex,
          zone: name,
          text: "",
          origin: slide.zoneOrigins?.[name]
        });
      }
    }
    if (shapes.length) {
      await sendSvgOps(
        shapes.map((s) => ({
          sel: s,
          ops: [{ kind: "delete", loc: s.loc }]
        })),
        "Delete"
      );
    }
    clearSelection();
  }
  async function duplicateSelection() {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (!sels.length) return;
    const k = 1 / (scale() || 1);
    const off2 = Math.round(24 * Math.max(1, k * 0.5));
    await sendSvgOps(
      sels.map((s, i) => ({
        sel: s,
        ops: [
          {
            kind: "duplicate",
            loc: s.loc,
            offset: [off2, off2],
            key: `dup${i}`
          }
        ]
      })),
      "Duplicate"
    );
  }
  async function groupSelection() {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (sels.length < 2) return;
    const key = sels[0].key;
    const parent = sels[0].el.parentElement;
    if (sels.some((s) => s.key !== key || s.el.parentElement !== parent)) {
      toast(
        "Only objects side by side in the same file can be grouped",
        "error"
      );
      return;
    }
    await sendSvgOps(
      [
        {
          sel: sels[0],
          ops: [{ kind: "group", locs: sels.map((s) => s.loc) }]
        }
      ],
      "Group"
    );
  }
  async function ungroupSelection() {
    const s = ed.selection[0];
    if (s?.el.localName !== "g" || !canTransform(s.el)) return;
    await sendSvgOps(
      [{ sel: s, ops: [{ kind: "ungroup", loc: s.loc }] }],
      "Ungroup"
    );
  }
  async function order(to) {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (!sels.length) return;
    await sendSvgOps(
      sels.map((s) => ({ sel: s, ops: [{ kind: "order", loc: s.loc, to }] })),
      "Arrange"
    );
  }
  function present() {
    const slide = currentSlide();
    const n = (slide?.visibleIndex ?? 0) + 1;
    window.open(`/#slide=${n}`, "inkflow-present");
  }
  function toggleTheme() {
    const root2 = document.documentElement;
    root2.dataset.theme = root2.dataset.theme === "light" ? "" : "light";
    render();
  }
  function setLayoutMode(on2) {
    ed.layoutMode = on2;
    document.body.classList.toggle("layout-mode", on2);
    $("btn-layout").classList.toggle("on", on2);
    enterGroup(null);
    clearSelection();
    drawOverlay();
    emit("layout-mode");
    if (on2) toast("Layout mode: edits change the shared layout files");
  }
  function renderStepSelect() {
    const sel = $("step-select");
    const svg = slideRoot();
    const max = svg ? maxStep(svg) : 0;
    sel.innerHTML = "";
    sel.append(new Option("All objects", ""));
    for (let i = 0; i <= max; i++)
      sel.append(new Option(`Build step ${i}`, String(i)));
    sel.value = ed.step == null ? "" : String(Math.min(ed.step, max));
    sel.disabled = max === 0 && ed.step == null;
  }
  function updateZoomLabel() {
    $("zoom-label").textContent = `${Math.round(scale() * 100)}%`;
  }
  function updateHistory() {
    $("btn-undo").disabled = !ed.canUndo;
    $("btn-redo").disabled = !ed.canRedo;
  }
  function updateTools() {
    document.querySelectorAll("[data-tool]").forEach((b) => {
      b.classList.toggle("on", b.dataset.tool === ed.tool);
    });
  }
  var TOOL_KEYS = {
    v: "select",
    t: "text",
    r: "rect",
    o: "ellipse",
    l: "line",
    a: "arrow"
  };
  function onKey(e) {
    const target = e.target;
    if (target.closest("input, textarea, select, [contenteditable]") || isEditingText()) {
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.toLowerCase();
    const handled = () => e.preventDefault();
    if (mod && lower === "z") {
      handled();
      void (e.shiftKey ? redo() : undo());
    } else if (mod && lower === "y") {
      handled();
      void redo();
    } else if (mod && lower === "a") {
      handled();
      selectAll();
    } else if (mod && lower === "d") {
      handled();
      void duplicateSelection();
    } else if (mod && lower === "c") {
      handled();
      if (ed.focus === "sorter") void copySlides();
      else copy();
    } else if (mod && lower === "x") {
      handled();
      if (ed.focus === "sorter") void cutSlides();
      else cut();
    } else if (mod && lower === "g") {
      handled();
      void (e.shiftKey ? ungroupSelection() : groupSelection());
    } else if (mod && lower === "m") {
      handled();
      void openGallery({ mode: "insert", after: ed.current });
    } else if (mod && key === "Enter") {
      handled();
      present();
    } else if (mod && (key === "ArrowUp" || key === "ArrowDown")) {
      handled();
      const up = key === "ArrowUp";
      void order(
        e.shiftKey ? up ? "front" : "back" : up ? "forward" : "backward"
      );
    } else if ((key === "Delete" || key === "Backspace") && ed.focus === "sorter") {
      handled();
      void deleteSlides();
    } else if (key === "Delete" || key === "Backspace") {
      if (ed.selection.length) {
        handled();
        void deleteSelection();
      }
    } else if (key.startsWith("Arrow") && ed.selection.length) {
      handled();
      const d = e.shiftKey ? 10 : 1;
      const dx = key === "ArrowLeft" ? -d : key === "ArrowRight" ? d : 0;
      const dy = key === "ArrowUp" ? -d : key === "ArrowDown" ? d : 0;
      void nudge(dx, dy);
    } else if (key === "PageDown" || key === "ArrowDown" && !ed.selection.length) {
      handled();
      gotoSlide(ed.current + 1);
    } else if (key === "PageUp" || key === "ArrowUp" && !ed.selection.length) {
      handled();
      gotoSlide(ed.current - 1);
    } else if (ed.cropMode && (key === "Escape" || key === "Enter")) {
      handled();
      setCropMode(false);
    } else if (key === "Escape") {
      if (ed.tool !== "select") setTool("select");
      else if (ed.scope) enterGroup(null);
      else clearSelection();
    } else if (key === "Enter" && ed.selection.length === 1) {
      handled();
      const el = ed.selection[0].el;
      emit(
        isZone(el) ? "edit-zone" : el.localName === "text" ? "edit-text" : "noop"
      );
      if (el.localName === "g") enterGroup(el);
    } else if (!mod && (key === "+" || key === "=")) {
      setZoom(scale() * 1.25);
    } else if (!mod && key === "-") {
      setZoom(scale() / 1.25);
    } else if (!mod && key === "0") {
      setZoom(0);
    } else if (!mod && !e.altKey && lower in TOOL_KEYS) {
      setTool(TOOL_KEYS[lower]);
    } else if (!mod && lower === "i") {
      void (e.shiftKey ? insertVideo() : insertImage());
    }
  }
  function initToolbar() {
    $("btn-undo").addEventListener("click", () => void undo());
    $("btn-redo").addEventListener("click", () => void redo());
    document.querySelectorAll("[data-tool]").forEach((b) => {
      b.addEventListener("click", () => setTool(b.dataset.tool));
    });
    $("btn-image").addEventListener("click", () => void insertImage());
    $("btn-video").addEventListener("click", () => void insertVideo());
    $("zoom-in").addEventListener("click", () => setZoom(scale() * 1.25));
    $("zoom-out").addEventListener("click", () => setZoom(scale() / 1.25));
    $("zoom-fit").addEventListener("click", () => setZoom(0));
    $("btn-layout").addEventListener(
      "click",
      () => setLayoutMode(!ed.layoutMode)
    );
    $("btn-theme").addEventListener("click", toggleTheme);
    $("btn-present").addEventListener("click", present);
    $("step-select").addEventListener("change", (e) => {
      const v = e.target.value;
      ed.step = v === "" ? null : Number(v);
      document.body.classList.toggle("previewing", ed.step != null);
      render();
      emit("step");
    });
    document.addEventListener("keydown", onKey);
    on("render", renderStepSelect);
    on("render", updateZoomLabel);
    on("zoom", updateZoomLabel);
    on("history", updateHistory);
    on("tool", updateTools);
    on("delete", () => void deleteSelection());
    on("duplicate", () => void duplicateSelection());
    on("group", () => void groupSelection());
    on("ungroup", () => void ungroupSelection());
    on("align", () => alignSelection("center"));
    on("slide-duplicate", () => void duplicateSlide());
    on("slide-delete", () => void deleteSlide());
    window.addEventListener("resize", layoutPaper);
    updateHistory();
    updateTools();
  }

  // src/ts/editor/main.ts
  var INITIAL_MODEL = __MODEL_JSON__;
  var INITIAL_SLIDES = __SLIDES_JSON__;
  var WS_PORT = __WS_PORT__;
  var INITIAL_ERROR = __ERROR_JSON__;
  var errorBox = document.getElementById("build-error");
  function showError() {
    errorBox.textContent = ed.error ?? "";
    errorBox.classList.toggle("show", !!ed.error);
  }
  function editTextOf(el) {
    const slide = currentSlide();
    const loc = el.getAttribute("data-ink");
    if (!slide || !loc) return;
    const key = parseInt(loc.split(":")[0] ?? "", 10);
    const src = slide.sources?.[key];
    if (!src?.writable) {
      toast(
        "This text lives in a layout; switch to layout mode to edit it",
        "error"
      );
      return;
    }
    editSvgText(el, src.path, () => slide.sources?.[key]?.hash ?? "", loc);
  }
  function readHash() {
    const m = location.hash.match(/slide=(\d+)/);
    if (!m || !ed.model) return;
    const n = Number(m[1]);
    const s = ed.model.slides.find((x) => x.visibleIndex === n - 1);
    if (s) ed.current = s.deckIndex;
  }
  function writeHash() {
    const s = currentSlide();
    if (s?.visibleIndex == null) return;
    const hash = `#slide=${s.visibleIndex + 1}`;
    if (location.hash !== hash) {
      try {
        history.replaceState(null, "", hash);
      } catch {
      }
    }
  }
  function selectPending() {
    if (!afterRender.ids.length) return;
    const svg = slideRoot();
    if (!svg) return;
    const els = afterRender.ids.map((id) => svg.querySelector(`[id="${CSS.escape(id)}"]`)).filter(
      (el) => el instanceof SVGGraphicsElement
    );
    if (!els.length) return;
    const editText = afterRender.editText;
    afterRender.ids = [];
    afterRender.editText = false;
    select(els);
    if (editText && els[0].localName === "text") editTextOf(els[0]);
    else if (editText && isZone(els[0])) {
      editZone(zoneName(els[0]), els[0], { selectAll: true });
    }
  }
  function boot() {
    ed.model = INITIAL_MODEL;
    ed.slides = INITIAL_SLIDES;
    ed.error = INITIAL_ERROR;
    readHash();
    hooks.editText = editTextOf;
    hooks.editZone = (zone, el, at) => editZone(zone, el, { at });
    hooks.editingHost = editingHost;
    hooks.crop = (el) => {
      const sel = ed.selection.find((s) => s.el === el);
      if (sel) void startCrop(sel);
    };
    hooks.finishEditing = () => void finishTextEdit();
    initCanvas();
    initInsert();
    initSorter();
    initProps();
    initObjects();
    initNotes();
    initToolbar();
    initContext();
    initGallery();
    initDialog();
    initTheme();
    on("slide", () => {
      void finishTextEdit();
      render();
      writeHash();
    });
    on("render", selectPending);
    on("selection", () => {
      const one = ed.selection.length === 1 ? ed.selection[0].el : null;
      if (ed.cropMode && !(one && isCropped(one))) setCropMode(false);
    });
    on("error", showError);
    on("edit-zone", () => {
      const el = ed.selection[0]?.el;
      if (el && isZone(el)) editZone(zoneName(el), el);
    });
    on("edit-text", () => {
      const el = ed.selection[0]?.el;
      if (el?.localName === "text") editTextOf(el);
    });
    window.addEventListener("hashchange", () => {
      const before = ed.current;
      readHash();
      if (ed.current !== before) emit("slide");
    });
    showError();
    renderSorter();
    render();
    writeHash();
    if (WS_PORT != null) connect(WS_PORT);
  }
  boot();
})();
