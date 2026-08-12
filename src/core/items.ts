import { INF_PENALTY } from "./badness.js";
import {
  CJK_CHAR,
  CJK_GLUE_SHRINK,
  CJK_GLUE_STRETCH,
  cjkBreakAllowed,
  graphemes,
} from "./cjk.js";
import { protrusionCodes } from "./protrusion.js";
import {
  type Box,
  type BuildOptions,
  caseTransformedText,
  type Glue,
  type Item,
  ItemType,
  type Measure,
  type ParagraphItems,
  type Penalty,
  type ProtrusionTable,
  type RunMetrics,
  type RunText,
} from "./types.js";

const SOFT_HYPHEN = "\u00AD";
/** Letters-only word core eligible for pattern hyphenation. */
const WORD_CORE = /^(\P{L}*)(\p{L}+)(\P{L}*)$/u;
const MIN_HYPHENATION_LENGTH = 5;

/**
 * Dash characters a line may break AFTER: hyphen-minus, U+2010 HYPHEN, en
 * dash, em dash. Absent on purpose: U+2011 NON-BREAKING HYPHEN exists to
 * forbid the break, and no browser engine breaks at U+2012 FIGURE DASH's
 * flanking digits or at U+2015 HORIZONTAL BAR (a quotation dash) either.
 */
function isBreakingDash(code: number): boolean {
  return code === 0x2d || code === 0x2010 || code === 0x2013 || code === 0x2014;
}

/**
 * Every dash character, including the three that never take a break of their
 * own. No break is ever offered BEFORE one of these: a run of dashes sets
 * solid, and a line may not open with a dash.
 */
function isAnyDash(code: number): boolean {
  return code === 0x2d || (code >= 0x2010 && code <= 0x2015);
}

/**
 * Punctuation that may not open a line, so a dash break is not offered in
 * front of one: "AAA\u2013, BBB" breaks at the space, never after the dash. The
 * Japanese form of this rule, over a much larger character set, is cjk.ts's
 * kinsoku pair. Only unambiguously closing and terminal marks are listed: the
 * straight quotes are omitted because a dash followed by one is far more
 * likely to be OPENING a quotation ("said\u2014'no'") than closing it, and
 * suppressing a legitimate break costs more than the rare curly apostrophe
 * ("\u2014\u2019tis") this lets through.
 */
const NO_LINE_START = /[,.;:!?%)\]}\u00BB\u203A\u2019\u201D\u2026\u2030\u203C\u2047\u2048\u2049]/;
/**
 * The mirror: punctuation that may not END a line, so a dash sitting directly
 * after one is opening something rather than joining two words, and gets no
 * break of its own. Without this, "(-5)" and "[-1, 1]" break after the sign
 * — leaving "(-" to end a line — while a bare "-5" is protected, an
 * inconsistency an opening bracket should not create. Straight quotes are
 * omitted here for the same ambiguity reason as above, in the other
 * direction: a dash after one is as likely to be closing a quotation
 * ("said \u2014 'no'\u2014then left") as opening it.
 */
const NO_LINE_END = /[([{\u00AB\u2039\u2018\u201C\u00BF\u00A1]/;
const DIGIT = /\p{Nd}/u;

/**
 * The dash rules' "essentially never, but not never": one below INF_PENALTY,
 * where the squared penalty term (\u00A7859) costs about as much as one maximally
 * bad line, so the breaker takes such a break only to escape something worse.
 *
 * Used where a prohibition would otherwise weld an UNBOUNDED run of text into
 * one atomic unit, which an absolute ban turns from a typographic preference
 * into an overfull line:
 *
 * - the space before a dash-initial token, keeping a spaced dash off the front
 *   of a line ("Moscow \u2014" / "the capital", never "Moscow" / "\u2014 the
 *   capital"), which binds a whole word plus its dash;
 * - a dash between digits, which binds every digit-flanked junction in the
 *   token at once: a range or a date is short, but "978-0-13-235088-4" is not,
 *   and it should still yield in a narrow measure rather than overflow.
 *
 * The bounded prohibitions get no penalty item at all (no break point
 * whatever) since they cannot cause an overflow: see dashJunctionClass.
 */
const NEAR_PROHIBITIVE_PENALTY = 9999;

/** A normal soft-wrap opportunity after a fixed-width separator run. */
const FIXED_SPACE_BREAK_PENALTY = 0;

/** Fixed-width Unicode Zs characters CSS calls "other space separators".
 * These retain their source character and intrinsic advance. U+202F NARROW
 * NO-BREAK SPACE deliberately remains inside its surrounding no-break box,
 * alongside U+00A0, to preserve shaping and run-boundary protection. */
const TEXT_SEPARATOR_SPLIT =
  /([\u0009\u000A\u000D\u0020]+|[\u1680\u2000-\u200A\u205F\u3000])/;

/**
 * A necessary condition for CJK_CHAR.test, decided by one charCodeAt scan.
 * U+1100 (Hangul Jamo) is the LOWEST code point that class matches — verified
 * exhaustively over all 1,114,112 code points — and every astral member is
 * spelled with surrogates, which start at 0xD800. So a token whose every
 * UTF-16 unit is below 0x1100 cannot contain a CJK character, and the whole
 * Script-property regex may be skipped: that covers every token of Latin,
 * Cyrillic, Greek, Hebrew, Arabic and Devanagari prose. The condition is
 * monotone under concatenation, so the per-code-point bound settles strings.
 */
function mayBeCJK(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x1100) return true;
  }
  return false;
}

/**
 * Whether `text` can produce at least one Box under this module's tokenizer.
 * Shared with the DOM reader so padded/painted edge ownership cannot drift
 * on fixed and no-break spaces. Only CSS document whitespace and soft hyphens
 * fail to make a box here.
 */
export function textMakesBox(text: string): boolean {
  return /[^\u0009\u000A\u000D\u0020\u00AD]/u.test(text);
}

/**
 * Right-protrusion credit when a line breaks at item `b`: the materialized
 * hyphen's for width-carrying penalties, otherwise the line's LAST BOX —
 * found by walking back over unbroken penalties and glue, so the paragraph-
 * final box protrudes past the parfillskip tail too (a full last line's
 * period must hang like any other line's).
 *
 * This is the walking form, for callers holding a bare item array. The
 * breaker and layoutLines hold a ParagraphItems and take `breakEndBox` +
 * `rpAt` instead, which is the same rule without the walk.
 */
export function breakRp(items: readonly Item[], b: number): number {
  let endBox: Box | undefined;
  for (let i = b - 1; i >= 0; i--) {
    const prev = items[i]!;
    if (prev.type === ItemType.Box) {
      endBox = prev;
      break;
    }
  }
  return rpAt(items[b]!, endBox);
}

/**
 * The box a break at `b` inherits from — its right protrusion, and the hang
 * flex of any trailing whitespace sequence it absorbed. Undefined only ahead
 * of the paragraph's first box. O(1) through `lastBoxBefore`, which is why
 * the breaker's inner loop resolves the box once and reads all three values
 * off it rather than walking back three times.
 */
export function breakEndBox(para: ParagraphItems, b: number): Box | undefined {
  const i = para.lastBoxBefore[b]!;
  if (i < 0) return undefined;
  const box = para.items[i]!;
  return box.type === ItemType.Box ? box : undefined;
}

/**
 * breakRp's rule, split out so the O(1) and walking forms cannot drift: a
 * width-carrying penalty hangs its own materialized hyphen, everything else
 * hangs the line's last box.
 */
export function rpAt(it: Item, endBox: Box | undefined): number {
  if (it.type === ItemType.Penalty && it.width > 0) return it.rp;
  return endBox === undefined ? 0 : endBox.rp;
}

/**
 * The lastLineMinWidth floor's stretch solve: distributes the `need` px
 * to the threshold over the ending's own pools — word glue plus the
 * RECRUITED flexes, letterfit tracking and wdth expansion (`flexY`,
 * their summed budgets). Body lines use those flexes invisibly on every
 * line; an ending whose author asked for width may use them too. One
 * pooled ratio, with the flexes saturating at their full budgets (ratio
 * 1, like body-line tracking saturation) while glue may continue to
 * `maxRatio` (maxEndingStretch). Returns the GLUE ratio that reaches the
 * threshold — the flexes ride at min(ratio, min(maxRatio, 1)) — or null
 * when the ending is unreachable and renders natural: all or nothing, a
 * line both stretched and still short reads worse than a ragged one.
 * Shared by the breaker's ending cost and the layout floor so pricing
 * and rendering can never disagree about reachability.
 */
export function endingFloorRatio(
  need: number,
  glueY: number,
  flexY: number,
  maxRatio: number,
): number | null {
  if (need <= 0) return 0;
  const flexCap = Math.min(maxRatio, 1);
  if (!(need <= glueY * maxRatio + flexY * flexCap)) return null;
  const pooled = need / (glueY + flexY);
  if (pooled <= flexCap) return pooled;
  return glueY > 0 ? (need - flexY * flexCap) / glueY : flexCap;
}

/**
 * Code-point-wise first/last character and length, without materializing the
 * `Array.from(text)` these replace: they run per BOX (tens of thousands per
 * document), and the arrays were the single largest source of allocation
 * churn in a cold enhance. Lone surrogates are passed through unpaired,
 * exactly as the string iterator does.
 */
function firstCodePoint(text: string): string {
  const code = text.charCodeAt(0);
  if (code >= 0xd800 && code <= 0xdbff && text.length > 1) {
    const next = text.charCodeAt(1);
    if (next >= 0xdc00 && next <= 0xdfff) return text.slice(0, 2);
  }
  return text[0]!;
}

function lastCodePoint(text: string): string {
  const n = text.length;
  const code = text.charCodeAt(n - 1);
  if (code >= 0xdc00 && code <= 0xdfff && n > 1) {
    const prev = text.charCodeAt(n - 2);
    if (prev >= 0xd800 && prev <= 0xdbff) return text.slice(n - 2);
  }
  return text[n - 1]!;
}

function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

/**
 * Split a token after every dash that is followed by a non-dash: "self-made"
 * → ["self-", "made"], "1914–1918" → ["1914–", "1918"], while "a--b" keeps
 * its run of dashes together ("a--", "b").
 *
 * Chunks are the unit hyphenation runs on, so a token is split at a junction
 * even when that junction will go on to FORBID the break (see
 * dashJunctionClass): splitting is what lets both sides of a dash-joined
 * compound hyphenate at all — the letters-only WORD_CORE gate rejects any
 * chunk with a dash inside it, which is why "unfortunately—nevertheless" used
 * to offer no break point anywhere.
 *
 * Written as a loop rather than the equivalent lookbehind-plus-lookahead
 * regex: lookbehind assertions are Safari 16.4+, they are SYNTAX
 * (an older engine fails to parse the whole module, taking any bundle this
 * ships inside down with it), and no build step can lower them — esbuild
 * passes them through even when the target says otherwise.
 */
function splitAtDashes(token: string): string[] {
  // Most tokens carry no dash at all; one native scan settles them.
  let dashed = false;
  for (let i = 0; i < token.length; i++) {
    if (isBreakingDash(token.charCodeAt(i))) {
      dashed = true;
      break;
    }
  }
  if (!dashed) return [token];
  const chunks: string[] = [];
  let start = 0;
  for (let i = 0; i < token.length - 1; i++) {
    if (isBreakingDash(token.charCodeAt(i)) && !isAnyDash(token.charCodeAt(i + 1))) {
      chunks.push(token.slice(start, i + 1));
      start = i + 1;
    }
  }
  chunks.push(token.slice(start));
  return chunks;
}

/** The character before `chunk`'s trailing run of dashes ("" if it is all dashes). */
function beforeTrailingDashes(chunk: string): string {
  let i = chunk.length - 1;
  while (i >= 0 && isAnyDash(chunk.charCodeAt(i))) i--;
  return i >= 0 ? chunk[i]! : "";
}

/**
 * What kind of break, if any, the junction between two chunks of one token
 * carries — that is, the break after the dash `before` ends with. The `after`
 * codes pushWord uses: 2 an ordinary dash break, 3 a near-prohibitive one, 0
 * no break point at all.
 *
 * Two junctions are split for hyphenation but refuse the break outright,
 * both of them bounded in the text they weld together, so neither can
 * overflow a measure:
 *
 * - a dash with nothing before it but dashes, or something that cannot end a
 *   line, so the dash is not joining two words at all: a sign ("-5" and
 *   "(-5)"), a CLI flag ("--verbose"), interval notation ("[-1, 1]"), an
 *   opening dialogue dash ("—Yes", "“—Yes”"). Breaking there strands the
 *   dash at a line end away from what it belongs to.
 * - a junction whose next character cannot open a line at all.
 *
 * A dash BETWEEN DIGITS is near-prohibitive rather than absolute. Keeping
 * "1914–1918" and "2026-08-06" whole is the rule — every engine measured
 * breaks them, and Chicago and Bringhurst both say not to, a deliberate
 * departure from UAX #14 where en dash is class BA and the break is legal.
 * But the test is per junction, so a long chain of them ("978-0-13-235088-4")
 * would otherwise become one unbreakable 17-character unit; at
 * NEAR_PROHIBITIVE_PENALTY it splits only when nothing else fits.
 */
function dashJunctionClass(before: string, after: string): number {
  const stem = beforeTrailingDashes(before);
  if (stem === "" || NO_LINE_END.test(stem)) return 0;
  const next = after[0]!;
  if (NO_LINE_START.test(next)) return 0;
  return DIGIT.test(next) && DIGIT.test(stem) ? 3 : 2;
}

/** Half-open range of text consumed by a floated ::first-letter. */
interface Exclusion {
  start: number;
  end: number;
}

/**
 * `exclusion` — expressed in coordinates where the substring of `length`
 * begins at `start` — re-expressed relative to that substring, or null when
 * the two don't overlap. Used at each level of the tokenizer's descent
 * (piece → part → fragment/cluster), since every level slices text a
 * floated first letter may sit inside.
 */
function clipExclusion(
  exclusion: Exclusion | undefined,
  start: number,
  length: number,
): Exclusion | null {
  const end = start + length;
  // The `start >= end` conjunct is what the three inline blocks this replaced
  // each carried: an empty or inverted range must produce no exclusion, not a
  // backwards slice that DUPLICATES text into the box. The reader only ever
  // emits well-formed ranges, but this is now the single choke point for every
  // level of the tokenizer's descent, so it defends itself.
  if (
    exclusion === undefined ||
    exclusion.start >= exclusion.end ||
    exclusion.start >= end ||
    exclusion.end <= start
  ) {
    return null;
  }
  return {
    start: Math.max(0, exclusion.start - start),
    end: Math.min(length, exclusion.end - start),
  };
}

/**
 * The part of `text` (beginning at `start` in the enclosing token) that stays
 * in normal flow once `exclusion` is removed, plus that removal expressed
 * relative to `text`. The excluded characters are rendered by the real float,
 * so they are measured out of the box's width but kept in its source text.
 */
function excludeFlow(
  text: string,
  start: number,
  exclusion: Exclusion | null,
): { flowText: string; flowExclusion?: Exclusion } {
  const clipped = clipExclusion(exclusion ?? undefined, start, text.length);
  if (clipped === null) return { flowText: text };
  return {
    flowText: text.slice(0, clipped.start) + text.slice(clipped.end),
    flowExclusion: clipped,
  };
}

/** `protrusionHang`'s "fetch the advance yourself, if you turn out to need it". */
const LAZY_ADVANCE = -1;

/** The protrusion table governing `run` on the line named by `firstLine`. */
function protrusionTable(
  opts: BuildOptions,
  run: RunMetrics,
  firstLine: boolean,
): ProtrusionTable | false {
  if (opts.protrusion === false) return false;
  return firstLine
    ? (run.protrusionFirst ?? opts.protrusionFirst ?? run.protrusion ?? opts.protrusion)
    : (run.protrusion ?? opts.protrusion);
}

/**
 * The character the run RENDERS for `ch`. Protrusion codes describe glyphs,
 * and under a `text-transform` the glyph on the page is not the one in the
 * source: `A` protrudes on both sides where `a` protrudes on neither. Only
 * the table lookup needs this — advances and side bearings are asked for by
 * SOURCE character and transformed by the measurer, so callers must keep
 * passing the source one to those.
 *
 * A mapping that changes length (`ß`→`SS`) matches no entry and so protrudes
 * nothing, which is the right answer for a two-glyph rendering anyway.
 */
function renderedChar(ch: string, run: RunMetrics): string {
  return caseTransformedText(ch, run.textTransform);
}

/**
 * Protrusion hang for `ch` at a line edge, in px: code/1000 × advance
 * (pdfTeX semantics), from the run's own hand-tuned table when one matched
 * its font, else the paragraph-wide table. Monospace runs inside another
 * font's prose (`protrudeInkOnly`) cap the hang at the glyph's side
 * bearing so ink never leaves the measure.
 */
function protrusionHang(
  table: ProtrusionTable | false,
  measure: Measure,
  ch: string,
  run: RunMetrics,
  /**
   * The glyph's advance, or LAZY (any negative value) to fetch it from
   * `measure.charAdvance` here. Deferring is exact, not an approximation: the
   * advance only ever scales a nonzero code or bounds the ink clamps below, so
   * a glyph the table says nothing about hangs zero whatever its advance is —
   * and the vast majority of glyphs (every ordinary letter) is such a glyph.
   * A pathological measure returning a negative advance merely gets asked
   * again for the same number.
   */
  advanceOrLazy: number,
  side: "l" | "r",
): number {
  if (table === false) return 0;
  // Capped at 1000: a whole advance is as far out as a glyph goes, because
  // that is the point where it has left the measure and there is nothing
  // beyond gone. Negatives pass through — they pull a glyph IN, which is a
  // real thing the measured model asks for. The cap matters most on the paths
  // that never reach classification — `hyphenRp`'s materialized hyphen and
  // `protrudeInkOnly` runs — so that one rule holds everywhere.
  const advCode = Math.min(1000, protrusionCodes(table, renderedChar(ch, run))?.[side] ?? 0);
  if (advCode === 0) return 0;
  const advance = advanceOrLazy < 0 ? measure.charAdvance(ch, run) : advanceOrLazy;
  const advHang = (advCode / 1000) * advance;
  if (run.protrudeInkOnly === true && measure.inkBearings !== undefined) {
    return Math.min(advHang, measure.inkBearings(ch, run)[side]);
  }
  // A PARTIAL line-start hang past the glyph's ink is pure displacement: the
  // mark detaches from the very margin it is meant to anchor. Cap at
  // ink-exit — the ink may leave the measure entirely but stays flush
  // against the margin. A FULL hang never reaches here (`leadingProtrusion`
  // handles it, and the glyph behind the mark anchors the margin instead),
  // and line ENDS keep the full hang: there the preceding text anchors the
  // margin and the mark drifts outward harmlessly.
  if (side === "l" && measure.inkBearings !== undefined) {
    return Math.min(advHang, Math.max(0, advance - measure.inkBearings(ch, run).r));
  }
  return advHang;
}

/**
 * Left protrusion for a box, in px.
 *
 * Ordinarily this is the first glyph's own hang. The exception is a mark that
 * hangs its ENTIRE advance (`l: 1000`, i.e. hanging punctuation): such a mark
 * occupies nothing inside the measure, so the glyph behind it is the line's
 * start and takes the line-start treatment itself. That is what keeps a hung
 * mark from moving the text it opens — without it `“Typography` set the T a
 * side bearing INSIDE the margin and denied it the protrusion a bare
 * `Typography` would have had, pushing the first line in by ~0.09em against
 * every line below it.
 *
 * EXACTLY ONE mark hangs. The glyph behind it is credited from the model
 * WITHOUT the hang overlay (`protrusionCredit`), so a second mark takes an
 * ordinary optical depth rather than hanging in turn: `“‘Twas` puts one quote
 * outside and gives the other what a `‘` is worth at a line start. Every
 * other implementation consults one glyph per line edge; this consults two,
 * for the two different questions, and stops.
 *
 * The mark's advance is taken IN CONTEXT (the width the box loses when the
 * mark is dropped) so its kern against the following glyph — `“T` kerns
 * tight in most Garaldes — lands outside the measure with the mark itself.
 * Affinity does the same, to the hundredth of a point.
 *
 * A `protrudeInkOnly` run is exempt: its whole contract is that no ink may
 * leave the measure, which a full hang would break.
 *
 * THE INVARIANT STOPS AT THE BOX. `<em>“</em>Typography` puts the mark in a box
 * of its own, so there is no glyph beside it here to credit and the T in the
 * next box keeps its own protrusion instead — a hair different from the
 * one-box case, which also spends the pair's kern outside the margin. Both are
 * deliberate: a contextual advance across two boxes is not well defined when
 * they are set in different fonts, and every reference implementation is at
 * least this narrow, consulting one glyph and stopping. Not worth widening.
 */
function leadingProtrusion(
  opts: BuildOptions,
  measure: Measure,
  text: string,
  run: RunMetrics,
  firstLine: boolean,
): number {
  const table = protrusionTable(opts, run, firstLine);
  if (table === false) return 0;
  const mark = firstCodePoint(text);
  const inkOnly = run.protrudeInkOnly === true && measure.inkBearings !== undefined;
  if (inkOnly || (protrusionCodes(table, renderedChar(mark, run))?.l ?? 0) < 1000) {
    return protrusionHang(table, measure, mark, run, LAZY_ADVANCE, "l");
  }
  const tail = text.slice(mark.length);
  const hang =
    tail.length === 0
      ? measure.charAdvance(mark, run)
      : measure.width(text, run) - measure.width(tail, run);
  // Nothing in THIS box to credit — see the box-boundary note above.
  if (tail.length === 0) return hang;
  const credit = run.protrusionCredit ?? opts.protrusionCredit ?? false;
  return hang + protrusionHang(credit, measure, firstCodePoint(tail), run, LAZY_ADVANCE, "l");
}

/**
 * Right protrusion for a box, in px — `leadingProtrusion` mirrored.
 *
 * Hanging is a CLASSIFICATION, not a large protrusion: it says the mark is not
 * part of the text's rectangle. So the text sets as though the mark were not
 * there, and the glyph that then ends the line takes the ordinary line-end
 * treatment. `content.” ` therefore hangs the quote and lets the period
 * protrude on its own account, exactly as `content.` would — the same rule
 * that governs the left edge, so that adding a mark never moves the text it
 * sits beside.
 *
 * As on the left, EXACTLY ONE mark is classified per edge: the rule applies
 * once and the protrusion model handles everything inward of it, which is what
 * keeps it from recursing with no place to stop. It stops at the box for the
 * same reasons too: `content<em>”</em>` credits nothing, because the period is
 * in a different box and `breakRp` reads only the last one.
 */
function trailingProtrusion(
  opts: BuildOptions,
  measure: Measure,
  text: string,
  run: RunMetrics,
): number {
  // The first-line table differs from the rest only in its LEFT codes, so the
  // right edge always reads the ordinary one.
  const table = protrusionTable(opts, run, false);
  if (table === false) return 0;
  const mark = lastCodePoint(text);
  const inkOnly = run.protrudeInkOnly === true && measure.inkBearings !== undefined;
  if (inkOnly || (protrusionCodes(table, renderedChar(mark, run))?.r ?? 0) < 1000) {
    return protrusionHang(table, measure, mark, run, LAZY_ADVANCE, "r");
  }
  const head = text.slice(0, text.length - mark.length);
  const hang =
    head.length === 0
      ? measure.charAdvance(mark, run)
      : measure.width(text, run) - measure.width(head, run);
  // Nothing in THIS box to credit — see the box-boundary note above.
  if (head.length === 0) return hang;
  const credit = run.protrusionCredit ?? opts.protrusionCredit ?? false;
  return hang + protrusionHang(credit, measure, lastCodePoint(head), run, LAZY_ADVANCE, "r");
}

/**
 * Flattens a paragraph's styled runs into the Knuth-Plass item stream.
 * Whitespace is collapsed; words become boxes measured whole (kerning-safe),
 * spaces become glue from the run's space spec, and break opportunities
 * (soft hyphens, hyphenator output, dashes) become penalties.
 * Ends with the TeX parfillskip idiom so the last line sets naturally.
 */
export function buildItems(
  texts: readonly RunText[],
  runs: readonly RunMetrics[],
  opts: BuildOptions,
  measure: Measure,
): ParagraphItems {
  const items: Item[] = [];
  let pendingSpaceRun = -1;
  let pendingLeadingSpace = false;
  let hasBox = false;
  let hasFlowBox = false;

  // Inline box extras, painted-box scopes and no-break scopes
  // (RunText.padStartPx/padEndPx/paintedBox/atomicKey). pendingPad
  // accumulates until the element's first box exists (its own first piece
  // may be whitespace-only); lastBox is patched retroactively when a piece
  // marked padEndPx finishes. At a painted inline's REAL open/close, its
  // side inset replaces glyph protrusion so the enclosed glyph can meet the
  // measure while the decoration itself hangs outside it. Ordinary boxes
  // between those markers retain glyph protrusion at internal line slices.
  let pendingPad = 0;
  let lastBox: Box | null = null;
  let lastBoxRun = -1;
  let lastBoxKey: number | undefined;
  let pieceKey: number | undefined;
  let piecePaintedStart = false;
  let piecePaintedEnd = false;
  let pendingBoxStartProtrusion = 0;
  let pendingPaintedStart = false;

  const emitBox = (box: Box, runIndex: number): void => {
    if (pendingPad > 0 || pendingPaintedStart) {
      if (pendingPad > 0) {
        box.width += pendingPad;
        box.padPx = (box.padPx ?? 0) + pendingPad;
      }
      // Every pending side decoration precedes this same first glyph. A
      // painted descendant's own inset may have been recorded before an
      // unpainted padded ancestor closes in the DOM walk, so the complete
      // pending padding is the authoritative border-to-glyph distance.
      const boxHang =
        pendingPaintedStart
          ? Math.max(pendingBoxStartProtrusion, pendingPad)
          : 0;
      box.lp = boxHang;
      box.lpFirst = boxHang;
      pendingPad = 0;
      pendingBoxStartProtrusion = 0;
      pendingPaintedStart = false;
    }
    items.push(box);
    hasBox = true;
    // Emptiness only: UTF-16 length and code-point count are zero together.
    if ((box.flowChars ?? box.text.length) > 0) hasFlowBox = true;
    lastBox = box;
    lastBoxRun = runIndex;
    lastBoxKey = pieceKey;
  };

  const hyphenRp = (run: RunMetrics): number =>
    piecePaintedEnd
      ? 0
      : protrusionHang(
          protrusionTable(opts, run, false),
          measure,
          "-",
          run,
          run.hyphenWidth,
          "r",
        );

  const makeBox = (
    text: string,
    runIndex: number,
    width: number,
    flowText = text,
    flowExclusion?: Exclusion,
  ): Box => {
    const run = runs[runIndex]!;
    let lp = 0;
    let rp = 0;
    let lpFirst = 0;
    if (opts.protrusion !== false && flowText.length > 0) {
      if (!piecePaintedStart) {
        lp = leadingProtrusion(opts, measure, flowText, run, false);
        lpFirst =
          (run.protrusionFirst ?? opts.protrusionFirst) === undefined
            ? lp
            : leadingProtrusion(opts, measure, flowText, run, true);
      }
      if (!piecePaintedEnd) rp = trailingProtrusion(opts, measure, flowText, run);
    }
    let expStretch = 0;
    let expShrink = 0;
    if (opts.expansion !== false) {
      if (run.ratioAtMax > 1) expStretch = width * (run.ratioAtMax - 1);
      if (run.ratioAtMin < 1) expShrink = width * (1 - run.ratioAtMin);
    }
    let trackStretch = 0;
    let trackShrink = 0;
    if (opts.tracking !== false) {
      trackStretch = width * opts.tracking.max;
      trackShrink = width * opts.tracking.shrink;
    }
    // Only a float-excluded box has a flow length of its own; the ordinary
    // case measures nothing (`flowText` IS `text`).
    let boxFlowChars: number | undefined;
    if (flowText !== text) {
      const flowChars = codePointLength(flowText);
      if (flowChars !== codePointLength(text)) boxFlowChars = flowChars;
    }
    return {
      type: ItemType.Box,
      width,
      run: runIndex,
      text,
      flowChars: boxFlowChars,
      flowExclusion,
      lp,
      lpFirst,
      rp,
      hangStretch: 0,
      hangShrink: 0,
      expStretch,
      expShrink,
      trackStretch,
      trackShrink,
    };
  };

  /**
   * Positional, and deliberately NOT an options bag: every break opportunity
   * in the document passes through here, and one uniform object literal keeps
   * the whole penalty stream on a single hidden class. The CJK joints keep
   * their own literal below rather than gaining a parameter here — their extra
   * `cjk` field would otherwise reshape every penalty in the stream.
   */
  const pushPenalty = (
    penalty: number,
    width: number,
    flagged: boolean,
    hyphen: boolean,
    rp: number,
    runIndex: number,
  ): void => {
    items.push({
      type: ItemType.Penalty,
      penalty,
      width,
      flagged,
      hyphen,
      rp,
      run: runIndex,
    } satisfies Penalty);
  };

  /**
   * The fragments of the token being emitted, as scratch arrays reused for the
   * whole paragraph. They are safe to reuse because a token is fully planned
   * and then fully emitted before the next one is touched: `pieceCount` is the
   * only live extent, so stale entries past it are unreachable. `pieceAfter`
   * says what follows fragment q — 0 nothing, 1 a hyphenation penalty, 2 an
   * dash penalty, 3 a near-prohibitive dash penalty — and
   * `pieceFromHyphenator` is meaningful only
   * where `pieceAfter` is 1.
   */
  const pieceText: string[] = [];
  const pieceAfter: number[] = [];
  const pieceFromHyphenator: boolean[] = [];
  let pieceCount = 0;

  /**
   * Split one chunk (no dashes) at soft hyphens or hyphenator
   * points, APPENDING the fragments to the scratch arrays. Returns whether
   * they came from the hyphenator, which decides the penalty's `hyphen` flag
   * (and so whether pass 1 may break there).
   */
  const chunkPieces = (chunk: string, noHyphens: boolean): boolean => {
    if (noHyphens) {
      // CSS hyphens:none — strip soft hyphens instead of honoring them.
      const text = chunk.includes(SOFT_HYPHEN)
        ? chunk.split(SOFT_HYPHEN).join("")
        : chunk;
      if (text.length > 0) pieceText[pieceCount++] = text;
      return false;
    }
    if (chunk.includes(SOFT_HYPHEN)) {
      for (const part of chunk.split(SOFT_HYPHEN)) {
        if (part.length > 0) pieceText[pieceCount++] = part;
      }
      return false;
    }
    // The letter core WORD_CORE finds is a substring of the chunk, so a chunk
    // shorter than the minimum cannot contain a long enough core — a length
    // test settles it before the \p{L}-class regex, which would otherwise be
    // matched against every short token in the document (roughly 40% of
    // English tokens are under five characters).
    if (opts.hyphenate && chunk.length >= MIN_HYPHENATION_LENGTH) {
      const m = WORD_CORE.exec(chunk);
      if (m && m[2]!.length >= MIN_HYPHENATION_LENGTH) {
        const prefix = m[1]!;
        const core = m[2]!;
        const suffix = m[3]!;
        const parts = opts.hyphenate(core.toLowerCase());
        // The offsets come from the lowercased core; reject output whose
        // total length differs (length-changing case mappings, e.g. İ→i̇,
        // would misalign every subsequent break point). Empty parts are
        // skipped in place rather than filtered into a new array: they move
        // neither the offsets nor the length total.
        let nonEmpty = 0;
        let joined = 0;
        for (const part of parts) {
          if (part.length > 0) nonEmpty++;
          joined += part.length;
        }
        if (nonEmpty > 1 && joined === core.length) {
          // Slice the original (cased) core at the hyphenator's offsets.
          const first = pieceCount;
          let off = 0;
          for (const part of parts) {
            if (part.length > 0) {
              pieceText[pieceCount++] = core.slice(off, off + part.length);
            }
            off += part.length;
          }
          if (prefix.length > 0) pieceText[first] = prefix + pieceText[first]!;
          if (suffix.length > 0) {
            pieceText[pieceCount - 1] = pieceText[pieceCount - 1]! + suffix;
          }
          return true;
        }
      }
    }
    pieceText[pieceCount++] = chunk;
    return false;
  };

  /**
   * Emit the word-space glue a previous whitespace run left pending, knowing
   * the run of the box that will follow it. Two space-position rules live
   * here: a space between two boxes of one nowrap element is unbreakable
   * (penalty ∞ in front — flex intact, break forbidden), and a space at a
   * font-family boundary shrinks only by `boundaryShrink` (rigid by
   * default; see BuildOptions.boundaryShrink).
   *
   * `dashInitial` says the box about to follow this space opens with a dash,
   * which earns the space a steep but finite penalty instead
   * (NEAR_PROHIBITIVE_PENALTY). `fixedSpaceInitial` absolutely forbids a
   * break that would put a fixed-width space at the start of a line. All
   * three prohibitions work the same way: a penalty item in FRONT of the
   * glue, which retires the glue's own break point (the breaker requires a
   * preceding box) and substitutes its own price. Breaking at that penalty
   * discards the glue, so the rare line that pays the dash price still
   * renders its space — segments.ts gives a break at a hand-built pre-glue
   * penalty the "space" joint for exactly this reason.
   */
  const flushPendingSpace = (
    nextRun: number,
    dashInitial = false,
    fixedSpaceInitial = false,
  ): void => {
    if (pendingSpaceRun >= 0 && hasBox) {
      const space = runs[pendingSpaceRun]!.space;
      if (
        pendingLeadingSpace ||
        fixedSpaceInitial ||
        (pieceKey !== undefined && pieceKey === lastBoxKey)
      ) {
        pushPenalty(INF_PENALTY, 0, false, false, 0, pendingSpaceRun);
      } else if (dashInitial) {
        pushPenalty(NEAR_PROHIBITIVE_PENALTY, 0, false, false, 0, pendingSpaceRun);
      }
      const boundary =
        lastBoxRun >= 0 && runs[lastBoxRun]!.familyKey !== runs[nextRun]!.familyKey;
      items.push({
        type: ItemType.Glue,
        width: pendingLeadingSpace ? 0 : space.width,
        stretch: pendingLeadingSpace ? 0 : space.stretch,
        stretchFil: 0,
        shrink: pendingLeadingSpace
          ? 0
          : boundary
            ? space.shrink * opts.boundaryShrink
            : space.shrink,
        run: pendingSpaceRun,
        rigid:
          !pendingLeadingSpace && boundary && opts.boundaryShrink < 1 ? true : undefined,
        fixedSpaceInitial: fixedSpaceInitial || undefined,
      } satisfies Glue);
    }
    pendingSpaceRun = -1;
    pendingLeadingSpace = false;
  };

  const pushWord = (
    token: string,
    runIndex: number,
    exclusion: Exclusion | null,
  ): void => {
    const run = runs[runIndex]!;

    // Plan all fragments: dash junctions ("self-made" → "self-" | "made"),
    // then soft-hyphen/hyphenator splits within each chunk.
    pieceCount = 0;
    if (pieceKey !== undefined) {
      // Inside a nowrap element nothing may break, so the token stays one box
      // (soft hyphens stripped like the noHyphens path) with no penalty after.
      chunkPieces(token, true);
      if (pieceCount > 0) pieceAfter[pieceCount - 1] = 0;
    } else {
      const noHyphens = run.noHyphens === true;
      const chunks = splitAtDashes(token);
      for (let c = 0; c < chunks.length; c++) {
        const first = pieceCount;
        const fromHyphenator = chunkPieces(chunks[c]!, noHyphens);
        for (let q = first; q < pieceCount - 1; q++) {
          pieceAfter[q] = 1;
          pieceFromHyphenator[q] = fromHyphenator;
        }
        // A chunk that yielded NO fragments (a lone soft hyphen) has no last
        // fragment to hang the dash penalty on, and must not steal the
        // previous chunk's. A junction the dash rules forbid takes class 0:
        // with no penalty item between the two boxes the breaker has no
        // break point there at all, which is exactly the intent.
        if (pieceCount > first) {
          pieceAfter[pieceCount - 1] =
            c < chunks.length - 1 ? dashJunctionClass(chunks[c]!, chunks[c + 1]!) : 0;
        }
      }
    }
    // A token with no measurable pieces (e.g. a lone soft hyphen) emits
    // nothing — and must not consume the pending space, or the next word
    // would get a doubled glue.
    if (pieceCount === 0) return;

    flushPendingSpace(runIndex, isAnyDash(token.charCodeAt(0)));

    // The shape almost every prose token has — one unbreakable fragment with
    // nothing withdrawn from flow — is the whole token measured once. The
    // prefix bookkeeping below degenerates to exactly this for it.
    if (pieceCount === 1 && pieceAfter[0] === 0 && exclusion === null) {
      const only = pieceText[0]!;
      emitBox(makeBox(only, runIndex, measure.width(only, run)), runIndex);
      return;
    }

    // Fragment widths are measured incrementally over token prefixes so they
    // sum exactly to the kerned whole-token width: adding break opportunities
    // never perturbs lines that don't use them, and a line broken at a
    // fragment gets exactly the width of its rendered prefix.
    let acc = "";
    let accWidth = 0;
    let tokenOffset = 0;
    for (let q = 0; q < pieceCount; q++) {
      const text = pieceText[q]!;
      acc += text;
      const start = tokenOffset;
      const { flowText, flowExclusion: boxExclusion } = excludeFlow(
        text,
        start,
        exclusion,
      );
      tokenOffset = start + text.length;
      const flowPrefix =
        exclusion === null
          ? acc
          : acc.slice(0, Math.max(0, exclusion.start)) + acc.slice(Math.min(acc.length, exclusion.end));
      const prefixWidth = measure.width(flowPrefix, run);
      const box = makeBox(text, runIndex, prefixWidth - accWidth, flowText, boxExclusion);
      accWidth = prefixWidth;
      emitBox(box, runIndex);
      const after = pieceAfter[q]!;
      if (after === 1) {
        pushPenalty(
          opts.hyphenPenalty,
          run.hyphenWidth,
          true,
          pieceFromHyphenator[q]!,
          hyphenRp(run),
          runIndex,
        );
      } else if (after === 2 || after === 3) {
        // The dash is box text, so the break inherits the box's own
        // right protrusion rather than a materialized hyphen's.
        pushPenalty(
          after === 3 ? NEAR_PROHIBITIVE_PENALTY : opts.exHyphenPenalty,
          0,
          true,
          false,
          box.rp,
          runIndex,
        );
      }
    }
  };

  /** Emit one fixed-width CSS other-space separator as source-preserving box
   * text. Under white-space: normal, a trailing run hangs: its characters and
   * advances remain measurable, but the complete run is excluded from line
   * fitting and justification. Unicode forbids a break before a fixed-width
   * separator, so adjacent separators expose one opportunity after the run.
   */
  const pushOtherSpace = (
    separator: string,
    runIndex: number,
    exclusion: Exclusion | null,
  ): void => {
    const run = runs[runIndex]!;
    flushPendingSpace(runIndex, false, true);
    const precedingItem = items[items.length - 1];
    const leadingGlue =
      precedingItem?.type === ItemType.Glue && precedingItem.fixedSpaceInitial === true
        ? precedingItem
        : undefined;
    // The run this separator continues ends either directly behind, or behind
    // the guard penalty and glue that a collapsible space between two fixed
    // separators just flushed (flushPendingSpace always guards a
    // fixedSpaceInitial glue with exactly one penalty in front of it).
    let chainIndex = items.length - 1;
    if (leadingGlue !== undefined) chainIndex -= 2;
    const boundary = items[chainIndex];
    // Discovering another fixed separator removes the provisional boundary.
    // The new last box inherits the complete run's hang width.
    const behindBoundary = items[chainIndex - 1];
    if (
      boundary?.type === ItemType.Penalty &&
      boundary.fixedSpace === true &&
      behindBoundary?.type === ItemType.Box &&
      behindBoundary.otherSpace === true
    ) {
      items.splice(chainIndex, 1);
      chainIndex -= 1;
    }
    const precedingBox = items[chainIndex];
    const { flowText, flowExclusion } = excludeFlow(separator, 0, exclusion);
    const width = measure.width(flowText, run);
    const box = makeBox(separator, runIndex, width, flowText, flowExclusion);
    box.otherSpace = true;
    box.rp =
      width +
      (precedingBox?.type === ItemType.Box && precedingBox.otherSpace === true
        ? precedingBox.rp
        : 0) +
      (leadingGlue?.width ?? 0);
    box.hangStretch =
      (precedingBox?.type === ItemType.Box && precedingBox.otherSpace === true
        ? precedingBox.hangStretch
        : 0) + (leadingGlue?.stretch ?? 0);
    box.hangShrink =
      (precedingBox?.type === ItemType.Box && precedingBox.otherSpace === true
        ? precedingBox.hangShrink
        : 0) + (leadingGlue?.shrink ?? 0);
    emitBox(box, runIndex);
    if (pieceKey === undefined && separator !== "\u2007") {
      items.push({
        type: ItemType.Penalty,
        penalty: FIXED_SPACE_BREAK_PENALTY,
        width: 0,
        flagged: false,
        hyphen: false,
        rp: 0,
        run: runIndex,
        fixedSpace: true,
      } satisfies Penalty);
    }
  };

  /**
   * A token containing CJK text (no whitespace, like every token here):
   * each CJK grapheme cluster becomes its own box, and every legal
   * inter-cluster boundary gets penalty(0) + zero-width stretchable glue —
   * a break opportunity WITHOUT a space, plus the flex Japanese
   * justification distributes between characters. Kinsoku-prohibited
   * boundaries (a line may not start with 。、」ー small kana… nor end
   * with 「（…) keep the glue but carry an infinite penalty; the glue is
   * never breakable on its own because it always follows a penalty (the
   * breaker's glue rule requires a preceding BOX). Embedded non-CJK
   * stretches (Latin words, digits) stay single boxes: hyphenation never
   * runs inside a mixed token, and NO break opportunity is invented inside
   * them — only at their CJK boundaries, where UAX #14 allows one.
   */
  const pushCJKToken = (
    token: string,
    runIndex: number,
    exclusion: Exclusion | null,
  ): void => {
    const run = runs[runIndex]!;
    // Soft hyphens are meaningless between ideographs; strip them (the
    // Latin path likewise drops them from the emitted text).
    const clean = token.split(SOFT_HYPHEN).join("");
    if (clean.length === 0) return;

    // Each CJK cluster is its own group; consecutive non-CJK clusters
    // merge into one opaque group.
    interface Group {
      cjk: boolean;
      text: string;
      flowText: string;
      flowExclusion?: Exclusion;
    }
    const groups: Group[] = [];
    let tokenOffset = 0;
    for (const cluster of graphemes(clean)) {
      const cjk = CJK_CHAR.test(cluster);
      const start = tokenOffset;
      const { flowText, flowExclusion: clusterExclusion } = excludeFlow(
        cluster,
        start,
        exclusion,
      );
      tokenOffset = start + cluster.length;
      const last = groups[groups.length - 1];
      if (!cjk && last !== undefined && !last.cjk) {
        const previousLength = last.text.length;
        last.text += cluster;
        last.flowText += flowText;
        if (clusterExclusion !== undefined) {
          const shifted = {
            start: previousLength + clusterExclusion.start,
            end: previousLength + clusterExclusion.end,
          };
          if (last.flowExclusion === undefined) last.flowExclusion = shifted;
          else last.flowExclusion.end = shifted.end;
        }
      } else groups.push({ cjk, text: cluster, flowText, flowExclusion: clusterExclusion });
    }

    flushPendingSpace(runIndex, isAnyDash(clean.charCodeAt(0)));

    // Each group is measured in ISOLATION, deliberately unlike pushWord's
    // prefix-incremental scheme: engines disagree on kana kerning between
    // canvas and DOM (Chromium's DOM kerns kana pairs its canvas never
    // measures; WebKit is the inverse), so cross-cluster kerning cannot be
    // modeled consistently. Instead the model assumes NO kerning between
    // clusters — the traditional solid setting (bete-gumi) — and the
    // renderer disables it in the DOM to match (font-kerning: none on
    // CJK-bearing segments; see write.ts).
    let prev: { group: Group; width: number } | null = null;
    for (const group of groups) {
      const width = measure.width(group.flowText, run);
      if (prev !== null) {
        const before = prev.group.cjk
          ? prev.group.text
          : (graphemes(prev.group.text).pop() ?? "");
        const after = group.cjk ? group.text : (graphemes(group.text)[0] ?? "");
        items.push({
          type: ItemType.Penalty,
          // Inside a nowrap element every inter-cluster boundary is
          // break-prohibited; the glue still flexes for justification.
          penalty:
            prev.group.flowText.length > 0 &&
            pieceKey === undefined &&
            cjkBreakAllowed(before, after)
              ? 0
              : INF_PENALTY,
          width: 0,
          flagged: false,
          hyphen: false,
          rp: 0, // breakRp walks back to the box, whose own rp applies
          run: runIndex,
          cjk: true,
        } satisfies Penalty);
        // Glue basis ≈ the em: the neighboring CJK cluster's advance (mean
        // of the two when both are CJK — punctuation and halfwidth kana
        // then flex less, as they should). Never the non-CJK side: a whole
        // Latin word's width would wildly over-flex its two boundaries.
        const basis =
          prev.group.flowText.length === 0
            ? 0
            : prev.group.cjk && group.cjk
            ? (prev.width + width) / 2
            : prev.group.cjk
              ? prev.width
              : width;
        items.push({
          type: ItemType.Glue,
          width: 0,
          stretch: CJK_GLUE_STRETCH * basis,
          stretchFil: 0,
          shrink: CJK_GLUE_SHRINK * basis,
          run: runIndex,
          cjk: true,
        } satisfies Glue);
      }
      emitBox(
        makeBox(group.text, runIndex, width, group.flowText, group.flowExclusion),
        runIndex,
      );
      prev = { group, width };
    }
  };

  for (const piece of texts) {
    const { text, run } = piece;
    pieceKey = piece.atomicKey;
    piecePaintedStart = piece.paintedBox === true || piece.paintedStart === true;
    piecePaintedEnd = piece.paintedBox === true || piece.paintedEnd === true;
    if (piece.padStartPx !== undefined) pendingPad += piece.padStartPx;
    if (opts.protrusion !== false && piece.boxStartProtrusionPx !== undefined) {
      pendingPaintedStart = true;
      pendingBoxStartProtrusion += piece.boxStartProtrusionPx;
    }
    // Capturing split groups alternate with text. Separator entries are
    // classified from their first code unit: fixed-width separators are
    // single characters, while document-whitespace runs begin with one of
    // the four characters CSS collapses under white-space: normal.
    const parts = text.split(TEXT_SEPARATOR_SPLIT);
    let pieceOffset = 0;
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi]!;
      if (part.length === 0) continue;
      const partStart = pieceOffset;
      pieceOffset = partStart + part.length;
      if ((pi & 1) === 1) {
        const separator = part.charCodeAt(0);
        if (
          separator === 0x09 ||
          separator === 0x0a ||
          separator === 0x0d ||
          separator === 0x20
        ) {
          if (hasBox) {
            pendingSpaceRun = run;
            pendingLeadingSpace = !hasFlowBox;
          }
        } else {
          const overlap = clipExclusion(
            piece.flowExclusion,
            partStart,
            part.length,
          );
          pushOtherSpace(part, run, overlap);
        }
        continue;
      }
      const overlap = clipExclusion(piece.flowExclusion, partStart, part.length);
      if (mayBeCJK(part) && CJK_CHAR.test(part)) {
        pushCJKToken(part, run, overlap);
      } else {
        pushWord(part, run, overlap);
      }
    }
    // The element's trailing extras ride its LAST box, wherever the last
    // box-bearing piece was (this piece may end in whitespace, or be
    // whitespace-only). The reader guarantees a padded element contains at
    // least one box-worthy character, so lastBox is that element's. (The
    // cast: lastBox is only ever assigned inside emitBox, which TS's
    // narrowing can't see.)
    const lb = lastBox as Box | null;
    if ((piece.padEndPx !== undefined || piece.boxEndProtrusionPx !== undefined) && lb !== null) {
      if (piece.padEndPx !== undefined) {
        lb.width += piece.padEndPx;
        lb.padPx = (lb.padPx ?? 0) + piece.padEndPx;
      }
      if (piece.boxEndProtrusionPx !== undefined) {
        // Presence marks the real close even when the painted box is
        // unpadded (fixed hang 0). Padding accumulated on this same raw run
        // can include unpainted ancestors outside the painter.
        lb.paintedEnd = true;
        lb.rp =
          opts.protrusion === false
            ? 0
            : Math.max(piece.boxEndProtrusionPx, piece.padEndPx ?? 0);
      } else if (lb.paintedEnd === true) {
        // A later whitespace-only run may carry an unpainted ancestor's
        // closing padding while still referring to the painted descendant's
        // last box. Extend that already-established optical inset.
        if (opts.protrusion !== false) lb.rp += piece.padEndPx ?? 0;
      } else {
        // Ordinary padded inline: its decoration, not glyph punctuation,
        // remains the boundary, but no painted-box hanging is requested.
        lb.rp = 0;
      }
    }
  }
  pieceKey = undefined;
  piecePaintedStart = false;
  piecePaintedEnd = false;

  // \penalty10000 \parfillskip \penalty-10000
  pushPenalty(INF_PENALTY, 0, false, false, 0, 0);
  items.push({ type: ItemType.Glue, width: 0, stretch: 0, stretchFil: 1, shrink: 0, run: 0 });
  pushPenalty(-INF_PENALTY, 0, false, false, 0, 0);

  return withSums(items, runs);
}

/**
 * Attaches cumulative sums and the first-box index to an item stream.
 * Escape hatch for hand-built streams. Invariants the breaker relies on:
 * widths/stretch/shrink must be nonnegative (negative glue would break
 * active-node deactivation monotonicity) and the stream must end with a
 * forced penalty (penalty ≤ −INF_PENALTY).
 */
export function withSums(items: Item[], runs: readonly RunMetrics[]): ParagraphItems {
  const n = items.length;
  const cumW = new Float64Array(n + 1);
  const cumY = new Float64Array(n + 1);
  const cumYfil = new Float64Array(n + 1);
  const cumZ = new Float64Array(n + 1);
  const cumExpY = new Float64Array(n + 1);
  const cumExpZ = new Float64Array(n + 1);
  const cumTrackY = new Float64Array(n + 1);
  const firstBoxAfter = new Int32Array(n + 1);
  const lastBoxBefore = new Int32Array(n + 1);
  lastBoxBefore[0] = -1;

  for (let i = 0; i < n; i++) {
    const it = items[i]!;
    lastBoxBefore[i + 1] = it.type === ItemType.Box ? i : lastBoxBefore[i]!;
    let w = 0, y = 0, yFil = 0, z = 0, ey = 0, ez = 0, ty = 0;
    if (it.type === ItemType.Box) {
      w = it.width;
      ey = it.expStretch;
      ez = it.expShrink;
      // Tracking folds into the GLUE sums: it flexes continuously with the
      // same ratio as glue (unlike expansion, which quantizes), so breaker
      // badness and layout distribution need no third pool. cumTrackY
      // exists only so the layout can saturate tracking at stretch ratio 1.
      y = ty = it.trackStretch;
      z = it.trackShrink;
    } else if (it.type === ItemType.Glue) {
      w = it.width;
      y = it.stretch;
      yFil = it.stretchFil;
      z = it.shrink;
    }
    cumW[i + 1] = cumW[i]! + w;
    cumY[i + 1] = cumY[i]! + y;
    cumYfil[i + 1] = cumYfil[i]! + yFil;
    cumZ[i + 1] = cumZ[i]! + z;
    cumExpY[i + 1] = cumExpY[i]! + ey;
    cumExpZ[i + 1] = cumExpZ[i]! + ez;
    cumTrackY[i + 1] = cumTrackY[i]! + ty;
  }

  firstBoxAfter[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    firstBoxAfter[i] = items[i]!.type === ItemType.Box ? i : firstBoxAfter[i + 1]!;
  }

  return {
    items,
    runs,
    cumW,
    cumY,
    cumYfil,
    cumZ,
    cumExpY,
    cumExpZ,
    cumTrackY,
    firstBoxAfter,
    lastBoxBefore,
  };
}
