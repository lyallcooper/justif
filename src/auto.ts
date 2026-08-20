/**
 * Drop-in auto-enhancement — the zero-config entry:
 *
 *   <script type="module" src="https://cdn.jsdelivr.net/npm/justif"></script>
 *
 * The page's own CSS decides what gets enhanced: every candidate element
 * whose computed `text-align` is `justify` (the fallback rendering justif
 * recommends anyway) is upgraded in place; nothing else is touched, so
 * adding the script never changes the alignment of anything.
 *
 * Hyphenation follows the page's declared languages: en-US is inlined
 * (English or unlabeled content costs no extra request), and content whose
 * nearest `lang` attribute matches one of the other bundled languages
 * loads that pattern module on demand — a sibling file on the same CDN,
 * one small request per distinct language. Languages we don't bundle (and
 * failed loads, e.g. when only this one file was copied to a static host)
 * justify with spacing only: wrong-language hyphenation is worse than
 * none. For full control use the API: `import { justify } from "justif"`.
 *
 * Typography is configured with `--justif-*` custom properties on the
 * paragraphs, because that is where element-scoped settings belong: the cascade
 * decides precedence, so there is none to invent here. Paragraphs group by
 * language AND resolved configuration, so configuring nothing still costs
 * exactly one controller per language. auto-options.ts owns that surface, and
 * auto-watch.ts is what makes changes to it apply on their own where the
 * engine allows. Which patterns a language wants, and what it costs to get
 * them, is auto-languages.ts.
 *
 * What is left here is the orchestration: grouping the page, starting a
 * controller per group, and reconciling that against what the CSS now says.
 *
 * The script tag carries only what is not element-scoped:
 *   data-justif-selector="article p"   candidate elements (default below)
 *   data-justif-defer                  read the page after the page's own
 *                                      DOMContentLoaded work, not before it
 *
 * Controllers are exposed at `window.justif.controllers` (with `justify`
 * and `unjustify`) as an escape hatch for debugging or teardown, and
 * `window.justif.booted` settles once every group's fonts settled and its
 * layout converged. FULL teardown must await `booted` first: language
 * groups whose patterns load on demand may not have pushed their final
 * controller yet (tearing down an interim-committed group by any route —
 * destroy(), unjustify(), a manual restore — cancels its pending
 * upgrade, but a group that committed no interim has nothing to tear
 * down until its pattern module lands).
 */
import { justify, unjustify } from "./index.js";
import type { LayoutOptions } from "./options.js";
import { hyphenationFor, moduleFor } from "./auto-languages.js";
import { CSS_PROPERTIES, parseCssOptions } from "./auto-options.js";
import { createWatcher } from "./auto-watch.js";

type Controller = ReturnType<typeof justify>;

/** A language-and-configuration group: the unit one controller manages. */
interface Group {
  /** Identity of the (language, configuration) pair. */
  key: string;
  id: string | null;
  options: LayoutOptions;
  els: HTMLElement[];
}

/** A group that has been started. `controller` is null only for an async
 * language group whose pattern module has not landed and that committed no
 * interim layout. */
interface Entry extends Group {
  controller: Controller | null;
}

const DEFAULT_SELECTOR = "p, li, dd, blockquote, figcaption";

declare global {
  interface Window {
    justif?: {
      justify: typeof justify;
      unjustify: typeof unjustify;
      controllers: ReturnType<typeof justify>[];
      /** Settles once every group's fonts have settled and its layout
       * converged. The text is justified earlier — as soon as every
       * group has committed against the fonts rendering at that moment. */
      booted: Promise<void>;
      /**
       * Re-read the `--justif-*` configuration and bring controllers into line
       * with it. Configuration changes normally apply on their own; this is the
       * explicit path for the cases the watcher cannot see — an engine without
       * `@property`, or a paragraph carrying the author's own `transition`
       * declaration, which is never replaced.
       *
       * Resolves once the affected controllers have settled. `booted` keeps its
       * original meaning and does not re-arm: on a page whose configuration
       * changes periodically it would never settle.
       */
      reconfigure: () => Promise<void>;
    };
  }
}

const KNOWN_PROPERTIES = new Set<string>(CSS_PROPERTIES);

/**
 * Under `data-justif-debug`, report `--justif-*` properties we do not recognize.
 * A misspelled custom property is silently ignored by CSS and by us, which is
 * the one failure mode of a string-valued surface that no amount of validation
 * catches — the declaration simply never arrives.
 *
 * Best-effort: whether computed style enumerates custom properties at all is not
 * guaranteed across engines, so this is a diagnostic aid rather than validation.
 */
function reportUnknownProperties(style: CSSStyleDeclaration, el: Element): void {
  try {
    for (let i = 0; i < style.length; i++) {
      const name = style.item(i);
      if (!name.startsWith("--justif-") || KNOWN_PROPERTIES.has(name)) continue;
      console.info("justif: unrecognized property", name, "on", el);
    }
  } catch {
    // Enumeration unsupported: nothing to report, and nothing to fix.
  }
}

/**
 * The public surface, and the one boot behind it.
 *
 * These live outside `boot()` so that `window.justif` is published when this
 * module runs, whenever the boot itself happens (see the bottom of this file).
 * A `data-justif-defer` page reading the global from its own DOMContentLoaded
 * listener — earlier than its boot — finds the same `controllers` array and the
 * same `booted` promise it would find afterwards.
 */
const controllers: Controller[] = [];
let resolveBooted!: () => void;
const booted = new Promise<void>((resolve) => {
  resolveBooted = resolve;
});
/** Set by the boot; absent until then, which is what makes `reconfigure()`
 * a no-op rather than a wait on a boot that may never be asked for. */
let reconfigureImpl: (() => Promise<void>) | null = null;

function boot(): Promise<void> {
  // document.currentScript is null inside module scripts, so configuration
  // is looked up by attribute on whichever script tag carries it.
  const selector =
    document
      .querySelector("script[data-justif-selector]")
      ?.getAttribute("data-justif-selector") ?? DEFAULT_SELECTOR;
  // <script data-justif-debug …>: log one line per paragraph justif
  // declines, with the failing check. Declines are invisible by design —
  // the paragraph keeps its native rendering — which is correct behavior
  // and a terrible debugging experience without this.
  const debug = document.querySelector("script[data-justif-debug]") !== null;
  const onSkip = debug
    ? (p: HTMLElement, reason: string): void => console.info("justif: skipped", p, "—", reason)
    : undefined;

  /** One warning per property-and-value pair: a bad rule hits every paragraph
   * it matches, and a thousand identical lines help nobody. Kept across
   * reconciliations, so a live change does not re-report the same mistake. */
  const warned = new Set<string>();
  /** Paragraphs this loader no longer manages, by any route. Never re-adopted,
   * so a consumer's teardown is not undone by a later configuration change. */
  const released = new WeakSet<Element>();

  let entries: Entry[] = [];

  /**
   * Live updates: `--justif-*` changes reconcile, author-CSS changes rescan.
   * Null where the engine cannot carry the signal (see createWatcher), in
   * which case the configuration is read once and `reconfigure()` is the only
   * way to change it. Constructed before the first computed read — it
   * registers the properties, and every paragraph must be read under the same
   * grammar rather than under whichever one was enhanced first.
   */
  const watcher = createWatcher({
    reconcile: () => reconcile(),
    // Every controller is offered the whole set; each keeps only its own.
    rescan: (targets) => {
      for (const entry of entries) entry.controller?.rescan(targets);
    },
    debug,
  });

  /**
   * Scan the page into (language, configuration) groups. Paragraphs configured
   * identically share one controller: an unconfigured page therefore still gets
   * exactly one per language, and only genuinely different settings add more.
   * Controller count matters — each runs its own patch scheduler with its own
   * forced layout per slice.
   */
  const collectGroups = (): Group[] => {
    const groups = new Map<string, Group>();
    /**
     * Paragraphs already adopted. They have to be recognized by record rather
     * than by computed style: enhancement writes an inline `text-align: left`
     * (the browser must not re-justify our exactly-filled lines), so a managed
     * paragraph no longer computes to `justify` and a rescan would read every
     * one of them as no longer a candidate.
     *
     * The flip side is that a paragraph whose author alignment changes away from
     * `justify` after enhancement is not noticed. That is the same masking, seen
     * from the other direction, and it needs a mechanism of its own.
     */
    const adopted = new Set<Element>();
    for (const entry of entries) {
      for (const el of entry.els) adopted.add(el);
    }
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (released.has(el)) continue;
      // The same declaration answers every question below, so reading the
      // `--justif-*` properties costs no additional style resolution.
      const style = getComputedStyle(el);
      const align = style.textAlign;
      if (!adopted.has(el) && align !== "justify" && align !== "justify-all") continue;
      const id = moduleFor(el.closest("[lang]")?.getAttribute("lang") ?? "");
      const { options, key, invalid } = parseCssOptions((property) =>
        style.getPropertyValue(property),
      );
      for (const { property, value } of invalid) {
        const pair = `${property}:${value}`;
        if (warned.has(pair)) continue;
        warned.add(pair);
        console.warn(`justif: invalid ${property} value "${value}" — using the default`);
      }
      if (debug) reportUnknownProperties(style, el);
      // U+0000 separates the two halves and U+0001 stands in for "no pattern
      // module": neither can appear in a BCP 47 tag or a configuration key, so
      // no language and configuration pair can collide into the wrong group.
      const groupKey = `${id ?? "\u0001"}\u0000${key}`;
      const group = groups.get(groupKey);
      if (group === undefined) groups.set(groupKey, { key: groupKey, id, options, els: [el] });
      else group.els.push(el);
      watcher?.arm(el, style);
    }
    const collected = [...groups.values()];
    if (debug) {
      for (const { id, options, els } of collected) {
        console.info("justif: group", {
          language: id ?? "(unbundled: spacing only)",
          options,
          paragraphs: els.length,
        });
      }
    }
    return collected;
  };

  /** Rewrite the public array in place: it is a documented escape hatch, so a
   * consumer may be holding a reference to the array itself. */
  const syncControllers = (): void => {
    controllers.length = 0;
    for (const entry of entries) {
      if (entry.controller !== null) controllers.push(entry.controller);
    }
  };

  /**
   * Start one group. `allowInterim` is false after boot: an interim layout
   * exists to make FIRST paint justified, and later it would only add a visible
   * change instead of removing one.
   */
  const startGroup = (
    group: Group,
    allowInterim: boolean,
  ): { entry: Entry; settled: Promise<unknown> } => {
    const { id, options, els } = group;
    const { hyphenate, load } = hyphenationFor(id);
    if (load === undefined) {
      // Synchronous fast path — justify() commits before this call
      // returns (against whatever fonts are rendering right now), so a
      // render-blocking script tag puts justified text in the first
      // frame the page ever paints. Only languages needing a
      // pattern-module fetch go async.
      const controller = justify(els, { ...options, hyphenate, onSkip });
      return { entry: { ...group, controller }, settled: Promise.resolve() };
    }
    // Pattern modules arrive by dynamic import, which nothing — not
    // even a render-blocking script tag — can hold first paint for.
    // While NOTHING HAS PAINTED yet, commit an interim UNHYPHENATED
    // layout now so what first appears is justified; the patterns
    // re-justify on arrival (destroy + justify in one task — a single
    // visible change, and only on lines that gain a hyphen). Once a
    // paint has happened the interim would ADD a visible change
    // instead of removing one, so it is skipped.
    const unpainted = allowInterim && performance.getEntriesByType("paint").length === 0;
    const interim: Controller | null = unpainted ? justify(els, { ...options, onSkip }) : null;
    const entry: Entry = { ...group, controller: interim };
    const settled = load().then((loaded) => {
      // Torn down while the patterns were in flight — by ANY route:
      // controller.destroy(), unjustify(), a manual restore. The
      // elements carry no enhancement, so re-enhancing would undo the
      // consumer's teardown. (An interim that enhanced nothing because
      // every paragraph bailed lands here too; the fresh controller
      // would only bail identically.)
      //
      // Ask the controller, not the DOM: a paragraph held in native
      // one-line layout is still managed but carries no `data-justif`, so
      // testing the attribute read a group that merely all fits on one line
      // as fully torn down — and it never received its hyphenator.
      if (interim !== null && interim.managed.length === 0) return;
      // Superseded by a reconciliation while the patterns were in flight: this
      // entry no longer describes the page.
      if (!entries.includes(entry)) return;
      // The patterns did not load — only this one file copied to a static
      // host, say. The interim (spacing-only) IS the final rendering then, so
      // replacing it would rewrite identical output.
      if (loaded === undefined && interim !== null) return;
      interim?.destroy();
      entry.controller = justify(els, { ...entry.options, hyphenate: loaded, onSkip });
      syncControllers();
    });
    return { entry, settled };
  };

  /**
   * Bring controllers into line with what the CSS now says.
   *
   * Signals may over-fire: the response is a read and a comparison, so a
   * spurious wake-up costs a style read in a frame that was already
   * recalculating — not a re-layout. Under-firing is the only real failure.
   */
  const reconcile = (): void => {
    const target = collectGroups();
    const unmatched = new Map(target.map((group) => [group.key, group]));
    const kept: Entry[] = [];
    const orphaned: Entry[] = [];
    for (const entry of entries) {
      const wanted = unmatched.get(entry.key);
      // Same key and same membership: this group resolved identically, so its
      // controller is already correct and keeps its scan, observers and caches.
      if (wanted !== undefined && sameElements(entry.els, wanted.els)) {
        unmatched.delete(entry.key);
        kept.push(entry);
      } else {
        orphaned.push(entry);
      }
    }
    // An orphan whose membership survived intact only changed configuration:
    // reuse its controller, which is far cheaper than a rescan. Membership is
    // the criterion because a controller cannot gain or lose paragraphs.
    const reused: Entry[] = [];
    for (const [key, group] of [...unmatched]) {
      const at = orphaned.findIndex((entry) => sameElements(entry.els, group.els));
      if (at < 0) continue;
      const entry = orphaned.splice(at, 1)[0]!;
      entry.key = key;
      entry.options = group.options;
      entry.controller?.applyLayoutOptions(group.options);
      reused.push(entry);
      unmatched.delete(key);
    }
    // Whatever is left really did regroup — split, merged, or no longer a
    // candidate — and those paragraphs need a fresh scan. Tear the old
    // controllers down and let the target grouping rebuild them.
    for (const entry of orphaned) entry.controller?.destroy();
    entries = [...kept, ...reused];
    for (const group of unmatched.values()) entries.push(startGroup(group, false).entry);
    syncControllers();
    // Standard CSS too, not just the `--justif-*` surface: a class swap or theme
    // toggle usually moves both, and this makes reconfigure() the single manual
    // call for everything — the one that matters where liveness is unavailable.
    // Free where nothing changed: rescan() compares before it re-reads. Last, so
    // the paragraphs it re-enhances are built with the configuration just applied.
    for (const entry of entries) entry.controller?.rescan();
  };

  /** One entry per group: settles once the group's FINAL controller
   * exists (pattern module loaded and applied, or not needed). */
  const settled: Promise<unknown>[] = [];
  for (const group of collectGroups()) {
    const started = startGroup(group, true);
    entries.push(started.entry);
    settled.push(started.settled);
  }
  syncControllers();

  // `booted`: final controllers in place, fonts settled, layouts
  // converged. allSettled — one group's failure must not block the rest.
  void Promise.allSettled(settled)
    .then(() => Promise.allSettled(controllers.map((c) => c.ready)))
    .then(resolveBooted);
  reconfigureImpl = (): Promise<void> => {
    // A paragraph this loader still lists but the controller no longer manages
    // was torn down from outside. Record that before re-reading, so the
    // reconciliation below does not re-adopt it.
    for (const entry of entries) {
      const managed = new Set<Element>(entry.controller?.managed ?? []);
      for (const el of entry.els) {
        if (!managed.has(el)) released.add(el);
      }
    }
    watcher?.cancelPendingReconcile();
    reconcile();
    return Promise.allSettled(controllers.map((c) => c.ready)).then(() => undefined);
  };
  return booted;
}

/** Same paragraphs in the same order. The order is the loader's own scan order,
 * so it is stable between scans. */
function sameElements(a: readonly Element[], b: readonly Element[]): boolean {
  return a.length === b.length && a.every((el, i) => el === b[i]);
}

// Published when this module runs, not by the boot: with `data-justif-defer`
// the boot is later, and a page reading the global before then must find the
// same objects the boot fills in.
window.justif = {
  justify,
  unjustify,
  controllers,
  booted,
  reconfigure: () => reconfigureImpl?.() ?? Promise.resolve(),
};

/**
 * WHEN the page is read, and the one reason to change it.
 *
 * By DEFAULT: now, synchronously, while this module executes. A module script
 * runs after parsing, when `readyState` is already "interactive", so this is
 * before DOMContentLoaded — and, with `blocking="render"` on the tag, inside
 * the window where the browser has not painted yet. That is what makes the
 * first painted frame the final one (test-e2e/noshift.spec.ts), and it is worth
 * defending: measured, the enhancement lands ~5ms before first contentful paint
 * on a fast load and on a throttled one alike.
 *
 * The cost is that a page whose OWN script rewrites the text — a math renderer
 * like KaTeX, a syntax highlighter, a translation pass — must have finished by
 * now, because justif reads a paragraph once and then owns its DOM. Script tag
 * order settles it for free: deferred scripts execute in document order, so a
 * transform whose tags come before this one, rendering from its own `onload`,
 * has always run first. A transform in a `DOMContentLoaded` listener has NOT,
 * whatever the order, because that event is after every deferred script.
 *
 * `data-justif-defer` is for that page: it moves the read to one task after the
 * DOMContentLoaded dispatch, which is after every deferred script, after the
 * `onload` handlers those tags carry, and after every DOMContentLoaded
 * listener, registered before or after this module. Verified in Chromium,
 * Firefox and WebKit. What it does NOT outlast is a listener that defers its own
 * work into a task of its own: two timers run in the order they were queued, and
 * this one is queued from a listener. It also gives up the first-frame guarantee
 * above — the browser may paint native justification and reflow — which is why
 * it is opt-in and not the default.
 *
 * Deferring waits on the event rather than queuing a task straight away, which
 * would look equivalent and is not: a deferred script still downloading makes
 * the parser yield, and a task queued now would then beat the very script it is
 * meant to follow. `load` is watched too, since a module injected after
 * DOMContentLoaded has already missed it and `readyState` cannot say whether it
 * has fired. Booting is idempotent, so whichever signal arrives first wins.
 *
 * Content that arrives later still — an async script that lands after the
 * event, a fetch, a client-rendered view — is the API's job: `justify()` it
 * when it is ready.
 */
let booting: Promise<void> | null = null;
const start = (): void => {
  booting ??= boot();
};
const startAfterDispatch = (): void => {
  setTimeout(start, 0);
};

if (document.querySelector("script[data-justif-defer]") !== null) {
  if (document.readyState === "complete") startAfterDispatch();
  else {
    document.addEventListener("DOMContentLoaded", startAfterDispatch, { once: true });
    window.addEventListener("load", startAfterDispatch, { once: true });
  }
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
