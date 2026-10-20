# Layouts

A layout is a reusable slide template, the same idea as a master slide.
It is an ordinary SVG holding the parts every slide of that kind shares,
with named **zones** left empty for the content.

Layouts are optional.
A deck of hand-drawn SVGs never needs one.
They earn their place the moment two slides should look identical
apart from their text.

## Zones

A zone is any shape whose `id` starts with `zone-`.
A `<rect>` is the usual choice:

```xml
<rect id="zone-content" x="120" y="200" width="1680" height="760"/>
```

When inkflow builds the slide it replaces that shape with a `<foreignObject>`
of the same bounding box, holding the rendered content.
A zone that the slide never fills is removed rather than left showing.

The zone shape itself is a placeholder: its fill and stroke are never painted
(Inkscape gives every rect a style). Custom properties in its own `style`
(`--inkflow-padding: 20px`, `--inkflow-valign: center`) do apply to its text,
like the layout CSS that sets them.

### A zone drawn as a box

Mark the shape `inkflow:show-shape="true"` and it is drawn instead: its fill
becomes the background of the box the text is in, its stroke a border, its
`rx`/`ry` (or an ellipse's outline) the corner radius, with some padding to
keep the text off the edge. On an accent-coloured fill (`inkflow-fill-accent`
or another vivid theme colour) the text takes the theme's `accent-fg` colour.
Text and box stay one element, so an animation or a transition moves them
together. Such a zone stays on the slide, drawn and empty, when nothing fills
it.

```xml
<rect id="zone-callout" x="1200" y="300" width="600" height="300" rx="24"
      class="inkflow-fill-surface inkflow-stroke-accent" style="stroke-width:3"
      inkflow:show-shape="true"/>
```

!!! tip
    Inkscape's Layers & Objects panel edits an element's *label*, not its `id`.
    Label the rect `zone-content` there and run
    [`inkflow label2id`](../authoring/inkscape.md#naming-elements-label2id).

### Non-rectangular zones

`<polygon>`, `<ellipse>`, `<circle>` and `<path>` work too.

For **media** zones, inkflow generates a `<clipPath>` from the exact shape,
so an image or video is cropped to the outline.
For **text** zones only the bounding box is used,
since text reflows in a rectangle whatever the shape.

### Reserved names

| ID | Filled with |
|---|---|
| `zone-title` | The leading `# H1` from Markdown, when the zone exists |
| `zone-subtitle` | The `## H2` right after it, when the zone exists |
| `zone-slide-number` | The current slide number. Must be a `<text>` element |
| `zone-slide-total` | The total slide count. Must be a `<text>` element |

Every other `zone-*` name is yours.
Pick names your Markdown will use: `zone-content`, `zone-left`, `zone-media`.

### The default zone

The default zone takes all the Markdown that nothing else claimed,
meaning everything outside an explicit `::zone::` marker
and outside the title and subtitle extraction.

A layout containing `zone-content` uses it as the default automatically.
For anything else, declare it:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:parent="builtin:content"
     inkflow:default-zone="quote"
     viewBox="0 0 1920 1080" width="1920" height="1080">
  <rect id="zone-quote" x="120" y="200" width="1680" height="720"/>
</svg>
```

A layout with no text zone at all, like `cover` or `section`, needs no default.

If a slide has unrouted Markdown and its layout declares no default zone,
the build fails with a red overlay in the browser naming the slide.

### When the title zone is missing

If a layout has no `zone-title` or `zone-subtitle`,
a leading `# H1` or `## H2` is not discarded.
It falls through into the default zone as rendered HTML.

```markdown
# This is a Quote
And this is the attribution line.
```

On the `quote` layout, which has no `zone-title`, both lines land in `zone-quote`.
On `content`, which has one, the `# H1` routes to `zone-title` as usual.

To bypass the question entirely, mark the zones explicitly:

```markdown
::quote::
This text always goes to zone-quote.
::attribution::
— Author name
```

## Inheritance

A layout points at its parent with `inkflow:parent` on the root `<svg>`:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:parent="theme:main"
     viewBox="0 0 1920 1080" width="1920" height="1080">
  <!-- zones specific to this layout -->
</svg>
```

Chains can be any depth:

```
slides/bullets.svg
  └─ inkflow:parent="content"         → layouts/content.svg
       └─ inkflow:parent="theme:main" → theme/main.svg  (no parent, chain ends)
```

inkflow resolves the whole chain in memory and composites the layers
from root to leaf, behind the slide's own content.
**The files on disk are never modified.**

To see the composed result while drawing,
run [`inkflow sync`](../authoring/inkscape.md#previewing-the-full-slide-sync).

## Finding a layout by name

A bare name is searched in three places, first match winning:

1. the project's `layouts/` directory
2. the active theme's `layouts/` directory
3. the built-in layouts

So a project `layouts/content.svg` shadows the built-in `content`
without any configuration.

A prefix skips the search:

| Written as | Resolves to |
|---|---|
| `"content"` | The three-level search |
| `"local:content"` | `{project}/layouts/content.svg` |
| `"theme:content"` | `{theme}/layouts/content.svg` |
| `"builtin:content"` | The built-in layout |
| `"./relative/path.svg"` | Relative to the current SVG file |

To see what is available in your project right now:

```bash
inkflow layouts
```

It prints every layout and overlay with its parent chain, its zones and how
many slides use it (with a deck, the layouts in its size's shape), and notes
the deck's own copies of theme layouts (below), the theme layouts they
replace, and a theme's layout the deck's own of the same name only shadows.
`inkflow layouts --plain` prints one line per layout instead of tables (for a
narrow terminal, or a program reading it), `--json` the same as data.

## Changing a theme's layout: the deck's own copy

A theme's layouts (the built-in ones included) live in an installed package
and are never written. To change one for a deck, give the deck its own copy:
copy the theme's file to `layouts/<same name>.svg` in the project and add
`inkflow:copy-of` to its root, naming the file it replaces. If the original
has an `inkflow:parent`, name that parent explicitly too (the theme's
`./title` would now look in your `layouts/`):

```xml
<svg ... inkflow:copy-of="builtin:base">              <!-- base has no parent -->
<svg ... inkflow:copy-of="builtin:agenda" inkflow:parent="builtin:title">
```

For a pip-installed theme's layout, write `theme:agenda` and `theme:title`
instead. The built-in files are in the installed package
(`python -c "import inkflow, pathlib; print(pathlib.Path(inkflow.__file__).parent / 'theme/layouts')"`);
an editor's slide master can make the copy for you on the first edit.

The copy then stands in for the theme's file **everywhere**, not only for
slides naming it: when any reference (a bare name, `builtin:base`,
`theme:agenda`, or the theme's own `./base` inside `numbered.svg`) resolves to
the theme's file, the project's copy is used instead. So a copy of `base` is
the background of every built-in layout, and of every layout of yours built on
them, and a copy of `title` changes `content`, `agenda` and the other layouts
built on `title`. The copy's own parent names the theme's ancestor, which the
project's copy of that ancestor stands in for whenever there is one. Only what
you copy changes: copying `agenda` touches agenda slides only.

The rule follows only marked copies. A project layout that merely shares a
name with a theme's (an own `title.svg` drawn as a title slide) replaces it for
slides naming it, as the search above says, but never slips into the theme's
chains. A copy built on its own original (`inkflow:parent="builtin:content"`
in a copy of `content`) goes on to the theme's file rather than looping.

Delete the copy and the theme's layout is used again. Run
[`inkflow sync`](../authoring/inkscape.md#previewing-the-full-slide-sync)
after making or deleting one, so the Inkscape previews show the new
background (`inkflow verify` reports the previews it made stale).

## Placeholder prompts and names

A layout's zones are its placeholders: what each slide on it fills. Two
optional additions are for editors:

```xml
<svg ... inkflow:label="Code examples">
  <rect id="zone-code" x="100" y="300" width="1000" height="600"/>
  <inkflow:hint zone="code">Paste the code example</inkflow:hint>
</svg>
```

`<inkflow:hint zone="<name>">` is the prompt an editor shows in that zone
while a slide leaves it empty. The build takes it out of every slide; a
layout's prompt for a zone replaces one its parent gives the same zone.
`inkflow:label` is the layout's name as its author typed it, which
`inkflow layouts` shows beside the file's own name for the deck's
own layouts.

## Built-in layouts

The built-in theme ships eighteen layouts, usable by bare name in any deck:

| Name | Zones | For |
|---|---|---|
| `cover` | title, subtitle, media | The opening slide |
| `section` | title, subtitle | A section divider |
| `title` | title | A bare title, no content zone |
| `content` | title, content | The standard text slide |
| `center` | content | A single centered block |
| `two-cols` | title, left, right | Two-column comparison |
| `fact` | fact, caption | One big number or claim |
| `quote` | quote, attribution | A pull quote |
| `media-left` | title, content, media | Text with an image or video on the left |
| `media-right` | title, content, media | The same, media on the right |
| `agenda` | title, content | A numbered outline (write a `1.` list) |
| `three-cols` | title, left, middle, right | Three side-by-side columns |
| `comparison` | title, left-title, left, right-title, right | Two headed columns: before/after, pros/cons |
| `quad` | title, top-left, top-right, bottom-left, bottom-right | A two-by-two grid |
| `three-cards` | title, media-1…3, card-1…3 | Three cards, each an image over text |
| `title-media` | title, media, caption | One large image or video with a caption |
| `full-media` | media, title, subtitle | A full-bleed photo or video, title over a fade |
| `end` | title, subtitle | The closing slide |

Two more exist as building blocks: `base` is the parentless background,
and `numbered` adds the slide-number zones.

Four poster layouts are drawn on the A paper sizes' canvas (3179 x 4494
portrait, 4494 x 3179 landscape), for a deck with `Deck(size="a0")` or another
A size: `poster-3col` and `poster-2col` (portrait), `poster-landscape-3col` and
`poster-landscape-4col`. Their zones are title, authors, affiliations, logos,
col-1…col-4, references and contact, on the building blocks `poster-base` and
`poster-landscape-base`. See [Posters and page sizes](../authoring/posters.md).

```python
Slide("cover", md="title")
Slide("two-cols", md="compare")
```

The [built-in theme page](../built-in-theme/index.md) has a live showcase of all of them.

They take your theme's palette automatically,
because they paint through the token classes rather than hardcoded colours.
See [Themes](themes.md#built-in-layouts-recolored).

## Creating a slide from a layout

`inkflow add` writes a new SVG already wired to a parent:

```bash
inkflow add slides/new.svg -p content
```

It creates the file with `inkflow:parent="content"`
and runs `inkflow sync` so the preview layers are there when you open it.
Omit `-p` for a blank slide with no parent.

Then add it to `deck.py`:

```python
Slide("slides/new.svg")
```

To rewire or detach an existing slide:

```bash
inkflow parent set slides/new.svg builtin:content
inkflow parent strip slides/new.svg
```

## Writing your own

1. Create `layouts/my-layout.svg`.
2. Point `inkflow:parent` at a base layout, or leave it off for a standalone one.
3. Add `zone-*` shapes where content belongs.
4. Set `inkflow:default-zone` unless the layout has a `zone-content`.
5. Reference it by name: `Slide("my-layout", md="custom")`.

A narrower content column:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:parent="builtin:content"
     inkflow:default-zone="content"
     viewBox="0 0 1920 1080" width="1920" height="1080">

  <rect id="zone-content" x="300" y="200" width="1320" height="720"/>
</svg>
```

Two columns, where unmarked Markdown flows into the left one:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:parent="builtin:content"
     inkflow:default-zone="left"
     viewBox="0 0 1920 1080" width="1920" height="1080">

  <rect id="zone-left"  x="80"   y="200" width="840" height="720"/>
  <rect id="zone-right" x="1000" y="200" width="840" height="720"/>
</svg>
```

```markdown
# Two Columns

Left column content here.

::right::
Right column content here.
```

Set per-layout defaults for alignment with CSS variables in the layout's own `<defs>`:

```css
#zone-title   { --inkflow-valign: center; }
#zone-content { --inkflow-padding: 40px; }
```

## Hiding an element on one slide

To drop an inherited element from a single slide, style it away.
The CSS is already scoped to that slide:

```python
Slide("content", extra_style=Inline("#logo { display: none }"))
```

## Layouts within a theme

A theme's layouts live outside any project and have no `deck.py`,
so `local:` and `theme:` are unavailable there.
Use `builtin:` or a relative path:

```xml
<!-- theme/layouts/content.svg -->
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:parent="builtin:content"
     viewBox="0 0 1920 1080" width="1920" height="1080">
  ...
</svg>
```

See [Themes](themes.md#shipping-a-theme-as-a-package) for packaging,
and [`sync --no-deck`](../authoring/inkscape.md#working-on-a-theme)
for previewing them while you work.
