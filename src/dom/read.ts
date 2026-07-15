import { type FontSpec, fontSpecOf } from "./measure.js";

/** One text node's worth of content with its resolved styling context. */
export interface StyledRun {
  text: string;
  /** Index into ParagraphScan.specs. */
  spec: number;
  /** Inline ancestor chain within the paragraph, outermost → innermost. */
  ancestors: readonly Element[];
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
  /** Paragraph direction. "rtl" only for PURE-RTL paragraphs (Hebrew/
   * Arabic with no strong-LTR content — see textSupported); anything
   * mixed bails to native rendering before a scan exists. */
  direction: "ltr" | "rtl";
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

/** Scripts that need shaping-aware breaking or CJK segmentation: out of scope v1. */
const UNSUPPORTED_SCRIPTS =
  /[\u0E00-\u0EFF\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;

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

/** Inline box extras that add layout width the measurement model never sees. */
const SIDE_BOX_PROPS = [
  "paddingLeft",
  "paddingRight",
  "borderLeftWidth",
  "borderRightWidth",
  "marginLeft",
  "marginRight",
] as const;

/**
 * Reads a paragraph into styled runs plus its available measure. Returns
 * null when the content or styling is out of scope — the caller leaves the
 * paragraph untouched (author CSS `text-align: justify` remains the
 * fallback rendering).
 */
export function readParagraph(p: HTMLElement): ParagraphScan | null {
  const view = p.ownerDocument.defaultView;
  if (view === null) return null;
  const cs = view.getComputedStyle(p);

  if (cs.display === "none" || cs.whiteSpace !== "normal") return null;
  // Canvas measures the RAW text; transformed text renders different
  // glyphs entirely (uppercase widths etc.) — bail to native rendering.
  if (cs.textTransform !== "none") return null;
  if (cs.writingMode !== "horizontal-tb") return null;
  // RTL is supported for PURE-RTL paragraphs only (checked against the
  // collected text below); mixed-direction content bails to native.
  const direction: "ltr" | "rtl" = cs.direction === "rtl" ? "rtl" : "ltr";
  if (p.isContentEditable) return null;
  if (p.shadowRoot !== null) return null;

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
  let supported = true;

  const walk = (node: Node, chain: readonly Element[], spec: number): void => {
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      if (!supported) return;
      if (child.nodeType === 3 /* TEXT_NODE */) {
        const text = child.nodeValue ?? "";
        if (text.length > 0) runs.push({ text, spec, ancestors: chain });
      } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
        const el = child as Element;
        // Foreign elements (SVG/MathML) keep case-preserved tagNames, so
        // match case-insensitively.
        if (REJECT_TAGS.has(el.tagName.toUpperCase())) {
          supported = false;
          return;
        }
        const elStyle = view.getComputedStyle(el);
        if (
          elStyle.display !== "inline" ||
          elStyle.float !== "none" ||
          (elStyle.position !== "static" && elStyle.position !== "relative")
        ) {
          supported = false;
          return;
        }
        // Horizontal box extras on inline elements would make every
        // downstream width wrong by that amount. Bail; native rendering
        // handles them fine. (Style backgrounds without layout impact via
        // box-shadow halos.)
        if (SIDE_BOX_PROPS.some((prop) => (parseFloat(elStyle[prop]) || 0) !== 0)) {
          supported = false;
          return;
        }
        if (elStyle.textTransform !== "none") {
          supported = false;
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
          supported = false;
          return;
        }
        walk(el, [...chain, el], indexSpec(elStyle));
      }
      // Comments and other node types are ignored.
    }
  };
  walk(p, [], baseSpec);

  if (!supported || runs.length === 0) return null;
  if (!textSupported(runs.map((r) => r.text).join(""), direction)) return null;

  const contentWidth = contentWidthOf(p);
  if (contentWidth <= 0) return null;

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
    direction,
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
