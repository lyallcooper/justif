import { spawnSync } from "node:child_process";

/**
 * Builds the fixture's private copy of the measurement module (see
 * tsup.optical.config.ts). Runs from the Playwright config rather than from an
 * npm script so that a bare `npx playwright test` gets it too, and it is cheap
 * enough to redo every run: one tiny entry, no type emit.
 *
 * Plain JS, like the scripts in tools/: the repo does not carry Node's type
 * declarations, and tsc typechecks everything under test-e2e.
 */
export default function globalSetup() {
  const result = spawnSync(
    "npx",
    ["tsup", "--config", "test-e2e/tsup.optical.config.ts"],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.status !== 0) {
    throw new Error(
      `Building the e2e measurement bundle failed with exit code ${result.status}`,
    );
  }
}
