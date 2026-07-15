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
 * and `unjustify`) as an escape hatch for debugging or teardown.
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

async function boot(): Promise<void> {
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
  await Promise.all(
    [...groups].map(async ([id, els]) => {
      controllers.push(justify(els, { hyphenate: await hyphenatorFor(id), onSkip }));
    }),
  );
  window.justif = { justify, unjustify, controllers };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot(), { once: true });
} else {
  void boot();
}
