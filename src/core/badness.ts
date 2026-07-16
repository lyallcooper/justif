/**
 * TeX-exact badness and demerits arithmetic (TeX: The Program §108, §834,
 * §859). Pure functions of numbers; the breaker composes them.
 */

/** TeX's "infinite" badness. */
export const INF_BAD = 10000;

/**
 * The stretch-to-flex ratio at which a line becomes underfull by TeX's
 * default standards: \hbadness=1000 is the badness above which TeX reports
 * an underfull hbox, and 100·r³ = 1000 at r = ∛10 ≈ 2.15 (spaces at about
 * twice their natural width under default spacing).
 */
export const UNDERFULL_RATIO = Math.cbrt(10);

/**
 * How far a lastLineMinWidth ending is willing to stretch its word glue to
 * reach the threshold, as a stretch-to-flex ratio: the willingness scales
 * with the setting, so demanding rectangles (1) works the spaces up to the
 * underfull bound (~2× natural) while a gentle floor (0.33) barely opens
 * them (~1.35×). Endings that would need more revert to natural spacing
 * entirely — all or nothing: a line both stretched and still short reads
 * worse than a ragged one. Shared by the breaker's ending cost and the
 * layout floor so pricing and rendering can never disagree about
 * reachability.
 */
export function maxEndingStretch(minWidth: number): number {
  return minWidth * UNDERFULL_RATIO;
}

/**
 * Penalties at or above this value forbid a break; at or below its negation,
 * force one.
 */
export const INF_PENALTY = 10000;

export const Fitness = {
  Tight: 0,
  Decent: 1,
  Loose: 2,
  VeryLoose: 3,
} as const;
export type Fitness = (typeof Fitness)[keyof typeof Fitness];

/**
 * badness(t, s) ≈ 100·(t/s)³ using TeX's integer approximation
 * (⌊(⌊297·t/s⌋³ + 2¹⁷) / 2¹⁸⌋), so fixtures reproduce TeX's exact values:
 * a line stretched by its full stretchability (t = s) has badness 100, half
 * of it badness 12.
 *
 * `t` is the stretch or shrink needed (≥ 0), `s` the amount available.
 */
export function badness(t: number, s: number): number {
  if (t <= 0) return 0;
  if (s <= 0) return INF_BAD;
  const r = Math.floor((297 * t) / s);
  if (r > 1290) return INF_BAD;
  return Math.floor((r * r * r + 0x20000) / 0x40000);
}

/**
 * TeX's fitness classification (§834): decent when badness ≤ 12, tight when
 * shrinking beyond that, loose/very-loose when stretching beyond it. Adjacent
 * lines whose classes differ by more than one incur `adjDemerits`.
 */
export function fitness(shrinking: boolean, b: number): Fitness {
  if (b <= 12) return Fitness.Decent;
  if (shrinking) return Fitness.Tight;
  return b < 100 ? Fitness.Loose : Fitness.VeryLoose;
}

/**
 * Base demerits for one line (§859): (linePenalty + badness)² — capped like
 * TeX at 10⁸ when the sum reaches 10000 — plus/minus the penalty squared for
 * finite positive/negative break penalties. Flag- and fitness-based extras
 * (doubleHyphenDemerits, adjDemerits, finalHyphenDemerits) are added by the
 * breaker, which knows both breakpoints.
 */
export function demerits(linePenalty: number, b: number, p: number): number {
  const base = linePenalty + b;
  let d = Math.abs(base) >= 10000 ? 100_000_000 : base * base;
  if (p > 0) d += p * p;
  else if (p > -INF_PENALTY) d -= p * p;
  return d;
}

/**
 * demerits() without the 10⁸ cap on the squared term, for paragraph-final
 * fil lines whose badness is deliberately uncapped (see the breaker's fil
 * branch): the cap would re-flatten the short-ending pressure one level up.
 * Identical to demerits() whenever |linePenalty + b| < 10000.
 */
export function demeritsUncapped(linePenalty: number, b: number, p: number): number {
  const base = linePenalty + b;
  let d = base * base;
  if (p > 0) d += p * p;
  else if (p > -INF_PENALTY) d -= p * p;
  return d;
}
