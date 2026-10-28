// @vitest-environment jsdom
//
// The time slider on the map coloured by observations: a step to a held frame draws at once with
// no request, a cold or failed frame never shows the wrong time, every kind of group has its own
// reading, and each drawn frame is stamped for the browser check. The real map screen, the real
// mesh layer on a recording GL, and a stubbed fetch that answers the /obs routes.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { MeshLayer } from '../src/gl/mesh-layer'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'
import { createRecordingGl } from './support/recording-gl'

const recording = createRecordingGl()

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({
    // finish() is what the frame stamp waits on; the recording GL has none of its own.
    gl: Object.assign(recording.gl, { finish: vi.fn() }),
    onLost: vi.fn(),
    onRestored: vi.fn(),
  })),
}))

const CONFIG: RunConfig = {
  case: 'test_run',
  n_par: null,
  n_real: null,
  base_realization: null,
  n_iterations: null,
  noptmax: null,
  first_iteration: 0,
  projection: null,
  projection_known: false,
  noise: { has_noise: null, decided_by: '', evidence: [], notes: [] },
}

const STATE: IngestState = {
  fresh: true,
  artifacts: [],
  capabilities: {
    map: { available: true, blockedBy: [] },
    stats: { available: true, blockedBy: [] },
    chips: { available: true, blockedBy: [] },
    obs: { available: true, blockedBy: [] },
  },
  ingestSeconds: null,
  cacheBytes: null,
}

const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 2, bounds: [0, 2, 0, 1], origin: [1000, 2000], crs: null, tag: 'obs-slider' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PAR_TABLE = tableToIPC(tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }), 'stream')
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

const ROWS = 3
const NAN = Number.NaN

interface GroupSpec {
  times: number[]
  kind: string
  stepsBy: 'time' | 'position'
  refused: string | null
}

const range = (n: number, step = 10): number[] => Array.from({ length: n }, (_, i) => (i + 1) * step)

// 'many' is first, so it is the group Observations opens on.
const GROUPS: Record<string, GroupSpec> = {
  many: { times: range(10), kind: 'numeric', stepsBy: 'time', refused: null },
  g139: { times: [1, 9, 10], kind: 'numeric', stepsBy: 'time', refused: null },
  g59: { times: [5, 9], kind: 'numeric', stepsBy: 'time', refused: null },
  g923: { times: [2, 3], kind: 'numeric', stepsBy: 'time', refused: null },
  g920: { times: [9, 20], kind: 'numeric', stepsBy: 'time', refused: null },
  ord: { times: [1, 2, 3], kind: 'ordinal (no time found)', stepsBy: 'position', refused: null },
  dates: { times: [19000, 19001, 19002], kind: 'datetime', stepsBy: 'time', refused: null },
  one: { times: [7], kind: 'numeric', stepsBy: 'time', refused: null },
  mixed: { times: [], kind: 'ordinal (mixed time kinds)', stepsBy: 'position', refused: 'the sites of this group mix time kinds, so one slider cannot step through them' },
}

// Row 2 has no value at odd positions, so the legend count changes from one step to the next.
function frameValues(spec: GroupSpec, time: number): number[] {
  const position = spec.times.indexOf(time)
  return [time, time + 1, position % 2 === 1 ? NAN : time + 2]
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function ipc(columns: Record<string, unknown[]>): Uint8Array {
  return Uint8Array.from(tableToIPC(tableFromArrays(columns), 'stream'))
}

function sitesTable(): Uint8Array {
  const rows = Array.from({ length: ROWS }, (_, i) => i)
  return ipc({
    site_id: rows.map((i) => 100 + i),
    site: rows.map((i) => `site_${i}`),
    n_obs: rows.map(() => 3),
    x: rows.map((i) => 0.2 + 0.2 * i),
    y: rows.map(() => 0.5),
    xy_source: rows.map(() => 'own'),
    layer: rows.map(() => 0),
    cell: rows.map(() => 0),
    rule: rows.map(() => 'own xy'),
    note: rows.map(() => null),
  })
}

function groupsTable(): Uint8Array {
  const names = Object.keys(GROUPS)
  return ipc({
    group: names,
    n_obs: names.map(() => 10),
    n_sites: names.map(() => ROWS),
    n_placed: names.map(() => ROWS),
    n_weighted: names.map(() => 10),
    n_with_target: names.map(() => 10),
    n_zero_weight: names.map(() => 0),
    n_sentinel: names.map(() => 0),
    n_no_value: names.map(() => 0),
    time_kind: names.map((n) => GROUPS[n].kind),
    inequality: names.map(() => 'none'),
    first_iteration: names.map(() => 0),
    last_iteration: names.map(() => 0),
    rmse_first: names.map(() => 1),
    rmse_last: names.map(() => 0.5),
    n_resid_first: names.map(() => 10),
    n_resid_last: names.map(() => 10),
  })
}

interface Gate {
  promise: Promise<void>
  release: () => void
}

let calls: string[] = []
/** The time of each /obs/frame request, in order. */
let frameCalls: number[] = []
let gates = new Map<number, Gate>()
let failTimes = new Set<number>()
let ignoreAbort = false
/** Holds every /obs/times answer until it resolves. */
let timesHold: Promise<void> | null = null

function gate(time: number): Gate {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  const made = { promise, release }
  gates.set(time, made)
  return made
}

function abortion(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined || ignoreAbort) return
    const fail = (): void => reject(new DOMException('aborted', 'AbortError'))
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail)
  })
}

function stubFetch(): void {
  calls = []
  frameCalls = []
  gates = new Map()
  failTimes = new Set()
  ignoreAbort = false
  timesHold = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: { signal?: AbortSignal }) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path, search] = url.split('?')
      if (path.startsWith('/api/run/obs/')) calls.push(url)
      const query = new URLSearchParams(search ?? '')
      const respond = (result: { status: number; bytes?: Uint8Array; body?: unknown; headers?: Record<string, string> }) => {
        const bytes = result.bytes ?? new Uint8Array(0)
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          json: async () => result.body ?? {},
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          headers: { get: (name: string) => result.headers?.[name] ?? null },
        }
      }
      const meta = (dtype: string) => ({ 'X-Pesto-Meta': JSON.stringify({ dtype }) })
      const group = query.get('group') ?? ''
      switch (path) {
        case '/api/run/grid/mesh':
          return respond({ status: 200, body: MESH_BODY })
        case '/api/run/grid/mesh/positions':
          return respond({ status: 200, bytes: bytesOf(POSITIONS), headers: meta('<f4') })
        case '/api/run/grid/mesh/cell_index':
          return respond({ status: 200, bytes: bytesOf(CELL_INDEX), headers: meta('<f4') })
        case '/api/run/grid/mesh/indices':
          return respond({ status: 200, bytes: bytesOf(INDICES), headers: meta('<u4') })
        case '/api/run/grid/parmap':
          return respond({ status: 200, bytes: bytesOf(new Int32Array([0, 1])) })
        case '/api/run/meta':
          return respond({ status: 200, bytes: PAR_TABLE })
        case '/api/run/grid/cells/cell':
          return respond({ status: 200, bytes: bytesOf(new Int32Array([0, 1])) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(new Int32Array([0, 1])) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 404, body: { title: 'no point positions were recorded for that iteration', status: 404 } })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(new Float32Array([10, 20])) })
        case '/api/run/grid/pp':
          return respond({ status: 200, body: { groups: [], not_interpolable: [], notes: [] } })
        case '/api/run/view':
          throw new Error('no saved view')
        case '/api/run/obs/groups':
          return respond({ status: 200, bytes: groupsTable() })
        case '/api/run/obs/sites':
          return respond({ status: 200, bytes: sitesTable(), headers: { 'X-Pesto-Meta': JSON.stringify({ order_digest: 'digest-a' }) } })
        case '/api/run/obs/times': {
          if (timesHold !== null) await timesHold
          const spec = GROUPS[group]
          return respond({
            status: 200,
            body: {
              group,
              order_digest: 'digest-a',
              time_kind: spec.kind,
              steps_by: spec.stepsBy,
              times: spec.times,
              n_at_time: spec.times.map(() => ROWS),
              n_sites: ROWS,
              iterations: [{ iteration: 0, available: true, reason: null }],
              limits: { resid_mean: [-1, 1], rmse: [0, 2], std: [0, 1], mean: [9, 11] },
              limits_rule: 'pooled over the first and last iteration',
              refused: spec.refused,
              notes: [],
            },
          })
        }
        case '/api/run/obs/frame': {
          const time = Number(query.get('time'))
          frameCalls.push(time)
          const held = gates.get(time)
          if (held !== undefined) await Promise.race([held.promise, abortion(init?.signal)])
          if (failTimes.has(time)) {
            return respond({ status: 404, body: { title: 'not found', status: 404, detail: 'the frame could not be read', artifact: 'obs_agg/0' } })
          }
          const spec = GROUPS[group]
          const stat = query.get('stat') ?? 'resid_mean'
          const values = new Float32Array(frameValues(spec, time))
          return respond({
            status: 200,
            bytes: bytesOf(values),
            headers: {
              'X-Pesto-Meta': JSON.stringify({
                dtype: '<f4',
                group,
                order_digest: 'digest-a',
                iteration: Number(query.get('iteration')),
                time,
                stat,
                n_sites: ROWS,
                n_at_time: ROWS,
                n_finite: values.filter((v) => Number.isFinite(v)).length,
              }),
            },
          })
        }
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

function manualStore(): SelectionStore {
  return createSelectionStore({ initial: emptySelection('test_run', 0), schedule: (run) => queueMicrotask(run) })
}

async function mounted(): Promise<{ root: HTMLElement; store: SelectionStore }> {
  stubFetch()
  const store = manualStore()
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: STATE, store })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  return { root, store }
}

const legendText = (root: HTMLElement): string => root.querySelector('.floating-bottom-left')?.textContent ?? ''
const sliderEl = (root: HTMLElement): HTMLElement => root.querySelector('.time-slider') as HTMLElement
const sliderText = (root: HTMLElement): string => sliderEl(root).textContent ?? ''
const rangeInput = (root: HTMLElement): HTMLInputElement | null => root.querySelector('.time-slider input[type="range"]')

function switchButton(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('.obs-colour-switch button')].find((b) => b.textContent === text)
  if (!found) throw new Error(`no switch button ${text}`)
  return found as HTMLButtonElement
}

async function enterObservations(root: HTMLElement): Promise<void> {
  switchButton(root, 'Observations').click()
  await vi.waitFor(() => expect(legendText(root)).toContain('iteration 0'))
  await vi.waitFor(() => expect(rangeInput(root)).not.toBeNull())
}

function chooseGroup(root: HTMLElement, group: string): void {
  const select = root.querySelector('select[aria-label="Observation group"]') as HTMLSelectElement
  select.value = group
  select.dispatchEvent(new Event('change'))
}

function moveSlider(root: HTMLElement, index: number): void {
  const input = rangeInput(root)!
  input.value = String(index)
  input.dispatchEvent(new Event('input'))
}

// Lets the prefetch requests land and the cache take them.
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('the time slider on the observation map', () => {
  let setPoints: ReturnType<typeof vi.spyOn>
  let setPointValues: ReturnType<typeof vi.spyOn>
  let draw: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
    delete window.__pestoFrames
    setPoints = vi.spyOn(MeshLayer.prototype, 'setPoints')
    setPointValues = vi.spyOn(MeshLayer.prototype, 'setPointValues')
    draw = vi.spyOn(MeshLayer.prototype, 'draw')
  })

  afterEach(() => {
    delete window.__pestoFrames
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const lastValues = (): number[] => Array.from(setPointValues.mock.calls.at(-1)![0] as Float32Array)
  const valuesDrawn = (): number[][] => setPointValues.mock.calls.map((c: unknown[]) => Array.from(c[0] as Float32Array))

  describe('a step to a frame that is already held', () => {
    it('shows only when the map is coloured by observations', async () => {
      const { root } = await mounted()
      expect(sliderEl(root).hidden).toBe(true)
      expect(rangeInput(root)).toBeNull()
      await enterObservations(root)
      expect(sliderEl(root).hidden).toBe(false)
      switchButton(root, 'Parameters').click()
      await vi.waitFor(() => expect(sliderEl(root).hidden).toBe(true))
      expect(rangeInput(root)).toBeNull()
    })

    it('shows one step per time of the group and the first time as text', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      const input = rangeInput(root)!
      expect(input.type).toBe('range')
      expect(input.min).toBe('0')
      expect(input.max).toBe('9')
      expect(input.value).toBe('0')
      expect(sliderText(root)).toContain('day 10 (model time)')
    })

    it('is a labelled input, reachable by keyboard, that steps one time at a time', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      const input = rangeInput(root)!
      expect(input.getAttribute('aria-label')).toBe('Observation time of many')
      expect(input.step).toBe('1')
      expect(input.disabled).toBe(false)
      expect(input.tabIndex).toBeGreaterThanOrEqual(0)
    })

    it('draws a prefetched frame with the values in dot order, one redraw and no new request for it', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      await settle()
      expect(frameCalls).toContain(20)
      const requestsForIt = frameCalls.filter((t) => t === 20).length
      const origins: string[] = []
      store.subscribe((s) => s.timeIdx, (_n, _p, o) => origins.push(...o))
      const valueCalls = setPointValues.mock.calls.length
      const draws = draw.mock.calls.length

      moveSlider(root, 1)

      // Drawn before anything is awaited: the frame was already held.
      expect(setPointValues.mock.calls.length).toBe(valueCalls + 1)
      expect(draw.mock.calls.length).toBe(draws + 1)
      expect(lastValues().slice(0, 2)).toEqual([20, 21])
      expect(Number.isNaN(lastValues()[2])).toBe(true)
      expect(frameCalls.filter((t) => t === 20).length).toBe(requestsForIt)
      expect(store.get().timeIdx).toBe(1)
      await settle()
      expect(origins).toEqual(['time-slider'])
      expect(sliderText(root)).toContain('day 20 (model time)')
    })

    it('keeps the window of frames around the new time prefetched', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      await settle()
      expect(frameCalls).not.toContain(40)
      moveSlider(root, 1)
      await settle()
      // Two each side of position 1: position 3 is time 40.
      expect(frameCalls).toContain(40)
    })

    it('never uploads the dot positions again on a step', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      await settle()
      const uploads = setPoints.mock.calls.length
      moveSlider(root, 1)
      moveSlider(root, 2)
      await settle()
      expect(setPoints.mock.calls.length).toBe(uploads)
      expect(setPointValues).toHaveBeenCalled()
    })

    it("changes the legend's count of sites with a value at each step", async () => {
      const { root } = await mounted()
      await enterObservations(root)
      await settle()
      expect(legendText(root)).toContain('3 of 3 sites have a value at this time')
      moveSlider(root, 1)
      expect(legendText(root)).toContain('2 of 3 sites have a value at this time')
      expect(legendText(root)).toContain('day 20 (model time)')
      moveSlider(root, 2)
      expect(legendText(root)).toContain('3 of 3 sites have a value at this time')
    })

    it('follows a time written by another view', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      store.set({ timeIdx: 4 }, 'obs')
      await vi.waitFor(() => expect(sliderText(root)).toContain('day 50 (model time)'))
      expect(rangeInput(root)!.value).toBe('4')
    })
  })

  describe('a step to a frame that is not held', () => {
    it('keeps the old colours, says it is reading, and draws the frame when it lands', async () => {
      const { root } = await mounted()
      const held = gate(40)
      await enterObservations(root)
      await settle()
      const valueCalls = setPointValues.mock.calls.length
      moveSlider(root, 3)
      expect(sliderEl(root).querySelector('[role="status"]')!.textContent).toBe('reading this time…')
      expect(setPointValues.mock.calls.length).toBe(valueCalls)
      held.release()
      await vi.waitFor(() => expect(lastValues().slice(0, 2)).toEqual([40, 41]))
      expect(sliderEl(root).querySelector('[role="status"]')!.textContent).toBe('')
    })

    it('never draws a frame for a time the slider has left', async () => {
      const { root, store } = await mounted()
      ignoreAbort = true
      const three = gate(40)
      const seven = gate(80)
      await enterObservations(root)
      await settle()
      moveSlider(root, 3)
      moveSlider(root, 7)
      expect(store.get().timeIdx).toBe(7)
      // The overtaken frame lands first, and must still not be drawn.
      three.release()
      await settle()
      expect(valuesDrawn().some((v) => v[0] === 40)).toBe(false)
      seven.release()
      await vi.waitFor(() => expect(lastValues().slice(0, 2)).toEqual([80, 81]))
      expect(valuesDrawn().some((v) => v[0] === 40)).toBe(false)
      expect(sliderText(root)).toContain('day 80 (model time)')
    })

    it('shows the reason of a failed frame and leaves the last colours on screen', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      await settle()
      failTimes.add(40)
      const valueCalls = setPointValues.mock.calls.length
      moveSlider(root, 3)
      await vi.waitFor(() => expect(sliderEl(root).querySelector('[role="status"]')!.textContent).toContain('the frame could not be read'))
      expect(setPointValues.mock.calls.length).toBe(valueCalls)
      expect(valuesDrawn().some((v) => v[0] === 40)).toBe(false)
    })

    it('asks again the next time it steps to a frame that failed', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      await settle()
      failTimes.add(40)
      moveSlider(root, 3)
      await vi.waitFor(() => expect(sliderEl(root).querySelector('[role="status"]')!.textContent).toContain('the frame could not be read'))
      const asked = frameCalls.filter((t) => t === 40).length
      failTimes.delete(40)
      moveSlider(root, 2)
      await settle()
      moveSlider(root, 3)
      await vi.waitFor(() => expect(lastValues().slice(0, 2)).toEqual([40, 41]))
      expect(frameCalls.filter((t) => t === 40).length).toBeGreaterThan(asked)
    })
  })

  describe('each kind of group', () => {
    it('says an ordinal group steps by position', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      chooseGroup(root, 'ord')
      await vi.waitFor(() => expect(sliderText(root)).toContain('steps by position in site (no time found)'))
      expect(rangeInput(root)!.max).toBe('2')
    })

    it('shows dates for a datetime group', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      chooseGroup(root, 'dates')
      await vi.waitFor(() => expect(sliderText(root)).toContain('2022-01-08'))
    })

    it('shows the time and no range input for a group with one time', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      chooseGroup(root, 'one')
      await vi.waitFor(() => expect(sliderText(root)).toContain('day 7 (model time)'))
      expect(rangeInput(root)).toBeNull()
      await vi.waitFor(() => expect(legendText(root)).toContain('day 7 (model time)'))
    })

    it('shows the server refusal and no range input for a mixed group, and asks for no frame', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      await settle()
      const asked = frameCalls.length
      chooseGroup(root, 'mixed')
      await vi.waitFor(() => expect(sliderText(root)).toContain('the sites of this group mix time kinds'))
      expect(rangeInput(root)).toBeNull()
      await settle()
      expect(sliderEl(root).hidden).toBe(false)
      expect(frameCalls.slice(asked).length).toBe(0)
    })

    it('shows the refusal as text, never as markup', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      GROUPS.mixed.refused = '<b>mixed</b> times'
      try {
        chooseGroup(root, 'mixed')
        await vi.waitFor(() => expect(sliderText(root)).toContain('<b>mixed</b> times'))
        expect(sliderEl(root).querySelector('b')).toBeNull()
      } finally {
        GROUPS.mixed.refused = 'the sites of this group mix time kinds, so one slider cannot step through them'
      }
    })
  })

  describe('a group change', () => {
    async function atTime(root: HTMLElement, group: string, index: number): Promise<void> {
      chooseGroup(root, group)
      await vi.waitFor(() => expect(rangeInput(root)?.getAttribute('aria-label')).toBe(`Observation time of ${group}`))
      await settle()
      moveSlider(root, index)
      await settle()
    }

    it('keeps the same time when the new group has it, whatever its position there', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      await atTime(root, 'g139', 1)
      expect(sliderText(root)).toContain('day 9 (model time)')
      chooseGroup(root, 'g59')
      await vi.waitFor(() => expect(rangeInput(root)?.getAttribute('aria-label')).toBe('Observation time of g59'))
      expect(sliderText(root)).toContain('day 9 (model time)')
      expect(store.get().timeIdx).toBe(1)
    })

    it('never reuses the slider position as a position in another group', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      await atTime(root, 'g139', 1)
      chooseGroup(root, 'g920')
      await vi.waitFor(() => expect(rangeInput(root)?.getAttribute('aria-label')).toBe('Observation time of g920'))
      // Time 9 is the first time of the new group, not its second.
      expect(rangeInput(root)!.value).toBe('0')
      expect(store.get().timeIdx).toBe(0)
      expect(sliderText(root)).toContain('day 9 (model time)')
    })

    it('goes to the first time and says so when the new group lacks the time, writing it as the map', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      await atTime(root, 'g139', 1)
      const origins: string[] = []
      store.subscribe((s) => s.timeIdx, (_n, _p, o) => origins.push(...o))
      chooseGroup(root, 'g923')
      await vi.waitFor(() => expect(rangeInput(root)?.getAttribute('aria-label')).toBe('Observation time of g923'))
      expect(rangeInput(root)!.value).toBe('0')
      expect(sliderText(root)).toContain('no observation at day 9 (model time), so the slider moved to its first time')
      expect(sliderText(root)).toContain('day 2 (model time)')
      await settle()
      expect(store.get().timeIdx).toBe(0)
      expect(origins).toEqual(['map'])
    })

    it('goes to the first time of a group that counts time differently', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      await atTime(root, 'g139', 1)
      chooseGroup(root, 'ord')
      await vi.waitFor(() => expect(sliderText(root)).toContain('count time differently'))
      expect(rangeInput(root)!.value).toBe('0')
    })

    it('does not leave the old group steppable while the new one loads', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      await settle()
      let release!: () => void
      timesHold = new Promise<void>((resolve) => {
        release = resolve
      })
      chooseGroup(root, 'g59')
      await vi.waitFor(() => expect(sliderEl(root).hidden).toBe(true))
      expect(rangeInput(root)).toBeNull()
      release()
      await vi.waitFor(() => expect(sliderEl(root).hidden).toBe(false))
      expect(rangeInput(root)!.max).toBe('1')
    })
  })

  describe('the frame stamp for the browser check', () => {
    it('stamps a slider step with its time index and the observation group', async () => {
      window.__pestoFrames = []
      const { root } = await mounted()
      await enterObservations(root)
      await settle()
      moveSlider(root, 1)
      const stamp = window.__pestoFrames!.at(-1)!
      expect(stamp.timeIdx).toBe(1)
      expect(stamp.group).toBe('many')
      moveSlider(root, 2)
      expect(window.__pestoFrames!.at(-1)!.timeIdx).toBe(2)
    })

    it('stamps the first observation frame with the index it drew', async () => {
      window.__pestoFrames = []
      const { root } = await mounted()
      await enterObservations(root)
      expect(window.__pestoFrames!.at(-1)!.timeIdx).toBe(0)
    })

    it('stamps no time index under the parameter field, before and after observations', async () => {
      window.__pestoFrames = []
      const { root } = await mounted()
      const before = window.__pestoFrames!.length
      expect(before).toBeGreaterThan(0)
      expect(window.__pestoFrames!.every((s) => s.timeIdx === undefined)).toBe(true)
      await enterObservations(root)
      const during = window.__pestoFrames!.length
      switchButton(root, 'Parameters').click()
      await vi.waitFor(() => expect(window.__pestoFrames!.length).toBeGreaterThan(during))
      expect(window.__pestoFrames!.slice(during).every((s) => s.timeIdx === undefined)).toBe(true)
    })
  })
})
