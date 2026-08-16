/**
 * Turning one paragraph's measured state into rendered line segments.
 *
 * The line measures come first, because a text-indent or a floated
 * `::first-letter` narrows only its own leading lines; then the breaker runs
 * against them, and the result is either written as segments or handed back to
 * the engine as native one-line text. Nothing here reads live geometry — that
 * is what makes a whole batch of paragraphs cost one forced layout instead of
 * one each.
 */

import { breakParagraph } from "../core/breaker.js";
import { layoutLines } from "../core/layout.js";
import type {
  BreakOptions,
  BreakResult,
  BuildOptions,
  Line,
  LineWidths,
} from "../core/types.js";
import { buildRenderSegments } from "./segments.js";
import {
  applyNativeHang,
  beginEnhancement,
  maskAuthorStyle,
  clearNativeHang,
  firstLineIndentPx,
  nativeHangIndent,
  type ParaState,
  restoreManagedOutput,
} from "./paragraph-state.js";
import type { PatchOutcome } from "./corrections.js";
import type { DrainQueues } from "./drain.js";
import { type RenderContent, writeParagraph } from "./write.js";

/** A float that leaves less than this beside it has no usable line box. */
const MIN_FLOAT_LINE_WIDTH_PX = 1;

/** One paragraph's chosen breaks, ready to write. */
export interface PartsLayout {
  rendered: RenderContent[];
  /** Set width per visual line, including native `<br>`-only lines. */
  lineWidths: number[];
  /** Identity of this layout, for skipping no-op re-renders. */
  fingerprint: string;
  visualLineCount: number;
  /** The sole modeled line, when the whole paragraph produced exactly one
   * (with its break result); null otherwise. */
  onlyLine: Line | null;
  onlyResult: BreakResult | null;
}

/**
 * What the patch pipeline needs from the controller that owns the paragraphs.
 */
export interface PatchHost {
  ownedState(p: HTMLElement): ParaState | undefined;
  /**
   * The controller's layout configuration as it stands right now — a call,
   * not a snapshot, because `applyLayoutOptions()` replaces all three objects
   * on a live controller and every break after it must use the new ones.
   *
   * `lastLineMinWidth` is the clamped public value, shared by breaker pricing
   * and the layout floor so the two cannot disagree.
   */
  layoutOptions(): {
    breakOpts: BreakOptions;
    buildOpts: BuildOptions;
    lastLineMinWidth: number;
  };
  /** The drain's queues: a patch drops what it supersedes and queues the
   * correction its own write is owed. */
  readonly queues: DrainQueues;
}

/** Bind the patch pipeline to one controller. */
export function createPatchPass(host: PatchHost) {
  /**
   * The paragraph's per-line measures. A text-indent and a floated
   * ::first-letter each narrow their own leading lines; everything after
   * them takes the full width. Returns null when the float leaves too little
   * room for any line to set beside it — the breaker has no vertical escape,
   * so that paragraph stays native until a resize restores usable space.
   */
  const lineWidthsFor = (state: ParaState): LineWidths | null => {
    const indentPx = firstLineIndentPx(state);
    const intrusion = state.scan.floatIntrusion;
    const varyingLines = Math.max(indentPx !== 0 ? 1 : 0, intrusion?.lines ?? 0);
    if (varyingLines === 0) return state.width;
    const widths = Array.from(
      { length: varyingLines + 1 },
      (_, line) =>
        state.width -
        (line === 0 ? indentPx : 0) -
        (intrusion !== null && line < intrusion.lines ? intrusion.inlineSize : 0),
    );
    if (
      intrusion !== null &&
      widths.slice(0, intrusion.lines).some((width) => width < MIN_FLOAT_LINE_WIDTH_PX)
    ) {
      return null;
    }
    return widths.map((width) => Math.max(0, width));
  };


  /**
   * Break and lay out every hard-break-delimited part of a paragraph against
   * the given measures. With drop-cap line widths this deliberately commits
   * each part's line count before choosing the next part's width slice: it
   * does not backtrack across a `<br>` for a globally prettier allocation
   * inside the overlap.
   */
  const layoutParts = (
    state: ParaState,
    widths: LineWidths,
    paragraphMinWidth: number,
  ): PartsLayout => {
    const { breakOpts, buildOpts, lastLineMinWidth } = host.layoutOptions();
    const paragraphBreakOpts =
      paragraphMinWidth === lastLineMinWidth
        ? breakOpts
        : { ...breakOpts, lastLineMinWidth: paragraphMinWidth };
    const paragraphBuildOpts =
      paragraphMinWidth === lastLineMinWidth
        ? buildOpts
        : { ...buildOpts, lastLineMinWidth: paragraphMinWidth };
    const widthAt = (line: number): number =>
      typeof widths === "number" ? widths : (widths[Math.min(line, widths.length - 1)] ?? 0);
    const widthsFrom = (line: number): LineWidths =>
      typeof widths === "number" ? widths : widths.slice(Math.min(line, widths.length - 1));

    const rendered: RenderContent[] = [];
    const lineWidths: number[] = [];
    const fingerprintParts: string[] = [];
    const priorLastLineFit = { sum: 0, count: 0 };
    let visualLineCount = 0;
    let modeledLineCount = 0;
    let onlyLine: Line | null = null;
    let onlyResult: BreakResult | null = null;

    for (let partIndex = 0; partIndex < state.parts.length; partIndex++) {
      const part = state.parts[partIndex]!;
      const partLineOffset = visualLineCount;
      const partWidths = widthsFrom(partLineOffset);
      const isFinal = part.breakAfter === null;
      let lines: Line[] = [];

      if (part.para.firstBoxAfter[0] !== part.para.items.length) {
        // Only the paragraph's real ending is body color for lastLineFit; a
        // hard-terminated segment's own ending is set naturally.
        const partBuildOpts =
          !isFinal && paragraphBuildOpts.lastLineFit !== 0
            ? { ...paragraphBuildOpts, lastLineFit: 0 }
            : paragraphBuildOpts;
        const result = breakParagraph(part.para, partWidths, paragraphBreakOpts);
        lines = layoutLines(
          part.para,
          result,
          partWidths,
          partBuildOpts,
          isFinal ? priorLastLineFit : undefined,
        );
        rendered.push(
          ...buildRenderSegments(state.scan, state.runsMetrics, part.para, lines, partLineOffset),
        );
        for (const line of lines) lineWidths.push(line.width);
        visualLineCount += lines.length;
        modeledLineCount += lines.length;
        if (modeledLineCount === 1) {
          onlyLine = lines[0] ?? null;
          onlyResult = result;
        } else {
          onlyLine = null;
          onlyResult = null;
        }
        // A hard-terminated segment's ragged/floored last line is not body
        // color. Preserve lastLineFit's paragraph-wide average by carrying
        // only the ordinarily justified lines into the actual final part.
        for (let i = 0; i + 1 < lines.length; i++) {
          priorLastLineFit.sum += lines[i]!.glueRatio;
          priorLastLineFit.count++;
        }
        fingerprintParts.push(
          `${partIndex}:${result.breakpoints.join(",")}:${result.endingMinWidth ?? ""}:${lines
            .map(
              (line) =>
                `${line.glueRatio.toFixed(4)}:${line.trackRatio.toFixed(4)}:${line.fontStretch}`,
            )
            .join(",")}`,
        );
      } else {
        fingerprintParts.push(`${partIndex}:empty`);
      }

      if (part.breakAfter !== null) {
        // A hard break after no box content still terminates one empty line.
        // The real <br> produces its height; this bookkeeping advances
        // text-indent/float widths and the intrinsic-size placeholder.
        if (lines.length === 0) {
          lineWidths.push(widthAt(visualLineCount));
          visualLineCount++;
        }
        rendered.push({
          kind: "hard-break",
          source: part.breakAfter.source,
          ancestors: part.breakAfter.ancestors,
        });
      }
    }

    return {
      rendered,
      lineWidths,
      fingerprint: fingerprintParts.join("|"),
      visualLineCount,
      onlyLine,
      onlyResult,
    };
  };

  /**
   * A normal one-line paragraph has no short ending to repair and gains
   * nothing from DOM rewriting, so it keeps its native rendering. Rectangular
   * mode is the sole exception, and only when the breaker reached the FULL
   * target rather than one of lastLineMinWidth's degraded fallback rungs: an
   * unreachable line remains native instead of being partially widened.
   */
  const oneLineStaysNative = (layout: PartsLayout, paragraphMinWidth: number): boolean => {
    const { onlyLine, onlyResult } = layout;
    if (onlyLine === null || onlyResult === null) return false;
    const adjusted =
      Math.abs(onlyLine.glueRatio) > 1e-9 ||
      Math.abs(onlyLine.trackRatio) > 1e-9 ||
      Math.abs(onlyLine.fontStretch - 100) > 1e-9;
    const reachedFullWidth =
      paragraphMinWidth === 1 &&
      (onlyResult.endingMinWidth ?? paragraphMinWidth) >= 1 - 1e-9 &&
      onlyLine.overfull !== true &&
      adjusted;
    return !reachedFullWidth;
  };

  const patchOne = (p: HTMLElement): PatchOutcome => {
    const state = host.ownedState(p);
    if (state === undefined) return { changed: false, pending: null };
    const widths = lineWidthsFor(state);
    if (widths === null) {
      host.queues.drop(p);
      return { changed: restoreManagedOutput(p, state), pending: null };
    }
    // `justify-all` is the CSS-level rectangular mode: it requests that
    // even the final (or only) line fill the measure. The ordinary public
    // default remains 0.33 for multi-line endings only.
    const paragraphMinWidth = state.scan.justifyAll ? 1 : host.layoutOptions().lastLineMinWidth;
    const layout = layoutParts(state, widths, paragraphMinWidth);

    if (
      layout.visualLineCount === 1 &&
      state.scan.hardBreaks.length === 0 &&
      oneLineStaysNative(layout, paragraphMinWidth)
    ) {
      host.queues.drop(p);
      const nativeIndent = nativeHangIndent(state, layout.onlyLine?.leftHang ?? 0);
      // Avoid dismantling and rebuilding byte-identical native output. In
      // particular, restoreManagedOutput clears state.nativeIndent, so calling
      // it before this comparison made every resize tick look like a relayout
      // and emitted four needless style mutations.
      if (!state.enhanced && nativeIndent === state.nativeIndent) {
        return { changed: false, pending: null };
      }
      let changed = restoreManagedOutput(p, state);
      // Native rendering skips the DOM rewrite, not the line-start hang.
      if (applyNativeHang(p, state, nativeIndent)) changed = true;
      return { changed, pending: null };
    }

    if (layout.fingerprint === state.lastPatch) return { changed: false, pending: null };
    state.lastPatch = layout.fingerprint;
    // Promotion out of the native one-line state: its inline hang must go
    // before beginEnhancement writes the enhancement's own declarations,
    // because clearing restores the author's whole style attribute.
    clearNativeHang(p, state);

    if (!state.enhanced) beginEnhancement(p, state);
    // Exact placeholder geometry for content-visibility authors: line boxes
    // are uniform (nowrap segments and native empty <br> lines), so the
    // model height is visual lines × line-height. Skipped paragraphs then
    // occupy exactly their rendered size — find-in-page scroll targets,
    // anchors, and scrollbars stay stable across reveals even in engines
    // whose remembered-size recording is unreliable (WebKit).
    if (state.scan.pinIntrinsicSize && state.scan.lineHeightPx !== null) {
      const height =
        Math.round(layout.visualLineCount * state.scan.lineHeightPx * 1000) / 1000;
      maskAuthorStyle(p, state, "contain-intrinsic-block-size", `auto ${height}px`);
    }
    // This re-patch detaches any previous segment DOM: corrections queued
    // for the old nodes are stale and must never be measured or parked. A
    // queued WIDTH stays — it describes the element, not the old nodes.
    host.queues.pendingCorrections.delete(p);
    host.queues.hiddenCorrections.delete(p);
    // Per-line target widths: an indented first line has its own measure,
    // and the wrap-guarantee corrections must compare against it.
    const elementFloat =
      state.scan.floatIntrusion?.kind === "element" ? state.scan.floatIntrusion : undefined;
    const pending = writeParagraph(
      p,
      layout.rendered,
      layout.lineWidths,
      state.width,
      state.scan.floatIntrusion?.lines ?? 0,
      elementFloat,
      state.renderedFloat,
    );
    state.renderedFloat = pending.renderedFloat;
    return {
      changed: true,
      pending,
    };
  };

  return { lineWidthsFor, layoutParts, oneLineStaysNative, patchOne };
}
