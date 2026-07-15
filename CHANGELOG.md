# Changelog

## Unreleased

- Critical: `dist` now ships with destructuring pre-lowered, and the build
  gates on esbuild accepting every file at Vite 6's default `build.target`.
  esbuild marks all destructuring as broken below Safari 14.1 and refuses
  to transform it; the older esbuilds bundled in Vite 6 / Astro 5 shipped
  the broken transform instead — a default production build initialized
  justif cleanly and silently managed zero paragraphs.
- New `onSkip(paragraph, reason)` option: one callback per paragraph justif
  declines, with the failing check ("inline `<kbd>` has a horizontal
  margin", "author font-stretch: 75% on a run"). The drop-in script accepts
  `data-justif-debug` to log the same to the console.
- Caps variants (`small-caps`, `all-small-caps`, …) are measured with DOM
  probes on every engine, and variant-run word spaces are measured in
  letter context: GTK WebKit synthesizes small caps at ~0.7× — scaling
  interior spaces with the letters — where other engines use the font's
  real feature, and lone-space probes measured full-size, leaving
  small-caps lines visibly under-filled on that port.
- README: the TeX-style tuning knobs are documented, and the inline-margin
  limitation is stated next to the chip padding/border support note.

## 0.2.0 (2026-07-15)

- Inline chips and pills are now first-class: horizontal padding and
  borders on inline elements (styled `code`, `kbd`, badges) are modeled
  as layout width instead of bailing the paragraph to native. Padding
  follows `box-decoration-break: slice` (the initial value) when an
  element wraps; `clone`, inline margins, and preserved-whitespace
  `white-space` values still bail.
- Word spaces at font-family boundaries stretch but no longer shrink
  below their natural width by default — chips live at those boundaries,
  and native CSS justification never shrinks a space. New
  `spacing.boundaryShrink` option (default `0`; `1` restores TeX
  semantics).
- `white-space: nowrap` on inline elements is honored: no break
  opportunity inside (spaces keep their justification flexibility).
- Author `font-variant-*` values and `font-feature-settings` no longer
  bail paragraphs to native: runs canvas cannot shape are measured with
  batched DOM probes, so small caps, oldstyle/tabular numerals, and
  stylistic sets justify like everything else.
- An unbreakable word wider than the measure now overflows from a line
  of its own — like a browser — instead of dragging the preceding words
  onto the overfull line with their spaces crushed.
- The corrective line-end margin lands outside a cloned inline element
  that closes at the line end, so a padded chip's end inset is never
  visually pinched.
- Drop-in: the import base is picked by URL shape instead of probing,
  removing a console 404 on non-English pages served from bare package
  CDN URLs.

## 0.1.1 (2026-07-15)

- Drop-in: on-demand language modules now load correctly from bare
  package CDN URLs (`https://cdn.jsdelivr.net/npm/justif`), which serve
  `auto.js` without redirecting to its file path — sibling-relative
  imports resolved a directory too high and non-English content silently
  fell back to spacing-only justification. The loader now retries against
  the module's own URL as the package root.

## 0.1.0 (2026-07-15)

Initial release.

- Zero-config drop-in: `<script type="module"
  src="https://cdn.jsdelivr.net/npm/justif"></script>` enhances everything
  the page's CSS justifies; hyphenation auto-follows declared `lang`
  attributes (en-US inlined, other bundled languages loaded on demand).

- Knuth-Plass total-fit line breaking (TeX's exact badness/demerits model,
  three-pass tolerance escalation, emergency stretch).
- Microtypography: character protrusion / optical margin alignment
  (pdfTeX-style, per-font tables), font expansion via the variable-font
  `wdth` axis (script-aware calibration), letterfit tracking (±3%),
  full hanging punctuation presets.
- Pluggable hyphenation; 23 bundled languages from CTAN hyph-utf8 (each
  its own entry, lazy-compiled), en-US from Knuth/Liang's original
  hyphen.tex, and the Liang engine itself (`justif/hyphenate/liang`) for
  any other TeX pattern set.
- CJK (Japanese-first): per-cluster breaking, kinsoku shori, burasage.
- RTL: pure-RTL Hebrew/Arabic paragraphs with mirrored protrusion;
  mixed-direction content bails to native rendering.
- eTeX-style `\lastlinefit` (last-line color matching); TeX-style
  short-last-line pressure.
- Accessibility-preserving DOM emission (inline flow, no cloned line
  boxes), byte-identical `destroy()`, clipboard cleanup, automatic
  resize re-layout (viewport-first, scroll-anchored), exact
  `content-visibility` placeholder cooperation.
- Fail-safe enhancement: unsupported or throwing paragraphs are left to
  native rendering; CSP-safe and shadow-DOM-aware stylesheet installation.
