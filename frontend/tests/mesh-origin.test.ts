// @vitest-environment jsdom
//
// The mesh is drawn relative to an origin the server sends. The browser keeps
// that origin and adds it back in one place only: the readout of a pilot-point
// dot. Also: the pick index is prepared in idle time after the first draw, so
// the first click does not pay for building it.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { gridMesh } from '../src/data/client'
import { Camera } from '../src/gl/camera'
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

vi.mock('../src/gl/picking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/gl/picking')>()
  return { ...actual, preparePickIndex: vi.fn(actual.preparePickIndex) }
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
    },
    ingestSeconds: null,
    cacheBytes: null,
  }
}

// One unit cell, relative to the origin. p0 of G1 sits on it as a cell; pa
// of k is placed by x/y at the relative pair (0.25, 0.75).
const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 1, nlay: 1, bounds: [0, 1, 0, 1], crs: null, tag: 'origin' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 0])
const LAYER_ARRAY = new Int32Array([0, 0])
const POINT_XY = new Float32Array([Number.NaN, Number.NaN, 0.25, 0.75])
const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'pa'], pargp: ['G1', 'k'], partrans: ['none', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function stubFetch(meshBody: Record<string, unknown>): void {
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
          return respond({ status: 200, bytes: bytesOf(LAYER_ARRAY) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 200, bytes: bytesOf(POINT_XY) })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(new Float32Array([10, 40])) })
        case '/api/run/grid/pp':
          return respond({ status: 200, body: { groups: [], not_interpolable: [], notes: [] } })
        case '/api/run/view':
          throw new Error('no saved view')
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

async function mounted(meshBody: Record<string, unknown>): Promise<HTMLElement> {
  stubFetch(meshBody)
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: baseState() })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  return root
}

function chooseK(root: HTMLElement): void {
  const picker = root.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
  picker.value = 'k'
  picker.dispatchEvent(new Event('change'))
}

// Clicks the dot at world (0.25, 0.75) of the unit cell, reading the canvas
// position back through Camera.fit so the test does not repeat its arithmetic.
function clickDot(root: HTMLElement): void {
  const canvas = root.querySelector('canvas') as HTMLCanvasElement
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
  const camera = new Camera(canvas.width, canvas.height)
  camera.fit([0, 1, 0, 1])
  const [x0, y0] = camera.screenToWorld(0, 0)
  const [x1, y1] = camera.screenToWorld(1, 1)
  canvas.dispatchEvent(
    new MouseEvent('click', { clientX: (0.25 - x0) / (x1 - x0), clientY: (0.75 - y0) / (y1 - y0) }),
  )
}

function readoutText(root: HTMLElement): string {
  return root.querySelector('.floating-bottom-right')?.textContent ?? ''
}

describe('gridMesh reads the origin', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses the origin from the mesh body', async () => {
    stubFetch({ ...MESH_BODY, origin: [712345, 7019873] })
    expect((await gridMesh()).origin).toEqual([712345, 7019873])
  })

  it('reads a body with no origin as [0, 0], which keeps older meshes valid', async () => {
    stubFetch(MESH_BODY)
    expect((await gridMesh()).origin).toEqual([0, 0])
  })

  it('refuses an origin that is not a pair of numbers instead of reading it as [0, 0]', async () => {
    stubFetch({ ...MESH_BODY, origin: [712345] })
    await expect(gridMesh()).rejects.toThrow(/origin/)
  })
})

describe('the readout of a pilot-point dot', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('adds the mesh origin back, so a dot at northing 7.02e6 reads its real coordinates', async () => {
    const root = await mounted({ ...MESH_BODY, origin: [712345, 7019873] })
    chooseK(root)
    await vi.waitFor(() => expect(root.querySelector('.floating-bottom-left')?.textContent).toContain('points on this layer'))
    clickDot(root)
    expect(readoutText(root)).toContain('x 712345, y 7019874')
  })

  it('reads the same as before for a mesh with no origin', async () => {
    const root = await mounted(MESH_BODY)
    chooseK(root)
    await vi.waitFor(() => expect(root.querySelector('.floating-bottom-left')?.textContent).toContain('points on this layer'))
    clickDot(root)
    expect(readoutText(root)).toContain('x 0, y 1 · layer 0')
  })
})

describe('the pick index', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('is prepared once, with the drawn mesh, after the first draw', async () => {
    const { preparePickIndex } = await import('../src/gl/picking')
    await mounted({ ...MESH_BODY, origin: [0, 0] })
    await vi.waitFor(() => expect(preparePickIndex).toHaveBeenCalledTimes(1))
    const mesh = vi.mocked(preparePickIndex).mock.calls[0][0]
    expect(mesh.nCells).toBe(1)
    expect(Array.from(mesh.positions)).toEqual(Array.from(POSITIONS))
  })
})
