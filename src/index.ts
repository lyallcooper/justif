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
import { breakParagraph } from "./core/breaker.js";
import { buildItems } from "./core/items.js";
import { layoutLines } from "./core/layout.js";
import {
  composeProtrusion,
  type HangingPunctuationMode,
  latinProtrusion,
  normalizeHangingPunctuation,
} from "./core/protrusion.js";
import {
  type BreakOptions,
  type BreakResult,
  type BuildOptions,
  defaultBreakOptions,
  defaultBuildOptions,
  type ExpansionOptions,
  ItemType,
  type Line,
  type LineWidths,
  type ParagraphItems,
  type ProtrusionTable,
  type RunMetrics,
  type TrackingOptions,
} from "./core/types.js";
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
import { createWidthObserver, type WidthObserver } from "./dom/observe.js";
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
  buildRenderSegments,
  buildRunMetrics,
  clearComposedProtrusionCache,
  measureFor,
  runTexts,
} from "./dom/segments.js";
import {
  applyCorrections,
  disableTextAutosizing,
  TEXT_AUTOSIZING_DECLARATIONS,
  measureCorrections,
  type PendingParagraph,
  type RenderContent,
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
   * hand-tuned per-font table.
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
   * Compatibility: `true` selects the default; `false` selects `"none"`;
   * `"first-line"` aliases `"first-line-and-line-ends"`; and `"all-lines"`
   * aliases `"all-line-edges"`.
   */
  hangingPunctuation?: true | HangingPunctuationMode;
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
   */
  readonly managed: readonly HTMLElement[];
}

interface ParaPart {
  para: ParagraphItems;
  breakAfter: HardBreak | null;
}

/** One property justif has written over, with what the author had there. */
interface MaskedDeclaration {
  property: string;
  /**
   * Does the style key read this property? Only those have to be lifted to
   * compare against the author's value, and lifting is not free: writing
   * `text-align` or the autosizing opt-out back and forth dirties layout, so a
   * check that lifted everything cost a forced layout and ~10ms per 400
   * paragraphs where the reads alone cost 0.3ms.
   */
  inKey: boolean;
  /** The value justif wrote, so a later author write can be recognized: if the
   * property no longer holds this, the author has taken it back and there is
   * nothing left to lift. */
  ours: string;
  /** Priority justif wrote it with — "important" for the autosizing opt-out,
   * whose whole point is that no author rule may override it after
   * measurement. Putting it back without this would quietly demote it. */
  oursPriority: string;
  /** The author's own inline declaration, "" when they had none. */
  author: string;
  authorPriority: string;
}

interface ParaState {
  /** The controller that owns this enhancement (guards zombie observers). */
  owner: symbol;
  original: DocumentFragment;
  originalStyleAttr: string | null;
  scan: ParagraphScan;
  runsMetrics: RunMetrics[];
  specByKey: Map<string, FontSpec>;
  parts: ParaPart[];
  width: number;
  /** Fingerprint of the last patch, to skip no-op re-renders. */
  lastPatch: string;
  enhanced: boolean;
  /** The `text-indent` px value written while this paragraph sets natively on
   * one line (author indent minus its line-start hang); null when none is
   * applied. Stored as WRITTEN, so a percentage indent re-resolving across a
   * resize is caught even though the hang itself is unchanged. */
  nativeIndent: number | null;
  /**
   * Inline declarations of justif's that sit on a property `rescan()`'s
   * comparison reads — `hyphens`, and a one-line hang's `text-indent`. An inline
   * declaration outranks the author's stylesheet, so the author's current value
   * is invisible until each of these is lifted (`authorStyleKeys`).
   */
  masked: MaskedDeclaration[];
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

/**
 * Of the declarations the enhancement writes, the ones `paragraphStyleKey` and
 * `styleKeyNow` read — so the ones whose author value has to be uncovered before
 * a comparison means anything. Everything else justif writes is invisible to the
 * key, and lifting it would be pure cost.
 *
 * `text-size-adjust` is deliberately NOT here even though it can move a computed
 * `font-size` on engines that autosize text: it is written on every enhanced
 * paragraph and read back on every check, so both sides of the comparison see it
 * consistently, and lifting it would both dirty layout and make the two sides
 * disagree.
 */
const KEY_PROPERTIES = new Set(["hyphens", "-webkit-hyphens", "text-indent"]);

/** Selects the rule in justif's stylesheet that turns transitions off for the
 * duration of a re-read (see `suppressTransitions`). */
const NO_TRANSITION_CLASS = "justif-no-transition";

/**
 * Write an inline declaration that covers an author value `rescan()` reads,
 * remembering what was underneath. Re-writing a property justif already owns
 * (a one-line hang whose indent changed) updates what to recognize later,
 * without forgetting the author's original.
 */
function maskAuthorStyle(
  p: HTMLElement,
  state: ParaState,
  property: string,
  value: string,
  priority = "",
): void {
  maskAuthorStyles(p, state, [[property, value]], priority);
}

/**
 * The same, for declarations that have to be recorded as a GROUP: every author
 * value is read before any of them is written.
 *
 * That ordering is the whole point where two of the properties are one property.
 * `-webkit-hyphens` and `hyphens` are aliases, so masking them one after the other
 * reads the first write back as the author's own value for the second — and the
 * comparison then puts justif's value back as though the author had asked for it,
 * leaving native hyphenation on and the paragraph unable to notice its own state.
 */
function maskAuthorStyles(
  p: HTMLElement,
  state: ParaState,
  declarations: ReadonlyArray<readonly [property: string, value: string]>,
  priority = "",
): void {
  const authored = declarations.map(([property]) => ({
    author: p.style.getPropertyValue(property),
    authorPriority: p.style.getPropertyPriority(property),
  }));
  for (const [index, [property, value]] of declarations.entries()) {
    const existing = state.masked.find((mask) => mask.property === property);
    if (existing === undefined) {
      state.masked.push({
        property,
        inKey: KEY_PROPERTIES.has(property),
        ours: value,
        oursPriority: priority,
        ...authored[index]!,
      });
    } else {
      existing.ours = value;
      existing.oursPriority = priority;
    }
    p.style.setProperty(property, value, priority);
  }
}

/**
 * Has the author written to this paragraph's style attribute since justif saved a
 * copy of it? Asked once justif's own declarations are off, and compared as
 * SERIALIZATIONS: the saved copy is the author's original text, which need not
 * equal its own round trip, so comparing it to the live attribute directly would
 * call every paragraph edited.
 */
function authorRewroteStyleAttribute(p: HTMLElement, saved: string | null): boolean {
  const probe = p.ownerDocument.createElement("span");
  if (saved !== null) probe.setAttribute("style", saved);
  return declarationSet(probe.style) !== declarationSet(p.style);
}

/**
 * A style attribute's declarations as one order-independent string.
 *
 * Not its serialization: re-setting a property moves it to the end of the list, so
 * taking justif's declarations off — which puts an author value back where there
 * was one — reorders what it touched, and comparing text would then report every
 * such paragraph as rewritten.
 */
function declarationSet(style: CSSStyleDeclaration): string {
  const declarations: string[] = [];
  for (let index = 0; index < style.length; index++) {
    const property = style.item(index);
    declarations.push(
      `${property}:${style.getPropertyValue(property)}:${style.getPropertyPriority(property)}`,
    );
  }
  return declarations.sort().join(";");
}

/**
 * Undo justif's own inline declarations, one property at a time, leaving every
 * other declaration exactly as it stands — including any the author has written
 * since the enhancement landed.
 *
 * The alternative, restoring the whole style attribute from the saved copy, is
 * what `destroy()` wants (byte-for-byte, so a fallback declaration pair or a
 * property the engine does not parse survives) but not what a re-read wants: it
 * would revert an author's later inline edit rather than honour it.
 */
function unmaskAuthorStyle(p: HTMLElement, state: ParaState): void {
  for (const mask of state.masked) {
    // Already the author's again: they have written this property since, so
    // there is nothing of ours here to take back.
    if (p.style.getPropertyValue(mask.property) !== mask.ours) continue;
    if (mask.author === "") p.style.removeProperty(mask.property);
    else p.style.setProperty(mask.property, mask.author, mask.authorPriority);
  }
  state.masked = [];
}

/** The author's own first-line indent in px. Percentage indents resolve
 * against the LIVE width (a scan-time resolution goes stale across
 * resizes). */
function firstLineIndentPx(state: ParaState): number {
  return state.scan.textIndentPct !== null
    ? state.scan.textIndentPct * state.width
    : state.scan.textIndent;
}

/** Forget a native one-line hang. Undoing the declarations themselves is the
 * caller's, by whichever route it restores author styling. */
function forgetNativeHang(state: ParaState): boolean {
  if (state.nativeIndent === null) return false;
  state.nativeIndent = null;
  return true;
}

/** Drop the inline `text-indent` hang written for a native one-line
 * paragraph, restoring the author's style attribute byte-for-byte. Only ever
 * applied while `enhanced` is false, so this restoration cannot clobber the
 * enhancement's own declarations — promotion clears it first. */
function clearNativeHang(p: HTMLElement, state: ParaState): boolean {
  if (!forgetNativeHang(state)) return false;
  state.masked = [];
  restoreStyleAttribute(p, state.originalStyleAttr);
  return true;
}

/**
 * Hanging punctuation for a paragraph left in native rendering: its opening
 * mark still owes the margin its hang — a paragraph whose opener sits flush
 * beside neighbours whose openers hang reads as a ragged left edge (issue
 * #14) — and a negative `text-indent` buys exactly that without the DOM
 * rewrite the one-line fast path exists to avoid. `text-indent` is line-START
 * relative, hanging into the right margin in an RTL paragraph, and it must
 * carry the author's own first-line indent because an inline declaration
 * replaces it. The same computed hang is used by the enhanced path.
 */
function nativeHangIndent(state: ParaState, hangPx: number): number | null {
  // This hang costs an inline style on the author's own element, so it has to
  // earn it: measured protrusion gives most letters a fraction of a pixel, which
  // no reader can see at a line start but which would rewrite the style
  // attribute of every short paragraph on the page. It applies to fallback
  // values too, where it drops the 50‰ letters (an 'A' at 16px is ~0.55px):
  // the threshold is about what a reader can see, not where the number came
  // from.
  if (hangPx < state.scan.specs[state.scan.baseSpec]!.sizePx * 0.04) {
    return null;
  }
  return Number((firstLineIndentPx(state) - hangPx).toFixed(3));
}

function applyNativeHang(
  p: HTMLElement,
  state: ParaState,
  indent: number | null,
): boolean {
  if (indent === null) return clearNativeHang(p, state);
  if (indent === state.nativeIndent) return false;
  state.nativeIndent = indent;
  maskAuthorStyle(p, state, "text-indent", `${indent}px`);
  // Neutralized for the same reason as in beginEnhancement: a CSS
  // hanging-punctuation hang would compound with this one.
  maskAuthorStyle(p, state, "hanging-punctuation", "none");
  return true;
}

/** Put a managed paragraph back into its exact author DOM without releasing
 * its measurements or controller ownership. A one-line paragraph uses this
 * native state while ResizeObserver keeps watching for a narrower measure
 * that makes total-fit line breaking useful again. */
function restoreManagedOutput(
  p: HTMLElement,
  state: ParaState,
  /**
   * How to give the author their inline styling back. "restore" puts the saved
   * attribute back verbatim, which is what teardown wants: byte-for-byte, so a
   * fallback declaration pair or a property this engine does not parse survives.
   * "keep" leaves the live attribute alone, for a caller that has already taken
   * justif's own declarations off it one property at a time
   * (`unmaskAuthorStyle`) — a re-read, which must not revert an author's later
   * inline edit along with them.
   */
  styleAttribute: "restore" | "keep" = "restore",
): boolean {
  // The native one-line hang is the one inline declaration justif writes
  // WITHOUT enhancing, so it has to be undone before that early return —
  // otherwise destroy(), unjustify() and a bail would all leak it.
  const clearedHang =
    styleAttribute === "restore" ? clearNativeHang(p, state) : forgetNativeHang(state);
  if (!state.enhanced) return clearedHang;
  p.replaceChildren(state.original);
  if (styleAttribute === "restore") {
    restoreStyleAttribute(p, state.originalStyleAttr);
    // The author's style attribute is back, so nothing of justif's covers it.
    state.masked = [];
  }
  p.removeAttribute("data-justif");
  p.removeAttribute("data-justif-dropcap");
  state.lastPatch = "";
  state.enhanced = false;
  return true;
}

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

/** Message for an `onSkip` reason: anything can be thrown, including
 * non-Errors from hostile content. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const hangMode: HangingPunctuationMode =
    requestedHang === undefined || requestedHang === true
      ? DEFAULT_HANGING_PUNCTUATION
      : normalizeHangingPunctuation(requestedHang);
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
      : composeProtrusion(protrusionModel ? latinProtrusion : {}, protrusionUser, hangMode);
  const protrusion: ProtrusionTable | false = composed === null ? false : composed.rest;
  const protrusionFirst =
    composed !== null && composed.first !== composed.rest ? composed.first : undefined;
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
    },
    hyphenate,
  };
}

/**
 * Take over a paragraph: stash its author DOM and neutralize the CSS that
 * would fight the model's own line breaking. Everything written here is an
 * inline declaration on the paragraph, restored byte-for-byte with the rest
 * of the style attribute by destroy().
 */
function beginEnhancement(p: HTMLElement, state: ParaState): void {
  state.original.append(...p.childNodes);
  state.enhanced = true;
  p.setAttribute("data-justif", "");
  if (state.scan.floatIntrusion !== null) p.setAttribute("data-justif-dropcap", "");
  // Recorded, since the enhancement is answerable for every declaration it leaves
  // on the author's element — as one group, because these two are one property.
  maskAuthorStyles(p, state, TEXT_AUTOSIZING_DECLARATIONS, "important");
  // Neutralize the author's text-align: justify (the browser must not
  // re-justify our exactly-filled lines) — toward the line-START edge,
  // which is the right edge in an RTL paragraph.
  maskAuthorStyle(p, state, "text-align", state.scan.direction === "rtl" ? "right" : "left");
  // text-align-last also applies to lines terminated by <br>. The core
  // has already implemented its `justify` case by setting each segment
  // ending as a rectangle, so neutralize that native second pass.
  // Other author alignments remain useful: the browser can center/end-
  // align our already-sized ragged ending without changing its breaks.
  if (state.scan.justifyAll) {
    const last = state.scan.direction === "rtl" ? "right" : "left";
    maskAuthorStyle(p, state, "text-align-last", last);
  }
  // Neutralize CSS hanging-punctuation (Safari): it would hang quotes
  // and stops on top of our protrusion — a double hang — and shift
  // rendered widths our wrap model doesn't know about. A no-op in
  // engines that don't support the property. Use a `hangingPunctuation`
  // mode for the full-hang style instead.
  maskAuthorStyle(p, state, "hanging-punctuation", "none");
  // Reset the properties that decide where the engine MAY break. The
  // model chose every break and each glyph run is `nowrap`, so neither
  // the permissive values (which license a break where the text offers
  // no opportunity) nor the restrictive ones (`keep-all`, `strict`,
  // `loose`) have legitimate work left in the enhanced DOM: measured
  // identical layout for CJK either way, and a too-wide token overflows
  // the same as before, `break-all` or not. What the permissive values do
  // have is a way to break the wrap guarantee. A line's ink deliberately
  // overhangs the measure (a hanging hyphen protrudes, and every line
  // carries the provisional wrap-safety pad), and Chromium and Firefox
  // read that overhang as "this line overflows" and re-break it at the one
  // boundary still available: between a segment and the `.justif-hyphen`
  // carrying its hyphen glyph, which then paints at the START of the next
  // line. WebKit takes the same break far more rarely, but does take it.
  // `line-break: anywhere` would be the most destructive — its
  // opportunities apply *inside* a nowrap run. The segment rules cover the
  // licences an author rule grants closer to the break point than this
  // (see SHEET_TEXT).
  maskAuthorStyle(p, state, "overflow-wrap", "normal");
  maskAuthorStyle(p, state, "word-break", "normal");
  maskAuthorStyle(p, state, "line-break", "auto");
  // Neutralize CSS `hyphens: auto`: the model chose every break, so
  // auto-hyphenation has no work left in the enhanced DOM (the
  // `hyphenate` option is the replacement) — and it makes Chromium's
  // beside-float fit test stop hanging the trailing break space,
  // dropping every line planned to wrap a drop cap below the float at
  // its narrow measure. Written only when it changes the computed
  // value: setting -webkit-hyphens at all (even to its initial
  // `manual`) moves WebKit onto a text path with subtly different
  // glyph advances. An author's `hyphens: auto !important` still wins,
  // deliberately: like text-align above (and unlike text-size-adjust,
  // where measurement integrity is at stake), enhancement never
  // escalates against an explicit author override.
  if (state.scan.specs[state.scan.baseSpec]!.hyphens === "auto") {
    // Recorded as one group, because these two ARE one property (see
    // maskAuthorStyles). From here on this paragraph's computed `hyphens` is
    // justif's, so rescan() looks underneath it — and, unavoidably, a later author
    // change to it no longer computes differently, which is how the drop-in
    // notices a change at all. Neutralizing on the SEGMENTS instead would leave
    // the author's value visible, and was tried: it brings back the Chromium
    // beside-float bug this declaration exists to prevent (#4/#5), whose fit test
    // reads the value from the paragraph.
    maskAuthorStyles(p, state, [
      ["hyphens", "manual"],
      ["-webkit-hyphens", "manual"],
    ]);
  }
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
      if (scan.runs.some((r) => /[\u00A0\u202F]/.test(r.text))) authorNbsp = true;
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
   * had never touched it. Two of justif's own inline declarations sit on
   * properties the key describes (`hyphens`, and a one-line hang's
   * `text-indent`), and an inline declaration outranks the author's stylesheet,
   * so on those paragraphs the author's current value is invisible.
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
  interface PatchOutcome {
    /** True when this call either installed line segments or restored native DOM. */
    changed: boolean;
    /** Installed segments awaiting the measured wrap-guarantee correction. */
    pending: PendingParagraph | null;
  }

  const safePatch = (p: HTMLElement): PatchOutcome => {
    try {
      return patchOne(p);
    } catch (error) {
      return {
        changed: bailToNative(p, `threw while rendering: ${describeError(error)}`),
        pending: null,
      };
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

  /** Forget every queued width and correction for `p`. (The queues are
   * declared below; every call happens long after initialization.) */
  const dropQueued = (p: HTMLElement): void => {
    pendingWidths.delete(p);
    pendingCorrections.delete(p);
    hiddenCorrections.delete(p);
  };

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

  /** One paragraph's chosen breaks, ready to write. */
  interface PartsLayout {
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
    const state = ownedState(p);
    if (state === undefined) return { changed: false, pending: null };
    const widths = lineWidthsFor(state);
    if (widths === null) {
      dropQueued(p);
      return { changed: restoreManagedOutput(p, state), pending: null };
    }
    // `justify-all` is the CSS-level rectangular mode: it requests that
    // even the final (or only) line fill the measure. The ordinary public
    // default remains 0.33 for multi-line endings only.
    const paragraphMinWidth = state.scan.justifyAll ? 1 : lastLineMinWidth;
    const layout = layoutParts(state, widths, paragraphMinWidth);

    if (
      layout.visualLineCount === 1 &&
      state.scan.hardBreaks.length === 0 &&
      oneLineStaysNative(layout, paragraphMinWidth)
    ) {
      dropQueued(p);
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
    pendingCorrections.delete(p);
    hiddenCorrections.delete(p);
    // Per-line target widths: an indented first line has its own measure,
    // and the wrap-guarantee corrections must compare against it.
    return {
      changed: true,
      pending: writeParagraph(
        p,
        layout.rendered,
        layout.lineWidths,
        state.scan.floatIntrusion?.lines ?? 0,
      ),
    };
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
    //
    // IntersectionObserver cannot populate nearViewport synchronously. Until
    // its first report, classify this batch directly so visible corrections
    // land in the same task as their initial patch.
    if (viewObserver !== null && !viewObserverReady) seedNearViewport(batch);
    const measure: PatchEntry[] = [];
    for (const e of batch) {
      if (viewObserver === null || nearViewport.has(e.p)) measure.push(e);
      else if (e.p.isConnected) hiddenCorrections.set(e.p, e.pending);
    }
    if (measure.length > 0) {
      const { corrections, hidden, invalid } = measureCorrections(
        measure.map((e) => e.pending),
      );
      applyCorrections(corrections);
      for (const i of hidden) {
        const e = measure[i]!;
        hiddenCorrections.set(e.p, e.pending);
      }
      for (const { index, reason } of invalid) {
        const e = measure[index]!;
        if (ownedState(e.p) === undefined) continue;
        dropQueued(e.p);
        if (bailToNative(e.p, reason)) emitRelayout(e.p);
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
    warmDomWidths(
      scannable.flatMap((p) => {
        const scan = scanned.get(p);
        return scan === undefined || !scan.specs.some(requiresDomMeasurement)
          ? []
          : [{ scan, specByKey: new Map(scan.specs.map((spec) => [spec.key, spec])) }];
      }),
    );
    const batch: PatchEntry[] = [];
    const changed: HTMLElement[] = [];
    for (const p of scannable) {
      if (!prepare(p)) continue;
      const outcome = safePatch(p);
      if (outcome.pending !== null) batch.push({ p, pending: outcome.pending });
      if (outcome.changed) changed.push(p);
    }
    flushPatches(batch);
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
      dropQueued(p);
      if (restoreManagedOutput(p, state)) changed = true;
    }
    for (const { p, state } of candidates) {
      const next = floatIntrusionOf(
        p,
        state.scan.runs.map((run) => run.text).join(""),
      );
      if (next === null) {
        states.delete(p);
        bailed.add(p);
        emitSkip(p, "could not remeasure floated ::first-letter after font change");
        emitRelayout(p);
        continue;
      }
      if (
        Math.abs(next.inlineSize - state.scan.floatIntrusion!.inlineSize) > 0.05 ||
        next.lines !== state.scan.floatIntrusion!.lines
      ) {
        changed = true;
      }
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
    const changed: HTMLElement[] = [];
    for (const p of mine) {
      const state = states.get(p)!;
      const width = widths.get(p)!;
      if (typeof width === "string") {
        dropQueued(p);
        if (bailToNative(p, width)) changed.push(p);
        continue;
      }
      state.runsMetrics = buildRunMetrics(state.scan, expansion, spacing, protrusionCtx);
      state.parts = buildParts(state.scan, state.runsMetrics, state.specByKey);
      state.width = width;
      state.lastPatch = "";
      const outcome = safePatch(p);
      if (outcome.pending !== null) batch.push({ p, pending: outcome.pending });
      if (outcome.changed) changed.push(p);
    }
    flushPatches(batch);
    for (const p of changed) emitRelayout(p);
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
  /** False until IntersectionObserver has supplied the passive viewport state. */
  let viewObserverReady = false;
  /** Synchronous fallback for the observer's initial asynchronous report. */
  const seedNearViewport = (batch: readonly PatchEntry[]): void => {
    const root = document.documentElement;
    const width = root.clientWidth || window.innerWidth;
    const height = root.clientHeight || window.innerHeight;
    // Percentage root margins resolve against the root's width.
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
    const s = ownedState(el);
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
      const state = ownedState(el);
      if (state === undefined) continue;
      if (Math.abs(width - state.width) < 0.05) continue;
      state.width = width;
      const outcome = safePatch(el);
      if (outcome.changed) {
        if (outcome.pending !== null) pendingCorrections.set(el, outcome.pending);
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
      if (ownedState(p) !== undefined) {
        viewObserver?.observe(p);
        revealObserver?.observe(p);
      }
    }
    if (options.observeResize !== false) {
      observer = createWidthObserver((widths) => {
        for (const [el, width] of widths) {
          const state = ownedState(el as HTMLElement);
          if (state === undefined) continue;
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
        if (ownedState(p) !== undefined) observer.observe(p);
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
    const stale = considered.filter((p) => decidedStyleKey.get(p) !== current.get(p));
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
        dropQueued(p);
      }
      bailed.delete(p);
      scanned.delete(p);
    }
    adopt(stale);
    for (const p of stale) {
      carriedStyleAttr.delete(p);
      // A paragraph may have changed sides. Viewport tracking matters as much
      // as width tracking: an unobserved paragraph never enters nearViewport,
      // so its measured correction would park and never be promoted.
      if (ownedState(p) === undefined) {
        observer?.unobserve(p);
        viewObserver?.unobserve(p);
        revealObserver?.unobserve(p);
        // Its segments are gone, which is a layout change like any other —
        // reported for the same consumers that track the one-line demotion.
        if (wasEnhanced.has(p)) emitRelayout(p);
      } else {
        observer?.observe(p);
        viewObserver?.observe(p);
        revealObserver?.observe(p);
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
      pendingWidths.clear();
      pendingCorrections.clear();
      hiddenCorrections.clear();
      pendingOrder = [];
      leaveClipboardCleanup?.();
      document.fonts.removeEventListener("loadingdone", onFontsLoaded);
      document.fonts.removeEventListener("loading", onFontsLoading);
      viewObserver?.disconnect();
      revealObserver?.disconnect();
      observer?.disconnect();
      observer = null;
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
