// Times reopen and the sliders in a real browser, against a real pesto
// process, using the frame stamps the page records when a test asks for them
// (src/perf.ts). Every delay is measured inside the page, from the move to the
// stamp of the frame that shows it, so Playwright round trips are not in the
// number. The synthetic run is a mechanism check only: nothing is judged.

import { expect, test, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const BUILT_INDEX = path.join(REPO_ROOT, 'src', 'pesto', 'static', 'index.html')
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'frontend', 'test-results', 'slider-latency')

const FRAME_TIMEOUT_MS = 5000
const SCHEMA_VERSION = 1

interface Launched {
  proc: ChildProcess
  url: string
}

async function runToCompletion(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: REPO_ROOT })
    let stderrBuffer = ''
    proc.stderr?.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8')
    })
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited (code ${code}): ${stderrBuffer}`))
    })
  })
}

// The throwaway HOME keeps recents and saved view state away from the real
// ones; uv still needs the real cache to find its packages.
async function launchPesto(runDir: string, cacheDir: string, fakeHome: string): Promise<Launched> {
  const env = { ...process.env, HOME: fakeHome, UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? path.join(homedir(), '.cache', 'uv') }
  const proc = spawn('uv', ['run', 'pesto', '--no-browser', runDir, '--cache-dir', cacheDir], { cwd: REPO_ROOT, env })

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

// Before navigating: the frame log the page stamps into, and a watcher that
// records when the canvas is first marked drawn (ms since navigation start).
async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__pestoFrames = []
    performance.setResourceTimingBufferSize(2000)
    const watch = new MutationObserver(() => {
      if (w.__pestoDrawnAt === undefined && document.querySelector('canvas[data-drawn="true"]')) {
        w.__pestoDrawnAt = performance.now()
      }
    })
    const start = () => watch.observe(document.documentElement, { subtree: true, attributes: true, childList: true })
    if (document.documentElement) start()
    else document.addEventListener('DOMContentLoaded', start)
  })
}

async function drawnAt(page: Page): Promise<number> {
  await page.waitForSelector('canvas[data-drawn="true"]', { timeout: 120_000 })
  return page.evaluate(() => (window as unknown as { __pestoDrawnAt: number }).__pestoDrawnAt)
}

interface GpuFacts {
  renderer: string
  viewport: { width: number; height: number }
  device_pixel_ratio: number
}

async function gpuFacts(page: Page): Promise<GpuFacts> {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    const renderer = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown'
    return {
      renderer,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      device_pixel_ratio: window.devicePixelRatio,
    }
  })
}

interface MoveStep {
  value: string
  selection?: string
  layer?: number
  group?: string
}

interface MovePlan {
  selector: string
  steps: MoveStep[]
  timeoutMs: number
  gapMs: number
}

// One move at a time: set the control, then wait frame by frame for a stamp
// at or after the move that shows what the move asked for.
async function timeMoves(page: Page, plan: MovePlan): Promise<{ delays: number[]; timeouts: number }> {
  return page.evaluate(async (p) => {
    const el = document.querySelector(p.selector) as HTMLInputElement | HTMLSelectElement | null
    if (!el) throw new Error(`no control matches ${p.selector}`)
    const frames = (window as unknown as { __pestoFrames: Array<{ t: number; selection: string; layer: number; group: string | null }> })
      .__pestoFrames
    const isRange = el instanceof HTMLInputElement && el.type === 'range'
    const isCheckbox = el instanceof HTMLInputElement && el.type === 'checkbox'
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
    const checkedSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')!.set!
    const delays: number[] = []
    let timeouts = 0
    for (const step of p.steps) {
      frames.length = 0
      const t0 = performance.now()
      if (isCheckbox) checkedSetter.call(el, step.value === 'true')
      else valueSetter.call(el, step.value)
      el.dispatchEvent(new Event(isRange ? 'input' : 'change', { bubbles: true }))
      let hit: number | null = null
      for (;;) {
        const found = frames.find(
          (f) =>
            f.t >= t0 &&
            (step.selection === undefined || f.selection === step.selection) &&
            (step.layer === undefined || f.layer === step.layer) &&
            (step.group === undefined || f.group === step.group),
        )
        if (found) {
          hit = found.t - t0
          break
        }
        if (performance.now() - t0 > p.timeoutMs) break
        await new Promise((r) => requestAnimationFrame(r))
      }
      if (hit === null) timeouts += 1
      else delays.push(hit)
      await new Promise((r) => setTimeout(r, p.gapMs))
    }
    return { delays, timeouts }
  }, plan)
}

// The synthetic run's constants live in tests/fixtures/synthetic_run.py.
const SYNTHETIC_REALIZATIONS = ['base', 'r1', 'r2']

const results: Record<string, unknown> = {
  schema_version: SCHEMA_VERSION,
  runs: {},
}
const runs = results.runs as Record<string, unknown>

function writeResults(project: string): void {
  mkdirSync(DEFAULT_OUT_DIR, { recursive: true })
  writeFileSync(path.join(DEFAULT_OUT_DIR, `slider-${project}.json`), JSON.stringify(results, null, 2) + '\n', 'utf8')
}

test.describe('reopen and sliders on the synthetic run (a mechanism check)', () => {
  test.skip(!existsSync(BUILT_INDEX), `the built frontend is missing at ${BUILT_INDEX} -- run "npm run build" first`)
  test.describe.configure({ mode: 'serial' })

  let launched: Launched
  let facts: GpuFacts | null = null
  const synthetic: Record<string, unknown> = { mode: 'synthetic', judged: false, judged_note: 'synthetic run: a mechanism check only' }
  runs.synthetic = synthetic

  test.beforeAll(async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'pesto-slider-synth-'))
    const runDir = path.join(work, 'synthetic')
    await runToCompletion('uv', ['run', 'python', '-m', 'tests.fixtures.synthetic_run', runDir])
    // The cache goes beside the run, never inside it.
    const cacheDir = path.join(work, 'synthetic-cache')
    cpSync(path.join(runDir, '.pesto'), cacheDir, { recursive: true })
    launched = await launchPesto(runDir, cacheDir, mkdtempSync(path.join(work, 'home-')))
  })

  test.afterAll(({}, testInfo) => {
    launched?.proc.kill()
    if (facts) Object.assign(results, { project: testInfo.project.name, ...facts })
    writeResults(testInfo.project.name)
  })

  test('reopen: first load after server start and a repeat load (synthetic)', async ({ page }) => {
    await installProbes(page)
    await page.goto(launched.url)
    const first = await drawnAt(page)
    facts = await gpuFacts(page)
    await page.reload()
    const repeat = await drawnAt(page)
    synthetic.reopen = { first_load_ms: first, repeat_load_ms: repeat }
    expect(first).toBeGreaterThan(0)
    expect(repeat).toBeGreaterThan(0)
  })

  test('slider: realization, which fetches (synthetic)', async ({ page }) => {
    await installProbes(page)
    await page.goto(launched.url)
    await drawnAt(page)
    const steps: MoveStep[] = []
    for (let i = 0; i < 10; i += 1) {
      const index = (i + 1) % SYNTHETIC_REALIZATIONS.length
      steps.push({ value: String(index), selection: SYNTHETIC_REALIZATIONS[index] })
    }
    const { delays, timeouts } = await timeMoves(page, {
      selector: 'input[aria-label="Realization"]',
      steps,
      timeoutMs: FRAME_TIMEOUT_MS,
      gapMs: 60,
    })
    synthetic.realization_delays_ms = delays
    expect(timeouts).toBe(0)
    expect(delays).toHaveLength(10)
    for (const d of delays) expect(typeof d).toBe('number')
  })
})
