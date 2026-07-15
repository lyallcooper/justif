/**
 * Cached text measurement at font-stretch 100%. Ordinary runs use canvas;
 * variants and OpenType features canvas cannot express use batched DOM
 * probes. See calibrate.ts for expansion widths.
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
  /** Every computed font-variant longhand. These participate in the cache
   * key because OpenType substitutions can change glyph advances. */
  variantAlternates: string;
  variantCaps: string;
  variantEastAsian: string;
  variantEmoji: string;
  /** Computed `hyphens` ("manual" default); "none" suppresses hyphenation
   * in this run. Not part of the cache key — it doesn't affect widths. */
  hyphens: string;
  /** Computed font-variant-ligatures. */
  ligatures: string;
  /** Computed font-feature-settings. */
  featureSettings: string;
  /** Computed font-variant-numeric. */
  numeric: string;
  variantPosition: string;
  /**
   * Computed direction, applied as canvas context state so RTL words are
   * shaped under the same base direction the DOM renders them with.
   * Deliberately NOT part of the cache key: measureText advances are
   * direction-independent in every engine — words are measured whole, so
   * Arabic joining and bidi-neutral reordering are internal to the string
   * and cannot change its total advance (verified empirically across
   * chromium/firefox/webkit for pointed Hebrew, joined Arabic, digits and
   * mirrored brackets; enforced by an e2e guard test).
   */
  direction: "ltr" | "rtl";
  /** Canonical cache key. */
  key: string;
}

export function fontSpecOf(style: CSSStyleDeclaration): FontSpec {
  const letterSpacing = style.letterSpacing === "normal" ? 0 : parseFloat(style.letterSpacing) || 0;
  const wordSpacing = parseFloat(style.wordSpacing) || 0;
  const computed = (property: string, fallback = "normal"): string =>
    style.getPropertyValue(property).trim() || fallback;
  const spec: FontSpec = {
    style: style.fontStyle,
    weight: style.fontWeight,
    sizePx: parseFloat(style.fontSize) || 16,
    family: style.fontFamily,
    letterSpacingPx: letterSpacing,
    wordSpacingPx: wordSpacing,
    stretch: style.fontStretch || "100%",
    variationSettings: style.fontVariationSettings || "normal",
    variantAlternates: computed("font-variant-alternates"),
    variantCaps: computed("font-variant-caps"),
    variantEastAsian: computed("font-variant-east-asian"),
    // font-variant-emoji is newer than the other longhands and is absent
    // from older CSSStyleDeclaration typings/engines. An unsupported
    // property computes to the same effective initial value.
    variantEmoji: computed("font-variant-emoji"),
    hyphens:
      style.hyphens ||
      (style as CSSStyleDeclaration & { webkitHyphens?: string }).webkitHyphens ||
      "manual",
    ligatures: computed("font-variant-ligatures"),
    featureSettings: computed("font-feature-settings"),
    numeric: computed("font-variant-numeric"),
    variantPosition: computed("font-variant-position"),
    direction: style.direction === "rtl" ? "rtl" : "ltr",
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
    spec.variantAlternates,
    spec.variantCaps,
    spec.variantEastAsian,
    spec.variantEmoji,
    spec.ligatures,
    spec.featureSettings,
    spec.numeric,
    spec.variantPosition,
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
/** Tracked separately from the key (direction is not in it — see FontSpec). */
let currentDirection: "ltr" | "rtl" = "ltr";

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
  if (currentKey === spec.key && currentDirection === spec.direction) return;
  // Base direction for shaping; the default "inherit" would follow the
  // (detached) canvas element rather than the run being measured.
  if ("direction" in ctx) ctx.direction = spec.direction;
  currentDirection = spec.direction;
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

/** Apply every width-affecting font property represented by FontSpec to a
 * DOM probe. The low-level feature setting is deliberately written after
 * the font-variant longhands, matching the cascade already computed on the
 * source run and OpenType's feature resolution order. */
export function applyFontSpec(el: HTMLElement, spec: FontSpec): void {
  el.style.fontStyle = spec.style;
  el.style.fontWeight = spec.weight;
  el.style.fontSize = spec.sizePx + "px";
  el.style.fontFamily = spec.family;
  el.style.letterSpacing = spec.letterSpacingPx + "px";
  el.style.wordSpacing = spec.wordSpacingPx + "px";
  el.style.direction = spec.direction;
  el.style.fontStretch = spec.stretch;
  el.style.fontVariationSettings = spec.variationSettings;
  el.style.setProperty("font-variant-alternates", spec.variantAlternates);
  el.style.setProperty("font-variant-caps", spec.variantCaps);
  el.style.setProperty("font-variant-east-asian", spec.variantEastAsian);
  el.style.setProperty("font-variant-emoji", spec.variantEmoji);
  el.style.setProperty("font-variant-ligatures", spec.ligatures);
  el.style.setProperty("font-variant-numeric", spec.numeric);
  el.style.setProperty("font-variant-position", spec.variantPosition);
  el.style.setProperty("font-feature-settings", spec.featureSettings);
}

/** True when the run needs the DOM shaper rather than canvas measureText.
 * Canvas exposes only caps variants, and even that property is absent in
 * WebKit. All other variant/feature values are measured in a styled DOM
 * probe so their actual substitutions and advances are honored. */
export function requiresDomMeasurement(spec: FontSpec): boolean {
  if (spec.variantCaps !== "normal" && !("fontVariantCaps" in getCtx())) return true;
  return (
    spec.variantAlternates !== "normal" ||
    spec.variantEastAsian !== "normal" ||
    spec.variantEmoji !== "normal" ||
    spec.ligatures !== "normal" ||
    spec.featureSettings !== "normal" ||
    spec.numeric !== "normal" ||
    spec.variantPosition !== "normal"
  );
}

/** Paragraphs whose styling neither measurement path can reproduce bail. */
export function supportsSpec(spec: FontSpec): boolean {
  // Canvas measures at default stretch with no variation settings: an
  // author-condensed/expanded or variation-pinned run is still outside the
  // expansion model: our per-line font-stretch would overwrite it.
  if (spec.stretch !== "100%" && spec.stretch !== "normal") return false;
  if (spec.variationSettings !== "normal") return false;
  return true;
}

const widthCache = new Map<string, Map<string, number>>();
const domWidthCache = new Map<string, Map<string, number>>();
const pendingDomWidths = new Map<string, { spec: FontSpec; texts: Set<string> }>();
let collectingDomWidths = false;
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

/** Canvas advance under `spec`. Used directly for ordinary runs and as a
 * throwaway estimate while discovering all strings a DOM-measured
 * paragraph will need. */
function measureCanvasWidth(text: string, spec: FontSpec): number {
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

function cachedDomWidth(text: string, spec: FontSpec): number | undefined {
  return domWidthCache.get(spec.key)?.get(text);
}

function queueDomWidth(text: string, spec: FontSpec): void {
  let pending = pendingDomWidths.get(spec.key);
  if (pending === undefined) {
    pending = { spec, texts: new Set() };
    pendingDomWidths.set(spec.key, pending);
  }
  pending.texts.add(text);
}

/** Measure all queued variant-bearing strings in one DOM layout. */
function flushDomWidths(): void {
  if (pendingDomWidths.size === 0) return;
  if (typeof document === "undefined" || document.body === null) {
    pendingDomWidths.clear();
    return;
  }

  const host = document.createElement("div");
  host.style.cssText =
    "position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;" +
    "white-space:pre;width:max-content;contain:layout style paint;";
  const probes: Array<{ span: HTMLSpanElement; text: string; spec: FontSpec }> = [];

  for (const { spec, texts } of pendingDomWidths.values()) {
    let perFont = domWidthCache.get(spec.key);
    if (perFont === undefined) {
      perFont = new Map();
      domWidthCache.set(spec.key, perFont);
    }
    for (const text of texts) {
      if (perFont.has(text)) continue;
      if (text.length === 0) {
        perFont.set(text, 0);
        continue;
      }
      const span = document.createElement("span");
      applyFontSpec(span, spec);
      span.style.display = "block";
      span.style.width = "max-content";
      span.style.whiteSpace = "pre";
      span.textContent = text;
      host.append(span);
      probes.push({ span, text, spec });
    }
  }
  pendingDomWidths.clear();
  document.body.append(host);
  try {
    // Appending every probe before the first read lets the engine shape and
    // lay them out as one batch rather than forcing a layout per word.
    for (const { span, text, spec } of probes) {
      domWidthCache.get(spec.key)!.set(text, span.getBoundingClientRect().width);
    }
  } finally {
    host.remove();
  }
}

/**
 * Run a discovery pass, then resolve all DOM-only measurements together.
 * The callback's results are intentionally disposable: uncached variant
 * widths use canvas estimates during discovery and become exact only after
 * this function returns.
 */
export function collectDomMeasurements<T>(work: () => T): T {
  if (collectingDomWidths) return work();
  collectingDomWidths = true;
  try {
    return work();
  } finally {
    collectingDomWidths = false;
    flushDomWidths();
  }
}

/** Advance of `text` under `spec` at font-stretch 100%, CSS px. */
export function measureWidth(text: string, spec: FontSpec): number {
  if (!requiresDomMeasurement(spec)) return measureCanvasWidth(text, spec);

  const hit = cachedDomWidth(text, spec);
  if (hit !== undefined) return hit;
  queueDomWidth(text, spec);
  if (collectingDomWidths) return measureCanvasWidth(text, spec);

  // A correctly integrated paragraph will have discovered this string in a
  // batch. Keep the primitive safe for direct callers and unusual late
  // paths by resolving a cache miss immediately.
  flushDomWidths();
  return cachedDomWidth(text, spec) ?? measureCanvasWidth(text, spec);
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
  domWidthCache.clear();
  pendingDomWidths.clear();
  bearingCache.clear();
  currentKey = "";
}
