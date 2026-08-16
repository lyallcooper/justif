/**
 * The drop-in's declarative configuration surface: `--justif-*` custom
 * properties read off each candidate paragraph's computed style.
 *
 * Pure by construction — the caller supplies the values, so nothing here
 * touches the DOM. Only `auto.ts` imports this; it is bundled into the drop-in
 * rather than shipped as its own file.
 *
 * Values are ordinary CSS: keywords, percentages, and the plain fractions the
 * JavaScript API takes — `33%` and `0.33` are one configuration, not two.
 * `auto` selects the library default, `none` switches a feature off, and
 * anything unparseable is reported and falls back to the default — the same end
 * state CSS itself produces for an invalid declaration.
 */
import { hangingCharacters } from "./core/protrusion.js";
import {
  type HangingPunctuationOptions,
  layoutDefaults,
  type LayoutOptions,
} from "./options.js";

/** Every property, in the order the grouping key serializes them. */
export const CSS_PROPERTIES = [
  "--justif-hanging-punctuation",
  "--justif-hanging-characters-start",
  "--justif-hanging-characters-end",
  "--justif-protrusion",
  "--justif-expansion",
  "--justif-tracking",
  "--justif-last-line-min-width",
  "--justif-last-line-fit",
  "--justif-space-stretch",
  "--justif-space-shrink",
] as const;

export type CssProperty = (typeof CSS_PROPERTIES)[number];

/**
 * `@property` syntax per property, for the registration the live-update path
 * installs. Registration is what makes these transitionable — the change signal
 * — and it also makes them computed values, so `calc()` and the CSS-wide
 * keywords start working wherever it is supported.
 *
 * A consequence worth knowing: once registered, a value the syntax rejects never
 * reaches the parser at all. The engine substitutes the inherited or initial
 * value first, exactly as it does for every other property, so `invalid` below
 * only ever reports values that are the right TYPE but out of range.
 *
 * `true` and `false` trail each list as aliases of `auto` and `none` — see
 * `canonicalKeyword`. `false` appears only where `none` does, so a property that
 * has no "off" state has no `false` either.
 */
export const PROPERTY_SYNTAX: Readonly<Record<CssProperty, string>> = {
  "--justif-hanging-punctuation":
    "auto | line-end-only | first-line-and-line-ends | all-line-edges | none |" +
    " true | false",
  // The only two properties registered `*`, because their value is a quoted
  // STRING — the set of characters hanging punctuation treats as marginal —
  // and the `@property` grammar has no string type. `*` costs the pre-parse
  // rejection the note above describes, so a malformed value reaches the
  // parser instead of being substituted away; it is reported there. What `*`
  // keeps is the change signal, which is the half that matters and which
  // `allow-discrete` supplies for a non-interpolable value (verified in all
  // three engines).
  "--justif-hanging-characters-start": "*",
  "--justif-hanging-characters-end": "*",
  "--justif-protrusion": "auto | none | true | false",
  "--justif-expansion": "auto | none | <percentage> | <number> | true | false",
  "--justif-tracking": "auto | none | <percentage> | <number> | true | false",
  "--justif-last-line-min-width":
    "auto | none | <percentage> | <number> | true | false",
  "--justif-last-line-fit": "auto | <percentage> | <number> | true",
  "--justif-space-stretch": "auto | <percentage> | <number> | true",
  "--justif-space-shrink": "auto | <percentage> | <number> | true",
};

export interface ParsedOptions {
  /** Only the fields the author actually set to something non-default. */
  options: LayoutOptions;
  /**
   * Canonical identity of the resulting configuration: paragraphs sharing it
   * can share one controller. Empty when nothing was configured, so an
   * unconfigured page keeps producing exactly one controller per language.
   */
  key: string;
  /** Declarations that could not be parsed, for the warning channel. */
  invalid: Array<{ property: CssProperty; value: string }>;
}

const NUMERIC = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/;

/**
 * `true` and `false` are the JavaScript API's spellings of these switches, and
 * they mean exactly what `auto` and `none` mean here — so accept them rather than
 * make anyone arriving from the JavaScript docs learn a second vocabulary for the
 * same two states.
 *
 * Aliases, not extra states: `false` is therefore rejected on a property with no
 * `none` (a spacing limit, the last-line fit), the same way `none` itself is.
 */
function canonicalKeyword(raw: string): string {
  if (raw === "true") return "auto";
  if (raw === "false") return "none";
  return raw;
}

/**
 * Fractions serialize at fixed precision so that float noise cannot fragment
 * groups: 1/3 and 0.33333333333333337 must not become separate controllers.
 */
function serialize(value: number): string {
  return value.toFixed(6);
}

/**
 * A percentage, or the same thing as the plain number the JavaScript API takes:
 * `33%` and `0.33` mean one fraction and produce one configuration.
 */
function parseFraction(raw: string): number | undefined {
  const match = NUMERIC.exec(raw);
  if (match === null) return undefined;
  const value = Number(match[1]) / (match[2] === "%" ? 100 : 1);
  // Negative limits are meaningless here, and registration cannot reject them:
  // both `<percentage>` and `<number>` admit a minus sign.
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * A CSS string's value: outer quotes removed and escapes resolved, so that
 * `"\\2E\\2C\u201D"` and `".,\u201D"` are one set. Undefined when the value is not a
 * well-formed string — with `syntax:"*"` nothing rejects that before we see it.
 */
function parseCssString(raw: string): string | undefined {
  const quote = raw[0];
  if (raw.length < 2 || (quote !== '"' && quote !== "'") || raw.at(-1) !== quote) {
    return undefined;
  }
  const body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      out += body[i];
      continue;
    }
    const hex = /^[0-9a-fA-F]{1,6}/.exec(body.slice(i + 1));
    if (hex === null) {
      // A backslash escapes the character after it, including the quote.
      i += 1;
      out += body[i] ?? "";
      continue;
    }
    const code = Number.parseInt(hex[0], 16);
    // CSS Syntax §4.3.7: zero, surrogates and out-of-range hex escapes all
    // decode to U+FFFD — the string stays well-formed.
    out +=
      code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff
        ? "�"
        : String.fromCodePoint(code);
    i += hex[0].length;
    // A single trailing whitespace terminates a hex escape and is not content
    // — any whitespace, not just a space, and CRLF counts as the one newline
    // it is. Registered `*` keeps the author's own spelling, so a tab written
    // here really does arrive as a tab.
    const after = body[i + 1];
    if (after === " " || after === "\t" || after === "\n" || after === "\f") i += 1;
    else if (after === "\r") i += body[i + 2] === "\n" ? 2 : 1;
  }
  return out;
}

/** A set's canonical spelling: sorted, deduplicated code points. Membership is
 * all these values mean, so two orderings are one configuration. */
function canonicalSet(chars: string): string {
  return [...new Set(chars)].sort().join("");
}

/**
 * Resolve one property. Returns the option fields it contributes plus the
 * fragment it adds to the grouping key — empty when the value is the library
 * default, which is what collapses `auto`, absent, and "explicitly the current
 * default" into one group.
 */
function parseOne(
  property: CssProperty,
  raw: string,
): { options: LayoutOptions; keyPart: string } | "invalid" | "default" {
  if (raw === "none") {
    switch (property) {
      case "--justif-hanging-punctuation":
        return { options: { hangingPunctuation: "none" }, keyPart: "none" };
      // An empty side classifies nothing there — how "line starts only" and
      // "line ends only, by character" are spelled.
      case "--justif-hanging-characters-start":
        return {
          options: { hangingPunctuation: { characters: { start: "" } } },
          keyPart: "none",
        };
      case "--justif-hanging-characters-end":
        return {
          options: { hangingPunctuation: { characters: { end: "" } } },
          keyPart: "none",
        };
      case "--justif-protrusion":
        return { options: { protrusion: false }, keyPart: "none" };
      case "--justif-expansion":
        return { options: { expansion: false }, keyPart: "none" };
      case "--justif-tracking":
        return { options: { tracking: false }, keyPart: "none" };
      case "--justif-last-line-min-width":
        return { options: { lastLineMinWidth: 0 }, keyPart: "0" };
      // `none` says nothing about a spacing limit or last-line fitting.
      default:
        return "invalid";
    }
  }

  if (property === "--justif-hanging-punctuation") {
    // Canonical spellings only: the older "first-line" and "all-lines" names
    // stay a JavaScript-API compatibility matter, since one policy with two
    // spellings here would also mean two configurations to group by.
    if (
      raw === "line-end-only" ||
      raw === "first-line-and-line-ends" ||
      raw === "all-line-edges"
    ) {
      return raw === layoutDefaults.hangingPunctuation
        ? "default"
        : { options: { hangingPunctuation: raw }, keyPart: raw };
    }
    return "invalid";
  }
  if (
    property === "--justif-hanging-characters-start" ||
    property === "--justif-hanging-characters-end"
  ) {
    const side = property === "--justif-hanging-characters-start" ? "start" : "end";
    const chars = parseCssString(raw);
    if (chars === undefined) return "invalid";
    if (canonicalSet(chars) === canonicalSet(hangingCharacters[side])) return "default";
    // Keyed on the SET, not the spelling: order and repeats do not make a
    // second configuration, and so cannot split one controller into two.
    return {
      options: { hangingPunctuation: { characters: { [side]: chars } } },
      keyPart: canonicalSet(chars),
    };
  }
  // Protrusion is a two-state switch: the table-backed model stays API-only,
  // because passing a table silently bypasses per-font measurement.
  if (property === "--justif-protrusion") return "invalid";

  const fraction = parseFraction(raw);
  if (fraction === undefined) return "invalid";

  switch (property) {
    // One value sets both limits symmetrically; `step` is not exposed and keeps
    // its default. Zero and `none` are the same rendering, so they collapse to
    // one configuration.
    case "--justif-expansion": {
      if (fraction === 0) return { options: { expansion: false }, keyPart: "none" };
      const { max, shrink } = layoutDefaults.expansion;
      if (max === fraction && shrink === fraction) return "default";
      return {
        options: { expansion: { max: fraction, shrink: fraction } },
        keyPart: serialize(fraction),
      };
    }
    case "--justif-tracking": {
      if (fraction === 0) return { options: { tracking: false }, keyPart: "none" };
      const { max, shrink } = layoutDefaults.tracking;
      if (max === fraction && shrink === fraction) return "default";
      return {
        options: { tracking: { max: fraction, shrink: fraction } },
        keyPart: serialize(fraction),
      };
    }
    case "--justif-last-line-min-width":
    case "--justif-last-line-fit": {
      const key =
        property === "--justif-last-line-min-width" ? "lastLineMinWidth" : "lastLineFit";
      const clamped = Math.min(1, fraction);
      if (clamped === layoutDefaults[key]) return "default";
      return { options: { [key]: clamped }, keyPart: serialize(clamped) };
    }
    default: {
      const key = property === "--justif-space-stretch" ? "stretch" : "shrink";
      if (clampedEquals(fraction, layoutDefaults.spacing[key])) return "default";
      return { options: { spacing: { [key]: fraction } }, keyPart: serialize(fraction) };
    }
  }
}

/**
 * Compared at the key's own precision: an author writing `33.3333%` and the
 * library's exact 1/3 differ, but not by anything that survives serialization,
 * and treating them as different configurations would only split controllers.
 */
function clampedEquals(a: number, b: number): boolean {
  return serialize(a) === serialize(b);
}

/**
 * Fold one hanging-punctuation contribution into what the earlier properties
 * already said. The edges keyword and the two character sides are separate
 * declarations that describe one setting, so the object form appears only when
 * a side was named — an author who set edges alone keeps the plain string, and
 * with it the grouping key it has always produced.
 */
function mergeHanging(
  into: LayoutOptions["hangingPunctuation"],
  add: LayoutOptions["hangingPunctuation"],
): LayoutOptions["hangingPunctuation"] {
  // `true` is the drop-in's spelling of "the library default", which is what
  // an absent `edges` already means.
  const asObject = (
    v: LayoutOptions["hangingPunctuation"],
  ): HangingPunctuationOptions =>
    v === undefined || v === true ? {} : typeof v === "object" ? v : { edges: v };
  if (typeof into !== "object" && typeof add !== "object") return add;
  const a = asObject(into);
  const b = asObject(add);
  return {
    ...a,
    ...b,
    ...(a.characters !== undefined || b.characters !== undefined
      ? { characters: { ...a.characters, ...b.characters } }
      : {}),
  };
}

/**
 * Read the whole surface. `read` returns a property's computed value, or the
 * empty string when it is not set.
 */
export function parseCssOptions(read: (property: CssProperty) => string): ParsedOptions {
  const options: LayoutOptions = {};
  const invalid: ParsedOptions["invalid"] = [];
  const keyParts: string[] = [];
  for (const property of CSS_PROPERTIES) {
    // `getPropertyValue` pads registered properties, so trim before comparing.
    const raw = read(property).trim();
    const value = canonicalKeyword(raw);
    // Unset, or explicitly deferring to the library.
    if (value === "" || value === "auto") continue;
    const parsed = parseOne(property, value);
    if (parsed === "invalid") {
      // The author's own spelling, not the canonical one: a warning has to name
      // what is actually in the stylesheet.
      invalid.push({ property, value: raw });
      continue;
    }
    if (parsed === "default") continue;
    // `spacing` and `hangingPunctuation` are the fields several properties
    // contribute to: the edges keyword and one property per side.
    if (parsed.options.spacing !== undefined) {
      options.spacing = { ...options.spacing, ...parsed.options.spacing };
    } else if (parsed.options.hangingPunctuation !== undefined) {
      options.hangingPunctuation = mergeHanging(
        options.hangingPunctuation,
        parsed.options.hangingPunctuation,
      );
    } else {
      Object.assign(options, parsed.options);
    }
    keyParts.push(`${property.slice("--justif-".length)}:${parsed.keyPart}`);
  }
  return { options, key: keyParts.join(";"), invalid };
}
