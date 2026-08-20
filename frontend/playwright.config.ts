// The one suite in this phase that drives a real Vite build, the real
// static route, the real token handshake and a real ingest together --
// against a real `pesto` process the spec's own fixture spawns and reads
// the printed URL from. Nothing here manages that server for us: there is
// no server-startup config block in this file at all. No retries: a
// flaky end-to-end test that passes on a retry is worse than one that
// fails and says so.
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/visual',
  timeout: 10 * 60 * 1000,
  retries: 0,
  reporter: 'list',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
