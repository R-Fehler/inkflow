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

## The series

Twenty-two stacked PRs, each opened against the one before it (PR 1 against
`upstream-main`):

| # | Branch | PR | Title |
|---|---|---|---|
| 1 | `claude/upstream-01-plugins` | R-Fehler/inkflow#3 | Add plugins: installed packages add commands, verify checks, completions |
| 2 | `claude/upstream-02-server-extensions` | R-Fehler/inkflow#4 | Add server extensions: frontends plug into the deck's server |
| 3 | `claude/upstream-03-source-locators` | R-Fehler/inkflow#5 | Add source locators: the editor build says where each element came from |
| 4 | `claude/upstream-04-one-port-door` | R-Fehler/inkflow#6 | Serve everything on one port, behind a door that decides who is who |
| 5 | `claude/upstream-05-incremental` | R-Fehler/inkflow#7 | Rebuild only what a change touched, and send pages what changed |
| 6 | `claude/upstream-06-deck-switching` | R-Fehler/inkflow#8 | Switch decks on one server, serve without a deck, send the owner home |
| 7 | `claude/upstream-07-sizes` | R-Fehler/inkflow#9 | Page sizes and posters: Deck(size=), print-size PDFs, poster layouts |
| 8 | `claude/upstream-08-layouts` | R-Fehler/inkflow#10 | More built-in layouts, and which slides use each |
| 9 | `claude/upstream-09-layout-copies` | R-Fehler/inkflow#11 | A theme's layout is copied on write; placeholders |
| 10 | `claude/upstream-10-charts` | R-Fehler/inkflow#12 | Charts from data, drawn at build time in theme tokens |
| 11 | `claude/upstream-11-pdf-figures` | R-Fehler/inkflow#13 | PDF figures: a page of a PDF shown as vector SVG |
| 12 | `claude/upstream-12-drawio` | R-Fehler/inkflow#14 | draw.io diagrams drawn into the slide; backgrounds behind pictures |
| 13 | `claude/upstream-13-fonts` | R-Fehler/inkflow#15 | The default fonts ship with inkflow |
| 14 | `claude/upstream-14-themes` | R-Fehler/inkflow#16 | Two more built-in themes: Paper and Stage |
| 15 | `claude/upstream-15-sections` | R-Fehler/inkflow#17 | Sections: named groups of consecutive slides |
| 16 | `claude/upstream-16-text-fit` | R-Fehler/inkflow#18 | Text size and shrink-to-fit |
| 17 | `claude/upstream-17-ink` | R-Fehler/inkflow#19 | Pen ink in the presenter |
| 18 | `claude/upstream-18-gestures` | R-Fehler/inkflow#20 | Zoom gestures: one shared layer, a pinch never leaves a trace |
| 19 | `claude/upstream-19-render` | R-Fehler/inkflow#21 | inkflow render and the handout |
| 20 | `claude/upstream-20-portable` | R-Fehler/inkflow#22 | A portable deck: fonts report, LFS, pinned inkflow, Pages publishing |
| 21 | `claude/upstream-21-single-file` | R-Fehler/inkflow#23 | One-file static build by default |
| 22 | `claude/upstream-22-rest` | R-Fehler/inkflow#24 | The rest of the core: what frontends need, and leftovers |

PRs 1–6 are what frontends build on (plugins, server extensions, source
locators, one port and the door, incremental rebuilds, deck switching);
7–21 are core features; 22 is what frontends still needed from the core
(`max_message_size`, `Instance.home`, neutral wording) and leftovers.

## What does not go upstream

Everything in `inkflow-editor/` (the visual editor and its editing session,
the agent CLI, the compare view, presence, online sharing through a relay):
it is a plugin over the core's plugin and server-extension API.

## Status

All 22 PRs are open (R-Fehler/inkflow#3–#24). The fork's core is now exactly
`claude/upstream-22-rest`'s: `git diff claude/upstream-22-rest -- . ':!inkflow-editor'`
lists only the fork's own files (this one, the workspace config, CI and mise
tasks, `docs/editor/`, the README's and the guides' editor parts), so
inkflow-editor runs on the core that goes upstream.

After merge: the PRs are re-targeted to `ll-nick/inkflow` and merged in
order. Then `upstream-main` is synced with upstream main, which then holds
the whole core, and the fork is merged with it: its core diff against
upstream is only the fork's own files listed above. From then on a change the
editor needs from the core goes upstream as a PR of its own first (a hook any
frontend could use), and the fork takes the core from upstream instead of
diverging again; once released, inkflow-editor can depend on the published
inkflow instead of the workspace copy.
