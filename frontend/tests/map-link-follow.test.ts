// @vitest-environment jsdom
//
// The map follows the shared selection, whoever wrote it: selected cells are ringed, selected
// site and pilot-point dots are ringed and the rest dimmed, dot clicks take the modifier rule,
// and what the map cannot draw is counted with its reason. The real map screen against a stubbed
// fetch, with the GL context and the shared MeshLayer double mocked.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { POINT_FLAG_DIM } from '../src/data/hatch-mask'
import { Camera } from '../src/gl/camera'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'

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

// Site ids are not row numbers. s103 sits on layer 1.
const HEADS: SiteSpec[] = [
  { id: 101, name: 's101', x: 0.25, y: 0.6, layer: 0, cell: 0 },
  { id: 102, name: 's102', x: 0.75, y: 0.6, layer: 0, cell: 0 },
  { id: 103, name: 's103', x: 1.5, y: 0.5, layer: 1, cell: 1 },
  { id: 104, name: 's104', x: 1.75, y: 0.5, layer: 0, cell: 1 },
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

function sitesTable(rows: SiteSpec[] = HEADS): Uint8Array {
  return ipc({
    site_id: rows.map((s) => s.id),
    site: rows.map((s) => s.name),
    n_obs: rows.map(() => 3),
    x: rows.map((s) => s.x),
    y: rows.map((s) => s.y),
    xy_source: rows.map(() => 'own'),
    layer: rows.map((s) => s.layer),
    cell: rows.map((s) => s.cell),
    rule: rows.map(() => 'own xy'),
    note: rows.map(() => null),
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
    n_at_time: [4, 4],
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
  // The sites table in this row order instead, so a test can tell identity from position.
  sitesRows: SiteSpec[]
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
    sitesRows: HEADS,
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
          return respond({ status: 200, bytes: sitesTable(stub.sitesRows), headers: { 'X-Pesto-Meta': JSON.stringify({ order_digest: 'digest-a' }) } })
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
  setSiteRings: Mocked
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

// The cell set the layer rings now: its last ring call, read as a list.
function lastRing(layer: LayerDouble): number[] {
  const calls: Array<{ order: number; ids: number[] }> = []
  layer.setSelected.mock.calls.forEach((args, i) => {
    const id = args[0] as number | null
    calls.push({ order: layer.setSelected.mock.invocationCallOrder[i], ids: id === null ? [] : [id] })
  })
  layer.setSelectedCells.mock.calls.forEach((args, i) => {
    calls.push({ order: layer.setSelectedCells.mock.invocationCallOrder[i], ids: [...(args[0] as number[])] })
  })
  calls.sort((a, b) => a.order - b.order)
  return calls.at(-1)?.ids ?? []
}

function clearRingCalls(layer: LayerDouble): void {
  layer.setSelected.mockClear()
  layer.setSelectedCells.mockClear()
  layer.draw.mockClear()
}

describe('the map rings the cells of the shared selection', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('rings cells another view wrote, once, and a write with no change calls nothing', async () => {
    const store = manualStore()
    const { layer } = await mountedWith(store)
    store.flush()
    clearRingCalls(layer)

    store.set({ cells: new Set([0, 1]) }, 'obs')
    store.flush()

    expect(layer.setSelectedCells).toHaveBeenCalledTimes(1)
    expect(layer.setSelectedCells).toHaveBeenCalledWith([0, 1])
    expect(layer.draw).toHaveBeenCalled()

    clearRingCalls(layer)
    store.set({ cells: new Set([1, 0]) }, 'obs')
    store.flush()
    expect(layer.setSelectedCells).not.toHaveBeenCalled()
    expect(layer.setSelected).not.toHaveBeenCalled()
    expect(layer.draw).not.toHaveBeenCalled()
  })

  it('a shift-click on a second cell rings both at once, and still both once the answer lands', async () => {
    const store = manualStore()
    const { root, stub, layer } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    clickAtWorld(canvas, 0.5, 0.5)
    await vi.waitFor(() => expect([...store.get().cells]).toEqual([0]))
    store.flush()
    stub.holdLink = true
    clearRingCalls(layer)

    clickAtWorld(canvas, 1.5, 0.5, { shiftKey: true })

    // Ringed from the set still being asked for, before any answer.
    expect(layer.setSelectedCells).toHaveBeenCalledWith([0, 1])
    expect(store.get().cells.size).toBe(1)
    await vi.waitFor(() => expect(stub.release.length).toBe(1))
    stub.release[0]()
    await vi.waitFor(() => expect([...store.get().cells].sort()).toEqual([0, 1]))
    store.flush()
    expect(lastRing(layer)).toEqual([0, 1])
  })

  it('keeps the cells ringed when the layer changes', async () => {
    const store = manualStore()
    const { layer } = await mountedWith(store)
    store.flush()
    store.set({ cells: new Set([0, 1]) }, 'obs')
    store.flush()
    expect(lastRing(layer)).toEqual([0, 1])

    store.set({ layer: 1 }, 'other')
    store.flush()
    await settle()

    expect(lastRing(layer)).toEqual([0, 1])
    expect([...store.get().cells].sort()).toEqual([0, 1])
  })

  it('takes every ring away when the cells are cleared', async () => {
    const store = manualStore()
    const { layer } = await mountedWith(store)
    store.flush()
    store.set({ cells: new Set([0, 1]) }, 'obs')
    store.flush()

    store.set({ cells: new Set() }, 'obs')
    store.flush()

    expect(lastRing(layer)).toEqual([])
  })
})

function lastPointCount(layer: LayerDouble): number {
  const call = layer.setPoints.mock.calls.at(-1) as [Float32Array, Float32Array] | undefined
  return call === undefined ? -1 : call[1].length
}

// The marks on the dots now, read only from calls made after the last setPoints, which clears them.
function dotMarks(layer: LayerDouble): { ringed: number[]; flags: number[] | null } {
  const pointsAt = Math.max(0, ...layer.setPoints.mock.invocationCallOrder)
  const ringAt = layer.setSelectedPoints.mock.invocationCallOrder.at(-1) ?? -1
  const flagsAt = layer.setPointFlags.mock.invocationCallOrder.at(-1) ?? -1
  expect(ringAt).toBeGreaterThan(pointsAt)
  expect(flagsAt).toBeGreaterThan(pointsAt)
  const flags = layer.setPointFlags.mock.calls.at(-1)![0] as Float32Array | null
  return { ringed: [...(layer.setSelectedPoints.mock.calls.at(-1)![0] as number[])], flags: flags === null ? null : Array.from(flags) }
}

const noneDimmed = (flags: number[] | null): boolean => flags === null || flags.every((f) => f === 0)

async function enterObservations(store: SelectionStore, layer: LayerDouble, dots = 3): Promise<void> {
  store.set({ colour: { source: 'obs', stat: 'resid_mean' } }, 'other')
  await vi.waitFor(() => expect(lastPointCount(layer)).toBe(dots))
  await settle()
}

async function chooseGroup(root: HTMLElement, layer: LayerDouble, group: string, dots: number): Promise<void> {
  const picker = root.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
  picker.value = group
  picker.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(lastPointCount(layer)).toBe(dots))
  await settle()
}

const readoutText = (root: HTMLElement): string => root.querySelector('.floating-bottom-right')?.textContent ?? ''
const sorted = <T,>(set: ReadonlySet<T>): T[] => [...set].sort()

describe('the map rings and dims dots from the shared selection', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.documentElement.style.removeProperty('--dim-alpha')
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('rings the selected site dots and dims the rest, and an empty selection dims nothing', async () => {
    const store = autoStore()
    const { layer } = await mountedWith(store)
    await enterObservations(store, layer)

    // Drawn on layer 0: s101, s102 and s104, in that order.
    store.set({ sites: new Set([101, 104]) }, 'obs')
    await settle()
    let marks = dotMarks(layer)
    expect(marks.ringed).toEqual([0, 2])
    expect(marks.flags).toEqual([0, POINT_FLAG_DIM, 0])

    store.set({ sites: new Set() }, 'obs')
    await settle()
    marks = dotMarks(layer)
    expect(marks.ringed).toEqual([])
    expect(noneDimmed(marks.flags)).toBe(true)
  })

  it('dims every drawn dot while the selected sites are all off this layer, and hides none', async () => {
    const store = autoStore()
    const { layer } = await mountedWith(store)
    await enterObservations(store, layer)
    store.set({ sites: new Set([103]) }, 'obs')
    await settle()
    const marks = dotMarks(layer)
    expect(marks.ringed).toEqual([])
    expect(marks.flags).toEqual([POINT_FLAG_DIM, POINT_FLAG_DIM, POINT_FLAG_DIM])
    expect(lastPointCount(layer)).toBe(3)
  })

  it('rings the same sites again after a time-slider step and after a layer change redraw the dots', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    store.set({ sites: new Set([101, 103]) }, 'obs')
    await settle()
    expect(dotMarks(layer).ringed).toEqual([0])

    const slider = root.querySelector('input[aria-label="Observation time of heads"]') as HTMLInputElement
    slider.value = '1'
    slider.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(store.get().timeIdx).toBe(1))
    await vi.waitFor(() => expect(layer.setPointValues).toHaveBeenCalled())
    await settle()
    let marks = dotMarks(layer)
    expect(marks.ringed).toEqual([0])
    expect(marks.flags).toEqual([0, POINT_FLAG_DIM, POINT_FLAG_DIM])

    // Layer 1 draws s103 alone.
    store.set({ layer: 1 }, 'other')
    await vi.waitFor(() => expect(lastPointCount(layer)).toBe(1))
    await settle()
    marks = dotMarks(layer)
    expect(marks.ringed).toEqual([0])
    expect(marks.flags).toEqual([0])
  })

  it('rings the selected pilot-point dots and dims the rest; no parameter dims nothing', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await chooseGroup(root, layer, 'k', 2)

    store.set({ pars: new Set(['pb']) }, 'params')
    await settle()
    let marks = dotMarks(layer)
    expect(marks.ringed).toEqual([1])
    expect(marks.flags).toEqual([POINT_FLAG_DIM, 0])

    store.set({ pars: new Set() }, 'params')
    await settle()
    marks = dotMarks(layer)
    expect(marks.ringed).toEqual([])
    expect(noneDimmed(marks.flags)).toBe(true)
  })

  it('a site-dot click replaces, adds or removes sites, and only a plain click clears cells and parameters', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement

    clickAtWorld(canvas, 0.25, 0.6)
    expect(sorted(store.get().sites)).toEqual([101])
    store.set({ cells: new Set([0]), pars: new Set(['p0']) }, 'other')
    await settle()

    clickAtWorld(canvas, 1.75, 0.5, { shiftKey: true })
    expect(sorted(store.get().sites)).toEqual([101, 104])
    expect(sorted(store.get().cells)).toEqual([0])
    expect(sorted(store.get().pars)).toEqual(['p0'])
    // The readout still lists the site just clicked.
    expect(readoutText(root)).toContain('s104')

    clickAtWorld(canvas, 0.25, 0.6, { altKey: true })
    expect(sorted(store.get().sites)).toEqual([104])
    expect(sorted(store.get().cells)).toEqual([0])

    clickAtWorld(canvas, 0.75, 0.6)
    expect(sorted(store.get().sites)).toEqual([102])
    expect(store.get().cells.size).toBe(0)
    expect(store.get().pars.size).toBe(0)
    await settle()
    expect(dotMarks(layer).ringed).toEqual([1])
  })

  it('a pilot-point-dot click adds with shift, replaces on a plain click, and never touches the sites', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await chooseGroup(root, layer, 'k', 2)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    store.set({ sites: new Set([101]), cells: new Set([0]), pars: new Set(['pb']) }, 'other')
    await settle()

    clickAtWorld(canvas, 0.25, 0.5, { shiftKey: true })
    expect(sorted(store.get().pars)).toEqual(['pa', 'pb'])
    expect(sorted(store.get().cells)).toEqual([0])
    expect(sorted(store.get().sites)).toEqual([101])

    clickAtWorld(canvas, 1.5, 0.5)
    expect(sorted(store.get().pars)).toEqual(['pb'])
    expect(store.get().cells.size).toBe(0)
    expect(sorted(store.get().sites)).toEqual([101])
    await settle()
    expect(dotMarks(layer).ringed).toEqual([1])
  })

  it('reads the dim strength from the theme on mount and again on a theme change', async () => {
    document.documentElement.style.setProperty('--dim-alpha', '0.4')
    const store = autoStore()
    const { layer } = await mountedWith(store)
    expect(layer.setDimAlpha).toHaveBeenCalledWith(0.4)

    document.documentElement.style.setProperty('--dim-alpha', '0.3')
    const theme = document.querySelector('select[aria-label="Theme"]') as HTMLSelectElement
    theme.value = 'dark'
    theme.dispatchEvent(new Event('change'))
    expect(layer.setDimAlpha.mock.calls.at(-1)).toEqual([0.3])
  })
})

const whereLinesOf = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('[data-testid="selection-where"] .link-reach')].map((el) => el.textContent ?? '')
const selectedNoticeText = (root: HTMLElement): string =>
  root.querySelector('[data-testid="iteration-selected-notice"]')?.textContent ?? ''

function parRow(over: Partial<LinkParRow> & { parnme: string }): LinkParRow {
  return { pargp: 'G1', kind: 'cell', layer: 0, cell: 0, cells: [0], n_cells: 1, cells_capped: false, reason: null, ...over }
}

describe('a parameter picked in a tab rings its cells on the map', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('asks /link/par once and rings the cells it sets on the drawn layer', async () => {
    const store = autoStore()
    const { stub, layer } = await mountedWith(store)
    stub.pars.p8 = parRow({ parnme: 'p8', cell: 1, cells: [1] })

    store.set({ pars: new Set(['p8']) }, 'params')
    await vi.waitFor(() => expect(lastRing(layer)).toEqual([1]))
    expect(stub.linkPar).toEqual([['p8']])
  })

  it('outlines a pilot point reach as one set, and says when a pilot point is on another layer', async () => {
    const store = autoStore()
    const { root, stub, layer } = await mountedWith(store)
    stub.pars.pp1 = parRow({ parnme: 'pp1', kind: 'pilot_point', cell: -1, cells: [0, 1], n_cells: 2 })
    stub.pars.pp2 = parRow({ parnme: 'pp2', kind: 'pilot_point', layer: 2, cell: -1, cells: [0], n_cells: 1 })

    store.set({ pars: new Set(['pp1']) }, 'params')
    await vi.waitFor(() => expect(lastRing(layer)).toEqual([0, 1]))

    store.set({ pars: new Set(['pp2']) }, 'params')
    await vi.waitFor(() => expect(whereLinesOf(root)).toEqual(['1 selected parameter is on layer 3 (index 2)']))
    expect(lastRing(layer)).toEqual([])
  })

  it('counts a parameter with no cell with its reason', async () => {
    const store = autoStore()
    const { root, stub } = await mountedWith(store)
    stub.pars.u1 = parRow({ parnme: 'u1', kind: 'unplaced', layer: -1, cell: -1, cells: [], n_cells: 0, reason: 'no cell is recorded for this parameter: rule unmapped' })

    store.set({ pars: new Set(['u1']) }, 'params')
    await vi.waitFor(() =>
      expect(whereLinesOf(root)).toEqual(['1 selected parameter has no cell: no cell is recorded for this parameter: rule unmapped']),
    )
  })

  it('drops the parameter rings and asks nothing when the map itself writes the parameters', async () => {
    const store = autoStore()
    const { root, stub, layer } = await mountedWith(store)
    stub.pars.p8 = parRow({ parnme: 'p8', cell: 1, cells: [1] })
    store.set({ pars: new Set(['p8']) }, 'params')
    await vi.waitFor(() => expect(lastRing(layer)).toEqual([1]))

    clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 0.5, 0.5)
    await vi.waitFor(() => expect(sorted(store.get().pars)).toEqual(['p0']))
    await settle()

    expect(lastRing(layer)).toEqual([0])
    expect(stub.linkPar).toEqual([['p8']])
    expect(whereLinesOf(root)).toEqual([])
  })
})

describe('the map counts the selected sites it cannot draw, and never moves', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('counts sites on another layer, in another group, not placed and not in the index', async () => {
    const store = autoStore()
    const { root, stub, layer } = await mountedWith(store)
    stub.sites[201] = { site_id: 201, site: 'd1', group: 'deep', layer: 0, cell: 0, placed: true, has_value: true }
    stub.sites[202] = { site_id: 202, site: 'u1', group: 'heads', layer: -1, cell: -1, placed: false, has_value: true }
    await enterObservations(store, layer)

    store.set({ sites: new Set([103, 201, 202, 999]) }, 'obs')
    await vi.waitFor(() =>
      expect(whereLinesOf(root)).toEqual([
        '1 selected site is on layer 2 (index 1)',
        '1 selected site is in another group (shown: heads)',
        '1 selected site is not placed',
        "1 selected site is not in this run's index",
      ]),
    )
    expect(stub.linkSites.at(-1)).toEqual({ sites: '103,201,202,999', iteration: '0' })
  })

  it('says to turn on all layers for a site of unknown layer', async () => {
    const store = autoStore()
    const { root, stub, layer } = await mountedWith(store)
    stub.sites[105] = { site_id: 105, site: 'q', group: 'heads', layer: -1, cell: 1, placed: true, has_value: true }
    await enterObservations(store, layer)
    store.set({ sites: new Set([105]) }, 'obs')
    await vi.waitFor(() => expect(whereLinesOf(root)).toEqual(['1 selected site has an unknown layer; turn on all layers to see it']))
  })

  it('counts a ringed dot panned off screen, and a selection from a tab never moves the camera', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    const matrices = layer.setMatrix.mock.calls.length

    store.set({ sites: new Set([101, 104]) }, 'obs')
    await vi.waitFor(() => expect(dotMarks(layer).ringed).toEqual([0, 2]))
    await settle()
    expect(layer.setMatrix.mock.calls.length).toBe(matrices)
    expect(whereLinesOf(root)).toEqual([])

    // s101 and s104 sit 112 px inside the left and right edges; four 40 px pans push one out.
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    canvas.focus()
    for (let i = 0; i < 4; i++) canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    expect(whereLinesOf(root)).toEqual(['1 selected site is off screen'])
  })

  it('adds the count of sites with no valid observation to the iteration notice', async () => {
    const store = autoStore()
    const { root, stub } = await mountedWith(store)
    stub.sites[101] = { ...stub.sites[101], has_value: false }
    stub.sites[102] = { ...stub.sites[102], has_value: false }
    const ids = [101, 102, 103, 104, 501, 502, 503, 504, 505, 506, 507, 508]

    store.set({ sites: new Set(ids) }, 'obs')
    await vi.waitFor(() =>
      expect(selectedNoticeText(root)).toContain('2 of 12 selected sites have no valid observation in iteration 0; the selection is kept'),
    )
  })

  it('says the selected sites cannot be checked, with the reason, when the iteration has no statistics', async () => {
    const store = autoStore()
    const { root, stub } = await mountedWith(store)
    stub.valueReason = 'obs_agg/0 could not be read: the file is missing'

    store.set({ sites: new Set([101]) }, 'obs')
    await vi.waitFor(() => expect(selectedNoticeText(root)).toContain('Selected sites cannot be checked in iteration 0'))
    expect(selectedNoticeText(root)).toContain('obs_agg/0 could not be read: the file is missing')
  })

  it('checks the first 200 of more selected sites and says how many were not', async () => {
    const store = autoStore()
    const { root, stub } = await mountedWith(store)
    const ids = Array.from({ length: 205 }, (_, i) => 1000 + i)

    store.set({ sites: new Set(ids) }, 'obs')
    await vi.waitFor(() =>
      expect(whereLinesOf(root)).toEqual(["200 selected sites are not in this run's index", '5 selected sites are not checked: only the first 200 are']),
    )
    expect(stub.linkSites.at(-1)!.sites.split(',').length).toBe(200)

    await enterObservations(store, await layerDouble())
    await vi.waitFor(() => expect(whereLinesOf(root)).toContain('5 selected sites are not checked: only the first 200 are'))
    expect(whereLinesOf(root)).toContain("200 selected sites are not in this run's index")
  })

  it('shows a name and reason from the server as text, never as markup', async () => {
    const store = autoStore()
    const { root, stub, layer } = await mountedWith(store)
    await enterObservations(store, layer)
    stub.pars['<b>x</b>'] = parRow({ parnme: '<b>x</b>', kind: 'unplaced', layer: -1, cell: -1, cells: [], n_cells: 0, reason: '<i>no cell</i>' })
    store.set({ pars: new Set(['<b>x</b>']) }, 'params')
    await vi.waitFor(() => expect(whereLinesOf(root)).toEqual(['1 selected parameter has no cell: <i>no cell</i>']))
    expect(root.querySelector('[data-testid="selection-where"] i')).toBeNull()
  })
})

// The rings the layer draws now over the parameter field, as x, y pairs.
function siteRingXy(layer: LayerDouble): number[] {
  const call = layer.setSiteRings.mock.calls.at(-1) as [Float32Array] | undefined
  return call === undefined ? [] : Array.from(call[0]).map((v) => Math.round(v * 100) / 100)
}

describe('picked sites are rings over a parameter field', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('rings only the picked sites, each at its own x, y matched by id, and calls none of them not drawn', async () => {
    const store = autoStore()
    const { root, stub, layer } = await mountedWith(store)
    // The sites table in another row order than the ids, so a ring by row position lands on the wrong site.
    stub.sitesRows = [...HEADS].reverse()

    store.set({ sites: new Set([104, 101]) }, 'obs')
    await vi.waitFor(() => expect(siteRingXy(layer)).toEqual([0.25, 0.6, 1.75, 0.5]))
    expect(whereLinesOf(root)).toEqual([])
    expect(root.textContent).not.toContain('not drawn')
    // The parameter field stays: no site dots replace it.
    expect(layer.setPoints.mock.calls.every((args) => (args[1] as Float32Array).length === 0)).toBe(true)

    store.set({ sites: new Set() }, 'obs')
    await vi.waitFor(() => expect(siteRingXy(layer)).toEqual([]))
  })

  it('rings a site on another layer only on its own layer, and says which layer it is on', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)

    store.set({ sites: new Set([103, 104]) }, 'obs')
    await vi.waitFor(() => expect(whereLinesOf(root)).toEqual(['1 selected site is on layer 2 (index 1), not drawn on layer 1 (index 0)']))
    expect(siteRingXy(layer)).toEqual([1.75, 0.5])

    store.set({ layer: 1 }, 'other')
    await vi.waitFor(() => expect(siteRingXy(layer)).toEqual([1.5, 0.5]))
    await vi.waitFor(() => expect(whereLinesOf(root)).toEqual(['1 selected site is on layer 1 (index 0), not drawn on layer 2 (index 1)']))
  })

  it('lists a site with no position, and one not in the index, and rings neither', async () => {
    const store = autoStore()
    const { root, stub, layer } = await mountedWith(store)
    stub.sitesRows = [...HEADS, { id: 106, name: 's106', x: Number.NaN, y: Number.NaN, layer: -1, cell: -1 }]
    stub.sites[106] = { site_id: 106, site: 's106', group: 'heads', layer: -1, cell: -1, placed: false, has_value: true }

    store.set({ sites: new Set([106, 999, 102]) }, 'obs')
    await vi.waitFor(() =>
      expect(whereLinesOf(root)).toEqual([
        '1 selected site has no position, not drawn: no position was recorded for this site',
        "1 selected site is not in this run's index",
      ]),
    )
    expect(siteRingXy(layer)).toEqual([0.75, 0.6])
  })

  it('takes the rings away while the map is coloured by observations, where the dots carry the selection', async () => {
    const store = autoStore()
    const { layer } = await mountedWith(store)
    store.set({ sites: new Set([101]) }, 'obs')
    await vi.waitFor(() => expect(siteRingXy(layer)).toEqual([0.25, 0.6]))

    await enterObservations(store, layer)
    expect(siteRingXy(layer)).toEqual([])
    expect(dotMarks(layer).ringed).toEqual([0])
  })

  it('a ring click picks and reads its site as a site-dot click does, over the cell under it', async () => {
    const store = autoStore()
    const { root, stub, layer } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    store.set({ sites: new Set([101, 104]), cells: new Set([0]), pars: new Set(['p0']) }, 'obs')
    await vi.waitFor(() => expect(siteRingXy(layer)).toEqual([0.25, 0.6, 1.75, 0.5]))

    clickAtWorld(canvas, 0.25, 0.6, { altKey: true })
    expect(sorted(store.get().sites)).toEqual([104])
    expect(sorted(store.get().cells)).toEqual([0])
    expect(sorted(store.get().pars)).toEqual(['p0'])
    await vi.waitFor(() => expect(siteRingXy(layer)).toEqual([1.75, 0.5]))

    clickAtWorld(canvas, 1.75, 0.5)
    expect(sorted(store.get().sites)).toEqual([104])
    expect(store.get().cells.size).toBe(0)
    expect(store.get().pars.size).toBe(0)
    expect(readoutText(root)).toContain('s104 (heads)')
    expect(readoutText(root)).toContain('no observation time: the map is coloured by parameters')
    // The click named the site, not the cell under the ring.
    expect(stub.linkCells).toEqual([])
  })

  it('a click 7 px from a ring picks its site, as the 8 px reach of a dot does', async () => {
    const store = autoStore()
    const { root, layer } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    store.set({ sites: new Set([101, 104]) }, 'obs')
    await vi.waitFor(() => expect(siteRingXy(layer)).toEqual([0.25, 0.6, 1.75, 0.5]))
    // Canvas px per world unit as Camera.fit lays this 2 by 1 mesh out, with its 4% padding.
    const scale = 0.96 * Math.min(canvas.width / 2, canvas.height)
    clickAtWorld(canvas, 1.75 + 7 / scale, 0.5)
    expect(sorted(store.get().sites)).toEqual([104])
    expect(readoutText(root)).toContain('s104 (heads)')
  })
})
