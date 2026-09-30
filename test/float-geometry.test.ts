import { describe, expect, it } from "vitest";
import { displacedFloatLines, visualLines } from "../src/dom/float-geometry.js";

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

describe("float placement validation", () => {
  function displaced(tops: readonly number[]): boolean {
    const source = {
      getBoundingClientRect: () => rect(0, 60.8, 0, 50),
    } as Element;
    const p = {
      getBoundingClientRect: () => rect(0, 100, 0, 300),
      ownerDocument: {
        defaultView: {
          getComputedStyle: (el: Element) => el === source
            ? { float: "left", direction: "ltr", marginBottom: "0px", marginRight: "0px" }
            : {
              borderLeftWidth: "0px", paddingLeft: "0px",
              borderRightWidth: "0px", paddingRight: "0px",
              borderTopWidth: "0px", paddingTop: "0px",
              lineHeight: "31.2px", fontSize: "24px",
            },
        },
      },
    } as unknown as HTMLElement;
    const lines = tops.map((top) => [{
      el: {
        isConnected: true,
        getBoundingClientRect: () => rect(top, top + 24, 50, 300),
      } as HTMLElement,
      seg: {},
    }]);
    return displacedFloatLines(p, source, lines, 2);
  }

  it("allows text below the float bottom in a partially overlapping final band", () => {
    // The float ends within the second 31.2px line box. The font's ink
    // rectangle can begin below that edge without the line being displaced.
    expect(displaced([30, 62.2])).toBe(false);
  });

  it("rejects a complete leading band displaced below the float", () => {
    expect(displaced([62.2, 93.4])).toBe(true);
  });
});
