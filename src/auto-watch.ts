/**
 * Noticing that the page's CSS has changed under an enhancement.
 *
 * The drop-in is configured through `--justif-*` custom properties, and each
 * paragraph's scan reads a set of standard properties besides. Both can change
 * after boot for reasons no observer reports: a media query, a container
 * query, a class swap, a theme toggle, an inline edit. The signal used here is
 * a transition — registering the custom properties makes them transitionable
 * at all, and a sub-millisecond transition on justif's own declaration then
 * fires an event whenever one of those computed values moves, whatever moved
 * it.
 *
 * Two answers come out of that, and they are deliberately different work. A
 * `--justif-*` change is a RECONFIGURATION: paragraphs may regroup, and the
 * controllers that survive take new options. A standard-property change is a
 * RESCAN of the paragraphs it landed on: their author styling now reads
 * differently from what their enhancement was built against.
 *
 * Everything here is best-effort by design. Signals may over-fire — the
 * response is a read and a comparison, so a spurious wake-up costs a style
 * read in a frame that was already recalculating, not a re-layout. Under-firing
 * is the only real failure, which is why the matching below is deliberately
 * loose and the arming deliberately conservative.
 */

import { CSS_PROPERTIES, PROPERTY_SYNTAX } from "./auto-options.js";

/** What the watcher does with what it notices. */
export interface WatchHost {
  /** A `--justif-*` value moved: re-read the configuration and bring
   * controllers into line with it. */
  reconcile(): void;
  /** These paragraphs' author styling moved: re-read them. */
  rescan(targets: readonly HTMLElement[]): void;
  /** `data-justif-debug`: report the liveness a paragraph did not get. */
  readonly debug: boolean;
}

export interface Watcher {
  /**
   * Make one paragraph watchable: preflight its transition longhands, mark it
   * only if nothing would be replaced, and ensure its root carries the rule and
   * the listener. Re-run on every scan, which is what notices an author
   * transition introduced after boot.
   */
  arm(el: HTMLElement, style: CSSStyleDeclaration): void;
  /** Drop a reconciliation queued but not yet run, for a caller about to do
   * that work itself. */
  cancelPendingReconcile(): void;
}

const KNOWN_PROPERTIES = new Set<string>(CSS_PROPERTIES);

/**
 * The standard properties a paragraph's SCAN depends on, watched the same way the
 * `--justif-*` configuration is: each one transitions under
 * `transition-behavior: allow-discrete` in all three engines (verified — several
 * are non-animatable in the older sense and carry only because interpolation is
 * discrete), so a change to any of them reaches `controller.rescan()`.
 *
 * Named individually rather than through `all`: `all` would transition every
 * property a managed paragraph animates — a hover colour, a theme fade — turning
 * cosmetic changes into scan work.
 *
 * `direction` is absent because it transitions in no engine, and `display`
 * deliberately so: transitioning it would delay an author's own show/hide by the
 * watcher's duration. Alignment (`text-align`, `text-align-last`) is absent for a
 * different reason — the enhancement overwrites it, so its computed value is
 * justif's own answer and a change to the author's underneath it is invisible.
 */
const SCAN_PROPERTIES = [
  "hyphens",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant",
  "font-feature-settings",
  "font-variation-settings",
  "letter-spacing",
  "word-spacing",
  "white-space",
  "line-height",
  "text-indent",
  "text-transform",
] as const;

/** Spellings engines report that no prefix of the list above covers. */
const SCAN_PROPERTY_ALIASES = new Set(["text-wrap-mode", "-webkit-hyphens"]);

/**
 * Does a transition event name a property the scan reads?
 *
 * Prefix-matched, because an event names the longhand the engine actually
 * animated: `white-space` arrives as `white-space-collapse`, `font-variant` as
 * `font-variant-caps`. Over-matching costs at most a rescan that compares equal
 * and does nothing.
 */
function isScanProperty(property: string): boolean {
  if (SCAN_PROPERTY_ALIASES.has(property)) return true;
  return SCAN_PROPERTIES.some((watched) => property.startsWith(watched));
}

/**
 * Properties the rescan itself writes, and until when to disregard an event
 * naming one.
 *
 * To compare a paragraph's `hyphens` (or a one-line hang's `text-indent`)
 * against the author's, `rescan()` has to take justif's own declaration off for
 * the read — and those are properties this watcher transitions, so the check
 * echoes back as events that would schedule the next check, for as long as the
 * page is open. Measured before this guard: 600 transition events and 240
 * rescans over two idle seconds, with no DOM change to show for any of it.
 *
 * A window rather than a flag: the echo arrives a frame or two after the write,
 * asynchronously. Two frames is enough for it and short enough that a genuine
 * author change is only ever missed if it lands on the same property, on the
 * same paragraph, inside the same 34ms — and the next event, or
 * `reconfigure()`, catches up even then.
 */
const ECHO_PROPERTIES = new Set(["hyphens", "-webkit-hyphens", "text-indent"]);
const ECHO_WINDOW_MS = 34;

/** Marks the paragraphs the watcher rule may transition. Separate from
 * ownership: it is present only where no author transition would be replaced. */
const WATCH_ATTRIBUTE = "data-justif-watch";

/**
 * Live updates need `@property` (Safari 16.4) to make the properties
 * transitionable at all, and `transition-behavior: allow-discrete` (Safari 17.4)
 * to carry the keyword-valued ones, whose interpolation is discrete. Requiring
 * both rather than shipping percentage-only liveness keeps the surface from
 * being half-live in a way nobody can predict.
 */
function liveUpdatesSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.registerProperty === "function" &&
    CSS.supports("transition-behavior", "allow-discrete")
  );
}

/** Install `cssText` at a root, preferring a constructable sheet: it also works
 * under a strict Content-Security-Policy, where an inline `<style>` is blocked
 * by `style-src` without 'unsafe-inline'. */
function adopt(root: Document | ShadowRoot, cssText: string): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    return;
  } catch {
    // Pre-2023 engines: fall through to an element.
  }
  const style = document.createElement("style");
  style.textContent = cssText;
  (root instanceof Document ? root.head : root).append(style);
}

/**
 * Register the properties, once, at DOCUMENT level — measured behavior, not a
 * guess: a document-level registration applies to elements inside shadow roots,
 * while an `@property` rule inside a shadow root is ignored entirely, in every
 * engine. Installing it per root would therefore silently do nothing there.
 *
 * Must run before the first computed read, or `calc()`, value validity, and
 * pages whose paragraphs all stay one-line would behave differently depending on
 * whether some other paragraph happened to be enhanced first.
 */
let registered = false;
function registerProperties(): void {
  if (registered) return;
  registered = true;
  adopt(
    document,
    CSS_PROPERTIES.map(
      (property) =>
        `@property ${property}{syntax:"${PROPERTY_SYNTAX[property]}";` +
        `inherits:true;initial-value:auto}`,
    ).join(""),
  );
}

/**
 * The watcher rule: a sub-millisecond transition on our own properties, so a
 * computed value change fires `transitionstart` whatever caused it — media
 * query, container query, class swap, theme toggle, inline edit, or
 * setProperty.
 *
 * Zero specificity via `:where()`, and gated on an attribute only added where
 * nothing would be replaced. Transition lists cannot merge through the cascade,
 * so whoever wins takes the whole declaration: an equal-specificity author rule
 * would otherwise LOSE to this one by source order (adopted sheets sort last)
 * and have its animation silently deleted.
 */
const watcherRule =
  `:where([${WATCH_ATTRIBUTE}]){transition-property:${[
    ...CSS_PROPERTIES,
    ...SCAN_PROPERTIES,
  ].join(",")};transition-duration:1ms;transition-behavior:allow-discrete}`;

/**
 * May the watcher be armed here?
 *
 * Yes when the computed `transition-property` already covers our properties —
 * either because our own rule is in effect (every rescan sees that, since the
 * declaration we installed is the one that computed) or because the author's
 * declaration includes them, in which case their transition carries the signal
 * and nothing needs replacing.
 *
 * Otherwise only the untouched initial value counts as clear. Conservative on
 * purpose: transition lists cannot merge, so an unusual-but-deliberate author
 * declaration must cost liveness on that paragraph rather than cost the author
 * their animation. `data-justif-debug` reports whatever this blocks.
 */
function watcherViable(style: CSSStyleDeclaration): boolean {
  if (style.transitionProperty.includes("--justif-")) return true;
  return style.transitionProperty === "all" && parseFloat(style.transitionDuration) === 0;
}

/**
 * Start watching for this page, or return null where the engine cannot support
 * it — in which case the configuration is read once and `reconfigure()` is the
 * only way to change it.
 *
 * Constructing this registers the properties, so it must happen before the
 * first computed read: otherwise paragraphs would be read under different
 * grammars depending on which one was enhanced first.
 */
export function createWatcher(host: WatchHost): Watcher | null {
  if (!liveUpdatesSupported()) return null;
  registerProperties();

  /** Roots already carrying the watcher rule and its listener. */
  const watchedRoots = new WeakSet<Document | ShadowRoot>();
  let frame = 0;

  /**
   * Coalesce every signal in a burst into one pass, and read only after the
   * watcher's own transition has finished.
   *
   * TWO frames, not one: `transitionstart` fires before the value has moved, and
   * a keyword-valued property interpolates discretely — it flips at the halfway
   * point of the duration. Reading in the first frame can therefore still see
   * the OLD value, which was reproducible in WebKit: the configuration change
   * was detected, then applied from a stale read. One frame is longer than the
   * 1ms transition, so by the second the computed value has settled.
   */
  const scheduleReconcile = (): void => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = 0;
        host.reconcile();
      });
    });
  };

  /**
   * Paragraphs whose author CSS has just changed, and the pass that re-reads them.
   *
   * Coalesced over the same two frames as `scheduleReconcile`, for the same
   * reason: `transitionstart` fires before a discretely-interpolated value has
   * actually moved. The work is then handed to `rescan()`, which compares each
   * paragraph's author styling against what its enhancement was built from — so a
   * burst of events that changes nothing the scan reads (a `font-variant` that
   * was already `normal`, an inherited value re-declared) costs one computed-style
   * read per paragraph and no layout at all.
   */
  const dirty = new Set<HTMLElement>();
  let rescanFrame = 0;
  let echoUntil = 0;
  const scheduleRescan = (el: HTMLElement): void => {
    dirty.add(el);
    if (rescanFrame !== 0) return;
    rescanFrame = requestAnimationFrame(() => {
      rescanFrame = requestAnimationFrame(() => {
        rescanFrame = 0;
        const targets = [...dirty];
        dirty.clear();
        echoUntil = performance.now() + ECHO_WINDOW_MS;
        host.rescan(targets);
      });
    });
  };

  const arm = (el: HTMLElement, style: CSSStyleDeclaration): void => {
    if (!watcherViable(style)) {
      el.removeAttribute(WATCH_ATTRIBUTE);
      if (host.debug) {
        console.info(
          "justif: live updates off for",
          el,
          `— an author transition occupies it (${style.transitionProperty} /` +
            ` ${style.transitionDuration}). Add justif's own properties to that` +
            ` declaration (${[...CSS_PROPERTIES, ...SCAN_PROPERTIES].join(", ")}),` +
            " or call window.justif.reconfigure() after a change.",
        );
      }
      return;
    }
    el.setAttribute(WATCH_ATTRIBUTE, "");
    const root = el.getRootNode();
    if (!(root instanceof Document || root instanceof ShadowRoot)) return;
    if (watchedRoots.has(root)) return;
    watchedRoots.add(root);
    // Plain rules do not pierce shadow boundaries and neither does
    // `transitionstart` — measured in all three engines — so the rule AND the
    // listener are per root, even though the registration above is not.
    adopt(root, watcherRule);
    root.addEventListener("transitionstart", (event) => {
      if (KNOWN_PROPERTIES.has((event as TransitionEvent).propertyName)) scheduleReconcile();
    });
    // Scan inputs are taken at the END of their transition, not the start.
    // Transition events bubble, so this listener sees the page's own animations
    // too, and those have real durations: sampling two frames in (which is right
    // for our own 1ms rule) would re-lay out a paragraph from a value still
    // interpolating, with no later event to correct it. `transitioncancel` counts
    // as an ending — an interrupted transition still leaves a new value.
    for (const type of ["transitionend", "transitioncancel"]) {
      root.addEventListener(type, (event) => {
        const property = (event as TransitionEvent).propertyName;
        if (!isScanProperty(property)) return;
        // Our own check echoing back, not a change to answer.
        if (ECHO_PROPERTIES.has(property) && event.timeStamp < echoUntil) return;
        // Only from a watched paragraph itself. Every property in the set
        // inherits, so a change made above one arrives as its own event on it;
        // an event from anything else is some other element's animation.
        const target = event.target;
        if (!(target instanceof HTMLElement) || !target.hasAttribute(WATCH_ATTRIBUTE)) {
          return;
        }
        scheduleRescan(target);
      });
    }
  };

  return {
    arm,
    cancelPendingReconcile: () => {
      if (frame === 0) return;
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
