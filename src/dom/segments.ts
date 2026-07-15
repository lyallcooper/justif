/**
 * Pure functions bridging a paragraph scan and the core's Line output to
 * the DOM writer's segment model (write.ts does the actual DOM emission).
 * No lifecycle, no state — index.ts stays plumbing.
 */
import {
  composeProtrusion,
  type HangingPunctuationMode,
  latinProtrusion,
} from "../core/protrusion.js";
import { fontProtrusion } from "../core/protrusion-fonts.js";
import {
  type ExpansionOptions,
  ItemType,
  type Line,
  type Measure,
  type ParagraphItems,
  type ProtrusionTable,
  type RunMetrics,
  type RunText,
} from "../core/types.js";
import { calibrateStretch, NO_EXPANSION } from "./calibrate.js";
import { type FontSpec, isMonospace, measureInkBearings, measureWidth } from "./measure.js";
import type { ParagraphScan } from "./read.js";
import { type RenderSegment, WRAP_SAFETY_PAD_PX } from "./write.js";

/**
 * Rendered advance of the inter-word space in a run containing `runText`.
 * When the author's font stack lacks a script's glyphs the engine renders
 * words in a FALLBACK font — and in Blink/WebKit the spaces BETWEEN those
 * words take the fallback font's advance too, not the first stack font's,
 * so `measureText(" ")` (which sees only the stack font) overstates every
 * gap by a fraction of a pixel. Canvas agrees with the DOM when the space
 * is measured in script context, so RTL runs probe "X X" − 2·"X" with a
 * letter of their own script (space-adjacent fallback is exactly how their
 * fixture words render). LTR paragraphs cannot reach this path with RTL
 * text (they bail), and keep the one-glyph measurement unchanged.
 */
function spaceWidthIn(spec: FontSpec, runText: string): number {
  if (spec.direction === "rtl") {
    const probe = /\p{Script=Arabic}/u.test(runText)
      ? "ل" // Arabic lam
      : /\p{Script=Hebrew}/u.test(runText)
        ? "א" // Hebrew alef
        : null;
    if (probe !== null) {
      return measureWidth(`${probe} ${probe}`, spec) - 2 * measureWidth(probe, spec);
    }
  }
  return measureWidth(" ", spec);
}

/** Core Measure implementation backed by the canvas cache. */
export function measureFor(specByKey: Map<string, FontSpec>): Measure {
  return {
    width: (text, run) => measureWidth(text, specByKey.get(run.fontKey)!),
    charAdvance: (ch, run) => measureWidth(ch, specByKey.get(run.fontKey)!),
    inkBearings: (ch, run) => measureInkBearings(ch, specByKey.get(run.fontKey)!),
  };
}

/** The core's RunText input, aligned index-for-index with scan.runs. */
export function runTexts(scan: ParagraphScan): RunText[] {
  return scan.runs.map((r, i) => ({ text: r.text, run: i }));
}

export function buildRunMetrics(
  scan: ParagraphScan,
  expansion: ExpansionOptions | false,
  spacing: { stretch: number; shrink: number; pull?: number },
  protrusion?: {
    enabled: boolean;
    user: ProtrusionTable | null;
    hang: HangingPunctuationMode;
  },
): RunMetrics[] {
  // Base-space context is the whole paragraph: the base font's spaces sit
  // between whatever script the paragraph is written in.
  const paragraphText = scan.runs.map((r) => r.text).join(" ");
  const baseSpaceWidth = spaceWidthIn(scan.specs[scan.baseSpec]!, paragraphText);
  const pull = spacing.pull ?? 0.7;
  // Every quantized stretch value the layout can emit gets its own
  // measurement (linear interpolation between the endpoints errs by
  // whole pixels per line for some variable fonts).
  const samplePcts: number[] = [];
  if (expansion !== false && expansion.step > 0) {
    const stepPct = 100 * expansion.step;
    for (let q = stepPct; q <= 100 * expansion.max + 1e-9; q += stepPct) {
      samplePcts.push(Math.round((100 + q) * 1000) / 1000);
    }
    for (let q = stepPct; q <= 100 * expansion.shrink + 1e-9; q += stepPct) {
      samplePcts.push(Math.round((100 - q) * 1000) / 1000);
    }
  }
  return scan.runs.map((run) => {
    const spec = scan.specs[run.spec]!;
    // Hand-tuned microtype config for this run's font, when one exists.
    // Precedence: generic table < per-font config < hang overlays (side-
    // and position-scoped) < user overrides.
    let perFont: ProtrusionTable | undefined;
    let perFontFirst: ProtrusionTable | undefined;
    if (protrusion !== undefined && protrusion.enabled) {
      const matched = fontProtrusion(spec.family);
      if (matched !== undefined) {
        const composed = composeProtrusion(
          { ...latinProtrusion, ...matched },
          protrusion.user,
          protrusion.hang,
        );
        perFont = composed.rest;
        if (composed.first !== composed.rest) perFontFirst = composed.first;
      }
    }
    const naturalSpace = spaceWidthIn(spec, run.text);
    // Oversized secondary-font spaces (monospace inline code — a full cell
    // wide) get downward pressure toward the paragraph's base space: the
    // line's rhythm is set by the base font, and a raw cell-space reads as
    // a hole in it. `pull` dials the pressure: 0 = each font's natural,
    // 1 = full convergence to the base (risks dissolving word boundaries in
    // loose-fitting fonts). Flexibility is likewise capped at the base
    // (TeX's typewriter fonts declare rigid spaces for the same reason).
    // An all-monospace paragraph is unaffected — its base space IS the
    // cell. The renderer emits the width difference as negative
    // word-spacing, so measurement and rendering agree.
    const spaceWidth =
      naturalSpace > baseSpaceWidth
        ? naturalSpace + (baseSpaceWidth - naturalSpace) * pull
        : naturalSpace;
    // The flex basis follows the same dial: pull 0 = each font's own flex
    // (TeX semantics), pull 1 = base-font flex.
    const flexWidth =
      naturalSpace + (Math.min(naturalSpace, baseSpaceWidth) - naturalSpace) * pull;
    const calibration =
      expansion === false
        ? NO_EXPANSION
        : calibrateStretch(
            spec,
            100 + 100 * expansion.max,
            100 - 100 * expansion.shrink,
            samplePcts,
            run.text,
          );
    return {
      fontKey: spec.key,
      space: {
        width: spaceWidth,
        stretch: flexWidth * spacing.stretch,
        shrink: flexWidth * spacing.shrink,
      },
      hyphenWidth: measureWidth("-", spec),
      ratioAtMax: calibration.ratioAtMax,
      ratioAtMin: calibration.ratioAtMin,
      expansionRatios: calibration.ratios,
      // RTL paragraphs never hyphenate: Arabic cursive joining makes the
      // prefix-incremental fragment measurement in buildItems invalid
      // (splitting changes the glyphs on both sides of the cut), and
      // Hebrew convention breaks without hyphens if at all. noHyphens
      // also strips soft hyphens and keeps the hyphenate callback from
      // ever being called for these runs.
      noHyphens: spec.hyphens === "none" || scan.direction === "rtl",
      // Monospace cells carry huge side bearings; advance-relative protrusion
      // codes would hang the ink visibly past the margin — but only when the
      // mono run sits INSIDE another font's prose (inline code), where the
      // hang reads as overflow against the base font's margin rhythm. A
      // paragraph set in a mono font owns its margin: it protrudes like any
      // other font (full cell hangs under hangingPunctuation — the
      // typewriter-tradition grid behavior).
      protrudeInkOnly: isMonospace(spec) && spec.key !== scan.specs[scan.baseSpec]!.key,
      protrusion: perFont,
      protrusionFirst: perFontFirst,
    };
  });
}

export function buildRenderSegments(
  scan: ParagraphScan,
  runsMetrics: readonly RunMetrics[],
  para: ParagraphItems,
  lines: readonly Line[],
): RenderSegment[] {
  const segments: RenderSegment[] = [];

  // Joint preceding the NEXT line, decided by each line's breakpoint.
  let pendingJoint: RenderSegment["joint"] = "none";

  for (const line of lines) {
    // Absolute word-spacing per run on this line: the author's own
    // word-spacing, the offset from the space glyph's advance to the glue
    // width the engine assigned (nonzero for pressured oversized spaces),
    // plus this line's glue adjustment.
    const desired = (runIndex: number): number => {
      const metrics = runsMetrics[runIndex]!;
      const spec = scan.specs[scan.runs[runIndex]!.spec]!;
      // The rendered space advance (script-contextual — see spaceWidthIn)
      // is what CSS word-spacing adds to; the offset closes the gap from
      // that advance to the glue width the engine assigned.
      const widthOffset = metrics.space.width - spaceWidthIn(spec, scan.runs[runIndex]!.text);
      const flex = line.glueRatio >= 0 ? metrics.space.stretch : metrics.space.shrink;
      return spec.wordSpacingPx + widthOffset + line.glueRatio * flex;
    };

    let joint = pendingJoint;
    let first = true;
    let text = "";
    let run = -1;
    let trackY = 0;
    let trackZ = 0;
    let boxChars = 0;
    const flush = (): void => {
      if (run < 0 || text.length === 0) return;
      // Letterfit tracking: this segment's boxes budgeted glueRatio × track
      // flex px of letterfit change; spread it as uniform letter-spacing
      // over the box characters. Spaces receive the same increment by CSS,
      // so the word-spacing below subtracts it — gaps stay exactly the
      // width the glue algebra assigned.
      const trackFlex = line.trackRatio >= 0 ? trackY : trackZ;
      const ls = boxChars > 0 && trackFlex > 0 ? (line.trackRatio * trackFlex) / boxChars : 0;
      // Edge spaces are excluded from the corrective width measurement
      // (they collapse when a retreated segment sits at a line start, making
      // rect widths position-dependent); their widths are modeled exactly:
      // stretched space advance plus this segment's word-spacing.
      const lead = text.length - text.trimStart().length;
      // Compute trail on the post-lead remainder: a whitespace-only
      // segment (bare space between two inline elements of different
      // runs) must not count its single character as BOTH lead and trail
      // — modelPx would double and the corrective measurement would run
      // an inverted Range.
      const trail = lead < text.length ? text.length - text.trimEnd().length : 0;
      const spec = scan.specs[scan.runs[run]!.spec]!;
      const table = runsMetrics[run]!.expansionRatios;
      const key = Math.round(line.fontStretch * 1000) / 1000;
      const ratio = table?.get(key) ?? 1;
      const wordSpacing = desired(run);
      const spacePx = spaceWidthIn(spec, scan.runs[run]!.text) * ratio + wordSpacing;
      segments.push({
        text,
        ancestors: scan.runs[run]!.ancestors,
        wordSpacingPx: wordSpacing - ls,
        letterSpacingPx: ls !== 0 ? spec.letterSpacingPx + ls : null,
        forceLigatures: ls !== 0 && spec.letterSpacingPx === 0,
        fontStretchPct: line.fontStretch,
        marginStartPx: first ? -line.leftHang : 0,
        marginEndPx: 0, // the line's last segment is patched after the loop
        edgeTrim: { lead, trail, modelPx: (lead + trail) * spacePx },
        joint,
      });
      joint = "none";
      first = false;
      text = "";
      run = -1;
      trackY = 0;
      trackZ = 0;
      boxChars = 0;
    };

    for (let i = line.start; i < line.end; i++) {
      const it = para.items[i]!;
      if (it.type === ItemType.Box) {
        if (run !== -1 && run !== it.run) {
          // Glue-less run boundary. Dash-class characters allow a line
          // break here (UAX14 B2/HY) — e.g. code directly followed by an
          // em dash — so those junctions get a U+2060 WORD JOINER, which
          // forbids the break outright. Zero width and invisible; only
          // inserted at dash junctions since find-in-page cannot match
          // through it.
          const junction = text.slice(-1) + (it.text[0] ?? "");
          const risky = /[\u002D\u2010-\u2015]/.test(junction);
          flush();
          text = risky ? "\u2060" : "";
        }
        run = it.run;
        text += it.text;
        trackY += it.trackStretch;
        trackZ += it.trackShrink;
        boxChars += Array.from(it.text).length;
      } else if (it.type === ItemType.Glue) {
        // Mid-line spaces stay INSIDE a nowrap segment, in the segment of
        // THEIR OWN run (a prose space after a link must not render inside
        // the link). A space at a segment edge becomes U+00A0: NBSP is
        // line-break class GL — unbreakable by specification — so run
        // boundaries can never become stray wrap points, whatever the
        // engine's edge-space heuristics. Same glyph advance, and
        // word-spacing applies to it identically.
        if (run === -1 || run === it.run) {
          run = it.run;
          text += " ";
        } else {
          // Leading NBSP in the NEXT run's segment: outside the previous
          // element (no underline extension), unbreakable on both sides.
          flush();
          run = it.run;
          text = "\u00A0";
        }
      }
      // Penalties not broken at render nothing.
    }
    flush();
    const last = segments[segments.length - 1];
    // Provisional margin; the measured correction pass finalizes it so the
    // line's layout width always fits the measure with 1px spare. The pad
    // keeps the line from re-wrapping before its (possibly deferred/
    // parked) correction lands.
    if (last !== undefined) {
      last.marginEndPx = -(line.rightHang + line.overflowPx + WRAP_SAFETY_PAD_PX);
    }

    // Decide the joint that separates this line from the next.
    const brk = para.items[line.end];
    if (line.hyphenated) pendingJoint = "hyphen";
    else if (brk !== undefined && brk.type === ItemType.Glue) pendingJoint = "space";
    else if (
      brk !== undefined &&
      brk.type === ItemType.Penalty &&
      brk.width === 0 &&
      !brk.flagged
    ) {
      // Unflagged zero-width penalties sit BEFORE a glue (lastLineMinWords
      // inserts them): the break consumes that space, which must still
      // appear in the DOM text — a <wbr> here would silently delete it
      // from copies and find-in-page. Explicit-hyphen breaks are flagged
      // and keep the <wbr>.
      pendingJoint = "space";
    } else pendingJoint = "wbr"; // zero-width flagged penalty (explicit hyphen)
  }

  return segments;
}
