/**
 * justif — text justification for perfectionists.
 *
 * `justify(document.querySelectorAll("p"))` re-lays-out existing paragraphs
 * with Knuth-Plass optimal line breaking, character protrusion (optical
 * margin alignment, per-font via measured glyph geometry), font expansion
 * on variable fonts with a wdth axis, and optional letterfit tracking
 * (Bringhurst's ±3%). Resize re-runs arithmetic only; `destroy()` restores
 * the original DOM.
 */

import { describeError } from "./core/errors.js";
import { clearCalibrationCache } from "./dom/calibrate.js";
import { clearOpticalCache } from "./dom/optical.js";
import { clearMeasureCache, supportsSpec } from "./dom/measure.js";
import { joinClipboardCleanup } from "./dom/clipboard.js";
import { createCorrectionPass, type PatchEntry, type PatchOutcome } from "./dom/corrections.js";
import { createDrain, createDrainQueues } from "./dom/drain.js";
import { beginScanBatch, endScanBatch, type ScanBatch } from "./dom/float-geometry.js";
import { createFloatTracking } from "./dom/floats.js";
import {
  collectFontProbes,
  type FontProbe,
  probesChanged,
  reprobeBaselines,
} from "./dom/font-probes.js";
import { createWidthObserver, type WidthObserver } from "./dom/observe.js";
import { createMetricsPass } from "./dom/metrics.js";
import { type ParaState, restoreManagedOutput, states } from "./dom/paragraph-state.js";
import { createPatchPass } from "./dom/patch.js";
import {
  contentWidthOf,
  type ParagraphScan,
  readParagraph,
  refreshAtomicWidths,
} from "./dom/read.js";
import {
  createAdoptionRecord,
  createRereadPass,
  styleKeyNow,
  suppressAutosizingForScan,
} from "./dom/reread.js";
import { clearComposedProtrusionCache } from "./dom/protrusion-tables.js";
import { writeParagraph } from "./dom/write.js";
import {
  type JustifyOptions,
  LAYOUT_OPTION_KEYS,
  type LayoutOptions,
  resolveOptions,
} from "./options.js";

export { kinsokuNotAtLineEnd, kinsokuNotAtLineStart } from "./core/cjk.js";
export type { ExpansionOptions, Line, ProtrusionTable, TrackingOptions } from "./core/types.js";
export {
  composeProtrusion,
  type HangingPunctuationMode,
  hangingCharacters,
  hangingPunctuation,
  latinProtrusion,
} from "./core/protrusion.js";
export { fontProtrusion } from "./core/protrusion-fonts.js";
export type { HangingPunctuationOptions, JustifyOptions, LayoutOptions } from "./options.js";
export { layoutDefaults } from "./options.js";

export interface JustifyController {
  /**
   * Resolves once the content's font faces have settled (loaded or
   * failed) and the layout converged on them. The text is enhanced
   * earlier than this — justify() commits synchronously against
   * whatever fonts are rendering at call time, so a still-loading
   * webfont shows its fallback justified until the faces settle.
   */
  readonly ready: Promise<void>;
  /**
   * Re-measure with the currently loaded font files and re-layout (also runs
   * automatically when webfonts finish loading). The original scan is reused, so
   * CSS changes need `rescan()` and content changes a fresh controller.
   */
  refresh(): void;
  /**
   * Re-read author CSS and re-enhance wherever it now reads differently: what to
   * call after changing the styling of managed paragraphs — `hyphens`, the font,
   * `letter-spacing`, `white-space`, `line-height`, `text-indent` — from a
   * stylesheet, a class, a theme toggle, or the devtools inspector.
   *
   * Returns the paragraphs it re-read. Ones whose styling is unchanged are left
   * strictly alone, so calling this on every suspicion is cheap: the check is one
   * computed-style read each. Paragraphs previously DECLINED are retried on the
   * same terms, since a style change is exactly what can make one eligible.
   *
   * `targets` narrows the work to some of this controller's paragraphs; omitted,
   * it considers all of them. Paragraphs released by `unjustify()` stay released.
   *
   * A re-read paragraph is restored to its author DOM and enhanced again, so —
   * unlike `refresh()` — a selection or caret inside one does not survive. Text
   * `content` changes are still out of scope: what gets re-read is the CSS.
   */
  rescan(targets?: Iterable<Element>): readonly HTMLElement[];
  /**
   * Replace this controller's layout settings and re-lay out its paragraphs,
   * reusing the existing scan. Cheaper than `destroy()` + `justify()`, and it
   * keeps observers, clipboard registration, and paragraph identity.
   *
   * `config` is COMPLETE, not a patch: a field left out takes the library
   * default, which is how a caller restores one. Anything outside
   * `LayoutOptions` is untouched — notably `hyphenate` (with its memoized
   * cache), `onSkip`, and `onRelayout`. `cleanClipboard` and `observeResize`
   * are deliberately not reconfigurable: the first registers a shared copy
   * handler once, and the second attaches observers once, so changing either
   * needs a fresh controller.
   */
  applyLayoutOptions(config: LayoutOptions): void;
  /** Restore the original DOM and disconnect observers. */
  destroy(): void;
  readonly paragraphs: readonly HTMLElement[];
  /**
   * The subset of `paragraphs` this controller still manages. Absent are ones
   * it declined, ones released by `destroy()` or `unjustify()`, and ones whose
   * enhancement was removed from the DOM from outside.
   *
   * Paragraphs sitting in native one-line layout ARE managed: they carry no
   * `data-justif` attribute, but the controller still holds their measurements
   * and watches for a measure narrow enough to make line breaking useful. Test
   * this rather than the attribute to ask "is this enhancement still live?".
   *
   * The attribute answers the OTHER question, "is justif's rendering on the
   * page right now?": every enhancement sets `data-justif` and every restore
   * removes it, so a managed paragraph without the attribute is one the
   * controller is watching but currently renders natively — a paragraph
   * short enough for one line, or one whose leading float leaves no room to
   * set beside it. Both signals are supported; they are two questions.
   */
  readonly managed: readonly HTMLElement[];
}


// Paragraph state and author-style masking: ./dom/paragraph-state.js.


function noopController(): JustifyController {
  return {
    ready: Promise.resolve(),
    refresh() {},
    rescan: () => [],
    applyLayoutOptions() {},
    destroy() {},
    paragraphs: [],
    managed: [],
  };
}

export function justify(
  targets: Element | Iterable<Element>,
  options: JustifyOptions = {},
): JustifyController {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return noopController();
  }

  const paragraphs: HTMLElement[] = [];
  for (const el of targets instanceof Element ? [targets] : targets) {
    if (el instanceof HTMLElement) paragraphs.push(el);
  }

  const owner = Symbol("justif-controller");
  /** Every decision this controller has made about each paragraph, shared with
   * the re-read pass in ./dom/reread.js that compares against them. */
  const record = createAdoptionRecord();
  const { bailed, carriedStyleAttr, decidedStyleKey, floatDecisions, scanned } = record;
  /** Membership, for the `rescan(targets)` filter: the drop-in hands every
   * controller the same set of changed paragraphs, so this is asked once per
   * target per controller and a linear scan of `paragraphs` showed up as real
   * time on long pages. */
  const owned = new Set(paragraphs);
  let destroyed = false;

  const initialResolution = resolveOptions(options);
  /** Fixed for this controller's lifetime: `hyphenate` is outside the
   * reconfigurable subset, and its memoized cache must survive one. */
  const { hyphenate } = initialResolution;
  // Reassignable: applyLayoutOptions() re-resolves these in place, and every
  // reader takes them at use time.
  let { breakOpts, buildOpts, lastLineMinWidth, expansion, spacing, protrusionCtx } =
    initialResolution;
  /**
   * The options a reconfiguration must preserve — callbacks, the hyphenator,
   * breaker penalties. The layout keys are stripped so that a field omitted
   * from applyLayoutOptions() resolves to the LIBRARY default instead of to
   * whatever this controller happened to be constructed with.
   */
  const fixedOptions: JustifyOptions = { ...options };
  for (const key of LAYOUT_OPTION_KEYS) delete fixedOptions[key];

  /** Phase 1: normalized computed-style and DOM reads; no font measurement. */
  const pendingSkips: Array<{ p: HTMLElement; reason: string }> = [];
  const scanParagraph = (p: HTMLElement, batch: ScanBatch): boolean => {
    if (states.get(p)?.enhanced) return true; // idempotent (possibly foreign)
    if (bailed.has(p)) return false;
    if (scanned.has(p)) return true;
    // Fail-safe: this library's contract is "enhance or leave native" —
    // an unexpected exception on one paragraph (a bug, hostile content)
    // must downgrade THAT paragraph to native rendering, never abort the
    // controller or poison its siblings.
    let scan: ParagraphScan | string;
    try {
      scan = readParagraph(p, batch);
      if (typeof scan !== "string") {
        if (scan.floatIntrusion?.kind === "element") floatDecisions.add(p);
        const bad = scan.specs.find((sp) => !supportsSpec(sp));
        if (bad !== undefined) {
          scan =
            bad.stretch !== "100%" && bad.stretch !== "normal"
              ? `author font-stretch: ${bad.stretch} on a run`
              : "font-variation-settings on a run";
        }
      }
    } catch (error) {
      scan = `threw while scanning: ${describeError(error)}`;
    }
    // Recorded either way, and here rather than after the enhancement lands:
    // this is the last moment the paragraph is in its author styling, which is
    // exactly what the key has to describe.
    decidedStyleKey.set(p, styleKeyNow(p));
    if (typeof scan === "string") {
      if (/float|shape-outside/i.test(scan)) floatDecisions.add(p);
      bailed.add(p);
      // The batch's temporary autosizing declarations are still present;
      // notify user code only after the finally block has restored them.
      pendingSkips.push({ p, reason: scan });
      return false;
    }
    scanned.set(p, scan);
    return true;
  };

  /**
   * patchOne with the per-paragraph fail-safe: an unexpected throw while
   * breaking/laying out/writing restores the paragraph's original DOM and
   * bails it to native rendering — never a half-patched paragraph, a dead
   * resize loop, or a poisoned controller. (writeParagraph builds its
   * fragment off-DOM and installs it atomically, so a throw cannot leave
   * partial segments behind; restore() covers the already-enhanced case.)
   */
  const safePatch = (p: HTMLElement): PatchOutcome => {
    try {
      const outcome = patchOne(p);
      floats.rebind(p, ownedState(p));
      return outcome;
    } catch (error) {
      const outcome = {
        changed: bailToNative(p, `threw while rendering: ${describeError(error)}`),
        pending: null,
      };
      floats.rebind(p, ownedState(p));
      return outcome;
    }
  };

  /** Isolated like emitRelayout: a throwing onSkip must never disturb the
   * fail-safe path that is busy leaving a paragraph native. */
  const emitSkip = (p: HTMLElement, reason: string): void => {
    try {
      options.onSkip?.(p, reason);
    } catch (err) {
      console.error("justif: onSkip callback threw", err);
    }
  };

  /** User callbacks are isolated like observer callbacks: one throwing
   * onRelayout must not abort the batch or kill a drain slice. */
  const emitRelayout = (p: HTMLElement): void => {
    try {
      options.onRelayout?.(p);
    } catch (err) {
      console.error("justif: onRelayout callback threw", err);
    }
  };

  /** Owned live state for `p` — undefined when another controller took it
   * over, or none manages it at all. */
  const ownedState = (p: HTMLElement): ParaState | undefined => {
    const state = states.get(p);
    return state !== undefined && state.owner === owner ? state : undefined;
  };

  /** Everything queued for a later frame, plus the passive viewport state.
   * Created here because all three of the passes below share it: the patch
   * pipeline queues a correction, the correction pass parks one, and the
   * drain works through both. */
  const queues = createDrainQueues();

  /** Leave `p` in its author DOM for good and tell user code why. Returns
   * whether its rendering changed (a relayout notification is then due). */
  const bailToNative = (p: HTMLElement, reason: string): boolean => {
    const changed = states.get(p)?.enhanced === true;
    restore(p);
    bailed.add(p);
    emitSkip(p, reason);
    return changed;
  };

  /**
   * Measurement + patch + flush for scanned paragraphs — fully synchronous,
   * no awaits, so a caller who runs it inside one task (e.g. a
   * render-blocking script, or the same task that reveals a font) gets the
   * enhanced text and everything it depends on painted in a single frame.
   * Measurement targets whatever fonts are RENDERING right now: a face
   * that is still loading is measured as its fallback — consistently, in
   * canvas and DOM alike — and the layout converges once it settles, via
   * the probe guard in onFontsLoaded.
   */
  const commit = (scannable: readonly HTMLElement[]): void => {
    warmDomWidths(domWidthEntriesFor(scannable));
    const batch: PatchEntry[] = [];
    const changed = new Set<HTMLElement>();
    for (const p of scannable) {
      if (!prepare(p)) continue;
      const outcome = safePatch(p);
      if (outcome.pending !== null) batch.push({ p, pending: outcome.pending });
      if (outcome.changed) changed.add(p);
    }
    flushPatches(batch, changed);
    for (const p of changed) emitRelayout(p);
  };

  /** Font probes for this controller's content; baselines are refreshed at
   * every commit and re-measure. */
  let fontProbes: FontProbe[] = [];
  /** True once the needed faces settled (loaded or failed) and the layout
   * was reconciled with them — the module-level measure caches then hold
   * settled-font metrics that a future controller may safely reuse. */
  let fontsConverged = false;


  /**
   * `fontsStale` (the default) drops the measurement caches and re-probes
   * baselines — what a font change needs, because every cached advance may now
   * describe the wrong letterforms.
   *
   * A configuration change passes `false`: glyph advances are unaffected, so
   * re-measuring the document would be pure waste, and nothing else needs
   * invalidating either. Calibration keys already include the expansion limits
   * (`calibrate.ts`), and composed protrusion tables are keyed on the settings
   * object's identity, which a re-resolution replaces.
   */
  const remeasureAll = (floatGeometryFresh = false, fontsStale = true): void => {
    if (destroyed) return;
    // Atomic widths are scan inputs too. Refresh them before deriving any
    // items so a font swap or explicit refresh can never be mistaken for
    // correctable prose drift. Read from `paragraphs` rather than from a list
    // of owned ones taken before `refreshIntrusions`, which can disown a
    // paragraph mid-pass.
    for (const p of paragraphs) {
      const state = ownedState(p);
      if (state !== undefined) refreshAtomicWidths(state.scan);
    }
    if (!floatGeometryFresh) floats.refreshIntrusions();
    if (fontsStale) {
      clearMeasureCache();
      clearCalibrationCache();
      // Measured protrusion is derived from rasterized glyphs, so it goes stale
      // for exactly the same reason widths do — a table measured before the
      // webfont arrived describes the fallback's letterforms.
      clearOpticalCache();
      clearComposedProtrusionCache();
      reprobeBaselines(fontProbes);
    }
    // Taken after the float pass above, which can disown a paragraph.
    const mine = paragraphs.filter((p) => ownedState(p) !== undefined);
    // All width reads first, then all patches, then one correction flush —
    // interleaving reads with the DOM writes would force a layout per
    // paragraph.
    const widths = new Map(mine.map((p) => [p, contentWidthOf(p)]));
    warmDomWidths(mine.map((p) => states.get(p)!));
    const batch: PatchEntry[] = [];
    const changed = new Set<HTMLElement>();
    for (const p of mine) {
      const state = states.get(p)!;
      const width = widths.get(p)!;
      if (typeof width === "string") {
        queues.drop(p);
        if (bailToNative(p, width)) changed.add(p);
        continue;
      }
      rebuildMetrics(state);
      state.width = width;
      state.lastPatch = "";
      const outcome = safePatch(p);
      if (outcome.pending !== null) batch.push({ p, pending: outcome.pending });
      if (outcome.changed) changed.add(p);
    }
    flushPatches(batch, changed);
    for (const p of changed) emitRelayout(p);
  };

  // Scan → per-run metrics → breaker items lives in ./dom/metrics.js.
  const { domWidthEntriesFor, prepare, rebuildMetrics, warmDomWidths } = createMetricsPass(record, {
    layoutOptions: () => ({ buildOpts, expansion, spacing, protrusionCtx }),
    owner,
    emitSkip: (p, reason) => emitSkip(p, reason),
  });

  // Line measures, breaking and the segment write live in ./dom/patch.js.
  const { lineWidthsFor, layoutParts, patchOne } = createPatchPass({
    ownedState: (p) => ownedState(p),
    layoutOptions: () => ({ breakOpts, buildOpts, lastLineMinWidth }),
    queues,
  });

  // The frame-budgeted resize drain, its queues and the viewport tracking that
  // orders it live in ./dom/drain.js. It is built before the correction pass
  // and takes `flushPatches` as a thunk: the two share the queues above, and
  // resolving the call at call time is what keeps that from being a cycle.
  const drain = createDrain(queues, {
    destroyed: () => destroyed,
    paragraphs,
    ownedState: (p) => ownedState(p),
    safePatch: (p) => safePatch(p),
    emitRelayout: (p) => emitRelayout(p),
    flushPatches: (batch) => flushPatches(batch),
    suspendWidthObservation: (p) => observer?.suspend(p),
  });

  // Float intrusion geometry — its re-reads, the float's own resize
  // observation, and the post-patch verification below — lives in
  // ./dom/floats.js. Built before the correction pass, which asks it to take
  // that second look; `declineRestored` is a thunk for the same reason
  // `flushPatches` is one above.
  const floats = createFloatTracking({
    destroyed: () => destroyed,
    paragraphs,
    ownedState: (p) => ownedState(p),
    bailToNative: (p, reason) => bailToNative(p, reason),
    declineRestored: (p, reason) => {
      states.delete(p);
      floats.rebind(p);
      bailed.add(p);
      emitSkip(p, reason);
      emitRelayout(p);
    },
    emitRelayout: (p) => emitRelayout(p),
    queues,
    restartPendingOrder: () => drain.restartPendingOrder(),
  });

  // Re-reading author styling and re-deciding from it lives in ./dom/reread.js.
  const { reread } = createRereadPass(record, {
    ownedState: (p) => ownedState(p),
    adopt: (targets) => adopt(targets),
    emitRelayout: (p) => emitRelayout(p),
    resyncObservation: (p) => {
      const state = ownedState(p);
      floats.rebind(p, state);
      if (state === undefined) {
        observer?.unobserve(p);
        drain.unobserve(p);
      } else {
        observer?.observe(p);
        drain.observe(p);
      }
    },
    reprobeBaselines: () => reprobeBaselines(fontProbes),
    queues,
  });

  // The correction pass and its width negotiation live in ./dom/corrections.js;
  // `CorrectionHost` there is the whole of what they need from this controller.
  const { flushPatches } = createCorrectionPass({
    ownedState: (p) => ownedState(p),
    bailToNative: (p, reason) => bailToNative(p, reason),
    emitRelayout: (p) => emitRelayout(p),
    safePatch: (p) => safePatch(p),
    rebuildMetrics: (state) => rebuildMetrics(state),
    seedNearViewport: (batch) => drain.seedNearViewport(batch),
    restartPendingOrder: () => drain.restartPendingOrder(),
    verifyElementFloats: (batch) => floats.verifyElementFloats(batch),
    queues,
    tracksViewport: drain.tracksViewport,
    viewportReady: () => drain.viewportReady(),
  });

  /** This controller's contribution to the shared copy handler. */
  const leaveClipboardCleanup =
    options.cleanClipboard === false
      ? null
      : joinClipboardCleanup({
          *enhanced() {
            for (const p of paragraphs) {
              const state = ownedState(p);
              if (state !== undefined && state.enhanced) yield [p, state.scan] as const;
            }
          },
        });

  let observer: WidthObserver | null = null;
  /** Late font loads only matter if they change what canvas measures: a
   * loadingdone fired moments after a commit that already measured those
   * faces (the async path's own loads, a page-driven re-justify) would
   * otherwise rewrite every paragraph for nothing. Probe advances are the
   * arbiter — the same net that catches engines whose check() reports a
   * still-loading face as available (WebKit with a loaded fallback in the
   * font string; it also fires no loadingdone for CSS-initiated loads). */
  /**
   * A face that starts loading AFTER the initial convergence. WebKit fires
   * `loading` for it but never `loadingdone` — verified for FontFace-API
   * loads in all three engines — so on that path the listener above is the
   * only notice a controller would ever get, and a font arriving late would
   * be rendered with the fallback's widths indefinitely. `fonts.ready` is
   * the portable signal for "this batch settled": it is replaced by a fresh
   * pending promise each time loading restarts, and resolves in every engine
   * once the new face is measurable. Re-entry is harmless because
   * `probesChanged()` still arbitrates, so the engines that DO fire
   * loadingdone simply find nothing left to do.
   */
  const onFontsLoading = (): void => {
    document.fonts.ready.then(
      () => {
        if (!destroyed) onFontsLoaded();
      },
      () => {},
    );
  };

  const onFontsLoaded = (): void => {
    const metricsChanged = probesChanged(fontProbes);
    let atomicChanged = false;
    for (const p of paragraphs) {
      const state = ownedState(p);
      if (state !== undefined && refreshAtomicWidths(state.scan)) atomicChanged = true;
    }
    const floatChanged = metricsChanged
      ? floats.refreshNativeIntrusions()
      : floats.refreshIntrusions();
    if (metricsChanged || atomicChanged || floatChanged) remeasureAll(true);
  };

  const attachObservers = (): void => {
    // Viewport tracking is independent of resize observation: the initial
    // flush seeds nearViewport itself, but only for what is on screen THEN —
    // every paragraph below the fold still parks, on any page. So both
    // viewport observers must run even with observeResize: false, or those
    // parked corrections would never fire at all.
    for (const p of paragraphs) {
      if (ownedState(p) !== undefined) drain.observe(p);
    }
    if (options.observeResize !== false) {
      floats.attachObserver();
      observer = createWidthObserver(drain.onWidths);
      for (const p of paragraphs) {
        const state = ownedState(p);
        if (state !== undefined) {
          observer.observe(p);
          floats.rebind(p, state);
        }
      }
    }
    document.fonts.addEventListener("loadingdone", onFontsLoaded);
    document.fonts.addEventListener("loading", onFontsLoading);
  };

  // The initial enhancement commits SYNCHRONOUSLY inside this justify()
  // call, whatever the font situation: canvas measures the fonts that are
  // RENDERING right now, so while webfonts are still loading the reader
  // gets the FALLBACK rendering fully justified — every visible state is
  // a justified one. Run from a render-blocking script, this puts
  // justified text in the first frame the page ever paints. When the real
  // faces settle, onFontsLoaded's probe guard re-measures only if their
  // metrics actually differ, and that convergence rides the same repaint
  // as the font swap. (Awaiting document.fonts.ready instead would forfeit
  // all of this — it can only resolve after the layout work that triggers
  // font loads, i.e. after the browser has painted native text. And
  // document.fonts.check() is no arbiter either: WebKit answers true for
  // a still-loading face whenever the font string carries an available
  // fallback family. Probe advances are the only ground truth used here.)
  /**
   * Read `targets` and enhance whatever of them can be: the whole adoption
   * sequence, shared by this first pass and by every later `rescan()`.
   */
  const adopt = (targets: readonly HTMLElement[]): void => {
    const restoreScanStyles = suppressAutosizingForScan(targets);
    let scannable: HTMLElement[];
    const scanBatch = beginScanBatch(targets.length);
    try {
      scannable = targets.filter((p) => scanParagraph(p, scanBatch));
    } finally {
      // Ends here, not at controller teardown: the batch's conclusions about
      // author CSS are only sound while no page script has run.
      endScanBatch(scanBatch);
      restoreScanStyles();
    }
    // Drained, so a later pass reports only what it declined itself.
    for (const { p, reason } of pendingSkips.splice(0)) emitSkip(p, reason);
    commit(scannable);
    // Probes cover every paragraph this controller holds, not just the ones this
    // pass read: a rescan of ONE paragraph must not discard the faces the others
    // are still waiting to converge on, or a webfont landing afterwards would
    // leave them on their fallback line breaks forever. Collected after the
    // commit, which is where each state's scan becomes reachable.
    fontProbes = collectFontProbes(
      paragraphs.flatMap((p) => ownedState(p)?.scan ?? []),
      hyphenate !== undefined,
    );
  };

  let ready: Promise<void>;
  try {
    adopt(paragraphs);
    reprobeBaselines(fontProbes);
    attachObservers();
    // `ready` keeps its contract — it resolves only once the needed faces
    // settled (loaded or failed) and the layout converged on them. The
    // load() calls also TRIGGER fetches for gated faces nothing has
    // rendered yet, and cover engines that never fire loadingdone for
    // CSS-initiated loads (WebKit). A face that fails to load settles
    // too: probes then match the fallback the commit measured, no work.
    if (fontProbes.length === 0) {
      fontsConverged = true;
      ready = Promise.resolve();
    } else {
      ready = Promise.all(
        fontProbes.map((f) => document.fonts.load(f.font, f.sample + f.kernSample).catch(() => {})),
      ).then(() => {
        fontsConverged = true;
        if (!destroyed) onFontsLoaded();
      });
    }
  } catch (error) {
    // Unexpected controller-level failures surface through `ready`,
    // never as a synchronous justify() throw.
    ready = Promise.reject(error instanceof Error ? error : new Error(describeError(error)));
  }
  // Fire-and-forget callers must not trigger unhandled-rejection noise;
  // callers who await `ready` still observe failures.
  ready.catch(() => {});

  return {
    ready,
    paragraphs,
    get managed() {
      return paragraphs.filter((p) => {
        const state = ownedState(p);
        if (state === undefined) return false;
        // Our record says enhanced but the DOM disagrees: something outside
        // restored this paragraph, so the enhancement is no longer live. A
        // native one-line paragraph legitimately has no attribute.
        return !state.enhanced || p.hasAttribute("data-justif");
      });
    },
    refresh() {
      floats.refreshNativeIntrusions();
      remeasureAll(true);
    },
    rescan(targets) {
      if (destroyed) return [];
      const candidates =
        targets === undefined
          ? paragraphs
          : [...targets].filter(
              (el): el is HTMLElement => el instanceof HTMLElement && owned.has(el),
            );
      // Whose answer could actually change. A paragraph this controller has
      // released — unjustify(), a teardown from outside — is neither managed nor
      // declined, and stays released: that was a decision, not a state.
      const considered = candidates.filter(
        (p) => ownedState(p) !== undefined || bailed.has(p),
      );
      return reread(considered);
    },
    applyLayoutOptions(config) {
      if (destroyed) return;
      const resolved = resolveOptions({ ...fixedOptions, ...config });
      // Keep the memoized hyphenator: re-resolving wraps the same function in
      // a fresh, empty cache, which would re-split every word in the document.
      resolved.buildOpts.hyphenate = hyphenate;
      breakOpts = resolved.breakOpts;
      buildOpts = resolved.buildOpts;
      lastLineMinWidth = resolved.lastLineMinWidth;
      expansion = resolved.expansion;
      spacing = resolved.spacing;
      protrusionCtx = resolved.protrusionCtx;
      floats.refreshNativeIntrusions();
      remeasureAll(true, false);
    },
    destroy() {
      destroyed = true;
      // Destroyed before the faces settled: the module-level measure
      // caches hold fallback-font metrics that nothing would ever
      // invalidate now (spec keys carry no font-load state, and this
      // controller's listeners die here) — a later justify() over the
      // same specs would silently reuse them against the loaded face.
      // Sacrifice the caches instead; live controllers merely re-measure
      // on their next layout.
      if (!fontsConverged) {
        clearMeasureCache();
        clearCalibrationCache();
        clearOpticalCache();
        clearComposedProtrusionCache();
      }
      drain.reset();
      leaveClipboardCleanup?.();
      document.fonts.removeEventListener("loadingdone", onFontsLoaded);
      document.fonts.removeEventListener("loading", onFontsLoading);
      drain.disconnect();
      observer?.disconnect();
      observer = null;
      floats.disconnect();
      for (const p of paragraphs) {
        if (ownedState(p) !== undefined) restore(p);
      }
    },
  };
}

/** Restore paragraphs enhanced by any controller to their original DOM. */
export function unjustify(targets: Element | Iterable<Element>): void {
  for (const el of targets instanceof Element ? [targets] : targets) {
    if (el instanceof HTMLElement) restore(el);
  }
}

function restore(p: HTMLElement): void {
  const state = states.get(p);
  if (state === undefined) return;
  restoreManagedOutput(p, state);
  states.delete(p);
}
