import { defineConfig } from "tsup";

/**
 * A browser build of the measurement module for the e2e fixture alone.
 *
 * `opticalProtrusion` is deliberately NOT part of the package's public API —
 * pages never call it, `segments.ts` does — but the measured-protrusion tests
 * assert its output directly rather than inferring it from geometry, so the
 * fixture needs some way to load it. Bundling it here keeps it out of `dist/`,
 * and therefore out of the published tarball and the `.d.ts` surface.
 *
 * The module imports nothing at runtime (one type-only import), so this is a
 * single self-contained file with no chunks and no compatibility lowering: the
 * only consumers are the three current Playwright engines.
 */
export default defineConfig({
  entry: { optical: "src/dom/optical.ts" },
  outDir: "test-e2e/build",
  format: ["esm"],
  target: "es2020",
  dts: false,
  sourcemap: false,
  clean: true,
  silent: true,
});
