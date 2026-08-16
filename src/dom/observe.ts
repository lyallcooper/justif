/**
 * One shared ResizeObserver for all enhanced paragraphs, delivered
 * synchronously from the observer callback. That callback runs after layout
 * and BEFORE paint, so a handler that re-breaks a paragraph there replaces
 * the engine's own reflow of now-stale segments in the same rendering
 * update — the invalid intermediate never paints. Deferring even one frame
 * lets a width drag flash invalid layouts, most visibly a float paragraph's
 * prose thrown below its drop cap.
 *
 * Entries carry the observed content-box inline size. That number is a CHANGE
 * SIGNAL, not a measurement: it is in untransformed CSS pixels, so it cannot be
 * compared against geometry read from client rects, and the caller re-reads any
 * element it reports as changed. What it is good for is the common notification
 * this observer delivers — a paragraph whose height moved and whose width did
 * not — which it settles without forcing a layout read.
 *
 * A handler that mutates an observed element's size inside this delivery
 * would make the observer's loop guard report "ResizeObserver loop
 * completed with undelivered notifications" on the console. `suspend`
 * exists for exactly that: the handler declares the elements it is about to
 * re-break, their observation stops for the remainder of this frame, and
 * resumption's initial notification a frame later reports the size already
 * on record — which the handler already treats as a no-op, ending the
 * chain.
 */

export interface WidthObserver {
  observe(el: Element): void;
  unobserve(el: Element): void;
  /** Stop watching `el` until the next frame: the caller is about to change
   * its size inside this observer's own delivery (see module comment). */
  suspend(el: Element): void;
  disconnect(): void;
}

export function createWidthObserver(
  /** Observed content-box inline size per element — a change signal only; see
   * the module comment. */
  onWidths: (widths: ReadonlyMap<Element, number>) => void,
): WidthObserver {
  const suspended = new Set<Element>();
  let frame = 0;

  const resume = (): void => {
    frame = 0;
    for (const el of suspended) observer.observe(el, { box: "content-box" });
    suspended.clear();
  };

  const observer = new ResizeObserver((entries) => {
    const batch = new Map<Element, number>();
    for (const entry of entries) {
      const size = entry.contentBoxSize?.[0];
      batch.set(entry.target, size !== undefined ? size.inlineSize : entry.contentRect.width);
    }
    onWidths(batch);
  });

  return {
    observe: (el) => {
      suspended.delete(el);
      observer.observe(el, { box: "content-box" });
    },
    unobserve: (el) => {
      observer.unobserve(el);
      suspended.delete(el);
    },
    suspend: (el) => {
      observer.unobserve(el);
      suspended.add(el);
      if (frame === 0) frame = requestAnimationFrame(resume);
    },
    disconnect: () => {
      observer.disconnect();
      suspended.clear();
      if (frame !== 0) cancelAnimationFrame(frame);
    },
  };
}
