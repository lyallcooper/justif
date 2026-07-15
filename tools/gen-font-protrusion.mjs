/**
 * Generate per-font protrusion tables from microtype's own hand-tuned
 * config sources (the docstrip-guarded cfg-t module in microtype.dtx).
 * For each supported font the effective TU/T1 chain is: the font's
 * `-default` list, then its `-T1` list (which the package loads on top),
 * plus EB Garamond's lining-figures list. Values are thousandths of the
 * glyph advance — justif's native unit.
 *
 * Usage: node tools/gen-font-protrusion.mjs [path-to-microtype.dtx]
 * (downloads from CTAN when no path is given; prints a TS fragment)
 */
import { readFileSync } from "node:fs";

const FONTS = ["ebg", "ppl", "ptm", "bch", "pmn", "ugm"];

// TeX command / slot → character. Lines whose tokens aren't mapped are
// skipped (encoding-specific slots, accent commands).
const NAME_MAP = {
  "\\AE": "Æ", "\\OE": "Œ", "\\%": "%", "\\#": "#", "{,}": ",", "{=}": "=",
  "\\textendash": "–", "\\textemdash": "—",
  "\\textquoteleft": "‘", "\\textquoteright": "’",
  "\\textquotedblleft": "“", "\\textquotedblright": "”",
  "\\quotesinglbase": "‚", "\\quotedblbase": "„",
  "\\guilsinglleft": "‹", "\\guilsinglright": "›",
  "\\guillemotleft": "«", "\\guillemotright": "»",
  "\\textexclamdown": "¡", "\\textquestiondown": "¿",
  "\\textbraceleft": "{", "\\textbraceright": "}",
  "\\textless": "<", "\\textgreater": ">",
  "\\textbackslash": "\\", "\\textbar": "|", "\\textquotedbl": '"',
};

let src;
const arg = process.argv[2];
if (arg) src = readFileSync(arg, "latin1");
else {
  const res = await fetch("https://mirrors.ctan.org/macros/latex/contrib/microtype/microtype.dtx");
  src = Buffer.from(await res.arrayBuffer()).toString("latin1");
}

// Extract the cfg-t module.
const mod = src.match(/%<\*cfg-t>([\s\S]*?)%<\/cfg-t>/);
if (!mod) throw new Error("cfg-t module not found");
const lines = mod[1].split("\n");

const guardMatches = (guard, font) =>
  guard.split("|").some((t) => (t.startsWith("!") ? t.slice(1) !== font : t === font));

// Split into \SetProtrusion blocks; track each block's name per font.
const blocks = [];
let current = null;
for (const raw of lines) {
  if (raw.includes("\\SetProtrusion")) {
    current = { names: {}, body: [] };
    blocks.push(current);
    continue;
  }
  if (current === null) continue;
  const m = raw.match(/^%<([^>]+)>(.*)$/);
  const guard = m ? m[1] : null;
  const content = m ? m[2] : raw;
  const nameM = content.match(/name\s*=\s*([\w-]+)/);
  if (nameM) {
    for (const f of FONTS) {
      if (guard === null || guardMatches(guard, f)) current.names[f] ??= nameM[1];
    }
    continue;
  }
  current.body.push({ guard, content });
}

function parseInto(table, block, font) {
  for (const { guard, content } of block.body) {
    if (guard !== null && !guardMatches(guard, font)) continue;
    // One or more `token = {l, r}` assignments per line.
    for (const m of content.matchAll(/([^\s=,{}]+|\{,\}|\{=\})\s*=\s*\{([^{}]*)\}/g)) {
      const token = m[1];
      if (token === "name" || token === "load" || token === "encoding" || token === "family") continue;
      const ch = NAME_MAP[token] ?? (/^[^\\%]$|^[^\\]$/.test(token) && token.length === 1 ? token : null);
      if (ch === null || ch === undefined) continue;
      const [l, r] = m[2].split(",").map((s) => parseInt(s.trim(), 10));
      const e = {};
      if (Number.isFinite(l) && l !== 0) e.l = l;
      if (Number.isFinite(r) && r !== 0) e.r = r;
      if (e.l !== undefined || e.r !== undefined) table[ch] = e;
      else delete table[ch];
    }
  }
}

const CHAINS = {
  ebg: ["EBGaramond-default", "EBGaramond-T1", "EBGaramond-T1-LF"],
  ppl: ["ppl-default", "ppl-T1"],
  ptm: ["ptm-default", "ptm-T1"],
  bch: ["bch-default", "bch-T1"],
  pmn: ["pmnj-default", "pmnj-T1"],
  ugm: ["ugm-default", "ugm-T1"],
};

const out = {};
for (const font of FONTS) {
  const table = {};
  for (const wanted of CHAINS[font]) {
    for (const block of blocks) {
      if (block.names[font] === wanted) parseInto(table, block, font);
    }
  }
  out[font] = table;
}

for (const [font, table] of Object.entries(out)) {
  const entries = Object.entries(table)
    .map(([ch, e]) => {
      const parts = [];
      if (e.l !== undefined) parts.push(`l: ${e.l}`);
      if (e.r !== undefined) parts.push(`r: ${e.r}`);
      return `  ${JSON.stringify(ch)}: { ${parts.join(", ")} },`;
    })
    .join("\n");
  console.log(`// ${font} (${Object.keys(table).length} chars)\n{\n${entries}\n}\n`);
}
