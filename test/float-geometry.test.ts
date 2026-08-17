import { describe, expect, it } from "vitest";
import { visualLines } from "../src/dom/float-geometry.js";

function rect(top: number, bottom: number, left = 0, right = 100): DOMRect {
  return {
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
  } as DOMRect;
}

describe("visual float lines", () => {
  it("keeps overlapping glyph rows distinct under tight leading", () => {
    const rects = Array.from({ length: 6 }, (_, line) => rect(5 + line * 16, 27 + line * 16));

    expect(visualLines(rects, 16)).toHaveLength(6);
  });

  it("coalesces compact MathML descendants without consuming the next line", () => {
    const rects = [
      rect(0, 20, 0, 60),
      rect(3, 32, 65, 120),
      rect(22, 34, 82, 98),
      rect(33, 53, 0, 120),
    ];

    expect(visualLines(rects, 23)).toMatchObject([
      { top: 0, bottom: 34, left: 0, right: 120 },
      { top: 33, bottom: 53, left: 0, right: 120 },
    ]);
  });
});
