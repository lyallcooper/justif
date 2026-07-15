import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    core: "src/core.ts",
    "hyphenate/en-us": "src/hyphenation/en-us.ts",
    "hyphenate/liang": "src/hyphenation/liang.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2020",
  treeshake: true,
});
