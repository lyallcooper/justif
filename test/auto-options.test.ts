import { describe, expect, it } from "vitest";
import {
  CSS_PROPERTIES,
  type CssProperty,
  parseCssOptions,
} from "../src/auto-options.js";
import { layoutDefaults } from "../src/index.js";

/** Read from a plain record, standing in for a computed style declaration. */
function from(declared: Partial<Record<CssProperty, string>>) {
  return parseCssOptions((property) => declared[property] ?? "");
}

describe("--justif-* parsing", () => {
  it("treats unset and auto alike: no options, no key, no complaints", () => {
    const unset = from({});
    expect(unset.options).toEqual({});
    expect(unset.key).toBe("");
    expect(unset.invalid).toEqual([]);

    const auto = from(Object.fromEntries(CSS_PROPERTIES.map((p) => [p, "auto"])));
    expect(auto.options).toEqual({});
    expect(auto.key).toBe("");
    expect(auto.invalid).toEqual([]);
  });

  it("reads keywords and percentages", () => {
    expect(from({ "--justif-hanging-punctuation": "all-line-edges" }).options).toEqual({
      hangingPunctuation: "all-line-edges",
    });
    expect(
      from({ "--justif-hanging-punctuation": "first-line-and-line-ends" }).options,
    ).toEqual({ hangingPunctuation: "first-line-and-line-ends" });
    expect(from({ "--justif-hanging-punctuation": "none" }).options).toEqual({
      hangingPunctuation: "none",
    });
    expect(from({ "--justif-protrusion": "none" }).options).toEqual({ protrusion: false });
    expect(from({ "--justif-last-line-min-width": "50%" }).options).toEqual({
      lastLineMinWidth: 0.5,
    });
    expect(from({ "--justif-last-line-fit": "25%" }).options).toEqual({ lastLineFit: 0.25 });
  });

  it("takes true and false as the JavaScript spellings of auto and none", () => {
    // `true` is `auto`: the library default, so it contributes no option and no
    // key fragment — an author writing it must not land in a second controller.
    const allTrue = from(Object.fromEntries(CSS_PROPERTIES.map((p) => [p, "true"])));
    expect(allTrue.options).toEqual({});
    expect(allTrue.key).toBe("");
    expect(allTrue.invalid).toEqual([]);

    // `false` is `none`, down to the grouping key, so the two spellings of one
    // configuration stay one configuration.
    for (const property of [
      "--justif-hanging-punctuation",
      "--justif-protrusion",
      "--justif-expansion",
      "--justif-tracking",
      "--justif-last-line-min-width",
    ] as const) {
      const asFalse = from({ [property]: "false" });
      const asNone = from({ [property]: "none" });
      expect(asFalse, property).toEqual(asNone);
      expect(asFalse.invalid, property).toEqual([]);
    }
    expect(from({ "--justif-protrusion": "false" }).options).toEqual({ protrusion: false });

    // Aliases, not extra states: where there is no `none` there is no `false`,
    // and the warning names the author's spelling rather than the canonical one.
    for (const property of [
      "--justif-last-line-fit",
      "--justif-space-stretch",
      "--justif-space-shrink",
    ] as const) {
      expect(from({ [property]: "false" }).invalid, property).toEqual([
        { property, value: "false" },
      ]);
    }
  });

  it("sets both limits from one value for expansion and tracking", () => {
    expect(from({ "--justif-expansion": "4%" }).options).toEqual({
      expansion: { max: 0.04, shrink: 0.04 },
    });
    expect(from({ "--justif-tracking": "1.5%" }).options).toEqual({
      tracking: { max: 0.015, shrink: 0.015 },
    });
  });

  it("merges the two spacing longhands into one field", () => {
    const both = from({
      "--justif-space-stretch": "80%",
      "--justif-space-shrink": "20%",
    });
    expect(both.options).toEqual({ spacing: { stretch: 0.8, shrink: 0.2 } });
    // One alone leaves the other to its default rather than pinning it.
    expect(from({ "--justif-space-shrink": "20%" }).options).toEqual({
      spacing: { shrink: 0.2 },
    });
  });

  it("normalizes zero to off for expansion and tracking", () => {
    // {max: 0, shrink: 0} and "disabled" render identically; collapsing them
    // keeps one configuration instead of two.
    expect(from({ "--justif-expansion": "0%" }).options).toEqual({ expansion: false });
    expect(from({ "--justif-tracking": "0%" }).options).toEqual({ tracking: false });
    expect(from({ "--justif-expansion": "0%" }).key).toBe(
      from({ "--justif-expansion": "none" }).key,
    );
  });

  it("clamps the last-line fractions to 100%", () => {
    expect(from({ "--justif-last-line-min-width": "150%" }).options).toEqual({
      lastLineMinWidth: 1,
    });
    expect(from({ "--justif-last-line-fit": "300%" }).options).toEqual({ lastLineFit: 1 });
  });

  it("accepts a plain fraction as an alias for the percentage", () => {
    // The JavaScript API takes fractions, so the two spellings of one setting
    // must mean the same thing — and must not split controllers.
    for (const [number, percentage] of [
      ["0.5", "50%"],
      ["0.33", "33%"],
      ["0", "0%"],
      ["1", "100%"],
    ]) {
      const property: CssProperty = "--justif-last-line-min-width";
      expect(from({ [property]: number }), `${number} vs ${percentage}`).toEqual(
        from({ [property]: percentage }),
      );
    }
    expect(from({ "--justif-tracking": "0.015" }).options).toEqual({
      tracking: { max: 0.015, shrink: 0.015 },
    });
    expect(from({ "--justif-space-stretch": "0.8" }).options).toEqual({
      spacing: { stretch: 0.8 },
    });
    // A fraction above 1 is a fraction, not a percentage missing its sign: this
    // is the one place the two spellings can be confused, and 3 means 300%.
    expect(from({ "--justif-tracking": "3" }).options).toEqual({
      tracking: { max: 3, shrink: 3 },
    });
  });

  it("rejects what CSS would not accept here, and reports it", () => {
    const cases: Array<[CssProperty, string]> = [
      // calc() cannot be evaluated without @property registration.
      ["--justif-expansion", "calc(1% * 2)"],
      // Negative limits are syntactically valid CSS but meaningless — in
      // either spelling, since <number> admits a minus sign too.
      ["--justif-tracking", "-3%"],
      ["--justif-space-stretch", "-10%"],
      ["--justif-last-line-min-width", "-0.5"],
      // Wrong keyword for the property.
      ["--justif-hanging-punctuation", "line-ends"],
      ["--justif-protrusion", "50%"],
      ["--justif-last-line-fit", "none"],
      ["--justif-space-shrink", "none"],
      // Canonical spellings only: the older JavaScript-API names for two of the
      // policies are not part of the CSS surface.
      ["--justif-hanging-punctuation", "first-line"],
      ["--justif-hanging-punctuation", "all-lines"],
      ["--justif-expansion", "garbage"],
    ];
    for (const [property, value] of cases) {
      const result = from({ [property]: value });
      expect(result.invalid, `${property}: ${value}`).toEqual([{ property, value }]);
      // Invalid means "fall back to the default", exactly as CSS behaves.
      expect(result.options, `${property}: ${value}`).toEqual({});
      expect(result.key, `${property}: ${value}`).toBe("");
    }
  });
});

describe("configuration identity (controller grouping)", () => {
  it("collapses an explicitly-specified current default into the default group", () => {
    // Anything that resolves to what the library would have done anyway must not
    // create a second controller.
    const asDefault: Array<Partial<Record<CssProperty, string>>> = [
      { "--justif-hanging-punctuation": "line-end-only" },
      { "--justif-expansion": "2%" },
      { "--justif-tracking": "3%" },
      { "--justif-last-line-fit": "0%" },
      { "--justif-space-stretch": "50%" },
      // Both spellings of a default collapse, including the fraction a
      // reader would copy straight out of the options table.
      { "--justif-last-line-min-width": "0.33" },
      { "--justif-expansion": "0.02" },
    ];
    for (const declared of asDefault) {
      const result = from(declared);
      expect(result.key, JSON.stringify(declared)).toBe("");
      expect(result.options, JSON.stringify(declared)).toEqual({});
    }
  });

  it("distinguishes the two near-thirds defaults, which are different numbers", () => {
    // lastLineMinWidth defaults to exactly 0.33, so 33% IS the default...
    expect(layoutDefaults.lastLineMinWidth).toBe(0.33);
    expect(from({ "--justif-last-line-min-width": "33%" }).key).toBe("");
    // ...while spacing.shrink defaults to 1/3, which 33% is not.
    expect(layoutDefaults.spacing.shrink).toBe(1 / 3);
    expect(from({ "--justif-space-shrink": "33%" }).key).not.toBe("");
  });

  it("gives distinct configurations distinct keys, and equal ones equal keys", () => {
    const a = from({ "--justif-tracking": "none", "--justif-last-line-min-width": "50%" });
    const b = from({ "--justif-tracking": "none", "--justif-last-line-min-width": "50%" });
    const c = from({ "--justif-tracking": "none", "--justif-last-line-min-width": "60%" });
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(a.key).not.toBe("");
  });

  it("keys on the resolved value, not the declaration order or spelling", () => {
    // The key is built in a fixed property order, so the order the author
    // happened to declare things in cannot fragment groups.
    const one = from({
      "--justif-space-shrink": "20%",
      "--justif-tracking": "none",
      "--justif-space-stretch": "80%",
    });
    const two = from({
      "--justif-space-stretch": "80%",
      "--justif-space-shrink": "20%",
      "--justif-tracking": "none",
    });
    expect(one.key).toBe(two.key);
    // Equivalent spellings of the same fraction agree too.
    expect(from({ "--justif-last-line-min-width": "50%" }).key).toBe(
      from({ "--justif-last-line-min-width": "50.0%" }).key,
    );
  });

  it("does not fragment on float noise", () => {
    // 0.1 + 0.2 style drift must not read as a different configuration.
    const exact = from({ "--justif-space-stretch": `${(0.30000000000000004 * 100).toString()}%` });
    const rounded = from({ "--justif-space-stretch": "30%" });
    expect(exact.key).toBe(rounded.key);
  });

  it("ignores surrounding whitespace, as computed values carry it", () => {
    expect(from({ "--justif-tracking": "  none  " }).options).toEqual({ tracking: false });
    expect(from({ "--justif-last-line-min-width": " 50% " }).options).toEqual({
      lastLineMinWidth: 0.5,
    });
  });
});
