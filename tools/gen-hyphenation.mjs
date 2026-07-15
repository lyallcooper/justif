/**
 * Generates src/hyphenation/<lang>.ts modules from CTAN's hyph-utf8
 * pattern collection (fetched from the hyphenation/tex-hyphen repo).
 *
 * Each generated module carries the source file's own license header —
 * pattern data is NOT relicensed under this package's MIT; it ships under
 * its original terms (all bundled languages use permissive licenses).
 * Languages whose header declares a copyleft-only license are refused.
 *
 * Usage: node tools/gen-hyphenation.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";

const BASE =
  "https://raw.githubusercontent.com/hyphenation/tex-hyphen/master/hyph-utf8/tex/generic/hyph-utf8/patterns/tex/";

/** Bundled languages: web-relevant, permissively licensed. */
const LANGS = [
  { id: "ca", file: "hyph-ca", name: "Catalan" },
  { id: "cs", file: "hyph-cs", name: "Czech" },
  { id: "da", file: "hyph-da", name: "Danish" },
  { id: "de", file: "hyph-de-1996", name: "German (reformed orthography)" },
  { id: "el", file: "hyph-el-monoton", name: "Greek (monotonic)" },
  { id: "en-gb", file: "hyph-en-gb", name: "British English" },
  { id: "es", file: "hyph-es", name: "Spanish" },
  { id: "fi", file: "hyph-fi", name: "Finnish" },
  { id: "fr", file: "hyph-fr", name: "French" },
  { id: "hr", file: "hyph-hr", name: "Croatian" },
  { id: "hu", file: "hyph-hu", name: "Hungarian" },
  { id: "it", file: "hyph-it", name: "Italian" },
  { id: "nb", file: "hyph-nb", name: "Norwegian Bokmål" },
  { id: "nl", file: "hyph-nl", name: "Dutch" },
  { id: "nn", file: "hyph-nn", name: "Norwegian Nynorsk" },
  { id: "pl", file: "hyph-pl", name: "Polish" },
  { id: "pt", file: "hyph-pt", name: "Portuguese" },
  { id: "ro", file: "hyph-ro", name: "Romanian" },
  { id: "ru", file: "hyph-ru", name: "Russian" },
  { id: "sk", file: "hyph-sk", name: "Slovak" },
  { id: "sl", file: "hyph-sl", name: "Slovenian" },
  { id: "sv", file: "hyph-sv", name: "Swedish" },
  { id: "tr", file: "hyph-tr", name: "Turkish" },
  { id: "uk", file: "hyph-uk", name: "Ukrainian" },
];

/** Licenses we can redistribute inside an MIT package (with the original
 * notice preserved). Dual licenses qualify if ANY grant is on this list. */
const PERMISSIVE = /\b(mit|bsd|mpl|lppl|apache|public.?domain|unlimited|wtfpl|cc0|isc|x11)\b/i;

const fetchText = async (name) => {
  const res = await fetch(BASE + name + ".tex");
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.text();
};

/** The header is YAML-ish inside % comments; return its plain text. */
const headerOf = (tex) => {
  const lines = [];
  for (const line of tex.split("\n")) {
    if (!line.startsWith("%")) break;
    lines.push(line.replace(/^%\s?/, ""));
  }
  return lines.join("\n");
};

const braceBlock = (tex, command) => {
  const start = tex.indexOf(command + "{");
  if (start === -1) return null;
  let i = start + command.length + 1;
  let depth = 1;
  let out = "";
  for (; i < tex.length && depth > 0; i++) {
    const ch = tex[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth > 0) out += ch;
  }
  return out;
};

const stripComments = (s) =>
  s
    .split("\n")
    .map((l) => l.split("%")[0])
    .join("\n");

const camel = (id) =>
  id
    .split("-")
    .map((part) => part[0].toUpperCase() + (part === "gb" || part === "us" ? part.slice(1).toUpperCase() : part.slice(1)))
    .join("");

await mkdir("src/hyphenation", { recursive: true });
const generated = [];
/** Languages that delegate to a shared patterns file (nb/nn -> hyph-no)
 * become re-exports of the first module generated from that file. */
const bySource = new Map();
for (const lang of LANGS) {
  let tex = await fetchText(lang.file);
  // Some files delegate to a shared one (e.g. hyph-nb -> hyph-no).
  const inputRef = /\\input\s+(hyph-[a-z-]+)\.tex/.exec(tex);
  let header = headerOf(tex);
  const sourceKey = inputRef === null ? lang.file : inputRef[1];
  const shared = bySource.get(sourceKey);
  if (shared !== undefined) {
    const src = `/**
 * ${lang.name} hyphenation patterns — identical data to ${shared.name}
 * (both are generated from CTAN hyph-utf8's ${sourceKey}.tex); this module
 * re-exports it under the ${lang.id} name. See ${shared.id}.ts for the
 * pattern data and its license.
 */
export { hyphenate${camel(shared.id)} as hyphenate${camel(lang.id)} } from "./${shared.id}.js";
`;
    await writeFile(`src/hyphenation/${lang.id}.ts`, src);
    generated.push({ ...lang, sharedWith: shared.id });
    console.log(`${lang.id}: re-export of ${shared.id} (${sourceKey}.tex)`);
    continue;
  }
  if (inputRef !== null) {
    tex = await fetchText(inputRef[1]);
    header += "\n\n(patterns shared via " + inputRef[1] + ".tex:)\n\n" + headerOf(tex);
  }

  // The licence: block runs until the next top-level header key. Files can
  // be multi-licensed ("available under any of these licences") — we may
  // redistribute under ANY listed grant, so test all of them, plus the
  // free-text all-permissive grants some files use.
  const licBlock =
    /licen[cs]e:\s*\n((?:[ \t-].*\n?)*)/i.exec(header)?.[1] ?? "";
  const names = [...licBlock.matchAll(/name:\s*([^\n]+)/g)].map((m) => m[1].trim());
  const licence = names.join(" / ") || licBlock.trim().split("\n")[0] || "unstated";
  const allPermissive =
    names.some((n) => PERMISSIVE.test(n)) ||
    /freely distributed|permitted in any medium|public domain|unlimited copying/i.test(licBlock);
  if (!allPermissive) {
    console.log(`SKIP ${lang.id}: licence "${licence}" not on the permissive list`);
    continue;
  }
  const minsBlock = /typesetting:\s*\n\s*left:\s*(\d+)\s*\n\s*right:\s*(\d+)/.exec(header);
  if (minsBlock === null) throw new Error(`${lang.id}: no typesetting hyphenmins in header`);
  const [leftmin, rightmin] = [Number(minsBlock[1]), Number(minsBlock[2])];
  const version = /version:\s*([^\n]+)/.exec(header)?.[1]?.trim() ?? "unknown";

  const patterns = stripComments(braceBlock(tex, "\\patterns") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (patterns.length < 50) throw new Error(`${lang.id}: only ${patterns.length} patterns`);
  const exceptionsRaw = braceBlock(tex, "\\hyphenation");
  const exceptions =
    exceptionsRaw === null ? [] : stripComments(exceptionsRaw).split(/\s+/).filter(Boolean);

  const doc = header
    .split("\n")
    .map((l) => " * " + l)
    .join("\n");
  const src = `/**
 * ${lang.name} hyphenation patterns, generated from CTAN hyph-utf8
 * (${lang.file}.tex, version ${version}) by tools/gen-hyphenation.mjs.
 * DO NOT EDIT — regenerate instead.
 *
 * The pattern data below is NOT covered by this package's MIT license;
 * it is redistributed under its original terms, reproduced here:
 *
${doc}
 */
import { createHyphenator } from "./liang.js";

const patterns =
  ${JSON.stringify(patterns.join(" "))};

const exceptions = ${JSON.stringify(exceptions.join(" "))};

/** \`hyphenate\` function for ${lang.name} (leftmin ${leftmin}, rightmin ${rightmin}),
 * for the \`hyphenate\` option of justify(). Compiles lazily on first use. */
export const hyphenate${camel(lang.id)}: (word: string) => string[] = createHyphenator({
  patterns,
  exceptions,
  leftmin: ${leftmin},
  rightmin: ${rightmin},
});
`;
  await writeFile(`src/hyphenation/${lang.id}.ts`, src);
  bySource.set(sourceKey, lang);
  generated.push({ ...lang, leftmin, rightmin, patterns: patterns.length, exceptions: exceptions.length, licence, kb: Math.round(src.length / 1024) });
  console.log(
    `${lang.id}: ${patterns.length} patterns, ${exceptions.length} exceptions, mins ${leftmin}/${rightmin}, ${licence}, ${Math.round(src.length / 1024)} KB`,
  );
}
console.log(`\n${generated.length}/${LANGS.length} generated`);
