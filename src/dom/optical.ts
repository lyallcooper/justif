import type { ProtrusionTable } from "../core/types.js";

/**
 * Measured optical protrusion: derives a font's own protrusion table by
 * rendering its glyphs and asking how far each one must hang for the margin
 * to LOOK straight, rather than by consulting a table tuned for other fonts.
 *
 * The model is one equation with two ingredients:
 *
 *     s = clamp( P(glyph) − P(letters) , ink line , geometric ceiling )
 *
 * POSITION. P is the ink centroid of the line's leading window — the glyph
 * plus the text after it, each column of ink weighted by how close it sits to
 * the margin. Because shifting a glyph translates its ink, the centroid moves
 * one-for-one with the shift, so the hang that aligns a glyph's perceived
 * position with an ordinary letter's is exactly the difference of their
 * centroids: nothing is solved or searched, and two glyphs of near-identical
 * construction get near-identical values by construction. (Its predecessor
 * read each glyph's leftmost ink instead, which for a hairline crossbar
 * misaligns the stem the eye actually locks onto — an 'f' and a 't' came out
 * 104 thousandths apart.) The window makes P local: a light mark's perceived
 * position leans on the text beyond it, a letter's barely does.
 *
 * RESTRAINT. Ink outside the margin is far louder than white inside it, and
 * the centroid cannot see that asymmetry, so how far a glyph may travel is a
 * separate, purely geometric bound — anchored on the STEMS' INK LINE, not the
 * advance edge, because the ink line is what the eye reads as the margin. The
 * two anchors differ by a hair in a proportional face; in a monospace face the
 * stems sit a tenth of an advance inside their cells, and an advance-edge
 * bound licensed hangs the eye rejected (IBM Plex Mono 't', whose ink is
 * already the leftmost in the face, was hung further out). Outward, then: a
 * glyph may take its ink a small allowance past the stems' ink line — beyond
 * that only in the proportion its ink is too light to conspicuously cross,
 * which at the light end frees a stop to straddle the margin while a capital
 * T, with a feather-light edge but a letter's worth of ink, must keep that
 * ink in. The bound never goes below zero: geometry may refuse a hang, but
 * never demands ink outside the margin on its own.
 *
 * The ink line is the other end of that clamp, and it does more work than
 * "limit" suggests: it is a floor, so a glyph the face sets loose — a quote
 * or a stop, with far more side bearing than a stem — is brought OUT to it
 * even where the centroid asked for less, and that is where most of such a
 * mark's hang actually comes from. In the other direction it lets a glyph the
 * face draws to hang (a 't' whose crossbar starts at the origin) come back IN
 * until its ink lines up with a stem's, which is the one case that yields a
 * negative value. Tradition rarely indents, and a monospace face is a visible
 * cell grid rather than a set of proportional bearings, so negative values are
 * suppressed for monospace faces.
 *
 * NOISE. The letters that actually begin and end lines ought to need almost no
 * correction, so how far their readings scatter IS this measurement's error on
 * this face — a monospace face, whose narrow letters sit centred in a cell
 * while its wide ones fill it, scatters them by a whole pixel where a serif
 * scatters them by a tenth of that. Every reading passes through a smooth
 * shrinkage (a garrote) against that spread: a reading inside the noise is not
 * evidence of anything and goes to zero, a stop's many-sigma reading is barely
 * touched, and — unlike a hard cut — nothing sits on a cliff where two similar
 * glyphs land on opposite sides of the threshold.
 *
 * The centroid is not an analogy borrowed from typography: perceived position
 * IS the centroid of the stimulus, which is the standing result in the
 * psychophysics of visual localization (Whitaker & McGraw and successors,
 * where the centroid beat peak and points of inflexion as the primitive
 * determining perceived location). What this file adds to that is the window
 * and the restraint, both of which are typography rather than vision.
 *
 * Validation was done with external harnesses (a browser driving this module
 * over ~19 faces, against microtype's per-font configs and Hoefler Text's
 * `opbd`, plus a blurred-line-edge metric over a held-out corpus); they need
 * fonts and a served page, so they do not live in this repo and the numbers
 * below cannot be reproduced from it. Recorded for provenance rather than as
 * a claim the code substantiates: ~68‰ mean deviation from 320 hand-tuned
 * values where the nine-constant predecessor scored ~74‰, and a perceived
 * edge tighter than microtype's generic table on 148 of 228 held-out cells.
 * Those aggregate figures predate the later suppression of negative values
 * for monospace faces; proportional-face values are unchanged.
 * The tables remain much closer to each other than to any measurement (~34‰),
 * which is the honest shape of the result: measurement does not reproduce
 * hand-tuning, and gains concentrate in monospace and serif faces while sans
 * runs a few percent behind the generic table on that metric.
 *
 * What IS checkable here: the characters print tunes most carefully land on
 * print's own values — line-end 'r' near microtype's uniform 50‰, hyphens in
 * the 400–550‰ band print uses — and `test-e2e` pins the cross-engine and
 * cache behaviour.
 */

/**
 * How each constant was chosen matters, because the instruments available
 * answer different questions and cannot be swapped:
 *
 *   - The RESTRAINT constants (allowance, heft, the ceiling's anchors and the
 *     clamp's very shape) were chosen leave-one-face-out against the
 *     hand-tuned references (microtype's per-font configs, Hoefler's `opbd`)
 *     — the only instrument that sees ink leave the margin. The choice was
 *     unanimous across folds. The blur metric gets no vote here: it prefers
 *     protrusion without limit, so any restraint reads to it as a loss.
 *   - The WINDOW was chosen by the held-out blur metric (spread of perceived
 *     line edges over a corpus), the instrument for how a margin reads; its
 *     optimum is interior, both neighbours scoring worse.
 *   - The NOISE multiple is one standard error, fixed by principle: the
 *     references contain no monospace face — where the error lives — and pick
 *     zero unanimously, while the blur metric shares the model's estimator and
 *     prefers protrusion without limit. Neither can see this constant.
 */
/** Window decay length, in em: column ink at distance d from the margin
 * weighs exp(−d/λ) in the centroid. */
const LAMBDA_EM = 0.45;
/** Standard errors a reading is shrunk by (nonnegative garrote). */
const NOISE_K = 1;
/** Ink allowed past the stems' ink line for any glyph, as a fraction of the
 * em. */
const ALLOW_EM = 0.05;
/** Ink mass, against a lowercase 'n's, at which a glyph stops being light
 * enough to straddle the margin and must start keeping its ink inside. */
const HEFT_K = 0.3;
/** Raster size. Not the page's size: protrusion is scale-free. Larger than
 * reading size on purpose — one pixel at 16px is a tenth of a monospace
 * advance, which quantized those values into visible steps. */
const RASTER_PX = 32;
/** Lay raster cells out in a compact grid. Besides reducing readback work,
 * this keeps the canvas well inside conservative mobile texture limits. */
const RASTER_COLUMNS = 8;
/**
 * Alpha at which a rasterized pixel starts to count as ink, and the pedestal
 * subtracted from every pixel that clears it.
 *
 * Perceived position is not the centroid of all the light: it is the centroid
 * taken "between limits defined by contrast threshold" (Whitaker & McGraw
 * 1998), and their model both truncates at that threshold AND subtracts it
 * from the profile inside the integral, which is what makes perceived offset
 * fall to zero as a stimulus approaches its own detection threshold. Here
 * that is `max(0, α − INK_PRESENT)` in the centroid. The geometry pass shares
 * the threshold but not the subtraction — it asks only which pixels are ink,
 * to total a glyph's mass and find its centre, and a pedestal there would
 * just scale both.
 *
 * Practically it is the antialiased fringe this suppresses — which is most of
 * the raster of a hairline crossbar, and therefore most of what made an 'f'
 * and a 't' disagree. An exponent on coverage suppresses the fringe about
 * equally well (measured), but coverage is a partial-AREA quantity, so the
 * physically faithful weight on it is linear; the threshold is where the
 * literature puts this behaviour, and it costs no extra parameter.
 *
 * The value is not delicate: anywhere from 0.08 to 0.4 scores the same on
 * both instruments (68.7–68.9‰ against the references, 148–150 of 228 cells
 * on the outcome metric), and 0.2 is the middle of that flat region.
 */
const INK_PRESENT = 0.2;
/** Lowercase letters whose advances change under any caps variant, used to
 * check that this canvas really applies the variant before trusting it. */
const CAPS_PROBE = "handgloves";
/** Stand-ins for "whatever follows a line's first glyph", averaged over, so
 * one glyph's value does not depend on one arbitrary neighbour. */
const TAILS = ["nono", "aese"];
const HEADS = ["onon", "esea"];
/** The reference for flush: common letters whose edge on this side is a plain
 * vertical stem. Their mean centroid defines where an ordinary letter's ink
 * sits, and their mean side bearing defines the ink line a glyph may indent
 * back to. */
const STEM_REFERENCE = { l: ["n", "h", "m", "u", "r", "b", "p", "k"], r: ["d", "h", "n", "m", "u", "l", "k", "q"] };
/** The letters that actually begin and end lines: their scatter is the
 * measurement's own noise on this face. */
const POPULATION = {
  l: ["t", "a", "s", "w", "o", "c", "n", "h", "d", "r", "i", "l", "f", "m", "p", "b", "e", "g"],
  r: ["e", "s", "d", "t", "n", "y", "r", "o", "l", "f", "h", "m", "a", "g", "k", "w", "p", "x"],
};
/** Characters that can begin or end a line and might want to hang. Letters and
 * digits are included because the whole point is to discover, not assume,
 * which shapes need it; anything absent inherits via `protrusionCodes`. */
const CANDIDATES = [
  ...`“”‘’"'.,;:!?-–—‐()[]{}«»‹›¡¿*/@%~_+‚„<>\\|=&`,
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."0123456789",
];

/**
 * The characters a measured table forms an opinion about. Callers need this
 * to tell "measured zero" (this glyph needs no hang) from "never examined"
 * (the raster pass has no candidate for it, as with the RTL stops), since
 * only the latter should fall back to a table.
 */
export const opticalCandidates: readonly string[] = CANDIDATES;

let shared: CanvasRenderingContext2D | null = null;
let unavailable = false;

/** Element-backed, like measure.ts — Firefox's OffscreenCanvas desyncs font
 * state. */
function context(): CanvasRenderingContext2D | null {
  if (unavailable) return null;
  if (shared !== null) return shared;
  try {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (ctx === null) {
      unavailable = true;
      return null;
    }
    shared = ctx;
    return shared;
  } catch {
    unavailable = true;
    return null;
  }
}

const cache = new Map<string, ProtrusionTable | undefined>();

/**
 * Drop every measured table. Callers MUST do this whenever the fonts on the
 * page may have changed: a table measured before a webfont arrived describes
 * the FALLBACK's glyphs, and nothing about the spec — which names only the
 * family — distinguishes the two, so the stale table would otherwise be
 * served against the loaded face forever. This is the same hazard that makes
 * measure.ts and calibrate.ts drop their caches on `loadingdone`.
 */
export function clearOpticalCache(): void {
  cache.clear();
}

/**
 * Everything about a spec that can change a glyph's SHAPE, and so its measured
 * table — ignoring the size and spacing the page uses, since protrusion is
 * expressed in thousandths of an advance and letter/word spacing do not change
 * shapes. Exported because any cache keyed more loosely than this one silently
 * serves one variant's table for another: small caps and lowercase are
 * different glyphs at the same family, weight and style.
 *
 * It errs toward including too much. `stretch` and `variationSettings` cannot
 * be applied to a canvas at all (no API for either), so today they can only
 * split the cache rather than change a value — but a spec that reaches here
 * differing in them is one the raster silently cannot honour, and keying them
 * apart is the conservative direction. Numerals, ligatures and feature
 * settings genuinely reshape candidates (old-style figures are the obvious
 * case, and digits are candidates), so they belong here outright.
 */
export function opticalFontKey(spec: OpticalFontSpec): string {
  return [
    `${spec.style} ${spec.weight} ${RASTER_PX}px ${spec.family}`,
    spec.stretch,
    spec.variationSettings,
    spec.variantCaps,
    spec.variantAlternates,
    spec.variantEastAsian,
    spec.variantPosition,
    spec.numeric,
    spec.ligatures,
    spec.featureSettings,
  ].join("|");
}

/**
 * A font to measure. Every field but `family` is optional and defaults to the
 * CSS initial value, so callers outside the library can ask for a face by
 * name; internally a full `FontSpec` satisfies it structurally.
 */
export interface OpticalFontSpec {
  /** A CSS family list; the first entry is what gets rasterized. */
  family: string;
  style?: string;
  weight?: string;
  stretch?: string;
  variationSettings?: string;
  variantCaps?: string;
  variantAlternates?: string;
  variantEastAsian?: string;
  variantPosition?: string;
  numeric?: string;
  ligatures?: string;
  featureSettings?: string;
}

/** CSS initial values, so a caller need only name a family. */
function fullSpec(spec: OpticalFontSpec): Required<OpticalFontSpec> {
  return {
    style: "normal",
    weight: "400",
    stretch: "100%",
    variationSettings: "normal",
    variantCaps: "normal",
    variantAlternates: "normal",
    variantEastAsian: "normal",
    variantPosition: "normal",
    numeric: "normal",
    ligatures: "normal",
    featureSettings: "normal",
    ...spec,
  };
}

/**
 * The measured protrusion table for a font, or undefined when the browser
 * cannot rasterize and read back (in which case callers keep their tables).
 * Cached per font, since a page has very few distinct ones.
 */
export function opticalProtrusion(input: OpticalFontSpec): ProtrusionTable | undefined {
  const spec = fullSpec(input);
  const key = opticalFontKey(spec);
  const hit = cache.get(key);
  if (hit !== undefined || cache.has(key)) return hit;
  const table = measure(spec);
  cache.set(key, table);
  return table;
}

function measure(spec: Required<OpticalFontSpec>): ProtrusionTable | undefined {
  const draw = context();
  if (draw === null) return undefined;
  const font = `${spec.style} ${spec.weight} ${RASTER_PX}px ${spec.family}`;
  const applyFont = (): void => {
    draw.font = font;
    draw.textBaseline = "alphabetic";
    // Explicit even for `normal`: engines disagree on whether assigning the
    // shorthand resets this canvas longhand, and this shared context must not
    // leak one measured variant into the next.
    draw.fontVariantCaps = spec.variantCaps as CanvasFontVariantCaps;
  };
  applyFont();
  /**
   * Memoized text metrics. The candidates are measured repeatedly — once for
   * their advance and again for their bearing, on each side — and a face with
   * many candidates spends real time in measureText for it (a quarter of the
   * whole measurement in WebKit).
   *
   * Valid for this call because the font never changes within it: every canvas
   * resize below resets the context and is immediately followed by
   * `applyFont()` restoring the identical string, and the caps probe measures
   * `draw` directly rather than through here, so its temporary font never
   * reaches the memo.
   */
  const metricsMemo = new Map<string, TextMetrics>();
  const metricsOf = (text: string): TextMetrics => {
    let box = metricsMemo.get(text);
    if (box === undefined) {
      box = draw.measureText(text);
      metricsMemo.set(text, box);
    }
    return box;
  };
  const advance = (text: string): number => metricsOf(text).width;
  if (advance("n") <= 0) return undefined;
  // A canvas that cannot shape this spec's font-variant would measure the
  // WRONG GLYPHS and cache them silently. WebKit has no canvas
  // `fontVariantCaps` at all, but assigning it still "works" — it becomes an
  // ordinary JS property that reads back the value it was given — so the
  // assignment and a readback both lie; only the rendered advance tells the
  // truth. measure.ts records the same rule for widths: caps support is
  // port-dependent and must never be assumed.
  if (spec.variantCaps !== "normal") {
    const variantWidth = draw.measureText(CAPS_PROBE).width;
    draw.font = `${spec.style} ${spec.weight} ${RASTER_PX}px ${spec.family}`;
    draw.fontVariantCaps = "normal";
    if (draw.measureText(CAPS_PROBE).width === variantWidth) return undefined;
    applyFont();
  }
  const monoAdvances = ["i", "W", ".", "m"].map(advance);
  const monospace =
    Math.max(...monoAdvances) - Math.min(...monoAdvances) <= 0.01;

  // Only the leading window is rasterized and read back.
  const pad = Math.round(RASTER_PX * 0.5); // ink hanging before the pen still counts
  const win = Math.round(RASTER_PX * 1.6);
  const strip = pad + win;
  const asc = Math.round(RASTER_PX * 1.05);
  const cellH = asc + Math.round(RASTER_PX * 0.4);
  const gridFor = (
    count: number,
  ): { columns: number; width: number; height: number } => {
    const columns = Math.min(RASTER_COLUMNS, Math.max(1, count));
    return {
      columns,
      width: strip * columns,
      height: cellH * Math.ceil(Math.max(1, count) / columns),
    };
  };
  /**
   * Reproduce the old one-column canvas boundary for every grid column.
   * Probe strings deliberately extend beyond the leading window; without a
   * horizontal clip their tail ink lands in the adjacent cell and receives
   * that cell's maximum centroid weight. Keep the full canvas height so
   * vertical raster behavior remains identical to the validated strip.
   */
  const fillClippedToColumn = (
    text: string,
    x: number,
    y: number,
    cellX: number,
    canvasHeight: number,
  ): void => {
    draw.save();
    draw.beginPath();
    draw.rect(cellX, 0, strip, canvasHeight);
    draw.clip();
    draw.fillText(text, x, y);
    draw.restore();
  };

  /**
   * Per-glyph geometry from single-glyph rasters: ink mass relative to a
   * lowercase 'n' and the centre of that ink, which together bound how far a
   * glyph may travel outward. Bearings come from measureText, not the raster,
   * so they are exact rather than pixel-quantized.
   */
  interface Geometry {
    mass: number;
    centre: number;
  }
  let geometry: Map<string, Geometry>;
  /**
   * The rows of a cell any candidate's ink can occupy, recorded while the
   * geometry pass is already reading every glyph. A cell is a whole ascender
   * plus descender tall, but no face fills it: roughly a third of its rows are
   * blank in every one, and the centroid pass — far the larger scan — can skip
   * them.
   *
   * Sound only because every glyph a centroid string can contain is itself a
   * candidate: TAILS and HEADS are built from letters that CANDIDATES already
   * covers, so this union bounds all the ink that pass can see. A stand-in
   * drawn from outside CANDIDATES would silently clip. The band is recorded
   * against `>=` where the centroid tests `>`, so it errs inclusive.
   */
  let bandTop = cellH;
  let bandBottom = -1;
  try {
    const glyphs = [...CANDIDATES, "n"];
    const grid = gridFor(glyphs.length);
    draw.canvas.width = grid.width;
    draw.canvas.height = grid.height;
    applyFont();
    draw.clearRect(0, 0, grid.width, grid.height);
    draw.fillStyle = "#000";
    glyphs.forEach((g, i) => {
      const cellX = (i % grid.columns) * strip;
      const cellY = Math.floor(i / grid.columns) * cellH;
      fillClippedToColumn(g, cellX + pad, cellY + asc, cellX, grid.height);
    });
    const img = draw.getImageData(0, 0, grid.width, grid.height);
    const measured = glyphs.map((g, i) => {
      let mass = 0;
      let moment = 0;
      const cellX = (i % grid.columns) * strip;
      const cellY = Math.floor(i / grid.columns) * cellH;
      for (let dy = 0; dy < cellH; dy++) {
        const row = (cellY + dy) * grid.width;
        for (let x = 0; x < strip; x++) {
          const a = img.data[(row + cellX + x) * 4 + 3]! / 255;
          if (a >= INK_PRESENT) {
            mass += a;
            moment += a * (x + 0.5 - pad);
            if (dy < bandTop) bandTop = dy;
            if (dy > bandBottom) bandBottom = dy;
          }
        }
      }
      // A glyph with an advance but NO ink — a space, or a face that renders
      // some candidate blank — has no position to measure. Marking it here
      // keeps it out of the table entirely; left to the arithmetic below it
      // would take mass 0, read as maximally light, and be granted a hang of
      // half its advance on the strength of the tail's ink alone.
      return mass > 0 ? { mass, centre: moment / mass } : null;
    });
    const nMass = measured[glyphs.length - 1]?.mass ?? 0;
    if (nMass <= 0) return undefined; // no ink for 'n': nothing to measure against
    geometry = new Map(
      glyphs.flatMap((g, i) => {
        const m = measured[i];
        return m === null || m === undefined ? [] : [[g, { centre: m.centre, mass: m.mass / nMass }] as const];
      }),
    );
  } catch {
    // A tainted or otherwise unreadable canvas: fall back to the tables.
    unavailable = true;
    return undefined;
  }

  /**
   * Ink centroid of the leading window, in raster px from the pen origin:
   * each column's ink weighted by exp(−d/λ) in its distance d from the
   * margin, summed over the stand-in contexts. Read from a SHARP raster —
   * this is a first moment, so it needs no blur to be smooth in the hang, and
   * blurring would only bleed neighbouring ink across the window edge.
   */
  const centroids = (strings: string[], side: "l" | "r"): Array<number | null> => {
    const grid = gridFor(strings.length);
    draw.canvas.width = grid.width;
    draw.canvas.height = grid.height;
    applyFont();
    draw.clearRect(0, 0, grid.width, grid.height);
    draw.fillStyle = "#000";
    strings.forEach((s, i) => {
      const cellX = (i % grid.columns) * strip;
      const cellY = Math.floor(i / grid.columns) * cellH;
      const x =
        side === "l"
          ? cellX + pad
          : cellX + strip - pad - advance(s);
      fillClippedToColumn(s, x, cellY + asc, cellX, grid.height);
    });
    const img = draw.getImageData(0, 0, grid.width, grid.height);
    // A row of the band at a time, not a column of the cell at a time: the
    // readback is row-major, so walking it by column strides a whole canvas
    // row per pixel and misses cache on every one. Each column still sums in
    // increasing-dy order, so the totals are bit-identical, not merely equal.
    // No recorded band means the geometry pass found no ink at all, which the
    // 'n' mass check already rejects; fall back to the whole cell regardless.
    const noBand = bandBottom < bandTop;
    const dy0 = noBand ? 0 : Math.max(0, bandTop - 1);
    const dy1 = noBand ? cellH - 1 : Math.min(cellH - 1, bandBottom + 1);
    const cols = new Float64Array(strip);
    return strings.map((_, i) => {
      let sum = 0;
      let moment = 0;
      const cellX = (i % grid.columns) * strip;
      const cellY = Math.floor(i / grid.columns) * cellH;
      cols.fill(0);
      for (let dy = dy0; dy <= dy1; dy++) {
        let at = ((cellY + dy) * grid.width + cellX) * 4 + 3;
        for (let x = 0; x < strip; x++, at += 4) {
          const a = img.data[at]! / 255;
          if (a > INK_PRESENT) cols[x] = cols[x]! + (a - INK_PRESENT);
        }
      }
      for (let x = 0; x < strip; x++) {
        // Distance from the pen origin into the line, on either side.
        const d = side === "l" ? x - pad : strip - pad - 1 - x;
        const w = cols[x]! * Math.exp(-Math.max(0, d) / RASTER_PX / LAMBDA_EM);
        sum += w;
        moment += w * (d + 0.5);
      }
      return sum > 0 ? moment / sum : null;
    });
  };

  const table: Record<string, { l?: number; r?: number }> = {};
  for (const side of ["l", "r"] as const) {
    const contexts = side === "l" ? TAILS : HEADS;
    const refSet = STEM_REFERENCE[side];
    const popSet = POPULATION[side];
    // Space-prefixed keys measure a letter AS A REFERENCE, separately from the
    // same letter as a candidate.
    const measuredAsReference = [...new Set([...refSet, ...popSet])].map((r) => ` ${r}`);
    const strings: string[] = [];
    const owner: string[] = [];
    for (const ch of [...CANDIDATES, ...measuredAsReference]) {
      const glyph = ch.startsWith(" ") ? ch.slice(1) : ch;
      for (const t of contexts) {
        strings.push(side === "l" ? glyph + t : t + glyph);
        owner.push(ch);
      }
    }
    let cells: Array<number | null>;
    try {
      cells = centroids(strings, side);
    } catch {
      unavailable = true;
      return undefined;
    }
    const sums = new Map<string, number[]>();
    cells.forEach((v, i) => {
      if (v === null) return;
      const rec = sums.get(owner[i]!) ?? [];
      rec.push(v);
      sums.set(owner[i]!, rec);
    });
    const meanOf = (k: string): number | null => {
      const rec = sums.get(k);
      if (rec === undefined || rec.length === 0) return null;
      return rec.reduce((a, b) => a + b, 0) / rec.length;
    };
    const refs = refSet.map((r) => meanOf(` ${r}`)).filter((v): v is number => v !== null);
    if (refs.length === 0) return undefined;
    const reference = refs.reduce((a, b) => a + b, 0) / refs.length;
    // The bearing a plain stem keeps, defining the ink line of a flush margin.
    applyFont();
    const bearingOf = (ch: string): number => {
      const box = metricsOf(ch);
      // Signed: negative when ink hangs before the pen (an italic 'f').
      return side === "l" ? -box.actualBoundingBoxLeft : advance(ch) - box.actualBoundingBoxRight;
    };
    const stemBearing = refSet.reduce((a, r) => a + bearingOf(r), 0) / refSet.length;
    /**
     * The noise floor: the spread of the letters that actually begin and end
     * lines. Reading one glyph's position finer than the letters' own scatter
     * would be reading noise — and in a monospace face that scatter is most of
     * what the centroid sees, since every advance is the same width whatever
     * the ink inside it does.
     */
    const pop = popSet.map((r) => meanOf(` ${r}`)).filter((v): v is number => v !== null);
    const popMean = pop.length > 0 ? pop.reduce((a, b) => a + b, 0) / pop.length : reference;
    const noise =
      pop.length < 2
        ? 0
        : NOISE_K * Math.sqrt(pop.reduce((sum, v) => sum + (v - popMean) ** 2, 0) / (pop.length - 1));
    for (const ch of CANDIDATES) {
      const mu = meanOf(ch);
      if (mu === null) continue;
      const adv = advance(ch);
      if (adv <= 0) continue;
      const geo = geometry.get(ch);
      if (geo === undefined) continue;
      // The reading: this glyph's perceived position against an ordinary
      // letter's, shrunk by the measurement's own noise. The garrote leaves a
      // stop's many-sigma reading nearly whole, zeroes anything inside the
      // noise, and has no cliff between the two.
      const raw = mu - reference;
      const read = raw * Math.max(0, 1 - (noise / (Math.abs(raw) || 1e-9)) ** 2);
      // The geometric bound, interpolating between two anchors by how light
      // the glyph is. Heavy end: ink up to the stems' ink line, since a
      // letter's ink crossing the line the eye reads as the margin is the
      // conspicuous failure. Light end: out to the centre of the glyph's own
      // ink, straddling the margin, which is every tradition's treatment of a
      // stop — a mark too light to read at full weight is not judged by the
      // stem line it cannot visually anchor. Both plus a small allowance,
      // never negative: geometry may refuse a hang, only the reading can ask
      // for an indent. Inward: back until its ink lines up with a stem's.
      const bearing = bearingOf(ch);
      const inkLine = bearing - stemBearing;
      const centre = side === "l" ? geo.centre : adv - geo.centre;
      const light = Math.exp(-((geo.mass / HEFT_K) ** 2));
      const ceiling = Math.max(0, (1 - light) * inkLine + light * centre + RASTER_PX * ALLOW_EM);
      const floor = Math.min(inkLine, ceiling);
      const permille = Math.round((Math.min(Math.max(read, floor), ceiling) / adv) * 1000);
      // A monospace face exposes its equal advances as a visible grid.
      // Indenting one glyph while its neighbours remain flush breaks that grid;
      // outward optical correction remains useful, inward correction does not.
      if (monospace && permille < 0) continue;
      if (Math.abs(permille) < 15) continue; // below the rendering threshold
      (table[ch] ??= {})[side] = permille;
    }
  }
  return Object.keys(table).length > 0 ? table : undefined;
}
