/**
 * CJK (Japanese-first) line-breaking support: script detection, grapheme
 * segmentation, and the kinsoku shori (禁則処理) character classes.
 *
 * CJK text has no inter-word spaces; lines may break between almost any two
 * characters, and justification distributes space BETWEEN characters
 * (JIS X 4051's inter-character expansion) rather than at word gaps. The
 * item builder therefore turns each CJK grapheme cluster into its own box
 * and separates adjacent boxes with a zero-width break penalty plus a small
 * stretchable glue — see buildItems. Everything here is DOM-free.
 */

/**
 * One CJK character: the Han/kana/Hangul scripts by Unicode property (which
 * also covers the astral Han extensions), plus the script-Common code points
 * that live inside CJK text and must be typeset like it — CJK symbols and
 * punctuation (、。「」 etc., U+3000–303F), the kana block's Common members
 * (゠・ー — the prolonged sound mark is NOT Script=Katakana), small kana
 * extensions, and the fullwidth/halfwidth forms (！？ＡＢ｡｢ etc.).
 */
export const CJK_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\u30A0\u30FB\u30FC\u31F0-\u31FF\uFF00-\uFF65\uFFE0-\uFFE6]/u;

/**
 * Kinsoku: characters that must never START a line (行頭禁則). JIS X 4051's
 * core set: closing brackets and quotes, sentence and clause stops, mid-dots
 * and fullwidth delimiters, small kana (they modify the preceding syllable),
 * iteration marks, the prolonged sound mark, and hyphen-like dashes — plus
 * their ASCII counterparts, which mixed Japanese/Latin text uses freely.
 * A break whose next line would open with one of these is suppressed.
 */
export const kinsokuNotAtLineStart =
  "、。，．・：；？！゛゜´¨‐–—〜゠…‥" + // stops, delimiters, dashes, ellipses
  "」』）〕］｝〉》】〙〗〟’”｠»›" + // closing brackets and quotes
  "ぁぃぅぇぉっゃゅょゎゕゖ" + // small hiragana
  "ァィゥェォッャュョヮヵヶ" + // small katakana
  "ㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ" + // small kana extensions (Ainu)
  "ーヽヾゝゞ々〻" + // prolonged sound + iteration marks
  "｡｣､･ｰ" + // halfwidth forms
  "!?,.:;)]}‼⁇⁈⁉%‰°′″℃-"; // ASCII/compat counterparts

/**
 * Kinsoku: characters that must never END a line (行末禁則): opening
 * brackets and quotes (fullwidth and ASCII). A break whose line would close
 * with one of these is suppressed.
 */
export const kinsokuNotAtLineEnd = "「『（〔［｛〈《【〘〖〝‘“｟«‹｢([{";

const NOT_AT_START = new Set(kinsokuNotAtLineStart);
const NOT_AT_END = new Set(kinsokuNotAtLineEnd);

/**
 * May a line break fall between the clusters `before` | `after`? Prohibited
 * when `before` must not end a line (opening bracket) or `after` must not
 * start one (stop, closing bracket, small kana…). Multi-code-point clusters
 * are never kinsoku characters, so Set membership on the whole cluster is
 * exact.
 */
export function cjkBreakAllowed(before: string, after: string): boolean {
  return !NOT_AT_END.has(before) && !NOT_AT_START.has(after);
}

/**
 * Inter-character glue, as fractions of the neighboring cluster's advance
 * (≈ the em for fullwidth characters): Japanese convention is natural width
 * zero with modest stretch — space appears between characters only when a
 * line needs it — and only a whisker of shrink (characters may kiss, never
 * overlap). 0.1 em stretch per gap justifies a worst-case one-character
 * deficit across a normal measure at a mild ratio without looking gappy.
 */
export const CJK_GLUE_STRETCH = 0.1;
export const CJK_GLUE_SHRINK = 0.02;

/** Minimal Intl.Segmenter surface (the core's lib target predates its
 * typings; the runtime feature test below is the real gate). */
interface GraphemeSegmenter {
  segment(text: string): Iterable<{ segment: string }>;
}
type SegmenterCtor = new (
  locales?: string,
  options?: { granularity: "grapheme" },
) => GraphemeSegmenter;

let segmenter: GraphemeSegmenter | null | undefined;

/**
 * Grapheme clusters of `text` (Intl.Segmenter). The no-Segmenter fallback
 * splits by code point but keeps combining marks attached to their base, so
 * a cluster is never split by a break opportunity even on old engines.
 */
export function graphemes(text: string): string[] {
  if (segmenter === undefined) {
    const ctor =
      typeof Intl !== "undefined"
        ? (Intl as { Segmenter?: SegmenterCtor }).Segmenter
        : undefined;
    segmenter = ctor === undefined ? null : new ctor(undefined, { granularity: "grapheme" });
  }
  if (segmenter !== null) {
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  const out: string[] = [];
  for (const cp of text) {
    if (out.length > 0 && /\p{M}/u.test(cp)) out[out.length - 1] += cp;
    else out.push(cp);
  }
  return out;
}
