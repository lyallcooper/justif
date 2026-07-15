import { describe, expect, it } from "vitest";
import {
  badness,
  demerits,
  Fitness,
  fitness,
  INF_BAD,
} from "../src/core/badness.js";

describe("badness", () => {
  it("matches TeX's canonical values", () => {
    // Fully stretched line (t = s): TeX gives exactly 100.
    expect(badness(1, 1)).toBe(100);
    expect(badness(50, 50)).toBe(100);
    // Half the stretchability used: TeX gives 12 (not 12.5 — integer approx).
    expect(badness(0.5, 1)).toBe(12);
    // A fifth: ⌊(59³ + 2¹⁷)/2¹⁸⌋ = 1.
    expect(badness(0.2, 1)).toBe(1);
  });

  it("is 0 when no adjustment is needed", () => {
    expect(badness(0, 1)).toBe(0);
    expect(badness(-2, 1)).toBe(0);
  });

  it("is infinite with no available stretch", () => {
    expect(badness(1, 0)).toBe(INF_BAD);
    expect(badness(1, -3)).toBe(INF_BAD);
  });

  it("saturates at INF_BAD for extreme ratios", () => {
    // r = 297·t/s > 1290 ⇔ t/s > ~4.343
    expect(badness(4.35, 1)).toBe(INF_BAD);
    expect(badness(4.3, 1)).toBeLessThan(INF_BAD);
  });

  it("is monotonic in t/s", () => {
    let prev = -1;
    for (let t = 0; t <= 5; t += 0.05) {
      const b = badness(t, 1);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
  });
});

describe("fitness", () => {
  it("classifies per TeX §834 boundaries", () => {
    expect(fitness(false, 0)).toBe(Fitness.Decent);
    expect(fitness(false, 12)).toBe(Fitness.Decent);
    expect(fitness(true, 12)).toBe(Fitness.Decent);
    expect(fitness(false, 13)).toBe(Fitness.Loose);
    expect(fitness(true, 13)).toBe(Fitness.Tight);
    expect(fitness(false, 99)).toBe(Fitness.Loose);
    expect(fitness(false, 100)).toBe(Fitness.VeryLoose);
    expect(fitness(false, INF_BAD)).toBe(Fitness.VeryLoose);
  });
});

describe("demerits", () => {
  const linePenalty = 10;

  it("is (linePenalty + badness)² for penalty-free breaks", () => {
    expect(demerits(linePenalty, 0, 0)).toBe(100);
    expect(demerits(linePenalty, 100, 0)).toBe(110 * 110);
  });

  it("adds p² for positive penalties", () => {
    expect(demerits(linePenalty, 0, 50)).toBe(100 + 2500);
  });

  it("subtracts p² for finite negative penalties", () => {
    expect(demerits(linePenalty, 0, -50)).toBe(100 - 2500);
  });

  it("ignores forced-break penalties", () => {
    expect(demerits(linePenalty, 0, -10000)).toBe(100);
  });

  it("caps the base term at 10⁸ like TeX", () => {
    expect(demerits(linePenalty, INF_BAD, 0)).toBe(100_000_000);
  });
});
