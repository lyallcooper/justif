/**
 * Re-reading a paragraph's author styling, and re-deciding what to do about it.
 *
 * An enhancement is built from what the author's CSS said at the moment it was
 * read. That answer can go stale — a class swap, a theme toggle, a media query
 * — and the paragraph then has to be restored, read again, and re-enhanced (or
 * declined) from scratch.
 *
 * The hard part is reading honestly. Justif's own inline declarations mask
 * several of the properties the scan depends on, and an inline declaration
 * outranks the author's stylesheet, so on those paragraphs the author's
 * current value is invisible until the mask is lifted. Worse, the drop-in
 * transitions those very properties, and a discretely-interpolated property
 * computes as its OLD value for as long as its transition runs — so a lift and
 * a read inside one frame reads back exactly what was just replaced. Every
 * read here is therefore fenced: transitions off, mask lifted, read, mask
 * back, transitions on.
 *
 * What survives a re-read is deliberately narrow: the paragraph's identity and
 * the author's own style attribute. Everything else is rebuilt, because the
 * whole point is that the previous answer is no longer trusted.
 */

import type { DrainQueues } from "./drain.js";
import {
  authorRewroteStyleAttribute,
  NO_TRANSITION_CLASS,
  type ParaState,
  restoreManagedOutput,
  restoreStyleAttribute,
  states,
  unmaskAuthorStyle,
} from "./paragraph-state.js";
import { paragraphStyleKey, type ParagraphScan } from "./read.js";
import { disableTextAutosizing } from "./write.js";

/**
 * The paragraph's styling as it computes right now.
 *
 * (One asymmetry worth knowing, on engines that autosize text: the scan reads
 * with autosizing suppressed and an enhanced paragraph keeps that suppression,
 * but a managed NATIVE one does not, so its `font-size` can read back
 * differently there. The cost is a redundant rescan, not a wrong one.)
 */
export function styleKeyNow(p: HTMLElement): string {
  const style = getComputedStyle(p);
  return `${paragraphStyleKey(style)} ${style.textIndent}`;
}

/**
 * Turn CSS transitions off on `targets` for the duration of a re-read, and
 * return the undo. Not an optimization — the re-read is wrong without it.
 *
 * The drop-in's watcher transitions the very properties the scan reads, and a
 * discretely-interpolated property computes as its OLD value for as long as its
 * transition runs. So every style justif changes and then reads back inside one
 * frame — the lift below, and the declarations `unmaskAuthorStyle` takes off
 * before the fresh scan — reads back as the value it just replaced. Measured:
 * the scan saw `hyphens: manual`, the declaration it had removed a moment
 * earlier, and re-enhanced the paragraph as though the author had asked for it.
 *
 * It also means a re-read raises no transitions of its own, so the watcher hears
 * no echo of it (`ECHO_PROPERTIES` in auto-watch.ts covers what little slips past).
 */
export function suppressTransitions(targets: readonly HTMLElement[]): () => void {
  // A class, selecting a rule in justif's own stylesheet — NOT an inline
  // declaration. The style attribute is the author's, saved and restored on
  // their behalf, and anything justif leaves in it while a re-read is under way
  // is liable to be captured as theirs.
  for (const p of targets) p.classList.add(NO_TRANSITION_CLASS);
  return () => {
    for (const p of targets) {
      p.classList.remove(NO_TRANSITION_CLASS);
      // An empty class attribute is not what the author wrote either.
      if (p.classList.length === 0 && p.getAttribute("class") === "") {
        p.removeAttribute("class");
      }
    }
  };
}

/** Suppress engine text autosizing across a scan, and return the undo: the
 * scan must read the font sizes the author asked for, not the ones the engine
 * inflated on a narrow viewport. */
export function suppressAutosizingForScan(paragraphs: readonly HTMLElement[]): () => void {
  const saved: Array<{ el: HTMLElement; style: string | null }> = [];
  const seen = new WeakSet<HTMLElement>();
  const disable = (el: HTMLElement): void => {
    if (seen.has(el)) return;
    seen.add(el);
    saved.push({ el, style: el.getAttribute("style") });
    disableTextAutosizing(el);
  };
  for (const p of paragraphs) {
    if (states.get(p)?.enhanced) continue;
    disable(p);
    for (const el of p.querySelectorAll("*")) {
      if (el instanceof HTMLElement) disable(el);
    }
  }
  return () => {
    for (const { el, style } of saved) {
      restoreStyleAttribute(el, style);
    }
  };
}

/**
 * What this controller has decided about each paragraph, and what it needs to
 * remember to be able to decide again.
 *
 * Shared, because both directions of the lifecycle touch it: the forward pass
 * records a decision as it scans and promotes, and the re-read pass compares
 * against those records and clears them. Per controller — a destroy() plus a
 * fresh justify() deliberately gets a clean slate, so content that previously
 * caused a decline gets another chance once it is fixed.
 */
export interface AdoptionRecord {
  /** Scans taken but not yet promoted into a live state. */
  readonly scanned: Map<HTMLElement, ParagraphScan>;
  /** Paragraphs declined for good — until a re-read gives them another go. */
  readonly bailed: WeakSet<HTMLElement>;
  /**
   * The author styling behind the current decision about each paragraph — the
   * scan it kept, or the styling it declined. A re-read compares against it to
   * answer "could reading again reach a different answer?", so a declined
   * paragraph is retried exactly when its styling changes, and an enhanced one
   * is left alone until its own does.
   */
  readonly decidedStyleKey: WeakMap<HTMLElement, string>;
  /** Float decisions depend on descendant CSS, which the paragraph-only style
   * key cannot see. An explicit rescan always re-reads these targets. */
  readonly floatDecisions: WeakSet<HTMLElement>;
  /**
   * A re-read paragraph's saved style attribute, handed from the state being
   * dropped to the one about to replace it. Without it the new state would save
   * the attribute as it stands, which the CSSOM has re-serialized — and
   * `destroy()`'s byte-for-byte restoration would quietly lose whatever does not
   * survive a round trip (a fallback declaration pair, a property this engine
   * does not parse).
   *
   * It stays the attribute as first seen, so an inline declaration the author
   * added after enhancement lives on in the DOM and is honoured by every
   * re-read, but is still restored away at teardown — exactly as it was before
   * re-reading existed.
   */
  readonly carriedStyleAttr: WeakMap<HTMLElement, string | null>;
}

export function createAdoptionRecord(): AdoptionRecord {
  return {
    scanned: new Map(),
    bailed: new WeakSet(),
    decidedStyleKey: new WeakMap(),
    floatDecisions: new WeakSet(),
    carriedStyleAttr: new WeakMap(),
  };
}

/** What the re-read pass needs from the controller that owns the paragraphs. */
export interface RereadHost {
  ownedState(p: HTMLElement): ParaState | undefined;
  /** Read `targets` and enhance whatever of them can be — the same adoption
   * sequence the first pass runs. */
  adopt(targets: readonly HTMLElement[]): void;
  /** Tell user code a paragraph's rendering changed. */
  emitRelayout(p: HTMLElement): void;
  /** Point every observer at this paragraph as it now stands, or stop
   * observing it if this controller no longer manages it. */
  resyncObservation(p: HTMLElement): void;
  /** Take the font-probe baselines again, against the paragraphs as rebuilt. */
  reprobeBaselines(): void;
  /** Where a dropped paragraph's queued work is forgotten. */
  readonly queues: DrainQueues;
}

export function createRereadPass(record: AdoptionRecord, host: RereadHost) {
  /**
   * The AUTHOR's key for each paragraph — what `styleKeyNow` would read if justif
   * had never touched it. Justif's own `hyphens`, one-line `text-indent`, and
   * intrinsic-size `min-width`/`contain` declarations can mask key properties.
   * An inline declaration outranks the author's stylesheet, so on those
   * paragraphs the author's current value is otherwise invisible.
   *
   * Each masked declaration is put back to what the author had there — their own
   * inline value, or nothing — rather than simply removed, since removing it
   * would let the read fall through to a rule their inline declaration had
   * overridden. Batched into write → read → write, so any number of paragraphs
   * costs two style recalculations, with no paint between them and every
   * declaration back where it was at the end.
   *
   * The lift IS a style change while it lasts, so on a page that transitions these
   * properties it produces transition events of its own. Recognizing that echo
   * belongs to whoever listens for those events — the drop-in, which knows it
   * asked for this — and not here.
   */
  const authorStyleKeys = (targets: readonly HTMLElement[]): Map<HTMLElement, string> => {
    const undo: Array<() => void> = [];
    for (const p of targets) {
      const lifting = (host.ownedState(p)?.masked ?? []).filter(
        // Not ours any more: the author (or a script, or the inspector) has
        // written this property since, so what computes IS their current value.
        (mask) => mask.inKey && p.style.getPropertyValue(mask.property) === mask.ours,
      );
      if (lifting.length === 0) continue;
      for (const { property, ours, oursPriority, author, authorPriority } of lifting) {
        if (author === "") p.style.removeProperty(property);
        else p.style.setProperty(property, author, authorPriority);
        undo.push(() => p.style.setProperty(property, ours, oursPriority));
      }
    }
    const keys = new Map(targets.map((p) => [p, styleKeyNow(p)]));
    for (const restoreMask of undo) restoreMask();
    return keys;
  };

  /**
   * The re-read itself: compare, then re-adopt whatever now reads differently.
   */
  const reread = (considered: readonly HTMLElement[]): readonly HTMLElement[] => {
    // Transitions come off only where this pass will actually write: the
    // paragraphs whose masked declarations have to be lifted for the comparison,
    // and then the ones being re-adopted. Suppressing on all of them would touch
    // the class attribute of every paragraph on the page for a check that in the
    // ordinary case changes nothing — visible to any MutationObserver the page
    // has of its own.
    const lifted = considered.filter((p) =>
      (host.ownedState(p)?.masked ?? []).some((mask) => mask.inKey),
    );
    const restoreLifted = suppressTransitions(lifted);
    let current: Map<HTMLElement, string>;
    try {
      current = authorStyleKeys(considered);
    } finally {
      restoreLifted();
    }
    const stale = considered.filter(
      (p) => record.floatDecisions.has(p) || record.decidedStyleKey.get(p) !== current.get(p),
    );
    if (stale.length === 0) return [];
    const restoreStale = suppressTransitions(stale);
    try {
      return readapt(stale);
    } finally {
      restoreStale();
    }
  };

  /** Restore `stale` to author styling, read it again, and enhance what can be. */
  const readapt = (stale: readonly HTMLElement[]): readonly HTMLElement[] => {
    /** Had rendered output to lose, for the relayout report below. */
    const wasEnhanced = new Set<HTMLElement>();
    for (const p of stale) {
      const state = host.ownedState(p);
      if (state !== undefined) {
        if (state.enhanced) wasEnhanced.add(p);
        // The scan has to read author CSS, so justif's own declarations come
        // off first — one property at a time, so that an inline edit the author
        // made since is honoured rather than reverted.
        const saved = state.originalStyleAttr;
        unmaskAuthorStyle(p, state);
        if (authorRewroteStyleAttribute(p, saved)) {
          // Their attribute now, so let the next state save it as it stands.
          record.carriedStyleAttr.delete(p);
        } else {
          // Untouched: put the author's own TEXT back and carry it across, so
          // `destroy()` still restores it byte-for-byte however many times this
          // paragraph has been re-read. Undoing our declarations individually
          // leaves a CSSOM serialization, which drops what does not survive a
          // round trip — a fallback declaration pair, a property this engine
          // does not parse.
          restoreStyleAttribute(p, saved);
          record.carriedStyleAttr.set(p, saved);
        }
        restoreManagedOutput(p, state, "keep");
        states.delete(p);
        host.queues.drop(p);
      }
      record.bailed.delete(p);
      record.floatDecisions.delete(p);
      record.scanned.delete(p);
    }
    host.adopt(stale);
    for (const p of stale) {
      record.carriedStyleAttr.delete(p);
      // A paragraph may have changed sides. Viewport tracking matters as much
      // as width tracking: an unobserved paragraph never enters nearViewport,
      // so its measured correction would park and never be promoted.
      host.resyncObservation(p);
      // Its segments are gone, which is a layout change like any other —
      // reported for the same consumers that track the one-line demotion.
      if (host.ownedState(p) === undefined && wasEnhanced.has(p)) host.emitRelayout(p);
    }
    host.reprobeBaselines();
    return stale;
  };

  return { reread };
}
