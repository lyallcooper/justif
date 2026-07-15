import {
  badness,
  demerits,
  Fitness,
  fitness,
  INF_BAD,
  INF_PENALTY,
} from "./badness.js";
import { breakRp } from "./items.js";
import {
  type BreakOptions,
  type BreakResult,
  ItemType,
  type LineWidths,
  lineWidthAt,
  type ParagraphItems,
} from "./types.js";

interface Node {
  /** Breakpoint item index; -1 for the paragraph start. */
  item: number;
  /** First item of the following line (a box; discardables skipped). */
  start: number;
  /** Lines completed before this point = index of the upcoming line. */
  line: number;
  fitness: Fitness;
  flagged: boolean;
  overfull: boolean;
  totalDemerits: number;
  prev: Node | null;
  next: Node | null;
}

/**
 * Knuth-Plass total-fit line breaking with TeX's three-pass escalation:
 * pass 1 ignores hyphenation points at `pretolerance`, pass 2 enables them at
 * `tolerance`, pass 3 adds emergency stretch to the badness computation only.
 * A final rescue pass (TeX's artificial demerits, §854) guarantees a result
 * even for unbreakable overfull material.
 */
export function breakParagraph(
  para: ParagraphItems,
  widths: LineWidths,
  opts: BreakOptions,
): BreakResult {
  // No boxes (empty or whitespace-only input): the only content is the
  // parfillskip tail — break at the final forced penalty without running
  // any passes. layoutLines emits zero lines for such paragraphs.
  if (para.firstBoxAfter[0] === para.items.length) {
    return { breakpoints: [para.items.length - 1], pass: 1, overfull: [false], demerits: 0 };
  }

  let emergency = 0;
  if (opts.emergencyStretch === "auto") {
    // TeX wisdom is \emergencystretch ≈ 3em; a space is ~1/4 em, so 12
    // space-widths. (Badness-only: rendered lines still stretch just as far
    // as needed, so pass 3 yields loose lines, not crushed or overfull ones.)
    for (const run of para.runs) emergency = Math.max(emergency, 12 * run.space.width);
  } else {
    emergency = opts.emergencyStretch;
  }

  let end: Node | null = null;
  let pass: 1 | 2 | 3 = 1;
  if (opts.pretolerance >= 0) {
    end = attempt(para, widths, opts, opts.pretolerance, false, 0, false);
  }
  if (end === null) {
    pass = 2;
    end = attempt(para, widths, opts, opts.tolerance, true, 0, false);
  }
  if (end === null && emergency > 0) {
    pass = 3;
    end = attempt(para, widths, opts, opts.tolerance, true, emergency, false);
  }
  if (end === null) {
    // Rescue: tolerance opens to INF_BAD so ANY line that merely stretches —
    // however loose — beats poking out of the measure. TeX instead emits an
    // overfull hbox and expects the author to rewrite; on the web there is
    // no author in the loop, and a loose line degrades better than glyphs
    // escaping the container. Artificial demerits (TeX §854) then fire only
    // at genuinely unbreakable material (a token wider than the measure),
    // which overflows exactly like an unbreakable word does in a browser.
    // pass is already 2 or 3 here (pass 2 always runs when pass 1 fails).
    end = attempt(para, widths, opts, INF_BAD, true, emergency, true);
  }
  if (end === null) throw new Error("justif: rescue pass failed (bug)");

  const breakpoints: number[] = [];
  const overfull: boolean[] = [];
  for (let node: Node | null = end; node !== null && node.item >= 0; node = node.prev) {
    breakpoints.push(node.item);
    overfull.push(node.overfull);
  }
  breakpoints.reverse();
  overfull.reverse();
  return { breakpoints, pass, overfull, demerits: end.totalDemerits };
}

function attempt(
  para: ParagraphItems,
  widths: LineWidths,
  opts: BreakOptions,
  tolerance: number,
  allowHyphens: boolean,
  extraStretch: number,
  rescue: boolean,
): Node | null {
  const { items, cumW, cumY, cumYfil, cumZ, cumExpY, cumExpZ, firstBoxAfter } = para;
  const n = items.length;

  let active: Node | null = {
    item: -1,
    start: firstBoxAfter[0]!,
    line: 0,
    fitness: Fitness.Decent,
    flagged: false,
    overfull: false,
    totalDemerits: 0,
    prev: null,
    next: null,
  };

  interface Candidate {
    from: Node;
    fitness: Fitness;
    totalDemerits: number;
    overfull: boolean;
  }
  const candidates = new Map<number, Candidate>();

  for (let b = 0; b < n; b++) {
    const it = items[b]!;

    let p: number;
    let flagged: boolean;
    let penWidth: number;
    if (it.type === ItemType.Glue) {
      const prev = items[b - 1];
      if (prev === undefined || prev.type !== ItemType.Box) continue;
      p = 0;
      flagged = false;
      penWidth = 0;
    } else if (it.type === ItemType.Penalty) {
      if (it.penalty >= INF_PENALTY) continue;
      if (it.hyphen && !allowHyphens) continue;
      p = it.penalty;
      flagged = it.flagged;
      penWidth = it.width;
    } else {
      continue;
    }
    const rp = breakRp(items, b);

    const forced = it.type === ItemType.Penalty && it.penalty <= -INF_PENALTY;

    candidates.clear();
    let bestDead: Node | null = null;
    let bestDeadRatio = 0;
    let prevLink: Node | null = null;
    let node: Node | null = active;

    while (node !== null) {
      const next: Node | null = node.next;
      const start = node.start;

      let L = cumW[b]! - cumW[start]! + penWidth;
      const startItem = items[start];
      if (startItem !== undefined && startItem.type === ItemType.Box) {
        L -= node.line === 0 ? startItem.lpFirst : startItem.lp;
      }
      L -= rp;

      const W = lineWidthAt(widths, node.line);
      const Y = cumY[b]! - cumY[start]! + (cumExpY[b]! - cumExpY[start]!);
      const Yfil = cumYfil[b]! - cumYfil[start]!;
      const Z = cumZ[b]! - cumZ[start]! + (cumExpZ[b]! - cumExpZ[start]!);

      let r: number;
      if (L < W) r = Yfil > 0 ? 0 : Y > 0 ? (W - L) / Y : Infinity;
      else if (L > W) r = Z > 0 ? (L - W) / -Z : -Infinity;
      else r = 0;

      if (r >= -1) {
        let bad: number;
        let filLine = false;
        if (L >= W) {
          bad = badness(L - W, Z);
        } else if (Yfil > 0) {
          // Fil line (paragraph end). With finite lastLineStretch, short
          // last lines cost badness. Fil lines are exempt from tolerance
          // rejection (a genuinely short paragraph must stay breakable);
          // with f = lastLineStretch the ratio is at most W/(f·W), so the
          // cost stays finite and strictly monotone in shortness — no
          // plateau, and the chosen last line is never shorter than the
          // default's.
          filLine = true;
          bad =
            opts.lastLineStretch === Infinity
              ? 0
              : badness(W - L, opts.lastLineStretch * W + Y + extraStretch);
        } else {
          bad = badness(W - L, Y + extraStretch);
        }
        if (bad <= tolerance || filLine) {
          const fit = fitness(L > W, bad);
          let d = demerits(opts.linePenalty, bad, p);
          if (flagged && node.flagged) d += opts.doubleHyphenDemerits;
          if (Math.abs(fit - node.fitness) > 1) d += opts.adjDemerits;
          if (forced && b === n - 1 && node.flagged) d += opts.finalHyphenDemerits;
          const total = node.totalDemerits + d;
          const key = node.line * 4 + fit;
          const existing = candidates.get(key);
          if (existing === undefined || total < existing.totalDemerits) {
            candidates.set(key, { from: node, fitness: fit, totalDemerits: total, overfull: false });
          }
        }
      }

      if (r < -1 || forced) {
        // Deactivate: unlink from the active list.
        if (prevLink === null) active = next;
        else prevLink.next = next;
        if (
          bestDead === null ||
          node.totalDemerits < bestDead.totalDemerits ||
          (node.totalDemerits === bestDead.totalDemerits && r > bestDeadRatio)
        ) {
          bestDead = node;
          bestDeadRatio = r;
        }
      } else {
        prevLink = node;
      }
      node = next;
    }

    // TeX's artificial demerits: in the rescue pass, never let the active
    // list die without a successor — break here at the least-bad dead node.
    if (rescue && active === null && candidates.size === 0 && bestDead !== null) {
      candidates.set(bestDead.line * 4 + Fitness.Decent, {
        from: bestDead,
        fitness: Fitness.Decent,
        totalDemerits: bestDead.totalDemerits,
        overfull: bestDeadRatio < -1,
      });
    }

    if (candidates.size > 0) {
      const start = firstBoxAfter[b + 1]!;
      for (const cand of candidates.values()) {
        const fresh: Node = {
          item: b,
          start,
          line: cand.from.line + 1,
          fitness: cand.fitness,
          flagged,
          overfull: cand.overfull,
          totalDemerits: cand.totalDemerits,
          prev: cand.from,
          next: active,
        };
        active = fresh;
      }
    }

    if (active === null) return null; // pass failed
  }

  // The final forced penalty deactivated everything and re-seeded nodes at
  // the paragraph end; pick the cheapest.
  let best: Node | null = null;
  for (let node: Node | null = active; node !== null; node = node.next) {
    if (best === null || node.totalDemerits < best.totalDemerits) best = node;
  }
  return best;
}
