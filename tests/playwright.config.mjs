import { defineConfig } from '@playwright/test';

// Headless by default (headless/run.sh); real display only via `npm run test:display`.
// Real Electron instances share one screen + GPU + public Nostr relays:
// run serially, allow generous timeouts, retry once for network flakiness.
export default defineConfig({
  globalSetup: './headless/guard.mjs',
  testDir: './e2e',
  testMatch: '*.spec.mjs',
  workers: 1,
  fullyParallel: false,
  retries: 1,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: './test-results',
});
