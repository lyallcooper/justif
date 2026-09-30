/**
 * Signed adjustment ratio for the pooled stretch or shrink of a line.
 * Infinite-order glue keeps an underfull ending natural; an overfull
 * ending still needs finite shrink. Missing flexibility yields infinity.
 */
export function lineAdjustmentRatio(
  naturalWidth: number,
  targetWidth: number,
  stretch: number,
  shrink: number,
  hasInfiniteStretch: boolean,
): number {
  if (naturalWidth < targetWidth) {
    return hasInfiniteStretch
      ? 0
      : stretch > 0
        ? (targetWidth - naturalWidth) / stretch
        : Infinity;
  }
  if (naturalWidth > targetWidth) {
    return shrink > 0 ? (naturalWidth - targetWidth) / -shrink : -Infinity;
  }
  return 0;
}
