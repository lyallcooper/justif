import { describe, expect, it } from "vitest";
import { buildItems, textMakesBox } from "../src/core/items.js";
import {
  type BuildOptions,
  defaultBuildOptions,
  type Glue,
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

  it("keeps floated first-letter text but excludes it from inline-flow metrics", () => {
    const run = mockRun();
    const para = buildItems(
      [{ text: "Among friends", run: 0, flowExclusion: { start: 0, end: 1 } }],
      [run],
      {
        ...defaultBuildOptions,
        tracking: { max: 0.03, shrink: 0.03 },
      },
      kernedMeasure,
    );
    const first = para.items.find((item) => item.type === ItemType.Box)!;
    expect(first.text).toBe("Among");
    expect(first.width).toBeCloseTo(kernedMeasure.width("mong", run));
    expect(first.flowChars).toBe(4);
    expect(first.flowExclusion).toEqual({ start: 0, end: 1 });
    expect(first.trackStretch).toBeCloseTo(first.width * 0.03);
  });

  it("keeps the collapsed source space after a one-letter floated word at zero width", () => {
    const para = buildItems(
      [{ text: "A story begins", run: 0, flowExclusion: { start: 0, end: 1 } }],
      [mockRun()],
      defaultBuildOptions,
      mockMeasure,
    );
    const boxes = para.items.filter((item) => item.type === ItemType.Box);
    expect(boxes[0]).toMatchObject({
      text: "A",
      width: 0,
      flowChars: 0,
      flowExclusion: { start: 0, end: 1 },
    });
    expect(boxes[1]!.text).toBe("story");
    const leadingGlue = para.items.find(
      (item) => item.type === ItemType.Glue && item.stretchFil === 0,
    )!;
    expect(leadingGlue).toMatchObject({ width: 0, stretch: 0, shrink: 0 });
    expect(para.items[para.items.indexOf(leadingGlue) - 1]).toMatchObject({
      type: ItemType.Penalty,
      penalty: 10000,
    });
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

describe("inline box extras (padding/border)", () => {
  it("shares box-worthiness with the tokenizer for no-break spaces", () => {
    expect(textMakesBox(" \t\n\u00AD")).toBe(false);
    expect(textMakesBox("\u00A0")).toBe(true);
    expect(textMakesBox("\u202F")).toBe(true);
  });

  const protrusionOpts: Partial<BuildOptions> = { protrusion: latinProtrusion };

  it("folds padStart/padEnd into the element's first/last box widths", () => {
    const para = buildItems(
      [
        { text: "see ", run: 0 },
        { text: "chip words", run: 1, padStartPx: 3, padEndPx: 5 },
        { text: " after", run: 0 },
      ],
      [mockRun(), mockRun()],
      defaultBuildOptions,
      mockMeasure,
    );
    const boxes = para.items.filter((it) => it.type === ItemType.Box);
    expect(boxes.map((b) => b.text)).toEqual(["see", "chip", "words", "after"]);
    expect(boxes[1]!.width).toBeCloseTo(mockMeasure.width("chip", mockRun()) + 3);
    expect(boxes[1]!.padPx).toBe(3);
    expect(boxes[2]!.width).toBeCloseTo(mockMeasure.width("words", mockRun()) + 5);
    expect(boxes[2]!.padPx).toBe(5);
    // Neighbors untouched.
    expect(boxes[0]!.width).toBeCloseTo(mockMeasure.width("see", mockRun()));
    expect(boxes[3]!.width).toBeCloseTo(mockMeasure.width("after", mockRun()));
  });

  it("carries pending padStart across a whitespace-only first piece", () => {
    const para = buildItems(
      [
        { text: " ", run: 1, padStartPx: 4 },
        { text: "word", run: 2, padEndPx: 6 },
      ],
      [mockRun(), mockRun(), mockRun()],
      defaultBuildOptions,
      mockMeasure,
    );
    const boxes = para.items.filter((it) => it.type === ItemType.Box);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.width).toBeCloseTo(mockMeasure.width("word", mockRun()) + 4 + 6);
    expect(boxes[0]!.padPx).toBe(10);
  });

  it("zeroes protrusion at padded edges (the decoration is the boundary)", () => {
    const bare = buildItems(
      [{ text: '"quote."', run: 0 }],
      [mockRun()],
      { ...defaultBuildOptions, ...protrusionOpts },
      mockMeasure,
    );
    const bareBox = bare.items.find((it) => it.type === ItemType.Box)!;
    expect(bareBox.lp).toBeGreaterThan(0);
    expect(bareBox.rp).toBeGreaterThan(0);

    const padded = buildItems(
      [{ text: '"quote."', run: 0, padStartPx: 2, padEndPx: 2 }],
      [mockRun()],
      { ...defaultBuildOptions, ...protrusionOpts },
      mockMeasure,
    );
    const padBox = padded.items.find((it) => it.type === ItemType.Box)!;
    expect(padBox.lp).toBe(0);
    expect(padBox.lpFirst).toBe(0);
    expect(padBox.rp).toBe(0);
  });

  it("computes expansion and tracking flex from the glyph width, not the padded width", () => {
    const w = mockMeasure.width("chip", mockRun());
    const para = buildItems(
      [{ text: "chip", run: 0, padStartPx: 10, padEndPx: 10 }],
      [mockRun()],
      {
        ...defaultBuildOptions,
        expansion: { max: 0.02, shrink: 0.02, step: 0 },
        tracking: { max: 0.03, shrink: 0.03 },
      },
      mockMeasure,
    );
    const box = para.items.find((it) => it.type === ItemType.Box)!;
    expect(box.width).toBeCloseTo(w + 20);
    expect(box.expStretch).toBeCloseTo(w * (mockRun().ratioAtMax - 1));
    expect(box.trackStretch).toBeCloseTo(w * 0.03);
  });

  it("suppresses glyph and inserted-hyphen protrusion inside a painted inline box", () => {
    const para = buildItems(
      [{ text: '"beautiful,"', run: 0, paintedBox: true }],
      [mockRun()],
      {
        ...defaultBuildOptions,
        protrusion: { '"': { l: 300 }, ",": { r: 500 }, "-": { r: 500 } },
        hyphenate: () => ["beau", "tiful"],
      },
      mockMeasure,
    );
    const boxes = para.items.filter((it) => it.type === ItemType.Box);
    const hyphen = para.items.find(
      (it) => it.type === ItemType.Penalty && it.width > 0,
    );
    expect(boxes[0]!.lp).toBe(0);
    expect(boxes[0]!.lpFirst).toBe(0);
    expect(boxes[boxes.length - 1]!.rp).toBe(0);
    expect(hyphen?.type).toBe(ItemType.Penalty);
    if (hyphen?.type !== ItemType.Penalty) throw new Error("expected hyphen penalty");
    expect(hyphen.rp).toBe(0);
  });

  it("suppresses character protrusion only on a side actually painted", () => {
    const opts = {
      ...defaultBuildOptions,
      protrusion: { '"': { l: 300 }, ",": { r: 500 } },
    };
    const start = buildItems(
      [{ text: '"edge,', run: 0, paintedStart: true }],
      [mockRun()],
      opts,
      mockMeasure,
    ).items.find((it) => it.type === ItemType.Box)!;
    expect(start.lp).toBe(0);
    expect(start.rp).toBeGreaterThan(0);

    const end = buildItems(
      [{ text: '"edge,', run: 0, paintedEnd: true }],
      [mockRun()],
      opts,
      mockMeasure,
    ).items.find((it) => it.type === ItemType.Box)!;
    expect(end.lp).toBeGreaterThan(0);
    expect(end.rp).toBe(0);
  });

  it("retains character protrusion at an internal slice of a painted inline", () => {
    const para = buildItems(
      [
        {
          text: "{ edge: next }",
          run: 0,
          // Zero-valued markers identify the painter's REAL open/close.
          // Boxes between them can end an internal line slice and should
          // still use their glyph protrusion.
          boxStartProtrusionPx: 0,
          boxEndProtrusionPx: 0,
        },
      ],
      [mockRun()],
      { ...defaultBuildOptions, protrusion: latinProtrusion },
      mockMeasure,
    );
    const boxes = para.items.filter((it) => it.type === ItemType.Box);
    expect(boxes.map((box) => box.text)).toEqual(["{", "edge:", "next", "}"]);
    expect(boxes[0]!.lp).toBe(0);
    expect(boxes[1]!.rp).toBeGreaterThan(0);
    expect(boxes[boxes.length - 1]!.rp).toBe(0);
  });

  it("hangs a painted box's side insets while keeping its glyphs on the measure", () => {
    const texts = [
      {
        text: '"halo."',
        run: 0,
        paintedBox: true,
        padStartPx: 6,
        padEndPx: 8,
        boxStartProtrusionPx: 6,
        boxEndProtrusionPx: 8,
      },
    ];
    const para = buildItems(
      texts,
      [mockRun()],
      { ...defaultBuildOptions, protrusion: latinProtrusion },
      mockMeasure,
    );
    const box = para.items.find((it) => it.type === ItemType.Box)!;
    expect(box.width).toBeCloseTo(mockMeasure.width('"halo."', mockRun()) + 14);
    expect(box.lp).toBe(6);
    expect(box.lpFirst).toBe(6);
    expect(box.rp).toBe(8);

    const disabled = buildItems(
      texts,
      [mockRun()],
      { ...defaultBuildOptions, protrusion: false },
      mockMeasure,
    );
    const disabledBox = disabled.items.find((it) => it.type === ItemType.Box)!;
    expect(disabledBox.lp).toBe(0);
    expect(disabledBox.lpFirst).toBe(0);
    expect(disabledBox.rp).toBe(0);
  });

  it("includes padded ancestors outside a painted descendant on both edges", () => {
    const para = buildItems(
      [
        {
          text: "halo",
          run: 0,
          paintedBox: true,
          // Painted child = 6px; an unpainted ancestor contributes 4px
          // on the same raw run after the child's reader pass.
          padStartPx: 10,
          padEndPx: 10,
          boxStartProtrusionPx: 6,
          boxEndProtrusionPx: 6,
        },
      ],
      [mockRun()],
      { ...defaultBuildOptions, protrusion: latinProtrusion },
      mockMeasure,
    );
    const box = para.items.find((it) => it.type === ItemType.Box)!;
    expect(box.lp).toBe(10);
    expect(box.rp).toBe(10);
    expect(box.paintedEnd).toBe(true);
  });

  it("preserves a painted end through an ancestor's whitespace-only close", () => {
    const para = buildItems(
      [
        {
          text: "halo",
          run: 0,
          paintedBox: true,
          padEndPx: 6,
          boxEndProtrusionPx: 6,
        },
        { text: " ", run: 1, padEndPx: 4 },
      ],
      [mockRun(), mockRun()],
      { ...defaultBuildOptions, protrusion: latinProtrusion },
      mockMeasure,
    );
    const box = para.items.find((it) => it.type === ItemType.Box)!;
    expect(box.width).toBeCloseTo(mockMeasure.width("halo", mockRun()) + 10);
    expect(box.rp).toBe(10);
    expect(box.paintedEnd).toBe(true);
  });
});

describe("atomic (nowrap) scopes", () => {
  it("forbids breaks at spaces between boxes sharing an atomic key", () => {
    const para = buildItems(
      [
        { text: "before ", run: 0 },
        { text: "git status", run: 1, atomicKey: 7 },
        { text: " after", run: 0 },
      ],
      [mockRun(), mockRun()],
      defaultBuildOptions,
      mockMeasure,
    );
    expect(shape(para.items)).toBe(
      "box(before) glue box(git) pen(10000) glue box(status) glue box(after) " +
        "pen(10000) fil pen(-10000)",
    );
  });

  it("keeps the space between two DIFFERENT nowrap elements breakable", () => {
    const para = buildItems(
      [
        { text: "a b", run: 0, atomicKey: 1 },
        { text: " ", run: 1 },
        { text: "c d", run: 2, atomicKey: 2 },
      ],
      [mockRun(), mockRun(), mockRun()],
      defaultBuildOptions,
      mockMeasure,
    );
    // Interior spaces guarded; the inter-element space is not.
    expect(shape(para.items)).toBe(
      "box(a) pen(10000) glue box(b) glue box(c) pen(10000) glue box(d) " +
        "pen(10000) fil pen(-10000)",
    );
  });

  it("suppresses hyphenation and explicit-hyphen breaks inside an atomic scope", () => {
    const para = buildItems(
      [{ text: "self-made beautiful", run: 0, atomicKey: 3 }],
      [mockRun()],
      { ...defaultBuildOptions, hyphenate: (w) => [w.slice(0, 4), w.slice(4)] },
      mockMeasure,
    );
    expect(shape(para.items)).toBe(
      "box(self-made) pen(10000) glue box(beautiful) pen(10000) fil pen(-10000)",
    );
  });

});

describe("boundary space rigidity", () => {
  const serif = () => mockRun({ familyKey: "serif" });
  const mono = () => mockRun({ familyKey: "mono" });

  it("drops shrink (keeps stretch) on spaces between different font families", () => {
    const para = buildItems(
      [
        { text: "the ", run: 0 },
        { text: "chip", run: 1 },
        { text: " after", run: 0 },
      ],
      [serif(), mono()],
      defaultBuildOptions,
      mockMeasure,
    );
    const glues = para.items.filter(
      (it): it is Glue => it.type === ItemType.Glue && it.stretchFil === 0,
    );
    expect(glues).toHaveLength(2);
    for (const glue of glues) {
      expect(glue.shrink).toBe(0);
      expect(glue.rigid).toBe(true);
      expect(glue.stretch).toBeCloseTo(mockRun().space.stretch);
      expect(glue.width).toBeCloseTo(mockRun().space.width);
    }
  });

  it("same family (style/weight changes) is not a boundary", () => {
    const para = buildItems(
      [
        { text: "some ", run: 0 },
        { text: "emphasis", run: 1 },
        { text: " text", run: 0 },
      ],
      [serif(), serif()],
      defaultBuildOptions,
      mockMeasure,
    );
    for (const it of para.items) {
      if (it.type === ItemType.Glue && it.stretchFil === 0) {
        expect(it.shrink).toBeCloseTo(mockRun().space.shrink);
        expect(it.rigid).toBeUndefined();
      }
    }
  });

  it("boundaryShrink 1 restores TeX semantics (full shrink, no rigid flag)", () => {
    const para = buildItems(
      [
        { text: "the ", run: 0 },
        { text: "chip", run: 1 },
        { text: " after", run: 0 },
      ],
      [serif(), mono()],
      { ...defaultBuildOptions, boundaryShrink: 1 },
      mockMeasure,
    );
    for (const it of para.items) {
      if (it.type === ItemType.Glue && it.stretchFil === 0) {
        expect(it.shrink).toBeCloseTo(mockRun().space.shrink);
        expect(it.rigid).toBeUndefined();
      }
    }
  });

  it("undefined familyKey (headless core users) never creates boundaries", () => {
    const para = buildItems(
      [
        { text: "one ", run: 0 },
        { text: "two", run: 1 },
      ],
      [mockRun(), mockRun()],
      defaultBuildOptions,
      mockMeasure,
    );
    for (const it of para.items) {
      if (it.type === ItemType.Glue && it.stretchFil === 0) {
        expect(it.rigid).toBeUndefined();
      }
    }
  });
});
