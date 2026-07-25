import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export function validatePackResult(packResult, packageJson) {
  if (!packResult || !Array.isArray(packResult.files)) {
    throw new Error("npm pack did not return a package file list");
  }
  if (packResult.name !== packageJson.name) {
    throw new Error(
      `Packed name ${packResult.name} does not match ${packageJson.name}`,
    );
  }
  if (packResult.version !== packageJson.version) {
    throw new Error(
      `Packed version ${packResult.version} does not match ${packageJson.version}`,
    );
  }
  if (!packResult.filename || !packResult.integrity) {
    throw new Error("npm pack did not report a filename and integrity");
  }

  const files = new Set(
    packResult.files.map((file) => normalizePackagePath(file.path)),
  );
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!files.has(required)) {
      throw new Error(`Packed artifact is missing ${required}`);
    }
  }

  const targets = collectPublishedTargets(packageJson);
  for (const target of targets) {
    if (!files.has(target)) {
      throw new Error(`Packed artifact is missing published target ${target}`);
    }
  }

  const forbidden = [...files].filter((file) =>
    ["src/", "test/", "test-e2e/", "tools/", ".github/"].some((prefix) =>
      file.startsWith(prefix),
    ),
  );
  if (forbidden.length > 0) {
    throw new Error(`Packed artifact contains private source: ${forbidden[0]}`);
  }

  return {
    filename: packResult.filename,
    integrity: packResult.integrity,
    fileCount: files.size,
  };
}

export function collectPublishedTargets(packageJson) {
  const targets = new Set();
  collectExportTargets(packageJson.exports, targets);
  for (const field of ["unpkg", "jsdelivr"]) {
    const target = packageJson[field];
    if (typeof target === "string") {
      targets.add(normalizePackagePath(target));
    }
  }
  return targets;
}

function collectExportTargets(value, targets) {
  if (typeof value === "string") {
    targets.add(normalizePackagePath(value));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value)) {
    collectExportTargets(nested, targets);
  }
}

function normalizePackagePath(path) {
  return path.replace(/^package\//, "").replace(/^\.\//, "");
}

function parseArgs(args) {
  const options = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--pack-destination" || argument === "--github-output") {
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for ${argument}`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unexpected argument: ${argument}`);
  }
  if (options.dryRun && options["pack-destination"]) {
    throw new Error("--dry-run and --pack-destination cannot be combined");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const cache = mkdtempSync(join(tmpdir(), "justif-npm-cache-"));
  const args = ["pack", "--json", "--ignore-scripts", "--cache", cache];
  if (options.dryRun) {
    args.push("--dry-run");
  } else if (options["pack-destination"]) {
    mkdirSync(options["pack-destination"], { recursive: true });
    args.push("--pack-destination", options["pack-destination"]);
  } else {
    throw new Error("Pass --dry-run or --pack-destination <directory>");
  }

  let packed;
  try {
    packed = spawnSync("npm", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
  if (packed.status !== 0) {
    throw new Error(`npm pack failed with exit code ${packed.status}`);
  }

  let results;
  try {
    results = JSON.parse(packed.stdout);
  } catch {
    throw new Error(`Could not parse npm pack output:\n${packed.stdout}`);
  }
  if (!Array.isArray(results) || results.length !== 1) {
    throw new Error(`Expected one packed artifact; received ${results.length}`);
  }

  const validated = validatePackResult(results[0], packageJson);
  const tarball = options["pack-destination"]
    ? resolve(options["pack-destination"], validated.filename)
    : validated.filename;
  if (options["github-output"]) {
    appendFileSync(
      options["github-output"],
      `tarball=${tarball}\nintegrity=${validated.integrity}\n`,
    );
  }
  console.log(
    `Verified ${validated.filename}: ${validated.fileCount} files, ${validated.integrity}`,
  );
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
