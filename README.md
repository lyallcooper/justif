# justif

Perfect justified text for the web: TeX-quality paragraph layout as a drop-in
enhancement for existing HTML.

Browsers justify text with a greedy, line-at-a-time breaker and stretch only
the spaces. `justif` re-lays paragraphs out with the full
[Knuth-Plass](https://doi.org/10.1002/spe.4380111102) paragraph-global
optimizer plus the [microtype](https://ctan.org/pkg/microtype) trio of
refinements:

- **Optimal line breaking** — TeX's exact badness/demerits model (three-pass
  tolerance escalation, hyphenation only when needed, adjacent-line fitness,
  emergency stretch), so spacing is optimized over the whole paragraph.
- **Character protrusion** (optical margin alignment) — terminal punctuation
  hangs into the margin so the text edge looks optically straight; protrusion
  participates in break decisions, exactly as in pdfTeX.
- **Font expansion** — on variable fonts with a `wdth` axis, glyphs stretch or
  shrink up to ±2% per line (via per-line `font-stretch`), evening out word
  spacing and reducing hyphenation. Fonts without a usable axis fall back to
  spacing-only justification automatically.
- **Hyphenation** — pluggable; an optional en-US module ships Knuth/Liang's
  original TeX patterns (~15 KB gzipped, zero cost unless imported). Soft
  hyphens (`&shy;`) are always honored, and CSS `hyphens: none` on any inline
  element (e.g. `code { hyphens: none }`) suppresses hyphenation inside it —
  identifiers never gain misleading hyphens.
- **CJK justification** (Japanese-first) — lines may break between
  characters with kinsoku shori (禁則処理) rules, and justification
  distributes space *between* characters, JIS-style. See
  [CJK support](#cjk-japanese-support).

Zero dependencies. ESM. The layout core is DOM-free and runs in Node.

## Usage

```js
import { justify } from "justif";
import { hyphenateEnUS } from "justif/hyphenate/en-us";

const controller = justify(document.querySelectorAll("article p"), {
  hyphenate: hyphenateEnUS,
});

// later:
controller.refresh(); // re-measure with current font files (runs automatically on webfont loads)
controller.destroy(); // restore the original DOM exactly
```

For content or CSS changes, call `destroy()` and `justify()` again — the
original scan is reused by `refresh()`. `unjustify(elements)` restores
paragraphs enhanced by any controller.

Keep `text-align: justify` in your CSS — paragraphs render natively justified
until enhancement (no ragged flash), and it remains the fallback for content
`justif` declines (see limitations).

Container resizes are handled automatically via `ResizeObserver`: measurement
happens once, so a resize re-runs only arithmetic plus a minimal DOM patch
(10,000 words enhance in ~25 ms cold; re-layout is a few ms).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `hyphenate` | `undefined` | `(word) => string[]` splitter; import `hyphenateEnUS` or bring your own |
| `protrusion` | `true` | `false`, or a table merged over the built-in Latin defaults (thousandths of the glyph's advance) |
| `expansion` | `{ max: 0.02, shrink: 0.02, step: 0.005 }` | `wdth`-axis expansion limits, or `false` |
| `tolerance` / `pretolerance` | `200` / `100` | TeX pass-2 / pass-1 badness ceilings |
| `hyphenPenalty`, `exHyphenPenalty`, `linePenalty`, `adjDemerits`, `doubleHyphenDemerits`, `finalHyphenDemerits` | TeX defaults | Break cost model |
| `emergencyStretch` | `"auto"` | Extra badness-only stretch for the final pass |
| `lastLineMinWords` | `0` | ≥ 2 discourages last lines with fewer words than this |
| `lastLineStretch` | `Infinity` | Fraction of the measure the last line's fill may stretch (TeX's `\parfillskip=0pt plus f\hsize`); e.g. `0.5` softly avoids orphan-ish short last lines |
| `lastLineFit` | `0` | eTeX's `\lastlinefit` as a 0–1 fraction: the last line's spaces adopt this fraction of the paragraph's mean stretch, so the ending shares the body's color instead of setting tight against loose lines. Word spacing only — letterfit and expansion stay natural |
| `cleanClipboard` | `true` | Rewrites copies so layout plumbing (word joiners, run-boundary NBSPs) never reaches the clipboard; author NBSPs (`Fig.&nbsp;7`) are preserved |
| `spacing` | `{ stretch: 0.5, shrink: 1/3, pull: 0.5 }` | Inter-word glue flexibility as fractions of the space width. `pull` (0–1) is the downward pressure on secondary-font spaces wider than the base font's (e.g. a monospace cell around inline code): 0 keeps each font's natural space, 1 converges fully to the base — which can dissolve word boundaries in loose-fitting fonts; they also flex like prose spaces, keeping one rhythm per line |
| `observeResize` | `true` | Auto re-layout on container resize |
| `onRelayout` | — | Callback fired after a paragraph is (re)patched; use it to keep overlays over the text in sync |

## How it works

1. **Read** — each paragraph is walked into styled runs (inline markup like
   links and `<em>` is preserved and may be split across lines).
2. **Measure** — words are measured whole (kerning-correct) via canvas
   `measureText`, cached globally. Canvas cannot measure at arbitrary `wdth`
   values, so expansion response is calibrated once per font with three
   hidden off-flow DOM measurements and linear interpolation — which doubles
   as detection: fonts that don't respond get expansion disabled.
3. **Break** — the Knuth-Plass active-node breaker runs over boxes/glue/
   penalties with protrusion credits and expansion stretchability folded into
   the line measures, so both influence which breaks are chosen.
4. **Write** — each line's content becomes inline `white-space: nowrap`
   segments carrying the computed `word-spacing` and `font-stretch`, with
   the real break spaces (or a `<wbr>` at hyphenation points) left between
   them. Because every justified line fills the measure exactly, the
   browser's own soft wrap breaks at precisely the chosen points — the flow
   stays native. Hyphens render as pseudo-content, invisible to the
   clipboard and screen readers; the original nodes are kept aside for
   exact restoration.

## Accessibility

Because the enhanced paragraph remains ordinary inline flow (no block-level
line wrappers, no cloned elements):

- assistive tech reads one continuous paragraph, and hyphenated words are
  exposed whole — the same accessible shape as native prose with styled
  spans;
- links wrap across lines as a single element: one tab stop, one accessible
  name, ids and listeners intact;
- find-in-page matches phrases across line breaks, including through
  hyphenated words;
- selection and clipboard behave natively (spaces at line breaks, never
  hard newlines or stray hyphens).

The headless core is available separately for canvas/SSR/custom renderers:

```js
import { buildItems, breakParagraph, layoutLines } from "justif/core";
```

## CJK (Japanese) support

CJK paragraphs (Han ideographs, kana, Hangul, fullwidth forms — mixed with
Latin freely) enhance like any other; no option is needed:

- Every CJK grapheme cluster is its own box; between clusters justif places
  a zero-width break opportunity plus a little stretchable inter-character
  glue (~0.1 em stretch, whisker shrink), so lines justify by opening space
  *between characters* — the JIS X 4051 convention — rather than only at
  word spaces.
- **Kinsoku shori**: characters that must not start a line (。、」ー
  small kana, closing brackets…) or end one (「（ opening brackets…) never
  do; the character classes are exported as `kinsokuNotAtLineStart` /
  `kinsokuNotAtLineEnd`.
- Line breaks between CJK characters render as bare `<wbr>` joints:
  selection, copies, and find-in-page see the original text with **no
  injected spaces or hyphens**. Hyphenation never applies inside CJK runs.
- **Burasage** (ぶら下げ組み): with protrusion on (the default), the
  ideographic and fullwidth stops — 、 。 ， ． — hang into the right
  margin like Latin terminal punctuation.
- Rendering assumes solid setting (bete-gumi): CJK-bearing segments are set
  with `font-kerning: none`, because browser engines disagree between canvas
  measurement and DOM rendering on kana kerning (Chromium's DOM kerns pairs
  its canvas never reports; WebKit is the inverse) — a consistent solid grid
  beats an unmeasurable kern.

Out of scope for now: vertical writing (`writing-mode` other than
`horizontal-tb` bails to native rendering), Thai/Lao (dictionary-based word
segmentation), and dedicated JIS spacing classes for fullwidth punctuation
compression.

## Very long documents

Re-justifying hundreds of paragraphs is fast (the layout core is a few
milliseconds for a book chapter), but the *browser's* per-span layout work
during window resizes scales with how many justified lines are in the
layout — WebKit in particular pays a fixed shaping cost per segment per
reflow with large variable fonts. Two things help:

- justif already slices resize re-layout across frames (viewport-first,
  scroll-anchored), so visible text updates immediately and nothing shifts
  under the reader.
- For truly huge documents you can additionally give paragraphs
  `content-visibility: auto`; justif cooperates: it maintains an **exact**
  `contain-intrinsic-block-size` on every paragraph it manages (its line
  boxes are uniform, so the model height is lines × line-height), which
  keeps find-in-page targets, anchors, and scrollbars stable across
  reveals, and it defers the off-screen wrap-guarantee measurements until
  paragraphs approach the viewport.

  Pair it with horizontal padding on the paragraphs (compensated by
  negative margins, e.g. `padding: 0 0.75em; margin: 0 -0.75em`):
  `content-visibility` implies paint containment, and protruded
  punctuation must paint *inside* the contained box or engines may clip
  or fail to repaint it.

  One caution from testing: engines differ meaningfully in *when* they
  render/skip `content-visibility` content (Safari is lazier than
  Chrome), so verify scroll and find behavior in WebKit before shipping
  it on layout-critical pages.

## Limitations (v1)

- Left-to-right, horizontal text only (Latin and CJK); paragraphs containing
  RTL scripts, Thai/Lao, images, `<br>`, floats, or non-`inline` elements are
  left untouched (native rendering, your CSS fallback applies).
- Floats / `shape-outside` intruding on the paragraph are ignored.

## Development

```sh
npm test              # core: golden fixtures, brute-force optimality oracle
npm run test:e2e      # real-browser geometry: sub-0.5px flush lines, restore fidelity, perf budget
npm run build         # tsup → dist/
python3 -m http.server 5199   # then open http://localhost:5199/demo/
npm run compare:tex   # compare against LuaLaTeX + microtype via texlive.net (needs the demo server)
```

The TeX comparison compiles the demo's fairy-tale paragraph with LuaLaTeX,
microtype (matching parameters), and Junicode at the exact demo geometry —
no local TeX installation — then extracts word positions from the PDF and
runs the same spacing analysis on all three renderers. At 26em, justif's
line breaks are identical to TeX's (9/9), with spacing statistics in the
same league (mean space 95% vs 97% of natural; the greedy browser sits at
135%).

The breaker is verified against an independent exhaustive-search oracle
(minimum total demerits over all feasible breakings) and TeX's published
badness values; the en-US hyphenator against TeX's classic results.
