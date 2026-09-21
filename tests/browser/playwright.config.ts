import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: directory,
  testMatch: /.*\.spec\.ts/,
  testIgnore: /platform-smoke\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: resolve(directory, "../../.hallmark/browser-results"),
  webServer: {
    command: "node scripts/serve-fixtures.mjs",
    cwd: resolve(directory, "../.."),
    url: "http://127.0.0.1:4179/article.html",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
