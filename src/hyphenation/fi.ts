/**
 * Finnish hyphenation patterns, generated from CTAN hyph-utf8
 * (hyph-fi.tex, version 2.2) by tools/gen-hyphenation.mjs.
 * DO NOT EDIT — regenerate instead.
 *
 * The pattern data below is NOT covered by this package's MIT license;
 * it is redistributed under its original terms, reproduced here:
 *
 * title: Hyphenation patterns for Finnish
 * copyright: Copyright (C) 1986, 1988, 1989 Kauko Saarinen
 * notice: This file is part of the hyph-utf8 package.
 *     See http://www.hyphenation.org/tex for more information.
 * language:
 *     name: Finnish
 *     tag: fi
 * version: 2.2
 * authors:
 *   -
 *     name: Kauko Saarinen
 *     affiliation: Computing Centre, University of Jyväskylä, Finland
 * licence:
 *     - text: Patterns may be freely distributed
 * hyphenmins:
 *     typesetting:
 *         left: 2
 *         right: 2
 * changes:
 *     - First release 1986-01 by Kauko Saarinen,
 *     - >
 *         Completely rewritten 1988-01. The new patterns make
 *         much less mistakes with foreign and compound words.
 *         The article "Automatic Hyphenation of Finnish"
 *         by Professor Fred Karlsson is also referred
 *     - 1989-03-08 (vers. 2.2), some vowel triples by Fred Karlsson added.
 *     - 1995-01-09: added \uccode and \lccode by Thomas Esser
 * texlive:
 *     encoding: ec
 *     babelname: finnish
 *     legacy_patterns: fihyph.tex
 *     message: Finnish hyphenation patterns
 *     package: finnish
 * 
 */
import { createHyphenator } from "./liang.js";

/** The patterns, sorted and front-coded; see `packed` in liang.ts. */
const packed =
  "0.suu2r1a2 1ydi2n1 1ä2 01a2siaka2s1 6n 6t 5oi 1b2lo 3ri 4o 4u 2a 2e 2i 2o 2u 2y 1d2ra 2a 2e 2i 2o 2u 2y 2ä 2ö 1f2la 3ra 4e 2a 2e 2i 2o 2u 2y 1g2lo 3ra 2a 2e 2i 2o 2u 2y 2ä 2ö 1ha 2e 2i 2o 2u 2y 2ä 2ö 1ja 2e 2i 2o 2u 2y 2ä 2ö 1k2ra 4e 4i 3v 4a 2a 2e 2i 2o 2u 2y 2ä 2ö 1la 2e 2i 2o 2u 2y 2ä 2ö 1ma 2e 2i 2o 2u 2y 2ä 2ö 1na 2e 2i 2o 2u 2y 2ä 2ö 1p2ro 2a 2e 2i 2o 2u 2y 2ä 2ö 1q2vi 1ra 2e 2i 2o 2u 2y 2ä 2ö 1sa 2e 2i 2o 2p2li 2t2r 2u 2y 2ä 2ö 1ta 2e 2i 2o 2u 2y 2ä 2ö 1va 2e 2i 2o 2u 2y 2ä 2ö 02n1a2jan 6o 5len 4ika 4nno 5to 3e2dus 3o2mai 5pet 6ist 5sa 4ton 5to 3y2lit 1s1a2jo 5len 6oi 5sia 4jatu 4pu 4se 3e2sity 3i2dea. 8n 3o2pisk 8t 5sa 4hje 3y2hti 5rit 0a1ei 2oi 2uu 2ä 2ö 1a1e2 3i2 3o2 3u2 1i1a 3e 3o 3u 1li1a2v 2kei2s1 2ous1 1u1a 3e 0b2l 2r 1ib3li 0c2l 1h2r 0d2r 0e1aa 3i 2uu 2ää 2ö2 1e1a2 3i2 3u2 3y2 1u1a 0f2l 2r 0g2l 2r 0i1aa 3u 2uu 2ää 2öö 1e1a 3o 3y 1i1a2 3e2 3o2 1o1a2 3e2 1u1a 3e 3o 0k2l 1eus1 0l2as 0o1aa 2ui 3u 2y 2ä 2ö 1i1a 3e 3o 3u 1u1e 3o 0p2l 2r 1erus1 0q2v 0r2as 1taus1 0sc2h 0ts2h 0u1aa 2ee 2y2 2ä2 2ö2 12s 1e1a 1i1e 1lo2s1 1o1a 3u 1u1a2 3e2 3i2 3o2 0y1a2 2ei 2o2 2u2 2ää 1li1o2p 0ä1u2 12y 2ä 2ö 13a2 2o2 1ä1e 3i 23y 0ö1e2 2u2 12y 2ä 2ö 13a2 2o2";

const exceptions = "";

/** `hyphenate` function for Finnish (leftmin 2, rightmin 2),
 * for the `hyphenate` option of justify(). Compiles lazily on first use. */
export const hyphenateFi: (word: string) => string[] = createHyphenator({
  packed,
  exceptions,
  leftmin: 2,
  rightmin: 2,
});
