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
import { layoutDefaults, type LayoutOptions } from "./index.js";

/** Every property, in the order the grouping key serializes them. */
export const CSS_PROPERTIES = [
  "--justif-hanging-punctuation",
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
    // `spacing` is the one field two properties contribute to.
    if (parsed.options.spacing !== undefined) {
      options.spacing = { ...options.spacing, ...parsed.options.spacing };
    } else {
      Object.assign(options, parsed.options);
    }
    keyParts.push(`${property.slice("--justif-".length)}:${parsed.keyPart}`);
  }
  return { options, key: keyParts.join(";"), invalid };
}
