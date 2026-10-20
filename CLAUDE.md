# Inkflow — codebase guide

This repository holds two packages, developed side by side as a uv workspace:

- **inkflow** (`src/inkflow`, `src/ts`, `src/css`, `tests/`): the core. It reads
  a deck, builds it, presents it, exports and checks it, and serves it with
  live reload. It knows nothing of any editor: it offers plugins
  (`plugins.py`) and server extensions (`extensions.py`) for frontends to
  build on, and the TypeScript client library they share (`src/ts/shared`,
  imported as `@inkflow/shared/*`).
- **inkflow-editor** (`inkflow-editor/`, package `inkflow_editor`): the visual
  editor, its editing session and the commands an agent uses, as a plugin of
  the core. It has its own guide: `inkflow-editor/CLAUDE.md`.

The core must never import `inkflow_editor`: `mise run test-core` runs the
core's tests where it is not installed at all. A change the editor needs from
the core is a hook any frontend could use (a plugin or extension hook, a
`ServerContext` capability, a `@inkflow/shared` module), never an editor
special case. See "Frontends are plugins; the core never knows them" below.

## Running

```bash
uv run inkflow serve --deck demo/deck.py   # start server at localhost:7777
uv run inkflow edit --deck demo/deck.py    # (inkflow-editor) the same server with the editor at /edit
uv run inkflow serve --deck demo/deck.py --share   # also on the LAN: view (and editor) links
mise run check                      # lint + format + typecheck + test (Python and JS, both packages)
mise run test-core                  # the core's tests with no plugin installed
mise run bundle                     # rebuild the JS/CSS bundles of both packages
```

## Git setup (one-time, per clone)

```bash
uv run inkflow setup-git
```

Configures two things:
- **Pre-commit hook** (`.githooks/pre-commit`) — strips Inkscape editor metadata from staged SVGs before every commit, so viewport pan/zoom/window state never lands in history
- **SVG diff driver** — `git diff`, `git log -p`, and GitHub's diff view show only visual changes even for SVGs that haven't been cleaned in-place

Git won't run this automatically on clone — that's an intentional git security boundary — so it needs to be run once. After that it's invisible. (`inkflow init` already does this for a freshly created project via `git_setup.init_project_git`; `setup-git` is the manual path for existing clones and teammates.)

SVG source files should be kept clean (no Inkscape metadata) in the repository. Run `uv run inkflow clean demo/slides/*.svg` to clean any files committed before the hook was in place.

## Project layout

```
src/
  inkflow/
    __init__.py       exports: Deck, Slide, Image, Video, Media, TextBox,
                               Cue, Transition, Align, VAlign, Direction, Easing,
                               AnimationKind, Trigger, Inline, Content, ZoneContent,
                               ColorMode, MediaFit,
                               MediaAlign, Muted, Overlay, Chart, ChartKind, PageSize, Section,
                               Palette, Theme, Typography, the shipped themes Paper + Stage,
                               and the `animations` and `transitions` namespaces
                               (`Animation` is NOT top-level — it lives in `animations`)
    manifest.py       dataclasses for the deck DSL; Cue/Transition base.
                               `Cue` (element, trigger) is the timeline base for `Animation`
                               (in animations.py) and `PlayVideo`; `Slide.animations`
                               is `list[Cue]`. Media is a `_MediaBase` shared by Image +
                               Video; `Media` is the `Image | Video` union alias (not
                               callable). Video adds playback fields (controls, autoplay,
                               muted, loop, poster, start, end). `Chart` is the third zone
                               value kind (data file `src` or inline `data`, kind, x, y…).
                               `Slugged` mixin (kebab slug from class name) is shared by
                               Animation + Transition
                               Deck params: slides, transition, overlays, theme,
                               mode: ColorMode, style, font_size, embed_fonts,
                               size (a PageSize; None = each slide its own, new
                               slides 16:9). `effective_size`, `is_print`; a print
                               deck defaults to light mode (unless the theme set a
                               mode) and `effective_font_size` = `base_font`.
                               `Section(name, slides=[...])` entries in `slides=`
                               (after the unsectioned leading slides) are flattened
                               by the `_SlideList` data descriptor: `deck.slides`
                               stays `list[Slide]` everywhere, `deck.sections` /
                               `section_ranges()` / `section_of(i)` record the groups
                               Slide params: src, id, md, zones, animations, transition,
                               overlays, extra_style, title, notes, visible, font_size, ink
    sizes.py          `PageSize`: a str value object naming a deck size ("16:9", "4:3",
                               "9:16"/phone, "a0".."a5" [-landscape], letter/legal/
                               tabloid, WxH mm/cm/in/pt or px; constructors .mm/.cm/
                               .inches/.px) with `canvas` (user units), `page_pt`/
                               `page_css` (the printed page), `is_print`, `base_font`
                               (screens: theme size x short/1080; paper:
                               `print_body_pt` = short side / 80, >= 10 pt) and
                               `chart_text_scale` (0.6 screen, 1.0 paper). Screens
                               keep 1080 units on the short side; the A sizes share
                               A0's canvas (3179x4494 at 1 unit = 1 CSS px) so a
                               poster prints at any A size; other sheets are 1 unit
                               = 1 CSS px. `same_aspect` (1%), `parse_view_box`,
                               `physical_length_pt` (an SVG root's 841mm)
    enums.py          shared enums (Direction, Align, VAlign, MediaFit, MediaAlign,
                               ColorMode, Muted, Trigger, AnimationKind, ChartKind);
                               `_KebabStrEnum`
                               base emits CSS token values (Muted is a plain Enum, resolved
                               in Python). `AnimationKind` (enter/exit/emphasis) is the
                               animation lifecycle role.
                               `Easing`/`Trigger` are str value objects with named presets
                               plus a constructor (`Easing.cubic_bezier(...)`, `Trigger.at(n)`)
    animations.py     the `Animation` base (moved here from manifest) + the semantic bases
                               `Enter`/`Exit`/`Emphasis` (they fix `kind`), the concrete types
                               (FadeIn, FadeOut, Bounce, SlideIn/Out, ScaleIn/Out, Highlight)
                               subclassing those, plus `PlayVideo` (subclasses `Cue`
                               directly, no timing) — starts a `Video` on a step, not on load
    transitions.py    concrete transition types (Cut, Crossfade, Morph, Push, Cover,
                               Zoom, Fade, Wipe) subclassing manifest.Transition
    pipeline.py       animation annotation + layout inlining; `process_slide(keep_zones=)`
                               keeps unfilled zones as dashed boxes (the slide master);
                               `pop_hints` takes `<inkflow:hint>` out, into `EmptyZone.hint`
                               (the nearest layout's wins); `EmptyZone`s are
                               `content.empty_zone_shapes`: the pruned zones plus
                               unfilled `inkflow:show-shape` ones, which stay drawn;
                               `build_slide` (one slide from its files) and
                               `slide_notes` (its notes file as HTML) are what
                               `process_deck` runs per slide, or asks its `cache`
                               for (a `SlideStore`: incremental.py)
    deps.py           which files a piece of the build read: `note(path)` at every
                               read or lookup of the slide pipeline (svgio, layout,
                               loaders, charts, pdf, ink, the model), collected by
                               `recording()` as path -> `Stamp` (mtime, ctime, size,
                               inode; None = not there; a file changed within
                               `RACY_NS`, or `COARSE_NS` on a whole-second file
                               system, is never trusted), `Stamps` (one stat per file
                               per build), `note_code` (a class looked up by name:
                               deck.py) / `note_class` (its module's file), `retry`
                               (a failure that may pass: built again next time)
    incremental.py    a served deck's builds, slide by slide (see "A served deck
                               rebuilds what a change touched" below): `SlideCache`
                               / `Build` (`slide`, `notes`, `finish`), `frozen`
                               (deck values compared by value and type), the
                               stand-in slide number and count (`_Template`,
                               `_plain`), warnings said again for kept slides; and
                               what the pages are sent: `set_keys` (each slide's and
                               model entry's content digest), `keys_of`, `as_patch`
    content.py        TextBox / Image / Video / chart injection into zone rects, with
                               alignment support; Video emits data-* playback attrs (driven
                               by video.ts); a chart is a nested <svg> in the zone's box
    charts.py         charts from data: `Table` read from CSV/TSV/JSON/a Markdown table
                               (`read_table`, cell text kept as typed by `read_text_rows` /
                               `serialize_rows`), `resolve` (a Chart's data, its path against
                               the file it is written in), `render` (bar/line/area/scatter/
                               pie SVG in theme tokens, `nice_ticks`), and the ```chart
                               fence (`parse_fence`, `expand_fences` over markdown.py's
                               placeholder)
    layout.py         parent inject/set/strip: layout chain resolution and Inkscape layer
                               writing. `AssetKind` (layouts/overlays) selects the searched
                               subdir, so `resolve_parent_path`/`resolve_chain` serve both
                               namespaces with one grammar. `inject_preview_layers` /
                               `are_preview_layers_current` take a `PreviewLayers`
                               (`behind` + `overlays` + css), each layer a
                               `PreviewLayer(path, ref)` — refs come from the caller since
                               a backdrop or an overlay is not named by an inkflow:parent.
                               Copy-on-write: `deck_copy` = the project's
                               `<kind>/<same name>.svg` carrying `inkflow:copy-of`
                               (`theme_ref`: `builtin:x`/`theme:x`) stands in for that
                               theme file wherever any reference resolves to it, the
                               theme's own `./base` chains included
                               (`resolve_parent_path(follow_copies=False)` names the
                               theme's file; `resolve_chain` falls back to it rather
                               than loop); unmarked same-named files never do.
                               `copy_of`/`label_of` read the root attributes.
                               Layer digests are canonical (c14n, whitespace-stripped), so a
                               synced ancestor does not read as stale forever.
                               The preview `<style>` also paints unstyled zone shapes as
                               dashed outlines (`zone_placeholder_css`): unfilled, Inkscape
                               would paint them black over the slide
    overlay.py        the `Overlay` DSL type (src only). Its own module because both
                               `themes` and `manifest` reference it, same as `Transition`
    markdown.py       markdown-it-py rendering only: code-fence highlighting, LaTeX math,
                               HTML->well-formed-XML normalization (inline <svg> keeps its
                               camelCase names); a ```chart fence becomes a placeholder
                               charts.py draws (no inkflow-specific grammar)
    steps.py          `StepResolver` — the trigger-resolution rule (ON_CLICK/WITH_PREVIOUS/
                               Trigger.at) shared by pipeline.py (the animations=[...] list)
                               and zones.py (markdown reveals)
    zones.py          ::zone:: / ::step:: marker grammar, zone param extraction, and slide
                               assembly (parsed markdown -> per-zone TextBox/Media);
                               marker `size=80%`/`fit=none` -> `TextBox.size`/`.fit`,
                               `set_zone_params` (a marker's params changed in place;
                               auto-extracted zones get explicit markers, an unnamed
                               zone an empty one at the end), `zone_params`
    server.py         the server `inkflow serve` runs: HTTP and the WebSocket on one
                               port (`/_inkflow/ws`), file watcher, build pipeline; the door
                               (`_share`: `Access` + `People`, `allowed(role, msg)`: the core's
                               messages, then each extension's `messages` by least role), sharing
                               on/off (`Listener.move`), `share_status` (+ each extension's
                               `share_status`/`share_op`/`share_lines`); the served deck in
                               `_served` (its extensions, last deck, `built_hash`/`failed_hash` for
                               `build-status`, said only after the extensions' `built`); `context`
                               = the `ServerContext` extensions act through (send, broadcast,
                               rebuild, `open_deck`, `shutdown`, `serve_connection`/`serve_request`
                               for connections that came another way); `extensions_for` (the
                               plugins'); `_save_ink` = the presenter's "Keep" when no extension
                               handles `edit-op` (`ink.save_ink`); `listening(ui, deck, extensions)`
                               (the one port without TUI/watcher: tests, embedding);
                               `load_deck` turns any failure in deck.py into `DeckError`
                               (`deck.py:42: NameError: …` + the line), which the CLI's
                               `_Group` prints as one error line instead of a traceback
    extensions.py     the server-extension API (see "Frontends are plugins" below):
                               `ServerExtension` (hooks: start/stop, open/close per deck,
                               before_build/build in a worker thread, built/build_failed,
                               welcome, hello/message/disconnected, http, keys, share_*;
                               `provenance` = the editor build, `messages` = type -> least role,
                               `serves_without_deck`), `ServerContext` (Protocol), `Build`
                               (deck, slides as built, `served` = the pages' copies, `fresh`),
                               `HttpRequest` (respond/send_file/refuse), `ServeConfig`, and the
                               `State`/`ResponseWriter` types the server shares
    plugins.py        plugins: the `inkflow.plugins` entry-point group; `Plugin`
                               (register_cli, slide_checks, deck_checks, server_extensions,
                               completion_spec, current_slide; all no-ops by default), `loaded()`
                               (found once; `INKFLOW_NO_PLUGINS=1` = none), `register`/`unregister`
                               (tests, embedding), `Issue`/`SlideCheck`/`DeckCheck`
    provenance.py     source locators on the composed SVG (`data-ink="<source>:<child
                               path>"`, counted on the tree as parsed from disk) and `locate`, their
                               inverse: what `process_deck(editor=True)` stamps for any frontend that
                               writes back (`INK_TOP`/`INK_LAYER`/`INK_LOCKED`/`INK_TAG`,
                               `is_element`, `is_link_wrapper`)
    workdir.py        the project's `.inkflow/` (`WORK_DIR`, `work_dir` = created
                               ignoring itself in git): caches (PDF pages) and plugins' files;
                               never watched
    catalog.py        the layouts and overlays a deck offers and which slides use
                               each (`layout_entries`: the project's copy winning, parent, `slides`
                               on it directly, `reach` through it; `background_name`;
                               `overlay_entries`; `slide_layouts`): `inkflow layouts`' counts and a
                               slide-master view's list
    access.py         who may reach a server and as whom (pure): `parse_request`,
                               `Access.host_ok` (Host: loopback names, IP literals,
                               `machine_names`, `--allow-host`; DNS rebinding),
                               `origin_ok` (a WebSocket's Origin = the page's own
                               host:port; none = a program), `is_local` (loopback peer +
                               loopback Host + no proxy headers: an SSH tunnel is
                               local, `tailscale serve` is not) = the owner, except in
                               SSH mode (`Access.ssh`: `--ssh`, default `over_ssh()` =
                               SSH_CONNECTION/SSH_CLIENT set), where the owner is a
                               local request with the `owner_token` (the printed owner
                               link `owner_path`, kept across `rotate`); `admit` (`?k=`
                               or the cookie, named `cookie_name_for(Host)`: the port
                               the browser sees, `inkflow-8000` through `ssh -L
                               8000:…:7777`, else the server's -> owner/editor/viewer
                               token, `secrets.compare_digest`), `presents_token`,
                               `rotate`, `links`, `lan_addresses`, `enter_page` (sets
                               the cookie, then moves on without the token; not a
                               redirect: SameSite=Strict), `redacted` (what logs may
                               show of a token), `ssh_server_address`
    sshshare.py       what "Share via SSH" writes commands from (`details`, the
                               `share-status`'s `sshInfo`, gathered on the dialog's
                               `status` op): server names (SSH_CONNECTION's server
                               address, fqdn, host name), login user, the deck's repo
                               via `publish.layout` (remote with web credentials
                               stripped, `clone_folder`, deck path in the repo,
                               pyproject pins inkflow -> `uv run`, else `uv tool
                               install <requirement>`)
    collab.py         the connected people (`People`, `Client`: id, role, token,
                               page's private `key`, name, colour, page, slide,
                               selection, editing); `Client.author` = whose History
                               steps ("owner" for the owner's pages and agents,
                               `guest:<key>`); `listing()` is the `presence` payload
                               (never the key or token)
    wsbridge.py       `Bridge`: a websockets `Server` without a listener; the HTTP
                               handler hands it an upgrade request it has read
                               (`adopt`), so pages, files and the WebSocket share
                               one port
    handout.py        the slides with their speaker notes: `handout_body`
                               (`.h-item`s, each svg in a `.trim` for fit.js),
                               `handout_page` (layouts notes / compact, paper a4 /
                               letter, `bar` = the view's controls); the server's
                               `/handout` (editors only: it shows the notes) and
                               `export.build_handout_pdf` (`inkflow export
                               --handout`, `Exporters.handout`)
    edit.py           launching external programs on source files: INKFLOW_EDIT_CMD*
                               resolution (extension > kind > default) for the presenter's
                               edit menu, and the editor's "Open" catalog (`open_choices`)
    export.py         static HTML export (inkflow build: one self-contained index.html by
                               default, every asset, stylesheet url() and font inlined,
                               the interface fonts subset to `_interface_text`; a
                               single file > 50 MB warns naming its largest assets;
                               `--assets-folder` = `inline_assets=False`, media copied
                               beside it) and PDF export (inkflow export);
                               `pdf_pages`: each slide's page (the --size override,
                               else the deck's size, else the slide's own: physical
                               width/height, else viewBox px), every distinct size a
                               named `@page` the slide's box selects (`page:`), so
                               mixed sizes print each on its own sheet; `--bleed`
                               (`extend_backgrounds`: canvas-covering rects/images
                               grown into it) and `--crop-marks`;
                               PDF/PNG pages reach Chromium over a loopback HTTP server
                               (`served`), never file:// (a snap/Flatpak Chromium has a
                               private /tmp), and `_run_chromium` checks the written file
                               and reports Chromium's stderr (`cdp.chromium_said`)
    pdfboxes.py       `set_page_boxes`: Chromium writes page sizes on a ~1/75 in grid, so
                               each page's MediaBox is rewritten to the exact size
                               (aligned with the content hung from the top-left),
                               plus TrimBox/BleedBox with bleed; the file is
                               re-assembled from its xref table (left alone when
                               it is not a classic-xref PDF)
    render.py         `inkflow render`: one headless Chromium for every slide (cdp.py),
                               viewport set to the slide's exact size; each slide page
                               resolves `window.inkflowRendered` to its layout findings
                               (src/ts/render/measure.ts), parsed into `Finding`s
                               (`message()`, `is_problem`: small text is a hint);
                               a printed slide (`print_checks`: a print deck, or an
                               SVG in mm without a deck size) gets `__RENDER_PRINT__`
                               (`print_check`: pt per unit, text below 0.6 of the
                               sheet's body size a hint, body text below 0.8) and
                               raster pictures checked at their printed dpi
                               (`low-res`: <150 hint, <100 problem);
                               `check_built` = the same measurements of slides
                               already built (no PNG, contrast only when asked),
                               which the editor's problem marks use;
                               `--check` = no output path; `--by-id` names the
                               images `<id>.png` (`image_name`); the contact sheet
                               (`sheet_layout`/`sheet_pages`/`sheet_html`: ≤1600 px wide,
                               ≤16 slides per image) is one more page screenshot of the
                               slide shots, each taken at its cell's size;
                               `page_template`/`slide_page` (a slide on a page of its
                               own deck, what inkflow-editor's compare sheet reuses)
                               `--boxes`: `window.inkflowBoxes()` (src/ts/render/boxes.ts)
                               read back as `SlideBoxes` of `ElementBox` (every element
                               with an id, zones with content extent + `free` height,
                               `zone-x/N` text blocks with their text's extent), no PNG
                               unless `-o`; `render_json` is `--json`
                               contrast (default on, `--no-contrast`): `_contrast` shoots
                               the slide as shown and after `window.inkflowHideText()`
                               (fast PNGs, `Page.screenshot_base64`), and
                               `window.inkflowContrast(shown, hidden)` returns `contrast`
                               findings (`ratio`/`needs`/`color`/`background`; below 3:1
                               a problem, 3–4.5:1 for small text a hint)
    cdp.py            minimal DevTools client over `websockets`: `Browser.launch`
                               (--remote-debugging-port=0, port read from the profile's
                               DevToolsActivePort, socket opened directly so no proxy
                               applies), `Page` (navigate → load event, evaluate awaiting
                               promises, viewport, screenshot)
    assets.py         asset reference resolution. `AssetRoots` holds the allowed roots
                               (project dir, theme asset dir, and the PDF page cache
                               `.inkflow/cache/pdf/` as `_pdf/`) and converts between an
                               absolute path and a canonical ref both ways; `AssetSource`
                               resolves the refs written in one file; `svg_reader` is the
                               composition reader that canonicalises each SVG as it is read
    cli/              CLI package (entry point inkflow.cli:main). _common.py holds the
                               `main` group, shared options, the Project/Target helpers and
                               `DeckSlides`/`slide_number` (SLIDE = presentation number or id);
                               commands are grouped by area: project.py (init, setup-git,
                               setup-pages, completion: `carapace_spec` merges each plugin's
                               `completion_spec` into completions/inkflow.yaml), present.py (serve,
                               build, export; `share_options`/`sharing`/`port_for`/`already_served`
                               for any command starting a server), render.py (`inkflow render`;
                               `current_slide` asks the plugins), fonts.py (`inkflow fonts [--json]`
                               = the fontreport table; plugins add subcommands: `group_deck`),
                               authoring.py (clean, label2id, add, parent group, sync, layouts
                               [--plain | --json]), color.py (colorize, palette), verify.py (each
                               line: the slide's number and id; a closing count, `verify_summary`;
                               `--no-deck-checks`). Submodules register on `main` by import; then
                               `plugins.loaded()` each `register_cli(main)`
    instances.py      one server per deck: each server records {pid, host, port,
                               ws_port (= port unless `--ws-port`), deck, tls,
                               owner_token (SSH mode)} in the user state dir (dir 0700,
                               records 0600; `ws_url()`/`owner_url()` carry `?k=`, the
                               probe a cookie; `url()` never does) (`register`/`unregister`, by
                               `_serve_deck`); `serving(deck)` finds the live one, trusting
                               a record only when `/_inkflow/instance` answers with its
                               pid (stale ones are deleted). Used by `inkflow edit/serve`
                               (open that server instead) and the session's open-deck
                               (returns `redirect`, the page goes there)
    drawio.py         draw.io editable SVGs (*.drawio.svg): the `<mxfile>` source in the
                               root's `content` attribute; `source`/`normalize` store it
                               uncompressed (inflate + unquote per page), `size`,
                               `textconv` (what `inkflow clean --stdout`, git's SVG diff
                               driver, prints for one; `clean` never rewrites one)
    drawio_inline.py  a draw.io picture drawn into its slide: `inkflow:drawio="inline"`
                               or `"themed"` on the `<image>` (`DiagramMode`; none = picture)
                               makes `process_slide` (before annotation) swap it for a
                               nested `<svg>` with the image's box, id, transform and
                               provenance (`data-ink-tag="image"`, `data-drawio`, class
                               `inkflow-diagram`), every id inside prefixed and each
                               `data-cell-id` cell named `<image id>-<cell id>` so cues
                               and connectors target shapes (`data-cell-kind` vertex/
                               edge/label/other from the source); Helvetica (draw.io's default) becomes
                               `var(--inkflow-body-font)`; "themed" maps colours to theme
                               tokens (draw.io's palette by name, else hue/lightness;
                               `light-dark()` by its light half) and moves recoloured
                               presentation attributes into style (no var() there).
                               contract.css sets its `color-scheme` from `data-theme`
    pdf.py            PDF figures: a picture naming a PDF (`plot.pdf#page=2`; `Image(...,
                               page=2)` is kept as that fragment) shows its page converted
                               to SVG by the first converter available: PyMuPDF (the
                               optional `pdf` extra, AGPL, imported by name only here),
                               then pdftocairo, mutool, Inkscape (`converter`, `CONVERTERS`).
                               `convert` caches by content hash + page + converter;
                               `PdfPages` (one per build, in `DeckContext`) rewrites every
                               `<image>`/`<img>` after content injection, keeping the PDF
                               ref in `data-inkflow-pdf`, or draws a placeholder (one
                               warning per build, `install_hint`); `page_count` for
                               the editor's page picker and `verify`. A page committed
                               beside its PDF (`committed_path`: `figure.pdf.p1.svg`,
                               written by `pack --with-pdf-pages`, root stamped with
                               the PDF's hash `data-inkflow-pdf-digest`) is used
                               instead while the hash matches (`committed_page`), so
                               references keep naming the PDF
    backgrounds.py    a background behind a picture (`Image(background=...)`,
                               `inkflow:background` on an `<image>` or a drawn-in diagram):
                               `background_paint` (paper = white in any mode, surface,
                               a theme colour, #hex); a zone `<img>` gets CSS, a slide's
                               own picture a pipeline-only `<rect>` behind it (margin 4%
                               of its shorter side, `pointer-events: none`)
    clean.py          SVG Inkscape metadata stripping (used by cli and pre-commit hook)
    fonts.py          font discovery + embedding (see "Font embedding" below):
                               `font_index`/`font_sources` (other modules' API),
                               `SHIPPED_FONTS_DIR`/`is_shipped`, `embed_fonts_css`
                               (serve; `font_url=shipped_font_url` links shipped files),
                               `embed_fonts_css_subsetted` (build/export/render),
                               `ui_fonts_css` (the interface's "Inkflow UI*" faces),
                               `shipped_font_file` (the `/_inkflow/fonts/` route)
    ink.py            pen ink: `ink_path` (ink/<slide id>.svg or Slide(ink=)),
                               `compose_ink` (the file's strokes as the slide's last
                               `<g class="inkflow-ink">`, stretched if its viewBox differs),
                               `Stroke` (a page's stroke validated field by field into a
                               filled `<path>`), `add_strokes` / `erase_strokes` (the file
                               as bytes, laid out as `inkflow clean` would write it)
    label2id.py       `inkflow label2id`: promote each element's inkscape:label to its
                               SVG id (Inkscape convenience for Morph/animation targets).
                               Slugifies non-id labels, skips clashes and preview-layer
                               elements, rewrites ids by text substitution to keep diffs small
    colors.py         CSS color token extraction, hex→class mapping, SVG colorization, GPL palette
    git_setup.py      git hook + SVG diff driver setup; `init_project_git`
                               bootstraps a fresh project (git init + .gitignore +
                               hooks), and steps aside when already inside a repo;
                               either way `setup_lfs` writes the deck's LFS section
    lfs.py            Git LFS for decks: media extensions (PATTERNS), the
                               .gitattributes section (rules, or the committed
                               `# inkflow: lfs off` git-only opt-out), `mode` (on/off/none
                               from the deck's .gitattributes up to the repo root)
    publish.py        GitHub Pages / GitLab Pages (`inkflow setup-pages`, `init --pages`,
                               the editor's Git → Publish…, session action `publish`
                               ops status/setup, setup local only, one History step
                               though the files sit at the repo root): renders
                               templates/ci/ (pages.yml, release.yml, gitlab-ci.yml
                               + gitlab-release.yml; `__TOKEN__` placeholders) for the
                               deck's `layout` (repo root, deck folder → `--deck`,
                               nearest pyproject.toml → `uv run --project`, else
                               `--with inkflow~=…`; GitHub branch = origin's HEAD or
                               the current one, GitLab uses $CI_DEFAULT_BRANCH). LFS
                               and PDF converter are handled at run time (checkout
                               `lfs: true`; GitLab `git grep filter=lfs`; poppler when
                               `git ls-files '<deck>/*.pdf'`), so the files do not
                               depend on them; release names use the repo name at run
                               time. `parse_remote`/`pages_url`/`settings_url` (user
                               sites, GitLab subgroups; self-hosted → no URL),
                               `detect` (the marker `inkflow setup-pages` in the file;
                               git status's `pages`), `plan` (conflicts: refuses
                               unless force), `font_warnings` (fonts.font_sources:
                               fonts outside the project's/theme's fonts/)
    fontreport.py     where each font family the deck uses comes from (`font_report`:
                               effective token values from the styles cascade, other
                               CSS font-family, every font in the built slides; faces
                               used, body bold/italic from the HTML): `Where` project /
                               theme (the active theme's or inkflow's fonts/) /
                               machine / missing / generic (a generic family first);
                               its own uncached index over fonts._font_dirs;
                               `licence_of` (licence files beside the font, name IDs
                               13/14/0, fsType, `_SYSTEM_FONTS` with open
                               alternatives); `plan_bundle` (machine fonts' used
                               files, or a variable font, to fonts/<family>/ with
                               licences + fonts/README.md table, warnings never
                               refusals); `token_value` (what `fonts set` writes)
    pack.py           the building blocks of a portable deck: `Item`s (key, message,
                               consequence, fixable), `plan_pyproject` (pin inkflow and a
                               pip-installed theme, nearest pyproject.toml or a new one), uv.lock
                               (`run_uv_lock`, patched out in tests by conftest), `plan_attributes`
                               (LF rules one per pattern, SVG diff line, LFS block or missing font
                               rules, lfs-off kept), `make_zip` (git ls-files or .gitignore, LFS
                               smudged), `show_path`; `ensure_text_rules`/`bundle_fonts_now`/
                               `lock_new_deck` for `init --self-contained` and new decks.
                               inkflow-editor's `pack.plan_pack` puts them together with its copy-in
                               of outside files (`inkflow pack`, its verify lines)
    init.py           project scaffolding (inkflow init): copies templates/ into
                               slides/ + notes/, writes a 3-slide deck.py and a bare
                               pyproject.toml pinning inkflow (`~=` compatible release);
                               command refuses a non-empty target (dotfiles ignored)
                               unless --force. `scaffold_poster` (init --poster
                               [--size], the editor's Poster look): templates/poster/
                               (poster.md, figures/, data/results.csv) on poster-3col
                               (poster-landscape-3col for a landscape sheet).
                               `with_theme` (init --theme, the Paper/Stage looks):
                               `theme=Paper()` + its import in the scaffolded deck.py
    loaders.py        deck style / script loading helpers. `load_deck_styles` emits the
                               CSS cascade: contract.css → active theme tokens → the
                               *built-in* theme's styles.css (always, since any theme may
                               fall through to the built-in layouts; skipped when the
                               built-in is itself active) → active theme styles.css →
                               project styles.css
    sync.py           reusable preview sync: `PreviewContext` (deck-derived data resolved
                               once per run: preview CSS, slides-by-file, overlay files),
                               `plan_preview` (the single answer to "what does this file
                               preview", shared by `sync`, `sync --check` and `verify`),
                               `PreviewRule` (which of the three overlay rules fired),
                               `PreviewPlan.swept` (whether a whole-deck sync keeps a file
                               current, and so whether verify may call it stale: a bare
                               slide only once it carries the preview style block),
                               `sync_slides`; shared by the `sync` command and `init`
                               (run live after scaffolding)
    logging.py        unified log sink over stdlib logging: `logger`, shared Rich
                               `console`, `report` (cargo-style status), `collect_logs`
                               (per-rebuild capture), and three independent sinks
                               (console/file/browser), each a level, resolved by
                               `resolve_levels` (`--log-level*` flags + INKFLOW_LOG_LEVEL*
                               env, `off` disables) and installed by `configure`.
                               `configure` also claims the root logger (`_ForeignHandler`)
                               so a dependency's records land in these sinks at their own
                               level instead of stdlib's lastResort stderr
    svg.py            SVG tree utilities (ensure_defs, with_namespaces,
                               compose_with_ancestors, compose_overlays,
                               duplicate_zone_ids, is_full_canvas_fill)
    svgio.py          SVG parse/serialize primitives: one hardened parser, SvgElement alias
    verify.py         slide authoring checks (inkflow verify); every plugin's
                               `slide_checks` run after the core's on each slide, `verify_deck` =
                               the plugins' `deck_checks` (inkflow-editor: arrows whose shapes
                               moved, what ties the deck to this machine); `render --check` does
                               not repeat them
    ns.py             XML namespace constants
    tui.py            terminal UI (Rich)
    presenter.html    shell template — inlined with CSS/JS at serve time
    render.html       single-slide page `inkflow render` measures and screenshots
    pdf.html          PDF export template
    bundles/          pre-built JS/CSS output (committed; no Node needed at install time)
      presenter.js    navigation, transitions, WebSocket, presenter panel
      presenter.css   all presenter styles including the sidebar panel
      render.js       single-slide renderer + layout measurement (src/ts/render)
      fit.js          shrink-to-fit for the PDF export page (src/ts/fit, pdf.html)
    theme/            built-in theme: layouts/*.svg (the 16:9 ones, and poster-base/
                               poster-landscape-base with poster-2col/-3col/
                               -landscape-3col/-4col on the A canvas: zones title,
                               authors, affiliations, logos, col-N, references,
                               contact), icon.svg, showcase/, fonts/ (the fonts
                               inkflow ships, licences + README), and
                               styles.css (per-layout zone styling for those layouts,
                               loaded for every deck — keep its rules `.layout-*`-scoped)
    builtin_themes/   the themes shipped besides the default (`Builtin`, themes.py):
                               `Paper` (quiet white document look, light by default) and
                               `Stage` (big-type keynote look, black on screen; leaves
                               `mode` unset so a printed deck is still light), `THEMES`
                               (default/paper/stage: init --theme, the Theme dialog's
                               selector) + `theme_id`. Each: palettes for both modes
                               (contrast checked in tests/test_builtin_themes.py),
                               `replace(Builtin.typography, ...)` (never their own font
                               families), `fonts_dir` = the default theme's fonts,
                               `asset_dir` = paper/ or stage/ here even for a subclass,
                               holding only a styles.css: unscoped text rules plus
                               `.layout-*` refinements of the built-in layouts
                               (decorative layout shapes matched by exact geometry,
                               e.g. `rect.inkflow-fill-accent[y="0"][height="8"]`)
    templates/        inkflow init starter files (title.svg, diagram.svg, guide.md,
                               diagram.md, notes/*.md) copied verbatim into new projects;
                               example/ is the demo deck's look (footer overlay + styles)
                               for the editor's "Inkflow example" new deck; ci/ is
                               publish.py's CI templates
  ts/                 TypeScript source
    globals.d.ts      ambient declarations for Python-injected globals (__SLIDES_JSON__ etc.)
                      shared/viewbox.ts falls back to the deck canvas (`setDeckCanvas`,
                      from the editor model's `deckSize`, which also sets the
                      thumbnails' `--deck-ar`); shared/ink.ts `inkScale` sizes
                      pen strokes by max(w/1920, h/1080)
    shared/           types, step engine (step.ts: WAAPI cue driver + elementActions),
                      sections.ts (section runs of the presented slides, which carry
                      `SlideData.section`; `verticalNeighbor` for wrapped grids),
                      keyframes.ts (reads @keyframes + per-cue var substitution),
                      step-ring SVG builder, cubic-bezier easing; ink (presenter and
                      editor alike): ink.ts (pure: perfect-freehand options, outline ->
                      path data, Douglas-Peucker `simplify`, eraser hit test, relay
                      validation), inksettings.ts (pure palette state), inkpad.ts
                      (pointer input -> strokes: coalesced + predicted samples, one
                      redraw per frame, eraser, palm and click swallowing),
                      inkpalette.ts (the floating palette); zoom gestures (both
                      pages): gestures.ts (pure: wheel delta -> zoom factor with
                      deltaMode, `ZoomAnchor`, the `TouchTracker` state machine;
                      tested), gesturepad.ts (`GesturePad`: the DOM glue, one per
                      page), zoom-camera.ts (the presenter camera's viewBox maths);
                      patch.ts (a rebuild as what changed: `applyPatch` puts a
                      list together from the items a page holds, named by
                      `key`; null = a key it lacks, the page sends `resync`;
                      tested),
                      fit.ts (text size steps + shrink-to-fit: pure `searchScale`
                      bisection, `floorScale`, `neededHeight`, `nextTextSize`,
                      `parseTextSize`, `MIN_TEXT_FRACTION` (measure.ts's too); DOM
                      `fitSlide`/`fitZone`/`scheduleFit`/`neededBoxHeight`,
                      `onFontsLoaded`; tested)
    presenter/        main presenter modules — navigation, transitions (progress-driven
                      via progress-driver.ts), overview, picker, websocket, status bar,
                      keyboard, syncmenu.ts (sync-mode status-bar control),
                      fit.ts (shared/fit.ts on each mounted slide, refit when
                      fonts load unless a transition is in flight),
                      pv.ts (presenter panel sidebar; current section under the
                      strip), overview.ts (grid with a heading per section, up/down
                      by geometry), picker.ts (sections match too), video.ts (step-driven
                      <video> playback, wired in via status.ts), toeditor.ts (back to
                      /edit at this slide: the opener editor tab when there is one;
                      hidden in a static build), ink.ts (ink mode: strokes held per
                      slide in inkstore.ts, mounted into the slide's <svg> through
                      slidehooks.ts, relayed as `ink` messages, saved with "Keep"
                      as an `edit-op` `ink`), and deck-url.ts
                      (pure position<->fragment codec behind syncURL/readURL; the
                      only module reading location.pathname/search/hash)
    fit/              main.ts: the PDF export page's script (bundles/fit.js, inlined
                      into pdf.html by export.py): `fitSlide` on every slide, again
                      on load and once fonts are ready
    render/           the single-slide page behind `inkflow render`: main.ts (step,
                      `fitSlide`, waits for load/fonts/first video frames, fits
                      again), measure.ts (zone
                      text vs its foreignObject box, code blocks cut off, drawn
                      side-by-side text boxes shrunk to fit by different
                      amounts (`unevenFits`, a hint: `uneven-fit`),
                      objects vs the viewBox — skipping clipped/masked content,
                      unpainted shapes and anything spanning the slide — and text
                      below 1/80 of the slide height; all in slide units),
                      boxes.ts (`--boxes`: each id'd element's box after
                      transforms, zone content extent/free space, text blocks)
                      contrast.ts (each text run vs the hidden-text shot's pixels
                      where its glyphs are, worst tenth decides; halo strokes,
                      shadows that help, alpha blended; pure WCAG maths tested)
  css/                CSS source
    shared/           theme variables, animation keyframes, ink.css (the ink palette)
    presenter/        presenter partials including pv.css (sidebar panel)
themes-tour/          a theme on every layout with text, code, a table and charts
                      (INKFLOW_TOUR_THEME / INKFLOW_TOUR_MODE): the built-in themes
                      page's screenshots (docs/built-in-theme/img/)
demo/
  deck.py             12-slide demo deck (SVG slides, some filling zones with Markdown via md=)
  slides/             source SVGs and Markdown content files
  data/               chart data (sales.csv)
mise.toml             task runner + tool versions (replaces poethepoet)
package.json          JS devDependencies: biome, esbuild, typescript
pnpm-lock.yaml        pnpm lockfile (JS deps); package manager is pnpm, not npm
pnpm-workspace.yaml   pnpm settings: allowlists esbuild's postinstall build script
biome.json            Biome lint + format config (4-space indent, noUnusedVariables=error)
tsconfig.json         TypeScript config (noEmit, verbatimModuleSyntax — tsc as type-checker only)
```

## Key architecture decisions

**Frontends are plugins; the core never knows them.**
A frontend (inkflow-editor's visual editor, a remote control, a review tool) is an installed package naming a `plugins.Plugin` under the `inkflow.plugins` entry point. The core finds plugins once per process (`plugins.loaded()`; `INKFLOW_NO_PLUGINS=1` turns them off) and asks each, at the place it matters: `register_cli(main)` after the core's own commands (a plugin may add subcommands to a core group, as inkflow-editor does to `fonts`); `slide_checks`/`deck_checks` in `inkflow verify`; `completion_spec` in `inkflow completion carapace` (command blocks merged into the core's spec, one named like a core command replacing it); `current_slide` for `inkflow render`'s default; `server_extensions(config)` when `serve` starts without a list of its own (`serve_options()` adds options to `inkflow serve` whose values reach it as `config.options`: inkflow-editor's `--share-online`); `requirement()` is pinned beside inkflow in a new deck's pyproject. A plugin's command that starts a server (`inkflow edit`) passes its extensions to `server.serve(..., extensions=)` itself.
A server extension (`extensions.ServerExtension`) is how a frontend lives in the server: per deck it is opened and closed; per build `before_build` and `build(Build)` run in the worker thread inside the build (raising fails it, as any build error), `built` after the pages have the new slides; `provenance = True` makes it the editor build (`process_deck(editor=True)`: source locators on every element, `SlideData.edit` facts, both for writing back). Its `messages` (type -> least role) are the only extra messages the door lets through (`server.allowed`); `hello` tells it what a page is (the editor says `role: "editor"`); `http` answers what the core does not (after its own pages, fonts and the deck's assets); `welcome` adds to the first message a page gets (the presenter's back-to-the-editor button appears only when one names an `editor` page); `keys` adds terminal keys, `share_*` the Share dialog's operations and the terminal's share lines, `home` the page the owner link and the terminal name (`/edit`; `server.owner_page`). `share-status` and presence go to the owner's pages other than the presenter (`send_owners`: a page says what it is in `hello`). It acts through the `ServerContext` (`server.context`): the served state, the people and the door, send/broadcast/notify, `rebuild`, `open_deck` (the server closes this deck and serves another on the same port), `shutdown`, and `serve_connection`/`serve_request`, which run a page connection or a GET that came another way (an online guest's, through a relay) exactly as one from the network, for its role. The order matters once: `build-status` says a build is done only after every extension's `built`, so a program that changed the deck (an agent's command) and waits for its build finds the editor's session on it too.
Without any extension the server is the presenter's alone, and still saves the presenter's ink with "Keep" (`ink.save_ink`, no undo). The TypeScript side mirrors this: `src/ts/shared` is the client library (step engine, fit, patches, ink, gestures, the socket, identity), and a frontend's bundle imports it as `@inkflow/shared/*` (tsconfig `paths`, vitest alias), never a path into the presenter.

**No SVG editor subprocess at serve time.**
Any SVG editor writes the files; the pipeline reads them directly with lxml,
strips Inkscape/Sodipodi editor namespaces, and annotates elements with `data-cues` for the step engine.
No GUI window flashes, instant processing.

**Live reload pushes slides over WebSocket, not `location.reload()`.**
When files change the server sends `{"type":"update","slides":[...],"transitions":[...],"logs":[{"level","message"},...]}` and the presenter swaps content in place, preserving the current slide index.
A page that said `{"type":"hello","patch":true}` (the editor with `role: "editor"`, the presenter with `role: "presenter"`) gets `slides` as a patch: every served slide carries a `key` (a digest of its content, `incremental.set_keys`), and a slide the last build already had is its key string instead of the slide (`as_patch`; the editor's `editor-model` does the same with `model.slides`). `shared/patch.ts` puts the list together from what the page holds, keeping held items' identity (the editor's thumbnails, list rows and canvas are redrawn only for items that changed; the presenter reloads the slide on screen only when that slide changed). On `hello` such a page is sent the current slides all by key (its HTML came with them); a key it does not hold means it missed a build, and it sends `{"type":"resync"}` for everything whole. A page that never said so (an older inkflow's tab left open) is sent whole lists, as before.
Non-fatal records collected during the rebuild (`inkflow.logging.collect_logs`, filtered to the browser sink's level) ride along on the `update` message and show as a dismissible `#warning-banner`, each entry styled by level via a `log-<level>` class (dismissal sticks across rebuilds until the log set changes, keyed on a signature in `ui.ts`); a fatal build error is sent separately as `{"type":"error","message":"..."}` and displayed as the full-screen overlay (also logged to the file sink). Static `build` sends no logs to the page (they go to the CLI instead).
The HTTP response includes `Cache-Control: no-store` so hard refreshes always get fresh content.

**A served deck rebuilds what a change touched (`incremental.py`).**
The watcher still rebuilds on every change of any project file, and `server.rebuild` still runs deck.py and walks every slide, but `process_deck(cache=)` takes a slide from the last build unless one of its inputs changed (`server.Kept`: a `SlideCache` and a `ModelCache` per served deck; `build`, `export`, `render`, `verify` pass none and are untouched). On a 274-slide deck a rebuild went from 16.6 s to under 0.1 s (most of the 16.6 s was `build_model` walking deck.py's libcst tree once per slide). A slide's inputs and how each is watched: the files it read or looked for, recorded by `deps.note` while it is processed and compared by stamp at the next build, "not there" included (so its layout chain and overlays, ink, chart data, PDFs and their converted or committed pages, a drawn-in diagram, each candidate of a name search: a `slides/x.svg` that now shadows the layout `x` is a change); what deck.py says of it and of the deck, compared by value (`frozen`: types count, `Inline("a")` is not the path `"a"`; a class deck.py defines is a new class on every load, so slides using one are always processed; a Markdown reveal's `type=Name` makes the slide depend on deck.py, whether the name was found or not); its id. **Not** its number or the slide count: they reach the output only as the root's `inkflow-slide-N` id (and the `@scope` naming it) and the text of `zone-slide-number`/`-total`, so the cache processes a slide with stand-in numbers and puts the real ones into the result (`_Template`), and inserting or moving a slide processes no other slide (a slide whose result shows a stand-in anywhere else is kept by its numbers instead, `_plain`). The notes file is a cache entry of its own, so typing a note processes no slide. What is deliberately outside the cache and done for every slide on every build: sections, the asset time stamps (`server._versioned`, which is how a changed picture reaches the pages), the keys, the deck stylesheet, fonts (their per-slide specs are memoized by SVG text in fonts.py), transitions. A slide whose build fell short for a reason that may pass (a PDF page that could not be converted) is not kept (`deps.retry`). Warnings logged while a slide (or its notes) was processed are logged again when it is kept; the one "no PDF converter" warning per build is said by `Build.finish`. Whoever adds a file read to the slide pipeline must `note` it: tests/test_incremental.py compares every incremental build with a full one and holds each slide's recorded files to what an audit hook saw Python open. `r` in the terminal (`rebuild(full=True)`) forgets what is kept.

**Position sync is a dumb relay with client-side authority + modes.**
Clients send `{"type":"nav","slideIndex","step"}` (validated + clamped server-side by `_coerce_nav_position`; a view link's are dropped, and its page starts in `follow`); the server stores the last position and rebroadcasts it as `{"type":"position",...}` to the *other* clients, and pushes it once to each newly connected client. A window that booted from a deep link (a slide named in the URL, captured by `readURL()` before `syncURL()` rewrites the bar) or reconnected asserts its own position and ignores that first push; a bare window adopts it. Each client also has a per-tab **sync mode** (`two-way`/`present`/`follow`/`solo`, `shared/types.ts`) deciding locally whether it broadcasts nav (`sends()`) and applies incoming positions (`receives()`) — the server knows nothing about modes. `s` cycles the mode; `syncmenu.ts` owns the status-bar widget, `websocket.ts` the network/state. Switching into a receiving mode sends `{"type":"sync-request"}` to catch up. Persisted in `sessionStorage`.

**Ink is drawn into the slide, held per slide, and saved to a file of its own.**
A stroke is perfect-freehand's outline around the pen's track (`shared/ink.ts`), written as one filled `<path>` so it renders anywhere without inkflow. `shared/inkpad.ts` turns pointer input into strokes for both pages: every coalesced sample is kept, the live stroke is one path redrawn once per animation frame (plus the browser's predicted samples) straight into the slide's own `<svg>`, so it is in slide units through the zoom camera, resizes and transitions; a pen's real pressure is used, a mouse's or finger's is simulated. By default only a pen draws (a mouse click and a swipe stay navigation, a palm near a pen is swallowed), and the click a gesture ends with never reaches the page. In the presenter (`presenter/ink.ts`, key `i`) ink is held per slide id (`inkstore.ts`, with undo) and re-mounted as `g.inkflow-live-ink` whenever `transitions.ts` mounts a slide (`slidehooks.ts`, which keeps transitions.ts and its tests free of ink). Other windows get it as `{"type":"ink","op":"draw"|"add"|"erase"|"abandon"|"request"|"state",...}`, relayed by the server untouched (or over the window link in a static build) and gated by the same `sends()`/`receives()` as the position; receivers validate every field (`strokeFrom`). With "Keep", a stroke also goes to the server as `edit-op` action `ink`, which only the owner and share-link editors may send, so an audience screen (a view link) never writes files: with an editor extension it becomes an undoable step of its session, without one the server writes the ink file itself (`server._save_ink`, `ink.save_ink`). Saved ink is `ink/<slide id>.svg` (or `Slide(ink=)`), strokes directly under its root so each is an editor object (source role `ink`, selectable and movable like the slide's own shapes); `process_slide` composes it right after the overlays and before annotation (a cue can reveal a stroke). A slide's id is inferred from file names, so inkflow-editor's `EditorSession._follow_ink` renames, copies or deletes ink files in the same step as a slide edit that changes ids, never overwriting a file nothing vacates. `serialize_ink` writes exactly what `inkflow clean` would, so the pre-commit hook leaves ink files alone.

**Zoom gestures are one shared layer; a pinch never leaves a trace of its first finger.**
`shared/gestures.ts` holds the pure parts and `shared/gesturepad.ts` (`GesturePad`) the DOM glue; the presenter (`presenter/zoom.ts`, the viewBox camera) and the editor (`editor/touchzoom.ts` → `canvas.zoomAbout`, which lays the paper out at the new size and scrolls the canvas so the anchored slide point lands where it belongs) each give it a host saying what a zoom, a pan and a cancelled finger mean. Ctrl/⌘+wheel (Chrome/Firefox's trackpad pinch) zooms by exp(-deltaY/100), each event's step bounded to ×1.2 so a mouse notch (100 px, 3 lines, a page; `wheelPixels` normalises `deltaMode`) is one even step; Safari's `gesturechange` zooms by its `scale` ratio; everything is summed and applied once per animation frame (`zoom(factor, from, to)`: about `from`, moved to `to`, so a pinch's midpoint pans as it zooms). Over the surface the page `preventDefault`s Ctrl+wheel and gesture events and sets `touch-action: none` (`#stage-wrap`, `#canvas`); elsewhere the browser keeps its page zoom. A plain wheel is the page's: the presenter pans the camera with it only while zoomed in (otherwise it does nothing, as before, so a trackpad's inertial tail never navigates), the editor scrolls natively. While zoomed the editor pads `#canvas` by half its size on every side (`layoutPaper`), so the paper can sit off-centre and the anchor always holds; `ZoomAnchor` keeps the anchored slide point across a gesture's frames so whole-pixel layout and scroll rounding never accumulate (per-frame layout measured at 1–4 ms median on the demo, so no CSS-transform stand-in).
Touch is read in the window's capture phase, before every other handler. `TouchTracker` decides: a lone finger passes through; a second finger landing while the first is not yet *committed* (moved past a 10 px slop **and** 200 ms passed) makes a pinch — the first finger's action is cancelled and every later event of both fingers is stopped, so the page never sees them; a second finger after the first committed is ignored (stopped) and the first carries on; after a pinch the finger left over is inert until it lifts (no drag, no swipe, no tap); a third finger is ignored; a finger landing beside a leftover resumes the pinch. Clicks are swallowed while a sequence is claimed and for 400 ms after a multi-finger one ends; `multiTouch` tells `keyboard.ts`'s swipe to stand down. Two ways to cancel, chosen per page: the **presenter rolls back** (`cancelSingle` → `onTouchCancel` subscribers: `InkPad.cancel()`, whose `onAbandon` relays `abandon` so other windows drop the half stroke, and the laser's `abortDraw`), because ink must start without latency and swipe/tap are decided at the end anyway; the **editor defers** (`defer`): a lone finger's events are held until it commits, then replayed as synthetic pointer events at the original target (pointerdown, plus a move to where it is), or on release replayed whole (a tap; a flick quicker than the window gets its move too), or dropped if a second finger makes a pinch — so selection, drags, marquees and insert tools need no rollback code and nothing reaches the session. `canvas.ts`/`insert.ts` wrap `setPointerCapture` in try (a replayed tap's pointer may already be gone). The editor's pen tool with *Hand* on is not deferred (ink latency) and is cancelled like the presenter's. A touch while a pen is down or was near in the last 1.5 s is a palm: not the gesture's, left to `InkPad`'s palm rejection. A double tap (or double-click) on empty area resets the presenter camera / fits the editor's slide; Chrome also fires a native `dblclick` for a touch double tap, both are idempotent.

**The deck position lives in the URL fragment, `#slide=7&steps=2` (`deck-url.ts`).**
The fragment never reaches a server, so nothing has to route it and rewriting it is a same-document change every browser permits. The path segment this used to write (`/7`) only ever worked under `serve`, whose catch-all answers any path with the presenter: a static host 404s it on reload (the docs demo included), and a `file://` deck cannot have it at all — the browser rejects the rewrite (`history.replaceState` throws `SecurityError`; Firefox logs "Content at …/index.html may not load data from …/7"). The fragment is the only form: nothing writes a path segment any more and nothing reads one, so the position has exactly one representation. `deck-url.ts` is the only module that touches `location.hash`, and its two functions are pure over a `URL` so every case is unit-tested; `status.ts` supplies `window.location` and keeps a `try/catch` around `replaceState`.

**`loadSlide()` vs `applyStep()` in the presenter JS.**
Step advances within a slide must NOT re-render `stage.innerHTML` — that would recreate the Web Animations API animations and lose their state.
`loadSlide()` sets innerHTML (enter-first elements start hidden via the `.anim-pending` guard).
Subsequent `applyStep()` calls drive each element's per-cue WAAPI animations (play/hold/reverse/cancel) on the existing DOM. The step engine (`shared/step.ts`) reads each element's `data-cues`, creates one paused `Animation` per cue (keyframes from `keyframes.ts`), and per step lets the **governing** enter/exit (the last one reached) own visibility — held at its resting end — while every other enter/exit is cancelled, so the result never depends on WAAPI composite order across several held animations. A single step back across the governing boundary plays the outgoing cue in reverse (it lands on its start frame, which equals the new governing cue's resting value, and the next step cancels it). `applyStepInstant` lands the resting state with no playback (load, jumps, backward entry) and never fires emphasis. The pure `elementActions(cues, step, prev, instant)` is the testable decision at the core.
Because the step state is held by live WAAPI animation objects (not classes/inline styles), it does not survive a DOM snapshot. So before a transition captures the outgoing slide (`stage.innerHTML` for the layer transitions, cloned nodes for morph), `loadSlide` calls `commitStepStyles(stage)` to bake the held values into inline styles — otherwise the outgoing slide reverts to its authored base (entered elements vanish, exited ones reappear) the instant the transition starts.

**`deck.py` is a Python module, not YAML/TOML.**
Loaded via `importlib.util.spec_from_file_location`. Must define a `main() -> Deck` function.

**Morph transition uses a rAF loop over SVG attributes, not CSS transforms.**
CSS `transform: translate(Xpx)` on SVG elements is interpreted in SVG user units, not CSS viewport pixels — FLIP-based approaches produce a coordinate gap proportional to the viewBox scale.
Instead, `morphSlide()` snapshots raw geometry attributes (`x`, `y`, `width`, `height`, `rx` for rects; `cx`, `cy`, `r` for circles) before the innerHTML swap, then drives a `requestAnimationFrame` loop that calls `setAttribute` each frame in SVG user units.
Colors are lerped channel-by-channel.
Exit-only elements are reconstructed as ghost nodes in the new SVG and faded out.
Backward navigation passes the outgoing slide's transition to `loadSlide()` so the morph plays in reverse.

**`presenter.html`/`css`/`js` are inlined at serve time.**
`build_html()` in `server.py` reads the template and the two bundles, substituting `__CSS__`, `__JS__`, `__STYLES__`, `__DATA_THEME__`, `__SLIDES_JSON__`, `__TRANSITIONS_JSON__`, `__WS_PORT__`, `__ERROR_JSON__` tokens.
Edit the source files, run `mise run bundle`, and reload the browser to see changes.

**The presenter panel is a sidebar inside the single presenter page, not a separate route.**
`<aside id="pv">` lives in `presenter.html` and is hidden (`width: 0`) by default.
Pressing `p` toggles `body.pv-open`, which CSS-transitions the sidebar to 30% width while the stage flexes back.
`pv.ts` owns all panel logic (clock, next-preview, notes); it reads directly from `state.slides` so no second WS connection or position sync is needed.
For second-screen use, open the same URL in two windows and toggle the panel in one.

**Font embedding is automatic and zero-config; the default fonts ship with inkflow.**
`theme/fonts/` holds Inter (variable, upright + italic), JetBrains Mono (variable), STIX Two Math (OpenType MATH) and Twemoji Mozilla (COLRv0 emoji, drawn by Safari too, unlike COLRv1), ~2 MB of WOFF2 with licences and a README (sources, versions, checksums). `Typography`'s defaults (every theme's) name them first: `"Inter", "Twemoji Mozilla", sans-serif`, `"JetBrains Mono", …, monospace`, and the `math_font` token `"STIX Two Math", math`, which contract.css applies to `math`. contract.css also gives a slide's unstyled text the body font (`svg[id^="inkflow-slide-"]`, never the page's UI font) and maps `font-family="sans-serif|sans|monospace"` *attributes* to the tokens by a rule (any stylesheet rule still wins, as over an attribute); `svg.theme_generic_fonts` (a pipeline step) rewrites the same generics in inline `style`s (Inkscape's default text) in place. A slide's own `@font-face` is lifted out of its `@scope` like `@keyframes`, and its family is not looked up.

Search order: `<project>/fonts/` → the active theme's `fonts/` → `SHIPPED_FONTS_DIR` (whatever the theme) → user font dir → system dirs. A variable font is one record over its `wght` range (`weight_range`; "Inter Variable" is indexed as Inter, `_family_key`); `@font-face` rules describe the *file* (weight range, real style; a colour font `1 1000`), deduped per (family, file), so the browser synthesises only what no file has. Specs come from the slides' `font-family` values and from the token declarations in the deck CSS (`_specs_from_tokens`: every family of each list, upright/italic × 400/700; later families are `need="fallback"`, the math token's `need="math"`).

Serve (`embed_fonts_css`, index cached per process): shipped files are linked as `/_inkflow/fonts/<file>` (`shipped_font_url`; the server route serves only those files, cacheable), anything else is a full base64 data URI. Build/export/render (`embed_fonts_css_subsetted`): every face is subset (fontTools, WOFF2, all layout features and the name table kept) to the slides' codepoints + printable ASCII + CSS `content` strings; with MathML, plus `_MATH_BASE` (radicals, fences) and every styled form of each letter in a formula (`_math_alphanumerics`: a browser draws `<mi>x</mi>` as U+1D465); a fallback family (emoji) only when the deck has characters the first families lack, the math font only with formulas. Subsets are cached by font content + codepoints in `$INKFLOW_CACHE_DIR` or the user cache dir (`_subset_cached`; tests point it at a session temp dir). If subsetting fails the full file is embedded. The PDF: Chromium writes variable and CFF faces as Type 3 (outlines, text selectable), static TrueType as TrueType; `pdf.html` hides video controls (their 0:00 is a system font).

The interface (editor, presenter, ink palette) uses `"Inkflow UI"` (Inter), `"Inkflow UI Mono"` (JetBrains Mono), `"Inkflow UI Symbols"` (STIX) and `"Inkflow UI Emoji"` (Twemoji), names of their own so they never mix with a deck's subset: `server.build_html`/`build_editor_html` add `ui_fonts_css()` (URLs) to the page CSS, a static build passes `ui_fonts_css(text)` subset to the presenter's own text, slide titles and notes.

Unresolvable fonts produce a yellow TUI warning (once per family) and fall back to system rendering.
Opt out per-deck: `Deck(embed_fonts=False)`. `publish.font_warnings` treats shipped fonts as portable.

**An asset reference resolves against the file it was written in.**
`assets.py` owns the rule and both halves of it. An `<image href>` resolves against its SVG, a Markdown `![](…)` against its `.md`, an `Image`/`Video`/`Inline` against `deck.py` — what every editor already assumes. The pipeline canonicalises each reference exactly once, while its declaring file is still known (`svg_reader` at each `clean_inkscape_tree` site, `AssetSource.html`/`.ref` for Markdown and zone values), into a path relative to the presentation root. `AssetRoots.locate` is the inverse, and it is the single answer both `server._resolve_asset` and `export._copy_assets` use, so serve and build cannot disagree about what a reference means. On-disk SVGs are never rewritten — only the in-memory tree — so a slide keeps rendering in Inkscape.

An asset must live under an allowed root: the project dir (canonical prefix `""`), or the active theme's `asset_dir()` (prefix `_theme/`, so a pip-installed theme can ship branding). `locate` matches longest prefix first, which reserves `_theme/` at the project root. A reference that escapes every root is warned about and left as written rather than re-anchored somewhere it never pointed at — the server has always refused paths outside the project, so it was never reachable. Symlink the directory in to bring it back inside; containment collapses `..` without resolving symlinks precisely so that works.

`build`/`export` copy every referenced local file into the output dir, mirroring the source tree; a canonical ref is relative and `..`-free by construction, so `out_dir / ref` always lands inside and needs no rewriting. `_slide_refs` scans the *emitted* SVG and notes rather than walking the deck, so a pruned zone takes its asset with it. A reference that resolves to nothing is a `logger.warning`, not a silent skip. `serve` streams the same refs on demand instead of copying.

**A deck is portable when a clone of its folder looks the same anywhere.**
Only the deck's own files and the pinned inkflow/theme travel with a `git clone`, so `fontreport.py` classifies every font as project / theme (portable) or machine / missing / generic (`inkflow fonts`), and `pack.py` holds the building blocks that take the rest away as `Item`s (fixable or not): pyproject pin + uv.lock, `.gitattributes` LF/diff/LFS rules, a zip of the source tree. inkflow-editor's `pack.plan_pack` puts them together with copying in files from outside the deck (its reference-rewriting engine) and PDF pages, for `inkflow pack`, its `verify` lines and its commit question. Licences warn, never refuse. fontreport only reads fonts.py's discovery (`_font_dirs`, `_read_font_record`) with its own uncached index, so a just-bundled font is seen at once.

**PDF figures are a derived asset, converted at build time and never committed.**
Browsers show no PDF in `<image>`/`<img>`, so `pdf.PdfPages.apply` (a pipeline step after content injection, so SVG pictures, `Image` zones and Markdown images are covered alike) points each PDF reference at its page converted to SVG in `.inkflow/cache/pdf/` (git-ignored, unwatched; named by content hash + page + converter, so a saved PDF converts again and the watcher's rebuild shows it). The cache is a third `AssetRoots` root with the canonical prefix `_pdf/`, reserved like `_theme/`: `serve`, `build` (inlined; with `--assets-folder` copied to `out/_pdf/`, not a hidden folder static hosts may refuse) and `export` handle a converted page exactly as any picture, with no special case. The PDF reference survives beside it as `data-inkflow-pdf`, which the editor reads instead of the href (`pdfpages.sourceRef`), so nothing it writes back (page change, replace, copy/paste) ever names the cache; moves and crops edit the source SVG, whose href is the PDF. PyMuPDF is optional (`inkflow[pdf]`) and loaded with `importlib` so inkflow stays MIT and type-checks without it; the system tools are the fallback. With no converter the picture becomes a placeholder data URI and the build warns once.

**A deck's size is a canvas plus a page, and the A sizes share one canvas.**
`Deck(size=)` (`sizes.PageSize`) names both: the user units new slides get and the sheet a PDF page is. A slide's own size stays its `viewBox`; the deck size only decides what is created (blank slides, editor inserts, ink scale, thumbnails' shape, the layouts the gallery offers) and what is printed (`export.pdf_pages` fits each viewBox onto the page, letterboxing another shape, which `verify` warns about). All A sizes share A0's canvas so one poster design and the `poster-*` layouts serve every A sheet, and text scales with the sheet (`base_font`: 1/80 of the short side, 30 pt on A0); `render` measures printed slides in points and dpi against that same sheet size (`print_body_pt`), so the default type scale and the check cannot disagree. `None` keeps the pre-size behaviour exactly (per-slide pages, 16:9 new slides, theme mode and font).

`build` (the default; `--assets-folder` copies instead) uses `_inline_assets`, which rewrites each reference to a `data:` URI through `assets.rewrite_references` — the same `REFERENCE_PATTERNS` the scan uses, so both halves learn a new reference kind at once. It runs *after* `embed_fonts_css_subsetted`, because the subsetter scans these very slide strings for used characters and base64 would pin the whole font. `assets.MIME_TYPES` is the shared table naming what `serve` sends and what the data URI claims; a suffix missing from it is copied out and warned about rather than dropped, so the build can fall short of one file but never loses an asset. Each reference is inlined where it stands, so a shared asset is carried once per use — the reason `--assets-folder` exists (the Pages CI templates use it, so videos stream). `_inline_css_urls` does the same for `url()` in the deck CSS (resolved from the project root, as the served page resolves it), and `_warn_remote` names web pictures a single file still needs the network for.

**Markdown content injection (`md=`) uses `<foreignObject>`.**
Markdown is rendered to HTML via `markdown-it-py`.
Zone `<rect>` elements in the layout SVG are replaced with `<foreignObject>` of the same geometry containing the rendered HTML.
Typography and color come from the CSS cascade (`contract.css` + theme tokens + `theme/styles.css` + per-deck/per-slide `style=`, see `loaders.load_deck_styles`) injected into the `<foreignObject>` HTML head.

**Text zone alignment — three layers, increasing specificity.**

*1. Layout SVG CSS variables* — set once, applies to every slide that uses the layout:
```css
/* inside the layout SVG's <defs><style> */
#zone-title   { --inkflow-valign: center; }
#zone-content { --inkflow-padding: 40px; }
```
`--inkflow-align` (`left`/`center`/`right`/`justify`), `--inkflow-valign` (`start`/`center`/`end`), and `--inkflow-padding` (any CSS length) are consumed by `.inkflow-wrapper` and `.inkflow-content` in `contract.css` via `var()`. No pipeline extraction; pure browser cascade.

*2. Markdown zone marker parameters* — per-zone, per-slide, directly in the `.md` file:
```
::content align=center valign=center padding=60::
```
`align`, `valign`, and `padding` are the supported keys. `valign` accepts `top`/`center`/`bottom` (mapped to flexbox `start`/`center`/`end`). `padding` is in SVG user units. These translate to inline `style` attributes on the generated `<foreignObject>` wrapper and content divs, overriding CSS variables.

*3. Python `TextBox` explicit params* — in `deck.py`:
```python
from inkflow import Align, Slide, TextBox, VAlign

Slide(
    "layout.svg",
    zones={
        "content": TextBox(
            text="...", align=Align.CENTER, valign=VAlign.TOP, padding=40
        )
    },
)
```
The target zone is the `zones` dict key (`"content"` → `zone-content`); `TextBox` has no selector argument, its first positional is `text`. `Align` and `VAlign` are `StrEnum`s exported from the top-level package. `None` (the default) means "defer to CSS variable".

**foreignObject DOM structure after injection:**
```
<foreignObject>
  <div class="inkflow-wrapper" [style="justify-content:…;padding:…;"]>
    <div class="inkflow-content" [style="text-align:…;"]>
      {rendered HTML}
    </div>
  </div>
</foreignObject>
```
Inline styles are only emitted when the corresponding param is non-`None`; CSS variables handle layout-level defaults without touching the element's `style`.

**Text size and shrink-to-fit are source; the fitted size is the browser's.**
A zone's text size is a factor, `--inkflow-font-scale`, and whether it shrinks to fit is `--inkflow-fit` (`none` = never; anything else, the default, shrinks). Both follow the alignment layers: `TextBox(size=, fit=)` or a marker's `size=80%`/`fit=none` go on the wrapper's inline style (`content.py`), which beats the zone shape's own style (carried onto the foreignObject like `--inkflow-padding`, so a text box of the slide or a layout's zone for all its slides), which beats layout/theme CSS (a deck-wide `:root { --inkflow-fit: none }` in styles.css works because custom properties inherit). contract.css sizes `.inkflow-wrapper` as `calc(1em * var(--inkflow-font-scale, 1) * var(--inkflow-fit-scale, 1))`; everything inside is in em. Fitting needs real text layout (fonts, line breaks, formulas), so it runs in the browser, in every page that shows a slide, with one module (`src/ts/shared/fit.ts`): the presenter on `slideMounted` (before a transition takes the slide; refit on fonts loaded only when no transition is in flight) and its overview/next preview, so the static build too; the editor canvas after each render plus its thumbnails, master list and compare view (`scheduleFit`, a frame later once attached); the PDF page (`fit.js` in pdf.html, at parse, on load and on fonts ready); and `inkflow render` before measuring, so `render --check` sees what the slide shows. `fitZone` bisects the factor (to 1 %) between 1 and the floor, measuring with every step shown (reveals are transparent, not removed, so the wrapper children's layout heights count them; `display: none` content does not take room) plus code blocks that scroll and tables wider than the box; the floor is the larger of a third of the box's own text size and the readable minimum: 1/80 of the slide's height (`MIN_TEXT_FRACTION`, shared with measure.ts) or, on a printed slide, `data-inkflow-min-text` that the pipeline stamps on the root (`sizes.print_min_text`: `PRINT_MIN_TEXT` of the sheet's body size, the constant render.py's print check uses). The result is an inline `--inkflow-fit-scale` on the wrapper and `data-inkflow-fit`/`data-inkflow-overflow` on the foreignObject (the editor's red *Doesn't fit* badge and panel, measure.ts's `scale` on an overflow finding: "even shrunk to N%"). Nothing fitted is ever written to a file. contract.css also resets margins and padding inside `.inkflow-wrapper` (`:where()`, as weak as the presenter's `*` reset), so the editor, the PDF page and the compare view lay text out exactly as the presenter does and fit it to the same size.

**Charts are drawn at build time from data files, in theme tokens.**
A `Chart` zone value or a ```` ```chart ```` Markdown fence is turned into plain SVG by `charts.py` while the deck builds, so serve, the static build, the PDF export, editor thumbnails and `inkflow render` show the same chart and nothing runs in the browser. The data is a CSV/TSV/JSON file (or inline `data={...}` / a Markdown table), its path resolving against the file it is written in like any asset; it is inlined into the slide, so nothing is copied or versioned, and the watcher's rebuild on any project file is what redraws a chart when its data changes. `zones.build_slide_content` resolves a deck chart to a `ResolvedChart` (data read, or the error to draw in its place) and expands fence placeholders with the Markdown file's `AssetSource`; `content.py` swaps the zone shape for a nested `<svg>` with the zone's box and user units (provenance carried, so the editor moves and resizes it as the zone rect). `y_min`/`y_max` fix the value axis's ends (`_bounded`: the fixed end is the first/last tick, round ticks too close to it dropped) and `y2` puts columns on a second axis on the right (`_Series.axis`, with `y2_min`/`y2_max`; refused for stacked or horizontal bars); with any end fixed the marks are clipped to the plot (`<id>-clip`). Marks are painted with the palette tokens (`charts.PALETTE`, the chromatic part of `colors.SVG_TOKENS` in a fixed order) in `style` (never presentation attributes, where `var()` is invalid) and text with the text tokens, so charts follow the theme and colour mode. Every series is a `<g id="<zone>-series-<slug>">` holding its marks, value labels and legend entry (pie slices `-slice-`), which is what `animations=[...]` targets to reveal them one by one (`verify` draws a slide's charts to know those ids, and reports unreadable data). A fence chart is inline SVG inside a zone's HTML: `html_fragment_to_xml` restores the camelCase names lxml's HTML parser lowercases, and `_replace_with_foreignobject` attaches the foreignObject before its content because lxml otherwise drops the inline `<svg>`'s xmlns as "redundant" with the slide root's. In the editor a placed chart is a `zone-chart` rect plus a `Chart(...)` zones= entry plus `data/chart-N.csv`, written in one step by `insert-chart`; `chart-preview` renders the dialog's unsaved settings and grid with the same `render`, and `chart-save-data` writes the grid back in the file's own format, cells as typed.

**Layout chain resolution at build time, not on disk.**
`inject-layout` writes locked Inkscape preview layers into SVGs for authoring reference,
but the pipeline resolves `inkflow:parent` chains in memory and composites layers on the fly.
SVG files on disk are never modified by the serve/build pipeline.

**Overlays are the second composition axis, not multiple inheritance.**
`inkflow:parent` means "what am I built on" and composites *behind* a slide; an `Overlay` means "what goes on top regardless of what I'm built on" and composites *above* it. That keeps each axis single-purpose, and it is why chrome (a logo, a footer) reaches every layout without a wrapper layout per layout. `process_slide` calls `compose_overlays` right after `compose_ancestors` and *before* numbering/injection/annotation, so an overlay's `zone-slide-number` is filled, an overlay-declared zone can be targeted by `zones={...}` (and is pruned when unfilled), and cues can animate overlay elements — all for free. Resolution is `Slide.overlays` → `Deck.overlays` → `Theme.overlays`, each an override (`None` inherits, `[]` means none), matching `effective_transition`.

Overlays live in `overlays/` and resolve through `resolve_parent_path(..., AssetKind.OVERLAY)`, the same grammar against a different subdir. The separate namespace is load-bearing: a bare `inkflow:parent` on an overlay can only find another overlay, so it cannot silently pull in a layout, whose full-bleed background rect would paint over the entire deck. `verify` catches the explicit-path version of that mistake via `is_full_canvas_fill` and names the offending file in the chain. Front-composition (rather than a "universal root ancestor", which would be a one-line change to `resolve_chain`) is forced by exactly that background rect: `theme/layouts/base.svg` is a single full-canvas `<rect>`, so chrome at the root of the chain would be painted over.

Overlays become part of the slide SVG, so they travel with it during a transition (chrome slides with a `Push`, dips mid-`Crossfade`; `Cut`/`Morph` are unaffected). Accepted and documented; a persistent chrome layer outside the stage would be the alternative if it ever grates.

**Overlay preview in `sync` resolves a file→overlays mapping that has no single right answer.** `sync` works on files, overlays are declared on slides, so a shared layout is backed by slides that may disagree. `sync.plan_preview` decides in three steps: an explicit `inkflow:preview-overlays` attribute on the file → what every slide backing it agrees on → the deck default. The last is a guess and biases toward *showing* chrome (over-reserved space beats overlap), so the fired rule is printed per file (`PreviewRule`) and points at the attribute when the guess is wrong. `--no-deck` has no mapping to derive and uses the attribute only. A file that is itself an overlay (in an `overlays/` dir **or** referenced as one by the deck — the union covers drafts and off-convention paths) gets no chrome, only whatever `inkflow:preview` names as a backdrop (a layout, or a relative path to a real slide). There is deliberately **no default backdrop**: an overlay cannot know what it lands on, and falling back to the theme's `base` previews chrome against the wrong canvas size and a background colour the deck never paints whenever the deck is built on raw SVGs rather than layouts. `sync` reports `no backdrop` so the omission is visible. Both attributes are authoring-only and never read by the pipeline.

Layer classes: `inkflow:layout-src`/`-hash` marks what goes *behind* (backdrop + ancestor chain), `inkflow:overlay-src`/`-hash` what goes on top. `clean.strip_preview_layers` removes both, which is what keeps a synced slide from painting its chrome twice (once from the preview, once from runtime composition) and keeps an ancestor's own overlay layers from leaking into every child. `verify` shares `plan_preview` (so it cannot disagree about staleness) and skips files outside the project dir, which `sync` would never write.

**A theme's layout is copied on write, and the copy stands in for it everywhere.**
The ask is PowerPoint's slide master: edit the background of every slide, or every slide of one type, without touching each slide. Theme and built-in layouts live in an installed package and are never written, so editing one (the slide master, `inkflow layout copy`) writes `layouts/<name>.svg`: the theme's file with only its root attributes changed (`inkflow:copy-of="builtin:agenda"`, `inkflow:parent` re-expressed as `builtin:title`), so element locators taken on the theme's file still hold for the edit made in the same step. The decision is in resolution (`layout.deck_copy`): any reference that lands on a theme file the project has a marked copy of gets the copy, including the built-in layouts' own `./base` and `./title` parents. That is what makes "edit the background" reach every built-in layout while copying only `base`, and per-type edits copy only that layout. Copying the whole chain was the alternative; it would freeze every ancestor at the time of the copy and make each later copy's edits invisible to the others. Only *marked* copies redirect, so an existing project `layouts/title.svg` (a title slide of the user's own) keeps shadowing the bare name only, as before. Revert = delete the copy. A template is a layout made from a slide (`master.template_bytes`): zones stay as empty zones (their text lives in Markdown/deck.py anyway), optional `<inkflow:hint zone>` prompts that the pipeline pops before output and the editor shows on empty zones. Master edits that change what other files preview (copy, revert, new overlay) refresh the deck's Inkscape previews inside the same History step after the commit (`_refresh_previews`, from disk); ordinary drags do not, and leaving the master view sends `previews` with `attach`, merged into the last step, so `verify` stays clean and Undo still takes back exactly what was seen.

## Server

- HTTP on port 7777 (asyncio streams, custom handler); assets are streamed in
  chunks with byte-range support (`_send_file`, 206/416), which Safari needs for video.
  Served slides stamp each local asset reference with its file's mtime
  (`_versioned`: `assets/x.png?v=…`; `_resolve_asset` drops the query), because a
  page keeps pictures it loaded by URL: a diagram or picture changed on disk is
  then a changed slide at a new URL. build/export never stamp; the editor drops
  the stamp before writing anything back (`pathtext.assetRef`, `cleanForPaste`)
- `/handout?layout=notes|compact&paper=a4|letter`: the handout view
  (handout.py), not for a view link (it shows the notes)
- anything else an extension's `http` answers (inkflow-editor: `/edit`,
  `/_export/`, `/_cmp/`), then the presenter at any path
- WebSocket on the same port at `/_inkflow/ws` (`access.WS_PATH`): the HTTP
  handler reads the request head, checks it, and hands an upgrade to
  `wsbridge.Bridge` (websockets 16.0's `ServerConnection` adopted onto the
  transport, so pings/close/flow control/TLS are websockets' own). Pages connect
  to `ws(s)://<location.host>/_inkflow/ws` (`shared/wsurl.ts`), so a LAN address,
  an SSH tunnel's forwarded port or an HTTPS proxy all work; `__WS_PORT__` only
  says whether the page is served (null in a static build). `--ws-port`
  (deprecated) additionally opens the old separate port on this machine only,
  behind the same checks (`_ws_check`, origin = the HTTP port's pages);
  inkflow-editor's `agent/remote.py` and `inkflow goto/select` use `Instance.ws_url()` (with the
  owner token in SSH mode; goto/select look the instance up first) / the
  context's `server.wsPath` (never a token: context.json is in the project)
- The door, before anything else, for every HTTP request and WebSocket
  handshake: `Host` must name this machine (else 403: DNS rebinding); a
  WebSocket's `Origin`, when sent, must be this server's page (else 403:
  cross-site WebSocket hijacking); then who it is (`Access.admit`): the owner
  (loopback, see access.py; in SSH mode loopback + the owner token), or a valid
  share token in `?k=` or the cookie, else 401 (SSH mode without any token: "Open
  the owner link", `_SSH_401`, never the token). A `?k=` request answers
  `enter_page` with `Set-Cookie: inkflow-<browser port>=…; HttpOnly;
  SameSite=Strict` (+ `Secure` with `--tls`). Viewers get the presenter
  only (no handout; an extension refuses them its pages too, inkflow-editor
  `/edit`, `/_export/`, `/_cmp/`; `/_inkflow/instance` is the owner's). Pages
  carry `X-Frame-Options`/`frame-ancestors 'self'` and `Referrer-Policy:
  no-referrer`. Messages by role: `allowed()` (owner only: `edit`, `share`;
  owner and editors: `edit-op`, a `hello` as `role: "editor"`; each
  extension's `messages` by their least role; a viewer sends no `nav` and no
  ink but `request`). inkflow-editor's extension sets `_local` (owner),
  `_role`, `_author`, `_name` on every edit-op from the connection's client,
  dropping any `_*` key the page sent
- Sharing (`--share`, a non-loopback `--host`, or the Share dialog's `share` ops
  status/on/off/rotate/kick, owner only): `Listener.move` rebinds the one port
  between this machine and every interface (or `--host`) without dropping
  connections; turning it off, New links (`rotate`) and Disconnect close guest
  sockets with code 4001 (`SENT_AWAY`: the page says why and stops
  reconnecting). Links per `lan_addresses()` (+ `.local`, `--allow-host` names)
  are printed in the TUI and sent as `share-status`; tokens never reach the log
  in full. `--tls CERT KEY` serves HTTPS/WSS on the same port. SSH mode
  (`--ssh/--no-ssh`, `Sharing.ssh`): `_listen_hosts` never moves the listener
  for sharing (only `--host` does), links name `localhost`, `share-status` adds
  `ssh` + `sshInfo`; the TUI prints the owner link (`owner_lines`, `LiveUI.
  set_owner`) and the instance record holds the owner token
- Presence: each connection is a `collab.Client` (`welcome` {id, role, colour,
  name} on connect); pages send `presence` {page, key, name, slide, selection,
  editing}, relayed to everyone as `presence` {people} (never persisted, never
  the key)
- Ports: without `--port`, `pick_port` takes the first free one from 7777 up
  (`_port_free` tries every address the host names, ::1 too) and the CLI says so
  when 7777 was taken; `serve(auto_ports=True)` picks again if the port is lost
  to a server starting at the same moment (`_PortBusy`). One server per deck
  still holds: `instances.serving` finds the deck's server first
- File watcher: `watchfiles.awatch` (async generator); `_WatchFilter(root)` skips
  `.inkflow/` and `build/` *below the deck's folder* only, so a deck living in a
  worktree under `.inkflow/worktrees/` is watched normally. Every batch of
  changes is one `rebuild`, which processes only the slides the change touched
  (incremental.py) and sends each page what changed (`Client.patches`)
- The listener, the watcher and the keyboard run as tasks of `_serve_deck`

## Animation pipeline

`pipeline.py` processes each slide as a single lxml tree: parsed once via the hardened parser in `svgio.py`, threaded through the pipeline, serialized once at the end. `SlideSvg` wraps the tree and each pipeline step is a method that mutates it in place (like `list.sort()`), delegating the DOM work to `content.py`/`svg.py` functions that take and return the root element. Key steps:
1. `clean_inkscape_tree(src)` — parse with the hardened lxml parser, remove elements/attrs in `http://www.inkscape.org/namespaces/inkscape` and `http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd`, call `etree.cleanup_namespaces()`. (`clean_inkscape_svg` wraps this and serializes to a pretty-printed string for the CLI/pre-commit hook.)
2. `annotate_svg(root, cues)` — `cues` are `(Cue, step)` pairs already resolved to concrete step numbers (see below). Finds elements by plain id (no leading `#`); `Animation` cues are **grouped per target element** (an element may carry several) and written as one `data-cues` JSON array (sorted by step) via `_cue_entry` — each entry is `{step, kind, name, opts, vars}`, where `opts` are the base `Animation` fields as element.animate() options (`duration`/`delay`/`easing`/`iterations`) and `vars` are ready strings (slide direction+distance → `from-x`/`from-y`, `scale`/`color`/custom fields) substituted for `var(--anim-<key>)` in the keyframes. Enter-first elements also get an `anim-pending` class (initial-hidden guard); two same-kind cues with no opposing kind between them warn. A `PlayVideo` cue still sets `data-play-on-step` on the target zone's `<video>`.

**Steps are inferred from triggers, never written by hand.** Every `Animation`/`PlayVideo` cue carries a `Trigger` (`ON_CLICK`, `WITH_PREVIOUS`, or a `Trigger.at(n)` pin). `steps.py`'s `StepResolver` walks a cue sequence in order and assigns concrete step numbers — `pipeline.resolve_steps` for the deck's `animations=[...]` list, the reveal counter in `zones.py` for markdown `::step::`/`::steps::` reveals. A slide's markdown reveals number first (the `.md` file, then `zones={...}` Markdown strings, which go through the same `_split_steps`/`chunks_to_html`), then the `animations=[...]` list continues the count, so all form one timeline.

**Autoplay vs. a `PlayVideo` cue.** If a `Video` sets `autoplay=True` and is also targeted by a `PlayVideo` cue, the cue wins: `process_slide` suppresses `autoplay` before content injection (so `Muted.AUTO` resolves to unmuted) and logs a warning.

The cue's `name` is the kebab-cased type name (`Slugged.slug()`, the mixin in `manifest.py`, shared by `Animation`/`Transition`): `FadeIn → fade-in`, driving `@keyframes anim-fade-in`. There is no per-type registry and no `--anim-*` style — timing/visual params travel in `data-cues` (the old `_anim_style`/`_anim_classes` are gone). Each animated element does still carry an `anim-<slug>` class per cue type, but only as a **styling hook** (the engine drives animation from `data-cues`, not the class): built-in CSS uses it solely for constant styles a keyframe cannot hold at the right cascade origin — `.anim-scale-in`/`.anim-scale-out` set `transform-box: fill-box` there so the morph transition's inline `view-box` pin can beat it by ordinary cascade instead of `!important`. Custom animations author a `@keyframes anim-<slug>` (no JS) and may hook their own static styles on `.anim-<slug>`; the engine reads the keyframes and substitutes the cue's `vars`. All built-in animation/transition defaults are concrete Python dataclass field defaults — no CSS `var(--anim-x, default)` fallback. `@keyframes` in `src/css/shared/animations.css` are global (in the presenter bundle); custom `@keyframes` from `Deck(style=...)` are lifted out of the per-slide `@scope` wrapper by `_scope_slide_styles`/`_extract_keyframes` so they stay globally discoverable.

All SVG parsing routes through `svgio.py` (`parse_svg`, `parse_svg_file`, `serialize_svg`), which uses one hardened parser config (`resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False`, constructed per call since lxml parsers are not thread-safe). This is defense-in-depth plus crash-robustness: an SVG referencing an external/DTD entity degrades to an inert node instead of crashing the rebuild. `svgio.py` also exports the `SvgElement` type alias used across the backend.

## JS toolchain

Three tools, each with a distinct role:

- **Biome** — linter and formatter for TypeScript and CSS. Run via `mise run lint-js`. Config in `biome.json`.
- **tsc** — type-checker only (`noEmit: true`). Never emits files; esbuild does that. Run via `mise run typecheck-js`.
- **esbuild** — bundler. Produces committed bundles in `src/inkflow/bundles/` (and inkflow-editor's in `inkflow-editor/src/inkflow_editor/bundles/`) that the Python inlining pipeline reads at serve/build time. Run via `mise run bundle`.

One `package.json`, `tsconfig.json` and `vitest.config.ts` at the root cover both packages' TypeScript; `@inkflow/shared/*` resolves to `src/ts/shared/*` for all three tools.

JS dependencies are managed with **pnpm** (`pnpm-lock.yaml`). Every JS task depends on an `install-js` task that runs `pnpm install`, so `node_modules` stays in sync with the lockfile on each `mise run` and cannot drift (CI uses `pnpm install --frozen-lockfile`). `pnpm-workspace.yaml` allowlists esbuild's postinstall build script, which pnpm blocks by default.

`pip install inkflow` ships the pre-built bundles — no Node at install time.

`verbatimModuleSyntax: true` in tsconfig enforces `import type` for type-only imports, which esbuild requires since it transpiles files individually without type information.

## Dependencies

```
click>=8.0           CLI
lxml>=5.0            SVG processing
markdown-it-py>=3.0  Markdown rendering
platformdirs>=4.0    per-user log + font directories (inkflow.logging, fonts.py)
rich>=15.0           terminal UI
watchfiles>=0.21     inotify-based file watcher
websockets>=12.0     WebSocket server (uses 16.x asyncio API)
```

inkflow-editor adds libcst (deck.py edits that keep formatting and comments)
and, optionally (`inkflow-editor[online]`), cryptography (sharing online).
