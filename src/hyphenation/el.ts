/**
 * Greek (monotonic) hyphenation patterns, generated from CTAN hyph-utf8
 * (hyph-el-monoton.tex, version 5.0) by tools/gen-hyphenation.mjs.
 * DO NOT EDIT — regenerate instead.
 *
 * The pattern data below is NOT covered by this package's MIT license;
 * it is redistributed under its original terms, reproduced here:
 *
 * title: Hyphenation patterns for Modern Greek, monotonic
 * copyright: Copyright (C) 2008-2011 Dimitrios Filippou
 * notice: This file is part of the hyph-utf8 package.
 *     See http://www.hyphenation.org/tex for more information.
 * language:
 *     name: Modern Greek, monotonic spelling
 *     tag: el-monoton
 * version: 5.0
 * authors:
 *   -
 *     name: Dimitrios Filippou
 *     contact: dimitrios.ap.filippou (at) gmail.com
 * licence:
 *     - This file is available under any of the following licences:
 *     -
 *         name: LPPL
 *         url: https://latex-project.org/lppl/
 *     -
 *         name: MIT
 *         url: https://opensource.org/licenses/MIT
 * hyphenmins:
 *     typesetting:
 *         left: 1
 *         right: 1
 * changes:
 *     - Created:       June 6, 2008
 *     - Last modified: Sept. 12, 2011
 * texlive:
 *     babelname: monogreek
 *     use_old_patterns_comment: Old patterns work in a different way, one-to-one conversion from UTF-8 is not possible.
 *     legacy_patterns: grmhyph5.tex
 *     message: Hyphenation patterns for uni-accent (monotonic) Modern Greek
 *     package: greek
 * ==========================================
 * This file was first created by mechanical translation from
 * GRMhyph5.tex via "elhyph-utf8 -m -c" (version 0.1 by Peter
 * Heslin -- p.j.heslin at durham dot ac dot uk). Some additions
 * were also made by hand.
 * 
 * Created by Dimitrios Filippou with some ideas borrowed from
 * Yannis Haralambous, Kostis Dryllerakis and Claudio Beccari.
 * Mojca Miklavec adapted it for the "hyph-utf8" package.
 * 
 * These hyphenation patterns are explained in "modern.pdf", which
 * can be found in the "elhyphen" or "hyphenation-greek" package.
 * 
 * Documentation in English can be found in: D. Filippou,
 * "Hyphenation patterns for Ancient and Modern Greek," in
 * "TeX, XML, and Digital Typography" (A. Syropoulos et al.,
 * eds.), Lecture Notes in Computer Science 3130, Springer-Verlag
 * Berlin-Heidelberg, 2004. ISBN 3-540-22801-2.
 * 
 */
import { createHyphenator } from "./liang.js";

/** The patterns, sorted and front-coded; see `packed` in liang.ts. */
const packed =
  "0.ή3 1ί3 1β4 1γ4 1δ4 1ζ4 1η3 1θ4 1ι3 1κ4 1λ4 1μ4 1ν4 1ξ4 1π4 1ρ4 1σ4 1τ4 1υ3 1φ4 1χ4 1ψ4 1ύ3 1ϲ4 1ή3 1ί3 1ύ3 04' 1ʼ 1β' 2. 21β 3ζ 3θ 3κ 3μ 3ν 3ξ 3π 3σ 3τ 3φ 3χ 3ψ 3ϲ 2ʼ 2ρ. 2᾿ 1γ' 2. 21β 3γ 3ζ 3θ 3κτ 3μ 3ξ 3π 3σ 3τ 3φ 3χ 3ψ 3ϲ 25κ2φ 3ξ2τ 2ʼ 2κ. 31μπ 4ντ 4τζ 5σ 5ϲ 3ς. 3σ. 3ϲ. 2λ. 2᾿ 1δ' 2. 21β 3γ 3δ 3ζ 3θ 3κ 3λ 3ξ 3π 3σ 3τ 3φ 3χ 3ψ 3ϲ 2ʼ 2᾿ 1ζ' 2. 21β 3γ 3δ 3ζ 3θ 3κ 3λ 3μ 3ν 3ξ 3π 3ρ 3σ 3τ 3φ 3χ 3ψ 3ϲ 2ʼ 2᾿ 1θ' 2. 21β 3γ 3δ 3ζ 3θ 3κ 3μ 3ξ 3π 3σ 3τ 3φ 3χ 3ψ 3ϲ 2ʼ 2᾿ 1κ' 2. 21β 3γ 3δ 3ζ 3θ 3κ 3μ 3ξ 3π 3σ 3φ 3χ 3ψ 3ϲ 2ʼ 2λ. 2σ. 2τ. 2᾿ 1λ' 2. 21β 3γ 3δ 3ζ 3θ 3κ 3λ 3μ 3ν 3ξ 3π 3ρ 3σ 3τ 3φ 3χ 3ψ 3ϲ 25κ2μ 2ʼ 2ς. 2σ. 2ϲ. 2᾿ 1μ' 2. 21β 3γ 3δ 3ζ 3θ 3κ 3λ 3μ 3ξ 3πτ 3ρ 3σ 3τ 3φ 3χ 3ψ 3ϲ 25ψ2τ 2ʼ 2π' 3. 31ντ 4τζ 5σ 5ϲ 3ʼ 3λ. 3ν. 3ρ. 3᾿ 2ς. 2σ. 2ϲ. 2᾿ 1ν' 2. 21β 3γ 3δ 3ζ 3θ 3κ 3λ 3μ 3ν 3ξ 3π 3ρ 3σ 3τζ 4σ 4ϲ 3φ 3χ 3ψ 3ϲ 25κ2φ 2ʼ 2ς. 2σ. 2τ' 3. 31μπ 3ς. 3σ. 3ϲ. 3᾿ 3’ 2ϲ. 2᾿ 1ξ' 2. 21β 3γ 3δ 3ζ 3θ 3κ 3λ 3μ 3ν 3π 3ρ 3σ 3τ 3φ 3χ 3ψ 3ϲ 2ʼ 2᾿ 1π' 2. 21β 3γ 3δ 3ζ 3θ 3κ 3μ 3ξ 3π 3σ 3φ 3χ 3ψ 3ϲ 2ʼ 2᾿ 1ρ' 2. 21β 3γ 3δ 3ζ 3θ 3κ 3λ 3μ 3ν 3ξ 3π 3ρ 3σ 3τ 3φ 3χ 3ψ 3ϲ 25γ2μ 3θ2μ 3κ2μ 3ξ2τ 3φ2ν 3χ2μ 2ʼ 2ς. 2σ. 2ϲ. 2᾿ 1ς. 1σ' 2. 21δ 3ζ 3ν 3ξ 3ρ 3σ 3ψ 2ʼ 2κ. 2τ. 2᾿ 1τ' 2. 21β 3γ 3δ 3θ 3κ 3ν 3ξ 3π 3τ 3φ 3χ 3ψ 2ʼ 2ζ' 3. 3ʼ 3᾿ 2λ. 2ρ. 2ς. 2σ' 3. 31γκ 4μπ 4ντ 3ʼ 3᾽ 2ϲ' 3. 31γκ 4μπ 4ντ 3ʼ 3᾿ 2᾿ 1φ' 2. 21β 3γ 3δ 3ζ 3κ 3μ 3ν 3ξ 3π 3σ 3φ 3χ 3ψ 3ϲ 2ʼ 2τ. 2᾿ 1χ' 2. 21β 3γ 3δ 3ζ 3κ 3μ 3ξ 3π 3σ 3φ 3χ 3ψ 3ϲ 2ʼ 2τ. 2᾿ 1ψ' 2. 21β 3γ 3δ 3ζ 3θ 3κ 3λ 3μ 3ν 3ξ 3π 3ρ 3σ 3τ 3φ 3χ 3ψ 3ϲ 2ʼ 2᾿ 1ϲ' 2. 21δ 3ζ 3ν 3ξ 3ρ 3ψ 3ϲ 2ʼ 2κ. 2τ. 2᾿ 1᾿ 06κς. 2ϲ. 0ΐ1 0ά1 12ι 2ϊ 13η. 2ι. 2υ 0έ1 12ι 2ϊ 13υ 0ή1 13υ 0ί1 0ΰ1 0α1 12ί 2η 2ι 2υ 2ϊ 2ϋ 2ύ 2ί 2ύ 0ε1 12ί 2ι 2υ 2ϊ 2ϋ 2ύ 2ί 2ύ 0η1 12ά 2έ 2α 2ε 2ο 2υ 2ω 2ό 2ύ 2ώ 2ά 2έ 2ό 2ύ 2ώ 0ι1 12ά 2έ 2α 2ε 2ο 2ω 2ό 2ώ 2ά 2έ 2ό 2ώ 0ο1 12ί 2ει 2η 2ι 2υ 2ϊ 2ύ 2ί 2ύ 13ϊ3ό 4ό 0σθ2μ 1τ2φ 0τζ2μ 0υ1 12ά 2ί 2α 2ι 2ο 2ω 2ό 2ώ 2ά 2ί 2ό 2ώ 0ω1 0ϊ1 0ϋ1 0ό1 12ι 2ϊ 13η. 2ι. 2υ 0ύ1 13ι 0ώ1 0ϲθ2μ 1τ2φ 0ά2ι 2ϊ 13η. 2ι. 2υ 0έ2ι 2ϊ 13υ 0ή3υ 0ό2ι 2ϊ 13η. 2ι. 2υ 0ύ3ι";

const exceptions = "";

/** `hyphenate` function for Greek (monotonic) (leftmin 1, rightmin 1),
 * for the `hyphenate` option of justify(). Compiles lazily on first use. */
export const hyphenateEl: (word: string) => string[] = createHyphenator({
  packed,
  exceptions,
  leftmin: 1,
  rightmin: 1,
});
