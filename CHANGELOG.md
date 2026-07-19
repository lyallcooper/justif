# Changelog

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
  paragraph-ending rules. justif leaves them in the browser's normal layout
  until they wrap onto multiple lines. `lastLineMinWidth: 1` and CSS
  `text-align: justify-all` still explicitly request a full-width line.
- Fixed iOS Safari rendering parts of a justified paragraph at different text
  sizes after rotation. To keep enhanced paragraphs stable, justif now
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
- Added `onSkip(paragraph, reason)` to report paragraphs justif cannot enhance
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
- Unsupported content safely remains in browser layout. justif works under a
  strict Content Security Policy, inside shadow DOM, and with
  `content-visibility` on long pages.
