// @vitest-environment jsdom
//
// The map coloured by observations: one group's sites as dots, a legend that counts every site,
// the layer and iteration rules, and the site readout of a click. The real map screen, the real
// mesh layer on a recording GL, and a stubbed fetch that answers the /obs routes.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { Camera } from '../src/gl/camera'
import { MeshLayer } from '../src/gl/mesh-layer'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'
import { createRecordingGl } from './support/recording-gl'

const recording = createRecordingGl()

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({
    gl: recording.gl,
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

function baseState(obs = true): IngestState {
  return {
    fresh: true,
    artifacts: [],
    capabilities: {
      map: { available: true, blockedBy: [] },
      stats: { available: true, blockedBy: [] },
      chips: { available: true, blockedBy: [] },
      ...(obs ? { obs: { available: true, blockedBy: [] } } : {}),
    },
    ingestSeconds: null,
    cacheBytes: null,
  }
}

// Two unit cells side by side on two layers; the mesh is drawn relative to an origin the readout adds back.
const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 2, bounds: [0, 2, 0, 1], origin: [1000, 2000], crs: null, tag: 'obs-dots' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 1])
const LAYER_ARRAY = new Int32Array([0, 1])
const PAR_TABLE = tableToIPC(tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }), 'stream')
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

interface SiteSpec {
  id: number
  name: string
  x: number
  y: number
  source: 'own' | 'cell_centre' | 'none'
  layer: number
  cell: number
  rule: string
  note: string | null
}

const NAN = Number.NaN
// Site ids are not row numbers, so a row used as an id shows up as a wrong id.
const HEADS: SiteSpec[] = [
  { id: 101, name: '<b>bold</b>', x: 0.25, y: 0.6, source: 'own', layer: 0, cell: 0, rule: 'own xy', note: null },
  { id: 102, name: 's_b', x: 0.75, y: 0.6, source: 'own', layer: 0, cell: 0, rule: 'own xy', note: null },
  { id: 103, name: 's_c', x: 0.75, y: 0.6, source: 'own', layer: 0, cell: 0, rule: 'own xy', note: null },
  { id: 104, name: 's_d', x: 1.5, y: 0.5, source: 'cell_centre', layer: 1, cell: 1, rule: 'cell only', note: null },
  { id: 105, name: 's_e', x: NAN, y: NAN, source: 'none', layer: -1, cell: -1, rule: 'none', note: 'no cell contains this site' },
  { id: 106, name: 's_f', x: 1.5, y: 0.25, source: 'own', layer: -1, cell: 1, rule: 'own xy', note: null },
]
const DEEP: SiteSpec[] = [
  { id: 201, name: 'd_a', x: 1.25, y: 0.5, source: 'own', layer: 1, cell: 1, rule: 'own xy', note: null },
  { id: 202, name: 'd_b', x: 1.75, y: 0.5, source: 'own', layer: 1, cell: 1, rule: 'own xy', note: null },
]
const CONC: SiteSpec[] = [
  { id: 301, name: 'c_a', x: NAN, y: NAN, source: 'none', layer: -1, cell: -1, rule: 'none', note: 'obs_cell: no cell found for any site' },
  { id: 302, name: 'c_b', x: NAN, y: NAN, source: 'none', layer: -1, cell: -1, rule: 'none', note: 'obs_cell: no cell found for any site' },
]
const STACK: SiteSpec[] = Array.from({ length: 22 }, (_, i) => ({
  id: 400 + i,
  name: `st_${i}`,
  x: 0.75,
  y: 0.6,
  source: 'own' as const,
  layer: 0,
  cell: 0,
  rule: 'own xy',
  note: null,
}))

interface GroupSpec {
  sites: SiteSpec[]
  times: number[]
  nAtTime: number[]
  /** resid_mean frame values per time. */
  frames: Record<number, number[]>
  limits: boolean
}

const GROUPS: Record<string, GroupSpec> = {
  conc: { sites: CONC, times: [10], nAtTime: [0], frames: { 10: [NAN, NAN] }, limits: false },
  heads: {
    sites: HEADS,
    times: [10, 20, 30],
    nAtTime: [5, 2, 1],
    frames: { 10: [0.5, -0.5, NAN, 1, NAN, 0.1], 20: [0.25, NAN, NAN, NAN, NAN, NAN], 30: [NAN, NAN, NAN, NAN, NAN, NAN] },
    limits: true,
  },
  deep: { sites: DEEP, times: [20, 30], nAtTime: [2, 2], frames: { 20: [3, 4], 30: [5, 6] }, limits: true },
  stack: { sites: STACK, times: [10], nAtTime: [22], frames: { 10: STACK.map(() => 1) }, limits: true },
}

const SITE_PAYLOADS: Record<number, { time: number[]; obsval: (number | null)[]; no_value: boolean[]; weighted: boolean[] }> = {
  // 10.5 is not 10: the nearest time must never be used.
  // Two rows at time 10: the frame and the readout both take the last, 2.5.
  101: { time: [10, 10], obsval: [1.5, 2.5], no_value: [false, false], weighted: [true, true] },
  102: { time: [10.5, 20], obsval: [5.5, 6.5], no_value: [false, false], weighted: [true, true] },
  103: { time: [10, 20], obsval: [7.5, null], no_value: [false, true], weighted: [false, true] },
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function ipc(columns: Record<string, unknown[]>): Uint8Array {
  return Uint8Array.from(tableToIPC(tableFromArrays(columns), 'stream'))
}

function sitesTable(sites: SiteSpec[]): Uint8Array {
  return ipc({
    site_id: sites.map((s) => s.id),
    site: sites.map((s) => s.name),
    n_obs: sites.map(() => 3),
    x: sites.map((s) => s.x),
    y: sites.map((s) => s.y),
    xy_source: sites.map((s) => s.source),
    layer: sites.map((s) => s.layer),
    cell: sites.map((s) => s.cell),
    rule: sites.map((s) => s.rule),
    note: sites.map((s) => s.note),
  })
}

function groupsTable(): Uint8Array {
  const names = groupOrder ?? Object.keys(GROUPS)
  const placed = names.map((n) => GROUPS[n].sites.filter((s) => s.source !== 'none').length)
  return ipc({
    group: names,
    n_obs: names.map(() => 10),
    n_sites: names.map((n) => GROUPS[n].sites.length),
    n_placed: placed,
    n_weighted: names.map(() => 10),
    n_with_target: names.map(() => 10),
    n_zero_weight: names.map(() => 0),
    n_sentinel: names.map(() => 0),
    n_no_value: names.map(() => 0),
    time_kind: names.map(() => 'numeric'),
    inequality: names.map(() => 'none'),
    first_iteration: names.map(() => 0),
    last_iteration: names.map(() => 1),
    rmse_first: names.map(() => 1),
    rmse_last: names.map(() => 0.5),
    n_resid_first: names.map(() => 10),
    n_resid_last: names.map(() => 10),
  })
}

function statValues(stat: string, base: number[]): number[] {
  if (stat === 'rmse') return base.map((v) => Math.abs(v) * 2)
  if (stat === 'std') return base.map((v) => Math.abs(v))
  if (stat === 'mean') return base.map((v) => v + 10)
  return base
}

let calls: string[] = []
// A refused /obs/site for this site id, to see the reason shown.
let refuseSite: number | null = null
let limitsRefused: string | null = null
// The order the group table lists the groups in; the map picks the first placed one itself.
let groupOrder: string[] | null = null

function stubFetch(): void {
  calls = []
  refuseSite = null
  limitsRefused = null
  groupOrder = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path, search] = url.split('?')
      // The conflict overlay reads /obs/pdc whatever the map is coloured by; only the colouring's reads count here.
      if (path.startsWith('/api/run/obs/') && path !== '/api/run/obs/pdc') calls.push(url)
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
      const group = query.get('group') ?? ''
      switch (path) {
        case '/api/run/grid/mesh':
          return respond({ status: 200, body: MESH_BODY })
        case '/api/run/grid/mesh/positions':
          return respond({ status: 200, bytes: bytesOf(POSITIONS), headers: metaHeader('<f4') })
        case '/api/run/grid/mesh/cell_index':
          return respond({ status: 200, bytes: bytesOf(CELL_INDEX), headers: metaHeader('<f4') })
        case '/api/run/grid/mesh/indices':
          return respond({ status: 200, bytes: bytesOf(INDICES), headers: metaHeader('<u4') })
        case '/api/run/grid/parmap':
          return respond({ status: 200, bytes: bytesOf(PARMAP) })
        case '/api/run/meta':
          return respond({ status: 200, bytes: PAR_TABLE })
        case '/api/run/grid/cells/cell':
          return respond({ status: 200, bytes: bytesOf(CELL_ARRAY) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(LAYER_ARRAY) })
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
          return respond({ status: 200, bytes: sitesTable(GROUPS[group].sites), headers: { 'X-Pesto-Meta': JSON.stringify({ order_digest: 'digest-a' }) } })
        case '/api/run/obs/times': {
          const spec = GROUPS[group]
          const limits = spec.limits
          return respond({
            status: 200,
            body: {
              group,
              order_digest: 'digest-a',
              time_kind: 'numeric',
              steps_by: 'time',
              times: spec.times,
              n_at_time: spec.nAtTime,
              n_sites: spec.sites.length,
              iterations: [
                { iteration: 0, available: true, reason: null },
                { iteration: 1, available: false, reason: 'obs_agg/1 could not be loaded: the file is missing' },
              ],
              limits: {
                resid_mean: limits ? [-1, 1] : null,
                rmse: limits ? [0, 2] : null,
                std: limits ? [0, 1] : null,
                mean: limits ? [9, 11] : null,
              },
              limits_rule: 'pooled over the first and last iteration',
              limits_refused: limitsRefused,
              refused: null,
              notes: [],
            },
          })
        }
        case '/api/run/obs/frame': {
          const iteration = Number(query.get('iteration'))
          const time = Number(query.get('time'))
          const stat = query.get('stat') ?? 'resid_mean'
          if (iteration !== 0) return respond({ status: 404, body: { title: 'obs_agg/1 is not available', status: 404, artifact: 'obs_agg/1' } })
          const spec = GROUPS[group]
          const values = new Float32Array(statValues(stat, spec.frames[time] ?? spec.sites.map(() => NAN)))
          const finite = values.filter((v) => Number.isFinite(v)).length
          return respond({
            status: 200,
            bytes: bytesOf(values),
            headers: {
              'X-Pesto-Meta': JSON.stringify({
                dtype: '<f4',
                group,
                order_digest: 'digest-a',
                iteration,
                time,
                stat,
                n_sites: spec.sites.length,
                n_at_time: spec.nAtTime[spec.times.indexOf(time)] ?? 0,
                n_rows_hidden: 0,
                n_finite: finite,
              }),
            },
          })
        }
        case '/api/run/obs/site': {
          const id = Number(query.get('site'))
          if (id === refuseSite) {
            return respond({ status: 404, body: { title: 'not found', status: 404, detail: 'the index has no such site', artifact: 'obs_index' } })
          }
          const found = SITE_PAYLOADS[id] ?? { time: [10], obsval: [1], no_value: [false], weighted: [true] }
          return respond({
            status: 200,
            body: {
              site_id: id,
              site: `site ${id}`,
              group: 'heads',
              time_kind: 'numeric',
              inequality: 'none',
              n_obs: found.time.length,
              ...found,
              sentinel: found.time.map(() => false),
              noise: { available: false, artifact: 'obs_ens', reason: 'none' },
              placement: { available: false, artifact: 'obs_cell', reason: 'none' },
              iterations: [0, 1],
              notes: [],
            },
          })
        }
        case '/api/run/link/cell': {
          const cells = (query.get('cells') ?? '').split(',').map(Number)
          return respond({
            status: 200,
            body: {
              layer: Number(query.get('layer')),
              cells,
              ring: [],
              ring_rule: 'a neighbouring cell shares at least one corner with a clicked cell',
              pars: [],
              pars_total: 0,
              par_notes: [],
              sites: [],
              sites_total: 0,
              sites_cap: 50,
              site_counts: { unknown_layer_included: 0, other_layer_left_out: 0, unplaced_in_run: 0 },
              reasons: { pars: 'no parameter sets this cell', sites: 'no observation site in this cell' },
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

async function mounted(withObs = true): Promise<{ root: HTMLElement; store: SelectionStore }> {
  stubFetch()
  const store = manualStore()
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: baseState(withObs), store })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  return { root, store }
}

const legendText = (root: HTMLElement): string => root.querySelector('.floating-bottom-left')?.textContent ?? ''
const readoutText = (root: HTMLElement): string => root.querySelector('.floating-bottom-right')?.textContent ?? ''
const noticeText = (root: HTMLElement): string => root.querySelector('[data-testid="obs-notices"]')?.textContent ?? ''

function switchButton(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('.obs-colour-switch button')].find((b) => b.textContent === text)
  if (!found) throw new Error(`no switch button ${text}`)
  return found as HTMLButtonElement
}

async function enterObservations(root: HTMLElement): Promise<void> {
  switchButton(root, 'Observations').click()
  await vi.waitFor(() => expect(legendText(root)).toContain('iteration 0'))
}

function chooseGroup(root: HTMLElement, group: string): void {
  const select = root.querySelector('select[aria-label="Observation group"]') as HTMLSelectElement
  select.value = group
  select.dispatchEvent(new Event('change'))
}

function clickAtWorld(canvas: HTMLCanvasElement, wx: number, wy: number): void {
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
  const camera = new Camera(canvas.width, canvas.height)
  camera.fit([0, 2, 0, 1])
  const [x0, y0] = camera.screenToWorld(0, 0)
  const [x1, y1] = camera.screenToWorld(1, 1)
  canvas.dispatchEvent(new MouseEvent('click', { clientX: (wx - x0) / (x1 - x0), clientY: (wy - y0) / (y1 - y0) }))
}

const f32 = (...values: number[]): number[] => Array.from(Float32Array.from(values))

describe('colouring the map by observations', () => {
  let setPoints: ReturnType<typeof vi.spyOn>
  let setPointValues: ReturnType<typeof vi.spyOn>
  let setMissingStyle: ReturnType<typeof vi.spyOn>
  let setColormap: ReturnType<typeof vi.spyOn>
  let setLimits: ReturnType<typeof vi.spyOn>
  let setValues: ReturnType<typeof vi.spyOn>
  let setFootprint: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
    setPoints = vi.spyOn(MeshLayer.prototype, 'setPoints')
    setPointValues = vi.spyOn(MeshLayer.prototype, 'setPointValues')
    setMissingStyle = vi.spyOn(MeshLayer.prototype, 'setMissingStyle')
    setColormap = vi.spyOn(MeshLayer.prototype, 'setColormap')
    setLimits = vi.spyOn(MeshLayer.prototype, 'setLimits')
    setValues = vi.spyOn(MeshLayer.prototype, 'setValues')
    setFootprint = vi.spyOn(MeshLayer.prototype, 'setFootprint')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const lastPoints = (): [Float32Array, Float32Array] => setPoints.mock.calls.at(-1) as [Float32Array, Float32Array]

  describe('the switch and the first draw', () => {
    it('asks for nothing from /obs until Observations is chosen', async () => {
      const { root } = await mounted()
      expect(calls).toEqual([])
      expect(root.querySelector('.obs-colour')).not.toBeNull()
      expect(setMissingStyle).not.toHaveBeenCalled()
    })

    it('offers no switch to a run that did not record observations', async () => {
      const { root } = await mounted(false)
      expect(root.querySelector('.obs-colour')).toBeNull()
    })

    it("writes colour obs and the first group with a placed site, as the map", async () => {
      const { root, store } = await mounted()
      const origins: string[] = []
      store.subscribe((s) => s.colour, (_n, _p, o) => origins.push(...o))
      store.subscribe((s) => s.obsGroups, (_n, _p, o) => origins.push(...o))
      await enterObservations(root)
      expect(store.get().colour).toEqual({ source: 'obs', stat: 'resid_mean' })
      // conc has no placed site, so heads is the first group worth drawing.
      expect([...store.get().obsGroups]).toEqual(['heads'])
      expect(new Set(origins)).toEqual(new Set(['map']))
    })

    it('draws the dots of the current layer with the frame values in dot order', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      expect(calls.some((c) => c.startsWith('/api/run/obs/sites?group=heads'))).toBe(true)
      expect(calls.some((c) => c.startsWith('/api/run/obs/times?group=heads'))).toBe(true)
      expect(calls.filter((c) => c.startsWith('/api/run/obs/frame?')).some((c) => c.includes('iteration=0') && c.includes('time=10') && c.includes('stat=resid_mean'))).toBe(true)
      const [xy, values] = lastPoints()
      // Rows 0, 1 and 2 sit on layer 0; the third has an observation but no measured value.
      expect(Array.from(xy)).toEqual(f32(0.25, 0.6, 0.75, 0.6, 0.75, 0.6))
      expect(Array.from(values).slice(0, 2)).toEqual([0.5, -0.5])
      expect(Number.isNaN(values[2])).toBe(true)
    })

    it('draws no parameter field, a diverging ramp, the server limits and rings for missing values', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      const field = setValues.mock.calls.at(-1)![0] as Float32Array
      expect(Array.from(field).every((v) => Number.isNaN(v))).toBe(true)
      expect(setColormap.mock.calls.at(-1)).toEqual(['RdBu', false])
      expect(setLimits.mock.calls.at(-1)![0]).toEqual([-1, 1])
      expect(setMissingStyle.mock.calls.at(-1)![0]).toBe('ring')
      expect(Array.from(setFootprint.mock.calls.at(-1)![0] as Uint8Array)).toEqual([1, 1])
      expect(root.querySelector('.map-area')!.classList.contains('colour-obs')).toBe(true)
    })

    it('keeps the colour source on observations while the layer slider moves', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
      layerInput.value = '1'
      layerInput.dispatchEvent(new Event('input'))
      await vi.waitFor(() => expect(legendText(root)).toContain('1 site on another layer'))
      expect(store.get().colour.source).toBe('obs')
      expect(store.get().layer).toBe(1)
    })

    it('hides the parameter-only rows and the parameter picker in observation mode', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      expect(root.querySelector('.map-area')!.classList.contains('colour-obs')).toBe(true)
      const hidden = [...root.querySelectorAll('[data-colour-source="par"]')]
      expect(hidden.length).toBeGreaterThan(5)
      expect(hidden.some((el) => el.querySelector('select[aria-label="Parameter group"]') !== null)).toBe(true)
      expect((root.querySelector('input[aria-label="Layer"]') as HTMLElement).closest('[data-colour-source]')).toBeNull()
    })
  })

  describe('back to parameters', () => {
    it('draws the parameter field exactly as before', async () => {
      const { root, store } = await mounted()
      const fieldBefore = Array.from(setValues.mock.calls.at(-1)![0] as Float32Array)
      const legendBefore = legendText(root)
      const colormapBefore = setColormap.mock.calls.at(-1)
      expect(Number.isNaN(fieldBefore[0])).toBe(false)

      await enterObservations(root)
      switchButton(root, 'Parameters').click()
      await vi.waitFor(() => expect(legendText(root)).toBe(legendBefore))

      expect(Array.from(setValues.mock.calls.at(-1)![0] as Float32Array)).toEqual(fieldBefore)
      expect(setColormap.mock.calls.at(-1)).toEqual(colormapBefore)
      expect(setMissingStyle.mock.calls.at(-1)![0]).toBe('discard')
      expect(lastPoints()[0].length).toBe(0)
      expect(store.get().colour).toEqual({ source: 'par', stat: 'value' })
      expect(root.querySelector('.map-area')!.classList.contains('colour-obs')).toBe(false)
    })

    it('still writes the parameter statistic as the colour while on Parameters', async () => {
      const { root, store } = await mounted()
      const statistic = root.querySelector('select[aria-label="Statistic"]') as HTMLSelectElement
      statistic.value = 'mean'
      statistic.dispatchEvent(new Event('change'))
      expect(store.get().colour).toEqual({ source: 'par', stat: 'mean' })
      // A trip to observations and back keeps it.
      await enterObservations(root)
      switchButton(root, 'Parameters').click()
      expect(store.get().colour).toEqual({ source: 'par', stat: 'mean' })
    })
  })

  describe('group, statistic and layers', () => {
    it('lists the groups with their placed counts', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      const select = root.querySelector('select[aria-label="Observation group"]') as HTMLSelectElement
      const labels = [...select.options].map((o) => o.textContent)
      expect(labels).toContain('conc · 0 placed')
      expect(labels).toContain('heads · 5 placed')
      expect(labels).toContain('deep · 2 placed')
    })

    it('follows a group chosen in the Obs tab', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      store.set({ obsGroups: new Set(['deep']) }, 'obs')
      await vi.waitFor(() => expect(legendText(root)).toContain('deep'))
      expect(calls.some((c) => c.startsWith('/api/run/obs/sites?group=deep'))).toBe(true)
    })

    it('colours by the RMS residual with viridis and the rmse limits, naming it', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      const select = root.querySelector('select[aria-label="Observation statistic"]') as HTMLSelectElement
      select.value = 'rmse'
      select.dispatchEvent(new Event('change'))
      await vi.waitFor(() => expect(legendText(root)).toContain('RMS residual over realizations, iteration 0'))
      expect(setColormap.mock.calls.at(-1)).toEqual(['viridis', false])
      expect(setLimits.mock.calls.at(-1)![0]).toEqual([0, 2])
      expect(legendText(root)).not.toContain('simulated above observed')
      // Same dots, so only the values are uploaded.
      expect(Array.from(setPointValues.mock.calls.at(-1)![0] as Float32Array).slice(0, 2)).toEqual([1, 1])
    })

    it('counts every site in the legend', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      const text = legendText(root)
      expect(text).toContain('mean residual (simulated minus observed), iteration 0')
      expect(text).toContain('simulated minus observed; blue means simulated above observed')
      expect(text).toContain('day 10 (model time)')
      expect(text).toContain('Limits: pooled over the first and last iteration')
      expect(text).toContain('2 of 3 sites have a value at this time')
      expect(text).toContain('1 has an observation at this time but no measured value')
      expect(text).toContain("0 at the centre of the cell's vertices, 3 at its own x and y")
      expect(text).toContain('1 site not placed: no cell contains this site')
      expect(text).toContain('1 site on another layer')
      expect(text).toContain('1 site with an unknown layer, shown only under all layers')
    })

    it('draws no colour and says why when the server could not make the limits', async () => {
      const { root } = await mounted()
      limitsRefused = 'the colour limits could not be made: the file is short'
      await enterObservations(root)
      const [, values] = lastPoints()
      expect(Array.from(values).every((v) => Number.isNaN(v))).toBe(true)
      expect(legendText(root)).toContain('Limits unknown, so the dots carry no colour: the colour limits could not be made: the file is short')
      expect(legendText(root)).not.toContain('this statistic has no finite value')
    })

    it('draws every layer, the unknown-layer site included, under all layers', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      const box = root.querySelector('input[aria-label="All layers"]') as HTMLInputElement
      box.checked = true
      box.dispatchEvent(new Event('change'))
      await vi.waitFor(() => expect(lastPoints()[0].length).toBe(10))
      expect(legendText(root)).toContain("1 at the centre of the cell's vertices, 4 at its own x and y")
      expect(legendText(root)).toContain('1 site with an unknown layer drawn because all layers is on')
      expect(legendText(root)).not.toContain('shown only under all layers')
      box.checked = false
      box.dispatchEvent(new Event('change'))
      await vi.waitFor(() => expect(lastPoints()[0].length).toBe(6))
    })

    it('draws a site without a value as a ring, and every dot as one when no site has a value', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      expect(setMissingStyle.mock.calls.at(-1)![0]).toBe('ring')
      expect(Number.isNaN(lastPoints()[1][2])).toBe(true)
      store.set({ timeIdx: 2 }, 'obs-slider')
      await vi.waitFor(() => expect(legendText(root)).toContain('day 30 (model time)'))
      expect(legendText(root)).toContain('0 of 3 sites have a value at this time')
      const last = (setPointValues.mock.calls.at(-1) ?? setPoints.mock.calls.at(-1)) as unknown[]
      const values = (last.length === 1 ? last[0] : last[1]) as Float32Array
      expect(Array.from(values).every((v) => Number.isNaN(v))).toBe(true)
      expect(setMissingStyle.mock.calls.at(-1)![0]).toBe('ring')
    })

    it('uploads the dots once and only the values when the time moves', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      const uploads = setPoints.mock.calls.length
      store.set({ timeIdx: 1 }, 'obs-slider')
      await vi.waitFor(() => expect(legendText(root)).toContain('day 20 (model time)'))
      expect(setPoints.mock.calls.length).toBe(uploads)
      expect(setPointValues).toHaveBeenCalled()
    })
  })

  describe('layers and groups that do not fit', () => {
    it('moves the map to the lowest layer holding a site and says so, writing the layer as the map', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      const layerOrigins: string[] = []
      store.subscribe((s) => s.layer, (_n, _p, o) => layerOrigins.push(...o))
      chooseGroup(root, 'deep')
      await vi.waitFor(() => expect(legendText(root)).toContain('moved to layer 1, the lowest layer with a site of this group'))
      expect(store.get().layer).toBe(1)
      expect(layerOrigins).toEqual(['map'])
      expect((root.querySelector('input[aria-label="Layer"]') as HTMLInputElement).value).toBe('1')
      expect(Array.from(lastPoints()[0])).toEqual(f32(1.25, 0.5, 1.75, 0.5))
    })

    it('moves to the lowest layer for the group it picked itself, as it does for a chosen one', async () => {
      const { root, store } = await mounted()
      groupOrder = ['conc', 'deep', 'heads', 'stack']
      await enterObservations(root)
      await vi.waitFor(() => expect(legendText(root)).toContain('moved to layer 1, the lowest layer with a site of this group'))
      expect([...store.get().obsGroups]).toEqual(['deep'])
      expect(store.get().layer).toBe(1)
      expect(Array.from(lastPoints()[0])).toEqual(f32(1.25, 0.5, 1.75, 0.5))
    })

    it('does not pull the map back when the user slides to a layer with no site', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
      layerInput.value = '1'
      layerInput.dispatchEvent(new Event('input'))
      await vi.waitFor(() => expect(lastPoints()[0].length).toBe(2))
      chooseGroup(root, 'conc')
      await vi.waitFor(() => expect(legendText(root)).toContain('No site of this group is drawn'))
      layerInput.value = '0'
      layerInput.dispatchEvent(new Event('input'))
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(store.get().layer).toBe(0)
    })

    it('draws no dot for a group with no placed site and gives the obs_cell reason', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      chooseGroup(root, 'conc')
      await vi.waitFor(() => expect(legendText(root)).toContain('No site of this group is drawn'))
      expect(lastPoints()[0].length).toBe(0)
      expect(legendText(root)).toContain('2 sites not placed: obs_cell: no cell found for any site')
      expect(legendText(root)).toContain('Limits: none')
    })

    it('keeps the same time across groups when both have it, else moves to the first with a note', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      store.set({ timeIdx: 1 }, 'obs-slider')
      await vi.waitFor(() => expect(legendText(root)).toContain('day 20 (model time)'))
      chooseGroup(root, 'deep')
      await vi.waitFor(() => expect(legendText(root)).toContain('deep'))
      // deep has day 20 at its first position, so the value is kept and the position follows it.
      expect(legendText(root)).toContain('day 20 (model time)')
      expect(store.get().timeIdx).toBe(0)
      expect(calls.some((c) => c.startsWith('/api/run/obs/frame?group=deep') && c.includes('time=20'))).toBe(true)
      expect(legendText(root)).not.toContain('moved to its first time')
      chooseGroup(root, 'heads')
      await vi.waitFor(() => expect(legendText(root)).toContain('heads'))
      expect(legendText(root)).toContain('day 20 (model time)')
    })

    it('says the slider moved when the new group lacks the old time', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      chooseGroup(root, 'deep')
      await vi.waitFor(() => expect(legendText(root)).toContain('so the slider moved to its first time'))
      expect(legendText(root)).toContain('this group has no observation at day 10 (model time)')
      expect(store.get().timeIdx).toBe(0)
    })
  })

  describe('an iteration with no observation statistics', () => {
    it('names obs_agg/K, keeps the parameter colouring and asks for no frame of that iteration', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      const framesBefore = calls.filter((c) => c.startsWith('/api/run/obs/frame?')).length
      store.set({ iteration: 1 }, 'iteration-toggle')
      await vi.waitFor(() => expect(noticeText(root)).toContain('obs_agg/1'))
      expect(noticeText(root)).toContain('the file is missing')
      expect(noticeText(root)).toContain('keeps its parameter colouring')
      expect(calls.filter((c) => c.startsWith('/api/run/obs/frame?') && c.includes('iteration=1'))).toEqual([])
      expect(calls.filter((c) => c.startsWith('/api/run/obs/frame?')).length).toBe(framesBefore)
      await vi.waitFor(() => expect(setMissingStyle.mock.calls.at(-1)![0]).toBe('discard'))
      await vi.waitFor(() => expect(legendText(root)).toContain('Scale:'))
      await vi.waitFor(() => expect(root.querySelector('.map-area')!.classList.contains('colour-obs')).toBe(false))
      expect(store.get().colour.source).toBe('obs')
    })

    it('draws the dots again when the iteration comes back', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      store.set({ iteration: 1 }, 'iteration-toggle')
      await vi.waitFor(() => expect(noticeText(root)).toContain('obs_agg/1'))
      await vi.waitFor(() => expect(legendText(root)).toContain('Scale:'))
      store.set({ iteration: 0 }, 'iteration-toggle')
      await vi.waitFor(() => expect(legendText(root)).toContain('2 of 3 sites have a value at this time'))
      expect(noticeText(root)).toBe('')
      expect(setMissingStyle.mock.calls.at(-1)![0]).toBe('ring')
    })

    it('says so when the statistic written is not an observation statistic', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      store.set({ colour: { source: 'obs', stat: 'value' } }, 'other')
      await vi.waitFor(() => expect(noticeText(root)).toContain('not one of the observation statistics'))
      expect(lastPoints()[0].length).toBe(0)
    })
  })

  describe('a click on the dots', () => {
    it('reads out every stacked site, nearest first, and writes their site ids', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      const origins: string[] = []
      store.subscribe((s) => s.sites, (_n, _p, o) => origins.push(...o))
      const canvas = root.querySelector('canvas') as HTMLCanvasElement
      clickAtWorld(canvas, 0.75, 0.6)
      // Site ids, not row numbers.
      expect([...store.get().sites]).toEqual([102, 103])
      const text = readoutText(root)
      expect(text).toContain('2 sites at this spot')
      expect(text.indexOf('s_b (heads)')).toBeGreaterThan(-1)
      expect(text.indexOf('s_b (heads)')).toBeLessThan(text.indexOf('s_c (heads)'))
      // The mesh origin is added back: 0.75 + 1000 and 0.6 + 2000.
      expect(text).toContain('x 1001, y 2001 (own coordinates)')
      expect(text).toContain('layer 0, cell 0 · placed by own xy')
      expect(text).toContain('day 10 (model time)')
      expect(text).toContain('mean residual (simulated minus observed), iteration 0: -0.5000')
      expect(text).toContain('mean residual (simulated minus observed), iteration 0: no value at this time')
      expect(text).toContain('reading the observed value…')
      store.flush()
      expect(origins).toEqual(['map'])
    })

    it('matches the observed value by the exact time only', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 0.75, 0.6)
      await vi.waitFor(() => expect(readoutText(root)).not.toContain('reading the observed value…'))
      const text = readoutText(root)
      // Site 102 only has 10.5 and 20: the nearest time to 10 is never used.
      expect(text).toContain('no observation at this time')
      expect(text).not.toContain('5.500')
      expect(text).toContain('observed 7.500 — zero weight: a model output, not fitted')
    })

    it('redraws the readout for a new time, reading the observed value at that exact time', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 0.75, 0.6)
      await vi.waitFor(() => expect(readoutText(root)).toContain('no observation at this time'))
      store.set({ timeIdx: 1 }, 'obs-slider')
      await vi.waitFor(() => expect(readoutText(root)).toContain('day 20 (model time)'))
      expect(readoutText(root)).toContain('observed 6.500')
      expect(readoutText(root)).toContain('no measured value')
    })

    it('reads a site at most once per site, and only the 20 listed', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      chooseGroup(root, 'stack')
      await vi.waitFor(() => expect(legendText(root)).toContain('stack'))
      expect(lastPoints()[0].length).toBe(44)
      const canvas = root.querySelector('canvas') as HTMLCanvasElement
      clickAtWorld(canvas, 0.75, 0.6)
      expect(readoutText(root)).toContain('22 sites at this spot')
      expect(readoutText(root)).toContain('2 more sites here are not listed')
      expect(store.get().sites.size).toBe(22)
      await vi.waitFor(() => expect(readoutText(root)).not.toContain('reading the observed value…'))
      const siteCalls = () => calls.filter((c) => c.startsWith('/api/run/obs/site?'))
      expect(siteCalls().length).toBe(20)
      clickAtWorld(canvas, 0.75, 0.6)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(siteCalls().length).toBe(20)
      expect(new Set(siteCalls()).size).toBe(20)
    })

    it('shows the reason when the observed value could not be read', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      refuseSite = 103
      clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 0.75, 0.6)
      await vi.waitFor(() => expect(readoutText(root)).toContain('the observed value could not be read: obs_index: the index has no such site'))
    })

    it('asks again on the next click when the read of a site failed', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      const canvas = root.querySelector('canvas') as HTMLCanvasElement
      refuseSite = 103
      clickAtWorld(canvas, 0.75, 0.6)
      await vi.waitFor(() => expect(readoutText(root)).toContain('the observed value could not be read'))
      refuseSite = null
      clickAtWorld(canvas, 0.75, 0.6)
      await vi.waitFor(() => expect(readoutText(root)).toContain('observed 7.500 — zero weight: a model output, not fitted'))
      expect(readoutText(root)).not.toContain('could not be read')
    })

    it('reads the last of two observations at one time and says there are two', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 0.25, 0.6)
      await vi.waitFor(() => expect(readoutText(root)).not.toContain('reading the observed value…'))
      const text = readoutText(root)
      expect(text).toContain('observed 2.500')
      expect(text).not.toContain('observed 1.500')
      expect(text).toContain('2 observations at this time; the last is shown')
    })

    it('shows a site name as text, never as markup', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 0.25, 0.6)
      expect(readoutText(root)).toContain('<b>bold</b> (heads)')
      expect(root.querySelector('.floating-bottom-right b')).toBeNull()
    })

    it('falls back to the cell readout when no dot is in reach, and clears the sites', async () => {
      const { root, store } = await mounted()
      await enterObservations(root)
      const canvas = root.querySelector('canvas') as HTMLCanvasElement
      clickAtWorld(canvas, 0.75, 0.6)
      expect(store.get().sites.size).toBe(2)
      clickAtWorld(canvas, 1.5, 0.9)
      expect(readoutText(root)).toContain('No parameter of G1 sits on this cell.')
      expect(readoutText(root)).not.toContain('sites at this spot')
      // The cells and the sites reach the store once /link/cell has answered.
      await vi.waitFor(() => expect([...store.get().cells]).toEqual([1]))
      expect(store.get().sites.size).toBe(0)
    })

    it('reads a lone site as a single block, with its cell centre label', async () => {
      const { root } = await mounted()
      await enterObservations(root)
      const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
      layerInput.value = '1'
      layerInput.dispatchEvent(new Event('input'))
      await vi.waitFor(() => expect(lastPoints()[0].length).toBe(2))
      clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 1.5, 0.5)
      const text = readoutText(root)
      expect(text).not.toContain('sites at this spot')
      expect(text).toContain('s_d (heads)')
      expect(text).toContain("(centre of the cell's vertices)")
      expect(text).toContain('layer 1, cell 1 · placed by cell only')
    })

    it('leaves a parameter-mode click as it was: the cell, and nothing asked of /obs', async () => {
      const { root, store } = await mounted()
      clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 0.5, 0.5)
      await vi.waitFor(() => expect([...store.get().cells]).toEqual([0]))
      expect(readoutText(root)).toContain('p0 (G1)')
      expect(calls).toEqual([])
    })
  })
})
