# Changelog

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
