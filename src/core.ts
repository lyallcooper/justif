/** Headless engine: DOM-free, testable in Node with a mock Measure. */
export * from "./core/types.js";
export {
  badness,
  demerits,
  Fitness,
  fitness,
  INF_BAD,
  INF_PENALTY,
} from "./core/badness.js";
export {
  CJK_CHAR,
  cjkBreakAllowed,
  graphemes,
  kinsokuNotAtLineEnd,
  kinsokuNotAtLineStart,
} from "./core/cjk.js";
export { breakRp, buildItems, withSums } from "./core/items.js";
export {
  composeProtrusion,
  type HangingPunctuationMode,
  hangingPunctuation,
  latinProtrusion,
  protrusionCodes,
} from "./core/protrusion.js";
export { fontProtrusion } from "./core/protrusion-fonts.js";
export { breakParagraph } from "./core/breaker.js";
export { layoutLines, lineText } from "./core/layout.js";
