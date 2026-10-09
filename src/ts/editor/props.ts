// The properties panel on the right. With nothing selected it edits the slide
// (title, layout, transition, visibility, animation order); with one object
// selected, that object (position, colours, text, arrangement, animations);
// with several, alignment and distribution.

import {
    canTransform,
    elementGeom,
    enterGroup,
    isZone,
    moveOps,
    select,
    selectionBox,
    sendSvgOps,
    slideBox,
    slideRoot,
    slideSize,
    zoneName,
} from "./canvas";
import {
    isCropped,
    pictureOf,
    resetCrop,
    setCropMode,
    startCrop,
} from "./crop";
import { clear, h, icon, toast } from "./dom";
import { layoutLabel, openGallery } from "./gallery";
import {
    type Box,
    parseTransform,
    planResize,
    planRotate,
    relativePath,
    rotationOf,
} from "./geom";
import { pickFile, upload, zoneMedia } from "./insert";
import { edit } from "./net";
import { distribute } from "./snap";
import { currentSlide, ed, emit, on, sourceOf } from "./state";
import type {
    CueInfo,
    FieldSchema,
    FieldValue,
    Selected,
    SlideModel,
    SvgOp,
    TransitionInfo,
    TypeInfo,
    ZoneValue,
} from "./types";

const panel = document.getElementById("props-body")!;

// ── Small widgets ──

function section(title: string, ...body: (Node | null | false)[]): HTMLElement {
    return h(
        "section",
        { class: "props-section" },
        h("h3", {}, title),
        ...body.filter((b): b is Node => !!b),
    );
}

function row(label: string, ...controls: Node[]): HTMLElement {
    return h(
        "label",
        { class: "prop-row" },
        h("span", { class: "prop-label" }, label),
        ...controls,
    );
}

function numberInput(
    value: number | null,
    commit: (v: number) => void,
    opts: {
        step?: number;
        min?: number;
        placeholder?: string;
        // Called when the box is emptied (for fields that accept None).
        onClear?: () => void;
    } = {},
): HTMLInputElement {
    const input = h("input", {
        type: "number",
        class: "num",
        step: opts.step ?? 1,
        min: opts.min ?? null,
        placeholder: opts.placeholder ?? "",
        value: value == null ? "" : String(Math.round(value * 100) / 100),
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

function textInput(
    value: string,
    commit: (v: string) => void,
    placeholder = "",
): HTMLInputElement {
    const input = h("input", { type: "text", value, placeholder });
    input.addEventListener("change", () => commit(input.value));
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") input.blur();
    });
    return input;
}

function selectInput(
    options: { value: string; label: string }[],
    value: string,
    commit: (v: string) => void,
): HTMLSelectElement {
    const sel = h("select", {});
    for (const o of options) {
        const opt = h("option", { value: o.value }, o.label);
        if (o.value === value) opt.selected = true;
        sel.append(opt);
    }
    sel.addEventListener("change", () => commit(sel.value));
    return sel;
}

function button(
    label: string | Node,
    title: string,
    fn: () => void,
    cls = "",
): HTMLButtonElement {
    return h(
        "button",
        { type: "button", class: `pbtn ${cls}`, title, onclick: fn },
        label,
    );
}

// ── Field editors (animations, transitions) ──

function fieldControl(
    f: FieldSchema,
    value: FieldValue,
    commit: (v: FieldValue) => void,
): Node {
    switch (f.kind) {
        case "trigger": {
            const labels: Record<string, string> = {
                "on-click": "On click",
                "with-previous": "With previous",
                "after-previous": "After previous",
            };
            const v = String(value ?? f.default ?? "on-click");
            const opts = f.choices.map((c) => ({
                value: c,
                label: labels[c] ?? c,
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
                    onClear: f.optional ? () => commit(null) : undefined,
                },
            );
        default:
            return textInput(value == null ? "" : String(value), commit);
    }
}

function fieldsEditor(
    schema: FieldSchema[],
    values: Record<string, FieldValue>,
    commit: (values: Record<string, FieldValue>) => void,
): HTMLElement {
    const box = h("div", { class: "fields" });
    for (const f of schema) {
        const label = f.name.replace(/_/g, " ");
        box.append(
            row(
                label,
                fieldControl(f, values[f.name] ?? f.default, (v) =>
                    commit({ ...values, [f.name]: v }),
                ),
            ),
        );
    }
    return box;
}

// Settings of an image or video zone (fit, alignment; for a video autoplay,
// loop, sound, controls, trim and poster), written back as its Image(...) /
// Video(...) call in deck.py.
const MEDIA_LABELS: Record<string, string> = {
    fit: "Fit",
    align: "Anchor",
    controls: "Controls",
    autoplay: "Autoplay",
    muted: "Mute",
    loop: "Loop",
    poster: "Poster",
    start: "Trim start",
    end: "Trim end",
};

function mediaSection(
    slide: SlideModel,
    zone: string,
    media: ZoneValue,
): HTMLElement {
    const kind = media.kind === "video" ? "video" : "image";
    const schema = ed.model?.mediaTypes?.[kind] ?? [];
    const values = media.fields ?? {};
    const commit = (name: string, v: FieldValue) =>
        void edit({
            action: "media-props",
            slide: slide.deckIndex,
            zone,
            fields: { [name]: v },
        });
    const rows: Node[] = [];
    for (const f of schema) {
        const label = MEDIA_LABELS[f.name] ?? f.name.replace(/_/g, " ");
        if (f.name === "poster") {
            const poster = values.poster;
            // A <div>, not row()'s <label>: a label would forward clicks on
            // its text to the first button.
            rows.push(
                h(
                    "div",
                    { class: "prop-row" },
                    h("span", { class: "prop-label" }, label),
                    h(
                        "span",
                        { class: "media-poster" },
                        poster ? String(poster).split("/").pop() : "None",
                    ),
                    button(
                        poster ? "Change…" : "Pick…",
                        poster
                            ? `Poster: ${poster}`
                            : "Still image shown before playback",
                        async () => {
                            const file = await pickFile("image/*");
                            const up = file ? await upload(file) : null;
                            if (up) commit("poster", up.path);
                        },
                    ),
                    poster
                        ? button("✕", "Remove the poster", () =>
                              commit("poster", null),
                          )
                        : null,
                ),
            );
            continue;
        }
        if (f.name === "muted") {
            // Muted.AUTO mutes exactly when the video autoplays.
            const opts = [
                { value: "auto", label: "When autoplaying" },
                { value: "on", label: "Always" },
                { value: "off", label: "Never" },
            ];
            rows.push(
                row(
                    label,
                    selectInput(opts, String(values.muted ?? "auto"), (v) =>
                        commit("muted", v),
                    ),
                ),
            );
            continue;
        }
        if (f.name === "start" || f.name === "end") {
            const v = values[f.name];
            rows.push(
                row(
                    label,
                    numberInput(
                        typeof v === "number" ? v : null,
                        (n) => commit(f.name, n),
                        {
                            step: 0.1,
                            min: 0,
                            placeholder: "seconds",
                            onClear: () => commit(f.name, null),
                        },
                    ),
                ),
            );
            continue;
        }
        rows.push(
            row(
                label,
                fieldControl(f, values[f.name] ?? f.default, (v) =>
                    commit(f.name, v),
                ),
            ),
        );
    }
    if (kind === "video") {
        rows.push(
            h(
                "p",
                { class: "hint" },
                "To start it on a click instead, add a Play video animation below.",
            ),
        );
    }
    return section(kind === "video" ? "Video" : "Image", ...rows);
}

function typeInfo(list: TypeInfo[], type: string): TypeInfo | null {
    return list.find((t) => t.type === type) ?? null;
}

// ── Slide panel ──

function renderSlidePanel(): void {
    const slide = currentSlide();
    const model = ed.model;
    if (!slide || !model) return;
    const editable = model.deckEditable;
    const di = slide.deckIndex;
    const root = slideRoot();
    const parent = root?.getAttribute("inkflow:parent") ?? null;
    const currentLayout = slide.srcShared
        ? slide.src.replace(/\.svg$/, "")
        : parent;
    panel.append(
        section(
            "Slide",
            row(
                "Title",
                textInput(slide.title ?? "", (v) => {
                    void edit({
                        action: "slide",
                        op: "title",
                        slide: di,
                        title: v,
                    });
                }),
            ),
            row(
                "Layout",
                button(
                    `${currentLayout ? layoutLabel(currentLayout) : "None"} ▾`,
                    "Pick a layout from previews",
                    () =>
                        void openGallery({
                            mode: "change",
                            current: currentLayout,
                        }),
                    "wide",
                ),
            ),
            row(
                "Font size",
                numberInput(
                    slide.fontSize,
                    (v) =>
                        void edit({
                            action: "slide",
                            op: "font-size",
                            slide: di,
                            size: v,
                        }),
                    { placeholder: "deck default" },
                ),
            ),
            row(
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
                            hidden: cb.checked,
                        });
                    });
                    return cb;
                })(),
            ),
            !editable &&
                h(
                    "p",
                    { class: "hint" },
                    "deck.py builds its slide list in code, so slide-level settings are read-only here.",
                ),
        ),
    );

    panel.append(transitionSection(slide.transition, di));
    panel.append(animationList(slide.animations, slide.animationsEditable, di));

    const files = h("div", { class: "files" });
    const addFile = (label: string, rel: string | null | undefined) => {
        if (rel)
            files.append(
                h(
                    "div",
                    { class: "file" },
                    h("span", {}, label),
                    h("code", {}, rel),
                ),
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
                "This slide is drawn by a shared layout. Draw on it (or insert anything) and it gets its own SVG built on that layout. Use “Edit layout” to change the layout itself.",
            ),
        );
    }
}

function transitionSection(
    current: TransitionInfo | null,
    di: number,
): HTMLElement {
    const model = ed.model!;
    const types = model.transitionTypes;
    const value = current?.type ?? "";
    const opts = [
        { value: "", label: `Deck default (${model.defaultTransition.type})` },
        ...types.map((t) => ({ value: t.type, label: t.type })),
    ];
    const send = (
        spec: { type: string; fields: Record<string, FieldValue> } | null,
    ) => void edit({ action: "slide", op: "transition", slide: di, spec });
    const body: Node[] = [
        row(
            "Type",
            selectInput(opts, value, (v) => {
                if (!v) send(null);
                else send({ type: v, fields: {} });
            }),
        ),
    ];
    if (current) {
        const info = typeInfo(types, current.type);
        if (info) {
            body.push(
                fieldsEditor(info.fields, current.fields, (fields) =>
                    send({ type: current.type, fields }),
                ),
            );
        }
    }
    return section("Transition into this slide", ...body);
}

// ── Animations ──

function triggerLabel(t: FieldValue): string {
    if (t === "with-previous") return "with previous";
    if (t === "after-previous") return "after previous";
    if (t === "on-click" || t == null) return "on click";
    return `step ${t}`;
}

function animationList(
    cues: CueInfo[],
    editable: boolean,
    di: number,
): HTMLElement {
    const list = h("div", { class: "anim-list" });
    if (!cues.length)
        list.append(h("p", { class: "hint" }, "No animations on this slide."));
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
                    onclick: () => selectById(cue.element),
                },
                `#${cue.element}`,
            ),
            h("span", { class: "anim-type" }, cue.type),
            h(
                "span",
                { class: "anim-trigger" },
                triggerLabel(cue.fields.trigger ?? null),
            ),
            editable &&
                button(icon("up", 12), "Earlier", () => {
                    if (i > 0)
                        void edit({
                            action: "anim",
                            slide: di,
                            op: "move",
                            index: i,
                            to: i - 1,
                        });
                }),
            editable &&
                button(icon("down", 12), "Later", () => {
                    if (i < cues.length - 1) {
                        void edit({
                            action: "anim",
                            slide: di,
                            op: "move",
                            index: i,
                            to: i + 1,
                        });
                    }
                }),
            editable &&
                button(icon("trash", 12), "Remove", () => {
                    void edit({
                        action: "anim",
                        slide: di,
                        op: "remove",
                        index: i,
                    });
                }),
        );
        list.append(item);
    });
    if (!editable && cues.length) {
        list.append(
            h(
                "p",
                { class: "hint" },
                "Animations are built in code in deck.py; read-only.",
            ),
        );
    }
    return section("Animation order", list);
}

function selectById(id: string): void {
    const svg = slideRoot();
    const el = svg?.querySelector(`[id="${CSS.escape(id)}"]`);
    if (el) {
        enterGroup(null);
        select([el as SVGGraphicsElement]);
    } else toast(`#${id} is not on this slide`, "error");
}

function elementAnimations(sel: Selected): HTMLElement {
    const slide = currentSlide()!;
    const model = ed.model!;
    const id = sel.el.getAttribute("id");
    const di = slide.deckIndex;
    const editable = slide.animationsEditable && model.deckEditable;
    const body = h("div", { class: "anim-list" });
    const elementName = isZone(sel.el) ? zoneName(sel.el) : id;
    slide.animations.forEach((cue, index) => {
        if (
            !elementName ||
            cue.element !== (cue.kind === "video" ? zoneName(sel.el) : id)
        )
            return;
        const info = typeInfo(model.animationTypes, cue.type);
        const send = (type: string, fields: Record<string, FieldValue>) =>
            void edit({
                action: "anim",
                slide: di,
                op: "replace",
                index,
                spec: { type, element: cue.element, fields },
            });
        const header = h(
            "div",
            { class: "anim-head" },
            h("span", { class: `anim-kind k-${cue.kind}` }),
            editable
                ? selectInput(
                      model.animationTypes.map((t) => ({
                          value: t.type,
                          label: t.type,
                      })),
                      cue.type,
                      (v) =>
                          send(v, {
                              trigger: cue.fields.trigger ?? "on-click",
                          }),
                  )
                : h("span", {}, cue.type),
            editable &&
                button(icon("trash", 12), "Remove", () => {
                    void edit({
                        action: "anim",
                        slide: di,
                        op: "remove",
                        index,
                    });
                }),
        );
        body.append(
            h(
                "div",
                { class: "anim-card" },
                header,
                info && editable
                    ? fieldsEditor(info.fields, cue.fields, (f) =>
                          send(cue.type, f),
                      )
                    : null,
            ),
        );
    });
    if (editable) {
        const groups: Record<string, TypeInfo[]> = {};
        for (const t of model.animationTypes) {
            if (t.kind === "video" && !isZone(sel.el)) continue;
            const kind = t.kind ?? "other";
            groups[kind] = [...(groups[kind] ?? []), t];
        }
        const add = h("select", { class: "add-anim" });
        add.append(h("option", { value: "" }, "+ Add animation…"));
        for (const [kind, types] of Object.entries(groups)) {
            const og = h("optgroup", { label: kind });
            for (const t of types)
                og.append(h("option", { value: t.type }, t.type));
            add.append(og);
        }
        add.addEventListener("change", () => {
            const type = add.value;
            if (!type) return;
            const video =
                typeInfo(model.animationTypes, type)?.kind === "video";
            const element = video ? zoneName(sel.el) : id;
            const src = sourceOf(sel.key);
            void edit({
                action: "anim",
                slide: di,
                op: "insert",
                index: slide.animations.length,
                spec: { type, element: element ?? "", fields: {} },
                target:
                    element || !src
                        ? undefined
                        : {
                              file: src.path,
                              loc: sel.loc,
                              base: sel.el.localName,
                          },
            });
        });
        body.append(add);
    } else if (!slide.animationsEditable) {
        body.append(
            h(
                "p",
                { class: "hint" },
                "This slide's animations are built in code.",
            ),
        );
    }
    return section("Animations", body);
}

// ── Object panel ──

const TAG_NAMES: Record<string, string> = {
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
    foreignObject: "Embedded content",
};

function tokenOf(el: Element, prop: "fill" | "stroke"): string | null {
    for (const c of el.classList) {
        const m = c.match(/^inkflow-(fill|stroke)-(.+)$/);
        if (m && m[1] === prop) return m[2];
    }
    return null;
}

function rgbToHex(rgb: string): string {
    const m = rgb.match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return "#000000";
    return `#${m
        .slice(0, 3)
        .map((v) => Math.round(Number(v)).toString(16).padStart(2, "0"))
        .join("")}`;
}

function paintRow(sel: Selected[], prop: "fill" | "stroke"): HTMLElement {
    const first = sel[0].el;
    const token = tokenOf(first, prop);
    const computed = getComputedStyle(first)[prop];
    const send = (paint: { token?: string; color?: string }) => {
        const plans = sel.map((s) => ({
            sel: s,
            ops: [{ kind: "paint", loc: s.loc, prop, ...paint } as SvgOp],
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
                onclick: () => send({ token: t }),
            }),
        );
    }
    const custom = h("input", {
        type: "color",
        value: computed && computed !== "none" ? rgbToHex(computed) : "#000000",
        title: "Custom colour",
    });
    custom.addEventListener("change", () => send({ color: custom.value }));
    swatches.append(custom);
    swatches.append(
        button("∅", "None", () => send({ color: "none" }), "none-btn"),
    );
    return row(prop === "fill" ? "Fill" : "Stroke", swatches);
}

function styleOps(
    sel: Selected[],
    set: Record<string, string | null>,
    label: string,
) {
    void sendSvgOps(
        sel.map((s) => ({ sel: s, ops: [{ kind: "style", loc: s.loc, set }] })),
        label,
    );
}

function renderObjectPanel(sel: Selected): void {
    const el = sel.el;
    const src = sourceOf(sel.key);
    const zone = isZone(el);
    const movable = canTransform(el);
    const id = el.getAttribute("id") ?? "";
    const tag = zone
        ? `Zone · ${zoneName(el)}`
        : (TAG_NAMES[el.localName] ?? el.localName);
    panel.append(
        section(
            tag,
            row(
                "Id",
                zone
                    ? h("code", {}, id)
                    : textInput(
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
                                          from: id,
                                      },
                                  ],
                                  label: "Rename",
                              });
                          },
                          "no id",
                      ),
            ),
            src &&
                h(
                    "p",
                    { class: "hint" },
                    `In ${src.rel}${src.role !== "slide" || currentSlide()?.srcShared ? ` · shared by ${src.usedBy.length} slide${src.usedBy.length === 1 ? "" : "s"}` : ""}`,
                ),
        ),
    );

    if (zone) {
        const slide = currentSlide()!;
        const name = zoneName(el);
        const origin = slide.zoneOrigins?.[name];
        const media = slide.zones[name];
        const where =
            origin === "deck"
                ? "deck.py zones="
                : origin === "md-file"
                  ? `${slide.md?.rel ?? "Markdown"} (whole file)`
                  : slide.md?.rel
                    ? `${slide.md.rel} · ::${name}::`
                    : "deck.py";
        const body: Node[] = [
            h("p", { class: "hint" }, `Content from ${where}`),
        ];
        if (media && (media.kind === "image" || media.kind === "video")) {
            body.push(
                h("p", { class: "hint media-src" }, media.src ?? ""),
                button(
                    "Replace media…",
                    "Pick another image or video",
                    () => void zoneMedia(name),
                ),
                button("Clear", "Empty this zone", () => {
                    void edit({
                        action: "zone-media",
                        slide: slide.deckIndex,
                        zone: name,
                        src: null,
                    });
                }),
            );
        } else {
            body.push(
                button(
                    "Edit text",
                    "Edit this zone's Markdown (double-click)",
                    () => {
                        emit("edit-zone");
                    },
                ),
            );
        }
        panel.append(section("Content", ...body));
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
            "g",
        ].includes(el.localName);
        const strokeWidth = parseFloat(getComputedStyle(el).strokeWidth) || 0;
        const opacity = parseFloat(getComputedStyle(el).opacity);
        panel.append(
            section(
                "Style",
                fills && !pictureOf(el) && paintRow([sel], "fill"),
                !pictureOf(el) &&
                    el.localName !== "g" &&
                    paintRow([sel], "stroke"),
                !pictureOf(el) &&
                    el.localName !== "g" &&
                    row(
                        "Stroke width",
                        numberInput(strokeWidth, (v) =>
                            styleOps(
                                [sel],
                                { "stroke-width": String(v) },
                                "Stroke width",
                            ),
                        ),
                    ),
                row(
                    "Opacity",
                    (() => {
                        const r = h("input", {
                            type: "range",
                            min: 0,
                            max: 1,
                            step: 0.05,
                            value: String(
                                Number.isFinite(opacity) ? opacity : 1,
                            ),
                        });
                        r.addEventListener("change", () =>
                            styleOps(
                                [sel],
                                { opacity: r.value === "1" ? null : r.value },
                                "Opacity",
                            ),
                        );
                        return r;
                    })(),
                ),
                el.localName === "rect" &&
                    row(
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
                                                        ry: null,
                                                    },
                                                },
                                            ],
                                        },
                                    ],
                                    "Corner radius",
                                );
                            },
                        ),
                    ),
            ),
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

// ── Pictures (free images on the slide) ──

const FITS: { value: string; label: string; par: string }[] = [
    { value: "contain", label: "Fit inside", par: "xMidYMid meet" },
    { value: "cover", label: "Fill (crop edges)", par: "xMidYMid slice" },
    { value: "stretch", label: "Stretch", par: "none" },
];

function pictureSection(sel: Selected): HTMLElement {
    const image = pictureOf(sel.el)!;
    const loc = image.getAttribute("data-ink") ?? sel.loc;
    const src = sourceOf(sel.key);
    const href =
        image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "";
    const par = image.getAttribute("preserveAspectRatio") ?? "xMidYMid meet";
    const fit = FITS.find((f) => f.par === par)?.value ?? "contain";
    const imageOps = (set: Record<string, string | null>, label: string) =>
        void sendSvgOps([{ sel, ops: [{ kind: "attrs", loc, set }] }], label);
    const cropped = isCropped(sel.el);
    return section(
        "Picture",
        h("p", { class: "hint media-src" }, href.split("/").pop() ?? href),
        h(
            "div",
            { class: "btn-row" },
            button(
                "Replace…",
                "Pick another picture; it keeps this size and place",
                async () => {
                    const file = await pickFile("image/*");
                    const up = file && src ? await upload(file) : null;
                    if (!up || !src) return;
                    imageOps(
                        {
                            href: relativePath(src.path, up.path),
                            "xlink:href": null,
                        },
                        "Replace picture",
                    );
                },
            ),
            ed.cropMode
                ? button(
                      "Done cropping",
                      "Enter",
                      () => setCropMode(false),
                      "on",
                  )
                : button(
                      "Crop",
                      "Crop (double-click the picture)",
                      () => void startCrop(sel),
                  ),
            cropped
                ? button(
                      "Reset crop",
                      "Show the whole picture again",
                      () => void resetCrop(sel),
                  )
                : null,
        ),
        row(
            "Fit",
            selectInput(
                FITS.map((f) => ({ value: f.value, label: f.label })),
                fit,
                (v) =>
                    imageOps(
                        {
                            preserveAspectRatio:
                                FITS.find((f) => f.value === v)?.par ?? null,
                        },
                        "Picture fit",
                    ),
            ),
        ),
    );
}

// The object's link, as the editor writes it (an <a> around the object), and
// as the pipeline renders a slide link (data-inkflow-slide, no href).
function linkOf(el: Element): string {
    const a = el.parentElement;
    if (a?.localName !== "a") return "";
    const slide = a.getAttribute("data-inkflow-slide");
    if (slide) return `slide:${slide}`;
    return a.getAttribute("href") ?? a.getAttribute("xlink:href") ?? "";
}

// A bare number is a slide number (as shown in the slide list).
function slideLinkByNumber(n: number): string | null {
    const s = ed.model?.slides[n - 1];
    return s?.id ? `slide:${s.id}` : null;
}

function slideOptions(): HTMLDataListElement {
    const list = h("datalist", { id: "slide-link-list" });
    for (const s of ed.model?.slides ?? []) {
        if (!s.id) continue;
        list.append(h("option", { value: `slide:${s.id}` }, s.title ?? s.id));
    }
    return list;
}

// Link and alt text. Alt text is the object's <title>, which screen readers
// read and browsers show as a tooltip.
function detailsSection(sel: Selected): HTMLElement {
    const title =
        [...sel.el.children].find((c) => c.localName === "title")
            ?.textContent ?? "";
    const link = textInput(
        linkOf(sel.el),
        (v) =>
            void sendSvgOps(
                [
                    {
                        sel,
                        ops: [
                            {
                                kind: "link",
                                loc: sel.loc,
                                href: /^\d+$/.test(v.trim())
                                    ? slideLinkByNumber(Number(v))
                                    : v.trim() || null,
                            },
                        ],
                    },
                ],
                v.trim() ? "Link" : "Remove link",
            ),
        "https://… or slide:id",
    );
    link.setAttribute("list", "slide-link-list");
    return section(
        "Link & alt text",
        slideOptions(),
        row("Link", link),
        row(
            "Alt text",
            textInput(
                title,
                (v) =>
                    void sendSvgOps(
                        [
                            {
                                sel,
                                ops: [{ kind: "title", loc: sel.loc, text: v }],
                            },
                        ],
                        "Alt text",
                    ),
                "Describe it for screen readers",
            ),
        ),
    );
}

function textSection(sel: Selected): HTMLElement {
    const el = sel.el;
    const cs = getComputedStyle(el);
    const spans = [...el.querySelectorAll("tspan")];
    const setAll = (set: Record<string, string | null>, label: string) => {
        const plans = [
            { sel, ops: [{ kind: "style", loc: sel.loc, set } as SvgOp] },
        ];
        // Inkscape often repeats font properties on each line's tspan.
        for (const t of spans) {
            const loc = t.getAttribute("data-ink");
            const style = t.getAttribute("style") ?? "";
            const touched = Object.keys(set).some(
                (k) => style.includes(`${k}:`) || t.hasAttribute(k),
            );
            if (loc && touched) {
                plans[0].ops.push({ kind: "style", loc, set });
            }
        }
        void sendSvgOps(plans, label);
    };
    const bold = parseInt(cs.fontWeight, 10) >= 600;
    const italic = cs.fontStyle === "italic";
    const anchor = cs.textAnchor;
    return section(
        "Text",
        row(
            "Size",
            numberInput(parseFloat(cs.fontSize), (v) =>
                setAll({ "font-size": `${v}px` }, "Font size"),
            ),
        ),
        row(
            "Font",
            textInput(
                cs.fontFamily,
                (v) => setAll({ "font-family": v || null }, "Font"),
                "font-family",
            ),
        ),
        h(
            "div",
            { class: "btn-row" },
            button(
                h("b", {}, "B"),
                "Bold",
                () => setAll({ "font-weight": bold ? null : "bold" }, "Bold"),
                bold ? "on" : "",
            ),
            button(
                h("i", {}, "I"),
                "Italic",
                () =>
                    setAll(
                        { "font-style": italic ? null : "italic" },
                        "Italic",
                    ),
                italic ? "on" : "",
            ),
            button(
                "⟸",
                "Align start",
                () => setAll({ "text-anchor": null }, "Align"),
                anchor === "start" ? "on" : "",
            ),
            button(
                "⇔",
                "Align middle",
                () => setAll({ "text-anchor": "middle" }, "Align"),
                anchor === "middle" ? "on" : "",
            ),
            button(
                "⟹",
                "Align end",
                () => setAll({ "text-anchor": "end" }, "Align"),
                anchor === "end" ? "on" : "",
            ),
            button("Edit", "Edit text (double-click)", () => emit("edit-text")),
        ),
    );
}

function geometrySection(sels: Selected[]): HTMLElement {
    const box = sels.length === 1 ? slideBox(sels[0].el) : selectionBox();
    if (!box) return h("div");
    const resizeTo = (to: Box) => {
        const plans = sels.map((s) => {
            const b = slideBox(s.el)!;
            const sx = box.width ? to.width / box.width : 1;
            const sy = box.height ? to.height / box.height : 1;
            const target = {
                x: to.x + (b.x - box.x) * sx,
                y: to.y + (b.y - box.y) * sy,
                width: b.width * sx,
                height: b.height * sy,
            };
            const plan = planResize(elementGeom(s.el), b, target);
            return {
                sel: s,
                ops: [{ kind: "attrs", loc: s.loc, set: plan } as SvgOp],
            };
        });
        void sendSvgOps(plans, "Resize");
    };
    const rot =
        sels.length === 1
            ? rotationOf(parseTransform(sels[0].el.getAttribute("transform")))
            : 0;
    return section(
        "Position & size",
        h(
            "div",
            { class: "grid2" },
            row(
                "X",
                numberInput(box.x, (v) => resizeTo({ ...box, x: v })),
            ),
            row(
                "Y",
                numberInput(box.y, (v) => resizeTo({ ...box, y: v })),
            ),
            row(
                "W",
                numberInput(
                    box.width,
                    (v) => resizeTo({ ...box, width: Math.max(1, v) }),
                    { min: 1 },
                ),
            ),
            row(
                "H",
                numberInput(
                    box.height,
                    (v) => resizeTo({ ...box, height: Math.max(1, v) }),
                    { min: 1 },
                ),
            ),
        ),
        sels.length === 1 &&
            row(
                "Rotation",
                numberInput(
                    rot,
                    (v) => {
                        const s = sels[0];
                        const center = {
                            x: box.x + box.width / 2,
                            y: box.y + box.height / 2,
                        };
                        const plan = planRotate(
                            elementGeom(s.el),
                            v - rot,
                            center,
                        );
                        void sendSvgOps(
                            [
                                {
                                    sel: s,
                                    ops: [
                                        {
                                            kind: "attrs",
                                            loc: s.loc,
                                            set: plan,
                                        },
                                    ],
                                },
                            ],
                            "Rotate",
                        );
                    },
                    { step: 1 },
                ),
            ),
    );
}

function arrangeSection(sels: Selected[]): HTMLElement {
    const order = (to: string) =>
        void sendSvgOps(
            sels.map((s) => ({
                sel: s,
                ops: [{ kind: "order", loc: s.loc, to }],
            })),
            "Arrange",
        );
    const isGroup = sels.length === 1 && sels[0].el.localName === "g";
    return section(
        "Arrange",
        h(
            "div",
            { class: "btn-row" },
            button("⇈", "Bring to front (Ctrl+Shift+↑)", () => order("front")),
            button("↑", "Bring forward (Ctrl+↑)", () => order("forward")),
            button("↓", "Send backward (Ctrl+↓)", () => order("backward")),
            button("⇊", "Send to back (Ctrl+Shift+↓)", () => order("back")),
            button(icon("copy", 14), "Duplicate (Ctrl+D)", () =>
                emit("duplicate"),
            ),
            sels.length > 1 &&
                button(icon("group", 14), "Group (Ctrl+G)", () =>
                    emit("group"),
                ),
            isGroup &&
                button("Ungroup", "Ungroup (Ctrl+Shift+G)", () =>
                    emit("ungroup"),
                ),
            button(
                icon("trash", 14),
                "Delete (Del)",
                () => emit("delete"),
                "danger",
            ),
        ),
    );
}

// ── Several objects ──

export function alignSelection(how: string): void {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (!sels.length) return;
    const boxes = sels.map((s) => slideBox(s.el)!);
    const ref = sels.length === 1 ? slideSize() : selectionBox()!;
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
        ops: moveOps(s, targetsX[i] - boxes[i].x, targetsY[i] - boxes[i].y),
    }));
    void sendSvgOps(plans, "Align");
}

function renderMultiPanel(): void {
    const sels = ed.selection;
    const movable = sels.every((s) => canTransform(s.el));
    panel.append(section(`${sels.length} objects`));
    if (movable) {
        const a = (label: string, title: string, how: string) =>
            button(label, title, () => alignSelection(how));
        panel.append(
            section(
                "Align",
                h(
                    "div",
                    { class: "btn-row" },
                    a("⇤", "Align left", "left"),
                    a("↔", "Align centre", "center"),
                    a("⇥", "Align right", "right"),
                    a("⤒", "Align top", "top"),
                    a("↕", "Align middle", "middle"),
                    a("⤓", "Align bottom", "bottom"),
                ),
                h(
                    "div",
                    { class: "btn-row" },
                    a("⇹ Distribute", "Distribute horizontally", "hspace"),
                    a("⇳ Distribute", "Distribute vertically", "vspace"),
                ),
            ),
        );
        panel.append(geometrySection(sels));
        const styleable = sels.filter(
            (s) => !isZone(s.el) && s.el.localName !== "image",
        );
        if (styleable.length === sels.length) {
            panel.append(
                section(
                    "Style",
                    paintRow(sels, "fill"),
                    paintRow(sels, "stroke"),
                ),
            );
        }
        panel.append(arrangeSection(sels));
    }
}

// ── Wiring ──

export function renderProps(): void {
    if (document.activeElement && panel.contains(document.activeElement)) {
        // Do not yank the control being typed in; refresh once it loses focus.
        refreshOnBlur = true;
        return;
    }
    clear(panel);
    if (!ed.model) return;
    if (ed.selection.length === 0) renderSlidePanel();
    else if (ed.selection.length === 1) renderObjectPanel(ed.selection[0]);
    else renderMultiPanel();
}

let refreshOnBlur = false;

export function initProps(): void {
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
