/**
 * Geometry shared by the paragraph reader and the measured wrap correction.
 *
 * A fragmented block has one client rect per column/page, while its bounding
 * rect is their union (including the gaps between them). CSS multicolumn
 * fragments have one common inline size; unequal widths belong to a more
 * general paged-fragmentation problem that the line model does not support.
 */

export const FRAGMENT_WIDTH_TOLERANCE_PX = 0.5;

export interface FragmentBoxes {
  ok: true;
  /** Non-zero-width border-box fragments in content order. */
  rects: readonly DOMRect[];
  /** The common fragment content-box width. */
  contentWidth: number;
}

export interface UnsupportedFragmentBoxes {
  ok: false;
  /**
   * "not rendered" and "zero content width" are deliberately separate answers
   * to the same reading of nothing. An element with NO boxes at all is not
   * being laid out — `display: none`, a closed `<details>`, a detached
   * subtree — and will measure again when it is. An element that HAS boxes
   * and still measures zero has been collapsed while rendered, which is a
   * condition someone has to be told about rather than wait out.
   */
  reason: "not rendered" | "zero content width" | "fragment boxes have unequal widths";
}

export type FragmentBoxResult = FragmentBoxes | UnsupportedFragmentBoxes;

export function fragmentBoxesOf(
  el: HTMLElement,
  style?: CSSStyleDeclaration,
): FragmentBoxResult {
  const view = el.ownerDocument.defaultView;
  if (view === null) return { ok: false, reason: "not rendered" };
  const cs = style ?? view.getComputedStyle(el);
  const all = el.getClientRects();
  if (all.length === 0) return { ok: false, reason: "not rendered" };
  const rects = [...all].filter((rect) => rect.width > 0);
  if (rects.length === 0) return { ok: false, reason: "zero content width" };

  const borderBoxWidth = rects[0]!.width;
  if (
    rects.some(
      (rect) => Math.abs(rect.width - borderBoxWidth) > FRAGMENT_WIDTH_TOLERANCE_PX,
    )
  ) {
    return { ok: false, reason: "fragment boxes have unequal widths" };
  }

  const contentWidth =
    borderBoxWidth -
    (parseFloat(cs.paddingLeft) || 0) -
    (parseFloat(cs.paddingRight) || 0) -
    (parseFloat(cs.borderLeftWidth) || 0) -
    (parseFloat(cs.borderRightWidth) || 0);
  return contentWidth > 0
    ? { ok: true, rects, contentWidth }
    : { ok: false, reason: "zero content width" };
}
