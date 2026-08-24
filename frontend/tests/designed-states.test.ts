// @vitest-environment jsdom
//
// MAP-06: every reachable missing-thing state names what is missing and
// why, through the one renderNotice/TONE_STYLE vocabulary, and two states
// true at once each get their own notice rather than one replacing the
// other. Mounts the real map screen with the real createContext (canvas's
// own getContext stubbed per test, since jsdom has no WebGL2) and a mocked
// MeshLayer -- only "No WebGL2" leaves getContext unstubbed, so the real
// module's own throw is exercised.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import type { RunConfig } from '../src/views/map'

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

const FAKE_GL = { clearColor: vi.fn(), clear: vi.fn(), viewport: vi.fn(), COLOR_BUFFER_BIT: 0 }

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

function baseState(overrides: Partial<IngestState['capabilities']> = {}): IngestState {
  return {
    fresh: true,
    artifacts: [],
    capabilities: {
      map: { available: true, blockedBy: [] },
      stats: { available: true, blockedBy: [] },
      chips: { available: true, blockedBy: [] },
      ...overrides,
    },
    ingestSeconds: null,
    cacheBytes: null,
  }
}

const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 1, nlay: 1, bounds: [0, 100, 0, 100], crs: 'EPSG:1', tag: 'tag1' }
const NO_CRS_MESH_BODY = { ...MESH_BODY, crs: null }
const POSITIONS = new Float32Array([0, 0, 100, 0, 100, 100, 0, 100])
const CELL_INDEX = new Float32Array([0, 0, 0, 0])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0])
const CELL_ARRAY = new Int32Array([0])
const UNMAPPED_CELL_ARRAY = new Int32Array([-1])
const LAYER_ARRAY = new Int32Array([0])
const FIELD = new Float32Array([42])

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

const PAR_TABLE = tableToIPC(tableFromArrays({ parnme: ['p0'], pargp: ['G1'], partrans: ['none'] }), 'stream')
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')
const VIEW_STATE_BODY = {
  divider: 0.72,
  colormap: 'viridis',
  reverse: false,
  scale: 'linear',
  limits_mode: 'robust',
  group: null,
  stat: 'value',
}

interface RouteResult {
  status: number
  bytes?: Uint8Array
  body?: unknown
  headers?: Record<string, string>
}

type Routes = Partial<Record<string, RouteResult>>

const DEFAULT_ROUTES: Routes = {
  '/api/run/grid/mesh': { status: 200, body: MESH_BODY },
  '/api/run/grid/mesh/positions': { status: 200, bytes: bytesOf(POSITIONS), headers: metaHeader('<f4') },
  '/api/run/grid/mesh/cell_index': { status: 200, bytes: bytesOf(CELL_INDEX), headers: metaHeader('<f4') },
  '/api/run/grid/mesh/indices': { status: 200, bytes: bytesOf(INDICES), headers: metaHeader('<u4') },
  '/api/run/grid/parmap': { status: 200, bytes: bytesOf(PARMAP) },
  '/api/run/meta': { status: 200, bytes: PAR_TABLE },
  '/api/run/grid/cells/cell': { status: 200, bytes: bytesOf(CELL_ARRAY) },
  '/api/run/grid/cells/layer': { status: 200, bytes: bytesOf(LAYER_ARRAY) },
  '/api/run/reals': { status: 200, bytes: REALS_TABLE },
  '/api/run/view': { status: 200, body: VIEW_STATE_BODY },
  '/api/run/grid/values': { status: 200, bytes: bytesOf(FIELD) },
}

function stubEnvironment(overrides: Routes = {}): void {
  const routes: Routes = { ...DEFAULT_ROUTES, ...overrides }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path] = url.split('?')
      const result = routes[path]
      if (!result) throw new Error(`unhandled fetch in test: ${path}`)
      const bytes = result.bytes ?? new Uint8Array(0)
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => result.body ?? {},
        arrayBuffer: async () => bytes.buffer,
        headers: { get: (name: string) => result.headers?.[name] ?? null },
      }
    }),
  )
}

function stubMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

function stubWebgl2(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === 'webgl2' ? (FAKE_GL as unknown as WebGL2RenderingContext) : null) as typeof HTMLCanvasElement.prototype.getContext)
}

function stubNoWebgl2(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
}

function mountFreshRoot(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}

async function mount(root: HTMLElement, config: RunConfig | null = CONFIG, state = baseState()): Promise<void> {
  const { mountMap } = await import('../src/views/map')
  mountMap(root, { config, state })
}

describe('every remaining state is a designed state', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    stubMatchMedia()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('a run whose grid could not be read renders "No grid file for this run" as informational', async () => {
    stubWebgl2()
    stubEnvironment({ '/api/run/grid/mesh': { status: 502, body: { type: 'about:blank', title: 'read failure', status: 502 } } })
    const root = mountFreshRoot()
    await mount(root)

    await vi.waitFor(() => {
      expect(root.textContent).toContain('No grid file for this run')
    })
    expect(root.textContent).toContain(
      "This run has no MODFLOW 6 grid file, so there's nothing to draw on the map. Every other view still works.",
    )
    expect(root.textContent).not.toContain('Critical')
  })

  it('a mesh reporting no CRS renders "No coordinate system" as informational, never warning', async () => {
    stubWebgl2()
    stubEnvironment({ '/api/run/grid/mesh': { status: 200, body: NO_CRS_MESH_BODY } })
    const root = mountFreshRoot()
    await mount(root)

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })
    expect(root.textContent).toContain('No coordinate system')
    expect(root.textContent).toContain('Note')
    expect(root.textContent).not.toContain('Warning')
  })

  it('a browser with no WebGL2 renders the critical designed state with the exact copy', async () => {
    stubNoWebgl2()
    stubEnvironment()
    const root = mountFreshRoot()
    await mount(root)

    expect(root.textContent).toContain("This browser can't draw the map")
    expect(root.textContent).toContain(
      "pesto needs WebGL2, which this browser doesn't provide. Try a recent version of Chrome, Firefox or Edge.",
    )
    expect(root.textContent).toContain('Critical')
    expect(root.querySelector('canvas')).toBeNull()
  })

  it('an iteration with no recorded cell mapping names the artifact and the reason', async () => {
    stubWebgl2()
    stubEnvironment({
      '/api/run/grid/cells/cell': {
        status: 502,
        body: { type: 'about:blank', title: 'read failure', status: 502, artifact: 'cellmap', detail: 'no recorded mapping for iteration 0' },
      },
    })
    const root = mountFreshRoot()
    await mount(root)

    await vi.waitFor(() => {
      expect(root.textContent).toContain('cellmap')
    })
    expect(root.textContent).toContain('no recorded mapping for iteration 0')
  })

  it('a failed artifact disables only what rests on it, leaving the rest of the canvas working', async () => {
    stubWebgl2()
    stubEnvironment()
    const root = mountFreshRoot()
    await mount(
      root,
      CONFIG,
      baseState({
        stats: { available: false, blockedBy: [{ artifact: 'par_agg/head', reason: 'the aggregation step crashed' }] },
      }),
    )

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })
    expect(root.textContent).toContain('par_agg/head')
    expect(root.textContent).toContain('the aggregation step crashed')
  })

  it('two states true at once -- no CRS and no drawable group -- each render their own notice, neither replacing the other', async () => {
    stubWebgl2()
    stubEnvironment({
      '/api/run/grid/mesh': { status: 200, body: NO_CRS_MESH_BODY },
      '/api/run/grid/cells/cell': { status: 200, bytes: bytesOf(UNMAPPED_CELL_ARRAY) },
    })
    const root = mountFreshRoot()
    await mount(root)

    await vi.waitFor(() => {
      expect(root.textContent).toContain('No parameter group can be drawn on this map')
    })
    expect(root.textContent).toContain('No coordinate system')
    expect(root.textContent).toContain(
      'Every group in this run failed to place on the grid. The unmapped list below names each one and the rule that was tried.',
    )
  })

  it('the header, status bar and Params panel frame stay on screen in every designed state', async () => {
    stubWebgl2()
    stubEnvironment({ '/api/run/grid/mesh': { status: 502, body: { type: 'about:blank', title: 'read failure', status: 502 } } })
    const root = mountFreshRoot()
    await mount(root)

    await vi.waitFor(() => {
      expect(root.textContent).toContain('No grid file for this run')
    })
    expect(root.querySelector('.header')).not.toBeNull()
    expect(root.querySelector('.status-bar')).not.toBeNull()
    const frame = root.querySelector('.map-frame')
    expect(frame).not.toBeNull()
    expect(frame!.children.length).toBe(3)
  })

  it('with no mesh loaded, the canvas element is not rendered at all', async () => {
    stubWebgl2()
    stubEnvironment({ '/api/run/grid/mesh': { status: 502, body: { type: 'about:blank', title: 'read failure', status: 502 } } })
    const root = mountFreshRoot()
    await mount(root)

    await vi.waitFor(() => {
      expect(root.textContent).toContain('No grid file for this run')
    })
    expect(root.querySelector('canvas')).toBeNull()
  })
})
