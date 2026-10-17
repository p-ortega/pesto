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

vi.mock('../src/gl/mesh-layer', () => ({
  MeshLayer: vi.fn().mockImplementation(function MockMeshLayer(this: object) {
    Object.assign(this, {
      setValues: vi.fn(),
      setLimits: vi.fn(),
      setColormap: vi.fn(),
      setMatrix: vi.fn(),
      setInactive: vi.fn(),
      setHairlineColor: vi.fn(),
      setContested: vi.fn(),
      setContestedColors: vi.fn(),
      setSelected: vi.fn(),
      setAccentColor: vi.fn(),
      setPoints: vi.fn(),
      setPointRingColor: vi.fn(),
      setFootprint: vi.fn(),
      setFootprintColor: vi.fn(),
      setSelectedPoint: vi.fn(),
      draw: vi.fn(),
      reupload: vi.fn(),
      dispose: vi.fn(),
    })
  }),
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
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base', 'r001', 'r002'] }), 'stream')
const FIELDS: Record<string, number[]> = { base: [10, 20], r001: [11, 21], r002: [12, 22] }

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

interface Stub {
  calls: string[]
  valuesCalls: string[]
}

function stubEnvironment(): Stub {
  const stub: Stub = { calls: [], valuesCalls: [] }
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
          return respond({ status: 200, bytes: PAR_TABLE })
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

async function mountedWith(store: SelectionStore): Promise<{ root: HTMLElement; stub: Stub }> {
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
function clickAtWorld(canvas: HTMLCanvasElement, wx: number, wy: number): void {
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
  const camera = new Camera(canvas.width, canvas.height)
  camera.fit([0, 2, 0, 1])
  const [x0, y0] = camera.screenToWorld(0, 0)
  const [x1, y1] = camera.screenToWorld(1, 1)
  const clientX = (wx - x0) / (x1 - x0)
  const clientY = (wy - y0) / (y1 - y0)
  canvas.dispatchEvent(new MouseEvent('click', { clientX, clientY }))
}

describe('a click on the map writes to the store', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('sets cells to the clicked cell before any flush, and draws the ring in the same call', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store)
    const instance = await meshLayerInstance()
    instance.setSelected.mockClear()
    store.flush()

    clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 1.5, 0.5)

    expect(Array.from(store.get().cells)).toEqual([1])
    expect(instance.setSelected).toHaveBeenCalledWith(1)
  })

  it('a click on the already-selected cell wakes no subscriber', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    clickAtWorld(canvas, 0.5, 0.5)
    expect(Array.from(store.get().cells)).toEqual([0])
    store.flush()

    const heard = vi.fn()
    store.subscribe((s) => s.cells, heard)
    clickAtWorld(canvas, 0.5, 0.5)
    store.flush()

    expect(heard).not.toHaveBeenCalled()
  })

  it('a click on empty space writes an empty selection', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    clickAtWorld(canvas, 0.5, 0.5)
    expect(store.get().cells.size).toBe(1)

    clickAtWorld(canvas, 5, 5)
    expect(store.get().cells.size).toBe(0)
  })
})
