/**
 * The resize drain: what is queued for a later frame, which paragraphs sit
 * near the viewport, and the frame-budgeted slices that work through both.
 *
 * Resize re-layouts run in slices, paragraphs in (or near) the viewport
 * first: a live width drag on a document with very many paragraphs keeps
 * frames short and updates the text the user is looking at immediately, while
 * below-the-fold paragraphs settle over the following frames. Ordering comes
 * from a passive IntersectionObserver (geometry reads at drain time would
 * force a layout), and the measured wrap-guarantee corrections are deferred
 * to their own trailing slices — every patched line carries a provisional
 * safety pad, so nothing can re-wrap while its correction is queued, and
 * during a continuous drag superseded corrections are simply dropped.
 */

import type { PatchEntry, PatchOutcome } from "./corrections.js";
import type { ParaState } from "./paragraph-state.js";
import { contentWidthOf } from "./read.js";
import type { PendingParagraph } from "./write.js";

/**
 * The drain's shared mutable state: what is queued for a later frame, and
 * what the viewport observers currently report as near.
 *
 * It is created before any of the passes that touch it and handed to each,
 * which is what lets the patch pipeline queue a correction, the correction
 * pass park one, and the scheduler below work through them all without any
 * of the three having to import another.
 */
export interface DrainQueues {
  /** Paragraphs whose measure has moved, with the width to re-break to. */
  readonly pendingWidths: Map<HTMLElement, number>;
  /** Paragraphs whose float geometry has changed under them. */
  readonly pendingFloatRelayout: Set<HTMLElement>;
  /** Patched paragraphs awaiting the measured wrap-guarantee correction. */
  readonly pendingCorrections: Map<HTMLElement, PendingParagraph>;
  /** Corrections that could not be measured because the paragraph's content
   * was layout-skipped (`content-visibility: auto` off-screen); retried when
   * the paragraph approaches the viewport. */
  readonly hiddenCorrections: Map<HTMLElement, PendingParagraph>;
  /**
   * Paragraphs at or near the viewport, tracked passively. Drives drain
   * ordering, the measure-vs-park split in the correction pass, and the first
   * promotion stage for parked corrections: a paragraph entering the 50%
   * margin gets its parked correction measured (for plain content this lands
   * flush before the user sees it; content-visibility-skipped content
   * measures zero and re-parks — the reveal observer is the guaranteed second
   * stage, so no retry loop is possible).
   */
  readonly nearViewport: Set<Element>;
  /** Forget every queued width and correction for `p`. */
  drop(p: HTMLElement): void;
}

export function createDrainQueues(): DrainQueues {
  const pendingWidths = new Map<HTMLElement, number>();
  const pendingFloatRelayout = new Set<HTMLElement>();
  const pendingCorrections = new Map<HTMLElement, PendingParagraph>();
  const hiddenCorrections = new Map<HTMLElement, PendingParagraph>();
  const nearViewport = new Set<Element>();
  return {
    pendingWidths,
    pendingFloatRelayout,
    pendingCorrections,
    hiddenCorrections,
    nearViewport,
    drop(p) {
      pendingWidths.delete(p);
      pendingFloatRelayout.delete(p);
      pendingCorrections.delete(p);
      hiddenCorrections.delete(p);
    },
  };
}

/**
 * What the drain needs from the controller that owns the paragraphs. Named
 * rather than captured: this is the whole coupling between the two.
 */
export interface DrainHost {
  /** True once the controller has been torn down; every slice checks it,
   * because a user callback may destroy mid-drain. */
  destroyed(): boolean;
  /** Every paragraph this controller holds, in document order. */
  readonly paragraphs: readonly HTMLElement[];
  ownedState(p: HTMLElement): ParaState | undefined;
  /** Re-break and re-write one paragraph, never throwing. */
  safePatch(p: HTMLElement): PatchOutcome;
  /** Tell user code a paragraph's rendering changed. */
  emitRelayout(p: HTMLElement): void;
  /** Measure and apply the wrap-guarantee corrections for a batch. A thunk:
   * the correction pass is constructed after this scheduler, over the same
   * queues. */
  flushPatches(batch: readonly PatchEntry[]): void;
  /** Stop width observation of `p` for the rest of this frame, because it is
   * about to be re-broken inside the observer's own delivery. */
  suspendWidthObservation(p: HTMLElement): void;
}

/** Bind the drain to one controller. */
export function createDrain(queues: DrainQueues, host: DrainHost) {
  const {
    hiddenCorrections,
    nearViewport,
    pendingCorrections,
    pendingFloatRelayout,
    pendingWidths,
  } = queues;

  let pendingOrder: HTMLElement[] = [];
  let pendingCursor = 0;
  let sliceQueued = false;
  const SLICE_BUDGET_MS = 10;
  /** Corrections measured per trailing slice; bounds the geometry reads
   * (the dominant cost per slice — WebKit pays ~0.1ms per rect call). */
  const CORRECTION_CHUNK = 100;

  /** False until IntersectionObserver has supplied the passive viewport state. */
  let viewObserverReady = false;

  /** Synchronous fallback for the observer's initial asynchronous report. */
  const seedNearViewport = (batch: readonly { p: HTMLElement }[]): void => {
    const root = document.documentElement;
    const width = root.clientWidth || window.innerWidth;
    const height = root.clientHeight || window.innerHeight;
    // One margin for all four sides, deliberately: the observer resolves a
    // percentage against the matching axis (top and bottom against the
    // root's HEIGHT), so on a landscape viewport this seed calls "near" a
    // band the observer would not. That bias is the right one for a
    // fallback — measuring a paragraph the observer would skip costs one
    // correction pass, while skipping one it would measure leaves that
    // paragraph on its provisional pad until the first report lands. Do not
    // "fix" this to match the observer without that trade in mind.
    const margin = width / 2;
    for (const { p } of batch) {
      const r = p.getBoundingClientRect();
      if (
        r.bottom >= -margin &&
        r.top <= height + margin &&
        r.right >= -margin &&
        r.left <= width + margin
      ) {
        nearViewport.add(p);
      } else nearViewport.delete(p);
    }
  };

  const viewObserver =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            viewObserverReady = true;
            let promoted = false;
            for (const e of entries) {
              if (e.isIntersecting) {
                nearViewport.add(e.target);
                if (promoteParked(e.target as HTMLElement)) promoted = true;
              } else {
                nearViewport.delete(e.target);
                // Removed-from-DOM paragraphs would otherwise pin their
                // detached segment DOM in the queues until destroy().
                if (!e.target.isConnected) {
                  const t = e.target as HTMLElement;
                  hiddenCorrections.delete(t);
                  pendingCorrections.delete(t);
                  pendingWidths.delete(t);
                }
              }
            }
            if (promoted) scheduleSlice();
          },
          { rootMargin: "50%" },
        );
  /**
   * Reveal trigger for parked corrections, margin 0: content-visibility
   * guarantees that content intersecting the actual viewport is rendered,
   * so a correction measured from this callback cannot see zero rects
   * again (a wider margin could fire while the paragraph is still
   * layout-skipped, parking its correction with no transition to retry).
   */
  const revealObserver =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          let revealed = false;
          for (const e of entries) {
            if (e.isIntersecting && promoteParked(e.target as HTMLElement)) revealed = true;
          }
          if (revealed) scheduleSlice();
        });

  /**
   * Move a parked correction back into the measurable queue — unless the
   * paragraph is no longer this controller's live enhancement (restored by
   * unjustify, taken over, destroyed), in which case the stale entry is
   * dropped so its detached nodes are released instead of re-measured as
   * zeros on every viewport transition.
   */
  const promoteParked = (el: HTMLElement): boolean => {
    const parked = hiddenCorrections.get(el);
    if (parked === undefined) return false;
    hiddenCorrections.delete(el);
    const s = host.ownedState(el);
    if (s === undefined || !s.enhanced) return false;
    pendingCorrections.set(el, parked);
    return true;
  };

  const scheduleSlice = (): void => {
    if (sliceQueued) return;
    sliceQueued = true;
    requestAnimationFrame(drainPending);
  };

  const visibleFirst = (els: HTMLElement[]): HTMLElement[] => {
    if (els.length > 1) {
      // Visible before off-screen, float paragraphs before the rest: while
      // a float paragraph waits for its patch, the engine renders its stale
      // segments thrown below the float — the worst-degraded pending state,
      // so it gets the first slice's budget. Stable sort: document order
      // survives within each rank.
      const rank = (p: HTMLElement): number =>
        (viewObserver !== null && !nearViewport.has(p) ? 2 : 0) +
        ((host.ownedState(p)?.scan.floatIntrusion ?? null) !== null ? 0 : 1);
      els.sort((a, b) => rank(a) - rank(b));
    }
    return els;
  };

  /** Re-order the drain queue around a newly queued paragraph and run it.
   * Entries already dealt with delete their own queue slots, so replaying the
   * order from the start costs a skipped lookup each and nothing more. */
  const restartPendingOrder = (): void => {
    pendingOrder = visibleFirst([...new Set([...pendingWidths.keys(), ...pendingFloatRelayout])]);
    pendingCursor = 0;
    scheduleSlice();
  };

  const drainPending = (): void => {
    sliceQueued = false;
    if (host.destroyed()) {
      reset();
      return;
    }
    const start = performance.now();
    // Scroll anchoring: off-screen patches land frames after the visible
    // ones (viewport-first slicing) and change paragraph heights ABOVE the
    // viewport, which would shift the text the user is looking at moments
    // after each width change. Native scroll anchoring can't help — the
    // anchor's contents get replaced — but the <p> elements themselves
    // persist. The anchor must be a paragraph whose TOP is inside the
    // viewport: anchoring a paragraph that straddles the viewport's top
    // edge holds its (invisible) top while its own re-break shifts
    // everything below it — the text visibly bounced by the straddler's
    // height delta on every step. Correction-only slices write no heights
    // and skip the geometry reads entirely.
    let anchor: HTMLElement | null = null;
    let anchorTop = 0;
    if (pendingCursor < pendingOrder.length) {
      let above: HTMLElement | null = null;
      let below: HTMLElement | null = null;
      for (const p of host.paragraphs) {
        if (!nearViewport.has(p)) continue;
        const top = p.getBoundingClientRect().top;
        if (top >= 0 && top < window.innerHeight) {
          anchor = p;
          anchorTop = top;
          break;
        }
        // Fallbacks when no top is inside the viewport (a single tall
        // paragraph fills it): prefer the paragraph NEAREST above — the
        // last one seen — so patches between it and the viewport are
        // still compensated; the first below-viewport paragraph is the
        // final resort.
        if (top < 0) above = p;
        else below ??= p;
      }
      if (anchor === null) {
        anchor = above ?? below;
        if (anchor !== null) anchorTop = anchor.getBoundingClientRect().top;
      }
    }
    let wrote = false;
    while (pendingCursor < pendingOrder.length) {
      if (wrote && performance.now() - start > SLICE_BUDGET_MS) break;
      const el = pendingOrder[pendingCursor++]!;
      const width = pendingWidths.get(el);
      const floatRelayout = pendingFloatRelayout.delete(el);
      // Reachable: the observer callback deletes entries superseded by a
      // revert to the current width while the stale order still lists them.
      if (width === undefined && !floatRelayout) continue;
      if (width !== undefined) pendingWidths.delete(el);
      const state = host.ownedState(el);
      if (state === undefined) continue;
      if (width !== undefined) {
        if (Math.abs(width - state.width) < 0.05 && !floatRelayout) continue;
        state.width = width;
      }
      if (floatRelayout) state.lastPatch = "";
      const outcome = host.safePatch(el);
      if (outcome.changed) {
        if (outcome.pending !== null) pendingCorrections.set(el, outcome.pending);
        wrote = true;
        host.emitRelayout(el);
        // onRelayout may call destroy(); stop before touching anything else.
        if (host.destroyed()) return;
      }
    }
    if (wrote && anchor !== null) {
      const delta = anchor.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
    }
    // Float paragraphs cannot wait for the deferred correction slices: a
    // beside-float line still wearing its provisional wrap-safety pad can
    // momentarily fail the engine's fit test and drop below the float — a
    // one-frame hole beside the ornament on every resize step. Flush their
    // corrections in this same rendering update (they are few — typically
    // one per article — so the extra forced layout stays bounded); everything
    // else keeps the batched read slices.
    if (wrote) {
      const floats = [...pendingCorrections.keys()].filter(
        (el) => (host.ownedState(el)?.scan.floatIntrusion ?? null) !== null,
      );
      if (floats.length > 0) {
        const batch: PatchEntry[] = floats.map((el) => {
          const pending = pendingCorrections.get(el)!;
          pendingCorrections.delete(el);
          return { p: el, pending };
        });
        host.flushPatches(batch);
        if (host.destroyed()) return;
      }
    }
    if (pendingCursor < pendingOrder.length) {
      scheduleSlice();
      return;
    }
    // All patches written: measure corrections in bounded chunks, visible
    // paragraphs first, one forced layout per slice.
    if (!wrote && pendingCorrections.size > 0) {
      const els = visibleFirst([...pendingCorrections.keys()]);
      const batch: PatchEntry[] = [];
      for (const el of els.slice(0, CORRECTION_CHUNK)) {
        batch.push({ p: el, pending: pendingCorrections.get(el)! });
        pendingCorrections.delete(el);
      }
      host.flushPatches(batch);
    }
    if (
      pendingCorrections.size > 0 ||
      pendingWidths.size > 0 ||
      pendingFloatRelayout.size > 0
    ) {
      scheduleSlice();
    }
  };

  /**
   * The width-observer delivery: queue what actually changed, then run the
   * first slice inline.
   */
  const onWidths = (widths: ReadonlyMap<Element, number>): void => {
    for (const [el, observed] of widths) {
      const state = host.ownedState(el as HTMLElement);
      // Most notifications here are a paragraph's own height moving under
      // a re-break, with its inline size untouched. The observed size
      // settles those without a layout read — it cannot be compared with
      // `state.width` (that is client-rect geometry, and an ancestor
      // transform scales one and not the other) but it is exact against
      // ITSELF from tick to tick.
      if (state === undefined || state.observedInline === observed) continue;
      state.observedInline = observed;
      // A real inline-size change: re-read it in the coordinate space the
      // scans and the correction pass both use.
      const width = contentWidthOf(el as HTMLElement);
      if (typeof width === "string") continue;
      if (Math.abs(width - state.width) < 0.05) {
        // Reverted to the current width: drop any queued intermediate
        // width, or a stale patch would land after the resize settled.
        pendingWidths.delete(el as HTMLElement);
        continue;
      }
      pendingWidths.set(el as HTMLElement, width);
      // About to be re-broken inside this same delivery — keep its own
      // height change out of the observer loop (see createWidthObserver).
      host.suspendWidthObservation(el as HTMLElement);
    }
    // Delivered inside the ResizeObserver callback — after layout,
    // before paint — so the first slice patched here replaces the
    // engine's reflow of stale segments in the SAME rendering update:
    // the invalid intermediate (a float paragraph's prose pushed below
    // its drop cap) never paints. Order the queue (no reads —
    // visibility is tracked passively) and run the first slice now —
    // unless a slice is already queued for this frame chain, which
    // would double the drain (and its forced layout) in one frame.
    if (pendingWidths.size > 0) {
      for (const p of pendingFloatRelayout) host.suspendWidthObservation(p);
      pendingOrder = visibleFirst([...new Set([...pendingWidths.keys(), ...pendingFloatRelayout])]);
      pendingCursor = 0;
      if (!sliceQueued) drainPending();
    }
  };

  /** Drop everything queued. For teardown, and for a slice that finds the
   * controller already destroyed under it. */
  const reset = (): void => {
    pendingWidths.clear();
    pendingFloatRelayout.clear();
    pendingCorrections.clear();
    hiddenCorrections.clear();
    pendingOrder = [];
  };

  return {
    /** False when the environment has no IntersectionObserver, in which case
     * nothing is ever parked and every paragraph is corrected in full. */
    tracksViewport: viewObserver !== null,
    /** False until the observers have supplied the passive viewport state. */
    viewportReady: () => viewObserverReady,
    seedNearViewport,
    restartPendingOrder,
    onWidths,
    /** Track `p`'s viewport proximity. Both observers, always together: the
     * 50% one drives drain ordering and the first promotion stage, the
     * margin-0 one is the guaranteed reveal for parked corrections. */
    observe: (p: HTMLElement): void => {
      viewObserver?.observe(p);
      revealObserver?.observe(p);
    },
    unobserve: (p: HTMLElement): void => {
      viewObserver?.unobserve(p);
      revealObserver?.unobserve(p);
    },
    disconnect: (): void => {
      viewObserver?.disconnect();
      revealObserver?.disconnect();
    },
    reset,
  };
}
