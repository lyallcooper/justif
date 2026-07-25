import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export function comparePublishedIntegrity(published, expected) {
  if (published === null) return "missing";
  return published === expected ? "matching" : "conflict";
}

function runNpm(args, { allowMissing = false, inherit = false } = {}) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return result.stdout?.trim() ?? "";
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (allowMissing && /\bE404\b|is not in this registry/i.test(output)) {
    return null;
  }
  throw new Error(
    `npm ${args[0]} failed with exit code ${result.status}\n${output.trim()}`,
  );
}

function publishedIntegrity(spec) {
  const output = runNpm(["view", spec, "dist.integrity", "--json"], {
    allowMissing: true,
  });
  if (output === null) return null;
  try {
    const parsed = JSON.parse(output);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    throw new Error(`Could not parse registry integrity for ${spec}: ${output}`);
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!["--tarball", "--integrity"].includes(argument)) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.tarball || !options.integrity) {
    throw new Error(
      "Usage: node tools/publish-release.mjs --tarball path --integrity sha512-...",
    );
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const spec = `${packageJson.name}@${packageJson.version}`;
  const before = publishedIntegrity(spec);
  const state = comparePublishedIntegrity(before, options.integrity);

  if (state === "conflict") {
    throw new Error(
      `${spec} already exists with integrity ${before}, not ${options.integrity}`,
    );
  }
  if (state === "matching") {
    console.log(`${spec} is already published with the expected integrity`);
    return;
  }

  console.log(`Publishing ${spec} from the verified tarball`);
  runNpm(["publish", options.tarball, "--access", "public"], { inherit: true });

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const visible = publishedIntegrity(spec);
    const visibility = comparePublishedIntegrity(visible, options.integrity);
    if (visibility === "matching") {
      console.log(`${spec} is visible with the expected integrity`);
      return;
    }
    if (visibility === "conflict") {
      throw new Error(
        `${spec} became visible with integrity ${visible}, not ${options.integrity}`,
      );
    }
    if (attempt < 20) sleep(3_000);
  }
  throw new Error(`${spec} was not visible on npm after 60 seconds`);
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
