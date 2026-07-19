import { maxEndingStretch } from "./badness.js";
import { breakRp, endingFloorRatio } from "./items.js";
import {
  type Box,
  type BreakResult,
  type BuildOptions,
  ItemType,
  type Line,
  type LineWidths,
  lineWidthAt,
  type ParagraphItems,
} from "./types.js";

/**
 * Font-stretch percent delta absorbing a line's shortfall (or excess).
 * `need` is the absolute px to absorb, `glueFlex`/`expFlex` the available
 * glue and expansion flexibility in that direction, `limit` the expansion
 * endpoint as a fraction (e.g. 0.02) and `step` the quantization increment
 * (0 = continuous). The result is clamped to the calibrated endpoint —
 * quantization must never spend more expansion than the breaker budgeted
 * or calibration measured.
 */
function solveExpansion(
  need: number,
  glueFlex: number,
  expFlex: number,
  limit: number,
  step: number,
): number {
  const frac = Math.min(need / (glueFlex + expFlex), 1);
  const limitPct = 100 * limit;
  const stepPct = 100 * step;
  const quantized =
    stepPct > 0 ? Math.round((frac * limitPct) / stepPct) * stepPct : frac * limitPct;
  return Math.min(quantized, limitPct);
}

/**
 * Signed width change of items[start..end) at the given font-stretch
 * percent: measured per-run ratios when calibration sampled them, linear
 * endpoint interpolation otherwise (identical to the breaker's budget).
 */
function expansionGainAt(
  para: ParagraphItems,
  start: number,
  end: number,
  stretchPct: number,
  limitPct: number,
): number {
  const key = Math.round(stretchPct * 1000) / 1000;
  const deltaPct = stretchPct - 100;
  let gain = 0;
  for (let i = start; i < end; i++) {
    const it = para.items[i]!;
    if (it.type !== ItemType.Box) continue;
    const ratio = para.runs[it.run]?.expansionRatios?.get(key);
    if (ratio !== undefined) {
      // Inline box decorations folded into the width don't respond to
      // font-stretch; only the glyph run scales.
      gain += (it.width - (it.padPx ?? 0)) * (ratio - 1);
    } else if (deltaPct >= 0) {
      gain += it.expStretch * (deltaPct / limitPct);
    } else {
      gain += -it.expShrink * (-deltaPct / limitPct);
    }
  }
  return gain;
}

/**
 * Converts chosen breakpoints into per-line render parameters, distributing
 * each line's shortfall/excess between font expansion (quantized to the
 * configured step so the emitted font-stretch values stay cacheable) and
 * inter-word glue. The same ratio drives both because expansion participated
 * in the breaker's stretch/shrink totals.
 */
export function layoutLines(
  para: ParagraphItems,
  breaks: BreakResult,
  widths: LineWidths,
  opts: BuildOptions,
): Line[] {
  const { items, cumW, cumY, cumYfil, cumZ, cumExpY, cumExpZ, cumTrackY, firstBoxAfter } = para;
  // A paragraph with no boxes (empty or whitespace-only input) has no lines.
  if (firstBoxAfter[0] === items.length) return [];

  const lines: Line[] = [];
  const exp = opts.expansion;

  for (let i = 0; i < breaks.breakpoints.length; i++) {
    const b = breaks.breakpoints[i]!;
    const prev = i === 0 ? -1 : breaks.breakpoints[i - 1]!;
    const start = prev < 0 ? firstBoxAfter[0]! : firstBoxAfter[prev + 1]!;
    const it = items[b]!;
    const isPenalty = it.type === ItemType.Penalty;

    // Trim trailing penalties and the parfillskip glue so items[start..end)
    // is exactly the visible line content (matters only for the last line).
    let end = b;
    while (end > start) {
      const tail = items[end - 1]!;
      if (tail.type === ItemType.Penalty) end--;
      else if (tail.type === ItemType.Glue && tail.stretchFil > 0) end--;
      else break;
    }

    let leftHang = 0;
    const startItem = items[start];
    if (startItem !== undefined && startItem.type === ItemType.Box) {
      leftHang = i === 0 ? startItem.lpFirst : startItem.lp;
    }

    const rightHang = breakRp(items, b);
    const penWidth = isPenalty ? it.width : 0;

    const L = cumW[b]! - cumW[start]! + penWidth - leftHang - rightHang;
    const W = lineWidthAt(widths, i);
    const Yg = cumY[b]! - cumY[start]!;
    const Yfil = cumYfil[b]! - cumYfil[start]!;
    const Zg = cumZ[b]! - cumZ[start]!;
    const Ye = cumExpY[b]! - cumExpY[start]!;
    const Ze = cumExpZ[b]! - cumExpZ[start]!;
    const Yt = cumTrackY[b]! - cumTrackY[start]!;

    // Yg/Zg are the CONTINUOUS-flex pools: glue plus letterfit tracking
    // (folded together in withSums); Ye/Ze is quantized expansion.
    const delta = W - L;
    let ratio: number;
    if (delta > 0) ratio = Yfil > 0 ? 0 : Yg + Ye > 0 ? delta / (Yg + Ye) : Infinity;
    else if (delta < 0) ratio = Zg + Ze > 0 ? delta / (Zg + Ze) : -Infinity;
    else ratio = 0;

    let fontStretch = 100;
    let glueRatio = 0;
    let overflowPx = 0;
    let overfull = breaks.overfull[i] ?? false;
    /** Emergency letterfit for one otherwise-overfull painted token when
     * protrusion is disabled. Normal tracking remains capped at −1; this
     * exceptional ratio absorbs only the residual needed to keep the fixed
     * decoration inside the measure. */
    let paintedTokenTrackRatio: number | null = null;
    /** Ending letterfit recruited by the lastLineMinWidth floor; null =
     * the default fil behavior (natural on the stretch side). */
    let filTrack: number | null = null;

    // Glue ratio for the px the glue pool must absorb (positive = stretch,
    // negative = shrink; expansion quantization can flip the residual's
    // sign, so both directions stay reachable from either branch).
    const glueRatioFor = (need: number): number =>
      need >= 0 ? (Yg > 0 ? need / Yg : 0) : Zg > 0 ? need / Zg : 0;

    if (delta > 0 && Yfil === 0) {
      if (exp !== false && Ye > 0) {
        fontStretch = 100 + solveExpansion(delta, Yg, Ye, exp.max, exp.step);
        const gain = expansionGainAt(para, start, end, fontStretch, 100 * exp.max);
        glueRatio = glueRatioFor(delta - gain);
      } else {
        glueRatio = glueRatioFor(delta);
      }
    } else if (delta > 0 && Yfil > 0) {
      // Paragraph ending. Two layout-time targets compose — the larger
      // wins; the breaker's cost model (and its test oracle) mirror the
      // floor's arithmetic:
      //   • eTeX's \lastlinefit: the ending's spaces adopt a fraction of
      //     the paragraph's average adjustment ratio.
      //   • the lastLineMinWidth floor: an ending the breaker could not
      //     lengthen to the threshold widens the rest of the way using
      //     its own pools — word glue up to maxEndingStretch(v) (the
      //     v-scaled underfull bound: gentle floors barely open the
      //     spaces, rectangles work them to ~2× natural) plus the
      //     RECRUITED flexes, letterfit tracking and wdth expansion,
      //     saturating at their budgets exactly like a body line's. But
      //     ALL OR NOTHING: an ending past the combined reach reverts to
      //     natural entirely — a line both stretched and still short
      //     reads worse than a clean ragged ending. At minWidth 1 the
      //     floor is the measure: paragraphs set as rectangles.
      // Without the floor the ending's letterfit stays natural, so the
      // fit target and the fully-justified cap use the GLUE-ONLY pool
      // (Yg minus the tracking flex folded into it).
      const glueOnly = Yg - Yt;
      let fitTarget = 0;
      if (opts.lastLineFit > 0 && lines.length > 0) {
        let sum = 0;
        for (const l of lines) sum += l.glueRatio;
        fitTarget = opts.lastLineFit * (sum / lines.length);
      }
      let floored = false;
      // The floor's threshold is the one the BREAKER's solution was found
      // under — a descended hunt stretches its ending to what it actually
      // reached, not to the requested value it provably could not.
      const minWidth = breaks.endingMinWidth ?? opts.lastLineMinWidth;
      if (minWidth > 0) {
        const need = minWidth * W - L;
        const maxR = maxEndingStretch(minWidth);
        if (need > 0) {
          const rFloor = endingFloorRatio(need, Math.max(0, glueOnly), Yt + Ye, maxR);
          if (rFloor !== null) {
            const flexCap = Math.min(maxR, 1);
            // Expansion first, quantized DOWN so the ending can never
            // overshoot the threshold (at minWidth 1 the threshold IS
            // the measure); the glue absorbs the quantization residual.
            let gain = 0;
            if (exp !== false && Ye > 0) {
              const stepPct = exp.step * 100;
              let pct =
                Math.floor((Math.min(rFloor, flexCap) * exp.max * 100) / stepPct) * stepPct;
              while (pct > 0) {
                gain = expansionGainAt(para, start, end, 100 + pct, 100 * exp.max);
                if (gain <= need) break;
                pct -= stepPct;
                gain = 0;
              }
              if (pct > 0) fontStretch = 100 + pct;
            }
            // Residual over glue + tracking, tracking saturating at its
            // budget like a body line's.
            const residual = need - gain;
            let rGlue = residual / (glueOnly + Yt);
            const rTrack = Math.min(Math.max(rGlue, 0), flexCap);
            if (rGlue > flexCap && glueOnly > 0) {
              rGlue = (residual - Yt * flexCap) / glueOnly;
            }
            // Down-quantized expansion can push more onto the glue than
            // the pooled solve promised — all or nothing still holds.
            if (rGlue <= maxR + 1e-9) {
              glueRatio =
                glueOnly > 0
                  ? Math.min(
                      Math.max(rGlue, fitTarget),
                      (delta - gain - rTrack * Yt) / glueOnly,
                    )
                  : 0;
              filTrack = rTrack;
              floored = true;
            } else {
              fontStretch = 100;
            }
          }
        } else if (fitTarget < 0) {
          // The floor also binds a fit-shrunk ending: negative ratios
          // render against the SHRINK pool, so the bound converts there.
          const Zfil = cumZ[b]! - cumZ[start]!;
          if (Zfil > 0) fitTarget = Math.max(fitTarget, need / Zfil);
        }
      }
      if (!floored && glueOnly > 0) {
        glueRatio = Math.max(-1, Math.min(fitTarget, delta / glueOnly));
      }
    } else if (delta < 0) {
      let need = delta;
      if (exp !== false && Ze > 0) {
        fontStretch = 100 - solveExpansion(-delta, Zg, Ze, exp.shrink, exp.step);
        const gain = expansionGainAt(para, start, end, fontStretch, 100 * exp.shrink);
        need = delta - gain;
      }
      glueRatio = glueRatioFor(need);
      // Px the line exceeds W beyond every shrink resource. Equivalent to
      // (|glueRatio| − 1)·Zg at the clamp, but stays correct when the line
      // has NO shrinkable glue at all (Zg = 0), where the ratio form
      // reported 0 and starved the renderer's wrap guard.
      overflowPx = Math.max(0, -need - Zg);
      if (overflowPx > 1e-6) overfull = true;

      // A token whose GLYPHS fit after ordinary tracking can still become
      // overfull solely because its painted padding is fixed layout width.
      // With protrusion disabled there is nowhere legitimate for that halo
      // to hang. For the tightly-scoped, unambiguous case of ONE painted
      // ending box, close only its letterfit by the exact residual. This is
      // preferable to either violating the no-protrusion contract or
      // inventing a break inside code. Multi-box lines and tracking:false
      // retain ordinary TeX overfull behavior.
      if (
        overflowPx > 1e-6 &&
        opts.protrusion === false &&
        opts.tracking !== false
      ) {
        let soleBox: Box | null = null;
        for (let j = start; j < end; j++) {
          const candidate = items[j]!;
          if (candidate.type !== ItemType.Box) continue;
          if (soleBox !== null) {
            soleBox = null;
            break;
          }
          soleBox = candidate;
        }
        if (
          soleBox?.paintedEnd === true &&
          soleBox.trackShrink > 0 &&
          // Never reverse/collapse a pathological token just to honor a
          // huge author inset: emergency letterfit may at most double the
          // configured shrink budget (−6% under the public default).
          overflowPx <= soleBox.trackShrink + 1e-9
        ) {
          paintedTokenTrackRatio = -1 - overflowPx / soleBox.trackShrink;
          overflowPx = 0;
          overfull = false;
        }
      }
    }

    // Spaces never shrink past their limit (TeX: overfull lines overflow
    // the margin rather than crushing). Rescue-pass lines land here; so
    // can sub-pixel slips from expansion quantization.
    if (glueRatio < -1) glueRatio = -1;

    // Tracking normally saturates at its budget: beyond ratio 1 the
    // letterfit stops opening and the SPACES stretch on alone. The one
    // negative-side exception was computed above for an overfull single
    // painted token with protrusion disabled. Re-derive the glue-only ratio
    // for ordinary stretch saturation so the line still fills: the
    // residual R satisfied R = (Yg − Yt)·s + Yt·min(s, 1); when the pooled
    // s exceeds 1, solve the saturated form for the spaces' s.
    // Fil lines keep natural letterfit on the STRETCH side (both the
    // default natural ending and a lastLineFit-colored one) — but an
    // over-long ending's shrink was priced by the breaker and the shrink
    // branch above against the POOLED Zg, tracking included, so the
    // letterfit share must render or the ending sets wider than modeled
    // and overflows the measure.
    let trackRatio =
      paintedTokenTrackRatio ??
      (Yfil > 0 ? (filTrack ?? Math.min(glueRatio, 0)) : glueRatio);
    if (Yfil === 0 && glueRatio > 1 && Yt > 0) {
      trackRatio = 1;
      const glueOnly = Yg - Yt;
      glueRatio = glueOnly > 0 ? (glueRatio * Yg - Yt) / glueOnly : 1;
    }

    lines.push({
      start,
      end,
      hyphenated: isPenalty && it.width > 0,
      ratio,
      fontStretch,
      glueRatio,
      trackRatio,
      leftHang,
      rightHang,
      overfull,
      overflowPx,
      width: W,
    });
  }

  return lines;
}

/**
 * Plain-text content of a line (CLI demos, tests, clipboard fixups). Breaks
 * taken at hyphenation points append U+2010 (not ASCII "-") so consumers can
 * distinguish inserted hyphens from hyphens present in the source text.
 */
export function lineText(para: ParagraphItems, line: Line): string {
  let out = "";
  for (let i = line.start; i < line.end; i++) {
    const it = para.items[i]!;
    if (it.type === ItemType.Box) out += it.text;
    // CJK inter-character glue has no source space — emit nothing for it.
    else if (it.type === ItemType.Glue && it.cjk !== true) out += " ";
  }
  if (line.hyphenated) out += "‐";
  return out;
}
