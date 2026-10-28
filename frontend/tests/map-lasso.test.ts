// @vitest-environment jsdom
//
// The lasso on the map: it picks only the site dots drawn now, takes the modifier rule at release,
// writes sites and nothing else, never pans, swallows the click its drag ends with, and keeps its
// outline until something else changes the sites. The real map screen against a stubbed fetch,
// with the GL context and the shared MeshLayer double mocked and a recording 2D outline.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { Camera } from '../src/gl/camera'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'
import { createRecording2d, type RecordedCall } from './support/recording-2d'

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

// The real geometry, counted, so a test can tell how often the dot index is built.
vi.mock('../src/data/lasso', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/lasso')>()
  return { ...actual, buildDotIndex: vi.fn(actual.buildDotIndex) }
})

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

// Two unit cells side by side, two layers. G1 sets the cells; k is placed by x/y and draws as dots.
const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 2, bounds: [0, 2, 0, 1], crs: null, tag: 'follow' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PARMAP = new Int32Array([0, 1, 2, 3])
const CELL_ARRAY = new Int32Array([0, 1, 0, 1])
const LAYER_ARRAY = new Int32Array([0, 0, 0, 0])
const NAN = Number.NaN
const POINT_XY = new Float32Array([NAN, NAN, NAN, NAN, 0.25, 0.5, 1.5, 0.5])
const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1', 'pa', 'pb'], pargp: ['G1', 'G1', 'k', 'k'], partrans: ['none', 'none', 'none', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

interface SiteSpec {
  id: number
  name: string
  x: number
  y: number
  layer: number
  cell: number
}

// Site ids are not row numbers. Five sites draw on layer 0; s106 sits on layer 1 inside the first lasso.
const HEADS: SiteSpec[] = [
  { id: 101, name: 's101', x: 0.25, y: 0.25, layer: 0, cell: 0 },
  { id: 102, name: 's102', x: 0.25, y: 0.75, layer: 0, cell: 0 },
  { id: 103, name: 's103', x: 0.75, y: 0.5, layer: 0, cell: 0 },
  { id: 104, name: 's104', x: 1.25, y: 0.5, layer: 0, cell: 1 },
  { id: 105, name: 's105', x: 1.75, y: 0.5, layer: 0, cell: 1 },
  { id: 106, name: 's106', x: 0.3, y: 0.5, layer: 1, cell: 0 },
]

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function ipc(columns: Record<string, unknown[]>): Uint8Array {
  return Uint8Array.from(tableToIPC(tableFromArrays(columns), 'stream'))
}

function sitesTable(): Uint8Array {
  return ipc({
    site_id: HEADS.map((s) => s.id),
    site: HEADS.map((s) => s.name),
    n_obs: HEADS.map(() => 3),
    x: HEADS.map((s) => s.x),
    y: HEADS.map((s) => s.y),
    xy_source: HEADS.map(() => 'own'),
    layer: HEADS.map((s) => s.layer),
    cell: HEADS.map((s) => s.cell),
    rule: HEADS.map(() => 'own xy'),
    note: HEADS.map(() => null),
  })
}

function groupsTable(): Uint8Array {
  return ipc({
    group: ['heads'],
    n_obs: [10],
    n_sites: [HEADS.length],
    n_placed: [HEADS.length],
    n_weighted: [10],
    n_with_target: [10],
    n_zero_weight: [0],
    n_sentinel: [0],
    n_no_value: [0],
    time_kind: ['numeric'],
    inequality: ['none'],
    first_iteration: [0],
    last_iteration: [1],
    rmse_first: [1],
    rmse_last: [0.5],
    n_resid_first: [10],
    n_resid_last: [10],
  })
}

const TIMES = [10, 20]

function timesBody(group: string): Record<string, unknown> {
  return {
    group,
    order_digest: 'digest-a',
    time_kind: 'numeric',
    steps_by: 'time',
    times: TIMES,
    n_at_time: [6, 6],
    n_sites: HEADS.length,
    iterations: [{ iteration: 0, available: true, reason: null }],
    limits: { resid_mean: [-1, 1], rmse: [0, 2], std: [0, 1], mean: [9, 11] },
    limits_rule: 'pooled over the first and last iteration',
    limits_refused: null,
    refused: null,
    notes: [],
  }
}

interface LinkParRow {
  parnme: string
  pargp: string
  kind: 'cell' | 'pilot_point' | 'unplaced'
  layer: number
  cell: number
  cells: number[]
  n_cells: number
  cells_capped: boolean
  reason: string | null
}

interface LinkSiteRow {
  site_id: number
  site: string
  group: string
  layer: number
  cell: number
  placed: boolean
  has_value: boolean | null
}

interface Stub {
  linkCells: string[]
  linkPar: string[][]
  linkSites: { sites: string; iteration: string }[]
  holdLink: boolean
  release: (() => void)[]
  pars: Record<string, LinkParRow>
  sites: Record<number, LinkSiteRow>
  valueReason: string | null
}

function linkCellBody(cells: number[]): Record<string, unknown> {
  return {
    layer: 0,
    cells,
    ring: [],
    ring_rule: 'a neighbouring cell shares at least one corner with a clicked cell',
    pars: cells.map((c) => ({ parnme: `p${c}`, pargp: 'G1', kind: 'cell', cell: c, weights: [], rule: 'sets this cell (par_cell)' })),
    pars_total: cells.length,
    par_notes: [],
    sites: [],
    sites_total: 0,
    sites_cap: 50,
    site_counts: { unknown_layer_included: 0, other_layer_left_out: 0, unplaced_in_run: 0 },
    reasons: { pars: null, sites: 'no observation site in this cell' },
  }
}

function defaultSites(): Record<number, LinkSiteRow> {
  const out: Record<number, LinkSiteRow> = {}
  for (const s of HEADS) {
    out[s.id] = { site_id: s.id, site: s.name, group: 'heads', layer: s.layer, cell: s.cell, placed: true, has_value: true }
  }
  return out
}

function stubEnvironment(): Stub {
  const stub: Stub = {
    linkCells: [],
    linkPar: [],
    linkSites: [],
    holdLink: false,
    release: [],
    pars: {},
    sites: defaultSites(),
    valueReason: null,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path, search] = url.split('?')
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
          return respond({ status: 200, bytes: bytesOf(POINT_XY) })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(new Float32Array([10, 20, 30, 40])) })
        case '/api/run/grid/pp':
          return respond({ status: 200, body: { groups: [], not_interpolable: [], notes: [] } })
        case '/api/run/view':
          throw new Error('no saved view')
        case '/api/run/obs/groups':
          return respond({ status: 200, bytes: groupsTable() })
        case '/api/run/obs/sites':
          return respond({ status: 200, bytes: sitesTable(), headers: { 'X-Pesto-Meta': JSON.stringify({ order_digest: 'digest-a' }) } })
        case '/api/run/obs/times':
          return respond({ status: 200, body: timesBody(group) })
        case '/api/run/obs/frame': {
          const time = Number(query.get('time'))
          const stat = query.get('stat') ?? 'resid_mean'
          const values = new Float32Array(HEADS.map((_, i) => (time === 10 ? 0.1 * i : -0.1 * i)))
          return respond({
            status: 200,
            bytes: bytesOf(values),
            headers: {
              'X-Pesto-Meta': JSON.stringify({
                dtype: '<f4',
                group,
                order_digest: 'digest-a',
                iteration: 0,
                time,
                stat,
                n_sites: HEADS.length,
                n_at_time: HEADS.length,
                n_rows_hidden: 0,
                n_finite: HEADS.length,
              }),
            },
          })
        }
        case '/api/run/obs/site':
          return respond({ status: 404, body: { title: 'not found', status: 404, detail: 'not in this test', artifact: 'obs_index' } })
        case '/api/run/link/cell': {
          const text = query.get('cells') ?? ''
          stub.linkCells.push(text)
          if (stub.holdLink) await new Promise<void>((resolve) => stub.release.push(resolve))
          return respond({ status: 200, body: linkCellBody(text.split(',').map(Number)) })
        }
        case '/api/run/link/par': {
          const names = JSON.parse(query.get('names') ?? '[]') as string[]
          stub.linkPar.push(names)
          return respond({
            status: 200,
            body: { pars: names.filter((n) => n in stub.pars).map((n) => stub.pars[n]), unknown: names.filter((n) => !(n in stub.pars)), reason: null, notes: [] },
          })
        }
        case '/api/run/link/sites': {
          const text = query.get('sites') ?? ''
          stub.linkSites.push({ sites: text, iteration: query.get('iteration') ?? '' })
          const ids = text.split(',').map(Number)
          return respond({
            status: 200,
            body: {
              iteration: Number(query.get('iteration')),
              sites: ids
                .filter((id) => id in stub.sites)
                .map((id) => (stub.valueReason !== null ? { ...stub.sites[id], has_value: null } : stub.sites[id])),
              unknown: ids.filter((id) => !(id in stub.sites)),
              value_rule: 'a site has a valid observation when one of its observations has a measured value',
              value_reason: stub.valueReason,
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

// A hand-stepped store: nothing reaches a subscriber until flush() is called.
function manualStore(): SelectionStore {
  return createSelectionStore({ initial: emptySelection('test_run', 0), schedule: () => {} })
}

// Delivers each batch on a microtask, as the obs colouring needs its own writes heard.
function autoStore(): SelectionStore {
  return createSelectionStore({ initial: emptySelection('test_run', 0), schedule: (run) => queueMicrotask(run) })
}

type Mocked = ReturnType<typeof vi.fn>

interface LayerDouble {
  setSelected: Mocked
  setSelectedCells: Mocked
  setSelectedPoint: Mocked
  setSelectedPoints: Mocked
  setPointFlags: Mocked
  setDimAlpha: Mocked
  setPoints: Mocked
  setPointValues: Mocked
  setMatrix: Mocked
  draw: Mocked
}

async function layerDouble(): Promise<LayerDouble> {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer).mock.instances[0] as unknown as LayerDouble
}

async function mountedWith(store: SelectionStore): Promise<{ root: HTMLElement; stub: Stub; layer: LayerDouble }> {
  const stub = stubEnvironment()
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    }),
  )
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: baseState(), store })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  return { root, stub, layer: await layerDouble() }
}

function clickAtWorld(canvas: HTMLCanvasElement, wx: number, wy: number, keys: MouseEventInit = {}): void {
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
  const camera = new Camera(canvas.width, canvas.height)
  camera.fit([0, 2, 0, 1])
  const [x0, y0] = camera.screenToWorld(0, 0)
  const [x1, y1] = camera.screenToWorld(1, 1)
  canvas.dispatchEvent(new MouseEvent('click', { ...keys, clientX: (wx - x0) / (x1 - x0), clientY: (wy - y0) / (y1 - y0) }))
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const recording = createRecording2d()

function stubOutlineContext(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === '2d' ? recording.ctx : null) as typeof HTMLCanvasElement.prototype.getContext)
}

function lastPointCount(layer: LayerDouble): number {
  const call = layer.setPoints.mock.calls.at(-1) as [Float32Array, Float32Array] | undefined
  return call === undefined ? -1 : call[1].length
}

async function enterObservations(store: SelectionStore, layer: LayerDouble, dots = 5): Promise<void> {
  store.set({ colour: { source: 'obs', stat: 'resid_mean' } }, 'other')
  await vi.waitFor(() => expect(lastPointCount(layer)).toBe(dots))
  await settle()
}

// World to client pixels through the camera the map fits to the mesh.
function clientAt(canvas: HTMLCanvasElement, wx: number, wy: number): [number, number] {
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
  const camera = new Camera(canvas.width, canvas.height)
  camera.fit([0, 2, 0, 1])
  const [x0, y0] = camera.screenToWorld(0, 0)
  const [x1, y1] = camera.screenToWorld(1, 1)
  return [(wx - x0) / (x1 - x0), (wy - y0) / (y1 - y0)]
}

function pointer(type: string, [x, y]: [number, number], keys: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true, cancelable: true, ...keys })
}

// A drag through the world points, released with the keys, then the click a browser fires after it.
function lassoWorld(canvas: HTMLCanvasElement, poly: [number, number][], keys: PointerEventInit = {}): void {
  const points = poly.map(([wx, wy]) => clientAt(canvas, wx, wy))
  canvas.dispatchEvent(pointer('pointerdown', points[0]))
  for (const point of points.slice(1)) canvas.dispatchEvent(pointer('pointermove', point))
  canvas.dispatchEvent(pointer('pointerup', points[points.length - 1], keys))
  const [x, y] = points[points.length - 1]
  canvas.dispatchEvent(new MouseEvent('click', { ...keys, clientX: x, clientY: y, bubbles: true }))
}

// Around s101 and s102 (and s106 on layer 1); s103 at x 0.75 is outside.
const LEFT: [number, number][] = [
  [0.1, 0.1],
  [0.45, 0.1],
  [0.45, 0.9],
  [0.1, 0.9],
]
// Around s104 and s105.
const RIGHT: [number, number][] = [
  [1.1, 0.3],
  [1.9, 0.3],
  [1.9, 0.7],
  [1.1, 0.7],
]
// Around s105 alone.
const FAR_RIGHT: [number, number][] = [
  [1.6, 0.3],
  [1.9, 0.3],
  [1.9, 0.7],
  [1.6, 0.7],
]
// Inside cell 1 but around no dot.
const EMPTY: [number, number][] = [
  [1.3, 0.8],
  [1.7, 0.8],
  [1.7, 0.95],
  [1.3, 0.95],
]

const lassoButton = (root: HTMLElement): HTMLButtonElement => root.querySelector('.lasso-button') as HTMLButtonElement
const sorted = <T,>(set: ReadonlySet<T>): T[] => [...set].sort()
const obsNotices = (root: HTMLElement): string => root.querySelector('[data-testid="obs-notices"]')?.textContent ?? ''
const isArmed = (root: HTMLElement): boolean => lassoButton(root).getAttribute('aria-pressed') === 'true'

function arm(root: HTMLElement): void {
  if (isArmed(root)) return
  const button = lassoButton(root)
  expect(button.disabled).toBe(false)
  button.click()
  expect(isArmed(root)).toBe(true)
}

// The outline's last paint: everything from the last clearRect on.
function lastPaint(): RecordedCall[] {
  const at = recording.calls.map((c) => c.method).lastIndexOf('clearRect')
  return at < 0 ? [] : recording.calls.slice(at)
}
const outlineShown = (): boolean => lastPaint().some((c) => c.method === 'stroke')

async function lassoGeometry() {
  return vi.mocked(await import('../src/data/lasso'))
}

describe('the lasso on the map', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
    stubOutlineContext()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('is enabled while site dots are drawn and disabled with its reason while the map is coloured by parameters', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    const reason = 'no observation site dots are drawn; colour the map by observations'
    expect(lassoButton(root).disabled).toBe(true)
    expect(lassoButton(root).title).toBe(reason)
    expect(root.querySelector('.lasso-control')?.textContent).toContain(reason)

    await enterObservations(store, layer)
    expect(lassoButton(root).disabled).toBe(false)
    expect(root.querySelector('.lasso-control')?.textContent).not.toContain(reason)

    arm(root)
    store.set({ colour: { source: 'par', stat: 'value' } }, 'other')
    await vi.waitFor(() => expect(lassoButton(root).disabled).toBe(true))
    expect(isArmed(root)).toBe(false)
  })

  it('writes the sites of the two dots it catches from the map and leaves cells and parameters', async () => {
    const store = autoStore()
    const { root, stub, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    store.set({ cells: new Set([1]), pars: new Set(['p1']) }, 'other')
    await settle()
    const origins: string[] = []
    store.subscribe(
      (s) => s.sites,
      (_n, _p, o) => origins.push(...o),
    )
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const linkCellsBefore = stub.linkCells.length

    arm(root)
    lassoWorld(canvas, LEFT)
    await settle()

    expect(sorted(store.get().sites)).toEqual([101, 102])
    expect(origins).toEqual(['map'])
    expect(sorted(store.get().cells)).toEqual([1])
    expect(sorted(store.get().pars)).toEqual(['p1'])
    // The click that ended the drag selected nothing and asked nothing about a cell.
    expect(stub.linkCells.length).toBe(linkCellsBefore)
  })

  it('leaves the camera matrix unchanged during an armed drag, where the same drag disarmed pans', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const matrixNow = (): number[] => Array.from(layer.setMatrix.mock.calls.at(-1)![0] as Float32Array)
    const before = matrixNow()
    layer.setMatrix.mockClear()

    arm(root)
    lassoWorld(canvas, RIGHT)
    await settle()
    expect(layer.setMatrix).not.toHaveBeenCalled()
    expect(sorted(store.get().sites)).toEqual([104, 105])

    // Disarmed, the very same drag pans.
    lassoButton(root).click()
    expect(isArmed(root)).toBe(false)
    lassoWorld(canvas, RIGHT)
    await settle()
    expect(layer.setMatrix).toHaveBeenCalled()
    expect(matrixNow()).not.toEqual(before)
  })

  it('adds to the sites with shift held at release and removes with alt', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    arm(root)

    lassoWorld(canvas, LEFT)
    await settle()
    expect(sorted(store.get().sites)).toEqual([101, 102])

    // The lasso stays armed after a release, so a second region can be added.
    expect(isArmed(root)).toBe(true)
    lassoWorld(canvas, RIGHT, { shiftKey: true })
    await settle()
    expect(sorted(store.get().sites)).toEqual([101, 102, 104, 105])

    lassoWorld(canvas, FAR_RIGHT, { altKey: true })
    await settle()
    expect(sorted(store.get().sites)).toEqual([101, 102, 104])

    // Plain replaces.
    lassoWorld(canvas, FAR_RIGHT)
    await settle()
    expect(sorted(store.get().sites)).toEqual([105])
  })

  it('says so and writes nothing when the lasso catches no dot', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    store.set({ sites: new Set([103]) }, 'obs')
    await settle()
    const writes: string[] = []
    store.subscribe(
      (s) => s.sites,
      (_n, _p, o) => writes.push(...o),
    )
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    arm(root)
    lassoWorld(canvas, EMPTY)
    await settle()
    expect(obsNotices(root)).toContain('no site dots inside the region; the selection is unchanged')
    expect(sorted(store.get().sites)).toEqual([103])
    expect(writes).toEqual([])
    expect(outlineShown()).toBe(false)
  })

  it('says the same and writes nothing for a path of fewer than 3 points', async () => {
    const store = autoStore()
    const { root, stub, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const linkCellsBefore = stub.linkCells.length
    arm(root)
    lassoWorld(canvas, [
      [0.25, 0.25],
      [0.25, 0.75],
    ])
    await settle()
    expect(obsNotices(root)).toContain('no site dots inside the region; the selection is unchanged')
    expect(store.get().sites.size).toBe(0)
    expect(stub.linkCells.length).toBe(linkCellsBefore)
  })

  it('never catches a dot on another layer with all layers off, and does with it on', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    arm(root)
    lassoWorld(canvas, LEFT)
    await settle()
    expect(sorted(store.get().sites)).toEqual([101, 102])

    const box = root.querySelector('input[aria-label="All layers"]') as HTMLInputElement
    box.checked = true
    box.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(lastPointCount(layer)).toBe(6))
    await settle()
    arm(root)
    lassoWorld(canvas, LEFT)
    await settle()
    expect(sorted(store.get().sites)).toEqual([101, 102, 106])
  })

  it('keeps the outline after release and through a pan, and takes it away when the Obs tab changes the sites', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    arm(root)
    lassoWorld(canvas, LEFT)
    await settle()
    expect(outlineShown()).toBe(true)
    const firstMove = lastPaint().find((c) => c.method === 'moveTo')!.args as number[]

    // A keyboard pan moves the outline with the map.
    canvas.focus()
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(outlineShown()).toBe(true)
    const movedTo = lastPaint().find((c) => c.method === 'moveTo')!.args as number[]
    expect(movedTo[0]).toBeCloseTo(firstMove[0] + 40)
    expect(movedTo[1]).toBeCloseTo(firstMove[1])

    store.set({ sites: new Set([104]) }, 'obs')
    await settle()
    expect(outlineShown()).toBe(false)
  })

  it('takes the outline away on a later map click', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    arm(root)
    lassoWorld(canvas, LEFT)
    await settle()
    expect(outlineShown()).toBe(true)

    lassoButton(root).click()
    clickAtWorld(canvas, 1.75, 0.5)
    await settle()
    expect(sorted(store.get().sites)).toEqual([105])
    expect(outlineShown()).toBe(false)
  })

  it('builds the dot index once per drawn set of dots', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    const geometry = await lassoGeometry()
    geometry.buildDotIndex.mockClear()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    arm(root)
    lassoWorld(canvas, LEFT)
    lassoWorld(canvas, RIGHT, { shiftKey: true })
    await settle()
    expect(sorted(store.get().sites)).toEqual([101, 102, 104, 105])
    expect(geometry.buildDotIndex).toHaveBeenCalledTimes(1)

    // A time step keeps the dots where they are, so the index stays.
    const slider = root.querySelector('input[aria-label="Observation time of heads"]') as HTMLInputElement
    slider.value = '1'
    slider.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(store.get().timeIdx).toBe(1))
    await settle()
    arm(root)
    lassoWorld(canvas, LEFT)
    await settle()
    expect(geometry.buildDotIndex).toHaveBeenCalledTimes(1)

    // Layer 1 draws another set of dots, so the index is built again.
    store.set({ layer: 1 }, 'other')
    await vi.waitFor(() => expect(lastPointCount(layer)).toBe(1))
    await settle()
    arm(root)
    lassoWorld(canvas, LEFT)
    await settle()
    expect(geometry.buildDotIndex).toHaveBeenCalledTimes(2)
    expect(sorted(store.get().sites)).toEqual([106])
  })
})
