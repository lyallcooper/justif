import { applyFontSpec, type FontSpec } from "./measure.js";

/**
 * Canvas cannot measure at arbitrary font-stretch values (keyword-only API,
 * no font-variation-settings — whatwg/html#3571), so expansion widths come
 * from a one-time per-font DOM calibration: a hidden off-flow span measures
 * one calibration string at 100% and at both expansion endpoints. Variable
 * font interpolation is linear between masters, so per-word widths scale by
 * the measured ratio. Fonts without a responsive wdth axis calibrate to
 * ratio 1, which disables expansion for that run automatically.
 */

export interface StretchCalibration {
  /** Width multiplier at font-stretch (100 + 100·max)%. 1 = unresponsive. */
  ratioAtMax: number;
  /** Width multiplier at font-stretch (100 − 100·shrink)%. */
  ratioAtMin: number;
  /**
   * Measured width multipliers at each quantized stretch percent the layout
   * can emit — the renderer's width model is then measured, not
   * interpolated (wdth axes are not perfectly linear).
   */
  ratios?: ReadonlyMap<number, number>;
}

export const NO_EXPANSION: StretchCalibration = { ratioAtMax: 1, ratioAtMin: 1 };

const CALIBRATION_STRING =
  "Sphinx of black quartz, judge my vow; 0123456789 flavors of justified text.";
/** Below this width delta (px) the axis is considered unresponsive. */
const RESPONSE_EPSILON = 0.05;

/**
 * Script-representative calibration texts. Expansion must be calibrated
 * against the glyphs that will actually render: under font fallback the
 * primary font's Latin response says nothing about the fallback font's
 * (typically zero) response, and a Latin-calibrated ratio applied to
 * fallback-rendered Hebrew/Arabic makes every expanded line ragged by the
 * full expansion delta. Calibrating with the run's own script makes the
 * existing responsiveness detection work per script: an unresponsive
 * fallback calibrates to ratio 1 and expansion disables for exactly those
 * runs, while a genuinely variable RTL font keeps it.
 */
// Letters only, no spaces: the SPACE glyph comes from the primary font
// (fallback only covers missing glyphs), so a space in the sample would
// leak the primary font's response into the fallback's calibration —
// enough (~0.1%) to clear RESPONSE_EPSILON and keep useless expansion on.
const HEBREW_SAMPLE = "אבגדהוזחטיכלמנסעפצקרשת";
const ARABIC_SAMPLE = "الحمدللهربالعالمينوبهنستعين";
// Han + kana + Hangul: CJK typically renders via a system fallback when
// the author's primary is a Latin webfont, with the same mismatch.
const CJK_SAMPLE = "永国酬鷹醸あかすなのはたまアカナタマ가나다라마바사";

function calibrationTextFor(runText: string | undefined): { text: string; tag: string } {
  let text = "";
  let tag = "";
  if (runText !== undefined) {
    if (/\p{Script=Hebrew}/u.test(runText)) {
      text = HEBREW_SAMPLE;
      tag = "he";
    }
    if (/\p{Script=Arabic}/u.test(runText)) {
      text += ARABIC_SAMPLE;
      tag += "ar";
    }
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(runText)) {
      text += CJK_SAMPLE;
      tag += "cjk";
    }
  }
  return text === "" ? { text: CALIBRATION_STRING, tag: "" } : { text, tag };
}

const cache = new Map<string, StretchCalibration>();

export function calibrateStretch(
  spec: FontSpec,
  maxPct: number,
  minPct: number,
  samplePcts: readonly number[] = [],
  runText?: string,
): StretchCalibration {
  const { text: calibrationText, tag } = calibrationTextFor(runText);
  const cacheKey = `${spec.key}|${maxPct}|${minPct}|${samplePcts.join(",")}|${tag}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;

  // An author-pinned wdth overrides any font-stretch we emit — expansion
  // would silently no-op, so disable it up front. Likewise an author
  // font-stretch ≠ 100%: our per-line value would clobber it.
  if (
    spec.variationSettings.includes('"wdth"') ||
    (spec.stretch !== "100%" && spec.stretch !== "normal")
  ) {
    cache.set(cacheKey, NO_EXPANSION);
    return NO_EXPANSION;
  }
  if (typeof document === "undefined" || document.body === null) return NO_EXPANSION;

  const host = document.createElement("div");
  host.style.cssText =
    "position:absolute;left:-100000px;top:0;visibility:hidden;white-space:pre;width:max-content;contain:layout style;";
  const span = document.createElement("span");
  // Expansion must be calibrated with the same substitutions/features the
  // run renders with: small caps, alternate figures, stylistic sets, and
  // the other font-variant longhands can all change the response of its
  // glyph mix to the width axis.
  applyFontSpec(span, spec);
  span.textContent = calibrationText;
  host.append(span);
  document.body.append(host);

  const widthAt = (stretch: string): number => {
    span.style.fontStretch = stretch;
    return span.getBoundingClientRect().width;
  };

  let result: StretchCalibration;
  try {
    const base = widthAt("100%");
    const wide = widthAt(maxPct + "%");
    const narrow = widthAt(minPct + "%");
    const ratioAtMax = base > 0 && Math.abs(wide - base) > RESPONSE_EPSILON ? wide / base : 1;
    const ratioAtMin = base > 0 && Math.abs(narrow - base) > RESPONSE_EPSILON ? narrow / base : 1;
    let ratios: Map<number, number> | undefined;
    if (base > 0 && (ratioAtMax !== 1 || ratioAtMin !== 1) && samplePcts.length > 0) {
      ratios = new Map();
      for (const pct of samplePcts) {
        // Unresponsive side: pin to 1 so layout matches the disabled budget.
        if (pct > 100 && ratioAtMax === 1) ratios.set(pct, 1);
        else if (pct < 100 && ratioAtMin === 1) ratios.set(pct, 1);
        else ratios.set(pct, widthAt(pct + "%") / base);
      }
    }
    result = { ratioAtMax, ratioAtMin, ratios };
  } finally {
    host.remove();
  }

  cache.set(cacheKey, result);
  return result;
}

/** Drop calibrations (call when webfonts finish loading). */
export function clearCalibrationCache(): void {
  cache.clear();
}
