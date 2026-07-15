/**
 * Canvas-based text measurement. Everything is measured once at
 * font-stretch 100% (canvas cannot vary wdth — see calibrate.ts for how
 * expansion widths are derived) and cached module-globally, so repeated
 * words across a document cost one measureText total.
 */

export interface FontSpec {
  style: string;
  weight: string;
  sizePx: number;
  family: string;
  letterSpacingPx: number;
  wordSpacingPx: number;
  /** The author's own font-stretch, e.g. "100%". */
  stretch: string;
  /** Computed font-variation-settings ("normal" when unset). */
  variationSettings: string;
  variantCaps: string;
  /** Computed `hyphens` ("manual" default); "none" suppresses hyphenation
   * in this run. Not part of the cache key — it doesn't affect widths. */
  hyphens: string;
  /** Computed font-variant-ligatures; canvas can only shape with the
   * font's DEFAULT ligatures, so anything but "normal" is unsupported. */
  ligatures: string;
  /** Computed font-feature-settings; same constraint as ligatures. */
  featureSettings: string;
  /** Computed font-variant-numeric; oldstyle/tabular overrides change digit
   * advances canvas cannot reproduce — same constraint as ligatures. */
  numeric: string;
  /** Canonical cache key. */
  key: string;
}

export function fontSpecOf(style: CSSStyleDeclaration): FontSpec {
  const letterSpacing = style.letterSpacing === "normal" ? 0 : parseFloat(style.letterSpacing) || 0;
  const wordSpacing = parseFloat(style.wordSpacing) || 0;
  const spec: FontSpec = {
    style: style.fontStyle,
    weight: style.fontWeight,
    sizePx: parseFloat(style.fontSize) || 16,
    family: style.fontFamily,
    letterSpacingPx: letterSpacing,
    wordSpacingPx: wordSpacing,
    stretch: style.fontStretch || "100%",
    variationSettings: style.fontVariationSettings || "normal",
    variantCaps: style.fontVariantCaps || "normal",
    hyphens:
      style.hyphens ||
      (style as CSSStyleDeclaration & { webkitHyphens?: string }).webkitHyphens ||
      "manual",
    ligatures: style.fontVariantLigatures || "normal",
    featureSettings: style.fontFeatureSettings || "normal",
    numeric: style.fontVariantNumeric || "normal",
    key: "",
  };
  spec.key = [
    spec.style,
    spec.weight,
    spec.sizePx,
    spec.family,
    spec.letterSpacingPx,
    spec.wordSpacingPx,
    spec.stretch,
    spec.variationSettings,
    spec.variantCaps,
  ].join("|");
  return spec;
}

/** The canvas shorthand accepts style/weight/size/family only. */
export function ctxFontOf(spec: FontSpec): string {
  const style = spec.style === "normal" ? "" : spec.style + " ";
  const weight = spec.weight === "400" || spec.weight === "normal" ? "" : spec.weight + " ";
  return `${style}${weight}${spec.sizePx}px ${spec.family}`;
}

type MeasureCtx = CanvasRenderingContext2D;

let sharedCtx: MeasureCtx | null = null;
let currentKey = "";

function getCtx(): MeasureCtx {
  if (sharedCtx === null) {
    // Prefer a regular canvas: Firefox's OffscreenCanvas 2D context desyncs
    // its font state after fontVariantCaps changes — resetting it back to
    // "normal" (and reassigning .font) leaves SHAPING in small-caps while
    // the getters read normal, silently inflating every subsequent
    // measurement by the small-caps delta. Element-backed contexts behave
    // correctly in every engine; OffscreenCanvas is only the no-DOM fallback.
    const canvas =
      typeof document !== "undefined"
        ? document.createElement("canvas")
        : new OffscreenCanvas(0, 0);
    sharedCtx = (canvas as HTMLCanvasElement).getContext("2d") as unknown as MeasureCtx;
    if (sharedCtx === null) throw new Error("justif: no 2d canvas context");
  }
  return sharedCtx;
}

function setFont(ctx: MeasureCtx, spec: FontSpec): void {
  if (currentKey === spec.key) return;
  ctx.font = ctxFontOf(spec);
  if ("letterSpacing" in ctx) ctx.letterSpacing = spec.letterSpacingPx + "px";
  if ("wordSpacing" in ctx) ctx.wordSpacing = spec.wordSpacingPx + "px";
  // Always reset caps state: it is independent canvas state, not part of
  // the font shorthand, and a stale small-caps value would poison every
  // later measurement (surviving even clearMeasureCache).
  if ("fontVariantCaps" in ctx) {
    try {
      ctx.fontVariantCaps = spec.variantCaps as CanvasFontVariantCaps;
    } catch {
      ctx.fontVariantCaps = "normal";
    }
  }
  currentKey = spec.key;
}

/** Paragraphs whose styling canvas cannot reproduce must bail. */
export function supportsSpec(spec: FontSpec): boolean {
  if (spec.variantCaps !== "normal" && !("fontVariantCaps" in getCtx())) return false;
  // Canvas always shapes with the font's default ligatures/features — there
  // is no API to vary them — so author overrides would make every DOM width
  // differ from its measurement.
  if (spec.ligatures !== "normal") return false;
  if (spec.featureSettings !== "normal") return false;
  if (spec.numeric !== "normal") return false;
  // Canvas measures at default stretch with no variation settings: an
  // author-condensed/expanded or variation-pinned run would make every
  // width wrong by the axis delta.
  if (spec.stretch !== "100%" && spec.stretch !== "normal") return false;
  if (spec.variationSettings !== "normal") return false;
  return true;
}

const widthCache = new Map<string, Map<string, number>>();
let segmenter: Intl.Segmenter | null | undefined;

function graphemeCount(text: string): number {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter() : null;
  }
  if (segmenter === null) return Array.from(text).length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** Advance of `text` under `spec` at font-stretch 100%, CSS px. */
export function measureWidth(text: string, spec: FontSpec): number {
  let perFont = widthCache.get(spec.key);
  if (perFont === undefined) {
    perFont = new Map();
    widthCache.set(spec.key, perFont);
  }
  const hit = perFont.get(text);
  if (hit !== undefined) return hit;

  const ctx = getCtx();
  setFont(ctx, spec);
  let width = ctx.measureText(text).width;
  if (!("letterSpacing" in ctx)) {
    // Arithmetic fallback (pre-2025 Safari): CSS adds tracking after every
    // grapheme and word-spacing to every space.
    if (spec.letterSpacingPx !== 0) width += spec.letterSpacingPx * graphemeCount(text);
    if (spec.wordSpacingPx !== 0) {
      let spaces = 0;
      for (const ch of text) if (ch === " " || ch === "\u00A0") spaces++;
      width += spec.wordSpacingPx * spaces;
    }
  }
  perFont.set(text, width);
  return width;
}

const bearingCache = new Map<string, Map<string, { l: number; r: number }>>();

/**
 * Side bearings of `ch`: distance from each edge of the advance box to the
 * glyph's ink (clamped ≥ 0 when ink spills past the box, as with italics).
 * Used to stop protrusion at the ink edge for monospace runs.
 */
export function measureInkBearings(ch: string, spec: FontSpec): { l: number; r: number } {
  let perFont = bearingCache.get(spec.key);
  if (perFont === undefined) {
    perFont = new Map();
    bearingCache.set(spec.key, perFont);
  }
  const hit = perFont.get(ch);
  if (hit !== undefined) return hit;

  const ctx = getCtx();
  setFont(ctx, spec);
  const m = ctx.measureText(ch);
  // actualBoundingBoxLeft is positive when ink extends LEFT of the origin,
  // so the left bearing (origin → ink) is its negation.
  const bearings = {
    l: Math.max(0, -m.actualBoundingBoxLeft),
    r: Math.max(0, m.width - m.actualBoundingBoxRight),
  };
  perFont.set(ch, bearings);
  return bearings;
}

/** True when the font is fixed-pitch (every glyph shares one advance). */
export function isMonospace(spec: FontSpec): boolean {
  return Math.abs(measureWidth("i", spec) - measureWidth("M", spec)) < 0.01;
}

/** Drop cached measurements (call when webfonts finish loading). */
export function clearMeasureCache(): void {
  widthCache.clear();
  bearingCache.clear();
  currentKey = "";
}
