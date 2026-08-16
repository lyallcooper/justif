/**
 * Croatian hyphenation patterns, generated from CTAN hyph-utf8
 * (hyph-hr.tex, version 1) by tools/gen-hyphenation.mjs.
 * DO NOT EDIT — regenerate instead.
 *
 * The pattern data below is NOT covered by this package's MIT license;
 * it is redistributed under its original terms, reproduced here:
 *
 * title: Hyphenation patterns for Croatian
 * copyright: Copyright (C) 1994, 1996, 2011, 2015 Igor Marinović
 * notice: This file is part of the hyph-utf8 package.
 *     See http://www.hyphenation.org/tex for more information.
 * language:
 *     name: Croatian
 *     tag: hr
 * authors:
 *   -
 *     name: Igor Marinović
 *     contact: marinowski (at) gmail.com
 * licence:
 *     - This file is available under any of these licences:
 *     -
 *         name: LPPL
 *         version: 1
 *         or_later: true
 *         url: http://www.latex-project.org/lppl/lppl-1-0.html
 *     -
 *         text: >
 *             Permission is hereby granted, free of charge, to any person obtaining
 *             a copy of this file and any associated documentation
 *             (the "Data Files") to deal in the Data Files
 *             without restriction, including without limitation the rights to use,
 *             copy, modify, merge, publish, distribute, and/or sell copies of
 *             the Data Files, and to permit persons to whom the Data Files
 *             are furnished to do so, provided that
 *             (a) this copyright and permission notice appear with all copies 
 *             of the Data Files,
 *             (b) this copyright and permission notice appear in associated 
 *             documentation, and
 *             (c) there is clear notice in each modified Data File
 *             as well as in the documentation associated with the Data File(s)
 *             that the data has been modified.
 *             
 *             THE DATA FILES ARE PROVIDED "AS IS", WITHOUT WARRANTY OF
 *             ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 *             WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *             NONINFRINGEMENT OF THIRD PARTY RIGHTS.
 *             IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS
 *             NOTICE BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL
 *             DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE,
 *             DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 *             TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 *             PERFORMANCE OF THE DATA FILES.
 *             
 *             Except as contained in this notice, the name of a copyright holder
 *             shall not be used in advertising or otherwise to promote the sale,
 *             use or other dealings in these Data Files without prior
 *             written authorization of the copyright holder.
 * hyphenmins:
 *     typesetting:
 *         left: 2
 *         right: 2
 * changes:
 *     - Late 1994 first version
 *     - Beginning of 1996 much more improved version (date of last change: 19.03.1996).
 *     - In summer 2008 patterns incorporated into hyph-utf8 and renamed from hrhyph.tex to hyph-hr.tex.
 *     - 06.06.2011 LPPL licence added.
 * texlive:
 *     encoding: ec
 *     babelname: croatian
 *     legacy_patterns: hrhyph.tex
 *     message: Croatian hyphenation patterns
 *     description: Hyphenation patterns for Croatian in T1/EC and UTF-8 encodings.
 * 
 */
import { createHyphenator } from "./liang.js";

/** The patterns, sorted and front-coded; see `packed` in liang.ts. */
const packed =
  "0.be2z1 1is1 2z1 1na2j1 2e2o3 1zg2 01bj 2l 2r 2v 1cj 2l 2r 2v 1dj 2r 2v 2žj 3l 3r 3v 1fj 2l 2r 2v 1gj 2l 2r 2v 1hj 2l 2r 2v 1k2lj 2j 2r 1ljl 3r 3v 1mj 2l 2r 2v 1njj 3l 3r 3v 2l 2v 1pj 2l 2r 2v 1r2je 1sb 2d 3ž 2f 2g 2h 2j 2k 2lj 2m 2nj 2r 2s 2v 2z 2ć 2č 2đ 2š 2ž 1tj 2l 2r 2v 1v2je 2r 1zc 2dž 2f 2h 2j 2k 2nj 2p 2t 2v 2z 2ć 2č 2đ 2š 2ž 1ćl 2r 2v 1čj 2l 2r 2v 1đj 2l 2r 2v 1šb 2d 3ž 2f 2g 2h 2j 2k 2m 2p 2r 2s 2t 2v 2z 2đ 2š 2ž 1žc 2d 3ž 2f 2g 2h 2k 2l 2m 2p 2r 2s 2t 2v 2z 2ć 2č 2đ 2š 2ž 02b1lj 2j. 2l. 2r. 2v. 1c1lj 2j. 2l. 2r. 2v. 1d1g 3ja 3l 4j 3vj 4l 4r 2j. 2r. 2v. 2ž1lj 3j. 3l. 3r. 3v. 1f1lj 2j. 2l. 2r. 2v. 1g1lj 2j. 2l. 2r. 2v. 1h1lj 2j. 2l. 2r. 2v. 1j1lj 1kj. 2lj. 2r. 1l1lj 2jl. 3r. 3v. 1m1lj 2j. 2l. 2r. 2v. 1n1lj 2j. 31lj 3j. 3l. 3r. 3v. 2l. 2v. 1p1h 3lj 2j. 2l. 2r. 2v. 1r1lj 2t. 1s1hr 3kr 2b. 2d. 3ž. 2f. 2g. 2h. 2j. 2k. 2lj. 2m. 2n. 3j. 2r. 2s. 2t. 2v. 2z. 2ć. 2č. 2đ. 2š. 2ž. 1t1lj 2j. 2l. 2r. 2v. 1v1lj 1z1lj 3vr 2c. 2dž. 2f. 2h. 2j. 2k. 2nj. 2p. 2t. 2v. 2z. 2ć. 2č. 2đ. 2š. 2ž. 1ć1lj 2l. 2r. 2v. 1č1lj 2j. 2l. 2r. 2v. 1đ1lj 2j. 2l. 2r. 2v. 1š1lj 3nj 3tv 2b. 2d. 3ž. 2f. 2g. 2h. 2j. 2k. 2m. 2p. 2r. 2s. 2t. 2v. 2z. 2đ. 2š. 2ž. 1ž1nj 2b. 2c. 2d. 3ž. 2f. 2g. 2h. 2k. 2l. 2m. 2n. 2p. 2r. 2s. 2t. 2v. 2z. 2ć. 2č. 2đ. 2š. 2ž. 0a1a2 2ba 3e 3i 3o 3u 2ca 3e 3i 3o 3u 2da 3e 3i 3o 3u 3ža 4e 4i 4o 4u 2e2 2fa 3e 3i 3o 3u 2ga 3e 3i 3o 3u 2ha 3e 3i 3o 3u 2i2 2ja 3e 3i 3o 3u 2ka 3e 3i 3o 3u 2la 3e 3i 3ja 4e 4i 4o 4u 3o 3u 2ma 3e 3i 3o 3u 2na 3e 3i 3ja 4e 4i 4o 4u 3o 3u 2o2 2pa 3e 3i 3o 3u 2ra 3e 3i 3o 3u 2sa 3e 3i 3o 3u 2ta 3e 3i 3o 3u 2u2 2va 3e 3i 3o 3u 2za 3e 3i 3o 3u 2ća 3e 3i 3o 3u 2ča 3e 3i 3o 3u 2đa 3e 3i 3o 3u 2ša 3e 3i 3o 3u 2ža 3e 3i 3o 3u 0b1b 2c 2d 3ž 2f 2g 2h 2k 2m 2n 3j 2p 2s 2t 2z 2ć 2č 2đ 2š 2ž 0c1b 2c 2d 3ž 2f 2g 2h 2k 2m 2n 3j 2p 2s 2t 2z 2ć 2č 2đ 2š 2ž 0d1b 2c 2d 2f 2h 2k 2m 2n 3j 2p 2s 32m 4p 4t 2t 2z 2ć 2č 2đ 2š 32k 12ž 1ž1b 3c 3d 4ž 3f 3g 3h 3k 3m 3n 4j 3p 3s 3t 3z 3ć 3č 3đ 3š 3ž 0e1a2 2ba 3e 3i 3o 3u 2ca 3e 3i 3o 3u 2da 3e 3i 3o 3u 3ža 4e 4i 4o 4u 2e2 2fa 3e 3i 3o 3u 2ga 3e 3i 3o 3u 2ha 3e 3i 3o 3u 2i2 2ja 3e 3i 3o 3u 2ka 3e 3i 3o 3u 2la 3e 3i 3ja 4e 4i 4o 4u 3o 3u 2ma 3e 3i 3o 3u 2na 3e 3i 3ja 4e 4i 4o 4u 3o 3u 2o2 2pa 3e 3i 3o 3u 2ra 3e 3i 3o 3u 2sa 3e 3i 3o 3u 2ta 3e 3i 3o 3u 2u2 2va 3e 3i 3o 3u 2za 3e 3i 3o 3u 2ća 3e 3i 3o 3u 2ča 3e 3i 3o 3u 2đa 3e 3i 3o 3u 2ša 3e 3i 3o 3u 2ža 3e 3i 3o 3u 0f1b 2c 2d 3ž 2f 2g 2h 2k 2m 2n 3j 2p 2s 2t 2z 2ć 2č 2đ 2š 2ž 0g1b 2c 2d 3ž 2f 2g 2h 2k 2m 2n 3j 2p 2s 2t 2z 2ć 2č 2đ 2š 2ž 0h1b 2c 2d 3ž 2f 2g 2h 2k 2m 2n 3j 2p 2s 2t 2z 2ć 2č 2đ 2š 2ž 0i1a2 2ba 3e 3i 3o 3u 2ca 3e 3i 3o 3u 2da 3e 3i 3o 3u 3ža 4e 4i 4o 4u 2e2 2fa 3e 3i 3o 3u 2ga 3e 3i 3o 3u 2ha 3e 3i 3o 3u 2i2 2ja 3e 3i 3o 3u 2ka 3e 3i 3o 3u 2la 3e 3i 3ja 4e 4i 4o 4u 3o 3u 2ma 3e 3i 3o 3u 2na 3e 3i 3ja 4e 4i 4o 4u 3o 3u 2o2 2pa 3e 3i 3o 3u 2ra 3e 3i 3o 3u 2sa 3e 3i 3o 3u 2ta 3e 3i 3o 3u 2u2 2va 3e 3i 3o 3u 2za 3e 3i 3o 3u 2ća 3e 3i 3o 3u 2ča 3e 3i 3o 3u 2đa 3e 3i 3o 3u 2ša 3e 3i 3o 3u 2ža 3e 3i 3o 3u 0j1b 2c 2d 3ž 2f 2g 2h 2j 2k 2l 2m 2n 3j 2p 2r 2s 32l 4t 2t 2v 2z 32g 2ć 2č 2đ 2š 2ž 0k1b 2c 2d 3ž 2f 2g 2h 2k 2l 2m 2n 3j 2p 2s 2t 2v 2z 2ć 2č 2đ 2š 2ž 12s1p 0l1b 2c 2d 3ž 2f 2g 2h 2k 2l 2m 2n 3j 2p 2r 2s 2t 2v 2z 2ć 2č 2đ 2š 2ž 12f1t 2m1s 1j1b 3c 3d 4ž 3f 3g 3h 3k 3lj 3m 3n 4j 3p 3s 3t 3z 3ć 3č 3đ 3š 3ž 0m1b 2c 2d 3ž 2f 2g 2h 2k 2m 2n 3j 2p 2s 2t 2z 2ć 2č 2đ 2š 2ž 12p1t 0n1b 2c 2d 3ž 2f 2g 2h 2k 2m 2n 3j 2p 2r 2s 2t 2z 2ć 2č 2đ 2š 2ž 12k1c 2s1t 2t1n 4s 1j1b 3c 3d 4ž 3f 3g 3h 3k 3m 3n 4j 3p 3s 3t 3z 3ć 3č 3đ 3š 3ž 0o1a2 2ba 3e 3i 3o 3u 2ca 3e 3i 3o 3u 2da 3e 3i 3o 3u 3ža 4e 4i 4o 4u 2e2 2fa 3e 3i 3o 3u 2ga 3e 3i 3o 3u 2ha 3e 3i 3o 3u 2i2 2ja 3e 3i 3o 3u 2ka 3e 3i 3o 3u 2la 3e 3i 3ja 4e 4i 4o 4u 3o 3u 2ma 3e 3i 3o 3u 2na 3e 3i 3ja 4e 4i 4o 4u 3o 3u 2o2 2pa 3e 3i 3o 3u 2ra 3e 3i 3o 3u 2sa 3e 3i 3o 3u 2ta 3e 3i 3o 3u 2u2 2va 3e 3i 3o 3u 2za 3e 3i 3o 3u 2ća 3e 3i 3o 3u 2ča 3e 3i 3o 3u 2đa 3e 3i 3o 3u 2ša 3e 3i 3o 3u 2ža 3e 3i 3o 3u 0p1b 2c 2d 3ž 2f 2g 2k 2m 2n 3j 2p 2s 2t 2z 2ć 2č 2đ 2š 2ž 0r1b 2c 2d 3ž 2f 2g 2h 2j 2k 2l 2m 2n 3j 2p 2r 2s 32t 2t 2v 2z 2ć 2č 2đ 2š 2ž 12c1n 2d1n 3ž1b 2g1n 2h1k 4nj 4t 2k1n 2n1c 4k 4t 2p1c 2t1c 4k 4m 4n 4s 2v1n 2z1n 2č1k 0s1c 2k2l 2l 2n 2p 2t 2v2l 12p1n 0t1b 2c 2d 3ž 2f 2g 2h 2k 32l 2m 2n 3j 2p 2s 32t 2t 2z 2ć 2č 2đ 2š 2ž 0u1a2 2ba 3e 3i 3o 3u 2ca 3e 3i 3o 3u 2da 3e 3i 3o 3u 3ža 4e 4i 4o 4u 2e2 2fa 3e 3i 3o 3u 2ga 3e 3i 3o 3u 2ha 3e 3i 3o 3u 2i2 2ja 3e 3i 3o 3u 2ka 3e 3i 3o 3u 2la 3e 3i 3ja 4e 4i 4o 4u 3o 3u 2ma 3e 3i 3o 3u 2na 3e 3i 3ja 4e 4i 4o 4u 3o 3u 2o2 2pa 3e 3i 3o 3u 2ra 3e 3i 3o 3u 2sa 3e 3i 3o 3u 2ta 3e 3i 3o 3u 2u2 2va 3e 3i 3o 3u 2za 3e 3i 3o 3u 2ća 3e 3i 3o 3u 2ča 3e 3i 3o 3u 2đa 3e 3i 3o 3u 2ša 3e 3i 3o 3u 2ža 3e 3i 3o 3u 0v1b 2c 2d 3ž 2f 2g 2h 2j 2k 2l 2m 2n 3j 2p 2s 2t 2v 2z 2ć 2č 2đ 2š 2ž 1j. 0z1b 2d 2g 32nj 2l 2m 2n 2r 32j 2s 2v2l 0ć1b 2c 2d 3ž 2f 2g 2h 2j 2k 2m 2n 3j 2p 2s 32t 2t 2z 2ć 2č 2đ 2š 2ž 0č1b 2c 2d 3ž 2f 2g 2h 2k 2m 2n 3j 2p 2s 2t 2z 2ć 2č 2đ 2š 2ž 0đ1b 2c 2d 3ž 2f 2g 2h 2k 2m 2n 3j 2p 2s 2t 2z 2ć 2č 2đ 2š 2ž 0š1c 2l 2n 2ć 2č 0ž1b 2j 2lj 2n";

const exceptions = "";

/** `hyphenate` function for Croatian (leftmin 2, rightmin 2),
 * for the `hyphenate` option of justify(). Compiles lazily on first use. */
export const hyphenateHr: (word: string) => string[] = createHyphenator({
  packed,
  exceptions,
  leftmin: 2,
  rightmin: 2,
});
