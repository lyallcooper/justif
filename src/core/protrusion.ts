import type { ProtrusionCodes, ProtrusionTable } from "./types.js";

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
 * The characters hanging punctuation treats as MARGINAL — not part of the
 * text's rectangle — in the style of classical book typography and CSS
 * `hanging-punctuation`. Membership, and nothing else: hanging is a
 * classification, so a character is either outside the measure or it is not.
 * How far a mark sits from the margin when it is NOT hung is a question for
 * the protrusion model, which is the other feature entirely.
 *
 * Quotes are marginal in either role at either edge; stops only at line ends.
 * `HangingPunctuationMode` then says WHERE the classification applies — line
 * ends alone, plus the paragraph opener (the CSS `first` model), or every line
 * edge — and a mark's membership never varies with where its line falls in the
 * paragraph (see #14): one mark at two depths inside a paragraph reads as a
 * misaligned edge rather than as either style.
 *
 * Brackets are deliberately absent, on either side. CSS `first` hangs the whole
 * Ps category, but no print system hangs a bracket more than slightly: measured
 * in Junicode, a line-start "(" hangs 100‰ of its advance in Affinity and 249‰
 * in InDesign, against microtype's generic 100‰. Leaving them out gives them
 * exactly that ordinary protrusion, the same depth on every line.
 *
 * The CJK stops are burasage (ぶら下げ組み): the classical Japanese
 * newspaper/book setting hangs them fully into the right margin. Their glyphs
 * sit in the left half of a fullwidth advance, so the ink lands just past the
 * margin while the em-box hangs; kinsoku already guarantees they can end a line
 * but never start one.
 */
export interface HangingCharacters {
  /** Marginal at a line START. */
  readonly start: string;
  /** Marginal at a line END. */
  readonly end: string;
}

/**
 * The default set as its named parts. Module-private and purely for reading:
 * `quotes + stops + cjk` says what the default end set IS in a way a Unicode
 * literal cannot. Deliberately not exported — as a public vocabulary these
 * names would promise Unicode categories they do not deliver, since `stops`
 * holds the two marks we chose to hang and not the `!?;:` a reader would
 * expect. Callers compose from `hangingCharacters` instead.
 */
const groups = {
  quotes: "'\"\u2018\u2019\u201C\u201D\u201A\u201E\u2039\u203A\u00AB\u00BB",
  stops: ".,",
  brackets: "([{",
  cjk: "\u3001\u3002\uFF0C\uFF0E",
} as const;

export const hangingCharacters: HangingCharacters = {
  start: groups.quotes,
  end: groups.quotes + groups.stops + groups.cjk,
};

/** The full hang depth, in the protrusion model's units. Hanging only ever
 * speaks in this one value — that is what makes it a classification. */
const HANG = 1000;
/** ...and the depth "first-line-and-line-ends" gives a marginal mark on the
 * lines after the opener, where it is deliberately NOT classified. */
const FLUSH = 0;

/** Set `chars` to `code` on one side of `base`, preserving the other side. */
function classify(
  base: ProtrusionTable,
  chars: string,
  side: "l" | "r",
  code: number,
): ProtrusionTable {
  const out: Record<string, ProtrusionCodes> = { ...base };
  for (const ch of chars) out[ch] = { ...out[ch], [side]: code };
  return out;
}

/**
 * `hangingCharacters` expressed as protrusion codes. Derived, not authored —
 * the set above is the source of truth. Exported for callers who want the
 * MAGNITUDE reading of the same characters: passed as `protrusion` it makes
 * these marks protrude their full advance without classifying them, so the
 * glyph beside a mark is credited nothing, which is what every other
 * implementation does.
 */
export const hangingPunctuation: ProtrusionTable = classify(
  classify({}, hangingCharacters.end, "r", HANG),
  hangingCharacters.start,
  "l",
  HANG,
);

/**
 * Full-hanging policy layered over the selected protrusion model. Each name
 * says which line edges hang fully, in increasing order.
 *
 * `"first-line"` and `"all-lines"` are the original spellings of
 * `"first-line-and-line-ends"` and `"all-line-edges"`, and remain supported.
 */
export type HangingPunctuationMode =
  | false
  | "none"
  | "line-end-only"
  | "first-line-and-line-ends"
  | "all-line-edges"
  | "first-line"
  | "all-lines";

/** Canonical policy for any accepted spelling, with `false` folded into
 * `"none"` — the two have always meant the same thing. */
export function normalizeHangingPunctuation(
  hang: HangingPunctuationMode,
): Exclude<HangingPunctuationMode, false | "first-line" | "all-lines"> {
  switch (hang) {
    case false:
      return "none";
    case "first-line":
      return "first-line-and-line-ends";
    case "all-lines":
      return "all-line-edges";
    default:
      return hang;
  }
}

/**
 * Composes the effective protrusion tables from a base table (generic or
 * generic+per-font), the hanging-punctuation mode, and the user's explicit
 * per-char overrides (which always win). Returns the table for lines after
 * the first (`rest`) and for the paragraph's first line (`first`); the two
 * are the SAME object when no first-line distinction exists, so callers
 * can cheaply skip duplicate work.
 *
 * `credit` is the same composition WITHOUT the hang overlay — the protrusion
 * model as it would stand with hanging off. It exists for the one glyph a
 * hung mark leaves at the line's start: that glyph takes the ordinary optical
 * treatment, never a second full hang, so `“‘Twas` hangs one quote and gives
 * the second whatever a `‘` is worth at a line start. Only one mark ever
 * hangs, which is also what every other implementation does.
 *
 * It is undefined unless the MODE hangs somewhere, because crediting is
 * something the hanging POLICY does, not something a number does. "This mark
 * is not part of the line" and "this mark sticks out 1000‰" are different
 * claims: only the first says anything about what sits beside it. So a
 * `protrusion` table containing 1000 protrudes that mark and credits nothing —
 * the behaviour every other implementation has.
 *
 * CREDITING is what does not vary with the number: no table value earns it, so
 * there is no cliff between 999 and 1000 to fall off. The GEOMETRY does vary
 * there, deliberately — 999 is a partial hang and takes the ink-exit cap, 1000
 * means the mark has left the measure and clears its whole contextual advance.
 * That is the same discontinuity the two features are: a magnitude below, a
 * classification at. Codes cap at 1000, since there is nothing beyond gone.
 */
export function composeProtrusion(
  base: ProtrusionTable,
  user: ProtrusionTable | null,
  hang: HangingPunctuationMode,
  chars: HangingCharacters = hangingCharacters,
): { rest: ProtrusionTable; first: ProtrusionTable; credit?: ProtrusionTable } {
  const mode = normalizeHangingPunctuation(hang);
  let rest = base;
  let first = base;
  if (mode !== "none") {
    rest = classify(base, chars.end, "r", HANG);
    first = rest;
    if (mode !== "line-end-only") {
      first = classify(rest, chars.start, "l", HANG);
      if (mode === "all-line-edges") rest = first;
      // "first-line-and-line-ends" classifies the opener, then sets these
      // marks FLUSH at later line starts. Leaving them at their partial
      // optical depth would show one mark at two depths (#14).
      else rest = classify(rest, chars.start, "l", FLUSH);
    }
  }
  const credit = mode === "none" ? undefined : user !== null ? { ...base, ...user } : base;
  if (user !== null) {
    const same = first === rest;
    rest = { ...rest, ...user };
    first = same ? rest : { ...first, ...user };
  }
  return { rest, first, credit };
}
