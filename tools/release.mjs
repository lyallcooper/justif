import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  getUnreleasedNotes,
  promoteUnreleased,
  validateReleaseMetadata,
} from "./release-metadata.mjs";
import { waitForCi } from "./wait-for-ci.mjs";

const RELEASE_FILES = [
  "package.json",
  "package-lock.json",
  "CHANGELOG.md",
  "README.md",
];
const BUMPS = new Set(["patch", "minor", "major"]);
const FLAGS = new Set(["--dry-run", "--yes", "-y"]);

let snapshots = null;
let mutated = false;
let staged = false;
let committed = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${result.stderr.trim() || result.stdout.trim()}`
      : "";
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}${detail}`,
    );
  }
  return options.capture ? result.stdout.trimEnd() : "";
}

function git(args, options) {
  return run("git", args, options);
}

function packageJson() {
  return JSON.parse(readFileSync("package.json", "utf8"));
}

function assertClean() {
  const status = git(["status", "--porcelain"], { capture: true });
  if (status) {
    throw new Error("The working tree must be clean before releasing");
  }
}

function assertMain() {
  const branch = git(["branch", "--show-current"], { capture: true });
  if (branch !== "main") {
    throw new Error(`Releases must run from main, not ${branch || "detached HEAD"}`);
  }
}

function authenticateAndFetch() {
  run("gh", ["auth", "status"]);
  git([
    "fetch",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
    "--tags",
  ]);
}

function assertExpectedChanges() {
  const changed = git(
    ["status", "--porcelain", "--untracked-files=all"],
    { capture: true },
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1))
    .sort();
  assertReleasePaths(changed, "Release preparation changed");
}

function assertReleasePaths(paths, context) {
  const expected = [...RELEASE_FILES].sort();
  if (
    paths.length !== expected.length ||
    paths.some((path, index) => path !== expected[index])
  ) {
    throw new Error(
      `${context} unexpected files: ${paths.join(", ") || "(none)"}`,
    );
  }
}

function takeSnapshots() {
  snapshots = new Map(
    RELEASE_FILES.map((path) => [path, readFileSync(path)]),
  );
}

function restoreSnapshots() {
  if (!snapshots || !mutated || committed) return;
  if (staged) {
    git(["restore", "--staged", "--", ...RELEASE_FILES]);
    staged = false;
  }
  for (const [path, contents] of snapshots) {
    writeFileSync(path, contents);
  }
  mutated = false;
}

async function confirmRelease(version, assumeYes) {
  if (assumeYes) {
    console.log(`Confirmed justif ${version} non-interactively via --yes`);
    return true;
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "Confirmation requires an interactive terminal; pass --yes to skip the prompt",
    );
  }
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question(
      `Commit and push justif ${version}, then tag it after CI passes? [y/N] `,
    );
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function validatePreparedRelease(version) {
  validateReleaseMetadata({
    tag: `v${version}`,
    packageVersion: version,
    changelog: readFileSync("CHANGELOG.md", "utf8"),
    readme: readFileSync("README.md", "utf8"),
  });
  run("node", ["tools/sync-version.mjs", "--check"]);
  run("npm", ["run", "check:package"]);
}

function headSha() {
  return git(["rev-parse", "HEAD"], { capture: true });
}

function ensureTag(version, sha) {
  const tag = `v${version}`;
  const existing = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `${tag}^{}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (existing.status === 0) {
    const tagType = git(["cat-file", "-t", `refs/tags/${tag}`], {
      capture: true,
    });
    if (tagType !== "tag") {
      throw new Error(
        `${tag} already exists as a lightweight tag; it will not be replaced`,
      );
    }
    if (existing.stdout.trim() !== sha) {
      throw new Error(
        `${tag} already points to ${existing.stdout.trim()}, not ${sha}; it will not be moved`,
      );
    }
    console.log(`${tag} already points to the release commit`);
  } else {
    git(["tag", "-a", tag, "-m", `justif ${version}`, sha]);
  }
  git(["push", "origin", `refs/tags/${tag}`]);
  console.log(
    `Pushed ${tag}; GitHub Actions will publish npm and create the GitHub release`,
  );
}

async function prepareRelease(bump, dryRun, assumeYes) {
  assertMain();
  assertClean();
  getUnreleasedNotes(readFileSync("CHANGELOG.md", "utf8"));
  if (!dryRun) authenticateAndFetch();
  const sha = headSha();
  if (!dryRun && sha !== git(["rev-parse", "origin/main"], { capture: true })) {
    throw new Error("main must exactly match origin/main before a new release");
  }

  run("npm", ["run", "typecheck"]);
  run("npm", ["test"]);

  takeSnapshots();
  mutated = true;
  run("npm", [
    "version",
    bump,
    "--no-git-tag-version",
    "--ignore-scripts",
  ]);
  const version = packageJson().version;
  const changelog = promoteUnreleased(
    readFileSync("CHANGELOG.md", "utf8"),
    version,
    new Date().toISOString().slice(0, 10),
  );
  writeFileSync("CHANGELOG.md", changelog);

  run("npm", ["run", "build"]);
  run("node", ["tools/sync-version.mjs"]);
  validatePreparedRelease(version);
  assertExpectedChanges();

  git(["diff", "--", ...RELEASE_FILES]);
  if (dryRun) {
    restoreSnapshots();
    assertClean();
    console.log(`Dry run for justif ${version} passed; no files were changed`);
    return;
  }

  if (!(await confirmRelease(version, assumeYes))) {
    restoreSnapshots();
    assertClean();
    console.log("Release cancelled; prepared files were restored");
    return;
  }

  git(["add", "--", ...RELEASE_FILES]);
  staged = true;
  const stagedFiles = git(["diff", "--cached", "--name-only"], {
    capture: true,
  })
    .split("\n")
    .filter(Boolean)
    .sort();
  assertReleasePaths(stagedFiles, "Staging included");

  git(["commit", "-m", `Release ${version}`]);
  committed = true;
  staged = false;
  const committedFiles = git(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
    { capture: true },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  assertReleasePaths(committedFiles, "Release commit included");
  assertClean();
  const releaseSha = headSha();
  git(["push", "origin", "main"]);
  waitForCi(releaseSha);
  ensureTag(version, releaseSha);
}

function resumeRelease() {
  assertMain();
  assertClean();
  authenticateAndFetch();

  const version = packageJson().version;
  const subject = git(["log", "-1", "--format=%s"], { capture: true });
  if (subject !== `Release ${version}`) {
    throw new Error(
      `HEAD is not the “Release ${version}” commit; refusing to tag unrelated work`,
    );
  }
  validateReleaseMetadata({
    tag: `v${version}`,
    packageVersion: version,
    changelog: readFileSync("CHANGELOG.md", "utf8"),
    readme: readFileSync("README.md", "utf8"),
  });

  const [behind, ahead] = git(
    ["rev-list", "--left-right", "--count", "origin/main...HEAD"],
    { capture: true },
  )
    .split(/\s+/)
    .map(Number);
  if (behind !== 0 || ahead > 1) {
    throw new Error(
      `main has diverged from origin/main (behind ${behind}, ahead ${ahead})`,
    );
  }

  run("npm", ["run", "typecheck"]);
  run("npm", ["test"]);
  run("npm", ["run", "build"]);
  validatePreparedRelease(version);
  assertClean();

  if (ahead === 1) {
    git(["push", "origin", "main"]);
  }
  const sha = headSha();
  waitForCi(sha);
  ensureTag(version, sha);
}

function usage() {
  console.log(`Usage:
  npm run release -- patch|minor|major [--dry-run] [--yes]
  npm run release -- resume

The command prepares one release commit on main, waits for that commit's CI,
then pushes an immutable vX.Y.Z tag. The tag triggers npm and GitHub publishing.

--yes skips the interactive confirmation, for non-interactive callers such as
an agent or a script. Every other safety check still applies: the release must
run from a clean main matching origin/main, only the four release files may
change, and the tag is pushed only after CI passes on the release commit.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const dryRun = args.includes("--dry-run");
  const assumeYes = args.includes("--yes") || args.includes("-y");
  const positional = args.filter((argument) => !FLAGS.has(argument));
  if (positional.length !== 1) {
    usage();
    throw new Error("Choose patch, minor, major, or resume");
  }
  if (positional[0] === "resume") {
    if (dryRun) throw new Error("resume does not support --dry-run");
    resumeRelease();
    return;
  }
  if (!BUMPS.has(positional[0])) {
    throw new Error(`Unknown release kind: ${positional[0]}`);
  }
  await prepareRelease(positional[0], dryRun, assumeYes);
}

process.on("SIGINT", () => {
  restoreSnapshots();
  process.exit(130);
});

try {
  await main();
} catch (error) {
  restoreSnapshots();
  console.error(error instanceof Error ? error.message : error);
  if (committed) {
    console.error("The release commit was kept. Run `npm run release -- resume`.");
  }
  process.exitCode = 1;
}
