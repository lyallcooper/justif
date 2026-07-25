import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function gh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed\n${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function findCiRun(sha, workflow = "ci.yml") {
  const output = gh([
    "run",
    "list",
    "--workflow",
    workflow,
    "--commit",
    sha,
    "--limit",
    "20",
    "--json",
    "databaseId,status,conclusion,createdAt,url,event,headBranch",
  ]);
  const runs = JSON.parse(output);
  return selectCiRun(runs);
}

export function selectCiRun(runs) {
  return (
    runs
      .filter((run) => run.event === "push" && run.headBranch === "main")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ??
    null
  );
}

export function waitForCi(sha, workflow = "ci.yml") {
  let run = null;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    run = findCiRun(sha, workflow);
    if (run) break;
    if (attempt < 60) sleep(5_000);
  }
  if (!run) {
    throw new Error(`No ${workflow} run appeared for ${sha} within five minutes`);
  }

  if (run.status !== "completed") {
    console.log(`Waiting for CI run ${run.url}`);
    const watched = spawnSync(
      "gh",
      ["run", "watch", String(run.databaseId), "--exit-status", "--interval", "5"],
      { stdio: "inherit" },
    );
    if (watched.status !== 0) {
      throw new Error(`CI failed for ${sha}: ${run.url}`);
    }
    return run;
  }
  if (run.conclusion !== "success") {
    throw new Error(
      `CI concluded ${run.conclusion || "without a result"} for ${sha}: ${run.url}`,
    );
  }

  console.log(`CI already passed for ${sha}: ${run.url}`);
  return run;
}

function main() {
  const args = process.argv.slice(2);
  const shaIndex = args.indexOf("--sha");
  const workflowIndex = args.indexOf("--workflow");
  const sha = shaIndex === -1 ? null : args[shaIndex + 1];
  const workflow =
    workflowIndex === -1 ? "ci.yml" : args[workflowIndex + 1];
  if (!sha || !workflow) {
    throw new Error(
      "Usage: node tools/wait-for-ci.mjs --sha <commit> [--workflow ci.yml]",
    );
  }
  waitForCi(sha, workflow);
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
