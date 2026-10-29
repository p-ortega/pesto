// @vitest-environment jsdom
//
// When another view asks for a layer the grid does not have, the map keeps its layer and says
// so, naming the asked value as an index and the grid and drawn layer in both numbers. The real
// map screen against a stubbed fetch, with only the two GL modules mocked, as in map-store.test.ts.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
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

// Two unit cells side by side, both in group G1; the layer count is the test's to choose.
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 1])
const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function stubEnvironment(nlay: number): void {
  const meshBody = { n_vert: 8, n_tri: 4, n_cells: 2, nlay, bounds: [0, 2, 0, 1], crs: null, tag: `foreign-${nlay}` }
  const layers = new Int32Array(nlay === 1 ? [0, 0] : [0, 1])
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path] = url.split('?')
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
          return respond({ status: 200, body: meshBody })
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
          return respond({ status: 200, bytes: bytesOf(layers) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 404, body: { title: 'no point positions were recorded for that iteration', status: 404 } })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(new Float32Array([10, 20])) })
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

// A hand-stepped store: nothing reaches a subscriber until flush() is called.
function manualStore(): SelectionStore {
  return createSelectionStore({ initial: emptySelection('test_run', 0), schedule: () => {} })
}

async function mounted(nlay: number, store: SelectionStore): Promise<HTMLElement> {
  stubEnvironment(nlay)
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
  return root
}

const noticesOf = (root: HTMLElement): string => root.querySelector('[data-testid="map-notices"]')?.textContent ?? ''

describe('another view asks for a layer the grid does not have', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('keeps drawing its layer and names the asked index, the grid and the drawn layer in both numbers', async () => {
    const store = manualStore()
    const root = await mounted(2, store)

    store.set({ layer: 5 }, 'test')
    store.flush()

    expect((root.querySelector('[aria-label="Layer"]') as HTMLInputElement).value).toBe('0')
    expect(noticesOf(root)).toContain(
      'Another view asked for layer index 5; the grid has 2 layers (index 0–1). The map keeps drawing layer 1 (index 0).',
    )
  })

  it('says a one-layer grid has 1 layer (index 0)', async () => {
    const store = manualStore()
    const root = await mounted(1, store)

    store.set({ layer: 3 }, 'test')
    store.flush()

    expect(noticesOf(root)).toContain(
      'Another view asked for layer index 3; the grid has 1 layer (index 0). The map keeps drawing layer 1 (index 0).',
    )
  })

  it('says nothing when the asked layer is one the grid has', async () => {
    const store = manualStore()
    const root = await mounted(2, store)

    store.set({ layer: 1 }, 'test')
    store.flush()

    expect(noticesOf(root)).not.toContain('Another view asked for layer')
  })
})
