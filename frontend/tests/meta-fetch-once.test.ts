// @vitest-environment jsdom
//
// The reopen fix: a mounted map asks the server for the parameter table
// once, only for the columns the map and the Params panel read, and the
// panel reads that same answer instead of asking again (RESEARCH Pitfall 4).

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAR_TABLE_COLUMNS, PAR_TABLE_OPTIONAL_COLUMNS } from '../src/data/parmap'
import type { IngestState } from '../src/data/client'
import type { RunConfig } from '../src/views/map'
import { createRecordingGl } from './support/recording-gl'
import { storeWithGroup } from './support/chosen-group'

const recording = createRecordingGl()

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({
    gl: recording.gl,
    onLost: vi.fn(),
    onRestored: vi.fn(),
  })),
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

const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 2, nlay: 1, bounds: [0, 1, 0, 1], crs: null, tag: 'meta-once' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
const CELL_INDEX = new Float32Array([0, 0, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 1])
const LAYER_ARRAY = new Int32Array([0, 0])
const FIELD = new Float32Array([10, 20])

const PAR_TABLE = tableToIPC(
  tableFromArrays({
    parnme: ['p0', 'p1'],
    pargp: ['G1', 'G1'],
    parlbnd: [0.1, 0.1],
    parubnd: [10, 10],
    partrans: ['none', 'none'],
  }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function stubEnvironment(metaStatus: number, parTable: Uint8Array = PAR_TABLE): string[] {
  const metaUrls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path] = url.split('?')
      if (path === '/api/run/meta') metaUrls.push(url)
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
          return metaStatus === 200
            ? respond({ status: 200, bytes: parTable })
            : respond({ status: metaStatus, body: { title: 'the control file is not readable', status: metaStatus } })
        case '/api/run/grid/cells/cell':
          return respond({ status: 200, bytes: bytesOf(CELL_ARRAY) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(LAYER_ARRAY) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 404, body: { title: 'no point positions were recorded for that iteration', status: 404 } })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(FIELD) })
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
  return metaUrls
}

function mountFreshRoot(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}

describe('one parameter table request per mounted map', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('asks /api/run/meta once, naming the required and the optional columns, and the panel shows its rows', async () => {
    const metaUrls = stubEnvironment(200)
    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState(), store: storeWithGroup('G1') })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
      expect(root.querySelectorAll('.param-row').length).toBe(2)
    })

    expect(metaUrls).toHaveLength(1)
    const params = new URL(metaUrls[0], 'http://127.0.0.1').searchParams
    expect(params.get('columns')?.split(',')).toEqual([...PAR_TABLE_COLUMNS])
    expect(params.get('optional_columns')?.split(',')).toEqual([...PAR_TABLE_OPTIONAL_COLUMNS])
    expect(params.get('kind')).toBe('par')
  })

  it('still draws, and the panel shows dashes, when the table has no bounds or partrans column', async () => {
    const bare = tableToIPC(tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'] }), 'stream')
    const metaUrls = stubEnvironment(200, bare)
    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState(), store: storeWithGroup('G1') })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
      expect(root.querySelectorAll('.param-row').length).toBe(2)
    })

    expect(metaUrls).toHaveLength(1)
    expect(root.textContent).not.toContain('The parameter table could not be read')
    expect(root.querySelector('.param-row')?.textContent).toContain('—')
  })

  it('still asks once when the request fails, and the map says the table could not be read', async () => {
    const metaUrls = stubEnvironment(502)
    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState(), store: storeWithGroup('G1') })

    await vi.waitFor(() => {
      expect(root.textContent).toContain('The parameter table could not be read')
    })
    expect(metaUrls).toHaveLength(1)
  })
})
