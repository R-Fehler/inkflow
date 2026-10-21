# Checking slides

`inkflow render` shows slides the way the presenter does, in a headless
Chromium, and writes them as PNG images. While it draws each slide it also
measures it, and prints a line for every layout problem it finds. What a
person sees in the images, a program (an agent editing the deck, a CI job)
can read back from the same command.

```bash
inkflow render                    # .inkflow/render/slide-1.png
inkflow render --slide 4 --step 0 # slide 4 before its first click
inkflow render --all              # every slide, slide-N.png each
inkflow render --check            # every slide, no images; exit 1 on a problem
inkflow render --sheet            # .inkflow/render/sheet.png: all slides in a grid
inkflow render --sheet -s 4 -s 5  # just these slides
```

A slide is named by its number (as the presenter counts, hidden slides left
out) or by its id. Without `--slide` it is the first slide, or the slide a
[plugin](../reference/extending.md) says is open (an editor's current
slide). Each slide is shown at its last build step, everything revealed,
unless `--step` names another. Images go to `.inkflow/render/` in the
project (git ignores it); `-o` names a PNG file for one slide or a sheet, or
a directory. They are `slide-N.png`; `--by-id` names them `<id>.png`, which
stays a slide's name when slides are added before it. `--scale` sets their
size relative to the slide's (half by default); `--json` prints the whole
result as JSON.

`render` needs Chromium or Chrome, like [`inkflow export`](../presenting/export.md);
`--chromium` points at one it does not find. Every render runs in a single
browser, so `--all`, `--sheet` and `--check` take a few seconds for a whole
deck.

## What it reports

```text
slide 2 (features): #zone-content: text overflows its zone by 232px (bottom)
slide 3 (interface): #zone-content: code block is cut off by 528px (right)
slide 8 (morph): #logo: lies 40px outside the slide (right)
slide 8 (morph): #lost: lies entirely outside the slide (right), so it is not shown
slide 3 (interface): #zone-content: text 10px tall is likely too small to read (below 13.5px): "tiny footnote"
slide 1 (title): #subtitle: contrast 2.4:1 against its background (needs 3:1): #8839ef on #203341 "Your editor, your style."
slide 5 (compare): #zone-right: its text is shrunk to 72% to fit while #zone-left beside it is at 100%: the two read at different sizes (shorten this one, or give both the same size, e.g. size=72% on each)
```

Lengths are in slide units, the numbers in the SVG. A zone's text is compared
with the zone's box, after it was [shrunk to fit](markdown.md#text-size-and-shrinking-to-fit)
as every page showing the slide shrinks it: text that fits once shrunk is
fine, text that overflows even at the smallest readable size is reported with
how far it was shrunk. A drawn object is compared with the slide's edges,
except a background or a band spanning the whole slide, and anything clipped
on purpose (a crop, a media zone).

Small text (below 1/80 of the slide's height) is a hint, and so is a text box
shrunk to fit a tenth or more further than the box beside it (two columns that
start at the same height and are as tall): each fits, but they read at
different sizes. The rest are problems. `--check` exits 1 on a problem, never
on a hint, and closes with a count (`1 layout problem and 2 hints in 12
slides`).

On a printed deck (a poster), text is measured in points against the sheet
and pictures by their printed resolution: see
[Posters](posters.md#check-it).

### Contrast

Contrast is measured against what is really behind each piece of text, in the
rendered slide: the slide is shot once as shown and once with its text made
transparent, and the background is read where the letters are. So text over a
photo, a gradient or a coloured box is judged by the pixels behind it, in the
deck's colour mode and with its theme's colours. The worst tenth of those
pixels decides, so a light patch behind white letters is found but a few
anti-aliased edges are not; a thick outline of another colour (a halo) is what
the text is read against, and a text shadow counts where it helps. Below 3:1
is a problem for any text; between 3:1 and 4.5:1 is a hint for text smaller
than 24px on a 1080px-tall slide (18.66px bold), the WCAG size for large text.
The check takes two more screenshots per slide (about 0.2 s); `--no-contrast`
skips it.

## A contact sheet

`--sheet` puts the slides on one image instead of one each, every slide
labelled with its number and id and the ones with problems flagged. A sheet is
at most 1600 px wide, with up to 16 slides per image (`sheet-1.png`,
`sheet-2.png`… for a longer deck), so one image shows the flow of the deck.

## Placing against real text

The boxes in an SVG say where a zone *is*, not where its text ends. To size or
line things up against what is really drawn, `inkflow render --boxes` prints
every element's box as the browser renders it, in slide units after
transforms, one line each (`--json` for everything):

```text
slide 2 (features): 1920x1080
zone-title  80,60 1760x120  zone  "Features"  content 300.1x80, free 40
  zone-title/1  80,63 300.1x80  h1  "Features"
zone-content  80,220 1760x740  zone  "Draw in any SVG editor…"  content 1288.7x566.5, free 173.5
  zone-content/1  80,224 1180x91.4  p  "Draw in any SVG editor…"
  zone-content/2  80,342.8 1288.7x91.4  p  "Slides from Markdown…"
box-svg  89,322.5 357.9x157.9  g
  rect-svg  89,322.5 357.9x157.9  rect
```

Each element with an id is listed, nested under the listed element it is in. A
zone shows the extent of its content and the height left free in it (negative
when the text overflows); under it, each block of its text (paragraph, heading,
list, code, table, picture) as `zone/N` with the extent of its *text*, not the
full width its box takes. Only boxes are measured, no image is written unless
`--output` is given, and it costs nothing noticeable on top of a render (about
0.13 s per slide for the demo deck, browser start included).
