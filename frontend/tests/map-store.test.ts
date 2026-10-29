// @vitest-environment jsdom
//
// The map view and the shared selection store: what a click on the map
// writes, what a control move writes, and how the map follows a change made
// by another view. Same harness as redraw.test.ts: the real map screen
// against a stubbed fetch, with only the two GL modules mocked.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
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
    },
    ingestSeconds: null,
    cacheBytes: null,
  }
}

// Two unit cells side by side, two layers. Cell 0 sits on layer 0 and cell 1
// on layer 1, both in group G1, so a layer move changes what is drawn.
const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 2, bounds: [0, 2, 0, 1], crs: null, tag: 'store' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 1])
const LAYER_ARRAY = new Int32Array([0, 1])
const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }),
  'stream',
)
// Groups a and b are drawn (a is linear, b is log); u is in the control table but never placed.
const TWO_GROUPS_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1', 'p2'], pargp: ['a', 'b', 'u'], partrans: ['none', 'log', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base', 'r001', 'r002'] }), 'stream')
const FIELDS: Record<string, number[]> = { base: [10, 20], r001: [11, 21], r002: [12, 22] }

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

interface LinkReply {
  status: number
  body?: unknown
  throws?: string
}

interface Stub {
  calls: string[]
  valuesCalls: string[]
  // The cells= of every /link/cell request, in order.
  linkCells: string[]
  // How /link/cell answers; by default each cell holds parameter p<cell> and site 100 + cell.
  linkReply: (cells: number[]) => LinkReply
  // When set, each /link/cell answer waits until a test calls its release.
  holdLink: boolean
  release: (() => void)[]
}

function linkBody(cells: number[]): Record<string, unknown> {
  return {
    layer: 0,
    cells,
    ring: [],
    ring_rule: 'a neighbouring cell shares at least one corner with a clicked cell',
    pars: cells.map((c) => ({ parnme: `p${c}`, pargp: 'G1', kind: 'cell', cell: c, weights: [], rule: 'sets this cell (par_cell)' })),
    pars_total: cells.length,
    par_notes: [],
    sites: cells.map((c) => ({ site_id: 100 + c, site: `s${c}`, group: 'heads', layer: 0, cell: c, in_clicked_cell: true })),
    sites_total: cells.length,
    sites_cap: 50,
    site_counts: { unknown_layer_included: 0, other_layer_left_out: 0, unplaced_in_run: 0 },
    reasons: { pars: null, sites: null },
  }
}

function stubEnvironment(parTable: Uint8Array = PAR_TABLE): Stub {
  const stub: Stub = {
    calls: [],
    valuesCalls: [],
    linkCells: [],
    linkReply: (cells) => ({ status: 200, body: linkBody(cells) }),
    holdLink: false,
    release: [],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path, search] = url.split('?')
      stub.calls.push(`GET ${path}`)
      const query = new URLSearchParams(search ?? '')
      const respond = (result: { status: number; bytes?: Uint8Array; body?: unknown; headers?: Record<string, string> }) => {
        const bytes = result.bytes ?? new Uint8Array(0)
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          json: async () => result.body ?? {},
          arrayBuffer: async () => bytes.buffer,
          headers: { get: (name: string) => result.headers?.[name] ?? null },
        }
      }
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
          return respond({ status: 200, bytes: parTable })
        case '/api/run/grid/cells/cell':
          return respond({ status: 200, bytes: bytesOf(CELL_ARRAY) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(LAYER_ARRAY) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 404, body: { title: 'no point positions were recorded for that iteration', status: 404 } })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values': {
          stub.valuesCalls.push(query.get('realization') ?? query.get('stat') ?? '')
          const name = query.get('realization') ?? 'base'
          const field = FIELDS[name] ?? FIELDS.base
          return respond({ status: 200, bytes: bytesOf(new Float32Array(field)) })
        }
        case '/api/run/link/cell': {
          const text = query.get('cells') ?? ''
          stub.linkCells.push(text)
          if (stub.holdLink) await new Promise<void>((resolve) => stub.release.push(resolve))
          const reply = stub.linkReply(text.split(',').map(Number))
          if (reply.throws) throw new Error(reply.throws)
          return respond({ status: reply.status, body: reply.body })
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
  return createSelectionStore({
    initial: emptySelection('test_run', 0),
    schedule: () => {},
  })
}

async function mountedWith(
  store: SelectionStore,
  parTable: Uint8Array = PAR_TABLE,
  config: RunConfig = CONFIG,
): Promise<{ root: HTMLElement; stub: Stub }> {
  const stub = stubEnvironment(parTable)
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
  mountMap(root, { config, state: baseState(), store })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  return { root, stub }
}

async function meshLayerInstance() {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer).mock.instances[0] as unknown as {
    setSelected: ReturnType<typeof vi.fn>
    setValues: ReturnType<typeof vi.fn>
  }
}

// Where a world point lands on the canvas after Camera.fit, read back
// through screenToWorld so the test does not repeat the fit arithmetic.
function clickAtWorld(canvas: HTMLCanvasElement, wx: number, wy: number, keys: MouseEventInit = {}): void {
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
  const camera = new Camera(canvas.width, canvas.height)
  camera.fit([0, 2, 0, 1])
  const [x0, y0] = camera.screenToWorld(0, 0)
  const [x1, y1] = camera.screenToWorld(1, 1)
  const clientX = (wx - x0) / (x1 - x0)
  const clientY = (wy - y0) / (y1 - y0)
  canvas.dispatchEvent(new MouseEvent('click', { ...keys, clientX, clientY }))
}

const cellsOf = (store: SelectionStore): number[] => [...store.get().cells].sort((a, b) => a - b)

// Clicks and waits until the store holds `cells`, which happens once /link/cell has answered.
async function clickAndWait(store: SelectionStore, canvas: HTMLCanvasElement, wx: number, keys: MouseEventInit, cells: number[]): Promise<void> {
  clickAtWorld(canvas, wx, 0.5, keys)
  await vi.waitFor(() => expect(cellsOf(store)).toEqual(cells))
}

// Lets every pending promise settle, so "nothing was written" is not read too early.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('a click on the map writes to the store', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('rings at once and writes cells with the answer', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const instance = await meshLayerInstance()
    instance.setSelected.mockClear()
    store.flush()

    clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 1.5, 0.5)

    expect(instance.setSelected).toHaveBeenCalledWith(1)
    await vi.waitFor(() => expect(cellsOf(store)).toEqual([1]))
    expect(stub.linkCells).toEqual(['1'])
    expect([...store.get().pars]).toEqual(['p1'])
    expect([...store.get().sites]).toEqual([101])
  })

  it('a click on the already-selected cell wakes no subscriber', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    await clickAndWait(store, canvas, 0.5, {}, [0])
    store.flush()

    const heard = vi.fn()
    store.subscribe((s) => s.cells, heard)
    clickAtWorld(canvas, 0.5, 0.5)
    await settle()
    store.flush()

    expect(heard).not.toHaveBeenCalled()
    expect(stub.linkCells).toEqual(['0'])
  })

  it('a plain click on empty space clears cells, sites and parameters in one write', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    await clickAndWait(store, canvas, 0.5, {}, [0])
    store.flush()
    const heard = vi.fn()
    store.subscribe((s) => [s.cells, s.pars, s.sites], heard)

    clickAtWorld(canvas, 5, 5)

    expect(store.get().cells.size).toBe(0)
    expect(store.get().pars.size).toBe(0)
    expect(store.get().sites.size).toBe(0)
    store.flush()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('a shift or alt click on empty space changes nothing', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    await clickAndWait(store, canvas, 0.5, {}, [0])
    store.flush()
    const heard = vi.fn()
    store.subscribe((s) => [s.cells, s.pars, s.sites], heard)

    clickAtWorld(canvas, 5, 5, { shiftKey: true })
    clickAtWorld(canvas, 5, 5, { altKey: true })
    await settle()
    store.flush()

    expect(heard).not.toHaveBeenCalled()
    expect(cellsOf(store)).toEqual([0])
    expect(stub.linkCells).toEqual(['0'])
  })

  it('shift-click adds a cell and alt-click removes one, each asking for the whole new set', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    await clickAndWait(store, canvas, 0.5, {}, [0])

    await clickAndWait(store, canvas, 1.5, { shiftKey: true }, [0, 1])
    expect(stub.linkCells.at(-1)).toBe('0,1')
    expect([...store.get().pars].sort()).toEqual(['p0', 'p1'])

    // Option on macOS sets altKey; alt wins when shift is held too.
    await clickAndWait(store, canvas, 0.5, { altKey: true, shiftKey: true }, [1])
    expect(stub.linkCells.at(-1)).toBe('1')
    expect([...store.get().pars]).toEqual(['p1'])
  })

  it('a quick second shift-click adds to the set still being asked for', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    stub.holdLink = true

    clickAtWorld(canvas, 0.5, 0.5)
    clickAtWorld(canvas, 1.5, 0.5, { shiftKey: true })
    await vi.waitFor(() => expect(stub.release.length).toBe(2))
    stub.release.forEach((release) => release())

    await vi.waitFor(() => expect(cellsOf(store)).toEqual([0, 1]))
    expect(stub.linkCells).toEqual(['0', '0,1'])
  })

  it('alt-click on the only selected cell writes cells only and asks nothing', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    await clickAndWait(store, canvas, 0.5, {}, [0])
    store.flush()
    const instance = await meshLayerInstance()
    instance.setSelected.mockClear()

    clickAtWorld(canvas, 0.5, 0.5, { altKey: true })

    expect(store.get().cells.size).toBe(0)
    expect([...store.get().pars]).toEqual(['p0'])
    expect([...store.get().sites]).toEqual([100])
    expect(instance.setSelected).toHaveBeenCalledWith(null)
    await settle()
    expect(stub.linkCells).toEqual(['0'])
  })

  it('shift-click on a cell already in the set writes nothing and wakes no one', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    await clickAndWait(store, canvas, 0.5, {}, [0])
    store.flush()
    const heard = vi.fn()
    store.subscribe((s) => [s.cells, s.pars, s.sites], heard)

    clickAtWorld(canvas, 0.5, 0.5, { shiftKey: true })
    await settle()
    store.flush()

    expect(heard).not.toHaveBeenCalled()
    expect(stub.linkCells).toEqual(['0'])
  })

  it('never writes the answer for an older click once a newer one is made', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const seenPars: string[][] = []
    store.subscribe(
      (s) => s.pars,
      (next) => seenPars.push([...next.pars]),
    )
    stub.holdLink = true

    clickAtWorld(canvas, 0.5, 0.5)
    clickAtWorld(canvas, 1.5, 0.5)
    await vi.waitFor(() => expect(stub.release.length).toBe(2))
    // The newer answer first, the older one last.
    stub.release[1]()
    await vi.waitFor(() => expect(cellsOf(store)).toEqual([1]))
    store.flush()
    stub.release[0]()
    await settle()
    store.flush()

    expect(cellsOf(store)).toEqual([1])
    expect([...store.get().pars]).toEqual(['p1'])
    expect(seenPars).toEqual([['p1']])
  })

  it('a 404 from /link/cell writes the cells only and the notice names the artifact and the reason', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    store.set({ pars: new Set(['kept']), sites: new Set([7]) }, 'obs')
    stub.linkReply = () => ({
      status: 404,
      body: { type: 'about:blank', title: 'read failure', status: 404, artifact: 'obs_cell', detail: 'failed to read obs_cell.json' },
    })

    await clickAndWait(store, canvas, 1.5, {}, [1])

    expect([...store.get().pars]).toEqual(['kept'])
    expect([...store.get().sites]).toEqual([7])
    const notice = root.querySelector('[data-testid="map-notices"]')?.textContent ?? ''
    expect(notice).toContain('obs_cell')
    expect(notice).toContain('failed to read obs_cell.json')
  })

  it('a thrown /link/cell fetch writes the cells only and shows its message', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    store.set({ pars: new Set(['kept']), sites: new Set([7]) }, 'obs')
    stub.linkReply = () => ({ status: 0, throws: 'the network went away' })

    await clickAndWait(store, canvas, 1.5, {}, [1])

    expect([...store.get().pars]).toEqual(['kept'])
    expect([...store.get().sites]).toEqual([7])
    expect(root.querySelector('[data-testid="map-notices"]')?.textContent ?? '').toContain('the network went away')
  })
})

function setInput(root: HTMLElement, label: string, value: string, event = 'input'): void {
  const el = root.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement
  el.value = value
  el.dispatchEvent(new Event(event))
}

describe('the map publishes its choices and follows other views', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('holds the drawn iteration, layer, colour and realization once the first draw is up', async () => {
    const store = manualStore()
    await mountedWith(store)

    const s = store.get()
    expect(s.iteration).toBe(0)
    expect(s.layer).toBe(0)
    expect(s.colour).toEqual({ source: 'par', stat: 'value' })
    expect(s.reals).toEqual(new Set(['base']))
  })

  it('writes a layer move, a realization move and a statistic change at once', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store)

    setInput(root, 'Layer', '1')
    expect(store.get().layer).toBe(1)

    setInput(root, 'Realization', '2')
    expect(store.get().reals).toEqual(new Set(['r002']))

    setInput(root, 'Statistic', 'mean', 'change')
    expect(store.get().colour.stat).toBe('mean')
    expect(store.get().reals).toEqual(new Set(['r002']))
  })

  it('moves the layer slider and redraws for a layer set by another view, without a fetch', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const instance = await meshLayerInstance()
    const setValuesBefore = instance.setValues.mock.calls.length
    const valuesFetchesBefore = stub.calls.filter((c) => c === 'GET /api/run/grid/values').length

    store.set({ layer: 1 }, 'test')
    store.flush()

    expect((root.querySelector('[aria-label="Layer"]') as HTMLInputElement).value).toBe('1')
    expect(instance.setValues.mock.calls.length).toBeGreaterThan(setValuesBefore)
    expect(stub.calls.filter((c) => c === 'GET /api/run/grid/values').length).toBe(valuesFetchesBefore)
  })

  it('does not apply its own layer move a second time', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store)
    const instance = await meshLayerInstance()

    setInput(root, 'Layer', '1')
    const setValuesAfterMove = instance.setValues.mock.calls.length
    store.flush()

    expect(instance.setValues.mock.calls.length).toBe(setValuesAfterMove)
  })

  it('says so, and keeps drawing, when another view asks for a layer the grid does not have', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store)

    store.set({ layer: 7 }, 'test')
    store.flush()

    expect((root.querySelector('[aria-label="Layer"]') as HTMLInputElement).value).toBe('0')
    expect(root.querySelector('[data-testid="map-notices"]')?.textContent).toContain('layer index 7')
  })
})

describe('the map follows a group chosen in another view', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  function picker(root: HTMLElement): HTMLSelectElement {
    return root.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
  }

  function scale(root: HTMLElement): HTMLSelectElement {
    return root.querySelector('select[aria-label="Value scale"]') as HTMLSelectElement
  }

  it('draws a drawable group chosen by the Params panel, through the picker path, and the picker shows it', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store, TWO_GROUPS_TABLE)
    expect(picker(root).value).toBe('a')
    expect(scale(root).value).toBe('linear')

    store.set({ parGroups: new Set(['b']) }, 'params')
    store.flush()

    expect(picker(root).value).toBe('b')
    // Group b is log-transformed, so the scale follows it exactly as a picker change would.
    expect(scale(root).value).toBe('log10')
  })

  it('leaves the map on its group when the chosen group is not on the map', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store, TWO_GROUPS_TABLE)

    store.set({ parGroups: new Set(['u']) }, 'params')
    store.flush()

    expect(picker(root).value).toBe('a')
    expect(scale(root).value).toBe('linear')
  })

  it('does nothing for a parGroups change that only the map itself made', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store, TWO_GROUPS_TABLE)

    store.set({ parGroups: new Set(['b']) }, 'map')
    store.flush()

    expect(picker(root).value).toBe('a')
    expect(scale(root).value).toBe('linear')
  })

  it('does nothing when several groups are chosen at once', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store, TWO_GROUPS_TABLE)

    store.set({ parGroups: new Set(['a', 'b']) }, 'params')
    store.flush()

    expect(picker(root).value).toBe('a')
  })

  it('does not redraw for the group it already shows', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store, TWO_GROUPS_TABLE)
    const instance = await meshLayerInstance()
    const before = instance.setValues.mock.calls.length

    store.set({ parGroups: new Set(['a']) }, 'params')
    store.flush()

    expect(picker(root).value).toBe('a')
    expect(instance.setValues.mock.calls.length).toBe(before)
  })

  it('does not write parGroups when its own picker changes', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store, TWO_GROUPS_TABLE)

    picker(root).value = 'b'
    picker(root).dispatchEvent(new Event('change'))
    store.flush()

    expect(store.get().parGroups.size).toBe(0)
  })
})

describe('the header chips read the config facts (D-17)', () => {
  const read = (source: string, value: number | boolean | null, shown: string, extra: Record<string, number> | null = null) => ({
    source,
    value,
    shown,
    evidence: '',
    extra,
  })

  it('marks the realization chip when ensemble sizes disagree and words base from the base fact', async () => {
    const config: RunConfig = {
      ...CONFIG,
      n_real: 200,
      base_realization: false,
      facts_version: 1,
      facts: [
        {
          key: 'ensemble_size',
          label: 'Ensemble size',
          readings: [read('control file', 200, '200'), read('cache', 100, '100')],
          agree: false,
          looked_for: [],
          note: null,
        },
        {
          key: 'base',
          label: 'Base realization',
          readings: [read('cache', true, 'iteration 0: base present', { iteration: 0 }), read('cache', false, 'iteration 3: base missing', { iteration: 3 })],
          agree: false,
          looked_for: [],
          note: null,
        },
      ],
    }
    const { root } = await mountedWith(manualStore(), PAR_TABLE, config)

    const chips = Array.from(root.querySelectorAll('.chip')).map((c) => c.textContent ?? '')
    const reals = chips.find((c) => c.includes('reals'))!
    expect(reals).toContain('sources disagree')
    expect(reals).toContain('base missing at iteration 3')
  })
})
