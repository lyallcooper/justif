import { breakRp } from "./items.js";
import {
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
      gain += it.width * (ratio - 1);
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
    } else if (delta > 0 && Yfil > 0 && opts.lastLineFit > 0 && lines.length > 0) {
      // eTeX's \lastlinefit, applied at layout time only (the breaker's
      // cost model — and its test oracle — are untouched): the ending's
      // spaces adopt a fraction of the paragraph's average adjustment
      // ratio. The ending's letterfit stays natural, so the target and
      // its fully-justified cap use the GLUE-ONLY pool (Yg minus the
      // tracking flex folded into it).
      const glueOnly = Yg - (cumTrackY[b]! - cumTrackY[start]!);
      if (glueOnly > 0) {
        let sum = 0;
        for (const l of lines) sum += l.glueRatio;
        const target = opts.lastLineFit * (sum / lines.length);
        glueRatio = Math.max(-1, Math.min(target, delta / glueOnly));
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
    }

    // Spaces never shrink past their limit (TeX: overfull lines overflow
    // the margin rather than crushing). Rescue-pass lines land here; so
    // can sub-pixel slips from expansion quantization.
    if (glueRatio < -1) glueRatio = -1;

    // Tracking saturates at its budget: beyond ratio 1 the letterfit stops
    // opening (±3% is a hard cap, not a hint) and the SPACES stretch on
    // alone. Re-derive the glue-only ratio so the line still fills: the
    // residual R satisfied R = (Yg − Yt)·s + Yt·min(s, 1); when the pooled
    // s exceeds 1, solve the saturated form for the spaces' s.
    // Fil lines keep natural letterfit whatever their glue does (both the
    // default natural ending and a lastLineFit-colored one).
    let trackRatio = Yfil > 0 ? 0 : glueRatio;
    const Yt = cumTrackY[b]! - cumTrackY[start]!;
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
