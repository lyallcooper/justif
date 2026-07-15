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

**No build step** — one line, zero configuration:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/justif"></script>
```

The page's own CSS decides what gets enhanced: every paragraph (and `li`,
`blockquote`, `dd`, `figcaption`) whose computed `text-align` is `justify`
is upgraded in place; nothing else is touched. Hyphenation follows your
declared languages: English content (nearest `lang` attribute, or none)
uses the inlined en-US patterns at no extra cost, and content in any other
[bundled language](#hyphenating-other-languages) loads its pattern module
on demand from the same CDN — one small request per distinct language.
Unbundled languages justify with spacing only (wrong-language hyphenation
is worse than none). `data-justif-selector="article p"` on the script tag
narrows the candidates; `window.justif.controllers` is the escape hatch.
~38 KB gzipped for English-only pages, no further requests.

**With a bundler:**

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

## Hyphenating other languages

23 languages ship with the package, each as its own zero-cost entry
(pattern data from CTAN's [hyph-utf8](https://ctan.org/pkg/hyph-utf8) —
the same patterns TeX uses — compiled lazily on first use):

```js
import { hyphenateDe } from "justif/hyphenate/de";
justify(document.querySelectorAll("p:lang(de)"), { hyphenate: hyphenateDe });
```

| | | | |
| --- | --- | --- | --- |
| `ca` Catalan | `da` Danish | `de` German | `el` Greek |
| `en-gb` British English | `en-us` American English | `es` Spanish | `fi` Finnish |
| `fr` French | `hr` Croatian | `hu` Hungarian | `it` Italian |
| `nb`/`nn` Norwegian | `nl` Dutch | `pl` Polish | `pt` Portuguese |
| `ru` Russian | `sk` Slovak | `sl` Slovenian | `sv` Swedish |
| `tr` Turkish | `uk` Ukrainian | | |

Pattern data is redistributed under each language's own permissive license,
reproduced verbatim in the module headers (the package's MIT covers the
code). Czech and Romanian are omitted (GPL-only / unstated license) — use
route 2 or 3 below for those.

For anything else, the `hyphenate` option takes any `(word) => string[]`
splitter — it receives a lowercased word (case is restored positionally
afterwards, so capitalized German nouns are fine) and must return fragments
whose lengths sum to the input's:

1. **Soft hyphens, no callback.** `&shy;` entities in your HTML are always
   honored as break opportunities. If your pipeline can hyphenate at build
   or server time (any tool, any language), you need nothing else.
2. **TeX patterns via the built-in engine.** Feed `createHyphenator` any of
   hyph-utf8's ~80 pattern files (extract the
   `\patterns{…}`/`\hyphenation{…}` contents into strings — they are
   plain space-separated lists; `tools/gen-hyphenation.mjs` in the repo
   automates exactly this):

   ```js
   import { createHyphenator } from "justif/hyphenate/liang";
   import { patterns, exceptions } from "./hyph-de-1996.js"; // your data

   const hyphenateDe = createHyphenator({
     patterns,
     exceptions,
     leftmin: 2,  // \lefthyphenmin — see the pattern file's docs
     rightmin: 2, // \righthyphenmin
   });
   justify(document.querySelectorAll("article p"), { hyphenate: hyphenateDe });
   ```

   Patterns compile lazily into a trie on first use, so shipping several
   languages costs nothing until one hyphenates.
3. **An existing hyphenation library.** Anything word-in/fragments-out
   plugs in directly (e.g. Hypher: `(w) => new Hypher(de).hyphenate(w)`);
   libraries that return soft-hyphenated strings need only
   `.split("\u00AD")`.

One hyphenator applies per `justify()` call, so multilingual pages group
paragraphs by language: `justify(document.querySelectorAll('p:lang(de)'),
{ hyphenate: hyphenateDe })`, and so on. RTL paragraphs never hyphenate
(Arabic joining makes fragment measurement invalid) and CJK does not need
to — both are handled automatically.

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

## RTL

Pure-RTL paragraphs (`direction: rtl` / `dir="rtl"`) are supported: Hebrew
and Arabic text — digits and punctuation included — justifies with the
full pipeline, lines mirrored end to end (protrusion hangs line-start
marks past the *right* edge, line-end stops past the left). Hyphenation
and letterfit tracking are never applied to RTL paragraphs (Arabic
cursive joining forbids both).

**Scope is pure-RTL only.** Mixed-bidi content bails to native rendering:
an RTL paragraph containing any strong-LTR letters (Latin, Greek,
Cyrillic, …), an LTR paragraph containing any RTL characters, nested
`dir` changes, `unicode-bidi` overrides, or explicit bidi control
characters — the browser's visual reordering of opposite-direction runs
is out of scope for the line model, so your CSS fallback applies.

## Deployment notes

- **Browser support**: evergreen browsers (Chrome/Edge 105+, Firefox 110+,
  Safari 16.4+). The hard requirements are `ResizeObserver`,
  `IntersectionObserver`, canvas `measureText`, and CSS logical margins;
  everything newer (constructable stylesheets, `Intl.Segmenter`, canvas
  `letterSpacing`) has a built-in fallback. No polyfills are bundled.
- **Content-Security-Policy**: safe under a strict `style-src` (no
  `'unsafe-inline'`) — segment rules install via constructable stylesheets
  (`adoptedStyleSheets`), not an injected `<style>` element, and per-line
  values are CSSOM property writes, which CSP does not govern.
- **Shadow DOM**: paragraphs inside open or closed shadow roots work; the
  segment rules are adopted onto the paragraph's own root.
- **Fail-safe by contract**: any paragraph the model cannot reproduce — and
  any unexpected exception while enhancing one — downgrades that paragraph
  to native rendering (your `text-align: justify` CSS applies). One bad
  paragraph never affects its siblings, the resize loop, or the controller.
- **SSR**: importing the package is side-effect-free and DOM-free;
  `justify()` is a client enhancement (call it after hydration). The
  headless core (`justif/core`) runs in Node.

## Limitations (v1)

- Horizontal Latin-script LTR, CJK (Han/kana/Hangul), and pure-RTL
  (Hebrew/Arabic) text; paragraphs containing mixed-direction content,
  Thai/Lao, images, `<br>`, floats, or non-`inline` elements are left
  untouched (native rendering, your CSS fallback applies).
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
