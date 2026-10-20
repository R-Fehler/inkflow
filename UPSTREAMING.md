# Upstreaming the core: the PR series

The core of this fork (`src/inkflow`, `src/ts`, `src/css`, without
`inkflow-editor/`) differs from upstream `ll-nick/inkflow` main by ~300 files.
That is too much for one review, so it goes up as a series of PRs, each built
from upstream main (or the PR before it), self-contained, with its tests, docs
and a green `mise run check`.

Branches live in this fork: `upstream-main` mirrors upstream main, PR branches
are `claude/upstream-NN-<topic>`. Each is opened here against `upstream-main`
(or the branch it stacks on) for review first; re-target to `ll-nick/inkflow`
when ready.

## Order

### A. What frontends build on (needed by inkflow-editor)

| # | PR | Contents | Stacks on |
|---|---|---|---|
| 1 | Plugins | `plugins.py`: entry-point plugins add CLI commands, `verify` checks (`--no-deck-checks`), completions | main |
| 2 | Server extensions | `extensions.py`: `ServerExtension` (start/stop, build hooks, own messages and pages, terminal keys, welcome fields), `ServerContext`; minimal `collab.Client`; `Plugin.server_extensions`/`serve_options` | 1 |
| 3 | Source locators | `provenance.py`, `process_deck(editor=True)`, `SlideData.edit`, `ServerExtension.provenance`; presenter copies drop `edit` | 2 |
| 4 | One port and the door | WebSocket on the HTTP port (`wsbridge.py`), `access.py` (Host/Origin checks against DNS rebinding and cross-site sockets, owner by loopback, share links with editor/viewer roles), messages gated by role, `--share`, `--tls`, `instances.py` (one server per deck) | 2 |
| 5 | Incremental rebuilds | `deps.py` + `incremental.py`: a served deck processes only the slides a change touched; pages get patches (`shared/patch.ts`) | 3 |
| 6 | Deck switching | `ServerContext.open_deck`, serving without a deck (`serves_without_deck`), `home` | 4 |

### B. Core features (independent of each other; any order after A, most also before)

| # | PR | Contents |
|---|---|---|
| 7 | Page sizes and posters | `sizes.py` (`Deck(size=)`), A-series canvas, poster layouts/templates, PDF page boxes (`pdfboxes.py`), `--bleed`/`--crop-marks` |
| 8 | Charts | `charts.py`, `Chart` zone value, ```` ```chart ```` fence, verify of chart ids |
| 9 | PDF figures | `pdf.py`, `_pdf/` asset root, committed pages |
| 10 | draw.io | `drawio.py`, `drawio_inline.py` (diagrams drawn into the slide, themed), `backgrounds.py` |
| 11 | Shipped fonts | `theme/fonts/` (Inter, JetBrains Mono, STIX Two Math, Twemoji), subsetting cache, interface fonts |
| 12 | Built-in themes | `builtin_themes/` Paper and Stage, `init --theme` |
| 13 | Sections | `Section(...)` in `slides=`, presenter overview/picker headings |
| 14 | Text size and fit | `TextBox(size=, fit=)`, marker params, `shared/fit.ts` everywhere a slide shows |
| 15 | Ink | `ink.py`, pen strokes in the presenter (`shared/ink*.ts`), saved per slide |
| 16 | Zoom gestures | `shared/gestures.ts`, `gesturepad.ts`, presenter camera |
| 17 | Render and checks | `cdp.py`, `render.py` (`inkflow render`, `--check`, contrast, `--boxes`), `handout.py` |
| 18 | Portability | `fontreport.py`, `lfs.py`, `pack.py`, `publish.py` (Pages CI), `init` pins inkflow |
| 19 | Online sharing | `online/` relay, end-to-end encryption (optional extra) — could also stay a plugin |

Each B PR may need small parts of another (verify lines, CLI options, the
completion spec); those are carried in whichever PR lands first.

## What does not go upstream

Everything in `inkflow-editor/` (the visual editor, agent CLI, compare view,
presence, Share via SSH): it is a plugin over the API of part A.

## Status

- PR 1 (plugins): `claude/upstream-01-plugins`, R-Fehler/inkflow#3.
- PR 2 (server extensions): `claude/upstream-02-server-extensions`,
  R-Fehler/inkflow#4. Interim owner rule: loopback peer through a loopback
  Host/Origin (PR 4 replaces it with `access.py`). `Role` lives in
  `collab.py` until then. Not yet in it: `provenance` (PR 3), `access`,
  `send_owners`, `share_*`, `serve_connection`/`serve_request` (PR 4),
  `open_deck`, `serves_without_deck`, `home` (PR 6), `resync` and patches
  (PR 5), `HttpRequest.token`/ranged `send_file` (PR 4).
- Next: PR 3 (source locators).
