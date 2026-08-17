/**
 * Turning the core's chosen Lines into the segment model the DOM writer
 * emits.
 *
 * This is where an abstract line — a range of items with a glue ratio and a
 * stretch — becomes concrete runs of text with the word-spacing,
 * letter-spacing and font-stretch that will make it set to exactly its
 * measure. It also decides everything about a line's EDGES: which characters
 * hang past them and how far, what the break between two lines is made of,
 * how a hyphen is carried, and what the trailing margin has to be so the
 * engine's own wrap breaks where the model chose.
 *
 * Pure and stateless. It reads the same width helpers the run metrics were
 * priced with, deliberately: a space measured one way for pricing and another
 * for rendering is the drift the wrap guarantee then has to correct.
 */
import { CJK_CHAR } from "../core/cjk.js";
import { breakEndBox } from "../core/items.js";
import {
  type Box,
  ItemType,
  type Line,
  type ParagraphItems,
  type RunMetrics,
} from "../core/types.js";
import { type FontSpec, measureWidth, transformedText } from "./measure.js";
import type { ParagraphScan } from "./read.js";
import { separatorWidthIn, spaceWidthIn } from "./run-metrics.js";
import {
  endWithoutCollapsibleSpaces,
  leadingCollapsibleSpaces,
  trailingCollapsibleSpaces,
} from "./whitespace.js";
import {
  hangCarrierShed,
  type RenderSegment,
  terminalSplit,
  WRAP_SAFETY_PAD_PX,
} from "./write.js";

const AUTHOR_NO_BREAK_SPACE = /[\u00A0\u202F]/;
const DASH_JUNCTION = /[\u002D\u2010-\u2015]/;

// Both tags are literals, so these patterns are constant. They are consulted
// twice per rendered segment, on every patch and every resize step, which is
// often enough that rebuilding the RegExp per call showed up in a profile.
const LIGA_EXPLICITLY_OFF = /["']liga["']\s*(?:0|off)\b/i;
const CLIG_EXPLICITLY_OFF = /["']clig["']\s*(?:0|off)\b/i;

/** Browsers commonly suppress common ligatures when letter-spacing is
 * nonzero. Tracking introduces letter-spacing, so explicitly retain those
 * defaults without overriding an author's own ligature choices or losing
 * their other low-level feature settings. */
function trackingFeatureSettings(spec: FontSpec, active: boolean): string | undefined {
  if (!active || spec.letterSpacingPx !== 0) return undefined;
  if (spec.ligatures === "none" || /\bno-common-ligatures\b/.test(spec.ligatures)) {
    return undefined;
  }

  const settings = spec.featureSettings === "normal" ? [] : [spec.featureSettings];
  if (!LIGA_EXPLICITLY_OFF.test(spec.featureSettings)) settings.push('"liga" 1');
  if (!CLIG_EXPLICITLY_OFF.test(spec.featureSettings)) settings.push('"clig" 1');
  return settings.length > 0 ? settings.join(", ") : undefined;
}

/**
 * What is safe to remove from a closing box's measured advance. The engine
 * clamps that box's own span at zero width, so a shed larger than its true
 * advance simply does not happen — and the model would then be describing a
 * narrower line than the DOM rendered. Canvas and DOM disagree about a
 * single cluster by a fraction of its width (a 20px Georgia period has been
 * seen 0.28px apart), so keep a proportional reserve and let the line's word
 * spaces, which are exact, pay for whatever that leaves unshed.
 */
function shedCapacity(advance: number): number {
  return Math.max(0, advance - Math.max(0.5, advance * 0.1));
}

/**
 * Advance of the segment's terminal cluster: its own glyph advance plus the
 * letter-spacing that follows it, which is what a shed there can remove.
 */
function terminalClusterAdvance(
  segment: RenderSegment,
  endBox: Box | undefined,
  scan: ParagraphScan,
): number {
  if (endBox === undefined) return 0;
  const { terminal } = terminalSplit(segment.text);
  if (terminal === undefined || terminal === " ") return 0;
  const spec = scan.specs[scan.runs[endBox.run]!.spec]!;
  return Math.max(
    0,
    measureWidth(terminal, spec) *
      // A condensed line renders narrower than the spec measures.
      Math.min(1, segment.fontStretchPct / 100) +
      segment.resolvedLetterSpacingPx,
  );
}

/** Below this the kern would move the carrier by less than the engine can
 * paint, so the writer leaves it undeclared and an unkerned pair — the common
 * case — renders exactly as it did before. */
const KERN_EPSILON = 0.01;

/**
 * The kern between a shedding segment's terminal cluster and the cluster
 * before it: what the writer has to restore as layout once that cluster is
 * shaped in a run of its own (see RenderSegment.terminalKernPx). Undefined
 * when there is no pair to kern, or the font does not kern this one.
 */
function terminalPairKern(
  segment: RenderSegment,
  endBox: Box | undefined,
  scan: ParagraphScan,
): number | undefined {
  if (endBox === undefined) return undefined;
  // A CJK segment renders with `font-kerning: none` (see RenderSegment.cjk):
  // canvas and DOM disagree about kana pairs, so the model assumes solid
  // setting and the renderer matches it. There is no pair adjustment in the
  // DOM to restore, and canvas would happily measure one.
  if (segment.cjk === true) return undefined;
  const spec = scan.specs[scan.runs[endBox.run]!.spec]!;
  // A transformed run is measured from SOURCE text, with the probe carrying
  // the property. That is exact for a whole segment, but the pair alone can
  // render as different glyphs than it does in place (`capitalize` is
  // context-sensitive), and a kern measured for the wrong pair would move the
  // carrier by the wrong amount. Leave those runs as they were.
  if (spec.textTransform !== "none") return undefined;
  const { prev, terminal } = terminalSplit(segment.text);
  if (prev === undefined || terminal === undefined) return undefined;
  // Letter- and word-spacing enter each measurement once per cluster, so they
  // cancel and what remains is the pair adjustment alone. Measured at the
  // spec's own width: an expanded line's kern differs by hundredths of a
  // pixel, which the corrective pass absorbs like any other model drift.
  const kern =
    measureWidth(prev + terminal, spec) -
    measureWidth(prev, spec) -
    measureWidth(terminal, spec);
  return Math.abs(kern) > KERN_EPSILON ? kern : undefined;
}

/** Tighten a line without collapsing protected word spaces. */
function tightenLine(
  segments: readonly RenderSegment[],
  first: number,
  px: number,
): void {
  if (px <= 0.001) return;
  const countAt = (index: number): number =>
    Math.max(
      0,
      segments[index]!.adjustableSpaceCount -
        (index === first ? segments[index]!.edgeTrim.lead : 0),
    );
  let remaining = px;
  const spaces = segments
    .slice(first)
    .reduce((sum, _segment, offset) => sum + countAt(first + offset), 0);
  const delta = spaces > 0 ? remaining / spaces : 0;
  for (let i = first; i < segments.length; i++) {
    const segment = segments[i]!;
    const count = countAt(i);
    if (count === 0) continue;
    const next = Math.max(segment.minimumWordSpacingPx, segment.wordSpacingPx - delta);
    remaining -= (segment.wordSpacingPx - next) * count;
    segment.wordSpacingPx = next;
  }

  if (remaining <= 0.001) return;
  const charCounts = segments.slice(first).map((segment) =>
    segment.allowLetterCorrection
      ? Array.from(segment.text).filter((char) => char.trim()).length
      : 0,
  );
  const chars = charCounts.reduce((sum, count) => sum + count, 0);
  if (chars === 0) return;
  const tracking = remaining / chars;
  for (let i = first; i < segments.length; i++) {
    const segment = segments[i]!;
    if (charCounts[i - first] === 0) continue;
    segment.resolvedLetterSpacingPx -= tracking;
    segment.letterSpacingPx = segment.resolvedLetterSpacingPx;
    if (countAt(i) > 0) {
      segment.wordSpacingPx += tracking;
      segment.minimumWordSpacingPx += tracking;
    }
  }
}

export function buildRenderSegments(
  scan: ParagraphScan,
  runsMetrics: readonly RunMetrics[],
  para: ParagraphItems,
  lines: readonly Line[],
  lineOffset = 0,
): RenderSegment[] {
  const segments: RenderSegment[] = [];

  // Joint preceding the NEXT line, decided by each line's breakpoint.
  let pendingJoint: RenderSegment["joint"] = "none";
  /** Whether the line that joint closes was set beside the float. */
  let pendingJointBesideFloat = false;
  /** Whether that joint stands for no source character at all (a break at an
   * atomic object's junction — see RenderSegment.jointVoid). */
  let pendingJointVoid = false;

  // Inline padding/border (StyledRun.padStartPx/padEndPx) is layout width
  // the corrective measurement can't see in the text rects — it renders on
  // the clone around the run's first/last content. Attribute it to the
  // run's first/last SEGMENT: those share a line with the decorated clone
  // edge by construction (a break next to the element puts the joint
  // outside the clone), and corrections only need per-line totals.
  const decorStartSeen = new Set<number>();
  const lastSegForRun = new Map<number, number>();
  let floatStyleEmitted = false;

  // How much wider a synthetic run-boundary NBSP renders than the ordinary
  // space the model prices it as (see the glue branches below). Nearly every
  // font gives the two characters one advance, but macOS Charter maps U+00A0
  // to its own glyph at exactly twice the space width (Hoefler Text more than
  // triples it; Skia halves it) — enough that the boundary reads as a hole
  // while the corrective pass squeezes every other gap on the line to pay for
  // it. Probed lazily and per spec: a paragraph without a run boundary never
  // measures at all.
  const nbspExcessByKey = new Map<string, number>();
  const nbspExcessIn = (spec: FontSpec, runIndex: number): number => {
    let excess = nbspExcessByKey.get(spec.key);
    if (excess === undefined) {
      const context = (): string => scan.runs[runIndex]!.text;
      excess = separatorWidthIn(spec, context, "\u00A0") - separatorWidthIn(spec, context, " ");
      nbspExcessByKey.set(spec.key, excess);
    }
    return excess;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const besideFloat = lineOffset + lineIndex < (scan.floatIntrusion?.lines ?? 0);
    const letterCorrectionAllowed =
      scan.direction !== "rtl" &&
      para.items.slice(line.start, line.end).some(
        (item) =>
          item.type === ItemType.Box && (item.trackStretch > 0 || item.trackShrink > 0),
      );
    /** Where this line's own segments start, for line-wide adjustments. */
    const lineFirstSegment = segments.length;
    let floorOverflowPx = 0;
    // Absolute word-spacing per run on this line: the author's own
    // word-spacing, the offset from the space glyph's advance to the glue
    // width the engine assigned (nonzero for pressured oversized spaces),
    // plus this line's glue adjustment. `flexOf` overrides the flex basis
    // for a rigid boundary glue rendered as its own segment: its shrink
    // differs from its run's interior spaces.
    const desired = (runIndex: number, flexOf?: { stretch: number; shrink: number }): number => {
      const metrics = runsMetrics[runIndex]!;
      const spec = scan.specs[scan.runs[runIndex]!.spec]!;
      // The rendered space advance (script-contextual — see spaceWidthIn)
      // is what CSS word-spacing adds to; the offset closes the gap from
      // that advance to the glue width the engine assigned.
      const widthOffset =
        metrics.space.width - spaceWidthIn(spec, () => scan.runs[runIndex]!.text);
      const pool = flexOf ?? metrics.space;
      const flex = line.glueRatio >= 0 ? pool.stretch : pool.shrink;
      return spec.wordSpacingPx + widthOffset + line.glueRatio * flex;
    };

    let joint = pendingJoint;
    let jointFlat = pendingJoint === "space" && pendingJointBesideFloat;
    let jointVoid = pendingJointVoid;
    let first = true;
    let text = "";
    let run = -1;
    let trackY = 0;
    let trackZ = 0;
    let cjkY = 0;
    let cjkZ = 0;
    let hasCJK = false;
    let boxChars = 0;
    let adjustableSpaceCount = 0;
    /** True only while flushing authored whitespace excluded from this line's
     * adjustable glue. It owns a segment so correction cannot alter it. */
    let fixedSpaceBox = false;
    /** The current fixed segment ends in a breakable other-space separator. */
    let weldFixedSeparator = false;
    /** This segment opens with a SYNTHETIC boundary NBSP — glue the model
     * prices as an ordinary space — rather than with author no-break text,
     * whose real advance the box measurement already sees. */
    let leadingSyntheticNbsp = false;
    /** A fixed box has already flushed, but an unrendered Penalty may still
     * separate it from the next Box. Retain its source edge so cross-run
     * dash junctions receive the same WJ protection as unflushed boxes. */
    let fixedBoundary: { lastChar: string; run: number } | undefined;
    /** The last thing placed on this line was an atomic object, so a space
     * arriving now opens a segment rather than continuing one (see the glue
     * branch below). */
    let afterObject = false;
    let flowExclusion: { start: number; end: number } | undefined;
    /** Set while flushing a rigid boundary glue's own segment. */
    let rigidFlex: { stretch: number; shrink: number } | null = null;
    const flush = (): void => {
      if (run < 0 || text.length === 0) return;
      // A first-letter exclusion can only occupy the paragraph's initial
      // source range. Item grouping can extend that first box across runs,
      // but the exclusion entering a rendered segment therefore still
      // starts at offset zero; leading collapsible whitespace was emitted
      // as glue before the box. Keep the prefix in source-text space.
      const floatedPrefix =
        flowExclusion === undefined ? undefined : text.slice(0, flowExclusion.end);
      const flowText =
        flowExclusion === undefined ? text : text.slice(flowExclusion.end);
      // Letterfit tracking: this segment's boxes budgeted glueRatio × track
      // flex px of letterfit change; spread it as uniform letter-spacing
      // over the box characters. Spaces receive the same increment by CSS,
      // so the word-spacing below subtracts it — gaps stay exactly the
      // width the glue algebra assigned.
      // CJK inter-character glue renders the same way: it has no character
      // in the DOM (nothing for word-spacing to widen), so its assigned
      // flex — glueRatio × the segment's CJK glue pool — joins the
      // letter-spacing spread. Totals are exact (letter-spacing applies
      // per box character, and the spread is computed from that count);
      // only the intra-segment distribution differs from the glue model by
      // sub-pixel amounts, which the measured wrap guarantee absorbs.
      const trackFlex = line.trackRatio >= 0 ? trackY : trackZ;
      const cjkFlex = line.glueRatio >= 0 ? cjkY : cjkZ;
      const extraPx =
        (trackFlex > 0 ? line.trackRatio * trackFlex : 0) +
        (cjkFlex > 0 ? line.glueRatio * cjkFlex : 0);
      const ls = boxChars > 0 && extraPx !== 0 ? extraPx / boxChars : 0;
      // Edge spaces are excluded from the corrective width measurement
      // (they collapse when a retreated segment sits at a line start, making
      // rect widths position-dependent); their widths are modeled exactly:
      // stretched space advance plus this segment's word-spacing.
      const lead = leadingCollapsibleSpaces(flowText);
      // Compute trail on the post-lead remainder: a whitespace-only
      // segment (bare space between two inline elements of different
      // runs) must not count its single character as BOTH lead and trail
      // — modelPx would double and the corrective measurement would run
      // an inverted Range.
      const trail = lead < flowText.length ? trailingCollapsibleSpaces(flowText) : 0;
      const spec = scan.specs[scan.runs[run]!.spec]!;
      const table = runsMetrics[run]!.expansionRatios;
      const key = Math.round(line.fontStretch * 1000) / 1000;
      const ratio = table?.get(key) ?? 1;
      // An author no-break-space box is measured with the run's raw author
      // word-spacing and has no glue adjustment. Do not subtract `ls`: its
      // NBSPs are box characters, so inherited tracking legitimately
      // reaches them just like the model's boxChars/track flex.
      const wordSpacing = fixedSpaceBox
        ? spec.wordSpacingPx
        : desired(run, rigidFlex ?? undefined);
      const spaceGlyphPx = spaceWidthIn(spec, () => scan.runs[run]!.text) * ratio;
      const spacePx = spaceGlyphPx + wordSpacing;
      const minimumWordSpacingPx = besideFloat && letterCorrectionAllowed
        ? Math.max(0, ((spaceGlyphPx + spec.wordSpacingPx) * 4) / 5) -
          spaceGlyphPx -
          ls
        : Number.NEGATIVE_INFINITY;
      const renderedWordSpacingPx = fixedSpaceBox
        ? wordSpacing
        : Math.max(wordSpacing - ls, minimumWordSpacingPx);
      const unclampedWordSpacingPx = fixedSpaceBox ? wordSpacing : wordSpacing - ls;
      const correctionSpaceCount = Math.max(
        0,
        adjustableSpaceCount - (segments.length === lineFirstSegment ? lead : 0),
      );
      floorOverflowPx +=
        (renderedWordSpacingPx - unclampedWordSpacingPx) * correctionSpaceCount;
      // Shave a fatter-than-space NBSP back to the glue width the model
      // assigned it. The character stays U+00A0 (the boundary must remain
      // unbreakable) and takes this segment's word-spacing like any other
      // space; only the surplus glyph advance comes off, as a negative start
      // margin — which measureLineExtent folds into the corrective model, so
      // the line's accounting stays exact. Zero for every font whose two
      // separators share an advance, and the declaration is then never
      // written.
      const nbspExcessPx =
        leadingSyntheticNbsp && flowText.charCodeAt(0) === 0xa0
          ? nbspExcessIn(spec, run) * ratio
          : 0;
      const srcRun = scan.runs[run]!;
      let decorPx: number | undefined;
      if (srcRun.padStartPx !== undefined && !decorStartSeen.has(run)) {
        decorStartSeen.add(run);
        decorPx = srcRun.padStartPx;
      }
      segments.push({
        text: flowText,
        floatedPrefix,
        floatedStyle:
          floatedPrefix !== undefined && !floatStyleEmitted
            ? scan.floatIntrusion?.kind === "first-letter"
              ? scan.floatIntrusion.style
              : undefined
            : undefined,
        floatedInnerStyle:
          floatedPrefix !== undefined ? srcRun.floatInnerStyle : undefined,
        ancestors: srcRun.ancestors,
        wordSpacingPx: renderedWordSpacingPx,
        adjustableSpaceCount,
        minimumWordSpacingPx,
        allowLetterCorrection: !fixedSpaceBox,
        weldEnd: weldFixedSeparator,
        letterSpacingPx: ls !== 0 ? spec.letterSpacingPx + ls : null,
        resolvedLetterSpacingPx: spec.letterSpacingPx + ls,
        fontFeatureSettings: trackingFeatureSettings(
          spec,
          ls !== 0 || (besideFloat && letterCorrectionAllowed),
        ),
        isolateShaping: spec.variantPosition !== "normal",
        fontStretchPct: line.fontStretch,
        marginStartPx: (first ? -line.leftHang : 0) - nbspExcessPx,
        marginEndPx: 0, // the line's last segment is patched after the loop
        edgeTrim: { lead, trail, modelPx: (lead + trail) * spacePx },
        transformChangesLength: transformedText(flowText, spec).length !== flowText.length,
        decorPx,
        cjk: hasCJK,
        joint,
        jointFlat: jointFlat ? true : undefined,
        jointVoid: jointVoid ? true : undefined,
        marginStartOwner:
          first && line.leftHang > 0 ? srcRun.boxStartProtrusionOwner : undefined,
        // Assigned only to the line's actual final segment below. Pointing
        // multiple entries at one clone would make correction measurement
        // count the clone's single margin more than once.
        marginEndOwner: undefined,
      });
      if (floatedPrefix !== undefined) floatStyleEmitted = true;
      if (srcRun.padEndPx !== undefined) lastSegForRun.set(run, segments.length - 1);
      if (flowText.length > 0) {
        joint = "none";
        jointFlat = false;
        jointVoid = false;
        first = false;
      }
      text = "";
      run = -1;
      trackY = 0;
      trackZ = 0;
      cjkY = 0;
      cjkZ = 0;
      hasCJK = false;
      boxChars = 0;
      adjustableSpaceCount = 0;
      fixedSpaceBox = false;
      weldFixedSeparator = false;
      leadingSyntheticNbsp = false;
      flowExclusion = undefined;
    };

    /** Model advance of each fixed-separator segment this line renders (and
     * of the collapsible space that hangs with a trailing run), keyed by its
     * index in `segments`. A trailing run's hang spans these whole boxes, so
     * the physical hang beside a float is shed across all of them. */
    const fixedSegmentWidth = new Map<number, number>();

    let trailingHangGlue = -1;
    const lineEndBox = breakEndBox(para, line.end);
    if (
      lineEndBox !== undefined &&
      (lineEndBox.hangStretch > 0 || lineEndBox.hangShrink > 0)
    ) {
      let i = line.end - 1;
      let candidate = para.items[i];
      while (
        i >= line.start &&
        candidate?.type === ItemType.Box &&
        candidate.otherSpace === true
      ) {
        i--;
        candidate = para.items[i];
      }
      if (
        i >= line.start &&
        candidate?.type === ItemType.Glue &&
        candidate.fixedSpaceInitial === true
      ) {
        trailingHangGlue = i;
      }
    }

    for (let i = line.start; i < line.end; i++) {
      const it = para.items[i]!;
      if (it.type === ItemType.Box && it.atomic === true) {
        // An object stands alone: it is placed, not set, so it shares a
        // segment with no text — which is also what lets its own element
        // sit at its authored depth in the cloned inline ancestry.
        flush();
        fixedBoundary = undefined;
        const srcRun = scan.runs[it.run]!;
        // Decoration accounting is the text path's, unchanged: an inline
        // whose whole content is one object opens its padding on that
        // object's segment and closes it there too.
        let decorPx: number | undefined;
        if (srcRun.padStartPx !== undefined && !decorStartSeen.has(it.run)) {
          decorStartSeen.add(it.run);
          decorPx = srcRun.padStartPx;
        }
        segments.push({
          text: "",
          atomic: {
            source: srcRun.atomic!.source,
            style: srcRun.atomic!.style,
            // A weld at the line's own edge would forbid the break the joint
            // there depends on. The trailing one is withdrawn below, once
            // the line's last segment is known.
            weldStart: !first,
            weldEnd: true,
          },
          ancestors: srcRun.ancestors,
          wordSpacingPx: 0,
          adjustableSpaceCount: 0,
          minimumWordSpacingPx: 0,
          // Nothing about an object is spacing, so no correction may be
          // distributed onto it; the line's text carries the whole
          // adjustment. Its own measured rect still enters the line extent,
          // which is what makes a drifted object width self-correcting.
          allowLetterCorrection: false,
          letterSpacingPx: null,
          resolvedLetterSpacingPx: 0,
          fontStretchPct: 100,
          // An object protrudes nothing of its own, but a painted inline
          // opening on it still hangs its decoration into the margin.
          marginStartPx: first ? -line.leftHang : 0,
          marginStartOwner:
            first && line.leftHang > 0 ? srcRun.boxStartProtrusionOwner : undefined,
          marginEndPx: 0, // the line's last segment is patched after the loop
          edgeTrim: { lead: 0, trail: 0, modelPx: 0 },
          decorPx,
          joint,
          jointFlat: jointFlat ? true : undefined,
          jointVoid: jointVoid ? true : undefined,
          marginEndOwner: undefined,
        });
        if (srcRun.padEndPx !== undefined) lastSegForRun.set(it.run, segments.length - 1);
        joint = "none";
        jointFlat = false;
        jointVoid = false;
        first = false;
        afterObject = true;
        continue;
      }
      if (it.type === ItemType.Box) {
        afterObject = false;
        const ownFixedSegment =
          it.otherSpace === true || AUTHOR_NO_BREAK_SPACE.test(it.text);
        const firstChar = it.text[0] ?? "";
        if (fixedBoundary !== undefined) {
          const junction = fixedBoundary.lastChar + firstChar;
          if (fixedBoundary.run !== it.run && DASH_JUNCTION.test(junction)) {
            text = "\u2060";
          }
          fixedBoundary = undefined;
        }
        if (ownFixedSegment && run !== -1) {
          const junction = text.slice(-1) + firstChar;
          const protect = run !== it.run && DASH_JUNCTION.test(junction);
          flush();
          if (protect) text = "\u2060";
        }
        if (run !== -1 && run !== it.run) {
          // Glue-less run boundary. Dash-class characters allow a line
          // break here (UAX14 B2/HY) — e.g. code directly followed by an
          // em dash — so those junctions get a U+2060 WORD JOINER, which
          // forbids the break outright. Zero width and invisible; only
          // inserted at dash junctions since find-in-page cannot match
          // through it.
          const junction = text.slice(-1) + firstChar;
          const risky = DASH_JUNCTION.test(junction);
          flush();
          text = risky ? "\u2060" : "";
        }
        run = it.run;
        const textOffset = text.length;
        text += it.text;
        if (it.flowExclusion !== undefined) {
          const shifted = {
            start: textOffset + it.flowExclusion.start,
            end: textOffset + it.flowExclusion.end,
          };
          if (flowExclusion === undefined) flowExclusion = shifted;
          else flowExclusion.end = shifted.end;
        }
        trackY += it.trackStretch;
        trackZ += it.trackShrink;
        boxChars += it.flowChars ?? Array.from(it.text).length;
        if (!hasCJK && CJK_CHAR.test(it.text)) hasCJK = true;
        if (ownFixedSegment) {
          const boundary = { lastChar: it.text.slice(-1), run: it.run };
          fixedSpaceBox = true;
          weldFixedSeparator = it.otherSpace === true;
          flush();
          if (it.otherSpace === true) fixedSegmentWidth.set(segments.length - 1, it.width);
          fixedBoundary = boundary;
        }
      } else if (it.type === ItemType.Glue) {
        fixedBoundary = undefined;
        if (i === trailingHangGlue) {
          // A collapsible space immediately before the trailing fixed run
          // shares that run's hang when this boundary is selected.
          // Render it at its authored width in a correction-proof segment;
          // rightHang removes the complete sequence from line fitting.
          flush();
          run = it.run;
          text = " ";
          fixedSpaceBox = true;
          flush();
          fixedSegmentWidth.set(segments.length - 1, it.width);
          continue;
        }
        if (it.cjk === true) {
          // CJK inter-character glue: no source character to emit — its
          // flex is pooled and rendered as this segment's letter-spacing
          // (see flush). It always sits between two boxes of one run, so
          // no run-boundary handling is needed.
          cjkY += it.stretch;
          cjkZ += it.shrink;
          continue;
        }
        const glueSpec = scan.specs[scan.runs[it.run]!.spec]!;
        if (glueSpec.variantPosition !== "normal") {
          // Firefox applies `font-variant-position` contextually across a
          // multiword shaping run: the same word and space can have
          // different advances when neighboring glyphs join that run.
          // The item model measures words and spaces independently, so
          // preserve those exact shaping boundaries in the rendered DOM.
          // A whitespace-only segment is safe here: write.ts already models
          // and excludes its edge space from corrective Range measurement.
          flush();
          run = it.run;
          text = " ";
          adjustableSpaceCount = 1;
          flush();
          continue;
        }
        if (it.rigid === true && line.glueRatio < 0) {
          // A rigid boundary space on a SHRUNKEN line: its assigned width
          // differs from its run's interior spaces (shrink withheld), and
          // word-spacing is per segment — so it renders as its own
          // one-space segment with the glue's own flex. NBSP for the same
          // reason as cross-run boundary spaces below. On stretched lines
          // its width equals its neighbors' and the normal paths apply.
          flush();
          run = it.run;
          text = "\u00A0";
          adjustableSpaceCount = 1;
          leadingSyntheticNbsp = true;
          rigidFlex = { stretch: it.stretch, shrink: it.shrink };
          flush();
          rigidFlex = null;
          continue;
        }
        // Mid-line spaces stay INSIDE a nowrap segment, in the segment of
        // THEIR OWN run (a prose space after a link must not render inside
        // the link). A space at a segment edge becomes U+00A0: NBSP is
        // line-break class GL — unbreakable by specification — so run
        // boundaries can never become stray wrap points, whatever the
        // engine's edge-space heuristics. Word-spacing applies to it
        // identically; the glyph advance usually matches too, and flush()
        // shaves off the surplus in the fonts where it does not.
        //
        // The space after an ATOMIC OBJECT takes the same treatment even
        // when it continues the run the object interrupted. Measured: a
        // plain space opening the segment after an object is where Firefox
        // ends the line, dropping the rest of a line that fit to the pixel
        // — the object's own word joiner cannot speak for a boundary the
        // space owns.
        if (!afterObject && (run === -1 || run === it.run)) {
          run = it.run;
          text += " ";
          adjustableSpaceCount++;
        } else {
          // Leading NBSP in the NEXT run's segment: outside the previous
          // element (no underline extension), unbreakable on both sides.
          flush();
          run = it.run;
          text = "\u00A0";
          adjustableSpaceCount = 1;
          leadingSyntheticNbsp = true;
          afterObject = false;
        }
      }
      // Penalties not broken at render nothing.
    }
    flush();
    const last = segments[segments.length - 1];
    // Provisional margin; the measured correction pass replaces its safety
    // component with physical spacing correction. The pad keeps the line
    // from re-wrapping before its (possibly deferred/parked) correction.
    if (last !== undefined) {
      // The line's chosen break remains available. Only fixed separators
      // followed by another box on this same modeled line need welding.
      last.weldEnd = false;
      // Same rule for an object closing the line: the joint after it is the
      // break the next line begins at, and a word joiner in front of that
      // joint is exactly what would forbid it.
      if (last.atomic !== undefined) last.atomic.weldEnd = false;
      let endBox: Box | undefined;
      for (let i = line.end - 1; i >= line.start; i--) {
        const candidate = para.items[i]!;
        if (candidate.type === ItemType.Box) {
          endBox = candidate;
          break;
        }
      }
      // Chromium and Firefox evaluate a nowrap fragment's fit beside a
      // float from its physical typographic width, ignoring an end margin
      // that would make the same fragment fit elsewhere. Encode a terminal
      // glyph's hang as reduced letter advance there: its glyph stays
      // joined to the word, but its ink can paint beyond the shortened
      // line box. Painted inline boxes retain the ordinary margin
      // representation: their overhang is not a terminal glyph advance.
      const requestedHang =
        besideFloat &&
        !line.hyphenated &&
        endBox?.paintedEnd !== true &&
        line.rightHang > 0 &&
        endWithoutCollapsibleSpaces(last.text) > 0
          ? line.rightHang
          : 0;
      /** What the closing box can still give up, after the hang below. */
      let padCapacity = 0;
      /** Of `requestedHang`, what no box on the line could give up. */
      let unshed = 0;
      if (requestedHang > 0) {
        if (fixedSegmentWidth.has(segments.length - 1)) {
          // A trailing fixed-separator run hangs whole boxes, not one
          // glyph's protrusion: each separator can give up only its own
          // advance, so shed the hang backwards across the run (and the
          // collapsible space that hangs with it). Piling the whole run on
          // the final separator collapses that one advance and leaves the
          // rest inside the line, where the corrective pass would crush it
          // out of the line's word spaces.
          let remaining = requestedHang;
          for (
            let index = segments.length - 1;
            remaining > 0.001 && fixedSegmentWidth.has(index);
            index--
          ) {
            const hung = segments[index]!;
            const width = fixedSegmentWidth.get(index)!;
            const share = Math.min(remaining, width);
            hung.physicalEndHangPx = share;
            remaining -= share;
            if (index === segments.length - 1) padCapacity = width - share;
            // The collapsible space hung with the run is a whitespace-only
            // segment, and corrective reads take an edge space from the
            // model rather than from a rect. Its hang has to come off there
            // too, or the model re-adds an advance the DOM no longer has.
            if (leadingCollapsibleSpaces(hung.text) === hung.text.length) {
              hung.edgeTrim = {
                ...hung.edgeTrim,
                modelPx: Math.max(0, hung.edgeTrim.modelPx - share),
              };
            }
          }
          unshed = remaining;
        } else {
          const capacity = shedCapacity(terminalClusterAdvance(last, endBox, scan));
          const share = Math.min(requestedHang, capacity);
          if (share > 0) last.physicalEndHangPx = share;
          unshed = requestedHang - share;
          padCapacity = capacity - share;
        }
      } else if (besideFloat && !line.hyphenated && endBox?.paintedEnd !== true) {
        padCapacity = shedCapacity(terminalClusterAdvance(last, endBox, scan));
      }
      const physicalEndHang = requestedHang - unshed;
      // A hyphen-ended line beside the float hangs its pseudo-hyphen the
      // same physical way — as reduced advance on the hyphen span itself
      // (letter-spacing after the "-"); a margin there is invisible to the
      // fit test and the whole line drops below the float.
      const hyphenEndHang =
        besideFloat && line.hyphenated && line.rightHang > 0 && endBox !== undefined
          ? line.rightHang
          : 0;
      if (hyphenEndHang > 0) {
        last.hyphenEndHangPx = hyphenEndHang;
        const endSpec = scan.specs[scan.runs[endBox!.run]!.spec]!;
        last.hyphenLetterSpacingPx = endSpec.letterSpacingPx - hyphenEndHang;
      }
      // Beside a float the safety pad in the margin below buys the line
      // nothing: the fit test reads the line's advance, and a margin is not
      // part of it. The model's own drift — a few hundredths of a pixel is
      // plenty — then drops the whole line under the float and leaves a
      // float-sized hole until the correction that would have fixed it
      // runs, which for an off-screen paragraph is never.
      //
      // So the pad is shed the way the hangs are, from the advance of
      // whichever box closes the line. That is free where the box has the
      // room, since nothing follows it: no glyph moves and the line paints
      // exactly where it did, only the box the engine measures gets
      // shorter.
      if (besideFloat) {
        const endSpec =
          endBox === undefined ? undefined : scan.specs[scan.runs[endBox.run]!.spec]!;
        const capacity =
          line.hyphenated && endBox !== undefined && endSpec !== undefined
            ? shedCapacity(runsMetrics[endBox.run]!.hyphenWidth + endSpec.letterSpacingPx) -
              hyphenEndHang
            : padCapacity;
        const pad = Math.max(0, Math.min(WRAP_SAFETY_PAD_PX, capacity));
        if (pad > 0.001) {
          last.physicalPadPx = pad;
          // A hyphenated line sheds on the hyphen span the writer appends
          // after this segment, so the terminal cluster is left alone.
          if (line.hyphenated && endSpec !== undefined) {
            last.hyphenLetterSpacingPx =
              (last.hyphenLetterSpacingPx ?? endSpec.letterSpacingPx) - pad;
          }
        }
        // Whatever the closing box could not give up — of the hang, and of
        // the pad — the line pays for by setting that much tighter, which
        // is what the corrective pass does to it anyway when it runs. This
        // only moves the same reckoning to write time, where a line whose
        // correction is parked can still benefit from it. Spacing is exact,
        // unlike an advance the engine may clamp, so it is also what makes
        // the arithmetic above safe to be conservative with.
        tightenLine(
          segments,
          lineFirstSegment,
          floorOverflowPx + unshed + (WRAP_SAFETY_PAD_PX - pad),
        );
      }
      // Whatever the writer ends up shedding, the carrier it sheds from is
      // shaped apart from the cluster before it. Hand it the pair kern that
      // costs, so the mark stays put against the glyph it follows.
      if (hangCarrierShed(last) > 0) {
        const kern = terminalPairKern(last, endBox, scan);
        if (kern !== undefined) last.terminalKernPx = kern;
      }
      last.marginEndPx = -(
        line.rightHang -
        unshed -
        physicalEndHang -
        hyphenEndHang +
        line.overflowPx +
        WRAP_SAFETY_PAD_PX
      );
      // What the line will actually protrude: a hang its closing box could
      // not shed was paid for in spacing above, so it is no longer standing
      // outside the measure and must not be corrected for as though it were.
      last.rightHangPx = line.rightHang - unshed;
      last.overflowPx = line.overflowPx;
      // A zero fixed hang still marks an unpadded painted element's REAL
      // close. Keep the safety/correction margin on that clone's outside;
      // an internal wrap in the same source run has no marker and retains
      // the ordinary per-line segment margin.
      if (endBox?.type === ItemType.Box && endBox.paintedEnd === true) {
        last.marginEndOwner = scan.runs[endBox.run]?.boxEndProtrusionOwner;
      }
    }

    // Decide the joint that separates this line from the next.
    const brk = para.items[line.end];
    pendingJointBesideFloat = lineOffset + lineIndex < (scan.floatIntrusion?.lines ?? 0);
    pendingJointVoid = false;
    if (line.hyphenated) pendingJoint = "hyphen";
    else if (brk !== undefined && brk.type === ItemType.Glue) pendingJoint = "space";
    else if (
      brk !== undefined &&
      brk.type === ItemType.Penalty &&
      brk.width === 0 &&
      !brk.flagged
    ) {
      // Unflagged zero-width penalties come in several kinds, told apart by
      // their discriminators. Hand-built zero-width penalties sit BEFORE a
      // glue at a real space: the break consumes that space, which must
      // still appear in the DOM text — a zero-width joint there would
      // silently delete it from copies and find-in-page. CJK inter-character
      // penalties have NO source space: a space joint would inject one into
      // copies (and render a visible gap), so they get the bare zero-width
      // joint. Explicit-hyphen breaks are flagged and keep the zero-width
      // joint below.
      //
      // An atomic object's junction has no source space either, but cannot
      // use that zero-width joint: measured, Firefox ignores it between two
      // objects and runs a formula clean past the measure. It takes a flat
      // space instead, marked as standing for nothing so copies drop it
      // (see RenderSegment.jointVoid).
      if (brk.atomic === true) {
        pendingJoint = "space";
        pendingJointVoid = true;
      } else {
        pendingJoint = brk.cjk === true || brk.fixedSpace === true ? "wbr" : "space";
      }
    } else pendingJoint = "wbr"; // zero-width flagged penalty (dash break)
  }

  // Closing decorations attach to each padded run's LAST segment — known
  // only now that every line is built.
  for (const [runIndex, segIndex] of lastSegForRun) {
    const seg = segments[segIndex]!;
    seg.decorPx = (seg.decorPx ?? 0) + scan.runs[runIndex]!.padEndPx!;
    seg.decorEndOwner = scan.runs[runIndex]!.padEndOwner;
  }

  return segments;
}
