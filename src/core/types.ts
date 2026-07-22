/**
 * Core data model. Everything here is DOM-free: widths are px floats already
 * resolved by the measurement layer (or a test mock).
 */

export interface GlueSpec {
  width: number;
  stretch: number;
  shrink: number;
}

/**
 * One styling context inside a paragraph (the paragraph itself, an <em>, a
 * size change…). The measurement layer resolves fonts to these metrics; the
 * core never sees font names.
 */
export interface RunMetrics {
  /** Opaque cache key (family+weight+style+size+spacing). */
  fontKey: string;
  /** Inter-word glue for this run, derived from the measured space width. */
  space: GlueSpec;
  /** Advance of the hyphen glyph in this run. */
  hyphenWidth: number;
  /**
   * Measured width multipliers at the expansion endpoints: the ratio of a
   * calibration string's width at font-stretch (100 + 100·max)% and
   * (100 − 100·shrink)% to its width at 100%. 1 means the font does not
   * respond on that side (no usable wdth axis) and expansion is disabled for
   * boxes of this run in that direction.
   */
  ratioAtMax: number;
  ratioAtMin: number;
  /**
   * Measured width multipliers at each quantized font-stretch percent the
   * layout can emit (keys = percent values, e.g. 101.5). When present, the
   * per-line expansion gain uses these measurements instead of linear
   * interpolation between the endpoints.
   */
  expansionRatios?: ReadonlyMap<number, number>;
  /**
   * Suppress hyphenation inside this run (CSS `hyphens: none`, e.g. inline
   * code): the hyphenator is never called and soft hyphens are stripped
   * rather than honored. Breaks at explicit hyphens remain (browsers break
   * there regardless of the hyphens property).
   */
  noHyphens?: boolean;
  /**
   * Clamp protrusion so a glyph's ink stops at the margin instead of hanging
   * past it. Set for monospace runs: protrusion codes are advance-relative
   * and assume proportional side bearings, but monospace glyphs sit in wide
   * uniform cells, so the code-implied hang would push the ink visibly out
   * of the measure. The clamp needs `Measure.inkBearings`.
   */
  protrudeInkOnly?: boolean;
  /**
   * Hand-tuned protrusion table matched to this run's font (microtype's
   * per-font configs). Overrides BuildOptions.protrusion for this run;
   * absent → the paragraph-wide table applies.
   */
  protrusion?: ProtrusionTable;
  /** First-line variant of `protrusion` (see BuildOptions.protrusionFirst). */
  protrusionFirst?: ProtrusionTable;
  /**
   * Identity of this run's font family (stack), independent of style,
   * weight, and size. Word spaces BETWEEN runs of different families lose
   * their shrink (see BuildOptions.boundaryShrink): such boundaries are
   * where chips and pills live, and a shrunken gap there reads as the chip
   * fusing with its neighbors. Absent → boundaries are never detected.
   */
  familyKey?: string;
}

/** A piece of paragraph text in one run, in document order. */
export interface RunText {
  text: string;
  run: number;
  /**
   * UTF-16 range whose characters are rendered by a floated
   * `::first-letter` box and therefore contribute no width to the normal
   * inline flow. The box text is retained for DOM reconstruction; item
   * widths, expansion, and tracking are measured from the remaining text.
   */
  flowExclusion?: { start: number; end: number };
  /** Shorthand for suppressing character protrusion at both sides of every
   * Box produced by this piece (kept for headless callers). */
  paintedBox?: boolean;
  /** Side-specific forms of `paintedBox`. DOM scans use the fixed actual-edge
   * markers below instead, so internal slices retain glyph protrusion. */
  paintedStart?: boolean;
  paintedEnd?: boolean;
  /** Fixed line-start protrusion for a painted inline box, normally the
   * distance from its border edge through its inline-start padding to the
   * text. Unlike character codes, this value is already in px. */
  boxStartProtrusionPx?: number;
  /** Fixed line-end counterpart of `boxStartProtrusionPx`. Defined as 0
   * too: presence marks the actual final box of an unpadded painted inline. */
  boxEndProtrusionPx?: number;
  /**
   * Inline padding+border px preceding this piece's first box / following
   * its last box (an inline element's side extras, resolved by the reader).
   * Folded into the adjacent box's width: the extras are layout width that
   * travels with the element's first/last fragment — CSS
   * `box-decoration-break: slice` semantics, which is also how the DOM
   * writer's whole-element clones fragment across lines.
   */
  padStartPx?: number;
  padEndPx?: number;
  /**
   * Set when this piece lives inside a `white-space: nowrap` inline
   * element: no break opportunity may be created between two boxes that
   * share a key (spaces stay justification-flexible, they just cannot
   * break). Distinct elements get distinct keys, so the space BETWEEN two
   * adjacent nowrap chips remains breakable.
   */
  atomicKey?: number;
}

export const ItemType = {
  Box: 0,
  Glue: 1,
  Penalty: 2,
} as const;
export type ItemType = (typeof ItemType)[keyof typeof ItemType];

export interface Box {
  type: typeof ItemType.Box;
  /** Natural advance of `text` at font-stretch 100%, measured whole. */
  width: number;
  run: number;
  text: string;
  /** Number of rendered characters that remain in normal inline flow.
   * Absent when every character in `text` participates normally. */
  flowChars?: number;
  /** UTF-16 source range rendered by a floated `::first-letter` rather
   * than by the normal-flow nowrap segment. */
  flowExclusion?: { start: number; end: number };
  /** Protrusion credit (px) if this box starts a line after the first. */
  lp: number;
  /** Protrusion credit (px) if this box starts the paragraph's FIRST line
   * (differs from lp only under hangingPunctuation "first-line"). */
  lpFirst: number;
  /** Protrusion credit (px) if this box ends a line. */
  rp: number;
  /** This is the actual final box of a painted inline. Renderers use the
   * marker (independent of rp, which may legitimately be zero) to keep
   * wrap-safety margins outside the decoration instead of pinching it. */
  paintedEnd?: boolean;
  /** Extra stretch/shrink available from font expansion (px). */
  expStretch: number;
  expShrink: number;
  /** Extra stretch/shrink available from letterfit tracking (px); folded
   * into the glue sums because tracking flexes continuously with the same
   * ratio as glue. Rendered as per-segment letter-spacing. */
  trackStretch: number;
  trackShrink: number;
  /** Inline padding/border px folded into `width` (RunText extras). The
   * glyph run's own advance is width − padPx: expansion gain must scale
   * only the glyphs, never the box decorations. */
  padPx?: number;
}

export interface Glue {
  type: typeof ItemType.Glue;
  width: number;
  stretch: number;
  /** Infinite-order stretch; only the final parfillskip glue uses this. */
  stretchFil: number;
  shrink: number;
  run: number;
  /**
   * CJK inter-character glue: no source space exists here. Renderers must
   * not emit a space character for it — its flex renders as inter-character
   * spacing (letter-spacing) instead of word-spacing. Never breakable on
   * its own (buildItems
   * always puts a penalty in front of it, so the glue-after-box rule never
   * fires).
   */
  cjk?: boolean;
  /**
   * A word space at a font-family boundary whose shrink was reduced (see
   * BuildOptions.boundaryShrink). Renderers must give it its OWN
   * word-spacing: it shares a run — and would otherwise share a rendered
   * segment — with fully shrinkable interior spaces.
   */
  rigid?: boolean;
}

export interface Penalty {
  type: typeof ItemType.Penalty;
  /** −INF_PENALTY … +INF_PENALTY. */
  penalty: number;
  /** Width added to the line if broken here (the hyphen glyph). */
  width: number;
  /** True for hyphen-ish breaks; consecutive flagged lines incur demerits. */
  flagged: boolean;
  /** True only for breaks inserted by the hyphenator (masked in pass 1). */
  hyphen: boolean;
  /** Protrusion credit of the materialized hyphen if the line ends here. */
  rp: number;
  run: number;
  /**
   * CJK inter-character break: the break site has NO source space, so a
   * line broken here must render a bare <wbr> joint, never a space. This is
   * what distinguishes it from other unflagged zero-width penalties (from
   * hand-built withSums streams), which sit at real spaces and must keep
   * rendering the space they consumed.
   */
  cjk?: boolean;
}

export type Item = Box | Glue | Penalty;

/** Protrusion codes in thousandths of the glyph's own advance (pdfTeX).
 * `l`/`r` are LOGICAL line-start/line-end sides: the renderer maps them to
 * physical margins via inline-start/end, so in an RTL paragraph an `l`
 * code hangs at the right edge and an `r` code at the left. */
export interface ProtrusionCodes {
  l?: number;
  r?: number;
}

export type ProtrusionTable = Readonly<Record<string, ProtrusionCodes>>;

export interface ExpansionOptions {
  /** Max glyph stretch as a fraction (0.02 → font-stretch up to 102%). */
  max: number;
  /** Max glyph shrink as a fraction (0.02 → down to 98%). */
  shrink: number;
  /** Quantization step as a fraction (0.005 → 0.5% increments). */
  step: number;
}

export interface BuildOptions {
  /** Splits a lowercase word into syllable pieces. Soft hyphens always win. */
  hyphenate?: (word: string) => readonly string[];
  hyphenPenalty: number;
  /** Penalty for breaking after an explicit "-" already in the text. */
  exHyphenPenalty: number;
  protrusion: ProtrusionTable | false;
  /** Table for boxes starting the paragraph's FIRST line (full hanging
   * punctuation on opening quotes/brackets). undefined → same as
   * `protrusion`. */
  protrusionFirst?: ProtrusionTable;
  expansion: ExpansionOptions | false;
  /** Letterfit tracking: inter-character space may open/close each line's
   * set width by these fractions (Bringhurst's tolerance is 0.03). Off by
   * default — word space and expansion are the primary flexes; TeX has no
   * equivalent (its letterspacing is static styling, not a per-line,
   * break-participating variable). */
  tracking: TrackingOptions | false;
  /**
   * eTeX-style \lastlinefit, layout-only: the last line's spaces are set
   * at this fraction of the paragraph's average adjustment ratio, so a
   * loose (or tight) paragraph doesn't end on a jarringly natural-width
   * line. 0 (default) = classic TeX, last line at natural width; 1 = the
   * ending fully adopts the paragraph's color. Capped at a fully
   * justified ending; the last line's letterfit stays natural.
   */
  lastLineFit: number;
  /**
   * Rendering floor for the paragraph ending, as a fraction of the
   * measure: a last line shorter than this stretches its word glue up to
   * the threshold (letterfit stays natural, as with `lastLineFit`) — but
   * only when the threshold is reachable within maxEndingStretch(v), the
   * v-scaled underfull bound. An ending that cannot reach it reverts to
   * natural spacing entirely: all or nothing, never stretched AND still
   * short. 1 sets every paragraph as a rectangle. Set
   * `BreakOptions.lastLineMinWidth` to the same value for the matching
   * render-aware break pressure (the public API does). 0 disables.
   */
  lastLineMinWidth: number;
  /**
   * Shrink multiplier for word spaces at font-FAMILY boundaries (runs with
   * differing `familyKey`). 0 (default): such spaces stretch but never
   * shrink — chips and pills (inline code, <kbd>) live at family
   * boundaries, their visual insets occupy part of the adjacent gap, and a
   * shrunken gap there fuses the chip with its neighbors. Native CSS
   * justification never shrinks spaces, so this also keeps chip gaps at
   * parity with the no-JS rendering. 1 restores TeX semantics (glue is
   * glue, wherever it sits); deliberate deviation otherwise.
   */
  boundaryShrink: number;
}

export interface TrackingOptions {
  /** Max letterfit opening as a fraction of the line's set width. */
  max: number;
  /** Max letterfit closing as a fraction of the line's set width. */
  shrink: number;
}

export interface BreakOptions {
  tolerance: number;
  /** Pass-1 (hyphenless) tolerance; < 0 skips pass 1. */
  pretolerance: number;
  linePenalty: number;
  adjDemerits: number;
  doubleHyphenDemerits: number;
  finalHyphenDemerits: number;
  /** Extra badness-only stretch for pass 3; "auto" = 12× the dominant
   * space width (≈ TeX's 3em \emergencystretch). */
  emergencyStretch: number | "auto";
  /**
   * Break-choice pressure toward paragraph endings at least this fraction
   * of the measure (0 = off, classic TeX: any ending length is free). The
   * cost model is RENDER-AWARE — it prices exactly what layoutLines will
   * do with the same value in `BuildOptions.lastLineMinWidth`: an ending
   * at or past the threshold is free; below it, the cost is the badness
   * of the word-glue stretch the render floor would apply (100·r³ with
   * r = shortfall / the ending's own glue stretch), one continuous curve
   * that automatically prices reachable endings below unreachable ones.
   * Two-phase, paragraph-level all-or-nothing: a strict RECTANGLE HUNT
   * first (the ending must be render-reachable or tolerance-cheap; body
   * lines bind at the normal tolerances), then — when no rectangle exists
   * without a worse-than-tolerance line — a compare-and-pick fallback:
   * a bounded-preference ladder (ending exempt, cost capped at INF_BAD)
   * races the exact option-off ladder, and its solution is kept only if
   * it renders a strictly longer ending, so the option can never yield a
   * shorter ending than off. Set both options to the same value; the
   * public API does.
   */
  lastLineMinWidth: number;
}

export const defaultBuildOptions: BuildOptions = {
  hyphenPenalty: 50,
  exHyphenPenalty: 50,
  protrusion: false,
  expansion: false,
  tracking: false,
  lastLineFit: 0,
  lastLineMinWidth: 0,
  boundaryShrink: 0,
};

export const defaultBreakOptions: BreakOptions = {
  tolerance: 200,
  pretolerance: 100,
  linePenalty: 10,
  adjDemerits: 10000,
  doubleHyphenDemerits: 10000,
  finalHyphenDemerits: 5000,
  emergencyStretch: "auto",
  lastLineMinWidth: 0,
};

export interface Measure {
  /** Advance of `text` (measured whole, kerning-correct) at 100% stretch. */
  width(text: string, run: RunMetrics): number;
  /** Advance of a single character, for protrusion credit. */
  charAdvance(ch: string, run: RunMetrics): number;
  /**
   * Distance from the advance-box edges to the glyph's ink (side bearings,
   * ≥ 0), for runs with `protrudeInkOnly`. Optional: when absent, protrusion
   * is never clamped.
   */
  inkBearings?(ch: string, run: RunMetrics): { l: number; r: number };
}

/**
 * The item stream plus cumulative sums (over items[0..i)) that make every
 * line measure an O(1) subtraction inside the breaker.
 */
export interface ParagraphItems {
  items: Item[];
  runs: readonly RunMetrics[];
  cumW: Float64Array;
  cumY: Float64Array;
  cumYfil: Float64Array;
  cumZ: Float64Array;
  cumExpY: Float64Array;
  cumExpZ: Float64Array;
  /** Tracking component of cumY (already included there), so the layout
   * can saturate tracking at its budget on stretch ratios beyond 1. The
   * shrink side needs no twin: the −1 glue clamp already bounds it. */
  cumTrackY: Float64Array;
  /** Index of the first box at or after item i (items.length if none). */
  firstBoxAfter: Int32Array;
}

/** Target width per line index (constant, or varying e.g. for text-indent). */
export type LineWidths = number | readonly number[];

export interface BreakResult {
  /** Item indices of the chosen breakpoints, ascending; last is the final forced penalty. */
  breakpoints: number[];
  /**
   * Which pass's tolerance produced the result. When even the final pass
   * finds no feasible path, the rescue (artificial-demerits) pass reruns
   * with tolerance opened to INF_BAD and reports the failed pass's number
   * — check `overfull` to detect rescued lines.
   */
  pass: 1 | 2 | 3;
  /** True per line that could not be fit within shrink limits. */
  overfull: boolean[];
  /**
   * The lastLineMinWidth threshold this solution was found under —
   * normally the requested value, LOWER when the rectangle hunt had to
   * descend (no arrangement reached the requested threshold within
   * tolerance, so the breaker retreated to the fullest ending it could
   * afford instead of collapsing to the option-off breaks). layoutLines
   * applies the render floor at this value.
   */
  endingMinWidth?: number;
  /** Total demerits of the chosen path (diagnostics, oracle tests). */
  demerits: number;
}

export interface Line {
  /**
   * Line content is items[start..end), with trailing penalties and the
   * parfillskip glue already trimmed off (`end` equals the breakpoint item
   * except on the last line).
   */
  start: number;
  end: number;
  /** True when a hyphen glyph must be rendered at the end of this line. */
  hyphenated: boolean;
  /** Adjustment ratio the breaker optimized (diagnostics). */
  ratio: number;
  /** CSS font-stretch percent for the whole line; 100 = natural. */
  fontStretch: number;
  /** Per-space width = space.width + glueRatio·(glueRatio ≥ 0 ? stretch : shrink). */
  glueRatio: number;
  /**
   * Ratio applied to the boxes' letterfit tracking flex. Equals glueRatio
   * within [−1, 1]; beyond that it normally SATURATES at ±1 — tracking is a
   * hard budget (Bringhurst's ±3%), while spaces stretch on past their
   * nominal flexibility (they just cost badness). The sole exception is an
   * otherwise-overfull single painted token with protrusion disabled: it may
   * close to −2 so fixed halo padding stays inside the measure. glueRatio is
   * recomputed over the glue-only pool for ordinary saturated lines.
   * Fil (paragraph-ending) lines keep natural letterfit on the stretch
   * side (0 for a ragged or lastLineFit-colored ending) but equal
   * glueRatio when the ending shrinks — the breaker priced that shrink
   * against the pooled flex, tracking included.
   */
  trackRatio: number;
  /** Px the first glyph protrudes into the line-START margin (left in
   * LTR, right in RTL). */
  leftHang: number;
  /** Px the last glyph (or hyphen) protrudes past the line-END edge
   * (right in LTR, left in RTL). */
  rightHang: number;
  overfull: boolean;
  /**
   * Px by which the rendered line exceeds its target width (0 for normal
   * lines; positive for overfull lines whose glue hit the shrink limit).
   * Renderers can use it to keep overfull lines from re-wrapping.
   */
  overflowPx: number;
  /** Target width this line was set to. */
  width: number;
}

export function lineWidthAt(widths: LineWidths, line: number): number {
  if (typeof widths === "number") return widths;
  return widths[Math.min(line, widths.length - 1)] ?? 0;
}
