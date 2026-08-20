// The only check in the phase that exercises the real Vite output, the
// real static route, the real token handshake and a real ingest together
// -- against a real `pesto` process this fixture spawns itself, reading
// the URL and token from the line it prints on stdout (`src/pesto/launch.py`).
// Assumes `npm run build` already ran; asserts the built `index.html`
// exists so a missing build fails with a clear message instead of a blank
// page. Skips the whole file when the benchmark directory is absent,
// matching `tests/conftest.py`'s own convention.

import { test, expect, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const BUILT_INDEX = path.join(REPO_ROOT, 'src', 'pesto', 'static', 'index.html')

const BENCHMARK_ROOT = process.env.PESTO_BENCH ?? path.join(homedir(), 'dev', 'data', 'pesto-bench')
const FORECAST_RUN_NAME = 'forecast_20250618105403'
const FORECAST_RUN_PATH = path.join(BENCHMARK_ROOT, FORECAST_RUN_NAME)

// A generous ceiling for a cold ingest of a real, several-gigabyte
// benchmark run -- not a threshold this suite asserts on, just a bound
// past which something is genuinely stuck rather than merely slow.
const INGEST_WAIT_MS = 8 * 60 * 1000

const ABSOLUTE_PATH_PATTERN = /\/(Users|home)\/\S+/i

function hasBenchmarkData(): boolean {
  try {
    return existsSync(FORECAST_RUN_PATH)
  } catch {
    return false
  }
}

function seedLastRun(fakeHome: string, targetPath: string): void {
  const dir = path.join(fakeHome, '.cache', 'pesto')
  mkdirSync(dir, { recursive: true })
  const body = JSON.stringify({ version: 1, path: realpathSync(targetPath) })
  writeFileSync(path.join(dir, 'last_run.json'), body, 'utf8')
}

interface Launched {
  proc: ChildProcess
  url: string
}

// Spawns the real console script and reads its own printed line for the
// URL and token, exactly as a person watching the terminal would --
// never guessing a port or minting a token of its own.
async function launchPesto(env: Record<string, string | undefined>): Promise<Launched> {
  const proc = spawn('uv', ['run', 'pesto', '--no-browser'], { cwd: REPO_ROOT, env })

  const url = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    let stderrBuffer = ''
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for "pesto serving" on stdout. stderr so far: ${stderrBuffer}`))
    }, 60_000)

    proc.stdout?.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const match = buffer.match(/pesto serving (\S+)/)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    proc.stderr?.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8')
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`pesto exited (code ${code}) before printing its serving URL: ${stderrBuffer}`))
    })
  })

  return { proc, url }
}

// Presses Tab repeatedly, reading the newly focused element's own text
// each time, until it matches -- the same thing a person tabbing through
// the page would do, with no assumption about how many presses it takes
// or what the page looked like before.
async function tabUntilFocused(page: Page, matches: (text: string) => boolean, maxPresses = 60): Promise<void> {
  for (let i = 0; i < maxPresses; i += 1) {
    await page.keyboard.press('Tab')
    const text = await page.evaluate(() => (document.activeElement?.textContent ?? '').trim())
    if (matches(text)) {
      return
    }
  }
  throw new Error('could not reach the target control by tabbing through the page')
}

test.describe('the picker and ingest flow, in a real browser against a real pesto', () => {
  test.skip(!hasBenchmarkData(), `benchmark run directory not found: ${FORECAST_RUN_PATH}`)
  test.describe.configure({ mode: 'serial' })

  let launched: Launched
  let pestoUrl: string

  test.beforeAll(async () => {
    if (!existsSync(BUILT_INDEX)) {
      throw new Error(`the built frontend is missing at ${BUILT_INDEX} -- run "npm run build" first`)
    }

    const fakeHome = mkdtempSync(path.join(tmpdir(), 'pesto-e2e-home-'))
    // Points the picker at the benchmark root itself, not the run directly
    // -- the cold-open flow below descends into it by keyboard, the same
    // one hop a person would take, rather than starting already inside it.
    seedLastRun(fakeHome, BENCHMARK_ROOT)

    launched = await launchPesto({ ...process.env, HOME: fakeHome })
    pestoUrl = launched.url
  })

  test.afterAll(() => {
    launched?.proc.kill()
  })

  test('cold open: pick the run by keyboard, agree to ingest, watch it finish, reach the placeholder', async ({
    page,
  }) => {
    await page.goto(pestoUrl)

    // D-08's whole point, now checked in a real address bar rather than a
    // manual note (05-VALIDATION.md's promoted check).
    expect(new URL(page.url()).searchParams.has('token')).toBe(false)

    const benchmarkRootName = path.basename(BENCHMARK_ROOT)
    await expect(page.getByRole('button', { name: benchmarkRootName, exact: true })).toBeVisible()
    await tabUntilFocused(page, (text) => text === benchmarkRootName)
    await page.keyboard.press('Enter')

    await expect(page.getByRole('button', { name: 'Open' }).first()).toBeVisible()
    await tabUntilFocused(page, (text) => text === 'Open')
    await page.keyboard.press('Enter')

    const agreeButton = page.getByRole('button', { name: 'Agree and ingest' })
    await expect(agreeButton).toBeVisible()
    await expect(page.getByText(/Projected cache size/)).toBeVisible()
    await expect(page.getByText(/Free space/)).toBeVisible()

    await agreeButton.click()

    // The first row can take a while to appear on a genuinely large run --
    // discovery and planning are cheap (filename checks only, D-10), but
    // the background ingest thread's first artifact may itself be slow to
    // start on several gigabytes of real ensemble data.
    await expect(page.locator('li').first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/Done|Failed|Already fresh/).first()).toBeVisible({ timeout: INGEST_WAIT_MS })

    await expect(page.getByText('The map is not built yet')).toBeVisible({ timeout: INGEST_WAIT_MS })

    const bodyText = (await page.textContent('body')) ?? ''
    expect(bodyText).toMatch(/5\.1/)
    expect(bodyText).toMatch(/Ingest time[\d.]/)
    expect(bodyText).toMatch(/Cache size[\d.]/)
    expect(bodyText).not.toMatch(ABSOLUTE_PATH_PATTERN)
  })

  test('warm open: reopening the same run skips the estimate and progress screens entirely', async ({ page }) => {
    const requests: { url: string; method: string }[] = []
    page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }))

    const start = Date.now()
    await page.goto(pestoUrl)
    await expect(page.getByText('The map is not built yet')).toBeVisible()
    const elapsedMs = Date.now() - start
    // Phase 6 measures the 1.5s warm-open budget on its own methodology;
    // this is a starting figure from a real browser, not that measurement.
    console.log(`[visual] warm-open navigation-to-placeholder: ${elapsedMs}ms`)

    await expect(page.getByRole('button', { name: 'Agree and ingest' })).toHaveCount(0)
    await expect(page.locator('li')).toHaveCount(0)
    expect(requests.some((r) => r.url.includes('/api/run/ingest/estimate'))).toBe(false)
    expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/api/run/ingest'))).toBe(false)

    const bodyText = (await page.textContent('body')) ?? ''
    expect(bodyText).not.toMatch(ABSOLUTE_PATH_PATTERN)
  })
})
