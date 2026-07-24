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

import { graphemes } from "../core/cjk.js";
import { fragmentBoxesOf } from "./geometry.js";
import { endWithoutCollapsibleSpaces } from "./whitespace.js";

export interface RenderSegment {
  text: string;
  /** Source prefix rendered outside the nowrap span because it belongs to
   * the paragraph's floated `::first-letter`. Keeping it in the author's
   * inline ancestor chain, but out of `.justif-seg`, preserves the native
   * float line box and keeps correction reads limited to normal-flow text. */
  floatedPrefix?: string;
  /** Computed ::first-letter longhands for the real floated source span. */
  floatedStyle?: readonly (readonly [property: string, value: string])[];
  /** Source-run styling restored on this fragment inside the one real
   * first-letter float. Anonymous spans preserve styling without cloning
   * semantic descendants (and their links/ids) a second time. */
  floatedInnerStyle?: readonly (readonly [property: string, value: string])[];
  /** Source inline elements to clone around this text, outermost first. */
  ancestors: readonly Element[];
  /** Absolute word-spacing for this segment's own spaces (px). */
  wordSpacingPx: number;
  /** Number of rendered source-space characters in this segment that came
   * from core Glue and therefore receive measured word-spacing correction.
   * Includes synthetic NBSP used to keep run-boundary glue unbreakable;
   * excludes author U+00A0/U+202F, which remain fixed box content. */
  adjustableSpaceCount: number;
  /** False for an own-segment author no-break-space box. A correction to
   * the segment's inherited letter-spacing would move those fixed spaces,
   * so drift must be absorbed by other segments on the line. */
  allowLetterCorrection: boolean;
  /** Absolute letter-spacing (author's + letterfit tracking), or null to
   * inherit the author's value untouched (tracking inactive on this line). */
  letterSpacingPx: number | null;
  /** Resolved value represented by `letterSpacingPx` (including inherited
   * author spacing when the declaration itself is omitted). */
  resolvedLetterSpacingPx: number;
  /** Portion of the terminal glyph's advance physically removed so a
   * nowrap line can fit beside a float without moving the glyph itself. */
  physicalEndHangPx?: number;
  /** Same removal for a line ending in an inserted hyphen, taken out of
   * the pseudo-hyphen's advance instead: the fit test beside a float
   * ignores the negative end margin that ordinarily encodes hyphen
   * protrusion, so a margined hyphen line drops below the float. Set on
   * the line's final text segment; the writer moves it onto the following
   * hyphen span. */
  hyphenEndHangPx?: number;
  /** Absolute letter-spacing emitted on that hyphen span (the run's own
   * letter-spacing minus hyphenEndHangPx): spacing after the "-" shrinks
   * its advance while the ink still paints past the shortened line box. */
  hyphenLetterSpacingPx?: number;
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
  /** Painted source inline whose clone receives `marginStartPx`, moving its
   * halo into the margin along with its contents. */
  marginStartOwner?: Element;
  /** Negative line-end protrusion + wrap-safety margin on a line's last
   * segment (shrinks layout advance only; glyphs paint unchanged). LOGICAL:
   * emitted as margin-inline-end (right in LTR, left in RTL), so the
   * corrective trailing margin always shrinks the line's advance at its
   * END edge. */
  marginEndPx: number;
  /** Intended optical protrusion of this line's final glyph. Assigned only
   * to the actual final text segment. */
  rightHangPx?: number;
  /** Deliberate excess after all configured shrink resources are exhausted.
   * Unlike DOM/canvas drift, this remains visibly overfull. */
  overflowPx?: number;
  /** Painted source inline whose clone receives `marginEndPx`. */
  marginEndOwner?: Element;
  /** Edge spaces excluded from corrective measurement (position-dependent
   * rendering) and re-added as exact model widths. */
  edgeTrim: { lead: number; trail: number; modelPx: number };
  /** Inline padding/border px of cloned ancestors that open/close at this
   * segment. Layout width the text rects can't see (it sits on the clone,
   * outside the segment span) — added to the corrective model like the
   * edge-trim widths. */
  decorPx?: number;
  /** Clone whose painted border edge closes `decorPx` on this segment. */
  decorEndOwner?: Element;
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

/** A mandatory source break between independently laid-out segments. The
 * writer clones the real element so selection, copying, accessibility, and
 * inline ancestry retain native <br> semantics. */
export interface RenderHardBreak {
  kind: "hard-break";
  source: Element;
  ancestors: readonly Element[];
}

export type RenderContent = RenderSegment | RenderHardBreak;

/**
 * Provisional trailing-margin pad (px) each line carries from write time
 * until its measured correction runs: covers model drift (expansion
 * responds per glyph; canvas vs DOM variance, ≤ ~1.3px observed) so a
 * line can never re-wrap while its correction is deferred/parked.
 */
export const WRAP_SAFETY_PAD_PX = 1.5;
/** Correct every line measuring above this window; lines shorter than it
 * are ragged by design (paragraph endings) and keep their provisional
 * margins. Wide enough to re-capture set lines sitting on the safety pad. */
const CORRECTION_WINDOW_PX = -(2 * WRAP_SAFETY_PAD_PX);
/** Physical slack retained beside a float. Firefox can reject an
 * exactly-equal later nowrap fragment after device-pixel rounding. */
const FLOAT_WRAP_SPARE_PX = 0.25;
const STYLE_ID = "justif-style";
const px = (v: number): string => `${Math.round(v * 1000) / 1000}px`;

const SHEET_TEXT =
  ".justif-seg{white-space:nowrap}" +
  // Once the source letter is a real float, Firefox retargets the
  // paragraph pseudo to the first normal-flow letter. Neutralize that
  // second pseudo; the real float carries the snapshotted author styles.
  "[data-justif-dropcap]::first-letter{all:unset!important}" +
  '.justif-hyphen::after{content:"-"}' +
  '@supports (content:"-" / ""){.justif-hyphen::after{content:"-" / ""}}';

/**
 * Pin rendered text to the CSS font size. iOS Safari's automatic text
 * autosizing is a post-CSS multiplier that can change after measurement and
 * can differ between the nowrap fragments that make up adjacent lines.
 * Inline !important is intentional: these metrics are as load-bearing as the
 * emitted px spacing, and neither a more-specific host rule nor a declaration
 * on an intervening cloned element may change them after measurement.
 */
export function disableTextAutosizing(el: HTMLElement): void {
  el.style.setProperty("-webkit-text-size-adjust", "100%", "important");
  el.style.setProperty("text-size-adjust", "100%", "important");
}

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
  marginEndEl: HTMLElement;
  /** Closing decorated-inline clone, when its border edge is the line's
   * physical painted end even though it carries no protrusion margin. */
  paintEndEl?: HTMLElement;
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
  paragraph: HTMLElement;
  lineElements: LineEntry[][];
  /** Target width per line (index-aligned with lineElements): lines under
   * a text-indent have a different measure than the rest. */
  lineWidths: readonly number[];
  /** Leading lines whose coordinate edge depends on a float. Correct these
   * from their measured physical width rather than the paragraph edge. */
  physicalFitLines: number;
}


/** Write phase: build and install the segment DOM. No layout reads. */
export function writeParagraph(
  p: HTMLElement,
  contents: readonly RenderContent[],
  lineWidths: readonly number[],
  physicalFitLines = 0,
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

  const cloneFor = (
    src: Element | undefined,
    chain: readonly Element[],
  ): HTMLElement | undefined => {
    if (src === undefined) return undefined;
    const depth = chain.indexOf(src);
    return depth < 0 ? undefined : (stack[depth]?.clone as HTMLElement | undefined);
  };

  let prevContainer: ParentNode = fragment;
  let floatSource: HTMLElement | null = null;
  const segments = contents.filter(
    (content): content is RenderSegment => !("kind" in content),
  );
  const floatBaseStyle = new Map(
    segments.find((segment) => segment.floatedStyle !== undefined)?.floatedStyle ?? [],
  );
  const floatInnerProperties = new Set(
    segments.flatMap((segment) =>
      (segment.floatedInnerStyle ?? []).map(([property]) => property),
    ),
  );
  let lastWasHardBreak = false;
  for (const content of contents) {
    if ("kind" in content) {
      const container = containerFor(content.ancestors);
      container.append(content.source.cloneNode(false));
      prevContainer = container;
      lineElements.push([]);
      lastWasHardBreak = true;
      continue;
    }
    const segment = content;
    lastWasHardBreak = false;
    if (segment.joint === "hyphen") {
      const hyphen = doc.createElement("span");
      hyphen.className = "justif-hyphen";
      disableTextAutosizing(hyphen);
      // The line's trailing protrusion margin must sit AFTER the hyphen —
      // on the preceding text segment it would pull the hyphen glyph back
      // into the word it belongs to. (RTL paragraphs never hyphenate, so
      // this path is LTR-only in practice; logical margins keep it
      // direction-correct regardless.)
      const entries = lineElements[lineElements.length - 1]!;
      const prevEntry = entries[entries.length - 1];
      if (prevEntry !== undefined && prevEntry.marginEndEl.style.marginInlineEnd !== "") {
        hyphen.style.marginInlineEnd = prevEntry.marginEndEl.style.marginInlineEnd;
        prevEntry.marginEndEl.style.marginInlineEnd = "";
      }
      // Beside a float the hyphen's optical hang is removed from its
      // physical advance rather than carried in the margin above (see
      // RenderSegment.hyphenEndHangPx).
      if (prevEntry?.seg?.hyphenLetterSpacingPx !== undefined) {
        hyphen.style.letterSpacing = px(prevEntry.seg.hyphenLetterSpacingPx);
      }
      prevContainer.append(hyphen);
      entries.push({ el: hyphen, seg: null, marginEndEl: hyphen });
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
    if (segment.floatedPrefix !== undefined) {
      if (floatSource === null) {
        floatSource = doc.createElement("span");
        floatSource.className = "justif-float-source";
        disableTextAutosizing(floatSource);
        for (const [property, value] of segment.floatedStyle ?? []) {
          floatSource.style.setProperty(property, value);
        }
        container.append(floatSource);
      }
      if (floatInnerProperties.size === 0) {
        floatSource.append(doc.createTextNode(segment.floatedPrefix));
      } else {
        const innerStyle = new Map(segment.floatedInnerStyle ?? []);
        const fragment = doc.createElement("span");
        fragment.className = "justif-float-fragment";
        // The real float is nested under the first source run's cloned
        // ancestors. For every property any floated run overrides, later
        // fragments must either apply their own override or reset to the
        // snapshotted pseudo value instead of inheriting that first run.
        for (const property of floatInnerProperties) {
          const value = innerStyle.get(property) ?? floatBaseStyle.get(property);
          if (value !== undefined) fragment.style.setProperty(property, value);
        }
        fragment.append(doc.createTextNode(segment.floatedPrefix));
        floatSource.append(fragment);
      }
    }
    // A first-letter range can consume a whole styling run. Its source text
    // still belongs in the cloned DOM, but there is no normal-flow segment
    // to measure or correct for that run.
    if (segment.text.length === 0) {
      prevContainer = container;
      continue;
    }
    const el = doc.createElement("span");
    el.className = "justif-seg";
    disableTextAutosizing(el);
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
    const marginStartEl = cloneFor(segment.marginStartOwner, segment.ancestors) ?? el;
    const marginEndEl = cloneFor(segment.marginEndOwner, segment.ancestors) ?? el;
    const paintEndEl = cloneFor(segment.decorEndOwner, segment.ancestors);
    if (segment.marginStartPx !== 0) {
      marginStartEl.style.marginInlineStart = px(segment.marginStartPx);
    }
    if (segment.marginEndPx !== 0) marginEndEl.style.marginInlineEnd = px(segment.marginEndPx);
    if (segment.cjk === true) {
      // Match the measurement model (isolated cluster advances, no
      // cross-cluster kerning — see RenderSegment.cjk).
      el.style.fontKerning = "none";
      // Chromium-only: its DOM trims fullwidth punctuation pairs by
      // default (text-spacing-trim: normal) while its canvas doesn't;
      // space-all disables the trim. A no-op in other engines.
      el.style.setProperty("text-spacing-trim", "space-all");
    }
    if (segment.physicalEndHangPx !== undefined && segment.physicalEndHangPx > 0) {
      const clusters = graphemes(segment.text);
      let end = clusters.length - 1;
      while (end >= 0 && /^\s+$/u.test(clusters[end]!)) end--;
      const hanging = clusters[end];
      if (hanging === undefined) el.textContent = segment.text;
      else {
        const before = clusters.slice(0, end).join("");
        const after = clusters.slice(end + 1).join("");
        el.append(before);
        const span = doc.createElement("span");
        span.className = "justif-hanging-end";
        span.style.letterSpacing = px(
          segment.resolvedLetterSpacingPx - segment.physicalEndHangPx,
        );
        span.textContent = hanging;
        el.append(span, after);
      }
    } else el.textContent = segment.text;
    container.append(el);
    prevContainer = container;
    lineElements[lineElements.length - 1]!.push({
      el,
      seg: segment,
      marginEndEl,
      paintEndEl,
    });
  }

  // A trailing <br> terminates the current line but does not create another
  // line box after itself. Consecutive breaks retain all preceding empty
  // entries, so <br><br> still contributes two native-height lines.
  if (lastWasHardBreak) lineElements.pop();
  p.replaceChildren(fragment);
  return { doc, paragraph: p, lineElements, lineWidths, physicalFitLines };
}

export interface SpacingCorrection {
  el: HTMLElement;
  property: "word-spacing" | "letter-spacing";
  px: number;
}

export interface Correction {
  el: HTMLElement;
  /** Element currently carrying the provisional end margin. */
  marginEl: HTMLElement;
  marginPx: number;
  /** Measured spacing adjustments that make the painted glyph edge agree
   * with the model rather than hiding DOM/canvas drift in an end margin. */
  spacing?: SpacingCorrection[];
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
  /** Paragraph indices whose live fragments are not equal-width columns. */
  invalid: Array<{ index: number; reason: string }>;
}

/** Pick the fragment containing a line's logical start. Horizontal distance
 * distinguishes adjacent columns; vertical distance also handles fragments
 * stacked like pages. Small hanging indents may put the point just outside
 * its fragment, so nearest-rectangle distance is used instead of contains(). */
function fragmentForLine(
  rects: readonly DOMRect[],
  lineRect: DOMRect,
  rtl: boolean,
): DOMRect {
  const x = rtl ? lineRect.right : lineRect.left;
  const y = lineRect.top + lineRect.height / 2;
  let best = rects[0]!;
  let bestDistance = Infinity;
  for (const rect of rects) {
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = rect;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Read phase of the measured wrap guarantee: models can drift
 * (variable-font expansion responds per glyph, not per calibration
 * string), and a line whose layout width exceeds the measure makes the
 * browser retreat to a mid-line boundary instead of overflowing. So
 * measure each intended line's true painted edge, then correct its spacing
 * to the modeled edge and retain only the intentional optical end margin.
 * The provisional safety margin prevents rewrapping until that correction
 * lands. Pure reads (one forced layout for the whole batch, however many
 * paragraphs it spans); apply the result with `applyCorrections`.
 */
export function measureCorrections(pending: readonly PendingParagraph[]): CorrectionResult {
  const corrections: Correction[] = [];
  const hidden: number[] = [];
  const invalid: Array<{ index: number; reason: string }> = [];
  let range: Range | null = null;
  for (let i = 0; i < pending.length; i++) {
    const { doc, paragraph, lineElements, lineWidths, physicalFitLines } = pending[i]!;
    // A pending whose nodes were detached (the paragraph was re-patched,
    // restored, or replaced since it was queued) is stale: drop it before
    // paying any geometry reads — detached nodes measure zero like skipped
    // content, and classifying them "hidden" would park them forever.
    const firstEntry = lineElements.find((l) => l.length > 0)?.[0];
    if (firstEntry === undefined || !firstEntry.el.isConnected) continue;
    range ??= doc.createRange();
    const paragraphStyle = doc.defaultView?.getComputedStyle(paragraph);
    const rtl = paragraphStyle?.direction === "rtl";
    const fragments = fragmentBoxesOf(paragraph, paragraphStyle);
    if (!fragments.ok) {
      if (fragments.reason === "zero content width") hidden.push(i);
      else invalid.push({ index: i, reason: fragments.reason });
      continue;
    }
    let sawInk = false;
    const paraCorrections: Correction[] = [];
    for (let li = 0; li < lineElements.length; li++) {
      const entries = lineElements[li]!;
      if (entries.length === 0) continue;
      const availableWidth = lineWidths[li] ?? lineWidths[lineWidths.length - 1] ?? 0;
      let rectPx = 0;
      let modelPx = 0;
      let ownMargins = 0;
      let lineRect: DOMRect | null = null;
      for (const { el, seg, marginEndEl } of entries) {
        let elRect: DOMRect | undefined;
        if (lineRect === null) {
          elRect = el.getBoundingClientRect();
          lineRect = elRect;
        }
        if (seg === null || (seg.edgeTrim.lead === 0 && seg.edgeTrim.trail === 0)) {
          rectPx += (elRect ?? el.getBoundingClientRect()).width;
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
        // Start margins are never relocated; the exact modeled value is
        // already on the segment (unlike end margins, whose carrier can be
        // transferred to a hyphen or hoisted out of a closing clone).
        modelPx += seg?.marginStartPx ?? 0;
        const me = parseFloat(marginEndEl.style.marginInlineEnd) || 0;
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
        const textEntries = entries.filter(
          (entry): entry is LineEntry & { seg: RenderSegment } => entry.seg !== null,
        );
        const endText = textEntries[textEntries.length - 1];
        const rightHang = endText?.seg.rightHangPx ?? 0;
        // Terminal-glyph and pseudo-hyphen removals are mutually exclusive
        // (a line ends in one or the other); both mean "this much of
        // rightHang is already out of the measured rects".
        const physicalEndHang =
          (endText?.seg.physicalEndHangPx ?? 0) + (endText?.seg.hyphenEndHangPx ?? 0);
        const deliberateOverflow = endText?.seg.overflowPx ?? 0;
        const besideFloat = li < physicalFitLines;
        // Set lines should PAINT at the modeled edge too. The former
        // margin-only correction made their layout advance fit but left
        // Firefox's Georgia glyphs visibly 2–3px outside the column. Away
        // from a float we can read that coordinate directly. Beside a
        // float (which may occupy either edge), correct the physical line
        // width instead: content width = measure + intentional overhang,
        // while the matching negative end margin removes that overhang
        // from layout. The punctuation itself never moves away from its
        // preceding glyph.
        const physicalLayout = layout - ownMargins;
        let adjustmentPx: number;
        if (besideFloat) {
          adjustmentPx =
            physicalLayout -
            (availableWidth -
              FLOAT_WRAP_SPARE_PX +
              rightHang -
              physicalEndHang +
              deliberateOverflow);
        } else {
          const fragment = fragmentForLine(fragments.rects, lineRect!, rtl === true);
          const contentEnd = rtl
            ? fragment.left +
              (parseFloat(paragraphStyle?.borderLeftWidth ?? "") || 0) +
              (parseFloat(paragraphStyle?.paddingLeft ?? "") || 0)
            : fragment.right -
              (parseFloat(paragraphStyle?.borderRightWidth ?? "") || 0) -
              (parseFloat(paragraphStyle?.paddingRight ?? "") || 0);
          const paintEndEntry = entries[entries.length - 1]!;
          let paintRect: DOMRect;
          if (paintEndEntry.paintEndEl !== undefined) {
            paintRect = paintEndEntry.paintEndEl.getBoundingClientRect();
          } else if (
            paintEndEntry.seg !== null &&
            paintEndEntry.seg.marginEndOwner !== undefined &&
            paintEndEntry.marginEndEl !== paintEndEntry.el
          ) {
            paintRect = paintEndEntry.marginEndEl.getBoundingClientRect();
          } else if (paintEndEntry.seg === null) {
            paintRect = paintEndEntry.el.getBoundingClientRect();
          } else {
            const node = endText?.el.firstChild;
            const end =
              endText === undefined ? 0 : endWithoutCollapsibleSpaces(endText.seg.text);
            if (node?.nodeType === 3 && end > 0) {
              range.setStart(node, 0);
              range.setEnd(node, end);
              paintRect = range.getBoundingClientRect();
            } else paintRect = paintEndEntry.el.getBoundingClientRect();
          }
          let paintedEnd = rtl ? -paintRect.left : paintRect.right;
          // A provisional margin on the final text span sits INSIDE a
          // padded ancestor and pinches that ancestor's border box. The
          // write phase hoists it to the ancestor's outside, restoring the
          // missing inset. Measure the edge we will have after that hoist,
          // or the safety pad gets converted into a visible 1.5px overhang.
          if (
            paintEndEntry.paintEndEl !== undefined &&
            paintEndEntry.marginEndEl !== paintEndEntry.paintEndEl &&
            paintEndEntry.paintEndEl.contains(paintEndEntry.marginEndEl)
          ) {
            paintedEnd -= parseFloat(paintEndEntry.marginEndEl.style.marginInlineEnd) || 0;
          }
          const desiredEnd = (rtl ? -contentEnd : contentEnd) + rightHang + deliberateOverflow;
          adjustmentPx = paintedEnd - desiredEnd;
        }
        // A retreated segment's collapsible prefix is discarded at the
        // physical line start, so it cannot absorb distributed spacing.
        // Other edge-trimmed spaces can sit at mid-line run boundaries and
        // do paint; keep those in the divisor. (All edge trims are modeled
        // separately only because their Range widths are position-sensitive.)
        const correctionTexts = textEntries.map((entry, entryIndex) =>
          entry.seg.text.slice(entryIndex === 0 ? entry.seg.edgeTrim.lead : 0),
        );
        const spaceCounts = textEntries.map(
          (entry, entryIndex) =>
            Math.max(
              0,
              entry.seg.adjustableSpaceCount -
                (entryIndex === 0 ? entry.seg.edgeTrim.lead : 0),
            ),
        );
        const spaces = spaceCounts.reduce((sum, count) => sum + count, 0);
        const spacing: SpacingCorrection[] = [];
        if (Math.abs(adjustmentPx) > 0.001 && spaces > 0) {
          const delta = adjustmentPx / spaces;
          for (let entryIndex = 0; entryIndex < textEntries.length; entryIndex++) {
            if (spaceCounts[entryIndex] === 0) continue;
            const entry = textEntries[entryIndex]!;
            spacing.push({
              el: entry.el,
              property: "word-spacing",
              px: (parseFloat(entry.el.style.wordSpacing) || 0) - delta,
            });
          }
        } else if (Math.abs(adjustmentPx) > 0.001) {
          const charCounts = correctionTexts.map((text, entryIndex) =>
            textEntries[entryIndex]!.seg.allowLetterCorrection ? Array.from(text).length : 0,
          );
          const chars = charCounts.reduce((sum, count) => sum + count, 0);
          if (chars > 0) {
            const delta = adjustmentPx / chars;
            for (let entryIndex = 0; entryIndex < textEntries.length; entryIndex++) {
              if (charCounts[entryIndex] === 0) continue;
              const entry = textEntries[entryIndex]!;
              const computed = entry.el.ownerDocument.defaultView?.getComputedStyle(entry.el);
              spacing.push({
                el: entry.el,
                property: "letter-spacing",
                px: (parseFloat(computed?.letterSpacing ?? "") || 0) - delta,
              });
            }
          }
        }
        // With no legitimate spacing recipient, keep the provisional wrap
        // margin instead of changing an author no-break-space box. This is
        // the only faithful fallback for a line made solely of fixed boxes.
        if (Math.abs(adjustmentPx) > 0.001 && spacing.length === 0) continue;
        const lineEndEntry = entries[entries.length - 1]!;
        paraCorrections.push({
          el: lineEndEntry.el,
          marginEl: lineEndEntry.marginEndEl,
          // Spacing now puts the measured painted edge at the requested
          // optical position. Its matching layout exclusion is therefore
          // exactly the intentional hang/overfull amount; deriving this
          // margin again from summed DOM widths lets engine-specific inline
          // rounding leak back in (notably Firefox's persistent 1.5px).
          marginPx:
            -(rightHang - (besideFloat ? physicalEndHang : 0) + deliberateOverflow),
          spacing: spacing.length > 0 ? spacing : undefined,
        });
      }
    }
    if (!sawInk) hidden.push(i);
    else corrections.push(...paraCorrections);
  }
  return { corrections, hidden, invalid };
}

/** Write phase of the wrap guarantee. The corrective margin lands on the
 * line's END edge (inline-end: right in LTR, left in RTL) — hoisted OUT of
 * any cloned inline element that closes at this line end. Inside the clone
 * the negative margin shrinks the clone's own decoration box, visibly
 * pinching a padded chip's end inset; inline-end margins accumulate at the
 * same line edge wherever they sit in the nesting, so the hoist is
 * layout-neutral. A clone whose element continues onto the next line has
 * later children, so the walk stops there and the margin stays inside —
 * where that line actually ends. */
export function applyCorrections(corrections: readonly Correction[]): void {
  for (const c of corrections) {
    for (const spacing of c.spacing ?? []) {
      spacing.el.style.setProperty(spacing.property, px(spacing.px));
    }
    let target = c.el;
    for (
      let parent = target.parentElement;
      parent !== null &&
      !parent.hasAttribute("data-justif") &&
      parent.lastChild === target;
      parent = target.parentElement
    ) {
      target = parent;
    }
    if (c.marginEl !== target) c.marginEl.style.marginInlineEnd = "0px";
    target.style.marginInlineEnd = px(c.marginPx);
  }
}
