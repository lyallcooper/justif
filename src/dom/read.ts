/**
 * Reading a paragraph out of the DOM: what its text is, how it is styled, and
 * whether justif can set it at all.
 *
 * The output is a flat list of styled runs plus the paragraph's measure —
 * everything the line model needs, and nothing that refers back to the nodes
 * it came from, so the layout can be computed without touching the DOM again.
 * Getting there means resolving inline structure into runs, folding padding,
 * borders and painted overflow into the widths they actually occupy, and
 * finding the forced breaks.
 *
 * Not everything inline is text. An inline-level box the engine lays out as
 * one object — a rendered formula, an inline-block chip — is read as an
 * ATOMIC BOX instead: its measured advance, the element to clone, and the
 * styling to pin on that clone. The walk stops at it, which is the point:
 * what is inside an object is the object's business.
 *
 * The other half of the job is saying no. Justif's contract is "enhance or
 * leave native", so anything the model cannot represent faithfully has to be
 * recognized HERE and reported as a reason rather than approximated: a
 * writing mode it does not implement, preserved whitespace, a bidi override,
 * a text-transform whose result it cannot measure. A wrong yes is a visibly
 * broken paragraph; a no is the browser's own rendering, which is what the
 * page had anyway.
 *
 * Float intrusion is read by ./float-geometry.js and arrives through it.
 */

import { textMakesBox } from "../core/items.js";
import {
  type FirstLetterFloatIntrusion,
  type FloatIntrusion,
  floatDetailsOf,
  firstLetterInnerStyle,
  leadingElementFloatOf,
  type ScanBatch,
} from "./float-geometry.js";
import { fragmentBoxesOf } from "./geometry.js";
import { ctxFontOf, type FontSpec, fontSpecOf } from "./measure.js";

/** A font actually used by text inside an opaque atomic object. The object
 * remains opaque to line breaking; this is only enough information to await
 * the faces whose arrival can change its measured advance. */
export interface AtomicFontSample {
  font: string;
  text: string;
}

/**
 * An inline-level object the model places whole and never looks inside: a
 * rendered equation, an inline-block chip, an out-of-flow subtree that
 * carries no advance at all. Everything the layout needs about it is its
 * measured advance; everything the writer needs is the element to clone and
 * the styling to pin on that clone.
 */
export interface AtomicBox {
  /** The author's own element, deep-cloned into the line that holds it. */
  source: Element;
  /** Margin-box advance, measured in the author's own layout. */
  widthPx: number;
  /** Whether this object's rendered advance is measurable and must be kept
   * current. Out-of-flow accessibility subtrees deliberately stay at zero. */
  inFlow: boolean;
  /** Text-bearing fonts used inside the opaque subtree at scan time. */
  fonts: readonly AtomicFontSample[];
  /** The clone installed by the latest successful patch. The source remains
   * the active element while a managed one-line paragraph stays native. */
  rendered: Element | null;
  /**
   * Inherited declarations pinned on the clone so the enhancement's own
   * segment styling cannot resize a box whose width is already modeled.
   * Measured: a segment's letterfit letter-spacing widens a KaTeX formula by
   * ~1.8px per equation in all three engines, and the nowrap a segment
   * carries widens a wrappable inline-block by a quarter of its width.
   */
  style: readonly (readonly [property: string, value: string])[];
}

/**
 * Whether this element's own box is scaled or rotated, so the rect it reports
 * is not the advance it takes on the line.
 *
 * Three properties, because the individual `scale` and `rotate` do NOT appear
 * in computed `transform` and either one alone resizes the rect. `translate` is
 * deliberately absent: it moves the box without resizing it, so the width read
 * is still the advance.
 */
function boxTransformed(style: CSSStyleDeclaration): boolean {
  const scale = style.getPropertyValue("scale");
  const rotate = style.getPropertyValue("rotate");
  return (
    style.transform !== "none" ||
    (scale !== "" && scale !== "none") ||
    (rotate !== "" && rotate !== "none")
  );
}

/** The element whose geometry currently represents this object. */
function activeAtomicElement(box: AtomicBox): Element | null {
  if (box.source.isConnected) return box.source;
  return box.rendered?.isConnected === true ? box.rendered : null;
}

/** Margin-box advance of an in-flow atomic object in its current rendering.
 * Null means the number this reads is not the object's advance — the paragraph
 * is layout-skipped, no live rendering exists, or a transform has appeared. */
function atomicAdvance(box: AtomicBox): number | null {
  if (!box.inFlow) return 0;
  const el = activeAtomicElement(box);
  if (el === null) return null;
  const view = el.ownerDocument.defaultView;
  if (view === null) return null;
  const rect = el.getBoundingClientRect();
  // content-visibility can make a connected descendant report a zero rect.
  // Never replace a real modeled object with that placeholder measurement.
  if (box.widthPx > 0 && rect.width === 0 && rect.height === 0) return null;
  const style = view.getComputedStyle(el);
  // A scaled or rotated box is why readAtomicBox rejects such an object
  // outright: the rect is not the advance. One that appears AFTER the scan —
  // a chip that scales on hover, a keyframed badge — must not be measured
  // either, so the object keeps the width it was modeled at.
  if (boxTransformed(style)) return null;
  const margins =
    (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
  return Math.max(0, rect.width + margins);
}

/** Whether this object's live rendering disagrees with its modeled advance.
 * Reads only: a caller measuring a batch must not change the model it is about
 * to compare the batch against, and one that answers "yes" and then cannot act
 * on it (out of settling budget, no longer ours) has to leave the discrepancy
 * detectable for the pass that can. */
export function atomicWidthStale(box: AtomicBox): boolean {
  const width = atomicAdvance(box);
  return width !== null && Math.abs(width - box.widthPx) > ATOMIC_WIDTH_EPSILON_PX;
}

/** Refresh one object's modeled advance from its live rendering. */
export function refreshAtomicBox(box: AtomicBox): boolean {
  const width = atomicAdvance(box);
  if (width === null || Math.abs(width - box.widthPx) <= ATOMIC_WIDTH_EPSILON_PX) return false;
  box.widthPx = width;
  return true;
}

/** Below this an object's advance has not moved: engine sub-pixel noise, not a
 * resized object. */
const ATOMIC_WIDTH_EPSILON_PX = 0.01;

/** Refresh every atomic object in a paragraph scan. */
export function refreshAtomicWidths(scan: ParagraphScan): boolean {
  let changed = false;
  for (const run of scan.runs) {
    if (run.atomic !== undefined && refreshAtomicBox(run.atomic)) changed = true;
  }
  return changed;
}

/** Drop references to generated clones when author DOM is restored. */
export function clearAtomicRendered(scan: ParagraphScan): void {
  for (const run of scan.runs) {
    if (run.atomic !== undefined) run.atomic.rendered = null;
  }
}

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
  /** This run IS an atomic object rather than text (`text` is empty). */
  atomic?: AtomicBox;
}

/** A visible forced line break in source order. `afterRun` partitions the
 * scanned text without putting a non-optional break into the core item
 * stream; `ancestors` lets the writer restore the real <br> at its exact
 * inline nesting depth. */
export interface HardBreak {
  source: Element;
  ancestors: readonly Element[];
  afterRun: number;
}

export interface ParagraphScan {
  runs: StyledRun[];
  hardBreaks: HardBreak[];
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
  /** Whether any author text, including an opaque floated subtree, contains
   * a no-break space that clipboard cleanup must preserve. */
  authorHasNbsp: boolean;
}

/**
 * Identity of the author styling a scan depends on, as one comparable string: a
 * paragraph whose key still matches would read back the same, so the enhancement
 * it already has — including a decision to leave it native — is still the right
 * answer. Both halves of the scan are therefore represented: what it MEASURES
 * with, and what it DECIDES on.
 *
 * Only what the scan reads, and only from the paragraph itself. Every inherited
 * property here reaches it from a rule anywhere above, so a `:root` or `body`
 * change lands in this key too; a run's own styling does not, since `p code {
 * font-size: ... }` changes no computed value on the paragraph and catching it
 * would mean walking every inline descendant on every check.
 *
 * `text-align`, `text-align-last` and `hanging-punctuation` are deliberately
 * absent: the enhancement overwrites them with inline declarations of its own, so
 * what they compute to afterwards is justif's answer rather than the author's
 * question. `text-indent` is the caller's to append, for the same reason — a
 * natively-hung one-line paragraph carries justif's.
 */
export function paragraphStyleKey(style: CSSStyleDeclaration): string {
  const spec = fontSpecOf(style);
  return [
    // The MEASUREMENT key: fonts, spacing, variants, features. Two of its own
    // fields sit outside it, measuring identically but scanning differently, so
    // both are named here.
    spec.key,
    spec.hyphens,
    spec.direction,
    // Grounds for keeping a paragraph native, and so for reconsidering one.
    style.display,
    style.whiteSpace,
    style.textTransform,
    style.writingMode,
    style.lineHeight,
    style.minWidth,
    style.contain,
  ].join(" ");
}

/**
 * Content the walker cannot lay out; the paragraph keeps native rendering.
 *
 * Replaced elements are here for a reason atomic boxes do not fix: their
 * intrinsic size can resolve LATER. Measured, an `<img>` with no declared
 * dimensions is 0px wide before its bytes arrive and 40px after, in all three
 * engines — a scan-time advance that a later load invalidates. `<math>` is
 * absent because a rendered formula IS measurable at scan time; it becomes an
 * atomic box below.
 */
const REJECT_TAGS = new Set([
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
  "TABLE",
  "HR",
  "SVG",
]);

/**
 * Computed `display` values that make an element an inline-level ATOMIC box:
 * one line-layout object, never split across lines, whose inside the model
 * has no business modeling. KaTeX's `.base` spans are `inline-block`; the
 * two-value serializations are listed because engines differ on which form
 * they report.
 *
 * `<math>` is deliberately NOT recognized here but by tag below: measured,
 * Chromium computes `display: math` for it while Firefox and WebKit report
 * plain `inline`, though all three lay it out as one atomic object.
 */
const ATOMIC_DISPLAYS = new Set([
  "inline-block",
  "inline-flex",
  "inline-grid",
  "inline-table",
  "inline flow-root",
  "inline math",
  "math",
]);

/**
 * Descendants an atomic box may not contain, because the writer renders one
 * by CLONING it: a canvas loses its bitmap, a media element its playback
 * state, a form control its value, an iframe its whole document. Rejecting
 * the box keeps the paragraph native, which is what these elements got
 * before atomic boxes existed (they are in REJECT_TAGS for the same reason).
 */
const UNCLONEABLE =
  "canvas,iframe,video,audio,object,embed,input,button,select,textarea,slot," +
  '[contenteditable=""],[contenteditable="true"]';

/**
 * Inherited properties pinned onto an atomic box's clone. Each is a
 * declaration the enhancement itself writes on the segments it emits, and so
 * one that would otherwise reach INSIDE an object whose advance is already
 * modeled: the letterfit and expansion a line carries, the word-spacing its
 * glue resolved to, the nowrap that makes a line one unbreakable fragment,
 * the kerning suppression a CJK segment declares, and the alignment justif
 * substitutes for the author's.
 */
const ATOMIC_PINNED_PROPERTIES = [
  "white-space",
  "letter-spacing",
  "word-spacing",
  "font-stretch",
  "font-kerning",
  "text-align",
] as const;

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

/** WebKit renders these as forced breaks even inside white-space: nowrap,
 * which can split a segment after line breaking has already completed. */
const FORCED_LINE_SEPARATORS = /[\u2028\u2029]/;

/**
 * FORM FEED (U+000C) and LINE TABULATION (U+000B), which no two engines
 * render alike. Measured between two letters at 16px monospace, where one
 * cell is 9.6px and "ab" is 19.20px (U+000B matches U+000C everywhere):
 *
 * - Chromium paints a ~5.3px glyph and offers NO break there (24.53px, and
 *   one line in a 1px measure);
 * - Firefox drops the character entirely but DOES break there (19.27px,
 *   over two lines);
 * - WebKit gives it a full space's advance and no break (28.81px, one
 *   line), and does not collapse it against an adjacent space: a space plus
 *   a form feed measures two full cells.
 *
 * No single item model can be right in all three, so a paragraph containing
 * one stays native. CSS Text 3 does not list either character as white
 * space, which is why the engines were free to diverge here.
 */
const DIVERGENT_CONTROLS = /[\u000B\u000C]/;

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
  if (FORCED_LINE_SEPARATORS.test(text)) return false;
  if (DIVERGENT_CONTROLS.test(text)) return false;
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

/** Why this `<br>` cannot be modeled as a hard break, or null when it can. */
function hardBreakBailReason(elStyle: CSSStyleDeclaration): string | null {
  if (elStyle.clear !== "none") return `<br> with clear: ${elStyle.clear}`;
  if (
    elStyle.display !== "inline" ||
    elStyle.float !== "none" ||
    (elStyle.position !== "static" && elStyle.position !== "relative")
  ) {
    return "non-inline-flow <br> (display/float/position)";
  }
  return null;
}

/**
 * Padding + border on an inline element's line-start and line-end sides.
 * These ARE modeled — folded into the element's first/last box, which is how
 * `box-decoration-break: slice` (the initial value) fragments.
 */
function inlineInsets(
  elStyle: CSSStyleDeclaration,
  direction: "ltr" | "rtl",
): { start: number; end: number } {
  const rtl = direction === "rtl";
  return {
    start:
      (parseFloat(rtl ? elStyle.paddingRight : elStyle.paddingLeft) || 0) +
      (parseFloat(rtl ? elStyle.borderRightWidth : elStyle.borderLeftWidth) || 0),
    end:
      (parseFloat(rtl ? elStyle.paddingLeft : elStyle.paddingRight) || 0) +
      (parseFloat(rtl ? elStyle.borderLeftWidth : elStyle.borderRightWidth) || 0),
  };
}

/**
 * `text-transform` values the measurer can reproduce, on the paragraph or on
 * anything inside it. The mapping is never justif's to compute: a DOM probe
 * carrying the property renders exactly what the run will, so source text in
 * gives transformed width out — length-changing mappings (`ß`→`SS`) and
 * locale-sensitive casing (Turkish dotless i) come out right without the item
 * model ever holding anything but source text.
 *
 * `capitalize` is the one value whose rendering depends on POSITION rather
 * than on the character. Engines capitalize the first letter of each word and
 * honor text before the element — measured across chromium/firefox/webkit,
 * `un<span>friendly</span>` renders `unfriendly`, the fragment untouched —
 * whereas justif measures words and hyphenation fragments in isolation, where
 * a probe would capitalize a fragment the page does not. Supporting it needs
 * a word-initial flag threaded to every measurement, not a property on a
 * probe.
 *
 * `full-width` and `full-size-kana` are excluded for a smaller reason: they
 * substitute glyphs whose protrusion the table would still be answering for
 * the ASCII source characters.
 *
 * `lowercase` carries one measured, accepted defect: Greek capital sigma is
 * context-sensitive (Σ lowercases to ς word-finally, σ elsewhere), and
 * engines scope that decision to the inline box — a per-line span ending in
 * Σ renders ς where the native page showed σ (`<span>ΟΣ</span><span>Ο</span>`
 * lowercases to "οςο" in Chromium and WebKit). A justified Greek paragraph
 * under `lowercase` can therefore show a final-form sigma at a line break
 * mid-word. Guarding it would mean detecting capital sigma before every
 * split point for a shape (all-caps Greek under lowercase) real pages
 * essentially never have; the mismatch is accepted rather than paid for.
 */
function supportedTextTransform(value: string): boolean {
  return value === "none" || value === "uppercase" || value === "lowercase";
}

/** The fonts whose glyphs give an opaque object's contents their width.
 * Computed while the author subtree is live: after enhancement it is detached,
 * and the clone is deliberately not walked by the line model. */
function atomicFontSamples(el: Element): AtomicFontSample[] {
  const view = el.ownerDocument.defaultView;
  if (view === null) return [];
  const textByFont = new Map<string, string>();
  const styles = new Map<Element, string>();
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    if (text.length === 0) continue;
    const parent = node.parentElement;
    if (parent === null) continue;
    let font = styles.get(parent);
    if (font === undefined) {
      font = ctxFontOf(fontSpecOf(view.getComputedStyle(parent)));
      styles.set(parent, font);
    }
    textByFont.set(font, (textByFont.get(font) ?? "") + text);
  }
  return [...textByFont].map(([font, text]) => ({ font, text }));
}

/**
 * Reads one atomic box, or says why this element is not one.
 *
 * Two shapes qualify. An IN-FLOW atomic inline (`display: inline-block` and
 * relatives, plus `<math>`) is one line-layout object: measured across
 * Chromium, Firefox and WebKit, its border box is exactly its advance — a
 * nowrap segment holding text, such an object and more text measures its
 * three parts to the pixel — and every engine offers a break on both sides of
 * it, which the item model reproduces. An OUT-OF-FLOW subtree (absolute or
 * fixed) contributes no advance at all, so it becomes a zero-width box that
 * exists only to carry its DOM: that is what keeps KaTeX's visually hidden
 * MathML, the accessible half of a rendered formula, in the enhanced output.
 *
 * Returns null when the element is ordinary inline content (the caller
 * descends into it as before), or a bail string when it is atomic in shape
 * but not in a form the writer can reproduce.
 */
function readAtomicBox(el: Element, elStyle: CSSStyleDeclaration): AtomicBox | string | null {
  const outOfFlow = elStyle.position === "absolute" || elStyle.position === "fixed";
  const inFlowAtomic =
    !outOfFlow &&
    (ATOMIC_DISPLAYS.has(elStyle.display) || el.tagName.toUpperCase() === "MATH");
  if (!outOfFlow && !inFlowAtomic) return null;
  const name = el.tagName.toLowerCase();
  if (elStyle.float !== "none") return "floated element is not a leading direct child";
  // A shadow root does not come along on cloneNode, so the rendered box would
  // be empty. Only the host itself is checked: walking a subtree for hosts
  // would cost every atomic box a tree walk to catch a shape essentially no
  // formula or chip has.
  if (el.shadowRoot !== null) return `atomic <${name}> hosts a shadow root`;
  if (el.querySelector(UNCLONEABLE) !== null) {
    return `atomic <${name}> contains content a clone would not reproduce`;
  }
  if (outOfFlow) {
    return { source: el, widthPx: 0, inFlow: false, fonts: [], rendered: null, style: [] };
  }
  // A transform scales the rect but not the advance the box occupies, so the
  // one number this model has for the object would be the wrong one. (An
  // ANCESTOR transform scales the paragraph's own measure by the same factor
  // — see contentWidthOf — so those stay consistent and are not rejected.)
  if (boxTransformed(elStyle)) return `transformed atomic <${name}>`;
  const rect = el.getBoundingClientRect();
  // Margins on an atomic box ARE modelable, unlike the ones on an inline: the
  // object's contribution to the line is its margin box, and the clone
  // carries the same declarations the measurement saw. A net negative margin
  // is clamped away — the breaker requires nonnegative widths, and an object
  // pulled into its neighbors is past what the line model can promise.
  const margins =
    (parseFloat(elStyle.marginLeft) || 0) + (parseFloat(elStyle.marginRight) || 0);
  return {
    source: el,
    widthPx: Math.max(0, rect.width + margins),
    inFlow: true,
    fonts: atomicFontSamples(el),
    rendered: null,
    style: ATOMIC_PINNED_PROPERTIES.map(
      (property) => [property, elStyle.getPropertyValue(property)] as const,
    ).filter(([, value]) => value !== ""),
  };
}

/**
 * Why the model cannot place this inline element's content, or null when it
 * can. `padded` says whether the element has horizontal insets, which decides
 * whether `box-decoration-break` has any decoration to repeat.
 */
function inlineBailReason(
  el: Element,
  elStyle: CSSStyleDeclaration,
  paragraphStyle: CSSStyleDeclaration,
  padded: boolean,
): string | null {
  const name = el.tagName.toLowerCase();
  if (elStyle.float !== "none") return "floated element is not a leading direct child";
  if (
    elStyle.display !== "inline" ||
    (elStyle.position !== "static" && elStyle.position !== "relative")
  ) {
    return `non-inline-flow <${name}> (display/float/position)`;
  }
  // Margins add layout width OUTSIDE the border box, where neither the box
  // widths nor the rendered clones carry them. Bail; native rendering
  // handles them fine.
  if (MARGIN_PROPS.some((prop) => (parseFloat(elStyle[prop]) || 0) !== 0)) {
    return `inline <${name}> has a horizontal margin`;
  }
  // `clone` would repeat the insets at every line break the model can't
  // see; bail.
  const decorationBreak =
    elStyle.getPropertyValue("box-decoration-break") ||
    elStyle.getPropertyValue("-webkit-box-decoration-break");
  if (padded && decorationBreak === "clone") {
    return `box-decoration-break: clone on padded <${name}>`;
  }
  if (!supportedTextTransform(elStyle.textTransform)) {
    return `text-transform: ${elStyle.textTransform} on <${name}>`;
  }
  // A nested direction change or any non-default unicode-bidi (<bdo>'s
  // bidi-override, embeddings, plaintext) is mixed-bidi territory: the
  // browser would reorder runs the linear line model cannot place.
  // `isolate` is allowed — with the paragraph-uniform direction enforced by
  // the caller, an isolate renders identically.
  if (
    elStyle.direction !== paragraphStyle.direction ||
    (elStyle.unicodeBidi !== "normal" && elStyle.unicodeBidi !== "isolate")
  ) {
    return `direction/unicode-bidi override on <${name}>`;
  }
  // Preserved-whitespace values (pre*) change tokenization itself: out of
  // scope, bail. `nowrap` is honored by the caller as an atomic scope.
  if (elStyle.whiteSpace !== "normal" && elStyle.whiteSpace !== "nowrap") {
    return `white-space: ${elStyle.whiteSpace} on <${name}>`;
  }
  return null;
}

/**
 * Reads a paragraph into styled runs plus its available measure. Returns
 * a human-readable skip reason (string) when the content or styling is out
 * of scope — the caller leaves the paragraph untouched (author CSS
 * `text-align: justify` remains the fallback rendering) and can surface
 * the reason through JustifyOptions.onSkip.
 *
 * `batch` carries state shared by every paragraph of one scan; omitting it
 * only makes the scan do more work.
 */
export function readParagraph(p: HTMLElement, batch?: ScanBatch): ParagraphScan | string {
  const view = p.ownerDocument.defaultView;
  if (view === null) return "detached from its document";
  const cs = view.getComputedStyle(p);

  if (cs.display === "none") return "display: none";
  if (cs.whiteSpace !== "normal") return `white-space: ${cs.whiteSpace} on the paragraph`;
  if (!supportedTextTransform(cs.textTransform)) return `text-transform: ${cs.textTransform}`;
  if (cs.writingMode !== "horizontal-tb") return `writing-mode: ${cs.writingMode}`;
  // RTL is supported for PURE-RTL paragraphs only (checked against the
  // collected text below); mixed-direction content bails to native.
  const direction: "ltr" | "rtl" = cs.direction === "rtl" ? "rtl" : "ltr";
  if (p.isContentEditable) return "content-editable";
  if (p.shadowRoot !== null) return "element hosts a shadow root";

  const fragments = fragmentBoxesOf(p, cs);
  if (!fragments.ok) return fragments.reason;
  const elementFloat = leadingElementFloatOf(p, cs, fragments.rects.length);
  if (typeof elementFloat === "string") return elementFloat;
  const omittedNodes = new Set<Node>(elementFloat?.leadingTrivia ?? []);
  if (elementFloat !== null) omittedNodes.add(elementFloat.source);

  const specs: FontSpec[] = [];
  const keyToIndex = new Map<string, number>();
  const indexSpec = (style: CSSStyleDeclaration): number => {
    const spec = fontSpecOf(style);
    // Deduped on MORE than the width-cache key: `hyphens` is deliberately
    // outside FontSpec.key (it cannot change a measurement, so runs that
    // differ only there must share cached widths) but it IS read per run, to
    // suppress hyphenation. Folding it in here keeps `hyphens: none` on a run
    // whose typography is otherwise identical to its paragraph's from
    // collapsing into that paragraph's spec and inheriting `auto`.
    const dedupeKey = `${spec.key}|${spec.hyphens}`;
    const existing = keyToIndex.get(dedupeKey);
    if (existing !== undefined) return existing;
    specs.push(spec);
    keyToIndex.set(dedupeKey, specs.length - 1);
    return specs.length - 1;
  };

  const baseSpec = indexSpec(cs);
  const runs: StyledRun[] = [];
  const hardBreaks: HardBreak[] = [];
  let skip: string | null = null;

  let nextAtomicKey = 0;

  /**
   * Post-order step for one inline element: hand its padding and its painted
   * side insets to the runs that will carry them. Padding attaches to the
   * element's first/last runs; a painted box additionally owns the whole
   * distance from its border to the edge glyph, so the enclosed glyph can
   * meet the measure while the decoration itself hangs outside it. Returns a
   * bail reason, or null.
   */
  const attachInlineExtras = (
    el: Element,
    before: number,
    insets: { start: number; end: number },
    padded: boolean,
    painted: PaintedEdges,
  ): string | null => {
    // Only padded or locally-painted elements need an edge scan/copy.
    if (!padded && !painted.start && !painted.end) return null;
    const inside = runs.slice(before);
    let firstBoxAt = -1;
    let lastBoxAt = -1;
    for (let i = 0; i < inside.length; i++) {
      // An atomic object is a box of the element's content as much as a word
      // is, so a chip whose whole content is one formula owns its padding
      // like any other.
      const run = inside[i]!;
      if (run.atomic === undefined && !textMakesBox(run.text)) continue;
      if (firstBoxAt < 0) firstBoxAt = i;
      lastBoxAt = i;
    }
    if (padded) {
      // The extras attach to the element's first/last runs. An element with
      // no box-worthy content would strand them (nothing to widen; the
      // writer would drop the empty element entirely) — bail. Soft hyphens
      // count as empty: the item builder emits no box for them either.
      if (firstBoxAt < 0) return `padded <${el.tagName.toLowerCase()}> with no text content`;
      const first = runs[before]!;
      const last = runs[runs.length - 1]!;
      first.padStartPx = (first.padStartPx ?? 0) + insets.start;
      last.padEndPx = (last.padEndPx ?? 0) + insets.end;
      // The walk is post-order, so nested closing edges overwrite this from
      // inner to outer. The final owner is the clone whose border edge
      // represents the complete closing decoration.
      last.padEndOwner = el;
    }
    if ((painted.start || painted.end) && firstBoxAt >= 0) {
      // This painted box owns the distance from its border to the edge
      // glyph, including padded descendants (already attached by the
      // post-order walk). If an UNPAINTED padded ancestor shares that same
      // edge, the core completes the inset from all pending pads.
      if (painted.start) {
        let startInset = 0;
        for (let i = 0; i <= firstBoxAt; i++) {
          startInset += inside[i]!.padStartPx ?? 0;
        }
        const firstBoxRun = inside[firstBoxAt]!;
        // Keep the zero marker too. It identifies the real open of an
        // unpadded painted inline, where the decoration edge replaces
        // character protrusion. Internal line slices have no marker, so
        // their edge glyphs retain ordinary optical alignment.
        firstBoxRun.boxStartProtrusionPx = startInset;
        firstBoxRun.boxStartProtrusionOwner = el;
      }
      if (painted.end) {
        let endInset = 0;
        for (let i = lastBoxAt; i < inside.length; i++) {
          endInset += inside[i]!.padEndPx ?? 0;
        }
        // The core patches the last box when the element's raw final run is
        // consumed (which may be whitespace-only), while the renderer finds
        // the owner from the actual last box's run. Keep the zero marker: it
        // distinguishes the real close of an unpadded painted inline from an
        // internal wrap in that inline.
        inside[inside.length - 1]!.boxEndProtrusionPx = endInset;
        inside[lastBoxAt]!.boxEndProtrusionOwner = el;
      }
    }
    return null;
  };

  const walk = (
    node: Node,
    chain: readonly Element[],
    spec: number,
    atomicKey: number | undefined,
    floatInnerStyle: FirstLetterFloatIntrusion["style"],
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
      if (node === p && omittedNodes.has(child)) continue;
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
        const tag = el.tagName.toUpperCase();
        if (tag === "BR") {
          const elStyle = view.getComputedStyle(el);
          // A hidden <br> creates no line break in native layout.
          if (elStyle.display === "none") continue;
          skip = hardBreakBailReason(elStyle);
          if (skip !== null) return;
          hardBreaks.push({ source: el, ancestors: chain, afterRun: runs.length });
          continue;
        }
        // Foreign elements (SVG/MathML) keep case-preserved tagNames, so
        // match case-insensitively.
        if (REJECT_TAGS.has(tag)) {
          skip = `<${el.tagName.toLowerCase()}> content`;
          return;
        }
        const elStyle = view.getComputedStyle(el);
        const atomic = readAtomicBox(el, elStyle);
        if (typeof atomic === "string") {
          skip = atomic;
          return;
        }
        if (atomic !== null) {
          // An object, not a styling context: it takes no spec of its own
          // (nothing here is measured in a font) and no descent. The
          // enclosing chain is kept so the writer nests the clone exactly
          // where the author put it.
          runs.push({
            text: "",
            spec,
            ancestors: chain,
            atomicKey,
            atomic,
          });
          continue;
        }
        const insets = inlineInsets(elStyle, direction);
        const padded = insets.start > 0 || insets.end > 0;
        skip = inlineBailReason(el, elStyle, cs, padded);
        if (skip !== null) return;
        // `white-space: nowrap` forbids breaks between this element's
        // boxes — honored via an atomic scope (the innermost key wins;
        // any nowrap ancestor already forbids everything inside).
        const childKey =
          elStyle.whiteSpace === "nowrap" ? (atomicKey ?? nextAtomicKey++) : atomicKey;
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
        skip = attachInlineExtras(el, before, insets, padded, paintedHere);
        if (skip !== null) return;
      }
      // Comments and other node types are ignored.
    }
  };
  walk(p, [], baseSpec, undefined, []);

  if (skip !== null) return skip;
  if (runs.length === 0 && hardBreaks.length === 0) return "no text content";
  const text = runs.map((r) => r.text).join("");
  if (text.length > 0 && !textSupported(text, direction)) {
    return "unsupported text (forced separators, bidi controls, mixed direction, or a script without break support)";
  }

  const floatDetails = floatDetailsOf(
    p,
    elementFloat === null ? text : (p.textContent ?? ""),
    cs,
    fragments.rects.length,
    batch,
  );
  // The measurement failure comes first: a `floatDetailsOf` string is a
  // reason of its own, and reporting it as a conflict with the element float
  // would send the author after a ::first-letter that never measured.
  if (typeof floatDetails === "string") return floatDetails;
  if (elementFloat !== null && floatDetails !== null) {
    return "leading floated element conflicts with ::first-letter";
  }
  const floatIntrusion = elementFloat ?? floatDetails?.intrusion ?? null;
  if (floatDetails !== null && elementFloat === null) {
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

  const contentWidth = fragments.contentWidth;

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
    hardBreaks,
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
    authorHasNbsp: /[\u00A0\u202F]/.test(p.textContent ?? ""),
  };
}

/**
 * Content-box width of one equal-width fragment (one rect in normal flow).
 *
 * THE definition of a paragraph's measure: everything that stores, compares or
 * breaks to a width — the initial scan, resize handling, the correction pass's
 * own validation — has to get it from here or from `fragmentBoxesOf` beneath
 * it. Client rects are transformed by any ancestor `transform`, so a width
 * sourced anywhere else (a ResizeObserver entry's inline size, most temptingly)
 * silently disagrees with this one by the scale factor, and every comparison
 * between them reads as a layout change that never happened.
 */
export function contentWidthOf(p: HTMLElement): number | string {
  const view = p.ownerDocument.defaultView;
  if (view === null) return "zero content width";
  const cs = view.getComputedStyle(p);
  const fragments = fragmentBoxesOf(p, cs);
  return fragments.ok ? fragments.contentWidth : fragments.reason;
}
