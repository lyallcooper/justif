/**
 * Rewrites destructuring out of the built dist so bundlers targeting
 * Safari 14-class environments never have to lower it themselves.
 *
 * Why: esbuild's compat data marks ALL destructuring as broken below
 * Safari 14.1 and REFUSES to transform it ("not supported yet") — and the
 * older esbuilds bundled in Vite 6 / Astro 5 (whose default build.target
 * includes `safari14`) shipped the broken transform instead, silently
 * corrupting the library in production builds: justif initialized cleanly
 * and managed zero paragraphs. Pre-lowering with Babel's (correct)
 * destructuring transform gives those pipelines nothing to touch.
 *
 * The esbuild verification pass below is the regression gate: every dist
 * file must transform cleanly at Vite 6's default target list.
 */
import { transformAsync } from "@babel/core";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform as esbuildTransform } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith(".js")) files.push(path);
  }
})(dist);

// Vite 6's default `build.target` ("modules"). `safari14` is the member
// whose esbuild feature flags matter here.
const VERIFY_TARGET = ["es2020", "edge88", "firefox78", "chrome87", "safari14"];

let lowered = 0;
for (const path of files) {
  const source = readFileSync(path, "utf8");
  const mapPath = path + ".map";
  const hasMap = existsSync(mapPath);
  const result = await transformAsync(source, {
    configFile: false,
    babelrc: false,
    compact: false,
    // `iterableIsArray` reads array patterns by index instead of via the
    // iterator protocol — every array pattern in this codebase destructures
    // a real array (Map entries, Object.entries pairs).
    assumptions: { iterableIsArray: true, objectRestNoSymbols: true, ignoreFunctionLength: true },
    plugins: [
      "@babel/plugin-transform-destructuring",
      "@babel/plugin-transform-parameters",
    ],
    inputSourceMap: hasMap ? JSON.parse(readFileSync(mapPath, "utf8")) : undefined,
    sourceMaps: hasMap,
  });
  if (result?.code == null) throw new Error(`lower-dist: Babel produced no output for ${path}`);
  if (result.code !== source) {
    writeFileSync(path, result.code);
    if (hasMap && result.map) writeFileSync(mapPath, JSON.stringify(result.map));
    lowered++;
  }

  // Gate: the file must now pass the exact transform Vite 6 defaults run.
  try {
    await esbuildTransform(result.code, { target: VERIFY_TARGET, format: "esm", loader: "js" });
  } catch (error) {
    throw new Error(`lower-dist: ${path} still fails Vite-default lowering:\n${error}`);
  }
}

console.log(`dist lowered for ${VERIFY_TARGET.join(",")} (${lowered}/${files.length} files rewritten)`);
