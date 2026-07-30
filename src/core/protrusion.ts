import type { ProtrusionCodes, ProtrusionTable } from "./types.js";

/** Every character in `chars` protrudes like `codes` (table-construction
 * shorthand for groups sharing one value). */
const inherit = (codes: ProtrusionCodes, chars: string): Record<string, ProtrusionCodes> =>
  Object.fromEntries(Array.from(chars, (c) => [c, codes]));

/**
 * Non-decomposable shape inheritance: characters whose glyph is (or edge-
 * matches) another letter's but that Unicode NFD cannot reduce — stroked
 * Latin forms plus Cyrillic and Greek homoglyphs. Mirrors microtype's
 * \DeclareCharacterInheritance lists, which map exactly these to their
 * Latin lookalikes.
 */
const SHAPE_BASE: Record<string, string> = {
  // Latin, not decomposable.
  Ł: "L", ł: "l", Đ: "D", đ: "d", Ð: "D", Ø: "O", ø: "o",
  Ŧ: "T", ŧ: "t", Ħ: "H", ħ: "h", Œ: "O", œ: "o", ı: "i", ȷ: "j",
  // Cyrillic capitals sharing Latin edge shapes.
  А: "A", В: "B", С: "C", Е: "E", Ѕ: "S", І: "I", Ј: "J", К: "K",
  М: "M", Н: "H", О: "O", Р: "P", Т: "T", Х: "X", У: "Y",
  // Cyrillic lowercase homoglyphs.
  а: "a", с: "c", е: "e", о: "o", р: "p", х: "x", у: "y", ѕ: "s", і: "i", ј: "j",
  // Greek capitals sharing Latin edge shapes.
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M",
  Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  // Greek lowercase homoglyph.
  ο: "o",
};

const HAS_MARKS = /^\P{M}\p{M}+$/u;
const baseCache = new Map<string, string | null>();

/** One inheritance step: explicit shape base, else NFD accent stripping. */
function baseOf(ch: string): string | null {
  const hit = baseCache.get(ch);
  if (hit !== undefined) return hit;
  let base: string | null = SHAPE_BASE[ch] ?? null;
  if (base === null) {
    const d = ch.normalize("NFD");
    if (d !== ch && HAS_MARKS.test(d)) base = d[0]!;
  }
  baseCache.set(ch, base);
  return base;
}

/**
 * Protrusion codes for `ch` in `table`, following character inheritance:
 * a character without its own entry takes its base letter's (À and
 * Cyrillic А protrude like A; Ё resolves Ё → Е → E). Mirrors microtype's
 * per-font \DeclareCharacterInheritance, applied universally.
 */
export function protrusionCodes(table: ProtrusionTable, ch: string): ProtrusionCodes | undefined {
  let cur: string | null = ch;
  for (let i = 0; i < 3 && cur !== null; i++) {
    const entry = table[cur];
    if (entry !== undefined) return entry;
    cur = baseOf(cur);
  }
  return undefined;
}

/**
 * Default character protrusion table for Latin text, in thousandths of the
 * glyph's own advance (pdfTeX \lpcode/\rpcode semantics — microtype's config
 * files use the same unit). Values are microtype's effective defaults for a
 * font without a bespoke config (its `default` + `T1-default` lists, which
 * cover Unicode text fonts under LuaLaTeX), verified against the \lpcode/
 * \rpcode registers of a live LuaLaTeX run. Merge overrides via the
 * `protrusion` option.
 */
export const latinProtrusion: ProtrusionTable = {
  // Sentence punctuation — the biggest optical wins.
  ".": { r: 700 },
  ",": { r: 500 },
  ":": { r: 500 },
  ";": { r: 300 },
  "!": { r: 100 },
  "?": { r: 100 },

  // Hyphens and dashes.
  "-": { l: 500, r: 500 },
  "‐": { l: 500, r: 500 },
  "–": { l: 200, r: 200 },
  "—": { l: 150, r: 150 },

  // Quotes. Left AND right values on each: some languages mirror their use.
  "‘": { l: 300, r: 400 },
  "’": { l: 300, r: 400 },
  "“": { l: 300, r: 300 },
  "”": { l: 300, r: 300 },
  "‚": { l: 400, r: 400 },
  "„": { l: 400, r: 400 },
  "‹": { l: 400, r: 300 },
  "›": { l: 300, r: 400 },
  "«": { l: 200, r: 200 },
  "»": { l: 200, r: 200 },
  // Straight quotes are not in microtype's defaults (rare in TeX documents,
  // common on the web); values mirror their curly equivalents.
  "'": { l: 300, r: 400 },
  '"': { l: 300, r: 300 },

  // Brackets, symbols, digits with visual slack.
  "(": { l: 100 },
  ")": { r: 200 },
  "{": { l: 400, r: 200 },
  "}": { l: 200, r: 400 },
  "<": { l: 200, r: 100 },
  ">": { l: 100, r: 200 },
  "/": { l: 100, r: 200 },
  "\\": { l: 100, r: 200 },
  _: { l: 100, r: 100 },
  "@": { l: 50, r: 50 },
  "~": { l: 200, r: 250 },
  "%": { l: 50, r: 50 },
  "*": { l: 200, r: 200 },
  "+": { l: 250, r: 250 },
  "¡": { l: 100 },
  "¿": { l: 100 },
  "1": { l: 50, r: 50 },
  "4": { l: 50, r: 50 },
  "7": { l: 50, r: 50 },

  // Diagonal / overhanging capitals.
  A: { l: 50, r: 50 },
  Æ: { l: 50 },
  F: { r: 50 },
  J: { l: 50 },
  K: { r: 50 },
  L: { r: 50 },
  T: { l: 50, r: 50 },
  V: { l: 50, r: 50 },
  W: { l: 50, r: 50 },
  X: { l: 50, r: 50 },
  Y: { l: 50, r: 50 },

  // Lowercase with overhanging terminals.
  k: { r: 50 },
  r: { r: 50 },
  v: { l: 50, r: 50 },
  w: { l: 50, r: 50 },
  x: { l: 50, r: 50 },
  y: { r: 50 },

  // RTL punctuation (pure-RTL paragraph support). Hebrew and Arabic share
  // most ASCII punctuation, which the entries above already cover — table
  // lookup is per character and `l`/`r` are logical line-start/line-end,
  // so a Hebrew period hangs into the LEFT margin automatically. These are
  // the script-specific marks, mirroring their Latin counterparts' values.
  "،": { r: 500 }, // Arabic comma ~ ","
  "؛": { r: 300 }, // Arabic semicolon ~ ";"
  "؟": { r: 100 }, // Arabic question mark ~ "?"
  "۔": { r: 700 }, // Arabic full stop ~ "."
  "־": { l: 500, r: 500 }, // Hebrew maqaf ~ "-"
  "׳": { l: 300, r: 400 }, // Hebrew geresh ~ "'"
  "״": { l: 300, r: 300 }, // Hebrew gershayim ~ '"'

  // Round capitals: a curve meets the margin at one tangent point, so
  // flush-set rounds read as slightly indented. microtype's generic
  // default omits them, but its hand-tuned Garalde configs (EB Garamond,
  // Minion, URW Garamond, Charter) all protrude these. Lowercase rounds
  // are deliberately NOT included: no microtype config protrudes them,
  // and at x-height the corners are below the visibility threshold —
  // adding them measurably worsened break quality in testing.
  O: { l: 50, r: 50 },
  C: { l: 50 },
  G: { l: 50 },
  Q: { l: 50, r: 70 },
};


/**
 * Full-hang character set in the style of classical book typography and
 * CSS `hanging-punctuation`: quotes hang entirely outside the measure at
 * line starts, stops and quotes hang entirely at line ends (brackets do
 * not — see below). `hangingPunctuation` can apply its RIGHT codes only
 * (`"line-end-only"`) or both sides on every line (`"all-line-edges"`), and
 * retains the older `"first-line"` paragraph-opener policy for compatibility.
 * This table may also be passed directly as `protrusion`, where it acts as a
 * user override table rather than selecting a hanging policy.
 *
 * A mark's hang depth belongs to the character, never to where its line
 * falls in the paragraph (see #14): two depths for one mark inside a
 * paragraph read as a misaligned edge rather than as either style.
 */
export const hangingPunctuation: ProtrusionTable = {
  // Stops (CSS force-end).
  ".": { r: 1000 },
  ",": { r: 1000 },
  // Quotes, either role at either edge.
  "'": { l: 1000, r: 1000 },
  '"': { l: 1000, r: 1000 },
  ...inherit({ l: 1000, r: 1000 }, "‘’“”‚„‹›«»"),
  // Brackets are deliberately NOT here, on either side. CSS `first` hangs
  // the whole Ps category, but no print system hangs a bracket more than
  // slightly: measured in Junicode, a line-start "(" hangs 100‰ of its
  // advance in Affinity and 249‰ in InDesign, against microtype's generic
  // 100‰. Leaving them out gives them exactly that ordinary protrusion, the
  // same depth on every line.
  // Burasage (ぶら下げ組み): the ideographic and fullwidth stops hang fully
  // into the right margin — the classical Japanese newspaper/book setting.
  // Their glyphs sit in the left half of a fullwidth advance, so the ink
  // lands just past the margin while the em-box hangs; kinsoku already
  // guarantees they can end a line but never start one.
  "、": { r: 1000 },
  "。": { r: 1000 },
  "，": { r: 1000 },
  "．": { r: 1000 },
};

/**
 * Full-hanging policy layered over the selected protrusion model.
 * `"first-line"` and `"all-lines"` are the original public spellings and
 * remain supported for compatibility.
 */
export type HangingPunctuationMode =
  | false
  | "none"
  | "line-end-only"
  | "all-line-edges"
  | "first-line"
  | "all-lines";

/** Line-start codes that set the full-hang characters FLUSH — the treatment
 * the legacy "first-line" mode gives every line after the first. */
const flushStarts: ProtrusionTable = Object.fromEntries(
  Object.entries(hangingPunctuation)
    .filter(([, codes]) => codes.l !== undefined)
    .map(([ch]) => [ch, { l: 0 }]),
);

/** Overlay one side of `overrides` onto `base`, preserving the other side. */
function applySide(
  base: ProtrusionTable,
  overrides: ProtrusionTable,
  side: "l" | "r",
): ProtrusionTable {
  const out: Record<string, ProtrusionCodes> = { ...base };
  for (const [ch, codes] of Object.entries(overrides)) {
    const v = codes[side];
    if (v !== undefined) out[ch] = { ...out[ch], [side]: v };
  }
  return out;
}

/**
 * Composes the effective protrusion tables from a base table (generic or
 * generic+per-font), the hanging-punctuation mode, and the user's explicit
 * per-char overrides (which always win). Returns the table for lines after
 * the first (`rest`) and for the paragraph's first line (`first`); the two
 * are the SAME object when no first-line distinction exists, so callers
 * can cheaply skip duplicate work.
 */
export function composeProtrusion(
  base: ProtrusionTable,
  user: ProtrusionTable | null,
  hang: HangingPunctuationMode,
): { rest: ProtrusionTable; first: ProtrusionTable } {
  const mode = hang === "all-lines" ? "all-line-edges" : hang;
  let rest = base;
  let first = base;
  if (mode !== false && mode !== "none") {
    rest = applySide(base, hangingPunctuation, "r");
    first = rest;
    if (mode !== "line-end-only") {
      first = applySide(rest, hangingPunctuation, "l");
      if (mode === "all-line-edges") rest = first;
      // The legacy first-line mode hangs the opener, then sets these marks
      // FLUSH at later line starts. Leaving them at their partial optical
      // depth would show one mark at two depths (#14).
      else rest = applySide(rest, flushStarts, "l");
    }
  }
  if (user !== null) {
    const same = first === rest;
    rest = { ...rest, ...user };
    first = same ? rest : { ...first, ...user };
  }
  return { rest, first };
}
