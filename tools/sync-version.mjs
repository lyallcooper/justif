/**
 * Synchronizes release-specific values in README CDN script examples.
 *
 * This runs from the npm `version` lifecycle hook, after a fresh build, so an
 * `npm version` commit contains both the new CDN pin and the SRI hash of the
 * exact file that will be published.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const readme = readFileSync("README.md", "utf8");
const versioned = readme.replace(
  /\/npm\/justif@\d+\.\d+\.\d+(-[\w.]+)?\//g,
  `/npm/justif@${version}/`,
);

let scriptCount = 0;
const updated = versioned.replace(/<script\b[^>]*>/g, (tag) => {
  const src = tag.match(
    /\bsrc="https:\/\/cdn\.jsdelivr\.net\/npm\/justif@[^/]+\/(dist\/[^"?#]+\.js)"/,
  );
  if (!src) return tag;

  const assetPath = src[1];
  if (assetPath.split("/").includes("..")) {
    throw new Error(`Unsafe README CDN asset path: ${assetPath}`);
  }

  const integrity = `sha384-${createHash("sha384")
    .update(readFileSync(assetPath))
    .digest("base64")}`;
  scriptCount += 1;

  tag = setAttribute(tag, "crossorigin", "anonymous");
  return setAttribute(tag, "integrity", integrity);
});

if (scriptCount === 0) {
  throw new Error("No jsDelivr <script> snippets found in README.md");
}

if (updated !== readme) {
  writeFileSync("README.md", updated);
}
console.log(
  `README CDN pins → justif@${version}; refreshed SRI for ${scriptCount} script(s)`,
);

function setAttribute(tag, name, value) {
  const existing = new RegExp(`(\\s${name}=)(?:"[^"]*"|'[^']*')`);
  if (existing.test(tag)) return tag.replace(existing, `$1"${value}"`);

  const srcLine = tag.match(/\n([ \t]*)src="[^"]*"/);
  if (srcLine) {
    return tag.replace(srcLine[0], `${srcLine[0]}\n${srcLine[1]}${name}="${value}"`);
  }
  return tag.replace(/>$/, ` ${name}="${value}">`);
}
