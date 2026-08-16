/**
 * Which hyphenation patterns a paragraph's language wants, and how to get them.
 *
 * Three answers, and the difference between them is what decides whether a
 * group can be enhanced synchronously. English and unlabeled content use the
 * inlined en-US patterns and cost no request; another bundled language costs
 * one dynamic import of a sibling file; a language justif does not bundle gets
 * no hyphenation at all, because wrong-language hyphenation is worse than none.
 *
 * Only `auto.ts` imports this; it is bundled into the drop-in rather than
 * shipped as its own file.
 */

import { hyphenateEnUS } from "./hyphenation/en-us.js";

/** A word splitter, in the shape `justify()`'s `hyphenate` option takes. */
export type Hyphenate = (word: string) => string[];

/** Languages with a bundled pattern module (dist/hyphenate/<id>.js). */
const BUNDLED = new Set([
  "ca", "da", "de", "el", "es", "fi", "fr", "hr", "hu", "it",
  "nb", "nl", "nn", "pl", "pt", "ru", "sk", "sl", "sv", "tr", "uk",
]);

/**
 * BCP 47 tag → bundled module id. "en-us" means the inlined en-US
 * hyphenator; null means hyphenation off (unbundled language).
 */
export function moduleFor(lang: string): string | null {
  const norm = lang.toLowerCase().replace(/_/g, "-");
  // Unlabeled content defaults to English — the pragmatic drop-in choice.
  if (norm === "") return "en-us";
  if (norm === "en-gb") return "en-gb";
  if (norm === "en" || norm.startsWith("en-")) return "en-us";
  const primary = norm.split("-")[0]!;
  if (primary === "no") return "nb"; // plain "no" → Bokmål patterns
  return BUNDLED.has(primary) ? primary : null;
}

/** How a group gets its hyphenator — and whether it has to wait for one. */
export interface Hyphenation {
  /** What to enhance with right now: the inlined en-US hyphenator, or
   * undefined for a language with no bundled patterns (spacing only).
   * Present, possibly undefined, exactly when `load` is absent. */
  hyphenate?: Hyphenate;
  /** Present only for a bundled pattern module, which nothing — not even a
   * render-blocking script tag — can supply without a fetch. Resolves
   * undefined if the load fails, which is spacing only. */
  load?: () => Promise<Hyphenate | undefined>;
}

export function hyphenationFor(id: string | null): Hyphenation {
  if (id === null) return {};
  if (id === "en-us") return { hyphenate: hyphenateEnUS };
  return { load: () => loadPatterns(id) };
}

async function tryImport(specifier: string): Promise<Hyphenate | undefined> {
  try {
    const m = (await import(specifier)) as Record<string, Hyphenate>;
    // Each language module has exactly one export: its hyphenate function.
    return Object.values(m)[0];
  } catch {
    return undefined;
  }
}

async function loadPatterns(id: string): Promise<Hyphenate | undefined> {
  // Resolved relative to the DROP-IN BUNDLE this file is compiled into —
  // dist/auto.js, so dist/hyphenate/<id>.js — present wherever the whole
  // package is served (npm CDNs, node_modules). The specifier is built as a
  // plain variable so bundlers (esbuild included) keep the import dynamic
  // instead of trying to glob-resolve it.
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
