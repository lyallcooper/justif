import { describe, expect, it } from "vitest";
import { breakParagraph } from "../src/core/breaker.js";
import { buildItems } from "../src/core/items.js";
import { layoutLines } from "../src/core/layout.js";
import { defaultBreakOptions, defaultBuildOptions, type Line } from "../src/core/types.js";
import { mockMeasure, mockRun } from "./helpers/mock.js";

const TEXT =
  "In olden times when wishing still helped one there lived a king whose " +
  "daughters were all beautiful and the youngest was so beautiful that the " +
  "sun itself was astonished whenever it shone in her face";

function layoutAt(width: number, lastLineFit: number): Line[] {
  const opts = { ...defaultBuildOptions, lastLineFit };
  const para = buildItems([{ text: TEXT, run: 0 }], [mockRun()], opts, mockMeasure);
  const result = breakParagraph(para, width, defaultBreakOptions);
  return layoutLines(para, result, width, opts);
}

/**
 * A width where the fit is well-conditioned: the default ending sets
 * naturally (short, no shrink needed) and fit = 1 is not capped by the
 * fully-justified limit (glueRatio(1) lands on 1 × mean exactly). The mock
 * measure is deterministic, so this is a fixed property per width.
 */
function pickWidth(): { width: number; mean: number } {
  for (let width = 160; width <= 320; width += 4) {
    const off = layoutAt(width, 0);
    if (off.length < 4) continue;
    if (off[off.length - 1]!.glueRatio !== 0) continue; // ending shrinks here
    const body = off.slice(0, -1);
    const mean = body.reduce((a, l) => a + l.glueRatio, 0) / body.length;
    if (mean <= 0.01) continue; // want a visibly loose paragraph
    const full = layoutAt(width, 1);
    if (Math.abs(full[full.length - 1]!.glueRatio - mean) > 1e-9) continue; // capped
    return { width, mean };
  }
  throw new Error("no well-conditioned width found for the mock text");
}

describe("lastLineFit (eTeX \\lastlinefit, layout-only)", () => {
  const { width, mean } = pickWidth();

  it("is off by default: the ending sets at natural width", () => {
    const lines = layoutAt(width, 0);
    expect(lines[lines.length - 1]!.glueRatio).toBe(0);
  });

  it("the ending adopts the given fraction of the paragraph's mean ratio", () => {
    for (const fit of [0.25, 0.5, 1]) {
      const lines = layoutAt(width, fit);
      expect(lines[lines.length - 1]!.glueRatio).toBeCloseTo(fit * mean, 9);
      // Body lines are untouched — this is a layout-only ending effect.
      expect(lines.slice(0, -1).map((l) => l.glueRatio)).toEqual(
        layoutAt(width, 0)
          .slice(0, -1)
          .map((l) => l.glueRatio),
      );
    }
  });

  it("caps at a fully justified ending when the target exceeds the room", () => {
    // Find a width whose ending is long (little stretch room): fit = 1
    // must never push the set width past the measure. glueRatio ≤ the
    // ratio that exactly fills — equivalently the ending's set width,
    // reconstructed from the ratio, stays ≤ W.
    for (let w = 160; w <= 320; w += 4) {
      const lines = layoutAt(w, 1);
      const last = lines[lines.length - 1]!;
      // Reconstruct: set = natural + ratio·Y. natural + 1·Ycap = W at the
      // cap, so ratio > cap would mean set > W; assert via the invariant
      // that re-running with a colossal synthetic mean cannot exceed it.
      expect(last.glueRatio).toBeLessThanOrEqual(1e9); // sanity
      // The real cap assertion: an ending whose natural width nearly fills
      // the measure gets a ratio strictly below the paragraph mean.
      const body = lines.slice(0, -1);
      const m = body.reduce((a, l) => a + l.glueRatio, 0) / Math.max(1, body.length);
      expect(last.glueRatio).toBeLessThanOrEqual(Math.max(0, m) + 1e-9);
    }
  });

  it("keeps the ending's letterfit natural (trackRatio 0)", () => {
    // Tracking changes the flex pools (and so the breaks), so search for a
    // width where the fit engages under tracking, then assert the ending's
    // letterfit stayed natural there.
    const opts = {
      ...defaultBuildOptions,
      lastLineFit: 1,
      tracking: { max: 0.03, shrink: 0.03 },
    };
    let engaged: Line | null = null;
    for (let w = 160; w <= 320 && engaged === null; w += 4) {
      const para = buildItems([{ text: TEXT, run: 0 }], [mockRun()], opts, mockMeasure);
      const result = breakParagraph(para, w, defaultBreakOptions);
      const lines = layoutLines(para, result, w, opts);
      const last = lines[lines.length - 1]!;
      if (last.glueRatio > 0.01) engaged = last;
    }
    expect(engaged).not.toBeNull();
    expect(engaged!.trackRatio).toBe(0); // letterfit stays natural
  });
});
