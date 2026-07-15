# Changelog

## 0.1.0 (unreleased)

Initial release.

- Knuth-Plass total-fit line breaking (TeX's exact badness/demerits model,
  three-pass tolerance escalation, emergency stretch).
- Microtypography: character protrusion / optical margin alignment
  (pdfTeX-style, per-font tables), font expansion via the variable-font
  `wdth` axis (script-aware calibration), letterfit tracking (±3%),
  full hanging punctuation presets.
- Pluggable hyphenation; en-US module with Knuth/Liang's TeX patterns.
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
