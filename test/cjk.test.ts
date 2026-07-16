import { describe, expect, it } from "vitest";
import { INF_PENALTY } from "../src/core/badness.js";
import { breakParagraph } from "../src/core/breaker.js";
import {
  CJK_CHAR,
  CJK_GLUE_SHRINK,
  CJK_GLUE_STRETCH,
  cjkBreakAllowed,
  graphemes,
  kinsokuNotAtLineEnd,
  kinsokuNotAtLineStart,
} from "../src/core/cjk.js";
import { buildItems } from "../src/core/items.js";
import { layoutLines, lineText } from "../src/core/layout.js";
import { hangingPunctuation, latinProtrusion } from "../src/core/protrusion.js";
import {
  type BuildOptions,
  defaultBreakOptions,
  defaultBuildOptions,
  type Glue,
  type Item,
  ItemType,
  type ParagraphItems,
  type Penalty,
} from "../src/core/types.js";
import { charWidth, kernedMeasure, mockMeasure, mockRun } from "./helpers/mock.js";

function build(text: string, opts: Partial<BuildOptions> = {}): ParagraphItems {
  return buildItems(
    [{ text, run: 0 }],
    [mockRun()],
    { ...defaultBuildOptions, ...opts },
    mockMeasure,
  );
}

/** Like items.test.ts's shape(), plus a · marker on CJK-flagged items. */
function shape(items: Item[]): string {
  return items
    .map((it) => {
      if (it.type === ItemType.Box) return `box(${it.text})`;
      if (it.type === ItemType.Glue) {
        return it.stretchFil > 0 ? "fil" : it.cjk === true ? "glue·" : "glue";
      }
      return `pen(${it.penalty}${it.cjk === true ? "·" : ""})`;
    })
    .join(" ");
}

const NOT_START = new Set(kinsokuNotAtLineStart);
const NOT_END = new Set(kinsokuNotAtLineEnd);

describe("CJK script detection", () => {
  it("classifies Han, kana, Hangul, fullwidth and CJK punctuation as CJK", () => {
    for (const ch of ["吾", "の", "ネ", "ー", "。", "「", "・", "한", "𠮷", "！", "Ａ", "ｱ", "　"]) {
      expect(CJK_CHAR.test(ch), ch).toBe(true);
    }
    for (const ch of ["a", "Z", "é", ",", "–", "«", "…"]) {
      expect(CJK_CHAR.test(ch), ch).toBe(false);
    }
  });

  it("kinsoku: stops and closers cannot start a line; openers cannot end one", () => {
    expect(cjkBreakAllowed("た", "。")).toBe(false);
    expect(cjkBreakAllowed("猫", "」")).toBe(false);
    expect(cjkBreakAllowed("キ", "ー")).toBe(false);
    expect(cjkBreakAllowed("ち", "ゃ")).toBe(false);
    expect(cjkBreakAllowed("「", "吾")).toBe(false);
    expect(cjkBreakAllowed("（", "一")).toBe(false);
    expect(cjkBreakAllowed("。", "名")).toBe(true);
    expect(cjkBreakAllowed("」", "と")).toBe(true);
    expect(cjkBreakAllowed("吾", "輩")).toBe(true);
  });
});

describe("buildItems on CJK text", () => {
  it("gives each CJK cluster its own box, joined by penalty(0) + space-less glue", () => {
    const para = build("吾輩は");
    expect(shape(para.items)).toBe(
      "box(吾) pen(0·) glue· box(輩) pen(0·) glue· box(は) pen(10000) fil pen(-10000)",
    );
  });

  it("inter-character glue: width 0, small stretch, tiny shrink, ∝ the cluster advance", () => {
    const para = build("吾輩");
    const glue = para.items[2] as Glue;
    expect(glue.type).toBe(ItemType.Glue);
    expect(glue.width).toBe(0);
    expect(glue.stretch).toBeCloseTo(CJK_GLUE_STRETCH * charWidth("吾"));
    expect(glue.shrink).toBeCloseTo(CJK_GLUE_SHRINK * charWidth("吾"));
  });

  it("suppresses breaks before line-start kinsoku characters (。、ー…)", () => {
    const para = build("猫だ。名");
    // だ|。 prohibited, 。|名 allowed.
    expect(shape(para.items)).toBe(
      "box(猫) pen(0·) glue· box(だ) pen(10000·) glue· box(。) pen(0·) glue· box(名) " +
        "pen(10000) fil pen(-10000)",
    );
  });

  it("suppresses breaks after line-end kinsoku characters (「（…)", () => {
    const para = build("は「猫」だ");
    const pens = para.items.filter(
      (it): it is Penalty => it.type === ItemType.Penalty && it.cjk === true,
    );
    // Boundaries: は|「 (ok), 「|猫 (prohibited), 猫|」 (prohibited: 」 must
    // not start a line), 」|だ (ok).
    expect(pens.map((p) => p.penalty)).toEqual([0, INF_PENALTY, INF_PENALTY, 0]);
  });

  it("keeps embedded Latin stretches whole and breaks only at their CJK boundaries", () => {
    const para = build("GDP成長率");
    expect(shape(para.items)).toBe(
      "box(GDP) pen(0·) glue· box(成) pen(0·) glue· box(長) pen(0·) glue· box(率) " +
        "pen(10000) fil pen(-10000)",
    );
  });

  it("never sends CJK text (or mixed-token Latin) to the hyphenator", () => {
    const calls: string[] = [];
    const spy = (w: string): string[] => {
      calls.push(w);
      return [w.slice(0, 3), w.slice(3)];
    };
    build("インターネットの記憶について", { hyphenate: spy });
    build("すごいwonderful体験", { hyphenate: spy });
    expect(calls).toEqual([]);
    // Space-separated pure-Latin tokens in a CJK paragraph still hyphenate.
    build("日本語 beautiful 日本語", { hyphenate: spy });
    expect(calls).toEqual(["beautiful"]);
  });

  it("never splits grapheme clusters (combining marks, astral Han)", () => {
    const para = build("が𠮷野");
    const boxes = para.items.filter((it) => it.type === ItemType.Box);
    expect(boxes.map((b) => (b as { text: string }).text)).toEqual(["が", "𠮷", "野"]);
  });

  it("strips soft hyphens inside CJK tokens instead of boxing them", () => {
    const para = build("吾­輩");
    expect(shape(para.items)).toBe(
      "box(吾) pen(0·) glue· box(輩) pen(10000) fil pen(-10000)",
    );
  });

  it("measures clusters in ISOLATION — no cross-cluster kerning in the model", () => {
    // Deliberate (unlike pushWord's kerning-exact prefix scheme): canvas
    // and DOM disagree on kana kerning per engine, so the model assumes
    // solid setting and the renderer disables kerning to match. Each box
    // must carry its cluster's standalone advance, kerning ignored.
    const para = buildItems(
      [{ text: "吾輩は猫である", run: 0 }],
      [mockRun()],
      defaultBuildOptions,
      kernedMeasure,
    );
    for (const it of para.items) {
      if (it.type !== ItemType.Box) continue;
      expect(it.width).toBeCloseTo(kernedMeasure.width(it.text, mockRun()), 9);
    }
  });

  it("consumes a pending word space before a CJK token exactly once", () => {
    const para = build("word 日本");
    expect(shape(para.items)).toBe(
      "box(word) glue box(日) pen(0·) glue· box(本) pen(10000) fil pen(-10000)",
    );
  });

  it("burasage: ideographic stops carry a full-advance right protrusion credit", () => {
    const para = buildItems(
      [{ text: "終わりです。次の文", run: 0 }],
      [mockRun()],
      { ...defaultBuildOptions, protrusion: { ...latinProtrusion, ...hangingPunctuation } },
      mockMeasure,
    );
    const stop = para.items.find(
      (it) => it.type === ItemType.Box && it.text === "。",
    ) as { rp: number };
    // r:1000 = the whole advance hangs — the classical hanging stop. The
    // break penalty after 。 is zero-width, so breakRp resolves to this rp.
    expect(stop.rp).toBeCloseTo(charWidth("。"));
  });

});

describe("breaking CJK paragraphs", () => {
  const soseki =
    "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。" +
    "何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。";

  it("breaks between characters into several flush-fitting lines", () => {
    const para = build(soseki);
    for (const width of [120, 200, 280]) {
      const result = breakParagraph(para, width, defaultBreakOptions);
      const lines = layoutLines(para, result, width, defaultBuildOptions);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.every((l) => !l.overfull)).toBe(true);
      // The full text survives, with no spaces invented between characters.
      const joined = lines.map((l) => lineText(para, l)).join("");
      expect(joined).toBe(soseki);
    }
  });

  it("kinsoku holds at every rendered line edge", () => {
    const para = build(soseki);
    for (const width of [100, 140, 180, 240, 320]) {
      const result = breakParagraph(para, width, defaultBreakOptions);
      const lines = layoutLines(para, result, width, defaultBuildOptions);
      for (const line of lines) {
        const text = lineText(para, line);
        const chars = graphemes(text);
        expect(NOT_START.has(chars[0]!), `line starts with "${chars[0]}" @ ${width}px`).toBe(
          false,
        );
        expect(
          NOT_END.has(chars[chars.length - 1]!),
          `line ends with "${chars[chars.length - 1]}" @ ${width}px`,
        ).toBe(false);
      }
    }
  });

  it("mixed Latin + CJK paragraphs keep word spaces and inter-character breaks", () => {
    const text = "この本は TeX の組版アルゴリズムを Web に移植したものである。";
    const para = build(text);
    const result = breakParagraph(para, 150, defaultBreakOptions);
    const lines = layoutLines(para, result, 150, defaultBuildOptions);
    expect(lines.length).toBeGreaterThan(1);
    // Reassembly: CJK joints join bare; space-glue breaks re-add the space.
    let joined = "";
    for (const [i, line] of lines.entries()) {
      joined += lineText(para, line);
      if (i < lines.length - 1) {
        const brk = para.items[line.end];
        if (brk !== undefined && brk.type === ItemType.Glue && brk.cjk !== true) joined += " ";
      }
    }
    expect(joined).toBe(text);
  });
});
