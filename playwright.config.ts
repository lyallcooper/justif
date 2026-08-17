import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test-e2e",
  timeout: 30_000,
  /**
   * One retry, so that two known non-product failures stop reading as
   * regressions. Playwright still reports a test that needed its retry as
   * "flaky", so neither is silenced — and a real failure fails twice.
   *
   * WebKit loses a navigation roughly once per hundred tests: `page.goto` of
   * the fixture never reaches `load`, and the test that was merely next in
   * line times out in its `beforeEach`. It settles on the same name most runs
   * under these defaults, but it has landed elsewhere under `--workers=1` and
   * at earlier commits, so the name is a symptom and not the cause. It is not
   * the web server starving: that is threaded, and it serves every other
   * request in the same run.
   *
   * The perf budgets are calibrated for a browser that has the machine to
   * itself. All three projects run together here, and the resize figure — a
   * latency, measured across real frames — is the one that suffers when they
   * compete: it has been seen at 137ms against a 100ms budget in a full run
   * while measuring 24ms alone moments later.
   */
  retries: 1,
  // Builds the fixture's own copy of the measurement module, which the package
  // does not export (see test-e2e/tsup.optical.config.ts).
  globalSetup: "./test-e2e/global-setup.mjs",
  use: { baseURL: "http://localhost:5199" },
  webServer: {
    command: "python3 -m http.server 5199 --bind 127.0.0.1",
    port: 5199,
    reuseExistingServer: true,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
