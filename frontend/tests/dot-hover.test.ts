// @vitest-environment jsdom
//
// The hand cursor over a dot and the 8 px click reach: a click 7 CSS px from a dot's centre picks
// it and 9 px misses, at both device ratios; the hover test runs once per frame, never during a
// pan, and steps aside for an armed tool. The lasso suite's map harness, with dotWithin counted.

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

// The real geometry, counted, so a test can tell when and how the hover asks it.
vi.mock('../src/data/lasso', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/data/lasso')>()
  return { ...actual, dotWithin: vi.fn(actual.dotWithin) }
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

const mapArea = (root: HTMLElement): HTMLElement => root.querySelector('.map-area') as HTMLElement
const hovering = (root: HTMLElement): boolean => mapArea(root).classList.contains('dot-hover')
const lassoButton = (root: HTMLElement): HTMLButtonElement => root.querySelector('.lasso-button') as HTMLButtonElement

// World to client pixels with the canvas backing store `ratio` times its CSS box, as fitCanvasToFrame sizes it.
function clientAtRatio(canvas: HTMLCanvasElement, wx: number, wy: number, ratio: number): [number, number] {
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: canvas.width / ratio, height: canvas.height / ratio }) as DOMRect
  const camera = new Camera(canvas.width, canvas.height)
  camera.fit([0, 2, 0, 1])
  const [x0, y0] = camera.screenToWorld(0, 0)
  const [x1, y1] = camera.screenToWorld(1, 1)
  return [(wx - x0) / (x1 - x0) / ratio, (wy - y0) / (y1 - y0) / ratio]
}

// Frames run only when the test says so, so it can count them.
function manualFrames(): { run: () => void; pending: () => number } {
  let queue: FrameRequestCallback[] = []
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    }),
  )
  return {
    run: () => {
      const now = queue
      queue = []
      for (const cb of now) cb(0)
    },
    pending: () => queue.length,
  }
}

function move(canvas: HTMLCanvasElement, at: [number, number]): void {
  canvas.dispatchEvent(pointer('pointermove', at, { buttons: 0 }))
}

async function lassoGeometry() {
  return vi.mocked(await import('../src/data/lasso'))
}

describe('dotWithin', () => {
  it('finds a dot within reach through the index or by scanning, and none beyond it', async () => {
    const { buildDotIndex, dotWithin } = await vi.importActual<typeof import('../src/data/lasso')>('../src/data/lasso')
    const xy = new Float32Array([0, 0, 10, 0, 10, 10])
    const tree = buildDotIndex(xy)
    for (const t of [tree, null]) {
      expect(dotWithin(t, xy, 10, 3, 3)).toBe(true)
      expect(dotWithin(t, xy, 10, 3.5, 3)).toBe(false)
      // Inside the search box's corner but further than r from every dot.
      expect(dotWithin(t, xy, 2.5, 2.5, 3)).toBe(false)
      expect(dotWithin(t, xy, 2, 2, 3)).toBe(true)
    }
    expect(dotWithin(null, new Float32Array(0), 0, 0, 5)).toBe(false)
  })
})

describe('the reach of a click on a site dot', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
    stubOutlineContext()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  for (const ratio of [1, 2]) {
    it(`picks a site 7 CSS px from its centre and not 9 px away, at a device ratio of ${ratio}`, async () => {
      const store = autoStore()
      const { root, layer } = await mountedWith(store)
      await enterObservations(store, layer)
      vi.stubGlobal('devicePixelRatio', ratio)
      const canvas = root.querySelector('canvas') as HTMLCanvasElement
      const [x, y] = clientAtRatio(canvas, 0.75, 0.5, ratio)

      canvas.dispatchEvent(new MouseEvent('click', { clientX: x + 7, clientY: y, bubbles: true }))
      await settle()
      expect([...store.get().sites]).toEqual([103])

      store.set({ sites: new Set() }, 'other')
      await settle()
      canvas.dispatchEvent(new MouseEvent('click', { clientX: x + 9, clientY: y, bubbles: true }))
      await settle()
      expect(store.get().sites.has(103)).toBe(false)
    })
  }
})

describe('the hand cursor over a dot', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
    stubOutlineContext()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('shows within one frame over a site dot and goes when the pointer moves off or leaves', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    const frames = manualFrames()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const [x, y] = clientAtRatio(canvas, 0.75, 0.5, 1)

    move(canvas, [x + 7, y])
    expect(hovering(root)).toBe(false)
    frames.run()
    expect(hovering(root)).toBe(true)

    move(canvas, [x + 9, y])
    frames.run()
    expect(hovering(root)).toBe(false)

    move(canvas, [x, y])
    frames.run()
    expect(hovering(root)).toBe(true)
    canvas.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1 }))
    expect(hovering(root)).toBe(false)
  })

  it('asks the drawn dots index once per frame however many moves arrive', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    const geometry = await lassoGeometry()
    const frames = manualFrames()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const [x, y] = clientAtRatio(canvas, 0.75, 0.5, 1)
    geometry.dotWithin.mockClear()

    for (let i = 0; i < 5; i++) move(canvas, [x + i, y])
    expect(frames.pending()).toBe(1)
    frames.run()
    expect(geometry.dotWithin).toHaveBeenCalledTimes(1)
    // The site dots go through their Flatbush index, not a scan.
    expect(geometry.dotWithin.mock.calls[0][0]).not.toBeNull()
    expect(hovering(root)).toBe(true)
  })

  it('never runs during a pan', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    const geometry = await lassoGeometry()
    const frames = manualFrames()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const [x, y] = clientAtRatio(canvas, 0.75, 0.5, 1)
    geometry.dotWithin.mockClear()

    canvas.dispatchEvent(pointer('pointerdown', [x + 40, y]))
    for (let i = 0; i < 5; i++) canvas.dispatchEvent(pointer('pointermove', [x + 30 - 6 * i, y], { buttons: 1 }))
    frames.run()
    expect(geometry.dotWithin).not.toHaveBeenCalled()
    expect(hovering(root)).toBe(false)
    canvas.dispatchEvent(pointer('pointerup', [x, y]))
  })

  it('steps aside while the lasso is armed, so its crosshair shows', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    const frames = manualFrames()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const [x, y] = clientAtRatio(canvas, 0.75, 0.5, 1)

    move(canvas, [x, y])
    frames.run()
    expect(hovering(root)).toBe(true)

    lassoButton(root).click()
    expect(lassoButton(root).getAttribute('aria-pressed')).toBe('true')
    move(canvas, [x, y])
    frames.run()
    expect(hovering(root)).toBe(false)
    expect(frames.pending()).toBe(0)
  })

  it('shows over a parameter dot when the map is coloured by parameters', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    const picker = root.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
    picker.value = 'k'
    picker.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(layer.setPoints.mock.calls.at(-1)?.[1]?.length).toBe(2))
    const frames = manualFrames()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const [x, y] = clientAtRatio(canvas, 0.25, 0.5, 1)

    move(canvas, [x + 7, y])
    frames.run()
    expect(hovering(root)).toBe(true)
    move(canvas, [x + 9, y])
    frames.run()
    expect(hovering(root)).toBe(false)
  })
})
