import { describe, expect, it } from "vitest";
import { latinProtrusion } from "../src/core/protrusion.js";
import { buildItems } from "../src/core/items.js";
import { defaultBuildOptions, ItemType } from "../src/core/types.js";
import { intrudedLineCount } from "../src/dom/float-geometry.js";
import { contentString } from "../src/dom/generated-content.js";
import { mockMeasure, mockRun } from "./helpers/mock.js";

it("keeps boundary advance rigid and hangs only its explicit protrusion", () => {
  const build = (edges: boolean, protrusion = true) => buildItems([{
    text: '“Union.”', run: 0,
    ...(edges ? {
      startEdge: { advancePx: 18, protrusionPx: 2 },
      endEdge: { advancePx: 21, protrusionPx: 0 },
    } : {}),
  }], [mockRun()], { ...defaultBuildOptions, protrusion: protrusion ? latinProtrusion : false as const }, mockMeasure)
    .items.find((item) => item.type === ItemType.Box)!;
  const plain = build(false);
  const edge = build(true);
  expect(edge.width - plain.width).toBeCloseTo(39);
  expect(edge.padPx).toBe(39);
  expect(edge.lp).toBe(2);
  expect(edge.lpFirst).toBe(2);
  expect(edge.rp).toBe(0);
  expect(edge.expStretch).toBe(plain.expStretch);
  expect(edge.trackStretch).toBe(plain.trackStretch);
  expect(build(true, false).lp).toBe(0);
});

it("applies boundaries only to the element's actual opening and closing boxes", () => {
  const items = buildItems([{
    text: '“One two three.”', run: 0,
    startEdge: { advancePx: 10, protrusionPx: 0 },
    endEdge: { advancePx: 12, protrusionPx: 0 },
  }], [mockRun()], defaultBuildOptions, mockMeasure).items.filter((item) => item.type === ItemType.Box);
  expect(items.map((item) => item.padPx ?? 0)).toEqual([10, 0, 12]);
  expect(items[0]!.lp).toBe(0);
  expect(items[2]!.rp).toBe(0);
});

describe("computed CSS content strings", () => {
  it("decodes CSS escapes rather than treating content as JSON", () => {
    expect(contentString('"\\2197 "')).toBe("↗");
    expect(contentString(String.raw`"\22 \\"`)).toBe('"\\');
    expect(contentString('"\\0 "')).toBe("\ufffd");
    expect(contentString('"↗"')).toBe("↗");
  });
  it("rejects content token lists and functions", () => {
    for (const value of ['counter(item)', 'attr(title)', 'url("x")', '"a" "b"', '"a" / "alternative"', 'none']) {
      expect(contentString(value)).toBeNull();
    }
  });
});

it("does not turn first-line ink overshoot into an extra float line", () => {
  const style = {
    textAlign: "justify", direction: "ltr", getPropertyValue: () => "auto",
  } as unknown as CSSStyleDeclaration;
  const lines = [385.98, 423.90, 461.82, 499.74].map((top, i) => ({
    top, left: i < 3 ? 69 : 0, right: 781,
  }));
  const content = { top: 386.98, left: 0, right: 781, lineHeight: 37.92 };
  expect(intrudedLineCount(lines, content, style, "left", 69, 500.74, 0)).toBe(3);
  expect(intrudedLineCount(lines, content, style, "left", 69, 501.74, 0)).toBe(4);
});
