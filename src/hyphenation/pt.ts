/**
 * Portuguese hyphenation patterns, generated from CTAN hyph-utf8
 * (hyph-pt.tex, version 1.4 2024-07-13) by tools/gen-hyphenation.mjs.
 * DO NOT EDIT — regenerate instead.
 *
 * The pattern data below is NOT covered by this package's MIT license;
 * it is redistributed under its original terms, reproduced here:
 *
 * title: Hyphenation patterns for Portuguese
 * copyright: Copyright (C) 1987, 1994, 1996, 2015 Pedro J. de Rezende, 1996, 2015 J. Joao Dias Almeida, 2024 Leonardo Araujo and Aline Benevides
 * notice: This file is part of the hyph-utf8 package.
 *     See http://www.hyphenation.org/tex for more information.
 * language:
 *     name: Portuguese
 *     tag: pt
 * version: 1.4 2024-07-13
 * authors:
 *   -
 *     name: Pedro J. de Rezende
 *     contact: rezende (at) ic.unicamp.br
 *   -
 *     name: J. Joao Dias Almeida
 *     contact: jj (at) di.uminho.pt
 *   -
 *     name: Leonardo Araujo
 *     contact: leolca (at) gmail.com
 *   -
 *     name: Aline Benevides
 *     contact: benevides.aline12 (at) gmail.com
 * licence:
 *     name: BSD 3-clause licence
 *     url: https://opensource.org/licenses/BSD-3-Clause
 *     text: >
 *         Redistribution and use in source and binary forms, with or without
 *         modification, are permitted provided that the following conditions
 *         are met:
 *         * Redistributions of source code must retain the above copyright
 *           notice, this list of conditions and the following disclaimer.
 *         * Redistributions in binary form must reproduce the above copyright
 *           notice, this list of conditions and the following disclaimer in the
 *           documentation and/or other materials provided with the
 *           distribution.
 *         * Neither the name of the University of Campinas, of the University
 *           of Minho nor the names of its contributors may be used to endorse
 *           or promote products derived from this software without specific
 *           prior written permission.
 * 
 *         THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 *         "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 *         LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 *         A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL PEDRO J. DE
 *         REZENDE OR J.JOAO DIAS ALMEIDA BE LIABLE FOR ANY DIRECT, INDIRECT,
 *         INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
 *         BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS
 *         OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED
 *         AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 *         LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY
 *         WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *         POSSIBILITY OF SUCH DAMAGE.
 * hyphenmins:
 *     typesetting:
 *         left: 2
 *         right: 3
 * changes:
 *     - Version 1.4 Release date: 13/07/2024 Leonardo Araujo and Aline Benevides
 *     - Version 1.3 Release date: 12/08/2015 Pedro J. de Rezende and J. Joao Dias Almeida
 *     - Version 1.2 Release date: 07/21/1996 Pedro J. de Rezende and J. Joao Dias Almeida
 *     - Version 1.1 Release date: 04/12/1994 Pedro J. de Rezende
 *     - Version 1.0 Release date: 02/13/1987 Pedro J. de Rezende
 * texlive:
 *     synonyms:
 *         - portuges
 *     encoding: ec
 *     babelname: portuguese
 *     legacy_patterns: pthyph.tex
 *     message: Portuguese hyphenation patterns
 *     description: Hyphenation patterns for Portuguese in T1/EC and UTF-8 encodings.
 * 
 */
import { createHyphenator } from "./liang.js";

/** The patterns, sorted and front-coded; see `packed` in liang.ts. */
const packed =
  "0.g2no 4ó 4ô 1m2n 1ne4o 1p2si 4í 3t 1s2 2u3b4li 1t2 3m 01- 1b2l 3r 2a 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1c2h 3l 3r 2a 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1d2l 3r 2a 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1f2l 3r 2a 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1g2l 3r 2a 2e 2i 2o 2u 32á 4ã 4é 4ê 4í 34a 4e 4i 4o 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1ja 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2õ 2ú 1k2l 3r 2a 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2õ 2ú 1l2h 2a 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1ma 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1n2h 2a 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1p2l 3neu 3r 3seu1d 2a 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1qu 32á 4â 4ã 4é 4ê 4í 34a 4e 4i 4o 1ra 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1sa 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1t2l 3r 2a 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1v2l 3r 2a 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1w2l 3r 1xa 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1za 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 1ça 2e 2i 2o 2u 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2õ 2ú 04a. 1e. 1o. 0a1i1nh 3nd 3r. 3z. 2â 2ã 2é 2í 2ó 2ô 2ú 13a 2e 2o 1u1i 0bu1i 0c2za 13c 1o2ima 0do1im 1u1i 0e1imp 3nc 4f 4g 4s 4t 4v 2á 2â 2ã 2é 2ê 2í 2ó 2ô 2ú 13a 2e 2o 0fu1i 0i1u 2á 2ã 2é 2í 2ó 2ú 13a 2e 2i 2o 2â 2ê 2ô 0ju1i 0nu1i 0o1im 3n 2á 2ã 2é 2ê 2í 2ó 12i1na 13a 2e 2o 0pro1i1b 0r3r 0s3s 1u1i 22b3l 5r 0t2c 1u1i 22id 4t 0u1i1ç 3n 3r. 3z. 2á 2â 2ã 2é 2ê 2í 13a 2e 2o 2u 0é1o 0í1a 2e 2o 0ú1o";

const exceptions = "hard-ware soft-ware";

/** `hyphenate` function for Portuguese (leftmin 2, rightmin 3),
 * for the `hyphenate` option of justify(). Compiles lazily on first use. */
export const hyphenatePt: (word: string) => string[] = createHyphenator({
  packed,
  exceptions,
  leftmin: 2,
  rightmin: 3,
});
