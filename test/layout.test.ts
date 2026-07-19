import { describe, expect, it } from "vitest";
import { breakParagraph } from "../src/core/breaker.js";
import { buildItems } from "../src/core/items.js";
import { layoutLines } from "../src/core/layout.js";
import { defaultBreakOptions, defaultBuildOptions, ItemType, type Line } from "../src/core/types.js";
import { mockMeasure, mockRun } from "./helpers/mock.js";

const TEXT =
  "In olden times when wishing still helped one there lived a king whose " +
  "daughters were all beautiful and the youngest was so beautiful that the " +
  "sun itself was astonished whenever it shone in her face";

describe("fil-line letterfit accounting", () => {
  const opts = {
    ...defaultBuildOptions,
    tracking: { max: 0.03, shrink: 0.03 },
  };

  // Regression for a model/render width divergence reported from production
  // (magritte.lyall.co, justif 0.2.1): the breaker and the layout's shrink
  // branch price an over-long ending against the POOLED shrink — glue plus
  // letterfit tracking — but trackRatio was forced to 0 on every fil line,
  // so the tracking share of the shrink never rendered and the ending set
  // up to boxWidth × shrink px (3% ≈ 20px on a full line) past the measure.
  it("a shrunken ending renders its letterfit share (trackRatio = glueRatio)", () => {
    let found: Line | null = null;
    for (let w = 160; w <= 400 && found === null; w += 2) {
      const para = buildItems([{ text: TEXT, run: 0 }], [mockRun()], opts, mockMeasure);
      const result = breakParagraph(para, w, defaultBreakOptions);
      const lines = layoutLines(para, result, w, opts);
      const last = lines[lines.length - 1]!;
      if (last.glueRatio < -0.01) {
        found = last;
        // The rendered shrink must equal the modeled deficit: glue at
        // glueRatio × space shrink AND boxes at trackRatio × track shrink
        // together absorb exactly what the pooled ratio promised.
        expect(last.trackRatio).toBe(last.glueRatio);
        // Cross-check the pooled algebra: ratio × (Zglue + Ztrack) = deficit.
        let natural = 0;
        let zGlue = 0;
        let zTrack = 0;
        for (let i = last.start; i < last.end; i++) {
          const it = para.items[i]!;
          if (it.type === ItemType.Box) {
            natural += it.width;
            zTrack += it.trackShrink;
          } else if (it.type === ItemType.Glue) {
            natural += it.width;
            zGlue += it.shrink;
          }
        }
        const deficit = natural - last.leftHang - last.rightHang - last.width;
        expect(deficit).toBeGreaterThan(0);
        expect(-last.glueRatio * (zGlue + zTrack)).toBeCloseTo(deficit, 6);
      }
    }
    expect(found).not.toBeNull();
  });

  it("a natural or stretched ending keeps letterfit natural (trackRatio 0)", () => {
    for (let w = 160; w <= 400; w += 2) {
      const para = buildItems([{ text: TEXT, run: 0 }], [mockRun()], opts, mockMeasure);
      const result = breakParagraph(para, w, defaultBreakOptions);
      const lines = layoutLines(para, result, w, opts);
      const last = lines[lines.length - 1]!;
      if (last.glueRatio >= 0) expect(last.trackRatio).toBe(0);
    }
  });
});

describe("painted-token overfull fallback", () => {
  it("uses exact emergency letterfit when protrusion is off and padding alone exceeds the measure", () => {
    const opts = {
      ...defaultBuildOptions,
      protrusion: false as const,
      tracking: { max: 0.03, shrink: 0.03 },
    };
    const para = buildItems(
      [
        {
          text: "getBoundingClientRect()",
          run: 0,
          paintedBox: true,
          padStartPx: 5,
          padEndPx: 5,
          // Presence (including zero) identifies the actual painted close.
          boxEndProtrusionPx: 0,
        },
      ],
      [mockRun()],
      opts,
      mockMeasure,
    );
    const box = para.items.find((item) => item.type === ItemType.Box)!;
    const width = box.width - box.trackShrink - 2;
    const result = breakParagraph(para, width, defaultBreakOptions);
    const line = layoutLines(para, result, width, opts)[0]!;

    expect(line.trackRatio).toBeLessThan(-1);
    expect(line.trackRatio).toBeGreaterThanOrEqual(-2);
    expect(line.overfull).toBe(false);
    expect(line.overflowPx).toBe(0);
    expect(box.width + line.trackRatio * box.trackShrink).toBeCloseTo(width, 6);
  });
});
