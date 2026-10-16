// Times reopen and the sliders in a real browser, against a real pesto
// process, using the frame stamps the page records when a test asks for them
// (src/perf.ts). Every delay is measured inside the page, from the move to the
// stamp of the frame that shows it, so Playwright round trips are not in the
// number.
//
// PESTO_BENCH_RESULTS: comma-separated paths of bench JSON files (relative
//   paths are taken from the repo root). Each names a run and the scratch cache
//   `pesto bench` built for it. Without it the synthetic run is measured as a
//   mechanism check and nothing is judged.
// PESTO_SLIDER_OUT_DIR: where slider-<project>.json goes. An existing results
//   file there is refused, never overwritten.

import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isSoftwareRenderer, parseBenchResult, stripToken, type BenchTarget } from './bench-json'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const BUILT_INDEX = path.join(REPO_ROOT, 'src', 'pesto', 'static', 'index.html')
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'frontend', 'test-results', 'slider-latency')

const FRAME_TIMEOUT_MS = 5000
const SCHEMA_VERSION = 1
const PROJECT_NAMES = ['chromium', 'chromium-gpu']
const GPU_PROJECT = 'chromium-gpu'

interface Target extends BenchTarget {
  mode: 'bench' | 'synthetic'
}

// The synthetic run's constants live in tests/fixtures/synthetic_run.py: G2
// places on layer 0, G4layer1 is the interpolated pilot-point group.
const SYNTHETIC_TARGET: Target = {
  mode: 'synthetic',
  label: 'synthetic',
  runDir: '',
  cacheDir: '',
  limits: { reopenMs: 1500, fetchP95Ms: 150, noFetchP95Ms: 50 },
  iteration: 0,
  heaviest: { group: 'G2', layer: 0, cells: 2 },
  pilotPoint: { group: 'G4layer1', layer: 0, nPp: 2 },
}

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p)
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function loadTargets(): Target[] {
  const listed = process.env.PESTO_BENCH_RESULTS
  if (!listed) return [SYNTHETIC_TARGET]
  const targets: Target[] = []
  for (const raw of listed.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const file = resolveFromRoot(raw)
    let json: unknown
    try {
      json = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`cannot read the bench result ${file}: ${(error as Error).message}`)
    }
    const target = parseBenchResult(json)
    const run = realOrResolved(target.runDir)
    const cache = realOrResolved(target.cacheDir)
    if (cache === run || cache.startsWith(run + path.sep)) {
      throw new Error(
        `${target.label}: the cache folder ${cache} is inside the run folder ${run}; pesto never writes inside a run folder`,
      )
    }
    targets.push({ ...target, mode: 'bench' })
  }
  if (targets.length === 0) throw new Error('PESTO_BENCH_RESULTS is set but names no file')
  return targets
}

const TARGETS = loadTargets()

const OUT_DIR = process.env.PESTO_SLIDER_OUT_DIR ? resolveFromRoot(process.env.PESTO_SLIDER_OUT_DIR) : DEFAULT_OUT_DIR

// Playwright loads this file in its main process first and in each worker
// after, and a worker inherits the id. The refusal runs once, in the first
// load, before any result of this run exists.
if (process.env.PESTO_SLIDER_RUN_ID === undefined) {
  process.env.PESTO_SLIDER_RUN_ID = new Date().toISOString()
  if (process.env.PESTO_SLIDER_OUT_DIR) {
    for (const project of PROJECT_NAMES) {
      const file = path.join(OUT_DIR, `slider-${project}.json`)
      if (existsSync(file)) {
        throw new Error(`${file} already exists; choose a new PESTO_SLIDER_OUT_DIR, earlier results are never overwritten`)
      }
    }
  }
}
const RUN_ID = process.env.PESTO_SLIDER_RUN_ID

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
// ones; uv still needs the real cache to find its packages. The cache folder
// is always given, so pesto never makes a .pesto folder in a run.
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

function stopPesto(launched: Launched | null): Promise<void> {
  if (!launched || launched.proc.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    launched.proc.once('exit', () => resolve())
    launched.proc.kill()
  })
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
  software_renderer: boolean
  viewport: { width: number; height: number }
  device_pixel_ratio: number
}

async function gpuFacts(page: Page): Promise<GpuFacts> {
  const read = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    const renderer = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown'
    return {
      renderer,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      device_pixel_ratio: window.devicePixelRatio,
    }
  })
  // A renderer string that cannot be read counts as software: it is never judged.
  return { ...read, software_renderer: read.renderer === 'unknown' || isSoftwareRenderer(read.renderer) }
}

interface RequestRecord {
  name: string
  start_ms: number
  duration_ms: number
  transfer_bytes: number
  encoded_bytes: number
}

// Every /api request this load made, with the token taken out of its name.
async function apiRequests(page: Page): Promise<RequestRecord[]> {
  await page.waitForTimeout(500)
  const raw = await page.evaluate(() =>
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((e) => e.name.includes('/api/'))
      .map((e) => ({
        name: e.name,
        start_ms: e.startTime,
        duration_ms: e.duration,
        transfer_bytes: e.transferSize,
        encoded_bytes: e.encodedBodySize,
      })),
  )
  return raw.map((r) => ({ ...r, name: stripToken(r.name) }))
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
  // Read the expected selection from the label shown beside the slider.
  selectionFromLabel?: boolean
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
      const want = p.selectionFromLabel
        ? (el.parentElement?.querySelector('.tabular-nums')?.textContent ?? '').trim()
        : step.selection
      let hit: number | null = null
      for (;;) {
        const found = frames.find(
          (f) =>
            f.t >= t0 &&
            (want === undefined || f.selection === want) &&
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

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// What gets written. Each target fills its own entry, and the whole file is
// rewritten as soon as a number exists, before any assertion runs.
interface Results {
  schema_version: number
  run_id: string
  project: string
  renderer: string | null
  software_renderer: boolean | null
  viewport: { width: number; height: number } | null
  device_pixel_ratio: number | null
  runs: Record<string, Record<string, unknown>>
}

function flush(project: string, label: string, run: Record<string, unknown>, facts: GpuFacts | null): void {
  const file = path.join(OUT_DIR, `slider-${project}.json`)
  let runs: Results['runs'] = {}
  if (existsSync(file)) {
    try {
      const earlier = JSON.parse(readFileSync(file, 'utf8')) as Partial<Results>
      if (earlier.run_id === RUN_ID && earlier.runs) runs = earlier.runs
    } catch {
      // An unreadable earlier file is replaced by this run's own numbers.
    }
  }
  runs[label] = run
  const doc: Results = {
    schema_version: SCHEMA_VERSION,
    run_id: RUN_ID,
    project,
    renderer: facts?.renderer ?? null,
    software_renderer: facts?.software_renderer ?? null,
    viewport: facts?.viewport ?? null,
    device_pixel_ratio: facts?.device_pixel_ratio ?? null,
    runs,
  }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8')
}

// Only a real benchmark run, in the real-GPU project, on a hardware renderer is judged.
function judging(target: Target, project: string, facts: GpuFacts | null): { judged: boolean; note: string } {
  if (target.mode === 'synthetic') return { judged: false, note: 'synthetic run: a mechanism check only' }
  if (project !== GPU_PROJECT) return { judged: false, note: 'software renderer: reported as the upper bound (D-19)' }
  if (facts === null || facts.software_renderer) {
    return {
      judged: false,
      note: 'the GPU project fell back to a software renderer, so the real-GPU speed limit cannot be judged here',
    }
  }
  return { judged: true, note: 'judged against the speed limit on the real GPU' }
}

async function reopenOnce(
  browser: Browser,
  target: Target,
  runDir: string,
  cacheDir: string,
  scratch: string,
): Promise<{
  first_load_ms: number
  repeat_load_ms: number
  requests_first: RequestRecord[]
  requests_repeat: RequestRecord[]
  facts: GpuFacts
}> {
  const launched = await launchPesto(runDir, cacheDir, mkdtempSync(path.join(scratch, 'home-')))
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await installProbes(page)
    await page.goto(launched.url)
    const first = await drawnAt(page)
    const requestsFirst = await apiRequests(page)
    const facts = await gpuFacts(page)
    await page.reload()
    const repeat = await drawnAt(page)
    const requestsRepeat = await apiRequests(page)
    return { first_load_ms: first, repeat_load_ms: repeat, requests_first: requestsFirst, requests_repeat: requestsRepeat, facts }
  } finally {
    await context.close()
    await stopPesto(launched)
  }
}

for (const target of TARGETS) {
  test.describe(`${target.label}: reopen and sliders (${target.mode})`, () => {
    test.skip(!existsSync(BUILT_INDEX), `the built frontend is missing at ${BUILT_INDEX} -- run "npm run build" first`)
    test.describe.configure({ mode: 'serial' })

    const record: Record<string, unknown> = { mode: target.mode, judged: false, judged_note: '' }
    let facts: GpuFacts | null = null
    let runDir = target.runDir
    let cacheDir = target.cacheDir
    let scratch = ''
    let sliderServer: Launched | null = null

    function settle(testInfo: TestInfo): boolean {
      const verdict = judging(target, testInfo.project.name, facts)
      record.judged = verdict.judged
      record.judged_note = verdict.note
      return verdict.judged
    }

    test.beforeAll(async () => {
      scratch = mkdtempSync(path.join(tmpdir(), 'pesto-slider-'))
      if (target.mode === 'synthetic') {
        runDir = path.join(scratch, 'synthetic')
        await runToCompletion('uv', ['run', 'python', '-m', 'tests.fixtures.synthetic_run', runDir])
        // The cache goes beside the run, never inside it.
        cacheDir = path.join(scratch, 'synthetic-cache')
        cpSync(path.join(runDir, '.pesto'), cacheDir, { recursive: true })
      } else {
        if (!existsSync(runDir)) throw new Error(`${target.label}: the run folder ${runDir} does not exist`)
        if (!existsSync(cacheDir)) throw new Error(`${target.label}: the scratch cache ${cacheDir} does not exist; run pesto bench first`)
      }
    })

    test.afterAll(async ({}, testInfo) => {
      await stopPesto(sliderServer)
      settle(testInfo)
      flush(testInfo.project.name, target.label, record, facts)
    })

    test(`reopen: first load after each server start and a repeat load (${target.mode})`, async ({ browser }, testInfo) => {
      const starts = target.mode === 'bench' ? 5 : 2
      const done: Array<Record<string, unknown>> = []
      for (let i = 0; i < starts; i += 1) {
        const one = await reopenOnce(browser, target, runDir, cacheDir, scratch)
        facts = one.facts
        done.push({
          first_load_ms: one.first_load_ms,
          repeat_load_ms: one.repeat_load_ms,
          requests_first: one.requests_first,
          requests_repeat: one.requests_repeat,
        })
      }
      const firsts = done.map((d) => d.first_load_ms as number)
      const repeats = done.map((d) => d.repeat_load_ms as number)
      const firstMedian = median(firsts)!
      const limitMs = target.limits.reopenMs
      const judged = settle(testInfo)
      const status = !judged ? 'not judged' : firstMedian <= limitMs ? 'pass' : 'miss'
      record.reopen = {
        starts: done,
        first_load_median_ms: firstMedian,
        first_load_max_ms: Math.max(...firsts),
        repeat_load_median_ms: median(repeats),
        speed_limit_ms: limitMs,
        status,
        note: judged
          ? `median first load after ${starts} server starts, judged at or under the speed limit; the slowest is reported beside it`
          : String(record.judged_note),
      }
      flush(testInfo.project.name, target.label, record, facts)
      expect.soft(status, `${target.label}: median first load ${firstMedian.toFixed(0)} ms against ${limitMs} ms`).not.toBe('miss')
    })

    test(`slider: realization, which fetches (${target.mode})`, async ({ page }, testInfo) => {
      const server = await launchPesto(runDir, cacheDir, mkdtempSync(path.join(scratch, 'home-')))
      sliderServer = server
      await installProbes(page)
      await page.goto(server.url)
      await drawnAt(page)
      facts = await gpuFacts(page)
      const count = Number(await page.locator('input[aria-label="Realization"]').getAttribute('max')) + 1
      const moves = target.mode === 'bench' ? 200 : 10
      const steps: MoveStep[] = []
      for (let i = 0; i < moves; i += 1) steps.push({ value: String((i + 1) % count) })
      const { delays, timeouts } = await timeMoves(page, {
        selector: 'input[aria-label="Realization"]',
        steps,
        timeoutMs: FRAME_TIMEOUT_MS,
        gapMs: 60,
        selectionFromLabel: true,
      })
      settle(testInfo)
      record.realization_delays_ms = delays
      flush(testInfo.project.name, target.label, record, facts)
      expect(timeouts).toBe(0)
      expect(delays).toHaveLength(moves)
      for (const d of delays) expect(typeof d).toBe('number')
    })
  })
}
