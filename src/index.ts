/**
 * justif — publication-grade text justification for the web.
 *
 * `justify(document.querySelectorAll("p"))` re-lays-out existing paragraphs
 * with Knuth-Plass optimal line breaking, character protrusion (optical
 * margin alignment, per-font via measured glyph geometry), font expansion
 * on variable fonts with a wdth axis, and optional letterfit tracking
 * (Bringhurst's ±3%). Resize re-runs arithmetic only; `destroy()` restores
 * the original DOM.
 */
import { breakParagraph } from "./core/breaker.js";
import { buildItems } from "./core/items.js";
import { layoutLines } from "./core/layout.js";
import {
  composeProtrusion,
  type HangingPunctuationMode,
  latinProtrusion,
} from "./core/protrusion.js";
import {
  type BreakOptions,
  type BuildOptions,
  defaultBreakOptions,
  defaultBuildOptions,
  type ExpansionOptions,
  type ParagraphItems,
  type ProtrusionTable,
  type RunMetrics,
  type TrackingOptions,
} from "./core/types.js";
import { clearCalibrationCache } from "./dom/calibrate.js";
import {
  clearMeasureCache,
  collectDomMeasurements,
  ctxFontOf,
  type FontSpec,
  requiresDomMeasurement,
  supportsSpec,
} from "./dom/measure.js";
import { createWidthObserver, type WidthObserver } from "./dom/observe.js";
import { contentWidthOf, type ParagraphScan, readParagraph } from "./dom/read.js";
import { buildRenderSegments, buildRunMetrics, measureFor, runTexts } from "./dom/segments.js";
import {
  applyCorrections,
  measureCorrections,
  type PendingParagraph,
  writeParagraph,
} from "./dom/write.js";

export { kinsokuNotAtLineEnd, kinsokuNotAtLineStart } from "./core/cjk.js";
export type { ExpansionOptions, Line, ProtrusionTable, TrackingOptions } from "./core/types.js";
export {
  composeProtrusion,
  type HangingPunctuationMode,
  hangingPunctuation,
  latinProtrusion,
} from "./core/protrusion.js";
export { fontProtrusion } from "./core/protrusion-fonts.js";

export interface JustifyOptions {
  /** Word splitter, e.g. `hyphenateEnUS` from "justif/hyphenate/en-us".
   * Never called for RTL paragraphs (Arabic joining makes fragment
   * measurement invalid; Hebrew convention breaks without hyphens). */
  hyphenate?: (word: string) => readonly string[];
  tolerance?: number;
  pretolerance?: number;
  hyphenPenalty?: number;
  exHyphenPenalty?: number;
  linePenalty?: number;
  adjDemerits?: number;
  doubleHyphenDemerits?: number;
  finalHyphenDemerits?: number;
  emergencyStretch?: number | "auto";
  /**
   * Discourage paragraph endings shorter than this fraction of the measure
   * (0.33 ≈ Bringhurst's "at least a third"). Soft, cost-based pressure:
   * the breaker lengthens endings when the paragraph can afford it and
   * declines when other lines would suffer more. Off by default. (Maps to
   * the core's TeX-style `lastLineStretch` budget of 1 − value; headless
   * users tune that directly.)
   */
  lastLineMinWidth?: number;
  /** true = built-in Latin table; an object merges over it; false disables. */
  protrusion?: boolean | ProtrusionTable;
  /**
   * Full hanging punctuation: quotes, stops, and opening brackets hang
   * entirely outside the measure. "first-line" (the DEFAULT, = `true`)
   * hangs left-edge marks fully only on the paragraph's FIRST line —
   * mid-paragraph line starts keep their partial microtype protrusion —
   * while stops and closing quotes hang fully at every line end;
   * "all-lines" extends the full left hangs to every line (classical
   * Gutenberg style); `false` disables full hangs, leaving microtype's
   * partial protrusion only. Requires `protrusion` enabled.
   */
  hangingPunctuation?: boolean | "first-line" | "all-lines";
  /** Glyph expansion limits via the wdth axis; false disables. */
  expansion?: ExpansionOptions | false;
  lastLineMinWords?: number;
  /**
   * Inter-word glue flexibility as fractions of the space width. `pull`
   * (0–1, default 0.7) is the downward pressure on secondary-font spaces
   * wider than the paragraph base font's: 0 keeps each font's natural
   * space, 1 converges them fully to the base (risks dissolving word
   * boundaries in loose-fitting fonts like monospace). `boundaryShrink`
   * (0–1, default 0) multiplies the shrink of spaces at font-FAMILY
   * boundaries: chips and pills (inline code, <kbd>) live there, their
   * insets occupy part of the adjacent gap, and native CSS justification
   * never shrinks a space — so by default those gaps stretch but hold
   * their natural width. 1 restores TeX semantics.
   */
  spacing?: { stretch: number; shrink: number; pull?: number; boundaryShrink?: number };
  /**
   * Letterfit tracking: lets inter-character space open or close each
   * line's set width, participating in break decisions like expansion.
   * `true` (the DEFAULT) allows ±3% — Bringhurst's tolerance for
   * letterspacing variation in justified text (The Elements of Typographic
   * Style); `false` disables. Word space and glyph expansion remain the
   * primary flexes (tracking saturates at its budget), and the last line
   * always keeps its natural letterfit. Beyond TeX: microtype's
   * letterspacing is static styling, never a per-line justification
   * variable. Always off for RTL paragraphs (letterspacing cursive Arabic
   * is typographically wrong and renders inconsistently across engines).
   */
  tracking?: boolean | Partial<TrackingOptions>;
  /**
   * Last-line color matching (eTeX's \lastlinefit): the paragraph ending's
   * spaces are set at this fraction (0–1) of the paragraph's average
   * looseness, instead of always natural width — a connoisseur's
   * refinement mainstream DTP tools only approximate with a static
   * "desired spacing" value. 0 (default) = off.
   */
  lastLineFit?: number;
  /**
   * Clean library-introduced characters out of copied text (default true).
   * Wrap determinism renders mid-line run-boundary spaces as NBSP and rare
   * dash junctions carry a U+2060 word joiner — plumbing that shouldn't
   * survive into the clipboard. Word joiners are always removed; NBSPs are
   * normalized back to spaces only when the selection's paragraphs
   * contained no author NBSPs (author intent like `Fig.&nbsp;7` wins over
   * cleanup). `false` restores raw copies.
   */
  cleanClipboard?: boolean;
  observeResize?: boolean;
  /**
   * Called after a paragraph's lines are (re)patched into the DOM — initial
   * enhancement, resize re-layout, refresh. Use it to keep overlays or
   * annotations positioned over the text in sync. NOT fired for the
   * deferred wrap-guarantee corrections: those only normalize trailing
   * layout-advance margins and never move a glyph.
   */
  onRelayout?: (paragraph: HTMLElement) => void;
}

export interface JustifyController {
  /** Resolves after fonts are ready and the initial enhancement ran. */
  readonly ready: Promise<void>;
  /**
   * Re-measure with the currently loaded font files and re-layout (also runs
   * automatically when webfonts finish loading). For content or CSS changes,
   * destroy() and justify() again — the original scan is reused here.
   */
  refresh(): void;
  /** Restore the original DOM and disconnect observers. */
  destroy(): void;
  readonly paragraphs: readonly HTMLElement[];
}

interface ParaState {
  /** The controller that owns this enhancement (guards zombie observers). */
  owner: symbol;
  original: DocumentFragment;
  originalStyleAttr: string | null;
  scan: ParagraphScan;
  runsMetrics: RunMetrics[];
  specByKey: Map<string, FontSpec>;
  para: ParagraphItems;
  width: number;
  /** Fingerprint of the last patch, to skip no-op re-renders. */
  lastPatch: string;
  enhanced: boolean;
}

/** Enhancement state is shared so unjustify() works from anywhere; each
 * state carries the owner of the controller that created it. */
const states = new WeakMap<HTMLElement, ParaState>();

const DEFAULT_EXPANSION: ExpansionOptions = { max: 0.02, shrink: 0.02, step: 0.005 };
const DEFAULT_SPACING = { stretch: 0.5, shrink: 1 / 3, pull: 0.7, boundaryShrink: 0 };
/** Bringhurst's tolerance: letterspacing in justified text may vary ±3%. */
const DEFAULT_TRACKING: TrackingOptions = { max: 0.03, shrink: 0.03 };

function noopController(): JustifyController {
  return { ready: Promise.resolve(), refresh() {}, destroy() {}, paragraphs: [] };
}

/** Defaults overlaid with the defined subset of same-named option keys. */
function withOverrides<T extends object>(defaults: T, overrides: Partial<T>): T {
  const merged = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const value = overrides[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
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
  /** Per-controller, so a destroy() + justify() retry gets a fresh chance
   * after content that previously caused a bail has been fixed. */
  const bailed = new WeakSet<HTMLElement>();
  let destroyed = false;

  const breakOpts = withOverrides(defaultBreakOptions, options);
  // Public intent ("ending at least this wide") → core mechanism (finite
  // parfillskip stretch budget). Smaller budget = stronger pressure, so
  // the two run in opposite directions — hence the friendlier name.
  if (options.lastLineMinWidth !== undefined && options.lastLineMinWidth > 0) {
    breakOpts.lastLineStretch = Math.max(0.05, 1 - Math.min(options.lastLineMinWidth, 0.95));
  }
  /** User's explicit per-char overrides, kept separate so they also win
   * over any per-font config matched in buildRunMetrics. */
  const protrusionUser: ProtrusionTable | null =
    typeof options.protrusion === "object" ? options.protrusion : null;
  const hangMode: HangingPunctuationMode =
    options.hangingPunctuation === false
      ? false
      : options.hangingPunctuation === true || options.hangingPunctuation === undefined
        ? "first-line"
        : options.hangingPunctuation;
  const composed =
    options.protrusion === false
      ? null
      : composeProtrusion(latinProtrusion, protrusionUser, hangMode);
  const protrusion: ProtrusionTable | false = composed === null ? false : composed.rest;
  const protrusionFirst =
    composed !== null && composed.first !== composed.rest ? composed.first : undefined;
  const protrusionCtx = { enabled: composed !== null, user: protrusionUser, hang: hangMode };
  const expansion = options.expansion === undefined ? DEFAULT_EXPANSION : options.expansion;
  const spacing = options.spacing ?? DEFAULT_SPACING;
  const tracking: TrackingOptions | false =
    options.tracking === false
      ? false
      : options.tracking === true || options.tracking === undefined
        ? DEFAULT_TRACKING
        : { ...DEFAULT_TRACKING, ...options.tracking };

  let hyphenate = options.hyphenate;
  if (hyphenate !== undefined) {
    const inner = hyphenate;
    const cache = new Map<string, readonly string[]>();
    hyphenate = (word) => {
      let pieces = cache.get(word);
      if (pieces === undefined) {
        pieces = inner(word);
        cache.set(word, pieces);
      }
      return pieces;
    };
  }
  const buildOpts: BuildOptions = {
    ...defaultBuildOptions,
    hyphenate,
    lastLineFit: Math.max(0, Math.min(1, options.lastLineFit ?? 0)),
    hyphenPenalty: options.hyphenPenalty ?? defaultBuildOptions.hyphenPenalty,
    exHyphenPenalty: options.exHyphenPenalty ?? defaultBuildOptions.exHyphenPenalty,
    lastLineMinWords: options.lastLineMinWords ?? defaultBuildOptions.lastLineMinWords,
    protrusion,
    protrusionFirst,
    expansion,
    tracking,
    boundaryShrink: spacing.boundaryShrink ?? defaultBuildOptions.boundaryShrink,
  };

  /** Phase 1: DOM reads only — no measurement, no font dependence. */
  const scanned = new Map<HTMLElement, ParagraphScan>();
  const scanParagraph = (p: HTMLElement): boolean => {
    if (states.get(p)?.enhanced) return true; // idempotent (possibly foreign)
    if (bailed.has(p)) return false;
    if (scanned.has(p)) return true;
    // Fail-safe: this library's contract is "enhance or leave native" —
    // an unexpected exception on one paragraph (a bug, hostile content)
    // must downgrade THAT paragraph to native rendering, never abort the
    // controller or poison its siblings.
    let scan: ParagraphScan | null;
    try {
      scan = readParagraph(p);
      if (scan !== null && scan.specs.some((sp) => !supportsSpec(sp))) scan = null;
    } catch {
      scan = null;
    }
    if (scan === null) {
      bailed.add(p);
      return false;
    }
    scanned.set(p, scan);
    return true;
  };

  const buildPara = (
    scan: ParagraphScan,
    runsMetrics: RunMetrics[],
    specByKey: Map<string, FontSpec>,
  ): ParagraphItems => {
    // RTL paragraphs never letterspace: tracking inside Arabic cursive
    // joining is typographically wrong, and engines disagree on whether
    // joined pairs receive letter-spacing at all — the width model would
    // drift by pixels per word. (Hyphenation is likewise suppressed, via
    // noHyphens in buildRunMetrics.)
    const opts = scan.direction === "rtl" ? { ...buildOpts, tracking: false as const } : buildOpts;
    return buildItems(runTexts(scan), runsMetrics, opts, measureFor(specByKey));
  };

  /** Phase 2: measurement + item building (fonts must be loaded by now). */
  const prepare = (p: HTMLElement): boolean => {
    if (states.get(p)?.enhanced) {
      scanned.delete(p); // another controller won the race; drop our scan
      return true;
    }
    const scan = scanned.get(p);
    if (scan === undefined) return false;
    scanned.delete(p);

    try {
      const specByKey = new Map<string, FontSpec>();
      for (const spec of scan.specs) specByKey.set(spec.key, spec);
      const runsMetrics = buildRunMetrics(scan, expansion, spacing, protrusionCtx);
      states.set(p, {
        owner,
        original: document.createDocumentFragment(),
        originalStyleAttr: p.getAttribute("style"),
        scan,
        runsMetrics,
        specByKey,
        para: buildPara(scan, runsMetrics, specByKey),
        width: scan.contentWidth,
        lastPatch: "",
        enhanced: false,
      });
    } catch {
      // Same fail-safe as the scan: this paragraph stays native.
      bailed.add(p);
      return false;
    }
    return true;
  };

  /**
   * Break, lay out, and write one paragraph's segment DOM. The measured
   * wrap-guarantee corrections are NOT run here — the caller batches them
   * through `flushPatches`, so a flush of many paragraphs costs one forced
   * layout instead of one per paragraph. Returns null when the patch is a
   * no-op (unchanged fingerprint or foreign state).
   */
  /**
   * patchOne with the per-paragraph fail-safe: an unexpected throw while
   * breaking/laying out/writing restores the paragraph's original DOM and
   * bails it to native rendering — never a half-patched paragraph, a dead
   * resize loop, or a poisoned controller. (writeParagraph builds its
   * fragment off-DOM and installs it atomically, so a throw cannot leave
   * partial segments behind; restore() covers the already-enhanced case.)
   */
  const safePatch = (p: HTMLElement): PendingParagraph | null => {
    try {
      return patchOne(p);
    } catch {
      restore(p);
      bailed.add(p);
      return null;
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

  const patchOne = (p: HTMLElement): PendingParagraph | null => {
    const state = states.get(p);
    if (state === undefined || state.owner !== owner) return null;
    // Percentage indents resolve against the LIVE width (the scan-time
    // resolution would go stale across resizes).
    const indentPx =
      state.scan.textIndentPct !== null
        ? state.scan.textIndentPct * state.width
        : state.scan.textIndent;
    const widths = indentPx !== 0 ? [state.width - indentPx, state.width] : state.width;
    const result = breakParagraph(state.para, widths, breakOpts);
    const lines = layoutLines(state.para, result, widths, buildOpts);
    const rendered = buildRenderSegments(state.scan, state.runsMetrics, state.para, lines);

    const fingerprint =
      result.breakpoints.join(",") +
      "|" +
      lines.map((l) => `${l.glueRatio.toFixed(4)}:${l.fontStretch}`).join(",");
    if (fingerprint === state.lastPatch) return null;
    state.lastPatch = fingerprint;

    if (!state.enhanced) {
      state.original.append(...p.childNodes);
      state.enhanced = true;
      p.setAttribute("data-justif", "");
      // Neutralize the author's text-align: justify (the browser must not
      // re-justify our exactly-filled lines) — toward the line-START edge,
      // which is the right edge in an RTL paragraph.
      p.style.textAlign = state.scan.direction === "rtl" ? "right" : "left";
      // Neutralize CSS hanging-punctuation (Safari): it would hang quotes
      // and stops on top of our protrusion — a double hang — and shift
      // rendered widths our wrap model doesn't know about. A no-op in
      // engines that don't support the property; restored by destroy()
      // with the rest of the style attribute. Use `hangingPunctuation`
      // (the protrusion preset) for the full-hang style instead.
      p.style.setProperty("hanging-punctuation", "none");
    }
    // Exact placeholder geometry for content-visibility authors: line boxes
    // are uniform (nowrap segments), so the model height is lines ×
    // line-height. Skipped paragraphs then occupy exactly their rendered
    // size — find-in-page scroll targets, anchors, and scrollbars stay
    // stable across reveals even in engines whose remembered-size
    // recording is unreliable (WebKit).
    if (state.scan.pinIntrinsicSize && state.scan.lineHeightPx !== null) {
      p.style.containIntrinsicBlockSize = `auto ${
        Math.round(lines.length * state.scan.lineHeightPx * 1000) / 1000
      }px`;
    }
    // This re-patch detaches any previous segment DOM: corrections queued
    // for the old nodes are stale and must never be measured or parked.
    pendingCorrections.delete(p);
    hiddenCorrections.delete(p);
    // Per-line target widths: an indented first line has its own measure,
    // and the wrap-guarantee corrections must compare against it.
    return writeParagraph(p, rendered, lines.map((l) => l.width));
  };

  interface PatchEntry {
    p: HTMLElement;
    pending: PendingParagraph;
  }

  /**
   * One read pass + one write pass for a batch of patched paragraphs.
   * Paragraphs whose content is layout-skipped (`content-visibility: auto`
   * off-screen) cannot be measured; their corrections are parked in
   * `hiddenCorrections` and retried when the IntersectionObserver reports
   * them near the viewport. Until then the provisional wrap-safety pad
   * keeps their lines from re-wrapping.
   */
  const flushPatches = (batch: readonly PatchEntry[]): void => {
    if (batch.length === 0) return;
    // Only paragraphs near the viewport are measured — reading rects of a
    // content-visibility-skipped paragraph returns zeros but still pays
    // the per-call geometry cost (~0.1ms in WebKit), which at hundreds of
    // off-screen paragraphs would dominate the drain. Far paragraphs are
    // parked unmeasured; the viewport observers promote them on approach.
    // Without an IntersectionObserver everything is measured directly.
    const measure: PatchEntry[] = [];
    for (const e of batch) {
      if (viewObserver === null || nearViewport.has(e.p)) measure.push(e);
      else if (e.p.isConnected) hiddenCorrections.set(e.p, e.pending);
    }
    if (measure.length > 0) {
      const { corrections, hidden } = measureCorrections(measure.map((e) => e.pending));
      applyCorrections(corrections);
      for (const i of hidden) {
        const e = measure[i]!;
        hiddenCorrections.set(e.p, e.pending);
      }
    }
  };

  const enhanceAll = async (): Promise<void> => {
    // Read phase for every paragraph first (one style/layout flush), then
    // ensure every needed font face is actually loaded — canvas measureText
    // silently uses fallback metrics for lazily-loading webfonts, which
    // would set every line to the wrong measure — then canvas measurement
    // and one write phase.
    const scannable = paragraphs.filter(scanParagraph);
    const fontsNeeded = new Set<string>();
    for (const p of scannable) {
      const scan = scanned.get(p);
      if (scan !== undefined) for (const spec of scan.specs) fontsNeeded.add(ctxFontOf(spec));
    }
    if (fontsNeeded.size > 0) {
      await Promise.all(
        [...fontsNeeded].map((font) => document.fonts.load(font).catch(() => {})),
      );
    }
    if (destroyed) return;
    // Discover every string needed by variant-bearing runs using disposable
    // canvas estimates, then shape all of those strings in one hidden DOM
    // batch. The real prepare pass below reads exact cached widths.
    collectDomMeasurements(() => {
      for (const p of scannable) {
        const scan = scanned.get(p);
        if (scan === undefined) continue;
        if (!scan.specs.some(requiresDomMeasurement)) continue;
        try {
          const specByKey = new Map(scan.specs.map((spec) => [spec.key, spec]));
          const runsMetrics = buildRunMetrics(scan, expansion, spacing, protrusionCtx);
          buildPara(scan, runsMetrics, specByKey);
        } catch {
          // prepare() owns the per-paragraph fail-safe and will bail this
          // paragraph without affecting its siblings.
        }
      }
    });
    const batch: PatchEntry[] = [];
    for (const p of scannable) {
      if (!prepare(p)) continue;
      const pending = safePatch(p);
      if (pending !== null) batch.push({ p, pending });
    }
    flushPatches(batch);
    for (const e of batch) emitRelayout(e.p);
  };

  const remeasureAll = (): void => {
    if (destroyed) return;
    clearMeasureCache();
    clearCalibrationCache();
    const mine = paragraphs.filter((p) => states.get(p)?.owner === owner);
    // All width reads first, then all patches, then one correction flush —
    // interleaving reads with the DOM writes would force a layout per
    // paragraph.
    const widths = new Map(mine.map((p) => [p, contentWidthOf(p)]));
    collectDomMeasurements(() => {
      for (const p of mine) {
        const state = states.get(p)!;
        if (!state.scan.specs.some(requiresDomMeasurement)) continue;
        try {
          const runsMetrics = buildRunMetrics(state.scan, expansion, spacing, protrusionCtx);
          buildPara(state.scan, runsMetrics, state.specByKey);
        } catch {
          // The actual pass below owns restoration and native fallback.
        }
      }
    });
    const batch: PatchEntry[] = [];
    for (const p of mine) {
      const state = states.get(p)!;
      state.runsMetrics = buildRunMetrics(state.scan, expansion, spacing, protrusionCtx);
      state.para = buildPara(state.scan, state.runsMetrics, state.specByKey);
      state.width = widths.get(p)!;
      state.lastPatch = "";
      const pending = safePatch(p);
      if (pending !== null) batch.push({ p, pending });
    }
    flushPatches(batch);
    for (const e of batch) emitRelayout(e.p);
  };

  // Resize re-layouts run in frame-budgeted slices, paragraphs in (or
  // near) the viewport first: a live width drag on a document with very
  // many paragraphs keeps frames short and updates the text the user is
  // looking at immediately, while below-the-fold paragraphs settle over
  // the following frames. Ordering comes from a passive
  // IntersectionObserver (geometry reads at drain time would force a
  // layout), and the measured wrap-guarantee corrections are deferred to
  // their own trailing slices — every patched line carries a provisional
  // safety pad, so nothing can re-wrap while its correction is queued, and
  // during a continuous drag superseded corrections are simply dropped.
  const pendingWidths = new Map<HTMLElement, number>();
  const pendingCorrections = new Map<HTMLElement, PendingParagraph>();
  /** Corrections that could not be measured because the paragraph's
   * content was layout-skipped (`content-visibility: auto` off-screen);
   * retried when the paragraph approaches the viewport. */
  const hiddenCorrections = new Map<HTMLElement, PendingParagraph>();
  let pendingOrder: HTMLElement[] = [];
  let pendingCursor = 0;
  let sliceQueued = false;
  const SLICE_BUDGET_MS = 10;
  /** Corrections measured per trailing slice; bounds the geometry reads
   * (the dominant cost per slice — WebKit pays ~0.1ms per rect call). */
  const CORRECTION_CHUNK = 100;

  /**
   * Paragraphs at or near the viewport, tracked passively. Drives drain
   * ordering, the measure-vs-park split in flushPatches, and the first
   * promotion stage for parked corrections: a paragraph entering the 50%
   * margin gets its parked correction measured (for plain content this
   * lands flush before the user sees it; content-visibility-skipped
   * content measures zero and re-parks — the reveal observer below is the
   * guaranteed second stage, so no retry loop is possible).
   */
  const nearViewport = new Set<Element>();
  const viewObserver =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
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
    const s = states.get(el);
    if (s === undefined || s.owner !== owner || !s.enhanced) return false;
    pendingCorrections.set(el, parked);
    return true;
  };

  const scheduleSlice = (): void => {
    if (sliceQueued) return;
    sliceQueued = true;
    requestAnimationFrame(drainPending);
  };

  const visibleFirst = (els: HTMLElement[]): HTMLElement[] => {
    if (els.length > 1 && viewObserver !== null) {
      els.sort((a, b) => Number(!nearViewport.has(a)) - Number(!nearViewport.has(b)));
    }
    return els;
  };

  const drainPending = (): void => {
    sliceQueued = false;
    if (destroyed) {
      pendingWidths.clear();
      pendingCorrections.clear();
      hiddenCorrections.clear();
      pendingOrder = [];
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
      for (const p of paragraphs) {
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
      // Reachable: the observer callback deletes entries superseded by a
      // revert to the current width while the stale order still lists them.
      if (width === undefined) continue;
      pendingWidths.delete(el);
      const state = states.get(el);
      if (state === undefined || state.owner !== owner || !state.enhanced) continue;
      if (Math.abs(width - state.width) < 0.05) continue;
      state.width = width;
      const pending = safePatch(el);
      if (pending !== null) {
        pendingCorrections.set(el, pending);
        wrote = true;
        emitRelayout(el);
        // onRelayout may call destroy(); stop before touching anything else.
        if (destroyed) return;
      }
    }
    if (wrote && anchor !== null) {
      const delta = anchor.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
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
      flushPatches(batch);
    }
    if (pendingCorrections.size > 0 || pendingWidths.size > 0) scheduleSlice();
  };

  /**
   * Rewrites copies that touch enhanced paragraphs: strips the word
   * joiners and (when no author NBSP is at stake) normalizes the
   * run-boundary NBSPs back to ordinary spaces, for both text/plain and
   * text/html flavors.
   */
  const onCopy = (e: ClipboardEvent): void => {
    if (e.clipboardData === null) return;
    const sel = document.getSelection();
    if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return;
    let touches = false;
    let authorNbsp = false;
    for (const p of paragraphs) {
      const state = states.get(p);
      if (state === undefined || state.owner !== owner || !state.enhanced) continue;
      if (!sel.containsNode(p, true)) continue;
      touches = true;
      if (state.scan.runs.some((r) => /[\u00A0\u202F]/.test(r.text))) authorNbsp = true;
    }
    if (!touches) return;

    const clean = (v: string): string => {
      const noWj = v.replace(/\u2060/g, "");
      return authorNbsp ? noWj : noWj.replace(/\u00A0/g, " ");
    };
    // text/plain comes from the cloned fragments, not Selection.toString():
    // Firefox's toString() folds NBSP to a plain space, which would drop
    // the very author NBSPs the authorNbsp guard exists to preserve.
    const BLOCKY =
      /^(?:P|DIV|LI|UL|OL|BLOCKQUOTE|H[1-6]|PRE|TABLE|TR|SECTION|ARTICLE|HEADER|FOOTER|FIGURE|FIGCAPTION)$/;
    const plainOf = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
      let out = "";
      for (let c = node.firstChild; c !== null; c = c.nextSibling) out += plainOf(c);
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as Element).tagName;
        if (tag === "BR") out += "\n";
        else if (BLOCKY.test(tag)) out += "\n\n";
      }
      return out;
    };
    const html = document.createElement("div");
    let plain = "";
    for (let i = 0; i < sel.rangeCount; i++) {
      const frag = sel.getRangeAt(i).cloneContents();
      const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        n.nodeValue = clean(n.nodeValue ?? "");
      }
      plain += plainOf(frag);
      html.append(frag);
    }
    e.clipboardData.setData("text/plain", plain.replace(/\n+$/, ""));
    e.clipboardData.setData("text/html", html.innerHTML);
    e.preventDefault();
  };
  if (options.cleanClipboard !== false) document.addEventListener("copy", onCopy);

  let observer: WidthObserver | null = null;
  const onFontsLoaded = (): void => remeasureAll();

  const ready = (async () => {
    await document.fonts.ready;
    if (destroyed) return;
    await enhanceAll();
    if (destroyed) return;
    // Viewport tracking is independent of resize observation: corrections
    // park during the initial enhancement flush on ANY page (the measure/
    // park split in flushPatches gates on nearViewport), so both viewport
    // observers must run even with observeResize: false — without them the
    // measured wrap-guarantee would never fire at all.
    for (const p of paragraphs) {
      const s = states.get(p);
      if (s !== undefined && s.owner === owner && s.enhanced) {
        viewObserver?.observe(p);
        revealObserver?.observe(p);
      }
    }
    if (options.observeResize !== false) {
      observer = createWidthObserver((widths) => {
        for (const [el, width] of widths) {
          const state = states.get(el as HTMLElement);
          if (state === undefined || state.owner !== owner || !state.enhanced) continue;
          if (Math.abs(width - state.width) < 0.05) {
            // Reverted to the current width: drop any queued intermediate
            // width, or a stale patch would land after the resize settled.
            pendingWidths.delete(el as HTMLElement);
            continue;
          }
          pendingWidths.set(el as HTMLElement, width);
        }
        // Already inside the observer's rAF: order the queue (no reads —
        // visibility is tracked passively) and run the first slice now —
        // unless a slice is already queued for this frame chain, which
        // would double the drain (and its forced layout) in one frame.
        if (pendingWidths.size > 0) {
          pendingOrder = visibleFirst([...pendingWidths.keys()]);
          pendingCursor = 0;
          if (!sliceQueued) drainPending();
        }
      });
      for (const p of paragraphs) {
        const s = states.get(p);
        if (s !== undefined && s.owner === owner && s.enhanced) observer.observe(p);
      }
    }
    document.fonts.addEventListener("loadingdone", onFontsLoaded);
  })();
  // Fire-and-forget callers must not trigger unhandled-rejection noise;
  // callers who await `ready` still observe failures.
  ready.catch(() => {});

  return {
    ready,
    paragraphs,
    refresh: remeasureAll,
    destroy() {
      destroyed = true;
      pendingWidths.clear();
      pendingCorrections.clear();
      hiddenCorrections.clear();
      pendingOrder = [];
      document.removeEventListener("copy", onCopy);
      document.fonts.removeEventListener("loadingdone", onFontsLoaded);
      viewObserver?.disconnect();
      revealObserver?.disconnect();
      observer?.disconnect();
      observer = null;
      for (const p of paragraphs) {
        if (states.get(p)?.owner === owner) restore(p);
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
  if (state === undefined || !state.enhanced) return;
  p.replaceChildren(state.original);
  if (state.originalStyleAttr === null) p.removeAttribute("style");
  else p.setAttribute("style", state.originalStyleAttr);
  p.removeAttribute("data-justif");
  states.delete(p);
}
