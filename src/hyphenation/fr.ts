/**
 * French hyphenation patterns, generated from CTAN hyph-utf8
 * (hyph-fr.tex, version V2.13 2016/05/12) by tools/gen-hyphenation.mjs.
 * DO NOT EDIT — regenerate instead.
 *
 * The pattern data below is NOT covered by this package's MIT license;
 * it is redistributed under its original terms, reproduced here:
 *
 * title: Hyphenation patterns for French
 * copyright: Copyright (C) 1994-2002 Daniel Flipo, Bernard Gaulle, 2016 Arthur Reutenauer
 * notice: This file is part of the hyph-utf8 package.
 *     See http://www.hyphenation.org/tex for more information.
 * language:
 *     name: French
 *     tag: fr
 * version: V2.13 2016/05/12
 * authors:
 *     -
 *         name: Daniel Flipo
 *     -
 *         name: Bernard Gaulle
 *         note: deceased
 *     -
 *         name: Arthur Reutenauer
 *         contact: arthur (at) reutenauer.eu
 *     -
 *         email: cesure-l (at) gutenberg (dot} eu (dot) org
 * licence:
 *     name: MIT
 *     url: https://opensource.org/licenses/MIT
 *     text: >
 *         Permission is hereby granted, free of charge, to any person obtaining
 *         a copy of this software and associated documentation files (the
 *         "Software"), to deal in the Software without restriction, including
 *         without limitation the rights to use, copy, modify, merge, publish,
 *         distribute, sublicense, and/or sell copies of the Software, and to
 *         permit persons to whom the Software is furnished to do so, subject to
 *         the following conditions:
 * 
 *         The above copyright notice and this permission notice shall be
 *         included in all copies or substantial portions of the Software.
 * 
 *         THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 *         EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 *         MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *         NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
 *         BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 *         ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 *         CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *         SOFTWARE.
 * hyphenmins:
 *     typesetting:
 *         left: 2
 *         right: 2
 * texlive:
 *     synonyms:
 *         - patois
 *         - francais
 *     encoding: ec
 *     babelname: french
 *     legacy_patterns: frhyph.tex
 *     message: French hyphenation patterns
 *     description: Hyphenation patterns for French in T1/EC and UTF-8 encodings.
 * ==========================================
 * %%%%%%% The most famous good guys who worked hard to obtain something usable.
 * Jacques Desarmenien, Universite de Strasbourg :
 *          -  << how to run TeX in a French environment: hyphenation, fonts,
 *             typography. >> in Tugboat, 5 (1984) 91-102. and TeX85 conference
 *          -  << La division par ordinateur des mots francais :
 *             application a TeX >> in TSI vol. 5 No 4, 1986 (C) AFCET-
 *                                                             Gauthier-Villars
 * Norman Buckle, UQAH (nb; many additions)
 * Michael Ferguson, INRS-Telecommunications (mjf) June 1988
 * Justin Bur, Universite de Montreal (jbb; checked against original list)
 *                    all patterns including apostrophe missing from nb list
 * after that, GUTenberg  and specially Daniel Flipo and Bernard Gaulle
 * did their best effort to improve the list of patterns.
 * 
 * 
 */
import { createHyphenator } from "./liang.js";

/** The patterns, sorted and front-coded; see `packed` in liang.ts. */
const packed =
  "0'2a2nesthési 3lcool 2informat 2octet 1a2g3nat 24 2b3réa 2e3s4ch 2mino1a2c 2na3s4tr 3ti1a2 6e2 6s2 6é2 52enne 2po2s3ta 2r3gent. 4pent. 2s2ta 1e4 2n1a2 4o2 2u2r1a2 1i2g3ni 6é 24 2n1a2 4e2 4i2 4o2 4s2tab 4u2 4é2 32a3nit 5ugur 4effab 5pt 5r 5xora 4i3miti 6q 6t 4o3cul 5nd 4u3l 5it 4é3lucta 6narra 3te4r3 5ra2 6e2 6i2 6o2 6s2 6u2 6é2 1o4 2n3guent. 2ua1ou 2vi1s2c 1u4 1y4 1â4 1è4 1é4 1ê4 1î4 1ô4 1û4 0.a2g3nat 24 2b3réa 2e3s4ch 2mino1a2c 2na3s4tr 3ti1a2 6e2 6s2 6é2 52enne 2po2s3ta 2r3dent. 4gent. 4pent. 2s2ta 1bai2se3main 2i1a2c 6t 5u 4u2 32s1a2 3o1a2 1ch4 3è2vre3feuille 2i2s1alp 2o1o2 32o3lie 3m3ment. 3n4 4s4 4tre1s2c 73maître 2ul4 1dacryo1a2 2i1a2cid 7é 6mi 6tom 5ld 4e2n 32s3h 2o3lent. 2y2s1a2 6i2 6o2 6u2 53 2é1a2 4io 4o2 32s 51i2 6u2n 6é2 6œ 33s2a3cr 8tell 7str 6c 6ensib 7rt 7xu 6i3d 8gn 8li 8nen 8r 7nvo 7st 6o3dé 8l 8pil 7rm 8p 7ufr 6p 6t 6é3gr 3s2a3m 1e4 2n1a2 4o2 2u2r1a2 1gem2ment. 1i2g3ni 6é 24 2n1a2 4e2 4i2 4o2 4s2tab 4u2 4é2 32a3nit 5ugur 4effab 5pt 5r 5xora 4i3miti 6q 6t 4o3cul 5nd 4u3l 5it 4é3lucta 6narra 3te4r3 5ra2 6e2 6i2 6o2 6s2 6u2 6é2 1kh4 1la3tent. 1ma2c3k 4g3nicide 8ficat 7um 4l1a2dres :o 8v 7isé 7p 6en 6int 6o2d 7c 4r1x 3cro1s2c 2illi1am 2ono1a2 6e2 6i2 6o2 6s2 6u2 6é2 6ï2dé 2é2g1oh 4s1es 6i 6u2s 5a 33san 3ta1s2ta 1no2n1obs 1o4 2n3guent. 2ua1ou 2vi1s2c 1pa2n1a2f 8mé 8ra 6is 6o2ph 7pt 4r1a2che :è 53hé 33rent. 4tent. 3ra1s2 2e4r 3n2ta 3r1a2 5e2 5i2 5o2 5u2 5é2 2h4 3alan3s2t 2luri1a 2on2tet 3s2t1in 7o2 63h 7r 4t1s2 2ro1s2cé 5é2 42g3nath 4u3d2h 3é1a2 5e2 5i2 5o2 5s2 5u2 5é2 42a3la 6u 2sycho1a2n 2ud1d2l 2éri1os 6s2 6u2 52s3s 8ta 1re1s2 32s3cap 7isi 9o 7ou 7ri 6pect 7ir 7lend 7ons 6quil 6s 6t 33s4tab 8g 8nd 8t 7im 8p 7oc 8p 7r 7u 7y 7én 8r 34s5trein 8ict 9n 3s3sent. 2é1a2 4e2 4i2 4o2 4é2 32a3le 7is 8t 5ux 4el 5r 4i3fi 4uss 4èr 3tro1a2 3u2 1sar3ment. 2ch4 2er3ment. 3u2le 2h4 2ou3vent. 2ta2g3n 3il3l 2u2b1a2 6in 6ur 6é2 53limin 8n 7u 4r1a2 6e2 6i2m 7nf 8t 6of 7x 6é2 53h 33b2alt 6é3r 4r2a3t 6eau 7ll 7t 2yn2g3nath 1ta3lent. 2h4 2ri1a2c 7n 7t 5o2n 1u4 1y4 1â4 1è4 1é4 2mi3nent. 1ê4 1î4 1ô4 1û4 01a2nesthési 2lcool 1b2l 3r 2a 2e 2i 2o 2u 2y 2â 2è 2é 2ê 2î 2ô 2û 1c2h 3k 3l 3r 2a 2e 2i 2o 2u 2y 2â 2è 2é 2ê 2î 2ô 2û 2œ 1d' 22r 2a 2e 2i 2o 2u 2y 2â 2è 2é 2ê 2î 2ô 2û 1f2l 3r 2a 2e 2i 2o 2u 2y 2â 2è 2é 2ê 2î 2ô 2û 1g2ha 4e 4i 4o 4y 3l 3n 3r 2a 2e 2i 2o 2u 2y 2â 2è 2é 2ê 2î 2ô 2û 1ha 2e 2i 2o 2u 2y 2â 2è 2é 2ê 2î 2ô 2û 1informat 1j 1k2h 3r 2a 2e 2i 2o 2u 2y 2â 2è 2é 2ê 2î 2ô 2û 1la 2e 2i 2o 2u 2y 2à 2â 2è 2é 2ê 2î 2ô 2û 1m2nès 4émo 5si 2a 2e 2i 2o 2u 2y 2â 2è 2é 2ê 2î 2ô 2û 2œ 1na 2e 2i 2o 2u 2y 2â 2è 2é 2ê 2î 2ô 2û 2œ 1octet 1p2h 3l 3neu 4é 3r 3sych 3tèr 4ér 2a 2e 2i 2o 2u 2y 2â 2è 2é 2ê 2î 2ô 2û 1q 1r2h 2a 2e 2i 2o 2u 2y 2â 2è 2é 2ê 2î 2ô 2û 1s2caph 4h 4lér 4op 3h 3lav 4ov 3patia 4erm 4hèr 5ér 4iel 5ros 4or 3tandard 4ein 4igm 4ock 5mos 4roph 5uctu 4yle 2a 2e 2i 2o 2u 2y 2â 2è 2é 2ê 2î 2ô 2û 2œ 1t2h 3r 2a 2e 2i 2o 2u 2y 2à 2â 2è 2é 2ê 2î 2ô 2û 1v2r 2a 2e 2i 2o 2u 2y 2â 2è 2é 2ê 2î 2ô 2û 1w2r 2a 2e 2i 2o 2u 1za 2e 2i 2o 2u 2y 2è 2é 1ç 1é2drie 6que 3lectr 4ément 3nerg 02'2 1bent. 2lent. 2rent. 1cent. 2hb 3ent. 3g 3m 3n 3p 3s 3t 3w 2k3h 3b 3ent. 3f 3g 3p 3s 3t 2lent. 2rent. 1dent. 2lent. 2rent. 1fent. 2lent. 2rent. 1gent. 2lent. 2nent. 2rent. 2uent. 1jent. 2k 1kent. 1lent. 1nent. 1pent. 2hent. 3n 3s 3t 2lent. 2rent. 1quent. 1r3heur 4ydr 2ent. 1s3hom 2chs 2ent. 2hent. 3m 3r 3s 1t3heur 2ent. 2hl 3m 3n 3s 2rent. 1vent. 2rent. 1went. 1xent. 1zent. 03d2hal 4oud 1ph2talé 5is 04be. 3s. 2le. 4s. 2re. 4s. 1ce. 3s. 2h. 3e. 4s. 3le. 5s. 3re. 5s. 2k. 3e. 4s. 2le. 4s. 2re. 4s. 1de. 3s. 2re. 4s. 1fe. 3s. 2le. 4s. 2re. 4s. 1ge. 3s. 2le. 4s. 2ne. 4s. 2re. 4s. 2ue. 4s. 1he. 3s. 1je. 3s. 1ke. 3s. 2h. 1le. 3s. 1me. 3s. 1ne. 3s. 1pe. 3s. 2h. 3e. 4s. 3le. 5s. 3re. 5s. 2le. 4s. 2re. 4s. 1que. 4s. 1re. 3s. 2he. 4s. 1sch. 4e. 5s. 2e. 3s. 2h. 3e. 4s. 1te. 3s. 2h. 3e. 4s. 3re. 5s. 2re. 4s. 1ve. 3s. 2re. 4s. 1we. 3s. 1ze. 3s. 0a1è2dre 12g3nos 2l1algi 2s3tro 1b2h 23sent. 2sti3nent. 2î2ment. 1c3cent. 2quies4cent. 1d2h 1i2ment. 1malga2ment. 1ni2ment. 2tifer3ment. 1po2s3tr 2pa3rent. 1r2ment. 2chi1é2pis 2mil5l 1s2ment. 1u2ment. 1vil4l 0bou2ment. 3til3l 1ru2ment. 0ca3ou3t2 2pil3l 2rê2ment. 1ci3dent. 1h2l 3r 2evil4l 2ien3dent. 2lo2r3a2c 7é2t 2ro2ment. 1il3l 1la2ment. 1o1a2d 4cc 5q 4p 4r 4ssoc 6ur 4u 4x 3ef 4n 4x 3é2 22g3niti 3nurb 2mpé3tent. 2nfi3dent. 3ni3vent. 3ti3nent. 5n3gent. 2rpu3lent. 1ur3rent. 1yril3l 0d1d2h 2s2 1a2ment. 1i2s3cop 2aphrag2ment. 2li3gent. 2ssi3dent. 3til3l 1éca3dent. 2tri3ment. 0e2n1i2vr 2s3ch 5op 1ntre3gent. 1r2ment. 1s3cent. 2ti2ment. 1u1s2tat 1xtra1 52c 6i 0f1s2 1a2ment. 1ichu3ment. 2r2ment. 1lam2ment. 1ritil3l 1u2ment. 1écu3lent. 0g1s2 1il3l 1ram2ment. 3ndilo3quent. 0hil3l 1u2ment. 1ype4r1 4ra2 5e2 5i2 5o2 5s2 5u2 5é2 3o1a2 5e2 5i2 5o2 5s2 5u2 5é2 1émi1é 3o1p2t 0i1algi 3rthr 2oxy 2s2tat 2è2dre 12s3chia 7o 6é 1bril3l 1l2l 1mma3nent. 3i3nent. 4s4cent. 2po3tent. 3u3dent. 1nci3dent. 2di3gent. 3o3lent. 3ul3gent. 2no3cent. 2so3lent. 3til3l 2telli3gent. 3i2ment. 1o1a2ct 1s3cent. 1va3lent. 0ja3cent. 0l1s2t 12ment. 13lion 1a2w3re 1il3l 1lu2ment. 0m1s2 1i2ment. 2l3l 34let 2t3tent. 1on2t3réal 3ova3lent. 2ye2n1â2g 1unifi3cent. 1écon3tent. 0n1x 13s2at. 6s. 1utri3ment. 0o1d2l 2ioni 2s2tas 6t 5im 5om 5rad 7tu 6iction 5éro 2è2dre 12b3long 2g3nomoni 6si 1m2ment. 2bud2s3 2ni1s2 4po3tent. 1pu3lent. 1r2ment. 1xy1a2 0paléo1é2 2pil3la 7e 7i 7om 1er3h 3ma3nent. 3ti3nent. 1h2l 3r 2oto1s2 1iril3l 1lu2ment. 1o1astre 2ly1a2 5e2 5i2 5o2 5s2 5u2 5è2 5é2 4va3lent. 1rivatdo3cent. 9zent. 2o2s3tat 3émi3nent. 2u3dent. 2é3sent. 3émi3nent. 1u2g3nable 7c 2pil3l 2sil3l 1é1r2é2q 22nul 0qua2ment. 0ra2ment. 2dio1a2 2i3ment. 1cil4l 1e3lent. 3pent. 2li2ment. 1i2ment. 2n3gent. 1mil4l 1u3lent. 1yth2ment. 1é3gent. 2ma3nent. 2sur3gent. 2ti3cent. 0semil4l 2r3gent. 4pent. 2squi1a2 1lalo2ment. 1poru4lent. 1téréo1s2 1u2ment. 23r2ah 2b1s2 3li2ment. 2ccu3lent. 2pe4r1 4ro2 5s2 2rémi3nent. 0t1t2l 1a2ment. 2chy1a2 2n3gent. 1chin3t2 1empéra3ment. 2r3gent. 2sta3ment. 1h2r 2ermo1s2 2ril3l 1o2ment. 2r3rent. 1ran2s1a2 7o2 7u2 63h 7p 43s2act 8ts 4spa3rent. 2i3dent. 2ucu3lent. 1u2ment. 2ng2s3 2rbu3lent. 1élé1e2 5i2 5o2b 7p 5s2 0u2s3tr 1cil4l 1evil4l 1ni1a2x 4o2v 1vil4l 0vacil4l 2nil3lin 8s 1eni2ment. 3tripo3tent. 1idi2ment. 2l3l 1ol2t1amp 1élo1s2ki 0wa2g3n 0xil3l 0y1algi 3sth 2s2tom 0â2ment. 0è2ment. 0é3cent. 2dent. 2quent. 2rent. 1ci2ment. 2u2ment. 1d2hi 1li2ment. 2o3quent. 1mil4l 1ni3tent. 1pi2s3cop 33s4cope 1quipo3tent. 4va4lent. 0ô2ment.";

const exceptions = "";

/** `hyphenate` function for French (leftmin 2, rightmin 2),
 * for the `hyphenate` option of justify(). Compiles lazily on first use. */
export const hyphenateFr: (word: string) => string[] = createHyphenator({
  packed,
  exceptions,
  leftmin: 2,
  rightmin: 2,
});
