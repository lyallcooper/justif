import { describe, expect, it } from "vitest";
import { fontProtrusion } from "../src/core/protrusion-fonts.js";
import { composeProtrusion, latinProtrusion, protrusionCodes } from "../src/core/protrusion.js";

describe("fontProtrusion", () => {
  it("matches by the first CSS family name, quote- and case-insensitively", () => {
    expect(fontProtrusion('"EB Garamond", serif')).toBeDefined();
    expect(fontProtrusion("eb garamond")).toBeDefined();
    expect(fontProtrusion("'Times New Roman', Times, serif")).toBeDefined();
    expect(fontProtrusion("Junicode, Georgia, serif")).toBeUndefined();
    expect(fontProtrusion("Georgia")).toBeUndefined();
  });

  it("carries microtype's hand-tuned per-font values", () => {
    // mt-ebg: period 600 (generic is 700), colon 400, T 70/70.
    const ebg = fontProtrusion("EB Garamond")!;
    expect(ebg["."]).toEqual({ r: 600 });
    expect(ebg[":"]).toEqual({ r: 400 });
    expect(ebg.T).toEqual({ l: 70, r: 70 });
    // mt-ptm: Y 80/80, 1 gets 150/150 in lining figures.
    const ptm = fontProtrusion("Times New Roman")!;
    expect(ptm.Y).toEqual({ l: 80, r: 80 });
    expect(ptm["1"]).toEqual({ l: 150, r: 150 });
    // The generic table stays the fallback and differs where hand tuning does.
    expect(latinProtrusion["."]).toEqual({ r: 700 });
  });
});

describe("protrusionCodes (universal character inheritance)", () => {
  it("resolves accents via NFD and stroked/homoglyph forms via the shape map", () => {
    const A = latinProtrusion.A;
    expect(protrusionCodes(latinProtrusion, "À")).toBe(A); // NFD
    expect(protrusionCodes(latinProtrusion, "Ǻ")).toBe(A); // stacked accents
    expect(protrusionCodes(latinProtrusion, "А")).toBe(A); // Cyrillic homoglyph
    expect(protrusionCodes(latinProtrusion, "Α")).toBe(A); // Greek homoglyph
    expect(protrusionCodes(latinProtrusion, "Ł")).toBe(latinProtrusion.L); // stroked
    expect(protrusionCodes(latinProtrusion, "ý")).toBe(latinProtrusion.y);
    // Two-step chain: Ӓ → NFD → А (Cyrillic) → shape map → A.
    expect(protrusionCodes(latinProtrusion, "Ӓ")).toBe(A);
    // Own entries always win over inheritance.
    expect(protrusionCodes(latinProtrusion, "Æ")).toBe(latinProtrusion["Æ"]);
    // Unknown characters resolve to nothing.
    expect(protrusionCodes(latinProtrusion, "→")).toBeUndefined();
    expect(protrusionCodes(latinProtrusion, "m")).toBeUndefined();
  });
});

describe("composeProtrusion (hanging-punctuation scoping)", () => {
  it("line-end-only mode fully hangs endings and preserves optical starts", () => {
    const { rest, first } = composeProtrusion(latinProtrusion, null, "line-end-only");
    expect(first).toBe(rest);
    expect(rest[","]).toEqual({ r: 1000 });
    expect(rest["“"]!.l).toBe(latinProtrusion["“"]!.l);
    expect(rest["“"]!.r).toBe(1000);
  });

  it("first-line-and-line-ends: r-hangs everywhere, full l-hang on line 0, flush after", () => {
    const { rest, first } = composeProtrusion(
      latinProtrusion,
      null,
      "first-line-and-line-ends",
    );
    expect(first).not.toBe(rest);
    // Stops hang fully at every line end.
    expect(rest[","]).toEqual({ r: 1000 });
    expect(first[","]).toEqual({ r: 1000 });
    // Opening quote: full on the first line, FLUSH on later line starts —
    // one mark must not show two hang depths in one paragraph (issue #14).
    expect(first["“"]!.l).toBe(1000);
    expect(rest["“"]!.l).toBe(0);
    expect(rest["“"]!.r).toBe(1000);
    // Brackets are not full-hang characters: they keep microtype's ordinary
    // protrusion, the same on the first line and every line after it (‰ of
    // advance; a live LuaLaTeX run gives "(" the same 100 and "[" nothing).
    expect(first["("]!.l).toBe(latinProtrusion["("]!.l);
    expect(rest["("]!.l).toBe(latinProtrusion["("]!.l);
    expect(rest["{"]!.l).toBe(latinProtrusion["{"]!.l);
    expect(rest["["]).toBeUndefined();
    // Characters outside the full-hang set keep microtype's values on every
    // line — the flush overlay is scoped to the marks that hang fully.
    expect(rest["—"]!.l).toBe(latinProtrusion["—"]!.l);
    expect(rest["T"]!.l).toBe(latinProtrusion["T"]!.l);
    expect(rest["?"]!.r).toBe(latinProtrusion["?"]!.r);
  });

  it("all-line-edges mode collapses to one table; off returns the base", () => {
    const all = composeProtrusion(latinProtrusion, null, "all-line-edges");
    expect(all.first).toBe(all.rest);
    expect(all.rest["“"]!.l).toBe(1000);
    const off = composeProtrusion(latinProtrusion, null, false);
    expect(off.rest).toBe(latinProtrusion);
    expect(off.first).toBe(latinProtrusion);
  });

  it("retains the older spellings as exact aliases and accepts none", () => {
    expect(composeProtrusion(latinProtrusion, null, "all-lines")).toEqual(
      composeProtrusion(latinProtrusion, null, "all-line-edges"),
    );
    expect(composeProtrusion(latinProtrusion, null, "first-line")).toEqual(
      composeProtrusion(latinProtrusion, null, "first-line-and-line-ends"),
    );
    expect(composeProtrusion(latinProtrusion, null, "none")).toEqual(
      composeProtrusion(latinProtrusion, null, false),
    );
  });

  it("composes over an EMPTY base: flush glyphs, hanging marks", () => {
    // `protrusion: false` with hanging left on. The model contributes no base
    // table, so the only entries are the hang overlay's own: ordinary glyphs
    // sit exactly flush while the eligible marks still hang.
    const { rest, first } = composeProtrusion({}, null, "line-end-only");
    expect(first).toBe(rest);
    expect(rest[","]).toEqual({ r: 1000 });
    expect(rest["“"]).toEqual({ r: 1000 });
    // Nothing the hang overlay does not name — no optical alignment at all.
    expect(rest.T).toBeUndefined();
    expect(rest["—"]).toBeUndefined();
    expect(rest["?"]).toBeUndefined();
    // Brackets are not full-hang characters, and with no base they get nothing.
    expect(rest["("]).toBeUndefined();
  });

  it("empty base, all-line-edges: marks hang on both sides and nothing else does", () => {
    const { rest, first } = composeProtrusion({}, null, "all-line-edges");
    expect(first).toBe(rest);
    expect(rest["“"]).toEqual({ l: 1000, r: 1000 });
    expect(rest[","]).toEqual({ r: 1000 });
    expect(rest.T).toBeUndefined();
  });

  it("empty base with hanging off composes nothing at all", () => {
    // The fourth state: strictly flush. resolveOptions skips composition
    // entirely here, but the composition itself must also be empty.
    expect(composeProtrusion({}, null, "none").rest).toEqual({});
    expect(composeProtrusion({}, null, false).rest).toEqual({});
  });

  it("user overrides beat the hang overlays in both tables", () => {
    const { rest, first } = composeProtrusion(
      latinProtrusion,
      { "“": { l: 123 } },
      "first-line-and-line-ends",
    );
    expect(rest["“"]).toEqual({ l: 123 });
    expect(first["“"]).toEqual({ l: 123 });
  });
});
