/**
 * TeX-exact badness and demerits arithmetic (TeX: The Program §108, §834,
 * §859). Pure functions of numbers; the breaker composes them.
 */

/** TeX's "infinite" badness. */
export const INF_BAD = 10000;

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
