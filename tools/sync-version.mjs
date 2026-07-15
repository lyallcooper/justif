/**
 * Rewrites version-pinned CDN URLs (…/npm/justif@X.Y.Z/…) in the README to
 * the current package.json version. Runs automatically from the npm
 * `version` lifecycle hook, so `npm version patch` can never leave the
 * README pointing at the previous release.
 */
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const readme = readFileSync("README.md", "utf8");
const updated = readme.replace(/\/npm\/justif@\d+\.\d+\.\d+(-[\w.]+)?\//g, `/npm/justif@${version}/`);
if (updated !== readme) {
  writeFileSync("README.md", updated);
  console.log(`README CDN pins → justif@${version}`);
}
