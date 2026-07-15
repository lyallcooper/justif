import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "build", "pages");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, "demo"), output, {
  recursive: true,
  // Keep the original variable TTFs as source/test fixtures, but deploy only
  // the much smaller WOFF2 web builds referenced by the demo.
  filter: (source) => extname(source) !== ".ttf",
});
await cp(join(root, "dist"), join(output, "dist"), {
  recursive: true,
  filter: (source) => extname(source) === "" || extname(source) === ".js",
});

console.log(`Cloudflare Pages demo built at ${output}`);
