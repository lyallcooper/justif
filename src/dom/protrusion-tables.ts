/**
 * Composing the protrusion table a font actually gets.
 *
 * Four sources can contribute, and they compose rather than override: the
 * generic Latin table, a hand-tuned per-font config where one exists, the
 * font's own MEASURED optical alignment (rasterized glyph geometry, when the
 * engine will give it up), and the caller's explicit per-character overrides,
 * which win over all of it. On top of that sits the hanging-punctuation
 * overlay, which is a separate decision — a mark may hang fully at a line
 * edge whether or not the protrusion model is switched on at all.
 *
 * Memoized per settings object rather than globally: two live controllers
 * with different settings must not evict each other, and a destroyed one's
 * tables should become collectable. The cache is weakly keyed for exactly
 * that, and `applyLayoutOptions` replaces the settings object, so a
 * reconfiguration re-composes without anything having to invalidate.
 */

import {
  composeProtrusion,
  type HangingCharacters,
  type HangingPunctuationMode,
  latinProtrusion,
} from "../core/protrusion.js";
import { fontProtrusion } from "../core/protrusion-fonts.js";
import type { ProtrusionTable } from "../core/types.js";
import type { FontSpec } from "./measure.js";
import { opticalCandidates, opticalFontKey, opticalProtrusion } from "./optical.js";

/**
 * Per-family protrusion tables under one controller's protrusion settings.
 * Keyed by the CSS family list; the cache is invalidated whenever the
 * settings object identity changes, which happens once per controller.
 */
export interface ProtrusionSettings {
  enabled: boolean;
  /** The protrusion model contributes a base table. With it off, the hang
   * overlays compose over an empty base: flush glyphs, hanging marks. */
  model: boolean;
  measured: boolean;
  user: ProtrusionTable | null;
  hang: HangingPunctuationMode;
  characters: HangingCharacters;
}
type ComposedTables =
  | { rest: ProtrusionTable; first?: ProtrusionTable; credit?: ProtrusionTable }
  | null;
/** Weakly keyed on the settings object, so two live controllers don't evict
 * each other and a destroyed one's tables are collectable. */
let composedBySettings = new WeakMap<ProtrusionSettings, Map<string, ComposedTables>>();

/**
 * Drop every composed table. Needed alongside `clearOpticalCache` on a font
 * change: these are built FROM measured tables, and a controller's settings
 * object outlives the fonts, so clearing only the measurement would leave the
 * stale composition in front of it.
 */
export function clearComposedProtrusionCache(): void {
  composedBySettings = new WeakMap();
}

/**
 * The generic table minus every character the raster pass forms an opinion
 * about — i.e. exactly the entries a measured table can never contain, such
 * as the Arabic and Hebrew stops. Computed once; the two tables are module
 * constants.
 */
let unmeasured: ProtrusionTable | undefined;
function unmeasuredProtrusion(): ProtrusionTable {
  if (unmeasured !== undefined) return unmeasured;
  const considered = new Set(opticalCandidates);
  unmeasured = Object.fromEntries(
    Object.entries(latinProtrusion).filter(([ch]) => !considered.has(ch)),
  );
  return unmeasured;
}

export function composedForFamily(
  spec: FontSpec,
  settings: ProtrusionSettings | undefined,
): ComposedTables {
  if (settings === undefined || !settings.enabled) return null;
  let composedCache = composedBySettings.get(settings);
  if (composedCache === undefined) {
    composedCache = new Map();
    composedBySettings.set(settings, composedCache);
  }
  const family = spec.family;
  // Measured tables describe a GLYPH SET, not a family: small caps, italics and
  // weights are different shapes and measure differently, so this cache must
  // key on everything the measurement keys on or it serves one variant's table
  // for another.
  const key = opticalFontKey(spec);
  const hit = composedCache.get(key);
  if (hit !== undefined) return hit;
  // Measured values describe THIS font, so within the range the measurement
  // CONSIDERED they replace the generic table and the per-font configs both —
  // a zero there means "this glyph needs no hang", not "no opinion", and must
  // not be back-filled from a table tuned for other faces. Characters the
  // measurement never looked at are a different matter: the generic table
  // carries entries the raster pass has no candidate for, notably the Arabic
  // and Hebrew stops that make pure-RTL paragraphs work.
  //
  // A user table deliberately selects the table-backed path instead: generic
  // values, then the matching hand-tuned font table, then the user's
  // overrides. Besides being an escape hatch for faces where hand tuning wins,
  // this avoids canvas pixel readback and keeps the chosen values stable across
  // browser engines.
  //
  // With the model off (`protrusion: false`) there is no base at all: only the
  // hang overlays land, so ordinary glyphs sit exactly flush while the eligible
  // marks still hang. Nothing here measures in that case — the raster pass is
  // the model's, and skipping it is most of what `protrusion: false` buys.
  let base: ProtrusionTable = {};
  if (settings.model) {
    // Pure-RTL paragraphs take the table-backed path: every character the raster
    // pass forms an opinion about is Latin, so measuring buys such a paragraph
    // nothing — while the script-specific stops it does NOT examine are exactly
    // what the built-in tables carry for it. Measured on CI, where `serif`
    // resolves to a face with no Arabic at all: the measured path left an Arabic
    // question mark sitting inside the margin.
    const measured =
      settings.measured && spec.direction !== "rtl" ? opticalProtrusion(spec) : undefined;
    base =
      measured !== undefined
        ? { ...unmeasuredProtrusion(), ...measured }
        : { ...latinProtrusion, ...fontProtrusion(family) };
  }
  const composed = composeProtrusion(base, settings.user, settings.hang, settings.characters);
  const tables: ComposedTables = {
    rest: composed.rest,
    first: composed.first !== composed.rest ? composed.first : undefined,
    credit: composed.credit,
  };
  composedCache.set(key, tables);
  return tables;
}