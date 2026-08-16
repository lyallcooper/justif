/**
 * Danish hyphenation patterns, generated from CTAN hyph-utf8
 * (hyph-da.tex, version 2011-01-11) by tools/gen-hyphenation.mjs.
 * DO NOT EDIT — regenerate instead.
 *
 * The pattern data below is NOT covered by this package's MIT license;
 * it is redistributed under its original terms, reproduced here:
 *
 * title: Hyphenation patterns for Danish
 * copyright: Copyright (C) 1994 Frank Jensen
 * notice: This file is part of the hyph-utf8 package.
 *     See http://www.hyphenation.org/tex for more information.
 * language:
 *     name: Danish
 *     tag: da
 * version: 2011-01-11
 * authors:
 *   -
 *     name: Frank Jensen
 *     contact: frank.jensen (at) hugin.com
 * licence:
 *     - This file is available under any of these licences:
 *     -
 *         name: LPPL
 *         version: 1.3
 *         or_later: true
 *         url: http://www.latex-project.org/lppl/lppl-1-3.html
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
 *     - 2011-01-11 - remove support for OT1 encoding
 * texlive:
 *     encoding: ec
 *     babelname: danish
 *     legacy_patterns: dkhyph.tex
 *     message: Danish hyphenation patterns
 *     description: Hyphenation patterns for Danish in T1/EC and UTF-8 encodings.
 * 
 */
import { createHyphenator } from "./liang.js";

/** The patterns, sorted and front-coded; see `packed` in liang.ts. */
const packed =
  "0.ae3 2n1s 33k 1be1t 35la 2i4tr 1der3i 2iagno5 1her3 2oved3 1ne4t5 1om1 2ve4 1po1 1så3 1til3 1yd5r 1ær5i 1øv3r 01arb 1ba 2e 2i 2o 2r4 2y 1ce 1de 2i 2u 1fa 2e 2i 2o 2u 1ga 2e 2i 2r 2y 1kon 2ra 2us 1lat 2e. 3r 3s 1ma 2e 2i 2ul 2æ 1nal 2e 2i 2o 1omr 1per 2la 2roc 2u 1rel 1sam 3t 2e 2ig 2kab 3e 2tan 4v 3e. 4d 4n 3r 3å 2y1s 2æ 2ø 1tag 2ry 2yp 1ved 2is 2o 2ærk 03a3sp 2bst 2gti 2naly 3v 1bu 1ch 1da 2o 2rif 4v 2y 2æ 2ø 1eff 3t 2ksem 4p 2lem 2ur 1fl 2y 2æ 2ø 1go 2å 2æ 2ø1 1klu 2ort 2ur 3t 2å 2ø 1len 2ov 1mo 2y 2å 2ø 1na 2y 2æ 1opta 2rdn 3ient 1pa 2en 2ot 1råd 1s4pi 3y 2lå 2omm 3n 2pec 3rog. 2tat 3el 4r. 4s 3o 2ul 3r 1teg 2id 2ræk. 1udv 1varm 2u 2ærd 04alkv 1b1n 2d 2s 1c1c 2h. 1d1n 23af 2e4lem 2op 2rett 1e1ko 2nn 1ft 1g5enden 3om 1h3t 2a. 2et 1j5en. 1l3int 3p 25ins 3or 2ele 3u 2s 1m5ej 3ov 2op 1n1h 3l 3v 25æb 2ak 2d 2im 2s 1or. 1p5h 3p4 2ec 2le. 4r 4s 2o3re 1raf 3rb 2eks 3ss 2imo 3np 4t 2øn 1s1b 3g4 3op 23h 25æn 2k. 2nin 2per 2t. 1t1f 3l 3t 23k 3p 2anv 2b 2res 2s 1v5om 05a4f1l 2dg 2fg 3s 2rg 1bæ 1cy 1d4reve 2røv 1elim 2rhv 1gj 1inf 1kap 3v 2od 2ry 1lab 3gd 3m 2ed 2øs 1nø 1pok 2ræ 2y3 2æd 1rese 3tt 2ut 2ør 1s4er 3tam 2is 3t 3u 2ky 2lu 2ol 3m. 4t 2temo 4p 4t 3j 3ø 1ta. 2ekn 3rm 2ur 1u5v 2dl 1vet 2å 06t3g 0a1e 2le 3i 3o 3y 2ra 3e 3i 2si 2ta1 3e 3i 3o 3u 2ve 13c 2h 2j 2ke 2la 3u 2nu 2pi 2ro 2sa 3c 3k 3o 3te 4i 2tø 14gef 3i 3y 2t5in 15ka 3r 2o 2pe 3o 2tr 2va 3æ 2z 1b5le 1de5la 1f3r 24ri 1g5in 3si 1is5t 1ku5 1l3k 25si 1m4pa 1n4k5r 1r5af 1to5v 0b1j 2st 13so 15t 2w 1a4ti 1e1k 3s4 3tr 23ro 25ru 1i5sk 1o3ra 24gr 25re 1rød3 1s5k 1u4s5tr 1y5s 0ce5ro 1i4o 1k3 0d1b 2d4 2f 2g 2k 2l 2m 2p 2ski 2te 2v 13h 2j 2ta 14sm 3u 15anta 2ov 2ros 3u 2tr 1a4s 1e4rig 25d 3sk 2r5eri 1i1e 25l 1s5an 3in 3vi 2tå4 2u5l 1t5o 3u 1ub5 0e1al 2ci 2h 2ka 3v 2las 3i 2or 2pr 2re 3i 2ta 3e 3i 3o 3y 2va 3i 3æ 13af 3k 3n 3t 2bl 2e 2fr 2gu 2in 2je 2ke 3l 3u 2lad 3e 3o 3y 3æ 3ø 2op 3v 2ra 3um 3ø 2tj 3r 3u 2um 3n 2ve 2æ 14do 2j5el 2lek 2mad 2nan 3o 2rag 4k 3ef 3ib 2v3erf 15ad 3g 3p 2kr 3y 2lu 2nu 2ol 2ry 2tæ 3ø 2x 2å 1a4la 1bs3 1d3re 4in 24str 25ar 3ra 2de4 4l5 1i5s 1k5sa 1l3ak 4r 25sa 1m1s 24p5le 1n3so 25ak 1pi3 1r1k 23af 3s 25ege 3ov 3tr 3un 3øn 2o5d 1tek4s 0f1b 2d 2f 2g 2h 2k 2p 2s4 2te 3i 2v 13ta 15to 3vi 1a4ce 2gs3 1ej4 3l1 1o4ri 2r1en 1ø4r5en 0g1b 2d 2g 2h 2l 2m 2te 3i 13art 2f 2k 2p 2ta 3r 2ud 2v 14se 3tr 3ø 15ov 2s4tide 3la 3å 2to 2yd 1e3s 2r3in 1i3st 24b 2ø4 1s1a 3p 3v 23or 2de4len 2ha4 1t4s 1un5 0he5s 2ds3 1i3s 24e 3n5 1o5ko 3ve 1un4 3d3 1vo4 0i1a 2c 2el 3n 2ka 3e 2lo 2ster 2ta 3e 3i 3u 2u 2va 3e 3i 13b 2dr 2er 3t. 2gu 2h 2ku 2lag 3i 2mu 2nu 2od 3g 3l 3t 2pli 2re 3i 2sc 3i 3ti 2to 3r 3y 2ø 14ble 2l5id 2sm 15i 2j 2ko 2o5r 3k 2pi 3r 2sua 2tæ 1ds5k 1f3r 1k1l 23re 3v 24tu 25ri 2s5t 1l3eg 3k 25ej 4l 3u 1n3s 24sv 2d3t 2gs1 2ter1 1on4 3s1 1r5t 1s3p 1t5re. 0j3ag 2le 3i 2r 15k 1de4rer 2s1 1ek4to 1lmel4di 5d5 1re5 1u3s 0k1k 2le 2si 2t 13h 2ste 14ny 2tar 3erh 2vo 3u 15au 2b 2lak 2stu 1e3sk 24t5a 25st 2l5s 1i3e 3st 1o3ra 3v 1s1p 23an 3k 25v 1t5re 3s 2i4e 0l1b 2f 2go1 2ke 3o 2l 2ta 3e 13dr 2h 2j 2ky 2op 2r 2ti 3r 3u 2ve 3i 3æ 14ps 2t5erf 3af 15mu 2sj 1a4g3r 2d3r 1d3st 2iagnos5 1e4mo 1fin4 4d5 1i4ga 25o 2ngeniø4 1o4du 1s5in 2es1 1t3o 1u5l 0m1b 2g 2l 2m 2n 2pe 3o 2r 2ud 13d 2f 2h 2k 2pi 3l 3r 2ste 2ta 3e 3i 3r 15ing 2sk 2tå 1i3k 24o 25sty 1men5 1o4da 1s3p 25in 3v 2e5s 1u1li 0n1b 2c 2f 2ke 3o 2m 2n 2sku 3ta 2ta 3e 3i 3r 13dr 2erk 2kr 3u 3æ 2ord 2r 2si 2to 3u 3y 2z 14go 15erl 2kv 2p 2sti 2tæ 1d5si 4k 4p 1e4da 25a 3sl 4t 2men4 5t5e 2o4 1i3st 25o 1s3po 1t4s5t 4u 2a4le 2iali4 0o1c 2e 2j 2ke 2li 3o 2te 13a 2ka 3u 2la 3e 3u 2or 2pi 2re. 43s 4g 4k 4r 4t 3i 2si 3o 2t 14as 2din 2g5o 3ek 4l 2r5in 15h 2in 2ly 3æ 2ov 2un 2å 1b3li 1d5ri 3s 3un 1f5r 1g5re 3sk 1i6s5e 1n3k 1ok5 1p3l 3r 3s 1r1an 23k 3sl 4t 3ø 25im 3o 2d5s 1v4s 0p1t 13d 2f 2m 2n 2sk 3t 14lan 2ro 15anl 2so 2ule 2v 1a5gh 1e1ra 23u 25s 1s4p 1u5b 1å3 0qu4 0r1b 2f 2gu 2h 2ke 3i 2l 2n 2r 2sa 3i 2te 3i 2ve 13dr 2ka 3u 2or 2p 2sp 3v 2to 2ud 2va 3i 3æ 14d5ar 2ing 2sk5v 2t5or 3eli 15enss 2kæ 2mu 2skr 3tu 3u 2tal 3ri 4o 3y 3æ 3ø 2år 2æl 1a5is 1d4s3 1e3st 25la 3s4u 4po 1i1e 25la 2ngse4 5o4r 1k3so 1mo4 1o1b 23p 1re5s 2o4n5 1s4n 1t3re 3s 25rat 1un4da 1y4s 0s1ar 2d 2f 2le 3i 2m 2pl 2s4 2ud 13af 3p 2kl 2un 2ve 14ed 2kå 2my 2nit 3æ 15int 2ju 2ly 2oms 2r4 2øk 1a4ma 1dy4 1e4se 1i4bl 1k5s4 1lo3 1o5k 1p4 1t5as 3om 1å4r5 0t1h 2m 2n 13si 3t 2væ 14ra 2sø 15så 2uds 2ve 1ands3 1e5ro 2de4l 3s5 2o1 1i3st 24en 3ø 2alis5t 1li4s5 1o1re 4i 25ra 2r4m 1ro5v 1s4pa 25pr 3ul 0u1a 2e 2la 3e 2rer 2te 3i 3o 13i 2læ 2ra 3e 3o 2si 14r3eg 15gu 2kl 2ly 2pe 2q 2ska 3o 1d3s 25r 1e4t5 1ge4ri 2s3 1k4ta 4r 1p5l 1s5a 3v 1t5r 3s4 0v3le 2st 15h 2j 2k 2li 2p 2re 2su 2t 1a5d 1e3s 24l5e 3reg 1i4l3in 1l4 2s1 0y1pe 13a 2e 2ke 3o 3v 2pi 2re 3i 2si 2ti 15dr 2ki 2li 3o 2mu 2o 2t3r 2ve 3æ 1k3li 24s5 1ns5 1r3ek 0zi5o 0å1d 2e 13l 2re 2t 15h 2sk 1rs5t 0æ1re 13c 2e 2ri 2so 3te 2ve 14g5r 3ek 15i 2kv 2o 2si 1b3l 1g5a 2s5 1lle4 1n1dr 1r4g5r 3ma 4o 25s 0ø1je 2re 2ve 13e 2ke 2le 2ri 1de5 1ms5 1n3st 24t3 1r5o 2ne3";

const exceptions = "";

/** `hyphenate` function for Danish (leftmin 2, rightmin 2),
 * for the `hyphenate` option of justify(). Compiles lazily on first use. */
export const hyphenateDa: (word: string) => string[] = createHyphenator({
  packed,
  exceptions,
  leftmin: 2,
  rightmin: 2,
});
