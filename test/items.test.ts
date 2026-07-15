import { describe, expect, it } from "vitest";
import { buildItems } from "../src/core/items.js";
import {
  type BuildOptions,
  defaultBuildOptions,
  type Item,
  ItemType,
} from "../src/core/types.js";
import { hangingPunctuation, latinProtrusion } from "../src/core/protrusion.js";
import { charWidth, kernedMeasure, mockMeasure, mockRun } from "./helpers/mock.js";

function build(text: string, opts: Partial<BuildOptions> = {}) {
  return buildItems(
    [{ text, run: 0 }],
    [mockRun()],
    { ...defaultBuildOptions, ...opts },
    mockMeasure,
  );
}

function shape(items: Item[]): string {
  return items
    .map((it) => {
      if (it.type === ItemType.Box) return `box(${it.text})`;
      if (it.type === ItemType.Glue) return it.stretchFil > 0 ? "fil" : "glue";
      return `pen(${it.penalty})`;
    })
    .join(" ");
}

describe("buildItems", () => {
  it("builds box/glue alternation with the parfillskip tail", () => {
    const para = build("one two");
    expect(shape(para.items)).toBe("box(one) glue box(two) pen(10000) fil pen(-10000)");
  });

  it("collapses runs of whitespace and ignores leading/trailing space", () => {
    const para = build("  one \t\n two  ");
    expect(shape(para.items)).toBe("box(one) glue box(two) pen(10000) fil pen(-10000)");
  });

  it("merges whitespace across run boundaries", () => {
    const para = buildItems(
      [
        { text: "one ", run: 0 },
        { text: " two", run: 0 },
      ],
      [mockRun()],
      defaultBuildOptions,
      mockMeasure,
    );
    expect(shape(para.items)).toBe("box(one) glue box(two) pen(10000) fil pen(-10000)");
  });

  it("joins words split across runs without glue", () => {
    const para = buildItems(
      [
        { text: "beau", run: 0 },
        { text: "tiful rest", run: 0 },
      ],
      [mockRun()],
      defaultBuildOptions,
      mockMeasure,
    );
    expect(shape(para.items)).toBe(
      "box(beau) box(tiful) glue box(rest) pen(10000) fil pen(-10000)",
    );
  });

  it("turns soft hyphens into flagged penalties carrying the hyphen width", () => {
    const para = build("beau­tiful");
    expect(shape(para.items)).toBe("box(beau) pen(50) box(tiful) pen(10000) fil pen(-10000)");
    const pen = para.items[1]!;
    if (pen.type !== ItemType.Penalty) throw new Error("expected penalty");
    expect(pen.width).toBe(charWidth("-"));
    expect(pen.flagged).toBe(true);
    // Soft hyphens are author-provided: available in pass 1, unlike
    // hyphenator-inserted breaks.
    expect(pen.hyphen).toBe(false);
  });

  it("allows zero-width flagged breaks after explicit hyphens", () => {
    const para = build("lime-tree");
    expect(shape(para.items)).toBe("box(lime-) pen(50) box(tree) pen(10000) fil pen(-10000)");
    const pen = para.items[1]!;
    if (pen.type !== ItemType.Penalty) throw new Error("expected penalty");
    expect(pen.width).toBe(0);
    expect(pen.hyphen).toBe(false);
  });

  it("uses the hyphenator on long-enough letter cores, preserving case and punctuation", () => {
    const calls: string[] = [];
    const para = build('"Wonderful," said', {
      hyphenate: (w) => {
        calls.push(w);
        return [w.slice(0, 3), w.slice(3)];
      },
    });
    expect(calls).toEqual(["wonderful"]);
    expect(shape(para.items)).toBe(
      'box("Won) pen(50) box(derful,") glue box(said) pen(10000) fil pen(-10000)',
    );
    const pen = para.items[1]!;
    if (pen.type !== ItemType.Penalty) throw new Error("expected penalty");
    expect(pen.hyphen).toBe(true); // masked in pass 1
  });

  it("does not hyphenate short words", () => {
    const para = build("tiny", { hyphenate: (w) => [w.slice(0, 2), w.slice(2)] });
    expect(shape(para.items)).toBe("box(tiny) pen(10000) fil pen(-10000)");
  });

  it("inserts a discouraging penalty before the last glue when lastLineMinWords ≥ 2", () => {
    const para = build("one two three", { lastLineMinWords: 2 });
    expect(shape(para.items)).toBe(
      "box(one) glue box(two) pen(500) glue box(three) pen(10000) fil pen(-10000)",
    );
  });

  it("computes protrusion credits from the table and char advances", () => {
    const para = build("Times one,", {
      protrusion: { T: { l: 100 }, ",": { r: 700 } },
    });
    const first = para.items[0]!;
    const last = para.items[2]!;
    if (first.type !== ItemType.Box || last.type !== ItemType.Box) throw new Error("boxes");
    expect(first.lp).toBeCloseTo((100 / 1000) * charWidth("T"));
    expect(first.rp).toBe(0);
    expect(last.rp).toBeCloseTo((700 / 1000) * charWidth(","));
  });

  it("clamps protrusion to the ink for protrudeInkOnly (monospace) runs", () => {
    const inkMeasure = {
      ...mockMeasure,
      // Wide cells: every glyph has 3px of side bearing on each side.
      inkBearings: () => ({ l: 3, r: 3 }),
    };
    const para = buildItems(
      [{ text: "Times one,", run: 0 }],
      [mockRun({ protrudeInkOnly: true })],
      { ...defaultBuildOptions, protrusion: { T: { l: 900 }, ",": { r: 700 }, "-": { r: 500 } } },
      inkMeasure,
    );
    const first = para.items[0]!;
    const last = para.items[2]!;
    if (first.type !== ItemType.Box || last.type !== ItemType.Box) throw new Error("boxes");
    expect(first.lp).toBe(3); // 900‰ × 10px = 9px table hang, capped at the bearing
    expect(last.rp).toBeCloseTo(2.8); // 700‰ × 4px stays under the 3px bearing: uncapped
  });

  it("caps line-start hangs at ink exit; line-end hangs stay full", () => {
    const inkMeasure = {
      ...mockMeasure,
      inkBearings: () => ({ l: 1, r: 1.5 }),
    };
    const para = buildItems(
      [{ text: "“One two.”", run: 0 }],
      [mockRun()],
      { ...defaultBuildOptions, protrusion: { "“": { l: 1000 }, "”": { r: 1000 } } },
      inkMeasure,
    );
    const first = para.items[0]!;
    const last = para.items[2]!;
    if (first.type !== ItemType.Box || last.type !== ItemType.Box) throw new Error("boxes");
    // “ advance 5, full-cell hang 5 → capped at advance − right bearing.
    expect(first.lp).toBeCloseTo(5 - 1.5);
    // Right side keeps the full hang: the preceding text anchors the margin.
    expect(last.rp).toBeCloseTo(charWidth("”"));
  });

  it("a run's matched per-font table overrides the paragraph-wide table", () => {
    const para = buildItems(
      [{ text: "one two.", run: 0 }],
      // EB Garamond-style hand tuning: period 600 instead of the generic 700.
      [mockRun({ protrusion: { ".": { r: 600 } } })],
      { ...defaultBuildOptions, protrusion: latinProtrusion },
      mockMeasure,
    );
    const last = para.items[2]!;
    if (last.type !== ItemType.Box) throw new Error("box");
    expect(last.rp).toBeCloseTo((600 / 1000) * charWidth("."));
    // Without a per-font table, the paragraph-wide table applies.
    const generic = buildItems(
      [{ text: "one two.", run: 0 }],
      [mockRun()],
      { ...defaultBuildOptions, protrusion: latinProtrusion },
      mockMeasure,
    ).items[2]!;
    if (generic.type !== ItemType.Box) throw new Error("box");
    expect(generic.rp).toBeCloseTo((700 / 1000) * charWidth("."));
  });

  it("hangingPunctuation preset (merged over latin) hangs stops by their full advance", () => {
    const para = buildItems(
      [{ text: "“One, two.”", run: 0 }],
      [mockRun()],
      { ...defaultBuildOptions, protrusion: { ...latinProtrusion, ...hangingPunctuation } },
      mockMeasure,
    );
    const first = para.items[0]!; // “One,
    const last = para.items[2]!; // two.”
    if (first.type !== ItemType.Box || last.type !== ItemType.Box) throw new Error("boxes");
    expect(first.lp).toBeCloseTo(charWidth("“")); // 1000‰ = the whole quote
    expect(first.rp).toBeCloseTo(charWidth(",")); // full comma at a line end
    expect(last.rp).toBeCloseTo(charWidth("”"));
  });

  it("tracking budgets letterfit flex per box and folds it into the glue sums", () => {
    const para = build("one two", { tracking: { max: 0.03, shrink: 0.03 } });
    const box = para.items[0]!;
    if (box.type !== ItemType.Box) throw new Error("box");
    expect(box.trackStretch).toBeCloseTo(box.width * 0.03);
    expect(box.trackShrink).toBeCloseTo(box.width * 0.03);
    // cumY over the whole paragraph = glue stretch + all boxes' track flex.
    const plain = build("one two");
    const n = para.items.length;
    const trackTotal = para.items.reduce(
      (a, it) => a + (it.type === ItemType.Box ? it.trackStretch : 0),
      0,
    );
    expect(para.cumY[n]! - plain.cumY[n]!).toBeCloseTo(trackTotal);
  });

  it("attaches expansion stretchability proportional to box width", () => {
    const para = build("word", { expansion: { max: 0.02, shrink: 0.02, step: 0.005 } });
    const box = para.items[0]!;
    if (box.type !== ItemType.Box) throw new Error("box");
    // mockRun responds ±1% at the endpoints.
    expect(box.expStretch).toBeCloseTo(box.width * 0.01);
    expect(box.expShrink).toBeCloseTo(box.width * 0.01);
  });

  describe("kerning-safe fragment widths", () => {
    const kerned = kernedMeasure;

    it("hyphenation fragments sum exactly to the whole-word width", () => {
      const split = (w: string) => [w.slice(0, 3), w.slice(3, 6), w.slice(6)];
      const para = buildItems(
        [{ text: "beautiful", run: 0 }],
        [mockRun()],
        { ...defaultBuildOptions, hyphenate: split },
        kerned,
      );
      const boxes = para.items.filter((it) => it.type === ItemType.Box);
      expect(boxes.length).toBe(3);
      const sum = boxes.reduce((a, b) => a + (b as { width: number }).width, 0);
      expect(sum).toBeCloseTo(kerned.width("beautiful", mockRun()), 9);
    });

    it("explicit-hyphen fragments also sum to the whole-token width", () => {
      const para = buildItems(
        [{ text: "water-splasher,", run: 0 }],
        [mockRun()],
        defaultBuildOptions,
        kerned,
      );
      const boxes = para.items.filter((it) => it.type === ItemType.Box);
      const sum = boxes.reduce((a, b) => a + (b as { width: number }).width, 0);
      expect(sum).toBeCloseTo(kerned.width("water-splasher,", mockRun()), 9);
    });
  });


  it("keeps no-break spaces inside boxes (unbreakable, unstretchable)", () => {
    const para = build("Fig.\u00A03 shows");
    expect(shape(para.items)).toBe("box(Fig.\u00A03) glue box(shows) pen(10000) fil pen(-10000)");
  });

  it("emits a single glue around a whitespace-surrounded lone soft hyphen", () => {
    const para = build("a \u00AD b");
    expect(shape(para.items)).toBe("box(a) glue box(b) pen(10000) fil pen(-10000)");
  });

  it("ignores hyphenator output containing empty pieces", () => {
    const para = build("beautiful", { hyphenate: () => ["", "beautiful"] });
    expect(shape(para.items)).toBe("box(beautiful) pen(10000) fil pen(-10000)");
  });

  it("rejects hyphenator output whose total length differs from the input", () => {
    const para = build("beautiful", { hyphenate: () => ["beau", "tifull"] });
    expect(shape(para.items)).toBe("box(beautiful) pen(10000) fil pen(-10000)");
  });

  it("noHyphens runs (CSS hyphens:none) never hyphenate and strip soft hyphens", () => {
    const calls: string[] = [];
    const para = buildItems(
      [{ text: "beau­tiful ResizeObserver", run: 0 }],
      [{ ...mockRun(), noHyphens: true }],
      {
        ...defaultBuildOptions,
        hyphenate: (w) => {
          calls.push(w);
          return [w.slice(0, 4), w.slice(4)];
        },
      },
      mockMeasure,
    );
    expect(calls).toEqual([]);
    expect(shape(para.items)).toBe(
      "box(beautiful) glue box(ResizeObserver) pen(10000) fil pen(-10000)",
    );
  });

  it("builds correct cumulative sums and firstBoxAfter", () => {
    const para = build("one two");
    const n = para.items.length;
    expect(para.cumW[n]).toBeCloseTo(
      mockMeasure.width("one", mockRun()) + 4 + mockMeasure.width("two", mockRun()),
    );
    expect(para.firstBoxAfter[0]).toBe(0);
    expect(para.firstBoxAfter[1]).toBe(2);
    expect(para.firstBoxAfter[n]).toBe(n);
  });
});
