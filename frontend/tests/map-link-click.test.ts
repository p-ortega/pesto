// @vitest-environment jsdom
//
// A cell click on the map asks /api/run/link/cell for what the cell holds and writes cells,
// parameters and sites to the store in one write; the Obs tab marks the sites. The real shell
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
      obs: { available: true, blockedBy: [] },
    },
    ingestSeconds: null,
    cacheBytes: null,
  }
}

const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 2, bounds: [0, 2, 0, 1], crs: null, tag: 'link' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 1])
const LAYER_ARRAY = new Int32Array([0, 0])
const PAR_TABLE = tableToIPC(tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }), 'stream')
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

function ipc(columns: Record<string, unknown[]>): Uint8Array {
  return Uint8Array.from(tableToIPC(tableFromArrays(columns), 'stream'))
}

// Site ids are not row numbers, so a row used as an id would mark the wrong row.
const SITES = [
  { id: 71, name: 'h_a', cell: 0 },
  { id: 72, name: 'h_b', cell: 1 },
  { id: 73, name: 'h_c', cell: 0 },
]

function sitesTable(): Uint8Array {
  return ipc({
    site_id: SITES.map((s) => s.id),
    site: SITES.map((s) => s.name),
    n_obs: SITES.map(() => 3),
    x: SITES.map((s) => s.cell + 0.5),
    y: SITES.map(() => 0.5),
    xy_source: SITES.map(() => 'own'),
    layer: SITES.map(() => 0),
    cell: SITES.map((s) => s.cell),
    rule: SITES.map(() => 'own xy'),
    note: SITES.map(() => null),
  })
}

function groupsTable(): Uint8Array {
  return ipc({
    group: ['heads'],
    n_obs: [9],
    n_sites: [3],
    n_placed: [3],
    n_weighted: [9],
    n_with_target: [9],
    n_zero_weight: [0],
    n_sentinel: [0],
    n_no_value: [0],
    time_kind: ['numeric'],
    inequality: ['none'],
    first_iteration: [0],
    last_iteration: [1],
    rmse_first: [1],
    rmse_last: [0.5],
    n_resid_first: [9],
    n_resid_last: [9],
  })
}

function linkAnswer(cells: number[], pars: string[], sites: number[]): Record<string, unknown> {
  return {
    layer: 0,
    cells,
    ring: [],
    ring_rule: 'a neighbouring cell shares at least one corner with a clicked cell',
    pars: pars.map((parnme) => ({ parnme, pargp: 'G1', kind: 'cell', cell: cells[0], weights: [], rule: 'sets this cell (par_cell)' })),
    pars_total: pars.length,
    par_notes: [],
    sites: sites.map((id) => ({ site_id: id, site: `s${id}`, group: 'heads', layer: 0, cell: cells[0], in_clicked_cell: true })),
    sites_total: sites.length,
    sites_cap: 50,
    site_counts: { unknown_layer_included: 0, other_layer_left_out: 0, unplaced_in_run: 0 },
    reasons: { pars: pars.length ? null : 'no parameter sets this cell on layer 0', sites: sites.length ? null : 'none' },
  }
}

interface Stub {
  linkCalls: URLSearchParams[]
  // Each /link/cell call waits for its own release, so a test can order the answers.
  release: ((answer: { status: number; body: unknown }) => void)[]
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function stubFetch(): Stub {
  const stub: Stub = { linkCalls: [], release: [] }
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
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(new Float32Array([10, 20])) })
        case '/api/run/grid/pp':
          return respond({ status: 200, body: { groups: [], not_interpolable: [], notes: [] } })
        case '/api/run/view':
          throw new Error('no saved view')
        case '/api/run/obs/groups':
          return respond({ status: 200, bytes: groupsTable() })
        case '/api/run/obs/sites':
          return respond({ status: 200, bytes: sitesTable(), headers: { 'X-Pesto-Meta': JSON.stringify({ order_digest: 'digest-a' }) } })
        case '/api/run/link/cell': {
          stub.linkCalls.push(query)
          const answer = await new Promise<{ status: number; body: unknown }>((resolve) => stub.release.push(resolve))
          return respond(answer)
        }
        default:
          return respond({ status: 404, body: { title: 'not in this test', status: 404, artifact: path } })
      }
    }),
  )
  return stub
}

function manualStore(): SelectionStore {
  return createSelectionStore({ initial: emptySelection('test_run', 0), schedule: () => {} })
}

async function mounted(store: SelectionStore): Promise<{ root: HTMLElement; stub: Stub }> {
  const stub = stubFetch()
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
  await vi.waitFor(() => expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull())
  return { root, stub }
}

async function meshLayerInstance() {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer).mock.instances[0] as unknown as { setSelected: ReturnType<typeof vi.fn> }
}

function clickAtWorld(canvas: HTMLCanvasElement, wx: number, wy: number, init: MouseEventInit = {}): void {
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
  const camera = new Camera(canvas.width, canvas.height)
  camera.fit([0, 2, 0, 1])
  const [x0, y0] = camera.screenToWorld(0, 0)
  const [x1, y1] = camera.screenToWorld(1, 1)
  canvas.dispatchEvent(new MouseEvent('click', { ...init, clientX: (wx - x0) / (x1 - x0), clientY: (wy - y0) / (y1 - y0) }))
}

const siteRows = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.obs-sites .obs-grid-row')]

describe('a cell click links the map to the tabs', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('rings the cell at once, asks /link/cell once, and writes cells, pars and sites in one write', async () => {
    const store = manualStore()
    const { root, stub } = await mounted(store)
    const instance = await meshLayerInstance()
    instance.setSelected.mockClear()
    store.flush()
    const heard = vi.fn()
    store.subscribe((s) => [s.cells, s.pars, s.sites], heard)

    clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 0.5, 0.5)

    expect(instance.setSelected).toHaveBeenCalledWith(0)
    await vi.waitFor(() => expect(stub.linkCalls.length).toBe(1))
    expect(stub.linkCalls[0].get('layer')).toBe('0')
    expect(stub.linkCalls[0].get('cells')).toBe('0')
    // Nothing reaches the store before the answer.
    expect(store.get().cells.size).toBe(0)

    stub.release[0]({ status: 200, body: linkAnswer([0], ['p0'], [71, 73]) })
    await vi.waitFor(() => expect(store.get().cells.size).toBe(1))
    expect([...store.get().cells]).toEqual([0])
    expect([...store.get().pars]).toEqual(['p0'])
    expect([...store.get().sites].sort()).toEqual([71, 73])
    store.flush()
    expect(heard).toHaveBeenCalledTimes(1)
    expect(stub.linkCalls.length).toBe(1)
  })

  it('the Obs tab marks the sites the answer named', async () => {
    const store = manualStore()
    const { root, stub } = await mounted(store)
    ;(root.querySelector('#tab-obs') as HTMLElement).click()
    await vi.waitFor(() => expect(root.querySelectorAll('.obs-groups .obs-grid-row').length).toBe(1))
    ;(root.querySelector('.obs-groups .obs-grid-row') as HTMLElement).click()
    store.flush()
    await vi.waitFor(() => expect(siteRows(root).length).toBe(3))

    clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 0.5, 0.5)
    await vi.waitFor(() => expect(stub.release.length).toBe(1))
    stub.release[0]({ status: 200, body: linkAnswer([0], [], [73]) })
    await vi.waitFor(() => expect(store.get().sites.size).toBe(1))
    store.flush()

    const marked = siteRows(root).map((row) => [row.dataset.siteId, row.getAttribute('aria-selected')])
    expect(marked).toEqual([
      ['71', 'false'],
      ['72', 'false'],
      ['73', 'true'],
    ])
  })
})
