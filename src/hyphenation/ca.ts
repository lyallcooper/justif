/**
 * Catalan hyphenation patterns, generated from CTAN hyph-utf8
 * (hyph-ca.tex, version 1.11 15 July 2003 15:08:12 CET) by tools/gen-hyphenation.mjs.
 * DO NOT EDIT — regenerate instead.
 *
 * The pattern data below is NOT covered by this package's MIT license;
 * it is redistributed under its original terms, reproduced here:
 *
 * title: Hyphenation patterns for Catalan
 * copyright: Copyright (C) December 1991-January 1995, July 2003 Gonçal Badenes
 * notice: This file is part of the hyph-utf8 package.
 *     See http://www.hyphenation.org/tex for more information.
 * language:
 *     name: Catalan
 *     tag: ca
 * version: 1.11 15 July 2003 15:08:12 CET
 * authors:
 *   -
 *     name: Gonçal Badenes
 *     contact: g.badenes (at) ieee.org
 *   -
 *     name: Francina Turon
 * licence:
 *     name: LPPL
 *     version: 1
 *     or_later: true
 *     url: https://latex-project.org/lppl/
 * hyphenmins:
 *     generation:
 *         left: 2
 *         right: 2
 *     typesetting:
 *         left: 2
 *         right: 2
 * changes:
 *     - Version 1.11 2003-07-15 Identical to version 1.10 except for the updated copyright notice.
 *     - Version 1.10 1995-01-17
 * texlive:
 *     encoding: ec
 *     babelname: catalan
 *     legacy_patterns: cahyph.tex
 *     message: Catalan hyphenation patterns
 *     description: Hyphenation patterns for Catalan in T1/EC and UTF-8 encodings.
 * ==========================================
 * 
 * This patterns have been created using standard, conservative
 * hyphenation rules for catalan. The results have refined running them
 * through patgen. In that way, the number of hits has been increased.
 * 
 * These rules produce no wrong patterns (Results checked against the
 * “Diccionari Ortogràfic i de Pronúncia”, Enciclopèdia
 * Catalana. The percentage of valid hyphen misses is lower than 1%
 * 
 * Some of the patterns below represent combinations that never
 * happen in Catalan. We have tried to keep them to a minimum.
 * 
 * Please report any problem you might have to the authors!!!
 * 
 */
import { createHyphenator } from "./liang.js";

/** The patterns, sorted and front-coded; see `packed` in liang.ts. */
const packed =
  "0.antihi2 1be2n 4s 2i2s 1ca2p 2e2l 2h2 2la2r 2o2ll 4n 4r 1de2s 2i2s 1en3a 1hi2a 4e 4o 4u 4à 4è 4é 4ò 4ó 4ú 3pe2r 5rm2n 2u2a 4e 4i 4o 4à 4è 4é 4í 4ò 4ó 1i2è 3ò 2n3ac 5d 5p 4es 4o 3te2r 1ma2l 3l1t2hus 1pa2n 2e2r 33ri 2os2t 2sa2l 1re2d 3be2s 1su2b 3b3o 4de2s 3pe2r 1th2 2ran2s 1u2è 3ò 01b2la 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3ra 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 2a 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1c2la 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3ra 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 2a 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1d2ra 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 2a 2e 2i 2o 2à 2è 2é 2í 2ò 2ó 2ú 1f2la 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3ra 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 2a 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1g2la 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3ra 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 2a 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 2ü 1ha 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1ja 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1l2le 4i 4u 4à 4è 4é 4í 4ò 4ó 4ú 2a 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1ma 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1n2ya 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 2a 2e 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1p2la 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3ra 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 2a 2u 2à 2è 2é 2í 2ò 2ó 2ú 1qu 2ü 1ra 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1sa 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1t2ra 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 2a 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1va 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1xa 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1za 2e 2i 2o 2u 2à 2è 2é 2í 2ò 2ó 2ú 1ça 2o 2u 2à 2ò 2ó 2ú 03du 1exp 1l2la 4o 1nef 3i 2i 1pe 2i 2o 2r 1ser 0a1a 2e 2i2a 4e 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3sme. 4ta. 2o 2u2a 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3m. 2à 2è 2é 2í 2ï 2ò 2ó 2ú 2ü 13ne 2ri 0bi3se 0des3ag 5r 5v 4enc 0e1a 2e 2i2a 4e 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3sme. 4ta. 2o 2u2a 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3m. 2à 2è 2é 2í 2ï 2ò 2ó 2ú 2ü 13ism 2le 2rio 4s 1in1s2tein 1s3aco 4f 4p 4rr 4s 3int 0g2no 3ò 1u2a 3e 3i 3o 3à 3è 3é 3í 3ò 3ó 1ü2e 3i 3è 3é 3í 0i1a 2e 2i2a 4e 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3sme. 4ta. 2o 2u2a 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3m. 2à 2è 2é 2í 2ï 2ò 2ó 2ú 2ü 1g3n 1n3ex 0n3si 1i2etz1sc2he 0o1a 2e 2i2a 4e 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3sme. 4ta. 2o 2u2a 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3m. 2à 2è 2é 2í 2ï 2ò 2ó 2ú 2ü 13gnò 2ro 0p2neu 2se 3i 3í 0qu2a 3e 3i 3o 3à 3è 3é 3í 3ò 3ó 2i3e 1ü2e 3i 3è 3é 3í 0ru1t2herford 0s3emp 3sp 1ub3a 0u1a 2e 2i2a 4e 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3sme. 4ta. 2o 2u2a 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 3m. 2à 2è 2é 2í 2ï 2ò 2ó 2ú 2ü 1i3et 0à1a 2e 2i2a 4e 4o 4u 2o 2u2a 4e 4i 4o 4u 2ï 2ü 0è1a 2e 2i2a 4e 4o 4u 2o 2u2a 4e 4i 4o 4u 2ï 2ü 0é1a 2e 2i2a 4e 4o 4u 2o 2u2a 4e 4i 4o 4u 2ï 2ü 0í1a 2e 2i2a 4e 4o 4u 2o 2u2a 4e 4i 4o 4u 2ï 2ü 0ï1a 2e 2i 32a 4e 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 2o 2u2a 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 2à 2è 2é 2í 2ò 2ó 2ú 0ò1a 2e 2i2a 4e 4o 4u 2o 2u2a 4e 4i 4o 4u 2ï 2ü 0ó1a 2e 2i2a 4e 4o 4u 2o 2u2a 4e 4i 4o 4u 2ï 2ü 0ú1a 2e 2i2a 4e 4o 4u 2o 2u2a 4e 4i 4o 4u 2ï 2ü 0ü1a 2e 2i2a 4e 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 2o 2u2a 4e 4i 4o 4u 4à 4è 4é 4í 4ò 4ó 4ú 2à 2è 2é 2í 2ò 2ó 2ú";

const exceptions = "cu-rie cu-ries gei-sha gei-shes goua-che goua-ches hip-py hip-pies hob-by hob-bies jeep jeeps joule joules klee-nex klee-nexs lar-ghet-ti lar-ghet-to lied lieder nos-al-tres ro-yal-ties ro-yal-ty vos-al-tres whis-ky whis-kies";

/** `hyphenate` function for Catalan (leftmin 2, rightmin 2),
 * for the `hyphenate` option of justify(). Compiles lazily on first use. */
export const hyphenateCa: (word: string) => string[] = createHyphenator({
  packed,
  exceptions,
  leftmin: 2,
  rightmin: 2,
});
