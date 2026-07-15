import { describe, expect, it } from "vitest";
import { buildItems } from "../src/core/items.js";
import { defaultBuildOptions, type Item, ItemType } from "../src/core/types.js";
import { textSupported } from "../src/dom/read.js";
import { mockMeasure, mockRun } from "./helpers/mock.js";

const HEBREW = "בראשית ברא אלהים את השמים ואת הארץ";
const ARABIC = "في قديم الزمان كان هناك ملك عظيم يحكم مملكة واسعة";

describe("textSupported (RTL scope decisions)", () => {
  it("accepts pure Hebrew and pure Arabic in rtl paragraphs", () => {
    expect(textSupported(HEBREW, "rtl")).toBe(true);
    expect(textSupported(ARABIC, "rtl")).toBe(true);
  });

  it("accepts pointed Hebrew (niqqud marks are not letters)", () => {
    expect(textSupported("שָׁלוֹם עֲלֵיכֶם וּבְרָכָה", "rtl")).toBe(true);
  });

  it("accepts digits and neutral punctuation in rtl paragraphs", () => {
    expect(textSupported("בשנת 1948 קמה המדינה, וזהו.", "rtl")).toBe(true);
    // Arabic-Indic digits and Arabic punctuation.
    expect(textSupported("في عام ١٩٤٨، حدث ذلك؟", "rtl")).toBe(true);
    expect(textSupported("(שאלה?) תשובה: כן!", "rtl")).toBe(true);
  });

  it("bails rtl paragraphs containing strong-LTR letters (mixed bidi)", () => {
    expect(textSupported(`${HEBREW} English ${HEBREW}`, "rtl")).toBe(false);
    expect(textSupported("מילה word", "rtl")).toBe(false);
    // Greek and Cyrillic are strong-LTR too.
    expect(textSupported("שלום αβγ", "rtl")).toBe(false);
    expect(textSupported("שלום абв", "rtl")).toBe(false);
  });

  it("bails rtl paragraphs with letters of unsupported RTL scripts", () => {
    // Syriac is RTL but out of scope (only Hebrew/Arabic are supported).
    expect(textSupported("ܫܠܡܐ ܥܠܝܟ", "rtl")).toBe(false);
  });

  it("bails rtl paragraphs with no RTL letters at all", () => {
    expect(textSupported("123 456 789", "rtl")).toBe(false);
    expect(textSupported("... --- ...", "rtl")).toBe(false);
  });

  it("bails LTR paragraphs containing strong-RTL characters", () => {
    expect(textSupported(`plain English with ${HEBREW} inside`, "ltr")).toBe(false);
    expect(textSupported("English with العربية inside", "ltr")).toBe(false);
    // Presentation forms (missed by the old UNSUPPORTED_SCRIPTS range).
    expect(textSupported("English with שׁ inside", "ltr")).toBe(false);
    expect(textSupported("English with ﺍ inside", "ltr")).toBe(false);
  });

  it("keeps accepting ordinary LTR text", () => {
    expect(textSupported("In olden times when wishing still helped one.", "ltr")).toBe(true);
    expect(textSupported("naïve café — “quotes”, digits 123.", "ltr")).toBe(true);
  });

  it("bails on explicit bidi controls in either direction", () => {
    // LRM, RLM, RLE, RLO, LRI, ALM — written as escapes: literal bidi
    // controls in a source file garble its own rendering.
    for (const ctl of ["\u200E", "\u200F", "\u202B", "\u202E", "\u2066", "\u061C"]) {
      expect(textSupported(`שלום${ctl}עולם`, "rtl"), JSON.stringify(ctl)).toBe(false);
      expect(textSupported(`hello${ctl}world`, "ltr"), JSON.stringify(ctl)).toBe(false);
    }
  });

  it("accepts CJK in LTR (supported) but bails on CJK inside RTL", () => {
    expect(textSupported("漢字テキスト", "ltr")).toBe(true);
    expect(textSupported("שלום 漢字", "rtl")).toBe(false);
  });
});

describe("RTL item building", () => {
  const shape = (items: Item[]): string =>
    items
      .map((it) => {
        if (it.type === ItemType.Box) return `box(${it.text})`;
        if (it.type === ItemType.Glue) return it.stretchFil > 0 ? "fil" : "glue";
        return `pen(${it.penalty})`;
      })
      .join(" ");

  it("produces the usual box/glue stream for Hebrew words", () => {
    const para = buildItems(
      [{ text: "שלום עולם", run: 0 }],
      // RTL runs are built with noHyphens (buildRunMetrics forces it for
      // direction: rtl scans).
      [mockRun({ noHyphens: true })],
      defaultBuildOptions,
      mockMeasure,
    );
    expect(shape(para.items)).toBe("box(שלום) glue box(עולם) pen(10000) fil pen(-10000)");
    const boxes = para.items.filter((it) => it.type === ItemType.Box);
    for (const b of boxes) expect(b.width).toBeGreaterThan(0);
  });

  it("never calls the hyphenate callback and emits no hyphen penalties", () => {
    const calls: string[] = [];
    const para = buildItems(
      [{ text: `${ARABIC} ${HEBREW}`, run: 0 }],
      [mockRun({ noHyphens: true })],
      {
        ...defaultBuildOptions,
        hyphenate: (w) => {
          calls.push(w);
          return [w];
        },
      },
      mockMeasure,
    );
    expect(calls).toEqual([]);
    const hyphenPens = para.items.filter(
      (it) => it.type === ItemType.Penalty && (it.hyphen || it.width > 0),
    );
    expect(hyphenPens).toEqual([]);
  });

  it("strips soft hyphens instead of honoring them", () => {
    const para = buildItems(
      [{ text: "מיל­ים ארוכות", run: 0 }],
      [mockRun({ noHyphens: true })],
      defaultBuildOptions,
      mockMeasure,
    );
    expect(shape(para.items)).toBe("box(מילים) glue box(ארוכות) pen(10000) fil pen(-10000)");
  });
});
