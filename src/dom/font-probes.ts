/**
 * Which font faces the content actually needs, and whether they have arrived.
 *
 * The initial enhancement commits against whatever is RENDERING at that
 * moment, so a webfont still in flight is measured as its fallback. Something
 * then has to decide when the real face has landed and the layout must be
 * rebuilt — and `document.fonts` cannot be that something: `check()` answers
 * true for a still-loading face whenever the font string carries an available
 * fallback (WebKit), and `loadingdone` never fires at all for CSS-initiated
 * loads there. Measured advances are the only ground truth, so this samples
 * each face against the text the content really sets and watches those numbers
 * move.
 */

import { ctxFontOf, probeAdvance } from "./measure.js";
import type { ParagraphScan } from "./read.js";

/** One entry per ctx font the content needs. `sample` holds every distinct
 * code point set in that font — faces are matched by unicode-range against
 * concrete text, so both the load() await and the change probe must carry the
 * scripts the content really uses (document.fonts.load() defaults to U+0020; a
 * fixed Latin sentinel is blind to a Greek/CJK/symbol subset face).
 * `kernSample` is a slice of RAW run text: real letter sequences, so a face
 * that differs from its fallback only in kerning/shaping of adjacent pairs —
 * metric-clone families, size-adjust-tuned fallbacks — still moves a probe
 * even when per-glyph advances match. Baselines are the advances as of the
 * last commit/re-measure. */
export interface FontProbe {
  font: string;
  sample: string;
  kernSample: string;
  baseline: number;
  kernBaseline: number;
}

const KERN_SAMPLE_MAX = 256;

/**
 * Per-font samples: every DISTINCT code point the content sets in that font,
 * spaces included (they size the glue), plus a raw-text kerning slice. No
 * injected seed — foreign-script filler would force unrelated subset faces to
 * download — and no cap on the code points: discarding later ones would blind
 * both the load() await and the change probe to exactly the scripts it dropped
 * (CJK documents, aggressively partitioned unicode-range families).
 * Distinctness bounds the sample; probeAdvance measures in chunks, so cost
 * stays flat even for ideographic content.
 */
export function collectFontProbes(
  scans: readonly ParagraphScan[],
  hyphenating: boolean,
): FontProbe[] {
  const fontSample = new Map<
    string,
    { chars: Set<string>; ascii: Uint8Array; kern: string }
  >();
  for (const scan of scans) {
    for (const spec of scan.specs) {
      const font = ctxFontOf(spec);
      if (!fontSample.has(font)) {
        fontSample.set(font, { chars: new Set(), ascii: new Uint8Array(128), kern: "" });
      }
    }
    for (const run of scan.runs) {
      const s = fontSample.get(ctxFontOf(scan.specs[run.spec]!))!;
      // ASCII — nearly every code unit of a Latin document — is screened by a
      // flat table first: this walk covers every character of every run, and
      // hashing the same 70-odd strings into a Set was most of its cost.
      const text = run.text;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 128) {
          if (s.ascii[code] === 1) continue;
          s.ascii[code] = 1;
          s.chars.add(text[i]!);
        } else {
          // Non-ASCII: take the whole code point, so a surrogate pair enters
          // the set as one character exactly as the string iterator gave it.
          const cp = String.fromCodePoint(text.codePointAt(i)!);
          s.chars.add(cp);
          i += cp.length - 1;
        }
      }
      if (s.kern.length < KERN_SAMPLE_MAX) {
        s.kern += run.text.slice(0, KERN_SAMPLE_MAX - s.kern.length);
      }
      // Hyphenatable content renders a "-" the runs may not contain (the
      // break glyph is measured per spec and painted via ::after) — a face
      // serving U+002D must be awaited and watched too.
      if (hyphenating || run.text.includes("\u00AD")) s.chars.add("-");
    }
  }
  // A font no run draws from (a base spec whose text all sits in inline
  // children) still sizes the paragraph's word spaces — its space glyph is
  // the one piece of it the layout consumes.
  return [...fontSample].map(([font, s]) => ({
    font,
    sample: s.chars.size === 0 ? " " : [...s.chars].join(""),
    kernSample: s.kern,
    baseline: 0,
    kernBaseline: 0,
  }));
}
/** Take the advances as they stand now as the baselines to compare against —
 * after a commit or a re-measure, which is what makes them current. */
export function reprobeBaselines(probes: readonly FontProbe[]): void {
  for (const f of probes) {
    f.baseline = probeAdvance(f.font, f.sample);
    f.kernBaseline = probeAdvance(f.font, f.kernSample);
  }
}

/** Has any sampled face changed what it measures since the last baseline? */
export function probesChanged(probes: readonly FontProbe[]): boolean {
  return probes.some(
    (f) =>
      Math.abs(probeAdvance(f.font, f.sample) - f.baseline) > 0.01 ||
      Math.abs(probeAdvance(f.font, f.kernSample) - f.kernBaseline) > 0.01,
  );
}
