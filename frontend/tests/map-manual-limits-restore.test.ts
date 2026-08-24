// @vitest-environment jsdom
//
// WINDOWS.md #11: the view-state wire has no field at all for a manual
// limits pair (see _VIEW_STATE_DEFAULTS in prefs.py and ViewStateWire in
// client.ts) -- only limits_mode round-trips. A run left in manual mode and
// reopened restores limits_mode: 'manual' with no pair to go with it, and
// the map must not present that as a real zero-width manual range. It must
// fall back to robust and say so.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import type { RunConfig } from '../src/views/map'

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({
    gl: { clearColor: vi.fn(), clear: vi.fn(), viewport: vi.fn(), COLOR_BUFFER_BIT: 0 },
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

const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 2, nlay: 1, bounds: [0, 1, 0, 1], crs: null, tag: 'manual-limits' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
const CELL_INDEX = new Float32Array([0, 0, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 1])
const LAYER_ARRAY = new Int32Array([0, 0])
const FIELD = new Float32Array([10, 20])

const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

// The exact wire shape read_view_state actually returns for a run left in
// manual mode: limits_mode carries 'manual', and there is no field for the
// pair at all, because none exists in _VIEW_STATE_DEFAULTS.
const RESTORED_VIEW = {
  divider: 0.72,
  colormap: 'viridis',
  reverse: false,
  scale: 'linear',
  limits_mode: 'manual',
  group: 'G1',
  stat: 'value',
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function stubEnvironment(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
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
        case '/api/run/view':
          if (init?.method === 'PUT') return respond({ status: 200, body: RESTORED_VIEW })
          return respond({ status: 200, body: RESTORED_VIEW })
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
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(FIELD) })
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

function mountFreshRoot(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}

describe('a restored manual limits mode with no persisted pair (WINDOWS.md #11)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('falls back to robust rather than presenting a degenerate 0/0 manual range', async () => {
    stubEnvironment()
    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    expect(root.textContent).toMatch(/Limits: Robust 2-98%/)
    expect(root.textContent).not.toMatch(/Limits: Manual/)

    const limitsSelect = root.querySelector('select[aria-label="Limits"]') as HTMLSelectElement
    expect(limitsSelect.value).toBe('robust')
  })

  it('says the manual limits could not be restored, rather than silently substituting robust', async () => {
    stubEnvironment()
    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    const notices = root.querySelector('[data-testid="map-notices"]') as HTMLElement
    expect(notices.textContent).toMatch(/manual limits/i)
  })
})
