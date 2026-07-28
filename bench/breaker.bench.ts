/** Deterministic line-breaker benchmarks. Run with `npm run bench`. */
import { bench, describe } from "vitest";
import { breakParagraph } from "../src/core/breaker.js";
import { buildItems } from "../src/core/items.js";
import { defaultBreakOptions, defaultBuildOptions } from "../src/core/types.js";
import { hyphenateEnUS } from "../src/hyphenation/en-us.js";
import { frogKing } from "../test/fixtures/frogKing.js";
import { mockMeasure, mockRun } from "../test/helpers/mock.js";

const WIDTH = 640;
const buildOptions = { ...defaultBuildOptions, hyphenate: hyphenateEnUS };

describe("breakParagraph", () => {
  for (const copies of [1, 4, 40]) {
    const text = Array.from({ length: copies }, () => frogKing).join(" ");
    const paragraph = buildItems([{ text, run: 0 }], [mockRun()], buildOptions, mockMeasure);

    bench(`${text.split(/\s+/).length} words`, () => {
      breakParagraph(paragraph, WIDTH, defaultBreakOptions);
    });
  }
});
