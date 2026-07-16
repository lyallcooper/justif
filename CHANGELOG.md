# Changelog

## Unreleased

- `lastLineMinWidth` now defaults to `0.33` — paragraph endings shorter
  than a third of the measure (Bringhurst's rule) are avoided out of the
  box. Pass `0` for the old default.
- Fixed two `lastLineMinWidth` bugs: values near 1 silently behaved like
  the option was off, and endings that needed a hyphen to lengthen never
  got one.
- `lastLineMinWidth` endings now also render at the requested width: an
  ending the line breaks can't fill naturally widens its word spacing up
  to the threshold, so `1` sets paragraphs as perfect rectangles wherever
  the text allows. Endings too short to reach the threshold at reasonable
  spacing keep their natural spacing, and the option never produces a
  shorter ending than leaving it off would.
- Removed `lastLineMinWords`. Use `lastLineMinWidth`: the objection to a
  lone word ending a paragraph is really about the line's width, which
  the width rule handles directly.
- For headless `justif/core` users: `BreakOptions.lastLineStretch` is
  replaced by `lastLineMinWidth` (set it to the same value as the build
  option, as the main API does).

## 0.2.2 (2026-07-16)

- Fixed: with tracking enabled (the default), a last line that shrinks to
  fit could overflow the measure by up to ~20px — it was set without the
  letterfit tightening the layout had counted on. Ragged last lines are
  unaffected.

## 0.2.1 (2026-07-15)

- Critical: production builds bundled with Vite 6 / Astro 5's default
  `build.target` silently justified nothing — their bundled esbuild
  mis-transformed justif's `dist`. The published files are now
  pre-lowered and verified against those targets.
- New `onSkip(paragraph, reason)` option: reports each paragraph justif
  declines and why. The drop-in script logs the same when given
  `data-justif-debug`.
- Fixed under-filled small-caps lines on Linux WebKit, which synthesizes
  small caps instead of using the font's own.
- README: documented the TeX-style tuning knobs and the inline-margin
  limitation.

## 0.2.0 (2026-07-15)

- Inline chips and pills are now first-class: horizontal padding and
  borders on inline elements (styled `code`, `kbd`, badges) are modeled
  instead of bailing the paragraph to native. Inline margins,
  `box-decoration-break: clone`, and preserved-whitespace `white-space`
  values still bail.
- Word spaces next to a font-family change stretch but no longer shrink
  below their natural width by default, matching native CSS
  justification around chips. New `spacing.boundaryShrink` option
  (default `0`; `1` restores TeX semantics).
- `white-space: nowrap` on inline elements is honored: no line break
  inside, spaces keep their justification flexibility.
- Author `font-variant-*` and `font-feature-settings` values no longer
  bail paragraphs to native: small caps, oldstyle/tabular numerals, and
  stylistic sets justify like everything else.
- A word wider than the measure now overflows from a line of its own —
  like a browser — instead of dragging the preceding words onto the
  overfull line with their spaces crushed.
- Fixed a padded chip at a line end rendering with its end padding
  slightly pinched.
- Drop-in: removed a console 404 on non-English pages served from bare
  package CDN URLs.

## 0.1.1 (2026-07-15)

- Drop-in: non-English pages loaded from a bare package CDN URL
  (`https://cdn.jsdelivr.net/npm/justif`) silently fell back to
  spacing-only justification — hyphenation language modules now load
  correctly there.

## 0.1.0 (2026-07-15)

Initial release.

- Zero-config drop-in: `<script type="module"
  src="https://cdn.jsdelivr.net/npm/justif"></script>` enhances everything
  the page's CSS justifies; hyphenation follows declared `lang`
  attributes.
- Knuth-Plass total-fit line breaking with TeX's badness/demerits model.
- Microtypography: character protrusion (optical margin alignment) with
  per-font tables, font expansion via the variable-font `wdth` axis,
  letterfit tracking (±3%), hanging punctuation presets.
- Pluggable hyphenation: 23 bundled languages (each its own entry),
  en-US from Knuth/Liang's original TeX patterns, and the Liang engine
  itself (`justif/hyphenate/liang`) for any other TeX pattern set.
- CJK (Japanese-first): per-cluster breaking, kinsoku shori, burasage.
- RTL: Hebrew/Arabic paragraphs with mirrored protrusion;
  mixed-direction content is left to native rendering.
- eTeX-style `\lastlinefit` and TeX-style short-last-line pressure.
- Accessible output: lines stay ordinary inline flow, so links,
  find-in-page, selection and copy work normally; `destroy()` restores
  the original markup byte-identically; automatic re-layout on resize;
  `content-visibility` cooperation for very long documents.
- Fail-safe: unsupported or throwing paragraphs keep native rendering;
  works under strict CSP and inside shadow DOM.
