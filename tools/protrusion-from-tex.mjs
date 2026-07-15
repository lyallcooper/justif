/**
 * Dump microtype's EFFECTIVE protrusion registers for a font by asking TeX
 * directly: after microtype configures a font, per-character protrusion
 * lives in \lpcode/\rpcode. Compiles via texlive.net (no local TeX) and
 * parses the log.
 *
 * UNIT WARNING: since pdfTeX 0.14h these registers hold thousandths of an
 * EM (microtype converts its config values — which are thousandths of the
 * glyph's own advance, justif's unit — at font load). Do NOT diff them
 * against latinProtrusion directly; divide by each glyph's advance/em
 * first. justif's table was instead taken from the microtype package
 * source (the `default` + `T1-default` lists in microtype.dtx), which is
 * already in advance units; this dump remains useful as an end-to-end
 * cross-check of what a live LuaLaTeX run actually applies.
 *
 * Usage: node tools/protrusion-from-tex.mjs
 */

const CHARS = [];
for (let c = 0x21; c <= 0x7e; c++) CHARS.push(c); // printable ASCII
for (const c of "‘’‚“”„–—‐…«»¡¿") CHARS.push(c.codePointAt(0));

const dumps = CHARS.map(
  (c) => `\\typeout{PROT ${c} = \\the\\lpcode\\font ${c} : \\the\\rpcode\\font ${c} }`,
).join("\n");

const TEX = `\\documentclass{article}
\\usepackage{fontspec}
\\setmainfont{Junicode}
\\usepackage[stretch=20,shrink=20,step=5]{microtype}
\\begin{document}
x% ensure the font is loaded and microtype has applied its setup
${dumps}
\\end{document}
`;

console.log("compiling protrusion dump via texlive.net…");
const form = new FormData();
form.append("filecontents[]", TEX);
form.append("filename[]", "document.tex");
form.append("engine", "lualatex");
form.append("return", "log");
const res = await fetch("https://texlive.net/cgi-bin/latexcgi", {
  method: "POST",
  body: form,
});
const log = await res.text();

const table = {};
for (const m of log.matchAll(/PROT (\d+) = (-?\d+)\s*:\s*(-?\d+)/g)) {
  const ch = String.fromCodePoint(Number(m[1]));
  const l = Number(m[2]);
  const r = Number(m[3]);
  if (l !== 0 || r !== 0) table[ch] = { ...(l !== 0 && { l }), ...(r !== 0 && { r }) };
}

if (Object.keys(table).length === 0) {
  console.error("no protrusion codes found — log tail:\n" + log.slice(-1500));
  process.exit(1);
}

console.log(
  `\nmicrotype's effective protrusion registers for Junicode ` +
    `(${Object.keys(table).length} chars, thousandths of 1em — see unit warning):`,
);
console.log(JSON.stringify(table, null, 1));
