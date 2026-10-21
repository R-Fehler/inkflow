# A deck that looks the same everywhere

A deck is a folder: `deck.py`, its drawings, Markdown and pictures. A
colleague who clones it, a CI runner publishing it, or you on another
laptop should get exactly the slides you see. Three things quietly tie a deck
to the computer it was made on:

- **fonts** that only this computer has (a font installed for you, or one
  your OS ships, such as Arial or Segoe UI), and font stacks that start with a
  generic family (`sans-serif`, `monospace`), which every OS draws with its own
  font;
- **files outside the deck**: a picture named as `../shared/logo.png`, or
  reached through a symlinked folder (git keeps the link, not the file, and a
  Windows checkout turns links into small text files);
- **the setup**: no `pyproject.toml` pinning the inkflow version, no
  `uv.lock`, no line-ending rules (a Windows checkout can rewrite every SVG
  with CRLF line endings), no Git LFS rules for fonts and media.

`inkflow fonts` shows where each font comes from, and a deck made with
`inkflow init` starts with the setup in place.

## Where the fonts come from

```bash
inkflow fonts            # one line per family, with the weights the deck uses
inkflow fonts --json     # the same, for scripts and agents
```

Every family the deck names is listed: the theme's font tokens as your
`styles.css` leaves them, other `font-family` declarations in the deck's
styles, and every font in the built slides (SVG text, Markdown, charts,
drawn-in diagrams). Each says where it comes from:

| Where | Meaning | On another machine |
|--|--|--|
| `project` | the deck's `fonts/` folder | the same: it is committed |
| `theme` | shipped with inkflow or the deck's theme | the same: the version is pinned |
| `machine` | this computer's font folders (the path is shown) | another font |
| `missing` | nowhere | a fallback, here too |
| `generic` | a stack starting with `sans-serif`, `serif`, `monospace`… | each OS's own font |

Weights and styles are the ones actually used: body text adds bold and italic
only where the Markdown has `**bold**` or `*italic*`, headings use the theme's
heading weight. The last line says whether every font travels with the deck.

A `machine` font's line names the licence found beside its files or in the
font itself. The well-known system fonts (Arial, Helvetica, Segoe UI, SF Pro,
Calibri, Cambria, Consolas, Times New Roman, Menlo…) come with Windows or
macOS and cannot be shared, so the report names an open alternative instead,
often one with the same metrics, so text keeps its layout: Arimo for Arial
and Helvetica, Carlito for Calibri, Tinos for Times New Roman, Inter for
Segoe UI and SF Pro, JetBrains Mono for Consolas and Menlo.

## Bringing fonts into the deck

Copy a `machine` font's files into the deck's `fonts/` folder (one folder per
family, with its licence file beside it) and commit them: the build looks
there first ([Fonts](../design/fonts.md)), and `inkflow fonts` then lists the
family as `project`. Only the files for the weights and styles the deck uses
are needed; a variable font is one file. A `generic` or `missing` font is
fixed by naming a font in the theme's tokens (`--inkflow-body-font`,
`-heading-font`, `-mono-font` in `styles.css`), with a generic family after it
as the fallback (`Inter, sans-serif`).

[Plugins](../reference/extending.md) can add subcommands to `inkflow fonts`
that do this for you.

## New decks start self-contained

`inkflow init` sets up what a clone needs:

- **Versions**: its `pyproject.toml` pins inkflow (`inkflow~=X.Y.Z`, plus
  what the installed [plugins](../reference/extending.md) ask a deck to
  depend on), and `uv lock` runs when uv is installed (offline it says so and
  you run it later).
- **Git rules** in the deck's `.gitattributes`: LF line endings for its text
  sources (`*.svg`, `*.md`, `*.py`, `*.css`, `*.csv`, `*.json`, `*.txt`, one
  rule each), the SVG diff driver line, and Git LFS rules for media and fonts.
  With `--no-lfs`, a committed *git only* choice (`# inkflow: lfs off`)
  instead of the LFS rules. Rules already there (including a repository-wide
  `* text=auto eol=lf`) are not added again.
- **Fonts**: any font the chosen look names that only this computer has is
  copied into `fonts/<family>/`, with the licence files found beside it
  (`OFL.txt`, `LICENSE*`, the family's README), and listed in
  `fonts/README.md` with where it came from and its licence. When the folder
  has no licence file, the licence the font itself states is written to
  `LICENSE-from-font.txt`.

Licences are read, not guessed at, and nothing is refused: a font whose
licence does not allow sharing is copied with a warning, because you may only
want the deck on your own machines, and a font with no licence anywhere is
copied with a reminder to check.

## What else needs this machine

- [PDF figures](../authoring/pdf-figures.md) need a converter to build,
  unless their pages are committed beside the PDF;
- pictures read from the web (`https://…`) need internet access;
- emoji and formulas need a font in the deck or the theme that draws them;
- the tools a build needs: `inkflow build` needs nothing else, `inkflow
  export` (PDF) needs Chromium or Chrome, and ffmpeg is never needed to build.

A CI runner publishing the deck has none of your fonts: see
[Publishing online](publish.md).
