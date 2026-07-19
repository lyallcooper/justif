/**
 * Pure functions bridging a paragraph scan and the core's Line output to
 * the DOM writer's segment model (write.ts does the actual DOM emission).
 * No lifecycle, no state — index.ts stays plumbing.
 */
import { CJK_CHAR } from "../core/cjk.js";
import {
  composeProtrusion,
  type HangingPunctuationMode,
  latinProtrusion,
} from "../core/protrusion.js";
import { fontProtrusion } from "../core/protrusion-fonts.js";
import {
  type Box,
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
import {
  type FontSpec,
  isMonospace,
  measureInkBearings,
  measureWidth,
  requiresDomMeasurement,
} from "./measure.js";
import type { ParagraphScan } from "./read.js";
import { type RenderSegment, WRAP_SAFETY_PAD_PX } from "./write.js";

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
  const explicitlyOff = (tag: string): boolean =>
    new RegExp(`["']${tag}["']\\s*(?:0|off)\\b`, "i").test(spec.featureSettings);
  if (!explicitlyOff("liga")) settings.push('"liga" 1');
  if (!explicitlyOff("clig")) settings.push('"clig" 1');
  return settings.length > 0 ? settings.join(", ") : undefined;
}

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
  if (requiresDomMeasurement(spec) && spec.variantPosition === "normal") {
    // Variant-bearing runs measure spaces IN LETTER CONTEXT for the same
    // reason: engines that SYNTHESIZE a variant can scale a run's interior
    // spaces along with its letters (GTK WebKit renders all-small-caps at
    // ~0.7x, spaces included), while a lone space carries nothing to case
    // and measures full-size — every modeled gap then overshoots the
    // rendered one and lines come out short. variant-position runs are the
    // exception BOTH ways: the renderer isolates each of their words and
    // spaces into its own shaping segment (Firefox shapes sub/super
    // contextually across a run), so their spaces really do render alone
    // and the lone-space measurement is the matching one.
    const letter = /\p{L}/u.exec(runText)?.[0] ?? "n";
    return measureWidth(`${letter} ${letter}`, spec) - 2 * measureWidth(letter, spec);
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
  return scan.runs.map((r, i) => ({
    text: r.text,
    run: i,
    boxStartProtrusionPx: r.boxStartProtrusionPx,
    boxEndProtrusionPx: r.boxEndProtrusionPx,
    padStartPx: r.padStartPx,
    padEndPx: r.padEndPx,
    atomicKey: r.atomicKey,
  }));
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
      // Word spaces between different font FAMILIES lose their shrink
      // (BuildOptions.boundaryShrink): chips and pills live at those
      // boundaries. Style/weight/size changes within a family (<em>,
      // <strong>) are not boundaries.
      familyKey: spec.family,
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

  // Inline padding/border (StyledRun.padStartPx/padEndPx) is layout width
  // the corrective measurement can't see in the text rects — it renders on
  // the clone around the run's first/last content. Attribute it to the
  // run's first/last SEGMENT: those share a line with the decorated clone
  // edge by construction (a break next to the element puts the joint
  // outside the clone), and corrections only need per-line totals.
  const decorStartSeen = new Set<number>();
  const lastSegForRun = new Map<number, number>();

  for (const line of lines) {
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
      const widthOffset = metrics.space.width - spaceWidthIn(spec, scan.runs[runIndex]!.text);
      const pool = flexOf ?? metrics.space;
      const flex = line.glueRatio >= 0 ? pool.stretch : pool.shrink;
      return spec.wordSpacingPx + widthOffset + line.glueRatio * flex;
    };

    let joint = pendingJoint;
    let first = true;
    let text = "";
    let run = -1;
    let trackY = 0;
    let trackZ = 0;
    let cjkY = 0;
    let cjkZ = 0;
    let hasCJK = false;
    let boxChars = 0;
    /** Set while flushing a rigid boundary glue's own segment. */
    let rigidFlex: { stretch: number; shrink: number } | null = null;
    const flush = (): void => {
      if (run < 0 || text.length === 0) return;
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
      const wordSpacing = desired(run, rigidFlex ?? undefined);
      const spacePx = spaceWidthIn(spec, scan.runs[run]!.text) * ratio + wordSpacing;
      const srcRun = scan.runs[run]!;
      let decorPx: number | undefined;
      if (srcRun.padStartPx !== undefined && !decorStartSeen.has(run)) {
        decorStartSeen.add(run);
        decorPx = srcRun.padStartPx;
      }
      segments.push({
        text,
        ancestors: srcRun.ancestors,
        wordSpacingPx: wordSpacing - ls,
        letterSpacingPx: ls !== 0 ? spec.letterSpacingPx + ls : null,
        fontFeatureSettings: trackingFeatureSettings(spec, ls !== 0),
        isolateShaping: spec.variantPosition !== "normal",
        fontStretchPct: line.fontStretch,
        marginStartPx: first ? -line.leftHang : 0,
        marginEndPx: 0, // the line's last segment is patched after the loop
        edgeTrim: { lead, trail, modelPx: (lead + trail) * spacePx },
        decorPx,
        cjk: hasCJK,
        joint,
        marginStartOwner:
          first && line.leftHang > 0 ? srcRun.boxStartProtrusionOwner : undefined,
        // Assigned only to the line's actual final segment below. Pointing
        // multiple entries at one clone would make correction measurement
        // count the clone's single margin more than once.
        marginEndOwner: undefined,
      });
      if (srcRun.padEndPx !== undefined) lastSegForRun.set(run, segments.length - 1);
      joint = "none";
      first = false;
      text = "";
      run = -1;
      trackY = 0;
      trackZ = 0;
      cjkY = 0;
      cjkZ = 0;
      hasCJK = false;
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
        if (!hasCJK && CJK_CHAR.test(it.text)) hasCJK = true;
      } else if (it.type === ItemType.Glue) {
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
      // A zero fixed hang still marks an unpadded painted element's REAL
      // close. Keep the safety/correction margin on that clone's outside;
      // an internal wrap in the same source run has no marker and retains
      // the ordinary per-line segment margin.
      let endBox: Box | undefined;
      for (let i = line.end - 1; i >= line.start; i--) {
        const candidate = para.items[i]!;
        if (candidate.type === ItemType.Box) {
          endBox = candidate;
          break;
        }
      }
      if (endBox?.type === ItemType.Box && endBox.paintedEnd === true) {
        last.marginEndOwner = scan.runs[endBox.run]?.boxEndProtrusionOwner;
      }
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
      // Unflagged zero-width penalties come in two kinds, told apart by
      // the `cjk` discriminator. Hand-built zero-width penalties sit BEFORE a
      // glue at a real space: the break consumes that space, which must
      // still appear in the DOM text — a <wbr> there would silently delete
      // it from copies and find-in-page. CJK inter-character penalties
      // have NO source space: a space joint would inject one into copies
      // (and render a visible gap), so they get the bare <wbr>.
      // Explicit-hyphen breaks are flagged and keep the <wbr> below.
      pendingJoint = brk.cjk === true ? "wbr" : "space";
    } else pendingJoint = "wbr"; // zero-width flagged penalty (explicit hyphen)
  }

  // Closing decorations attach to each padded run's LAST segment — known
  // only now that every line is built.
  for (const [runIndex, segIndex] of lastSegForRun) {
    const seg = segments[segIndex]!;
    seg.decorPx = (seg.decorPx ?? 0) + scan.runs[runIndex]!.padEndPx!;
  }

  return segments;
}
