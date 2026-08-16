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
import { buildItems } from "./core/items.js";
import {
  composeProtrusion,
  type HangingCharacters,
  hangingCharacters,
  type HangingPunctuationMode,
  latinProtrusion,
  normalizeHangingPunctuation,
} from "./core/protrusion.js";
import {
  type BreakOptions,
  type BuildOptions,
  defaultBreakOptions,
  defaultBuildOptions,
  type ExpansionOptions,
  ItemType,
  type Line,
  type ProtrusionTable,
  type RunMetrics,
  type TrackingOptions,
} from "./core/types.js";
import { describeError } from "./core/errors.js";
import { clearCalibrationCache } from "./dom/calibrate.js";
import { clearOpticalCache } from "./dom/optical.js";
import {
  clearMeasureCache,
  collectDomMeasurements,
  ctxFontOf,
  type FontSpec,
  probeAdvance,
  requiresDomMeasurement,
  supportsSpec,
} from "./dom/measure.js";
import { createCorrectionPass, type PatchEntry, type PatchOutcome } from "./dom/corrections.js";
import { createDrain, createDrainQueues } from "./dom/drain.js";
import { createWidthObserver, type WidthObserver } from "./dom/observe.js";
import { createPatchPass } from "./dom/patch.js";
import {
  authorRewroteStyleAttribute,
  NO_TRANSITION_CLASS,
  type ParaPart,
  type ParaState,
  restoreManagedOutput,
  restoreStyleAttribute,
  states,
  unmaskAuthorStyle,
} from "./dom/paragraph-state.js";

import {
  beginScanBatch,
  contentWidthOf,
  endScanBatch,
  floatIntrusionOf,
  floatInlineSizeOf,
  type HardBreak,
  type ParagraphScan,
  paragraphStyleKey,
  readParagraph,
  type ScanBatch,
} from "./dom/read.js";
import {
  buildRunMetrics,
  clearComposedProtrusionCache,
  measureFor,
  runTexts,
} from "./dom/segments.js";
import { disableTextAutosizing, writeParagraph } from "./dom/write.js";

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
   * Keep paragraph endings and lines terminated by `<br>` at least this
   * fraction of the measure wide (0.33 ≈ Bringhurst's "at least a third").
   * Two mechanisms compose.
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
   * that can afford it sets as a perfect rectangle, including a one-line
   * paragraph. Values below `1` apply only to multi-line paragraphs: a
   * naturally one-line element stays in native layout because it has no
   * short ending to repair. Defaults to `0.33` (Bringhurst); pass `0` to
   * disable.
   */
  lastLineMinWidth?: number;
  /**
   * Character protrusion model. `true` (the default) measures each font's
   * glyph-specific optical alignment by rasterizing its glyphs. `false`
   * disables character protrusion — and only that: `hangingPunctuation` is an
   * independent setting, so `false` with hanging left on sets ordinary glyphs
   * exactly flush while the eligible marks still hang.
   *
   * An object selects the fixed table-backed model and supplies
   * per-character overrides, in thousandths of the character's own advance.
   * Overrides are merged over the generic Latin table and any matching
   * hand-tuned per-font table. Values cap at 1000 — a whole advance is as far
   * out as a glyph goes — while negatives are honoured and pull it inward. A
   * value here sets how far a character protrudes and never makes it hang;
   * membership is `hangingPunctuation`'s to decide.
   *
   * Built-in tables (the generic Latin list plus microtype's per-font configs)
   * remain as the FALLBACK, used per font wherever the measurement cannot run
   * — a canvas that will not rasterize or read back, or one the browser will
   * not shape a run's font-variant in — and for the characters the raster pass
   * has no candidate for, such as the Arabic and Hebrew stops. They are not
   * separately selected when `true`; passing an object (including `{}`)
   * bypasses measurement and uses them directly.
   */
  protrusion?: boolean | ProtrusionTable;
  /**
   * Full-hanging policy, independent of `protrusion`. `"line-end-only"` (the
   * default) fully hangs eligible punctuation at line ends while line starts
   * retain optical alignment. `"first-line-and-line-ends"` adds the CSS `first`
   * model on top of that: the paragraph's opening quote hangs fully and later
   * line starts set those marks flush. `"all-line-edges"` fully hangs at every
   * line edge; `"none"` applies only the selected protrusion model.
   *
   * Hanging is composed as a protrusion overlay, but the two settings switch
   * separately: with `protrusion: false` the overlay composes over an empty
   * base, and with `"none"` the protrusion model applies alone.
   *
   * An object additionally chooses WHICH characters are marginal — see
   * `HangingPunctuationOptions`.
   *
   * Compatibility: `true` selects the default; `false` selects `"none"`;
   * `"first-line"` aliases `"first-line-and-line-ends"`; and `"all-lines"`
   * aliases `"all-line-edges"`.
   */
  hangingPunctuation?: true | HangingPunctuationMode | HangingPunctuationOptions;
  /** Glyph expansion limits via the wdth axis; false disables. Fields left out
   * take their default, like `spacing` and `tracking`. */
  expansion?: Partial<ExpansionOptions> | false;
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
  spacing?: Partial<{
    stretch: number;
    shrink: number;
    pull: number;
    boundaryShrink: number;
  }>;
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
   * "desired spacing" value. Lines terminated by `<br>` contribute their
   * justified body lines to the average but do not receive last-line fitting
   * themselves. 0 (default) = off.
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
   * Called after a paragraph's rendered layout changes — initial
   * enhancement, resize re-layout, promotion from a native one-line state,
   * restoration when it fits on one line again, refresh, and re-measures
   * triggered by fonts finishing to load. Use it to keep overlays or
   * annotations positioned over the text in sync. NOT fired for the deferred
   * wrap-guarantee corrections: those reconcile sub-pixel painted-edge drift
   * with small spacing changes but do not alter chosen breaks or paragraph
   * structure.
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

/**
 * Hanging punctuation as its two independent parts: which characters are
 * marginal, and where that classification applies.
 *
 * Membership carries no depth. A character is either outside the measure or
 * it is not — how far a mark sits from the margin when it is NOT hung is the
 * `protrusion` model's business, and writing a depth here would merge two
 * features that answer different questions.
 */
export interface HangingPunctuationOptions {
  /** Which line edges the classification applies to, and on which lines.
   * Defaults to the same policy the string form selects. */
  edges?: HangingPunctuationMode;
  /**
   * Which characters are marginal. Each side REPLACES the built-in set for
   * that side; a side left out keeps its default, so naming one edge never
   * silently empties the other. Compose from the exported `hangingCharacters`
   * to extend rather than replace:
   *
   * ```js
   * characters: { start: hangingCharacters.start + "([{" }   // + CSS brackets
   * characters: { end: "" }                                  // starts only
   * ```
   *
   * Replacing `end` wholesale drops the CJK stops that make burasage work, so
   * mixed Japanese and Latin text wants `hangingCharacters.end + "…"` rather
   * than a bare list. Nothing is validated: a letter here will hang.
   */
  characters?: { start?: string; end?: string };
}

/**
 * The layout settings a live reconfiguration can replace. Everything else a
 * controller was built with — the hyphenator, callbacks, breaker penalties,
 * clipboard cleanup, resize observation — is fixed for its lifetime.
 */
export type LayoutOptions = Pick<
  JustifyOptions,
  | "hangingPunctuation"
  | "protrusion"
  | "expansion"
  | "tracking"
  | "spacing"
  | "lastLineMinWidth"
  | "lastLineFit"
>;

/** Runtime counterpart of `LayoutOptions`, for stripping those keys. */
const LAYOUT_OPTION_KEYS = [
  "hangingPunctuation",
  "protrusion",
  "expansion",
  "tracking",
  "spacing",
  "lastLineMinWidth",
  "lastLineFit",
] as const satisfies ReadonlyArray<keyof LayoutOptions>;

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

const DEFAULT_EXPANSION: ExpansionOptions = { max: 0.02, shrink: 0.02, step: 0.005 };
const DEFAULT_SPACING = { stretch: 0.5, shrink: 1 / 3, pull: 0.7, boundaryShrink: 0 };
/** Bringhurst's tolerance: letterspacing in justified text may vary ±3%. */
const DEFAULT_TRACKING: TrackingOptions = { max: 0.03, shrink: 0.03 };
/** Bringhurst's "at least a third", as the decimal the public API takes. The
 * CORE default stays 0 (classic TeX), like tracking's core-off/public-on split. */
const DEFAULT_LAST_LINE_MIN_WIDTH = 0.33;
const DEFAULT_LAST_LINE_FIT = 0;
const DEFAULT_HANGING_PUNCTUATION = "line-end-only" as const;

/**
 * What each `LayoutOptions` field resolves to when omitted. Exported so callers
 * can tell "the author asked for the default" apart from "the author asked for
 * something that happens to equal it" — the drop-in needs exactly that to avoid
 * splitting paragraphs into separate controllers over identical settings — and
 * so configuration UI has one source for its initial values.
 *
 * Declared after the constants it reads: a `const` is not initialized until its
 * own statement runs, so hoisting this above them would throw at module load.
 */
export const layoutDefaults = Object.freeze({
  hangingPunctuation: DEFAULT_HANGING_PUNCTUATION,
  protrusion: true,
  expansion: DEFAULT_EXPANSION,
  tracking: DEFAULT_TRACKING,
  spacing: DEFAULT_SPACING,
  lastLineMinWidth: DEFAULT_LAST_LINE_MIN_WIDTH,
  lastLineFit: DEFAULT_LAST_LINE_FIT,
  // `satisfies`, not an annotation: this keeps the exact shapes, so
  // `layoutDefaults.expansion.max` reads as a number instead of forcing callers
  // to narrow away the `false` and `true` the option types also permit.
}) satisfies Required<LayoutOptions>;
/** Below this residual measure, a native float must push its line box below
 * itself. The breaker has no equivalent vertical escape, so keep the whole
 * paragraph native until a resize restores usable space beside the float. */
const MIN_FLOAT_LINE_WIDTH_PX = 1;

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

/** Defaults overlaid with the defined subset of same-named option keys. */
function withOverrides<T extends object>(defaults: T, overrides: Partial<T>): T {
  const merged = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const value = overrides[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/** Everything the option object decides before any paragraph is touched.
 * Pure: computed once per controller, then shared by every phase. */
interface ResolvedOptions {
  breakOpts: BreakOptions;
  buildOpts: BuildOptions;
  /** The clamped public value, feeding breaker pricing AND the layout floor
   * — the two must see the same number. */
  lastLineMinWidth: number;
  expansion: ExpansionOptions | false;
  spacing: Required<NonNullable<JustifyOptions["spacing"]>>;
  /** Per-run protrusion resolution context for `buildRunMetrics`. */
  protrusionCtx: {
    /** Anything to compose at all: the model is on, or marks hang, or both. */
    enabled: boolean;
    /** The protrusion model contributes a base table (`protrusion !== false`).
     * With it off, hang overlays compose over an empty base. */
    model: boolean;
    measured: boolean;
    user: ProtrusionTable | null;
    hang: HangingPunctuationMode;
    characters: HangingCharacters;
  };
  /** Memoized word splitter, or undefined when hyphenation is off. */
  hyphenate: ((word: string) => readonly string[]) | undefined;
}

function resolveOptions(options: JustifyOptions): ResolvedOptions {
  const breakOpts = withOverrides(defaultBreakOptions, options);
  // The public default is Bringhurst's third (the CORE default stays 0 =
  // classic TeX, like tracking's core-off/public-on split).
  const lastLineMinWidth = Math.max(
    0,
    Math.min(1, options.lastLineMinWidth ?? DEFAULT_LAST_LINE_MIN_WIDTH),
  );
  breakOpts.lastLineMinWidth = lastLineMinWidth;
  /** User's explicit per-char overrides, kept separate so they also win
   * over any per-font config matched in buildRunMetrics. */
  // Copied, not aliased: every other option is snapshotted at justify() time,
  // and the per-family composition is now memoized, so a caller mutating its
  // own table afterwards would otherwise see a partial, inconsistent effect.
  const protrusionUser: ProtrusionTable | null =
    typeof options.protrusion === "object"
      ? Object.fromEntries(
          Object.entries(options.protrusion).map(([character, codes]) => [
            character,
            { ...codes },
          ]),
        )
      : null;
  const requestedHang = options.hangingPunctuation;
  const isHangObject = typeof requestedHang === "object" && requestedHang !== null;
  const hangObject = isHangObject ? requestedHang : null;
  const requestedEdges = isHangObject ? requestedHang.edges : requestedHang;
  const hangMode: HangingPunctuationMode =
    requestedEdges === undefined || requestedEdges === true
      ? DEFAULT_HANGING_PUNCTUATION
      : normalizeHangingPunctuation(requestedEdges);
  /** Each side REPLACES the built-in set; a side left out keeps its default,
   * so naming one edge never silently empties the other. */
  const hangChars: HangingCharacters =
    hangObject?.characters === undefined
      ? hangingCharacters
      : {
          start: hangObject.characters.start ?? hangingCharacters.start,
          end: hangObject.characters.end ?? hangingCharacters.end,
        };
  // The protrusion MODEL and full hanging are independent settings, even
  // though hanging is implemented as a protrusion overlay: `protrusion: false`
  // removes the model's base table, and the hang overlay then composes over an
  // empty one. That state — ordinary glyphs exactly flush, eligible marks
  // hanging — is a real typographic choice, and the only way to reject a
  // font's measured optical alignment without also losing hanging quotes.
  const protrusionModel = options.protrusion !== false;
  // `hangMode` is already normalized: the `false` spelling became "none" above.
  const hanging = hangMode !== "none";
  const measuredProtrusion =
    options.protrusion === undefined || options.protrusion === true;
  const composed =
    !protrusionModel && !hanging
      ? null
      : composeProtrusion(
          protrusionModel ? latinProtrusion : {},
          protrusionUser,
          hangMode,
          hangChars,
        );
  const protrusion: ProtrusionTable | false = composed === null ? false : composed.rest;
  const protrusionFirst =
    composed !== null && composed.first !== composed.rest ? composed.first : undefined;
  /** The model without the hang overlay: what a glyph left at the line's start
   * by a fully hung mark is worth. */
  const protrusionCredit = composed === null ? undefined : composed.credit;
  const expansion =
    options.expansion === false
      ? false
      : withOverrides(DEFAULT_EXPANSION, options.expansion ?? {});
  // withOverrides, never a spread: object spread copies an explicitly present
  // `boundaryShrink: undefined` — the shape a wrapper building options from
  // its own optional config emits — over the default, and a family-boundary
  // glue shrink of `NaN` then silently changes chosen breaks.
  const spacing = withOverrides(DEFAULT_SPACING, options.spacing ?? {});
  const tracking: TrackingOptions | false =
    options.tracking === false
      ? false
      : options.tracking === true || options.tracking === undefined
        ? DEFAULT_TRACKING
        : withOverrides(DEFAULT_TRACKING, options.tracking);

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

  return {
    breakOpts,
    // NOTE: JustifyOptions.protrusion/tracking are wider than BuildOptions',
    // so withOverrides(defaultBuildOptions, options) does NOT typecheck —
    // keep these explicit.
    buildOpts: {
      ...defaultBuildOptions,
      hyphenate,
      lastLineFit: Math.max(0, Math.min(1, options.lastLineFit ?? DEFAULT_LAST_LINE_FIT)),
      lastLineMinWidth,
      hyphenPenalty: options.hyphenPenalty ?? defaultBuildOptions.hyphenPenalty,
      exHyphenPenalty: options.exHyphenPenalty ?? defaultBuildOptions.exHyphenPenalty,
      protrusion,
      protrusionFirst,
      protrusionCredit,
      expansion,
      tracking,
      boundaryShrink: spacing.boundaryShrink,
    },
    lastLineMinWidth,
    expansion,
    spacing,
    protrusionCtx: {
      enabled: composed !== null,
      model: protrusionModel,
      measured: measuredProtrusion,
      user: protrusionUser,
      hang: hangMode,
      characters: hangChars,
    },
    hyphenate,
  };
}


/**
 * Temporarily suppress text autosizing on every source run before the scan,
 * returning the undo. WebKit exposes an already-active autosizing multiplier
 * through computed font sizes; applying the permanent opt-out only when output
 * was written would therefore measure boosted text and render it unboosted. Do
 * all writes up front so the first computed-style read pays one batched style
 * recalculation, then restore every style attribute byte-for-byte before
 * measurement or user code can observe the temporary declarations.
 */
function suppressAutosizingForScan(paragraphs: readonly HTMLElement[]): () => void {
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

/** Block-level tags whose boundaries become blank lines in a plain-text copy. */
const BLOCKY_TAGS =
  /^(?:P|DIV|LI|UL|OL|BLOCKQUOTE|H[1-6]|PRE|TABLE|TR|SECTION|ARTICLE|HEADER|FOOTER|FIGURE|FIGCAPTION)$/;

/**
 * text/plain for a copied fragment. Taken from the cloned nodes rather than
 * Selection.toString(): Firefox's toString() folds NBSP to a plain space,
 * which would drop the very author NBSPs the cleanup guard exists to
 * preserve.
 */
function plainTextOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  let out = "";
  for (let c = node.firstChild; c !== null; c = c.nextSibling) out += plainTextOf(c);
  if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = (node as Element).tagName;
    if (tag === "BR") out += "\n";
    else if (BLOCKY_TAGS.test(tag)) out += "\n\n";
  }
  return out;
}

/** Text nodes that contribute at least one character to a live selection
 * range, in document order. Empty endpoint slices are deliberately omitted:
 * the first non-empty node is the one that determines whether a copied
 * fragment starts with a layout-only joint, even when the range starts at the
 * end of the preceding text node. */
function nonEmptyTextNodesInRange(range: Range): Text[] {
  const root = range.commonAncestorContainer;
  const out: Text[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node as Text;
    if (!range.intersectsNode(text)) return;
    const start = text === range.startContainer ? range.startOffset : 0;
    const end = text === range.endContainer ? range.endOffset : text.data.length;
    if (start < end) out.push(text);
  };
  if (root.nodeType === Node.TEXT_NODE) visit(root);
  else {
    const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      visit(node);
    }
  }
  return out;
}

/** The only ordinary whitespace text node the enhanced DOM emits outside a
 * `.justif-seg`: the literal space that carries a real soft-wrap joint.
 * Author whitespace is inside a segment, so this remains safe even when a
 * selection crosses non-enhanced content before or after a managed paragraph.
 */
function isJustifBoundaryJoint(node: Text): boolean {
  const parent = node.parentElement;
  return (
    node.data === " " &&
    parent !== null &&
    parent.closest(".justif-seg") === null &&
    parent.closest("[data-justif]") !== null
  );
}

/** Clone-side counterpart to isJustifBoundaryJoint(). The cloned fragment no
 * longer has the enhanced paragraph ancestor, so only its segment boundary
 * shape can be checked there; the live-node check already established the
 * paragraph provenance. */
function isClonedBoundaryJoint(node: Text): boolean {
  const parent = node.parentElement;
  return node.data === " " && (parent === null || parent.closest(".justif-seg") === null);
}

/** Remove leading/trailing layout-only joints from one copied range. The live
 * range identifies the first and last included text nodes before cloning;
 * cloneContents() may add empty endpoint text clones, so the corresponding
 * clone is found by its first/last NON-EMPTY text position instead. */
function removeCopiedBoundaryJoints(range: Range, fragment: DocumentFragment): void {
  const included = nonEmptyTextNodesInRange(range);
  if (included.length === 0) return;
  const trimLeading = isJustifBoundaryJoint(included[0]!);
  const trimTrailing = isJustifBoundaryJoint(included[included.length - 1]!);
  if (!trimLeading && !trimTrailing) return;

  const cloned = nonEmptyTextNodesInRange(
    // A detached fragment is not a live selection range, so collect its text
    // nodes directly rather than reusing the range helper above.
    (() => {
      const cloneRange = fragment.ownerDocument!.createRange();
      cloneRange.selectNodeContents(fragment);
      return cloneRange;
    })(),
  );
  const remove = new Set<Text>();
  const first = cloned[0];
  const last = cloned[cloned.length - 1];
  if (trimLeading && first !== undefined && isClonedBoundaryJoint(first)) {
    remove.add(first);
  }
  if (trimTrailing && last !== undefined && isClonedBoundaryJoint(last)) {
    remove.add(last);
  }
  for (const node of remove) node.remove();
}

/** One entry per ctx font the content needs. `sample` holds every distinct
 * code point set in that font — faces are matched by unicode-range against
 * concrete text, so both the load() await and the change probe must carry the
 * scripts the content really uses (document.fonts.load() defaults to U+0020; a
 * fixed Latin sentinel is blind to a Greek/CJK/symbol subset face).
 * `kernSample` is a slice of RAW run text: real letter sequences, so a face
 * that differs from its fallback only in kerning/shaping of adjacent pairs —
 * metric-clone families, size-adjust-tuned fallbacks — still moves a probe
 * even when per-glyph advances match. Baselines are the advances as of the
 * last commit/re-measure. */
interface FontProbe {
  font: string;
  sample: string;
  kernSample: string;
  baseline: number;
  kernBaseline: number;
}

const KERN_SAMPLE_MAX = 256;

/**
 * Per-font samples: every DISTINCT code point the content sets in that font,
 * spaces included (they size the glue), plus a raw-text kerning slice. No
 * injected seed — foreign-script filler would force unrelated subset faces to
 * download — and no cap on the code points: discarding later ones would blind
 * both the load() await and the change probe to exactly the scripts it dropped
 * (CJK documents, aggressively partitioned unicode-range families).
 * Distinctness bounds the sample; probeAdvance measures in chunks, so cost
 * stays flat even for ideographic content.
 */
function collectFontProbes(
  scans: readonly ParagraphScan[],
  hyphenating: boolean,
): FontProbe[] {
  const fontSample = new Map<
    string,
    { chars: Set<string>; ascii: Uint8Array; kern: string }
  >();
  for (const scan of scans) {
    for (const spec of scan.specs) {
      const font = ctxFontOf(spec);
      if (!fontSample.has(font)) {
        fontSample.set(font, { chars: new Set(), ascii: new Uint8Array(128), kern: "" });
      }
    }
    for (const run of scan.runs) {
      const s = fontSample.get(ctxFontOf(scan.specs[run.spec]!))!;
      // ASCII — nearly every code unit of a Latin document — is screened by a
      // flat table first: this walk covers every character of every run, and
      // hashing the same 70-odd strings into a Set was most of its cost.
      const text = run.text;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 128) {
          if (s.ascii[code] === 1) continue;
          s.ascii[code] = 1;
          s.chars.add(text[i]!);
        } else {
          // Non-ASCII: take the whole code point, so a surrogate pair enters
          // the set as one character exactly as the string iterator gave it.
          const cp = String.fromCodePoint(text.codePointAt(i)!);
          s.chars.add(cp);
          i += cp.length - 1;
        }
      }
      if (s.kern.length < KERN_SAMPLE_MAX) {
        s.kern += run.text.slice(0, KERN_SAMPLE_MAX - s.kern.length);
      }
      // Hyphenatable content renders a "-" the runs may not contain (the
      // break glyph is measured per spec and painted via ::after) — a face
      // serving U+002D must be awaited and watched too.
      if (hyphenating || run.text.includes("\u00AD")) s.chars.add("-");
    }
  }
  // A font no run draws from (a base spec whose text all sits in inline
  // children) still sizes the paragraph's word spaces — its space glyph is
  // the one piece of it the layout consumes.
  return [...fontSample].map(([font, s]) => ({
    font,
    sample: s.chars.size === 0 ? " " : [...s.chars].join(""),
    kernSample: s.kern,
    baseline: 0,
    kernBaseline: 0,
  }));
}

/**
 * Clipboard cleanup is a DOCUMENT-level concern, so all controllers share one
 * listener: registering per controller meant a page that re-justifies without
 * destroying accumulated handlers, each one cloning the whole selection on
 * every copy, and whichever ran last decided the NBSP question for everyone —
 * so an author NBSP in one controller's paragraph could be normalized away by
 * another's handler. One listener, unioning every participant, removes both.
 */
interface ClipboardParticipant {
  /** Enhanced paragraphs this controller owns, with their scans. */
  enhanced(): Iterable<readonly [HTMLElement, ParagraphScan]>;
}

const clipboardParticipants = new Set<ClipboardParticipant>();

const onDocumentCopy = (e: ClipboardEvent): void => {
  if (e.clipboardData === null) return;
  const sel = document.getSelection();
  if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return;
  let touches = false;
  let authorNbsp = false;
  for (const participant of clipboardParticipants) {
    for (const [p, scan] of participant.enhanced()) {
      if (!sel.containsNode(p, true)) continue;
      touches = true;
      if (scan.authorHasNbsp) authorNbsp = true;
    }
  }
  if (!touches) return;

  const clean = (v: string): string => {
    const noWj = v.replace(/\u2060/g, "");
    return authorNbsp ? noWj : noWj.replace(/\u00A0/g, " ");
  };
  const html = document.createElement("div");
  let plain = "";
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    const frag = range.cloneContents();
    removeCopiedBoundaryJoints(range, frag);
    const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      n.nodeValue = clean(n.nodeValue ?? "");
    }
    plain += plainTextOf(frag);
    html.append(frag);
  }
  e.clipboardData.setData("text/plain", plain.replace(/\n+$/, ""));
  e.clipboardData.setData("text/html", html.innerHTML);
  e.preventDefault();
};

/** Join the shared copy handler; returns the leave function. The document
 * listener exists only while at least one controller wants cleanup. */
function joinClipboardCleanup(participant: ClipboardParticipant): () => void {
  if (clipboardParticipants.size === 0) {
    document.addEventListener("copy", onDocumentCopy);
  }
  clipboardParticipants.add(participant);
  return () => {
    if (!clipboardParticipants.delete(participant)) return;
    if (clipboardParticipants.size === 0) {
      document.removeEventListener("copy", onDocumentCopy);
    }
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
  /** Per-controller, so a destroy() + justify() retry gets a fresh chance
   * after content that previously caused a bail has been fixed. */
  const bailed = new WeakSet<HTMLElement>();
  /** Float decisions depend on descendant CSS, which the paragraph-only
   * style key cannot see. An explicit rescan always re-reads these targets. */
  const floatDecisions = new WeakSet<HTMLElement>();
  /**
   * The author styling behind this controller's current decision about each
   * paragraph — the scan it kept, or the styling it declined. `rescan()` compares
   * against it to answer "could re-reading reach a different answer?", so a
   * declined paragraph is retried exactly when its styling changes, and an
   * enhanced one is left alone until its own.
   */
  const decidedStyleKey = new WeakMap<HTMLElement, string>();
  /** Membership, for the `rescan(targets)` filter: the drop-in hands every
   * controller the same set of changed paragraphs, so this is asked once per
   * target per controller and a linear scan of `paragraphs` showed up as real
   * time on long pages. */
  const owned = new Set(paragraphs);
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
  const carriedStyleAttr = new WeakMap<HTMLElement, string | null>();
  let destroyed = false;
  let rebindFloatObservation: (p: HTMLElement, state?: ParaState) => void = () => {};

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
  const scanned = new Map<HTMLElement, ParagraphScan>();
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
   * The paragraph's styling as it computes right now.
   *
   * (One asymmetry worth knowing, on engines that autosize text: the scan reads
   * with autosizing suppressed and an enhanced paragraph keeps that suppression,
   * but a managed NATIVE one does not, so its `font-size` can read back
   * differently there. The cost is a redundant rescan, not a wrong one.)
   */
  function styleKeyNow(p: HTMLElement): string {
    const style = getComputedStyle(p);
    return `${paragraphStyleKey(style)} ${style.textIndent}`;
  }

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
   * no echo of it (`ECHO_PROPERTIES` in auto.ts covers what little slips past).
   */
  const suppressTransitions = (targets: readonly HTMLElement[]): (() => void) => {
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
  };


  const authorStyleKeys = (targets: readonly HTMLElement[]): Map<HTMLElement, string> => {
    const undo: Array<() => void> = [];
    for (const p of targets) {
      const lifting = (ownedState(p)?.masked ?? []).filter(
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

  const buildParts = (
    scan: ParagraphScan,
    runsMetrics: RunMetrics[],
    specByKey: Map<string, FontSpec>,
  ): ParaPart[] => {
    // RTL paragraphs never letterspace: tracking inside Arabic cursive
    // joining is typographically wrong, and engines disagree on whether
    // joined pairs receive letter-spacing at all — the width model would
    // drift by pixels per word. (Hyphenation is likewise suppressed, via
    // noHyphens in buildRunMetrics.)
    const opts = scan.direction === "rtl" ? { ...buildOpts, tracking: false as const } : buildOpts;
    const texts = runTexts(scan);
    const measure = measureFor(specByKey);
    const parts: ParaPart[] = [];
    let startRun = 0;
    const append = (endRun: number, breakAfter: HardBreak | null): void => {
      const para = buildItems(texts.slice(startRun, endRun), runsMetrics, opts, measure);
      // First-line protrusion is a property of the CSS paragraph, not of
      // each independently optimized hard-break segment. A leading <br>
      // consumes that first formatted line too, so every later segment
      // uses ordinary line-start protrusion from its first box onward.
      if (parts.length > 0) {
        for (const item of para.items) {
          if (item.type === ItemType.Box) item.lpFirst = item.lp;
        }
      }
      parts.push({ para, breakAfter });
      startRun = endRun;
    };
    for (const hardBreak of scan.hardBreaks) {
      append(hardBreak.afterRun, hardBreak);
    }
    append(texts.length, null);
    return parts;
  };

  /**
   * Pre-shape every string that needs real DOM measurement, in ONE hidden
   * batch: variant-bearing runs (small-caps and friends) can't be measured on
   * canvas, and discovering them one paragraph at a time would pay a hidden
   * layout each. The build results are thrown away — the pass that follows
   * reads the exact cached widths. Throws are swallowed: the real pass owns
   * the per-paragraph fail-safe and will bail that paragraph alone.
   */
  const warmDomWidths = (
    entries: readonly { scan: ParagraphScan; specByKey: Map<string, FontSpec> }[],
  ): void => {
    collectDomMeasurements(() => {
      for (const { scan, specByKey } of entries) {
        if (!scan.specs.some(requiresDomMeasurement)) continue;
        try {
          buildParts(scan, buildRunMetrics(scan, expansion, spacing, protrusionCtx), specByKey);
        } catch {
          /* deliberately ignored; see above */
        }
      }
    });
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
      // Keyed on the MEASUREMENT key, so specs that differ only in a
      // key-excluded field (`hyphens`) collapse to one entry — deliberately:
      // they measure identically. See FontSpec.key.
      const specByKey = new Map<string, FontSpec>();
      for (const spec of scan.specs) specByKey.set(spec.key, spec);
      const runsMetrics = buildRunMetrics(scan, expansion, spacing, protrusionCtx);
      states.set(p, {
        owner,
        original: document.createDocumentFragment(),
        originalStyleAttr: carriedStyleAttr.has(p)
          ? (carriedStyleAttr.get(p) ?? null)
          : p.getAttribute("style"),
        scan,
        runsMetrics,
        specByKey,
        parts: buildParts(scan, runsMetrics, specByKey),
        width: scan.contentWidth,
        lastPatch: "",
        enhanced: false,
        renderedFloat: null,
        nativeIndent: null,
        masked: [],
      });
    } catch (error) {
      // Same fail-safe as the scan: this paragraph stays native.
      bailed.add(p);
      emitSkip(p, `threw while measuring: ${describeError(error)}`);
      return false;
    }
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
      rebindFloatObservation(p, ownedState(p));
      return outcome;
    } catch (error) {
      const outcome = {
        changed: bailToNative(p, `threw while rendering: ${describeError(error)}`),
        pending: null,
      };
      rebindFloatObservation(p, ownedState(p));
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
    warmDomWidths(
      scannable.flatMap((p) => {
        const scan = scanned.get(p);
        return scan === undefined || !scan.specs.some(requiresDomMeasurement)
          ? []
          : [{ scan, specByKey: new Map(scan.specs.map((spec) => [spec.key, spec])) }];
      }),
    );
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

  const refreshFloatIntrusions = (): boolean => {
    let changed = false;
    for (const p of paragraphs) {
      const state = ownedState(p);
      if (state === undefined || state.scan.floatIntrusion === null) continue;
      if (state.scan.floatIntrusion.kind === "element") {
        if (refreshElementFloat(p, state, state.scan.floatIntrusion) === "changed") {
          changed = true;
        }
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
  const refreshNativeFloatIntrusions = (): boolean => {
    if (destroyed) return false;
    const candidates = paragraphs.flatMap((p) => {
      const state = ownedState(p);
      return state !== undefined && state.scan.floatIntrusion !== null ? [{ p, state }] : [];
    });
    let changed = false;
    for (const { p, state } of candidates) {
      queues.drop(p);
      if (restoreManagedOutput(p, state)) changed = true;
    }
    for (const { p, state } of candidates) {
      const next = floatIntrusionOf(
        p,
        state.scan.runs.map((run) => run.text).join(""),
        state.scan.floatIntrusion ?? undefined,
      );
      if (next === null) {
        states.delete(p);
        rebindFloatObservation(p);
        bailed.add(p);
        emitSkip(p, "could not remeasure paragraph float after font change");
        emitRelayout(p);
        continue;
      }
      if (!floatGeometryEquals(next, state.scan.floatIntrusion!)) changed = true;
      state.scan.floatIntrusion = next;
    }
    return changed;
  };

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
    if (!floatGeometryFresh) refreshFloatIntrusions();
    if (fontsStale) {
      clearMeasureCache();
      clearCalibrationCache();
      // Measured protrusion is derived from rasterized glyphs, so it goes stale
      // for exactly the same reason widths do — a table measured before the
      // webfont arrived describes the fallback's letterforms.
      clearOpticalCache();
      clearComposedProtrusionCache();
      reprobeBaselines();
    }
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
      state.runsMetrics = buildRunMetrics(state.scan, expansion, spacing, protrusionCtx);
      state.parts = buildParts(state.scan, state.runsMetrics, state.specByKey);
      state.width = width;
      state.lastPatch = "";
      const outcome = safePatch(p);
      if (outcome.pending !== null) batch.push({ p, pending: outcome.pending });
      if (outcome.changed) changed.add(p);
    }
    flushPatches(batch, changed);
    for (const p of changed) emitRelayout(p);
  };

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

  // The correction pass and its width negotiation live in ./dom/corrections.js;
  // `CorrectionHost` there is the whole of what they need from this controller.
  const {
    flushPatches,
    floatGeometryEquals,
    refreshElementFloat,
    rejectPatch,
    verifyElementFloats,
  } =
    createCorrectionPass({
      ownedState: (p) => ownedState(p),
      bailToNative: (p, reason) => bailToNative(p, reason),
      emitRelayout: (p) => emitRelayout(p),
      safePatch: (p) => safePatch(p),
      seedNearViewport: (batch) => drain.seedNearViewport(batch),
      restartPendingOrder: () => drain.restartPendingOrder(),
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
  let floatObserver: ResizeObserver | null = null;
  const observedFloat = new Map<HTMLElement, Element>();
  const floatParagraph = new WeakMap<Element, HTMLElement>();
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
    const metricsChanged = probesChanged();
    const floatChanged = metricsChanged
      ? refreshNativeFloatIntrusions()
      : refreshFloatIntrusions();
    if (metricsChanged || floatChanged) remeasureAll(true);
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
      if (typeof ResizeObserver !== "undefined") {
        floatObserver = new ResizeObserver((entries) => {
          let queued = false;
          for (const entry of entries) {
            const p = floatParagraph.get(entry.target);
            if (p === undefined || observedFloat.get(p) !== entry.target) continue;
            const state = ownedState(p);
            const intrusion = state?.scan.floatIntrusion;
            if (state === undefined || intrusion?.kind !== "element") {
              floatObserver?.unobserve(entry.target);
              observedFloat.delete(p);
              continue;
            }
            const verdict = refreshElementFloat(p, state, intrusion, entry.target);
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
              queues.drop(p);
              const changed = bailToNative(
                p,
                "could not remeasure leading floated element after resize",
              );
              rebindFloatObservation(p);
              if (changed) emitRelayout(p);
              continue;
            }
            if (verdict !== "changed") continue;
            queues.pendingFloatRelayout.add(p);
            queued = true;
          }
          if (queued) drain.restartPendingOrder();
        });
        rebindFloatObservation = (p, state = ownedState(p)) => {
          const prior = observedFloat.get(p);
          const intrusion = state?.scan.floatIntrusion;
          const next =
            intrusion?.kind === "element"
              ? (state?.renderedFloat ?? intrusion.source)
              : undefined;
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
      }
      observer = createWidthObserver(drain.onWidths);
      for (const p of paragraphs) {
        const state = ownedState(p);
        if (state !== undefined) {
          observer.observe(p);
          rebindFloatObservation(p, state);
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
    ready = Promise.reject(error instanceof Error ? error : new Error(describeError(error)));
  }
  // Fire-and-forget callers must not trigger unhandled-rejection noise;
  // callers who await `ready` still observe failures.
  ready.catch(() => {});

  /**
   * The re-read itself: compare, then re-adopt whatever now reads differently.
   * Called with transitions suppressed on `considered`.
   */
  const reread = (considered: readonly HTMLElement[]): readonly HTMLElement[] => {
    // Transitions come off only where this pass will actually write: the
    // paragraphs whose masked declarations have to be lifted for the comparison,
    // and then the ones being re-adopted. Suppressing on all of them would touch
    // the class attribute of every paragraph on the page for a check that in the
    // ordinary case changes nothing — visible to any MutationObserver the page
    // has of its own.
    const lifted = considered.filter((p) =>
      (ownedState(p)?.masked ?? []).some((mask) => mask.inKey),
    );
    const restoreLifted = suppressTransitions(lifted);
    let current: Map<HTMLElement, string>;
    try {
      current = authorStyleKeys(considered);
    } finally {
      restoreLifted();
    }
    const stale = considered.filter(
      (p) => floatDecisions.has(p) || decidedStyleKey.get(p) !== current.get(p),
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
      const state = ownedState(p);
      if (state !== undefined) {
        if (state.enhanced) wasEnhanced.add(p);
        // The scan has to read author CSS, so justif's own declarations come
        // off first — one property at a time, so that an inline edit the author
        // made since is honoured rather than reverted.
        const saved = state.originalStyleAttr;
        unmaskAuthorStyle(p, state);
        if (authorRewroteStyleAttribute(p, saved)) {
          // Their attribute now, so let the next state save it as it stands.
          carriedStyleAttr.delete(p);
        } else {
          // Untouched: put the author's own TEXT back and carry it across, so
          // `destroy()` still restores it byte-for-byte however many times this
          // paragraph has been re-read. Undoing our declarations individually
          // leaves a CSSOM serialization, which drops what does not survive a
          // round trip — a fallback declaration pair, a property this engine
          // does not parse.
          restoreStyleAttribute(p, saved);
          carriedStyleAttr.set(p, saved);
        }
        restoreManagedOutput(p, state, "keep");
        states.delete(p);
        queues.drop(p);
      }
      bailed.delete(p);
      floatDecisions.delete(p);
      scanned.delete(p);
    }
    adopt(stale);
    for (const p of stale) {
      carriedStyleAttr.delete(p);
      // A paragraph may have changed sides. Viewport tracking matters as much
      // as width tracking: an unobserved paragraph never enters nearViewport,
      // so its measured correction would park and never be promoted.
      if (ownedState(p) === undefined) {
        rebindFloatObservation(p);
        observer?.unobserve(p);
        drain.unobserve(p);
        // Its segments are gone, which is a layout change like any other —
        // reported for the same consumers that track the one-line demotion.
        if (wasEnhanced.has(p)) emitRelayout(p);
      } else {
        rebindFloatObservation(p, ownedState(p));
        observer?.observe(p);
        drain.observe(p);
      }
    }
  reprobeBaselines();
  return stale;
  };

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
      refreshNativeFloatIntrusions();
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
      refreshNativeFloatIntrusions();
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
      floatObserver?.disconnect();
      floatObserver = null;
      observedFloat.clear();
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
