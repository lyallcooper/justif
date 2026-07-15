import type { Measure, RunMetrics } from "../../src/core/types.js";

/**
 * Deterministic proportional character widths (px at a nominal 16px serif,
 * loosely Computer Modern proportions). No kerning — the mock exists so core
 * behavior is reproducible in Node, not to model a real font.
 */
const WIDTHS: Record<string, number> = {};
function set(chars: string, w: number): void {
  for (const c of chars) WIDTHS[c] = w;
}
set("iljI.,;:!'‘’|‐", 4);
set('ftr()[]"“”', 5);
set("sJ-", 5);
set("acezgkvxy?", 7);
set("bdhnopqu", 8);
set("wFLTZS", 9);
set("ABCDEGHKNPRUVXY", 10);
set("mMOQW", 12);
set("0123456789", 8);

export function charWidth(ch: string): number {
  return WIDTHS[ch] ?? 8;
}

export function mockRun(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    fontKey: "mock16",
    space: { width: 4, stretch: 2, shrink: 4 / 3 },
    hyphenWidth: charWidth("-"),
    ratioAtMax: 1.01,
    ratioAtMin: 0.99,
    ...overrides,
  };
}

export const mockMeasure: Measure = {
  width(text) {
    let w = 0;
    for (const ch of text) w += charWidth(ch);
    return w;
  },
  charAdvance(ch) {
    return charWidth(ch);
  },
};

/**
 * Kerned mock: every adjacent letter pair tightens by 0.5px, so a word's
 * width is NOT the sum of its independently measured fragments — the measure
 * to use when testing kerning-sensitive width bookkeeping.
 */
export const kernedMeasure: Measure = {
  width(text) {
    let w = 0;
    let n = 0;
    for (const ch of text) {
      w += charWidth(ch);
      n++;
    }
    return w - Math.max(0, n - 1) * 0.5;
  },
  charAdvance(ch) {
    return charWidth(ch);
  },
};
