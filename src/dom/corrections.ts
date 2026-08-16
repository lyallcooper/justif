/**
 * The measured wrap guarantee, and the width negotiation that has to succeed
 * before it can run.
 *
 * A patch writes line segments modelled on measurements; this reads the result
 * back and corrects the difference. Two things can go wrong before a correction
 * is even meaningful — the paragraph's own measure may have moved under the
 * patch, and the paragraph may not be being laid out at all — and each has its
 * own answer here.
 */

import { contentWidthOf, type ElementFloatIntrusion, renderedElementFloatIntrusionOf } from "./read.js";
import { describeError } from "../core/errors.js";
import {
  maskAuthorStyle,
  type ParaState,
  unmaskAuthorStyle,
  withInlineSizeContainment,
} from "./paragraph-state.js";
import {
  applyCorrections,
  type Correction,
  measureCorrections,
  type ParagraphOutcome,
  type PendingParagraph,
} from "./write.js";

/** What one call to the patch writer did. */
export interface PatchOutcome {
  changed: boolean;
  pending: PendingParagraph | null;
}

/** Where a correction pass announces a paragraph whose rendering it changed;
 * the controller supplies one that respects its own batching. */
export type NoteRelayout = (p: HTMLElement) => void;

/**
 * What the correction pass needs from the controller that owns the paragraphs.
 * Named rather than captured: this is the whole coupling between the two, and
 * it is worth being able to read it in one place.
 */
export interface CorrectionHost {
  ownedState(p: HTMLElement): ParaState | undefined;
  /** Forget every queued re-layout and correction for this paragraph. */
  dropQueued(p: HTMLElement): void;
  /** Leave the paragraph in its author DOM for good, telling user code why.
   * Returns whether its rendering changed. */
  bailToNative(p: HTMLElement, reason: string): boolean;
  /** Re-break and re-write one paragraph, never throwing. */
  safePatch(p: HTMLElement): PatchOutcome;
  /** Tell user code a paragraph's rendering changed. */
  emitRelayout(p: HTMLElement): void;
  /** Classify a batch's viewport proximity directly, for the window before
   * IntersectionObserver has reported anything. */
  seedNearViewport(batch: readonly PatchEntry[]): void;
  /** Re-order the drain queue around newly queued paragraphs and run it. */
  restartPendingOrder(): void;
  /** Corrections parked until their paragraph is laid out again. */
  readonly hiddenCorrections: Map<HTMLElement, PendingParagraph>;
  /** Paragraphs the viewport observers currently report as near. */
  readonly nearViewport: Set<Element>;
  /** Paragraphs whose float geometry has changed under them. */
  readonly pendingFloatRelayout: Set<HTMLElement>;
  /** Paragraphs with a width change already queued: their current geometry
   * describes a layout that is about to be replaced. */
  readonly pendingWidths: Map<HTMLElement, number>;
  /** Null when the environment has no IntersectionObserver, in which case
   * every paragraph is corrected in full. */
  viewObserver(): IntersectionObserver | null;
  /** False until the observer has supplied the passive viewport state. */
  viewObserverReady(): boolean;
}

export interface PatchEntry {
  p: HTMLElement;
  pending: PendingParagraph;
  /** How far this paragraph has got with the intrinsic-size repair during
   * THIS flush: "live" while one is installed on trial, "cleared" once it
   * proved not to be the cause and was taken back off. Absent on a paragraph
   * repaired by an earlier flush — that one is simply author styling as far
   * as this flush is concerned. */
  guard?: "live" | "cleared";
  /** Which property the live repair wrote, so it can be taken back off. */
  guardProperty?: string;
}

/**
 * Bind the correction pass to one controller. Everything below closes over
 * `host` and nothing else, so the coupling is exactly the interface above.
 */
export function createCorrectionPass(host: CorrectionHost) {
  /**
   * Width-negotiation passes a batch may spend before a paragraph that still
   * disagrees with its own measure is handed back to the engine. Three cover
   * the longest sequence one paragraph can legitimately need — install the
   * guard, take it off again, break at the external measure — and the rest is
   * headroom for a cascade, where each paragraph's guard resizes the next and
   * every link costs a further pass.
   */
  const SETTLE_PASSES = 5;

  /** Hand one entry of a correction batch back to the engine for good. */
  const rejectPatch = (entry: PatchEntry, reason: string, note: NoteRelayout): void => {
    if (host.ownedState(entry.p) === undefined) return;
    host.dropQueued(entry.p);
    if (host.bailToNative(entry.p, reason)) note(entry.p);
  };

  /**
   * One read pass + one write pass for a batch of patched paragraphs.
   * Paragraphs whose content is layout-skipped (`content-visibility: auto`
   * off-screen) cannot be measured; their corrections are parked and retried when the IntersectionObserver reports
   * them near the viewport. Until then the provisional wrap-safety pad
   * keeps their lines from re-wrapping.
   *
   * A paragraph whose own measure moved under the patch is negotiated first
   * (`settleWidth`) and the whole batch re-read, since one paragraph's repair
   * can resize a shared ancestor.
   */
  const flushPatches = (
    batch: readonly PatchEntry[],
    /** A caller that is already collecting relayout notifications for this
     * turn. Paragraphs re-broken or given back here join that set instead of
     * notifying immediately, so one paragraph is never announced twice. */
    changed?: Set<HTMLElement>,
  ): void => {
    if (batch.length === 0) return;
    const noteRelayout = (p: HTMLElement): void => {
      if (changed === undefined) host.emitRelayout(p);
      else changed.add(p);
    };
    // IntersectionObserver cannot populate nearViewport synchronously. Until
    // its first report, classify this batch directly so visible corrections
    // land in the same task as their initial patch.
    if (host.viewObserver() !== null && !host.viewObserverReady()) host.seedNearViewport(batch);
    let active = batch.filter((entry) => entry.p.isConnected);
    // Terminates on the filter below: past SETTLE_PASSES a mismatch is left
    // alone rather than negotiated, so a further pass can only be triggered by
    // an invalid or disowned paragraph — and both leave `active`, making each
    // such pass strictly shorter than the last.
    for (let pass = 0; active.length > 0; pass++) {
      // Only paragraphs near the viewport get line-by-line correction: the
      // rects of a content-visibility-skipped paragraph read as zeros but
      // still cost ~0.1ms each in WebKit, which at hundreds of off-screen
      // paragraphs would dominate the drain. Far paragraphs are parked after
      // the one paragraph-level read their own measure needs, and the viewport
      // observers promote them on approach. Without an IntersectionObserver
      // everything is corrected directly.
      const detailed = active.map(
        (entry) => host.viewObserver() === null || host.nearViewport.has(entry.p),
      );
      let outcomes: ParagraphOutcome[];
      try {
        outcomes = measureCorrections(
          active.map((entry) => entry.pending),
          detailed,
        );
      } catch (error) {
        // A paragraph that cannot be measured reports that as its own outcome.
        // Reaching here means the read pass itself could not run, so nothing
        // in this batch has a trustworthy measure and native rendering is the
        // only state that cannot strand a provisional margin or stale float
        // geometry.
        console.error("justif: correction measurement threw", error);
        const reason = `correction measurement failed: ${describeError(error)}`;
        for (const entry of active) rejectPatch(entry, reason, noteRelayout);
        return;
      }
      // A repair or a re-break can resize a shared Grid/Flex ancestor, so any
      // write means every correction read in this layout describes a layout
      // that no longer exists: collect them, and discard the lot if anything
      // was written.
      let wrote = false;
      const corrections: Correction[] = [];
      const park: PatchEntry[] = [];
      const measured: PatchEntry[] = [];
      for (let i = 0; i < active.length; i++) {
        const entry = active[i]!;
        const outcome = outcomes[i]!;
        switch (outcome.status) {
          case "stale":
            break;
          case "hidden":
            park.push(entry);
            break;
          case "corrected":
            corrections.push(...outcome.corrections);
            measured.push(entry);
            break;
          case "invalid":
            rejectPatch(entry, outcome.reason, noteRelayout);
            wrote = true;
            break;
          case "collapsed":
            wrote = true;
            if (entry.guard === "live") {
              // Justif's own repair took the paragraph's width to nothing —
              // what inline-size containment does to an ancestor that is sized
              // FROM the paragraph rather than merely floored by it. Undo it
              // and read again.
              revertGuard(entry);
            } else {
              rejectPatch(entry, "content width collapsed to zero", noteRelayout);
            }
            break;
          case "resized": {
            const state = host.ownedState(entry.p);
            if (state === undefined) {
              // Not ours any more; the filter below drops it.
              wrote = true;
              break;
            }
            if (pass >= SETTLE_PASSES) {
              // Out of settling budget: something outside this paragraph keeps
              // moving its measure, and no repair available here reaches it.
              // Leave it enhanced at the measure it last broke to, with its
              // provisional wrap-safety pad standing — loose, but justified and
              // laid out — rather than hand a page of prose back to the engine
              // because one ancestor will not hold still.
              break;
            }
            wrote = true;
            settleWidth(
              entry,
              state,
              outcome.width,
              outcome.minWidth,
              outcome.contain,
              noteRelayout,
            );
            break;
          }
        }
      }
      if (wrote) {
        active = active.filter(
          (entry) => entry.p.isConnected && host.ownedState(entry.p)?.enhanced === true,
        );
        continue;
      }
      // Isolated separately from the read pass: a throw here has already
      // applied part of the batch, and the degraded state — every line keeping
      // its provisional wrap-safety pad, loose but laid out — is better than
      // reverting paragraphs that measured cleanly.
      try {
        applyCorrections(corrections);
        for (const entry of park) host.hiddenCorrections.set(entry.p, entry.pending);
        verifyElementFloats(measured);
      } catch (error) {
        console.error("justif: correction write threw", error);
      }
      return;
    }
  };

  /**
   * The repair for a paragraph whose generated lines have pushed it wider,
   * chosen from what the paragraph's own computed style says about WHERE that
   * growth escaped to. Returns null when neither repair is available.
   */
  const intrinsicRepair = (
    minWidth: string,
    contain: string,
  ): { property: string; value: string } | null => {
    // `auto` computes only on a flex or grid item, and only there does a box
    // have an automatic minimum size — which IS its min-content contribution.
    // The paragraph's own track is what grew, so drop that floor and nothing
    // else: the max-content contribution, and so the track's own result, stays
    // exactly what it was before the patch.
    if (minWidth === "auto") return { property: "min-width", value: "0px" };
    // An ordinary block has no automatic minimum to drop; its contribution has
    // travelled up to whichever ancestor IS an item, and nothing writable on
    // the paragraph reaches that ancestor's minimum. So stop the contribution
    // at its source instead. This is the blunter instrument — it suppresses the
    // max-content contribution too, which collapses an ancestor sized FROM the
    // paragraph — so the result is read back and reverted if it did harm.
    const guarded = withInlineSizeContainment(contain);
    return guarded === contain ? null : { property: "contain", value: guarded };
  };

  /** Take a trial repair back off, leaving the author's own value behind. */
  const revertGuard = (entry: PatchEntry): void => {
    const state = host.ownedState(entry.p);
    if (state !== undefined && entry.guardProperty !== undefined) {
      unmaskAuthorStyle(entry.p, state, entry.guardProperty);
    }
    entry.guard = "cleared";
  };

  /**
   * Reconcile one paragraph whose own measure moved between the patch that
   * wrote its segments and the layout that read them back. Enhancement may
   * change a paragraph's line breaks and height but never its own measure, so
   * a mismatch has exactly two causes: justif's own generated lines pushing
   * the paragraph wider, or a change from outside, which is simply the new
   * measure to break at.
   *
   * The first has one mechanism. Every generated line is `white-space: nowrap`,
   * which raises the paragraph's min-content contribution from its longest WORD
   * to its longest LINE — measured in WebKit, 88px to 185px for an ordinary
   * paragraph. A flex or grid item's automatic minimum size IS that
   * contribution, so a track sized to its own content is floored open and the
   * paragraph ends up wider than the author's layout asked for. Where the
   * paragraph is not itself the item, the same contribution travels up to
   * whichever ancestor is. `intrinsicRepair` answers both.
   *
   * One reading cannot tell the two causes apart, so a GROWN measure is
   * probed: write the repair, and if the width does not come back it was never
   * ours to fix. A SHRUNK measure is never probed — `nowrap` content can only
   * ever RAISE an intrinsic contribution, so a narrower measure (a classic
   * scrollbar appearing, a lazily loaded image, a font swap) is external by
   * construction.
   */
  const settleWidth = (
    entry: PatchEntry,
    state: ParaState,
    width: number,
    minWidth: string,
    contain: string,
    note: NoteRelayout,
  ): void => {
    if (entry.guard === undefined) {
      if (width > entry.pending.contentWidth) {
        const repair = intrinsicRepair(minWidth, contain);
        if (repair !== null) {
          maskAuthorStyle(entry.p, state, repair.property, repair.value);
          entry.guard = "live";
          entry.guardProperty = repair.property;
          return;
        }
      }
    } else if (entry.guard === "live") {
      // The repair is in force and the measure is still wrong, so justif's own
      // content was not the cause (or an author `!important` outranks the
      // declaration). Take it off and read again — removing it moves the width
      // once more, so the break has to wait for that pass.
      revertGuard(entry);
      return;
    }
    // An external measure: no repair applied here, the trial has been cleared,
    // or a shrink was never ours to begin with.
    state.width = width;
    state.lastPatch = "";
    const outcome = host.safePatch(entry.p);
    if (outcome.pending !== null) entry.pending = outcome.pending;
    if (outcome.changed) note(entry.p);
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
      host.pendingFloatRelayout.add(p);
      queued = true;
    }
    if (queued) host.restartPendingOrder();
  };

  /** Sub-pixel noise in a live rect read must not count as a geometry
   * change, or every remeasure would invalidate every float paragraph. */
  const floatGeometryEquals = (
    a: { inlineSize: number; lines: number },
    b: { inlineSize: number; lines: number },
  ): boolean => Math.abs(a.inlineSize - b.inlineSize) <= 0.05 && a.lines === b.lines;

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
  ): "unchanged" | "changed" | "unmeasurable" | "stale" => {
    if (host.pendingWidths.has(p)) return "stale";
    const widthNow = contentWidthOf(p);
    if (typeof widthNow !== "number" || Math.abs(widthNow - state.width) > 0.05) {
      return "stale";
    }
    const next = renderedElementFloatIntrusionOf(
      p,
      source ?? state.renderedFloat ?? intrusion.source,
      intrusion,
    );
    if (next === null) return "unmeasurable";
    if (floatGeometryEquals(next, intrusion)) return "unchanged";
    state.scan.floatIntrusion = next;
    state.lastPatch = "";
    return "changed";
  };

  return {
    flushPatches,
    floatGeometryEquals,
    refreshElementFloat,
    rejectPatch,
    verifyElementFloats,
  };
}
