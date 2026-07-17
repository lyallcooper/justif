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
 * Optional overrides on the script tag:
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
 * down until its pattern module lands). No-flash cooperation: a page may hide its text under
 * an `html.justif-pending` CSS rule — added by an inline head snippet
 * that MUST carry its own removal timeout, since a failed script load
 * would otherwise leave the content hidden forever; the class is removed
 * as soon as every group has committed (earlier than `booted`), so the
 * revealed frame is already justified.
 */
import { justify, unjustify } from "./index.js";
import { hyphenateEnUS } from "./hyphenation/en-us.js";

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
       * converged. The text is justified (and any `justif-pending` hide
       * class removed) earlier — as soon as every group has committed
       * against the fonts rendering at that moment. */
      booted: Promise<void>;
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

/** Tier-2 no-flash reveal: pages may hide candidate text under an
 * `html.justif-pending` rule (set by an inline head snippet that carries
 * its own timeout escape); the class comes off once the initial
 * enhancement has committed, so the reveal frame is already justified. */
function revealPending(): void {
  document.documentElement.classList.remove("justif-pending");
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

  const groups = new Map<string | null, Element[]>();
  for (const el of document.querySelectorAll(selector)) {
    const align = getComputedStyle(el).textAlign;
    if (align !== "justify" && align !== "justify-all") continue;
    const id = moduleFor(el.closest("[lang]")?.getAttribute("lang") ?? "");
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [el]);
    else group.push(el);
  }

  const controllers: ReturnType<typeof justify>[] = [];
  /** One entry per group: settles once the group has a justified layout
   * in the DOM (an interim counts) — this is what lifts justif-pending. */
  const committed: Promise<unknown>[] = [];
  /** One entry per group: settles once the group's FINAL controller
   * exists (pattern module loaded and applied, or not needed). */
  const settled: Promise<unknown>[] = [];
  for (const [id, els] of groups) {
    if (id === null || id === "en-us") {
      // Synchronous fast path — justify() commits before this call
      // returns (against whatever fonts are rendering right now), so a
      // render-blocking script tag puts justified text in the first
      // frame the page ever paints. Only languages needing a
      // pattern-module fetch go async.
      const c = justify(els, { hyphenate: id === null ? undefined : hyphenateEnUS, onSkip });
      controllers.push(c);
      committed.push(Promise.resolve());
      settled.push(Promise.resolve());
    } else {
      // Pattern modules arrive by dynamic import, which nothing — not
      // even a render-blocking script tag — can hold first paint for.
      // While the content is not yet VISIBLE (nothing painted, or hidden
      // under justif-pending), commit an interim UNHYPHENATED layout now
      // so what first appears is justified; the patterns re-justify on
      // arrival (destroy + justify in one task — a single visible
      // change, and only on lines that gain a hyphen). Once the content
      // is visible the interim would ADD a visible change instead of
      // removing one, so it is skipped.
      const invisible =
        performance.getEntriesByType("paint").length === 0 ||
        document.documentElement.classList.contains("justif-pending");
      const interim: ReturnType<typeof justify> | null = invisible
        ? justify(els, { onSkip })
        : null;
      if (interim !== null) {
        controllers.push(interim);
        committed.push(Promise.resolve());
      }
      const final = hyphenatorFor(id).then((hyphenate) => {
        // Torn down while the patterns were in flight — by ANY route:
        // controller.destroy(), unjustify(), a manual restore. The
        // elements carry no enhancement, so re-enhancing would undo the
        // consumer's teardown. (An interim that enhanced nothing because
        // every paragraph bailed lands here too; the fresh controller
        // would only bail identically.)
        if (interim !== null && !els.some((el) => el.hasAttribute("data-justif"))) return;
        // Unbundled language: the interim (spacing-only) IS the final
        // rendering — replacing it would rewrite identical output.
        if (hyphenate === undefined && interim !== null) return;
        if (interim !== null) {
          const at = controllers.indexOf(interim);
          if (at >= 0) controllers.splice(at, 1);
          interim.destroy();
        }
        controllers.push(justify(els, { hyphenate, onSkip }));
      });
      settled.push(final);
      if (!invisible) committed.push(final);
    }
  }
  // Reveal as soon as every group has a justified layout on the page —
  // what first becomes visible is already justified even while pattern
  // modules are still in flight. allSettled: one group's failure must
  // neither block the reveal nor hide the others' committed text. On the
  // synchronous path these promises are already settled, so the reveal
  // lands in this same task's microtask checkpoint — still ahead of the
  // next paint. `booted` settles later: final controllers in place,
  // fonts settled, layouts converged.
  void Promise.allSettled(committed).then(revealPending);
  const booted = Promise.allSettled(settled).then(() =>
    Promise.allSettled(controllers.map((c) => c.ready)).then(() => undefined),
  );
  window.justif = { justify, unjustify, controllers, booted };
  return booted;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
} else {
  void boot();
}
