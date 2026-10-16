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
  // Playwright empties its output folder at the start of every run; the slider
  // check writes its results to test-results/slider-latency/, so keep them apart.
  outputDir: 'test-results/playwright',
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
    // The real graphics card (ANGLE on Metal). Only the slider check runs here;
    // the software project above runs it too and gives the upper bound (D-19).
    {
      name: 'chromium-gpu',
      testMatch: /slider-latency\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-angle=metal', '--enable-gpu'],
        },
      },
    },
  ],
})
