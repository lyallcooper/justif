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
  probeAdvance,
  requiresDomMeasurement,
  supportsSpec,
} from "./dom/measure.js";
import { createWidthObserver, type WidthObserver } from "./dom/observe.js";
import { contentWidthOf, type ParagraphScan, readParagraph } from "./dom/read.js";
import { buildRenderSegments, buildRunMetrics, measureFor, runTexts } from "./dom/segments.js";
import {
  applyCorrections,
  disableTextAutosizing,
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
   * Keep paragraph endings at least this fraction of the measure wide
   * (0.33 ≈ Bringhurst's "at least a third"). Two mechanisms compose.
   * The breaker prefers arrangements whose endings reach the threshold
   * naturally — cost pressure that escalates into hyphenation when
   * needed, and prices endings by exactly what will render, so it steers
   * into arrangements the render floor can finish. An ending that still
   * falls short is then RENDERED with its word spaces widened to the
   * threshold — within a willingness that scales with the setting:
   * rectangles (`1`) work the spaces up to TeX's underfull-reporting
   * standard (≈ 2× natural at the default `spacing`), a gentle `0.33`
   * floor barely opens them. An ending that would need more keeps fully
   * natural spacing instead: all or nothing, never stretched AND still
   * short. The same principle holds for the whole paragraph: a threshold
   * ending is never bought with a worse-than-tolerance body line, and the
   * option never renders a shorter ending than it would produce switched
   * off (the breaker compares and keeps the better solution). The top of
   * the range can still be non-monotone per paragraph — one may satisfy
   * `0.5` yet revert to its natural ending at `1`. At `1` every paragraph
   * that can afford it sets as a perfect rectangle. Defaults to `0.33`
   * (Bringhurst); pass `0` to disable.
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
  /**
   * Re-layout managed paragraphs when their content width changes
   * (default true). With `false`, width changes after enhancement are
   * not tracked — including ones caused by OTHER elements' late-loading
   * fonts resizing a shared shrink-to-fit container; call `refresh()`
   * after such changes.
   */
  observeResize?: boolean;
  /**
   * Called after a paragraph's lines are (re)patched into the DOM —
   * initial enhancement, resize re-layout, refresh, and re-measures
   * triggered by fonts finishing to load. Use it to keep overlays or
   * annotations positioned over the text in sync. NOT fired for the
   * deferred wrap-guarantee corrections: those only normalize trailing
   * layout-advance margins and never move a glyph.
   */
  onRelayout?: (paragraph: HTMLElement) => void;
  /**
   * Called once per paragraph that justif declines to manage, with a short
   * human-readable reason ("inline <kbd> has a horizontal margin",
   * "font-variation-settings on a run", "threw while rendering: …").
   * Declines are otherwise silent by design — the paragraph keeps its
   * native CSS rendering — which makes "skipped" indistinguishable from
   * "broken" while integrating; this is the diagnosis channel.
   */
  onSkip?: (paragraph: HTMLElement, reason: string) => void;
}

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

/** Restore an inline style attribute exactly after CSSOM writes. Chromium can
 * rematerialize `style=""` when an element whose CSSStyleDeclaration handled
 * text-size-adjust is later cloned, even after removeAttribute(). Resetting
 * the attribute first severs that stale declaration before removal. */
function restoreStyleAttribute(el: HTMLElement, style: string | null): void {
  if (style === null) {
    el.setAttribute("style", "");
    el.removeAttribute("style");
  } else {
    el.setAttribute("style", style);
  }
}

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
  // The public default is Bringhurst's third (the CORE default stays 0 =
  // classic TeX, like tracking's core-off/public-on split). One clamped
  // value feeds breaker pricing AND the layout floor — the two must see
  // the same number.
  const lastLineMinWidth = Math.max(0, Math.min(1, options.lastLineMinWidth ?? 0.33));
  breakOpts.lastLineMinWidth = lastLineMinWidth;
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
    lastLineMinWidth,
    hyphenPenalty: options.hyphenPenalty ?? defaultBuildOptions.hyphenPenalty,
    exHyphenPenalty: options.exHyphenPenalty ?? defaultBuildOptions.exHyphenPenalty,
    protrusion,
    protrusionFirst,
    expansion,
    tracking,
    boundaryShrink: spacing.boundaryShrink ?? defaultBuildOptions.boundaryShrink,
  };

  /**
   * Temporarily suppress text autosizing on every source run before the scan.
   * WebKit exposes an already-active autosizing multiplier through computed
   * font sizes; applying the permanent opt-out only when output was written
   * would therefore measure boosted text and render it unboosted. Do all
   * writes up front so the first computed-style read pays one batched style
   * recalculation, then restore every style attribute byte-for-byte before
   * measurement or user code can observe the temporary declarations.
   */
  const disableTextAutosizingForScan = (): (() => void) => {
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
  };

  /** Phase 1: normalized computed-style and DOM reads; no font measurement. */
  const scanned = new Map<HTMLElement, ParagraphScan>();
  const pendingSkips: Array<{ p: HTMLElement; reason: string }> = [];
  const scanParagraph = (p: HTMLElement): boolean => {
    if (states.get(p)?.enhanced) return true; // idempotent (possibly foreign)
    if (bailed.has(p)) return false;
    if (scanned.has(p)) return true;
    // Fail-safe: this library's contract is "enhance or leave native" —
    // an unexpected exception on one paragraph (a bug, hostile content)
    // must downgrade THAT paragraph to native rendering, never abort the
    // controller or poison its siblings.
    let scan: ParagraphScan | string;
    try {
      scan = readParagraph(p);
      if (typeof scan !== "string") {
        const bad = scan.specs.find((sp) => !supportsSpec(sp));
        if (bad !== undefined) {
          scan =
            bad.stretch !== "100%" && bad.stretch !== "normal"
              ? `author font-stretch: ${bad.stretch} on a run`
              : "font-variation-settings on a run";
        }
      }
    } catch (error) {
      scan = `threw while scanning: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (typeof scan === "string") {
      bailed.add(p);
      // The batch's temporary autosizing declarations are still present;
      // notify user code only after the finally block has restored them.
      pendingSkips.push({ p, reason: scan });
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

  /** Phase 2: measurement + item building, against the fonts currently
   * rendering (still-loading faces measure as their fallbacks and
   * converge later). */
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
    } catch (error) {
      // Same fail-safe as the scan: this paragraph stays native.
      bailed.add(p);
      emitSkip(p, `threw while measuring: ${error instanceof Error ? error.message : String(error)}`);
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
    } catch (error) {
      restore(p);
      bailed.add(p);
      emitSkip(p, `threw while rendering: ${error instanceof Error ? error.message : String(error)}`);
      return null;
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
      disableTextAutosizing(p);
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

  /** One entry per ctx font the content needs. `sample` holds every
   * distinct code point set in that font — faces are matched by
   * unicode-range against concrete text, so both the load() await and the
   * change probe must carry the scripts the content really uses
   * (document.fonts.load() defaults to U+0020; a fixed Latin sentinel is
   * blind to a Greek/CJK/symbol subset face). `kernSample` is a slice of
   * RAW run text: real letter sequences, so a face that differs from its
   * fallback only in kerning/shaping of adjacent pairs — metric-clone
   * families, size-adjust-tuned fallbacks — still moves a probe even when
   * per-glyph advances match. Baselines are the advances as of the last
   * commit/re-measure. */
  interface FontProbe {
    font: string;
    sample: string;
    kernSample: string;
    baseline: number;
    kernBaseline: number;
  }
  let fontProbes: FontProbe[] = [];
  /** True once the needed faces settled (loaded or failed) and the layout
   * was reconciled with them — the module-level measure caches then hold
   * settled-font metrics that a future controller may safely reuse. */
  let fontsConverged = false;

  const reprobeBaselines = (): void => {
    for (const f of fontProbes) {
      f.baseline = probeAdvance(f.font, f.sample);
      f.kernBaseline = probeAdvance(f.font, f.kernSample);
    }
  };
  const probesChanged = (): boolean =>
    fontProbes.some(
      (f) =>
        Math.abs(probeAdvance(f.font, f.sample) - f.baseline) > 0.01 ||
        Math.abs(probeAdvance(f.font, f.kernSample) - f.kernBaseline) > 0.01,
    );

  const remeasureAll = (): void => {
    if (destroyed) return;
    clearMeasureCache();
    clearCalibrationCache();
    reprobeBaselines();
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
  /** Late font loads only matter if they change what canvas measures: a
   * loadingdone fired moments after a commit that already measured those
   * faces (the async path's own loads, a page-driven re-justify) would
   * otherwise rewrite every paragraph for nothing. Probe advances are the
   * arbiter — the same net that catches engines whose check() reports a
   * still-loading face as available (WebKit with a loaded fallback in the
   * font string; it also fires no loadingdone for CSS-initiated loads). */
  const onFontsLoaded = (): void => {
    if (probesChanged()) remeasureAll();
  };

  const attachObservers = (): void => {
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
  const restoreScanStyles = disableTextAutosizingForScan();
  let scannable: HTMLElement[];
  try {
    scannable = paragraphs.filter(scanParagraph);
  } finally {
    restoreScanStyles();
  }
  for (const { p, reason } of pendingSkips) emitSkip(p, reason);
  // Per-font samples: every DISTINCT code point the content sets in that
  // font, spaces included (they size the glue), plus a raw-text kerning
  // slice. No injected seed — foreign-script filler would force unrelated
  // subset faces to download — and no cap: discarding later code points
  // would blind both the load() await and the change probe to exactly the
  // scripts it dropped (CJK documents, aggressively partitioned
  // unicode-range families). Distinctness bounds the sample; probeAdvance
  // measures in chunks, so cost stays flat even for ideographic content.
  const KERN_SAMPLE_MAX = 256;
  const fontSample = new Map<string, { chars: Set<string>; kern: string }>();
  for (const p of scannable) {
    const scan = scanned.get(p);
    if (scan === undefined) continue;
    for (const spec of scan.specs) {
      const font = ctxFontOf(spec);
      if (!fontSample.has(font)) fontSample.set(font, { chars: new Set(), kern: "" });
    }
    for (const run of scan.runs) {
      const s = fontSample.get(ctxFontOf(scan.specs[run.spec]!))!;
      for (const ch of run.text) s.chars.add(ch);
      if (s.kern.length < KERN_SAMPLE_MAX) {
        s.kern += run.text.slice(0, KERN_SAMPLE_MAX - s.kern.length);
      }
      // Hyphenatable content renders a "-" the runs may not contain (the
      // break glyph is measured per spec and painted via ::after) — a
      // face serving U+002D must be awaited and watched too.
      if (hyphenate !== undefined || run.text.includes("\u00AD")) s.chars.add("-");
    }
  }
  // A font no run draws from (a base spec whose text all sits in inline
  // children) still sizes the paragraph's word spaces — its space glyph
  // is the one piece of it the layout consumes.
  fontProbes = [...fontSample].map(([font, s]) => ({
    font,
    sample: s.chars.size === 0 ? " " : [...s.chars].join(""),
    kernSample: s.kern,
    baseline: 0,
    kernBaseline: 0,
  }));

  let ready: Promise<void>;
  try {
    commit(scannable);
    reprobeBaselines();
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
    ready = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  // Fire-and-forget callers must not trigger unhandled-rejection noise;
  // callers who await `ready` still observe failures.
  ready.catch(() => {});

  return {
    ready,
    paragraphs,
    refresh: remeasureAll,
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
      }
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
  restoreStyleAttribute(p, state.originalStyleAttr);
  p.removeAttribute("data-justif");
  states.delete(p);
}
