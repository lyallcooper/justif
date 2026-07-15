import { describe, expect, it } from "vitest";
import { hyphenateEnUS } from "../src/hyphenation/en-us.js";
import { createHyphenator } from "../src/hyphenation/liang.js";

describe("Liang engine", () => {
  it("applies pattern digits and odd-value breaks", () => {
    // Toy patterns: break "abcd" between b and c.
    const hyphenate = createHyphenator({ patterns: "b1c", leftmin: 1, rightmin: 1 });
    expect(hyphenate("abcd")).toEqual(["ab", "cd"]);
  });

  it("lets higher even digits suppress breaks", () => {
    const hyphenate = createHyphenator({ patterns: "b1c ab2c", leftmin: 1, rightmin: 1 });
    expect(hyphenate("abcd")).toEqual(["abcd"]);
  });

  it("honors leftmin/rightmin", () => {
    const hyphenate = createHyphenator({ patterns: "a1b", leftmin: 2, rightmin: 2 });
    expect(hyphenate("ab")).toEqual(["ab"]);
    expect(hyphenate("abcc")).toEqual(["abcc"]); // break would leave 1 letter left
    expect(hyphenate("aabb")).toEqual(["aa", "bb"]); // exactly 2+2 is allowed
  });

  it("respects exceptions verbatim", () => {
    const hyphenate = createHyphenator({
      patterns: "a1b",
      exceptions: "ta-ble project",
      leftmin: 1,
      rightmin: 1,
    });
    expect(hyphenate("table")).toEqual(["ta", "ble"]);
    expect(hyphenate("project")).toEqual(["project"]);
  });
});

describe("en-US patterns (TeX's classic results)", () => {
  const cases: Array<[string, string]> = [
    ["hyphenation", "hy-phen-ation"],
    ["concatenation", "con-cate-na-tion"],
    ["mathematics", "math-e-mat-ics"],
    ["typography", "ty-pog-ra-phy"],
    // rightmin 3 forbids the folklore "com-put-er"; TeX itself agrees.
    ["computer", "com-puter"],
    ["algorithm", "al-go-rithm"],
    ["reciprocity", "reci-procity"], // exception list
    ["associate", "as-so-ciate"], // exception list
    ["table", "ta-ble"], // exception list
    ["project", "project"], // exception list: never hyphenated
    ["present", "present"], // exception list: never hyphenated
    [
      "supercalifragilisticexpialidocious",
      "su-per-cal-ifrag-ilis-tic-ex-pi-ali-do-cious",
    ],
  ];

  for (const [word, expected] of cases) {
    it(`${word} → ${expected}`, () => {
      expect(hyphenateEnUS(word).join("-")).toBe(expected);
    });
  }

  it("pieces always rejoin to the input word", () => {
    const words =
      "in olden times when wishing still helped one there lived king whose daughters were all beautiful youngest astonished whenever fountain plaything favorite".split(
        " ",
      );
    for (const word of words) {
      expect(hyphenateEnUS(word).join("")).toBe(word);
      for (const piece of hyphenateEnUS(word)) expect(piece.length).toBeGreaterThan(0);
    }
  });

  it("never breaks closer than leftmin 2 / rightmin 3", () => {
    for (const word of ["about", "eaten", "idea", "aroma", "opera"]) {
      const pieces = hyphenateEnUS(word);
      expect(pieces[0]!.length).toBeGreaterThanOrEqual(2);
      expect(pieces[pieces.length - 1]!.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("createHyphenator (public engine for other languages)", () => {
  it("drives arbitrary TeX pattern data", () => {
    const h = createHyphenator({ patterns: "s1t", leftmin: 2, rightmin: 3 });
    expect(h("hostel")).toEqual(["hos", "tel"]);
  });

  it("handles non-ASCII letters in patterns and words", () => {
    const h = createHyphenator({ patterns: "u1s", leftmin: 2, rightmin: 3 });
    expect(h("häuser")).toEqual(["häu", "ser"]);
  });

  it("honors exceptions and hyphenmins", () => {
    const h = createHyphenator({
      patterns: "s1t",
      exceptions: "host-el",
      leftmin: 2,
      rightmin: 3,
    });
    expect(h("hostel")).toEqual(["host", "el"]);
    // rightmin 3 forbids the s|t break in a 5-letter word ending "tel"? no:
    // "as" + "tel" — leftmin 2 allows it; a 4-letter word is too short.
    expect(h("stst")).toEqual(["stst"]);
  });
});
