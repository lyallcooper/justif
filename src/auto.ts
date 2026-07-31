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
 * Typography is configured in CSS, on the paragraphs themselves, because that
 * is where element-scoped settings belong — one selector configures a section,
 * the cascade decides precedence, and an inline style handles a one-off:
 *
 *   :root      { --justif-tracking: none; --justif-last-line-min-width: 50%; }
 *   blockquote { --justif-hanging-punctuation: none; }
 *
 * Values are ordinary CSS keywords and percentages; `auto` means the library
 * default. Paragraphs are grouped by language AND resolved configuration, so
 * configuring nothing still costs exactly one controller per language. See
 * auto-options.ts for the full surface.
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
import { CSS_PROPERTIES, parseCssOptions } from "./auto-options.js";

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

  /**
   * One controller per (language, configuration) pair. Paragraphs configured
   * identically share one: an unconfigured page therefore still gets exactly one
   * controller per language, and only genuinely different settings add more.
   * Controller count matters — each runs its own patch scheduler with its own
   * forced layout per slice.
   */
  const groups = new Map<string, { id: string | null; options: LayoutOptions; els: Element[] }>();
  /** One warning per property-and-value pair: a bad rule hits every paragraph
   * it matches, and a thousand identical lines help nobody. */
  const warned = new Set<string>();
  for (const el of document.querySelectorAll(selector)) {
    // The same declaration answers both questions, so reading the `--justif-*`
    // properties costs no additional style resolution.
    const style = getComputedStyle(el);
    const align = style.textAlign;
    if (align !== "justify" && align !== "justify-all") continue;
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
    if (group === undefined) groups.set(groupKey, { id, options, els: [el] });
    else group.els.push(el);
  }
  if (debug) {
    for (const { id, options, els } of groups.values()) {
      console.info("justif: group", {
        language: id ?? "(unbundled: spacing only)",
        options,
        paragraphs: els.length,
      });
    }
  }

  const controllers: ReturnType<typeof justify>[] = [];
  /** One entry per group: settles once the group's FINAL controller
   * exists (pattern module loaded and applied, or not needed). */
  const settled: Promise<unknown>[] = [];
  for (const { id, options, els } of groups.values()) {
    if (id === null || id === "en-us") {
      // Synchronous fast path — justify() commits before this call
      // returns (against whatever fonts are rendering right now), so a
      // render-blocking script tag puts justified text in the first
      // frame the page ever paints. Only languages needing a
      // pattern-module fetch go async.
      const c = justify(els, {
        ...options,
        hyphenate: id === null ? undefined : hyphenateEnUS,
        onSkip,
      });
      controllers.push(c);
      settled.push(Promise.resolve());
    } else {
      // Pattern modules arrive by dynamic import, which nothing — not
      // even a render-blocking script tag — can hold first paint for.
      // While NOTHING HAS PAINTED yet, commit an interim UNHYPHENATED
      // layout now so what first appears is justified; the patterns
      // re-justify on arrival (destroy + justify in one task — a single
      // visible change, and only on lines that gain a hyphen). Once a
      // paint has happened the interim would ADD a visible change
      // instead of removing one, so it is skipped.
      const unpainted = performance.getEntriesByType("paint").length === 0;
      const interim: ReturnType<typeof justify> | null = unpainted
        ? justify(els, { ...options, onSkip })
        : null;
      if (interim !== null) controllers.push(interim);
      const final = hyphenatorFor(id).then((hyphenate) => {
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
        // Unbundled language: the interim (spacing-only) IS the final
        // rendering — replacing it would rewrite identical output.
        if (hyphenate === undefined && interim !== null) return;
        if (interim !== null) {
          const at = controllers.indexOf(interim);
          if (at >= 0) controllers.splice(at, 1);
          interim.destroy();
        }
        controllers.push(justify(els, { ...options, hyphenate, onSkip }));
      });
      settled.push(final);
    }
  }
  // `booted`: final controllers in place, fonts settled, layouts
  // converged. allSettled — one group's failure must not block the rest.
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
