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
 * exactly one controller per language. auto-options.ts owns that surface;
 * changes to it apply on their own where the engine allows, which
 * `liveUpdatesSupported` gates and `armWatcher` sets up.
 *
 * The script tag carries only what is not element-scoped:
 *   data-justif-selector="article p"   candidate elements (default below)
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
import { type LayoutOptions, justify, unjustify } from "./index.js";
import { hyphenateEnUS } from "./hyphenation/en-us.js";
import { CSS_PROPERTIES, PROPERTY_SYNTAX, parseCssOptions } from "./auto-options.js";

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

/** Languages with a bundled pattern module (dist/hyphenate/<id>.js). */
const BUNDLED = new Set([
  "ca", "da", "de", "el", "es", "fi", "fr", "hr", "hu", "it",
  "nb", "nl", "nn", "pl", "pt", "ru", "sk", "sl", "sv", "tr", "uk",
]);

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

/**
 * BCP 47 tag → bundled module id. "en-us" means the inlined en-US
 * hyphenator; null means hyphenation off (unbundled language).
 */
function moduleFor(lang: string): string | null {
  const norm = lang.toLowerCase().replace(/_/g, "-");
  // Unlabeled content defaults to English — the pragmatic drop-in choice.
  if (norm === "") return "en-us";
  if (norm === "en-gb") return "en-gb";
  if (norm === "en" || norm.startsWith("en-")) return "en-us";
  const primary = norm.split("-")[0]!;
  if (primary === "no") return "nb"; // plain "no" → Bokmål patterns
  return BUNDLED.has(primary) ? primary : null;
}

async function tryImport(specifier: string): Promise<((w: string) => string[]) | undefined> {
  try {
    const m = (await import(specifier)) as Record<string, (w: string) => string[]>;
    // Each language module has exactly one export: its hyphenate function.
    return Object.values(m)[0];
  } catch {
    return undefined;
  }
}

async function hyphenatorFor(id: string | null): Promise<((w: string) => string[]) | undefined> {
  if (id === null) return undefined;
  if (id === "en-us") return hyphenateEnUS;
  // Resolved relative to THIS file: dist/hyphenate/<id>.js — present
  // wherever the whole package is served (npm CDNs, node_modules). The
  // specifier is built as a plain variable so bundlers (esbuild included)
  // keep the import dynamic instead of trying to glob-resolve it.
  // Bare package CDN URLs (https://cdn.jsdelivr.net/npm/justif) serve this
  // module in place WITHOUT redirecting to its file path, so a sibling-
  // relative import would resolve a directory too high (/npm/hyphenate/…).
  // There the module's own URL *is* the package root — checked FIRST (by
  // the URL not looking like a .js file) so the common case never logs a
  // 404 in the adopter's console.
  const base = import.meta.url.replace(/[?#].*$/, "");
  if (!/\.[cm]?js$/.test(base)) {
    return tryImport(base + "/dist/hyphenate/" + id + ".js");
  }
  return tryImport("./hyphenate/" + id + ".js"); // undefined → spacing only
}

const KNOWN_PROPERTIES = new Set<string>(CSS_PROPERTIES);

/**
 * The standard properties a paragraph's SCAN depends on, watched the same way the
 * `--justif-*` configuration is: each one fires `transitionstart` under
 * `transition-behavior: allow-discrete` in all three engines (verified — several
 * are non-animatable in the older sense and carry only because interpolation is
 * discrete), so a change to any of them reaches `controller.rescan()`.
 *
 * Named individually rather than through `all`: `all` would fire on every
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
 * The watcher: a sub-millisecond transition on our own properties, so a computed
 * value change fires `transitionstart` whatever caused it — media query,
 * container query, class swap, theme toggle, inline edit, or setProperty.
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

  const live = liveUpdatesSupported();
  // Before the first computed read, so every paragraph is read under the same
  // grammar instead of depending on which one was enhanced first.
  if (live) registerProperties();

  /** One warning per property-and-value pair: a bad rule hits every paragraph
   * it matches, and a thousand identical lines help nobody. Kept across
   * reconciliations, so a live change does not re-report the same mistake. */
  const warned = new Set<string>();
  /** Paragraphs this loader no longer manages, by any route. Never re-adopted,
   * so a consumer's teardown is not undone by a later configuration change. */
  const released = new WeakSet<Element>();
  /** Roots already carrying the watcher rule and its listener. */
  const watchedRoots = new WeakSet<Document | ShadowRoot>();

  let entries: Entry[] = [];
  const controllers: Controller[] = [];
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
        reconcile();
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
  const scheduleRescan = (el: HTMLElement): void => {
    dirty.add(el);
    if (rescanFrame !== 0) return;
    rescanFrame = requestAnimationFrame(() => {
      rescanFrame = requestAnimationFrame(() => {
        rescanFrame = 0;
        const targets = [...dirty];
        dirty.clear();
        // Every controller is offered the whole set; each keeps only its own.
        for (const entry of entries) entry.controller?.rescan(targets);
      });
    });
  };

  /**
   * Make one paragraph watchable: preflight its transition longhands, mark it
   * only if nothing would be replaced, and ensure its root carries the rule and
   * the listener. Re-run on every scan, which is what notices an author
   * transition introduced after boot.
   */
  const armWatcher = (el: HTMLElement, style: CSSStyleDeclaration): void => {
    if (!watcherViable(style)) {
      el.removeAttribute(WATCH_ATTRIBUTE);
      if (debug) {
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
      const property = (event as TransitionEvent).propertyName;
      if (KNOWN_PROPERTIES.has(property)) {
        scheduleReconcile();
        return;
      }
      // Anything else our rule transitions is a scan input. The target is the
      // watched paragraph itself — the rule is not inherited, so a descendant
      // cannot be the source — and every property here inherits, so a change made
      // anywhere above it arrives as its own event.
      if (property.startsWith("--") || !(event.target instanceof HTMLElement)) return;
      scheduleRescan(event.target);
    });
  };

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
      if (live) armWatcher(el, style);
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
    if (id === null || id === "en-us") {
      // Synchronous fast path — justify() commits before this call
      // returns (against whatever fonts are rendering right now), so a
      // render-blocking script tag puts justified text in the first
      // frame the page ever paints. Only languages needing a
      // pattern-module fetch go async.
      const controller = justify(els, {
        ...options,
        hyphenate: id === null ? undefined : hyphenateEnUS,
        onSkip,
      });
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
    const settled = hyphenatorFor(id).then((hyphenate) => {
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
      // Unbundled language: the interim (spacing-only) IS the final
      // rendering — replacing it would rewrite identical output.
      if (hyphenate === undefined && interim !== null) return;
      interim?.destroy();
      entry.controller = justify(els, { ...entry.options, hyphenate, onSkip });
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
  const booted = Promise.allSettled(settled).then(() =>
    Promise.allSettled(controllers.map((c) => c.ready)).then(() => undefined),
  );
  window.justif = {
    justify,
    unjustify,
    controllers,
    booted,
    reconfigure(): Promise<void> {
      // A paragraph this loader still lists but the controller no longer manages
      // was torn down from outside. Record that before re-reading, so the
      // reconciliation below does not re-adopt it.
      for (const entry of entries) {
        const managed = new Set<Element>(entry.controller?.managed ?? []);
        for (const el of entry.els) {
          if (!managed.has(el)) released.add(el);
        }
      }
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      reconcile();
      return Promise.allSettled(controllers.map((c) => c.ready)).then(() => undefined);
    },
  };
  return booted;
}

/** Same paragraphs in the same order. The order is the loader's own scan order,
 * so it is stable between scans. */
function sameElements(a: readonly Element[], b: readonly Element[]): boolean {
  return a.length === b.length && a.every((el, i) => el === b[i]);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
} else {
  void boot();
}
