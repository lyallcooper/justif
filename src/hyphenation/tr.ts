/**
 * Turkish hyphenation patterns, generated from CTAN hyph-utf8
 * (hyph-tr.tex, version 1) by tools/gen-hyphenation.mjs.
 * DO NOT EDIT — regenerate instead.
 *
 * The pattern data below is NOT covered by this package's MIT license;
 * it is redistributed under its original terms, reproduced here:
 *
 * title: Hyphenation patterns for Turkish
 * copyright: Copyright (C) 1987 Pierre A. MacKay, 2008, 2011 TUG
 * notice: This file is part of the hyph-utf8 package.
 *     See http://www.hyphenation.org/tex for more information.
 * language:
 *     name: Turkish
 *     tag: tr
 * authors:
 *     -
 *         name: Pierre A. MacKay
 *     -
 *         name: H. Turgut Uyar
 *         contact: uyar (at) itu.edu.tr
 *     -
 *         name: S. Ekin Kocabas
 *         contact: kocabas (at) stanford.edu
 *     -
 *         name: Mojca Miklavec
 * licence:
 *     name: LPPL
 *     version: 1
 *     or_later: true
 *     url: https://latex-project.org/lppl/lppl-1-0.html
 * hyphenmins:
 *     typesetting:
 *         left: 2
 *         right: 2
 * changes:
 *     - 2008-06-25/27/28 - create this file by adapting Ottoman rules for modern Turkish
 *     - 2011-08-10 - add LPPL licence with permission of Pierre A. MacKay
 * texlive:
 *     encoding: ec
 *     babelname: turkish
 *     legacy_patterns: tkhyph.tex
 *     message: Turkish hyphenation patterns
 *     description: |-
 *         Hyphenation patterns for Turkish in T1/EC and UTF-8 encodings.
 *         Auto-generated from a script included in the distribution.
 *         The patterns for Turkish were first produced for the Ottoman Texts
 *         Project in 1987 and were suitable for both Modern Turkish and Ottoman
 *         Turkish in Latin script, however the required character set didn't fit
 *         into EC encoding, so support for Ottoman Turkish had to be dropped to
 *         keep compatibility with 8-bit engines.
 * ==========================================
 * This file is auto-generated from
 * source/generic/hyph-utf8/languages/tr/generate_patterns_tr.rb
 * that is part of hyph-utf8.
 * Please don't modify this file; modify the generating script instead.
 * 
 * Credits:
 * - algorithm developed by P. A. MacKay for the Ottoman Texts Project in 1987
 * - rules adapted for modern Turkish by H. Turgut Uyar <uyar at itu.edu.tr>
 * - initiative to improve Turkish patterns by S. Ekin Kocabas <kocabas at stanford.edu>
 * - script written by Mojca Miklavec <mojca.miklavec.lists at gmail.com> in June 2008
 * 
 * See also:
 * - http://mirror.ctan.org/language/turkish/hyphen/turk_hyf.c
 * - http://www.tug.org/TUGboat/Articles/tb09-1/tb20mackay.pdf
 * 
 * Differences with Ottoman patterns:
 * - adapted for the use on modern TeX engines, using UTF-8 charactes
 * - only letters for Modern Turkish + âîû (the first one often needed, the other two don't hurt)
 * - (if needed, support for Ottoman Turkish might be provided separately under language code 'ota')
 * 
 */
import { createHyphenator } from "./liang.js";

/** The patterns, sorted and front-coded; see `packed` in liang.ts. */
const packed =
  "01b1 1c1 1d1 1f1 1g1 1h1 1j1 1k1 1l1 1m1 1n1 1p1 1r1 1s1 1t1 1v1 1y1 1z1 1ç1 1ğ1 1ş1 02a1 1bb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1cb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1db 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1e1 22cek. 1fb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1gb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1hb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1i1 1jb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1kb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1lb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1mb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1nb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1o1 1pb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1rb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1sb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1tb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1u1 1vb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1yb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1zb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1â1 1çb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1î1 1ö1 1û1 1ü1 1ğb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 1ı1 1şb 2c 2d 2f 2g 2h 2j 2k 2l 2m 2n 2p 2r 2s 2t 2v 2y 2z 2ç 2ğ 2ş 0a3a2 2e2 2i2 2o2 2u2 2â2 2î2 2ö2 2û2 2ü2 2ı2 0e3a2 2e2 2i2 2o2 2u2 2â2 2î2 2ö2 2û2 2ü2 2ı2 0i3a2 2e2 2i2 2o2 2u2 2â2 2î2 2ö2 2û2 2ü2 2ı2 0m1t4rak 0o3a2 2e2 2i2 2o2 2u2 2â2 2î2 2ö2 2û2 2ü2 2ı2 0tu4r4k 0u3a2 2e2 2i2 2o2 2u2 2â2 2î2 2ö2 2û2 2ü2 2ı2 0â3a2 2e2 2i2 2o2 2u2 2â2 2î2 2ö2 2û2 2ü2 2ı2 0î3a2 2e2 2i2 2o2 2u2 2â2 2î2 2ö2 2û2 2ü2 2ı2 0ö3a2 2e2 2i2 2o2 2u2 2â2 2î2 2ö2 2û2 2ü2 2ı2 0û3a2 2e2 2i2 2o2 2u2 2â2 2î2 2ö2 2û2 2ü2 2ı2 0ü3a2 2e2 2i2 2o2 2u2 2â2 2î2 2ö2 2û2 2ü2 2ı2 0ı3a2 2e2 2i2 2o2 2u2 2â2 2î2 2ö2 2û2 2ü2 2ı2";

const exceptions = "";

/** `hyphenate` function for Turkish (leftmin 2, rightmin 2),
 * for the `hyphenate` option of justify(). Compiles lazily on first use. */
export const hyphenateTr: (word: string) => string[] = createHyphenator({
  packed,
  exceptions,
  leftmin: 2,
  rightmin: 2,
});
