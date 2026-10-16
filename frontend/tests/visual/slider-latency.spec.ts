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
import { isSoftwareRenderer, parseBenchResult, stripToken, summarize, type BenchTarget } from './bench-json'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const BUILT_INDEX = path.join(REPO_ROOT, 'src', 'pesto', 'static', 'index.html')
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'frontend', 'test-results', 'slider-latency')

const FRAME_TIMEOUT_MS = 5000
const SETUP_TIMEOUT_MS = 60_000
const OUTPUT_TAIL_BYTES = 16_384
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
    let settled = false
    // Output is kept only until the URL is read, and only its tail, so a chatty server cannot grow it.
    const keepTail = (text: string) => text.slice(-OUTPUT_TAIL_BYTES)
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (proc.exitCode === null) proc.kill()
      reject(new Error(message))
    }
    const timer = setTimeout(() => {
      fail(`timed out waiting for "pesto serving" on stdout. stderr so far: ${stderrBuffer}`)
    }, 60_000)
    proc.stdout?.on('data', (chunk) => {
      if (settled) return
      buffer = keepTail(buffer + chunk.toString('utf8'))
      const match = buffer.match(/pesto serving (\S+)/)
      if (match) {
        settled = true
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    proc.stderr?.on('data', (chunk) => {
      if (!settled) stderrBuffer = keepTail(stderrBuffer + chunk.toString('utf8'))
    })
    proc.on('exit', (code) => {
      fail(`pesto exited (code ${code}) before printing its serving URL: ${stderrBuffer}`)
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
  // The draw-only controls: the frame must have been drawn with this value.
  colormap?: string
  reverse?: boolean
  scale?: string
  limits?: string
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
// at or after the move that shows what the move asked for. Every move names
// something its own frame must carry, so a frame still in flight from an
// earlier move is never counted as the answer.
async function timeMoves(page: Page, plan: MovePlan): Promise<{ delays: number[]; timeouts: number }> {
  return page.evaluate(async (p) => {
    const el = document.querySelector(p.selector) as HTMLInputElement | HTMLSelectElement | null
    if (!el) throw new Error(`no control matches ${p.selector}`)
    const frames = (
      window as unknown as {
        __pestoFrames: Array<{
          t: number
          selection: string
          layer: number
          group: string | null
          colormap?: string
          reverse?: boolean
          scale?: string
          limits?: string
        }>
      }
    ).__pestoFrames
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
            (step.group === undefined || f.group === step.group) &&
            (step.colormap === undefined || f.colormap === step.colormap) &&
            (step.reverse === undefined || f.reverse === step.reverse) &&
            (step.scale === undefined || f.scale === step.scale) &&
            (step.limits === undefined || f.limits === step.limits),
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

interface ControlInfo {
  present: boolean
  disabled: boolean
  value: string
  checked: boolean
  min: number
  max: number
  options: Array<{ value: string; disabled: boolean }>
}

async function controlInfo(page: Page, selector: string): Promise<ControlInfo> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLInputElement | HTMLSelectElement | null
    if (!el) return { present: false, disabled: true, value: '', checked: false, min: 0, max: 0, options: [] }
    const options =
      el instanceof HTMLSelectElement ? Array.from(el.options).map((o) => ({ value: o.value, disabled: o.disabled })) : []
    const input = el instanceof HTMLInputElement ? el : null
    return {
      present: true,
      disabled: el.disabled,
      value: el.value,
      checked: input?.checked ?? false,
      min: input ? Number(input.min) : 0,
      max: input ? Number(input.max) : 0,
      options,
    }
  }, selector)
}

const SEL = {
  group: 'select[aria-label="Parameter group"]',
  layer: 'input[aria-label="Layer"]',
  statistic: 'select[aria-label="Statistic"]',
  realization: 'input[aria-label="Realization"]',
  colormap: 'select[aria-label="Colormap"]',
  reverse: 'input[aria-label="Reverse colormap"]',
  scale: 'select[aria-label="Value scale"]',
  limits: 'select[aria-label="Limits"]',
}

// One move that waits for its frame, to put a control where a later
// measurement needs it. It waits much longer than a timed move: the first draw
// of a group can include loading the science libraries. Gives the delay in ms,
// or null when no frame arrived.
async function setControl(page: Page, selector: string, step: MoveStep): Promise<number | null> {
  const { delays } = await timeMoves(page, { selector, steps: [step], timeoutMs: SETUP_TIMEOUT_MS, gapMs: 60 })
  return delays.length === 1 ? delays[0] : null
}

// Python's urllib quote with safe="" keeps these and nothing else but letters and digits (cache/layout.py pp_field).
function quoteLikeCache(name: string): string {
  return encodeURIComponent(name).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function pilotFieldFolder(cacheDir: string, group: string): string {
  return path.join(cacheDir, 'grid', 'pp', 'fields', quoteLikeCache(group))
}

interface SliderRow {
  control: string
  kind: 'fetch' | 'no_fetch'
  moves: number
  p50_ms: number | null
  p95_ms: number | null
  max_ms: number | null
  timeouts: number
  speed_limit_ms: number
  status: 'pass' | 'miss' | 'not judged' | 'skipped'
  note: string
}

function skippedRow(control: string, kind: SliderRow['kind'], limit: number, reason: string): SliderRow {
  return { control, kind, moves: 0, p50_ms: null, p95_ms: null, max_ms: null, timeouts: 0, speed_limit_ms: limit, status: 'skipped', note: `skipped: ${reason}` }
}

// Strictly under the limit passes; any move whose frame never came is a miss.
function measuredRow(
  control: string,
  kind: SliderRow['kind'],
  limit: number,
  delays: number[],
  timeouts: number,
  judged: boolean,
  judgedNote: string,
): SliderRow {
  const s = summarize(delays)
  const timeoutNote = timeouts > 0 ? `${timeouts} move(s) had no frame within ${FRAME_TIMEOUT_MS / 1000} s` : ''
  let status: SliderRow['status'] = 'not judged'
  let note = [judgedNote, timeoutNote].filter((n) => n !== '').join('; ')
  if (judged) {
    const miss = timeouts > 0 || s.p95 === null || s.p95 >= limit
    status = miss ? 'miss' : 'pass'
    note = miss
      ? [s.p95 !== null && s.p95 >= limit ? `p95 ${s.p95.toFixed(1)} ms is not under ${limit} ms` : '', timeoutNote].filter((n) => n !== '').join('; ')
      : `p95 is under ${limit} ms (nearest rank over single moves)`
  }
  return { control, kind, moves: delays.length + timeouts, p50_ms: s.p50, p95_ms: s.p95, max_ms: s.max, timeouts, speed_limit_ms: limit, status, note }
}

// Steps through a select's usable options, one move each, starting after the current one.
function cycleSteps(values: string[], current: string, count: number): MoveStep[] {
  const start = Math.max(values.indexOf(current), 0)
  return Array.from({ length: count }, (_, i) => ({ value: values[(start + 1 + i) % values.length] }))
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
    // Read before any test in this describe opens the page, so earlier draws cannot warm it unseen.
    let ppFolderExistedAtStart = false
    let reopenMiss: string | null = null

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
      if (target.pilotPoint !== null) ppFolderExistedAtStart = existsSync(pilotFieldFolder(cacheDir, target.pilotPoint.group))
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
      // The miss fails the check in the last test of this describe. Failing here would skip this run's slider tests, because they run in serial mode.
      reopenMiss = status === 'miss' ? `${target.label}: median first load ${firstMedian.toFixed(0)} ms against ${limitMs} ms` : null
    })

    const bench = target.mode === 'bench'
    const sliderRows: SliderRow[] = []
    record.sliders = sliderRows
    const setup: Record<string, unknown> = {
      group: null,
      layer: null,
      iteration: target.iteration,
      note: 'the page draws the run\'s first iteration; the bench iteration is recorded here, not selected',
    }
    record.setup = setup

    // A fresh page on the slider server, with the statistic back on a single
    // realization and the heaviest group on its layer (D-12).
    async function openForSliders(page: Page, testInfo: TestInfo): Promise<void> {
      if (!sliderServer) sliderServer = await launchPesto(runDir, cacheDir, mkdtempSync(path.join(scratch, 'home-')))
      await installProbes(page)
      await page.goto(sliderServer.url)
      await drawnAt(page)
      facts = await gpuFacts(page)
      settle(testInfo)

      const stat = await controlInfo(page, SEL.statistic)
      if (stat.present && stat.value !== 'value') await setControl(page, SEL.statistic, { value: 'value' })

      if (target.heaviest === null) {
        setup.note = `no group places on any cell; measured on the page's default group. ${setup.note}`
        return
      }
      const groups = await controlInfo(page, SEL.group)
      const offered = groups.options.some((o) => o.value === target.heaviest!.group)
      if (!offered) {
        setup.note = `the picker does not offer ${target.heaviest.group}; measured on the page's default group. ${setup.note}`
        return
      }
      if (groups.value !== target.heaviest.group) {
        const drawn = await setControl(page, SEL.group, { value: target.heaviest.group, group: target.heaviest.group })
        if (drawn === null) setup.note = `no frame within ${SETUP_TIMEOUT_MS / 1000} s after choosing ${target.heaviest.group}. ${setup.note}`
      }
      const layer = await controlInfo(page, SEL.layer)
      if (!layer.disabled && Number(layer.value) !== target.heaviest.layer) {
        const drawn = await setControl(page, SEL.layer, { value: String(target.heaviest.layer), layer: target.heaviest.layer })
        if (drawn === null) setup.note = `no frame within ${SETUP_TIMEOUT_MS / 1000} s after moving to layer ${target.heaviest.layer}. ${setup.note}`
      }
      setup.group = target.heaviest.group
      setup.layer = target.heaviest.layer
    }

    test(`slider: realization and statistic, which fetch (${target.mode})`, async ({ page }, testInfo) => {
      await openForSliders(page, testInfo)
      const limit = target.limits.fetchP95Ms
      const judged = settle(testInfo)
      const judgedNote = String(record.judged_note)

      const real = await controlInfo(page, SEL.realization)
      if (!real.present || real.disabled || real.max < 1) {
        sliderRows.push(skippedRow('Realization', 'fetch', limit, !real.present ? 'the control is not on the page' : real.disabled ? 'the control is disabled (one realization, or a statistic other than value)' : 'fewer than two realizations'))
      } else {
        const count = real.max + 1
        const current = Number(real.value)
        const moves = bench ? 200 : 10
        const steps: MoveStep[] = Array.from({ length: moves }, (_, i) => ({ value: String((current + 1 + i) % count) }))
        const { delays, timeouts } = await timeMoves(page, {
          selector: SEL.realization,
          steps,
          timeoutMs: FRAME_TIMEOUT_MS,
          gapMs: 60,
          selectionFromLabel: true,
        })
        sliderRows.push(measuredRow('Realization', 'fetch', limit, delays, timeouts, judged, judgedNote))
      }
      flush(testInfo.project.name, target.label, record, facts)

      const stat = await controlInfo(page, SEL.statistic)
      const aggregates = stat.options.filter((o) => !o.disabled && o.value !== 'value').map((o) => o.value)
      if (!stat.present || stat.disabled || aggregates.length < 2) {
        sliderRows.push(skippedRow('Statistic', 'fetch', limit, !stat.present ? 'the control is not on the page' : stat.disabled ? 'the control is disabled' : 'fewer than two statistics other than value'))
      } else {
        const moves = bench ? 100 : 7
        const steps: MoveStep[] = Array.from({ length: moves }, (_, i) => {
          const value = aggregates[i % aggregates.length]
          return { value, selection: value }
        })
        const { delays, timeouts } = await timeMoves(page, { selector: SEL.statistic, steps, timeoutMs: FRAME_TIMEOUT_MS, gapMs: 60 })
        sliderRows.push(measuredRow('Statistic', 'fetch', limit, delays, timeouts, judged, judgedNote))
        await setControl(page, SEL.statistic, { value: 'value' })
      }
      flush(testInfo.project.name, target.label, record, facts)

      for (const row of sliderRows) {
        expect.soft(row.timeouts, `${target.label}: ${row.control} had moves with no frame`).toBe(0)
        expect.soft(row.status, `${target.label}: ${row.control} ${row.note}`).not.toBe('miss')
      }
    })

    test(`slider: layer, colormap, reverse, value scale and limits, which only draw (${target.mode})`, async ({ page }, testInfo) => {
      await openForSliders(page, testInfo)
      const limit = target.limits.noFetchP95Ms
      const judged = settle(testInfo)
      const judgedNote = String(record.judged_note)
      const before = sliderRows.length
      const moves = (benchMoves: number, syntheticMoves: number) => (bench ? benchMoves : syntheticMoves)

      async function selectControl(
        control: string,
        selector: string,
        field: 'colormap' | 'scale' | 'limits',
        count: number,
        skip: (info: ControlInfo, usable: string[]) => string | null,
      ): Promise<void> {
        const info = await controlInfo(page, selector)
        const usable = info.options.filter((o) => !o.disabled && o.value !== 'manual').map((o) => o.value)
        const why = !info.present ? 'the control is not on the page' : info.disabled ? 'the control is disabled' : skip(info, usable)
        if (why !== null) {
          sliderRows.push(skippedRow(control, 'no_fetch', limit, why))
          return
        }
        const { delays, timeouts } = await timeMoves(page, {
          selector,
          steps: cycleSteps(usable, info.value, count).map((step) => ({ ...step, [field]: step.value })),
          timeoutMs: FRAME_TIMEOUT_MS,
          gapMs: 40,
        })
        sliderRows.push(measuredRow(control, 'no_fetch', limit, delays, timeouts, judged, judgedNote))
        await setControl(page, selector, { value: info.value, [field]: info.value })
      }
      const fewerThanTwo = (info: ControlInfo, usable: string[]) => (usable.length < 2 ? 'fewer than two usable options' : null)

      const layer = await controlInfo(page, SEL.layer)
      if (!layer.present || layer.disabled || layer.max <= layer.min) {
        sliderRows.push(skippedRow('Layer', 'no_fetch', limit, !layer.present ? 'the control is not on the page' : layer.disabled ? 'the control is disabled (a one-layer grid)' : 'fewer than two layers'))
      } else {
        const here = Number(layer.value)
        const other = here < layer.max ? here + 1 : here - 1
        const steps: MoveStep[] = Array.from({ length: moves(100, 6) }, (_, i) => {
          const to = i % 2 === 0 ? other : here
          return { value: String(to), layer: to }
        })
        const { delays, timeouts } = await timeMoves(page, { selector: SEL.layer, steps, timeoutMs: FRAME_TIMEOUT_MS, gapMs: 40 })
        sliderRows.push(measuredRow('Layer', 'no_fetch', limit, delays, timeouts, judged, judgedNote))
        if (Number(await page.locator(SEL.layer).inputValue()) !== here) await setControl(page, SEL.layer, { value: String(here), layer: here })
      }

      await selectControl('Colormap', SEL.colormap, 'colormap', moves(50, 6), fewerThanTwo)

      const reverse = await controlInfo(page, SEL.reverse)
      if (!reverse.present || reverse.disabled) {
        sliderRows.push(skippedRow('Reverse colormap', 'no_fetch', limit, !reverse.present ? 'the control is not on the page' : 'the control is disabled'))
      } else {
        const steps: MoveStep[] = Array.from({ length: moves(50, 6) }, (_, i) => {
          const checked = (i % 2 === 0) !== reverse.checked
          return { value: String(checked), reverse: checked }
        })
        const { delays, timeouts } = await timeMoves(page, { selector: SEL.reverse, steps, timeoutMs: FRAME_TIMEOUT_MS, gapMs: 40 })
        sliderRows.push(measuredRow('Reverse colormap', 'no_fetch', limit, delays, timeouts, judged, judgedNote))
        const now = await controlInfo(page, SEL.reverse)
        if (now.checked !== reverse.checked) await setControl(page, SEL.reverse, { value: String(reverse.checked), reverse: reverse.checked })
      }

      await selectControl('Value scale', SEL.scale, 'scale', moves(50, 6), fewerThanTwo)
      await selectControl('Limits', SEL.limits, 'limits', moves(50, 6), fewerThanTwo)
      flush(testInfo.project.name, target.label, record, facts)

      for (const row of sliderRows.slice(before)) {
        expect.soft(row.timeouts, `${target.label}: ${row.control} had moves with no frame`).toBe(0)
        expect.soft(row.status, `${target.label}: ${row.control} ${row.note}`).not.toBe('miss')
      }
    })

    test(`slider: a fast realization drag, information only (${target.mode})`, async ({ page }, testInfo) => {
      await openForSliders(page, testInfo)
      const real = await controlInfo(page, SEL.realization)
      if (!real.present || real.disabled || real.max < 1) {
        record.drag = { moves: 0, values_requests: 0, note: 'skipped: the realization control is disabled or has fewer than two realizations' }
        flush(testInfo.project.name, target.label, record, facts)
        return
      }
      const drag = await page.evaluate(
        async ({ selector, moves, gapMs, timeoutMs }) => {
          const el = document.querySelector(selector) as HTMLInputElement
          const frames = (window as unknown as { __pestoFrames: Array<{ t: number; selection: string }> }).__pestoFrames
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
          const count = Number(el.max) + 1
          const current = Number(el.value)
          performance.clearResourceTimings()
          performance.setResourceTimingBufferSize(2000)
          frames.length = 0
          let want = ''
          for (let i = 0; i < moves; i += 1) {
            setter.call(el, String((current + 1 + i) % count))
            el.dispatchEvent(new Event('input', { bubbles: true }))
            want = (el.parentElement?.querySelector('.tabular-nums')?.textContent ?? '').trim()
            await new Promise((r) => setTimeout(r, gapMs))
          }
          const t0 = performance.now()
          while (!frames.some((f) => f.selection === want)) {
            if (performance.now() - t0 > timeoutMs) return { arrived: false }
            await new Promise((r) => requestAnimationFrame(r))
          }
          return { arrived: true }
        },
        { selector: SEL.realization, moves: 30, gapMs: 16, timeoutMs: FRAME_TIMEOUT_MS },
      )
      await page.waitForTimeout(300)
      const valuesRequests = await page.evaluate(
        () => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/run/grid/values')).length,
      )
      record.drag = {
        moves: 30,
        values_requests: valuesRequests,
        note: `information only; moves 16 ms apart are coalesced to one animation frame with one fetch in flight, newest wins${drag.arrived ? '' : '; the last move\'s frame never arrived within 5 s'}`,
      }
      flush(testInfo.project.name, target.label, record, facts)
      expect.soft(drag.arrived, `${target.label}: the last move of the drag never reached a frame`).toBe(true)
    })

    test('slider: pilot-point field, cold sweep then repeat sweep', async ({ page }, testInfo) => {
      const pilot = target.pilotPoint
      if (pilot === null) {
        record.pilot_point = { skipped: 'skipped: this run has no interpolable pilot-point group' }
        flush(testInfo.project.name, target.label, record, facts)
        test.skip(true, 'this run has no interpolable pilot-point group')
        return
      }
      // Looked at before the page draws anything here, and again at the start of this check.
      const folder = pilotFieldFolder(cacheDir, pilot.group)
      const memoExisted = ppFolderExistedAtStart || existsSync(folder)

      await openForSliders(page, testInfo)
      const limit = target.limits.fetchP95Ms
      const judged = settle(testInfo)
      const groups = await controlInfo(page, SEL.group)
      if (!groups.options.some((o) => o.value === pilot.group)) {
        record.pilot_point = { skipped: `skipped: the picker does not offer ${pilot.group}` }
        flush(testInfo.project.name, target.label, record, facts)
        test.skip(true, `the picker does not offer ${pilot.group}`)
        return
      }
      // The first draw of the group is reported beside the sweeps: it can carry one-off costs such as loading the science libraries.
      const firstDraw = groups.value !== pilot.group ? await setControl(page, SEL.group, { value: pilot.group, group: pilot.group }) : null

      const real = await controlInfo(page, SEL.realization)
      if (!real.present || real.disabled || real.max < 1) {
        record.pilot_point = { group: pilot.group, skipped: 'skipped: the realization control is disabled or has fewer than two realizations' }
        flush(testInfo.project.name, target.label, record, facts)
        return
      }
      const last = Math.min(real.max, bench ? 100 : 2)
      const sweep = Array.from({ length: last }, (_, i) => ({ value: String(i + 1) }))
      const run = () => timeMoves(page, { selector: SEL.realization, steps: sweep, timeoutMs: FRAME_TIMEOUT_MS, gapMs: 60, selectionFromLabel: true })

      const cold = await run()
      const repeat = await run()
      const coldSummary = summarize(cold.delays)
      const repeatRow = measuredRow('pilot-point repeat sweep', 'fetch', limit, repeat.delays, repeat.timeouts, judged, String(record.judged_note))
      record.pilot_point = {
        group: pilot.group,
        first_draw_ms: firstDraw,
        cold: {
          moves: cold.delays.length + cold.timeouts,
          p50_ms: coldSummary.p50,
          p95_ms: coldSummary.p95,
          max_ms: coldSummary.max,
          cold: !memoExisted,
          note: memoExisted
            ? 'the field memo already held this group, so this sweep is not cold'
            : 'first compute of each realization\'s field; reported, not judged (D-17)',
        },
        repeat: {
          moves: repeatRow.moves,
          p50_ms: repeatRow.p50_ms,
          p95_ms: repeatRow.p95_ms,
          max_ms: repeatRow.max_ms,
          speed_limit_ms: limit,
          status: repeatRow.status,
          note: repeatRow.note,
        },
      }
      flush(testInfo.project.name, target.label, record, facts)
      expect.soft(cold.timeouts + repeat.timeouts, `${target.label}: pilot-point sweep moves with no frame`).toBe(0)
      expect.soft(repeatRow.status, `${target.label}: pilot-point repeat sweep ${repeatRow.note}`).not.toBe('miss')
    })

    // Last on purpose: a failure here cannot skip any other test of this run.
    test(`reopen: verdict against the speed limit, after the slider tests (${target.mode})`, async () => {
      test.skip(!('reopen' in record), 'the reopen measurement was not part of this run')
      expect(reopenMiss, 'reopen missed its speed limit').toBeNull()
    })
  })
}
