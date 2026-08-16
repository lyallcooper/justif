/**
 * Reading back what the engine actually rendered, and correcting it to the
 * model.
 *
 * A patch writes lines modelled on measured glyph advances. The engine then
 * lays those lines out for real, and the two disagree by small amounts:
 * canvas and DOM round differently, font expansion responds per glyph, a
 * decorated inline's border edge lands where the model did not predict. Left
 * alone that drift is invisible at the left edge and glaring at the right,
 * where a justified paragraph's whole point is that the lines end together.
 *
 * So every line is written with a provisional trailing pad — wide enough that
 * it can never re-wrap while uncorrected — and this is the pass that measures
 * the real thing and replaces that pad with the exact remainder. What it
 * measures is deliberately the PAINTED end, not the content end: a line ends
 * where its last ink is, which for a hanging mark or a protruding glyph is
 * not where the box ends.
 *
 * Reads and writes are strictly separated (`measureCorrections` then
 * `applyCorrections`) because a batch of paragraphs must cost one forced
 * layout between them, not one each. Deciding WHICH paragraphs to put through
 * this, what to do when one cannot be measured, and how to handle a paragraph
 * whose own width moved under the patch is ./corrections.js.
 */

import { describeError } from "../core/errors.js";
import { FRAGMENT_WIDTH_TOLERANCE_PX, fragmentBoxesOf } from "./geometry.js";
import { endWithoutCollapsibleSpaces } from "./whitespace.js";
import {
  CORRECTION_WINDOW_PX,
  FLOAT_WRAP_SPARE_PX,
  hangCarrierShed,
  type LineEntry,
  type PendingParagraph,
  px,
  type RenderSegment,
} from "./write.js";

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

/**
 * What the correction pass concluded about ONE paragraph. Returned one per
 * input, in input order, so no caller has to keep parallel index arrays in
 * step — the alignment that used to have to be re-verified by hand.
 */
export type ParagraphOutcome =
  /** Its segment DOM is no longer in the document: it was re-patched,
   * restored or replaced since it was queued. Nothing to do. */
  | { status: "stale" }
  /**
   * Content currently skipped by layout (`content-visibility: auto`
   * off-screen): every glyph run measured zero, so no correction can be
   * computed. Re-queue and retry when the paragraph nears the viewport;
   * until then the provisional wrap-safety pad keeps the lines safe.
   */
  | { status: "hidden" }
  /**
   * Measured zero, but nothing about this paragraph licenses being skipped.
   * Something has collapsed it — including, possibly, a repair the caller
   * itself just applied — and silently parking it would strand it invisible.
   */
  | { status: "collapsed" }
  /**
   * The patch changed the paragraph's own measure. Carries the live measure
   * and the two computed values a repair has to be chosen from: `min-width`,
   * whose `auto` says the paragraph is itself a flex or grid item, and
   * `contain`, which any repair must compose with rather than replace.
   */
  | { status: "resized"; width: number; minWidth: string; contain: string }
  /** Cannot be corrected safely; the paragraph should go back to the engine. */
  | { status: "invalid"; reason: string }
  /** Correctable. `corrections` may be empty when no line needed one. */
  | { status: "corrected"; corrections: readonly Correction[] };

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
 * Whether third-party code (a browser extension, an annotation tool) has
 * restructured any of this line's segments. The measurements below index
 * into their text nodes with write-time offsets, so a foreign-mutated line
 * cannot be measured against the model — its provisional wrap-safety margin
 * stays standing instead.
 */
function foreignMutated(entries: readonly LineEntry[]): boolean {
  return entries.some(({ el, seg }) => {
    if (seg === null) return false;
    const singleText =
      el.childNodes.length === 1 &&
      el.firstChild?.nodeType === 3 &&
      (el.firstChild as Text).data === seg.text;
    // The shed — a terminal glyph's hang, the wrap-safety pad, or both — is
    // what puts a span in the segment, so it is also what says which shape is
    // the writer's own. Reading the hang alone called a pad-only segment's
    // carrier foreign and skipped an ordinary line's correction.
    if (hangCarrierShed(seg) <= 0) {
      return !singleText;
    }
    // A shedding segment legitimately holds text around its own
    // hanging-cluster span (or a lone text node when every cluster is
    // whitespace); anything else is foreign.
    const mid = el.childNodes[1] as Element | undefined;
    const hangShape =
      el.childNodes.length === 3 &&
      el.firstChild?.nodeType === 3 &&
      mid?.nodeType === 1 &&
      mid.className === "justif-hanging-end" &&
      el.lastChild?.nodeType === 3 &&
      el.textContent === seg.text;
    return !(singleText || hangShape);
  });
}

/**
 * The text node and offset holding character index `index` of a segment's
 * complete text. A plain segment is one text node, but a physical-end-hang
 * segment nests its hanging cluster inside a span ([text, span, text]), so
 * an offset can live past the first node. Boundary offsets resolve to the
 * end of the earlier node; null only when the segment holds no text at all.
 */
function segmentTextPoint(
  el: Element,
  index: number,
): { node: Text; offset: number } | null {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = index;
  let last: Text | null = null;
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const text = n as Text;
    if (remaining <= text.length) return { node: text, offset: remaining };
    remaining -= text.length;
    last = text;
  }
  return last === null ? null : { node: last, offset: last.length };
}

interface LineExtent {
  /** Measured glyph-run width (edge spaces excluded — see modelPx). */
  rectPx: number;
  /** Exactly modeled contributions: edge spaces, decorations, margins. */
  modelPx: number;
  /** The line's own end margins, which layout excludes but paint does not. */
  ownMargins: number;
  /** First entry's rect, identifying the line's fragment and line box. */
  lineRect: DOMRect | null;
  /** A read this line depends on had to index a glyph run by source offset
   * on a segment whose transform changes the text's length. No correction can
   * be derived; the line keeps its provisional pad, as for a re-wrapped one. */
  unmeasurable: boolean;
}

/** Reads one line's true painted extent. Rect reads only for the glyph runs;
 * every space at a segment edge is taken from the model instead, because a
 * Range over a leading space measures narrower at a line start than mid-line
 * (which made the naive correction circular). */
function measureLineExtent(entries: readonly LineEntry[], range: Range): LineExtent {
  let rectPx = 0;
  let modelPx = 0;
  let ownMargins = 0;
  let lineRect: DOMRect | null = null;
  let unmeasurable = false;
  for (const { el, seg, marginEndEl } of entries) {
    let elRect: DOMRect | undefined;
    if (lineRect === null) {
      elRect = el.getBoundingClientRect();
      lineRect = elRect;
    }
    if (seg === null || (seg.edgeTrim.lead === 0 && seg.edgeTrim.trail === 0)) {
      rectPx += (elRect ?? el.getBoundingClientRect()).width;
    } else {
      // Only edge spaces force this branch, and only a Range can exclude them
      // (the element rect above includes them). A transform that changes the
      // text's length puts source offsets out of step with the glyph run, so
      // this particular read cannot be trusted — give up on the line rather
      // than correct it by a wrong amount. The endpoints are resolved across
      // the segment's text nodes because a physical-end-hang segment nests
      // its hanging cluster in a span; its negative letter-spacing keeps the
      // hung advance out of the range's layout rects, exactly as it stays
      // out of the element rect the other branch reads.
      if (seg.transformChangesLength === true) unmeasurable = true;
      const start = segmentTextPoint(el, seg.edgeTrim.lead);
      const end = segmentTextPoint(el, seg.text.length - seg.edgeTrim.trail);
      if (start === null || end === null) {
        unmeasurable = true;
      } else {
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        rectPx += range.getBoundingClientRect().width;
        modelPx += seg.edgeTrim.modelPx;
      }
    }
    if (seg !== null && seg.decorPx !== undefined) modelPx += seg.decorPx;
    // Start margins are never relocated; the exact modeled value is already
    // on the segment (unlike end margins, whose carrier can be transferred
    // to a hyphen or hoisted out of a closing clone).
    modelPx += seg?.marginStartPx ?? 0;
    const me = parseFloat(marginEndEl.style.marginInlineEnd) || 0;
    modelPx += me;
    ownMargins += me;
  }
  return { rectPx, modelPx, ownMargins, lineRect, unmeasurable };
}

/** Coordinate of a fragment's content-box end edge (its line-end side). */
function contentEndOf(
  fragment: DOMRect,
  paragraphStyle: CSSStyleDeclaration | undefined,
  rtl: boolean,
): number {
  return rtl
    ? fragment.left +
        (parseFloat(paragraphStyle?.borderLeftWidth ?? "") || 0) +
        (parseFloat(paragraphStyle?.paddingLeft ?? "") || 0)
    : fragment.right -
        (parseFloat(paragraphStyle?.borderRightWidth ?? "") || 0) -
        (parseFloat(paragraphStyle?.paddingRight ?? "") || 0);
}

/**
 * Where this line's ink actually ends, and the rect that coordinate came
 * from. The carrier of the painted edge is whichever of these closes the
 * line: a decorated inline's border box, the clone holding a relocated end
 * margin, a pseudo-hyphen span, or the final glyph run itself (measured
 * without its collapsible trailing spaces, which paint nothing).
 *
 * Null when only a source-offset Range could carry the answer and this
 * segment's `text-transform` changes the text's length, which puts those
 * offsets out of step with the glyph run — the same read measureLineExtent
 * refuses to make. The caller leaves the line's provisional pad standing.
 */
function paintedEndOf(
  entries: readonly LineEntry[],
  endText: (LineEntry & { seg: RenderSegment }) | undefined,
  range: Range,
  rtl: boolean,
): { value: number; rect: DOMRect } | null {
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
    const end = endText === undefined ? 0 : endWithoutCollapsibleSpaces(endText.seg.text);
    if (node?.nodeType === 3 && end > 0) {
      if (end === (node as Text).length && node === endText!.el.lastChild) {
        // Nothing to strip, and the text node is the element's only child: the
        // Range would span exactly the element's content box, so read the
        // ELEMENT instead. Same coordinate, one less Range — and the only read
        // of the two that stays correct when a `text-transform` changes the
        // text's length (see RenderSegment.transformChangesLength). Measured:
        // no emitted segment in 181 justified lines carried a trailing
        // collapsible space, so this is the path lines actually take.
        paintRect = endText!.el.getBoundingClientRect();
      } else {
        if (endText!.seg.transformChangesLength === true) return null;
        // Resolved across the segment's text nodes: the painted end can sit
        // inside a physical-end-hang segment's hanging-cluster span.
        const endPoint = segmentTextPoint(endText!.el, end);
        if (endPoint === null) return null;
        range.setStart(node, 0);
        range.setEnd(endPoint.node, endPoint.offset);
        paintRect = range.getBoundingClientRect();
      }
    } else paintRect = paintEndEntry.el.getBoundingClientRect();
  }
  let value = rtl ? -paintRect.left : paintRect.right;
  // A provisional margin on the final text span sits INSIDE a padded
  // ancestor and pinches that ancestor's border box. The write phase hoists
  // it to the ancestor's outside, restoring the missing inset. Measure the
  // edge we will have after that hoist, or the safety pad gets converted
  // into a visible 1.5px overhang.
  if (
    paintEndEntry.paintEndEl !== undefined &&
    paintEndEntry.marginEndEl !== paintEndEntry.paintEndEl &&
    paintEndEntry.paintEndEl.contains(paintEndEntry.marginEndEl)
  ) {
    value -= parseFloat(paintEndEntry.marginEndEl.style.marginInlineEnd) || 0;
  }
  return { value, rect: paintRect };
}

/**
 * Spreads `adjustmentPx` (measured painted edge minus modeled edge) over the
 * line's word spaces, or over its characters when the line has no adjustable
 * space left. Returns an empty list when nothing may legitimately absorb it
 * — a line of fixed boxes only, or an adjustment below the write precision.
 */
function distributeAdjustment(
  textEntries: readonly (LineEntry & { seg: RenderSegment })[],
  adjustmentPx: number,
): SpacingCorrection[] {
  if (Math.abs(adjustmentPx) <= 0.001) return [];
  // A retreated segment's collapsible prefix is discarded at the physical
  // line start, so it cannot absorb distributed spacing. Other edge-trimmed
  // spaces can sit at mid-line run boundaries and do paint; keep those in
  // the divisor. (All edge trims are modeled separately only because their
  // Range widths are position-sensitive.)
  const spaceCounts = textEntries.map((entry, entryIndex) =>
    Math.max(
      0,
      entry.seg.adjustableSpaceCount - (entryIndex === 0 ? entry.seg.edgeTrim.lead : 0),
    ),
  );
  const spacing: SpacingCorrection[] = [];
  const spaces = spaceCounts.reduce((sum, count) => sum + count, 0);
  if (spaces > 0) {
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
    return spacing;
  }
  const charCounts = textEntries.map((entry, entryIndex) =>
    entry.seg.allowLetterCorrection
      ? Array.from(entry.seg.text.slice(entryIndex === 0 ? entry.seg.edgeTrim.lead : 0)).length
      : 0,
  );
  const chars = charCounts.reduce((sum, count) => sum + count, 0);
  if (chars === 0) return spacing;
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
  return spacing;
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
export function measureCorrections(
  pending: readonly PendingParagraph[],
  /** Whether each paragraph also needs detailed line correction. Width is
   * always validated, including for far-offscreen entries. */
  detailed?: readonly boolean[],
): ParagraphOutcome[] {
  const outcomes: ParagraphOutcome[] = [];
  let range: Range | null = null;
  for (let i = 0; i < pending.length; i++) {
    try {
      const {
        doc,
        paragraph,
        lineElements,
        lineWidths,
        contentWidth,
        physicalFitLines,
      } = pending[i]!;
      // A pending whose nodes were detached (the paragraph was re-patched,
      // restored, or replaced since it was queued) is stale: say so before
      // paying any geometry reads — detached nodes measure zero like skipped
      // content, and classifying them "hidden" would park them forever.
      const firstEntry = lineElements.find((l) => l.length > 0)?.[0];
      if (firstEntry === undefined || !firstEntry.el.isConnected) {
        outcomes.push({ status: "stale" });
        continue;
      }
      range ??= doc.createRange();
      const paragraphStyle = doc.defaultView?.getComputedStyle(paragraph);
      const rtl = paragraphStyle?.direction === "rtl";
      const fragments = fragmentBoxesOf(paragraph, paragraphStyle);
      if (!fragments.ok) {
        outcomes.push(
          fragments.reason === "not rendered"
            ? { status: "hidden" }
            : fragments.reason === "zero content width"
              ? { status: "collapsed" }
              : { status: "invalid", reason: fragments.reason },
        );
        continue;
      }
      if (Math.abs(fragments.contentWidth - contentWidth) > FRAGMENT_WIDTH_TOLERANCE_PX) {
        outcomes.push({
          status: "resized",
          width: fragments.contentWidth,
          minWidth: paragraphStyle?.minWidth ?? "auto",
          contain: paragraphStyle?.contain ?? "none",
        });
        continue;
      }
      if (detailed?.[i] === false) {
        outcomes.push({ status: "hidden" });
        continue;
      }
      let sawInk = false;
      const paraCorrections: Correction[] = [];
      for (let li = 0; li < lineElements.length; li++) {
        const entries = lineElements[li]!;
        if (entries.length === 0) continue;
        if (foreignMutated(entries)) {
          // Ink must still come from a real rect read (valid regardless of
          // child mutation): asserting it would drop a layout-skipped
          // paragraph out of the hidden re-park pipeline and lose its
          // guaranteed reveal retry.
          if (!sawInk) {
            sawInk = entries.some(({ el }) => el.getBoundingClientRect().width > 0);
          }
          continue;
        }
        const availableWidth = lineWidths[li] ?? lineWidths[lineWidths.length - 1] ?? 0;
        const { rectPx, modelPx, ownMargins, lineRect, unmeasurable } = measureLineExtent(
          entries,
          range,
        );
        // Skipped content (content-visibility: auto off-screen) measures
        // zero rects; model widths and margins still parse, so the "is this
        // paragraph actually rendered" test uses rect reads only.
        if (rectPx !== 0) sawInk = true;
        // Recorded as ink first: the paragraph is rendered, it is only this
        // line's correction that cannot be derived.
        if (unmeasurable) continue;
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
          // rightHang is already out of the measured rects". A hung
          // fixed-separator run spreads its removal over the run's segments,
          // so the terminal side is a sum, not the last segment's share.
          const physicalEndHang =
            textEntries.reduce((sum, entry) => sum + (entry.seg.physicalEndHangPx ?? 0), 0) +
            (endText?.seg.hyphenEndHangPx ?? 0);
          // The wrap-safety pad shed from the terminal cluster is out of the
          // measured rects exactly as the hang removals are, but it is not
          // protrusion: it stays shed after correction (it is what keeps the
          // corrected line safe too), so it comes off the target and not off
          // the end margin below.
          const physicalPad = textEntries.reduce(
            (sum, entry) => sum + (entry.seg.physicalPadPx ?? 0),
            0,
          );
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
                physicalEndHang -
                physicalPad +
                deliberateOverflow);
          } else {
            const fragment = fragmentForLine(fragments.rects, lineRect!, rtl === true);
            const contentEnd = contentEndOf(fragment, paragraphStyle, rtl === true);
            const paintEndEntry = entries[entries.length - 1]!;
            const painted = paintedEndOf(entries, endText, range, rtl === true);
            if (painted === null) continue;
            const paintRect = painted.rect;
            // The hyphen carrier is the one line-end box the engine can move
            // off this line on its own (an emergency break at its segment
            // boundary — see the neutralizations in `justify`; a `!important`
            // author licence still reaches it). A moved carrier reports the
            // next line's start, or the next column's top, and correcting to
            // that coordinate is what turns the deferred pass into a 50–75px
            // word-spacing blowout. It shares a line box with the text it
            // follows (same styling context, so same rect top) and the
            // fragment that line was measured against; failing either, the
            // line has re-wrapped and no correction can be measured — leave
            // its provisional pad standing, as for a foreign-mutated line.
            if (paintEndEntry.seg === null && endText !== undefined) {
              const textRect = endText.el.getBoundingClientRect();
              if (
                Math.abs(paintRect.top - textRect.top) > 0.5 ||
                fragmentForLine(fragments.rects, paintRect, rtl === true) !== fragment
              ) {
                continue;
              }
            }
            const desiredEnd = (rtl ? -contentEnd : contentEnd) + rightHang + deliberateOverflow;
            adjustmentPx = painted.value - desiredEnd;
          }
          const spacing = distributeAdjustment(textEntries, adjustmentPx);
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
      // No ink anywhere while the paragraph's own box measures fine is the
      // signature of layout-skipped content (`content-visibility: auto`
      // off-screen), which is waited out rather than acted on.
      outcomes.push(
        sawInk ? { status: "corrected", corrections: paraCorrections } : { status: "hidden" },
      );
    } catch (error) {
      // This paragraph's own reads failed. The shared range may have been left
      // pointing into its nodes, so drop it rather than carry it to the next.
      range = null;
      outcomes.push({ status: "invalid", reason: `threw while measuring: ${describeError(error)}` });
    }
  }
  return outcomes;
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
