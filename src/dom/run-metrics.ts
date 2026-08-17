/**
 * Per-run metrics: what one styled run costs the line model.
 *
 * The scan says what each run's text and font are; this turns that into the
 * numbers the breaker prices lines with — the run's space width, its
 * stretch/shrink pool, the expansion range its font can actually deliver,
 * and the protrusion table its glyphs hang by. One entry per run, computed
 * once and reused until a font or a setting moves.
 *
 * The width helpers here are shared with the segment writer, which has to
 * reproduce the same numbers when it emits the DOM: a space measured one way
 * for pricing and another for rendering is exactly the drift the wrap
 * guarantee exists to catch.
 */

import {
  type ExpansionOptions,
  type Measure,
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
import { composedForFamily, type ProtrusionSettings } from "./protrusion-tables.js";
import type { ParagraphScan } from "./read.js";

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
export function spaceWidthIn(spec: FontSpec, context: () => string): number {
  return separatorWidthIn(spec, context, " ");
}

/** `spaceWidthIn` for an arbitrary word-separator character. */
export function separatorWidthIn(spec: FontSpec, context: () => string, separator: string): number {
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
    // The core needs the object's advance and nothing else about it; its
    // element and styling stay on the scan, where the writer reads them.
    atomic: r.atomic === undefined ? undefined : { widthPx: r.atomic.widthPx },
  }));
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