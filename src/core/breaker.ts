import {
  badness,
  demerits,
  demeritsUncapped,
  Fitness,
  fitness,
  INF_BAD,
  INF_PENALTY,
  maxEndingStretch,
} from "./badness.js";
import { breakRp, endingFloorRatio } from "./items.js";
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
    return {
      breakpoints: [para.items.length - 1],
      pass: 1,
      overfull: [false],
      demerits: 0,
      endingMinWidth: opts.lastLineMinWidth,
    };
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
  /** The threshold the returned solution was found under — layoutLines
   * applies the render floor at THIS value, not the requested one, so a
   * degraded hunt's ending stretches to what it can actually reach. */
  let achieved = opts.lastLineMinWidth;
  // RECTANGLE HUNT (lastLineMinWidth > 0): strict passes where the ending
  // must be render-reachable (or cost no more than tolerance) and body
  // lines bind at the normal tolerances. Failing both means NO breaking
  // reaches the threshold without a worse-than-tolerance line — the hunt
  // then DESCENDS (below) rather than let pass-3 emergency pricing buy a
  // stretched ending with a wrecked body line (emergency stretch
  // discounts body looseness in the cost while the ending's uncapped
  // preference dwarfs it — the optimizer would trade a rescue-grade
  // first line for a flush ending).
  const hunt = (minWidth: number): { end: Node | null; pass: 1 | 2 | 3 } => {
    const o = { ...opts, lastLineMinWidth: minWidth };
    let e: Node | null = null;
    let p: 1 | 2 | 3 = 1;
    if (o.pretolerance >= 0) {
      e = attempt(para, widths, o, {
        tolerance: o.pretolerance,
        hyphens: false,
        extraStretch: 0,
        rescue: false,
        strictEnding: true,
      });
    }
    if (e === null) {
      p = 2;
      e = attempt(para, widths, o, {
        tolerance: o.tolerance,
        hyphens: true,
        extraStretch: 0,
        rescue: false,
        strictEnding: true,
      });
    }
    return { end: e, pass: p };
  };
  if (opts.lastLineMinWidth > 0) {
    ({ end, pass } = hunt(opts.lastLineMinWidth));
    if (end === null) {
      // THRESHOLD DESCENT: the retreat between the requested threshold
      // and OFF. Without it the failure mode is a cliff — a paragraph
      // that misses a rectangle by a hang's width reverts all the way to
      // the option-off ending (raising the setting could SHORTEN endings;
      // observed as the demo's short-last-line count rising past 0.33).
      // Binary-search the highest ABSOLUTE sixteenth below the requested
      // threshold whose hunt succeeds (reachability is monotone in the
      // threshold for all practical pools, so ~4 hunts). Absolute grid,
      // not sixteenths OF the request: every setting then lands on the
      // same rungs, so raising the slider can never achieve a LOWER rung
      // than a smaller setting would — the monotonicity this exists for.
      // The winner still faces the off comparison below at its achieved
      // threshold.
      let lo = 1;
      let hi = Math.min(15, Math.ceil(opts.lastLineMinWidth * 16) - 1);
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = hunt(mid / 16);
        if (r.end !== null) {
          end = r.end;
          pass = r.pass;
          achieved = mid / 16;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
    }
  }
  // FALLBACK LADDERS. The classic option-off pass shape; the final rescue
  // attempt opens tolerance to INF_BAD so ANY line that merely stretches —
  // however loose — beats poking out of the measure (TeX instead emits an
  // overfull hbox and expects the author to rewrite; on the web there is
  // no author in the loop, and a loose line degrades better than glyphs
  // escaping the container; artificial demerits, TeX §854, then fire only
  // at genuinely unbreakable material, which overflows exactly like an
  // unbreakable word does in a browser).
  const ladder = (o: BreakOptions): { end: Node | null; pass: 1 | 2 | 3 } => {
    let e: Node | null = null;
    let p: 1 | 2 | 3 = 1;
    if (o.pretolerance >= 0) {
      e = attempt(para, widths, o, {
        tolerance: o.pretolerance,
        hyphens: false,
        extraStretch: 0,
        rescue: false,
        strictEnding: false,
      });
    }
    if (e === null) {
      p = 2;
      e = attempt(para, widths, o, {
        tolerance: o.tolerance,
        hyphens: true,
        extraStretch: 0,
        rescue: false,
        strictEnding: false,
      });
    }
    if (e === null && emergency > 0) {
      p = 3;
      e = attempt(para, widths, o, {
        tolerance: o.tolerance,
        hyphens: true,
        extraStretch: emergency,
        rescue: false,
        strictEnding: false,
      });
    }
    if (e === null) e = attempt(para, widths, o, {
        tolerance: INF_BAD,
        hyphens: true,
        extraStretch: emergency,
        rescue: true,
        strictEnding: false,
      });
    return { end: e, pass: p };
  };
  if (opts.lastLineMinWidth > 0 && end !== null && achieved < opts.lastLineMinWidth) {
    // A DESCENT winner still faces the off comparison, at its achieved
    // threshold: if the off arrangement's ending renders at least as long
    // under the same floor, take off verbatim (purer body typography;
    // renderedEndingWidth gives both solutions their floor stretch, so a
    // tie means identical ending widths). Keeps "ON never renders a
    // shorter ending than OFF" true by construction.
    const off = ladder({ ...opts, lastLineMinWidth: 0 });
    if (
      off.end !== null &&
      renderedEndingWidth(para, widths, off.end, achieved) + 1e-9 >=
        renderedEndingWidth(para, widths, end, achieved)
    ) {
      ({ end, pass } = off);
    }
  } else if (end === null && opts.lastLineMinWidth > 0) {
    // BOUNDED-PRESSURE FALLBACK, compare-and-pick — reached only when the
    // hunt failed at EVERY descent level (no strict-tolerance arrangement
    // reaches even a sixteenth of the threshold). The bounded candidate
    // gets ONE pass-2-shaped attempt: bodies bound at tolerance, hyphens
    // available, endings exempt (as a fil line classically is) with cost
    // capped at INF_BAD; the hyphen-free first pass is skipped because
    // exempt endings would make it always succeed, masking the hyphenated
    // longer-ending arrangements the preference exists to find. It is NOT
    // allowed into emergency/rescue: body badness is admission-discounted
    // there, so even the capped preference could outbid a genuinely
    // degraded line — a paragraph in that much distress takes the off
    // ladder's typography verbatim, preference silent.
    //
    // The bounded solution is kept ONLY if it renders a strictly longer
    // ending; ties and losses take the off solution verbatim. This makes
    // "ON never renders a shorter ending than OFF" true by construction:
    // on the capped cost's plateau every hopeless ending prices alike, so
    // ties there used to resolve against a different candidate set than
    // OFF's (pass 2 vs pass 1) and could pick shorter endings.
    const bounded = attempt(para, widths, opts, {
      tolerance: opts.tolerance,
      hyphens: true,
      extraStretch: 0,
      rescue: false,
      strictEnding: false,
    });
    const off = ladder({ ...opts, lastLineMinWidth: 0 });
    const v = opts.lastLineMinWidth;
    achieved = v;
    if (
      bounded !== null &&
      (off.end === null ||
        renderedEndingWidth(para, widths, bounded, v) >
          renderedEndingWidth(para, widths, off.end, v) + 1e-9)
    ) {
      end = bounded;
      pass = 2;
    } else {
      ({ end, pass } = off);
    }
  } else if (end === null) {
    ({ end, pass } = ladder(opts));
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
  return {
    breakpoints,
    pass,
    overfull,
    demerits: end.totalDemerits,
    endingMinWidth: achieved,
  };
}

/**
 * The width a solution's final line will RENDER at under the layout floor:
 * its natural width, plus the stretch to the lastLineMinWidth threshold
 * when that is reachable within maxEndingStretch(v) — the same arithmetic
 * as layoutLines' fil branch, so the fallback comparison judges solutions
 * by what actually appears on the page.
 */
function renderedEndingWidth(
  para: ParagraphItems,
  widths: LineWidths,
  end: Node,
  minWidth: number,
): number {
  const { items, cumW, cumY, cumTrackY, cumExpY, firstBoxAfter } = para;
  // `end` breaks at the final forced penalty; the last line runs from the
  // previous node's start (the paragraph-start node when single-line).
  const from = end.prev;
  const start = from === null ? firstBoxAfter[0]! : from.start;
  const line = from === null ? 0 : from.line;
  const b = end.item;
  let L = cumW[b]! - cumW[start]!;
  const startItem = items[start];
  if (startItem !== undefined && startItem.type === ItemType.Box) {
    L -= line === 0 ? startItem.lpFirst : startItem.lp;
  }
  L -= breakRp(items, b);
  const need = minWidth * lineWidthAt(widths, line) - L;
  if (need <= 0) return L;
  const trackY = cumTrackY[b]! - cumTrackY[start]!;
  const glueOnly = Math.max(0, cumY[b]! - cumY[start]! - trackY);
  const flexY = trackY + (cumExpY[b]! - cumExpY[start]!);
  return endingFloorRatio(need, glueOnly, flexY, maxEndingStretch(minWidth)) !== null
    ? L + need
    : L;
}

/** One pass of the escalation ladder; see breakParagraph for the sequence. */
interface AttemptMode {
  /** Badness ceiling for this pass (pretolerance, tolerance, or INF_BAD). */
  tolerance: number;
  /** Enable hyphenation break candidates. */
  hyphens: boolean;
  /** Pass-3 emergency stretch, folded into badness only (px). */
  extraStretch: number;
  /** TeX §854 artificial-demerits rescue: never let the active list die. */
  rescue: boolean;
  /** Rectangle-hunt ending semantics (see the fil branch). */
  strictEnding: boolean;
}

function attempt(
  para: ParagraphItems,
  widths: LineWidths,
  opts: BreakOptions,
  mode: AttemptMode,
): Node | null {
  const { tolerance, hyphens: allowHyphens, extraStretch, rescue, strictEnding } = mode;
  const { items, cumW, cumY, cumYfil, cumZ, cumExpY, cumExpZ, cumTrackY, firstBoxAfter } = para;
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
    let bestDeadOver = Infinity;
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
        let filReachable = true;
        let filFitness: Fitness | null = null;
        if (L >= W) {
          bad = badness(L - W, Z);
        } else if (Yfil > 0) {
          // Fil line (paragraph end). The lastLineMinWidth cost is
          // RENDER-AWARE: it prices exactly what layoutLines will do with
          // the same setting. An ending at or past the threshold is free.
          // Below it, the render floor stretches the ending's own word
          // glue to the threshold, so the cost is that stretch's badness —
          // the CONTINUOUS 100·r³ (badness()'s INF_BAD saturation once
          // flattened every short ending into one plateau: minWidth 1
          // chose the same breaks as OFF while 0.5 worked). Unreachable
          // endings (r past the render bound, which will revert to
          // natural) price strictly above every reachable one, steering
          // the breaker into arrangements that actually render at the
          // threshold.
          //
          // STRICT mode (the rectangle hunt): the ending is accepted only
          // when the render floor can actually reach the threshold or at
          // tolerance-cheap shortness — anything else fails the pass, so
          // the paragraph escalates into hyphenation for the rectangle's
          // sake (a blanket exemption once trapped the pressure inside the
          // hyphen-free pass) and, failing that, drops to the bounded
          // ladder. BOUNDED mode: the classic fil exemption (an ending
          // never rejects a break) with the cost capped at INF_BAD ≈ one
          // maximally-bad line — a preference that cannot outbid body
          // quality. Default endings (lastLineMinWidth 0, badness 0)
          // never hit any of this.
          filLine = true;
          const need = opts.lastLineMinWidth * W - L;
          if (need <= 0) {
            bad = 0;
          } else {
            // The render floor's pools: the ending's word-glue stretch
            // (CLAMPED at 0: a glue-less ending's cumY − cumTrackY
            // cancels to a float epsilon of EITHER sign, and a negative
            // pool would flip the badness negative — a free pass through
            // every tolerance; found via a real-text sweep, tracking on)
            // plus the RECRUITED flexes: the ending's own letterfit
            // tracking and wdth expansion, the invisible pools every
            // body line already uses. Saturation semantics live in
            // endingFloorRatio, shared with the layout floor, so pricing
            // and rendering agree about reachability. (Expansion enters
            // linearly here as it does in body-line pricing; the layout
            // quantizes it, so a one-step sliver of endings can price as
            // rectangles yet render natural — a preference error, never
            // a wrap hazard.)
            const trackY = cumTrackY[b]! - cumTrackY[start]!;
            const glueOnly = Math.max(0, cumY[b]! - cumY[start]! - trackY);
            const flexY = trackY + (cumExpY[b]! - cumExpY[start]!);
            const rFloor = endingFloorRatio(
              need,
              glueOnly,
              flexY,
              maxEndingStretch(opts.lastLineMinWidth),
            );
            filReachable = rFloor !== null;
            // Fitness classes by what RENDERS: a reachable ending by its
            // real floor stretch, an unreachable one (renders natural) as
            // Decent — so adjacency effects match the option-off ladder
            // and a plateau tie among hopeless endings resolves exactly
            // as OFF would (a VeryLoose class from the preference cost
            // used to skew adjDemerits and pick different, shorter
            // endings).
            filFitness =
              rFloor !== null ? fitness(false, 100 * rFloor * rFloor * rFloor) : Fitness.Decent;
            const rFil = need / (glueOnly + flexY + extraStretch); // 0 pool → Infinity: unaffordable
            bad = 100 * rFil * rFil * rFil;
            if (!strictEnding) bad = Math.min(bad, INF_BAD);
          }
        } else {
          bad = badness(W - L, Y + extraStretch);
        }
        if (bad <= tolerance || (filLine && (strictEnding ? filReachable : true))) {
          const fit = filFitness ?? fitness(L > W, bad);
          // Fil endings keep their uncapped badness through the demerits
          // too — the shared formula flattens |linePenalty + bad| ≥ 10000
          // to 10⁸, which would rebuild the same plateau one level up.
          let d = filLine
            ? demeritsUncapped(opts.linePenalty, bad, p)
            : demerits(opts.linePenalty, bad, p);
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
        // Rescue-seeding origin: least overflow past all shrink (L − W − Z)
        // wins, not cheapest history. The artificial line is free, so the
        // min-demerits node is usually the paragraph start (0 demerits) —
        // seeding from it would sweep every word since the last affordable
        // break onto the overfull line. The origin nearest the unbreakable
        // token overflows by only that token's own excess, the way a
        // browser sets an unbreakable word on a line of its own. (Ratio is
        // the wrong metric here: extra words add shrinkable glue, so a
        // longer overfull line can have the less-negative ratio.)
        const over = L - W - Z;
        if (
          bestDead === null ||
          over < bestDeadOver ||
          (over === bestDeadOver && node.totalDemerits < bestDead.totalDemerits)
        ) {
          bestDead = node;
          bestDeadOver = over;
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
        overfull: bestDeadOver > 0,
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
