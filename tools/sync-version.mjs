/**
 * Synchronizes release-specific values in README CDN script examples.
 *
 * This runs from the npm `version` lifecycle hook, after a fresh build, so an
 * `npm version` commit contains both the new CDN pin and the SRI hash of the
 * exact file that will be published.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function synchronizeReadme(readme, version, readAsset) {
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
      .update(readAsset(assetPath))
      .digest("base64")}`;
    scriptCount += 1;

    tag = setAttribute(tag, "crossorigin", "anonymous");
    return setAttribute(tag, "integrity", integrity);
  });

  if (scriptCount === 0) {
    throw new Error("No jsDelivr <script> snippets found in README.md");
  }
  return { updated, scriptCount };
}

function main() {
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    throw new Error("Usage: node tools/sync-version.mjs [--check]");
  }

  const check = process.argv.includes("--check");
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const readme = readFileSync("README.md", "utf8");
  const { updated, scriptCount } = synchronizeReadme(
    readme,
    version,
    readFileSync,
  );

  if (check && updated !== readme) {
    throw new Error(
      "README.md release pin or SRI is stale; run node tools/sync-version.mjs",
    );
  }
  if (!check && updated !== readme) {
    writeFileSync("README.md", updated);
  }
  console.log(
    `README CDN pins → justif@${version}; verified SRI for ${scriptCount} script(s)`,
  );
}

function setAttribute(tag, name, value) {
  const existing = new RegExp(`(\\s${name}=)(?:"[^"]*"|'[^']*')`);
  if (existing.test(tag)) return tag.replace(existing, `$1"${value}"`);

  const srcLine = tag.match(/\n([ \t]*)src="[^"]*"/);
  if (srcLine) {
    return tag.replace(srcLine[0], `${srcLine[0]}\n${srcLine[1]}${name}="${value}"`);
  }
  return tag.replace(/>$/, ` ${name}="${value}">`);
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
