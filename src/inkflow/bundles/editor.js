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
    }).filter((n2) => Number.isFinite(n2));
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
        const name2 = style[i];
        props[kebabToCamel(name2)] = style.getPropertyValue(name2).trim();
      }
      for (const offset of parseOffsets(kf.keyText)) {
        frames.push({ offset, ...props });
      }
    }
    frames.sort((a, b) => a.offset - b.offset);
    return frames;
  }
  function findKeyframes(name2, rules) {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSKeyframesRule) {
        if (rule.name === name2) return rule;
        continue;
      }
      const grouping = rule;
      if (grouping.cssRules) {
        const found = findKeyframes(name2, grouping.cssRules);
        if (found) return found;
      }
    }
    return null;
  }
  function templateFor(name2) {
    const cached = templates.get(name2);
    if (cached !== void 0) return cached;
    let result = null;
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      const rule = findKeyframes(name2, rules);
      if (rule) {
        result = ruleToKeyframes(rule);
        break;
      }
    }
    templates.set(name2, result);
    return result;
  }
  var VAR_ANIM = /var\(\s*--anim-([\w-]+)\s*(?:,[^()]*)?\)/g;
  function substituteVars(value, vars) {
    return value.replace(
      VAR_ANIM,
      (match, key) => key in vars ? vars[key] : match
    );
  }
  function buildKeyframes(name2, vars) {
    const template = templateFor(name2);
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
  function parseCues(el2) {
    const raw = el2.getAttribute("data-cues");
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  function cueStates(el2) {
    let states = elementCues.get(el2);
    if (!states) {
      states = parseCues(el2).map((cue) => ({ cue, anim: null }));
      elementCues.set(el2, states);
    }
    return states;
  }
  function effectEndMs(cue) {
    const { duration, delay, iterations } = cue.opts;
    return Math.max(0, delay) * 1e3 + Math.max(0, duration) * (iterations ?? 1) * 1e3;
  }
  function ensureAnim(el2, st) {
    if (!st.anim) {
      const { name: name2, vars, opts: opts2 } = st.cue;
      const anim = el2.animate(buildKeyframes(`anim-${name2}`, vars), {
        duration: Math.max(0, opts2.duration * 1e3),
        delay: Math.max(0, opts2.delay * 1e3),
        easing: opts2.easing || "linear",
        iterations: opts2.iterations ?? 1,
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
  function buildStepRun(root2, fromStep, toStep) {
    const forward = toStep >= fromStep;
    const runStep = Math.max(fromStep, toStep);
    const items = [];
    root2.querySelectorAll("[data-cues]").forEach((el2) => {
      for (const st of cueStates(el2)) {
        if (st.cue.step !== runStep) continue;
        const anim = ensureAnim(el2, st);
        anim.pause();
        items.push({
          anim,
          offsetMs: Math.max(0, st.cue.offset) * 1e3,
          spanMs: effectEndMs(st.cue)
        });
      }
    });
    const totalMs = items.reduce(
      (m, it) => Math.max(m, it.offsetMs + it.spanMs),
      0
    );
    return { items, totalMs, forward, toStep };
  }
  function seekStepRun(run, value) {
    const runTimeMs = value * run.totalMs;
    for (const it of run.items) {
      it.anim.currentTime = Math.min(
        Math.max(runTimeMs - it.offsetMs, 0),
        it.spanMs
      );
    }
  }
  function applyCodeHighlights(root2, step) {
    root2.querySelectorAll(
      ".inkflow-codeblock[data-hl-spec][data-base-step]"
    ).forEach((block) => {
      const spec = JSON.parse(block.dataset.hlSpec);
      const baseStep = +(block.dataset.baseStep ?? "0");
      const specIdx = Math.min(Math.max(step - baseStep, 0), spec.length - 1);
      const active3 = spec[specIdx];
      const hasHL = active3 !== null;
      block.querySelectorAll(".code-line").forEach((line) => {
        const n2 = +(line.dataset.line ?? "0");
        line.classList.toggle("hl-active", hasHL && active3.includes(n2));
        line.classList.toggle("hl-dim", hasHL && !active3.includes(n2));
        if (!hasHL) line.classList.remove("hl-active", "hl-dim");
      });
    });
  }
  function maxStep(root2) {
    let m = 0;
    root2.querySelectorAll("[data-cues]").forEach((el2) => {
      for (const c of parseCues(el2)) if (c.step > m) m = c.step;
    });
    root2.querySelectorAll("[data-play-on-step]").forEach((el2) => {
      const s = +(el2.getAttribute("data-play-on-step") ?? "0");
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
    root2.querySelectorAll("[data-cues]").forEach((el2) => {
      const states = cueStates(el2);
      const actions = restingActions(
        states.map((s) => s.cue),
        step
      );
      states.forEach((st, i) => {
        if (actions[i] === "hold") holdAtEnd(ensureAnim(el2, st));
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
    const valid = parts.length === 4 && parts.every((n2) => Number.isFinite(n2)) && parts[2] > 0 && parts[3] > 0;
    const [x, y, w, h2] = valid ? parts : fallback.split(/[\s,]+/).map(Number);
    return { x, y, w, h: h2 };
  }

  // src/ts/editor/connectors.ts
  var SIDES = ["top", "right", "bottom", "left"];
  var MAX_SITES = 9;
  function siteName(side, t) {
    return Math.abs(t - 0.5) < 1e-9 ? side : `${side}@${Math.round(t * 1e3) / 1e3}`;
  }
  function parseSite(name2) {
    const [side, frac] = name2.split("@");
    if (!SIDES.includes(side)) return null;
    const t = frac === void 0 ? 0.5 : Number(frac);
    return Number.isFinite(t) && t >= 0 && t <= 1 ? { side, t } : null;
  }
  function siteOnCorners(c, side, t, round = false) {
    const along = {
      top: [t, 0],
      right: [1, t],
      bottom: [1 - t, 1],
      left: [0, 1 - t]
    };
    let [u, v] = along[side];
    if (round) {
      const off2 = Math.sqrt(Math.max(0, 0.25 - (t - 0.5) ** 2));
      if (side === "top") v = 0.5 - off2;
      else if (side === "bottom") v = 0.5 + off2;
      else if (side === "right") u = 0.5 + off2;
      else u = 0.5 - off2;
    }
    const ex = { x: c[1].x - c[0].x, y: c[1].y - c[0].y };
    const ey = { x: c[3].x - c[0].x, y: c[3].y - c[0].y };
    const x = c[0].x + u * ex.x + v * ey.x;
    const y = c[0].y + u * ex.y + v * ey.y;
    const i = SIDES.indexOf(side);
    const a = c[i];
    const b = c[(i + 1) % 4];
    let nx = b.y - a.y;
    let ny = -(b.x - a.x);
    const centre = {
      x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4,
      y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4
    };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (nx * (mid.x - centre.x) + ny * (mid.y - centre.y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const len = Math.hypot(nx, ny) || 1;
    const clean = (n2) => Math.abs(n2) < 1e-12 ? 0 : n2;
    return {
      name: siteName(side, t),
      x,
      y,
      dx: clean(nx / len),
      dy: clean(ny / len)
    };
  }
  function sitesFromCorners(c, perSide = 1, round = false) {
    const n2 = Math.max(1, Math.min(MAX_SITES, Math.round(perSide)));
    return SIDES.flatMap(
      (side) => Array.from(
        { length: n2 },
        (_, k) => siteOnCorners(c, side, (k + 1) / (n2 + 1), round)
      )
    );
  }
  function siteByName(c, name2, round = false) {
    const s = parseSite(name2);
    return s ? siteOnCorners(c, s.side, s.t, round) : null;
  }
  function nearestSite(sites, p, within) {
    let best2 = null;
    let bestD = within;
    for (const s of sites) {
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d <= bestD) {
        best2 = s;
        bestD = d;
      }
    }
    return best2;
  }
  function direction(end, other) {
    if (end.dx !== void 0 && end.dy !== void 0) {
      return { x: end.dx, y: end.dy };
    }
    const dx = other.x - end.x;
    const dy = other.y - end.y;
    return Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) || 1 };
  }
  function horizontal(d) {
    return Math.abs(d.x) >= Math.abs(d.y);
  }
  function parseBend(value) {
    const m = /^([xy]):(-?\d*\.?\d+(?:e[-+]?\d+)?)$/i.exec(value ?? "");
    if (!m) return null;
    const at2 = Number(m[2]);
    return Number.isFinite(at2) ? { axis: m[1], at: at2 } : null;
  }
  function formatBend(b) {
    return `${b.axis}:${Math.round(b.at * 100) / 100}`;
  }
  var STUB = 30;
  function route(style, a, b, bend = null) {
    if (style === "curved") {
      const da = direction(a, b);
      const db = direction(b, a);
      const k = Math.max(30, Math.hypot(b.x - a.x, b.y - a.y) * 0.4);
      return {
        curve: true,
        points: [
          { x: a.x, y: a.y },
          { x: a.x + da.x * k, y: a.y + da.y * k },
          { x: b.x + db.x * k, y: b.y + db.y * k },
          { x: b.x, y: b.y }
        ]
      };
    }
    if (style === "straight") {
      return {
        curve: false,
        points: [a, b].map((p) => ({ x: p.x, y: p.y }))
      };
    }
    return elbow(a, b, bend);
  }
  function elbow(a, b, bend) {
    const da = direction(a, b);
    const db = direction(b, a);
    const ha = horizontal(da);
    const hb = horizontal(db);
    let axis;
    let fallback;
    let build2;
    if (ha === hb) {
      axis = ha ? "x" : "y";
      const pa = ha ? a.x : a.y;
      const pb = ha ? b.x : b.y;
      const sa = Math.sign(ha ? da.x : da.y);
      const sb = Math.sign(ha ? db.x : db.y);
      fallback = sa === sb ? sa > 0 ? Math.max(pa, pb) + STUB : Math.min(pa, pb) - STUB : (pa + pb) / 2;
      build2 = (m) => ha ? {
        pts: [a, { x: m, y: a.y }, { x: m, y: b.y }, b],
        mid: { x: m, y: (a.y + b.y) / 2 }
      } : {
        pts: [a, { x: a.x, y: m }, { x: b.x, y: m }, b],
        mid: { x: (a.x + b.x) / 2, y: m }
      };
    } else if (ha) {
      axis = "x";
      fallback = b.x;
      const k = b.y + Math.sign(db.y || 1) * STUB;
      build2 = (m) => ({
        pts: [a, { x: m, y: a.y }, { x: m, y: k }, { x: b.x, y: k }, b],
        mid: { x: m, y: (a.y + k) / 2 }
      });
    } else {
      axis = "y";
      fallback = b.y;
      const k = b.x + Math.sign(db.x || 1) * STUB;
      build2 = (m) => ({
        pts: [a, { x: a.x, y: m }, { x: k, y: m }, { x: k, y: b.y }, b],
        mid: { x: (a.x + k) / 2, y: m }
      });
    }
    const at2 = bend && bend.axis === axis ? bend.at : fallback;
    const { pts, mid } = build2(at2);
    return {
      curve: false,
      points: simplify(pts.map((p) => ({ x: p.x, y: p.y }))),
      bend: { axis, at: at2, mid }
    };
  }
  function simplify(pts) {
    const out = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-6) continue;
      out.push(p);
      while (out.length >= 3) {
        const [p0, p1, p2] = out.slice(-3);
        const ux = p1.x - p0.x;
        const uy = p1.y - p0.y;
        const vx = p2.x - p1.x;
        const vy = p2.y - p1.y;
        if (Math.abs(ux * vy - uy * vx) < 1e-6 && ux * vx + uy * vy > 0) {
          out.splice(out.length - 2, 1);
        } else break;
      }
    }
    return out;
  }
  function n(v) {
    return String(Math.round(v * 100) / 100);
  }
  function pathData(r) {
    const [first, ...rest] = r.points;
    const head = `M${n(first.x)},${n(first.y)}`;
    if (r.curve) {
      return `${head} C${rest.map((p) => `${n(p.x)},${n(p.y)}`).join(" ")}`;
    }
    return `${head} ${rest.map((p) => `L${n(p.x)},${n(p.y)}`).join(" ")}`;
  }
  function endpointsOf(d) {
    const nums = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    if (nums.length < 4 || nums.some((v) => !Number.isFinite(v))) return null;
    return {
      start: { x: nums[0], y: nums[1] },
      end: { x: nums[nums.length - 2], y: nums[nums.length - 1] }
    };
  }
  function parseConnection(value) {
    if (!value) return null;
    const i = value.lastIndexOf(":");
    const site = value.slice(i + 1);
    if (i <= 0 || !parseSite(site)) return null;
    return { id: value.slice(0, i), site };
  }

  // src/ts/editor/dom.ts
  function h(tag, attrs2 = {}, ...children2) {
    const el2 = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs2)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el2.addEventListener(k.slice(2), v);
      } else if (k === "value" && "value" in el2) {
        el2.value = String(v);
      } else if (v === true) {
        el2.setAttribute(k, "");
      } else {
        el2.setAttribute(k, String(v));
      }
    }
    for (const c of children2) {
      if (c == null || c === false) continue;
      el2.append(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el2;
  }
  function clear(el2) {
    while (el2.firstChild) el2.removeChild(el2.firstChild);
  }
  var SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs2 = {}) {
    const el2 = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs2)) el2.setAttribute(k, String(v));
    return el2;
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
  function icon(name2, size3 = 16) {
    const wrap2 = document.createElement("span");
    wrap2.innerHTML = `<svg viewBox="0 0 16 16" width="${size3}" height="${size3}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name2] ?? ""}</svg>`;
    return wrap2.firstElementChild;
  }
  var toastTimer = 0;
  function toast(message, kind = "info") {
    const el2 = document.getElementById("toast");
    if (!el2) return;
    el2.textContent = message;
    el2.className = `show ${kind}`;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(
      () => {
        el2.className = "";
      },
      kind === "error" ? 6e3 : 2600
    );
  }

  // src/ts/editor/drawioshapes.ts
  function diagramShapes(svg) {
    const shapes = [];
    for (const g of svg.querySelectorAll("g[data-cell-id]")) {
      const parent = g.parentElement?.closest("g[data-cell-id]");
      if (!parent?.parentElement?.closest("g[data-cell-id]")) continue;
      const id = g.getAttribute("id");
      if (id) shapes.push({ id, label: cellLabel(g), el: g });
    }
    return shapes;
  }
  function cellLabel(g) {
    const own = (sel) => [...g.querySelectorAll(sel)].filter(
      (el2) => el2.closest("g[data-cell-id]") === g
    );
    for (const el2 of [...own("foreignObject"), ...own("text")]) {
      const text = (el2.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    return "";
  }
  function attachableCell(el2) {
    const cell = el2?.closest('g[data-cell-kind="vertex"][id]');
    return cell?.closest("svg[data-drawio]") ? cell : null;
  }
  function attachableCells(svg) {
    return [
      ...svg.querySelectorAll('g[data-cell-kind="vertex"][id]')
    ];
  }
  function cellShape(cell) {
    for (const kid of cell.children) {
      if (kid.hasAttribute("data-cell-id")) continue;
      if (kid.querySelector("foreignObject, text, switch")) continue;
      return kid;
    }
    return cell;
  }
  function shapesEditable(diagram) {
    return diagram.getAttribute("inkflow:drawio-edit") === "shapes";
  }
  function isDiagramCell(el2) {
    return el2.localName === "g" && el2.getAttribute("data-cell-kind") === "vertex" && el2.hasAttribute("data-ink") && !!el2.closest("svg[data-drawio]");
  }
  function median(values) {
    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }
  function boxIn(el2, ref) {
    const g = el2;
    const from = g.getScreenCTM?.();
    const to = ref.getScreenCTM?.();
    if (!from || !to || typeof g.getBBox !== "function") return null;
    const m = to.inverse().multiply(from);
    const b = g.getBBox();
    const pts = [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x, b.y + b.height],
      [b.x + b.width, b.y + b.height]
    ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys)
    };
  }
  function pageOffset(diagram) {
    const xs = [];
    const ys = [];
    for (const cell of diagram.querySelectorAll(
      'g[data-cell-kind="vertex"][data-cell-geometry]'
    )) {
      const geo = (cell.getAttribute("data-cell-geometry") ?? "").split(/\s+/).map(Number);
      const b = boxIn(cellShape(cell), cell);
      if (!b || geo.length !== 4 || geo.some((v) => !Number.isFinite(v)))
        continue;
      xs.push(b.x - geo[0]);
      ys.push(b.y - geo[1]);
    }
    return xs.length ? { x: median(xs), y: median(ys) } : null;
  }
  function pageBox(cell, offset) {
    const parent = cell.parentElement;
    const b = parent ? boxIn(cellShape(cell), parent) : null;
    if (!b) return null;
    const r = (v) => Math.round(v * 100) / 100;
    return {
      x: r(b.x - offset.x),
      y: r(b.y - offset.y),
      width: r(b.width),
      height: r(b.height)
    };
  }
  function drawnBox(cell, root2) {
    return boxIn(cellShape(cell), root2);
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
  function fmt(n2) {
    const r = Math.round(n2 * 1e3) / 1e3;
    return Object.is(r, -0) ? "0" : String(r);
  }
  function formatTransform(m) {
    if (isTranslateOnly(m)) {
      if (Math.abs(m.e) < EPS && Math.abs(m.f) < EPS) return null;
      return `translate(${fmt(m.e)},${fmt(m.f)})`;
    }
    const r = (n2) => String(Math.round(n2 * 1e6) / 1e6);
    return `matrix(${r(m.a)},${r(m.b)},${r(m.c)},${r(m.d)},${fmt(m.e)},${fmt(m.f)})`;
  }
  var BOX_TAGS = /* @__PURE__ */ new Set(["rect", "image", "foreignObject", "use", "svg"]);
  function num(v, fallback = 0) {
    const n2 = parseFloat(v ?? "");
    return Number.isFinite(n2) ? n2 : fallback;
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
    if (vb.length !== 4 || vb.some((n2) => !Number.isFinite(n2))) return null;
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
  function projectFile(ref, base2) {
    if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("_theme/"))
      return null;
    if (ref.startsWith("/")) return ref;
    const parts = base2 ? base2.split("/").slice(0, -1) : [];
    for (const part of ref.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return parts.join("/");
  }

  // src/ts/shared/deck-styles.ts
  function applyDeckStyles(msg) {
    if (msg.styles !== void 0) {
      const el2 = document.getElementById("deck-styles");
      if (el2) el2.textContent = msg.styles;
    }
    if (msg.mode !== void 0)
      document.documentElement.dataset.theme = msg.mode;
  }

  // src/ts/editor/state.ts
  var CONNECTOR_TOOLS = {
    line: "straight",
    arrow: "straight",
    elbow: "elbow",
    curve: "curved"
  };
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
  function connected() {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }
  var stopped = false;
  function stopReconnecting() {
    stopped = true;
  }
  var waiting = [];
  function whenConnected() {
    if (connected()) return Promise.resolve();
    return new Promise((resolve) => waiting.push(resolve));
  }
  function connect(port) {
    const host4 = location.hostname || "localhost";
    const sock = new WebSocket(`ws://${host4}:${port}`);
    ws = sock;
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: "hello", role: "editor" }));
      document.body.classList.remove("offline");
      for (const resolve of waiting) resolve();
      waiting = [];
    };
    sock.onclose = () => {
      document.body.classList.add("offline");
      for (const resolve of pending.values()) {
        resolve({ ok: false, error: "disconnected from the server" });
      }
      pending.clear();
      if (!stopped) window.setTimeout(() => connect(port), 1500);
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
          if (document.body.classList.contains("start-mode") || ed.model && msg.model.deckPath !== ed.model.deckPath) {
            location.assign("/edit");
            return;
          }
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
  async function edit(req, opts2 = {}) {
    const result = await request(req);
    if (!result.ok && !(opts2.retrying && TRANSIENT.test(result.error ?? ""))) {
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
  function best(edges, targets2, threshold) {
    let delta = 0;
    let dist = threshold + 1;
    for (const e of edges) {
      for (const t of targets2) {
        const d = Math.abs(t - e);
        if (d < dist - 1e-9) {
          dist = d;
          delta = t - e;
        }
      }
    }
    if (dist > threshold) return { delta: 0, at: [] };
    const at2 = /* @__PURE__ */ new Set();
    for (const e of edges) {
      for (const t of targets2) {
        if (Math.abs(t - (e + delta)) < 1e-6) at2.add(t);
      }
    }
    return { delta, at: [...at2] };
  }
  function snapBox(box, targets2, threshold) {
    const x = best(
      [box.x, box.x + box.width / 2, box.x + box.width],
      targets2.xs,
      threshold
    );
    const y = best(
      [box.y, box.y + box.height / 2, box.y + box.height],
      targets2.ys,
      threshold
    );
    return { dx: x.delta, dy: y.delta, guidesX: x.at, guidesY: y.at };
  }
  function snapEdges(edgesX, edgesY, targets2, threshold) {
    const x = best(edgesX, targets2.xs, threshold);
    const y = best(edgesY, targets2.ys, threshold);
    return { dx: x.delta, dy: y.delta, guidesX: x.at, guidesY: y.at };
  }
  function distribute(boxes, axis) {
    const size3 = axis === "x" ? "width" : "height";
    const order2 = boxes.map((b, i) => ({ b, i })).sort((p, q) => p.b[axis] - q.b[axis]);
    const out = boxes.map((b) => b[axis]);
    if (order2.length < 3) return out;
    const first = order2[0].b;
    const last = order2[order2.length - 1].b;
    const total = order2.reduce((s, o) => s + o.b[size3], 0);
    const span = last[axis] + last[size3] - first[axis];
    const gap = (span - total) / (order2.length - 1);
    let pos = first[axis];
    for (const o of order2) {
      out[o.i] = pos;
      pos += o.b[size3] + gap;
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
    // Opens a draw.io diagram's editor; false when the picture is not one.
    diagram: (_el) => false,
    // A diagram shape's label, to be edited (its panel's Label field).
    cellLabel: (_el) => {
    },
    // Shapes of this drawn diagram were edited in its source (`step`: the
    // undo step): draw.io redraws its picture into that step.
    diagramEdited: (_diagram, _step) => {
    },
    typeInto: (_el) => {
    },
    zoneMedia: (_zone) => {
    },
    zoneText: (_zone) => {
    },
    // Select these ids once the rebuild that holds them has rendered.
    selectAfterRender: (_ids) => {
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
      const el2 = findElement(k, trustLoc);
      if (el2 && selectable(el2)) addToSelection(el2, false);
    }
    layoutPaper();
    emit("render");
    emit("selection");
  }
  function findElement(k, trustLoc) {
    const svg = slideRoot();
    if (!svg) return null;
    if (k.id) {
      const byId2 = svg.querySelector(`[id="${CSS.escape(k.id)}"]`);
      if (byId2?.hasAttribute("data-ink")) return byId2;
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
      v.removeAttribute("controls");
      v.controls = false;
      const start = parseFloat(v.dataset.start ?? "");
      if (start > 0) v.currentTime = start;
    });
    if (ed.step == null) {
      svg.querySelectorAll(".anim-pending").forEach((el2) => {
        el2.classList.remove("anim-pending");
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
  function measure(el2) {
    const g = el2;
    if (typeof g.getBBox !== "function") return null;
    if (isDiagramCell(el2)) {
      const shape = cellShape(el2);
      const a = shape.getScreenCTM?.();
      const c = g.getScreenCTM();
      if (shape !== el2 && a && c) {
        const m = c.inverse().multiply(a);
        const b2 = shape.getBBox();
        const pts = [
          [b2.x, b2.y],
          [b2.x + b2.width, b2.y],
          [b2.x, b2.y + b2.height],
          [b2.x + b2.width, b2.y + b2.height]
        ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        return {
          bbox: {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys)
          },
          ctm: c
        };
      }
    }
    if (el2.localName === "svg" && el2 !== slideRoot()) {
      const s = el2;
      const ctm2 = el2.parentElement?.getScreenCTM?.();
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
  function slideBox(el2) {
    try {
      const m = measure(el2);
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
    "viewBox",
    // A connector's route and its attachments.
    "d",
    "inkflow:connect-start",
    "inkflow:connect-end",
    "inkflow:bend"
  ];
  function elementGeom(el2) {
    const parent = el2.parentElement;
    const parentCTM = parent?.getScreenCTM?.();
    const attrs2 = {};
    for (const a of GEOM_ATTRS) attrs2[a] = el2.getAttribute(a);
    let box = { x: 0, y: 0, width: 0, height: 0 };
    try {
      box = measure(el2)?.bbox ?? box;
    } catch {
    }
    return {
      tag: el2.localName,
      sourceTag: el2.getAttribute("data-ink-tag") ?? el2.localName,
      attrs: attrs2,
      own: parseTransform(el2.getAttribute("transform")),
      parentToSlide: parentCTM ? multiply(invert(rootCTM()), mat(parentCTM)) : { ...IDENTITY },
      localBox: box
    };
  }
  function isZone(el2) {
    const id = el2.getAttribute("id") ?? "";
    return id.startsWith("zone-") && !NON_ZONES.has(id);
  }
  function zoneName(el2) {
    return (el2.getAttribute("id") ?? "").replace(/^zone-/, "");
  }
  function mediaZoneAt(clientX, clientY) {
    const inside = (r) => clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    for (const el2 of overlay.querySelectorAll("[data-media-zone]")) {
      if (inside(el2.getBoundingClientRect()))
        return el2.getAttribute("data-media-zone");
    }
    const slide = currentSlide();
    const svg = slideRoot();
    if (!slide || !svg) return null;
    for (const el2 of svg.querySelectorAll('[id^="zone-"]')) {
      const name2 = zoneName(el2);
      const kind = slide.zones[name2]?.kind;
      if ((kind === "image" || kind === "video") && inside(el2.getBoundingClientRect()))
        return name2;
    }
    return null;
  }
  function keyOf(el2) {
    const loc = el2.getAttribute("data-ink") ?? "";
    return parseInt(loc.split(":")[0] ?? "", 10);
  }
  function isLocked(el2) {
    return el2.closest("[data-ink-locked]") !== null;
  }
  function isOwn(el2) {
    const src = sourceOf(keyOf(el2));
    const slide = currentSlide();
    return !!src && src.role === "slide" && !!slide && !slide.srcShared && src.writable;
  }
  function editableCell(el2) {
    const diagram = el2.closest("svg[data-drawio]");
    return isDiagramCell(el2) && !!diagram && shapesEditable(diagram) && canTransform(diagram);
  }
  function selectable(el2) {
    if (!el2.hasAttribute("data-ink") || isLocked(el2)) return false;
    const src = sourceOf(keyOf(el2));
    if (!src) return false;
    if (src.role === "diagram") return src.writable && editableCell(el2);
    if (ed.layoutMode) return src.writable;
    return isOwn(el2) || el2.hasAttribute("data-ink-top") && isZone(el2);
  }
  function canTransform(el2) {
    const src = sourceOf(keyOf(el2));
    if (!src?.writable) return false;
    if (src.role === "diagram") return editableCell(el2);
    return ed.layoutMode || isOwn(el2);
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
  function canTypeInto(el2) {
    if (!["rect", "ellipse", "circle"].includes(el2.localName)) return false;
    if (!canTransform(el2) || ed.layoutMode || !isOwn(el2)) return false;
    return !isZone(el2) || el2.hasAttribute("inkflow:show-shape");
  }
  function isLineLike(el2) {
    return el2.localName === "line" || isConnector(el2);
  }
  function pickByBox(svg, x, y) {
    const pt = clientToSlide(x, y);
    const slide = slideSize();
    const pool = ed.scope ? [...ed.scope.children].filter((el2) => el2.hasAttribute("data-ink")) : [...svg.querySelectorAll("[data-ink-top]")];
    for (let i = pool.length - 1; i >= 0; i--) {
      const el2 = pool[i];
      if (!selectable(el2) || isLineLike(el2)) continue;
      const b = slideBox(el2);
      if (!b || b.width * b.height > slide.width * slide.height * 0.8)
        continue;
      if (pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height) {
        return el2;
      }
    }
    return null;
  }
  function candidatesAt(x, y) {
    const svg = slideRoot();
    if (!svg) return [];
    const out = [];
    const add = (el2) => {
      if (el2 && !out.includes(el2) && selectable(el2)) {
        out.push(el2);
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
      if (isLineLike(pool[i])) continue;
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
    const current2 = ed.selection.length === 1 ? ed.selection[0].el : null;
    let index = near && cycle ? cycle.index + 1 : 0;
    if (!near && current2 && all[0] === current2) index = 1;
    index %= all.length;
    cycle = { x: e.clientX, y: e.clientY, index };
    select([all[index]]);
    if (all.length > 1) {
      const name2 = all[index].getAttribute("id") ?? all[index].localName;
      toast(`${index + 1} of ${all.length} here: ${name2}`);
    }
  }
  function setHover(el2) {
    if (el2 !== hoverEl) {
      hoverEl = el2;
      drawOverlay();
    }
  }
  function toSelected(el2) {
    const loc = el2.getAttribute("data-ink") ?? "";
    return { el: el2, key: keyOf(el2), loc };
  }
  function addToSelection(el2, notify = true) {
    if (ed.selection.some((s) => s.el === el2)) return;
    ed.selection.push(toSelected(el2));
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
    const scope2 = ed.scope ?? svg;
    const els = [...scope2.querySelectorAll("[data-ink]")].filter(
      (el2) => (ed.scope ? el2.parentElement === ed.scope : el2.hasAttribute("data-ink-top")) && selectable(el2) && (canTransform(el2) || ed.scope !== null)
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
  function elementCorners(el2) {
    try {
      const measured = measure(el2);
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
      default:
        return { x: cx, y: cy };
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
    drawSiteHints();
    const transformable = ed.selection.filter((s) => canTransform(s.el));
    const lone = ed.selection.length === 1 ? ed.selection[0].el : null;
    const connector = lone && isConnector(lone) && canTransform(lone) ? lone : null;
    const box = !connector && transformable.length === ed.selection.length ? selectionBox() : null;
    if (connector && ed.step == null) {
      const m = slideToPaper();
      for (const which of ["start", "end"]) {
        const end = connectorEnd(connector, which);
        if (!end) continue;
        const p = apply(m, end);
        const attached = connector.hasAttribute(ENDS[which]);
        const handle = svgEl("circle", {
          cx: p.x,
          cy: p.y,
          r: 6,
          class: `handle endpoint${attached ? " attached" : ""}`
        });
        handle.dataset.handle = `c-${which}`;
        overlay.append(handle);
      }
      const bend = connectorRoute(connector)?.bend;
      if (bend) {
        const p = apply(m, bend.mid);
        const handle = svgEl("rect", {
          x: p.x - 5,
          y: p.y - 5,
          width: 10,
          height: 10,
          transform: `rotate(45 ${p.x} ${p.y})`,
          class: `handle bend ${bend.axis === "x" ? "ew" : "ns"}`
        });
        handle.dataset.handle = "c-bend";
        overlay.append(handle);
      }
    }
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
      const frames = ed.selection.some(
        (s) => s.el.localName === "svg" && !s.el.hasAttribute("data-drawio") || isDiagramCell(s.el)
      );
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
      const label4 = svgEl("text", {
        x: tx + w / 2,
        y: ty + 15,
        "text-anchor": "middle"
      });
      label4.textContent = text;
      g.append(label4);
      const title2 = svgEl("title");
      title2.textContent = media ? `Add an image or video to the ${z.zone} zone` : `Add ${z.zone} text`;
      g.append(title2);
      g.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (media) hooks.zoneMedia(z.zone);
        else hooks.zoneText(z.zone);
      });
      overlay.append(g);
    }
  }
  var CONNECTOR = "inkflow:connector";
  var ENDS = { start: "inkflow:connect-start", end: "inkflow:connect-end" };
  var SNAP_SITE_PX = 14;
  function isConnector(el2) {
    return el2.hasAttribute(CONNECTOR);
  }
  function connectorStyle(el2) {
    const v = el2.getAttribute(CONNECTOR);
    return v === "elbow" || v === "curved" ? v : "straight";
  }
  function toSlideMat(el2) {
    const ctm = el2.getScreenCTM?.();
    return ctm ? multiply(invert(rootCTM()), mat(ctm)) : null;
  }
  var SITES = "inkflow:sites";
  function sitesPerSide(el2) {
    const n2 = Number(el2.getAttribute(SITES) ?? 1);
    return Number.isFinite(n2) ? Math.max(1, Math.min(MAX_SITES, Math.round(n2))) : 1;
  }
  function cornersOf(el2) {
    try {
      const m = measure(attachableCell(el2) ? cellShape(el2) : el2);
      if (!m) return null;
      const toSlide = multiply(invert(rootCTM()), mat(m.ctm));
      const b = m.bbox;
      if (b.width <= 0 && b.height <= 0) return null;
      const tag = el2.getAttribute("data-ink-tag") ?? el2.localName;
      return {
        corners: [
          { x: b.x, y: b.y },
          { x: b.x + b.width, y: b.y },
          { x: b.x + b.width, y: b.y + b.height },
          { x: b.x, y: b.y + b.height }
        ].map((p) => apply(toSlide, p)),
        round: tag === "ellipse" || tag === "circle"
      };
    } catch {
      return null;
    }
  }
  function sitesOf(el2) {
    const c = cornersOf(el2);
    return c ? sitesFromCorners(c.corners, sitesPerSide(el2), c.round) : null;
  }
  function siteOf(el2, name2) {
    const c = cornersOf(el2);
    return c ? siteByName(c.corners, name2, c.round) : null;
  }
  function byId(id) {
    return slideRoot()?.querySelector(`[id="${CSS.escape(id)}"]`) ?? null;
  }
  function attachables(except) {
    const svg = slideRoot();
    if (!svg) return [];
    const pool = ed.scope ? [...ed.scope.children] : [...svg.querySelectorAll("[data-ink-top]")];
    const area2 = slideSize();
    const objects = pool.filter((el2) => {
      if (el2 === except || isConnector(el2) || !el2.hasAttribute("data-ink"))
        return false;
      const b = slideBox(el2);
      return !!b && b.width * b.height < area2.width * area2.height * 0.8;
    });
    const cells = objects.flatMap(
      (el2) => el2.hasAttribute("data-drawio") ? attachableCells(el2) : []
    );
    return [...objects, ...cells];
  }
  function attachTargetAt(x, y, except = null) {
    const svg = slideRoot();
    for (const hit of document.elementsFromPoint(x, y)) {
      if (!svg?.contains(hit)) continue;
      const cell = attachableCell(hit);
      if (cell) return cell;
    }
    return candidatesAt(x, y).find((el2) => el2 !== except && !isConnector(el2)) ?? null;
  }
  function siteAt(p, except) {
    const within = SNAP_SITE_PX / (scale() || 1);
    let best2 = null;
    let bestD = within;
    for (const el2 of attachables(except)) {
      const s = nearestSite(sitesOf(el2) ?? [], p, bestD);
      if (s) {
        best2 = { el: el2, site: s };
        bestD = Math.hypot(s.x - p.x, s.y - p.y);
      }
    }
    return best2;
  }
  var siteHints = [];
  function showSites(hints) {
    siteHints = hints;
    drawOverlay();
  }
  function drawSiteHints() {
    const m = slideToPaper();
    for (const { el: el2, active: active3 } of siteHints) {
      for (const s of sitesOf(el2) ?? []) {
        const p = apply(m, s);
        const on2 = active3?.name === s.name && Math.hypot(active3.x - s.x, active3.y - s.y) < 0.5;
        overlay.append(
          svgEl("circle", {
            cx: p.x,
            cy: p.y,
            r: on2 ? 6 : 4,
            class: `site${on2 ? " on" : ""}`
          })
        );
      }
    }
  }
  function connectorEnd(conn, which) {
    const c = parseConnection(conn.getAttribute(ENDS[which]));
    if (c) {
      const target = byId(c.id);
      const site = target ? siteOf(target, c.site) : null;
      if (site) return site;
    }
    const pts = endpointsOf(conn.getAttribute("d") ?? "");
    const m = toSlideMat(conn);
    if (!pts || !m) return null;
    return apply(m, which === "start" ? pts.start : pts.end);
  }
  function isStale(conn) {
    const pts = endpointsOf(conn.getAttribute("d") ?? "");
    const m = toSlideMat(conn);
    if (!pts || !m) return false;
    for (const which of ["start", "end"]) {
      const c = parseConnection(conn.getAttribute(ENDS[which]));
      const target = c ? byId(c.id) : null;
      const site = c && target ? siteOf(target, c.site) : null;
      if (!site) continue;
      const drawn = apply(m, which === "start" ? pts.start : pts.end);
      if (Math.hypot(drawn.x - site.x, drawn.y - site.y) > 1) return true;
    }
    return false;
  }
  function connectorsTo(id) {
    const svg = slideRoot();
    if (!svg) return [];
    return [
      ...svg.querySelectorAll(`[${CSS.escape(CONNECTOR)}][data-ink]`)
    ].filter(
      (conn) => canTransform(conn) && ["start", "end"].some((w) => {
        const c = parseConnection(conn.getAttribute(ENDS[w]));
        return !!c && (c.id === id || c.id.startsWith(`${id}-`));
      })
    );
  }
  function rerouteConnectors(conns, label4 = "Re-route arrows", coalesce) {
    const plans = conns.flatMap((el2) => {
      const d = connectorPath(el2);
      const sel = toSelected(el2);
      return d ? [{ sel, ops: [{ kind: "attrs", loc: sel.loc, set: { d } }] }] : [];
    });
    return plans.length ? sendSvgOps(plans, label4, coalesce) : null;
  }
  var BEND = "inkflow:bend";
  function connectorRoute(conn, ends = {}, style = connectorStyle(conn), bend = parseBend(conn.getAttribute(BEND))) {
    const a = ends.start ?? connectorEnd(conn, "start");
    const b = ends.end ?? connectorEnd(conn, "end");
    if (!a || !b) return null;
    return route(style, a, b, bend);
  }
  function connectorPath(conn, ends = {}, style = connectorStyle(conn), bend = parseBend(conn.getAttribute(BEND))) {
    const r = connectorRoute(conn, ends, style, bend);
    const toSlide = toSlideMat(conn);
    if (!r || !toSlide) return null;
    const local = invert(toSlide);
    return pathData({ ...r, points: r.points.map((p) => apply(local, p)) });
  }
  function newConnectorPath(style, a, b, parent) {
    const svg = slideRoot();
    const pm = parent?.getScreenCTM?.();
    const local = pm && svg ? multiply(invert(mat(pm)), rootCTM()) : IDENTITY;
    const r = route(style, a, b);
    return pathData({ ...r, points: r.points.map((p) => apply(local, p)) });
  }
  var GEOMETRY = /* @__PURE__ */ new Set([...GEOM_ATTRS, "points"]);
  function geometryChanged(ops) {
    return ops.some(
      (op) => op.kind === "attrs" && Object.keys(op.set ?? {}).some(
        (k) => GEOMETRY.has(k)
      )
    );
  }
  function withConnectors(plans) {
    const svg = slideRoot();
    if (!svg) return plans;
    const moved = plans.filter((p) => geometryChanged(p.ops)).map((p) => p.sel.el);
    if (!moved.length) return plans;
    for (const p of plans) {
      for (const op of p.ops) {
        if (op.kind === "attrs" && op.loc === p.sel.loc) {
          applyPlanToDom(p.sel.el, op.set);
        }
      }
    }
    const touches = (conn) => ["start", "end"].some((w) => {
      const c = parseConnection(conn.getAttribute(ENDS[w]));
      const target = c ? byId(c.id) : null;
      return !!target && moved.some((m) => m === target || m.contains(target));
    });
    const out = [...plans];
    for (const conn of svg.querySelectorAll(`[${CSS.escape(CONNECTOR)}]`)) {
      if (!conn.hasAttribute("data-ink") || !canTransform(conn) || !touches(conn))
        continue;
      const d = connectorPath(conn);
      if (!d) continue;
      applyPlanToDom(conn, { d });
      const loc = conn.getAttribute("data-ink") ?? "";
      const existing = out.find((p) => p.sel.el === conn);
      const op = { kind: "attrs", loc, set: { d } };
      if (existing) existing.ops = [...existing.ops, op];
      else
        out.push({
          sel: toSelected(conn),
          ops: [op]
        });
    }
    return out;
  }
  var movingTogether = [];
  function connectorMoveOps(sel, dx, dy) {
    const conn = sel.el;
    const set = {};
    const ends = {};
    for (const w of ["start", "end"]) {
      const c = parseConnection(conn.getAttribute(ENDS[w]));
      const target = c ? byId(c.id) : null;
      const kept = !!target && movingTogether.some((m) => m === target || m.contains(target));
      const here = connectorEnd(conn, w);
      if (!kept) {
        if (c) set[ENDS[w]] = null;
        if (here) ends[w] = { x: here.x + dx, y: here.y + dy };
      }
    }
    for (const [k, v] of Object.entries(set)) {
      if (v === null) conn.removeAttribute(k);
    }
    let bend = parseBend(conn.getAttribute(BEND));
    if (bend) {
      bend = { ...bend, at: bend.at + (bend.axis === "x" ? dx : dy) };
      set[BEND] = formatBend(bend);
    }
    const d = connectorPath(conn, ends, connectorStyle(conn), bend);
    if (d) set.d = d;
    applyPlanToDom(conn, { d: set.d ?? null });
    return [{ kind: "attrs", loc: sel.loc, set }];
  }
  function freshId(base2) {
    const svg = slideRoot();
    let n2 = 1;
    while (svg?.querySelector(`[id="${base2}-${n2}"]`)) n2++;
    return `${base2}-${n2}`;
  }
  function endpointPlans(drag, p, e) {
    const sel = drag.snaps[0].sel;
    const conn = sel.el;
    const hit = e.altKey ? null : siteAt(p, conn);
    const under = attachTargetAt(e.clientX, e.clientY, conn);
    siteHints = [
      ...under ? [
        {
          el: under,
          active: hit?.el === under ? hit.site : null
        }
      ] : [],
      ...hit && hit.el !== under ? [{ el: hit.el, active: hit.site }] : []
    ];
    const ops = [];
    let attach = null;
    if (hit) {
      let id = hit.el.getAttribute("id");
      if (!id && keyOf(hit.el) === sel.key) {
        id = freshId(hit.el.localName);
        hit.el.setAttribute("id", id);
        ops.push({ kind: "id", loc: hit.el.getAttribute("data-ink"), id });
      }
      if (id) attach = `${id}:${hit.site.name}`;
    }
    const end = attach && hit ? hit.site : p;
    const d = connectorPath(conn, { [drag.which]: end });
    if (!d) return [];
    applyPlanToDom(conn, { d });
    ops.push({
      kind: "attrs",
      loc: sel.loc,
      set: { d, [ENDS[drag.which]]: attach }
    });
    return [{ sel, ops }];
  }
  function bendPlans(drag, p) {
    const sel = drag.snaps[0].sel;
    const conn = sel.el;
    const current2 = connectorRoute(conn)?.bend;
    if (!current2) return [];
    const bend = {
      axis: current2.axis,
      at: Math.round(current2.axis === "x" ? p.x : p.y)
    };
    const d = connectorPath(conn, {}, "elbow", bend);
    if (!d) return [];
    applyPlanToDom(conn, { d });
    return [
      {
        sel,
        ops: [
          {
            kind: "attrs",
            loc: sel.loc,
            set: { d, [BEND]: formatBend(bend) }
          }
        ]
      }
    ];
  }
  function opsByFile(plans) {
    const out = /* @__PURE__ */ new Map();
    for (const { sel, ops } of plans) {
      const src = sourceOf(sel.key);
      if (!src) continue;
      const list3 = out.get(src.path) ?? [];
      list3.push(...ops);
      out.set(src.path, list3);
    }
    return out;
  }
  async function sendSvgOps(plans, label4, coalesce, ids) {
    const slide = currentSlide();
    if (!slide) return false;
    if (ed.structuralPending) {
      toast("One moment: the last change is still being applied");
      return false;
    }
    const run = queue.then(() => sendQueued(plans, label4, coalesce, ids));
    queue = run.catch(() => false);
    return run;
  }
  var queue = Promise.resolve();
  async function sendQueued(plans, label4, coalesce, ids) {
    const slide = currentSlide();
    if (!slide) return false;
    let ok = true;
    plans = withConnectors(plans);
    const cells = diagramPlans(plans);
    plans = cells.plans;
    if (cells.diagrams.size && !coalesce) coalesce = `diagram-${Date.now()}`;
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
        label: label4,
        coalesce,
        // Deleting or duplicating a zone takes its content along (not in
        // layout mode: a layout's zones are filled by every slide).
        zoneSlide: ed.layoutMode ? void 0 : slide.deckIndex
      });
      ok = ok && result.ok;
      if (ids && result.ids) Object.assign(ids, result.ids);
    }
    if (ok && coalesce) {
      for (const diagram of cells.diagrams)
        hooks.diagramEdited(diagram, coalesce);
    }
    return ok;
  }
  function applyPlanToDom(el2, plan) {
    for (const [k, v] of Object.entries(plan)) {
      if (v == null) el2.removeAttribute(k);
      else el2.setAttribute(k, v);
    }
  }
  function textChildren(el2) {
    return [...el2.querySelectorAll("tspan")].filter(
      (t) => t.hasAttribute("x") || t.hasAttribute("y")
    );
  }
  function moveOps(sel, dx, dy) {
    if (isConnector(sel.el) && sel.el.getAttribute("d")) {
      return connectorMoveOps(sel, dx, dy);
    }
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
    movingTogether = sels.map((s) => s.el);
    const ordered = [
      ...sels.filter((s) => !isConnector(s.el)),
      ...sels.filter((s) => isConnector(s.el))
    ];
    const plans = ordered.map((sel) => ({ sel, ops: moveOps(sel, dx, dy) }));
    drawOverlay();
    await sendSvgOps(plans, "Nudge", "nudge");
  }
  function snapshot(sel) {
    const attrs2 = {};
    for (const a of GEOM_ATTRS) attrs2[a] = sel.el.getAttribute(a);
    return {
      sel,
      attrs: attrs2,
      kids: textChildren(sel.el).map((el2) => ({
        el: el2,
        x: el2.getAttribute("x"),
        y: el2.getAttribute("y")
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
      for (const el2 of svg.querySelectorAll("[data-ink-top]")) {
        if (exclude.has(el2) || [...exclude].some((x) => x.contains(el2)))
          continue;
        const b = slideBox(el2);
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
    if (handle === "c-bend") return { kind: "bend", snaps };
    if (handle === "c-start" || handle === "c-end") {
      return {
        kind: "endpoint",
        which: handle === "c-start" ? "start" : "end",
        snaps
      };
    }
    const targets2 = snapTargets(new Set(sels.map((s) => s.el)));
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
    if (handle) return { kind: "resize", handle, snaps, start, targets: targets2 };
    return { kind: "move", snaps, start, targets: targets2 };
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
  var lastInput = null;
  var copying = false;
  var ghosts = [];
  function showGhosts(snaps) {
    if (ghosts.length) return;
    for (const s of snaps) {
      const ghost = s.sel.el.cloneNode(true);
      for (const node of [ghost, ...ghost.querySelectorAll("*")]) {
        for (const attr of [...node.attributes]) {
          if (attr.name === "id" || attr.name.startsWith("data-ink")) {
            node.removeAttribute(attr.name);
          }
        }
      }
      ghost.setAttribute("pointer-events", "none");
      s.sel.el.before(ghost);
      ghosts.push(ghost);
    }
  }
  function dropGhosts() {
    for (const g of ghosts) g.remove();
    ghosts = [];
  }
  function setCopying(on2) {
    copying = on2;
    document.body.classList.toggle("drag-copy", on2);
    if (!on2) dropGhosts();
  }
  function updateDrag(drag, e) {
    lastInput = e;
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
      setCopying(e.ctrlKey || e.metaKey);
      if (copying) showGhosts(drag.snaps);
      movingTogether = drag.snaps.map((s) => s.sel.el);
      const ordered = [
        ...drag.snaps.filter((s) => !isConnector(s.sel.el)),
        ...drag.snaps.filter((s) => isConnector(s.sel.el))
      ];
      const plans = ordered.map((s) => ({
        sel: s.sel,
        ops: moveOps(s.sel, dx, dy)
      }));
      lastPlans = copying ? plans : withConnectors(plans);
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
    } else if (drag.kind === "endpoint") {
      restore(drag.snaps);
      lastPlans = endpointPlans(drag, p1, e);
    } else if (drag.kind === "bend") {
      restore(drag.snaps);
      lastPlans = bendPlans(drag, p1);
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
      const hits2 = [...svg.querySelectorAll("[data-ink-top]")].filter(
        (el2) => {
          if (!selectable(el2) || !canTransform(el2)) return false;
          const b = slideBox(el2);
          return !!b && b.x >= m.x && b.y >= m.y && b.x + b.width <= m.x + m.width && b.y + b.height <= m.y + m.height;
        }
      );
      if (drag.additive) {
        for (const el2 of hits2) addToSelection(el2, false);
        select(ed.selection.map((s) => s.el));
      } else select(hits2);
      return;
    }
    const plans = lastPlans;
    lastPlans = [];
    if (drag.kind === "move" && copying) {
      setCopying(false);
      restore(drag.snaps);
      drawOverlay();
      await dropCopies(plans);
      return;
    }
    drawOverlay();
    if (!plans.length) return;
    if (siteHints.length) siteHints = [];
    const label4 = drag.kind === "endpoint" ? "Connect" : drag.kind === "bend" ? "Reshape arrow" : drag.kind === "move" ? "Move" : drag.kind === "resize" ? ed.cropMode ? "Crop" : "Resize" : "Rotate";
    const ok = await sendSvgOps(plans, label4);
    if (!ok) restore(drag.snaps);
    drawOverlay();
  }
  async function dropCopies(plans) {
    const keys = [];
    const copies = plans.map((p, i) => {
      const set = {};
      const kids = [];
      for (const op of p.ops) {
        if (op.kind !== "attrs") continue;
        if (op.loc === p.sel.loc) Object.assign(set, op.set);
        else kids.push({ loc: String(op.loc), set: op.set });
      }
      keys.push(`copy${i}`);
      return {
        sel: p.sel,
        ops: [
          {
            kind: "duplicate",
            loc: p.sel.loc,
            key: `copy${i}`,
            set,
            kids
          }
        ]
      };
    });
    const ids = {};
    if (await sendSvgOps(copies, "Duplicate", void 0, ids)) {
      const made = keys.map((k) => ids[k]).filter(Boolean);
      if (made.length) hooks.selectAfterRender(made);
    }
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
    let deselectOnClick = false;
    if (handle) {
      drag = beginDrag(handle);
    } else {
      clickTarget = pick(e.clientX, e.clientY);
      if (clickTarget) {
        const already = ed.selection.some((s) => s.el === clickTarget);
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          if (already) deselectOnClick = true;
          else addToSelection(clickTarget);
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
      shift: e.shiftKey,
      deselectOnClick
    };
  }
  function onPointerMove(e) {
    if (!pointer) {
      if (ed.tool === "select" && e.buttons === 0) {
        const el2 = pick(e.clientX, e.clientY);
        if (el2 !== hoverEl) {
          hoverEl = el2;
          drawOverlay();
        }
      } else if (ed.tool in CONNECTOR_TOOLS && e.buttons === 0) {
        const p = clientToSlide(e.clientX, e.clientY);
        const hit = e.altKey ? null : siteAt(p, null);
        const under = attachTargetAt(e.clientX, e.clientY);
        const hints = [
          ...under ? [
            {
              el: under,
              active: hit?.el === under ? hit.site : null
            }
          ] : [],
          ...hit && hit.el !== under ? [{ el: hit.el, active: hit.site }] : []
        ];
        if (hints.length || siteHints.length) showSites(hints);
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
    lastInput = null;
    try {
      if (p.drag && p.started) await endDrag(p.drag);
      else if (p.drag?.kind === "marquee") marquee = null;
      if (!p.started && p.deselectOnClick && p.clickTarget) {
        ed.selection = ed.selection.filter((s) => s.el !== p.clickTarget);
        drawOverlay();
        emit("selection");
      }
    } finally {
      setCopying(false);
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
    const el2 = pick(e.clientX, e.clientY);
    if (!el2) return;
    if (canTypeInto(el2)) {
      hooks.typeInto(el2);
      return;
    }
    if (isZone(el2)) {
      hooks.editZone(zoneName(el2), el2, { x: e.clientX, y: e.clientY });
      return;
    }
    const text = textUnder(e.clientX, e.clientY);
    if (text && el2.contains(text)) {
      if (text !== el2 && !text.hasAttribute("data-ink-top")) {
        enterGroup(text.parentElement);
      }
      select([text]);
      hooks.editText(text);
      return;
    }
    if (isDiagramCell(el2) && !el2.querySelector('g[data-cell-kind="vertex"][data-ink]')) {
      select([el2]);
      hooks.cellLabel(el2);
      return;
    }
    if (el2.localName === "g") {
      enterGroup(el2);
      const inner = pick(e.clientX, e.clientY);
      if (inner) select([inner]);
      return;
    }
    if (el2.hasAttribute("data-drawio") && shapesEditable(el2) && canTransform(el2)) {
      enterDiagram(el2, e.clientX, e.clientY);
      return;
    }
    if (canTransform(el2) && hooks.diagram(el2)) return;
    if (canTransform(el2) && (el2.localName === "image" || el2.localName === "svg" && [...el2.children].some((c) => c.localName === "image"))) {
      hooks.crop(el2);
    }
  }
  function enterDiagram(diagram, x, y) {
    const layers = [
      ...diagram.querySelectorAll(
        'g[data-cell-kind="other"][data-ink]'
      )
    ];
    const under = document.elementsFromPoint(x, y).map((hit) => layers.find((l) => l.contains(hit))).find((l) => !!l);
    const layer2 = under ?? layers[0];
    if (!layer2) {
      toast("This diagram has no shapes to edit here", "error");
      return;
    }
    enterGroup(layer2);
    const inner = pick(x, y);
    if (inner) select([inner]);
    else toast("Click a shape of the diagram; Esc leaves it");
  }
  function diagramPlans(plans) {
    const diagrams = /* @__PURE__ */ new Set();
    const out = [];
    let refused = false;
    for (const plan of plans) {
      if (sourceOf(plan.sel.key)?.role !== "diagram") {
        out.push(plan);
        continue;
      }
      const el2 = plan.sel.el;
      const diagram = el2.closest("svg[data-drawio]");
      const cell = el2.getAttribute("data-cell-id");
      if (!diagram || !cell) continue;
      const ops = [];
      let moved = false;
      for (const op of plan.ops) {
        if (op.kind === "delete") ops.push({ kind: "cell-delete", cell });
        else if (String(op.kind).startsWith("cell-")) ops.push(op);
        else if (geometryChanged([op])) moved = true;
        else refused = true;
      }
      if (moved) {
        const offset = pageOffset(diagram);
        const box = offset ? pageBox(el2, offset) : null;
        if (offset && box) {
          ops.push({
            kind: "cell-geometry",
            cell,
            ...box,
            offset: [offset.x, offset.y]
          });
        }
      }
      if (ops.length) {
        out.push({ sel: plan.sel, ops });
        diagrams.add(diagram);
      }
    }
    if (refused) {
      toast(
        "That change to a diagram's shapes is made in draw.io (Edit diagram)",
        "error"
      );
    }
    return { plans: out, diagrams };
  }
  function initCanvas() {
    paper.addEventListener("pointerdown", onPointerDown);
    for (const type of ["mousedown", "auxclick"]) {
      paper.addEventListener(type, (e) => {
        if (e.button === 1) e.preventDefault();
      });
    }
    paper.addEventListener("pointermove", onPointerMove);
    for (const type of ["keydown", "keyup"]) {
      window.addEventListener(type, (e) => {
        if (!["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
        if (!pointer?.started || !pointer.drag || !lastInput) return;
        updateDrag(pointer.drag, {
          clientX: lastInput.clientX,
          clientY: lastInput.clientY,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey
        });
      });
    }
    paper.addEventListener("pointerup", (e) => void onPointerUp(e));
    paper.addEventListener("pointercancel", (e) => void onPointerUp(e));
    paper.addEventListener("dblclick", onDoubleClick);
    paper.addEventListener("pointerleave", () => {
      if (siteHints.length) showSites([]);
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

  // src/ts/editor/pathtext.ts
  function sepOf(path) {
    return path.includes("\\") && !path.includes("/") ? "\\" : "/";
  }
  function withSep(dir) {
    const sep2 = sepOf(dir);
    return dir.endsWith(sep2) ? dir : dir + sep2;
  }
  function joinPath(dir, name2) {
    return withSep(dir) + name2;
  }
  function baseName(path) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
  }
  function samePath(a, b) {
    const norm = (p) => p.replace(/(.)[\\/]+$/, "$1");
    return norm(a) === norm(b);
  }
  function commonPrefix(names) {
    if (!names.length) return "";
    let prefix = names[0];
    for (const name2 of names.slice(1)) {
      let i = 0;
      while (i < prefix.length && i < name2.length && prefix[i].toLowerCase() === name2[i].toLowerCase()) {
        i++;
      }
      prefix = prefix.slice(0, i);
    }
    return prefix;
  }
  function startingWith(names, typed) {
    const t = typed.toLowerCase();
    return names.filter((n2) => n2.toLowerCase().startsWith(t));
  }
  function splitTyped(value) {
    const i = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
    if (i < 0) return { dir: "", prefix: value };
    return { dir: value.slice(0, i + 1), prefix: value.slice(i + 1) };
  }
  function assetRef(href) {
    return href.replace(/\?v=[0-9a-f]+$/, "");
  }

  // src/ts/editor/dialog.ts
  var host2 = document.getElementById("dialog");
  var onClose = null;
  function openDialog(title2, body2, opts2 = {}) {
    closeDialog();
    onClose = opts2.onClose ?? null;
    const box = h(
      "div",
      {
        class: `dialog-box${opts2.large ? " large" : opts2.wide ? " wide" : ""}`,
        role: "dialog"
      },
      h(
        "div",
        { class: "dialog-head" },
        h("h2", {}, title2),
        opts2.hint ? h("span", { class: "hint" }, opts2.hint) : null,
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
        const own = e.target?.closest?.(
          "[data-own-escape]"
        );
        if (e.key === "Escape" && dialogOpen() && !own) {
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

  // src/ts/editor/folderpicker.ts
  function megabytes(bytes) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  function folderPicker(start, onChange, files2) {
    let folder = null;
    let places = { favorites: [], default: null };
    let filter = "";
    let typing = 0;
    const path = h("input", {
      type: "text",
      class: "folder-path",
      spellcheck: "false",
      autocomplete: "off",
      title: "Type a path: Tab completes, Enter opens, \u2193 goes to the list"
    });
    const list3 = h("div", { class: "folder-list", role: "listbox" });
    const where = h("div", { class: "hint folder-where" });
    const placesRow = h("div", { class: "folder-places" });
    const star = h("button", {
      type: "button",
      class: "pbtn folder-star"
    });
    const system = h(
      "button",
      {
        type: "button",
        class: "pbtn",
        hidden: true,
        title: "Choose with this computer's own dialog"
      },
      "Browse\u2026"
    );
    const entries = () => [...list3.querySelectorAll("button.folder")].filter(
      (b) => !b.hidden
    );
    async function go(target, opts2 = {}) {
      const res = await request({
        action: "browse",
        path: target,
        files: files2?.kind
      });
      if (!res.ok) {
        if (!opts2.quiet) {
          where.textContent = res.error ?? "Cannot open that folder";
        }
        return false;
      }
      folder = res;
      places = folder.places ?? places;
      system.hidden = !folder.systemPicker;
      path.value = withSep(folder.path);
      filter = "";
      renderList();
      renderPlaces();
      where.textContent = folder.repo ? `In the git repository at ${folder.repo}` : "Not in a git repository";
      onChange(folder);
      if (opts2.focus === "list") (entries()[0] ?? path).focus();
      else if (opts2.focus === "path") path.focus();
      return true;
    }
    function entry(label4, kind, onOpen, extra) {
      const b = h(
        "button",
        {
          type: "button",
          class: `folder ${kind === "file" ? "file" : kind === "up" ? "up" : ""}`,
          role: "option",
          onclick: onOpen
        },
        label4,
        extra ?? null
      );
      return b;
    }
    function renderList() {
      clear(list3);
      const f = folder;
      if (!f) return;
      if (f.parent && !filter) {
        list3.append(
          entry("\u2191 ..", "up", () => {
            if (f.parent) void go(f.parent, { focus: "list" });
          })
        );
      }
      const dirs = startingWith(f.dirs, filter);
      for (const name2 of dirs) {
        list3.append(
          entry(`\u{1F4C1} ${name2}`, "dir", () => {
            void go(joinPath(f.path, name2), { focus: "list" });
          })
        );
      }
      const shown = startingWith(
        (f.files ?? []).map((x) => x.name),
        filter
      );
      for (const file of f.files ?? []) {
        if (!shown.includes(file.name)) continue;
        list3.append(
          entry(
            `\u{1F39E} ${file.name}`,
            "file",
            () => files2?.onFile(joinPath(f.path, file.name)),
            h(
              "span",
              { class: "hint file-size" },
              megabytes(file.size)
            )
          )
        );
      }
      if (!dirs.length && !shown.length) {
        list3.append(
          h(
            "p",
            { class: "hint folder-empty" },
            filter ? `Nothing here starts with \u201C${filter}\u201D.` : "No folders here."
          )
        );
      }
      path.toggleAttribute("data-own-escape", !!filter);
    }
    async function setPlaces(op, target) {
      const res = await request({ action: "places-set", op, path: target });
      if (!res.ok) {
        toast(res.error ?? "Cannot save that", "error");
        return;
      }
      places = res.places;
      renderPlaces();
    }
    function chip(label4, target, remove) {
      return h(
        "span",
        { class: "place" },
        h(
          "button",
          {
            type: "button",
            class: "place-go",
            title: target,
            onclick: () => void go(target, { focus: "list" })
          },
          label4
        ),
        remove ? h(
          "button",
          {
            type: "button",
            class: "place-remove",
            title: "Remove from favourites",
            onclick: remove
          },
          "\xD7"
        ) : null
      );
    }
    function renderPlaces() {
      clear(placesRow);
      const here = folder?.path ?? "";
      const isFavorite = places.favorites.some((p) => samePath(p, here));
      star.textContent = isFavorite ? "\u2605" : "\u2606";
      star.title = isFavorite ? "Remove this folder from your favourites" : "Add this folder to your favourites";
      star.classList.toggle("on", isFavorite);
      if (places.default) {
        placesRow.append(
          chip(`\u2302 ${baseName(places.default)} (default)`, places.default)
        );
      }
      for (const p of places.favorites) {
        placesRow.append(
          chip(`\u2605 ${baseName(p)}`, p, () => void setPlaces("remove", p))
        );
      }
      const isDefault = !!places.default && samePath(places.default, here);
      placesRow.append(
        h(
          "button",
          {
            type: "button",
            class: "place-default",
            title: isDefault ? "New decks go here and Open deck starts here; click to forget it" : "New decks go here and Open deck starts here",
            onclick: () => void setPlaces("default", isDefault ? null : here)
          },
          isDefault ? "\u2713 Default location" : "Make this the default location"
        )
      );
    }
    path.addEventListener("input", () => {
      window.clearTimeout(typing);
      const { dir, prefix } = splitTyped(path.value);
      if (folder && samePath(dir, folder.path)) {
        filter = prefix;
        renderList();
      } else if (dir && !prefix) {
        typing = window.setTimeout(
          () => void go(dir, { quiet: true }),
          250
        );
      }
    });
    async function complete() {
      const { dir, prefix } = splitTyped(path.value);
      if (!folder || !samePath(dir, folder.path)) {
        if (!dir || !await go(dir, { quiet: true })) return;
        path.value = withSep(folder.path) + prefix;
      }
      const f = folder;
      const matches = startingWith(f.dirs, prefix);
      if (matches.length === 1) {
        await go(joinPath(f.path, matches[0]));
        return;
      }
      const common = commonPrefix(matches);
      filter = common.length > prefix.length ? common : prefix;
      path.value = withSep(f.path) + filter;
      renderList();
    }
    path.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void complete();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const { dir, prefix } = splitTyped(path.value);
        const f = folder;
        if (f && prefix && samePath(dir, f.path)) {
          const exact = f.dirs.find(
            (d) => d.toLowerCase() === prefix.toLowerCase()
          );
          const only = startingWith(f.dirs, prefix);
          const into = exact ?? (only.length === 1 ? only[0] : null);
          if (into) {
            void go(joinPath(f.path, into));
            return;
          }
        }
        void go(path.value);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        entries()[0]?.focus();
      } else if (e.key === "Escape" && filter && folder) {
        e.preventDefault();
        path.value = withSep(folder.path);
        filter = "";
        renderList();
      }
    });
    list3.addEventListener("keydown", (e) => {
      const items = entries();
      const at2 = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = at2 + (e.key === "ArrowDown" ? 1 : -1);
        if (next < 0) path.focus();
        else items[Math.min(next, items.length - 1)]?.focus();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        if (filter) {
          path.focus();
          path.value = path.value.slice(0, -1);
          path.dispatchEvent(new Event("input"));
        } else if (folder?.parent) {
          void go(folder.parent, { focus: "list" });
        }
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
        e.preventDefault();
        path.focus();
        path.value += e.key;
        path.dispatchEvent(new Event("input"));
      }
    });
    star.addEventListener("click", () => {
      const here = folder?.path;
      if (!here) return;
      const isFavorite = places.favorites.some((p) => samePath(p, here));
      void setPlaces(isFavorite ? "remove" : "add", here);
    });
    system.addEventListener("click", async () => {
      system.disabled = true;
      const before = where.textContent;
      where.textContent = "A dialog is open on this computer (it may be behind the browser)\u2026";
      const res = await request({
        action: "system-pick",
        path: folder?.path ?? start,
        files: files2?.kind,
        title: files2 ? "Choose a video" : "Choose a folder"
      });
      system.disabled = false;
      where.textContent = before;
      if (!res.ok) {
        toast(res.error ?? "No dialog could be shown", "error");
        return;
      }
      const chosen = typeof res.path === "string" ? res.path : null;
      if (!chosen) return;
      if (files2) files2.onFile(chosen);
      else void go(chosen);
    });
    const el2 = h(
      "div",
      { class: "folder-picker" },
      h(
        "div",
        { class: "folder-bar" },
        path,
        system,
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            title: "Your home folder",
            onclick: () => void go(folder?.home ?? "~", { focus: "list" })
          },
          "Home"
        ),
        star
      ),
      placesRow,
      list3,
      where
    );
    void go(start);
    return { el: el2, current: () => folder, focus: () => path.focus() };
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
  function layoutLabel(name2) {
    return LABELS[name2]?.[0] ?? name2;
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
      svg.querySelectorAll(".anim-pending").forEach((el2) => {
        el2.classList.remove("anim-pending");
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
    const used = /* @__PURE__ */ new Set([
      ...Object.keys(slide.zoneOrigins ?? {}),
      ...Object.keys(slide.zones)
    ]);
    return [...used].filter((z) => !p.zones.includes(z));
  }
  function close() {
    root.classList.remove("open");
    clear(root);
  }
  async function openGallery(opts2) {
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
    const title2 = opts2.mode === "insert" ? "New slide" : "Change layout";
    root.append(
      h(
        "div",
        { class: "gallery-box", role: "dialog", "aria-label": title2 },
        h(
          "div",
          { class: "gallery-head" },
          h("h2", {}, title2),
          h(
            "span",
            { class: "hint" },
            opts2.mode === "insert" ? "Every layout, in this deck's theme" : "The slide keeps its content; zones the new layout lacks are not shown"
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
      const [label4, description] = LABELS[p.name] ?? [p.name, ""];
      const lost = opts2.mode === "change" ? lostZones(p) : [];
      const current2 = opts2.mode === "change" && p.name === opts2.current;
      const card = h(
        "button",
        {
          type: "button",
          class: `gallery-card${current2 ? " current" : ""}`,
          title: p.name,
          onclick: () => void choose(p, opts2, lost)
        },
        thumbnail(p),
        h(
          "div",
          { class: "gallery-label" },
          h("strong", {}, label4),
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
  async function choose(p, opts2, lost) {
    if (opts2.mode === "insert") {
      close();
      await newSlide(p.name, opts2.after);
      return;
    }
    if (p.name === opts2.current) {
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
  function pickSlide(i, e) {
    ed.focus = "sorter";
    if (e.shiftKey) {
      const [a, b] = [Math.min(ed.current, i), Math.max(ed.current, i)];
      for (let k = a; k <= b; k++) ed.slideSelection.add(k);
      emit("slide-selection");
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (!ed.slideSelection.size) ed.slideSelection.add(ed.current);
      if (ed.slideSelection.has(i)) ed.slideSelection.delete(i);
      else ed.slideSelection.add(i);
      emit("slide-selection");
      if (ed.slideSelection.has(i)) gotoSlide(i);
      return;
    }
    ed.slideSelection.clear();
    if (i === ed.current) emit("slide-selection");
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
    const n2 = ed.model?.slides.length ?? 0;
    if (!n2) return;
    const i = Math.max(0, Math.min(n2 - 1, deckIndex));
    if (i === ed.current) return;
    ed.current = i;
    ed.selection = [];
    ed.scope = null;
    emit("slide");
  }
  var Thumbs = class {
    cache = /* @__PURE__ */ new Map();
    used = /* @__PURE__ */ new Map();
    begin() {
      this.used = /* @__PURE__ */ new Map();
    }
    end() {
      this.cache = this.used;
    }
    thumb(slide) {
      const box = h("div", { class: "thumb" });
      if (slide.visibleIndex == null) {
        box.append(h("div", { class: "thumb-hidden" }, icon("eyeOff", 18)));
        return box;
      }
      const data = ed.slides[slide.visibleIndex];
      if (!data) return box;
      const cached = this.cache.get(data.svg);
      if (cached && !this.used.has(data.svg)) {
        this.used.set(data.svg, cached);
        return cached;
      }
      this.used.set(data.svg, box);
      box.innerHTML = data.svg;
      const svg = box.querySelector("svg");
      if (svg) {
        const vb = parseViewBox(svg.getAttribute("viewBox"));
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svg.style.aspectRatio = `${vb.w} / ${vb.h}`;
        svg.querySelectorAll(".anim-pending").forEach((el2) => {
          el2.classList.remove("anim-pending");
        });
        svg.querySelectorAll("video").forEach((v) => {
          v.removeAttribute("autoplay");
        });
      }
      return box;
    }
  };
  var thumbs = new Thumbs();
  function renderSorter() {
    clear(list);
    thumbs.begin();
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
        thumbs.thumb(slide)
      );
      item.addEventListener("click", (e) => pickSlide(i, e));
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        ed.focus = "sorter";
        if (!ed.slideSelection.has(i)) {
          ed.slideSelection.clear();
          gotoSlide(i);
        }
        openSlideMenu(e.clientX, e.clientY, i);
      });
      item.addEventListener("dragstart", (e) => {
        dragFrom = i;
        e.dataTransfer?.setData("text/plain", String(i));
        item.classList.add("dragging");
      });
      item.addEventListener("dragend", () => {
        dragFrom = null;
        item.classList.remove("dragging");
        list.querySelectorAll(".drop-before, .drop-after").forEach((el2) => {
          el2.classList.remove("drop-before", "drop-after");
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
    thumbs.end();
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
  async function newSlideLike(i = ed.current) {
    const result = await edit({
      action: "slide",
      op: "new",
      after: i,
      like: i,
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
    const name2 = slide.title ?? slide.id ?? `slide ${i + 1}`;
    if (!window.confirm(
      `Delete \u201C${name2}\u201D from the deck? (Its files stay on disk.)`
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
  function menuItem(label4, fn, disabled = false) {
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
      label4
    );
  }
  function openSlideMenu(x, y, i) {
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
      const n2 = ed.model?.slides.length ?? 0;
      if (pendingSelect != null && pendingSelect < n2) {
        ed.current = pendingSelect;
        pendingSelect = null;
        emit("slide");
      }
      if (ed.current >= n2) ed.current = Math.max(0, n2 - 1);
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

  // src/ts/editor/openwith.ts
  var menu2 = document.getElementById("context-menu");
  function fileName(path) {
    return path.split(/[\\/]/).pop() ?? path;
  }
  function inProject(path) {
    const root2 = ed.model?.projectDir;
    if (!path.startsWith("/")) return !path.split("/").includes("..");
    return !!root2 && path.startsWith(`${root2}/`);
  }
  async function openMenu(path, x, y) {
    const res = await request({ action: "open-apps", path });
    if (!res.ok) {
      toast(res.error ?? "Cannot open this file", "error");
      return;
    }
    const apps = res.apps ?? [];
    clear(menu2);
    menu2.append(h("div", { class: "menu-title" }, `Open ${fileName(path)} in`));
    for (const app of apps) {
      menu2.append(menuItem(app.label, () => void open(path, app)));
    }
    menu2.append(
      menuItem("Copy path", () => {
        const root2 = ed.model?.projectDir ?? "";
        const full = path.startsWith("/") ? path : `${root2}/${path}`;
        void navigator.clipboard.writeText(full).then(
          () => toast(`Copied ${full}`, "ok"),
          () => toast(full)
        );
      })
    );
    showMenu(x, y);
  }
  async function open(path, app) {
    const res = await request({ action: "open-file", path, app: app.id });
    if (res.ok) toast(`Opened ${fileName(path)} in ${app.label}`, "ok");
    else toast(res.error ?? "Could not open the file", "error");
  }
  function openButton(path, label4 = "Open") {
    if (!path || !inProject(path)) return null;
    return h(
      "button",
      {
        type: "button",
        class: "pbtn open-with",
        title: `Open ${fileName(path)} in another program`,
        onclick: (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          void openMenu(path, r.left, r.bottom + 4);
        }
      },
      `${label4} \u25BE`
    );
  }

  // src/ts/editor/videocheck.ts
  var LONG = 10 * 60;
  async function mediaInfo(path) {
    const res = await request({ action: "media-info", path });
    if (!res.ok) {
      toast(res.error ?? "Cannot read the video", "error");
      return null;
    }
    return res;
  }
  function name(path) {
    return path.split(/[\\/]/).pop() ?? path;
  }
  function minutes(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  function describe(info3) {
    return [
      info3.vcodec ? `${info3.vcodec.toUpperCase()} in .${info3.container}` : `.${info3.container}`,
      info3.width && info3.height ? `${info3.width}\xD7${info3.height}` : "",
      info3.fps ? `${Math.round(info3.fps)} fps` : "",
      info3.duration ? minutes(info3.duration) : "",
      megabytes(info3.size)
    ].filter(Boolean).join(" \xB7 ");
  }
  async function checkVideo(ctx) {
    const data = await mediaInfo(ctx.path);
    if (!data) return;
    const issues = collect(ctx, data);
    if (issues.length) showCheck(ctx, data, issues);
  }
  async function openVideoCheck(ctx) {
    const data = await mediaInfo(ctx.path);
    if (data) showCheck(ctx, data, collect(ctx, data));
  }
  function collect(ctx, data) {
    const issues = [...data.issues];
    if (ctx.browser && !ctx.browser.decoded) {
      issues.unshift({
        kind: "decode",
        level: "error",
        text: "This browser cannot play it: it shows as an empty box here, and in the presenter for anyone with this browser."
      });
    }
    const duration = ctx.browser?.duration;
    if (data.info.duration == null && duration && duration > LONG) {
      issues.push({
        kind: "length",
        level: "info",
        text: `It runs ${Math.round(duration / 60)} minutes. Trim start and end in its settings, or cut it in a video editor.`
      });
    }
    return issues;
  }
  function showCheck(ctx, data, issues) {
    const editors = h(
      "button",
      {
        type: "button",
        class: "pbtn",
        title: "Trim or cut it in a video editor (LosslessCut, Shotcut\u2026)"
      },
      "Open in\u2026"
    );
    editors.addEventListener("click", () => {
      const r = editors.getBoundingClientRect();
      void openMenu(ctx.path, r.left, r.bottom + 4);
    });
    openDialog(
      "Video check",
      h(
        "div",
        { class: "git-form" },
        h(
          "p",
          { class: "hint" },
          `${name(ctx.path)}: ${describe(data.info)}`
        ),
        issues.length ? h(
          "ul",
          { class: "video-issues" },
          ...issues.map(
            (i) => h("li", { class: `issue-${i.level}` }, i.text)
          )
        ) : h(
          "p",
          {},
          "Nothing to worry about: it plays in every current browser."
        ),
        !data.tools.ffprobe && h(
          "p",
          { class: "hint" },
          "Install ffmpeg (it brings ffprobe) to see the codec, resolution and length here, and to convert in place."
        ),
        h(
          "p",
          { class: "hint" },
          "MP4 with H.264 plays in every browser; WebM (VP9) in all but some Safari versions. Convert to one of them to be safe."
        ),
        h(
          "div",
          { class: "btn-row end" },
          editors,
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => closeDialog()
            },
            "Keep as is"
          ),
          h(
            "button",
            {
              type: "button",
              class: "pbtn primary",
              onclick: () => convertDialog(ctx.path, data, {
                kind: "replace",
                ctx
              })
            },
            "Convert\u2026"
          )
        )
      ),
      { wide: true }
    );
  }
  var PRESETS = [
    { label: "Keep its resolution", height: null },
    { label: "4K (2160p)", height: 2160 },
    { label: "Full HD (1080p)", height: 1080 },
    { label: "HD (720p)", height: 720 },
    { label: "480p", height: 480 }
  ];
  async function convertForInsert(source) {
    const data = await mediaInfo(source);
    if (!data) return null;
    return new Promise(
      (resolve) => convertDialog(source, data, { kind: "insert", done: resolve })
    );
  }
  function convertDialog(path, data, purpose) {
    const info3 = data.info;
    let format = data.remux ? "copy" : "mp4";
    let height = null;
    let quality = 2;
    let audio = !!info3.acodec;
    const inserting = purpose.kind === "insert";
    const choices = [
      ["mp4", "MP4 (H.264)", "Plays in every browser. The safe choice."],
      [
        "webm",
        "WebM (VP9)",
        "Smaller at the same quality; not in all Safari versions."
      ]
    ];
    if (data.remux) {
      choices.unshift([
        "copy",
        `Keep the video as it is (.${data.remux})`,
        `Its ${info3.vcodec?.toUpperCase() ?? "video"} already plays in browsers: repackaged without re-encoding, in seconds and with no quality lost.`
      ]);
    }
    const formats = h(
      "div",
      { class: "look-list" },
      ...choices.map(([value, label4, text]) => {
        const radio = h("input", {
          type: "radio",
          name: "video-format",
          value
        });
        radio.checked = value === format;
        radio.addEventListener("change", () => {
          format = value;
          void update();
        });
        return h(
          "label",
          { class: "look" },
          radio,
          h(
            "span",
            { class: "look-text" },
            h("strong", {}, label4),
            h("span", { class: "hint" }, text)
          )
        );
      })
    );
    const size3 = h("select", {});
    for (const p of PRESETS) {
      const bigger = p.height && info3.height && p.height > info3.height;
      const option2 = h(
        "option",
        { value: String(p.height ?? "") },
        p.height ? `${p.label}${bigger ? " (no larger than the source)" : ""}` : `${p.label}${info3.width && info3.height ? ` (${info3.width}\xD7${info3.height})` : ""}`
      );
      option2.selected = p.height === height;
      size3.append(option2);
    }
    size3.addEventListener("change", () => {
      height = size3.value ? Number(size3.value) : null;
      void update();
    });
    const slider = h("input", {
      type: "range",
      class: "quality-slider",
      min: "0",
      max: String(data.qualities.length - 1),
      step: "1",
      value: String(quality)
    });
    const qualityLabel = h("span", { class: "hint" });
    slider.addEventListener("input", () => {
      quality = Number(slider.value);
      void update();
    });
    const sound = h("input", { type: "checkbox" });
    sound.checked = audio;
    sound.disabled = !info3.acodec && data.tools.ffprobe;
    sound.addEventListener("change", () => {
      audio = sound.checked;
      void update();
    });
    const estimate = h("p", { class: "video-estimate" });
    const command = h("textarea", {
      class: "git-message video-command",
      rows: "3",
      readonly: true,
      spellcheck: "false"
    });
    const copy2 = h(
      "button",
      {
        type: "button",
        class: "pbtn",
        onclick: () => void navigator.clipboard.writeText(command.value).then(
          () => toast(
            "Command copied: run it in the deck's folder",
            "ok"
          ),
          () => command.select()
        )
      },
      "Copy command"
    );
    const use = h("input", { type: "checkbox" });
    use.checked = true;
    const progress = h("progress", {
      max: "1",
      value: "0",
      hidden: true
    });
    const run = h(
      "button",
      { type: "button", class: "pbtn primary", disabled: !data.tools.ffmpeg },
      "Convert now"
    );
    let job = null;
    let finished = false;
    async function update() {
      qualityLabel.textContent = data.qualities[quality] ?? "";
      size3.disabled = slider.disabled = format === "copy";
      const res = await request({
        action: "convert-plan",
        path,
        format,
        height,
        quality,
        audio
      });
      if (!res.ok) {
        estimate.textContent = res.error ?? "";
        return;
      }
      command.value = String(res.command);
      const bytes = res.estimate;
      estimate.textContent = bytes ? `Roughly ${megabytes(bytes)}, from ${megabytes(info3.size)} now (a guess: it depends on the footage).` : "No size estimate without the video's length and resolution (install ffmpeg).";
      estimate.append(
        h("br"),
        h("span", { class: "hint" }, `Saved as ${res.out}`)
      );
    }
    run.addEventListener("click", async () => {
      if (job) {
        await request({ action: "convert-cancel", job });
        return;
      }
      const res = await request({
        action: "convert",
        path,
        format,
        height,
        quality,
        audio
      });
      if (!res.ok || typeof res.job !== "string") {
        toast(res.error ?? "Could not start ffmpeg", "error");
        return;
      }
      job = res.job;
      run.textContent = "Cancel";
      progress.hidden = false;
      const poll = async () => {
        const st = await request({ action: "convert-status", job });
        progress.value = Number(st.progress ?? 0);
        if (st.state === "running") {
          window.setTimeout(() => void poll(), 700);
          return;
        }
        job = null;
        run.textContent = inserting ? "Convert and insert" : "Convert now";
        progress.hidden = true;
        if (st.state !== "done" || typeof st.path !== "string") {
          toast(
            `Conversion stopped: ${st.error || "cancelled"}`,
            "error"
          );
          return;
        }
        toast(`Converted to ${st.rel}`, "ok");
        finished = true;
        const placed = { path: st.path, rel: String(st.rel) };
        if (purpose.kind === "insert") purpose.done(placed);
        else if (use.checked) {
          await edit({
            action: "zone-media",
            slide: purpose.ctx.slide,
            zone: purpose.ctx.zone,
            src: st.path
          });
        }
        closeDialog();
      };
      void poll();
    });
    openDialog(
      "Convert video",
      h(
        "div",
        { class: "deck-form" },
        h("p", { class: "hint" }, `${name(path)}: ${describe(info3)}`),
        inserting && h(
          "p",
          { class: "hint warn" },
          "Browsers cannot play this file as it is: convert it to put it on the slide."
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Format"),
          formats
        ),
        h(
          "label",
          { class: "field" },
          h("span", { class: "field-label" }, "Resolution"),
          size3
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Quality"),
          h(
            "div",
            { class: "video-quality" },
            h("span", { class: "hint" }, "Smaller"),
            slider,
            h("span", { class: "hint" }, "Better"),
            qualityLabel
          )
        ),
        h("label", { class: "check-row" }, sound, "Keep the sound"),
        estimate,
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "ffmpeg"),
          h("div", {}, command, h("div", { class: "btn-row" }, copy2))
        ),
        !data.tools.ffmpeg && h(
          "p",
          { class: "hint warn" },
          "ffmpeg is not installed here: copy the command and run it where it is, or install ffmpeg to convert from the editor."
        ),
        !inserting && h(
          "label",
          { class: "check-row" },
          use,
          "Use the converted video on this slide"
        ),
        h("div", { class: "btn-row end" }, progress, run)
      ),
      {
        wide: true,
        // Closed before it finished: an insert is called off, and a
        // source staged for it goes (cancelling a running ffmpeg first).
        onClose: () => {
          if (finished) return;
          if (job) void request({ action: "convert-cancel", job });
          if (purpose.kind === "insert") {
            void request({ action: "discard-source", path });
            purpose.done(null);
          }
        }
      }
    );
    if (inserting) run.textContent = "Convert and insert";
    void update();
  }
  function pickVideoFromDisk(start) {
    return new Promise((resolve) => {
      let chosen = null;
      const picker = folderPicker(start, () => {
      }, {
        kind: "video",
        onFile: (path) => {
          chosen = path;
          closeDialog();
        }
      });
      openDialog(
        "Insert a video from this computer",
        h(
          "div",
          { class: "deck-form" },
          h(
            "p",
            { class: "hint" },
            "Pick a video: the server copies it into the deck's assets/ folder straight from disk, however big it is."
          ),
          picker.el
        ),
        { large: true, onClose: () => resolve(chosen) }
      );
      picker.focus();
    });
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
  function toParent(el2, x, y) {
    const svg = slideRoot();
    if (!el2 || !svg) return { x, y };
    const p = el2.getScreenCTM?.();
    const r = svg.getScreenCTM();
    if (!p || !r) return { x, y };
    const m = multiply(invert(mat(p)), mat(r));
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }
  async function insertXml(xml, base2, opts2 = {}) {
    if (!await ensureOwnDrawing()) return false;
    const src = ownSource();
    if (!src) return false;
    const parent = insertParent();
    const ops = [...opts2.before?.() ?? []];
    if (opts2.marker) ops.push({ kind: "ensure-marker" });
    if (typeof xml === "function") xml = xml();
    ops.push({ kind: "insert", parent: parent.loc, xml, base: base2, key: "new" });
    const result = await edit({
      action: "svg",
      file: src.path,
      hash: src.hash,
      ops,
      label: `Insert ${base2}`
    });
    if (!result.ok) return false;
    const id = result.ids?.new;
    if (id) {
      afterRender.ids = [id];
      afterRender.editText = !!opts2.editText;
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
      default:
        return `<ellipse cx="${fmt(x + w / 2)}" cy="${fmt(y + h2 / 2)}" rx="${fmt(w / 2)}" ry="${fmt(h2 / 2)}" ${SHAPE_STYLE.ellipse}/>`;
    }
  }
  function textXml(p) {
    return `<text x="${fmt(p.x)}" y="${fmt(p.y)}" class="inkflow-fill-text" style="font-size:56px;font-family:var(--inkflow-body-font, sans-serif)">Text</text>`;
  }
  var draft = null;
  function drawDraft(tool, a, b, ends) {
    draft?.remove();
    const m = slideToPaper();
    const style = CONNECTOR_TOOLS[tool];
    if (style) {
      const r = route(style, ends?.a ?? a, ends?.b ?? b);
      const toPaper = (p) => ({
        x: m.a * p.x + m.e,
        y: m.d * p.y + m.f
      });
      draft = svgEl("path", {
        d: pathData({ ...r, points: r.points.map(toPaper) }),
        class: "draft",
        fill: "none"
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
  async function insertConnector(tool, from, to, startHit, endHit) {
    let a = startHit ? startHit.site : from;
    let b = endHit ? endHit.site : to;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 8) {
      a = { x: from.x - 150, y: from.y };
      b = { x: from.x + 150, y: from.y };
      startHit = null;
      endHit = null;
    }
    const before = [];
    const taken = /* @__PURE__ */ new Set();
    const attach = (hit) => {
      if (!hit) return null;
      let id = hit.el.getAttribute("id");
      if (!id && keyOf(hit.el) === 0) {
        const svg = slideRoot();
        let n2 = 1;
        const base2 = hit.el.localName;
        while (svg?.querySelector(`[id="${base2}-${n2}"]`) || taken.has(`${base2}-${n2}`))
          n2++;
        id = `${base2}-${n2}`;
        taken.add(id);
        hit.el.setAttribute("id", id);
        before.push({
          kind: "id",
          loc: hit.el.getAttribute("data-ink"),
          id
        });
      }
      return id ? `${id}:${hit.site.name}` : null;
    };
    const startAt = attach(startHit);
    const endAt = attach(endHit);
    const style = CONNECTOR_TOOLS[tool] ?? "straight";
    const arrow = tool !== "line";
    const attrs2 = [
      `inkflow:connector="${style}"`,
      startAt ? `inkflow:connect-start="${startAt}"` : "",
      endAt ? `inkflow:connect-end="${endAt}"` : "",
      arrow ? 'marker-end="url(#inkflow-arrow)"' : ""
    ].filter(Boolean).join(" ");
    await insertXml(
      // Routed into the insertion parent's space once it is known (a slide
      // drawn from a layout gets its own SVG first).
      () => `<path d="${newConnectorPath(style, a, b, insertParent().el)}" ${SHAPE_STYLE.line} ${attrs2}/>`,
      arrow ? "arrow" : "line",
      { marker: arrow, before: () => before }
    );
  }
  function onToolDown(e, start) {
    const tool = ed.tool;
    if (tool === "select") return false;
    e.preventDefault();
    clearSelection();
    const paperEl = e.currentTarget;
    paperEl.setPointerCapture(e.pointerId);
    ed.interacting = true;
    const connecting = tool in CONNECTOR_TOOLS;
    const startHit = connecting && !e.altKey ? siteAt(start, null) : null;
    if (startHit) start = { x: startHit.site.x, y: startHit.site.y };
    let endHit = null;
    let end = start;
    const move = (ev) => {
      end = clientToSlide(ev.clientX, ev.clientY);
      if (connecting) {
        endHit = ev.altKey ? null : siteAt(end, null);
        if (endHit) end = { x: endHit.site.x, y: endHit.site.y };
        const under = attachTargetAt(ev.clientX, ev.clientY);
        showSites([
          ...under ? [
            {
              el: under,
              active: endHit?.el === under ? endHit.site : null
            }
          ] : [],
          ...endHit && endHit.el !== under ? [{ el: endHit.el, active: endHit.site }] : [],
          ...startHit ? [{ el: startHit.el, active: startHit.site }] : []
        ]);
      }
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
      drawDraft(
        tool,
        start,
        end,
        connecting ? {
          a: startHit ? startHit.site : start,
          b: endHit ? endHit.site : end
        } : void 0
      );
    };
    const up = () => {
      paperEl.removeEventListener("pointermove", move);
      paperEl.removeEventListener("pointerup", up);
      draft?.remove();
      draft = null;
      ed.interacting = false;
      let a = start;
      let b = end;
      if (connecting) {
        showSites([]);
        void insertConnector(tool, start, end, startHit, endHit);
        setTool("select");
        drawOverlay();
        return;
      }
      if (tool === "text") {
        void insertTextBox(start, end);
        setTool("select");
        drawOverlay();
        return;
      }
      if (Math.hypot(b.x - a.x, b.y - a.y) < 8) {
        const w = 360;
        const h2 = 220;
        a = { x: start.x - w / 2, y: start.y - h2 / 2 };
        b = { x: start.x + w / 2, y: start.y + h2 / 2 };
      }
      const parent = insertParent().el;
      const pa = toParent(parent, a.x, a.y);
      const pb = toParent(parent, b.x, b.y);
      void insertXml(shapeXml(tool, pa, pb), tool);
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
    const current2 = currentSlide();
    if (!src || !current2) return;
    const parent = insertParent();
    const p0 = toParent(parent.el, box.x, box.y);
    const p1 = toParent(parent.el, box.x + box.width, box.y + box.height);
    const result = await edit({
      action: "insert-textbox",
      slide: current2.deckIndex,
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
  async function typeInto(el2) {
    const slide = currentSlide();
    const loc = el2.getAttribute("data-ink");
    const src = slide?.sources?.[keyOf(el2)];
    if (!slide || !loc || !src) return;
    if (!ed.model?.deckEditable && !slide.md) {
      toast(
        "deck.py builds its slides in code; there is nowhere to keep the text",
        "error"
      );
      return;
    }
    const result = await edit({
      action: "shape-text",
      slide: slide.deckIndex,
      file: src.path,
      hash: src.hash,
      loc
    });
    const id = result.ids?.new;
    if (result.ok && id) {
      afterRender.ids = [id];
      afterRender.editText = true;
    }
  }
  function zonePlaceholder(zone) {
    const words = zone.replace(/[-_]+/g, " ").trim() || "Text";
    return words[0].toUpperCase() + words.slice(1);
  }
  async function zoneText(zone) {
    const slide = currentSlide();
    if (!slide) return;
    const text = zonePlaceholder(zone);
    const result = await edit({
      action: "zone-text",
      slide: slide.deckIndex,
      zone,
      text
    });
    if (!result.ok) return;
    afterRender.ids = [`zone-${zone}`];
    afterRender.editText = true;
    afterRender.placeholder = text;
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
  var CHUNK = 4 * 1024 * 1024;
  async function upload(media) {
    if (!(media instanceof File)) {
      const result2 = await request({
        action: "import-path",
        path: media.path
      });
      if (result2.ok && result2.convert) {
        return convertForInsert(String(result2.source));
      }
      if (result2.ok && result2.path && result2.rel) {
        return { path: result2.path, rel: result2.rel };
      }
      if (media.file) return upload(media.file);
      toast(result2.error ?? "could not copy the file", "error");
      return null;
    }
    const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const big = media.size > 3 * CHUNK;
    let result = { ok: false };
    for (let at2 = 0; at2 < media.size || at2 === 0; at2 += CHUNK) {
      const last = at2 + CHUNK >= media.size;
      const data = await readBase64(media.slice(at2, at2 + CHUNK));
      result = await request({
        action: "upload-chunk",
        upload: id,
        name: media.name,
        data,
        last
      });
      if (!result.ok) {
        toast(result.error ?? "upload failed", "error");
        return null;
      }
      if (big) {
        const done = Math.min(
          100,
          Math.round((at2 + CHUNK) / media.size * 100)
        );
        toast(`Copying ${media.name}\u2026 ${done}%`);
      }
      if (last) break;
    }
    if (result.convert) return convertForInsert(String(result.source));
    if (!result.path || !result.rel) return null;
    return { path: result.path, rel: result.rel };
  }
  function droppedPath(dt) {
    const list3 = dt?.getData("text/uri-list") ?? "";
    const uri = list3.split(/\r?\n/).find((line) => line.startsWith("file://"));
    if (!uri) return null;
    try {
      const url = new URL(uri);
      if (url.host && url.host !== "localhost") return null;
      return decodeURIComponent(url.pathname).replace(
        /^\/([A-Za-z]:\/)/,
        "$1"
      );
    } catch {
      return null;
    }
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
      const fallback = { w: 1280, h: 720, decoded: false, duration: null };
      const timer5 = window.setTimeout(() => resolve(fallback), 3e3);
      video.preload = "metadata";
      video.muted = true;
      video.onloadedmetadata = () => {
        window.clearTimeout(timer5);
        const duration = Number.isFinite(video.duration) ? video.duration : null;
        resolve(
          video.videoWidth && video.videoHeight ? {
            w: video.videoWidth,
            h: video.videoHeight,
            decoded: true,
            duration
          } : { ...fallback, duration }
        );
      };
      video.onerror = () => {
        window.clearTimeout(timer5);
        resolve(fallback);
      };
      video.src = `/${rel}`;
    });
  }
  var VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|mkv|avi|m4v|wmv|flv|mpe?g|ts|mts|m2ts|3gp|3g2|mxf|vob|f4v|asf|dv)$/i;
  var VIDEO_ACCEPT = "video/*,.mkv,.avi,.m4v,.wmv,.flv,.mpg,.mpeg,.ts,.mts,.m2ts,.3gp,.mxf,.vob,.dv";
  function isVideo(file) {
    return file instanceof File && file.type.startsWith("video/") || VIDEO_EXT.test(file.name);
  }
  function isImage(file) {
    return file instanceof File && file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name);
  }
  async function insertVideoFile(file, at2) {
    if (!await ensureOwnDrawing()) return;
    const up = await upload(file);
    const src = ownSource();
    const slide = currentSlide();
    if (!up || !src || !slide) return;
    const size3 = await videoSize(up.rel);
    const vb = slideRoot()?.viewBox.baseVal;
    const vw = vb?.width || 1920;
    const vh = vb?.height || 1080;
    const k = Math.min(vw * 0.6 / size3.w, vh * 0.6 / size3.h);
    const w = size3.w * k;
    const h2 = size3.h * k;
    const cx = Math.min(Math.max(at2?.x ?? vw / 2, w / 2), vw - w / 2);
    const cy = Math.min(Math.max(at2?.y ?? vh / 2, h2 / 2), vh - h2 / 2);
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
    if (result.ok && id) {
      afterRender.ids = [id];
      void checkVideo({
        path: up.path,
        slide: slide.deckIndex,
        zone: id.replace(/^zone-/, ""),
        browser: size3
      });
    }
  }
  async function insertVideo() {
    const file = await pickFile(VIDEO_ACCEPT);
    if (file) await insertVideoFile(file);
  }
  async function insertFile(file, at2) {
    const zone = at2 ? mediaZoneAt(at2.clientX, at2.clientY) : null;
    if (zone) {
      await fillZone(zone, file);
      return;
    }
    if (isImage(file)) await insertImageFile(file, at2);
    else await insertVideoFile(file, at2);
  }
  async function insertImageFile(file, at2) {
    if (!await ensureOwnDrawing()) return;
    const up = await upload(file);
    const src = ownSource();
    if (!up || !src) return;
    const size3 = await naturalSize(up.rel);
    const svg = slideRoot();
    const vb = svg?.viewBox.baseVal;
    const maxW = (vb?.width || 1920) * 0.5;
    const maxH = (vb?.height || 1080) * 0.5;
    const k = Math.min(1, maxW / size3.w, maxH / size3.h);
    const w = size3.w * k;
    const h2 = size3.h * k;
    const cx = at2?.x ?? (vb?.width || 1920) / 2;
    const cy = at2?.y ?? (vb?.height || 1080) / 2;
    const parent = insertParent().el;
    const p = toParent(parent, cx - w / 2, cy - h2 / 2);
    const href = relativePath(src.path, up.path);
    await insertXml(
      `<image href="${href}" x="${fmt(p.x)}" y="${fmt(p.y)}" width="${fmt(w)}" height="${fmt(h2)}" preserveAspectRatio="xMidYMid meet"/>`,
      "image"
    );
  }
  async function insertDiagramImage(path, width, height) {
    if (!await ensureOwnDrawing()) return false;
    const src = ownSource();
    if (!src) return false;
    const svg = slideRoot();
    const vb = svg?.viewBox.baseVal;
    const slideW = vb?.width || 1920;
    const slideH = vb?.height || 1080;
    const k = Math.min(1, slideW * 0.6 / width, slideH * 0.6 / height);
    const w = width * k;
    const ht = height * k;
    const parent = insertParent().el;
    const p = toParent(parent, (slideW - w) / 2, (slideH - ht) / 2);
    return insertXml(
      `<image href="${relativePath(src.path, path)}" x="${fmt(p.x)}" y="${fmt(p.y)}" width="${fmt(w)}" height="${fmt(ht)}" preserveAspectRatio="xMidYMid meet"/>`,
      "diagram"
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
  var MEDIA_ACCEPT = `image/*,${VIDEO_ACCEPT}`;
  async function fillZone(zone, file) {
    const slide = currentSlide();
    if (!slide) return;
    const up = await upload(file);
    if (!up) return;
    const result = await edit({
      action: "zone-media",
      slide: slide.deckIndex,
      zone,
      src: up.path,
      fit: slide.zones[zone]?.fit ?? "cover"
    });
    if (result.ok && isVideo(file)) {
      void checkVideo({
        path: up.path,
        slide: slide.deckIndex,
        zone,
        browser: await videoSize(up.rel)
      });
    }
  }
  async function zoneMedia(zone) {
    const file = await pickFile(MEDIA_ACCEPT);
    if (file) await fillZone(zone, file);
  }
  function cleanForPaste(el2) {
    const copy2 = el2.cloneNode(true);
    for (const node of [copy2, ...copy2.querySelectorAll("*")]) {
      for (const attr of [...node.attributes]) {
        const name2 = attr.name;
        if (name2.startsWith("data-")) node.removeAttribute(name2);
        else if (name2 === "xlink:href") {
          node.setAttribute("href", assetRef(attr.value));
          node.removeAttribute(name2);
        } else if (["href", "src", "poster"].includes(name2)) {
          node.setAttribute(name2, assetRef(attr.value));
        } else if (name2.includes(":") && !name2.startsWith("xml:")) {
          node.removeAttribute(name2);
        } else if (name2 === "class") {
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
    hooks.typeInto = (el2) => void typeInto(el2);
    hooks.zoneMedia = (zone) => void zoneMedia(zone);
    hooks.zoneText = (zone) => void zoneText(zone);
    hooks.selectAfterRender = (ids) => {
      afterRender.ids = ids;
    };
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
      const at2 = {
        ...clientToSlide(e.clientX, e.clientY),
        clientX: e.clientX,
        clientY: e.clientY
      };
      const path = droppedPath(e.dataTransfer);
      void insertFile(path ? { path, name: file.name, file } : file, at2);
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
    const n2 = indices.length;
    toast(
      `Copied ${n2} slide${n2 > 1 ? "s" : ""}` + (dropped.length ? `; left out ${dropped.join(", ")}` : "")
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
    let files2 = {};
    if (refs.length) {
      const result = await request({ action: "copy-assets", refs });
      files2 = result.files ?? {};
    }
    await put({
      type: "inkflow-objects",
      version: 1,
      project: ed.model?.projectDir,
      sourceFile: currentSlide()?.sources?.[sels[0].key]?.path ?? "",
      fragments,
      files: files2
    });
    const n2 = sels.length;
    toast(`${cut2 ? "Cut" : "Copied"} ${n2} object${n2 > 1 ? "s" : ""}`);
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
    const n2 = result.pasted;
    toast(`Pasted ${n2} slide${n2 > 1 ? "s" : ""}`, "ok");
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

  // src/ts/editor/crop.ts
  function pictureOf(el2) {
    if (el2.localName === "image") return el2;
    if (el2.localName !== "svg" || !el2.getAttribute("viewBox")) return null;
    const images = [...el2.children].filter((c) => c.localName === "image");
    return images.length === 1 ? images[0] : null;
  }
  function isCropped(el2) {
    return el2.localName === "svg" && pictureOf(el2) !== null;
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

  // src/ts/editor/drawio.ts
  function diagramOf(el2) {
    const drawn = drawnDiagram(el2);
    if (drawn) return drawn;
    const image = pictureOf(el2);
    return image && isDiagramHref(hrefOf(image)) ? image : null;
  }
  function drawnDiagram(el2) {
    return el2.localName === "svg" && el2.hasAttribute("data-drawio") ? el2 : null;
  }
  function isDiagramHref(href) {
    return /\.drawio\.svg$/i.test(href.split(/[?#]/)[0]);
  }
  function hrefOf(el2) {
    return (el2.getAttribute("data-drawio") ?? el2.getAttribute("href") ?? el2.getAttribute("xlink:href") ?? "").split(/[?#]/)[0];
  }
  var DIAGRAM_MODES = [
    { value: "picture", label: "Picture" },
    { value: "inline", label: "Drawn on the slide" },
    { value: "themed", label: "In the deck's theme" }
  ];
  function diagramMode(el2) {
    const mode = drawnDiagram(el2)?.getAttribute("data-drawio-mode");
    return mode === "inline" || mode === "themed" ? mode : "picture";
  }
  var open2 = null;
  function editDiagram(sel) {
    const image = diagramOf(sel.el);
    const src = sourceOf(sel.key);
    if (!image || !src) return;
    if (!src.writable) {
      toast("This picture lives in a layout; switch to layout mode", "error");
      return;
    }
    void openDrawio({
      path: hrefOf(image),
      image: {
        file: src.path,
        hash: src.hash,
        loc: image.getAttribute("data-ink") ?? sel.loc
      },
      id: image.getAttribute("id")
    });
  }
  function newDiagram() {
    if (!currentSlide()) return;
    void openDrawio({ path: null });
  }
  async function openDrawio(target) {
    if (open2) return;
    const res = await request({ action: "drawio-load", path: target.path });
    if (!res.ok) {
      toast(res.error ?? "Cannot open that diagram", "error");
      return;
    }
    const base2 = String(res.url);
    let origin;
    try {
      origin = new URL(base2).origin;
    } catch {
      toast(`INKFLOW_DRAWIO_URL is not a web address: ${base2}`, "error");
      return;
    }
    const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origin);
    if (!navigator.onLine && !local) {
      offerDesktop(
        target,
        `This computer is offline, and draw.io loads from ${origin}.`
      );
      return;
    }
    const dark = document.documentElement.dataset.theme !== "light";
    const params = new URLSearchParams({
      embed: "1",
      proto: "json",
      spin: "1",
      configure: "1",
      saveAndExit: "1",
      noSaveBtn: "0",
      libraries: "1",
      modified: "unsavedChanges",
      ui: dark ? "dark" : "kennedy"
    });
    const frame = h("iframe", {
      class: "drawio-frame",
      src: `${base2}${base2.includes("?") ? "&" : "?"}${params}`,
      title: "draw.io"
    });
    let path = target.path;
    let exitAfterSave = false;
    let saving = false;
    let loaded = false;
    const status2 = h("p", {}, `Loading draw.io from ${origin}\u2026`);
    const note = h(
      "div",
      { class: "drawio-note" },
      h(
        "div",
        { class: "drawio-note-card" },
        status2,
        h(
          "div",
          { class: "btn-row" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              title: "Draw it in the draw.io app on this computer (no internet needed)",
              onclick: () => {
                close2();
                void useDesktop({ ...target, path });
              }
            },
            "Use draw.io desktop instead"
          ),
          h(
            "button",
            { type: "button", class: "pbtn", onclick: () => close2() },
            "Cancel"
          )
        )
      )
    );
    const wrap2 = h("div", { id: "drawio", class: "drawio" }, frame, note);
    document.body.append(wrap2);
    open2 = wrap2;
    const slow = window.setTimeout(() => {
      if (loaded) return;
      status2.textContent = `draw.io did not load from ${origin}. Is this computer offline? Draw the diagram in draw.io desktop instead.`;
      note.classList.add("failed");
    }, 15e3);
    const post = (msg) => frame.contentWindow?.postMessage(JSON.stringify(msg), origin);
    const close2 = () => {
      window.clearTimeout(slow);
      window.removeEventListener("message", onMessage);
      wrap2.remove();
      open2 = null;
    };
    const save3 = async (svg) => {
      const first = path === null;
      const step = `drawio-save-${Date.now()}`;
      const result = await edit({
        action: "drawio-save",
        path,
        svg,
        image: first ? void 0 : target.image,
        coalesce: step
      });
      if (result.ok && !first && target.id) followArrows(target.id, step);
      saving = false;
      if (!result.ok) {
        post({ action: "status", message: "Not saved", modified: true });
        return;
      }
      if (first && typeof result.rel === "string") {
        path = result.rel;
        await insertDiagramImage(
          String(result.path),
          Number(result.width) || 640,
          Number(result.height) || 360
        );
      }
      if (exitAfterSave) close2();
      else post({ action: "status", message: "Saved", modified: false });
    };
    const onMessage = (e) => {
      if (e.source !== frame.contentWindow || e.origin !== origin) return;
      let msg;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      switch (msg.event) {
        case "configure":
          loaded = true;
          post({ action: "configure", config: { compressXml: false } });
          break;
        case "init":
          loaded = true;
          note.remove();
          post({
            action: "load",
            xml: String(res.xml ?? ""),
            autosave: 0,
            title: String(res.name ?? "Diagram")
          });
          break;
        case "save":
          if (saving) break;
          saving = true;
          exitAfterSave = !!msg.exit;
          post({ action: "export", format: "xmlsvg", spin: "Saving" });
          break;
        case "export": {
          const data = String(msg.data ?? "");
          const svg = decodeSvg(data);
          if (svg) void save3(svg);
          else {
            saving = false;
            toast("draw.io sent something other than an SVG", "error");
          }
          break;
        }
        case "exit":
          close2();
          break;
      }
    };
    window.addEventListener("message", onMessage);
  }
  function followArrows(id, step) {
    const rendered2 = () => {
      off("render", rendered2);
      window.clearTimeout(give);
      const stale = connectorsTo(id).filter(isStale);
      if (stale.length)
        void rerouteConnectors(stale, "Re-route arrows", step);
    };
    const give = window.setTimeout(() => off("render", rendered2), 1e4);
    on("render", rendered2);
  }
  var redraws = /* @__PURE__ */ new Map();
  var redrawCount = 0;
  function diagramEdited(diagram, step) {
    const id = diagram.getAttribute("id");
    if (!id) return;
    const n2 = ++redrawCount;
    window.clearTimeout(timers.get(id));
    redraws.set(id, n2);
    timers.set(
      id,
      window.setTimeout(() => void redraw(id, step, n2), 600)
    );
  }
  var timers = /* @__PURE__ */ new Map();
  function drawnById(id) {
    return slideRoot()?.querySelector(
      `svg[data-drawio][id="${CSS.escape(id)}"]`
    ) ?? null;
  }
  function rendered(ms = 4e3) {
    return new Promise((resolve) => {
      const done = () => {
        off("render", done);
        window.clearTimeout(give);
        resolve();
      };
      const give = window.setTimeout(done, ms);
      on("render", done);
    });
  }
  async function redraw(id, step, n2) {
    const latest = () => redraws.get(id) === n2;
    await rendered(1500);
    const diagram = drawnById(id);
    const path = diagram?.getAttribute("data-drawio");
    if (!diagram || !path || !latest()) return;
    const res = await request({ action: "drawio-load", path });
    if (!res.ok || !latest()) return;
    let svg;
    try {
      svg = await renderDiagram(String(res.xml ?? ""), String(res.url));
    } catch (err) {
      if (latest()) {
        toast(
          `${err instanceof Error ? err.message : String(err)}: the shape changed, and draw.io's own arrows follow it the next time draw.io opens the diagram`,
          "error"
        );
      }
      return;
    }
    const now = drawnById(id);
    const src = now ? sourceOf(keyOf(now)) : null;
    const box = now ? alignedBox(now, svg) : null;
    if (!now || !src || !box || !latest()) return;
    const result = await edit(
      {
        action: "drawio-save",
        path,
        svg,
        expect: res.hash,
        image: {
          file: src.path,
          hash: src.hash,
          loc: now.getAttribute("data-ink") ?? ""
        },
        box,
        coalesce: step
      },
      { retrying: true }
    );
    if (result.ok) {
      redraws.delete(id);
      followArrows(id, step);
    }
  }
  function alignedBox(diagram, svgText) {
    const holder = h("div", {
      style: "position:fixed;left:-30000px;top:0;visibility:hidden",
      "aria-hidden": "true"
    });
    holder.innerHTML = svgText;
    document.body.append(holder);
    try {
      const fresh = holder.querySelector("svg");
      const oldRoot = diagram.querySelector(":scope > g");
      const newRoot = fresh?.querySelector(":scope > g");
      if (!fresh || !oldRoot || !newRoot) return null;
      const dx = [];
      const dy = [];
      for (const cell of diagram.querySelectorAll(
        'g[data-cell-kind="vertex"][data-cell-id]'
      )) {
        const id = cell.getAttribute("data-cell-id") ?? "";
        const other = newRoot.querySelector(
          `g[data-cell-id="${CSS.escape(id)}"]`
        );
        const a = drawnBox(cell, oldRoot);
        const b = other ? drawnBox(other, newRoot) : null;
        if (!a || !b) continue;
        dx.push(b.x - a.x);
        dy.push(b.y - a.y);
      }
      const vbOld = diagram.viewBox.baseVal;
      const vbNew = fresh.viewBox.baseVal;
      if (!dx.length || !vbOld?.width || !vbNew?.width) return null;
      const num2 = (name2) => Number.parseFloat(diagram.getAttribute(name2) ?? "0") || 0;
      const sx = num2("width") / vbOld.width;
      const sy = num2("height") / vbOld.height;
      const r = (v) => Math.round(v * 100) / 100;
      return {
        x: r(num2("x") + (vbNew.x - vbOld.x - median(dx)) * sx),
        y: r(num2("y") + (vbNew.y - vbOld.y - median(dy)) * sy),
        width: r(vbNew.width * sx),
        height: r(vbNew.height * sy)
      };
    } finally {
      holder.remove();
    }
  }
  var renderer = null;
  var renderQueue = Promise.resolve();
  function closeRenderer() {
    renderer?.frame.remove();
    renderer = null;
  }
  function hiddenFrame(base2) {
    if (renderer && renderer.base === base2) {
      window.clearTimeout(renderer.closeTimer);
      renderer.closeTimer = window.setTimeout(closeRenderer, 18e4);
      return renderer;
    }
    closeRenderer();
    const origin = new URL(base2).origin;
    const params = new URLSearchParams({
      embed: "1",
      proto: "json",
      configure: "1",
      spin: "0"
    });
    const frame = h("iframe", {
      src: `${base2}${base2.includes("?") ? "&" : "?"}${params}`,
      title: "draw.io (drawing the diagram)",
      "aria-hidden": "true",
      tabindex: "-1",
      style: "position:fixed;left:-30000px;top:0;width:1200px;height:800px;border:0"
    });
    frame.inert = true;
    const ready = new Promise((resolve, reject) => {
      const give = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("draw.io did not load"));
      }, 2e4);
      const onMessage = (e) => {
        if (e.source !== frame.contentWindow || e.origin !== origin) return;
        const msg = parseMessage(e.data);
        if (msg?.event === "configure") {
          frame.contentWindow?.postMessage(
            JSON.stringify({
              action: "configure",
              config: { compressXml: false }
            }),
            origin
          );
        } else if (msg?.event === "init") {
          window.clearTimeout(give);
          window.removeEventListener("message", onMessage);
          resolve();
        }
      };
      window.addEventListener("message", onMessage);
    });
    document.body.append(frame);
    renderer = {
      base: base2,
      frame,
      origin,
      ready,
      closeTimer: window.setTimeout(closeRenderer, 18e4)
    };
    ready.catch(() => closeRenderer());
    return renderer;
  }
  function parseMessage(data) {
    try {
      return JSON.parse(String(data));
    } catch {
      return null;
    }
  }
  function renderDiagram(xml, base2) {
    const run = renderQueue.then(async () => {
      let origin;
      try {
        origin = new URL(base2).origin;
      } catch {
        throw new Error(`INKFLOW_DRAWIO_URL is not a web address: ${base2}`);
      }
      const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origin);
      if (!navigator.onLine && !local)
        throw new Error("This computer is offline");
      const r = hiddenFrame(base2);
      await r.ready;
      return new Promise((resolve, reject) => {
        const post = (msg) => r.frame.contentWindow?.postMessage(
          JSON.stringify(msg),
          r.origin
        );
        const finish = () => {
          window.clearTimeout(give);
          window.removeEventListener("message", onMessage);
          if (document.activeElement === r.frame) r.frame.blur();
        };
        const give = window.setTimeout(() => {
          finish();
          reject(new Error("draw.io did not draw the diagram"));
        }, 2e4);
        const onMessage = (e) => {
          if (e.source !== r.frame.contentWindow || e.origin !== r.origin)
            return;
          const msg = parseMessage(e.data);
          if (msg?.event === "load") {
            post({ action: "export", format: "xmlsvg", spin: "0" });
          } else if (msg?.event === "export") {
            finish();
            const svg = decodeSvg(String(msg.data ?? ""));
            if (svg) resolve(svg);
            else reject(new Error("draw.io sent no SVG"));
          }
        };
        window.addEventListener("message", onMessage);
        post({ action: "load", xml, autosave: 0 });
      });
    });
    renderQueue = run.catch(() => void 0);
    return run;
  }
  function offerDesktop(target, why) {
    openDialog(
      "Draw in draw.io desktop?",
      h(
        "div",
        { class: "deck-form" },
        h("p", {}, why),
        h(
          "p",
          { class: "hint" },
          "The diagram can be drawn in the draw.io app on this computer instead: save there, and the slide updates."
        ),
        h(
          "div",
          { class: "btn-row end" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => closeDialog()
            },
            "Cancel"
          ),
          h(
            "button",
            {
              type: "button",
              class: "pbtn primary",
              onclick: () => {
                closeDialog();
                void useDesktop(target);
              }
            },
            "Open in draw.io desktop"
          )
        )
      )
    );
  }
  async function useDesktop(target) {
    let path = target.path;
    const apps = path ? await request({ action: "open-apps", path }) : null;
    if (path && !hasDesktop(apps?.apps)) {
      desktopMissing();
      return;
    }
    if (!path) {
      const made = await edit({ action: "drawio-new" });
      if (!made.ok || typeof made.rel !== "string") return;
      path = made.rel;
      const placed = await insertDiagramImage(
        String(made.path),
        Number(made.width) || 640,
        Number(made.height) || 360
      );
      if (!placed) return;
      const found = await request({ action: "open-apps", path });
      if (!hasDesktop(found.apps)) {
        desktopMissing();
        return;
      }
    }
    const res = await request({ action: "open-file", path, app: "drawio" });
    if (!res.ok) {
      toast(res.error ?? "draw.io desktop did not start", "error");
      return;
    }
    toast("Opened in draw.io desktop: save there and the slide updates", "ok");
  }
  function hasDesktop(apps) {
    return Array.isArray(apps) && apps.some((a) => a.id === "drawio");
  }
  function desktopMissing() {
    openDialog(
      "draw.io desktop is not installed",
      h(
        "div",
        { class: "deck-form" },
        h(
          "p",
          {},
          "Install the draw.io app (free) on this computer, then try again:"
        ),
        h(
          "ul",
          {},
          h(
            "li",
            {},
            h(
              "a",
              {
                href: "https://www.drawio.com/",
                target: "_blank",
                rel: "noopener"
              },
              "drawio.com"
            ),
            " (Windows, macOS, Linux)"
          ),
          h(
            "li",
            {},
            "Linux: flatpak install flathub com.jgraph.drawio.desktop"
          )
        ),
        h(
          "p",
          { class: "hint" },
          "Or run draw.io on your own network (the jgraph/drawio Docker image) and start inkflow with INKFLOW_DRAWIO_URL pointing at it."
        )
      )
    );
  }
  function decodeSvg(data) {
    const m = data.match(/^data:image\/svg\+xml(;base64)?,(.*)$/s);
    if (!m) return data.trimStart().startsWith("<") ? data : null;
    if (!m[1]) return decodeURIComponent(m[2]);
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
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
  function label(el2) {
    if (isZone(el2)) return `Zone \xB7 ${zoneName(el2)}`;
    const id = el2.getAttribute("id");
    const kind = el2.hasAttribute("data-ink-layer") ? "Layer" : NAMES[el2.localName] ?? el2.localName;
    if (el2.localName === "text") {
      const t = (el2.textContent ?? "").trim().replace(/\s+/g, " ");
      return id ? `${id} \xB7 \u201C${t.slice(0, 24)}\u201D` : `\u201C${t.slice(0, 32)}\u201D`;
    }
    return id ?? kind;
  }
  function isHidden(el2) {
    return el2.style?.display === "none" || el2.getAttribute("display") === "none";
  }
  function children(el2) {
    return [...el2.children].filter(
      (c) => c.hasAttribute("data-ink") && !["title", "desc", "defs", "style", "metadata"].includes(
        c.localName
      ) && // A cropped picture's own <image> is part of the picture.
      el2.localName !== "svg"
    );
  }
  function selFor(el2) {
    return {
      el: el2,
      key: keyOf(el2),
      loc: el2.getAttribute("data-ink") ?? ""
    };
  }
  async function toggleHidden2(el2) {
    await sendSvgOps(
      [
        {
          sel: selFor(el2),
          ops: [
            {
              kind: "style",
              loc: el2.getAttribute("data-ink") ?? "",
              set: { display: isHidden(el2) ? null : "none" }
            }
          ]
        }
      ],
      isHidden(el2) ? "Show" : "Hide"
    );
  }
  async function toggleLocked(el2) {
    const own = el2.hasAttribute("data-ink-locked");
    if (!own && isLocked(el2)) {
      toast("It is inside a locked layer or group: unlock that instead");
      return;
    }
    await sendSvgOps(
      [
        {
          sel: selFor(el2),
          ops: [
            {
              kind: "lock",
              loc: el2.getAttribute("data-ink") ?? "",
              locked: !own
            }
          ]
        }
      ],
      own ? "Unlock" : "Lock"
    );
  }
  function rename(el2, nameEl) {
    const src = sourceOf(keyOf(el2));
    if (!src?.writable || isZone(el2)) return;
    const id = el2.getAttribute("id") ?? "";
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
              loc: el2.getAttribute("data-ink"),
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
  function pickFromList(el2) {
    if (isLocked(el2)) {
      toast("Locked: unlock it to select it");
      return;
    }
    const parent = el2.parentElement;
    if (parent && !el2.hasAttribute("data-ink-top") && parent.localName === "g" && !parent.hasAttribute("data-ink-layer")) {
      enterGroup(parent);
    } else if (ed.scope && !ed.scope.contains(el2)) {
      enterGroup(null);
    }
    if (!selectable(el2)) {
      toast(
        ed.layoutMode ? "This object cannot be edited here" : "From a layout or overlay: use Edit layout to change it"
      );
      return;
    }
    select([el2]);
  }
  function row(el2, depth) {
    const loc = el2.getAttribute("data-ink") ?? "";
    const src = sourceOf(keyOf(el2));
    const writable = !!src?.writable && (canTransform(el2) || ed.layoutMode || isOwnObject(el2));
    const kids = children(el2);
    const group = kids.length > 0;
    const open4 = group && !collapsed.has(loc);
    const selected = ed.selection.some((s) => s.el === el2);
    const locked = el2.hasAttribute("data-ink-locked");
    const hidden = isHidden(el2);
    const name2 = h("span", { class: "obj-name" }, label(el2));
    const out = [];
    const item = h(
      "div",
      {
        class: `obj-row${selected ? " on" : ""}${writable ? "" : " foreign"}${hidden ? " hidden-obj" : ""}`,
        title: src ? `${label(el2)} \xB7 ${src.rel}` : label(el2),
        style: `padding-left:${8 + depth * 14}px`
      },
      h(
        "button",
        {
          type: "button",
          class: `obj-twisty${group ? "" : " none"}`,
          title: open4 ? "Collapse" : "Expand",
          onclick: (e) => {
            e.stopPropagation();
            if (collapsed.has(loc)) collapsed.delete(loc);
            else collapsed.add(loc);
            renderObjects();
          }
        },
        group ? open4 ? "\u25BE" : "\u25B8" : ""
      ),
      name2,
      writable ? h(
        "button",
        {
          type: "button",
          class: `obj-toggle${hidden ? " on" : ""}`,
          title: hidden ? "Hidden: click to show" : "Hide (on the slide and in the presentation)",
          onclick: (e) => {
            e.stopPropagation();
            void toggleHidden2(el2);
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
            void toggleLocked(el2);
          }
        },
        icon(locked ? "lock" : "unlock", 14)
      ) : h("span", { class: "obj-badge" }, src?.role ?? "")
    );
    item.addEventListener("click", () => pickFromList(el2));
    item.addEventListener("dblclick", () => rename(el2, name2));
    item.addEventListener("mouseenter", () => setHover(el2));
    item.addEventListener("mouseleave", () => setHover(null));
    out.push(item);
    if (open4) {
      for (const k of [...kids].reverse()) out.push(...row(k, depth + 1));
    }
    return out;
  }
  function isOwnObject(el2) {
    const src = sourceOf(keyOf(el2));
    return !!src && src.role === "slide" && src.writable;
  }
  function renderObjects() {
    if (host3.hidden) return;
    clear(host3);
    const svg = slideRoot();
    if (!svg) return;
    const top = [...svg.querySelectorAll("[data-ink-top], [data-ink-layer]")].filter((el2) => {
      const parent = el2.parentElement?.closest(
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
    for (const el2 of top) host3.append(...row(el2, 0));
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

  // src/ts/editor/animsteps.ts
  function cueSteps(cues, svg) {
    const seen = /* @__PURE__ */ new Map();
    return cues.map((cue) => {
      if (!svg) return null;
      const byId2 = (id) => svg.querySelector(`[id="${CSS.escape(id)}"]`);
      if (cue.kind === "video") {
        const zone = byId2(`zone-${cue.element}`) ?? byId2(cue.element);
        const v = zone?.querySelector("[data-play-on-step]");
        const s = Number(v?.getAttribute("data-play-on-step"));
        return Number.isFinite(s) && s > 0 ? s : null;
      }
      const el2 = byId2(cue.element) ?? byId2(`zone-${cue.element}`);
      const n2 = seen.get(cue.element) ?? 0;
      seen.set(cue.element, n2 + 1);
      try {
        const list3 = JSON.parse(el2?.getAttribute("data-cues") ?? "[]");
        const steps = list3.map((c) => c.step).sort((a, b) => a - b);
        return steps[n2] ?? null;
      } catch {
        return null;
      }
    });
  }

  // src/ts/editor/animpreview.ts
  var current = null;
  function previewPlaying() {
    return current !== null;
  }
  function stopPreview() {
    current?.cancel();
  }
  function wait(ms, cancelled) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        if (cancelled() || now - t0 >= ms) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
  function playRun(root2, from, to, cancelled) {
    const run = buildStepRun(root2, from, to);
    if (!run.totalMs) return Promise.resolve();
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        if (cancelled()) {
          resolve();
          return;
        }
        const v = Math.min(1, (now - t0) / run.totalMs);
        seekStepRun(run, v);
        if (v < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }
  function showStep(step) {
    const sel = document.getElementById("step-select");
    if (sel) sel.value = step == null ? "" : String(step);
    for (const row3 of document.querySelectorAll(
      ".anim-row[data-step]"
    )) {
      row3.classList.toggle(
        "playing",
        step != null && row3.dataset.step === String(step)
      );
    }
  }
  async function playAnimations(from = 1) {
    stopPreview();
    const first = slideRoot();
    const last = first ? maxStep(first) : 0;
    if (!first || last === 0) {
      toast("Nothing on this slide is animated yet");
      return;
    }
    const before = ed.step;
    let cancelled = false;
    const run = { cancel: () => cancelled = true };
    current = run;
    const stopOnClick = (e) => {
      if (!e.target.closest?.(".anim-preview-ctl")) run.cancel();
    };
    const stopOnKey = (e) => {
      if (e.key === "Escape") run.cancel();
    };
    document.addEventListener("pointerdown", stopOnClick, true);
    document.addEventListener("keydown", stopOnKey, true);
    document.body.classList.add("previewing", "anim-playing");
    emit("preview");
    ed.step = Math.max(0, Math.min(from, last) - 1);
    render();
    const root2 = slideRoot();
    const gone = () => cancelled || slideRoot() !== root2;
    if (root2) {
      for (let s = ed.step + 1; s <= last && !gone(); s++) {
        showStep(s);
        await playRun(root2, s - 1, s, gone);
        if (gone()) break;
        applyStepInstant(root2, s);
        ed.step = s;
        await wait(s < last ? 450 : 900, gone);
      }
    }
    document.removeEventListener("pointerdown", stopOnClick, true);
    document.removeEventListener("keydown", stopOnKey, true);
    if (current === run) current = null;
    document.body.classList.remove("anim-playing");
    document.body.classList.toggle("previewing", before != null);
    ed.step = before;
    showStep(null);
    render();
    emit("preview");
  }

  // src/ts/editor/videopreview.ts
  function videoOf(el2) {
    if (!el2) return null;
    return el2.localName === "video" ? el2 : el2.querySelector("video");
  }
  function isPreviewing(video) {
    return !video.paused && !video.ended;
  }
  function togglePreview(video) {
    if (isPreviewing(video)) {
      video.pause();
      return;
    }
    const start = parseFloat(video.dataset.start ?? "") || 0;
    const end = parseFloat(video.dataset.end ?? "");
    if (video.currentTime < start || end > 0 && video.currentTime >= end) {
      video.currentTime = start;
    }
    if (end > 0) {
      const stop = () => {
        if (video.currentTime >= end) {
          video.pause();
          video.removeEventListener("timeupdate", stop);
        }
      };
      video.addEventListener("timeupdate", stop);
    }
    void video.play().catch(() => {
    });
  }
  function previewButton(video, make) {
    const btn = make(
      "\u25B6 Play preview",
      "Play the video here (the presenter plays it as the deck says)",
      () => togglePreview(video)
    );
    const sync = () => {
      btn.textContent = isPreviewing(video) ? "\u23F8 Pause preview" : "\u25B6 Play preview";
    };
    for (const ev of ["play", "pause", "ended"])
      video.addEventListener(ev, sync);
    sync();
    return btn;
  }

  // src/ts/editor/props.ts
  var panel = document.getElementById("props-body");
  function section(title2, ...body2) {
    return h(
      "section",
      { class: "props-section" },
      h("h3", {}, title2),
      ...body2.filter((b) => !!b)
    );
  }
  function row2(label4, ...controls) {
    return h(
      "label",
      { class: "prop-row" },
      h("span", { class: "prop-label" }, label4),
      ...controls
    );
  }
  function numberInput(value, commit, opts2 = {}) {
    const input = h("input", {
      type: "number",
      class: "num",
      step: opts2.step ?? 1,
      min: opts2.min ?? null,
      placeholder: opts2.placeholder ?? "",
      value: value == null ? "" : String(Math.round(value * 100) / 100)
    });
    const fire = () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) commit(v);
      else if (input.value.trim() === "") opts2.onClear?.();
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
  function button(label4, title2, fn, cls = "") {
    return h(
      "button",
      { type: "button", class: `pbtn ${cls}`, title: title2, onclick: fn },
      label4
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
        const opts2 = f.choices.map((c) => ({
          value: c,
          label: labels[c] ?? c
        }));
        if (!f.choices.includes(v))
          opts2.push({ value: v, label: `At step ${v}` });
        return selectInput(opts2, v, commit);
      }
      case "enum":
      case "easing": {
        const v = String(value ?? f.default ?? "");
        const opts2 = f.choices.map((c) => ({ value: c, label: c }));
        if (v && !f.choices.includes(v)) opts2.push({ value: v, label: v });
        return selectInput(opts2, v, commit);
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
      const label4 = f.name.replace(/_/g, " ");
      box.append(
        row2(
          label4,
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
    const commit = (name2, v) => void edit({
      action: "media-props",
      slide: slide.deckIndex,
      zone,
      fields: { [name2]: v }
    });
    const rows = [];
    for (const f of schema) {
      const label4 = MEDIA_LABELS[f.name] ?? f.name.replace(/_/g, " ");
      if (f.name === "poster") {
        const poster = values.poster;
        rows.push(
          h(
            "div",
            { class: "prop-row" },
            h("span", { class: "prop-label" }, label4),
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
        const opts2 = [
          { value: "auto", label: "When autoplaying" },
          { value: "on", label: "Always" },
          { value: "off", label: "Never" }
        ];
        rows.push(
          row2(
            label4,
            selectInput(
              opts2,
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
            label4,
            numberInput(
              typeof v === "number" ? v : null,
              (n2) => commit(f.name, n2),
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
          label4,
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
  function typeInfo(list3, type) {
    return list3.find((t) => t.type === type) ?? null;
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
    const files2 = h("div", { class: "files" });
    const addFile = (label4, rel, path) => {
      if (rel)
        files2.append(
          h(
            "div",
            { class: "file" },
            h("span", {}, label4),
            h("code", { title: path ?? rel }, rel),
            openButton(path)
          )
        );
    };
    addFile("Drawing", slide.srcShared ? null : slide.srcRel, slide.srcPath);
    addFile("Layout", slide.srcShared ? slide.srcRel : null, slide.srcPath);
    addFile("Markdown", slide.md?.rel, slide.md?.path);
    addFile("Notes", slide.notes.rel, slide.notes.path);
    const deckPath = ed.model?.deckPath;
    if (deckPath) addFile("Deck", fileName(deckPath), deckPath);
    const textInDeck = slide.md?.kind !== "file" && (slide.md?.kind === "inline" || Object.values(slide.zones).some((z) => z.kind === "text"));
    if (textInDeck && editable)
      files2.append(
        button(
          "Move text to Markdown",
          "Move this slide's text out of deck.py into its own .md file",
          () => void edit({ action: "to-markdown", slide: di })
        )
      );
    panel.append(section("Files", files2));
    const arrows = attachedConnectors();
    if (arrows.length) {
      const stale = arrows.filter((a) => isStale(a.el)).length;
      panel.append(
        section(
          "Arrows",
          h(
            "p",
            { class: "hint" },
            `${arrows.length} arrow${arrows.length === 1 ? " is" : "s are"} attached to shapes and follow them when they move here. After moving shapes in another editor, re-route them:`
          ),
          stale ? h(
            "p",
            { class: "hint warn" },
            `${stale} ${stale === 1 ? "arrow no longer meets its shape" : "arrows no longer meet their shapes"} (moved in draw.io or another editor).`
          ) : null,
          button(
            "Re-route all",
            "Re-attach every arrow to its shapes",
            () => reroute(arrows)
          )
        )
      );
    }
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
  function transitionSection(current2, di) {
    const model = ed.model;
    const types = model.transitionTypes;
    const value = current2?.type ?? "";
    const opts2 = [
      { value: "", label: `Deck default (${model.defaultTransition.type})` },
      ...types.map((t) => ({ value: t.type, label: t.type }))
    ];
    const send = (spec) => void edit({ action: "slide", op: "transition", slide: di, spec });
    const body2 = [
      row2(
        "Type",
        selectInput(opts2, value, (v) => {
          if (!v) send(null);
          else send({ type: v, fields: {} });
        })
      )
    ];
    if (current2) {
      const info3 = typeInfo(types, current2.type);
      if (info3) {
        body2.push(
          fieldsEditor(
            info3.fields,
            current2.fields,
            (fields) => send({ type: current2.type, fields })
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
    const model = ed.model;
    const list3 = h("div", { class: "anim-list" });
    if (!cues.length)
      list3.append(h("p", { class: "hint" }, "No animations on this slide."));
    const steps = cueSteps(cues, slideRoot());
    const replace2 = (i, type, fields) => void edit({
      action: "anim",
      slide: di,
      op: "replace",
      index: i,
      spec: { type, element: cues[i].element, fields }
    });
    cues.forEach((cue, i) => {
      const step = steps[i];
      const info3 = typeInfo(model.animationTypes, cue.type);
      const trigger = cue.fields.trigger ?? "on-click";
      const typeSelect = selectInput(
        model.animationTypes.filter((t) => t.kind === "video" === (cue.kind === "video")).map((t) => ({ value: t.type, label: t.type })),
        cue.type,
        (v) => {
          const names = new Set(
            typeInfo(model.animationTypes, v)?.fields.map(
              (f) => f.name
            )
          );
          const kept = Object.fromEntries(
            Object.entries(cue.fields).filter(([k]) => names.has(k))
          );
          replace2(i, v, { ...kept, trigger });
        }
      );
      const triggerField = info3?.fields.find((f) => f.kind === "trigger");
      const triggerSelect = triggerField ? fieldControl(
        triggerField,
        trigger,
        (v) => replace2(i, cue.type, { ...cue.fields, trigger: v })
      ) : null;
      const item = h(
        "div",
        {
          class: "anim-row",
          "data-step": step == null ? null : String(step)
        },
        h(
          "div",
          { class: "anim-item" },
          h("span", {
            class: `anim-kind k-${cue.kind}`,
            title: cue.kind
          }),
          h(
            "span",
            {
              class: "anim-step",
              title: step == null ? "Not on the slide" : `Plays on click ${step}`
            },
            step == null ? "\u2013" : String(step)
          ),
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
          step != null && button(
            icon("play", 12),
            "Preview from this animation",
            () => void playAnimations(step),
            "anim-preview-ctl"
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
        ),
        editable ? h("div", { class: "anim-edit" }, typeSelect, triggerSelect) : h(
          "div",
          { class: "anim-edit" },
          h("span", { class: "anim-type" }, cue.type),
          h(
            "span",
            { class: "anim-trigger" },
            triggerLabel(cue.fields.trigger ?? null)
          )
        )
      );
      list3.append(item);
    });
    if (!editable && cues.length) {
      list3.append(
        h(
          "p",
          { class: "hint" },
          "Animations are built in code in deck.py; read-only."
        )
      );
    }
    const svg = slideRoot();
    const animated = !!svg && maxStep(svg) > 0;
    const playing = previewPlaying();
    const controls = h(
      "div",
      { class: "btn-row anim-preview" },
      playing ? button(
        "\u25A0 Stop",
        "Stop the preview (Esc)",
        () => stopPreview(),
        "anim-preview-ctl"
      ) : button(
        "\u25B6 Play",
        "Play this slide's animations here, click by click",
        () => void playAnimations(1),
        "anim-preview-ctl"
      )
    );
    if (!animated && !playing)
      controls.firstChild.disabled = true;
    return section("Animation order", controls, list3);
  }
  function selectById(id) {
    const svg = slideRoot();
    const found = svg?.querySelector(`[id="${CSS.escape(id)}"]`);
    const el2 = found?.closest("[data-ink]") ?? null;
    if (el2) {
      enterGroup(null);
      select([el2]);
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
    const steps = cueSteps(slide.animations, slideRoot());
    slide.animations.forEach((cue, index) => {
      if (!elementName || cue.element !== (cue.kind === "video" ? zoneName(sel.el) : id))
        return;
      const info3 = typeInfo(model.animationTypes, cue.type);
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
        steps[index] != null && button(
          icon("play", 12),
          `Preview (click ${steps[index]})`,
          () => void playAnimations(steps[index] ?? 1),
          "anim-preview-ctl"
        ),
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
          info3 && editable ? fieldsEditor(
            info3.fields,
            cue.fields,
            (f) => send(cue.type, f)
          ) : null
        )
      );
    });
    if (editable) {
      const add = animationPicker(
        model.animationTypes,
        isZone(sel.el),
        "+ Add animation\u2026"
      );
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
  function animationPicker(all, video, prompt) {
    const groups = {};
    for (const t of all) {
      if (t.kind === "video" && !video) continue;
      const kind = t.kind ?? "other";
      groups[kind] = [...groups[kind] ?? [], t];
    }
    const add = h("select", { class: "add-anim" });
    add.append(h("option", { value: "" }, prompt));
    for (const [kind, types] of Object.entries(groups)) {
      const og = h("optgroup", { label: kind });
      for (const t of types)
        og.append(h("option", { value: t.type }, t.type));
      add.append(og);
    }
    return add;
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
  function tokenOf(el2, prop) {
    for (const c of el2.classList) {
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
  function boxOps(s) {
    return isZone(s.el) ? [{ kind: "attrs", loc: s.loc, set: { "inkflow:show-shape": "true" } }] : [];
  }
  function boxShown(el2) {
    return !isZone(el2) || el2.hasAttribute("inkflow:show-shape");
  }
  function paintRow(sel, prop) {
    const first = sel[0].el;
    const shown = boxShown(first);
    const token = shown ? tokenOf(first, prop) : null;
    const computed = shown ? getComputedStyle(first)[prop] : "none";
    const send = (paint) => {
      const plans = sel.map((s) => ({
        sel: s,
        ops: [
          ...boxOps(s),
          { kind: "paint", loc: s.loc, prop, ...paint }
        ]
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
  function styleOps(sel, set, label4) {
    void sendSvgOps(
      sel.map((s) => ({
        sel: s,
        ops: [...boxOps(s), { kind: "style", loc: s.loc, set }]
      })),
      label4
    );
  }
  function focusCellLabel(_el) {
    const area2 = panel.querySelector(".cell-label");
    area2?.focus();
    area2?.select();
  }
  function tokenHex(token) {
    const probe = h("span", { style: `color: var(--inkflow-${token})` });
    (slideRoot()?.parentElement ?? document.body).append(probe);
    const hex = rgbToHex(getComputedStyle(probe).color);
    probe.remove();
    return hex;
  }
  function cellColorRow(label4, current2, pick2) {
    const swatches = h("div", { class: "swatches" });
    for (const t of ed.model?.colorTokens ?? []) {
      swatches.append(
        h("button", {
          type: "button",
          class: "swatch",
          title: `${t} (as its colour now)`,
          style: `background: var(--inkflow-${t})`,
          onclick: () => pick2(tokenHex(t))
        })
      );
    }
    const custom = h("input", {
      type: "color",
      value: current2,
      title: "Custom colour"
    });
    custom.addEventListener("change", () => pick2(custom.value));
    swatches.append(custom);
    return row2(label4, swatches);
  }
  function renderCellPanel(sel) {
    const el2 = sel.el;
    const cell = el2.getAttribute("data-cell-id") ?? "";
    const themed = el2.closest("svg[data-drawio]")?.getAttribute("data-drawio-mode") === "themed";
    const send = (op, label4) => void sendSvgOps([{ sel, ops: [op] }], label4);
    const style = (key, value, label4) => send({ kind: "cell-style", cell, key, value }, label4);
    const painted2 = cellShape(el2).querySelector(
      "rect, ellipse, path, polygon, circle"
    );
    const look = painted2 ? getComputedStyle(painted2) : null;
    const hex = (v) => v && v !== "none" ? rgbToHex(v) : "#ffffff";
    const area2 = h("textarea", {
      class: "cell-label",
      rows: 2,
      spellcheck: "true"
    });
    area2.value = cellLabel(el2);
    area2.addEventListener(
      "change",
      () => send({ kind: "cell-label", cell, text: area2.value }, "Shape label")
    );
    area2.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) area2.blur();
    });
    panel.append(
      section(
        "draw.io shape",
        row2("Id", h("code", {}, el2.getAttribute("id") ?? "")),
        row2("Label", area2),
        cellColorRow(
          "Fill",
          hex(look?.fill),
          (v) => style("fillColor", v, "Shape fill")
        ),
        cellColorRow(
          "Line",
          hex(look?.stroke),
          (v) => style("strokeColor", v, "Shape line")
        ),
        row2(
          "Line width",
          numberInput(
            parseFloat(look?.strokeWidth ?? "1") || 1,
            (v) => style("strokeWidth", v, "Shape line width")
          )
        ),
        h(
          "p",
          { class: "hint" },
          `Changes go into the diagram's draw.io source, and draw.io redraws it (its arrows follow).${themed ? " In the deck's theme, colours show as the nearest theme colour." : ""} Copying, grouping, rotating and stacking shapes stay in draw.io. Esc leaves the diagram.`
        ),
        h(
          "div",
          { class: "btn-row" },
          button("Leave the diagram", "Esc", () => enterGroup(null))
        )
      )
    );
    panel.append(geometrySection([sel]));
    panel.append(elementAnimations(sel));
  }
  function renderObjectPanel(sel) {
    const el2 = sel.el;
    if (isDiagramCell(el2)) {
      renderCellPanel(sel);
      return;
    }
    const src = sourceOf(sel.key);
    const zone = isZone(el2);
    const movable = canTransform(el2);
    const id = el2.getAttribute("id") ?? "";
    const tag = zone ? `Zone \xB7 ${zoneName(el2)}` : drawnDiagram(el2) ? "Diagram" : TAG_NAMES[el2.localName] ?? el2.localName;
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
          "div",
          { class: "source-hint" },
          h(
            "p",
            { class: "hint" },
            `In ${src.rel}${src.role !== "slide" || currentSlide()?.srcShared ? ` \xB7 shared by ${src.usedBy.length} slide${src.usedBy.length === 1 ? "" : "s"}` : ""}`
          ),
          openButton(src.path)
        )
      )
    );
    if (zone) {
      const slide = currentSlide();
      const name2 = zoneName(el2);
      const origin = slide.zoneOrigins?.[name2];
      const media = slide.zones[name2];
      const where = origin === "deck" ? "deck.py zones=" : origin === "md-file" ? `${slide.md?.rel ?? "Markdown"} (whole file)` : slide.md?.rel ? `${slide.md.rel} \xB7 ::${name2}::` : "deck.py";
      const textFile = origin === "deck" || !slide.md?.path ? ed.model?.deckPath : slide.md.path;
      const isMedia = !!media && (media.kind === "image" || media.kind === "video");
      const body2 = [
        h(
          "div",
          { class: "source-hint" },
          h("p", { class: "hint" }, `Content from ${where}`),
          isMedia ? null : openButton(textFile)
        )
      ];
      if (media && (media.kind === "image" || media.kind === "video")) {
        body2.push(
          h(
            "div",
            { class: "source-hint" },
            h("p", { class: "hint media-src" }, media.src ?? ""),
            openButton(projectFile(media.src))
          ),
          button(
            "Replace media\u2026",
            "Pick another image or video",
            () => void zoneMedia(name2)
          ),
          button("Clear", "Empty this zone", () => {
            void edit({
              action: "zone-media",
              slide: slide.deckIndex,
              zone: name2,
              src: null
            });
          })
        );
        const video = media.kind === "video" ? videoOf(el2) : null;
        if (video) body2.push(previewButton(video, button));
        if (media.kind === "video" && media.src) {
          const src2 = media.src;
          body2.push(
            button(
              "Check & convert\u2026",
              "Can every browser play it? Convert it to MP4 or WebM, smaller or at another resolution",
              () => void openVideoCheck({
                path: src2,
                slide: slide.deckIndex,
                zone: name2
              })
            )
          );
        }
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
        panel.append(mediaSection(slide, name2, media));
      }
    }
    const innerVideo = zone ? null : videoOf(el2);
    if (innerVideo) {
      panel.append(section("Video", previewButton(innerVideo, button)));
    }
    if (movable) panel.append(geometrySection([sel]));
    const textZone = zone && el2.localName === "foreignObject" && !!el2.querySelector(".inkflow-content");
    const shapeTag = textZone ? el2.getAttribute("data-ink-tag") ?? "rect" : el2.localName;
    if ((!zone || textZone) && src?.writable && (movable || ed.layoutMode)) {
      const picture = !!pictureOf(el2) || !!drawnDiagram(el2);
      const fills = ![
        "line",
        "polyline",
        "image",
        "foreignObject",
        "g"
      ].includes(shapeTag);
      const strokeWidth = parseFloat(getComputedStyle(el2).strokeWidth) || 0;
      const opacity = parseFloat(getComputedStyle(el2).opacity);
      panel.append(
        section(
          "Style",
          fills && !picture && paintRow([sel], "fill"),
          !picture && el2.localName !== "g" && paintRow([sel], "stroke"),
          !picture && el2.localName !== "g" && row2(
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
          shapeTag === "rect" && row2(
            "Corner radius",
            numberInput(
              parseFloat(el2.getAttribute("rx") ?? "0") || 0,
              (v) => {
                void sendSvgOps(
                  [
                    {
                      sel,
                      ops: [
                        ...boxOps(sel),
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
      if (el2.localName === "text") panel.append(textSection(sel));
      if (textZone) panel.append(textBoxSection(sel));
    }
    if (!zone && src?.writable && movable && isConnector(el2)) {
      panel.append(connectorSection(sel));
    }
    if (src?.writable && (movable || ed.layoutMode) && !isConnector(el2) && el2.localName !== "line") {
      panel.append(connectionPointsSection(sel));
    }
    if (!zone && src?.writable && pictureOf(el2)) {
      panel.append(pictureSection(sel));
    }
    if (!zone && src?.writable && drawnDiagram(el2)) {
      panel.append(diagramSection(sel));
      const shapes = diagramShapesSection(sel);
      if (shapes) panel.append(shapes);
    }
    if (!zone && src?.writable && (movable || ed.layoutMode)) {
      panel.append(detailsSection(sel));
    }
    if (movable) panel.append(arrangeSection([sel]));
    if (id || zone || src?.writable) panel.append(elementAnimations(sel));
  }
  var ARROW = "url(#inkflow-arrow)";
  function attachedConnectors() {
    const svg = slideRoot();
    if (!svg) return [];
    return [...svg.querySelectorAll("[data-ink]")].filter(
      (el2) => isConnector(el2) && canTransform(el2) && (el2.hasAttribute("inkflow:connect-start") || el2.hasAttribute("inkflow:connect-end"))
    ).map((el2) => ({
      el: el2,
      key: parseInt(
        (el2.getAttribute("data-ink") ?? "").split(":")[0],
        10
      ),
      loc: el2.getAttribute("data-ink") ?? ""
    }));
  }
  function reroute(sels) {
    const plans = sels.map((s) => ({ s, d: connectorPath(s.el) })).filter((x) => !!x.d).map(({ s, d }) => ({
      sel: s,
      ops: [{ kind: "attrs", loc: s.loc, set: { d } }]
    }));
    if (plans.length) void sendSvgOps(plans, "Re-route arrows");
  }
  function connectorSection(sel) {
    const el2 = sel.el;
    const has = (attr) => (el2.getAttribute(attr) ?? "").includes("inkflow-arrow");
    const heads = has("marker-start") ? has("marker-end") ? "both" : "start" : has("marker-end") ? "end" : "none";
    const send = (set, label4, marker = false) => void sendSvgOps(
      [
        {
          sel,
          ops: [
            ...marker ? [{ kind: "ensure-marker" }] : [],
            { kind: "attrs", loc: sel.loc, set }
          ]
        }
      ],
      label4
    );
    const describe2 = (which) => {
      const c = parseConnection(el2.getAttribute(`inkflow:connect-${which}`));
      return c ? `${c.id} (${c.site})` : "free";
    };
    return section(
      "Connector",
      row2(
        "Route",
        selectInput(
          [
            { value: "straight", label: "Straight" },
            { value: "elbow", label: "Elbow" },
            { value: "curved", label: "Curved" }
          ],
          connectorStyle(el2),
          (v) => {
            const style = v;
            const d = connectorPath(el2, {}, style, null);
            send(
              {
                "inkflow:connector": v,
                "inkflow:bend": null,
                ...d ? { d } : {}
              },
              "Connector route"
            );
          }
        )
      ),
      row2(
        "Arrowheads",
        selectInput(
          [
            { value: "none", label: "None" },
            { value: "end", label: "At the end" },
            { value: "start", label: "At the start" },
            { value: "both", label: "Both ends" }
          ],
          heads,
          (v) => send(
            {
              "marker-start": v === "start" || v === "both" ? ARROW : null,
              "marker-end": v === "end" || v === "both" ? ARROW : null
            },
            "Arrowheads",
            v !== "none"
          )
        )
      ),
      h(
        "p",
        { class: "hint" },
        `Start: ${describe2("start")} \xB7 End: ${describe2("end")}. Drag an end onto a shape's dot to attach it; Alt while dragging keeps it free.${connectorStyle(el2) === "elbow" ? " Drag the yellow handle to move the elbow's middle segment." : ""}`
      ),
      h(
        "div",
        { class: "btn-row" },
        button(
          "Re-route",
          "Re-attach to the shapes where they are now",
          () => reroute([sel])
        ),
        el2.hasAttribute("inkflow:bend") && button(
          "Reset bend",
          "Put the elbow's middle segment back where it goes by default",
          () => {
            const d = connectorPath(el2, {}, "elbow", null);
            send(
              { "inkflow:bend": null, ...d ? { d } : {} },
              "Reset bend"
            );
          }
        ),
        button(
          "Detach",
          "Free both ends",
          () => send(
            {
              "inkflow:connect-start": null,
              "inkflow:connect-end": null
            },
            "Detach"
          )
        )
      )
    );
  }
  function connectionPointsSection(sel) {
    const n2 = sitesPerSide(sel.el);
    const box = section(
      "Connection points",
      row2(
        "Per side",
        selectInput(
          [1, 2, 3, 4, 5, 7, 9].map((k) => ({
            value: String(k),
            label: k === 1 ? "1 (middle)" : String(k)
          })),
          String(n2),
          (v) => void sendSvgOps(
            [
              {
                sel,
                ops: [
                  {
                    kind: "attrs",
                    loc: sel.loc,
                    set: {
                      "inkflow:sites": v === "1" ? null : v
                    }
                  }
                ]
              }
            ],
            "Connection points"
          )
        )
      )
    );
    box.addEventListener(
      "mouseenter",
      () => showSites([{ el: sel.el, active: null }])
    );
    box.addEventListener("mouseleave", () => showSites([]));
    return box;
  }
  function textBoxSection(sel) {
    const el2 = sel.el;
    const value = (name2) => el2.style.getPropertyValue(name2).trim();
    const setVar = (name2, v, label4) => void sendSvgOps(
      [
        {
          sel,
          ops: [{ kind: "style", loc: sel.loc, set: { [name2]: v } }]
        }
      ],
      label4
    );
    const shown = el2.hasAttribute("inkflow:show-shape");
    const box = h("input", { type: "checkbox" });
    box.checked = shown;
    box.addEventListener(
      "change",
      () => void sendSvgOps(
        [
          {
            sel,
            ops: [
              {
                kind: "attrs",
                loc: sel.loc,
                set: {
                  "inkflow:show-shape": box.checked ? "true" : null
                }
              }
            ]
          }
        ],
        box.checked ? "Show box" : "Hide box"
      )
    );
    const padding = parseFloat(value("--inkflow-padding"));
    return section(
      "Text box",
      row2("Draw the box", box),
      row2(
        "Padding",
        numberInput(
          Number.isFinite(padding) ? padding : null,
          (v) => setVar(
            "--inkflow-padding",
            `${Math.max(0, v)}px`,
            "Padding"
          ),
          {
            min: 0,
            placeholder: "auto",
            onClear: () => setVar("--inkflow-padding", null, "Padding")
          }
        )
      ),
      row2(
        "Align",
        selectInput(
          [
            { value: "", label: "Default" },
            { value: "left", label: "Left" },
            { value: "center", label: "Centre" },
            { value: "right", label: "Right" },
            { value: "justify", label: "Justify" }
          ],
          value("--inkflow-align"),
          (v) => setVar("--inkflow-align", v || null, "Text align")
        )
      ),
      row2(
        "Vertical",
        selectInput(
          [
            { value: "", label: "Default" },
            { value: "start", label: "Top" },
            { value: "center", label: "Middle" },
            { value: "end", label: "Bottom" }
          ],
          value("--inkflow-valign"),
          (v) => setVar("--inkflow-valign", v || null, "Vertical align")
        )
      )
    );
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
    const href = assetRef(
      image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? ""
    );
    const par = image.getAttribute("preserveAspectRatio") ?? "xMidYMid meet";
    const fit = FITS.find((f) => f.par === par)?.value ?? "contain";
    const imageOps = (set, label4) => void sendSvgOps([{ sel, ops: [{ kind: "attrs", loc, set }] }], label4);
    const cropped = isCropped(sel.el);
    return section(
      "Picture",
      h(
        "div",
        { class: "source-hint" },
        h("p", { class: "hint media-src" }, href.split("/").pop() ?? href),
        openButton(projectFile(href))
      ),
      isDiagramHref(href) ? h(
        "div",
        { class: "btn-row" },
        button(
          "Edit diagram",
          "Open it in draw.io (or double-click it)",
          () => editDiagram(sel),
          "on"
        )
      ) : null,
      isDiagramHref(href) && !cropped ? showAsRow(sel, "picture") : null,
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
  function showAsRow(sel, mode) {
    return row2(
      "Show as",
      selectInput(
        DIAGRAM_MODES.map((m) => ({ value: m.value, label: m.label })),
        mode,
        (v) => void sendSvgOps(
          [
            {
              sel,
              ops: [
                // Its shapes are named after it.
                {
                  kind: "ensure-id",
                  loc: sel.loc,
                  base: "diagram",
                  key: "diagram"
                },
                {
                  kind: "attrs",
                  loc: sel.loc,
                  set: {
                    "inkflow:drawio": v === "picture" ? null : v
                  }
                }
              ]
            }
          ],
          "Show diagram as"
        )
      )
    );
  }
  function diagramSection(sel) {
    const svg = drawnDiagram(sel.el);
    const href = svg.getAttribute("data-drawio") ?? "";
    const par = svg.getAttribute("preserveAspectRatio") ?? "xMidYMid meet";
    const fit = FITS.find((f) => f.par === par)?.value ?? "contain";
    return section(
      "draw.io",
      h(
        "div",
        { class: "source-hint" },
        h("p", { class: "hint media-src" }, href.split("/").pop() ?? href),
        openButton(projectFile(href))
      ),
      h(
        "div",
        { class: "btn-row" },
        button(
          "Edit diagram",
          "Open it in draw.io (or double-click it)",
          () => editDiagram(sel),
          "on"
        )
      ),
      showAsRow(sel, diagramMode(svg)),
      editShapesRow(sel, svg),
      row2(
        "Fit",
        selectInput(
          FITS.map((f) => ({ value: f.value, label: f.label })),
          fit,
          (v) => void sendSvgOps(
            [
              {
                sel,
                ops: [
                  {
                    kind: "attrs",
                    loc: sel.loc,
                    set: {
                      preserveAspectRatio: FITS.find((f) => f.value === v)?.par ?? null
                    }
                  }
                ]
              }
            ],
            "Diagram fit"
          )
        )
      )
    );
  }
  function editShapesRow(sel, svg) {
    const on2 = shapesEditable(svg);
    const box = h("input", { type: "checkbox" });
    box.checked = on2;
    box.addEventListener("change", () => {
      void sendSvgOps(
        [
          {
            sel,
            ops: [
              {
                kind: "attrs",
                loc: sel.loc,
                set: {
                  "inkflow:drawio-edit": box.checked ? "shapes" : null
                }
              }
            ]
          }
        ],
        box.checked ? "Edit diagram shapes here" : "Edit diagram in draw.io"
      );
    });
    return h(
      "div",
      {},
      h("label", { class: "check-row" }, box, " Edit shapes here"),
      h(
        "p",
        { class: "hint" },
        on2 ? "Double-click the diagram to select its shapes: move, resize, relabel, recolour or delete them here. draw.io redraws the diagram after each change (it needs to load, like Edit diagram)." : "Double-click opens draw.io. Turn this on to edit the diagram's shapes on the slide instead; the diagram stays a draw.io diagram."
      )
    );
  }
  function diagramShapesSection(sel) {
    const slide = currentSlide();
    const model = ed.model;
    const svg = drawnDiagram(sel.el);
    if (!slide || !model || !svg) return null;
    const shapes = diagramShapes(svg);
    if (!shapes.length) return null;
    const editable = slide.animationsEditable && model.deckEditable;
    const list3 = h("div", { class: "diagram-shapes" });
    const flash = (el2, on2) => setHover(on2 ? el2 : null);
    for (const shape of shapes) {
      const count = slide.animations.filter(
        (c) => c.element === shape.id
      ).length;
      const name2 = shape.label || `(${shape.id.slice(svg.id.length + 1)})`;
      const item = h(
        "div",
        { class: "diagram-shape" },
        h(
          "span",
          { class: "diagram-shape-name", title: `#${shape.id}` },
          name2
        ),
        count ? h(
          "span",
          {
            class: "hint",
            title: "Animations on this shape (see Animation order)"
          },
          `${count} \u2726`
        ) : null
      );
      item.addEventListener("mouseenter", () => flash(shape.el, true));
      item.addEventListener("mouseleave", () => flash(shape.el, false));
      if (editable) {
        const add = animationPicker(
          model.animationTypes,
          false,
          "Animate\u2026"
        );
        add.addEventListener("change", () => {
          if (!add.value) return;
          flash(shape.el, false);
          void edit({
            action: "anim",
            slide: slide.deckIndex,
            op: "insert",
            index: slide.animations.length,
            spec: { type: add.value, element: shape.id, fields: {} }
          });
        });
        item.append(add);
      }
      list3.append(item);
    }
    return section(
      "Shapes",
      h(
        "p",
        { class: "hint" },
        "Animate the diagram's shapes one by one. To change a shape, edit the diagram in draw.io."
      ),
      list3
    );
  }
  function linkOf(el2) {
    const a = el2.parentElement;
    if (a?.localName !== "a") return "";
    const slide = a.getAttribute("data-inkflow-slide");
    if (slide) return `slide:${slide}`;
    return a.getAttribute("href") ?? a.getAttribute("xlink:href") ?? "";
  }
  function slideLinkByNumber(n2) {
    const s = ed.model?.slides[n2 - 1];
    return s?.id ? `slide:${s.id}` : null;
  }
  function slideOptions() {
    const list3 = h("datalist", { id: "slide-link-list" });
    for (const s of ed.model?.slides ?? []) {
      if (!s.id) continue;
      list3.append(h("option", { value: `slide:${s.id}` }, s.title ?? s.id));
    }
    return list3;
  }
  function detailsSection(sel) {
    const title2 = [...sel.el.children].find((c) => c.localName === "title")?.textContent ?? "";
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
          title2,
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
    const el2 = sel.el;
    const cs = getComputedStyle(el2);
    const spans = [...el2.querySelectorAll("tspan")];
    const setAll = (set, label4) => {
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
      void sendSvgOps(plans, label4);
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
      const a = (label4, title2, how) => button(label4, title2, () => alignSelection(how));
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
    const active3 = document.activeElement;
    if (active3 && panel.contains(active3) && typingIn(active3)) {
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
  function typingIn(el2) {
    if (el2.localName === "textarea" || el2.isContentEditable)
      return true;
    if (el2.localName !== "input") return false;
    const type = el2.type;
    return !["checkbox", "radio", "range", "button", "color"].includes(type);
  }
  function initProps() {
    on("selection", renderProps);
    on("render", renderProps);
    on("preview", renderProps);
    panel.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (refreshOnBlur && !panel.contains(document.activeElement)) {
          refreshOnBlur = false;
          renderProps();
        }
      }, 0);
    });
  }

  // src/ts/editor/stylecopy.ts
  var PAINT_CLASS = /^inkflow-(fill|stroke)-[\w-]+$/;
  var COMMON = ["opacity", "filter"];
  var PAINT = [
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-dasharray",
    "stroke-linecap",
    "stroke-linejoin"
  ];
  var MARKERS = ["marker-start", "marker-mid", "marker-end"];
  var FONT = [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-decoration",
    "letter-spacing"
  ];
  var BOX_VARS = ["--inkflow-padding", "--inkflow-align", "--inkflow-valign"];
  var SHAPES = "rect, ellipse, circle, path, line, polyline, polygon, text";
  var LINES = /* @__PURE__ */ new Set(["path", "line", "polyline"]);
  var SHOW_SHAPE = "inkflow:show-shape";
  var copied = null;
  function kindOf(el2) {
    if (el2.localName === "text") return "text";
    if (isZone(el2)) return "box";
    return "shape";
  }
  function read(el2, prop) {
    const inline2 = el2.style?.getPropertyValue(prop).trim();
    return inline2 || el2.getAttribute(prop);
  }
  function painted(el2) {
    if (["g", "a", "svg"].includes(el2.localName)) {
      return el2.querySelector(SHAPES);
    }
    return el2;
  }
  function targets(sel) {
    if (!["g", "a", "svg"].includes(sel.el.localName)) return [sel];
    return [...sel.el.querySelectorAll(SHAPES)].filter((el2) => el2.hasAttribute("data-ink")).map((el2) => ({ ...sel, el: el2, loc: el2.getAttribute("data-ink") ?? "" }));
  }
  function hasCopiedStyle() {
    return copied !== null;
  }
  function copyStyle() {
    const sel = ed.selection[0];
    const el2 = sel ? painted(sel.el) : null;
    if (!el2) {
      toast("Select an object to copy its style from");
      return;
    }
    const kind = kindOf(el2);
    const names = [...COMMON, ...PAINT, ...MARKERS, ...FONT, ...BOX_VARS];
    copied = {
      kind,
      tag: el2.localName,
      classes: [...el2.classList].filter((c) => PAINT_CLASS.test(c)),
      props: Object.fromEntries(names.map((n2) => [n2, read(el2, n2)])),
      radius: { rx: el2.getAttribute("rx"), ry: el2.getAttribute("ry") },
      showShape: el2.getAttribute(SHOW_SHAPE) === "true"
    };
    toast("Style copied: select objects and press Ctrl+Alt+V to apply it");
  }
  function propsFor(style, el2) {
    const kind = kindOf(el2);
    const props = [...COMMON];
    const shapeLike = (k) => k === "shape" || k === "box";
    if (kind === "text" && style.kind === "text") props.push(...PAINT, ...FONT);
    else if (shapeLike(kind) && shapeLike(style.kind)) props.push(...PAINT);
    if (LINES.has(el2.localName) && LINES.has(style.tag)) props.push(...MARKERS);
    if (kind === "box" && style.kind === "box") props.push(...BOX_VARS);
    return props;
  }
  function opsFor(style, sel) {
    const el2 = sel.el;
    const props = propsFor(style, el2);
    const set = {};
    for (const p of props) set[p] = style.props[p] ?? null;
    const ops = [];
    for (const prop of ["fill", "stroke"]) {
      if (!props.includes(prop)) continue;
      const token = style.classes.find((c) => c.startsWith(`inkflow-${prop}-`))?.slice(`inkflow-${prop}-`.length);
      ops.push({ kind: "paint", loc: sel.loc, prop, token });
      if (token) set[prop] = null;
    }
    const attrs2 = {};
    if (el2.localName === "rect" && style.tag === "rect") {
      attrs2.rx = style.radius.rx;
      attrs2.ry = style.radius.ry;
    }
    if (kindOf(el2) === "box" && style.kind === "box") {
      attrs2[SHOW_SHAPE] = style.showShape ? "true" : null;
    }
    if (Object.keys(attrs2).length) {
      ops.push({ kind: "attrs", loc: sel.loc, set: attrs2 });
    }
    ops.push({ kind: "style", loc: sel.loc, set });
    return ops;
  }
  async function pasteStyle() {
    const style = copied;
    if (!style) {
      toast("Copy a style first: select an object and press Ctrl+Alt+C");
      return;
    }
    const sels = ed.selection.filter((s) => canTransform(s.el)).flatMap(targets);
    if (!sels.length) {
      toast("Select the objects to apply the style to");
      return;
    }
    await sendSvgOps(
      sels.map((sel) => ({ sel, ops: opsFor(style, sel) })),
      "Paste style"
    );
  }

  // src/ts/editor/find.ts
  var panel2 = document.getElementById("find-panel");
  var hits = [];
  var active = -1;
  var timer = 0;
  var opts = { matchCase: false, wholeWord: false, regex: false };
  var scope = "deck";
  function el(sel) {
    return panel2.querySelector(sel);
  }
  function slideFiles(s) {
    const out = (s.sources ?? []).filter((src) => src.writable).map((src) => src.path);
    if (s.srcPath) out.push(s.srcPath);
    if (s.md?.path) out.push(s.md.path);
    if (s.notes?.path) out.push(s.notes.path);
    return out;
  }
  function files() {
    const slides = scope === "slide" ? [currentSlide()].filter((s) => !!s) : ed.model?.slides ?? [];
    return [...new Set(slides.flatMap(slideFiles))];
  }
  function slidesOf(hit) {
    if (hit.kind === "deck") return hit.slide != null ? [hit.slide] : [];
    return (ed.model?.slides ?? []).filter((s) => slideFiles(s).includes(hit.file)).map((s) => s.deckIndex);
  }
  function query() {
    return el(".find-input").value;
  }
  function base() {
    return { query: query(), files: files(), ...opts };
  }
  async function search() {
    const q = query();
    if (!q) {
      hits = [];
      renderResults();
      return;
    }
    const result = await request({ action: "find", ...base() });
    if (q !== query()) return;
    if (!result.ok) {
      hits = [];
      renderResults(result.error ?? "search failed");
      return;
    }
    hits = result.hits;
    if (scope === "slide") {
      const cur = currentSlide()?.deckIndex;
      hits = hits.filter((h2) => h2.kind !== "deck" || h2.slide === cur);
    }
    active = Math.min(active, hits.length - 1);
    renderResults();
  }
  function schedule() {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void search(), 220);
  }
  function fileLabel(path) {
    const root2 = ed.model?.projectDir ?? "";
    return path.startsWith(root2) ? path.slice(root2.length + 1) : path;
  }
  function renderResults(error) {
    const list3 = el(".find-results");
    const status2 = el(".find-status");
    clear(list3);
    if (error) {
      status2.textContent = error;
      return;
    }
    if (!query()) {
      status2.textContent = "";
      return;
    }
    const slides = new Set(hits.flatMap(slidesOf));
    status2.textContent = hits.length ? `${hits.length}${hits.length >= 500 ? "+" : ""} match${hits.length === 1 ? "" : "es"} on ${slides.size} slide${slides.size === 1 ? "" : "s"}` : "No matches";
    let lastGroup = "";
    hits.forEach((hit, i) => {
      const on2 = slidesOf(hit);
      const first = on2[0];
      const slide = first != null ? ed.model?.slides[first] : null;
      const group = slide != null ? `${first + 1} \xB7 ${slide.title ?? slide.id ?? ""}` : fileLabel(hit.file);
      if (group !== lastGroup) {
        list3.append(h("div", { class: "find-group" }, group));
        lastGroup = group;
      }
      const where = hit.kind === "deck" ? "deck.py" : `${fileLabel(hit.file)}${on2.length > 1 ? ` \xB7 ${on2.length} slides` : ""}`;
      const row3 = h(
        "button",
        {
          type: "button",
          class: `find-hit${i === active ? " on" : ""}`,
          title: where,
          onclick: () => goTo(i)
        },
        h(
          "span",
          { class: "find-snippet" },
          hit.before,
          h("mark", {}, hit.match),
          hit.after
        ),
        h("span", { class: "find-where" }, where)
      );
      list3.append(row3);
    });
  }
  function goTo(i) {
    const hit = hits[i];
    if (!hit) return;
    active = i;
    renderResults();
    const on2 = slidesOf(hit);
    const cur = currentSlide()?.deckIndex;
    const target = cur != null && on2.includes(cur) ? cur : on2[0];
    if (target != null) gotoSlide(target);
    if (hit.kind === "svg" && hit.loc != null) {
      const slide = currentSlide();
      const key = slide?.sources?.findIndex((s) => s.path === hit.file) ?? -1;
      const node = key >= 0 ? slideRoot()?.querySelector(`[data-ink="${key}:${hit.loc}"]`) : null;
      if (node && selectable(node)) select([node]);
    }
    panel2.querySelector(".find-hit.on")?.scrollIntoView({ block: "nearest" });
  }
  async function replace(all) {
    const q = query();
    if (!q) return;
    if (!all && active < 0) {
      goTo(0);
      return;
    }
    const replacement = el(".replace-input").value;
    const hit = hits[active];
    if (all && hits.length > 1) {
      const n2 = hits.length;
      if (!window.confirm(
        `Replace ${n2} matches of \u201C${q}\u201D with \u201C${replacement}\u201D?`
      )) {
        return;
      }
    }
    const result = await edit({
      action: "replace",
      replacement,
      ...base(),
      only: all ? void 0 : { file: hit.file, index: hit.index }
    });
    if (result.ok) {
      const n2 = result.replaced;
      toast(`Replaced ${n2} match${n2 === 1 ? "" : "es"}`);
    }
  }
  function toggle(name2, btn) {
    opts[name2] = !opts[name2];
    btn.classList.toggle("on", opts[name2]);
    schedule();
  }
  function build() {
    const flag = (label4, title2, name2) => {
      const b = h(
        "button",
        { type: "button", class: "find-flag", title: title2 },
        label4
      );
      b.addEventListener("click", () => toggle(name2, b));
      return b;
    };
    const find = h("input", {
      type: "text",
      class: "find-input",
      placeholder: "Find in slides, notes and deck.py",
      spellcheck: "false"
    });
    const repl = h("input", {
      type: "text",
      class: "replace-input",
      placeholder: "Replace with",
      spellcheck: "false"
    });
    const where = h("select", { class: "find-scope", title: "Where to look" });
    where.append(
      h("option", { value: "deck" }, "All slides"),
      h("option", { value: "slide" }, "This slide")
    );
    where.addEventListener("change", () => {
      scope = where.value === "slide" ? "slide" : "deck";
      schedule();
    });
    find.addEventListener("input", () => {
      active = -1;
      schedule();
    });
    find.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (hits.length)
          goTo(
            (active + (e.shiftKey ? -1 : 1) + hits.length) % hits.length
          );
      }
    });
    repl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void replace(e.ctrlKey || e.metaKey);
      }
    });
    panel2.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") closeFind();
    });
    panel2.append(
      h(
        "div",
        { class: "find-row" },
        find,
        flag("Aa", "Match case", "matchCase"),
        flag("ab", "Whole words", "wholeWord"),
        flag(".*", "Regular expression", "regex"),
        h(
          "button",
          {
            type: "button",
            class: "find-close",
            title: "Close (Esc)",
            onclick: closeFind
          },
          "\xD7"
        )
      ),
      h(
        "div",
        { class: "find-row" },
        repl,
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            title: "Replace this match (Enter)",
            onclick: () => void replace(false)
          },
          "Replace"
        ),
        h(
          "button",
          {
            type: "button",
            class: "pbtn",
            title: "Replace every match (Ctrl+Enter)",
            onclick: () => void replace(true)
          },
          "All"
        )
      ),
      h(
        "div",
        { class: "find-row" },
        where,
        h("span", { class: "find-status" })
      ),
      h("div", { class: "find-results" })
    );
  }
  function openFind(replaceMode = false) {
    if (!panel2.childElementCount) build();
    panel2.hidden = false;
    const input = el(
      replaceMode ? ".replace-input" : ".find-input"
    );
    const picked = window.getSelection()?.toString().trim();
    if (picked && !picked.includes("\n")) {
      el(".find-input").value = picked;
    }
    input.focus();
    input.select();
    schedule();
  }
  function closeFind() {
    panel2.hidden = true;
  }
  function initFind() {
    document.getElementById("btn-find")?.addEventListener("click", () => openFind());
    on("model", () => {
      if (!panel2.hidden && query()) schedule();
    });
  }

  // src/ts/editor/grid.ts
  var view = document.getElementById("grid-view");
  var list2 = document.getElementById("grid-list");
  var sizeInput = document.getElementById("grid-size");
  var thumbs2 = new Thumbs();
  var dragFrom2 = null;
  function toggleGrid(on2 = view.hidden === true) {
    view.hidden = !on2;
    document.body.classList.toggle("grid-mode", on2);
    document.getElementById("btn-grid")?.classList.toggle("on", on2);
    if (on2) {
      ed.focus = "sorter";
      renderGrid();
      view.focus();
    } else {
      ed.focus = "canvas";
      emit("slide");
    }
  }
  function open3(i) {
    ed.slideSelection.clear();
    toggleGrid(false);
    gotoSlide(i);
  }
  function renderGrid() {
    if (view.hidden) return;
    clear(list2);
    thumbs2.begin();
    const slides = ed.model?.slides ?? [];
    slides.forEach((slide, i) => {
      const item = h(
        "div",
        {
          class: `grid-item${i === ed.current ? " active" : ""}${ed.slideSelection.has(i) ? " picked" : ""}${slide.visible ? "" : " hidden-slide"}`,
          draggable: ed.model?.deckEditable ? "true" : null,
          "data-index": i
        },
        thumbs2.thumb(slide),
        h(
          "div",
          { class: "grid-caption" },
          h("span", { class: "grid-num" }, String(i + 1)),
          h(
            "span",
            { class: "grid-title" },
            slide.title ?? slide.id ?? slide.src
          ),
          slide.animations.length ? h(
            "span",
            {
              class: "grid-badge",
              title: `${slide.animations.length} animation(s)`
            },
            "\u2726"
          ) : null
        )
      );
      item.addEventListener("click", (e) => {
        pickSlide(i, e);
        ed.focus = "sorter";
      });
      item.addEventListener("dblclick", () => open3(i));
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
        dragFrom2 = i;
        e.dataTransfer?.setData("text/plain", String(i));
        item.classList.add("dragging");
      });
      item.addEventListener("dragend", () => {
        dragFrom2 = null;
        list2.querySelectorAll(".drop-before, .drop-after").forEach((el2) => {
          el2.classList.remove("drop-before", "drop-after");
        });
        item.classList.remove("dragging");
      });
      item.addEventListener("dragover", (e) => {
        if (dragFrom2 == null) return;
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
        if (dragFrom2 == null) return;
        const r = item.getBoundingClientRect();
        let to = e.clientX > r.left + r.width / 2 ? i + 1 : i;
        if (dragFrom2 < to) to -= 1;
        void moveSlide(dragFrom2, to);
      });
      list2.append(item);
    });
    thumbs2.end();
    list2.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }
  function columns() {
    const items = [...list2.children];
    if (items.length < 2) return 1;
    const top = items[0].offsetTop;
    const n2 = items.findIndex((el2) => el2.offsetTop !== top);
    return n2 === -1 ? items.length : n2;
  }
  function onKey(e) {
    if (view.hidden) return;
    const target = e.target;
    if (target.closest("input, textarea, select, #dialog, #find-panel")) return;
    const n2 = ed.model?.slides.length ?? 0;
    const move = (to) => {
      e.preventDefault();
      e.stopPropagation();
      ed.slideSelection.clear();
      gotoSlide(Math.max(0, Math.min(n2 - 1, to)));
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
        move(n2 - 1);
        break;
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        open3(ed.current);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        toggleGrid(false);
        break;
    }
  }
  function setSize(px) {
    view.style.setProperty("--grid-w", `${px}px`);
    try {
      localStorage.setItem("inkflow-editor-grid", String(px));
    } catch {
    }
  }
  function initGrid() {
    document.getElementById("btn-grid")?.addEventListener("click", () => toggleGrid());
    document.getElementById("grid-close")?.addEventListener("click", () => toggleGrid(false));
    document.addEventListener("keydown", onKey, true);
    let saved = 280;
    try {
      saved = Number(localStorage.getItem("inkflow-editor-grid")) || 280;
    } catch {
    }
    sizeInput.value = String(saved);
    setSize(saved);
    sizeInput.addEventListener("input", () => setSize(Number(sizeInput.value)));
    on("model", renderGrid);
    on("slide", renderGrid);
    on("slide-selection", renderGrid);
  }

  // src/ts/editor/richtext.ts
  var Unsupported = class extends Error {
  };
  var COLOR_CLASS = /^inkflow-color-[\w-]+$/;
  var RAW_INLINE = /* @__PURE__ */ new Set(["u", "mark", "sub", "sup"]);
  function attrs(el2) {
    return [...el2.attributes].map((a) => a.name);
  }
  function plain(el2, allowed = []) {
    return attrs(el2).every(
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
    const el2 = node;
    const tag = el2.localName;
    switch (tag) {
      case "strong":
      case "b":
        if (!plain(el2)) throw new Unsupported(tag);
        return wrap(inline(el2), "**");
      case "em":
      case "i":
        if (!plain(el2)) throw new Unsupported(tag);
        return wrap(inline(el2), "*");
      case "s":
      case "del":
      case "strike":
        if (!plain(el2)) throw new Unsupported(tag);
        return wrap(inline(el2), "~~");
      case "code":
        if (!plain(el2)) throw new Unsupported(tag);
        return codeSpan(el2.textContent ?? "");
      case "br":
        return "\\\n";
      case "a": {
        const slide = el2.getAttribute("data-inkflow-slide");
        if (slide && plain(el2, ["data-inkflow-slide", "title"])) {
          return `[${inline(el2)}](slide:${slide})`;
        }
        if (!plain(el2, ["href", "title"])) throw new Unsupported(tag);
        const href = el2.getAttribute("href") ?? "";
        const title2 = el2.getAttribute("title");
        const t = title2 ? ` "${title2.replace(/"/g, '\\"')}"` : "";
        return `[${inline(el2)}](${href.replace(/[()\s]/g, encodeURIComponent)}${t})`;
      }
      case "span": {
        const cls = el2.getAttribute("class") ?? "";
        const latex = formula(el2, "inline");
        if (latex !== null) return `$${latex}$`;
        if (!cls && plain(el2)) return inline(el2);
        if (COLOR_CLASS.test(cls) && plain(el2, ["class"])) {
          return `<span class="${cls}">${inline(el2)}</span>`;
        }
        throw new Unsupported(`span.${cls}`);
      }
      case "font":
        return inline(el2);
      default:
        if (RAW_INLINE.has(tag) && plain(el2)) {
          return `<${tag}>${inline(el2)}</${tag}>`;
        }
        throw new Unsupported(tag);
    }
  }
  function formula(el2, kind) {
    const cls = (el2.getAttribute("class") ?? "").split(/\s+/);
    if (!cls.includes("math") || !cls.includes(kind)) return null;
    const latex = el2.querySelector("math")?.getAttribute("data-latex");
    if (latex == null) throw new Unsupported("math without its LaTeX");
    return latex.trim();
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
  var TASK_LIST = "contains-task-list";
  var TASK_ITEM = "task-list-item";
  function isCheckbox(node) {
    return node.nodeType === Node.ELEMENT_NODE && node.localName === "input" && node.type === "checkbox";
  }
  function listMarkdown(list3) {
    const ordered = list3.localName === "ol";
    const tasks = list3.classList.contains(TASK_LIST);
    let n2 = parseInt(list3.getAttribute("start") ?? "1", 10) || 1;
    const lines = [];
    for (const li of list3.children) {
      if (li.localName !== "li") throw new Unsupported(li.localName);
      const cls = li.getAttribute("class") ?? "";
      if (!plain(li, cls === TASK_ITEM || !cls ? ["class"] : [])) {
        throw new Unsupported("li with attributes");
      }
      const box = [...li.childNodes].find(isCheckbox);
      const task = tasks || cls === TASK_ITEM || box !== void 0;
      const bullet = ordered ? `${n2++}. ` : "- ";
      const marker = `${bullet}${task ? box?.checked ? "[x] " : "[ ] " : ""}`;
      const pad = " ".repeat(bullet.length);
      const own = [];
      const nested = [];
      for (const c of li.childNodes) {
        const el2 = c;
        if (isCheckbox(c)) continue;
        if (c.nodeType === Node.ELEMENT_NODE && /^[ou]l$/.test(el2.localName)) {
          nested.push(listMarkdown(el2));
        } else if (c.nodeType === Node.ELEMENT_NODE && (el2.localName === "p" || el2.localName === "div")) {
          own.push(inline(el2));
        } else {
          own.push(inlineNode(c));
        }
      }
      const text = own.join("").replace(/(\\\n\s*)+$/, "").trim().replace(/\n/g, `
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
  function blockMarkdown(el2) {
    const tag = el2.localName;
    if (/^h[1-6]$/.test(tag)) {
      if (!plain(el2)) throw new Unsupported(tag);
      return `${"#".repeat(Number(tag[1]))} ${inline(el2).trim()}`;
    }
    const latex = formula(el2, "block");
    if (latex !== null) return `$$
${latex}
$$`;
    switch (tag) {
      case "p":
      case "div":
        if (!plain(el2)) throw new Unsupported(tag);
        if ([...el2.children].some((c) => BLOCK.has(c.localName))) {
          return blocks(el2);
        }
        return escapeLineStart(inline(el2).replace(/\\\n$/, "").trim());
      case "ul":
      case "ol": {
        const cls = el2.getAttribute("class");
        if (cls && cls !== TASK_LIST)
          throw new Unsupported(`${tag}.${cls}`);
        if (!plain(el2, ["start", "class"])) throw new Unsupported(tag);
        return listMarkdown(el2);
      }
      case "blockquote":
        if (!plain(el2)) throw new Unsupported(tag);
        return blocks(el2).split("\n").map((l) => l ? `> ${l}` : ">").join("\n");
      case "hr":
        return "---";
      case "table":
        if (!plain(el2)) throw new Unsupported(tag);
        return tableMarkdown(el2);
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
      const el2 = node;
      if (node.nodeType === Node.ELEMENT_NODE && BLOCK.has(el2.localName)) {
        flush();
        const md = blockMarkdown(el2);
        if (md.trim()) out.push(md);
      } else if (node.nodeType === Node.ELEMENT_NODE && el2.localName === "br") {
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
  var active2 = null;
  function isEditingText() {
    return active2 !== null;
  }
  async function finishTextEdit() {
    const a = active2;
    if (!a) return;
    active2 = null;
    clear(layer);
    closeDock();
    await a.commit();
  }
  function cancel() {
    const a = active2;
    if (!a) return;
    active2 = null;
    clear(layer);
    closeDock();
    a.cancel();
  }
  function linesOf(el2) {
    const spans = [...el2.children].filter((c) => c.localName === "tspan");
    const loose = [...el2.childNodes].some(
      (n2) => n2.nodeType === Node.TEXT_NODE && (n2.textContent ?? "").trim()
    );
    if (!spans.length || loose) return [el2.textContent ?? ""];
    return spans.map((s) => s.textContent ?? "");
  }
  function editSvgText(el2, sourcePath, hash, loc) {
    void finishTextEdit();
    const rect = el2.getBoundingClientRect();
    const style = getComputedStyle(el2);
    const ctm = el2.getScreenCTM();
    const fontPx = parseFloat(style.fontSize) * (ctm ? Math.hypot(ctm.a, ctm.b) : 1);
    const original = linesOf(el2);
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
    el2.style.visibility = "hidden";
    layer.append(area2);
    autosize();
    area2.focus();
    area2.select();
    active2 = {
      commit: async () => {
        el2.style.visibility = "";
        const lines = area2.value.replace(/\r/g, "").split("\n");
        if (lines.join("\n") === original.join("\n")) return;
        if (lines.length === 1 && !el2.querySelector("tspan")) {
          el2.textContent = lines[0];
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
        el2.style.visibility = "";
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
    let timer5 = 0;
    const coalesce = `zone-${deckIndex}-${zone}-${Date.now()}`;
    const send = async () => {
      window.clearTimeout(timer5);
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
        timer5 = window.setTimeout(() => void send(), 800);
      }
    };
    area2.addEventListener("input", () => {
      window.clearTimeout(timer5);
      timer5 = window.setTimeout(() => void send(), 450);
    });
    const button4 = (name2, title2, fn) => h(
      "button",
      {
        type: "button",
        class: "fmt-btn",
        title: title2,
        onmousedown: (e) => {
          e.preventDefault();
          fn();
        }
      },
      name2
    );
    const bar = h(
      "div",
      { class: "zone-toolbar" },
      h("span", { class: "zone-label" }, `${zone} \xB7 Markdown`),
      button4("B", "Bold (Ctrl+B)", () => wrapSelection(area2, "**")),
      button4("I", "Italic (Ctrl+I)", () => wrapSelection(area2, "*")),
      button4("H", "Heading", () => prefixLines(area2, "## ")),
      button4("\u2022", "Bullet list", () => prefixLines(area2, "- ")),
      button4("1.", "Numbered list", () => prefixLines(area2, "1. ")),
      button4("`", "Code", () => wrapSelection(area2, "`")),
      button4("\u2211", "Math", () => wrapSelection(area2, "$")),
      button4("\u23F5", "Reveal on click: insert a ::step:: marker", () => {
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
    active2 = {
      commit: async () => {
        await send();
      },
      cancel: () => {
        window.clearTimeout(timer5);
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
  function editZone(zone, el2, opts2 = {}) {
    void finishTextEdit();
    if (el2 && editZoneRich(zone, el2, opts2)) return;
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
  function editZoneRich(zone, el2, opts2) {
    const slide = currentSlide();
    const content2 = el2.querySelector(".inkflow-content");
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
    const fo = el2;
    const deckIndex = slide.deckIndex;
    ed.richEditing = true;
    richHost = content2;
    fo.classList.add("rich-editing");
    fo.style.overflow = "visible";
    content2.contentEditable = "true";
    for (const box of content2.querySelectorAll(
      "input[type=checkbox]"
    )) {
      box.disabled = false;
    }
    content2.addEventListener("input", () => fixChecklists(content2));
    content2.spellcheck = true;
    document.execCommand("defaultParagraphSeparator", false, "p");
    content2.focus();
    placeCaret(content2, opts2);
    const bar = richToolbar(content2, () => {
      void finishTextEdit().then(() => editZoneText(zone));
    });
    layer.append(bar);
    positionBar(bar, fo);
    const cleanup = () => {
      closeFormula(false, false);
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
    active2 = {
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
        if (opts2.placeholder !== void 0 && (md === start || !md.trim())) {
          await takeBackPlaceholder();
          return;
        }
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
        if (opts2.placeholder !== void 0) {
          void takeBackPlaceholder();
          return;
        }
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
      if (next && (layer.contains(next) || content2.contains(next))) return;
      if (bar.matches(":hover")) return;
      void finishTextEdit();
    });
    for (const m of content2.querySelectorAll(".math")) {
      makeChip(m);
    }
    content2.addEventListener("click", (e) => {
      const chip = e.target.closest?.(".math");
      if (chip && content2.contains(chip)) {
        openFormula(content2, chip);
      }
    });
    return true;
  }
  async function takeBackPlaceholder() {
    const result = await edit({ action: "undo" });
    if (!result.ok) emit("rerender");
  }
  function placeCaret(content2, opts2) {
    const sel = window.getSelection();
    if (!sel) return;
    let range = null;
    if (opts2.at && !opts2.selectAll) {
      range = document.caretRangeFromPoint?.(opts2.at.x, opts2.at.y) ?? null;
      if (range && !content2.contains(range.startContainer)) range = null;
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(content2);
      if (!opts2.selectAll) range.collapse(false);
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
  function unwrap(el2) {
    el2.replaceWith(...el2.childNodes);
  }
  function wrapRange(content2, make, same) {
    const range = selectionRange(content2);
    if (!range || range.collapsed) return;
    const frag = range.extractContents();
    frag.querySelectorAll(same).forEach(unwrap);
    const sel = window.getSelection();
    if (make) {
      const el2 = make();
      el2.append(frag);
      range.insertNode(el2);
      range.selectNodeContents(el2);
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
    content2.querySelectorAll(same).forEach((el2) => {
      if (!el2.textContent) el2.remove();
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
    const current2 = a?.getAttribute("href") ?? "";
    const url = window.prompt(
      a ? "Link address: https://\u2026 or slide:<id> (empty removes the link)" : "Link address: https://\u2026 or slide:<id>",
      current2 || "https://"
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
  function makeChip(el2) {
    el2.contentEditable = "false";
    el2.classList.add("math-chip");
  }
  var formula2 = null;
  function closeFormula(revert, refocus = true) {
    if (!formula2) return;
    const f = formula2;
    formula2 = null;
    f.pop.remove();
    f.chip.classList.remove("editing");
    if (revert) f.revert();
    if (refocus && f.chip.isConnected) f.done();
  }
  function insertFormula(content2) {
    const range = selectionRange(content2);
    const chip = h("span", { class: "math inline" });
    chip.innerHTML = '<math data-latex=""></math>';
    makeChip(chip);
    if (range) {
      range.deleteContents();
      range.insertNode(chip);
    } else {
      content2.append(chip);
    }
    openFormula(content2, chip, true);
  }
  function openFormula(content2, chip, isNew = false) {
    closeFormula(false);
    const original = chip.querySelector("math")?.getAttribute("data-latex") ?? "";
    const before = chip.cloneNode(true);
    const field = h("textarea", {
      class: "formula-input",
      rows: 2,
      spellcheck: "false",
      placeholder: "LaTeX, e.g. \\frac{a}{b}"
    });
    field.value = original || (isNew ? "x" : "");
    const block = h("input", { type: "checkbox" });
    block.checked = chip.classList.contains("block");
    const status2 = h("span", { class: "formula-status" });
    const pop = h(
      "div",
      { class: "formula-pop" },
      field,
      h(
        "div",
        { class: "formula-row" },
        h("label", {}, block, " On its own line"),
        status2,
        h(
          "button",
          {
            type: "button",
            class: "fmt-btn done",
            onmousedown: (e) => {
              e.preventDefault();
              closeFormula(false);
            }
          },
          "Done"
        )
      )
    );
    const self = {
      pop,
      chip,
      revert: () => {
        if (isNew) self.chip.remove();
        else self.chip.replaceWith(before);
        changed(content2);
      },
      done: () => {
        content2.focus();
        const range = document.createRange();
        range.setStartAfter(self.chip);
        range.collapse(true);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    };
    pop.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        closeFormula(true);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        closeFormula(false);
      }
    });
    let timer5 = 0;
    let seq = 0;
    const renderNow = async () => {
      window.clearTimeout(timer5);
      const latex = field.value.trim();
      if (!latex) return;
      const mine = ++seq;
      const wantBlock = block.checked;
      const result = await request({
        action: "math",
        latex,
        block: wantBlock
      });
      if (mine !== seq || formula2 !== self) return;
      if (!result.ok) {
        status2.textContent = result.error ?? "cannot render";
        pop.classList.add("error");
        return;
      }
      status2.textContent = "";
      pop.classList.remove("error");
      if (wantBlock !== self.chip.classList.contains("block")) {
        self.chip = swapKind(content2, self.chip, wantBlock);
      }
      self.chip.innerHTML = String(
        result.mathml
      );
      changed(content2);
      placePop(pop, self.chip);
    };
    field.addEventListener("input", () => {
      window.clearTimeout(timer5);
      timer5 = window.setTimeout(() => void renderNow(), 250);
    });
    block.addEventListener("change", () => void renderNow());
    chip.classList.add("editing");
    layer.append(pop);
    placePop(pop, chip);
    formula2 = self;
    field.focus();
    field.select();
    if (isNew) void renderNow();
  }
  function swapKind(content2, chip, block) {
    const next = h(block ? "div" : "span", {
      class: `math ${block ? "block" : "inline"}`
    });
    makeChip(next);
    next.classList.add("editing");
    if (block) {
      const para = chip.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote");
      chip.remove();
      if (para && content2.contains(para)) para.after(next);
      else content2.append(next);
    } else {
      const p = h("p", {});
      chip.replaceWith(p);
      p.append(next);
    }
    return next;
  }
  function placePop(pop, chip) {
    const r = chip.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 420))}px`;
    pop.style.top = `${Math.min(r.bottom + 8, window.innerHeight - 140)}px`;
  }
  function checkbox() {
    const box = h("input", {
      type: "checkbox",
      class: "task-list-item-checkbox"
    });
    return box;
  }
  function fixChecklists(content2) {
    for (const li of content2.querySelectorAll("ul.contains-task-list > li")) {
      li.classList.add("task-list-item");
      const first = li.firstChild;
      if (!(first instanceof HTMLInputElement)) {
        li.prepend(checkbox(), " ");
      }
    }
  }
  function toggleChecklist(content2) {
    let li = caretElement(content2)?.closest("li");
    if (!li || !content2.contains(li)) {
      document.execCommand("insertUnorderedList");
      li = caretElement(content2)?.closest("li");
    }
    const list3 = li?.parentElement;
    if (list3?.localName !== "ul") return;
    if (list3.classList.contains("contains-task-list")) {
      list3.classList.remove("contains-task-list");
      if (!list3.classList.length) list3.removeAttribute("class");
      for (const item of list3.children) {
        item.classList.remove("task-list-item");
        if (!item.classList.length) item.removeAttribute("class");
        item.querySelector(":scope > input[type=checkbox]")?.remove();
      }
    } else {
      list3.classList.add("contains-task-list");
      fixChecklists(content2);
    }
    changed(content2);
  }
  function insertReveal(content2) {
    const block = caretElement(content2)?.closest(
      "p, h1, h2, h3, h4, h5, h6, ul, ol, table, blockquote"
    );
    const marker = h("p", {}, "::step::");
    if (block && content2.contains(block)) {
      block.before(marker);
    } else {
      content2.append(marker);
    }
    changed(content2);
    toast("Saved when you finish: what follows appears one click later");
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
    const btn = (label4, title2, fn, cls = "") => h(
      "button",
      {
        type: "button",
        class: `fmt-btn ${cls}`,
        title: title2,
        onmousedown: (e) => {
          e.preventDefault();
          fn();
          syncToolbar(bar, content2);
        }
      },
      label4
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
      btn("\u2611", "Checklist", () => toggleChecklist(content2), "fmt-task"),
      btn("\u2211", "Formula (LaTeX)", () => insertFormula(content2)),
      btn("\u25A6", "Insert a table", () => insertTable(content2)),
      tableTools,
      h("span", { class: "fmt-sep" }),
      btn("Tx", "Clear formatting", exec("removeFormat")),
      btn(
        "\u23F5",
        "Reveal on click: what follows appears one click later (a ::step:: marker; afterwards this text is edited as Markdown)",
        () => insertReveal(content2)
      ),
      btn(
        "M\u2193",
        "Edit the Markdown source (code, images, reveals\u2026)",
        toSource
      ),
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
    const el2 = caretElement(content2);
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
    on2("fmt-code", !!el2?.closest("code"));
    on2("fmt-link", !!el2?.closest("a"));
    on2("fmt-ul", !!el2?.closest("ul"));
    on2("fmt-ol", !!el2?.closest("ol"));
    on2("fmt-task", !!el2?.closest("ul.contains-task-list"));
    const blockEl = el2?.closest("p, h1, h2, h3, h4, h5, h6, blockquote, li");
    const select2 = bar.querySelector(".fmt-block");
    if (select2 && blockEl) {
      const tag = blockEl.closest("blockquote") ? "blockquote" : blockEl.localName;
      select2.value = ["p", "h1", "h2", "h3", "blockquote"].includes(tag) ? tag : "p";
    }
    bar.querySelector(".fmt-table")?.classList.toggle(
      "show",
      !!el2?.closest("td, th")
    );
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
      const name2 = zoneName(z.el);
      const value = slide.zones[name2];
      if (slide.zoneOrigins?.[name2] === "md-file") {
        toast(
          "This zone shows the whole Markdown file: edit its text instead"
        );
        continue;
      }
      if (value && (value.kind === "image" || value.kind === "video")) {
        await edit({
          action: "zone-media",
          slide: slide.deckIndex,
          zone: name2,
          src: null
        });
      } else {
        await edit({
          action: "zone-text",
          slide: slide.deckIndex,
          zone: name2,
          text: "",
          origin: slide.zoneOrigins?.[name2]
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
    const n2 = (slide?.visibleIndex ?? 0) + 1;
    window.open(`/#slide=${n2}`, "inkflow-present");
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
  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {
    });
  }
  function updateFullscreen() {
    const on2 = !!document.fullscreenElement;
    const b = $("btn-fullscreen");
    b.classList.toggle("on", on2);
    b.title = on2 ? "Leave full screen (F)" : "Full screen (F)";
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
    a: "arrow",
    e: "elbow",
    c: "curve"
  };
  function onKey2(e) {
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
    } else if (mod && e.altKey && (e.code === "KeyC" || e.code === "KeyV")) {
      handled();
      if (e.code === "KeyC") copyStyle();
      else void pasteStyle();
    } else if (mod && lower === "c") {
      handled();
      if (ed.focus === "sorter") void copySlides();
      else copy();
    } else if (mod && lower === "x") {
      handled();
      if (ed.focus === "sorter") void cutSlides();
      else cut();
    } else if (mod && (lower === "f" || lower === "h")) {
      handled();
      openFind(lower === "h");
    } else if (mod && lower === "g") {
      handled();
      void (e.shiftKey ? ungroupSelection() : groupSelection());
    } else if (mod && lower === "m") {
      handled();
      if (e.shiftKey) void openGallery({ mode: "insert", after: ed.current });
      else if (ed.model?.deckEditable) void newSlideLike(ed.current);
      else
        toast(
          "deck.py builds its slides in code; add slides there",
          "error"
        );
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
    } else if (key === "Enter" && ed.selection.length === 1 && canTypeInto(ed.selection[0].el)) {
      handled();
      void typeInto(ed.selection[0].el);
    } else if (key === "Enter" && ed.selection.length === 1) {
      handled();
      const el2 = ed.selection[0].el;
      emit(
        isZone(el2) ? "edit-zone" : el2.localName === "text" ? "edit-text" : "noop"
      );
      if (el2.localName === "g") enterGroup(el2);
    } else if (!mod && (key === "+" || key === "=")) {
      setZoom(scale() * 1.25);
    } else if (!mod && key === "-") {
      setZoom(scale() / 1.25);
    } else if (!mod && key === "0") {
      setZoom(0);
    } else if (!mod && !e.altKey && lower in TOOL_KEYS) {
      setTool(TOOL_KEYS[lower]);
    } else if (!mod && !e.altKey && lower === "g") {
      toggleGrid();
    } else if (!mod && !e.altKey && lower === "f") {
      handled();
      toggleFullscreen();
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
    $("btn-diagram").addEventListener("click", () => newDiagram());
    $("zoom-in").addEventListener("click", () => setZoom(scale() * 1.25));
    $("zoom-out").addEventListener("click", () => setZoom(scale() / 1.25));
    $("zoom-fit").addEventListener("click", () => setZoom(0));
    $("btn-layout").addEventListener(
      "click",
      () => setLayoutMode(!ed.layoutMode)
    );
    $("btn-theme").addEventListener("click", toggleTheme);
    $("btn-present").addEventListener("click", present);
    $("btn-fullscreen").addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", updateFullscreen);
    $("step-select").addEventListener("change", (e) => {
      const v = e.target.value;
      ed.step = v === "" ? null : Number(v);
      document.body.classList.toggle("previewing", ed.step != null);
      render();
      emit("step");
    });
    document.addEventListener("keydown", onKey2);
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

  // src/ts/editor/canvasmenu.ts
  var menu3 = document.getElementById("context-menu");
  var at = { x: 0, y: 0 };
  function sep() {
    return h("div", { class: "menu-sep" });
  }
  function title(text) {
    return h("div", { class: "menu-title" }, text);
  }
  function objectMenu() {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    const one = sels.length === 1 ? sels[0] : null;
    const el2 = one?.el ?? null;
    const items = [];
    if (el2) {
      if (canTypeInto(el2)) {
        items.push(menuItem("Type text into it", () => void typeInto(el2)));
      } else if (isZone(el2)) {
        items.push(menuItem("Edit text", () => emit("edit-zone")));
      } else if (el2.localName === "text") {
        items.push(menuItem("Edit text", () => emit("edit-text")));
      } else if (el2.localName === "g") {
        items.push(
          menuItem(
            "Enter group",
            () => enterGroup(el2)
          )
        );
      }
      const video = videoOf(el2);
      if (video) {
        items.push(
          menuItem(
            isPreviewing(video) ? "Pause preview" : "Play preview",
            () => togglePreview(video)
          )
        );
        const zone = isZone(el2) ? zoneName(el2) : null;
        const media = zone ? currentSlide()?.zones[zone] : null;
        const slide = currentSlide();
        if (zone && slide && media?.kind === "video" && media.src) {
          const src = media.src;
          items.push(
            menuItem(
              "Check & convert\u2026",
              () => void openVideoCheck({
                path: src,
                slide: slide.deckIndex,
                zone
              })
            )
          );
        }
      }
      if (diagramOf(el2)) {
        items.push(menuItem("Edit diagram", () => editDiagram(one)));
      }
      if (pictureOf(el2)) {
        items.push(menuItem("Crop", () => void startCrop(one)));
      }
      if (items.length) items.push(sep());
    }
    items.push(
      menuItem("Cut", () => cut()),
      menuItem("Copy", () => copy()),
      menuItem("Paste", () => void pasteFromClipboard()),
      menuItem("Duplicate", () => void duplicateSelection(), !sels.length),
      menuItem("Delete", () => void deleteSelection()),
      sep(),
      menuItem("Copy style", () => copyStyle(), !one),
      menuItem(
        "Paste style",
        () => void pasteStyle(),
        !sels.length || !hasCopiedStyle()
      ),
      sep(),
      menuItem("Bring to front", () => void order("front"), !sels.length),
      menuItem("Bring forward", () => void order("forward"), !sels.length),
      menuItem("Send backward", () => void order("backward"), !sels.length),
      menuItem("Send to back", () => void order("back"), !sels.length)
    );
    if (sels.length > 1) {
      items.push(
        sep(),
        menuItem("Group", () => void groupSelection()),
        title("Align"),
        ...[
          ["left", "Left edges"],
          ["center", "Centres (horizontally)"],
          ["right", "Right edges"],
          ["top", "Top edges"],
          ["middle", "Middles (vertically)"],
          ["bottom", "Bottom edges"]
        ].map(([how, label4]) => menuItem(label4, () => alignSelection(how)))
      );
    } else if (el2?.localName === "g") {
      items.push(
        sep(),
        menuItem("Ungroup", () => void ungroupSelection())
      );
    }
    if (el2 && one) {
      const src = sourceOf(one.key);
      items.push(
        sep(),
        menuItem(
          isHidden(el2) ? "Show" : "Hide",
          () => void toggleHidden2(el2)
        ),
        menuItem(
          el2.hasAttribute("data-ink-locked") ? "Unlock" : "Lock",
          () => void toggleLocked(el2)
        )
      );
      if (src) {
        const name2 = src.rel.split("/").pop() ?? src.rel;
        items.push(
          menuItem(`Open ${name2} in\u2026`, () => {
            void openMenu(src.path, at.x, at.y);
          })
        );
      }
    }
    return items;
  }
  async function insertFromDisk() {
    const start = ed.model?.projectDir ?? "";
    const path = await pickVideoFromDisk(start);
    if (!path) return;
    const name2 = path.split(/[\\/]/).pop() ?? path;
    await insertVideoFile({ path, name: name2 });
  }
  function slideMenu() {
    const slide = currentSlide();
    const editable = !!ed.model?.deckEditable;
    const i = slide?.deckIndex ?? ed.current;
    return [
      menuItem("Paste", () => void pasteFromClipboard()),
      menuItem("Select all", () => selectAll()),
      menuItem("Insert video from a folder\u2026", () => void insertFromDisk()),
      menuItem("New diagram (draw.io)\u2026", () => newDiagram()),
      sep(),
      title("Slide"),
      menuItem(
        "New slide after\u2026",
        () => void openGallery({ mode: "insert", after: ed.current }),
        !editable
      ),
      menuItem(
        "Change layout\u2026",
        () => {
          const parent = document.querySelector("#slide-host svg")?.getAttribute("inkflow:parent") ?? null;
          void openGallery({ mode: "change", current: parent });
        },
        !editable
      ),
      menuItem(
        "Duplicate slide",
        () => void duplicateSlide(ed.current),
        !editable
      ),
      menuItem(
        slide?.visible === false ? "Show slide" : "Hide slide",
        () => void edit({
          action: "slide",
          op: "hide",
          slide: i,
          hidden: slide?.visible !== false
        }),
        !editable
      ),
      menuItem("Delete slide", () => void deleteSlide(ed.current), !editable)
    ];
  }
  function onContextMenu(e) {
    const target = e.target;
    if (e.shiftKey || target.closest("input, textarea, select, [contenteditable]")) {
      return;
    }
    e.preventDefault();
    ed.focus = "canvas";
    at = { x: e.clientX, y: e.clientY };
    const hit = pick(e.clientX, e.clientY);
    if (hit) {
      if (!ed.selection.some((s) => s.el === hit)) select([hit]);
    } else {
      clearSelection();
    }
    clear(menu3);
    menu3.append(...hit ? objectMenu() : slideMenu());
    showMenu(e.clientX, e.clientY);
  }
  function initCanvasMenu() {
    document.getElementById("canvas")?.addEventListener("contextmenu", onContextMenu);
  }

  // src/ts/editor/context.ts
  var timer2 = 0;
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
    window.clearTimeout(timer2);
    timer2 = window.setTimeout(() => {
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
        const n2 = Number(msg.slide);
        const slides = ed.model?.slides ?? [];
        const target = slides.find((s) => s.visibleIndex === n2 - 1);
        if (target) gotoSlide(target.deckIndex);
      } else if (msg.command === "select") {
        const ids = msg.ids ?? [];
        const svg = slideRoot();
        if (!svg) return;
        const els = ids.map((id) => svg.querySelector(`[id="${CSS.escape(id)}"]`)).filter(
          (el2) => el2 instanceof SVGGraphicsElement
        );
        enterGroup(null);
        select(els);
        emit("flash");
      }
    });
  }

  // src/ts/editor/decks.ts
  var menu4 = document.getElementById("context-menu");
  var button2 = document.getElementById("btn-deck");
  function baseName2(path) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  }
  function join(dir, name2) {
    return `${dir.replace(/[\\/]+$/, "")}/${name2}`;
  }
  function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "my-deck";
  }
  function renderButton() {
    const dir = ed.model?.projectDir;
    button2.textContent = `${dir ? baseName2(dir) : "deck"} \u25BE`;
    button2.title = dir ? `${dir}
Decks: new, open, recent` : "Decks";
  }
  async function info() {
    const res = await request({ action: "project-info" });
    if (!res.ok) {
      toast(res.error ?? "Cannot read the deck's folder", "error");
      return null;
    }
    return res;
  }
  async function openMenu2() {
    const data = await info();
    if (!data) return;
    clear(menu4);
    menu4.append(
      menuItem("New deck\u2026", () => newDeckDialog(data)),
      menuItem("Open deck\u2026", () => openDeckDialog(data))
    );
    if (data.recent.length) {
      menu4.append(h("div", { class: "menu-title" }, "Recent decks"));
      for (const path of data.recent) {
        const dir = path.replace(/[\\/]deck\.py$/, "");
        const item = menuItem(baseName2(dir), () => void openDeck(path));
        item.title = dir;
        menu4.append(item);
      }
    }
    menu4.append(
      h("div", { class: "menu-sep" }),
      menuItem("Quit Inkflow", () => void quit())
    );
    const r = button2.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4);
  }
  async function openDeck(path) {
    const res = await request({ action: "open-deck", path });
    if (!res.ok) {
      toast(res.error ?? "Cannot open that deck", "error");
      return false;
    }
    closeDialog();
    if (res.redirect) {
      toast("That deck is already open: switching to it\u2026");
      location.assign(String(res.redirect));
      return true;
    }
    if (!res.opening) {
      toast("That deck is the one open here");
      return true;
    }
    toast(
      `Opening ${baseName2(String(res.deck ?? path).replace(/[\\/]deck\.py$/, ""))}\u2026`
    );
    return true;
  }
  function newDeckDialog(data) {
    const title2 = h("input", {
      type: "text",
      value: "My presentation"
    });
    const name2 = h("input", {
      type: "text",
      value: data.name
    });
    let nameEdited = false;
    name2.addEventListener("input", () => {
      nameEdited = true;
      update();
    });
    title2.addEventListener("input", () => {
      if (!nameEdited) name2.value = slug(title2.value);
      update();
    });
    let look = data.themes.some((t) => t.id === "current") ? "current" : "starter";
    const looks = h(
      "div",
      { class: "look-list" },
      ...data.themes.map((t) => {
        const radio = h("input", {
          type: "radio",
          name: "deck-look",
          value: t.id
        });
        radio.checked = t.id === look;
        radio.addEventListener("change", () => {
          look = t.id;
        });
        return h(
          "label",
          { class: "look" },
          radio,
          h(
            "span",
            { class: "look-text" },
            h("strong", {}, t.label),
            h("span", { class: "hint" }, t.description)
          )
        );
      })
    );
    const git2 = h("input", { type: "checkbox" });
    git2.checked = true;
    git2.addEventListener("change", () => update());
    const gitRow = h(
      "label",
      { class: "check-row" },
      git2,
      "Create a git repository for this deck"
    );
    const gitNote = h("p", { class: "hint" });
    const lfs = h("input", { type: "checkbox" });
    lfs.checked = data.lfs;
    const lfsRow = h(
      "label",
      { class: "check-row" },
      lfs,
      "Store videos, images and fonts with Git LFS"
    );
    const lfsNote = h(
      "p",
      { class: "hint" },
      data.lfs ? "Untick for git only: media is kept in git itself, fine for a small repository." : "git-lfs is not installed, so this deck uses git only (its .gitattributes says so; install git-lfs to switch later)."
    );
    const full = h("p", { class: "hint full-path" });
    const picker = folderPicker(data.parent, () => update());
    function update() {
      const folder = picker.current();
      const parent = folder?.path ?? data.parent;
      full.textContent = `New deck: ${join(parent, name2.value || "\u2026")}`;
      const inRepo = !!folder?.repo;
      gitRow.hidden = inRepo || !data.git;
      lfsRow.hidden = !data.git || !inRepo && !git2.checked;
      lfsNote.hidden = lfsRow.hidden;
      gitNote.textContent = inRepo ? `It becomes a new folder of the git repository at ${folder?.repo}, versioned with it.` : data.git ? "" : "git is not installed, so the deck gets no repository.";
    }
    const create = h(
      "button",
      { type: "button", class: "pbtn primary" },
      "Create and open"
    );
    create.addEventListener("click", async () => {
      const folder = picker.current();
      if (!folder || !name2.value.trim()) {
        toast("Choose a folder and a name for the deck", "error");
        return;
      }
      create.disabled = true;
      create.textContent = "Creating\u2026";
      const res = await request({
        action: "new-deck",
        path: join(folder.path, name2.value.trim()),
        title: title2.value,
        theme: look,
        git: !folder.repo && git2.checked,
        lfs: lfs.checked
      });
      create.disabled = false;
      create.textContent = "Create and open";
      if (!res.ok) {
        toast(res.error ?? "Could not create the deck", "error");
        return;
      }
      closeDialog();
      toast(`Created ${name2.value.trim()}; opening it\u2026`, "ok");
    });
    openDialog(
      "New deck",
      h(
        "div",
        { class: "deck-form" },
        h(
          "label",
          { class: "field" },
          h("span", { class: "field-label" }, "Title"),
          title2
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Look"),
          looks
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Where"),
          h(
            "div",
            {},
            picker.el,
            h(
              "label",
              { class: "field inline" },
              h("span", { class: "field-label" }, "Folder name"),
              name2
            ),
            full,
            gitRow,
            gitNote,
            lfsRow,
            lfsNote
          )
        ),
        h("div", { class: "btn-row end" }, create)
      ),
      { large: true }
    );
    update();
    title2.select();
  }
  function openDeckDialog(data) {
    const open4 = h(
      "button",
      { type: "button", class: "pbtn primary", disabled: true },
      "Open this deck"
    );
    const picker = folderPicker(
      data.places?.default ?? data.current.replace(/[\\/][^\\/]*$/, ""),
      (f) => {
        open4.disabled = !f.isDeck;
        open4.textContent = f.isDeck ? `Open ${baseName2(f.path)}` : "No deck.py in this folder";
      }
    );
    open4.addEventListener("click", () => {
      const f = picker.current();
      if (f?.isDeck) void openDeck(join(f.path, "deck.py"));
    });
    openDialog(
      "Open deck",
      h(
        "div",
        { class: "deck-form" },
        h("p", { class: "hint" }, "Go to a folder with a deck.py in it."),
        picker.el,
        h("div", { class: "btn-row end" }, open4)
      ),
      { large: true }
    );
    picker.focus();
  }
  async function quit() {
    const res = await request({ action: "quit" });
    if (!res.ok) {
      toast(res.error ?? "Cannot stop inkflow from here", "error");
      return;
    }
    stopReconnecting();
    document.getElementById("start")?.remove();
    document.body.classList.add("start-mode");
    document.body.append(
      h(
        "div",
        { id: "start", class: "start" },
        h(
          "div",
          { class: "start-card" },
          h("div", { class: "start-logo" }, "ink", h("b", {}, "flow")),
          h(
            "p",
            { class: "start-lead" },
            "Inkflow has stopped. Everything was saved as you went; you can close this tab."
          )
        )
      )
    );
  }
  async function showStart() {
    document.body.classList.add("start-mode");
    await whenConnected();
    const data = await info();
    const recent = h("div", { class: "start-recent" });
    if (data?.recent.length) {
      recent.append(h("h2", {}, "Recent decks"));
      for (const path of data.recent) {
        const dir = path.replace(/[\\/]deck\.py$/, "");
        recent.append(
          h(
            "button",
            {
              type: "button",
              class: "start-deck",
              title: dir,
              onclick: () => void openDeck(path)
            },
            h("span", { class: "start-deck-name" }, baseName2(dir)),
            h("span", { class: "start-deck-path" }, dir)
          )
        );
      }
    }
    const action = (label4, hint, fn) => h(
      "button",
      { type: "button", class: "start-action", onclick: fn },
      h("span", { class: "start-action-label" }, label4),
      h("span", { class: "start-action-hint" }, hint)
    );
    const page = h(
      "div",
      { id: "start", class: "start" },
      h(
        "div",
        { class: "start-card" },
        h("div", { class: "start-logo" }, "ink", h("b", {}, "flow")),
        h(
          "p",
          { class: "start-lead" },
          "Slides you draw, write and version."
        ),
        h(
          "div",
          { class: "start-actions" },
          // Asked afresh each time: a default location saved in the
          // picker since counts.
          action(
            "New deck\u2026",
            "Start from one of four looks",
            async () => {
              const fresh = await info();
              if (fresh) newDeckDialog(fresh);
            }
          ),
          action("Open deck\u2026", "A folder with a deck.py", async () => {
            const fresh = await info();
            if (fresh) openDeckDialog(fresh);
          })
        ),
        recent,
        h(
          "button",
          {
            type: "button",
            class: "start-quit",
            onclick: () => void quit()
          },
          "Quit Inkflow"
        )
      )
    );
    document.body.append(page);
  }
  function initDecks() {
    button2.addEventListener("click", () => void openMenu2());
    on("model", renderButton);
    renderButton();
  }

  // src/ts/editor/exportdlg.ts
  var FORMATS = [
    {
      format: "html",
      title: "Web page",
      text: "A folder with index.html and the deck's images and videos. Opens offline in any browser, or upload it to any web host.",
      placeholder: () => "build"
    },
    {
      format: "single",
      title: "Single HTML file",
      text: "Everything in one file, images included: easy to email or share. Larger than the folder.",
      placeholder: (stem) => `${stem}.html`
    },
    {
      format: "pdf",
      title: "PDF",
      text: "One page per slide, every build step shown. Needs Chromium or Chrome on this computer.",
      placeholder: (stem) => `${stem}.pdf`
    }
  ];
  function size(bytes) {
    if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  }
  function option(f, stem) {
    const output = h("input", {
      type: "text",
      placeholder: f.placeholder(stem),
      spellcheck: "false",
      title: "Where to save it, relative to deck.py"
    });
    const status2 = h("div", { class: "export-status" });
    const go = h("button", { type: "button", class: "pbtn primary" }, "Export");
    go.addEventListener("click", async () => {
      go.disabled = true;
      status2.textContent = f.format === "pdf" ? "Rendering pages\u2026" : "Building\u2026";
      status2.className = "export-status busy";
      const result = await request({
        action: "export",
        format: f.format,
        output: output.value.trim() || null
      });
      go.disabled = false;
      if (!result.ok) {
        status2.className = "export-status error";
        status2.textContent = result.error ?? "export failed";
        return;
      }
      const r = result;
      status2.className = "export-status done";
      status2.replaceChildren(
        h("span", {}, `Saved to ${r.rel} \xB7 ${size(r.size)}`),
        h(
          "a",
          { href: r.download, class: "pbtn", download: "" },
          f.format === "html" ? "Download .zip" : "Download"
        )
      );
    });
    return h(
      "div",
      { class: "export-option" },
      h(
        "div",
        { class: "export-text" },
        h("strong", {}, f.title),
        h("p", { class: "hint" }, f.text)
      ),
      h("div", { class: "export-row" }, output, go),
      status2
    );
  }
  function openExport() {
    const stem = ed.model?.deckPath.split(/[\\/]/).pop()?.replace(/\.py$/, "") ?? "deck";
    openDialog(
      "Export",
      h(
        "div",
        { class: "export-body" },
        ...FORMATS.map((f) => option(f, stem))
      ),
      { hint: "Saved next to deck.py; the paths can be changed" }
    );
  }
  function initExport() {
    document.getElementById("btn-export")?.addEventListener("click", openExport);
  }

  // src/ts/editor/git.ts
  var menu5 = document.getElementById("context-menu");
  var button3 = document.getElementById("btn-git");
  var label2 = button3.querySelector(".git-label");
  var badge = button3.querySelector(".git-badge");
  var status = { repo: false, git: false };
  function render2() {
    button3.hidden = !status.git;
    if (!status.repo) {
      label2.textContent = "Git";
      badge.hidden = true;
      button3.title = "Not versioned: create a git repository for this deck";
      return;
    }
    label2.textContent = status.branch ?? `@${status.detached ?? "?"}`;
    const n2 = status.changes?.length ?? 0;
    const lfsIssues = lfsFiles().length;
    button3.classList.toggle("warn", lfsIssues > 0);
    badge.hidden = n2 === 0 && lfsIssues === 0;
    badge.textContent = n2 ? String(n2) : "!";
    const sync = [
      status.ahead ? `${status.ahead} to push` : "",
      status.behind ? `${status.behind} to pull` : ""
    ].filter(Boolean).join(", ");
    button3.title = [
      status.branch ? `Branch ${status.branch}` : `Viewing ${status.detached}`,
      n2 ? `${n2} changed file${n2 === 1 ? "" : "s"}` : "No changes",
      sync,
      lfsIssues ? `${lfsIssues} media file${lfsIssues === 1 ? "" : "s"} not in Git LFS` : ""
    ].filter(Boolean).join(" \xB7 ");
  }
  async function refreshGit() {
    if (!connected()) return status;
    const res = await request({ action: "git", op: "status" });
    if (res.ok && res.git) status = res.git;
    render2();
    return status;
  }
  var REWRITES = /* @__PURE__ */ new Set([
    "discard",
    "pull",
    "switch",
    "view",
    "revert",
    "restore",
    "create-branch"
  ]);
  var NOTICE_KEY = "inkflow-git-undo-notice";
  var noticeShown = false;
  function undoNoticeDue() {
    try {
      return sessionStorage.getItem(NOTICE_KEY) !== "1" && !noticeShown;
    } catch {
      return !noticeShown;
    }
  }
  function undoNoticeShown() {
    noticeShown = true;
    try {
      sessionStorage.setItem(NOTICE_KEY, "1");
    } catch {
    }
  }
  var UNDO_NOTICE = "Note: git changes the deck's files on disk, so the editor's undo and redo history is cleared afterwards (Ctrl+Z cannot go back past this point). You are told this once per session.";
  async function git(op, args = {}, question = "") {
    const notice = REWRITES.has(op) && undoNoticeDue();
    if (question || notice) {
      const text = [question, notice ? UNDO_NOTICE : ""].filter(Boolean).join("\n\n");
      if (!confirm(question ? text : `${text}

Continue?`)) return null;
      if (notice) undoNoticeShown();
    }
    button3.classList.add("busy");
    const res = await request({ action: "git", op, ...args });
    button3.classList.remove("busy");
    if (res.git) {
      status = res.git;
      render2();
    }
    if (!res.ok) {
      toast(res.error ?? `git ${op} failed`, "error");
      return null;
    }
    if (typeof res.message === "string") toast(res.message, "ok");
    if (res.historyCleared) {
      ed.canUndo = false;
      ed.canRedo = false;
      emit("history");
    }
    return res;
  }
  async function openMenu3() {
    await refreshGit();
    clear(menu5);
    if (!status.repo) {
      menu5.append(
        h("div", { class: "menu-title" }, "Not versioned"),
        menuItem("Create a git repository", async () => {
          if (await git("init"))
            toast("This deck is now versioned with git", "ok");
        }),
        menuItem("Create a git repository (git only, no LFS)", async () => {
          if (await git("init", { lfs: false }))
            toast("This deck is now versioned with git", "ok");
        })
      );
    } else {
      const n2 = status.changes?.length ?? 0;
      const deckChanges = (status.changes ?? []).filter((c) => c.inDeck);
      const where = status.branch ? `On ${status.branch}` : `Viewing ${status.detached} (no branch)`;
      menu5.append(
        h(
          "div",
          { class: "menu-title" },
          `${where} \xB7 ${n2 ? `${n2} change${n2 === 1 ? "" : "s"}` : "no changes"}`
        )
      );
      if (status.last) {
        menu5.append(
          h(
            "div",
            { class: "menu-note" },
            `Last: ${status.last.subject} (${status.last.when})`
          )
        );
      }
      const lfsCount = lfsFiles().length;
      if (lfsCount) {
        const item = menuItem(
          `\u26A0 ${lfsCount} media file${lfsCount === 1 ? "" : "s"} not in Git LFS\u2026`,
          () => lfsDialog()
        );
        item.classList.add("warn");
        menu5.append(item);
      } else if (status.lfs?.mode === "on" && !status.lfs.installed) {
        menu5.append(
          h(
            "div",
            { class: "menu-note warn" },
            "git-lfs is not installed: this deck's media needs it"
          )
        );
      }
      menu5.append(
        menuItem(
          "Commit\u2026",
          () => commitDialog(),
          n2 === 0 || !status.branch
        ),
        menuItem(
          status.ahead ? `Push (${status.ahead})` : "Push",
          () => void git("push"),
          !status.remotes?.length || !status.branch
        ),
        menuItem(
          status.behind ? `Pull (${status.behind})` : "Pull",
          () => void git("pull"),
          !status.upstream
        ),
        menuItem(
          "Discard changes\u2026",
          () => discardDialog(),
          deckChanges.length === 0
        ),
        menuItem(
          "Undo last commit",
          async () => {
            if (await git(
              "undo-commit",
              {},
              `Take back "${status.last?.subject}"? Its changes stay, uncommitted.`
            ))
              toast(
                "Last commit taken back; its changes are kept",
                "ok"
              );
          },
          !status.canUndoCommit
        ),
        h("div", { class: "menu-sep" }),
        menuItem(
          status.branch ? "Branches\u2026" : "Back to a branch\u2026",
          () => void branchesDialog(),
          !status.hasCommits
        ),
        menuItem(
          "History\u2026",
          () => void historyDialog(),
          !status.hasCommits
        )
      );
    }
    const r = button3.getBoundingClientRect();
    showMenu(Math.max(8, r.right - 260), r.bottom + 4);
  }
  function lfsFiles() {
    const l = status.lfs;
    return l ? [...l.uncovered, ...l.unconverted] : [];
  }
  function size2(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }
  function lfsList(files2) {
    return h(
      "div",
      { class: "git-files" },
      ...files2.map(
        (f) => h(
          "div",
          { class: "git-file" },
          h("span", { class: "git-status" }, f.kind),
          h("code", { class: "git-path" }, f.path),
          h("span", { class: "hint git-size" }, size2(f.size))
        )
      )
    );
  }
  function lfsDialog() {
    const l = status.lfs;
    if (!l) return;
    const paths = lfsFiles().map((f) => f.path);
    openDialog(
      "Large files and Git LFS",
      h(
        "div",
        { class: "git-form" },
        h(
          "p",
          { class: "hint" },
          "Git keeps a full copy of a video or image in every version, so the repository grows with each change. Git LFS stores them outside the history; a small repository can do without it."
        ),
        l.uncovered.length > 0 && h("h3", {}, "No Git LFS rule covers these"),
        l.uncovered.length > 0 && lfsList(l.uncovered),
        l.unconverted.length > 0 && h("h3", {}, "Committed before Git LFS was set up"),
        l.unconverted.length > 0 && lfsList(l.unconverted),
        !l.installed && h(
          "p",
          { class: "hint warn" },
          "git-lfs is not installed on this computer: install it (git-lfs.com) to track files with it."
        ),
        h(
          "p",
          { class: "hint" },
          "Tracking adds rules to the deck's .gitattributes and stages the files again as LFS files; commit to keep it. Earlier commits keep their full copies (git lfs migrate rewrites history, for everyone with a clone)."
        ),
        h(
          "div",
          { class: "btn-row end" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn",
              title: "Record in .gitattributes that this deck stores media in git itself; no more warnings",
              onclick: async () => {
                if (await git("lfs-off")) closeDialog();
              }
            },
            "Use git without LFS"
          ),
          h(
            "button",
            {
              type: "button",
              class: "pbtn primary",
              disabled: !l.installed,
              onclick: async () => {
                if (await git("lfs-track", { paths }))
                  closeDialog();
              }
            },
            "Track with Git LFS"
          )
        )
      ),
      { wide: true }
    );
  }
  function fileRow(change, checked) {
    const box = h("input", {
      type: "checkbox",
      value: change.path
    });
    box.checked = checked;
    return h(
      "label",
      { class: `git-file${change.inDeck ? "" : " outside"}` },
      box,
      h("span", { class: `git-status s-${change.status}` }, change.status),
      h("code", { class: "git-path" }, change.path)
    );
  }
  function checkedPaths(list3) {
    return [...list3.querySelectorAll("input:checked")].map(
      (b) => b.value
    );
  }
  function commitDialog() {
    const changes = status.changes ?? [];
    const message = h("textarea", {
      class: "git-message",
      rows: "3"
    });
    message.value = status.suggestedMessage ?? "Update slides";
    const files2 = h(
      "div",
      { class: "git-files" },
      ...changes.map((c) => fileRow(c, c.inDeck))
    );
    const outside = changes.some((c) => !c.inDeck);
    const name2 = h("input", {
      type: "text",
      placeholder: "Your name"
    });
    const email = h("input", {
      type: "email",
      placeholder: "you@example.com"
    });
    const identity = status.identity ? null : h(
      "div",
      { class: "git-identity" },
      h(
        "p",
        { class: "hint" },
        "git needs to know who commits (kept in this repository only):"
      ),
      h("div", { class: "btn-row" }, name2, email)
    );
    const run = async (push) => {
      const paths = checkedPaths(files2);
      const res = await git("commit", {
        message: message.value,
        paths,
        ...identity ? { name: name2.value, email: email.value } : {}
      });
      if (!res) return;
      closeDialog();
      if (push) await git("push");
    };
    const canPush = !!status.remotes?.length;
    const changed2 = new Set(changes.map((c) => c.path));
    const heavy = lfsFiles().filter((f) => changed2.has(f.path));
    const lfsNote = heavy.length > 0 && h(
      "p",
      { class: "hint warn" },
      `${heavy.length} of these ${heavy.length === 1 ? "is a media file" : "are media files"} git would store whole, not in Git LFS. `,
      h(
        "button",
        {
          type: "button",
          class: "link-btn",
          onclick: () => lfsDialog()
        },
        "Review\u2026"
      )
    );
    message.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void run(false);
      }
    });
    openDialog(
      "Commit",
      h(
        "div",
        { class: "git-form" },
        h(
          "label",
          { class: "field" },
          h("span", { class: "field-label" }, "Message"),
          message
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Files"),
          h(
            "div",
            {},
            files2,
            outside && h(
              "p",
              { class: "hint" },
              "Files outside this deck are left out unless you tick them."
            )
          )
        ),
        lfsNote,
        identity,
        h(
          "div",
          { class: "btn-row end" },
          canPush && h(
            "button",
            {
              type: "button",
              class: "pbtn",
              onclick: () => void run(true)
            },
            "Commit and push"
          ),
          h(
            "button",
            {
              type: "button",
              class: "pbtn primary",
              title: "Ctrl+Enter",
              onclick: () => void run(false)
            },
            "Commit"
          )
        )
      ),
      { wide: true, hint: status.branch ? `on ${status.branch}` : void 0 }
    );
    message.focus();
    message.select();
  }
  function discardDialog() {
    const changes = (status.changes ?? []).filter((c) => c.inDeck);
    const files2 = h(
      "div",
      { class: "git-files" },
      ...changes.map((c) => fileRow(c, true))
    );
    openDialog(
      "Discard changes",
      h(
        "div",
        { class: "git-form" },
        h(
          "p",
          { class: "hint warn" },
          "The ticked files go back to how they were in the last commit; new files are deleted. This cannot be undone."
        ),
        files2,
        h(
          "div",
          { class: "btn-row end" },
          h(
            "button",
            {
              type: "button",
              class: "pbtn danger",
              onclick: async () => {
                const paths = checkedPaths(files2);
                if (!paths.length) return;
                if (await git("discard", { paths })) {
                  closeDialog();
                  toast(
                    `Discarded changes to ${paths.length} file${paths.length === 1 ? "" : "s"}`,
                    "ok"
                  );
                }
              }
            },
            "Discard"
          )
        )
      ),
      { wide: true }
    );
  }
  async function branchesDialog() {
    const res = await git("branches");
    if (!res) return;
    const branches = res.branches;
    const name2 = h("input", {
      type: "text",
      placeholder: "new-branch-name"
    });
    const create = async () => {
      if (!name2.value.trim()) return;
      if (await git("create-branch", { name: name2.value.trim() })) {
        closeDialog();
        toast(`Created and switched to ${name2.value.trim()}`, "ok");
      }
    };
    name2.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void create();
      }
    });
    openDialog(
      "Branches",
      h(
        "div",
        { class: "git-form" },
        h(
          "div",
          { class: "git-list" },
          ...branches.map(
            (b) => h(
              "div",
              { class: `git-row${b.current ? " current" : ""}` },
              h("strong", {}, b.name),
              h(
                "span",
                { class: "hint" },
                b.current ? "current" : b.when
              ),
              !b.current && h(
                "button",
                {
                  type: "button",
                  class: "pbtn",
                  onclick: async () => {
                    if (await git("switch", {
                      name: b.name
                    })) {
                      closeDialog();
                      toast(
                        `Switched to ${b.name}`,
                        "ok"
                      );
                    }
                  }
                },
                "Switch"
              )
            )
          )
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "New branch"),
          h(
            "div",
            { class: "btn-row" },
            name2,
            h(
              "button",
              {
                type: "button",
                class: "pbtn primary",
                onclick: create
              },
              "Create and switch"
            )
          )
        ),
        h(
          "p",
          { class: "hint" },
          "Uncommitted changes come along to the branch you switch to; git refuses a switch that would overwrite them."
        )
      ),
      { wide: true }
    );
  }
  async function historyDialog() {
    const res = await git("log");
    if (!res) return;
    const log = res.log;
    const act = async (op, c, question, done) => {
      if (await git(op, { sha: c.sha }, question)) {
        closeDialog();
        toast(done, "ok");
      }
    };
    openDialog(
      "History",
      h(
        "div",
        { class: "git-form" },
        log.length ? h(
          "div",
          { class: "git-list history" },
          ...log.map(
            (c) => h(
              "div",
              { class: `git-row${c.head ? " current" : ""}` },
              h(
                "div",
                { class: "git-commit" },
                h("strong", {}, c.subject),
                h(
                  "span",
                  { class: "hint" },
                  `${c.short} \xB7 ${c.author} \xB7 ${c.when}${c.refs.length ? ` \xB7 ${c.refs.join(", ")}` : ""}`
                )
              ),
              h(
                "div",
                { class: "btn-row" },
                h(
                  "button",
                  {
                    type: "button",
                    class: "pbtn",
                    title: "Show the deck as it was then (switch back with Branches)",
                    onclick: () => void act(
                      "view",
                      c,
                      `Show the deck as it was at "${c.subject}"? Edits there are not on any branch until you create one.`,
                      `Viewing ${c.short}; switch back to a branch from the git menu`
                    )
                  },
                  "View"
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "pbtn",
                    title: "Make the deck's files what they were then, as uncommitted changes",
                    onclick: () => void act(
                      "restore",
                      c,
                      `Restore the deck's files to "${c.subject}"? Your current files are replaced (commit first to keep them).`,
                      `Restored the deck to ${c.short}; commit to keep it`
                    )
                  },
                  "Restore"
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "pbtn",
                    title: "A new commit that undoes this one",
                    onclick: () => void act(
                      "revert",
                      c,
                      `Undo "${c.subject}" with a new commit?`,
                      `Reverted ${c.short}`
                    )
                  },
                  "Revert"
                )
              )
            )
          )
        ) : h("p", { class: "hint" }, "No commits touch this deck yet."),
        h(
          "p",
          { class: "hint" },
          "View: look at an old version (no branch). Restore: bring the deck back to it as changes you can commit. Revert: undo one commit with a new one."
        )
      ),
      {
        wide: true,
        hint: status.scope ? `changes to ${status.scope}/` : void 0
      }
    );
  }
  var timer3 = 0;
  function initGit() {
    button3.addEventListener("click", () => void openMenu3());
    on("model", () => {
      window.clearTimeout(timer3);
      timer3 = window.setTimeout(() => void refreshGit(), 600);
    });
  }

  // src/ts/editor/notes.ts
  var area = document.getElementById("notes-input");
  var label3 = document.getElementById("notes-file");
  var timer4 = 0;
  var slideIndex = -1;
  var sent = "";
  var burst = "";
  async function save() {
    window.clearTimeout(timer4);
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
      timer4 = window.setTimeout(() => void save(), 800);
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
    label3.textContent = slide.notes.kind === "file" ? slide.notes.rel ?? "" : slide.notes.kind === "inline" ? "inline in deck.py" : "new notes file on first edit";
  }
  function initNotes() {
    area.addEventListener("focus", () => {
      burst = `notes-${Date.now()}`;
    });
    area.addEventListener("input", () => {
      window.clearTimeout(timer4);
      timer4 = window.setTimeout(() => void save(), 600);
    });
    area.addEventListener("blur", () => void save());
    area.addEventListener("keydown", (e) => e.stopPropagation());
    on("slide", () => {
      void save().then(load);
    });
    on("model", load);
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
  var info2 = null;
  var content = null;
  var cssVar = (name2) => `--inkflow-${name2.replace(/_/g, "-")}`;
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
    return `#${rgb.slice(0, 3).map((n2) => Number(n2).toString(16).padStart(2, "0")).join("")}`;
  }
  async function save2(body2, label4) {
    await edit({ action: "theme-set", label: label4, ...body2 });
  }
  function setToken(group, name2, value) {
    void save2({ changes: { [group]: { [name2]: value } } }, "Theme");
  }
  function colorCell(mode, name2) {
    const t = info2;
    const own = t.overrides[mode][name2];
    const value = own ?? t.values[mode][name2] ?? "#000000";
    const input = h("input", {
      type: "color",
      value: toHex(value),
      title: `${cssVar(name2)} (${mode})${own ? " \xB7 changed" : ""}`
    });
    input.addEventListener("input", () => {
      const showing = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      if (showing === mode) {
        document.documentElement.style.setProperty(
          cssVar(name2),
          input.value
        );
      }
    });
    input.addEventListener("change", () => setToken(mode, name2, input.value));
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
          onclick: () => setToken(mode, name2, null)
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
    const add = (name2, label4) => rows.push(
      h(
        "div",
        { class: "theme-row" },
        h("span", { class: "theme-label" }, label4),
        colorCell("dark", name2),
        colorCell("light", name2)
      )
    );
    for (const [name2, label4] of SEMANTIC) add(name2, label4);
    rows.push(h("div", { class: "theme-sub" }, "Named colours"));
    for (const name2 of NAMED) add(name2, name2[0].toUpperCase() + name2.slice(1));
    return h("div", { class: "theme-colors" }, ...rows);
  }
  function fontRow(name2, label4, generic) {
    const t = info2;
    const own = t.overrides.typography[name2];
    const value = own ?? t.values.typography[name2] ?? generic;
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
        setToken("typography", name2, null);
        return;
      }
      const withFallback = v.includes(",") || v === generic ? v : `${v}, ${generic}`;
      setToken("typography", name2, withFallback);
    });
    const sample = h("span", { class: "theme-font-sample" }, "Aa Bb 123");
    sample.style.fontFamily = value;
    return h(
      "div",
      { class: "theme-font" },
      h("span", { class: "theme-label" }, label4),
      input,
      sample,
      own ? h(
        "button",
        {
          type: "button",
          class: "theme-reset",
          title: "Back to the theme's font",
          onclick: () => setToken("typography", name2, null)
        },
        "\u21BA"
      ) : null
    );
  }
  function render3() {
    if (!content || !info2) return;
    const t = info2;
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
    const size3 = h("input", {
      type: "number",
      min: 8,
      max: 200,
      value: t.fontSize ?? "",
      placeholder: String(t.themeFontSize)
    });
    size3.disabled = !ed.model?.deckEditable;
    size3.addEventListener("change", () => {
      const n2 = parseInt(size3.value, 10);
      void save2({ fontSize: Number.isFinite(n2) ? n2 : null }, "Font size");
    });
    const list3 = h("datalist", { id: "theme-font-list" });
    for (const f of ["sans-serif", "serif", "monospace", ...t.fonts]) {
      list3.append(h("option", { value: f }));
    }
    content.append(
      h(
        "div",
        { class: "theme-top" },
        h("label", {}, h("span", {}, "Colour mode"), mode),
        h("label", {}, h("span", {}, "Base font size (px)"), size3)
      ),
      h("h3", {}, "Fonts"),
      list3,
      ...FONTS.map(([n2, l, g]) => fontRow(n2, l, g)),
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
    info2 = result.theme;
    render3();
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
  function editTextOf(el2) {
    const slide = currentSlide();
    const loc = el2.getAttribute("data-ink");
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
    editSvgText(el2, src.path, () => slide.sources?.[key]?.hash ?? "", loc);
  }
  function readHash() {
    const m = location.hash.match(/slide=(\d+)/);
    if (!m || !ed.model) return;
    const n2 = Number(m[1]);
    const s = ed.model.slides.find((x) => x.visibleIndex === n2 - 1);
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
      (el2) => el2 instanceof SVGGraphicsElement
    );
    if (!els.length) return;
    const { editText, placeholder } = afterRender;
    afterRender.ids = [];
    afterRender.editText = false;
    afterRender.placeholder = void 0;
    select(els);
    if (editText && els[0].localName === "text") editTextOf(els[0]);
    else if (editText && isZone(els[0])) {
      editZone(zoneName(els[0]), els[0], { selectAll: true, placeholder });
    }
  }
  function boot() {
    ed.model = INITIAL_MODEL;
    ed.slides = INITIAL_SLIDES;
    ed.error = INITIAL_ERROR;
    readHash();
    hooks.editText = editTextOf;
    hooks.editZone = (zone, el2, at2) => editZone(zone, el2, { at: at2 });
    hooks.editingHost = editingHost;
    hooks.crop = (el2) => {
      const sel = ed.selection.find((s) => s.el === el2);
      if (sel) void startCrop(sel);
    };
    hooks.finishEditing = () => void finishTextEdit();
    hooks.diagram = (el2) => {
      const sel = ed.selection.find((s) => s.el === el2);
      if (!sel || !diagramOf(el2)) return false;
      editDiagram(sel);
      return true;
    };
    hooks.diagramEdited = diagramEdited;
    hooks.cellLabel = focusCellLabel;
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
    initExport();
    initFind();
    initGrid();
    initTheme();
    initDecks();
    initGit();
    initCanvasMenu();
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
      const el2 = ed.selection[0]?.el;
      if (el2 && isZone(el2)) editZone(zoneName(el2), el2);
    });
    on("edit-text", () => {
      const el2 = ed.selection[0]?.el;
      if (el2?.localName === "text") editTextOf(el2);
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
    if (!ed.model && !ed.error) void showStart();
  }
  boot();
})();
