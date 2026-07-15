/**
 * Norwegian Nynorsk hyphenation patterns — identical data to Norwegian Bokmål
 * (both are generated from CTAN hyph-utf8's hyph-no.tex); this module
 * re-exports it under the nn name. See nb.ts for the
 * pattern data and its license.
 */
export { hyphenateNb as hyphenateNn } from "./nb.js";
