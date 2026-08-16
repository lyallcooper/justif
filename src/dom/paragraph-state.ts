/**
 * The per-paragraph record the controller keeps, and the style bookkeeping that
 * goes with it.
 *
 * Justif writes inline declarations over the author's own, and every one has to
 * be givable back exactly as it was — their inline value, their `!important`,
 * or nothing at all. That is what makes this a vocabulary rather than a grab
 * bag: `ParaState` holds what was covered up, and the functions here are the
 * only sanctioned ways to cover and uncover it.
 */

import type { ParagraphItems, RunMetrics } from "../core/types.js";
import type { FontSpec } from "./measure.js";
import type { HardBreak, ParagraphScan } from "./read.js";

export interface ParaPart {
  para: ParagraphItems;
  breakAfter: HardBreak | null;
}

/** One property justif has written over, with what the author had there. */
export interface MaskedDeclaration {
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

export interface ParaState {
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
  /** Live clone of an authored leading float while enhanced. */
  renderedFloat: Element | null;
  /** The `text-indent` px value written while this paragraph sets natively on
   * one line (author indent minus its line-start hang); null when none is
   * applied. Stored as WRITTEN, so a percentage indent re-resolving across a
   * resize is caught even though the hang itself is unchanged. */
  nativeIndent: number | null;
  /** Last inline size the ResizeObserver reported for this paragraph, so a
   * notification carrying no inline-size change costs nothing to dismiss.
   * Untransformed CSS pixels: only ever compared with its own previous value,
   * never with a measure (see `contentWidthOf`). */
  observedInline?: number;
  /**
   * Inline declarations of justif's that sit on a property `rescan()`'s
   * comparison reads—`hyphens`, a one-line hang's `text-indent`, and an
   * intrinsic-size repair's `min-width` or `contain`. An inline declaration outranks the
   * author's stylesheet, so the author's current value is invisible until each
   * of these is lifted (`authorStyleKeys`).
   */
  masked: MaskedDeclaration[];
}

/** Enhancement state is shared so unjustify() works from anywhere; each
 * state carries the owner of the controller that created it. */
export const states = new WeakMap<HTMLElement, ParaState>();

/** Restore an inline style attribute exactly after CSSOM writes. Chromium can
 * rematerialize `style=""` when an element whose CSSStyleDeclaration handled
 * text-size-adjust is later cloned, even after removeAttribute(). Resetting
 * the attribute first severs that stale declaration before removal. */
export function restoreStyleAttribute(el: HTMLElement, style: string | null): void {
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
export const KEY_PROPERTIES = new Set([
  "hyphens",
  "-webkit-hyphens",
  "text-indent",
  "min-width",
  "contain",
]);

/** Selects the rule in justif's stylesheet that turns transitions off for the
 * duration of a re-read (see `suppressTransitions`). */
export const NO_TRANSITION_CLASS = "justif-no-transition";

/**
 * Write an inline declaration that covers an author value `rescan()` reads,
 * remembering what was underneath. Re-writing a property justif already owns
 * (a one-line hang whose indent changed) updates what to recognize later,
 * without forgetting the author's original.
 */
export function maskAuthorStyle(
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
export function maskAuthorStyles(
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
export function authorRewroteStyleAttribute(p: HTMLElement, saved: string | null): boolean {
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
export function declarationSet(style: CSSStyleDeclaration): string {
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
 * since the enhancement landed. When `property` is provided, remove only that
 * temporary probe and retain ownership records for every other declaration.
 *
 * The alternative, restoring the whole style attribute from the saved copy, is
 * what `destroy()` wants (byte-for-byte, so a fallback declaration pair or a
 * property the engine does not parse survives) but not what a re-read wants: it
 * would revert an author's later inline edit rather than honour it.
 */
export function unmaskAuthorStyle(p: HTMLElement, state: ParaState, property?: string): void {
  const kept: MaskedDeclaration[] = [];
  for (const mask of state.masked) {
    if (property && mask.property !== property) {
      kept.push(mask);
      continue;
    }
    // Already the author's again: they have written this property since, so
    // there is nothing of ours here to take back.
    if (p.style.getPropertyValue(mask.property) !== mask.ours) continue;
    if (mask.author === "") p.style.removeProperty(mask.property);
    else p.style.setProperty(mask.property, mask.author, mask.authorPriority);
  }
  state.masked = kept;
}

/** The author's own first-line indent in px. Percentage indents resolve
 * against the LIVE width (a scan-time resolution goes stale across
 * resizes). */
export function firstLineIndentPx(state: ParaState): number {
  return state.scan.textIndentPct !== null
    ? state.scan.textIndentPct * state.width
    : state.scan.textIndent;
}

/** Forget a native one-line hang. Undoing the declarations themselves is the
 * caller's, by whichever route it restores author styling. */
export function forgetNativeHang(state: ParaState): boolean {
  if (state.nativeIndent === null) return false;
  state.nativeIndent = null;
  return true;
}

/** Drop the inline `text-indent` hang written for a native one-line
 * paragraph, restoring the author's style attribute byte-for-byte. Only ever
 * applied while `enhanced` is false, so this restoration cannot clobber the
 * enhancement's own declarations — promotion clears it first. */
export function clearNativeHang(p: HTMLElement, state: ParaState): boolean {
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
export function nativeHangIndent(state: ParaState, hangPx: number): number | null {
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

export function applyNativeHang(
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

/** Add inline-axis size containment without discarding any containment the
 * author already requested. The shorthand aliases cannot be combined with
 * other values, so expand `content` before adding the missing component. */
export function withInlineSizeContainment(authorContain: string): string {
  if (authorContain === "strict" || authorContain.includes("size")) return authorContain;
  if (authorContain === "content") return "inline-size layout style paint";
  return !authorContain || authorContain === "none"
    ? "inline-size"
    : `${authorContain} inline-size`;
}

/** Put a managed paragraph back into its exact author DOM without releasing
 * its measurements or controller ownership. A one-line paragraph uses this
 * native state while ResizeObserver keeps watching for a narrower measure
 * that makes total-fit line breaking useful again. */
export function restoreManagedOutput(
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
  state.renderedFloat = null;
  return true;
}
