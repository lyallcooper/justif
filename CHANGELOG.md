# Changelog

## Unreleased

## 0.7.1 (2026-08-03)

- Fixed a bug where copying text could unexpectedly have a leading
  space.

## 0.7.0 (2026-08-01)

### Notable changes

- By default, **punctuation is now only hung off the line ends**. The previous
  default also hung punctuation off of the start of the first line of
  each paragraph. Set `hangingPunctuation` to `"first-line-and-line-ends"` to
  get the old default.
- **Behavior change**: `protrusion: false` no longer switches off hanging
  punctuation automatically. `hangingPunctuation` settings will now be respected
  (but not optically aligned) if protrusion is disabled.
- **API change** (non-breaking): `hangingPunctuation`'s options are now
  `"line-end-only"`, `"first-line-and-line-ends"`, `"all-line-edges"`, or
  `"none"`. See the [README
  section](https://github.com/lyallcooper/justif#protrusion-and-hanging-punctuation)
  for more details.
- **The drop-in script is now configurable via CSS.** Set `--justif-*` custom
  properties on `:root` to configure a whole page, or on any element to change
  one section or a single paragraph: hanging punctuation, protrusion, expansion,
  tracking, word-space limits, and the last-line settings. See the [README
  section](https://github.com/lyallcooper/justif#setting-options-in-css) for
  details.
- Optical margin alignment now dynamically measures each font's letterforms
  instead of relying on a hard-coded table. This allows for great alignment for
  any arbitrary font you use with Justif. See the
  [README](https://github.com/lyallcooper/justif#protrusion-and-hanging-punctuation)
  for more details.

### Various fixes

- `justify()` now accepts partial `expansion` and `spacing` objects, filling in
  the rest from the defaults, as `tracking` already did.
- New exported `layoutDefaults` gives the default value of every setting the CSS
  surface covers, for building configuration UI.
- Fixed paragraphs in a language other than English never being hyphenated when
  every paragraph in that language happened to fit on one line as the page
  loaded. Narrowing the window later wrapped them without hyphens.
- `justify()`'s controller now also exposes `managed`: the paragraphs it is
  still responsible for, excluding any it declined and any released since.
- New `controller.applyLayoutOptions(config)` changes typography settings on a
  live controller and re-lays out in place, without the teardown and rescan that
  `destroy()` plus `justify()` costs. Settings it does not cover — the
  hyphenator, callbacks — are left alone.
- Opening brackets are no longer forced fully into the margin. Measured fonts
  use their own bracket shapes; the built-in tables give parentheses a slight
  overhang and leave square brackets flush.
- One-line paragraphs now receive the same visible line-start alignment as
  longer paragraphs, without replacing their native markup.
- Unchanged one-line paragraphs no longer trigger `onRelayout` during a resize
  or `refresh()`.
- Monospace fonts no longer indent individual edge glyphs, preserving their
  visible character grid.
- Fixed Safari keeping the fallback font's line breaks and spacing when a font
  arrives after the text is justified, such as one loaded by a script or by
  late-running CSS.
- Fixed a wide gap opening beside an italic, bold, small-caps, or linked run
  in Charter, Hoefler Text, and a few other fonts, with every other word space
  on that line squeezed narrow to make room for it.

## 0.6.5 (2026-07-28)

- Long single-paragraph passages now reflow much faster, including the
  4,400-word excerpt on the demo page.
- On-screen paragraphs now receive their final spacing before `justify()`
  returns, avoiding a brief overhang when pages enhance before first paint.

## 0.6.4 (2026-07-26)

- Justif now loads on Safari and iOS below 16.4.
- `hyphens: none` is now honored on an inline run whose type matches the
  surrounding prose.
- Enhancement is about 13% faster on body text.
- Copying a selection that spans paragraphs from separate `justify()` calls no
  longer drops author non-breaking spaces.
- Pages that justify document after document no longer grow their memory
  without bound as more text is measured.

## 0.6.3 (2026-07-25)

- Fixed a few lines of a paragraph stretching to word spacing tens of pixels
  wide on pages whose CSS lets the browser break long words:
  `overflow-wrap: break-word` or `anywhere`, `word-break: break-all`, or
  `line-break: anywhere`. Those declarations could also move an inserted
  hyphen to the start of the following line; hyphens now stay at the end of
  the line they break (#10). Only paragraphs on screen when
  `justify()` ran showed the spacing, so the same text could look correct
  until it was scrolled into view.

## 0.6.2 (2026-07-25)

- Highlights made with third-party annotation tools (like Instapaper's
  browser extension) no longer silently fail to appear when the selected
  text crosses a hyphenated line break (#9).
- Browser extensions that highlight by splitting or wrapping Justif's
  rendered text no longer trigger errors in the deferred line-width
  corrections; affected lines keep their safe provisional spacing.

## 0.6.1 (2026-07-24)

- Fixed author-written non-breaking spaces (U+00A0 and narrow U+202F) stretching
  or shrinking with justification like ordinary word spaces. They now retain
  their authored width in indentation and no-break phrases.

## 0.6.0 (2026-07-24)

- Paragraphs spanning a CSS multicolumn break no longer receive roughly
  two-column line breaks or extreme spacing stretch in earlier columns.
  They are now measured and corrected against the individual column width
  instead of the bounding box of the whole spread. Fragmented drop caps and
  unequal-width page fragments safely remain in native layout.
- Paragraphs containing inline `<br>` elements are now enhanced instead of
  staying in browser layout. Set `text-align-last: justify` to tell Justif to
  justify lines ending in `<br>` instead of leaving them ragged.

## 0.5.1 (2026-07-23)

- Fixed drop-cap paragraphs rendering their opening lines below the float
  instead of beside it in Chrome. This happened whenever the paragraph also
  had CSS `hyphens: auto` (#4), or when a line next to the drop cap ended in
  a justif-inserted hyphen (#5). Affected lines kept their narrow spacing,
  leaving a large gap at the right margin. Inserted hyphens still hang into
  the margin, and lines next to a drop cap no longer extend past the column
  edge in any browser.

## 0.5.0 (2026-07-22)

- Paragraphs beginning with floated `::first-letter` drop caps can now use
  Justif's paragraph-wide line breaking. The drop cap keeps its styling and
  browser-native intrusion, including logical float directions and first
  letters split across styled inline content. Unsupported or too-narrow
  layouts safely remain browser-native, and drop-cap geometry is refreshed
  after font and layout changes.
- Fixed justified lines sometimes painting beyond the column edge in Firefox
  and Safari because browser text widths differed slightly from the measured
  model. Corrections are now distributed through the line's spacing, while
  intentional hanging punctuation continues to protrude into the margin.
- Fixed spaces emitted as separate JSX text nodes, such as `{" "}`, being
  treated as non-breaking spaces during justification. JSX and equivalent
  plain HTML now wrap identically around links and other inline content.
- The drop-in `dist/auto.js` script is now minified in release builds, reducing
  its uncompressed size by roughly 44% while keeping the existing CDN URL.

## 0.4.2 (2026-07-19)

- Fixed optical margin alignment for inline code, badges, and highlighted
  text with backgrounds or shadows. At column edges, their text now lines up
  with surrounding prose without clipping or pinching the decoration.
  Punctuation and inserted hyphens still hang normally when these elements
  wrap across lines.
- With `protrusion: false`, backgrounds, shadows, and padding stay inside the
  column whenever the content itself can fit. Genuinely too-wide unbreakable
  content keeps the usual overflow behavior. Transparent, inset, and sharp
  vertical-only shadows no longer affect margin alignment.

## 0.4.1 (2026-07-18)

- Short labels and other one-line text are no longer stretched by the default
  paragraph-ending rules. Justif leaves them in the browser's normal layout
  until they wrap onto multiple lines. `lastLineMinWidth: 1` and CSS
  `text-align: justify-all` still explicitly request a full-width line.
- Fixed iOS Safari rendering parts of a justified paragraph at different text
  sizes after rotation. To keep enhanced paragraphs stable, Justif now
  disables Safari's automatic text inflation for them; pages that rely on that
  inflation may display enhanced prose slightly smaller than nearby text.

## 0.4.0 (2026-07-17)

- The drop-in script can now avoid a re-layout flash on page load. Load it in
  `<head>` with `blocking="render"` and Chrome, Edge, and Safari can show
  justified text on the first paint. Firefox may still briefly show the
  browser's native justification, and hyphens appear once any on-demand
  language patterns finish loading.
- Text no longer waits for web fonts before being justified. It first uses the
  available fallback, then re-justifies when the intended font arrives. This
  also fixes Safari occasionally keeping the fallback layout after a slow font
  load. `controller.ready` and the new `window.justif.booted` resolve once
  fonts and layout have settled.
- Fonts that finish loading no longer trigger another layout when their
  arrival does not change the rendered text.
- `lastLineMinWidth` now uses the fullest achievable paragraph ending when the
  exact requested width is out of reach, and increasing the option can no
  longer make an ending shorter. Enabled tracking and font expansion can also
  help an ending reach its target without relying entirely on word spacing.

## 0.3.0 (2026-07-16)

- `lastLineMinWidth` now defaults to `0.33`, avoiding paragraph endings shorter
  than one third of the column by default. Pass `0` to restore the previous
  behavior.
- Fixed `lastLineMinWidth` values near `1` acting as though the option were
  disabled, and fixed endings that needed a hyphen being unable to reach the
  requested width.
- `lastLineMinWidth` now affects the rendered ending as well as the chosen
  line breaks. A value of `1` produces a full-width final line wherever the
  text can support one; endings that would require unreasonable spacing keep
  their natural width.
- Removed `lastLineMinWords`. Use `lastLineMinWidth` instead.
- For `justif/core` users, `BreakOptions.lastLineStretch` has been replaced by
  `lastLineMinWidth`; pass the same value to the build and break options.

## 0.2.2 (2026-07-16)

- Fixed final lines occasionally overflowing the column when tracking was
  enabled and the line needed to tighten. Naturally ragged final lines are
  unaffected.

## 0.2.1 (2026-07-15)

- Fixed a critical compatibility issue where production builds using the
  default Vite 6 or Astro 5 target could silently leave every paragraph
  unenhanced.
- Added `onSkip(paragraph, reason)` to report paragraphs Justif cannot enhance
  and explain why. The drop-in script provides the same diagnostics when
  `data-justif-debug` is present.
- Fixed small-caps lines appearing under-filled on Linux WebKit.

## 0.2.0 (2026-07-15)

- Paragraphs containing inline code, keycaps, badges, and other chips with
  horizontal padding or borders can now be enhanced instead of falling back
  to browser layout. Inline margins, `box-decoration-break: clone`, and
  preserved-whitespace modes remain unsupported.
- Spaces beside a font-family change no longer shrink by default, preventing
  surrounding text from crowding inline chips. Set `spacing.boundaryShrink`
  to `1` to restore the previous behavior.
- `white-space: nowrap` is now respected on inline elements: their contents
  stay together while their internal spaces remain adjustable.
- Small caps, oldstyle or tabular numerals, stylistic sets, and other
  `font-variant-*` or `font-feature-settings` choices can now be justified.
- A word wider than the column now overflows on a line of its own, matching
  browser behavior instead of crushing the spaces before it.
- Fixed the end padding of a chip appearing pinched at a line ending.
- Fixed a console 404 when the drop-in script was used from a bare package CDN
  URL on a non-English page.

## 0.1.1 (2026-07-15)

- Fixed non-English pages using the drop-in script from a bare package CDN URL
  (`https://cdn.jsdelivr.net/npm/justif`) silently falling back to
  spacing-only justification. Hyphenation language modules now load correctly.

## 0.1.0 (2026-07-15)

Initial release.

- A zero-config drop-in script enhances text already justified by the page's
  CSS, with hyphenation selected from each element's `lang` attribute.
- Paragraph-wide Knuth–Plass line breaking produces more even spacing than a
  browser's line-at-a-time justification.
- Optical margin alignment, hanging punctuation, letterfit tracking, and
  variable-font width adjustment provide restrained microtypography.
- Hyphenation is bundled for 23 languages, with support for custom TeX pattern
  sets through `justif/hyphenate/liang`.
- Japanese-first CJK support includes per-character line breaking, kinsoku,
  and hanging punctuation. Hebrew and Arabic paragraphs support right-to-left
  layout; mixed-direction paragraphs remain in browser layout.
- Controls are provided for short paragraph endings and last-line fitting.
- Enhanced text remains ordinary inline content, preserving links,
  find-in-page, selection, copying, and accessibility. Layout updates
  automatically on resize, and `destroy()` restores the original markup.
- Unsupported content safely remains in browser layout. Justif works under a
  strict Content Security Policy, inside shadow DOM, and with
  `content-visibility` on long pages.
