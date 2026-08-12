#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools>=4.53", "brotli>=1.1", "skia-pathops>=0.8"]
# ///
"""Build the demo's WOFF2 files from pinned upstream font sources.

Every face the demo serves is produced here, so `demo/fonts` has recorded
provenance instead of downloads of unknown age. Run with no arguments to
rebuild, or with --check to verify the installed files still match this
manifest (version string, requested OpenType features, character coverage).

Two rules the manifest encodes, both learned the hard way:

Prefer whichever build of a family is newest, which is not always the
designer's own repository — Google Fonts ships newer builds of Alegreya, EB
Garamond, Vollkorn and Courier Prime than their upstream repos have tagged.
What is never safe is the WOFF2 that fonts.googleapis.com *serves*: those are
subset with a fixed feature allowlist that drops `smcp`, so small caps in
Alegreya, EB Garamond and Vollkorn silently disappear. Always start from the
full font, which for those families lives in the google/fonts repository.

Subset to the characters the demo actually renders. `latin` mirrors the range
Google Fonts calls "latin"; `demo` is tighter, for faces where a smaller file
matters more than coverage of text no sample contains — above all Junicode,
which is preloaded and gates the first paint.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

try:
    from fontTools import subset
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
except ModuleNotFoundError as error:
    raise SystemExit(
        f"{error}\nThis script expects to be run by uv: uv run tools/fonts/build.py"
    )

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "demo" / "fonts"

# Every character any demo sample, control or label sets in an article face,
# plus the ASCII range in full. Latin text in the samples stays inside this;
# the Hebrew, Arabic and Japanese samples are deliberately left to fall back
# to a system face, as no font in the picker covers them.
DEMO = (
    list(range(0x20, 0x7F))
    + [0xA0, 0xAB, 0xB7, 0xBB, 0xD7, 0xF9, 0x14D, 0x3C3]
    + [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x202F]
    + [0x2192, 0x2212, 0x2264, 0x2265, 0x2767]
)

# The unicode-range Google Fonts publishes for its "latin" subset.
LATIN = sorted(
    set(range(0x00, 0x100))
    | {0x131, 0x152, 0x153, 0x2BB, 0x2BC, 0x2C6, 0x2DA, 0x2DC, 0x304, 0x308, 0x329}
    | set(range(0x2000, 0x2070))
    | {0x20AC, 0x2122, 0x2191, 0x2193, 0x2212, 0x2215, 0xFEFF, 0xFFFD}
    | set(DEMO)
)

# The one letter the specimen sample's drop cap sets. Goudy Initialen's
# floriated glyphs run ~10 KB each, so the face carries exactly the initial
# the demo renders; a new opening word means extending this set.
INITIALS = [ord("T")]

SETS = {"demo": sorted(set(DEMO)), "latin": LATIN, "initials": INITIALS}

# Junicode's figures are oldstyle by default, so the drawer's numeric readouts
# need `lnum` and `tnum` kept to stay lining and tabular. Latin Modern is the
# TeX comparison face and keeps the figure styles TeX itself offers.
JUNICODE_FEATURES = ("smcp", "c2sc", "onum", "lnum", "pnum", "tnum")
LATIN_MODERN_FEATURES = ("onum", "lnum", "pnum", "tnum", "zero", "aalt", "dlig")

GF = "https://raw.githubusercontent.com/google/fonts/main/ofl/"
# Roboto Slab is Apache-licensed and so lives outside google/fonts' ofl tree.
GF_APACHE = "https://raw.githubusercontent.com/google/fonts/main/apache/"
CTAN = "https://mirror.ctan.org/fonts/lm/fonts/opentype/public/lm/"
IOSEVKA = ("https://github.com/be5invis/Iosevka/releases/download/v34.8.0/"
           "PkgWebFont-Iosevka-34.8.0.zip")


@dataclass(frozen=True)
class Face:
    """One output file: where it comes from and how it is cut down."""

    out: str
    src: str
    member: str | None = None  # path inside a .zip/.tgz source
    charset: str = "latin"
    features: tuple[str, ...] = ()
    # Variation axes to keep. Any other axis is pinned at its default and
    # dropped, which is worth doing when the extra deltas are large and the
    # demo has no control for them. Empty keeps every axis.
    axes: tuple[str, ...] = ()
    # Rewrite each glyph as an overlap-free outline. For sources whose
    # contours self-intersect with mixed windings (amateur digitizations),
    # rasterizers disagree about the fill itself — Safari knocked Goudy
    # Initialen's interiors out into line-work while Chrome filled them —
    # and every internal seam picks up double-coverage antialiasing.
    remove_overlaps: bool = False


@dataclass(frozen=True)
class Family:
    name: str
    version: str  # the upstream version string, as the font reports it
    provenance: str
    faces: tuple[Face, ...] = field(default_factory=tuple)


MANIFEST: tuple[Family, ...] = (
    Family(
        "Junicode",
        "2.230",
        "Variable TTFs vendored beside this manifest, newer than upstream's "
        "latest release (2.226). Sets the page UI as well as the article.",
        (
            Face("Junicode-Roman-2.230.woff2", "local:Junicode-Roman.ttf", charset="demo",
                 features=JUNICODE_FEATURES),
            Face("Junicode-Italic-2.230.woff2", "local:Junicode-Italic.ttf", charset="demo",
                 features=JUNICODE_FEATURES),
        ),
    ),
    Family(
        "Coelacanth",
        "0.007",
        "Fuzzypeg/Coelacanth release 0.9.0, text-size instances (the fonts "
        "themselves still report 0.007).",
        (
            Face("Coelacanth-Roman-0.9.0.woff2",
                 "https://github.com/Fuzzypeg/Coelacanth/raw/0.9.0/interpolatedFonts/Coelacanth.otf",
                 charset="demo", features=("smcp", "c2sc")),
            Face("Coelacanth-Italic-0.9.0.woff2",
                 "https://github.com/Fuzzypeg/Coelacanth/raw/0.9.0/interpolatedFonts/CoelacanthIt.otf",
                 charset="demo", features=("smcp", "c2sc")),
            Face("Coelacanth-Bold-0.9.0.woff2",
                 "https://github.com/Fuzzypeg/Coelacanth/raw/0.9.0/interpolatedFonts/CoelacanthBold.otf",
                 charset="demo", features=("smcp", "c2sc")),
        ),
    ),
    Family(
        "EB Garamond",
        "1.003",
        "google/fonts, newer than octaviopardo/EBGaramond12 (1.002). The "
        "served web subset has no small caps; this build does. Its default "
        "figures are tabular lining, so `onum` and `pnum` are both kept: "
        "together they reach the proportional oldstyle set (zero -> zero.lf "
        "-> zero.osf) that running prose wants.",
        (
            Face("EBGaramond-Roman-1.003.woff2", GF + "ebgaramond/EBGaramond[wght].ttf",
                 features=("smcp", "c2sc", "onum", "pnum", "tnum")),
            Face("EBGaramond-Italic-1.003.woff2", GF + "ebgaramond/EBGaramond-Italic[wght].ttf",
                 features=("smcp", "c2sc", "onum", "pnum", "tnum")),
        ),
    ),
    Family(
        "Alegreya",
        "2.009",
        "google/fonts, newer than huertatipografica/Alegreya (2.008). Real "
        "smcp here replaces the separate Alegreya SC family. Its figures are "
        "oldstyle by default, so `lnum` is the one figure feature worth keeping "
        "— `pnum` only ever switches text already made tabular.",
        (
            Face("Alegreya-Roman-2.009.woff2", GF + "alegreya/Alegreya[wght].ttf",
                 features=("smcp", "c2sc", "lnum")),
            Face("Alegreya-Italic-2.009.woff2", GF + "alegreya/Alegreya-Italic[wght].ttf",
                 features=("smcp", "c2sc", "lnum")),
        ),
    ),
    Family(
        "Source Serif 4",
        "4.004",
        "google/fonts, matching adobe-fonts/source-serif. A transitional face "
        "next to the picker's old-style and modern ones, and the only one here "
        "with both an optical-size axis and real small caps.",
        (
            Face("SourceSerif4-Roman-4.004.woff2", GF + "sourceserif4/SourceSerif4[opsz,wght].ttf",
                 features=("smcp", "c2sc")),
            # Source Serif draws no italic small caps, as Vollkorn did not.
            Face("SourceSerif4-Italic-4.004.woff2",
                 GF + "sourceserif4/SourceSerif4-Italic[opsz,wght].ttf"),
        ),
    ),
    Family(
        "Newsreader",
        "1.003",
        "google/fonts, matching productiontype/newsreader. Has one figure "
        "design and no small caps, so its acronyms synthesise.",
        (
            Face("Newsreader-Roman-1.003.woff2", GF + "newsreader/Newsreader[opsz,wght].ttf",
                 features=("pnum", "tnum")),
            Face("Newsreader-Italic-1.003.woff2",
                 GF + "newsreader/Newsreader-Italic[opsz,wght].ttf",
                 features=("pnum", "tnum")),
        ),
    ),
    Family(
        "Roboto Slab",
        "2.002",
        "google/fonts, under Apache 2.0 rather than the OFL like everything "
        "else here. Ships no italic in any build, so italic text is slanted by "
        "the browser. Its default figures are oldstyle.",
        (
            Face("RobotoSlab-Roman-2.002.woff2", GF_APACHE + "robotoslab/RobotoSlab[wght].ttf",
                 features=("smcp", "c2sc", "lnum")),
        ),
    ),
    Family(
        "Iosevka",
        "34.8.0",
        "be5invis/Iosevka release 34.8.0, the default (narrow) monospace "
        "family from its prebuilt webfont package.",
        (
            Face("Iosevka-Regular-34.8.0.woff2", IOSEVKA, member="TTF/Iosevka-Regular.ttf"),
            Face("Iosevka-Italic-34.8.0.woff2", IOSEVKA, member="TTF/Iosevka-Italic.ttf"),
            Face("Iosevka-Bold-34.8.0.woff2", IOSEVKA, member="TTF/Iosevka-Bold.ttf"),
        ),
    ),
    Family(
        "IM Fell English",
        "3.00",
        "google/fonts, the only distribution. No build of IM Fell has smcp, "
        "so the demo keeps its companion small-caps family.",
        (
            Face("IMFellEnglish-Regular-3.00.woff2", GF + "imfellenglish/IMFeENrm28P.ttf"),
            Face("IMFellEnglish-Italic-3.00.woff2", GF + "imfellenglish/IMFeENit28P.ttf"),
            Face("IMFellEnglishSC-Regular-3.00.woff2", GF + "imfellenglishsc/IMFeENsc28P.ttf"),
        ),
    ),
    Family(
        "Latin Modern Roman",
        "2.004",
        "CTAN lm package 2.005, whose OpenType files still report 2.004. The "
        "Unicode outline continuation of Computer Modern, as used by TeX. Its "
        "small caps are a separate design, like TeX's own.",
        (
            Face("LatinModernRoman-Regular-2.004.woff2", CTAN + "lmroman10-regular.otf",
                 charset="demo", features=LATIN_MODERN_FEATURES),
            Face("LatinModernRoman-Italic-2.004.woff2", CTAN + "lmroman10-italic.otf",
                 charset="demo", features=LATIN_MODERN_FEATURES),
            Face("LatinModernRomanCaps-Regular-2.004.woff2", CTAN + "lmromancaps10-regular.otf",
                 charset="demo", features=LATIN_MODERN_FEATURES),
        ),
    ),
    Family(
        "Roboto Flex",
        "3.200",
        "google/fonts, matching googlefonts/roboto-flex release 3.200.",
        (
            Face(
                "RobotoFlex-Roman-3.200.woff2",
                GF + "robotoflex/RobotoFlex[GRAD,XOPQ,XTRA,YOPQ,YTAS,YTDE,YTFI,"
                "YTLC,YTUC,opsz,slnt,wdth,wght].ttf",
                features=("pnum",),
                # Its ten parametric axes and slnt carry ~330k of deltas that
                # no demo control reaches. Google Fonts drops them too.
                axes=("opsz", "wght", "wdth"),
            ),
        ),
    ),
    Family(
        "Inter",
        "4.001",
        "rsms/inter release 4.1, a newer build than google/fonts serves "
        "(both report 4.001; the git hashes differ).",
        (
            Face("Inter-Roman-4.1.woff2",
                 "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip",
                 member="InterVariable.ttf", features=("pnum", "tnum")),
            Face("Inter-Italic-4.1.woff2",
                 "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip",
                 member="InterVariable-Italic.ttf", features=("pnum", "tnum")),
        ),
    ),
    Family(
        "Courier Prime",
        "3.018",
        "quoteunquoteapps/CourierPrime, which google/fonts matches.",
        (
            Face("CourierPrime-Regular-3.018.woff2",
                 "https://raw.githubusercontent.com/quoteunquoteapps/CourierPrime/master/fonts/ttf/CourierPrime-Regular.ttf"),
            Face("CourierPrime-Italic-3.018.woff2",
                 "https://raw.githubusercontent.com/quoteunquoteapps/CourierPrime/master/fonts/ttf/CourierPrime-Italic.ttf"),
            Face("CourierPrime-Bold-3.018.woff2",
                 "https://raw.githubusercontent.com/quoteunquoteapps/CourierPrime/master/fonts/ttf/CourierPrime-Bold.ttf"),
        ),
    ),
    Family(
        "Goudy Initialen",
        "1.1",
        "Dieter Steffmann's 2000 digitization (Typographer Mediengestaltung) "
        "of the floriated initials Goudy drew for Lanston around 1905 "
        "(Goudy Initials No. 296), served as the foundry build by 1001fonts. "
        "Sets the specimen sample's drop cap.",
        (
            Face("GoudyInitialen-1.1.woff2",
                 "https://www.1001fonts.com/download/goudy-initialen.zip",
                 member="GoudyInitialen.ttf", charset="initials",
                 remove_overlaps=True),
        ),
    ),
    Family(
        "IBM Plex Mono",
        "1.000",
        "IBM's @ibm/plex-mono-variable package. Supersedes the static 2.3 "
        "faces google/fonts still serves; the variable build reports 1.000.",
        (
            Face("IBMPlexMonoVar-Roman-1.000.woff2",
                 "https://registry.npmjs.org/@ibm/plex-mono-variable/-/plex-mono-variable-1.0.0.tgz",
                 member="package/fonts/complete/ttf/IBM Plex Mono Var-Roman.ttf"),
            Face("IBMPlexMonoVar-Italic-1.000.woff2",
                 "https://registry.npmjs.org/@ibm/plex-mono-variable/-/plex-mono-variable-1.0.0.tgz",
                 member="package/fonts/complete/ttf/IBM Plex Mono Var-Italic.ttf"),
        ),
    ),
)


def cache_dir() -> Path:
    path = Path(os.environ.get("JUSTIF_FONT_CACHE", Path(tempfile.gettempdir()) / "justif-fonts"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def fetch(url: str) -> bytes:
    """Download once per run of the tool, then reuse from the cache dir."""
    if url.startswith("local:"):
        return (OUT_DIR / url[len("local:"):]).read_bytes()
    # A stable digest: hash() is randomized per interpreter run, which would
    # miss the cache on every invocation and strand one orphan copy per run.
    key = hashlib.sha256(url.encode()).hexdigest()[:16]
    cached = cache_dir() / (key + "-" + url.rsplit("/", 1)[-1][:60])
    if cached.exists():
        return cached.read_bytes()
    request = urllib.request.Request(url, headers={"User-Agent": "justif-font-build"})
    with urllib.request.urlopen(request, timeout=300) as response:
        data = response.read()
    cached.write_bytes(data)
    return data


def source_bytes(face: Face) -> bytes:
    data = fetch(face.src)
    if face.member is None:
        return data
    if face.src.endswith((".tgz", ".tar.gz")):
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            extracted = archive.extractfile(face.member)
            if extracted is None:
                raise KeyError(f"{face.member} not in {face.src}")
            return extracted.read()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return archive.read(face.member)


def version_of(font: TTFont) -> str:
    """The numeric part of nameID 5, e.g. "Version 2.009" -> "2.009"."""
    raw = (font["name"].getDebugName(5) or "").replace("Version", "").strip()
    return raw.split(";")[0].strip()


def drop_axes(data: bytes, keep: tuple[str, ...]) -> bytes:
    with TTFont(io.BytesIO(data), fontNumber=0) as font:
        pinned = {
            axis.axisTag: axis.defaultValue
            for axis in font["fvar"].axes
            if axis.axisTag not in keep
        }
        if not pinned:
            return data
        instancer.instantiateVariableFont(font, pinned, inplace=True, updateFontNames=False)
        buffer = io.BytesIO()
        font.save(buffer)
        return buffer.getvalue()


def build_face(family: Family, face: Face) -> str:
    data = source_bytes(face)
    if face.axes:
        data = drop_axes(data, face.axes)
    if face.remove_overlaps:
        from fontTools.ttLib.removeOverlaps import removeOverlaps

        with TTFont(io.BytesIO(data), fontNumber=0) as font:
            removeOverlaps(font)
            buffer = io.BytesIO()
            font.save(buffer)
            data = buffer.getvalue()
    with TTFont(io.BytesIO(data), fontNumber=0) as font:
        found = version_of(font)
        available = set(font.getBestCmap())
        tables = {tag for t in ("GSUB",) if t in font
                  for tag in {r.FeatureTag for r in font[t].table.FeatureList.FeatureRecord}}
    if found != family.version:
        raise SystemExit(
            f"{face.out}: source reports version {found}, manifest pins "
            f"{family.version}. Update the manifest deliberately, so the "
            f"filename and the demo's @font-face rules move with it."
        )
    for wanted in face.features:
        if wanted not in tables:
            raise SystemExit(f"{face.out}: source has no {wanted!r} feature to keep")

    codepoints = [c for c in SETS[face.charset] if c in available]
    source = cache_dir() / f"src-{face.out}.bin"
    source.write_bytes(data)
    args = [
        str(source),
        f"--output-file={OUT_DIR / face.out}",
        "--flavor=woff2",
        "--unicodes=" + ",".join(f"U+{c:04X}" for c in codepoints),
        # Keep the source's hinting: these are the same outlines Google Fonts
        # serves, and dropping it would change how they rasterise.
        "--no-subset-tables+=FFTM",
    ]
    if face.features:
        args.append("--layout-features+=" + ",".join(face.features))
    subset.main(args)
    source.unlink()
    return f"{(OUT_DIR / face.out).stat().st_size / 1024:.0f}k"


def verify(family: Family, face: Face) -> tuple[bool, str]:
    path = OUT_DIR / face.out
    if not path.exists():
        return False, "missing"
    with TTFont(path) as font:
        found = version_of(font)
        cmap = set(font.getBestCmap())
        present = {r.FeatureTag for r in font["GSUB"].table.FeatureList.FeatureRecord} \
            if "GSUB" in font else set()
    problems = []
    if found != family.version:
        problems.append(f"version {found} != {family.version}")
    missing_features = [f for f in face.features if f not in present]
    if missing_features:
        problems.append("no " + ",".join(missing_features))
    # A source may genuinely lack a character in the set; only flag a face that
    # has lost coverage it could have had.
    if not set(SETS[face.charset]) & cmap:
        problems.append("empty coverage")
    size = f"{path.stat().st_size / 1024:.0f}k"
    detail = f"{size:>5}  {len(cmap):>4} cps"
    if face.features:
        detail += "  " + ",".join(sorted(present & set(face.features)))
    return not problems, detail if not problems else f"{detail}  ** {'; '.join(problems)}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="verify the installed files instead of rebuilding")
    parser.add_argument("--family", action="append", default=None,
                        help="limit to one family name (repeatable)")
    args = parser.parse_args()

    families = [f for f in MANIFEST if args.family is None or f.name in args.family]
    if args.family and not families:
        raise SystemExit(f"no family matching {args.family}")

    expected = {face.out for family in MANIFEST for face in family.faces}
    ok = True
    for family in families:
        print(f"\n{family.name} {family.version}")
        for face in family.faces:
            if not args.check:
                size = build_face(family, face)
                print(f"  built {face.out:44} {size:>5}")
            good, detail = verify(family, face)
            ok = ok and good
            print(f"  {'ok  ' if good else 'FAIL'} {face.out:44} {detail}")

    if args.family is None:
        stray = sorted(p.name for p in OUT_DIR.glob("*.woff2") if p.name not in expected)
        if stray:
            print("\nNot in the manifest — delete these, or add them to it:")
            for name in stray:
                print(f"  {name}")
            ok = False

    print("\n" + ("all faces match the manifest" if ok else "manifest check failed"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
