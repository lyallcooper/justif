/**
 * Reading a float's intrusion on a paragraph out of the DOM.
 *
 * Two shapes of float narrow a paragraph's leading lines, and justif has to
 * answer the same two questions about both: how much inline size does it take
 * away, and from how many lines? A floated `::first-letter` is the harder
 * one — it is a pseudo-element, so it has no node to measure and its box has
 * to be reconstructed from computed style and the geometry of the lines it
 * pushes. A leading floated ELEMENT is measurable directly, but only after
 * ruling out everything the line model cannot follow: shape-outside, clear,
 * a second float, content whose own layout is not predictable from its box.
 *
 * The line COUNT is the delicate half. It is read from where the paragraph's
 * lines actually start and stop relative to the float's box — not from the
 * float's height over the line height, which disagrees with every engine at
 * the boundary. A paragraph is measured in its author DOM for this, because
 * an enhanced one's segments are not independent evidence: they were built
 * from the previous answer.
 *
 * Nothing here is stateful except `ScanBatch`, which caches one question for
 * the duration of a single justify() call and no longer.
 */

import { graphemes } from "../core/cjk.js";
import { fragmentBoxesOf } from "./geometry.js";
import { fontSpecOf, measureWidth } from "./measure.js";

interface FloatGeometry {
  /** Physical inline width removed from each overlapping line. */
  inlineSize: number;
  /** Consecutive line boxes, from the paragraph start, that overlap it. */
  lines: number;
}

export interface FirstLetterFloatIntrusion extends FloatGeometry {
  kind: "first-letter";
  /** Computed ::first-letter presentation copied onto the real float used
   * by the enhanced DOM. */
  style: readonly (readonly [property: string, value: string])[];
}

export interface ElementFloatIntrusion extends FloatGeometry {
  kind: "element";
  /** Author node retained in the saved DOM and deep-cloned while enhanced. */
  source: Element;
  /** Collapsible whitespace and comments preceding the source in DOM order. */
  leadingTrivia: readonly Node[];
}

export type FloatIntrusion = FirstLetterFloatIntrusion | ElementFloatIntrusion;
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

function firstLetterStyle(style: CSSStyleDeclaration): FirstLetterFloatIntrusion["style"] {
  return FIRST_LETTER_PROPERTIES.map((property) => [
    property,
    style.getPropertyValue(property),
  ] as const).filter((entry) => entry[1] !== "");
}

export function firstLetterInnerStyle(
  style: CSSStyleDeclaration,
  paragraph: CSSStyleDeclaration,
): FirstLetterFloatIntrusion["style"] {
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
/**
 * The physical side a float sits on, or null when the element is not floated
 * to a side the line model can follow. `none` lands here, which is how a
 * caller tells "no longer a float at all" apart from "a float that cannot be
 * measured just now".
 */
export function physicalFloatSide(
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

export function visualLines(
  rects: readonly DOMRect[],
  lineHeight: number,
): Array<{ top: number; bottom: number; left: number; right: number }> {
  const lines: Array<{
    top: number;
    bottom: number;
    left: number;
    right: number;
    fragments: Array<{ top: number; bottom: number }>;
  }> = [];
  const threshold = Math.max(2, lineHeight * 0.45);
  for (const rect of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    const line = lines.find((candidate) => {
      const topDelta = Math.abs(candidate.top - rect.top);
      if (topDelta < threshold) return true;
      return (
        topDelta < lineHeight * 1.25 &&
        candidate.fragments.some((fragment) => {
          const overlap =
            Math.min(fragment.bottom, rect.bottom) - Math.max(fragment.top, rect.top);
          const smallerHeight = Math.min(fragment.bottom - fragment.top, rect.height);
          const largerHeight = Math.max(fragment.bottom - fragment.top, rect.height);
          const compact = smallerHeight < lineHeight * 0.8;
          return (
            (compact || largerHeight > lineHeight * 1.25) &&
            overlap > smallerHeight * (compact ? 0.3 : 0.5)
          );
        })
      );
    });
    if (line === undefined) {
      lines.push({
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        fragments: [{ top: rect.top, bottom: rect.bottom }],
      });
    } else {
      line.bottom = Math.max(line.bottom, rect.bottom);
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      line.fragments.push({ top: rect.top, bottom: rect.bottom });
    }
  }
  return lines.sort((a, b) => a.top - b.top);
}

/** Content-box edges and resolved line height of a paragraph, in viewport
 * coordinates — the frame both float paths measure line shortfall against. */
function paragraphContentBox(
  p: HTMLElement,
  paragraphStyle: CSSStyleDeclaration,
): { left: number; right: number; top: number; lineHeight: number } {
  const rect = p.getBoundingClientRect();
  return {
    left: rect.left + pxValue(paragraphStyle.borderLeftWidth) + pxValue(paragraphStyle.paddingLeft),
    right: rect.right - pxValue(paragraphStyle.borderRightWidth) - pxValue(paragraphStyle.paddingRight),
    top: rect.top + pxValue(paragraphStyle.borderTopWidth) + pxValue(paragraphStyle.paddingTop),
    lineHeight: parseFloat(paragraphStyle.lineHeight) || pxValue(paragraphStyle.fontSize) * 1.2,
  };
}

/** Whether the paragraph's last line is naturally short at `floatSide`. A
 * start-aligned (or centered) final line measures short at its ragged edge
 * whether or not a float reaches it, so observed shortfall there is not
 * evidence of intrusion. Reads the alignment governing the CURRENTLY
 * rendered layout: the author's native justification during the scan, and
 * the masked text-align (flush to the line-start edge) while enhanced. */
function lastLineRaggedAt(
  paragraphStyle: CSSStyleDeclaration,
  floatSide: "left" | "right",
): boolean {
  if (paragraphStyle.textAlign === "justify-all") return false;
  const last = paragraphStyle.getPropertyValue("text-align-last") || "auto";
  if (last === "justify") return false;
  if (last === "center") return true;
  const direction = paragraphStyle.direction === "rtl" ? "rtl" : "ltr";
  // The physical edge the last line stays flush against; it is ragged at
  // the opposite one. `auto` and `start` follow direction (`auto` under
  // text-align: justify falls back to start).
  let flushEdge: "left" | "right";
  if (last === "left" || last === "right") flushEdge = last;
  else if (last === "end") flushEdge = direction === "rtl" ? "left" : "right";
  else flushEdge = direction === "rtl" ? "right" : "left";
  return floatSide !== flushEdge;
}

function intrudedLineCount(
  lines: ReadonlyArray<{ top: number; left: number; right: number }>,
  content: { left: number; right: number; top: number; lineHeight: number },
  paragraphStyle: CSSStyleDeclaration,
  floatSide: "left" | "right",
  inlineSize: number,
  floatBottom: number,
  boundaryMode: 0 | 1 | 2,
): number {
  const skipLastLine = lastLineRaggedAt(paragraphStyle, floatSide);
  let affected = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (boundaryMode === 2 && line.top >= floatBottom + 0.5) {
      const previous = lines[i - 1];
      if (
        affected > 0 &&
        previous !== undefined &&
        line.top - previous.top < content.lineHeight * 1.5
      ) {
        return affected;
      }
      break;
    }
    // Only vertical geometry can say whether the float reaches a line that
    // is short at its ragged edge anyway.
    if (skipLastLine && i === lines.length - 1) break;
    const observed =
      floatSide === "left" ? line.left - content.left : content.right - line.right;
    // An ordinary first-line indent can move one line, but not by anything
    // close to the whole float. Half the measured margin-box width cleanly
    // separates the intruded lines from the full-width lines below it.
    if (observed > inlineSize * 0.5) affected++;
    else {
      if (boundaryMode === 1 && affected > 0) return affected;
      break;
    }
  }
  const firstLine = lines[0];
  const textTop =
    firstLine !== undefined && firstLine.top < floatBottom ? firstLine.top : content.top;
  const geometricLines = Math.max(
    1,
    Math.ceil((floatBottom - textTop) / content.lineHeight - 1e-6),
  );
  return Math.max(affected, geometricLines);
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

  const content = paragraphContentBox(p, paragraphStyle);

  const tail = p.ownerDocument.createRange();
  tail.setStart(end.node, end.offset);
  const last = nodes[nodes.length - 1]!;
  tail.setEnd(last, last.data.length);
  const lines = visualLines([...tail.getClientRects()], content.lineHeight);

  // The float's bottom edge, for the vertical half of the overlap count.
  // Chromium exposes the pseudo's used height. Firefox/WebKit return
  // `auto`; in that case Firefox's Range rect is its compact float content
  // box, while a tall ink rect (WebKit) is not layout geometry and the
  // computed line-height is.
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
    : content.top +
      pxValue(style.marginTop) +
      borderBoxHeight +
      pxValue(style.marginBottom);
  const affected = intrudedLineCount(
    lines,
    content,
    paragraphStyle,
    floatSide,
    inlineSize,
    floatBottom,
    0,
  );

  return { kind: "first-letter", inlineSize, lines: affected, style: firstLetterStyle(style) };
}

const LEADING_TRIVIA = /^[\t\n\f\r ]*$/;
const UNSAFE_FLOAT_CONTENT = [
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "canvas",
  "input",
  "button",
  "select",
  "textarea",
  "script",
  "style",
].join(",");

function borderBoxSize(
  style: CSSStyleDeclaration,
  axis: "inline" | "block",
): number | null {
  const size = parseFloat(axis === "inline" ? style.width : style.height);
  if (!Number.isFinite(size)) return null;
  if (style.boxSizing === "border-box") return Math.max(0, size);
  const extras =
    axis === "inline"
      ? pxValue(style.paddingLeft) +
        pxValue(style.paddingRight) +
        pxValue(style.borderLeftWidth) +
        pxValue(style.borderRightWidth)
      : pxValue(style.paddingTop) +
        pxValue(style.paddingBottom) +
        pxValue(style.borderTopWidth) +
        pxValue(style.borderBottomWidth);
  return Math.max(0, size + extras);
}

function unsafeFloatSubtree(source: Element): string | null {
  const unsafe = source.matches(UNSAFE_FLOAT_CONTENT)
    ? source
    : source.querySelector(UNSAFE_FLOAT_CONTENT);
  if (unsafe !== null) return `<${unsafe.tagName.toLowerCase()}> in floated element`;
  for (const el of [source, ...source.querySelectorAll("*")]) {
    if (el.shadowRoot !== null) return "shadow root in floated element";
  }
  return null;
}

function elementFloatGeometry(
  p: HTMLElement,
  source: Element,
  paragraphStyle: CSSStyleDeclaration,
  style: CSSStyleDeclaration,
  floatSide: "left" | "right",
  verify: boolean,
): FloatGeometry | null {
  const borderInline = borderBoxSize(style, "inline");
  const borderBlock = borderBoxSize(style, "block");
  if (borderInline === null || borderBlock === null) return null;
  const inlineSize =
    borderInline + pxValue(style.marginLeft) + pxValue(style.marginRight);
  const blockSize =
    borderBlock + pxValue(style.marginTop) + pxValue(style.marginBottom);
  if (inlineSize <= 0 || blockSize <= 0) return null;

  const content = paragraphContentBox(p, paragraphStyle);
  const tail = p.ownerDocument.createRange();
  tail.selectNodeContents(p);
  tail.setStartAfter(source);
  const lines = visualLines([...tail.getClientRects()], content.lineHeight);
  const floatBottom = content.top + blockSize;
  return {
    inlineSize,
    lines: intrudedLineCount(
      lines,
      content,
      paragraphStyle,
      floatSide,
      inlineSize,
      floatBottom,
      !p.hasAttribute("data-justif") ? 1 : verify ? 2 : 0,
    ),
  };
}

export function leadingElementFloatOf(
  p: HTMLElement,
  paragraphStyle: CSSStyleDeclaration,
  fragmentCount: number,
): ElementFloatIntrusion | string | null {
  const view = p.ownerDocument.defaultView;
  if (view === null) return null;
  const leadingTrivia: Node[] = [];
  let source: Element | null = null;
  for (let child = p.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === Node.COMMENT_NODE) {
      leadingTrivia.push(child);
      continue;
    }
    if (child.nodeType === Node.TEXT_NODE && LEADING_TRIVIA.test(child.nodeValue ?? "")) {
      leadingTrivia.push(child);
      continue;
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (view.getComputedStyle(el).float !== "none") source = el;
    }
    break;
  }

  if (source === null) return null;

  const outsideFloats: Element[] = [];
  for (const el of p.querySelectorAll("*")) {
    if (el === source || source.contains(el)) continue;
    if (view.getComputedStyle(el).float !== "none") outsideFloats.push(el);
  }
  if (outsideFloats.length > 0) return "multiple floated elements";
  if (fragmentCount > 1) return "fragmented paragraph with leading floated element";

  const unsafe = unsafeFloatSubtree(source);
  if (unsafe !== null) return `unsafe ${unsafe}`;
  const style = view.getComputedStyle(source);
  if (style.clear !== "none") return `clear: ${style.clear} on leading floated element`;
  const shapeOutside = style.getPropertyValue("shape-outside") || "none";
  if (shapeOutside !== "none") return "shape-outside on leading floated element";
  const direction: "ltr" | "rtl" = paragraphStyle.direction === "rtl" ? "rtl" : "ltr";
  const side = physicalFloatSide(style.float, direction);
  if (side === null) return `unsupported element float: ${style.float}`;
  const geometry = elementFloatGeometry(p, source, paragraphStyle, style, side, false);
  if (geometry === null) return "could not measure leading floated element";
  return { kind: "element", source, leadingTrivia, ...geometry };
}

/**
 * Per-`justify()` scan state, threaded through readParagraph.
 *
 * It caches "can a `::first-letter` rule reach this root at all?", and the
 * scoping is deliberate: a page is free to append a stylesheet between two
 * justify() calls (lazy component CSS, a print/theme swap), and a cache that
 * outlived the call — keyed on the document, say — would answer every later
 * scan from a walk taken before that rule existed and silently flatten the
 * drop cap. One batch is the longest window in which the answer cannot have
 * changed under us, because nothing yields to page script inside it.
 */
/**
 * Rules one paragraph's saved inspection can afford to have examined. The
 * per-paragraph work this replaces measures ~8µs, and materializing a CSSRule
 * to read its selector ~0.3µs, so stylesheets holding more than a few dozen
 * rules per paragraph cannot repay the walk — a short article behind a large
 * generated stylesheet would pay more than it saves. Counting a sheet's rules
 * is free (only INDEXING the list materializes the wrappers), so the count
 * decides whether to walk at all.
 */
const RULES_PER_PARAGRAPH = 24;

export interface ScanBatch {
  /** Roots already walked, with their answer. endScanBatch drops these so no
   * Document or ShadowRoot outlives the scan that needed it. */
  firstLetterRoots: Map<Document | ShadowRoot, boolean>;
  /** Rules this batch may examine before the walk stops paying for itself. */
  ruleBudget: number;
}

/** Open a scan batch. Pair with endScanBatch in a finally. */
export function beginScanBatch(paragraphCount: number): ScanBatch {
  return {
    firstLetterRoots: new Map(),
    ruleBudget: paragraphCount * RULES_PER_PARAGRAPH,
  };
}

/** Close a scan batch, releasing its DOM references. */
export function endScanBatch(batch: ScanBatch): void {
  batch.firstLetterRoots.clear();
}

/** Nesting bound for grouping rules. @media/@supports/@layer/@container and
 * CSS nesting can legitimately stack a few levels; a document that stacks
 * more is reported as "may have a rule" rather than walked forever. */
const MAX_RULE_DEPTH = 12;

function rulesMentionFirstLetter(rules: CSSRuleList, depth: number): boolean {
  // Absence is what has to be PROVEN here (see mayHaveFirstLetterRule), and a
  // truncated walk proves nothing.
  if (depth > MAX_RULE_DEPTH) return true;
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i] as
      | (CSSRule & {
          selectorText?: string;
          cssRules?: CSSRuleList;
          styleSheet?: CSSStyleSheet;
        })
      | undefined;
    if (rule === undefined) continue;
    // Both spellings reach the same pseudo-element: CSS keeps the legacy
    // one-colon `:first-letter` valid alongside `::first-letter`. A substring
    // test covers both, and over-matching (a `.first-letter` class) costs
    // only the inspection we would otherwise have done anyway.
    if (rule.selectorText !== undefined && rule.selectorText.includes("first-letter")) {
      return true;
    }
    // @import exposes its target as a whole sheet, which may itself be
    // cross-origin and throw where sheetMentionsFirstLetter reads it.
    const imported = rule.styleSheet;
    if (imported != null && sheetMentionsFirstLetter(imported, depth + 1)) return true;
    // Grouping rules and nested style rules (`p { &::first-letter {} }`)
    // both hang their children off cssRules.
    const nested = rule.cssRules;
    if (nested != null && rulesMentionFirstLetter(nested, depth + 1)) return true;
  }
  return false;
}

function sheetMentionsFirstLetter(sheet: CSSStyleSheet, depth: number): boolean {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    // A cross-origin sheet (and anything else the engine guards) throws on
    // cssRules. Its selectors are unknowable, so it counts as a sheet that
    // may carry the rule.
    return true;
  }
  return rulesMentionFirstLetter(rules, depth);
}

function rootMentionsFirstLetter(root: Document | ShadowRoot): boolean {
  try {
    const sheets = root.styleSheets;
    for (let i = 0; i < sheets.length; i += 1) {
      const sheet = sheets[i];
      if (sheet !== undefined && sheetMentionsFirstLetter(sheet, 0)) return true;
    }
    // Constructed sheets never appear in styleSheets, and a shadow root's
    // adopted list is entirely its own.
    const adopted = (root as { adoptedStyleSheets?: readonly CSSStyleSheet[] }).adoptedStyleSheets;
    if (adopted !== undefined) {
      for (let i = 0; i < adopted.length; i += 1) {
        const sheet = adopted[i];
        if (sheet !== undefined && sheetMentionsFirstLetter(sheet, 0)) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Rules across a root's sheets, or null when one cannot be read — which
 * settles the question conservatively on its own. Reading a list's length
 * never materializes its rules, so this is free at any stylesheet size.
 * Nested and imported rules go uncounted; the budget guards against one
 * large flat sheet, which is the shape a generated stylesheet has.
 */
function countRules(root: Document | ShadowRoot): number | null {
  let total = 0;
  try {
    const sheets = root.styleSheets;
    for (let i = 0; i < sheets.length; i += 1) {
      total += sheets[i]!.cssRules.length;
    }
    const adopted = (root as { adoptedStyleSheets?: readonly CSSStyleSheet[] }).adoptedStyleSheets;
    if (adopted !== undefined) {
      for (let i = 0; i < adopted.length; i += 1) {
        total += adopted[i]!.cssRules.length;
      }
    }
  } catch {
    return null;
  }
  return total;
}

function rootMayHaveFirstLetterRule(batch: ScanBatch, root: Document | ShadowRoot): boolean {
  const cached = batch.firstLetterRoots.get(root);
  if (cached !== undefined) return cached;
  const rules = countRules(root);
  // Over budget answers the same "assume the rule may exist" an unreadable
  // sheet does: the paragraphs then take the inspection they always took, and
  // the batch is no worse off than never having asked.
  const answer = rules === null || rules > batch.ruleBudget || rootMentionsFirstLetter(root);
  batch.firstLetterRoots.set(root, answer);
  return answer;
}

/**
 * Can a `::first-letter` rule apply to this paragraph at all?
 *
 * Every answer is biased toward "yes": a wrong "yes" only costs the pseudo
 * inspection that follows, while a wrong "no" would model a drop cap as
 * ordinary text and mis-render the paragraph with no way to notice.
 */
function mayHaveFirstLetterRule(p: HTMLElement, batch: ScanBatch | undefined): boolean {
  // No batch means no place to keep the answer for the rest of the scan, and
  // the walk must never run per paragraph.
  if (batch === undefined) return true;
  // A slotted paragraph renders inside a shadow tree whose sheets are not in
  // its own root, where `::slotted(p)::first-letter` would style it. (A
  // closed root hides the slot assignment as well as its sheets.)
  if (p.assignedSlot !== null) return true;
  const doc = p.ownerDocument;
  const root = p.getRootNode();
  if (root === doc) return rootMayHaveFirstLetterRule(batch, doc);
  // Realm-correct: paragraphs handed to justify() can belong to an iframe
  // document, whose ShadowRoot is not this realm's.
  const shadowRoot = doc.defaultView?.ShadowRoot;
  if (shadowRoot === undefined || !(root instanceof shadowRoot)) return true;
  return (
    rootMayHaveFirstLetterRule(batch, root) ||
    // The host document reaches into the shadow tree with
    // `::part(x)::first-letter`.
    rootMayHaveFirstLetterRule(batch, doc)
  );
}

export function floatDetailsOf(
  p: HTMLElement,
  text: string,
  paragraphStyle?: CSSStyleDeclaration,
  fragmentCount?: number,
  batch?: ScanBatch,
): { intrusion: FloatIntrusion; span: { start: number; end: number } } | string | null {
  // With no such rule in reach the pseudo-element cannot be generated, so it
  // is neither a float nor a layout hazard — exactly the `null` below.
  if (!mayHaveFirstLetterRule(p, batch)) return null;
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
  let liveFragmentCount = fragmentCount;
  if (liveFragmentCount === undefined) {
    const fragments = fragmentBoxesOf(p, cs);
    if (!fragments.ok) return fragments.reason;
    liveFragmentCount = fragments.rects.length;
  }
  if (liveFragmentCount > 1) {
    return "fragmented paragraph with floated ::first-letter";
  }
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

/** Re-read a live paragraph's supported float geometry. Exported for
 * font-driven remeasurement after the original DOM has been enhanced. */
export function floatIntrusionOf(
  p: HTMLElement,
  text = p.textContent ?? "",
  previous?: FloatIntrusion,
): FloatIntrusion | null {
  if (previous?.kind === "element") {
    const view = p.ownerDocument.defaultView;
    if (view === null) return null;
    const fragments = fragmentBoxesOf(p);
    if (!fragments.ok) return null;
    const next = leadingElementFloatOf(p, view.getComputedStyle(p), fragments.rects.length);
    return typeof next === "object" ? next : null;
  }
  const details = floatDetailsOf(p, text);
  return typeof details === "object" && details !== null ? details.intrusion : null;
}

/** Re-measure a live clone of a supported leading floated element without
 * inspecting or walking its opaque subtree. */
export function renderedElementFloatIntrusionOf(
  p: HTMLElement,
  source: Element,
  previous: ElementFloatIntrusion,
  verify: boolean,
): ElementFloatIntrusion | null {
  const view = p.ownerDocument.defaultView;
  if (view === null) return null;
  const paragraphStyle = view.getComputedStyle(p);
  const style = view.getComputedStyle(source);
  const direction: "ltr" | "rtl" = paragraphStyle.direction === "rtl" ? "rtl" : "ltr";
  const side = physicalFloatSide(style.float, direction);
  if (side === null) return null;
  const geometry = elementFloatGeometry(
    p,
    source,
    paragraphStyle,
    style,
    side,
    verify,
  );
  return geometry === null ? null : { ...previous, ...geometry };
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
