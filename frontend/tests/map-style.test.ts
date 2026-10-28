// @vitest-environment jsdom
//
// The Classes control on the real map screen: one effective style reaches the
// layer and the legend together, the held field is redrawn without a fetch,
// and the observation look always draws continuous (D-01, D-02, D-04).

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { MeshLayer } from '../src/gl/mesh-layer'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({
    gl: { clearColor: vi.fn(), clear: vi.fn(), viewport: vi.fn(), COLOR_BUFFER_BIT: 0 },
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

const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 1, bounds: [0, 2, 0, 1], crs: null, tag: 'map-style' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 1])
const LAYER_ARRAY = new Int32Array([0, 0])

const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

let field = new Float32Array([10, 20])
let valueFetches = 0

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function stubEnvironment(): void {
  valueFetches = 0
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
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          headers: { get: (name: string) => result.headers?.[name] ?? null },
        }
      }
      if (path.startsWith('/api/run/obs/')) {
        return respond({ status: 404, body: { title: 'no observations in this test', status: 404 } })
      }
      switch (path) {
        case '/api/run/view':
          return respond({ status: 404, body: { title: 'no saved view', status: 404 } })
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
          valueFetches += 1
          return respond({ status: 200, bytes: bytesOf(field) })
        case '/api/run/grid/pp':
          return respond({ status: 200, body: { groups: [], not_interpolable: [], notes: [] } })
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

type Mocked = ReturnType<typeof vi.fn>
function layerMock(): { setStyle: Mocked } {
  return vi.mocked(MeshLayer).mock.instances[0] as unknown as { setStyle: Mocked }
}

function lastStyle(): { classes: number } {
  const calls = layerMock().setStyle.mock.calls
  return calls[calls.length - 1][0] as { classes: number }
}

async function mounted(): Promise<{ root: HTMLElement; store: SelectionStore }> {
  stubEnvironment()
  const store = createSelectionStore({ initial: emptySelection('test_run', 0), schedule: (run) => queueMicrotask(run) })
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: baseState(), store })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  return { root, store }
}

function chooseClasses(root: HTMLElement, value: string): void {
  const select = root.querySelector('select[aria-label="Colour classes"]') as HTMLSelectElement
  select.value = value
  select.dispatchEvent(new Event('change'))
}

const legend = (root: HTMLElement): HTMLElement => root.querySelector('.floating-bottom-left') as HTMLElement

describe('the Classes control on the map', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    field = new Float32Array([10, 20])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('steps the layer and the legend together from the held field, with no new fetch', async () => {
    const { root } = await mounted()
    const before = valueFetches
    expect(lastStyle().classes).toBe(0)

    chooseClasses(root, '9')

    expect(lastStyle()).toEqual({ classes: 9, symmetric: false, texture: false })
    expect(legend(root).querySelectorAll('.legend-class')).toHaveLength(9)
    expect(legend(root).querySelectorAll('.legend-edge')).toHaveLength(10)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(valueFetches).toBe(before)
  })

  it('puts the smooth ramp back on Continuous', async () => {
    const { root } = await mounted()
    chooseClasses(root, '9')
    chooseClasses(root, '0')

    expect(lastStyle().classes).toBe(0)
    expect(legend(root).querySelectorAll('.legend-class')).toHaveLength(0)
    const gradient = [...legend(root).querySelectorAll('div')].find((d) => d.style.background.includes('linear-gradient'))
    expect(gradient).toBeDefined()
  })

  it('draws the observation look continuous and hides the Classes row there', async () => {
    const { root, store } = await mounted()
    chooseClasses(root, '9')
    store.set({ colour: { source: 'obs', stat: 'resid_mean' } }, 'test')
    await vi.waitFor(() => expect(lastStyle().classes).toBe(0))

    const label = (root.querySelector('select[aria-label="Colour classes"]') as HTMLElement).closest('label')
    expect(label?.getAttribute('data-colour-source')).toBe('par')
  })
})
