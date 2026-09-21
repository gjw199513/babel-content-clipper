import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

// Public website checks depend on current network/site availability, so they
// run explicitly rather than making the local fixture suite network-dependent.
export default defineConfig({
  ...base,
  testMatch: /platform-smoke\.spec\.ts/,
  testIgnore: [],
});
