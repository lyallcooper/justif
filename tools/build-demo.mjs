import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "build", "pages");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, "demo"), output, { recursive: true });
await cp(join(root, "dist"), join(output, "dist"), {
  recursive: true,
  filter: (source) => extname(source) === "" || extname(source) === ".js",
});

console.log(`Cloudflare Pages demo built at ${output}`);
