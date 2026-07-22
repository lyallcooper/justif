import { graphemes } from "../core/cjk.js";
import { textMakesBox } from "../core/items.js";
import { type FontSpec, fontSpecOf, measureWidth } from "./measure.js";

/** One resolved styling run; adjacent sibling text nodes may be coalesced. */
export interface StyledRun {
  text: string;
  /** Index into ParagraphScan.specs. */
  spec: number;
  /** Inline ancestor chain within the paragraph, outermost → innermost. */
  ancestors: readonly Element[];
  /** Px of painted-box protrusion carried by this run's first/last box. */
  boxStartProtrusionPx?: number;
  boxEndProtrusionPx?: number;
  /** Source inline whose clone must receive the protrusion/safety margin so
   * its paint moves into the margin without pinching its decoration. */
  boxStartProtrusionOwner?: Element;
  boxEndProtrusionOwner?: Element;
  /**
   * Inline padding+border px opening before this run / closing after it
   * (this run holds the first/last content of one or more padded inline
   * elements). Real layout width the item model folds into the adjacent
   * box — see RunText.
   */
  padStartPx?: number;
  padEndPx?: number;
  /** Outermost inline whose clone owns the closing padding/border edge. */
  padEndOwner?: Element;
  /** Innermost `white-space: nowrap` inline element containing this run
   * (one id per element instance): no break opportunity inside. */
  atomicKey?: number;
  /** UTF-16 range rendered by the paragraph's floated `::first-letter`
   * box rather than by normal inline flow. */
  flowExclusion?: { start: number; end: number };
  /** Inherited visual style that differs from the paragraph and must be
   * restored on this fragment inside the reconstructed first-letter box. */
  floatInnerStyle?: readonly (readonly [property: string, value: string])[];
}

export interface FloatIntrusion {
  /** Physical inline width removed from each overlapping line. */
  inlineSize: number;
  /** Consecutive line boxes, from the paragraph start, that overlap it. */
  lines: number;
  /** Computed ::first-letter presentation copied onto the real float used
   * by the enhanced DOM. */
  style: readonly (readonly [property: string, value: string])[];
}

export interface ParagraphScan {
  runs: StyledRun[];
  specs: FontSpec[];
  /** Spec index of the paragraph element itself. */
  baseSpec: number;
  contentWidth: number;
  textIndent: number;
  /** Raw fraction when text-indent is a percentage (re-resolved against
   * the live width on every re-layout), else null. */
  textIndentPct: number | null;
  /** Computed line-height in px, or null when "normal" (font-dependent). */
  lineHeightPx: number | null;
  /** The paragraph opts into placeholder-size maintenance: styled with
   * content-visibility: auto, OR carrying an explicit contain-intrinsic
   * size (inert without containment — a standing signal for pages that
   * apply containment only transiently, e.g. while resizing). */
  pinIntrinsicSize: boolean;
  /** The author explicitly requests justification of the final line.
   * `text-align-last: justify` is the interoperable form; engines that
   * preserve `text-align: justify-all` in computed style are recognized
   * directly too. */
  justifyAll: boolean;
  /** Paragraph direction. "rtl" only for PURE-RTL paragraphs (Hebrew/
   * Arabic with no strong-LTR content — see textSupported); anything
   * mixed bails to native rendering before a scan exists. */
  direction: "ltr" | "rtl";
  /** A floated `::first-letter` (drop cap), measured in its native layout. */
  floatIntrusion: FloatIntrusion | null;
}

/** Content the v1 walker cannot lay out; the paragraph keeps native rendering. */
const REJECT_TAGS = new Set([
  "BR",
  "WBR",
  "IMG",
  "PICTURE",
  "VIDEO",
  "AUDIO",
  "CANVAS",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "INPUT",
  "BUTTON",
  "SELECT",
  "TEXTAREA",
  "MATH",
  "TABLE",
  "HR",
  "SVG",
]);

/**
 * Scripts still out of scope: Southeast Asian scripts whose line breaks
 * need dictionary word segmentation (Thai, Lao). CJK (Han, kana, Hangul,
 * fullwidth forms) is supported — buildItems segments it into per-cluster
 * boxes with kinsoku-aware inter-character break opportunities — and
 * pure-RTL Hebrew/Arabic paragraphs are governed by the direction rules
 * below.
 */
const UNSUPPORTED_SCRIPTS = /[\u0E00-\u0EFF]/;

/**
 * Explicit bidi controls (ALM, LRM/RLM, embeddings, overrides, isolates):
 * they reorder rendering in ways the linear one-run-after-another line
 * model cannot see, whatever the paragraph direction. Always bail.
 */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

/**
 * Strong-RTL characters: every BMP RTL block (Hebrew … Arabic Extended-A,
 * both presentation-forms blocks) plus the supplementary RTL planes
 * (historic scripts, Adlam, Arabic Mathematical symbols). An LTR paragraph
 * containing any of these is mixed-bidi → native rendering. (Before RTL
 * support this bail was implicit — RTL blocks sat inside
 * UNSUPPORTED_SCRIPTS — it is now explicit and covers the presentation
 * forms the old range missed.)
 */
const STRONG_RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

/**
 * A letter outside the two supported RTL scripts (Latin, Greek, Cyrillic,
 * CJK, …). Inside a `direction: rtl` paragraph any such letter is a
 * strong-LTR (or otherwise unsupported) run: the browser would visually
 * reorder it against the RTL flow, breaking the linear line model. Marks
 * (niqqud, harakat) are \p{M}, not \p{L}, so pointed text passes.
 */
const NON_RTL_LETTER = /(?![\p{Script=Hebrew}\p{Script=Arabic}])\p{L}/u;

/** At least one actual RTL letter — a `dir="rtl"` paragraph of only
 * neutrals/digits has no anchor for its direction; leave it native. */
const RTL_LETTER = /[\p{Script=Hebrew}\p{Script=Arabic}]/u;

/**
 * Pure text-level support decision for a paragraph of the given computed
 * direction (exported for unit tests). RTL scope is deliberately narrow:
 * pure-RTL paragraphs only — Hebrew/Arabic letters, digits and neutral
 * punctuation, no strong-LTR content, no explicit bidi controls. Digits
 * (European and Arabic-Indic) ARE allowed: bidi reordering of a number
 * token is internal to the token (its advance is order-independent) and a
 * line's logically-first/last tokens stay at the visual line edges, so the
 * measured wrap guarantee holds — verified by the RTL line-flush e2e tests
 * across all three engines.
 */
export function textSupported(text: string, direction: "ltr" | "rtl"): boolean {
  if (BIDI_CONTROLS.test(text)) return false;
  if (UNSUPPORTED_SCRIPTS.test(text)) return false;
  if (direction === "rtl") {
    if (NON_RTL_LETTER.test(text)) return false;
    if (!RTL_LETTER.test(text)) return false;
  } else if (STRONG_RTL.test(text)) {
    return false;
  }
  return true;
}

/** Inline box extras the model still can't place: margins add layout width
 * OUTSIDE the border box, where neither the box widths nor the rendered
 * clones would carry them. Padding and borders ARE modeled (folded into the
 * element's first/last box). */
const MARGIN_PROPS = ["marginLeft", "marginRight"] as const;

/** CSSOM serializations of a fully transparent computed color. */
function transparentColor(color: string): boolean {
  const value = color.trim().toLowerCase();
  if (value === "transparent") return true;
  // Legacy computed-color form: rgba(r, g, b, 0).
  if (/^rgba\([^)]*,\s*0(?:\.0*)?%?\s*\)$/.test(value)) return true;
  // Modern color functions (rgb(), hsl(), color(), …): ... / 0.
  return /\/\s*0(?:\.0*)?%?\s*\)$/.test(value);
}

interface PaintedEdges {
  start: boolean;
  end: boolean;
}

/** Split a computed CSS list/token stream without cutting inside colors. */
function splitCss(value: string, commas: boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (commas ? ch === "," : /\s/.test(ch))) {
      const token = value.slice(start, i).trim();
      if (token.length > 0) out.push(token);
      start = i + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** Visible OUTSET shadows that actually reach past a horizontal side.
 * Inset shadows, transparent hover-ring reservations, and vertical-only
 * zero-blur shadows (the common `0 1px 0` underline idiom) are not halos. */
function shadowPaintedEdges(value: string, direction: "ltr" | "rtl"): PaintedEdges {
  let left = false;
  let right = false;
  if (value === "none") return { start: false, end: false };
  for (const shadow of splitCss(value, true)) {
    const tokens = splitCss(shadow, false);
    if (tokens.some((token) => token.toLowerCase() === "inset")) continue;
    const color = tokens.find(
      (token) => token === "transparent" || /^[a-z-]+\(/i.test(token),
    );
    if (color !== undefined && transparentColor(color)) continue;
    const lengths = tokens
      .filter((token) => /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:px)?$/i.test(token))
      .map((token) => parseFloat(token));
    if (lengths.length < 2) continue;
    const offsetX = lengths[0]!;
    const blur = Math.max(0, lengths[2] ?? 0);
    const spread = lengths[3] ?? 0;
    // Preserve negative net reach: a sufficiently negative spread can
    // retract even an offset shadow fully inside the border box. Flooring
    // here would let the offset alone manufacture a painted side.
    const reach = blur + spread;
    if (offsetX - reach < 0) left = true;
    if (offsetX + reach > 0) right = true;
  }
  return direction === "rtl" ? { start: right, end: left } : { start: left, end: right };
}

function paintedInlineEdges(
  style: CSSStyleDeclaration,
  direction: "ltr" | "rtl",
): PaintedEdges {
  // Backgrounds are box-shaped on both sides. A background clipped to text
  // is still glyph-shaped and keeps ordinary character protrusion.
  const clips = style.backgroundClip.split(",").map((clip) => clip.trim());
  const clippedToText = clips.length > 0 && clips.every((clip) => clip === "text");
  const background =
    !clippedToText &&
    (style.backgroundImage !== "none" || !transparentColor(style.backgroundColor));
  if (background) return { start: true, end: true };
  return shadowPaintedEdges(style.boxShadow, direction);
}

/** CSS ::first-letter includes the first typographic character together
 * with punctuation immediately before and after it. Return UTF-16 offsets
 * into the paragraph's flattened text (leading collapsible whitespace is
 * outside the pseudo-element). */
function firstLetterRange(text: string): { start: number; end: number } | null {
  const punctuation = /^[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Po}]$/u;
  const clusters = graphemes(text);
  let offset = 0;
  let i = 0;
  while (i < clusters.length && /^\s+$/u.test(clusters[i]!)) {
    offset += clusters[i]!.length;
    i++;
  }
  if (i === clusters.length) return null;

  const start = offset;
  while (i < clusters.length && punctuation.test(clusters[i]!)) {
    offset += clusters[i]!.length;
    i++;
  }
  if (i === clusters.length || /^\s+$/u.test(clusters[i]!)) return null;
  offset += clusters[i]!.length;
  i++;
  while (i < clusters.length && punctuation.test(clusters[i]!)) {
    offset += clusters[i]!.length;
    i++;
  }
  return { start, end: offset };
}

interface TextPoint {
  node: Text;
  offset: number;
}

/** Locate a UTF-16 offset in p.textContent without mutating the DOM. */
function textPointAt(nodes: readonly Text[], target: number): TextPoint | null {
  let offset = 0;
  for (const node of nodes) {
    const end = offset + node.data.length;
    if (target <= end) return { node, offset: target - offset };
    offset = end;
  }
  const last = nodes[nodes.length - 1];
  return last === undefined ? null : { node: last, offset: last.data.length };
}

function pxValue(value: string): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Properties CSS permits (or engines commonly honor) on ::first-letter.
 * The enhanced DOM turns that pseudo float into a real span so browser line
 * boxes stay stable around nowrap segments; copying the computed longhands
 * preserves the author's drop-cap presentation. */
const FIRST_LETTER_PROPERTIES = [
  "float",
  "box-sizing",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-stretch",
  "font-kerning",
  "font-optical-sizing",
  "font-feature-settings",
  "font-variation-settings",
  "font-variant-caps",
  "font-variant-east-asian",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-position",
  "font-synthesis",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "color",
  "background-color",
  "background-image",
  "background-position",
  "background-size",
  "background-repeat",
  "background-origin",
  "background-clip",
  "text-decoration-line",
  "text-decoration-color",
  "text-decoration-style",
  "text-decoration-thickness",
  "text-shadow",
  "text-transform",
  "vertical-align",
  "direction",
  "writing-mode",
  "-webkit-text-fill-color",
  "-webkit-text-stroke-color",
  "-webkit-text-stroke-width",
] as const;

/** Inherited/propagated styling an inline descendant can contribute inside
 * `::first-letter`. Box decorations stay on the one real cloned ancestor;
 * copying them onto an anonymous fragment would double padding/backgrounds.
 * Values equal to the paragraph are omitted so the pseudo's own longhands
 * still control the drop cap. */
const FIRST_LETTER_INNER_PROPERTIES = [
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-stretch",
  "font-kerning",
  "font-optical-sizing",
  "font-feature-settings",
  "font-variation-settings",
  "font-variant-caps",
  "font-variant-east-asian",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-position",
  "font-synthesis",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "color",
  "text-decoration-line",
  "text-decoration-color",
  "text-decoration-style",
  "text-decoration-thickness",
  "text-shadow",
  "text-transform",
  "vertical-align",
  "-webkit-text-fill-color",
  "-webkit-text-stroke-color",
  "-webkit-text-stroke-width",
] as const;

function firstLetterStyle(style: CSSStyleDeclaration): FloatIntrusion["style"] {
  return FIRST_LETTER_PROPERTIES.map((property) => [
    property,
    style.getPropertyValue(property),
  ] as const).filter((entry) => entry[1] !== "");
}

function firstLetterInnerStyle(
  style: CSSStyleDeclaration,
  paragraph: CSSStyleDeclaration,
): FloatIntrusion["style"] {
  return FIRST_LETTER_INNER_PROPERTIES.map((property) => [
    property,
    style.getPropertyValue(property),
  ] as const).filter(
    ([property, value]) =>
      value !== "" && value !== paragraph.getPropertyValue(property),
  );
}

/** Resolve logical float values against the paragraph's inline direction.
 * Browsers preserve `inline-start`/`inline-end` as the computed value even
 * though they actively place the float at a physical edge. */
function physicalFloatSide(
  value: string,
  direction: "ltr" | "rtl",
): "left" | "right" | null {
  if (value === "left" || value === "right") return value;
  if (value === "inline-start") return direction === "rtl" ? "right" : "left";
  if (value === "inline-end") return direction === "rtl" ? "left" : "right";
  return null;
}

/** Properties on a non-floated ::first-letter that can change glyph
 * advances or the first line box. Compare them with the actual source
 * inline, not merely the paragraph: an ordinary paragraph beginning in
 * <strong> legitimately has a bold computed first-letter with no pseudo
 * rule, and its run is already modeled by the normal walker. */
const FIRST_LETTER_METRIC_PROPERTIES = [
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-stretch",
  "font-kerning",
  "font-optical-sizing",
  "font-feature-settings",
  "font-variation-settings",
  "font-variant-alternates",
  "font-variant-caps",
  "font-variant-east-asian",
  "font-variant-emoji",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-position",
  "font-synthesis",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "vertical-align",
] as const;

const FIRST_LETTER_INLINE_BOX_PROPERTIES = [
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
] as const;

function nonFloatedFirstLetterChangesLayout(
  p: HTMLElement,
  paragraphStyle: CSSStyleDeclaration,
  style: CSSStyleDeclaration,
  text: string,
): boolean {
  const differsFromParagraph = FIRST_LETTER_METRIC_PROPERTIES.some(
    (property) => style.getPropertyValue(property) !== paragraphStyle.getPropertyValue(property),
  );
  const hasBox = FIRST_LETTER_INLINE_BOX_PROPERTIES.some(
    (property) => Math.abs(parseFloat(style.getPropertyValue(property)) || 0) > 1e-6,
  );
  if (!differsFromParagraph && !hasBox) return false;

  const span = firstLetterRange(text);
  if (span === null) return false;
  const nodes: Text[] = [];
  const walker = p.ownerDocument.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  const point = textPointAt(nodes, span.start);
  const source = point?.node.parentElement ?? p;
  const sourceStyle = p.ownerDocument.defaultView?.getComputedStyle(source);
  if (sourceStyle === undefined) return false;
  return (
    hasBox ||
    FIRST_LETTER_METRIC_PROPERTIES.some(
      (property) => style.getPropertyValue(property) !== sourceStyle.getPropertyValue(property),
    )
  );
}

/** Group Range fragments into visual line boxes. Inline descendants can
 * yield several fragments for one line, so top coordinates within half a
 * paragraph line-height coalesce. */
function visualLines(
  rects: readonly DOMRect[],
  lineHeight: number,
): Array<{ top: number; left: number; right: number }> {
  const lines: Array<{ top: number; left: number; right: number }> = [];
  const threshold = Math.max(2, lineHeight * 0.45);
  for (const rect of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    const line = lines.find((candidate) => Math.abs(candidate.top - rect.top) < threshold);
    if (line === undefined) lines.push({ top: rect.top, left: rect.left, right: rect.right });
    else {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
    }
  }
  lines.sort((a, b) => a.top - b.top);
  return lines;
}

/**
 * Measure a floated ::first-letter while the author's native DOM is still
 * present. CSSOM exposes used width/height for the pseudo-element only in
 * Chromium; Range geometry supplies its auto inline size everywhere else.
 * Native line fragments directly tell us how many consecutive line boxes
 * overlap the float, with a block-size fallback for layout-skipped content.
 */
function floatedFirstLetter(
  p: HTMLElement,
  paragraphStyle: CSSStyleDeclaration,
  style: CSSStyleDeclaration,
  floatSide: "left" | "right",
  text: string,
  span: { start: number; end: number },
): FloatIntrusion | null {
  const nodes: Text[] = [];
  const walker = p.ownerDocument.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  const start = textPointAt(nodes, span.start);
  const end = textPointAt(nodes, span.end);
  if (start === null || end === null) return null;

  const range = p.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const glyphRect = range.getBoundingClientRect();
  const specifiedWidth = parseFloat(style.width);
  const pseudoLineHeight = parseFloat(style.lineHeight) || pxValue(style.fontSize) * 1.2;
  // Safari reports the normal 17px inline fragment for a 70px floated
  // first letter. Its height exposes that the Range missed the pseudo box;
  // measure with the pseudo's resolved font instead. Firefox's compact
  // 49px Range and Chromium's used pseudo geometry pass this guard.
  const rangeRepresentsPseudo =
    glyphRect.width > 0 && glyphRect.height >= pseudoLineHeight * 0.5;
  const glyphWidth =
    rangeRepresentsPseudo
      ? glyphRect.width
      : measureWidth(text.slice(span.start, span.end), fontSpecOf(style));
  const contentWidth = Number.isFinite(specifiedWidth) ? specifiedWidth : glyphWidth;
  const inlineExtras =
    pxValue(style.paddingLeft) +
    pxValue(style.paddingRight) +
    pxValue(style.borderLeftWidth) +
    pxValue(style.borderRightWidth);
  const borderBoxWidth =
    style.boxSizing === "border-box" && Number.isFinite(specifiedWidth)
      ? contentWidth
      : contentWidth + inlineExtras;
  const inlineSize = Math.max(
    0,
    borderBoxWidth + pxValue(style.marginLeft) + pxValue(style.marginRight),
  );
  if (inlineSize <= 0) return null;

  const paragraphRect = p.getBoundingClientRect();
  const contentLeft =
    paragraphRect.left + pxValue(paragraphStyle.borderLeftWidth) + pxValue(paragraphStyle.paddingLeft);
  const contentRight =
    paragraphRect.right - pxValue(paragraphStyle.borderRightWidth) - pxValue(paragraphStyle.paddingRight);
  const contentTop =
    paragraphRect.top + pxValue(paragraphStyle.borderTopWidth) + pxValue(paragraphStyle.paddingTop);
  const paragraphLineHeight =
    parseFloat(paragraphStyle.lineHeight) || pxValue(paragraphStyle.fontSize) * 1.2;

  const tail = p.ownerDocument.createRange();
  tail.setStart(end.node, end.offset);
  const last = nodes[nodes.length - 1]!;
  tail.setEnd(last, last.data.length);
  const lines = visualLines([...tail.getClientRects()], paragraphLineHeight);
  let affected = 0;
  for (const line of lines) {
    const observed =
      floatSide === "left" ? line.left - contentLeft : contentRight - line.right;
    // An ordinary first-line indent can move one line, but not by anything
    // close to the whole float. Half the measured margin-box width cleanly
    // separates the intruded lines from the full-width lines below it.
    if (observed > inlineSize * 0.5) affected++;
    else break;
  }

  // Predict the overlap from vertical geometry too. This matters when the
  // paragraph initially ends before the float does: after a later resize it
  // can gain additional lines that still need the narrow measure. Chromium
  // exposes the pseudo's used height. Firefox/WebKit return `auto`; in that
  // case Firefox's Range rect is its compact float content box, while a tall
  // ink rect (WebKit) is not layout geometry and the computed line-height is.
  const specifiedHeight = parseFloat(style.height);
  const compactAutoBox =
    !Number.isFinite(specifiedHeight) &&
    glyphRect.height > 0 &&
    glyphRect.height <= pseudoLineHeight * 1.2;
  const contentHeight = Number.isFinite(specifiedHeight)
    ? specifiedHeight
    : compactAutoBox
      ? glyphRect.height
      : pseudoLineHeight;
  const blockExtras =
    pxValue(style.paddingTop) +
    pxValue(style.paddingBottom) +
    pxValue(style.borderTopWidth) +
    pxValue(style.borderBottomWidth);
  const borderBoxHeight =
    style.boxSizing === "border-box" && Number.isFinite(specifiedHeight)
      ? contentHeight
      : contentHeight + blockExtras;
  const floatBottom = compactAutoBox
    ? glyphRect.bottom +
      pxValue(style.paddingBottom) +
      pxValue(style.borderBottomWidth) +
      pxValue(style.marginBottom)
    : contentTop +
      pxValue(style.marginTop) +
      borderBoxHeight +
      pxValue(style.marginBottom);
  const firstTextTop = lines[0]?.top ?? contentTop;
  const geometricLines = Math.max(
    1,
    Math.ceil((floatBottom - firstTextTop) / paragraphLineHeight - 1e-6),
  );
  affected = Math.max(affected, geometricLines);

  return { inlineSize, lines: affected, style: firstLetterStyle(style) };
}

function floatDetailsOf(
  p: HTMLElement,
  text: string,
  paragraphStyle?: CSSStyleDeclaration,
): { intrusion: FloatIntrusion; span: { start: number; end: number } } | string | null {
  const view = p.ownerDocument.defaultView;
  if (view === null) return null;
  let style: CSSStyleDeclaration;
  try {
    style = view.getComputedStyle(p, "::first-letter");
  } catch {
    return "could not inspect ::first-letter style";
  }
  // This cheap pseudo-style read makes the ordinary path stop here: only
  // actual drop caps pay for Range geometry. A metric-changing inline
  // first letter is still unsafe because the normal run model cannot see
  // its pseudo-only font/box, so leave that paragraph native too.
  if (style.float === "none") {
    return nonFloatedFirstLetterChangesLayout(
      p,
      paragraphStyle ?? view.getComputedStyle(p),
      style,
      text,
    )
      ? "layout-changing non-floated ::first-letter"
      : null;
  }
  const cs = paragraphStyle ?? view.getComputedStyle(p);
  const direction: "ltr" | "rtl" = cs.direction === "rtl" ? "rtl" : "ltr";
  const floatSide = physicalFloatSide(style.float, direction);
  if (floatSide === null) return `unsupported ::first-letter float: ${style.float}`;
  const span = firstLetterRange(text);
  if (span === null) return "could not locate floated ::first-letter text";
  const intrusion = floatedFirstLetter(
    p,
    cs,
    style,
    floatSide,
    text,
    span,
  );
  return intrusion === null ? "could not measure floated ::first-letter" : { intrusion, span };
}

/** Re-read a live paragraph's floated first-letter geometry. Exported for
 * font-driven remeasurement after the original DOM has been enhanced. */
export function floatIntrusionOf(
  p: HTMLElement,
  text = p.textContent ?? "",
): FloatIntrusion | null {
  const details = floatDetailsOf(p, text);
  return typeof details === "object" && details !== null ? details.intrusion : null;
}

/** Live inline size of either the real enhanced float or a native
 * ::first-letter. The overlap count remains the scan-time value: enhanced
 * nowrap fragments are not reliable evidence for native float geometry. */
export function floatInlineSizeOf(p: HTMLElement): number | null {
  const rendered = p.querySelector<HTMLElement>(":scope .justif-float-source");
  if (rendered !== null) {
    const rect = rendered.getBoundingClientRect();
    const style = rendered.ownerDocument.defaultView?.getComputedStyle(rendered);
    if (style === undefined) return rect.width > 0 ? rect.width : null;
    const size = rect.width + pxValue(style.marginLeft) + pxValue(style.marginRight);
    return size > 0 ? size : null;
  }
  return floatIntrusionOf(p)?.inlineSize ?? null;
}

/**
 * Reads a paragraph into styled runs plus its available measure. Returns
 * a human-readable skip reason (string) when the content or styling is out
 * of scope — the caller leaves the paragraph untouched (author CSS
 * `text-align: justify` remains the fallback rendering) and can surface
 * the reason through JustifyOptions.onSkip.
 */
export function readParagraph(p: HTMLElement): ParagraphScan | string {
  const view = p.ownerDocument.defaultView;
  if (view === null) return "detached from its document";
  const cs = view.getComputedStyle(p);

  if (cs.display === "none") return "display: none";
  if (cs.whiteSpace !== "normal") return `white-space: ${cs.whiteSpace} on the paragraph`;
  // Canvas measures the RAW text; transformed text renders different
  // glyphs entirely (uppercase widths etc.) — bail to native rendering.
  if (cs.textTransform !== "none") return `text-transform: ${cs.textTransform}`;
  if (cs.writingMode !== "horizontal-tb") return `writing-mode: ${cs.writingMode}`;
  // RTL is supported for PURE-RTL paragraphs only (checked against the
  // collected text below); mixed-direction content bails to native.
  const direction: "ltr" | "rtl" = cs.direction === "rtl" ? "rtl" : "ltr";
  if (p.isContentEditable) return "content-editable";
  if (p.shadowRoot !== null) return "element hosts a shadow root";

  const specs: FontSpec[] = [];
  const keyToIndex = new Map<string, number>();
  const indexSpec = (style: CSSStyleDeclaration): number => {
    const spec = fontSpecOf(style);
    const existing = keyToIndex.get(spec.key);
    if (existing !== undefined) return existing;
    specs.push(spec);
    keyToIndex.set(spec.key, specs.length - 1);
    return specs.length - 1;
  };

  const baseSpec = indexSpec(cs);
  const runs: StyledRun[] = [];
  let skip: string | null = null;

  let nextAtomicKey = 0;
  const walk = (
    node: Node,
    chain: readonly Element[],
    spec: number,
    atomicKey: number | undefined,
    floatInnerStyle: FloatIntrusion["style"],
  ): void => {
    // JSX expressions such as {" "} can produce a text node separate from
    // the prose beside it; server renderers may also put empty comments
    // between those adjacent text children. They still form one browser
    // shaping/style run. Coalesce them here so the renderer does not treat
    // the literal space as a cross-run boundary and replace it with NBSP.
    // An intervening element resets the candidate even when it is empty:
    // element boundaries remain meaningful to DOM reconstruction.
    let adjacentTextRun: StyledRun | null = null;
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      if (skip !== null) return;
      if (child.nodeType === 3 /* TEXT_NODE */) {
        const text = child.nodeValue ?? "";
        if (text.length > 0) {
          if (adjacentTextRun === null) {
            adjacentTextRun = {
              text,
              spec,
              ancestors: chain,
              atomicKey,
              floatInnerStyle: floatInnerStyle.length > 0 ? floatInnerStyle : undefined,
            };
            runs.push(adjacentTextRun);
          } else {
            adjacentTextRun.text += text;
          }
        }
      } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
        adjacentTextRun = null;
        const el = child as Element;
        // Foreign elements (SVG/MathML) keep case-preserved tagNames, so
        // match case-insensitively.
        if (REJECT_TAGS.has(el.tagName.toUpperCase())) {
          skip = `<${el.tagName.toLowerCase()}> content`;
          return;
        }
        const elStyle = view.getComputedStyle(el);
        if (
          elStyle.display !== "inline" ||
          elStyle.float !== "none" ||
          (elStyle.position !== "static" && elStyle.position !== "relative")
        ) {
          skip = `non-inline-flow <${el.tagName.toLowerCase()}> (display/float/position)`;
          return;
        }
        // Margins add layout width OUTSIDE the border box, where neither
        // the box widths nor the rendered clones carry them. Bail; native
        // rendering handles them fine.
        if (MARGIN_PROPS.some((prop) => (parseFloat(elStyle[prop]) || 0) !== 0)) {
          skip = `inline <${el.tagName.toLowerCase()}> has a horizontal margin`;
          return;
        }
        // Padding and borders ARE modeled: they travel with the element's
        // first/last fragment, which is `box-decoration-break: slice` —
        // the initial value, and how the whole-element clones fragment.
        // `clone` would repeat them at every line break the model can't
        // see; bail.
        const padStart =
          (parseFloat(direction === "rtl" ? elStyle.paddingRight : elStyle.paddingLeft) || 0) +
          (parseFloat(
            direction === "rtl" ? elStyle.borderRightWidth : elStyle.borderLeftWidth,
          ) || 0);
        const padEnd =
          (parseFloat(direction === "rtl" ? elStyle.paddingLeft : elStyle.paddingRight) || 0) +
          (parseFloat(
            direction === "rtl" ? elStyle.borderLeftWidth : elStyle.borderRightWidth,
          ) || 0);
        const padded = padStart > 0 || padEnd > 0;
        const decorationBreak =
          elStyle.getPropertyValue("box-decoration-break") ||
          elStyle.getPropertyValue("-webkit-box-decoration-break");
        if (padded && decorationBreak === "clone") {
          skip = `box-decoration-break: clone on padded <${el.tagName.toLowerCase()}>`;
          return;
        }
        if (elStyle.textTransform !== "none") {
          skip = `text-transform: ${elStyle.textTransform} on <${el.tagName.toLowerCase()}>`;
          return;
        }
        // A nested direction change or any non-default unicode-bidi
        // (<bdo>'s bidi-override, embeddings, plaintext) is mixed-bidi
        // territory: the browser would reorder runs the linear line model
        // cannot place. `isolate` is allowed — with the paragraph-uniform
        // direction enforced here, an isolate renders identically.
        if (
          elStyle.direction !== cs.direction ||
          (elStyle.unicodeBidi !== "normal" && elStyle.unicodeBidi !== "isolate")
        ) {
          skip = `direction/unicode-bidi override on <${el.tagName.toLowerCase()}>`;
          return;
        }
        // `white-space: nowrap` forbids breaks between this element's
        // boxes — honored via an atomic scope (the innermost key wins;
        // any nowrap ancestor already forbids everything inside).
        // Preserved-whitespace values (pre*) change tokenization itself:
        // out of scope, bail.
        let childKey = atomicKey;
        if (elStyle.whiteSpace === "nowrap") {
          childKey = atomicKey ?? nextAtomicKey++;
        } else if (elStyle.whiteSpace !== "normal") {
          skip = `white-space: ${elStyle.whiteSpace} on <${el.tagName.toLowerCase()}>`;
          return;
        }
        const before = runs.length;
        const paintedHere = paintedInlineEdges(elStyle, direction);
        walk(
          el,
          [...chain, el],
          indexSpec(elStyle),
          childKey,
          firstLetterInnerStyle(elStyle, cs),
        );
        if (skip !== null) return;
        // Only padded or locally-painted elements need an edge scan/copy.
        const inspectEdges = padded || paintedHere.start || paintedHere.end;
        const inside = inspectEdges ? runs.slice(before) : [];
        let firstBoxAt = -1;
        let lastBoxAt = -1;
        for (let i = 0; i < inside.length; i++) {
          if (!textMakesBox(inside[i]!.text)) continue;
          if (firstBoxAt < 0) firstBoxAt = i;
          lastBoxAt = i;
        }
        if (padded) {
          // The extras attach to the element's first/last runs. An element
          // with no box-worthy content would strand them (nothing to widen;
          // the writer would drop the empty element entirely) — bail.
          // Soft hyphens count as empty: the item builder emits no box for
          // them either.
          if (firstBoxAt < 0) {
            skip = `padded <${el.tagName.toLowerCase()}> with no text content`;
            return;
          }
          const first = runs[before]!;
          const last = runs[runs.length - 1]!;
          first.padStartPx = (first.padStartPx ?? 0) + padStart;
          last.padEndPx = (last.padEndPx ?? 0) + padEnd;
          // The walk is post-order, so nested closing edges overwrite this
          // from inner to outer. The final owner is the clone whose border
          // edge represents the complete closing decoration.
          last.padEndOwner = el;
        }
        if ((paintedHere.start || paintedHere.end) && firstBoxAt >= 0) {
          // This painted box owns the distance from its border to the edge
          // glyph, including padded descendants (already attached by the
          // post-order walk). If an UNPAINTED padded ancestor shares that
          // same edge, the core completes the inset from all pending pads.
          if (paintedHere.start) {
            let startInset = 0;
            for (let i = 0; i <= firstBoxAt; i++) {
              startInset += inside[i]!.padStartPx ?? 0;
            }
            const firstBoxRun = inside[firstBoxAt]!;
            // Keep the zero marker too. It identifies the real open of an
            // unpadded painted inline, where the decoration edge replaces
            // character protrusion. Internal line slices have no marker,
            // so their edge glyphs retain ordinary optical alignment.
            firstBoxRun.boxStartProtrusionPx = startInset;
            firstBoxRun.boxStartProtrusionOwner = el;
          }
          if (paintedHere.end) {
            let endInset = 0;
            for (let i = lastBoxAt; i < inside.length; i++) {
              endInset += inside[i]!.padEndPx ?? 0;
            }
            // The core patches the last box when the element's raw final
            // run is consumed (which may be whitespace-only), while the
            // renderer finds the owner from the actual last box's run.
            // Keep the zero marker: it distinguishes the real close of an
            // unpadded painted inline from an internal wrap in that inline.
            inside[inside.length - 1]!.boxEndProtrusionPx = endInset;
            inside[lastBoxAt]!.boxEndProtrusionOwner = el;
          }
        }
      }
      // Comments and other node types are ignored.
    }
  };
  walk(p, [], baseSpec, undefined, []);

  if (skip !== null) return skip;
  if (runs.length === 0) return "no text content";
  const text = runs.map((r) => r.text).join("");
  if (!textSupported(text, direction)) {
    return "unsupported text (bidi controls, mixed direction, or a script without break support)";
  }

  const floatDetails = floatDetailsOf(p, text, cs);
  if (typeof floatDetails === "string") return floatDetails;
  const floatIntrusion = floatDetails?.intrusion ?? null;
  if (floatDetails !== null) {
    const firstSpan = floatDetails.span;
    let offset = 0;
    for (const run of runs) {
      const runEnd = offset + run.text.length;
      const start = Math.max(firstSpan.start, offset);
      const end = Math.min(firstSpan.end, runEnd);
      if (start < end) {
        run.flowExclusion = { start: start - offset, end: end - offset };
      }
      offset = runEnd;
    }
  }

  const contentWidth = contentWidthOf(p);
  if (contentWidth <= 0) return "zero content width";

  let textIndent = parseFloat(cs.textIndent) || 0;
  const textIndentPct = cs.textIndent.endsWith("%") ? textIndent / 100 : null;
  if (textIndentPct !== null) textIndent = textIndentPct * contentWidth;

  const lineHeightPx = parseFloat(cs.lineHeight);
  const styles = cs as CSSStyleDeclaration & {
    contentVisibility?: string;
    containIntrinsicBlockSize?: string;
    containIntrinsicHeight?: string;
  };
  const cis = styles.containIntrinsicBlockSize ?? styles.containIntrinsicHeight ?? "";
  const pinIntrinsicSize =
    (styles.contentVisibility ?? "") === "auto" || (cis !== "" && cis !== "none");

  return {
    runs,
    specs,
    baseSpec,
    contentWidth,
    textIndent,
    textIndentPct,
    lineHeightPx: Number.isFinite(lineHeightPx) ? lineHeightPx : null,
    pinIntrinsicSize,
    justifyAll: cs.textAlign === "justify-all" || cs.textAlignLast === "justify",
    direction,
    floatIntrusion,
  };
}

/** Content-box width from computed style + border-box rect width. */
export function contentWidthOf(p: HTMLElement): number {
  const view = p.ownerDocument.defaultView;
  if (view === null) return 0;
  const cs = view.getComputedStyle(p);
  return (
    p.getBoundingClientRect().width -
    (parseFloat(cs.paddingLeft) || 0) -
    (parseFloat(cs.paddingRight) || 0) -
    (parseFloat(cs.borderLeftWidth) || 0) -
    (parseFloat(cs.borderRightWidth) || 0)
  );
}
