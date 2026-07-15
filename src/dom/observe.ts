/**
 * One shared ResizeObserver for all enhanced paragraphs, coalesced through
 * requestAnimationFrame. Entries carry the content-box inline size, so the
 * resize path never forces a layout read.
 */

export interface WidthObserver {
  observe(el: Element): void;
  unobserve(el: Element): void;
  disconnect(): void;
}

export function createWidthObserver(
  onWidths: (widths: ReadonlyMap<Element, number>) => void,
): WidthObserver {
  const pending = new Map<Element, number>();
  let frame = 0;

  const flush = (): void => {
    frame = 0;
    if (pending.size === 0) return;
    const batch = new Map(pending);
    pending.clear();
    onWidths(batch);
  };

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const size = entry.contentBoxSize?.[0];
      const width = size !== undefined ? size.inlineSize : entry.contentRect.width;
      pending.set(entry.target, width);
    }
    if (frame === 0) frame = requestAnimationFrame(flush);
  });

  return {
    observe: (el) => observer.observe(el, { box: "content-box" }),
    unobserve: (el) => {
      observer.unobserve(el);
      pending.delete(el);
    },
    disconnect: () => {
      observer.disconnect();
      pending.clear();
      if (frame !== 0) cancelAnimationFrame(frame);
    },
  };
}
