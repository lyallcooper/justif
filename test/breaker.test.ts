import { describe, expect, it } from "vitest";
import {
  badness,
  demerits,
  demeritsUncapped,
  Fitness,
  fitness,
  INF_PENALTY,
  maxEndingStretch,
} from "../src/core/badness.js";
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
  const { items, cumW, cumY, cumYfil, cumZ, cumExpY, cumExpZ, cumTrackY, firstBoxAfter } = para;
  const n = items.length;
  const memo = new Map<string, number | null>();

  function lineFeasibility(
    start: number,
    b: number,
    line: number,
  ): { bad: number; fit: Fitness; fil: boolean } | null {
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
      return { bad, fit: fitness(true, bad), fil: false };
    }
    if (L < W && Yfil <= 0) {
      const bad = badness(W - L, Y);
      if (bad > opts.tolerance) return null;
      return { bad, fit: fitness(false, bad), fil: false };
    }
    // Fil ending: render-aware lastLineMinWidth cost, mirroring the
    // breaker's STRICT (rectangle-hunt) pass 2 — the stretch the layout
    // floor would apply over the ending's word glue PLUS the recruited
    // flexes (letterfit tracking and wdth expansion, saturating at their
    // budgets while glue continues to maxEndingStretch), continuous and
    // uncapped, accepted when the floor can actually reach the threshold
    // or at tolerance-cheap shortness (no emergency stretch here).
    let bad = 0;
    let filFit: Fitness = fitness(false, 0);
    const need = opts.lastLineMinWidth * W - L;
    if (need > 0) {
      // Clamped at 0, like the breaker: a glue-less ending's sums cancel
      // to a float epsilon of either sign.
      const trackY = cumTrackY[b]! - cumTrackY[start]!;
      const glueOnly = Math.max(0, cumY[b]! - cumY[start]! - trackY);
      const flexY = trackY + (cumExpY[b]! - cumExpY[start]!);
      const maxR = maxEndingStretch(opts.lastLineMinWidth);
      const flexCap = Math.min(maxR, 1);
      // endingFloorRatio, inlined — the oracle stays independent.
      let rFloor: number | null = null;
      if (need <= glueOnly * maxR + flexY * flexCap) {
        const pooled = need / (glueOnly + flexY);
        rFloor =
          pooled <= flexCap ? pooled : glueOnly > 0 ? (need - flexY * flexCap) / glueOnly : flexCap;
      }
      const r = need / (glueOnly + flexY);
      bad = 100 * r * r * r;
      if (rFloor === null && bad > opts.tolerance) return null;
      // Fitness from what renders, mirroring the breaker: reachable →
      // the real floor stretch; unreachable (renders natural) → Decent.
      filFit = rFloor !== null ? fitness(false, 100 * rFloor ** 3) : Fitness.Decent;
    }
    return { bad, fit: filFit, fil: true };
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
      let d = feas.fil
        ? demeritsUncapped(opts.linePenalty, feas.bad, p)
        : demerits(opts.linePenalty, feas.bad, p);
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
    // CJK item streams (per-cluster boxes, penalty(0) + inter-character
    // glue, kinsoku INF penalties) must satisfy the same optimality.
    "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗い所で泣いていた。",
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
    // The CJK stream too: inter-character glue makes most widths feasible.
    expect(bruteForce(build(texts[3]!), 210, pass2Opts)).not.toBeNull();
  });

  it("agrees with the oracle under lastLineMinWidth's render-aware ending cost", () => {
    // Per-value counters: a shared cap once let minWidth 0.5 consume every
    // check and left minWidth 1 — the headline value — with zero coverage.
    for (const minWidth of [0.5, 1]) {
      // Tracking on exercises the recruited-flex pools in the ending
      // cost (letterfit budgets enter the floor's reach); off keeps the
      // classic glue-only coverage.
      for (const tracking of [false, { max: 0.03, shrink: 0.03 }] as const) {
        let checked = 0;
        for (let width = 200; width <= 520; width += 40) {
          const opts = { ...pass2Opts, lastLineMinWidth: minWidth };
          const para = build(frogKing, { hyphenate: fakeHyphenator, tracking });
          const oracle = bruteForce(para, width, opts);
          if (oracle === null) continue; // no breaking passes tolerance at this width
          const result = breakParagraph(para, width, opts);
          // The oracle models the STRICT pass 2 only; compare when the
          // breaker's strict hunt succeeded (pass 2 with these opts —
          // pretolerance −1 skips both pass 1s, and a fallback result
          // would be a different, laxer optimization).
          expect(
            result.demerits,
            `minWidth ${minWidth} width ${width} tracking ${tracking !== false}`,
          ).toBeCloseTo(oracle, 6);
          checked++;
        }
        expect(checked, `minWidth ${minWidth} tracking ${tracking !== false}`).toBeGreaterThan(
          0,
        );
      }
    }
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

  it("sets an unbreakable over-measure word on its own line, not with its neighbors", () => {
    // "Wwwwwwwwwwwwwwww" = 12 + 15·9 = 147 > W = 100; everything around it
    // fits. The rescue seeding must originate at the break nearest the
    // giant word — preceding words go on a loose line and the overfull
    // line overflows by only the word's own excess (147 − 100 = 47), like
    // a browser. Seeding from the cheapest history instead swept "aa bb"
    // onto the overfull line (overflow 82+, spaces crushed to ratio −1).
    for (const text of [
      "aa bb Wwwwwwwwwwwwwwww cc dd",
      "aa bb cc Wwwwwwwwwwwwwwww",
      "Wwwwwwwwwwwwwwww aa bb cc",
    ]) {
      const para = build(text);
      const result = breakParagraph(para, 100, defaultBreakOptions);
      const lines = layoutLines(para, result, 100, defaultBuildOptions);
      const overfull = lines.filter((l) => l.overfull);
      expect(overfull).toHaveLength(1);
      expect(lineText(para, overfull[0]!).trim()).toBe("Wwwwwwwwwwwwwwww");
      expect(overfull[0]!.overflowPx).toBeCloseTo(47, 6);
      for (const line of lines) {
        if (!line.overfull) expect(line.overflowPx).toBe(0);
        expect(line.glueRatio).toBeGreaterThanOrEqual(-1 - 1e-9);
      }
    }
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

describe("lastLineMinWidth break pressure (short-last-line avoidance)", () => {

  /** RENDERED last-line width fraction: natural plus the floor's stretch. */
  const renderedEnding = (width: number, minWidth: number, tracking = false): number => {
    const build = {
      ...defaultBuildOptions,
      hyphenate: fakeHyphenator,
      lastLineMinWidth: minWidth,
      ...(tracking ? { tracking: { max: 0.03, shrink: 0.03 } } : {}),
    };
    const para = buildItems([{ text: frogKing, run: 0 }], [mockRun()], build, mockMeasure);
    const result = breakParagraph(para, width, {
      ...defaultBreakOptions,
      lastLineMinWidth: minWidth,
    });
    const lines = layoutLines(para, result, width, build);
    const last = lines[lines.length - 1]!;
    let natural = 0;
    let glueY = 0;
    let trackY = 0;
    for (let i = last.start; i < last.end; i++) {
      const it = para.items[i]!;
      if (it.type === ItemType.Box) {
        natural += it.width;
        trackY += it.trackStretch;
      } else if (it.type === ItemType.Glue) {
        natural += it.width;
        glueY += it.stretch;
      }
    }
    // Recruited letterfit counts toward the rendered ending (the floor
    // may draw on it; trackRatio ≤ 0 outside the floor path).
    return (
      (natural + Math.max(0, last.glueRatio) * glueY + Math.max(0, last.trackRatio) * trackY) /
      width
    );
  };


  it("every setting renders endings at least as long as OFF, and lengthens some", () => {
    // Regression for the badness-saturation plateau (1.0 used to behave
    // like OFF while 0.5 worked): both settings must always render an
    // ending no shorter than the default's. RENDERED width — the floor
    // may stretch a naturally-shorter ending past the default's. NOTE:
    // strong vs mid is deliberately NOT asserted — paragraph-level
    // all-or-nothing means a paragraph can satisfy 0.5's threshold at
    // tolerance yet fail 1.0's rectangle test and revert to clean-body
    // breaks with a shorter ending.
    let strongerHelped = 0;
    for (let width = 200; width <= 520; width += 20) {
      const def = renderedEnding(width, 0);
      const mid = renderedEnding(width, 0.5);
      const strong = renderedEnding(width, 1);
      expect(mid, `width ${width}`).toBeGreaterThanOrEqual(def - 1e-9);
      expect(strong, `width ${width}`).toBeGreaterThanOrEqual(def - 1e-9);
      if (strong > def + 1e-9) strongerHelped++;
    }
    expect(strongerHelped).toBeGreaterThan(0);
  });

  it("raising the setting never shortens an ending (threshold descent)", () => {
    // The cliff this guards: a paragraph that reaches 0.33's threshold
    // but not 1's used to collapse to the OPTION-OFF breaks, so raising
    // the slider GREW the short-last-line population (observed on the
    // Alice corpus). The descent retreats to the fullest reachable
    // absolute-sixteenth instead, making the rendered ending monotone in
    // the setting.
    const settings = [0, 0.25, 0.5, 0.75, 1];
    let strictlyImproved = 0;
    for (let width = 200; width <= 520; width += 16) {
      let prev = -1;
      for (const v of settings) {
        const frac = renderedEnding(width, v, true);
        expect(frac, `width ${width} v ${v}`).toBeGreaterThanOrEqual(prev - 1e-9);
        if (prev >= 0 && frac > prev + 1e-9) strictlyImproved++;
        prev = frac;
      }
    }
    expect(strictlyImproved).toBeGreaterThan(0);
  });

  it("recruits letterfit tracking for rectangles spaces alone cannot finish", () => {
    // The floor may draw on the ending's own letterfit (and wdth
    // expansion, exercised end-to-end in the browser) when word spaces
    // alone cannot reach the threshold — saturating at the ±3% budget,
    // with all-or-nothing preserved: a recruited ending always renders
    // AT the threshold, never stretched-and-still-short.
    const tracking = { max: 0.03, shrink: 0.03 };
    let recruited = 0;
    for (let width = 200; width <= 520; width += 8) {
      const buildOpts = {
        ...defaultBuildOptions,
        hyphenate: fakeHyphenator,
        lastLineMinWidth: 1,
        tracking,
      };
      const para = buildItems([{ text: frogKing, run: 0 }], [mockRun()], buildOpts, mockMeasure);
      const result = breakParagraph(para, width, { ...defaultBreakOptions, lastLineMinWidth: 1 });
      const lines = layoutLines(para, result, width, buildOpts);
      const last = lines[lines.length - 1]!;
      let natural = 0;
      let glueY = 0;
      let trackY = 0;
      for (let i = last.start; i < last.end; i++) {
        const it = para.items[i]!;
        if (it.type === ItemType.Box) {
          natural += it.width;
          trackY += it.trackStretch;
        } else if (it.type === ItemType.Glue) {
          natural += it.width;
          glueY += it.stretch;
        }
      }
      if (last.trackRatio > 1e-9) {
        const rendered =
          natural + Math.max(0, last.glueRatio) * glueY + last.trackRatio * trackY;
        expect(rendered, `width ${width}`).toBeCloseTo(width, 6);
        // Count the cases the old glue-only floor could NOT complete.
        if ((width - natural) / glueY > maxEndingStretch(1)) recruited++;
      }
    }
    expect(recruited).toBeGreaterThan(0);
  });

  it("recruits hyphenation for the ending (pass 1 must not mask pass 2)", () => {
    // The ending is tolerance-BOUND in passes 1–2: an arrangement whose
    // ending prices past tolerance fails the pass, so the breaker
    // escalates into hyphenation. A blanket fil exemption used to keep
    // pass 1 (hyphen-free) always-succeeding, trapping the pressure among
    // hyphenless breakings — skipping pass 1 by hand then produced
    // strictly longer endings than the normal ladder, which this asserts
    // can no longer happen.
    const fracWithHyphens = (width: number, opts: Partial<BreakOptions>): number => {
      const para = build(frogKing, { hyphenate: fakeHyphenator });
      const result = breakParagraph(para, width, {
        ...defaultBreakOptions,
        lastLineMinWidth: 1,
        ...opts,
      });
      const lines = layoutLines(para, result, width, defaultBuildOptions);
      const last = lines[lines.length - 1]!;
      let natural = 0;
      for (let i = last.start; i < last.end; i++) {
        const it = para.items[i]!;
        if (it.type === ItemType.Box || it.type === ItemType.Glue) natural += it.width;
      }
      return natural / width;
    };
    for (let width = 200; width <= 520; width += 20) {
      const normal = fracWithHyphens(width, {});
      const forcedPass2 = fracWithHyphens(width, { pretolerance: -1 });
      // Small slack: where pass 1 legitimately succeeds (ending within
      // pretolerance), pass 2's extra candidates may trade a hair of
      // ending length for cheaper demerits. The masking bug produced
      // differences of 0.3+.
      expect(normal, `width ${width}`).toBeGreaterThanOrEqual(forcedPass2 - 0.03);
    }
  });

  it("never buys the ending with a wrecked body line (paragraph-level all-or-nothing)", () => {
    // The telescope case: a paragraph too short for any tolerance-grade
    // rectangle. Escalation once let emergency pricing DISCOUNT body
    // looseness while the ending's preference dwarfed it — the optimizer
    // set a first line at glue ratio 7+ to buy a flush ending; a later
    // review found the bounded fallback's pass-3/rescue rungs doing the
    // same on other texts (frogKing w=196: OFF worst 3.0 → ON 3.75, for
    // an ending that STILL reverted). Now the strict hunt and the bounded
    // fallback both bind bodies at tolerance, and paragraphs in genuine
    // distress take the off ladder verbatim: no body line may be
    // materially looser than the off solution's, on any text, tracking on
    // or off. Pooled line.ratio is the badness currency (glueRatio
    // re-solves higher after tracking saturation).
    const TELESCOPE =
      "“What a curious feeling!” said Alice; “I must be shutting up like a telescope.”";
    const worstBody = (
      text: string,
      width: number,
      minWidth: number,
      tracking: boolean,
    ): number => {
      const build = {
        ...defaultBuildOptions,
        hyphenate: fakeHyphenator,
        lastLineMinWidth: minWidth,
        ...(tracking ? { tracking: { max: 0.03, shrink: 0.03 } } : {}),
      };
      const para = buildItems([{ text, run: 0 }], [mockRun()], build, mockMeasure);
      const result = breakParagraph(para, width, {
        ...defaultBreakOptions,
        lastLineMinWidth: minWidth,
      });
      const lines = layoutLines(para, result, width, build);
      let worst = 0;
      for (const line of lines.slice(0, -1)) worst = Math.max(worst, line.ratio);
      return worst;
    };
    for (const text of [TELESCOPE, frogKing]) {
      for (const tracking of [true, false]) {
        for (const v of [0.9, 1]) {
          for (let width = 180; width <= 560; width += 8) {
            const off = worstBody(text, width, 0, tracking);
            const on = worstBody(text, width, v, tracking);
            expect(
              on,
              `"${text.slice(1, 15)}" width ${width} v ${v} tracking ${tracking}`,
            ).toBeLessThanOrEqual(Math.max(off, 1.27) + 1e-6);
          }
        }
      }
    }
  });

  it("never yields a shorter ending than OFF, with tracking enabled", () => {
    // Regression: a glue-less ending's word-glue pool (cumY − cumTrackY)
    // cancels to a float epsilon of either sign; unclamped, a NEGATIVE
    // pool flipped the render-aware badness negative — a free pass
    // through every tolerance, so one-word endings beat every honest
    // arrangement (pass 1 "succeeded" with 1e99 total demerits while
    // real candidates were tolerance-rejected). Tracking must be ON:
    // without it the pool is a plain glue sum and never cancels.
    for (let width = 180; width <= 560; width += 8) {
      const off = renderedEnding(width, 0, true);
      const on = renderedEnding(width, 1, true);
      expect(on, `width ${width}`).toBeGreaterThanOrEqual(off - 1e-9);
    }
  });

  it("tolerates genuinely short paragraphs (no rescue blowup)", () => {
    const para = build("one two three");
    const result = breakParagraph(para, 500, { ...defaultBreakOptions, lastLineMinWidth: 0.5 });
    const lines = layoutLines(para, result, 500, defaultBuildOptions);
    expect(lines.length).toBe(1);
    expect(lines[0]!.overfull).toBe(false);
    expect(lines[0]!.glueRatio).toBe(0); // still set naturally
  });
});

describe("lastLineMinWidth rendering floor (ending widens to the threshold)", () => {
  /**
   * Last line's set width after glue adjustment, plus its word-glue
   * stretch pool (tracking off in defaultBuildOptions, so the glue-only
   * pool the layout stretches equals Yg here).
   */
  const setEnding = (text: string, width: number, minWidth: number) => {
    const buildOpts = { ...defaultBuildOptions, lastLineMinWidth: minWidth };
    const breakOpts = { ...defaultBreakOptions, lastLineMinWidth: minWidth };
    const para = build(text, { hyphenate: fakeHyphenator });
    const result = breakParagraph(para, width, breakOpts);
    const lines = layoutLines(para, result, width, buildOpts);
    const last = lines[lines.length - 1]!;
    let natural = 0;
    let Yg = 0;
    for (let i = last.start; i < last.end; i++) {
      const it = para.items[i]!;
      if (it.type === ItemType.Box) natural += it.width;
      else if (it.type === ItemType.Glue) {
        natural += it.width;
        Yg += it.stretch;
      }
    }
    const set = natural + Math.max(0, last.glueRatio) * Yg;
    return { set, natural, Yg, last, pass: result.pass, achieved: result.endingMinWidth ?? minWidth };
  };

  it("widens endings below the threshold exactly to it, and leaves longer ones natural", () => {
    let widened = 0;
    let untouched = 0;
    for (let width = 200; width <= 520; width += 20) {
      const v = 0.6;
      const { set, natural, Yg, last, achieved } = setEnding(frogKing, width, v);
      if (Yg === 0 || natural >= width) continue; // one-word / shrinking ending
      if (natural >= v * width) {
        expect(last.glueRatio).toBe(0); // already past the floor: natural
        untouched++;
      } else if ((v * width - natural) / Yg <= maxEndingStretch(v)) {
        expect(set).toBeCloseTo(v * width, 6);
        widened++;
      } else if (achieved < v) {
        // Unreachable at the request: the hunt DESCENDED — the ending
        // renders exactly at the achieved threshold (or stays natural
        // when it already clears it). All-or-nothing holds per level.
        if (natural < achieved * width) expect(set).toBeCloseTo(achieved * width, 6);
        else expect(last.glueRatio).toBe(0);
      } else {
        // No rung reachable at all (bounded/off fallback): natural.
        expect(last.glueRatio).toBe(0);
      }
    }
    expect(widened).toBeGreaterThan(0);
    expect(untouched).toBeGreaterThan(0);
  });

  it("minWidth 1 sets rectangles whenever flush is within the underfull bound", () => {
    let flush = 0;
    for (let width = 200; width <= 520; width += 20) {
      const { set, natural, Yg, last, achieved } = setEnding(frogKing, width, 1);
      if (Yg === 0 || natural >= width) continue;
      expect(last.overfull).toBe(false);
      const need = (width - natural) / Yg;
      if (need <= maxEndingStretch(1)) {
        expect(set).toBeCloseTo(width, 6);
        if (last.glueRatio > 0.01) flush++;
      } else if (achieved < 1) {
        // Flush unreachable: the hunt descended to the fullest
        // affordable sixteenth and the ending renders exactly there
        // (or stays natural when it already clears the rung).
        if (natural < achieved * width) expect(set).toBeCloseTo(achieved * width, 6);
        else expect(last.glueRatio).toBe(0);
      } else {
        expect(last.glueRatio).toBe(0);
        expect(set).toBeCloseTo(natural, 6);
      }
    }
    expect(flush).toBeGreaterThan(0);
  });

  it("the stretch willingness scales with the setting", () => {
    // A gentle floor works its spaces far less hard than rectangles do:
    // find widths where an ending is widened under v=1 yet reverts to
    // natural under a small v with the SAME breaks (the bound shrank).
    let scaled = 0;
    for (let width = 200; width <= 520; width += 20) {
      const para = build(frogKing, { hyphenate: fakeHyphenator });
      const result = breakParagraph(para, width, {
        ...defaultBreakOptions,
        lastLineMinWidth: 0.9,
      });
      // Strip the result's own threshold: this test probes the LAYOUT
      // floor's willingness scaling in isolation, so the opts fallback
      // must decide (a real result pins layout to its achieved value).
      const at = (v: number) =>
        layoutLines(para, { ...result, endingMinWidth: undefined }, width, {
          ...defaultBuildOptions,
          lastLineMinWidth: v,
        });
      const gentle = at(0.33)[at(0.33).length - 1]!.glueRatio;
      const strong = at(0.9)[at(0.9).length - 1]!.glueRatio;
      expect(gentle).toBeLessThanOrEqual(maxEndingStretch(0.33) + 1e-9);
      if (strong > maxEndingStretch(0.33) + 1e-9 && gentle === 0) scaled++;
    }
    expect(scaled).toBeGreaterThan(0);
  });

  it("reverts to natural spacing when the threshold is unreachable (all or nothing)", () => {
    // Three words cannot reach 500px at any sane spacing: rather than
    // rendering a line both stretched AND still short — worse than either
    // extreme — the ending falls back to fully natural spacing.
    const { set, natural, last } = setEnding("one two three", 500, 1);
    expect(last.glueRatio).toBe(0);
    expect(set).toBeCloseTo(natural, 6);
    expect(set).toBeLessThan(500);
  });

  it("leaves a one-word paragraph natural (no glue to stretch)", () => {
    const { set, Yg, last } = setEnding("Honorificabilitudinitatibus", 500, 1);
    expect(Yg).toBe(0);
    expect(last.glueRatio).toBe(0);
    expect(last.overfull).toBe(false);
    expect(set).toBeLessThan(500);
  });

  it("binds lastLineFit to the floor: composed endings never render below it", () => {
    // lastLineFit may color the ending looser OR tighter than natural;
    // the floor must hold in both directions (a fit-shrunk ending stops
    // at the floor, converted to the shrink pool it renders against).
    const v = 0.5;
    let fitActive = 0;
    for (let width = 200; width <= 520; width += 20) {
      const para = build(frogKing, { hyphenate: fakeHyphenator });
      const result = breakParagraph(para, width, defaultBreakOptions);
      const lines = layoutLines(para, result, width, {
        ...defaultBuildOptions,
        lastLineMinWidth: v,
        lastLineFit: 1,
      });
      const last = lines[lines.length - 1]!;
      let natural = 0;
      let Yg = 0;
      let Zg = 0;
      for (let i = last.start; i < last.end; i++) {
        const it = para.items[i]!;
        if (it.type === ItemType.Box) natural += it.width;
        else if (it.type === ItemType.Glue) {
          natural += it.width;
          Yg += it.stretch;
          Zg += it.shrink;
        }
      }
      if (Yg === 0 || natural >= width) continue;
      const set = natural + last.glueRatio * (last.glueRatio >= 0 ? Yg : Zg);
      const reachable =
        natural >= v * width || (v * width - natural) / Yg <= maxEndingStretch(v);
      if (reachable) expect(set, `width ${width}`).toBeGreaterThanOrEqual(v * width - 1e-6);
      if (Math.abs(last.glueRatio) > 1e-9) fitActive++;
    }
    expect(fitActive).toBeGreaterThan(0);
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
