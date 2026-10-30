// @vitest-environment jsdom
//
// Drawing a set of observation groups on the map: the set entries in the group list, the set
// asked for by its column and value, every member group's sites drawn as dots, a lasso that
// catches dots of several groups, and the way back to one group. The real map screen against a
// stubbed fetch, with the GL context and the shared MeshLayer double mocked.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { Camera } from '../src/gl/camera'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'
import { createRecording2d } from './support/recording-2d'

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({
    gl: { clearColor: vi.fn(), clear: vi.fn(), viewport: vi.fn(), finish: vi.fn(), COLOR_BUFFER_BIT: 0 },
    onLost: vi.fn(),
    onRestored: vi.fn(),
  })),
}))

vi.mock('../src/gl/mesh-layer', async (importOriginal) =>
  (await import('./support/mesh-layer-mock')).meshLayerMockModule(await importOriginal()),
)

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

function baseState(): IngestState {
  return {
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
}

// Two unit cells side by side on one layer.
const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 1, bounds: [0, 2, 0, 1], crs: null, tag: 'obs-sets' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 1])
const LAYER_ARRAY = new Int32Array([0, 0])
const PAR_TABLE = tableToIPC(tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }), 'stream')
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

interface SiteSpec {
  id: number
  name: string
  group: string
  x: number
  y: number
}

// One site per group, as on hm. Site ids are not row numbers.
const SITES: Record<string, SiteSpec> = {
  g1: { id: 11, name: 's11', group: 'g1', x: 0.25, y: 0.5 },
  g2: { id: 22, name: 's22', group: 'g2', x: 1.5, y: 0.5 },
  g3: { id: 33, name: 's33', group: 'g3', x: 0.75, y: 0.5 },
}
const GROUP_TIMES: Record<string, number[]> = { g1: [20], g2: [10, 20], g3: [10] }
const SET = { by: 'oname', value: 'hds', groups: ['g1', 'g2'] }
const SET_TIMES = [10, 20]
// resid_mean of each set row (g1, g2) at each time.
const SET_FRAMES: Record<number, number[]> = { 10: [Number.NaN, -0.5], 20: [0.5, -0.25] }

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function ipc(columns: Record<string, unknown[]>): Uint8Array {
  return Uint8Array.from(tableToIPC(tableFromArrays(columns), 'stream'))
}

function sitesTable(sites: SiteSpec[], withGroup = true): Uint8Array {
  return ipc({
    site_id: sites.map((s) => s.id),
    site: sites.map((s) => s.name),
    ...(withGroup ? { group: sites.map((s) => s.group) } : {}),
    n_obs: sites.map(() => 2),
    x: sites.map((s) => s.x),
    y: sites.map((s) => s.y),
    xy_source: sites.map(() => 'own'),
    layer: sites.map(() => 0),
    cell: sites.map((s) => (s.x < 1 ? 0 : 1)),
    rule: sites.map(() => 'own xy'),
    note: sites.map(() => null),
  })
}

function groupsTable(): Uint8Array {
  const names = Object.keys(SITES)
  return ipc({
    group: names,
    n_obs: names.map(() => 2),
    n_sites: names.map(() => 1),
    n_placed: names.map(() => 1),
    n_weighted: names.map(() => 2),
    n_with_target: names.map(() => 2),
    n_zero_weight: names.map(() => 0),
    n_sentinel: names.map(() => 0),
    n_no_value: names.map(() => 0),
    time_kind: names.map(() => 'numeric'),
    inequality: names.map(() => 'none'),
    first_iteration: names.map(() => 0),
    last_iteration: names.map(() => 1),
    rmse_first: names.map(() => 1),
    rmse_last: names.map(() => 0.5),
    n_resid_first: names.map(() => 2),
    n_resid_last: names.map(() => 2),
  })
}

interface Stub {
  calls: string[]
  /** What the stub does to a set's answers, to see each refusal. */
  setSites: 'ok' | 'no-group-column'
  setFrame: 'ok' | 'other-set' | 'other-digest'
  setTimesRefused: string | null
  groupSets: 'ok' | 'fail'
}

function isSet(query: URLSearchParams): boolean {
  return query.get('by') === SET.by && query.get('value') === SET.value
}

function stubEnvironment(): Stub {
  const stub: Stub = { calls: [], setSites: 'ok', setFrame: 'ok', setTimesRefused: null, groupSets: 'ok' }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path, search] = url.split('?')
      if (path.startsWith('/api/run/obs/') && path !== '/api/run/obs/pdc') stub.calls.push(url)
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
      const group = query.get('group')
      const asSet = isSet(query)
      const setKey = { by: SET.by, value: SET.value }
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
        case '/api/run/obs/group_sets':
          if (stub.groupSets === 'fail') {
            return respond({ status: 404, body: { title: 'not found', status: 404, detail: 'control/obs.parquet is not in the cache', artifact: 'control' } })
          }
          return respond({
            status: 200,
            body: {
              order_digest: 'digest-a',
              rule: 'a set is every observation group whose observations all hold the same value',
              sets: [{ ...SET, n_groups: SET.groups.length, n_sites: SET.groups.length }],
              notes: [],
            },
          })
        case '/api/run/obs/sites': {
          if (asSet) {
            const rows = SET.groups.map((g) => SITES[g])
            return respond({
              status: 200,
              bytes: sitesTable(rows, stub.setSites === 'ok'),
              headers: { 'X-Pesto-Meta': JSON.stringify({ order_digest: 'digest-a', group: null, set: setKey }) },
            })
          }
          return respond({
            status: 200,
            bytes: sitesTable([SITES[group ?? '']]),
            headers: { 'X-Pesto-Meta': JSON.stringify({ order_digest: 'digest-a', group, set: null }) },
          })
        }
        case '/api/run/obs/times': {
          const refused = asSet ? stub.setTimesRefused : null
          const times = refused !== null ? [] : asSet ? SET_TIMES : GROUP_TIMES[group ?? '']
          return respond({
            status: 200,
            body: {
              group: asSet ? null : group,
              set: asSet ? setKey : null,
              order_digest: 'digest-a',
              time_kind: refused !== null ? 'mixed' : 'numeric',
              steps_by: 'time',
              times,
              n_at_time: times.map(() => 1),
              n_sites: asSet ? SET.groups.length : 1,
              iterations: [{ iteration: 0, available: true, reason: null }],
              limits: { resid_mean: [-1, 1], rmse: [0, 2], std: [0, 1], mean: [9, 11] },
              limits_rule: 'pooled over the first and last iteration',
              limits_refused: null,
              refused,
              notes: [],
            },
          })
        }
        case '/api/run/obs/frame': {
          const time = Number(query.get('time'))
          const stat = query.get('stat') ?? 'resid_mean'
          const values = asSet ? new Float32Array(SET_FRAMES[time] ?? [Number.NaN, Number.NaN]) : new Float32Array([0.75])
          const set = asSet ? (stub.setFrame === 'other-set' ? { by: SET.by, value: 'sfr' } : setKey) : null
          return respond({
            status: 200,
            bytes: bytesOf(values),
            headers: {
              'X-Pesto-Meta': JSON.stringify({
                dtype: '<f4',
                group: asSet ? null : group,
                set,
                order_digest: asSet && stub.setFrame === 'other-digest' ? 'digest-b' : 'digest-a',
                iteration: 0,
                time,
                stat,
                n_sites: values.length,
                n_at_time: values.length,
                n_rows_hidden: 0,
                n_finite: values.filter((v) => Number.isFinite(v)).length,
              }),
            },
          })
        }
        case '/api/run/obs/site':
          return respond({ status: 404, body: { title: 'not found', status: 404, detail: 'not in this test', artifact: 'obs_index' } })
        case '/api/run/link/cell': {
          const cells = (query.get('cells') ?? '').split(',').map(Number)
          return respond({
            status: 200,
            body: {
              layer: 0,
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
        case '/api/run/link/sites': {
          const ids = (query.get('sites') ?? '').split(',').map(Number)
          const byId = new Map(Object.values(SITES).map((s) => [s.id, s]))
          return respond({
            status: 200,
            body: {
              iteration: Number(query.get('iteration')),
              sites: ids
                .filter((id) => byId.has(id))
                .map((id) => {
                  const s = byId.get(id)!
                  return { site_id: s.id, site: s.name, group: s.group, layer: 0, cell: s.x < 1 ? 0 : 1, placed: true, has_value: true }
                }),
              unknown: ids.filter((id) => !byId.has(id)),
              value_rule: 'a site has a valid observation when one of its observations has a measured value',
              value_reason: null,
              reason: null,
              notes: [],
            },
          })
        }
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
  return stub
}

function autoStore(): SelectionStore {
  return createSelectionStore({ initial: emptySelection('test_run', 0), schedule: (run) => queueMicrotask(run) })
}

type Mocked = ReturnType<typeof vi.fn>

interface LayerDouble {
  setPoints: Mocked
  setPointValues: Mocked
}

async function layerDouble(): Promise<LayerDouble> {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer).mock.instances[0] as unknown as LayerDouble
}

async function mounted(): Promise<{ root: HTMLElement; store: SelectionStore; stub: Stub; layer: LayerDouble }> {
  const stub = stubEnvironment()
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    }),
  )
  const store = autoStore()
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: baseState(), store })
  await vi.waitFor(() => expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull())
  return { root, store, stub, layer: await layerDouble() }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const recording = createRecording2d()

function stubOutlineContext(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === '2d' ? recording.ctx : null) as typeof HTMLCanvasElement.prototype.getContext)
}

function lastPoints(layer: LayerDouble): [Float32Array, Float32Array] | undefined {
  return layer.setPoints.mock.calls.at(-1) as [Float32Array, Float32Array] | undefined
}

const lastPointCount = (layer: LayerDouble): number => lastPoints(layer)?.[1].length ?? -1
const groupSelect = (root: HTMLElement) => root.querySelector('select[aria-label="Observation group"]') as HTMLSelectElement
const setOption = (root: HTMLElement) => groupSelect(root).querySelector('option[data-obs-set]') as HTMLOptionElement | null
const legendText = (root: HTMLElement): string => root.querySelector('.floating-bottom-left')?.textContent ?? ''
const readoutText = (root: HTMLElement): string => root.querySelector('.floating-bottom-right')?.textContent ?? ''
const noticeText = (root: HTMLElement): string => root.querySelector('[data-testid="obs-notices"]')?.textContent ?? ''
const dataSummary = (root: HTMLElement) => root.querySelector('[data-fold="data"] > .fold-summary')?.textContent ?? ''

// Observations on, the first placed group (g1) drawn, and the group list with its set entry built.
async function enterObservations(store: SelectionStore, layer: LayerDouble, root: HTMLElement): Promise<void> {
  store.set({ colour: { source: 'obs', stat: 'resid_mean' } }, 'other')
  await vi.waitFor(() => expect(lastPointCount(layer)).toBe(1))
  await vi.waitFor(() => expect(setOption(root)).not.toBeNull())
  await settle()
}

function chooseSet(root: HTMLElement): void {
  const option = setOption(root)
  if (option === null) throw new Error('no set entry')
  option.selected = true
  groupSelect(root).dispatchEvent(new Event('change'))
}

function chooseGroup(root: HTMLElement, group: string): void {
  groupSelect(root).value = group
  groupSelect(root).dispatchEvent(new Event('change'))
}

function clientAt(canvas: HTMLCanvasElement, wx: number, wy: number): [number, number] {
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
  const camera = new Camera(canvas.width, canvas.height)
  camera.fit([0, 2, 0, 1])
  const [x0, y0] = camera.screenToWorld(0, 0)
  const [x1, y1] = camera.screenToWorld(1, 1)
  return [(wx - x0) / (x1 - x0), (wy - y0) / (y1 - y0)]
}

function pointer(type: string, [x, y]: [number, number]): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true, cancelable: true })
}

function lassoWorld(canvas: HTMLCanvasElement, poly: [number, number][]): void {
  const points = poly.map(([wx, wy]) => clientAt(canvas, wx, wy))
  canvas.dispatchEvent(pointer('pointerdown', points[0]))
  for (const point of points.slice(1)) canvas.dispatchEvent(pointer('pointermove', point))
  canvas.dispatchEvent(pointer('pointerup', points[points.length - 1]))
  const [x, y] = points[points.length - 1]
  canvas.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }))
}

function clickAtWorld(canvas: HTMLCanvasElement, wx: number, wy: number): void {
  const [x, y] = clientAt(canvas, wx, wy)
  canvas.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y }))
}

const sorted = <T,>(set: ReadonlySet<T>): T[] => [...set].sort()
const f32 = (...values: number[]): number[] => Array.from(Float32Array.from(values))

describe('drawing a set of observation groups on the map', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
    stubOutlineContext()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('ends the group list with one entry per set, read from its own attributes', async () => {
    const { root, store, layer } = await mounted()
    await enterObservations(store, layer, root)
    const options = [...groupSelect(root).options]
    expect(options.at(-1)?.textContent).toBe('oname = hds · 2 groups · 2 placed')
    expect(options.at(-1)?.getAttribute('data-obs-set-by')).toBe('oname')
    expect(options.at(-1)?.getAttribute('data-obs-set-value')).toBe('hds')
    expect(options.filter((o) => o.hasAttribute('data-obs-group')).map((o) => o.value)).toEqual(['g1', 'g2', 'g3'])
  })

  it('asks for the set by its column and value and draws a dot for every member site', async () => {
    const { root, store, stub, layer } = await mounted()
    await enterObservations(store, layer, root)
    stub.calls.length = 0

    chooseSet(root)
    await vi.waitFor(() => expect(lastPointCount(layer)).toBe(2))

    expect(sorted(store.get().obsGroups)).toEqual(['g1', 'g2'])
    expect(stub.calls.some((c) => c.startsWith('/api/run/obs/sites?by=oname&value=hds'))).toBe(true)
    expect(stub.calls.some((c) => c.startsWith('/api/run/obs/times?by=oname&value=hds'))).toBe(true)
    expect(stub.calls.some((c) => c.startsWith('/api/run/obs/frame?by=oname&value=hds&'))).toBe(true)
    expect(stub.calls.filter((c) => c.includes('group=')).filter((c) => !c.includes('/obs/site?'))).toEqual([])
    const [xy, values] = lastPoints(layer)!
    expect(Array.from(xy)).toEqual(f32(0.25, 0.5, 1.5, 0.5))
    // g1 had only time 20, so the slider stays on 20 in the set's times.
    expect(store.get().timeIdx).toBe(1)
    expect(Array.from(values)).toEqual(f32(0.5, -0.25))
    expect(groupSelect(root).selectedOptions[0]?.hasAttribute('data-obs-set')).toBe(true)
  })

  it('lassoes the dots of both groups of the set', async () => {
    const { root, store, layer } = await mounted()
    await enterObservations(store, layer, root)
    chooseSet(root)
    await vi.waitFor(() => expect(lastPointCount(layer)).toBe(2))
    await settle()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement

    const button = root.querySelector('.lasso-button') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    button.click()
    lassoWorld(canvas, [
      [0.1, 0.1],
      [1.9, 0.1],
      [1.9, 0.9],
      [0.1, 0.9],
    ])
    await settle()

    expect(sorted(store.get().sites)).toEqual([11, 22])
  })

  it('draws one group alone again when one group is chosen after the set', async () => {
    const { root, store, stub, layer } = await mounted()
    await enterObservations(store, layer, root)
    chooseSet(root)
    await vi.waitFor(() => expect(lastPointCount(layer)).toBe(2))
    stub.calls.length = 0

    chooseGroup(root, 'g1')
    await vi.waitFor(() => expect(lastPointCount(layer)).toBe(1))

    expect([...store.get().obsGroups]).toEqual(['g1'])
    expect(stub.calls.some((c) => c.startsWith('/api/run/obs/sites?group=g1'))).toBe(true)
    expect(Array.from(lastPoints(layer)![0])).toEqual(f32(0.25, 0.5))
  })

  it('ends the list with a disabled entry carrying the reason when the sets cannot be read, and draws a group as before', async () => {
    const { root, store, stub, layer } = await mounted()
    stub.groupSets = 'fail'
    store.set({ colour: { source: 'obs', stat: 'resid_mean' } }, 'other')
    await vi.waitFor(() => expect(lastPointCount(layer)).toBe(1))
    await vi.waitFor(() => expect(groupSelect(root).querySelector('option[data-obs-sets-failed]')).not.toBeNull())
    const failed = [...groupSelect(root).options].at(-1)!
    expect(failed.textContent).toBe('Group sets could not be read')
    expect(failed.disabled).toBe(true)
    expect(failed.title).toBe('control: control/obs.parquet is not in the cache')
    chooseGroup(root, 'g2')
    await vi.waitFor(() => expect(Array.from(lastPoints(layer)![0])).toEqual(f32(1.5, 0.5)))
  })
})

describe('a set reads as a set wherever the map names what it draws', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
    stubOutlineContext()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  async function withSet(): Promise<{ root: HTMLElement; store: SelectionStore; stub: Stub; layer: LayerDouble }> {
    const env = await mounted()
    await enterObservations(env.store, env.layer, env.root)
    chooseSet(env.root)
    await vi.waitFor(() => expect(lastPointCount(env.layer)).toBe(2))
    await settle()
    return env
  }

  it("names the set in the legend's group line and on the Data card's folded line", async () => {
    const { root } = await withSet()
    const name = root.querySelector('.floating-bottom-left .legend-name.truncate')
    expect(name?.textContent).toBe('oname = hds · 2 groups')
    const fold = root.querySelector('[data-fold="data"] > .fold-button') as HTMLButtonElement
    if (fold.getAttribute('aria-expanded') === 'true') fold.click()
    expect(dataSummary(root)).toMatch(/^Data: oname = hds · 2 groups · /)
  })

  it("names a picked dot's own group in the readout, not the set", async () => {
    const { root } = await withSet()
    clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 1.5, 0.5)
    await vi.waitFor(() => expect(readoutText(root)).toContain('s22 (g2)'))
    expect(readoutText(root)).not.toContain('(oname = hds')
  })

  it('names the set in a has-no-time-axis notice', async () => {
    const { root, store, stub, layer } = await mounted()
    await enterObservations(store, layer, root)
    stub.setTimesRefused = 'the groups of this set mix time kinds (datetime and numeric)'
    chooseSet(root)
    await vi.waitFor(() => expect(noticeText(root)).toContain('oname = hds · 2 groups has no time axis'))
    expect(noticeText(root)).toContain('mix time kinds')
  })

  it('colours nothing and says why when the frame is for another set', async () => {
    const { root, store, stub, layer } = await mounted()
    await enterObservations(store, layer, root)
    stub.setFrame = 'other-set'
    chooseSet(root)
    await vi.waitFor(() => expect(noticeText(root)).toContain('asked for the set oname = hds but the answer was for the set oname = sfr'))
    expect(lastPointCount(layer)).toBe(0)
  })

  it('colours nothing when the frame was cut from another observation table', async () => {
    const { root, store, stub, layer } = await mounted()
    await enterObservations(store, layer, root)
    stub.setFrame = 'other-digest'
    chooseSet(root)
    await vi.waitFor(() => expect(noticeText(root)).toContain('different observation table'))
    expect(lastPointCount(layer)).toBe(0)
  })

  it("refuses a set's sites that do not say each site's group", async () => {
    const { root, store, stub, layer } = await mounted()
    await enterObservations(store, layer, root)
    stub.setSites = 'no-group-column'
    chooseSet(root)
    await vi.waitFor(() => expect(noticeText(root)).toContain('is missing group'))
    expect(lastPointCount(layer)).toBe(0)
  })

  it('refuses groups that are not one set and draws no dot for them', async () => {
    const { root, store, layer } = await withSet()
    store.set({ obsGroups: new Set(['g1', 'g3']) }, 'other')
    await vi.waitFor(() =>
      expect(noticeText(root)).toContain(
        'These 2 observation groups are not one group set of the observation data; pesto draws one group or one set at a time',
      ),
    )
    expect(lastPointCount(layer)).toBe(0)
    expect(groupSelect(root).value).toBe('')
  })
})
