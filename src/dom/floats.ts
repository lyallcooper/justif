/**
 * Keeping a paragraph's float intrusion honest.
 *
 * A paragraph that sets beside a float — a floated `::first-letter` drop cap,
 * or a leading floated element — breaks against narrowed measures for as many
 * lines as the float overlaps. Both numbers are read from live geometry, and
 * both move: the float's own box resizes, a font arrives and changes how many
 * lines an auto-height drop cap covers, the page reflows.
 *
 * Every path that re-reads them lands here, because the failure modes are
 * shared and sharp. A reading taken while the paragraph still holds the
 * PREVIOUS break's segments describes a rendering the model never chose —
 * commonly with the segments pushed under the float, which measures back as
 * "the float overlaps one line" and would stick, since re-breaking to it moves
 * the float's box not at all. So `refreshElementFloat` refuses to read a
 * paragraph whose width is in flight ("stale"), and the post-patch
 * verification re-reads from the layout the patch itself produced, where a
 * differing answer means the FIRST reading was the stale one.
 *
 * An unreadable float is deliberately not a verdict here: whether that means
 * "wait" or "give the paragraph back to the engine" depends on whether the
 * float is painted at all, which only the caller knows.
 */

import type { PatchEntry } from "./corrections.js";
import type { DrainQueues } from "./drain.js";
import { type ParaState, restoreManagedOutput } from "./paragraph-state.js";
import {
  type ElementFloatIntrusion,
  floatInlineSizeOf,
  floatIntrusionOf,
  physicalFloatSide,
  renderedElementFloatIntrusionOf,
} from "./float-geometry.js";
import { contentWidthOf } from "./read.js";

/** Sub-pixel noise in a live rect read must not count as a geometry
 * change, or every remeasure would invalidate every float paragraph. */
export function floatGeometryEquals(
  a: { inlineSize: number; lines: number },
  b: { inlineSize: number; lines: number },
): boolean {
  return Math.abs(a.inlineSize - b.inlineSize) <= 0.05 && a.lines === b.lines;
}

/** What float tracking needs from the controller that owns the paragraphs. */
export interface FloatHost {
  destroyed(): boolean;
  /** Every paragraph this controller holds. */
  readonly paragraphs: readonly HTMLElement[];
  ownedState(p: HTMLElement): ParaState | undefined;
  /** Leave the paragraph in its author DOM for good, telling user code why.
   * Returns whether its rendering changed. */
  bailToNative(p: HTMLElement, reason: string): boolean;
  /**
   * The same, for a paragraph whose managed output this pass has ALREADY
   * restored: the DOM is the author's again, so only the record, the skip and
   * the relayout are left to settle. Rebinding the observation is the
   * controller's to sequence, which is why this is one call and not three.
   */
  declineRestored(p: HTMLElement, reason: string): void;
  /** Tell user code a paragraph's rendering changed. */
  emitRelayout(p: HTMLElement): void;
  /** Whether a paragraph's width is in flight, and where a discovered
   * re-layout is queued. */
  readonly queues: DrainQueues;
  /** Re-order the drain queue around newly queued paragraphs and run it. */
  restartPendingOrder(): void;
}

/** Bind float tracking to one controller. */
export function createFloatTracking(host: FloatHost) {
  let floatObserver: ResizeObserver | null = null;
  /** The element currently observed for each paragraph, and back again. Two
   * maps because a notification arrives keyed by the float, while every other
   * path here starts from the paragraph. */
  const observedFloat = new Map<HTMLElement, Element>();
  const floatParagraph = new WeakMap<Element, HTMLElement>();

  /**
   * The one second look at an element float's geometry, shared by every path
   * that re-reads it (post-patch verification, remeasures, the float's own
   * resize notifications): measure the rendered float, compare with the
   * shared tolerance, and on a real change store the new intrusion and
   * invalidate the paragraph's last patch so the next layout uses it.
   *
   * "unmeasurable" is deliberately not acted on here: the caller decides
   * whether an unreadable float means "wait" (an unrendered float keeps the
   * geometry on record) or "bail" (the resize observer, for a float that is
   * painted yet cannot be read).
   *
   * "stale" protects the geometry on record from a layout that is no
   * layout at all. Mid-drag, the segments on screen were built for a width
   * the paragraph no longer has — the engine has already reflowed them, and
   * commonly pushed the ones that no longer fit beside the float under it —
   * so rects read now describe a rendering the model never chose. Writing
   * an intrusion measured from one (observed count 0, the vertical
   * prediction collapsed) is how a resize could leave a tall drop cap with
   * one narrowed line and a paragraph-sized hole beside it.
   */
  const refreshElementFloat = (
    p: HTMLElement,
    state: ParaState,
    intrusion: ElementFloatIntrusion,
    source?: Element,
  ): "unchanged" | "changed" | "unmeasurable" | "unfloated" | "stale" => {
    if (host.queues.pendingWidths.has(p)) return "stale";
    const widthNow = contentWidthOf(p);
    if (typeof widthNow !== "number" || Math.abs(widthNow - state.width) > 0.05) {
      return "stale";
    }
    const rendered = source ?? state.renderedFloat ?? intrusion.source;
    // Asked before measuring, because the two failures need opposite answers
    // and the box cannot tell them apart: an element the author has stopped
    // floating collapses to nothing exactly like one that is not being
    // rendered. `float` is the only thing that says which happened.
    const direction = state.scan.direction === "rtl" ? "rtl" : "ltr";
    if (physicalFloatSide(getComputedStyle(rendered).float, direction) === null) {
      return "unfloated";
    }
    const next = renderedElementFloatIntrusionOf(
      p,
      rendered,
      intrusion,
    );
    if (next === null) return "unmeasurable";
    if (floatGeometryEquals(next, intrusion)) return "unchanged";
    state.scan.floatIntrusion = next;
    state.lastPatch = "";
    return "changed";
  };

  /**
   * The author has stopped floating this paragraph's leading element. Its
   * intrusion is not merely unreadable, it is gone — and the enhanced DOM is
   * built around a float that no longer exists, so the line widths and the
   * ornament's placement are both wrong. Hand the paragraph back to the
   * engine rather than leave it set to a measure nothing takes away from.
   *
   * Recoverable: `rescan()` always re-reads a paragraph whose float was part
   * of the decision, so this is undone by a re-read once the page settles.
   */
  const declineUnfloated = (p: HTMLElement): void => {
    host.queues.drop(p);
    const changed = host.bailToNative(p, "leading floated element is no longer floated");
    rebind(p);
    if (changed) host.emitRelayout(p);
  };

  /**
   * Second look at an element float's intrusion, from the layout the patch
   * just produced. The first reading after a width change is taken while the
   * paragraph still holds the PREVIOUS break's segments; when those no longer
   * fit beside the float the engine pushes them under it, and the tail rects
   * then say the float overlaps a single line — an answer that would stick,
   * since re-breaking to it changes the float's own box not at all.
   *
   * Measuring again here breaks that: this layout was built from the geometry
   * it is being measured against, so a differing answer means the first
   * reading was the stale one. The pair converges (the corrected break puts
   * text beside the float, which measures back the same), and the equality
   * test is what ends it.
   */
  const verifyElementFloats = (batch: readonly PatchEntry[]): void => {
    let queued = false;
    for (const { p } of batch) {
      const state = host.ownedState(p);
      const intrusion = state?.scan.floatIntrusion;
      if (state === undefined || intrusion?.kind !== "element") continue;
      // Unmeasurable is not a verdict: the paragraph keeps the geometry it
      // has, exactly as the resize observer leaves an unrendered float alone.
      if (refreshElementFloat(p, state, intrusion) !== "changed") continue;
      host.queues.pendingFloatRelayout.add(p);
      queued = true;
    }
    if (queued) host.restartPendingOrder();
  };

  /** Re-read every managed paragraph's float geometry from the rendering it
   * currently has. Returns whether any of it moved. */
  const refreshIntrusions = (): boolean => {
    let changed = false;
    for (const p of host.paragraphs) {
      const state = host.ownedState(p);
      if (state === undefined || state.scan.floatIntrusion === null) continue;
      if (state.scan.floatIntrusion.kind === "element") {
        const verdict = refreshElementFloat(p, state, state.scan.floatIntrusion);
        // Also checked here, not just in the observer: with `observeResize`
        // off there is no observer, and this is the only pass that looks.
        if (verdict === "unfloated") declineUnfloated(p);
        else if (verdict === "changed") changed = true;
        continue;
      }
      const nextInlineSize = floatInlineSizeOf(p);
      if (nextInlineSize === null) continue;
      // With unchanged font probes, only the live inline size needs this
      // cheap refresh. Enhanced nowrap fragments are not an independent
      // source of truth for native overlap count: Safari can push a wide
      // provisional segment below the float and report one affected line,
      // creating a self-reinforcing re-break. Font changes take the native
      // restoration path below and re-read both dimensions instead.
      if (Math.abs(nextInlineSize - state.scan.floatIntrusion.inlineSize) > 0.05) {
        state.scan.floatIntrusion = {
          kind: "first-letter",
          inlineSize: nextInlineSize,
          lines: state.scan.floatIntrusion.lines,
          style: state.scan.floatIntrusion.style,
        };
        changed = true;
      }
    }
    return changed;
  };

  /** Font changes can alter an auto-height first-letter's overlap count,
   * which the enhanced nowrap fragments cannot reveal. Restore all managed
   * drop caps to their author DOM in one write phase, then measure the same
   * native geometry used by the initial scan. Re-enhancement happens in the
   * immediately following remeasureAll call, before the browser can paint. */
  const refreshNativeIntrusions = (): boolean => {
    if (host.destroyed()) return false;
    const candidates = host.paragraphs.flatMap((p) => {
      const state = host.ownedState(p);
      return state !== undefined && state.scan.floatIntrusion !== null ? [{ p, state }] : [];
    });
    let changed = false;
    for (const { p, state } of candidates) {
      host.queues.drop(p);
      if (restoreManagedOutput(p, state)) changed = true;
    }
    for (const { p, state } of candidates) {
      const next = floatIntrusionOf(
        p,
        state.scan.runs.map((run) => run.text).join(""),
        state.scan.floatIntrusion ?? undefined,
      );
      if (next === null) {
        host.declineRestored(p, "could not remeasure paragraph float after font change");
        continue;
      }
      if (!floatGeometryEquals(next, state.scan.floatIntrusion!)) changed = true;
      state.scan.floatIntrusion = next;
    }
    return changed;
  };

  /**
   * Point the observation at whatever element now carries this paragraph's
   * float — the rendered clone once one exists, the author's source before
   * that — and stop observing whatever it carried before. A paragraph with no
   * element float is simply unobserved, which is also how a decline and a
   * teardown release one.
   */
  const rebind = (p: HTMLElement, state: ParaState | undefined = host.ownedState(p)): void => {
    const prior = observedFloat.get(p);
    const intrusion = state?.scan.floatIntrusion;
    const next =
      intrusion?.kind === "element" ? (state?.renderedFloat ?? intrusion.source) : undefined;
    if (prior === next) return;
    if (prior !== undefined) {
      floatObserver?.unobserve(prior);
      observedFloat.delete(p);
    }
    if (next !== undefined) {
      observedFloat.set(p, next);
      floatParagraph.set(next, p);
      floatObserver?.observe(next);
    }
  };

  /** Start watching the floats themselves, so a float that resizes under a
   * paragraph re-breaks it. Called only where the controller observes resizes
   * at all. */
  const attachObserver = (): void => {
    if (typeof ResizeObserver === "undefined") return;
    floatObserver = new ResizeObserver(onFloatResize);
    // Adopt the bindings already on record. The initial commit patches every
    // paragraph before observation is attached, so those floats are bound but
    // unobserved — and `rebind` returns early on a binding that has not
    // changed, so it would never pick them up.
    for (const source of observedFloat.values()) floatObserver.observe(source);
  };

  const onFloatResize: ResizeObserverCallback = (entries) => {
    let queued = false;
    for (const entry of entries) {
      const p = floatParagraph.get(entry.target);
      if (p === undefined || observedFloat.get(p) !== entry.target) continue;
      const state = host.ownedState(p);
      const intrusion = state?.scan.floatIntrusion;
      if (state === undefined || intrusion?.kind !== "element") {
        floatObserver?.unobserve(entry.target);
        observedFloat.delete(p);
        continue;
      }
      const verdict = refreshElementFloat(p, state, intrusion, entry.target);
      if (verdict === "unfloated") {
        declineUnfloated(p);
        continue;
      }
      if (verdict === "unmeasurable") {
        // A float that has stopped being rendered — an ancestor turned
        // `display: none`, a tab panel closed — notifies at 0×0, and its
        // computed `width` reverts to `auto`, which no geometry can be
        // read from. Nothing is wrong with the paragraph: it just has no
        // boxes to measure. Leave the enhancement alone and wait for the
        // notification that arrives when it is laid out again, or the
        // teardown below would strand it natively rendered for good (the
        // recovery notification carries the geometry already on record,
        // so the equality test below would find nothing to re-queue).
        const box = entry.contentBoxSize?.[0];
        const painted =
          box !== undefined
            ? box.inlineSize > 0 || box.blockSize > 0
            : entry.contentRect.width > 0 || entry.contentRect.height > 0;
        if (!painted) continue;
        host.queues.drop(p);
        const changed = host.bailToNative(
          p,
          "could not remeasure leading floated element after resize",
        );
        rebind(p);
        if (changed) host.emitRelayout(p);
        continue;
      }
      if (verdict !== "changed") continue;
      host.queues.pendingFloatRelayout.add(p);
      queued = true;
    }
    if (queued) host.restartPendingOrder();
  };

  const disconnect = (): void => {
    floatObserver?.disconnect();
    floatObserver = null;
    observedFloat.clear();
  };

  return {
    refreshElementFloat,
    verifyElementFloats,
    refreshIntrusions,
    refreshNativeIntrusions,
    rebind,
    attachObserver,
    disconnect,
  };
}
