# justif

Better justified text for the web.

`justif` is a zero-dependency ESM library that applies TeX-style paragraph
layout to existing HTML. It chooses line breaks across the whole paragraph,
then uses hyphenation and microtypography to produce more even spacing than
native browser justification.

It is a progressive enhancement. Your HTML and CSS provide the initial and
fallback rendering, while `justif` upgrades paragraphs it can measure
reliably. Unsupported paragraphs are left untouched.

## Why it exists

Browsers normally justify one line at a time. A locally acceptable break can
make the next line too loose, create visible rivers of whitespace, or force a
poor break near the end of the paragraph.

`justif` uses the [Knuth-Plass line-breaking
algorithm](https://doi.org/10.1002/spe.4380111102) to evaluate a paragraph as
a whole. It can also:

- hyphenate words using bundled TeX patterns;
- hang punctuation into the margin for a cleaner text edge;
- make small per-line width adjustments on variable fonts with a `wdth` axis;
- make small letter-spacing adjustments when needed;
- justify CJK text between characters with Japanese kinsoku rules.

The result remains inline HTML. Links, emphasis, selection, copying,
find-in-page, and assistive technology keep normal paragraph semantics.

## Quick start

### Add one script

Keep native justification in your CSS, then load the automatic entry:

```html
<style>
  article p {
    text-align: justify;
  }
</style>

<script type="module" src="https://cdn.jsdelivr.net/npm/justif"></script>
```

The script scans `p`, `li`, `dd`, `blockquote`, and `figcaption` elements once
the DOM is ready. It enhances only elements whose computed `text-align` is
`justify` or `justify-all`.

Set the page language so the correct hyphenation rules are used:

```html
<html lang="en-US">
```

Unlabelled and generic English content uses American English. Other bundled
languages are loaded on demand. If a language is not bundled, the text is
still justified without automatic hyphenation.

To limit the automatic scan, add a selector to the script:

```html
<script
  type="module"
  data-justif-selector="article .prose p"
  src="https://cdn.jsdelivr.net/npm/justif"
></script>
```

### Use the JavaScript API

Install the package:

```sh
npm install justif
```

Then choose the elements and hyphenator explicitly:

```js
import { justify } from "justif";
import { hyphenateEnUS } from "justif/hyphenate/en-us";

const controller = justify(document.querySelectorAll("article p"), {
  hyphenate: hyphenateEnUS,
  lastLineMinWidth: 0.33,
});

await controller.ready;

// Re-measure after the active font files change.
controller.refresh();

// Restore the original paragraph DOM and stop observing resizes.
controller.destroy();
```

Container width changes and newly loaded webfonts are handled automatically.
If paragraph content or its computed text styles change, call `destroy()` and
run `justify()` again so the paragraph can be rescanned.

`justify()` accepts one `Element` or any iterable of elements. The returned
controller exposes `ready`, `refresh()`, `destroy()`, and the selected
`paragraphs`. `unjustify(elements)` can restore elements without access to
their original controller.

## Hyphenation

The automatic script selects hyphenators from the nearest `lang` attribute.
With the JavaScript API, import one hyphenator per language group:

```js
import { justify } from "justif";
import { hyphenateDe } from "justif/hyphenate/de";

justify(document.querySelectorAll("p:lang(de)"), {
  hyphenate: hyphenateDe,
});
```

The package includes Catalan, Danish, Dutch, English (US and GB), Finnish,
French, German, Greek, Croatian, Hungarian, Italian, Norwegian Bokmål and
Nynorsk, Polish, Portuguese, Russian, Slovak, Slovenian, Spanish, Swedish,
Turkish, and Ukrainian.

You can also pass any function with this shape:

```js
const exceptions = new Map([
  ["typography", ["ty", "pog", "ra", "phy"]],
]);

const hyphenate = (lowercaseWord) =>
  exceptions.get(lowercaseWord) ?? [lowercaseWord];
```

The returned fragments must join back to the input word. Author-provided soft
hyphens are honored without a callback. Add `hyphens: none` to an inline
element, such as `code`, to suppress both automatic and soft hyphenation
inside it.

## Options

These are the options most applications need:

| Option | Default | Purpose |
| --- | --- | --- |
| `hyphenate` | none | Splits a lowercase word into hyphenatable fragments |
| `protrusion` | `true` | Enables optical margin alignment; pass `false` or a character table |
| `hangingPunctuation` | `"first-line"` | Fully hangs opening marks on the first line and stops or quotes at line ends; also accepts `"all-lines"` or `false` |
| `expansion` | `{ max: 0.02, shrink: 0.02, step: 0.005 }` | Adjusts a usable variable-font `wdth` axis by up to 2 percent; silently disables itself for other fonts |
| `tracking` | `{ max: 0.03, shrink: 0.03 }` | Allows small per-line letter-spacing adjustments; pass `false` to disable |
| `spacing` | `{ stretch: 0.5, shrink: 1/3, pull: 0.7 }` | Controls inter-word spacing flexibility |
| `lastLineMinWidth` | off | Discourages endings shorter than this fraction of the measure; `0.33` is a useful starting point |
| `lastLineMinWords` | `0` | Discourages a last line with fewer than this many words when set to `2` or more |
| `lastLineFit` | `0` | Makes the last line adopt a fraction from `0` to `1` of the paragraph's average spacing adjustment |
| `observeResize` | `true` | Reflows managed paragraphs when their width changes |
| `cleanClipboard` | `true` | Removes layout-only characters from copied text while preserving author nonbreaking spaces |
| `onRelayout` | none | Runs after a paragraph is patched, including after resize and refresh |

The exported `JustifyOptions` type also includes lower-level line-breaking
penalties and tolerances for applications that need TeX-style tuning.

## Supported content and fallback behavior

`justif` supports horizontal LTR text, CJK text, and pure RTL Hebrew or Arabic
paragraphs. Inline markup such as links, `em`, `strong`, and `code` may wrap
across lines.

A paragraph stays on native browser layout when `justif` cannot reproduce it
reliably. Important examples include:

- mixed LTR and RTL text;
- vertical writing, Thai, and Lao;
- images, form controls, `<br>`, SVG, MathML, floats, or block descendants;
- inline descendants with horizontal padding, borders, or margins;
- content-editable paragraphs and unsupported font-feature overrides.

Keep `text-align: justify` in your CSS so these paragraphs still have a useful
fallback. One unsupported paragraph does not prevent its siblings from being
enhanced.

While a paragraph is managed, its inline descendants are rendered as clones.
Use delegated event handlers for interactive inline content. Event listeners
attached directly to the original descendants are available again after
`destroy()`, but they are not copied to the rendered clones. The same applies
to JavaScript references to those original descendants.

`justif` requires a modern browser with canvas text measurement,
`ResizeObserver`, `IntersectionObserver`, and CSS logical margins. Importing
the package during SSR is safe, but `justify()` only enhances content in a
browser. The DOM-free layout engine is available from `justif/core` for custom
renderers.

## License

MIT. Bundled hyphenation patterns retain the licenses recorded in their
module headers.
