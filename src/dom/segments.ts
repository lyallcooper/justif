/**
 * Pure functions bridging a paragraph scan and the core's Line output to
 * the DOM writer's segment model (write.ts does the actual DOM emission).
 * No lifecycle, no state — index.ts stays plumbing.
 */
import { CJK_CHAR } from "../core/cjk.js";
import { breakEndBox } from "../core/items.js";
import { opticalCandidates, opticalFontKey, opticalProtrusion } from "./optical.js";
import {
  composeProtrusion,
  type HangingCharacters,
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
  transformedText,
} from "./measure.js";
import type { ParagraphScan } from "./read.js";
import {
  endWithoutCollapsibleSpaces,
  leadingCollapsibleSpaces,
  trailingCollapsibleSpaces,
} from "./whitespace.js";
import { type RenderSegment, WRAP_SAFETY_PAD_PX } from "./write.js";

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
function spaceWidthIn(spec: FontSpec, context: () => string): number {
  return separatorWidthIn(spec, context, " ");
}

/** `spaceWidthIn` for an arbitrary word-separator character. */
function separatorWidthIn(spec: FontSpec, context: () => string, separator: string): number {
  // `context` is a thunk: only the paths below that actually probe in script
  // or letter context need the text, and materializing a paragraph-wide
  // string for the ordinary case was pure waste. Memoized because an RTL spec
  // in neither Arabic nor Hebrew falls through to the variant path and would
  // otherwise rebuild it twice.
  let text: string | undefined;
  const runText = (): string => (text ??= context());
  if (spec.direction === "rtl") {
    const probe = /\p{Script=Arabic}/u.test(runText())
      ? "ل" // Arabic lam
      : /\p{Script=Hebrew}/u.test(runText())
        ? "א" // Hebrew alef
        : null;
    if (probe !== null) {
      return (
        measureWidth(`${probe}${separator}${probe}`, spec) - 2 * measureWidth(probe, spec)
      );
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
    const letter = /\p{L}/u.exec(runText())?.[0] ?? "n";
    return (
      measureWidth(`${letter}${separator}${letter}`, spec) - 2 * measureWidth(letter, spec)
    );
  }
  return measureWidth(separator, spec);
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
    flowExclusion: r.flowExclusion,
    boxStartProtrusionPx: r.boxStartProtrusionPx,
    boxEndProtrusionPx: r.boxEndProtrusionPx,
    padStartPx: r.padStartPx,
    padEndPx: r.padEndPx,
    atomicKey: r.atomicKey,
  }));
}

/**
 * Per-family protrusion tables under one controller's protrusion settings.
 * Keyed by the CSS family list; the cache is invalidated whenever the
 * settings object identity changes, which happens once per controller.
 */
interface ProtrusionSettings {
  enabled: boolean;
  /** The protrusion model contributes a base table. With it off, the hang
   * overlays compose over an empty base: flush glyphs, hanging marks. */
  model: boolean;
  measured: boolean;
  user: ProtrusionTable | null;
  hang: HangingPunctuationMode;
  characters: HangingCharacters;
}
type ComposedTables =
  | { rest: ProtrusionTable; first?: ProtrusionTable; credit?: ProtrusionTable }
  | null;
/** Weakly keyed on the settings object, so two live controllers don't evict
 * each other and a destroyed one's tables are collectable. */
let composedBySettings = new WeakMap<ProtrusionSettings, Map<string, ComposedTables>>();

/**
 * Drop every composed table. Needed alongside `clearOpticalCache` on a font
 * change: these are built FROM measured tables, and a controller's settings
 * object outlives the fonts, so clearing only the measurement would leave the
 * stale composition in front of it.
 */
export function clearComposedProtrusionCache(): void {
  composedBySettings = new WeakMap();
}

/**
 * The generic table minus every character the raster pass forms an opinion
 * about — i.e. exactly the entries a measured table can never contain, such
 * as the Arabic and Hebrew stops. Computed once; the two tables are module
 * constants.
 */
let unmeasured: ProtrusionTable | undefined;
function unmeasuredProtrusion(): ProtrusionTable {
  if (unmeasured !== undefined) return unmeasured;
  const considered = new Set(opticalCandidates);
  unmeasured = Object.fromEntries(
    Object.entries(latinProtrusion).filter(([ch]) => !considered.has(ch)),
  );
  return unmeasured;
}

function composedForFamily(
  spec: FontSpec,
  settings: ProtrusionSettings | undefined,
): ComposedTables {
  if (settings === undefined || !settings.enabled) return null;
  let composedCache = composedBySettings.get(settings);
  if (composedCache === undefined) {
    composedCache = new Map();
    composedBySettings.set(settings, composedCache);
  }
  const family = spec.family;
  // Measured tables describe a GLYPH SET, not a family: small caps, italics and
  // weights are different shapes and measure differently, so this cache must
  // key on everything the measurement keys on or it serves one variant's table
  // for another.
  const key = opticalFontKey(spec);
  const hit = composedCache.get(key);
  if (hit !== undefined) return hit;
  // Measured values describe THIS font, so within the range the measurement
  // CONSIDERED they replace the generic table and the per-font configs both —
  // a zero there means "this glyph needs no hang", not "no opinion", and must
  // not be back-filled from a table tuned for other faces. Characters the
  // measurement never looked at are a different matter: the generic table
  // carries entries the raster pass has no candidate for, notably the Arabic
  // and Hebrew stops that make pure-RTL paragraphs work.
  //
  // A user table deliberately selects the table-backed path instead: generic
  // values, then the matching hand-tuned font table, then the user's
  // overrides. Besides being an escape hatch for faces where hand tuning wins,
  // this avoids canvas pixel readback and keeps the chosen values stable across
  // browser engines.
  //
  // With the model off (`protrusion: false`) there is no base at all: only the
  // hang overlays land, so ordinary glyphs sit exactly flush while the eligible
  // marks still hang. Nothing here measures in that case — the raster pass is
  // the model's, and skipping it is most of what `protrusion: false` buys.
  let base: ProtrusionTable = {};
  if (settings.model) {
    // Pure-RTL paragraphs take the table-backed path: every character the raster
    // pass forms an opinion about is Latin, so measuring buys such a paragraph
    // nothing — while the script-specific stops it does NOT examine are exactly
    // what the built-in tables carry for it. Measured on CI, where `serif`
    // resolves to a face with no Arabic at all: the measured path left an Arabic
    // question mark sitting inside the margin.
    const measured =
      settings.measured && spec.direction !== "rtl" ? opticalProtrusion(spec) : undefined;
    base =
      measured !== undefined
        ? { ...unmeasuredProtrusion(), ...measured }
        : { ...latinProtrusion, ...fontProtrusion(family) };
  }
  const composed = composeProtrusion(base, settings.user, settings.hang, settings.characters);
  const tables: ComposedTables = {
    rest: composed.rest,
    first: composed.first !== composed.rest ? composed.first : undefined,
    credit: composed.credit,
  };
  composedCache.set(key, tables);
  return tables;
}

export function buildRunMetrics(
  scan: ParagraphScan,
  expansion: ExpansionOptions | false,
  spacing: { stretch: number; shrink: number; pull?: number },
  protrusion?: ProtrusionSettings,
): RunMetrics[] {
  // Base-space context is the whole paragraph: the base font's spaces sit
  // between whatever script the paragraph is written in. Materialized LAZILY —
  // spaceWidthIn ignores its text for the ordinary LTR, variant-free spec, so
  // the common paragraph never pays for a copy of its own text.
  const baseSpec = scan.specs[scan.baseSpec]!;
  const baseSpaceWidth = spaceWidthIn(baseSpec, () =>
    scan.runs.map((r) => r.text).join(" "),
  );
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
    // and position-scoped) < user overrides. Memoized per family: composing
    // it spreads the generic table and builds two overlays, and it was
    // repeated for every run of every paragraph even though the user table
    // and hang mode are fixed for the controller.
    const perFontTables = composedForFamily(spec, protrusion);
    const perFont = perFontTables?.rest;
    const perFontFirst = perFontTables?.first;
    const perFontCredit = perFontTables?.credit;
    const naturalSpace = spaceWidthIn(spec, () => run.text);
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
      // other font (full cells hang under a hanging-punctuation mode — the
      // typewriter-tradition grid behavior).
      protrudeInkOnly: isMonospace(spec) && spec.key !== baseSpec.key,
      // Glyph identity for protrusion lookups only; every width this run
      // carries was already measured with the property applied.
      textTransform:
        spec.textTransform === "uppercase" || spec.textTransform === "lowercase"
          ? spec.textTransform
          : undefined,
      protrusion: perFont,
      protrusionFirst: perFontFirst,
      protrusionCredit: perFontCredit,
    };
  });
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
      const spacePx = spaceWidthIn(spec, () => scan.runs[run]!.text) * ratio + wordSpacing;
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
            ? scan.floatIntrusion?.style
            : undefined,
        floatedInnerStyle:
          floatedPrefix !== undefined ? srcRun.floatInnerStyle : undefined,
        ancestors: srcRun.ancestors,
        wordSpacingPx: fixedSpaceBox ? wordSpacing : wordSpacing - ls,
        adjustableSpaceCount,
        allowLetterCorrection: !fixedSpaceBox,
        weldEnd: weldFixedSeparator,
        letterSpacingPx: ls !== 0 ? spec.letterSpacingPx + ls : null,
        resolvedLetterSpacingPx: spec.letterSpacingPx + ls,
        fontFeatureSettings: trackingFeatureSettings(spec, ls !== 0),
        isolateShaping: spec.variantPosition !== "normal",
        fontStretchPct: line.fontStretch,
        marginStartPx: (first ? -line.leftHang : 0) - nbspExcessPx,
        marginEndPx: 0, // the line's last segment is patched after the loop
        edgeTrim: { lead, trail, modelPx: (lead + trail) * spacePx },
        transformChangesLength: transformedText(flowText, spec).length !== flowText.length,
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
      if (floatedPrefix !== undefined) floatStyleEmitted = true;
      if (srcRun.padEndPx !== undefined) lastSegForRun.set(run, segments.length - 1);
      if (flowText.length > 0) {
        joint = "none";
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
      if (it.type === ItemType.Box) {
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
        if (run === -1 || run === it.run) {
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
      const besideFloat = lineOffset + lineIndex < (scan.floatIntrusion?.lines ?? 0);
      const physicalEndHang =
        besideFloat &&
        !line.hyphenated &&
        endBox?.paintedEnd !== true &&
        line.rightHang > 0 &&
        endWithoutCollapsibleSpaces(last.text) > 0
          ? line.rightHang
          : 0;
      if (physicalEndHang > 0) last.physicalEndHangPx = physicalEndHang;
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
      last.marginEndPx = -(
        line.rightHang -
        physicalEndHang -
        hyphenEndHang +
        line.overflowPx +
        WRAP_SAFETY_PAD_PX
      );
      last.rightHangPx = line.rightHang;
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
      // still appear in the DOM text — a zero-width joint there would
      // silently delete it from copies and find-in-page. CJK inter-character
      // penalties have NO source space: a space joint would inject one into
      // copies (and render a visible gap), so they get the bare zero-width
      // joint. Explicit-hyphen breaks are flagged and keep the zero-width
      // joint below.
      pendingJoint = brk.cjk === true || brk.fixedSpace === true ? "wbr" : "space";
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
