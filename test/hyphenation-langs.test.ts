import { describe, expect, it } from "vitest";
import { hyphenateCa } from "../src/hyphenation/ca.js";
import { hyphenateDa } from "../src/hyphenation/da.js";
import { hyphenateDe } from "../src/hyphenation/de.js";
import { hyphenateEl } from "../src/hyphenation/el.js";
import { hyphenateEnGB } from "../src/hyphenation/en-gb.js";
import { hyphenateEs } from "../src/hyphenation/es.js";
import { hyphenateFi } from "../src/hyphenation/fi.js";
import { hyphenateFr } from "../src/hyphenation/fr.js";
import { hyphenateHr } from "../src/hyphenation/hr.js";
import { hyphenateHu } from "../src/hyphenation/hu.js";
import { hyphenateIt } from "../src/hyphenation/it.js";
import { hyphenateNb } from "../src/hyphenation/nb.js";
import { hyphenateNl } from "../src/hyphenation/nl.js";
import { hyphenateNn } from "../src/hyphenation/nn.js";
import { hyphenatePl } from "../src/hyphenation/pl.js";
import { hyphenatePt } from "../src/hyphenation/pt.js";
import { hyphenateRu } from "../src/hyphenation/ru.js";
import { hyphenateSk } from "../src/hyphenation/sk.js";
import { hyphenateSl } from "../src/hyphenation/sl.js";
import { hyphenateSv } from "../src/hyphenation/sv.js";
import { hyphenateTr } from "../src/hyphenation/tr.js";
import { hyphenateUk } from "../src/hyphenation/uk.js";

/** One native long word per bundled language (hyphenators receive
 * lowercase — items.ts lowercases before calling and restores case
 * positionally). */
const SAMPLES: Array<[string, (w: string) => string[], string]> = [
  ["ca", hyphenateCa, "desenvolupament"],
  ["da", hyphenateDa, "sammensætning"],
  ["de", hyphenateDe, "silbentrennung"],
  ["el", hyphenateEl, "τυπογραφία"],
  ["en-gb", hyphenateEnGB, "hyphenation"],
  ["es", hyphenateEs, "justificación"],
  ["fi", hyphenateFi, "kirjoittaminen"],
  ["fr", hyphenateFr, "typographie"],
  ["hr", hyphenateHr, "tipografija"],
  ["hu", hyphenateHu, "elválasztás"],
  ["it", hyphenateIt, "tipografia"],
  ["nb", hyphenateNb, "skrivemaskin"],
  ["nl", hyphenateNl, "lettergrepen"],
  ["nn", hyphenateNn, "skrivemaskin"],
  ["pl", hyphenatePl, "typografia"],
  ["pt", hyphenatePt, "tipografia"],
  ["ru", hyphenateRu, "типографика"],
  ["sk", hyphenateSk, "typografia"],
  ["sl", hyphenateSl, "tipografija"],
  ["sv", hyphenateSv, "avstavning"],
  ["tr", hyphenateTr, "kütüphane"],
  ["uk", hyphenateUk, "видавництво"],
];

describe("bundled hyph-utf8 languages", () => {
  it.each(SAMPLES)("%s: splits a native word losslessly", (_id, h, word) => {
    const parts = h(word);
    expect(parts.join("")).toBe(word);
    expect(parts.length).toBeGreaterThan(1);
    // No fragment may be empty; hyphenmins are per-language but ≥ 1.
    for (const part of parts) expect(part.length).toBeGreaterThan(0);
  });

  it("known-correct splits (canonical dictionary hyphenations)", () => {
    expect(hyphenateDe("silbentrennung")).toEqual(["sil", "ben", "tren", "nung"]);
    expect(hyphenateIt("tipografia")).toEqual(["ti", "po", "gra", "fia"]);
    expect(hyphenateFr("typographie")).toEqual(["ty", "po", "gra", "phie"]);
  });

  it("nb and nn share one pattern-data module", () => {
    expect(hyphenateNn).toBe(hyphenateNb);
  });

  it("short words come back whole", () => {
    for (const [, h] of SAMPLES) expect(h("ab")).toEqual(["ab"]);
  });
});
