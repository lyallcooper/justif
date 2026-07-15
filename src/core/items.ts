import { INF_PENALTY } from "./badness.js";
import {
  CJK_CHAR,
  CJK_GLUE_SHRINK,
  CJK_GLUE_STRETCH,
  cjkBreakAllowed,
  graphemes,
} from "./cjk.js";
import { protrusionCodes } from "./protrusion.js";
import {
  type Box,
  type BuildOptions,
  type Glue,
  type Item,
  ItemType,
  type Measure,
  type ParagraphItems,
  type Penalty,
  type RunMetrics,
  type RunText,
} from "./types.js";

const SOFT_HYPHEN = "\u00AD";
/** Letters-only word core eligible for pattern hyphenation. */
const WORD_CORE = /^(\P{L}*)(\p{L}+)(\P{L}*)$/u;
const MIN_HYPHENATION_LENGTH = 5;
/**
 * Breakable whitespace: everything \s matches EXCEPT no-break spaces
 * (U+00A0, U+202F), which stay inside boxes — unbreakable and unstretchable,
 * as the author intended.
 */
const BREAKABLE_SPACE = /[^\S\u00A0\u202F]/;
const BREAKABLE_SPLIT = /([^\S\u00A0\u202F]+)/;

/**
 * Right-protrusion credit when a line breaks at item `b`: the materialized
 * hyphen's for width-carrying penalties, otherwise the line's LAST BOX —
 * found by walking back over unbroken penalties and glue, so the paragraph-
 * final box protrudes past the parfillskip tail too (a full last line's
 * period must hang like any other line's). Shared by the breaker and
 * layoutLines so the two can never drift.
 */
export function breakRp(items: readonly Item[], b: number): number {
  const it = items[b]!;
  if (it.type === ItemType.Penalty && it.width > 0) return it.rp;
  for (let i = b - 1; i >= 0; i--) {
    const prev = items[i]!;
    if (prev.type === ItemType.Box) return prev.rp;
  }
  return 0;
}

/**
 * Protrusion hang for `ch` at a line edge, in px: code/1000 × advance
 * (pdfTeX semantics), from the run's own hand-tuned table when one matched
 * its font, else the paragraph-wide table. Monospace runs inside another
 * font's prose (`protrudeInkOnly`) cap the hang at the glyph's side
 * bearing so ink never leaves the measure.
 */
function protrusionHang(
  opts: BuildOptions,
  measure: Measure,
  ch: string,
  run: RunMetrics,
  advance: number,
  side: "l" | "r",
  firstLine = false,
): number {
  if (opts.protrusion === false) return 0;
  const table = firstLine
    ? (run.protrusionFirst ?? opts.protrusionFirst ?? run.protrusion ?? opts.protrusion)
    : (run.protrusion ?? opts.protrusion);
  const advCode = protrusionCodes(table, ch)?.[side] ?? 0;
  if (advCode === 0) return 0;
  const advHang = (advCode / 1000) * advance;
  if (run.protrudeInkOnly === true && measure.inkBearings !== undefined) {
    return Math.min(advHang, measure.inkBearings(ch, run)[side]);
  }
  // A line-START hang past the glyph's ink is pure displacement: the mark
  // detaches from the very margin it is meant to anchor (worst in
  // monospace, where a full-cell "“" floats ~4px out with a hole before
  // the text). Cap at ink-exit — the ink may leave the measure entirely
  // but stays flush against the margin. Line ENDS keep the full hang:
  // there the preceding text anchors the margin and the mark drifts
  // outward harmlessly.
  if (side === "l" && measure.inkBearings !== undefined) {
    return Math.min(advHang, Math.max(0, advance - measure.inkBearings(ch, run).r));
  }
  return advHang;
}

/**
 * Flattens a paragraph's styled runs into the Knuth-Plass item stream.
 * Whitespace is collapsed; words become boxes measured whole (kerning-safe),
 * spaces become glue from the run's space spec, and break opportunities
 * (soft hyphens, hyphenator output, explicit hyphens) become penalties.
 * Ends with the TeX parfillskip idiom so the last line sets naturally.
 */
export function buildItems(
  texts: readonly RunText[],
  runs: readonly RunMetrics[],
  opts: BuildOptions,
  measure: Measure,
): ParagraphItems {
  const items: Item[] = [];
  let pendingSpaceRun = -1;
  let hasBox = false;

  // Inline box extras and no-break scopes (RunText.padStartPx/padEndPx/
  // atomicKey). pendingPad accumulates until the element's first box exists
  // (its own first piece may be whitespace-only); lastBox is patched
  // retroactively when a piece marked padEndPx finishes. Boxes at a padded
  // edge drop their protrusion: the visual boundary there is the box
  // decoration, not the glyph.
  let pendingPad = 0;
  let lastBox: Box | null = null;
  let lastBoxRun = -1;
  let lastBoxKey: number | undefined;
  let pieceKey: number | undefined;

  const emitBox = (box: Box, runIndex: number): void => {
    if (pendingPad > 0) {
      box.width += pendingPad;
      box.padPx = (box.padPx ?? 0) + pendingPad;
      box.lp = 0;
      box.lpFirst = 0;
      pendingPad = 0;
    }
    items.push(box);
    hasBox = true;
    lastBox = box;
    lastBoxRun = runIndex;
    lastBoxKey = pieceKey;
  };

  const hyphenRp = (run: RunMetrics): number =>
    protrusionHang(opts, measure, "-", run, run.hyphenWidth, "r");

  const makeBox = (text: string, runIndex: number, width: number): Box => {
    const run = runs[runIndex]!;
    let lp = 0;
    let rp = 0;
    let lpFirst = 0;
    if (opts.protrusion !== false) {
      const chars = Array.from(text);
      const first = chars[0]!;
      const last = chars[chars.length - 1]!;
      const firstAdv = measure.charAdvance(first, run);
      lp = protrusionHang(opts, measure, first, run, firstAdv, "l");
      lpFirst =
        (run.protrusionFirst ?? opts.protrusionFirst) === undefined
          ? lp
          : protrusionHang(opts, measure, first, run, firstAdv, "l", true);
      rp = protrusionHang(opts, measure, last, run, measure.charAdvance(last, run), "r");
    }
    let expStretch = 0;
    let expShrink = 0;
    if (opts.expansion !== false) {
      if (run.ratioAtMax > 1) expStretch = width * (run.ratioAtMax - 1);
      if (run.ratioAtMin < 1) expShrink = width * (1 - run.ratioAtMin);
    }
    let trackStretch = 0;
    let trackShrink = 0;
    if (opts.tracking !== false) {
      trackStretch = width * opts.tracking.max;
      trackShrink = width * opts.tracking.shrink;
    }
    return {
      type: ItemType.Box,
      width,
      run: runIndex,
      text,
      lp,
      lpFirst,
      rp,
      expStretch,
      expShrink,
      trackStretch,
      trackShrink,
    };
  };

  const pushPenalty = (p: Omit<Penalty, "type">): void => {
    items.push({ type: ItemType.Penalty, ...p });
  };

  interface PiecePenalty {
    penalty: number;
    width: number;
    flagged: boolean;
    hyphen: boolean;
    rp: number;
    /** True → use the preceding box's rp (an explicit "-" is box text). */
    rpFromBox?: boolean;
  }
  interface PiecePlan {
    text: string;
    after: PiecePenalty | null;
  }

  /** Split one chunk (no explicit hyphens) at soft hyphens or hyphenator points. */
  const chunkPieces = (
    chunk: string,
    noHyphens: boolean,
  ): { pieces: string[]; fromHyphenator: boolean } => {
    if (noHyphens) {
      // CSS hyphens:none — strip soft hyphens instead of honoring them.
      const text = chunk.split(SOFT_HYPHEN).join("");
      return { pieces: text.length > 0 ? [text] : [], fromHyphenator: false };
    }
    if (chunk.includes(SOFT_HYPHEN)) {
      return {
        pieces: chunk.split(SOFT_HYPHEN).filter((s) => s.length > 0),
        fromHyphenator: false,
      };
    }
    if (opts.hyphenate) {
      const m = WORD_CORE.exec(chunk);
      if (m && m[2]!.length >= MIN_HYPHENATION_LENGTH) {
        const prefix = m[1]!;
        const core = m[2]!;
        const suffix = m[3]!;
        const parts = opts.hyphenate(core.toLowerCase()).filter((p) => p.length > 0);
        // The offsets come from the lowercased core; reject output whose
        // total length differs (length-changing case mappings, e.g. İ→i̇,
        // would misalign every subsequent break point).
        if (parts.length > 1 && parts.join("").length === core.length) {
          // Slice the original (cased) core at the hyphenator's offsets.
          const pieces: string[] = [];
          let off = 0;
          for (const part of parts) {
            pieces.push(core.slice(off, off + part.length));
            off += part.length;
          }
          pieces[0] = prefix + pieces[0]!;
          pieces[pieces.length - 1] = pieces[pieces.length - 1]! + suffix;
          return { pieces, fromHyphenator: true };
        }
      }
    }
    return { pieces: [chunk], fromHyphenator: false };
  };

  /**
   * Emit the word-space glue a previous whitespace run left pending, knowing
   * the run of the box that will follow it. Two space-position rules live
   * here: a space between two boxes of one nowrap element is unbreakable
   * (penalty ∞ in front — flex intact, break forbidden), and a space at a
   * font-family boundary shrinks only by `boundaryShrink` (rigid by
   * default; see BuildOptions.boundaryShrink).
   */
  const flushPendingSpace = (nextRun: number): void => {
    if (pendingSpaceRun >= 0 && hasBox) {
      const space = runs[pendingSpaceRun]!.space;
      if (pieceKey !== undefined && pieceKey === lastBoxKey) {
        pushPenalty({ penalty: INF_PENALTY, width: 0, flagged: false, hyphen: false, rp: 0, run: pendingSpaceRun });
      }
      const boundary =
        lastBoxRun >= 0 && runs[lastBoxRun]!.familyKey !== runs[nextRun]!.familyKey;
      items.push({
        type: ItemType.Glue,
        width: space.width,
        stretch: space.stretch,
        stretchFil: 0,
        shrink: boundary ? space.shrink * opts.boundaryShrink : space.shrink,
        run: pendingSpaceRun,
        rigid: boundary && opts.boundaryShrink < 1 ? true : undefined,
      } satisfies Glue);
    }
    pendingSpaceRun = -1;
  };

  const pushWord = (token: string, runIndex: number): void => {
    const run = runs[runIndex]!;

    // Plan all fragments: explicit hyphens ("self-made" → "self-" | "made"),
    // then soft-hyphen/hyphenator splits within each chunk. Inside a nowrap
    // element nothing may break, so the token stays one box (soft hyphens
    // stripped like the noHyphens path).
    const chunks = pieceKey !== undefined ? [token] : token.split(/(?<=-)(?=[^-])/);
    const plans: PiecePlan[] = [];
    for (let c = 0; c < chunks.length; c++) {
      const { pieces, fromHyphenator } = chunkPieces(
        chunks[c]!,
        run.noHyphens === true || pieceKey !== undefined,
      );
      for (let i = 0; i < pieces.length; i++) {
        let after: PiecePenalty | null = null;
        if (i < pieces.length - 1) {
          after = {
            penalty: opts.hyphenPenalty,
            width: run.hyphenWidth,
            flagged: true,
            hyphen: fromHyphenator,
            rp: hyphenRp(run),
          };
        } else if (c < chunks.length - 1) {
          after = {
            penalty: opts.exHyphenPenalty,
            width: 0,
            flagged: true,
            hyphen: false,
            rp: 0,
            rpFromBox: true,
          };
        }
        plans.push({ text: pieces[i]!, after });
      }
    }
    // A token with no measurable pieces (e.g. a lone soft hyphen) emits
    // nothing — and must not consume the pending space, or the next word
    // would get a doubled glue.
    if (plans.length === 0) return;

    flushPendingSpace(runIndex);

    // Fragment widths are measured incrementally over token prefixes so they
    // sum exactly to the kerned whole-token width: adding break opportunities
    // never perturbs lines that don't use them, and a line broken at a
    // fragment gets exactly the width of its rendered prefix.
    let acc = "";
    let accWidth = 0;
    for (const plan of plans) {
      acc += plan.text;
      const prefixWidth = measure.width(acc, run);
      const box = makeBox(plan.text, runIndex, prefixWidth - accWidth);
      accWidth = prefixWidth;
      emitBox(box, runIndex);
      if (plan.after !== null) {
        pushPenalty({
          penalty: plan.after.penalty,
          width: plan.after.width,
          flagged: plan.after.flagged,
          hyphen: plan.after.hyphen,
          rp: plan.after.rpFromBox === true ? box.rp : plan.after.rp,
          run: runIndex,
        });
      }
    }
  };

  /**
   * A token containing CJK text (no whitespace, like every token here):
   * each CJK grapheme cluster becomes its own box, and every legal
   * inter-cluster boundary gets penalty(0) + zero-width stretchable glue —
   * a break opportunity WITHOUT a space, plus the flex Japanese
   * justification distributes between characters. Kinsoku-prohibited
   * boundaries (a line may not start with 。、」ー small kana… nor end
   * with 「（…) keep the glue but carry an infinite penalty; the glue is
   * never breakable on its own because it always follows a penalty (the
   * breaker's glue rule requires a preceding BOX). Embedded non-CJK
   * stretches (Latin words, digits) stay single boxes: hyphenation never
   * runs inside a mixed token, and NO break opportunity is invented inside
   * them — only at their CJK boundaries, where UAX #14 allows one.
   */
  const pushCJKToken = (token: string, runIndex: number): void => {
    const run = runs[runIndex]!;
    // Soft hyphens are meaningless between ideographs; strip them (the
    // Latin path likewise drops them from the emitted text).
    const clean = token.split(SOFT_HYPHEN).join("");
    if (clean.length === 0) return;

    // Each CJK cluster is its own group; consecutive non-CJK clusters
    // merge into one opaque group.
    interface Group {
      cjk: boolean;
      text: string;
    }
    const groups: Group[] = [];
    for (const cluster of graphemes(clean)) {
      const cjk = CJK_CHAR.test(cluster);
      const last = groups[groups.length - 1];
      if (!cjk && last !== undefined && !last.cjk) last.text += cluster;
      else groups.push({ cjk, text: cluster });
    }

    flushPendingSpace(runIndex);

    // Each group is measured in ISOLATION, deliberately unlike pushWord's
    // prefix-incremental scheme: engines disagree on kana kerning between
    // canvas and DOM (Chromium's DOM kerns kana pairs its canvas never
    // measures; WebKit is the inverse), so cross-cluster kerning cannot be
    // modeled consistently. Instead the model assumes NO kerning between
    // clusters — the traditional solid setting (bete-gumi) — and the
    // renderer disables it in the DOM to match (font-kerning: none on
    // CJK-bearing segments; see write.ts).
    let prev: { group: Group; width: number } | null = null;
    for (const group of groups) {
      const width = measure.width(group.text, run);
      if (prev !== null) {
        const before = prev.group.cjk
          ? prev.group.text
          : (graphemes(prev.group.text).pop() ?? "");
        const after = group.cjk ? group.text : (graphemes(group.text)[0] ?? "");
        pushPenalty({
          // Inside a nowrap element every inter-cluster boundary is
          // break-prohibited; the glue still flexes for justification.
          penalty:
            pieceKey === undefined && cjkBreakAllowed(before, after) ? 0 : INF_PENALTY,
          width: 0,
          flagged: false,
          hyphen: false,
          rp: 0, // breakRp walks back to the box, whose own rp applies
          run: runIndex,
          cjk: true,
        });
        // Glue basis ≈ the em: the neighboring CJK cluster's advance (mean
        // of the two when both are CJK — punctuation and halfwidth kana
        // then flex less, as they should). Never the non-CJK side: a whole
        // Latin word's width would wildly over-flex its two boundaries.
        const basis =
          prev.group.cjk && group.cjk
            ? (prev.width + width) / 2
            : prev.group.cjk
              ? prev.width
              : width;
        items.push({
          type: ItemType.Glue,
          width: 0,
          stretch: CJK_GLUE_STRETCH * basis,
          stretchFil: 0,
          shrink: CJK_GLUE_SHRINK * basis,
          run: runIndex,
          cjk: true,
        } satisfies Glue);
      }
      emitBox(makeBox(group.text, runIndex, width), runIndex);
      prev = { group, width };
    }
  };

  for (const piece of texts) {
    const { text, run } = piece;
    pieceKey = piece.atomicKey;
    if (piece.padStartPx !== undefined) pendingPad += piece.padStartPx;
    const parts = text.split(BREAKABLE_SPLIT);
    for (const part of parts) {
      if (part.length === 0) continue;
      if (BREAKABLE_SPACE.test(part[0]!)) {
        if (hasBox) pendingSpaceRun = run;
      } else if (CJK_CHAR.test(part)) {
        pushCJKToken(part, run);
      } else {
        pushWord(part, run);
      }
    }
    // The element's trailing extras ride its LAST box, wherever the last
    // box-bearing piece was (this piece may end in whitespace, or be
    // whitespace-only). The reader guarantees a padded element contains at
    // least one box-worthy character, so lastBox is that element's. (The
    // cast: lastBox is only ever assigned inside emitBox, which TS's
    // narrowing can't see.)
    const lb = lastBox as Box | null;
    if (piece.padEndPx !== undefined && lb !== null) {
      lb.width += piece.padEndPx;
      lb.padPx = (lb.padPx ?? 0) + piece.padEndPx;
      lb.rp = 0;
    }
  }
  pieceKey = undefined;

  if (opts.lastLineMinWords >= 2) {
    let gluesFromEnd = 0;
    for (let i = items.length - 1; i >= 0 && gluesFromEnd < opts.lastLineMinWords - 1; i--) {
      // Only WORD gaps count: CJK inter-character glue is not a word
      // boundary, and a penalty spliced between a kinsoku penalty and its
      // glue would legalize a prohibited break (and render a phantom space).
      // The same trap guards nowrap-internal spaces: their glue sits behind
      // a penalty ∞, and splicing a finite penalty in between would create
      // the very break opportunity the element forbids.
      if (items[i]!.type !== ItemType.Glue || (items[i] as Glue).cjk === true) continue;
      gluesFromEnd++;
      const guard = items[i - 1];
      if (guard !== undefined && guard.type === ItemType.Penalty && guard.penalty >= INF_PENALTY) {
        continue; // still a word gap, but its break is already forbidden
      }
      const run = (items[i] as Glue).run;
      items.splice(i, 0, {
        type: ItemType.Penalty,
        penalty: opts.lastLinePenalty,
        width: 0,
        flagged: false,
        hyphen: false,
        rp: 0,
        run,
      });
    }
  }

  // \penalty10000 \parfillskip \penalty-10000
  pushPenalty({ penalty: INF_PENALTY, width: 0, flagged: false, hyphen: false, rp: 0, run: 0 });
  items.push({ type: ItemType.Glue, width: 0, stretch: 0, stretchFil: 1, shrink: 0, run: 0 });
  pushPenalty({ penalty: -INF_PENALTY, width: 0, flagged: false, hyphen: false, rp: 0, run: 0 });

  return withSums(items, runs);
}

/**
 * Attaches cumulative sums and the first-box index to an item stream.
 * Escape hatch for hand-built streams. Invariants the breaker relies on:
 * widths/stretch/shrink must be nonnegative (negative glue would break
 * active-node deactivation monotonicity) and the stream must end with a
 * forced penalty (penalty ≤ −INF_PENALTY).
 */
export function withSums(items: Item[], runs: readonly RunMetrics[]): ParagraphItems {
  const n = items.length;
  const cumW = new Float64Array(n + 1);
  const cumY = new Float64Array(n + 1);
  const cumYfil = new Float64Array(n + 1);
  const cumZ = new Float64Array(n + 1);
  const cumExpY = new Float64Array(n + 1);
  const cumExpZ = new Float64Array(n + 1);
  const cumTrackY = new Float64Array(n + 1);
  const firstBoxAfter = new Int32Array(n + 1);

  for (let i = 0; i < n; i++) {
    const it = items[i]!;
    let w = 0, y = 0, yFil = 0, z = 0, ey = 0, ez = 0, ty = 0;
    if (it.type === ItemType.Box) {
      w = it.width;
      ey = it.expStretch;
      ez = it.expShrink;
      // Tracking folds into the GLUE sums: it flexes continuously with the
      // same ratio as glue (unlike expansion, which quantizes), so breaker
      // badness and layout distribution need no third pool. cumTrackY
      // exists only so the layout can saturate tracking at stretch ratio 1.
      y = ty = it.trackStretch;
      z = it.trackShrink;
    } else if (it.type === ItemType.Glue) {
      w = it.width;
      y = it.stretch;
      yFil = it.stretchFil;
      z = it.shrink;
    }
    cumW[i + 1] = cumW[i]! + w;
    cumY[i + 1] = cumY[i]! + y;
    cumYfil[i + 1] = cumYfil[i]! + yFil;
    cumZ[i + 1] = cumZ[i]! + z;
    cumExpY[i + 1] = cumExpY[i]! + ey;
    cumExpZ[i + 1] = cumExpZ[i]! + ez;
    cumTrackY[i + 1] = cumTrackY[i]! + ty;
  }

  firstBoxAfter[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    firstBoxAfter[i] = items[i]!.type === ItemType.Box ? i : firstBoxAfter[i + 1]!;
  }

  return {
    items,
    runs,
    cumW,
    cumY,
    cumYfil,
    cumZ,
    cumExpY,
    cumExpZ,
    cumTrackY,
    firstBoxAfter,
  };
}
