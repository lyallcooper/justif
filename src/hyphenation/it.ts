/**
 * Italian hyphenation patterns, generated from CTAN hyph-utf8
 * (hyph-it.tex, version 4.9 2014/04/22) by tools/gen-hyphenation.mjs.
 * DO NOT EDIT — regenerate instead.
 *
 * The pattern data below is NOT covered by this package's MIT license;
 * it is redistributed under its original terms, reproduced here:
 *
 * title: Hyphenation patterns for Italian
 * copyright: Copyright (C) 2008-2011 Claudio Beccari
 * notice: This file is part of the hyph-utf8 package.
 *     See http://www.hyphenation.org/tex for more information.
 * language:
 *     name: Italian
 *     tag: it
 * version: 4.9 2014/04/22
 * authors:
 *   -
 *     name: Claudio Beccari
 *     contact: claudio.beccari (at) gmail.com
 * licence:
 *     - This file is available under any of the following licences:
 *     -
 *         name: LPPL
 *         version: 1.3
 *         or_later: true
 *         url: http://www.latex-project.org/lppl.txt
 *         status: maintained
 *         maintainer: Claudio Beccari, e-mail claudio dot beccari at gmail dot com
 *     -
 *         name: MIT
 *         url: https://opensource.org/licenses/MIT
 *         text: >
 *             Permission is hereby granted, free of charge, to any person
 *             obtaining a copy of this software and associated documentation
 *             files (the "Software"), to deal in the Software without
 *             restriction, including without limitation the rights to use,
 *             copy, modify, merge, publish, distribute, sublicense, and/or sell
 *             copies of the Software, and to permit persons to whom the
 *             Software is furnished to do so, subject to the following
 *             conditions:
 * 
 *             The above copyright notice and this permission notice shall be
 *             included in all copies or substantial portions of the Software.
 * 
 *             THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 *             EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 *             OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *             NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 *             HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 *             WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 *             FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
 *             OTHER DEALINGS IN THE SOFTWARE.
 * hyphenmins:
 *     typesetting:
 *         left: 2
 *         right: 2
 * changes:
 *     - 2014-04-22 - Add few patterns involving `h'
 *     - 2011-08-16 - Change the licence from GNU LGPL into LPPL v1.3.
 *     - 2010-05-24 - Fix for Italian patterns for proper hyphenation of -ich and Ljubljana.
 *     - 2008-06-09 - Import of original ithyph.tex into hyph-utf8 package.
 *     - 2008-03-08 - (last change in ithyph.tex)
 * texlive:
 *     encoding: ascii
 *     babelname: italian
 *     legacy_patterns: ithyph.tex
 *     message: Italian hyphenation patterns
 *     description: |-
 *         Hyphenation patterns for Italian in ASCII encoding.
 *         Compliant with the Recommendation UNI 6461 on hyphenation
 *         issued by the Italian Standards Institution
 *         (Ente Nazionale di Unificazione UNI).
 * ==========================================
 * 
 * These hyphenation patterns for the Italian language are supposed to comply
 * with the Recommendation UNI 6461 on hyphenation issued by the Italian
 * Standards Institution (Ente Nazionale di Unificazione UNI).  No guarantee
 * or declaration of fitness to any particular purpose is given and any
 * liability is disclaimed.
 * 
 */
import { createHyphenator } from "./liang.js";

/** The patterns, sorted and front-coded; see `packed` in liang.ts. */
const packed =
  "0.a3p2n 2nti1 53m2n 1bio1 1c2 2a4p3s 2ircu2m1 2ontro1 1d2 2i2s3cine 1e2x1eu 1fran2k3 3ee3 1h2 1j2 1k2 1li3p2sa 1narco1 1opto1 2rto3p2 1p2s 2ara1 2h2l 4r 2oli3p2 2re1 1re1i2scr 1sha2re3 2u2b3lu 6r 1t2 2ran2s3c 8d 8l 8n 8p 8r 8t 1wa2g3n 2el2t1 1z2 01b 1c 1d 1f 1g 1h 1j 1k 1l 1m 1n 1p 1q 1r 1s2 1t 1v 1w 1x 1z 02'2 1at. 1b' 2. 2b 2c 2d 2f 2m 2n 2p 2s 2t 2v 1c' 2. 2b 2c 2d 2f 2h''. 4. 3. 3b 3h 3n 2k 2m 2n 2q 2s 2t 2z 1d' 2. 2b 2d 2g 2l 2m 2n 2p 2s 2t 2v 2w 1f' 2. 2b 2f 2g 2n 2s 2t 1g' 2. 2b 2d 2f 2g 2h2t 2m 2p 2s 2t 2v 2w 2z 1h' 2. 2b 2d 2h 2m 2n 2r 2v 1j' 2. 1k' 2. 2f 2g 2k 2m 2s 2t 1l'' 3. 2. 23f2 2b 2c 2d 2g 2k 2l 2m 2n 2p 2q 2r 2s 2t 2v 2w 2z 1m' 2. 2b 2c 2f 2l 2m 2n 2p 2q 2r 2s 2t 2v 2w 1n' 2. 2b 2c 2d 2f 2g 2heit 2k 2l 2m 2n 2p 2q 2r 2s 2t 2v 2z 1p' 2. 2d 2n 2p 2s 2t 2z 1q' 2. 2q 1r' 2. 2b 2c 2d 2f 2g 2k 2l 2m 2n 2p 2q 2r 2s 2t 2v 2w 2x 2z 1s3p2n 3s 2h' 3. 3m 2tb 3c 3d 3f 3g 3m 3n 3p 3s 3t 3v 2z 1t'' 3. 2. 2b 2c 2d 2f 2g 2h. 2m 2n 2p 2t 2v 2w 2zk 1v'' 3. 2. 2c 2v 1w' 2. 21y 1x' 2. 2b 2c 2f 2h 2m 2p 2t 2w 1z'' 3. 2. 2b 2d 2l 2n 2p 2s 2t 2v 2z 03p2ne 3sic 1t2sch 04s'' 3. 2. 0a1ia 3e 3o 3u 2uo 2ya 0b2l 2r 0c2h 2l 2r 1h2r 0d2r 0e1iu 12w 0f2l 2r 0g2h 2l 2n 2r 0h2l 1i3p2n 0k2h 2l 2r 0l2h 2j 0n2g3n 2s3fer 0o1ia 3e 3o 3u 0p2h 2l 2r 0r2h 2t2s3 0s4s3m 0t2h 2l 2r 2s 2t3s 2z 1z2s 0v2l 2r 0w2h 1a2r 0y1i 2ou";

const exceptions = "";

/** `hyphenate` function for Italian (leftmin 2, rightmin 2),
 * for the `hyphenate` option of justify(). Compiles lazily on first use. */
export const hyphenateIt: (word: string) => string[] = createHyphenator({
  packed,
  exceptions,
  leftmin: 2,
  rightmin: 2,
});
