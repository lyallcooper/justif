/**
 * DOM emission via native soft wrap: each line's content is one or more
 * INLINE `white-space: nowrap` segments carrying that line's word-spacing /
 * font-stretch, with the real break space (or a <wbr> at hyphen points) left
 * between lines. Because every justified line fills the measure exactly, the
 * browser's own greedy wrap is forced to break at precisely the chosen
 * points — and because the flow stays inline:
 *   - assistive tech reads one continuous paragraph (no block boundaries),
 *     and hyphenated word fragments rejoin seamlessly;
 *   - original inline elements (links!) are cloned once and wrap across
 *     lines whole — one element, one tab stop, one accessible name;
 *   - find-in-page matches phrases across line breaks;
 *   - selection copies with spaces, not hard newlines.
 * Mid-line spaces live inside the segments, so line boundaries are the only
 * soft-wrap opportunities regardless of sub-pixel rounding. Hyphens render
 * as pseudo-content, invisible to the clipboard and accessibility tree.
 */

export interface RenderSegment {
  text: string;
  /** Source inline elements to clone around this text, outermost first. */
  ancestors: readonly Element[];
  /** Absolute word-spacing for this segment's own spaces (px). */
  wordSpacingPx: number;
  /** Absolute letter-spacing (author's + letterfit tracking), or null to
   * inherit the author's value untouched (tracking inactive on this line). */
  letterSpacingPx: number | null;
  /** Feature settings to emit when tracking needs to retain common
   * ligatures. Includes the author's low-level settings so this declaration
   * never replaces their stylistic sets or variant choices. */
  fontFeatureSettings?: string;
  /** Keep context-sensitive positional variants within the same shaping
   * unit used for measurement. CSS bidi isolation creates that boundary
   * without changing inline layout or adding DOM text. */
  isolateShaping?: boolean;
  /** The line's expansion; 100 = natural (declaration omitted). */
  fontStretchPct: number;
  /** Negative line-start protrusion on a line's first segment; 0 otherwise.
   * LOGICAL: emitted as margin-inline-start, which the browser resolves to
   * the left edge in LTR and the right edge in RTL — line starts hang into
   * the correct margin in both directions. */
  marginStartPx: number;
  /** Negative line-end protrusion + wrap-safety margin on a line's last
   * segment (shrinks layout advance only; glyphs paint unchanged). LOGICAL:
   * emitted as margin-inline-end (right in LTR, left in RTL), so the
   * corrective trailing margin always shrinks the line's advance at its
   * END edge. */
  marginEndPx: number;
  /** Edge spaces excluded from corrective measurement (position-dependent
   * rendering) and re-added as exact model widths. */
  edgeTrim: { lead: number; trail: number; modelPx: number };
  /** Inline padding/border px of cloned ancestors that open/close at this
   * segment. Layout width the text rects can't see (it sits on the clone,
   * outside the segment span) — added to the corrective model like the
   * edge-trim widths. */
  decorPx?: number;
  /** Contains CJK text: rendered with `font-kerning: none` (and Chromium's
   * text-spacing-trim disabled) so DOM advances equal the model's isolated
   * cluster advances. Engines disagree between canvas and DOM on kana
   * kerning — Chromium's DOM kerns pairs its canvas never measures, WebKit
   * is the inverse — so cross-cluster kerning cannot be measured
   * consistently; the model assumes solid setting (bete-gumi) and the
   * renderer matches it. */
  cjk?: boolean;
  /**
   * What separates this segment from the previous one:
   * "none" — same-line continuation (no break opportunity),
   * "space" — line boundary at a space (bare text node, hangs at wrap),
   * "hyphen" — line boundary at a hyphenation point (pseudo-hyphen + <wbr>),
   * "wbr" — line boundary after an explicit hyphen (zero-width, <wbr>).
   */
  joint: "none" | "space" | "hyphen" | "wbr";
}

/**
 * Provisional trailing-margin pad (px) each line carries from write time
 * until its measured correction runs: covers model drift (expansion
 * responds per glyph; canvas vs DOM variance, ≤ ~1.3px observed) so a
 * line can never re-wrap while its correction is deferred/parked.
 */
export const WRAP_SAFETY_PAD_PX = 1.5;
/** Corrections normalize every line measuring overflow above this window
 * back to exactly WRAP_SPARE_PX of slack; lines shorter than the window
 * are ragged by design (paragraph endings) and keep their margins. Wide
 * enough to re-capture lines sitting on the provisional pad. */
const CORRECTION_WINDOW_PX = -(2 * WRAP_SAFETY_PAD_PX);
/** The measured end state: layout fits the measure with this to spare. */
const WRAP_SPARE_PX = 1;

const STYLE_ID = "justif-style";
const px = (v: number): string => `${Math.round(v * 1000) / 1000}px`;

const SHEET_TEXT =
  ".justif-seg{white-space:nowrap}" +
  '.justif-hyphen::after{content:"-"}' +
  '@supports (content:"-" / ""){.justif-hyphen::after{content:"-" / ""}}';

/** Roots (documents and shadow roots) that already carry the sheet. */
const styledRoots = new WeakSet<Document | ShadowRoot>();

/**
 * Install the segment rules at the paragraph's ROOT — the document, or the
 * shadow root it lives in (document-level styles don't pierce shadow
 * boundaries; without `.justif-seg{white-space:nowrap}` the entire line
 * model silently collapses). Constructable stylesheets are preferred: they
 * also work under a strict Content-Security-Policy, where an injected
 * inline `<style>` element is blocked by `style-src` without
 * 'unsafe-inline'. The `<style>` element is only the legacy fallback
 * (pre-2023 engines without adoptedStyleSheets).
 */
function ensureStylesheet(root: Document | ShadowRoot): void {
  if (styledRoots.has(root)) return;
  // Duck-typed, not instanceof: an iframe's document is another realm's
  // Document and instanceof would misclassify it.
  const isDoc = root.nodeType === 9; /* DOCUMENT_NODE */
  const doc = isDoc ? (root as Document) : (root as ShadowRoot).ownerDocument;
  const win = doc.defaultView;
  if (win !== null && "adoptedStyleSheets" in root) {
    try {
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(SHEET_TEXT);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      styledRoots.add(root);
      return;
    } catch {
      /* same-realm constraint or frozen list: fall through to <style> */
    }
  }
  if (isDoc && doc.getElementById(STYLE_ID) !== null) {
    styledRoots.add(root);
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = SHEET_TEXT;
  (isDoc ? doc.head : (root as ShadowRoot)).append(style);
  styledRoots.add(root);
}

interface LineEntry {
  el: HTMLElement;
  seg: RenderSegment | null;
}

/**
 * A paragraph whose segments are in the DOM but whose measured wrap
 * guarantee has not run yet. Produce with `writeParagraph`, then batch any
 * number of these through `measureCorrections` (reads) + `applyCorrections`
 * (writes): interleaving the phases per paragraph would force a full layout
 * per paragraph, batching costs one for the whole flush.
 */
export interface PendingParagraph {
  doc: Document;
  lineElements: LineEntry[][];
  /** Target width per line (index-aligned with lineElements): lines under
   * a text-indent have a different measure than the rest. */
  lineWidths: readonly number[];
}


/** Write phase: build and install the segment DOM. No layout reads. */
export function writeParagraph(
  p: HTMLElement,
  segments: readonly RenderSegment[],
  lineWidths: readonly number[],
): PendingParagraph {
  const doc = p.ownerDocument;
  const root = p.getRootNode();
  ensureStylesheet(
    root.nodeType === 9 || (root.nodeType === 11 && "host" in root)
      ? (root as Document | ShadowRoot)
      : doc,
  );
  /** Per intended line: its visual elements (with their segment data);
   * the last one takes the corrective margin. */
  const lineElements: LineEntry[][] = [[]];

  const fragment = doc.createDocumentFragment();
  // One clone per source element for the whole paragraph: segments of the
  // same source element are contiguous, so a plain stack suffices and
  // elements never need duplicating (ids, tab stops, and accessible names
  // stay singular).
  const stack: Array<{ src: Element; clone: Element }> = [];
  const containerAt = (depth: number): ParentNode =>
    depth === 0 ? fragment : stack[depth - 1]!.clone;

  const commonDepth = (chain: readonly Element[]): number => {
    let i = 0;
    while (i < stack.length && i < chain.length && stack[i]!.src === chain[i]) i++;
    return i;
  };

  const containerFor = (chain: readonly Element[]): ParentNode => {
    let depth = commonDepth(chain);
    stack.length = depth;
    for (; depth < chain.length; depth++) {
      const src = chain[depth]!;
      const clone = src.cloneNode(false) as Element;
      containerAt(depth).append(clone);
      stack.push({ src, clone });
    }
    return containerAt(chain.length);
  };

  let prevContainer: ParentNode = fragment;
  for (const segment of segments) {
    if (segment.joint === "hyphen") {
      const hyphen = doc.createElement("span");
      hyphen.className = "justif-hyphen";
      // The line's trailing protrusion margin must sit AFTER the hyphen —
      // on the preceding text segment it would pull the hyphen glyph back
      // into the word it belongs to. (RTL paragraphs never hyphenate, so
      // this path is LTR-only in practice; logical margins keep it
      // direction-correct regardless.)
      const entries = lineElements[lineElements.length - 1]!;
      const prevEntry = entries[entries.length - 1];
      if (prevEntry !== undefined && prevEntry.el.style.marginInlineEnd !== "") {
        hyphen.style.marginInlineEnd = prevEntry.el.style.marginInlineEnd;
        prevEntry.el.style.marginInlineEnd = "";
      }
      prevContainer.append(hyphen);
      entries.push({ el: hyphen, seg: null });
    }
    if (segment.joint !== "none") {
      lineElements.push([]);
      // The joint lives at the deepest container common to both sides, so a
      // break inside a link keeps its space/wbr inside the link.
      const depth = Math.min(commonDepth(segment.ancestors), stack.length);
      stack.length = depth;
      const container = containerAt(depth);
      if (segment.joint === "space") container.append(doc.createTextNode(" "));
      else container.append(doc.createElement("wbr"));
    }

    const container = containerFor(segment.ancestors);
    const el = doc.createElement("span");
    el.className = "justif-seg";
    // Always written (even "0px"): an inherited word-spacing from ancestor
    // CSS must not leak into a segment whose computed adjustment is zero.
    el.style.wordSpacing = px(segment.wordSpacingPx);
    if (segment.letterSpacingPx !== null) {
      el.style.letterSpacing = px(segment.letterSpacingPx);
      if (segment.fontFeatureSettings !== undefined) {
        el.style.fontFeatureSettings = segment.fontFeatureSettings;
      }
    }
    if (segment.isolateShaping === true) el.style.unicodeBidi = "isolate";
    if (segment.fontStretchPct !== 100) {
      el.style.fontStretch = `${Math.round(segment.fontStretchPct * 100) / 100}%`;
    }
    if (segment.marginStartPx !== 0) el.style.marginInlineStart = px(segment.marginStartPx);
    if (segment.marginEndPx !== 0) el.style.marginInlineEnd = px(segment.marginEndPx);
    if (segment.cjk === true) {
      // Match the measurement model (isolated cluster advances, no
      // cross-cluster kerning — see RenderSegment.cjk).
      el.style.fontKerning = "none";
      // Chromium-only: its DOM trims fullwidth punctuation pairs by
      // default (text-spacing-trim: normal) while its canvas doesn't;
      // space-all disables the trim. A no-op in other engines.
      el.style.setProperty("text-spacing-trim", "space-all");
    }
    el.textContent = segment.text;
    container.append(el);
    prevContainer = container;
    lineElements[lineElements.length - 1]!.push({ el, seg: segment });
  }

  p.replaceChildren(fragment);
  return { doc, lineElements, lineWidths };
}

export interface Correction {
  el: HTMLElement;
  marginPx: number;
}

export interface CorrectionResult {
  corrections: Correction[];
  /**
   * Indices into `pending` of paragraphs whose content is currently
   * layout-skipped (`content-visibility: auto` off-screen): every glyph
   * run measured zero, so no correction can be computed. Callers should
   * re-queue these and retry when the paragraph becomes visible; until
   * then the provisional wrap-safety pad keeps the lines safe.
   */
  hidden: number[];
}

/**
 * Read phase of the measured wrap guarantee: models can drift
 * (variable-font expansion responds per glyph, not per calibration
 * string), and a line whose layout width exceeds the measure makes the
 * browser retreat to a mid-line boundary instead of overflowing. So
 * measure each intended line's true layout width and compute the trailing
 * margin that makes it fit with ~1px to spare — glyph positions are
 * unaffected, and the slack is far too small to pull the next segment up.
 * Pure reads (one forced layout for the whole batch, however many
 * paragraphs it spans); apply the result with `applyCorrections`.
 */
export function measureCorrections(pending: readonly PendingParagraph[]): CorrectionResult {
  const corrections: Correction[] = [];
  const hidden: number[] = [];
  let range: Range | null = null;
  for (let i = 0; i < pending.length; i++) {
    const { doc, lineElements, lineWidths } = pending[i]!;
    // A pending whose nodes were detached (the paragraph was re-patched,
    // restored, or replaced since it was queued) is stale: drop it before
    // paying any geometry reads — detached nodes measure zero like skipped
    // content, and classifying them "hidden" would park them forever.
    const firstEntry = lineElements.find((l) => l.length > 0)?.[0];
    if (firstEntry === undefined || !firstEntry.el.isConnected) continue;
    range ??= doc.createRange();
    let sawInk = false;
    const paraCorrections: Correction[] = [];
    for (let li = 0; li < lineElements.length; li++) {
      const entries = lineElements[li]!;
      if (entries.length === 0) continue;
      const availableWidth = lineWidths[li] ?? lineWidths[lineWidths.length - 1] ?? 0;
      let rectPx = 0;
      let modelPx = 0;
      let ownMargins = 0;
      for (const { el, seg } of entries) {
        if (seg === null || (seg.edgeTrim.lead === 0 && seg.edgeTrim.trail === 0)) {
          rectPx += el.getBoundingClientRect().width;
        } else {
          // Position-independent width: trimmed glyph run (measured) plus
          // exact model widths for the edge spaces.
          const node = el.firstChild as Text;
          range.setStart(node, seg.edgeTrim.lead);
          range.setEnd(node, seg.text.length - seg.edgeTrim.trail);
          rectPx += range.getBoundingClientRect().width;
          modelPx += seg.edgeTrim.modelPx;
        }
        if (seg !== null && seg.decorPx !== undefined) modelPx += seg.decorPx;
        modelPx += parseFloat(el.style.marginInlineStart) || 0;
        const me = parseFloat(el.style.marginInlineEnd) || 0;
        modelPx += me;
        ownMargins += me;
      }
      // Skipped content (content-visibility: auto off-screen) measures
      // zero rects; model widths and margins still parse, so the "is this
      // paragraph actually rendered" test uses rect reads only.
      if (rectPx !== 0) sawInk = true;
      const layout = rectPx + modelPx;
      const overflow = layout - availableWidth;
      if (overflow > CORRECTION_WINDOW_PX) {
        const last = entries[entries.length - 1]!.el;
        paraCorrections.push({ el: last, marginPx: ownMargins - (overflow + WRAP_SPARE_PX) });
      }
    }
    if (!sawInk) hidden.push(i);
    else corrections.push(...paraCorrections);
  }
  return { corrections, hidden };
}

/** Write phase of the wrap guarantee. The corrective margin lands on the
 * line's END edge (inline-end: right in LTR, left in RTL). */
export function applyCorrections(corrections: readonly Correction[]): void {
  for (const c of corrections) c.el.style.marginInlineEnd = px(c.marginPx);
}
