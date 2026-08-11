# Demo fonts

The demo serves its fonts from this directory so it has no runtime dependency
on a third-party font host. Every WOFF2 here is generated:

    npm run fonts          # rebuild from the pinned upstream sources
    npm run check:fonts    # verify the installed files match the manifest

`tools/fonts/build.py` holds the manifest — one entry per family, recording
where the font comes from, which version is pinned, which OpenType features
are kept and how far the character set is cut down. It also refuses to build a
source whose version has moved, so an upstream release is a deliberate change
here rather than a silent one.

Filenames carry the upstream version, both because `/fonts/*` is served
`immutable` with a one-year lifetime (a replaced file must be a new URL) and
because it makes the directory listing the answer to "are we current?".

Two things the manifest exists to remember:

- **Do not vendor what fonts.googleapis.com serves.** Those WOFF2 files are
  subset with a fixed feature allowlist that drops `smcp`, which is why the
  demo spent a while faking small caps in EB Garamond and pulling Alegreya's
  out of a separate `SC` family. The full fonts in the google/fonts repository
  have real small caps in both.
- **Newest is not always the designer's repository.** Google Fonts currently
  ships later builds of Alegreya and EB Garamond than those projects have
  tagged, and matches upstream for Courier Prime.

Small caps, after that: Junicode, Coelacanth, EB Garamond, Alegreya, Source
Serif 4 and Roboto Slab use their own `smcp`, so small caps follow the
surrounding weight and slope. IM Fell English and Latin Modern draw caps as a
separate design with no `smcp` to reach it, so they keep a companion family.
Source Serif's italic has no small caps in any build, and Newsreader, Roboto
Flex, Inter, Iosevka, Courier Prime and IBM Plex Mono have none at all — those
synthesise.

Figures are left to each face's own default, which for Junicode, Coelacanth,
Alegreya and Roboto Slab means oldstyle. EB Garamond is the one exception: its
default set is tabular lining, spaced for columns of numbers rather than for
prose, so the demo asks it for proportional oldstyle and the manifest keeps
both `onum` and `pnum` — `onum` alone reaches only the tabular oldstyle set.
Latin Modern and IBM Plex Mono keep their lining defaults, the first because it
stands in for TeX and the second because it sets code.

The corresponding font licenses are included in this directory. Everything here
is OFL except Roboto Slab, which is Apache 2.0. The variable TTFs kept beside
the WOFF2 files are the build sources for Junicode, and are excluded from the
deployed demo.
