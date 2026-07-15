import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test-e2e",
  timeout: 30_000,
  use: { baseURL: "http://localhost:5199" },
  webServer: {
    command: "python3 -m http.server 5199",
    port: 5199,
    reuseExistingServer: true,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
