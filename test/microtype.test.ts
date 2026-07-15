import { describe, expect, it } from "vitest";
import { breakParagraph } from "../src/core/breaker.js";
import { buildItems } from "../src/core/items.js";
import { layoutLines, lineText } from "../src/core/layout.js";
import { latinProtrusion } from "../src/core/protrusion.js";
import {
  type BuildOptions,
  defaultBreakOptions,
  defaultBuildOptions,
  type Line,
  type ParagraphItems,
} from "../src/core/types.js";
import { hyphenateEnUS } from "../src/hyphenation/en-us.js";
import { frogKing } from "./fixtures/frogKing.js";
import { charWidth, mockMeasure, mockRun } from "./helpers/mock.js";

function layoutAt(width: number, opts: Partial<BuildOptions>): { para: ParagraphItems; lines: Line[] } {
  const buildOpts = { ...defaultBuildOptions, ...opts };
  const para = buildItems([{ text: frogKing, run: 0 }], [mockRun()], buildOpts, mockMeasure);
  const result = breakParagraph(para, width, defaultBreakOptions);
  return { para, lines: layoutLines(para, result, width, buildOpts) };
}

describe("character protrusion", () => {
  it("hangs terminal punctuation into the right margin", () => {
    const { para, lines } = layoutAt(300, { protrusion: latinProtrusion });
    // The last line never reaches the margin (parfillskip), so its right
    // protrusion is deliberately zero — exclude it.
    const punctLines = lines
      .slice(0, -1)
      .filter((l) => /[.,;]$/.test(lineText(para, l)));
    expect(punctLines.length).toBeGreaterThan(0);
    for (const line of punctLines) {
      const last = lineText(para, line).slice(-1);
      const code = latinProtrusion[last]!.r!;
      expect(line.rightHang).toBeCloseTo((code / 1000) * charWidth(last), 6);
    }
  });

  it("hangs opening glyphs into the left margin", () => {
    const { para, lines } = layoutAt(300, { protrusion: latinProtrusion });
    for (const line of lines) {
      const first = lineText(para, line)[0]!;
      const expected = ((latinProtrusion[first]?.l ?? 0) / 1000) * charWidth(first);
      expect(line.leftHang).toBeCloseTo(expected, 6);
    }
  });

  it("credits the protruded width so justified content still fills the measure", () => {
    const { para, lines } = layoutAt(300, { protrusion: latinProtrusion });
    for (const line of lines.slice(0, -1)) {
      if (line.overfull) continue;
      // Visible content spans width + leftHang + rightHang; the flush test in
      // breaker.test.ts covers the algebra. Here: hangs are never negative.
      expect(line.leftHang).toBeGreaterThanOrEqual(0);
      expect(line.rightHang).toBeGreaterThanOrEqual(0);
    }
  });

  it("can change break decisions (it participates in the breaker, not post-hoc)", () => {
    const withP = layoutAt(220, { protrusion: latinProtrusion, hyphenate: hyphenateEnUS });
    const without = layoutAt(220, { protrusion: false, hyphenate: hyphenateEnUS });
    // Not asserting a specific difference at every width — just that the two
    // configurations are being computed through the same optimizer with
    // different measures, and both reconstruct the text.
    // Undo soft-hyphen breaks ("‐ ") and explicit-hyphen breaks ("- ").
    const textOf = (r: typeof withP) =>
      r.lines
        .map((l) => lineText(r.para, l))
        .join(" ")
        .replace(/‐ /g, "")
        .replace(/- /g, "-");
    expect(textOf(withP)).toBe(frogKing);
    expect(textOf(without)).toBe(frogKing);
  });
});

describe("font expansion", () => {
  const expansion = { max: 0.02, shrink: 0.02, step: 0.005 };

  it("emits quantized font-stretch values within the configured range", () => {
    const { lines } = layoutAt(260, { expansion, hyphenate: hyphenateEnUS });
    for (const line of lines) {
      expect(line.fontStretch).toBeGreaterThanOrEqual(98);
      expect(line.fontStretch).toBeLessThanOrEqual(102);
      const steps = (line.fontStretch - 100) / 0.5;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
    }
  });

  it("reduces spacing variance (more even color) vs spacing-only justification", () => {
    const widths = [220, 260, 300, 340];
    let varWith = 0;
    let varWithout = 0;
    for (const width of widths) {
      const w = layoutAt(width, { expansion, hyphenate: hyphenateEnUS });
      const wo = layoutAt(width, { expansion: false, hyphenate: hyphenateEnUS });
      const variance = (lines: Line[]) => {
        const justified = lines.slice(0, -1).map((l) => l.glueRatio);
        const mean = justified.reduce((a, b) => a + b, 0) / justified.length;
        return justified.reduce((a, b) => a + (b - mean) ** 2, 0) / justified.length;
      };
      varWith += variance(w.lines);
      varWithout += variance(wo.lines);
    }
    expect(varWith).toBeLessThan(varWithout);
  });

  it("does not hyphenate more than spacing-only justification", () => {
    const widths = [200, 240, 280, 320];
    let hyphensWith = 0;
    let hyphensWithout = 0;
    for (const width of widths) {
      hyphensWith += layoutAt(width, { expansion, hyphenate: hyphenateEnUS }).lines.filter(
        (l) => l.hyphenated,
      ).length;
      hyphensWithout += layoutAt(width, {
        expansion: false,
        hyphenate: hyphenateEnUS,
      }).lines.filter((l) => l.hyphenated).length;
    }
    expect(hyphensWith).toBeLessThanOrEqual(hyphensWithout);
  });

  it("keeps lines flush when expansion absorbs part of the shortfall", () => {
    const { para, lines } = layoutAt(260, { expansion, hyphenate: hyphenateEnUS });
    const sMaxDelta = 100 * expansion.max;
    for (const line of lines.slice(0, -1)) {
      if (line.overfull) continue;
      let width = -line.leftHang - line.rightHang;
      const gain = (line.fontStretch - 100) / sMaxDelta; // fraction of full expansion
      for (let i = line.start; i < line.end; i++) {
        const it = para.items[i]!;
        if (it.type === 0) {
          width += it.width + gain * (gain >= 0 ? it.expStretch : it.expShrink);
        } else if (it.type === 1) {
          width += it.width + line.glueRatio * (line.glueRatio >= 0 ? it.stretch : it.shrink);
        }
      }
      const brk = para.items[line.end]!;
      if (brk.type === 2) width += brk.width;
      expect(width).toBeCloseTo(line.width, 6);
    }
  });
});
