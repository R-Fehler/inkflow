# inkflow-editor — codebase guide

The visual editor for inkflow decks, its editing session (every change written
back to the deck's own files, undoable), the commands an agent uses beside the
author, sharing online and the compare view. It is a **plugin of the core**
(`inkflow`, at the repository root, with its own guide in `../CLAUDE.md`): it
imports inkflow as a library and adds to it, and the core never imports it.

## How it plugs into the core

- **Plugin** (`plugin.py`, entry point `inkflow.plugins`): its commands on the
  core's `inkflow` group (and `fonts bundle`/`set` on the core's `fonts`
  group), its `verify` lines, its shell-completion blocks, the slide the
  author has open (for `inkflow render`'s default).
- **Server extensions** (`server.py`, `online/extension.py`, built on
  `inkflow.extensions`): `inkflow edit` (and `inkflow serve` with the plugin
  installed) runs the core's server with them. Everything the editor page
  needs from the server is an extension hook: the editor build
  (`provenance = True`), the model per build, the messages `edit-op`,
  `compare-*`, `problems-check` (editors) and `editor-context`,
  `editor-command` (owner), the pages `/edit`, `/_export/`, `/_cmp/` and the
  start page, the presenter's back-to-the-editor button (`welcome`), the `e`
  key, the Share dialog's Online section.
- **TypeScript**: the editor's bundle imports the core's client library as
  `@inkflow/shared/*` (src/ts/shared at the root: step engine, fit, patches,
  ink, gestures, the socket, identity); nothing in the core's TypeScript
  imports the editor's.

When the editor needs something new from the core, add a hook any frontend
could use (a `Plugin` or `ServerExtension` method, a `ServerContext`
capability, a `@inkflow/shared` module), never an editor special case in the
core; `mise run test-core` runs the core's tests with this package not
installed.

## Running

```bash
uv run inkflow edit --deck demo/deck.py            # the editor at /edit
uv run inkflow edit --deck demo/deck.py --share    # also on the LAN: editor + view links
uv run inkflow edit --start                        # the start page: new / open / recent decks
cd inkflow-editor && uv run pytest                 # the editor's tests
mise run bundle                                    # (from the root) rebuild both packages' bundles
```

## Layout

```
inkflow-editor/
  pyproject.toml      package `inkflow-editor` (depends on `inkflow`, libcst; extra
                               `online` = cryptography); entry point `inkflow.plugins`:
                               `editor = "inkflow_editor.plugin:plugin"`
  src/inkflow_editor/
    plugin.py         `EditorPlugin`: the commands (`cli.register`, `agent.register`),
                               verify's `checks.check_connectors`/`check_portable`, the server
                               extensions (`EditorExtension`, `OnlineExtension`), the completion
                               spec (completions/inkflow-editor.yaml) and `current_slide`
    server.py         `EditorExtension` (see "The editor in the core's server"):
                               one `EditorSession`, `CompareHub` and `Problems` per deck, the
                               model per build (`build`: `build_model` with its `ModelCache`,
                               keys, the patch; `built`: sent, session told `built_hash`/`live`),
                               `editor_html`, `/_export/` (`export_file`, `read_export`), `/_cmp/`,
                               the start page while no deck is open, `edit_op` (the `_local`/
                               `_role`/`_author`/`_name` it sets, post-edit messages, a deck
                               switch or quit through the `ServerContext`), `default_exporters`
    checks.py         the editor's `inkflow verify` lines: `check_connectors` (arrows
                               whose shapes moved, scene.py's rule), `check_portable`
                               (pack's items)
    pack.py           `inkflow pack`'s plan: `plan_pack`/`PackPlan` over the core's
                               `inkflow.pack` blocks + `filerename.plan_copy_in` + PDF pages
    comparesheet.py   `inkflow compare --sheet`: `render_comparison`, pair sheets
                               (`pair_sheet_layout`/`pair_sheet_html`, boxes outlined), on the
                               core's `render.page_template`/`slide_page`
    (modules)         the editing engine (see "The visual editor" below):
                               (provenance: the core's `inkflow.provenance`), svgops.py (write-back ops on one SVG:
                               attrs/style/paint/text/insert/delete/duplicate/order/group;
                               `OpResult.duplicates`: per duplicate op, every id copied ->
                               its copy's),
                               deckedit.py (libcst edits of deck.py: slide list, Slide(...)
                               args, animations=[...], zones={...}, imports; keeps comments;
                               the slide list is read as `Group`s (unsectioned + one per
                               Section) and every list edit is `restructure(groups)`: pure
                               `move_in_groups`/`add_section`/`remove_section`/
                               `move_section`, slides reindented to their new list; a
                               group may also carry a `Foreign` slide: one of another
                               version of deck.py with its comments, `slide_items`),
                               codegen.py (DSL object -> shortest constructor source; field
                               schemas for the property panels), session.py (one request ->
                               one undoable whole-file step; EditorSession/History; the
                               `fonts` action (report / bundle / set) and the `pack`
                               action (check / plan / apply, `gitPaths` for the commit);
                               `_Txn.copy` = a file copied in without its bytes;
                               the `svg` action with `zoneSlide` (the slide's own SVG):
                               deleting an element takes the content of every `zone-*`
                               inside it (Markdown section, zones= entry, Inline) and the
                               slide's `animations=[...]` of it and everything inside it
                               (`_drop_cues`; a zone's `-series-`/`-slice-`, a drawn-in
                               diagram's `<id>-` shapes), duplicating copies every zone's
                               content under its copy's id; `zone-format` (a zone's
                               `size`/`fit` on one slide: its marker's params or its
                               TextBox's fields, a zones= string moved to Markdown first;
                               a zone shape's own `--inkflow-font-scale`/`--inkflow-fit`
                               are the `svg` action's `style` op); a video
                               inserted anywhere is a new zone-video rect + a Video(...)
                               zones= entry in one step; the `ink` action adds / erases /
                               clears strokes, owner or share-link editor, and slide-list edits move a
                               slide's ink file when its id changes: `_follow_ink`; the
                               `slide` action's ops: new (optional `md` text) / delete
                               (`files`: also what the deck reaches only through it,
                               `slide_drop_files`) / duplicate / move (`slides` for several, `section`
                               target) / hide / title / id (ink and
                               `slide:` links follow) / detach / layout / font-size /
                               transition / section-add / -rename / -remove / -move
                               (`follow`: deck index whose new place comes back as
                               `select`); a request's `agent` text labels its step
                               "Agent: …" and `deckHash` must match the build; each
                               result lists `changes` and the step's `seq`, which
                               `undo` may name to take back only that step;
                               `delete-files` and `slide` (`_DELETES`) return `deleted`
                               (path, git state, size) + `written` + `repo`, and with
                               `dryRun` only that, nothing written; the
                               `rename` action (`from`/`to`, or `slide`/`stem`, `dryRun`
                               returns the plan) records file moves as `_Move`s without
                               their bytes and removes the folders a step empties),
                               agent/remote.py (one request from the CLI, any session action:
                               through the server serving the deck over the WebSocket,
                               waiting on `build-status` before and after, else an
                               offline EditorSession),
                               shapes.py (`inkflow shape`'s commands, run by the session's
                               `shape` action (`EditorSession._shapes`): each command runs
                               the editor's own actions (`svg` ops, `insert-textbox`,
                               `shape-text` (`zone`: a requested zone name),
                               `insert-chart` (`src`: an existing data file), `zone-text`,
                               `slide` detach) as requests of their own under one
                               `coalesce` key, so a batch is one History step that sees
                               its own earlier writes, taken back whole when a command is
                               refused; deck.py changed meanwhile is reloaded as
                               `_inkflow_shape_deck`, `shape_deck_hash` passing the build
                               check; a command object's first key names it),
                               scene.py (the slide composed from source as the canvas
                               shows it, own file key 0, + canvas.ts's connector logic:
                               corners/sites, `connector_path`, `is_stale`,
                               `with_connectors`, `move_ops`/`movingTogether`),
                               bbox.py (getBBox/getScreenCTM on lxml: transforms, nested
                               svg viewport+viewBox+preserveAspectRatio, zones as
                               `content.zone_box`, path tight bounds, `<use>`; `<text>`
                               estimated, so arrows never attach to plain text),
                               routing.py + geometry.py (ports of connectors.ts and
                               geom.ts with JS rounding/number printing; held to them by
                               tests/data/connector_routes.json, written from the TS by
                               make_connector_routes.mjs and checked by both
                               connectors.fixture.test.ts and tests/test_routing.py),
                               model.py (build_model: per-slide sources, zones, cues for the
                               editor; `ModelCache` keeps what it read of each slide's
                               files (`_slide_facts`) between a server's builds, the
                               positions and `usedBy` are put in each time; deck.py's
                               animation counts read once per content), drawioedit.py (a drawn-in diagram's shapes edited
                               on the slide: geometry/label/style/delete in its source,
                               the picture patched until draw.io redraws it), context.py (.inkflow/context.json for agents),
                               agent/outline.py (`inkflow outline`: `## <section>` lines, `STARRED` and `--starred`, per-slide files, layout chain,
                               zones with their origin, text, size and fit, animations and clicks, read
                               off `build_model` + the editor build; `--slide N` adds zone
                               boxes, canvas size and the slide SVG's named ids; with
                               `--boxes` also the rendered boxes of `render --boxes`),
                               transfer.py (clipboard bundles: copy slides/objects with their
                               files, paste into any project; pasted Slide(...) must pass the
                               `check_slide_code` allowlist, never arbitrary Python),
                               chartedit.py (the chart actions' checks: settings and grid
                               tables from the browser, `chart_json` for the model, the next
                               `data/chart-N.csv`),
                               compare.py (pure: `normalize_svg`, `pair_slides`,
                               `element_changes`, `compare_decks` over `DeckFacts`, the
                               CLI's text/JSON), comparesrc.py (compare sides: `Source`,
                               commits materialized into `.inkflow/cache/compare/<sha>/`,
                               worktrees, `build_side` with an injected loader,
                               `deck_facts`, `slide_paths` (the files a slide is made of,
                               by role), `shadow_css`, `display_svg`), comparehub.py
                               (the server's compare views: shared sides, live rebuilds,
                               folder watchers, `/_cmp/<token>/` assets, `take_request`,
                               `compare-sources`; see "The compare view" below),
                               filerename.py (rename/move a project file with every
                               reference following: `plan_rename` (no writes) resolves
                               each reference against the file it is written in (SVG
                               href/src/poster, CSS url(), inkflow:parent and preview-layer
                               markers via `_Chains`, Markdown images/links/chart `data:`,
                               deck.py literals via libcst) and re-expresses it in the same
                               style (bare layout name, `local:`, path); ids inferred from
                               renamed files follow (ink moved, `slide:` links rewritten);
                               `plan_slide_rename` = a slide's own files to one stem;
                               `reference_counts` (the rename's counts), `project_files`;
                               `file_uses` (the Files view): reachability from deck.py's
                               objects (+ any deck.py string naming a file) through
                               `_reference_graph` (preview-layer markers reach, never
                               count), states used/unused/orphan (only unused files name
                               it, `by`)/template (layouts/, overlays/ nothing uses);
                               `slide_drop_files` = reached before, not after a delete
                               (no layouts/overlays, inferred ink left to `_follow_ink`);
                               `plan_copy_in` = every file named outside the deck or
                               through a symlink copied in (assets/, layouts/,
                               overlays/, slides/) and its references re-expressed
                               relative by the same `_World` (`relative=True`), for
                               `inkflow pack`),
                               previews.py (layout gallery renders; like the model's
                               layout list, `layout.layouts_for`: built-in layouts
                               in the deck's shape, the project's own always; zones
                               show a template's hints; `roots` adds `base`),
                               master.py (the slide master: `layout_entries` (every
                               layout, the project's copy winning, parent, `slides`
                               on it directly, `reach` through it), `background_name`,
                               `overlay_entries`, `master_tree` (the editor's list),
                               `copy_bytes` (a theme file as the deck's copy: only
                               root attributes change, so locators hold; parent as
                               `builtin:`/`theme:`), `template_bytes` (a slide as a
                               layout: preview layers dropped, refs rebased, zones
                               empty, `<inkflow:hint zone>` prompts, pictures to
                               `zone-picture` rects), `overlay_bytes`, `master_slide`
                               (the one-slide composition `master-render` draws);
                               the session's `master` action (copy / revert / save /
                               rename / delete / new-overlay / add-zone / previews),
                               `master-tree`, `master-render`, and `copyLayout` on any
                               request with a `file`: `_copy_on_write` makes the copy
                               in the same step and points the request at it;
                               copy/revert/delete/new-overlay set `_previews`, so
                               `_refresh_previews` rewrites the deck's stale Inkscape
                               previews into that step after the commit; `attach`
                               joins the author's last step (leaving the master)),
                               placeholders.py (a layout's or overlay's zones as the
                               master edits them: `target` (the file, its copy's
                               theme original as an alias, the slides that get it,
                               child layouts), `placeholders` (kind from the name:
                               `is_media_zone`; prompt, nearest wins; box; `filled`),
                               `taken_ids`, `zone_name`/`name_problem`, `set_prompt`,
                               `plan_rename` / `plan_remove` = a `Plan` of writes made
                               without writing: the zone, prompts, `<style>`
                               `#zone-old`, arrows, `inkflow:default-zone` (set when
                               `content` is renamed), and per slide `zones.rename_zone`
                               on its Markdown (auto title/content get markers),
                               `rename_zone_key` / animation targets in deck.py;
                               refused when a slide already names the new zone or
                               shares its Markdown with a slide off the layout; the
                               session's `master` ops add-zone (`prompt`, `exact`, a
                               `layout`/`overlay` name, a default box), zone-make
                               (a drawn shape, `inkflow:show-shape`), zone-rename
                               (`dryRun` writes nothing, not even the copy),
                               zone-prompt, zone-remove (`dropContent`), and the
                               read `master-placeholders`),
                               themeedit.py (Theme
                               dialog: token overrides as one marked block in the project's
                               styles.css, values validated, never raw CSS; the session's
                               `theme-set` also takes `theme` = a `THEMES` name, written
                               as `Deck(theme=Paper())`), findreplace.py
                               (find/replace over SVG text, Markdown and deck.py author-text
                               literals only; `deckSlide` keeps deck.py to one slide's
                               text, the dialog's "This slide"), gitops.py (the Git menu: status, commit,
                               push/pull, discard, undo commit, branches, deck-scoped log,
                               view/revert/restore a commit, `lfs_status` = media
                               no LFS rule covers or committed as full copies, `lfs_track`
                               / `lfs_off`; `file_states` = per file committed/modified/
                               untracked/ignored/no-repo (one `status --ignored`);
                               `commit_with` (paths + blobs given as text, from an index
                               of its own), `diff_text`; shells out to git with
                               GIT_TERMINAL_PROMPT=0),
                               slidegit.py (each slide's changes since the last commit:
                               `changes` = per slide `new`/`modified`/`shared` from the
                               git status of its files (`slide_paths` + its style file +
                               `deck_inputs` = styles.css, scripts.js and their url()s,
                               embedded project fonts, project .py files in
                               sys.modules, a theme folder inside the deck; layouts,
                               overlays, deck inputs and files several slides use are
                               shared) and its `Slide(...)` entry against HEAD's
                               deck.py (`entries`, `match_entries`: same code, then the
                               same id / md / src with no other name disagreeing);
                               `slide_diff` (entry diff + git diff of its files);
                               `commit_plan`/`commit_slides`: a committed slide is
                               complete (a fresh clone shows it as it looks now): every
                               changed file the chosen slides are made of, shared and
                               deck-wide included (`touched` = other slides that change
                               with them, `missing` = ignored or outside-the-repo files
                               a clone lacks), + `partial_deck` = the working deck.py
                               with every other slide's entry as committed (`Foreign`,
                               comments kept), new ones left out, removed ones put back
                               unless `with_removed`; extra paths = ticked deleted
                               leftovers (any changed file is accepted);
                               `discard_plan`/`discard_writes` = the opposite (own
                               files from `gitops.head_bytes`, deck.py =
                               `partial_deck(others, with_removed=True)`, shared
                               files only when ticked); `slide_log` = commits that
                               changed its own files or its entry (each deck.py
                               blob's entries matched to the working entry); the
                               session's git ops `status` + `slides`, `slide-diff`,
                               `slide-log`, `commit-slides` and `discard-slides`
                               (`dryRun` = the plan; writes local only; a discard
                               is one History step), read off
                               `EditorSession.live` = the server's last editor
                               build),
                               problems.py (each slide's problems for the editor's
                               marks: `Problems.verify` = verify_slide for the
                               entries whose key (salted with deck.py's hash) is new,
                               stale-preview warnings dropped; `measure` = the
                               layout check (`Exporters.layout` =
                               `render.check_built`, handed in: render builds on the
                               server) for slides whose SVG digest (+ contrast) is
                               new, once `layout_on`; `json` = per deck index +
                               layout state; the server runs it after each build
                               (`EditorExtension.check_problems`) and on `problems-check`, sends
                               `{"type":"problems"}`),
                               comments.py (review comments: threads by slide id in
                               `.inkflow/comments.json` like stars: add (x/y or
                               `target`) / reply / resolve / delete (its starter
                               or the owner), `follow` id changes with the stars,
                               `visible`; the session's `comment` action (no History
                               step), the model's `comments`, the extension's
                               `{"type":"comments"}` to every editor),
                               worktrees.py (the session's `worktree` action and
                               `inkflow worktree`: `list_worktrees` = every worktree with
                               the deck.py at the same relative path, ahead/behind the
                               deck's branch, dirty, `main`; `add` = branch `deck/<name>`
                               in `<main worktree>/.inkflow/worktrees/<name>`, ignored by
                               git and unwatched, with a `note` when uncommitted deck
                               changes stay behind; `merge` = ff or a "Merge X into Y"
                               commit, refused while the deck is dirty, a conflict
                               aborted and named; `remove` refuses dirty/unmerged unless
                               forced, deletes only merged (or forced) `deck/` branches),
                               projects.py (new deck in one of seven
                               looks, each with `preview` colours for its thumbnail,
                               folder browsing, recent decks, `serve_elsewhere`: the
                               session's `open-deck-tab` (local only, unlocked) = the
                               deck's own server, started hidden like the launcher's
                               (`launcher.hidden_python`, `--no-open --quit-when-idle`)
                               when none has it, its `owner_url`), places.py (favourite
                               folders + the default deck location, user config dir),
                               stars.py (starred slides, the author's marks:
                               `.inkflow/stars.json` = `{"starred": [slide ids]}`,
                               not committed, unwatched, no History step; the
                               session's `star` action (`slides`: deck indices,
                               `on`), `follow` carries them through a step's id
                               changes (`_Step.ids`: `_id_changes` for the `slide`
                               ops, `RenamePlan.ids`), back on undo; a new slide's id
                               starts without one; the model lists them as `stars`,
                               the extension tells editors `{"type":"stars"}`),
                               nativedialog.py (the OS folder/file chooser shown by the
                               server: zenity/kdialog, osascript, PowerShell; `system-pick`,
                               local only), media.py (files of any
                               size: by path (`import_path`, local only) or in chunks
                               (`Uploads`), staged in .inkflow/incoming/ and moved into
                               assets/ in one rename; both return an `Arrival`, which
                               says `convert=True` for a video browsers cannot play but
                               ffmpeg can read (by path: converted from where it is;
                               uploaded: kept in incoming/<id>/ until converted, then
                               `discard_source`); `probe` (ffprobe), `issues`, `plan`
                               (ffmpeg MP4/WebM command + rough size, or `fmt="copy"`:
                               remux via `remux_target`, sound re-encoded only if it
                               does not fit), `Conversions` (background ffmpeg jobs,
                               also staged))
    online/           sharing online through a relay (see "Sharing online" below):
                               crypto.py (link/room secrets, `room_id`, HKDF, the
                               hello/welcome handshake `hello`/`accept`/`finish`,
                               `Session` seal/open with sequence numbers; AES-GCM
                               from `cryptography`, the optional `online` extra,
                               imported by name: `available`, `INSTALL_HINT`),
                               frames.py (envelope `pack`/`unpack`, `wrap`/`unwrap`
                               coding byte (host-only DEFLATE), `chunks`/
                               `Reassembler` below 512 KiB frames), relay.py (the
                               Python relay = `inkflow relay`: `Relay` rooms, host
                               proof, caps, `Bucket` rate limits, close codes, the
                               guest page as static files, `--dump`), host.py
                               (`OnlineHost`: the room, reconnects, `rotate`/`stop`
                               with `bye`; `Guest` per relay peer; `VirtualConnection`
                               shaped as a `ServerConnection`; `_Capture` turning a
                               routed HTTP response into `res`/`body`/`end`; `Hooks`
                               = the core's `serve_connection`/`serve_request`), extension.py
                               (`OnlineExtension`, below), config.py (`relay.json` in the
                               user config dir, `INKFLOW_RELAY_URL`/`_TOKEN`),
                               deploy.py (`inkflow relay deploy cloudflare`: stages
                               cloudflare/worker.js + guest/ with a generated
                               wrangler.toml, `npx wrangler@<pinned> deploy
                               --secrets-file`, the URL from
                               `WRANGLER_OUTPUT_FILE_PATH`), guest/ (the guest page:
                               index.html, `_headers`, `_guest/boot.js|sw.js` bundled
                               from src/ts/guest), cloudflare/worker.js (bundled from
                               relay/cloudflare/src/worker.ts)
    launcher.py       `inkflow setup-desktop`: an application-menu launcher (Linux
                               .desktop + icon, macOS ~/Applications/Inkflow.app, Windows
                               Start menu .lnk) running `<this python> -m inkflow edit
                               --start --quit-when-idle=60` hidden (pythonw on Windows;
                               `__main__.py` gives a console-less process devnull
                               streams), or in a terminal with `--terminal`
    agent/            the commands an agent uses, each a client of the session (registered on
                               the core's `main` by `agent.register`): context.py (context, outline,
                               goto, select, setup-claude; `current_slide` for the core's render),
                               compare.py (`inkflow compare [LEFT] RIGHT`),
                               comments.py (`inkflow comments [--all] [--json]`),
                               master.py
                               (`inkflow layout` copy/revert/save/rename/delete,
                               `layout placeholder` add/rename/prompt/remove and
                               `layout placeholders [--json]`, and
                               `inkflow overlay` new/copy/revert: the session's
                               `master` action through agent/remote.py), slides.py
                               (the `slide` group: add, delete, duplicate, move, hide, show,
                               star, unstar, rename, title, and `slide section`
                               add/rename/move/remove;
                               SLIDE = presentation number or id, SECTION = name or
                               1-based position; runs the
                               session's `slide` action via agent/remote.py, so with an
                               editor open it is an undoable "Agent: …" step there),
                               shapes.py (the `shape` group over shapes.py: add,
                               connect, sites, reroute, move, resize, align, distribute,
                               style, text, delete, duplicate, group, ungroup, order,
                               rename, lock/unlock, hide/show, link, batch, list; `-s`
                               defaults to the editor's slide in a fresh context.json),
                               _edits.py (`apply_edit`, `report_rename`: what slide, shape,
                               text and anim share; `DeckSlides` is the core's),
                               text.py (`find`/`replace`: the session's `find`
                               and `replace` actions over the files `build_model` lists
                               per slide, as the Find dialog sends them; `-s` sends
                               `deckSlide`, deck.py text of that Slide(...) only),
                               anim.py (the `anim` group: `list` = the slide built alone
                               (hidden ones as if shown), Markdown reveals read off its
                               `inkflow-step-*` data-cues and code highlight stages, then
                               `resolve_steps(animations, reveal max)`; add/set/move/
                               remove send the session's `anim` action (Animation panel
                               ops; `remove` takes `indices` for several in one step),
                               types from inkflow.animations + the deck module, targets
                               from the built slide's ids, nearest names on a miss),
                               files.py (`inkflow mv OLD NEW [-n]`: the session's
                               `rename` action, through agent/remote.py; slides.py adds
                               `slide rename-files`; `inkflow files [--unused] [--json]`
                               and `files clean [-n] [--templates]` = `delete-files`;
                               `_edits.deletion_warnings` = the dialog's git words),
                               worktree.py (the `worktree` group: add,
                               list, merge, remove over worktrees.py; `add` prints
                               `path:`/`deck:` on stdout). Submodules register on `main` by import.
    cli/              the editor's own commands: edit.py (`inkflow edit`: the core's
                               `serve` with `EditorExtension` + `OnlineExtension`
                               (`--share-online`) + other plugins' extensions; `setup-desktop`),
                               pack.py (`fonts bundle`/`fonts set` on the core's `fonts` group,
                               `inkflow pack [--zip] [-n] [--with-pdf-pages]`), relay.py (`inkflow
                               relay`)
    editor.html       visual editor shell, served at /edit (editor bundle + deck styles)
    claude/SKILL.md   the inkflow skill `inkflow setup-claude` installs into a project
    completions/      inkflow-editor.yaml: carapace blocks merged into the core's spec
    templates/        example/: the demo deck's look (footer overlay + styles) for the
                               editor's "Inkflow example" new deck
    bundles/          editor.js/.css (src/ts/editor, src/css/editor; committed)
  src/ts/             TypeScript (imports the core's client library as `@inkflow/shared/*`)
    globals.d.ts      `__MODEL_JSON__` (the core's globals.d.ts has the rest)
    editor/           (editing together: collab.ts = presence (avatars, slide
                      dots, others' selections via `hooks.drawPeers`, the name
                      dialog), share.ts = the owner's Share… dialog (links, QR
                      via qrcode-generator, New links, Disconnect; in SSH mode
                      "Turn on links", localhost links without QR),
                      sshdialog.ts = its "Share via SSH" view (not SSH mode: move
                      the deck to a server, steps + Next time; SSH mode: the
                      collaborator's tunnel + link message per role) over
                      sshtext.ts (pure + tested: `shellQuote`, commands, messages),
                      conflict.ts = the box keeping typing a stale write
                      refused; shared/identity.ts = name + private key in
                      localStorage, shared/wsurl.ts = `socketUrl(location)` and
                      `openSocket()`: the relay channel when the page runs in
                      the guest page's frame; share.ts's Online section, its
                      words in sharetext.ts)
                      visual editor: canvas.ts (render + fit, the "Doesn't fit" badge, hit-testing, handles, drag ->
                      attribute plans), geom.ts (pure matrices + move/resize/rotate plans),
                      snap.ts (smart guides), textedit.ts, insert.ts (tools, images,
                      paste), sorter.ts (slide list rows + the drag model shared
                      with grid.ts; `Thumbs` draws a thumbnail when it nears the
                      part of its list on screen and empties it when it leaves
                      (IntersectionObserver on the scroller); `renderSorter`
                      redraws only the rows whose picture changed and just moves
                      the marks when none did), sections.ts (pure: rows, drop targets, move
                      requests), sectionui.ts (section headers, collapse state in
                      localStorage, section menu, rename, section-* edits), props.ts (its Text size section: A−/A+, a typed size, Shrink text to fit, Make box taller), notes.ts (the speaker notes panel: Write = the Markdown, saved as typed; Preview = the built `SlideData.notes` HTML, `slide:` links followed; its top edge `#notes-resize` drags the panel's height (`--notes-h` on `#workspace`); height and view kept in localStorage; pure height maths in notestext.ts, tested), toolbar.ts (shortcuts),
                      panels.ts (the slide list, notes and properties each
                      hidden and shown: `body.hide-left|bottom|right` set
                      `--sorter-w` / `--notes-row` / `--props-w` on
                      `#workspace` to 0 (css/editor/panels.css), a `.panel-tab`
                      on each edge of the canvas and the keys 1 2 3, kept in
                      localStorage; pure part in panelstext.ts, tested),
                      stars.ts (starred slides: `S`, the ☆ on a slide's row
                      and grid tile, the slide panel's Starred, the grid's
                      "Starred only (N)" filter; `ed.model.stars` + the `stars`
                      message; pure part in starstext.ts, tested),
                      context.ts (agent context + goto/select), net.ts (edit-op requests),
                      animpreview.ts (▶ Play in the Animation order list and an
                      animation's panel: shared/step.ts runs played on the canvas
                      click by click, in preview mode; Esc/a click/a re-render
                      stops it), animsteps.ts (`cueSteps`: each listed
                      animation's click, read off the built slide's data-cues),
                      clipboard.ts (system-clipboard copy/paste of slides and objects),
                      richtext.ts (zone HTML <-> Markdown for in-place rich editing; throws
                      Unsupported rather than drop content), crop.ts, objects.ts (Objects
                      tab: hide/lock), gallery.ts, grid.ts (grid view of all slides;
                      shares sorter.ts's Thumbs cache class and slide menu), theme.ts
                      (its Fonts section: the session's `fonts` report colour-coded,
                      Bundle fonts into the deck with the licence warnings in a
                      confirm; font fields send `fonts` op `set`),
                      find.ts, exportdlg.ts, openwith.ts ("Open ▾" in other programs),
                      decks.ts ("deck ▾": new/open/recent decks, start page;
                      `openDeckInTab`: ⧉ / Ctrl+click on a recent deck, "Open in a
                      new tab" in Open deck…, the tab opened at the click and sent
                      to the `open-deck-tab` result's URL),
                      folderpicker.ts (the folder picker those and the video picker
                      share: Tab completion, type-to-filter, keyboard list, places,
                      Browse… = system dialog; its pure path maths in pathtext.ts),
                      rename.ts ("Rename…" beside a file's Open ▾, "Rename files…"
                      for a slide, the deck menu's "Files…" view: a dialog that
                      previews the session's `rename` dry run as the name is
                      typed; path maths in pathtext.ts; the Files view's states,
                      git badges, Pick all unused, Delete…), deletedlg.ts (the
                      delete-from-disk dialog: a `dryRun`'s `deleted` files with
                      git badges and warnings; slide deletes' "Also delete its
                      files from disk") over deletetext.ts (pure words; tested),
                      master.ts (the slide master: "Slide master" in the
                      toolbar; its list replaces the sorter (`#master`), each
                      entry drawn by the session's `master-render` into
                      `ed.master`, which `currentSlide()`/`currentRendered()`
                      return, so the canvas, insert tools and panels work
                      unchanged; only `ed.master.path`'s objects select, the
                      others get `.master-context`; a theme file's source gets
                      `copyTo` and net.ts adds `copyLayout` to requests naming
                      it, then follows `copied`; Save as layout…, New overlay,
                      placeholders, rename/delete/revert dialogs; the props
                      panel's `masterPanel`) over mastertree.ts (pure: the
                      layout tree under the background, badges, usage words,
                      `copyTarget`; tested); placeholders.ts (the add / make
                      placeholder dialog, the panel's Placeholder section: name
                      with a `zone-rename` dry run as it is typed, prompt,
                      Remove; `ed.master.placeholders` from
                      `master-placeholders`) over placeholdertext.ts (pure: the
                      server's name rules, panel words; tested),
                      git.ts (Git menu; its Worktrees section: rows with
                      Compare = `inkflow:compare` CustomEvent {kind: "path",
                      deck, label} for the compare view, a dialog with what to
                      tell the agent (worktreetext.ts, pure + tested), Merge,
                      Remove with a force retry, New worktree for an agent…;
                      "Published at <url>" + Publish… → publish.ts: host,
                      release, README link, files to write, then commit + next
                      steps; its pure parts in publishtext.ts, tested; Pack deck…
                      and Commit's pack question → pack.ts: `pack` op `check`
                      first, "Pack and commit" (focused) = op `apply` then commit
                      the ticked paths + its `gitPaths` in the same commit,
                      "Commit without packing (not recommended)"; its words in
                      packtext.ts, tested),
                      canvasmenu.ts (right-click menu on the canvas; text fields and
                      Shift+right-click keep the browser's), videopreview.ts (canvas
                      videos lose controls + pointer events so they select and drag;
                      "Play preview" plays one in place; the presenter is unaffected),
                      videocheck.ts (Video check after insert: browser decode test +
                      ffprobe issues; Convert dialog with remux/presets/quality/
                      estimate; `convertForInsert` makes it mandatory for formats
                      only ffmpeg reads),
                      drawioshapes.ts (a drawn-in diagram's shapes for the
                      Shapes/Animate list),
                      pdfpages.ts (a PDF figure's page: `choosePage` dialog of
                      thumbnails from the `pdf-pages`/`pdf-page` session actions;
                      `sourceRef` = `data-inkflow-pdf` or the href, what the panel,
                      Open ▾ and copy write back),
                      drawio.ts (draw.io embed mode in a full-screen iframe, JSON
                      postMessage protocol checked by source + origin: configure
                      → load → save → export xmlsvg → `drawio-save`; a new diagram's
                      picture is placed on first save via insert.insertDiagramImage),
                      stylecopy.ts (format painter: Copy/Paste style, Ctrl+Alt+C/V;
                      theme colours go through the server's `paint` op),
                      dialog.ts (the one modal), connectors.ts (connection sites
                      and straight/elbow/curved routes, pure + tested),
                      chart.ts (the chart dialog: data grid, settings, server-drawn
                      preview; insert-chart / chart-save-data) over chartgrid.ts
                      (pure: TSV paste, grid edits, series settings; tested),
                      ink.ts (the pen tool: one session `ink` step per stroke /
                      erase / clear), touchzoom.ts (the canvas's `GesturePad`:
                      pinch / Ctrl+wheel -> canvas.zoomAbout, one finger
                      deferred), compare.ts (the compare view: paired list,
                      side by side / slider / difference, outlines, notes diff,
                      picker, Take this slide, Merge branch; `openCompare(…,
                      {focus})` starts on a right-hand slide, `focusRow`) over
                      comparelib.ts (pure: rows, jumps, badges, word diff,
                      take/merge rules; tested), slidegit.ts (each slide's
                      U/M/• mark on its list row and grid tile, from the
                      `slides` git.ts asks for with every git status and after
                      every git op (`setSlideChanges`, event `slide-git`); the
                      slide menu's Compare with the last commit, Show git diff
                      and Commit this slide / N changed slides…; the
                      commit-slides, discard and slide history dialogs,
                      `jumpToChange` (Alt+F5), `isMarked` for the grid's
                      "Changed only") over slidegittext.ts (pure words;
                      tested), problems.ts (the ⚠ marks, the toolbar's
                      `#btn-problems`, the Problems list with the layout
                      check and its contrast setting: `problems-check`) over
                      problemstext.ts (pure; tested), comments.ts (Shift+C,
                      pins via `hooks.drawComments`, the 💬 marks, a slide's
                      threads dialog) over commentstext.ts (pure; tested),
                      keys.ts (the shortcuts on the page: `commandFor`/
                      `matches`/`keyLabel` over the person's own keys in
                      localStorage, `data-keys` titles retitled, the Keyboard
                      shortcuts dialog, the toolbar's ? Help menu
                      `#btn-help`; toolbar.ts's `COMMANDS` run them) over
                      keystext.ts (pure: `SHORTCUTS` with defaults, fixed
                      ones only shown, `comboOf`, `assign`/`reset`; tested),
                      palette.ts (Space / Ctrl+K / Ctrl+Shift+P: the
                      toolbar's buttons by title, editor commands,
                      `gitCommands`, `deckCommands`, every slide) over
                      palettetext.ts (pure `score`/`rank`/`fromTitle`;
                      tested)
    guest/            the guest page for sharing online (bundled into
                      src/inkflow_editor/online/guest/_guest/): crypto.ts (Web Crypto
                      twin of online/crypto.py), frames.ts, channel.ts (`Channel`:
                      handshake, sealed frames, `RelaySocket` page connections,
                      `fetch` through the host), boot.ts (top mode: link from the
                      fragment -> sessionStorage, service worker, channel, the
                      page frame; frame mode: the host's page for this address,
                      document.open/write), sw.ts (the service worker)
  src/css/editor/     the editor's styles (index.css imports the core's src/css/shared)
  relay/
    cloudflare/         the relay as a Cloudflare Worker (src/worker.ts: one Durable
                        Object per room, Hibernation API; wrangler.toml for `wrangler
                        dev` from the repo; its own package.json/tsconfig with
                        @cloudflare/workers-types, `pnpm install --ignore-workspace`)
    e2e/online.e2e.mjs  sharing online end to end in Chromium (Playwright), against
                        the Python relay or the Worker under `wrangler dev`
  tests/              the editor's tests (their own pytest session: `cd inkflow-editor &&
                               uv run pytest`); serving.py = a deck served with `EditorExtension`
                               on a thread (`serve_deck`); data/ = connector routes (shared with
                               vitest), online vectors, a draw.io file
```

## Key architecture decisions

**The editor in the core's server (`server.py`).**
`EditorExtension` holds what the server once kept for the editor: per served deck (`open`) one `EditorSession` (given by the caller in tests: `EditorExtension(session=…)`), a `CompareHub` and `Problems`; the editor pages' connections (`hello` with `role: "editor"`); the last deck that built. Per build: `before_build` takes the session's `snapshot` (the build id stale writes are checked against), `build` makes the model (`build_model` with the extension's own `ModelCache`, emptied when the core's build is `fresh`), stamps `build`, keys its slides and computes the patch against the last model; `built` commits them, tells the session `built_hash` and `live`, sends `editor-model` (whole or as a patch, per page), starts the problem checks and feeds the compare views' live side. The core announces the build in `build-status` only after this, so an agent's command waiting for its edit's build finds the session on it. An `edit-op` from an admitted page arrives through `message` (the core has already refused it from a view link): `edit_op` sets `_local`/`_role`/`_author`/`_name` from the connection's client, applies it, answers with `edit-result`, then tells every editor what follows (stars, comments, each person's Undo/Redo or an agent's step); a session that switched decks or quit asks the server through the `ServerContext` (`open_deck`, `shutdown`).
`OnlineExtension` (`online/extension.py`) is sharing online as an extension of its own: the room on a relay, its status and links in the owner's `share-status` (`share_status`), the dialog's `online-*`/`relay-set` operations (`share_op`), the terminal's lines (`share_lines`), and each guest's page connection and GET run by the core as if from its own port (`ServerContext.serve_connection`/`serve_request`), for the guest's role.

**Renaming a file rewrites every reference to it, by the same rule.**
`filerename.py` finds references where they are written and resolves each against its own file (never by matching a name across the project), then writes the new one in the style it was written: a bare layout name stays a name (`local:` when a `slides/` file would shadow it), a path stays a path relative to its file, a `#page=` stays. SVGs are rewritten by a small tokenizer (only the attribute values change), contents of preview layers are copies and left alone, but their markers are followed through the chain that declared them (`_Chains`: an ancestor's parent is relative to that ancestor). The session applies the plan as one step whose moves are kept without bytes (videos), so undo moves files back and restores the folders; the extension never changes; `styles.css`, `deck.py` and files in hidden folders are refused. `inkflow mv` and `inkflow slide rename-files` are the same action from the CLI.

**The visual editor writes the deck's own files; it has no document model of its own.**
`inkflow edit` (or `/edit` on any `serve`) is a second page on the same server. The server builds with `process_deck(editor=True)` (the extension's `provenance = True`), which stamps every element read from a source file with `data-ink="<source index>:<child path>"` — the child path counted on the tree *as parsed from disk*, before cleaning (`clean_inkscape_tree(before_clean=...)`), so `provenance.locate` finds the same node when an edit is written back. `SlideData.edit` carries the source list, the pruned empty zones and where each zone's content was written; the pages' copies drop it (the core's `_without_edit`), the editor gets it inside `build_model`'s model (`editor-model` message, sent by the extension's `built` after each `update` to clients that said `hello` as editors).
The browser never writes a file: it sends `{"type":"edit-op", "action": ...}` and `session.EditorSession` turns that into new bytes for SVGs (lxml, only touched nodes change), Markdown (`zones.zone_spans` mirrors the parser to replace one zone's section) or `deck.py` (libcst via `deckedit`, values generated by `codegen` from the real DSL object so the dataclass validates them). Each request is one `History` step of whole-file before/after snapshots; undo refuses if a file changed outside the editor. So an agent changes the slide list through the session too: `inkflow slide` (`agent/slides.py` → `agent/remote.py`) sends the same `edit-op` to the server serving the deck (found with `instances.serving`), with `agent` (the step becomes "Agent: …") and `deckHash` (the deck.py it numbered slides against; refused unless that is the build), and polls `{"type":"build-status"}` (`deckHash`/`failedHash` of the last build) until the build caught up, before and after; the server then tells every editor `{"type":"agent-edit", label, step, undoLabel…}`, shown as a toast whose Undo sends `undo` with that `step` (refused once another step followed). With no server it applies the request with a fresh `EditorSession`. Undo/Redo buttons are titled with `undoLabel`/`redoLabel` (in each result and in `editor-model`'s `history`). An SVG request carries the file hash the client rendered from and is refused when stale; results return new hashes so quick consecutive edits chain. Writes go through the normal watcher → rebuild → push, which is also how the editor, Inkscape and an agent see each other's changes. `load_deck` compiles deck.py from source each time (the bytecode cache's whole-second mtime check loads stale code after a same-size edit such as a slide reorder).
The client previews a drag by setting attributes on the live DOM and sends the same plan (`geom.ts`: x/y/width/height for rects/images/rect-backed zones, cx/cy for ellipses, endpoints for lines, a merged leading translate for everything else, a matrix for resize/rotate of transformed elements). Objects from layouts/overlays and slides drawn straight from a shared layout are not selectable outside "Edit layout"; drawing on such a slide first gives it its own `slides/<id>.svg` built on that layout (never named like a layout, which would shadow it). `.inkflow/` (editor context, renders) ignores itself in git and is excluded from the watcher.
Everything the editor adds is plain deck source, so Inkscape, an agent and the presenter need no editor knowledge: a **text box** or a **video placed anywhere** is a `zone-text`/`zone-video` rect in the slide's own SVG filled through the slide's Markdown or `zones={...}` (deleting or duplicating such a rect takes its content along — `_svg` with `zoneSlide`); **rich text** is edited as the zone's rendered HTML and written back by `richtext.ts`, only when serializing the zone as rendered gives back its source (`sameMarkdown`), otherwise the Markdown pane opens; a **crop** is a nested `<svg x y width height viewBox>` frame around the `<image>` (the canvas measures it by its viewport, not getBBox); a **connector** (line/arrow; four tools: line, arrow, elbow, curve) is a `<path>` with `inkflow:connector="straight|elbow|curved"` and `inkflow:connect-start/-end="<id>:<site>"`, a site being a side (`top`, its middle) or `side@fraction` (`top@0.25`, clockwise from the side's first corner) — a shape's `inkflow:sites="N"` only decides how many points per side are *offered* (copied onto a zone's foreignObject by `content.py`), a named site is always computable, so fewer points later never detaches an arrow; an elbow's adjustable segment is `inkflow:bend="x:640"` (axis and slide-unit coordinate, ignored when the route's axis changes) with a drag handle; `connectors.ts` holds the pure site/route maths, `canvas.withConnectors` re-routes attached connectors inside every `sendSvgOps` (so drags, nudges and geometry fields all carry them in the same step), connector moves detach ends whose shapes do not move along (`movingTogether`), and an id rename rewrites `connect-*` references (`svgops._rename_connections`); a shape moved elsewhere leaves its arrow until "Re-route all" (or `inkflow shape reroute`, the Python port in scene.py; `verify` warns about such arrows); a **link** is an `<a href>` wrapper that provenance treats as transparent (`is_link_wrapper`: the object inside stays the selectable one), and `pipeline.resolve_links` turns `slide:<id>` into `data-inkflow-slide` and gives web links `target="_blank"`; **slide text goes to Markdown**: a zone write on a slide with no `.md` (`_slide_markdown`) creates `slides/<slide-id>.md` named after the slide's *current* id (ids are inferred from the md stem, so `slide:` links survive; `id=` is written when the name is taken), sets `md=`, and moves the slide's plain-string `zones={...}` into it in the same step; `TextBox` and `md=Inline` stay in deck.py (the `to-markdown` action converts those on request); **text in a shape** is that shape renamed to a `zone-text*` zone plus `inkflow:show-shape="true"` (centred both ways via `--inkflow-align/-valign` in its style unless already set), which makes `content.zone_shape_css` paint the shape's own fill/stroke/rx as the text box's CSS (without it a zone shape stays an unpainted placeholder; `--inkflow-padding/-align/-valign` in its style carry over either way); a **formula** in rich text is a chip around the rendered `<math data-latex>` (`markdown._math_to_mathml` stamps the source), edited through the `math` session action, which renders exactly as the build does; **lock** is `inkflow:locked` (survives the pre-commit cleaner, unlike `sodipodi:insensitive`), **hide** is `display:none`; **theme** edits are one marked block in `styles.css`. A rebuild pushes the deck stylesheet and colour mode on `update` only when they changed (`styles`/`mode` keys, `shared/deck-styles.ts`), so theme edits restyle open pages without a reload. **Open ▾** (`openwith.ts`) asks the session for `open-apps` (`edit.open_choices`: the configured `INKFLOW_EDIT_CMD*` command, installed programs for the file's kind, the system opener) and launches with `open-file`, which only takes project files of a known kind and only from the owner (the extension sets `_local` = owner on every edit-op from the connection's role, overwriting the client's); for an SVG it first brings the Inkscape preview (layout layers + theme CSS, what `sync` writes) up to date as one History step, and `_new_slide_file` writes it on creation, since Inkscape draws only what is in the file. **Ctrl+drag** copies: `canvas.ts` previews by moving the originals with stand-in clones (`showGhosts`) left in place, and drops `duplicate` ops whose `set`/`kids` carry the move's attributes for the copy (resolved before any op runs); `apply_ops` re-attaches connectors copied together with their shapes. **draw.io diagrams**: `drawio-load` (source + `INKFLOW_DRAWIO_URL`, default embed.diagrams.net) / `drawio-save` (normalized SVG; no path = new `diagrams/diagram-N.drawio.svg`; `image` = the slide's picture keeps its width and takes the new height, same History step); without internet (`navigator.onLine` false, or no `configure`/`init` from the frame within 15 s) `drawio.ts` offers draw.io desktop: `drawio-new` writes `drawio.blank()` (an empty source behind a placeholder picture), the picture is placed, and `open-file` launches the app (`edit` kind DIAGRAM; Open ▾ never writes Inkscape preview layers into a `.drawio.svg`). "Show as" in a diagram's panel sets `inkflow:drawio` (plus `ensure-id`); a drawn-in diagram (`drawio.drawnDiagram`) selects, moves, resizes and rotates as its `<image>`, and `selectById` climbs from a shape to it. Its vertex cells (`data-cell-kind`, read from the source by `drawio.cells`) are connector targets too (`canvas.attachables`/`attachTargetAt`, sites on `drawioshapes.cellShape`, not the label); renaming the picture renames `<id>-*` connections and cues (`OpResult.renamed_prefixes`); a save through the editor re-routes the arrows into it in the same step (`coalesce`), and the slide panel counts arrows whose ends no longer meet their shapes (`canvas.isStale`). **Editing a diagram's shapes on the slide** (`inkflow:drawio-edit="shapes"`, "Edit shapes here"): editor builds stamp vertex cells `data-ink="<k>:#<cell>"` (and layers, so `enterGroup` survives re-renders) into a source of role `diagram`, plus `data-cell-geometry` (the page box the drawing shows); double-click enters the layer, `canvas.diagramPlans` turns plans into `cell-geometry` (the shape's measured page box: drawn box − `drawioshapes.pageOffset`, the median of drawn − geometry), `cell-delete`; the panel sends `cell-label`/`cell-style`; the session routes a `.drawio.svg` `svg` action to `drawioedit.apply_cell_ops`, which edits the mxGraphModel and patches the picture meanwhile (moved shapes under a transform, `data-drawn-geometry`). `hooks.diagramEdited` → `drawio.diagramEdited` debounces a redraw: a hidden, `inert` draw.io frame loads the source and exports xmlsvg, `alignedBox` measures how the page moved (median per shape, rendered off-screen) so unmoved shapes keep their place, and `drawio-save` (`box`, `expect` = the hash `drawio-load` returned, `coalesce` = the edit's step) writes both in the edit's undo step. **Quitting**: the `quit` action (local only, "Quit Inkflow") sets `session.quit_requested`, and the extension asks the server to `shutdown()`; `serve(quit_when_idle=…)` adds `_quit_when_idle`, which stops the server once `ws_clients` has been empty that long. **Start mode**: `serve(None)` (allowed because `EditorExtension.serves_without_deck`) / `EditorSession(None)` (`has_deck=False`): the extension's `http` answers the owner with the editor's start page at any path (`decks.showStart`), allowing just the project actions; opening a deck switches the server as usual and the page goes to `/edit`. An empty zone's **+** label writes the zone's name as its text and opens it for rich editing with that text selected (`afterRender.placeholder`); finishing with it untouched or empty, or Escape, undoes that write. **Decks and git**: `serve()` loops over `_serve_deck`, which returns the deck.py the editor asked for (`EditorSession.switch_to`, set by `open-deck`/`new-deck`, handed to the server by the extension: `ServerContext.open_deck`) and starts again on the same port; an editor page reloads when a model for a different `deckPath` arrives. Git operations, folder browsing and deck creation go through the same session (`git`, `browse`, `new-deck`, …); every git operation that writes (commit, push/pull, `git init`, switch…) and anything touching paths outside the deck are refused unless the request is the owner's, and operations that rewrite files reset the editor's History (the result carries `historyCleared`; `git.ts` warns once per session before the first one). **Worktrees** (`{"action":"worktree","op":"list"|"add"|"remove"|"merge"}`, worktrees.py; add/remove/merge local only) let an agent work on branch `deck/<name>` in `.inkflow/worktrees/<name>` while the author edits on: list → `{worktrees:[{name,path,branch,head,deck,dirty,ahead,behind,main}]}`, add → `{worktree, note?}`, merge → `{message, files, historyCleared}` (only when files changed), remove (`force`) → `{message}`; every result also carries the fresh `worktrees`. The agent's own server for its worktree deck is a second server on the next free port. Exports run through `Exporters` (`server.default_exporters`: the core's `export`/`render` builds, handed to the session) and are downloadable at `/_export/<token>/…`, which serves only what the session exported.

**Several people edit one deck through one session; each undoes their own steps.**
`History` is shared, but every `_Step` has an `author` (`collab.Client.author`:
`"owner"` for the owner's pages and agents, `guest:<page key>`) and `name`. Undo
takes back the author's latest step only when no later step (anyone's) wrote one
of its files (`History.blocker`; else refused with `blocked` and the other's
name: "Ana changed a.md after you"); redo likewise; a new step clears only its
author's redo; typing coalesces only within one author. `history_state(author)`
is per person, so `editor-model` and the `history` message after every change
are sent per client (`EditorExtension.send_editors(callable)`). Writes are serialized by the
session's lock (`_UNLOCKED`: long reads like export). **Stale writes are
refused, never merged:** each rebuild takes `session.snapshot()` (every project
file's mtime+size) and stamps its number into the model (`build`); every page
request carries `baseBuild`, and `_check_fresh` refuses (`stale`, `by`, `path`)
a write to any file (and deck.py, whose numbering every request relies on)
changed since that build, unless the change is the requester's own still
rebuilding (`last_writer`: author + hash). Text edits pin the build they began
on (`textedit.ts`); when only something else changed (another zone, deck.py)
they save again on the newer build (`zoneUnchanged`), otherwise `conflict.ts`
shows the typing to copy or put back ("Use mine instead"). A guest's write never
creates code or settings (`_guest_writes`: `.py`, scripts, `.toml`/`.lock`,
anything in a hidden folder), and every machine-reaching action is `_local_only`
(Open in programs, git writes, decks/browse/system-pick/places, import by path,
files outside the deck, worktree add/merge/remove, publish setup, pack, fonts
bundle, quit).

**Sharing online: a dumb relay, end-to-end encryption, guests as virtual connections.**
The host (`online/host.OnlineHost`, started by the Share dialog's `share` ops
`online-on`/`-off`/`-rotate`/`relay-set` or `--share-online`) connects out to
the relay's `/_relay/host?room=<id>` with `Inkflow-Room-Secret` (room id =
b64url(SHA-256("inkflow-room/1" + secret))[:22], so a guest link cannot host)
and, if the relay has one, `Authorization: Bearer <access token>`. The relay
(Python `online/relay.py` or the Worker, same rules, tested by the same
`TestAnyRelay` with `INKFLOW_TEST_RELAY_PORT`) forwards binary frames: host side
`u32 peer + frame`, guest side the frame; text `ready`/`join`/`leave` to the
host and `kick` from it; a room lives while its host is connected (4404 no
room, 4410 host gone, 4409 full, 4401 refused, 4403 kicked, 4429 rate, 4408
replaced). Crypto (`online/crypto.py` = `src/ts/guest/crypto.ts`, held together
by tests/data/online_vectors.json): per-role 32-byte link secrets in the link
fragment (`<relay>/#r=<room>&k=<secret>`); `hello` = guest nonce + HMAC(auth key);
the host tries each role's auth key (the one that matches is the role) and
answers `welcome` = host nonce + HMAC over both (only the host can); session keys
per connection and direction = HKDF(link secret, both nonces); frames =
`0x03 | seq u64 | AES-256-GCM` with the header as AAD, each side expecting the
next seq (replay/reorder/tamper ends the guest). Messages (`online/frames.py`):
a coding byte (DEFLATE from the host only; the host refuses it from guests),
envelope `u32 len | JSON header | body`, chunks of < 512 KiB. Inner protocol:
`open`/`ws`/`close` per page connection `c`, `get`(path, range)/`cancel` ->
`res`/`body`/`end`, `hi` {role}, `bye` {reason}. Each `open` becomes a
`VirtualConnection` run through the deck server's own WebSocket handler
(`ServerContext.serve_connection`, joined as a `collab.Client` with
`online=True`), and each `get` through its HTTP route
(`ServerContext.serve_request`) for that role, so roles,
`allowed()`, presence, per-person undo, stale-write refusal and owner-only
actions are the LAN ones; open byte ranges are capped at 4 MiB. LAN share
off/rotate leaves online guests alone and vice versa; a deck switch drops the
online pages' connections (they reconnect to the new deck). The guest page
(`src/ts/guest`, static on the relay; the relay answers every navigation with
index.html): **top mode** reads the fragment, keeps the link in sessionStorage
(the address bar loses the key; a reload or a window the page opens finds it
there), registers `/_guest/sw.js` (scope `/`, `Service-Worker-Allowed`), opens
the `Channel` and shows `/edit` (editor link) or `/` in a full-window iframe;
**frame mode** (the same index.html inside that iframe) fetches the host's page
for its own path through `parent.__inkflowRelay` and replaces itself with it
(`document.open/write`), so the host's own editor/presenter of its own version
runs at the right path. Its socket is `wsurl.openSocket()` -> `RelaySocket`; its
subresource requests (pictures, fonts, video ranges, downloads) reach the
service worker, which posts them to the requesting client (`inkflow-fetch` +
MessagePort), whose boot.ts forwards them through the channel and streams the
answer back (no keys or channel in the worker, nothing else routed). Chosen over
rewriting URLs to blob:, which would need every asset (videos) fetched up front.

**The compare view builds both decks in one server (`comparehub.py`).**
A side is a `comparesrc.Source`: `{"kind":"live"}`, `{"kind":"commit","rev"}` (any rev git resolves; refused if it starts with `-`), `{"kind":"path","deck"}` (a deck.py or its folder; outside the project only for a local request), `{"kind":"branch","name"}` (its worktree when one has it checked out, the live deck if that is this one, else its commit; a remote request falls back to the commit), plus `{"kind":"spec","spec"}` for `?compare=` (`inkflow edit --compare REV|PATH`) and the CLI, resolved by `spec_source`. A commit is materialized into `.inkflow/cache/compare/<sha>/` (ignored, unwatched) with a throwaway `GIT_INDEX_FILE`: `read-tree` + `checkout-index` of the deck's folder only, so filters run (LFS smudged; `filter.lfs.required=false`) and nothing is registered as a worktree; a pointer left over is replaced by the working copy's file when its sha256 is the pointer's oid (`missing` lists the rest); `prune` keeps the 6 most recent plus those in use. Other decks load as their own module (`load_deck(path, module)`, `build_model(deck_module=…)`), never `_inkflow_deck`, so the served deck's custom classes stay the session's; comparesrc/comparehub cannot import server.py (a cycle), so the loader is handed in (`CompareHub(deck, load_deck)`). The live side is the server's own build (`side_build_from` after every `rebuild`), never rebuilt by the hub. Protocol: `{"type":"compare-open","view":n,"left":src,"right":src}` → `{"type":"compare-model","view":n,"left":side,"right":side,"deck":[…],"pairs":[pair_json…]}`, where a side carries `kind/label/branch/sha/live/deckPath/token/missing/error/source`, `css` (its `load_deck_styles` with `:root` aimed at `.cmp-root`, `@font-face` split off into `fonts` for the document; `shadow_css`) and `slides` (`display_svg`: no `data-ink*`, pictures at `/_cmp/<token>/<ref>?v=<mtime>`, plus plain-text `notes`); re-sent to every page comparing a side whenever it rebuilds (live: each rebuild; a path side: its own `awatch`, ignoring its `.inkflow/`/`build/`/`.git`; a commit: never). `{"type":"compare-close"}` (or disconnecting) drops sides nobody compares, their tokens and modules. `{"type":"compare-sources"}` → commits, branches and worktrees for the picker; failures answer `{"type":"compare-error","for","view","message"}`. `/_cmp/<token>/<ref>` resolves with that side's own `AssetRoots.locate` and the served-suffix list, so it reaches nothing outside that deck's roots. Pairing (`compare.pair_slides`): ids that name a slide whatever its place (explicit, or an inferred id no other slide shares), then the file it is written in (`key_file`: its Markdown, or its own unshared SVG), then identical normalized SVG+notes, then the remaining ids (`content-2` numbering), then what is left by order between pairs kept in order, only when built on the same layout or file (`_related`); rows follow the right deck, a slide only on the left before what was added in its place; `moved` = outside the longest in-order run. Normalization drops `data-ink*`/`data-cell-geometry`/`data-drawn-geometry`, `?v=` stamps, the root's `inkflow-slide-N` id and its `@scope`, and the slide number/total texts. A pair is `changed` when the normalized SVG, the notes text, the slide's settings (`_slide_settings`: hidden, layout, id, title, md, notes file, transition, animations, zones, overlays, style, font size; model JSON minus `custom`/`path`/chart columns) or its files (sources by role, md, notes, ink, chart data, pictures) differ. `element_changes` matches elements with an id by id, the rest as sequences under their nearest named ancestor (`difflib`), leaf units being SVG shapes and HTML blocks; boxes are approximate server-side (transforms, path points, a foreignObject's box for its HTML) and the page measures the element at the same child-index `path` in the shadow DOM instead when it finds it. The page draws each slide in a shadow root with the side's constructed stylesheet (both in the colour mode the editor's light/dark button shows), so neither deck's CSS reaches the other or the editor. "Take this slide" is the edit-op `compare-take` (`pair`, `left`, `right` must match the hub's current pair): the extension drops any client `_take` and puts the hub's `take_request` there (`export_slides` of the other deck, `replace` = the live index or `after`, `inPlace` when every file can keep its path, its ink), and the session's `_compare_take` writes it as one History step (`transfer.plan_slide_replace` writes files at their own paths; else `plan_slide_paste`). "Merge branch" sends `{"action":"worktree","op":"merge","branch"}` (the worktrees session action) and shows its error; `document` event `inkflow:compare` (`{kind:"path",deck,label}`) opens the view on a deck. While the view is open, keys other than its own and Ctrl+Z/Y stop in its capture listener, and the toolbar's tools are disabled (`body.compare-mode`).
