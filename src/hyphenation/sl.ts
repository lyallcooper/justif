/**
 * Slovenian hyphenation patterns, generated from CTAN hyph-utf8
 * (hyph-sl.tex, version 2.3) by tools/gen-hyphenation.mjs.
 * DO NOT EDIT — regenerate instead.
 *
 * The pattern data below is NOT covered by this package's MIT license;
 * it is redistributed under its original terms, reproduced here:
 *
 * title: Hyphenation patterns for Slovenian
 * copyright: Copyright (C) 1990 Matjaž Vrečko
 * notice: This file is part of the hyph-utf8 package.
 *     See http://www.hyphenation.org/tex for more information.
 * language:
 *     name: Slovenian
 *     tag: sl
 * version: 2.3
 * authors:
 *   -
 *     name: Matjaž Vrečko
 *     affiliation: TeXCeX
 *     contact: matjaz (at) mg-soft.si
 * licence:
 *     - This file is available under any of these licences:
 *     -
 *         name: LPPL
 *         version: 1
 *         or_later: true
 *         url: http://www.latex-project.org/lppl/lppl-1-0.html
 *     -
 *         name: MIT
 *         url: https://opensource.org/licences/MIT
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
 *     - 1990       First version of `hyphen.si' (Matjaž Vrečko, TeXCeX)
 * 
 *     - >
 *         Some cosmetic changes done later on, but none of these apply any more;
 *         the patterns are still the same as they were originally:
 *     - 1994-05-17 Use of code page 852 in patterns (Leon Žlajpah)
 *     - 1995-04-06 Release of `sihyph21.tex'
 *     - 1995-06-20 >
 *             Added \slovenehyphenmins
 *             Release of `sihyph22.tex'
 *     - 1997-15-04 >
 *             Some changes concerning "c, "s, "z and ...
 *             Release of `sihyph23.tex'
 *     - 2007-01-20 >
 *             `sihyph23.tex' renamed to `slhyph.tex'
 *             (sl is the proper language code for Slovenian)
 * texlive:
 *     synonyms:
 *         - slovene
 *     encoding: ec
 *     babelname: slovenian
 *     legacy_patterns: sihyph.tex
 *     message: Slovenian hyphenation patterns
 *     description: Hyphenation patterns for Slovenian in T1/EC and UTF-8 encodings.
 * 
 */
import { createHyphenator } from "./liang.js";

/** The patterns, sorted and front-coded; see `packed` in liang.ts. */
const packed =
  "0.av5r 1di6spo 1ek3s 35v 1is1 2z1 1ob5it 3i4d 2d1 1po4d5n 4v5s 2re6d7n 1se4k5s 2i4s 2t4 1voz5l 5n 1zliz6 1č8 1š8 1ž8 01fa 1hu 1ind 3p 3š 1kn 2re 1liz 2oč 1naj 3s 3z 2eh 1peč 1sc 2p 2tr 1usp 1viv 1wa 1ye 1z1r 22a 2i 2lj 2n 2o 2u 1čj 2l 02b1c 3d 3k 3n 3s 3t 3v 3č 3š 1c1n 3t 2c 2h. 2k 1d1b 3c 3d 3g 3h 3j 3k 3p 3s 3t 3v 3z2 3č 3š 23m 3o2f 1ew 1f1n 3s 2t 1g1d 3t 1h1k 3n 3t 3č 3š 1ine 2ss 1j1b 3c 3d 3g 3k 3l 3m 3n 3od 3p 3r 3s 3t 3v 3z 3č 3š 2h 2os 2us 3č 1k1c 3d 3m 3t 2s. 1l1b 3c 3d 3f 3g 3h 3k 3l 3m 3n 3p 3s 3t 3v 3z 3č 3š 3ž 2j. 3k 3n 3s 3č 3š 1m1b 3c 3d 3f 3k 3m 3p 3s 3t 3v 3č 3š 3ž 1n1b 3c 3f 3g 3h 3k 3l 3n 3p 3s 3t 3v 3z 3š 3ž 23d2 2j. 3c 3k 3s 3š 2č 1p1c 3k 3s 3t 3š 23č2 1r1b 3c 3d 3g 3h 3j 3k 3l 3m 3n 3p 3s 3t 3v 3z 3č 3š 2ae 1s1b 3f 3j 3s 2k. 2t. 3k 3m 1t1b 3c 3d 3k 3m 3s 3t 1u1a 1v1b 3c 3d 3j 3k 3m 3n 3p 3t 23zk 2zo 2č 1y1f 1z1b 3d2 3h 3is 3j 3k 3m 3od 3p 3s 3up 4z 3z2 3č 1č1b 3g 3k 3n 3p 3s 1š1j 2č. 3k 3n 1ž1b 3c 3j 3k 3č 03i4n3os 2nse 3tr 1ktr 1razl 3ču 2eal 2odi 1ste 1v2pa 3zg 1z4voj 2bir 2lil 3og 4ž 04bmi 1d3nac 5r 4ož 3vi 25nap 5č 4eb 4iz 4jač 3obd 2ind 2nas 2obč 1eth 1hl. 1idor 2gh 2le 3o 2nšk 2re 1j5int 2ime 2ob 3ž 1kst. 2tra 1l5izd 2jc 1mind 4p 4š 1njv 1ogl 2py 1phs 2loz 1sc. 2kre 2tf 1t3int 2ind 4os 4p 4se 2naj 2z. 1urg 1vjo 2šk 1z5išč 2redč 4z 4š 4ž 3i 3u 1č3let 2op 2up 1žmi 05dlet 1načel 1obla 3ro 2seb 1redč 1stim 1tema 1zlit 4v 06d5elem 1tletno 08č. 1š. 1ž. 0a1a 2b 2c 2d 2e1 2f 2g 2h 2i 2j 2k 2l 2m 2n 2o 2p 2ra 3e 3i 3o 3u 2s 2t 2u1 2v 2ze 2č 2š 2ž 12uk 14hm 2j5ek 3f 2kst 2mz 2nm 2ph 2sš 2tf 2uf 3l 2vž 2z3oč 3ig 3ob 3ra 15ju. 16dobl 1b5ba 26rod 1c5ci 1d2l 25ur 26rl. 5a 4ob 1f1t 25ga 1h5mi 4o 1i2n1 1j3os 3ug 4č 25fi 4o 3ha 4e 3im 3žn 26imo 3stb 1k4s 1n5mi 3zi 26dga 4hi 1o2b1 1r5xa 4o 4u 26dwa 1s5šč 1t4i 1v5ši 3ža 1y5to 1z3la 4e 24lil 5t 5v 3red 25fo 3ora 5o 3vp 1ž5mi 0b1h 2ja 2m 2z 2ž 13jem 2lep 2rab 4š 3ez 3ob 14ja. 15jel 4t 2leta 3il 4t 4v 2ord 2ras 3eže 1a4u 26bba 2n3č4 1e1 24v 1i1 1o1 25vp 26chm 1r6žda 2e4zg 5i 5r 1u5ki 4u 4v 3ry 0c1ka 15ko. 1h5ma 1k1o2 3s 25we 2ov3 0d1lo 12e 2li 2o 13rep 14i5no 2rev 2ur 15lit 4v 2niv 2raz 1d6voj 1e4min 4n 3z3i 1i4skr 25ck 26spr 2s1 1o5rd 3v4z 4č 1re6pn 1teks6 1u5ro 3um 0e1a 2b 2c 2d 2e 2f 2g 2h 2i 2j 2k 2l 2m 2n 2o1 2p 2ra 3e 3i 3o 3u 2s 2t 2u1 2v 2z 2č 2š 2ž 12č1v 13z4dr 14d3oč 3f 3obs 2ep 2ff 2rf 3r 2tinš 2wt 2yw 2z5or 4u4m5 3ob 3t 3ž 2čd 3t 2šp 15sta 4i. 5h 5l 2zij 4s 1b4j 26liz 1d2l 25ig 3ob 3vč 3zb 26obe 5r 1f5fe 3ta 1i2z 26pzi 2z5e 1k6mal 3tre 1o4dl 3z5n 2b4j 4r 1p5nik 1ra5z4r 6v 36z5l 1s5da 1v5ha 3stv 26pre 3ste 2e6t5l 1w5le 3to 26ind 1z2g 24l 3mo 3re 25dj 3gl 3imn 4z 26ijo 4st 3lom 3man 1č3le 25de 4i 4o 3op 3ti 4o 4r 3up 26vrs 1š5po 0fe1 26ljt 1f5ma 1i6zlj 1o6uri 1re4u 1t5ve 1u1 0ge6ige 3njč 2l5č4 1i6tpr 1o1 25vz 1u1 0h4lo 15ren 1a4u 1e4i 1u6ffm 0i1a 2b 2c 2d 2e1 2f 2g 2h 2i 2j 2k 2l 2m 2n 2o1 2p 2r 2s 2t 2u 2v 2x 2z 2ča 3e 3i 3u 2š 2ž 12zr 14cs 2kč 2mh 2skv 1i2n1 1k5ča 1l5č4k 1m5hi 1s4a 26ert 2is4 1t5pr 1v5jo 1z1l 3u 24la 25me 4o 3po 26ode 3ure 2li4z 1č5ra 3vr 0j1hi 15akt 1e4ks4 1od4l 1ra1 3z4 1sis6t 1u1 22ž1 25dm 1z6ves 0k5sat 2vip 1e5ti 1i1 1o1 25kd 26vše 2k4 2z6lo 1s1c 3p 3t 24po 25te 26taz 1u5ro 0l2i1 1a4ir 26vz. 1e1 24e 25me 26ipz 1g5ča 1i6dž. 1ju5d6j 1o1 1u5ki 4u 0m5niv 2urn 1e4d5n 4r 26dos 1i6th. 1o6vš. 3št. 1y5hi 0n1ča 3e 3i 3u 14dm 2gh 3v 2ost 2tg 3v 1a1 24d5nj 4re 3j3u 45en 3v3z 26dra 4ur 3jak 4oč 2d5r 2j3o 2vze6 2z6or 1d5ga 3hi 1e1 23d2 3zm 2z4v 1g5ha 3vi 1je4v5s 1o5rd 1sis4 1t5ga 4e 3vi 2eks4 1u1 1y5qu 1z4i 0o1a 2b 2c 2d 2e 2f 2g 2h 2i 2j 2k 2l 2m 2n 2o 2p 2ra 3e 3i 3o 3u 2s 2t 2u 2v 2y 2z 2č 2š 2ž 12d1ž 2ol 2v1z 14as 2bz 2cr 2kb 3t 2lr 2om 2pm 15vza 16drep 2l5avt 1b5gl 3ide 3jo 1c5ke 4i 1d5dv 3nal 3zd 1ele4 1iz2 1k5ba 4e 1l5re 26gča 1od4l 1p5me 1r4deč 1se4m5 1u5ki 4u 1v3zd 25sem 3šk 1z2n 3o 3r 3v 24b 3g 25lo 3nic 5š 26lož 2d5j 1ž5mi 0pe1 24kt 3tle 3v5s 2t3l 2v5t4 1h5so 1i5zo 1o1 24d3l 45oč 4na 26dfa 3lob 3std 1rez4 1z6ig. 1č5ka 0qu2 0r1f 2r 2ž 13v2j 14in 2th 1a4z5id 5or 26jžn 3vza 2v5z 1e1 25jo 3km 3čv 26cht 3dig 4nju 3iba 3sda 3znač 4us 4ve 2v6sk 1i1 25n4o 2z4g 4l 4n 1o1 25zo 2b6id 1t5ha 1u5kl 1v5jo 1y5an 1z2l 1ž5da 0s2ci 2kn 14id 2lav 2on 2plod 2ten 3ir 4č 3ra. 1e4k5sa 25ma 3vp 2k5si 1i1 26gn. 2s1 1oni5 4č4 1pod4l 1u1 24bo 1ve5t 0t1f 1a5wi 2z4 1ch5o 1e5xa 2k6st 1o6vž. 1r6tur 2t5u 1u1 0u1b 2c 2d 2e 2f 2g 2h 2i 2j 2ka 3e 3o 2l 2m 2n 2p 2ra 3e 3i 2s 2t 2v 2z 2č 2š 2ž 14bp 2th 1b4j 25po 1d6mi. 1p6čka 1th5o 1x5em 1še3s 0v1f 2g 2ča 3e 3i 12za 3u 13zp 14pij 4l 2čer 15skn 2šek 1e4i 3tin 3čl 4m 2tle6t 1i5dv 26žg. 2d6va 1o5rd 2z5le 1t4k 1z2 0wo2 0x1f 0y1j 2l 2w 0z1c 2g 2ig 2li 3u 2ob 3g 2t 2v2 2š 2ž 12ol 13dv 2ku 2vn 14gni 2om 2uj 2ven 3ok 15got 2las 3om 16ane. 1a1z2 23vp 25uk 3zd 1d5ju 1liz5 0č5mes 1i1 0š2č 1e2s";

const exceptions = "";

/** `hyphenate` function for Slovenian (leftmin 2, rightmin 2),
 * for the `hyphenate` option of justify(). Compiles lazily on first use. */
export const hyphenateSl: (word: string) => string[] = createHyphenator({
  packed,
  exceptions,
  leftmin: 2,
  rightmin: 2,
});
