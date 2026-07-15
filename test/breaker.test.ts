import { describe, expect, it } from "vitest";
import { badness, demerits, Fitness, fitness, INF_PENALTY } from "../src/core/badness.js";
import { breakParagraph } from "../src/core/breaker.js";
import { buildItems } from "../src/core/items.js";
import { layoutLines, lineText } from "../src/core/layout.js";
import {
  type BreakOptions,
  type BuildOptions,
  defaultBreakOptions,
  defaultBuildOptions,
  ItemType,
  type LineWidths,
  lineWidthAt,
  type ParagraphItems,
} from "../src/core/types.js";
import { frogKing } from "./fixtures/frogKing.js";
import { charWidth, kernedMeasure, mockMeasure, mockRun } from "./helpers/mock.js";

function build(text: string, opts: Partial<BuildOptions> = {}): ParagraphItems {
  return buildItems(
    [{ text, run: 0 }],
    [mockRun()],
    { ...defaultBuildOptions, ...opts },
    mockMeasure,
  );
}

/** Skip pass 1 so results compare like-for-like with the oracle. */
const pass2Opts: BreakOptions = {
  ...defaultBreakOptions,
  pretolerance: -1,
  emergencyStretch: 0,
};

/**
 * Independent exhaustive-search oracle: minimum total demerits over ALL
 * feasible breakings, via memoized recursion over (breakpoint, line,
 * fitness, flagged). Written separately from the breaker on purpose.
 */
function bruteForce(
  para: ParagraphItems,
  widths: LineWidths,
  opts: BreakOptions,
): number | null {
  const { items, cumW, cumY, cumYfil, cumZ, cumExpY, cumExpZ, firstBoxAfter } = para;
  const n = items.length;
  const memo = new Map<string, number | null>();

  function lineFeasibility(
    start: number,
    b: number,
    line: number,
  ): { bad: number; fit: Fitness } | null {
    const it = items[b]!;
    let penWidth = 0;
    let rp = 0;
    if (it.type === ItemType.Penalty && it.width > 0) {
      penWidth = it.width;
      rp = it.rp;
    } else {
      // The line's last box, past any unbroken penalties and parfill glue
      // (independent mirror of breakRp's semantics).
      for (let i = b - 1; i >= 0; i--) {
        const prev = items[i]!;
        if (prev.type === ItemType.Box) {
          rp = prev.rp;
          break;
        }
      }
    }
    let L = cumW[b]! - cumW[start]! + penWidth - rp;
    const startItem = items[start];
    if (startItem !== undefined && startItem.type === ItemType.Box) L -= startItem.lp;
    const W = lineWidthAt(widths, line);
    const Y = cumY[b]! - cumY[start]! + (cumExpY[b]! - cumExpY[start]!);
    const Yfil = cumYfil[b]! - cumYfil[start]!;
    const Z = cumZ[b]! - cumZ[start]! + (cumExpZ[b]! - cumExpZ[start]!);
    if (L > W) {
      if (Z <= 0 || (L - W) / Z > 1) return null;
      const bad = badness(L - W, Z);
      if (bad > opts.tolerance) return null;
      return { bad, fit: fitness(true, bad) };
    }
    if (L < W && Yfil <= 0) {
      const bad = badness(W - L, Y);
      if (bad > opts.tolerance) return null;
      return { bad, fit: fitness(false, bad) };
    }
    return { bad: 0, fit: fitness(false, 0) };
  }

  function search(prev: number, line: number, fit: Fitness, flagged: boolean): number | null {
    if (prev === n - 1) return 0;
    const key = `${prev}|${line}|${fit}|${flagged}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    memo.set(key, null); // cycle guard (there are none, but be safe)

    const start = prev < 0 ? firstBoxAfter[0]! : firstBoxAfter[prev + 1]!;
    let best: number | null = null;
    for (let b = prev + 1; b < n; b++) {
      const it = items[b]!;
      let p: number;
      let bFlagged: boolean;
      if (it.type === ItemType.Glue) {
        if (b === 0 || items[b - 1]!.type !== ItemType.Box) continue;
        p = 0;
        bFlagged = false;
      } else if (it.type === ItemType.Penalty) {
        if (it.penalty >= INF_PENALTY) continue;
        p = it.penalty;
        bFlagged = it.flagged;
      } else {
        continue;
      }
      const feas = lineFeasibility(start, b, line);
      if (feas === null) continue;
      let d = demerits(opts.linePenalty, feas.bad, p);
      if (bFlagged && flagged) d += opts.doubleHyphenDemerits;
      if (Math.abs(feas.fit - fit) > 1) d += opts.adjDemerits;
      if (p <= -INF_PENALTY && b === n - 1 && flagged) d += opts.finalHyphenDemerits;
      const rest = search(b, line + 1, feas.fit, bFlagged);
      if (rest !== null && (best === null || d + rest < best)) best = d + rest;
    }
    memo.set(key, best);
    return best;
  }

  return search(-1, 0, Fitness.Decent, false);
}

describe("breakParagraph vs brute-force oracle", () => {
  const texts = [
    "In olden times when wishing still helped one, there lived a king",
    "whose daughters were all beautiful; and the youngest was so beautiful that",
    "Close by the king's castle lay a great dark forest, and under an old lime-tree",
  ];
  const widths = [140, 170, 210, 260, 320];

  for (const text of texts) {
    for (const width of widths) {
      it(`finds the global optimum ("${text.slice(0, 20)}…" @ ${width}px)`, () => {
        const para = build(text, { hyphenate: fakeHyphenator });
        const oracle = bruteForce(para, width, pass2Opts);
        if (oracle === null) return; // infeasible at this tolerance; rescue path tested elsewhere
        const result = breakParagraph(para, width, pass2Opts);
        expect(result.pass).toBe(2);
        expect(result.demerits).toBeCloseTo(oracle, 6);
      });
    }
  }

  it("agrees with the oracle when protrusion and expansion are enabled", () => {
    const para = build(texts[2]!, {
      protrusion: { ",": { r: 700 }, ".": { r: 700 }, "-": { r: 700 }, C: { l: 50 } },
      expansion: { max: 0.02, shrink: 0.02, step: 0.005 },
    });
    for (const width of widths) {
      const oracle = bruteForce(para, width, pass2Opts);
      if (oracle === null) continue;
      expect(breakParagraph(para, width, pass2Opts).demerits).toBeCloseTo(oracle, 6);
    }
  });

  it("the oracle itself finds solutions (silent skips above are not vacuous)", () => {
    const para = build(texts[0]!, { hyphenate: fakeHyphenator });
    expect(bruteForce(para, 260, pass2Opts)).not.toBeNull();
  });

  it("supports varying line widths (first-line indent)", () => {
    const para = build(texts[0]!);
    const widths: number[] = [180, 220];
    const oracle = bruteForce(para, widths, pass2Opts);
    expect(oracle).not.toBeNull();
    expect(breakParagraph(para, widths, pass2Opts).demerits).toBeCloseTo(oracle!, 6);
  });
});

describe("three-pass behavior", () => {
  it("prefers pass 1 (no hyphenation) when it succeeds at pretolerance", () => {
    const para = build(frogKing, { hyphenate: (w) => [w.slice(0, 3), w.slice(3)] });
    const result = breakParagraph(para, 500, defaultBreakOptions);
    expect(result.pass).toBe(1);
    const lines = layoutLines(para, result, 500, defaultBuildOptions);
    expect(lines.some((l) => l.hyphenated)).toBe(false);
  });

  it("falls through to hyphenation when words cannot fit whole", () => {
    // 60px is narrower than the longer words: splits are unavoidable.
    const para = build(frogKing, { hyphenate: fakeHyphenator });
    const result = breakParagraph(para, 60, defaultBreakOptions);
    expect(result.pass).toBeGreaterThanOrEqual(2);
    const lines = layoutLines(para, result, 60, defaultBuildOptions);
    expect(lines.some((l) => l.hyphenated)).toBe(true);
  });

  it("prefers a loose line over an overfull one when a glue break exists", () => {
    // Word pairs slightly exceed the measure (no shrink can save them), but
    // every single word fits. TeX would emit overfull hboxes; justif must
    // fall back to loose one-word lines — never poke out of the measure
    // while a legal break configuration exists.
    const para = build("wow wow wow wow");
    // "wow wow" = 2·27 + 4 = 58; one "wow" = 27.
    const result = breakParagraph(para, 50, { ...defaultBreakOptions, emergencyStretch: 0 });
    expect(result.overfull.every((o) => !o)).toBe(true);
    const lines = layoutLines(para, result, 50, defaultBuildOptions);
    for (const line of lines) {
      expect(line.overfull).toBe(false);
      expect(line.glueRatio).toBeGreaterThanOrEqual(-1 - 1e-9);
    }
  });

  it("rescues impossibly narrow measures with overfull lines instead of throwing", () => {
    const para = build("supercalifragilistic expialidocious");
    const result = breakParagraph(para, 30, defaultBreakOptions);
    expect(result.overfull.some(Boolean)).toBe(true);
    const lines = layoutLines(para, result, 30, defaultBuildOptions);
    expect(lines.map((l) => lineText(para, l)).join(" ").trim()).toBe(
      "supercalifragilistic expialidocious",
    );
  });
});

function fakeHyphenator(w: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < w.length; i += 3) parts.push(w.slice(i, i + 3));
  return parts;
}

describe("frog-king golden layout", () => {
  it("reconstructs the exact input text across widths", () => {
    for (const width of [150, 250, 400, 500]) {
      const para = build(frogKing);
      const result = breakParagraph(para, width, defaultBreakOptions);
      const lines = layoutLines(para, result, width, defaultBuildOptions);
      // Breaks after an explicit "-" (zero-width penalty) join without a
      // space; the fixture contains no "- " sequences of its own.
      const joined = lines
        .map((l) => lineText(para, l))
        .join(" ")
        .replace(/- /g, "-");
      expect(joined).toBe(frogKing);
    }
  });

  it("never shrinks spaces past their limit (glueRatio ≥ -1), even on rescue lines", () => {
    for (const width of [40, 80, 150, 250, 400]) {
      const para = build(frogKing);
      const result = breakParagraph(para, width, defaultBreakOptions);
      const lines = layoutLines(para, result, width, defaultBuildOptions);
      for (const line of lines) {
        expect(line.glueRatio).toBeGreaterThanOrEqual(-1 - 1e-9);
      }
    }
  });

  it("marks impossible lines overfull instead of crushing spaces to zero", () => {
    // 60px fits ~1.3 average words: many lines cannot be broken feasibly.
    const para = build(frogKing);
    const result = breakParagraph(para, 60, defaultBreakOptions);
    const lines = layoutLines(para, result, 60, defaultBuildOptions);
    expect(lines.some((l) => l.overfull)).toBe(true);
    for (const line of lines) {
      expect(line.glueRatio).toBeGreaterThanOrEqual(-1 - 1e-9);
    }
  });

  it("tracking flex loosens glue ratios and can make infeasible lines feasible", () => {
    // Same text, same breaks: with tracking in the pool, each line's ratio
    // (and thus its badness) drops because the flex denominator grows.
    const tracked = build(frogKing, { tracking: { max: 0.03, shrink: 0.03 } });
    const plain = build(frogKing);
    const opts = { ...defaultBreakOptions, emergencyStretch: 0 };
    const rTracked = breakParagraph(tracked, 180, opts);
    const rPlain = breakParagraph(plain, 180, opts);
    const worst = (para: ParagraphItems, r: ReturnType<typeof breakParagraph>): number =>
      Math.max(
        ...layoutLines(para, r, 180, defaultBuildOptions)
          .slice(0, -1)
          .map((l) => Math.abs(l.ratio)),
      );
    expect(worst(tracked, rTracked)).toBeLessThanOrEqual(worst(plain, rPlain) + 1e-9);
    // And the layout ratio spreads over the combined pool: a tracked line
    // asks less of its spaces than the same line without tracking.
    const lt = layoutLines(tracked, rPlain, 180, defaultBuildOptions);
    const lp = layoutLines(plain, rPlain, 180, defaultBuildOptions);
    for (let i = 0; i < lt.length - 1; i++) {
      expect(Math.abs(lt[i]!.glueRatio)).toBeLessThanOrEqual(Math.abs(lp[i]!.glueRatio) + 1e-9);
    }
  });

  it("the paragraph-final box protrudes past the parfillskip tail", () => {
    const para = buildItems(
      [{ text: "one two.", run: 0 }],
      [mockRun()],
      { ...defaultBuildOptions, protrusion: { ".": { r: 700 } } },
      mockMeasure,
    );
    const result = breakParagraph(para, 200, defaultBreakOptions);
    const lines = layoutLines(para, result, 200, defaultBuildOptions);
    const last = lines[lines.length - 1]!;
    expect(last.rightHang).toBeCloseTo((700 / 1000) * charWidth("."));
  });

  it("first-line left hangs apply only on line 0; later quote-led lines use the rest table", () => {
    const para = buildItems(
      [{ text: "“aa bb “cc dd", run: 0 }],
      [mockRun()],
      {
        ...defaultBuildOptions,
        protrusion: { "“": { l: 300 } },
        protrusionFirst: { "“": { l: 1000 } },
      },
      mockMeasure,
    );
    // Break after "bb": line 0 = “aa bb, line 1 = “cc dd.
    const lines = layoutLines(
      para,
      { breakpoints: [3, para.items.length - 1], pass: 1, overfull: [false, false], demerits: 0 },
      200,
      defaultBuildOptions,
    );
    expect(lines[0]!.leftHang).toBeCloseTo((1000 / 1000) * charWidth("“"));
    expect(lines[1]!.leftHang).toBeCloseTo((300 / 1000) * charWidth("“"));
  });

  it("tracking saturates at ratio 1 on very loose lines; spaces absorb the rest", () => {
    const para = build("one two three", { tracking: { max: 0.03, shrink: 0.03 } });
    // Force "one two" onto a very loose first line via a hand-made break at
    // the second glue: pooled ratio far beyond 1.
    const W = 300;
    const lines = layoutLines(
      para,
      { breakpoints: [3, para.items.length - 1], pass: 2, overfull: [false, false], demerits: 0 },
      W,
      { ...defaultBuildOptions, tracking: { max: 0.03, shrink: 0.03 } },
    );
    const line = lines[0]!;
    expect(line.trackRatio).toBe(1); // letter-spacing capped at the 3% budget
    expect(line.glueRatio).toBeGreaterThan(1); // spaces stretch on alone
    // The saturated split still fills the measure exactly:
    // L + glueRatio·(glue stretch) + 1·(track budget) = W.
    const L = para.cumW[3]! - para.cumW[0]!;
    const Yt = para.cumTrackY[3]! - para.cumTrackY[0]!;
    const Yglue = para.cumY[3]! - para.cumY[0]! - Yt;
    expect(L + line.glueRatio * Yglue + Yt).toBeCloseTo(W, 6);
  });

  it("survives narrow measures without overfull once emergency stretch kicks in", () => {
    // At 150px (~4 words/line) pass 3's ~3em emergency stretch should always
    // find loose-but-legal breaks — no overfull, no crushed spaces.
    const para = build(frogKing, { hyphenate: fakeHyphenator });
    const result = breakParagraph(para, 150, defaultBreakOptions);
    const lines = layoutLines(para, result, 150, defaultBuildOptions);
    expect(lines.every((l) => !l.overfull)).toBe(true);
  });

  it("matches the golden break positions at 400px", () => {
    const para = build(frogKing);
    const result = breakParagraph(para, 400, defaultBreakOptions);
    const lines = layoutLines(para, result, 400, defaultBuildOptions);
    expect(lines.map((l) => lineText(para, l))).toMatchSnapshot();
  });
});

describe("hyphenation neutrality", () => {
  const kerned = kernedMeasure;

  it("enabling hyphenation never changes lines that take no hyphen break", () => {
    let checked = 0;
    for (const width of [300, 380, 460, 540]) {
      const layoutFor = (hyphenate?: (w: string) => string[]) => {
        const buildOpts = { ...defaultBuildOptions, hyphenate };
        const para = buildItems([{ text: frogKing, run: 0 }], [mockRun()], buildOpts, kerned);
        const result = breakParagraph(para, width, defaultBreakOptions);
        const lines = layoutLines(para, result, width, buildOpts);
        return { para, lines };
      };
      const without = layoutFor(undefined);
      const withH = layoutFor(fakeHyphenator);
      if (withH.lines.some((l) => l.hyphenated)) continue; // hyphens genuinely used
      checked++;
      expect(withH.lines.map((l) => lineText(withH.para, l))).toEqual(
        without.lines.map((l) => lineText(without.para, l)),
      );
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("lastLineStretch (short-last-line avoidance)", () => {
  const lastLineFraction = (width: number, lastLineStretch: number): number => {
    const para = build(frogKing);
    const opts = { ...defaultBreakOptions, lastLineStretch };
    const result = breakParagraph(para, width, opts);
    const lines = layoutLines(para, result, width, defaultBuildOptions);
    const last = lines[lines.length - 1]!;
    let natural = 0;
    for (let i = last.start; i < last.end; i++) {
      const it = para.items[i]!;
      if (it.type === ItemType.Box || it.type === ItemType.Glue) natural += it.width;
    }
    return natural / width;
  };

  it("never produces shorter last lines than the default, and fixes short ones", () => {
    let shortDefault = 0;
    let shortAvoiding = 0;
    for (let width = 200; width <= 520; width += 20) {
      const def = lastLineFraction(width, Infinity);
      const avoid = lastLineFraction(width, 0.5);
      expect(avoid).toBeGreaterThanOrEqual(def - 1e-9);
      if (def < 0.2) shortDefault++;
      if (avoid < 0.2) shortAvoiding++;
    }
    // The frog-king fixture has orphan endings at several of these widths.
    expect(shortDefault).toBeGreaterThan(0);
    expect(shortAvoiding).toBeLessThan(shortDefault);
  });

  it("tolerates genuinely short paragraphs (capped badness, no rescue)", () => {
    const para = build("one two three");
    const result = breakParagraph(para, 500, { ...defaultBreakOptions, lastLineStretch: 0.5 });
    const lines = layoutLines(para, result, 500, defaultBuildOptions);
    expect(lines.length).toBe(1);
    expect(lines[0]!.overfull).toBe(false);
    expect(lines[0]!.glueRatio).toBe(0); // still set naturally
  });
});

describe("degenerate inputs and option edge cases", () => {
  it("empty and whitespace-only paragraphs produce zero lines without escalating", () => {
    for (const text of ["", "   ", "\u00AD", " \u00AD "]) {
      const para = build(text);
      const result = breakParagraph(para, 300, defaultBreakOptions);
      expect(result.pass).toBe(1);
      expect(layoutLines(para, result, 300, defaultBuildOptions)).toEqual([]);
    }
  });

  it("expansion quantization never exceeds the calibrated endpoint", () => {
    // step 0.0075 does not divide max 0.02: naive rounding would emit 102.25%.
    const buildOpts = {
      ...defaultBuildOptions,
      expansion: { max: 0.02, shrink: 0.02, step: 0.0075 },
    };
    const para = buildItems([{ text: frogKing, run: 0 }], [mockRun()], buildOpts, mockMeasure);
    const result = breakParagraph(para, 260, defaultBreakOptions);
    for (const line of layoutLines(para, result, 260, buildOpts)) {
      expect(line.fontStretch).toBeLessThanOrEqual(102);
      expect(line.fontStretch).toBeGreaterThanOrEqual(98);
    }
  });

  it("expansion step 0 disables quantization but still clamps", () => {
    const buildOpts = {
      ...defaultBuildOptions,
      expansion: { max: 0.02, shrink: 0.02, step: 0 },
    };
    const para = buildItems([{ text: frogKing, run: 0 }], [mockRun()], buildOpts, mockMeasure);
    const result = breakParagraph(para, 260, defaultBreakOptions);
    for (const line of layoutLines(para, result, 260, buildOpts)) {
      expect(line.fontStretch).toBeLessThanOrEqual(102);
      expect(line.fontStretch).toBeGreaterThanOrEqual(98);
      expect(Number.isFinite(line.fontStretch)).toBe(true);
    }
  });
});

describe("layout algebra", () => {
  it("sets each justified line flush: boxes + adjusted glue == target width", () => {
    const para = build(frogKing);
    const result = breakParagraph(para, 300, defaultBreakOptions);
    const lines = layoutLines(para, result, 300, defaultBuildOptions);
    for (const line of lines.slice(0, -1)) {
      let width = -line.leftHang - line.rightHang;
      for (let i = line.start; i < line.end; i++) {
        const it = para.items[i]!;
        if (it.type === ItemType.Box) width += it.width;
        else if (it.type === ItemType.Glue) {
          width +=
            it.width +
            line.glueRatio * (line.glueRatio >= 0 ? it.stretch : it.shrink);
        }
      }
      const brk = para.items[line.end]!;
      if (brk.type === ItemType.Penalty) width += brk.width;
      expect(width).toBeCloseTo(line.width, 6);
    }
  });
});
