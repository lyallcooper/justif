/**
 * The public option surface, and what it resolves to.
 *
 * Two audiences meet here. Outward, this is the documented API — every knob a
 * caller can turn, with the typographic reasoning behind its default, because
 * a justification setting whose consequence is not explained is a setting
 * nobody can choose between. Inward, `resolveOptions` turns that into the
 * flat, fully-defaulted shape the layout actually runs on, once per
 * controller.
 *
 * Pure by construction: nothing here touches the DOM, so what a controller
 * will do with a given option object can be worked out without a document.
 *
 * The split between the public defaults and the CORE defaults in
 * ./core/types.js is deliberate and shows up repeatedly below. The core is
 * classic TeX; the public API is Bringhurst. `lastLineMinWidth` and
 * `tracking` are both core-off, public-on for that reason.
 */

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
  type ProtrusionTable,
  type TrackingOptions,
} from "./core/types.js";
import type { ProtrusionSettings } from "./dom/protrusion-tables.js";

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
export const LAYOUT_OPTION_KEYS = [
  "hangingPunctuation",
  "protrusion",
  "expansion",
  "tracking",
  "spacing",
  "lastLineMinWidth",
  "lastLineFit",
] as const satisfies ReadonlyArray<keyof LayoutOptions>;
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
export interface ResolvedOptions {
  breakOpts: BreakOptions;
  buildOpts: BuildOptions;
  /** The clamped public value, feeding breaker pricing AND the layout floor
   * — the two must see the same number. */
  lastLineMinWidth: number;
  expansion: ExpansionOptions | false;
  spacing: Required<NonNullable<JustifyOptions["spacing"]>>;
  /** Per-run protrusion resolution context for `buildRunMetrics`. */
  protrusionCtx: ProtrusionSettings;
  /** Memoized word splitter, or undefined when hyphenation is off. */
  hyphenate: ((word: string) => readonly string[]) | undefined;
}

export function resolveOptions(options: JustifyOptions): ResolvedOptions {
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