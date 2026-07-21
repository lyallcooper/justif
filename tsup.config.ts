import { defineConfig } from "tsup";

const shared = {
  format: ["esm"] as const,
  dts: true,
  target: "es2020" as const,
  treeshake: true,
};

export default defineConfig([
  {
    ...shared,
    entry: {
      index: "src/index.ts",
      core: "src/core.ts",
      "hyphenate/liang": "src/hyphenation/liang.ts",
    },
    sourcemap: true,
    clean: true,
  },
  {
    // The drop-in script: fully self-contained (own config block, single
    // entry, so nothing chunk-splits — one file works from any CDN/static
    // host with zero companion requests). tools/lower-dist.mjs minifies this
    // bundle after its compatibility transforms have run.
    ...shared,
    entry: { auto: "src/auto.ts" },
    sourcemap: false,
    clean: false,
  },
  {
    // Language pattern modules: generated data (tools/gen-hyphenation.mjs)
    // — sourcemaps would double the package size for nothing.
    ...shared,
    entry: {
      "hyphenate/ca": "src/hyphenation/ca.ts",
      "hyphenate/da": "src/hyphenation/da.ts",
      "hyphenate/de": "src/hyphenation/de.ts",
      "hyphenate/el": "src/hyphenation/el.ts",
      "hyphenate/en-gb": "src/hyphenation/en-gb.ts",
      "hyphenate/en-us": "src/hyphenation/en-us.ts",
      "hyphenate/es": "src/hyphenation/es.ts",
      "hyphenate/fi": "src/hyphenation/fi.ts",
      "hyphenate/fr": "src/hyphenation/fr.ts",
      "hyphenate/hr": "src/hyphenation/hr.ts",
      "hyphenate/hu": "src/hyphenation/hu.ts",
      "hyphenate/it": "src/hyphenation/it.ts",
      "hyphenate/nb": "src/hyphenation/nb.ts",
      "hyphenate/nl": "src/hyphenation/nl.ts",
      "hyphenate/nn": "src/hyphenation/nn.ts",
      "hyphenate/pl": "src/hyphenation/pl.ts",
      "hyphenate/pt": "src/hyphenation/pt.ts",
      "hyphenate/ru": "src/hyphenation/ru.ts",
      "hyphenate/sk": "src/hyphenation/sk.ts",
      "hyphenate/sl": "src/hyphenation/sl.ts",
      "hyphenate/sv": "src/hyphenation/sv.ts",
      "hyphenate/tr": "src/hyphenation/tr.ts",
      "hyphenate/uk": "src/hyphenation/uk.ts",
    },
    sourcemap: false,
    clean: false,
  },
]);
