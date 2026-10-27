// @vitest-environment jsdom
//
// D-07 and the fourth hard rule: a parameter group that never placed on a
// cell is still named, behind the picker's disclosure and in the Params
// panel. The server's map block holds only the parameters that placed, so
// a group with no placed parameter at all never appears in it -- on a real
// PstFrom run that is 99% of the groups. Those groups come from the
// control table, which lists every parameter, and must not go missing just
// because the map block never mentions them. Drives the real map screen
// against the recording WebGL2 stub, the same way map-empty-layer.test.ts
// does.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import type { RunConfig } from '../src/views/map'
import { createRecordingGl } from './support/recording-gl'

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

// One cell. The control table has three parameters in three groups: p0 of
// G1 places on the cell, p1 of G2 is in the map block but never placed
// (cell -1), and p2 of G3 is not in the map block at all -- the shape of
// every pilot-point group on a real run.
const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 1, nlay: 1, bounds: [0, 1, 0, 1], crs: null, tag: 'unmapped' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, -1])
const LAYER_ARRAY = new Int32Array([0, -1])
const FIELD = new Float32Array([10, 20])

const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1', 'p2'], pargp: ['G1', 'G2', 'G3'], partrans: ['none', 'none', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

// What GET /api/run/grid/placement answers: a body, or a failure status.
type PlacementAnswer = { status: number; body: unknown }

const NOTE_OF_G2 = "group 'G2' carries 'layer', which look like placement data but the rules do not read them"
const PLACEMENT_BODY = {
  summary: '1 of 3 groups placed',
  groups: [
    { group: 'G1', rule: 'grid', mapped: 1, total: 1, notes: [] },
    { group: 'G2', rule: 'unmapped', mapped: 0, total: 1, notes: [NOTE_OF_G2] },
    { group: 'G3', rule: 'unmapped', mapped: 0, total: 4, notes: [] },
  ],
  notes: [],
}

const calls: string[] = []

function stubFetch(placement: PlacementAnswer = { status: 200, body: PLACEMENT_BODY }): void {
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path] = url.split('?')
      calls.push(path)
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
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(FIELD) })
        case '/api/run/grid/placement':
          return respond(placement)
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

describe('groups that never placed on a cell are still named', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('counts a group absent from the map block as unmapped, next to one present but unplaced', async () => {
    stubFetch()
    const { mountMap } = await import('../src/views/map')
    const root = document.createElement('div')
    document.body.appendChild(root)
    mountMap(root, { config: CONFIG, state: baseState() })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    const picker = root.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['G1'])

    const disclosure = Array.from(root.querySelectorAll('button')).find((b) => /groups? unmapped/.test(b.textContent ?? ''))
    expect(disclosure?.textContent).toBe('2 groups unmapped')

    const panelText = root.querySelector('.params-panel')?.textContent ?? ''
    expect(panelText).toContain('2 groups unmapped')
    expect(panelText).toContain('G2')
    expect(panelText).toContain('G3')
  })

  async function openMap(placement?: PlacementAnswer): Promise<HTMLElement> {
    stubFetch(placement)
    const { mountMap } = await import('../src/views/map')
    const root = document.createElement('div')
    document.body.appendChild(root)
    mountMap(root, { config: CONFIG, state: baseState() })
    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })
    return root
  }

  function pickerList(root: HTMLElement): string {
    return root.querySelector('.floating .unmapped-list')?.textContent ?? ''
  }

  it('names the recorded note for each unmapped group in the picker and in the Params panel', async () => {
    const root = await openMap()

    expect(pickerList(root)).toContain(NOTE_OF_G2)
    expect(pickerList(root)).toContain('G3 — no placement rule matched, placed 0 of 4')
    const panelText = root.querySelector('.params-unmapped')?.textContent ?? ''
    expect(panelText).toContain(NOTE_OF_G2)
    expect(panelText).toContain('G3 — no placement rule matched, placed 0 of 4')
  })

  it('asks for the placement once, before the cell mapping it is read alongside', async () => {
    await openMap()

    const asked = calls.filter((c) => c === '/api/run/grid/placement')
    expect(asked).toHaveLength(1)
    expect(calls.indexOf('/api/run/grid/placement')).toBeLessThan(calls.indexOf('/api/run/grid/cells/cell'))
  })

  it('keeps the old copy and adds one notice naming the failure when the placement cannot be read', async () => {
    const root = await openMap({
      status: 404,
      body: { type: 'about:blank', title: 'not found', status: 404, artifact: 'par_cell', detail: 'par_cell.json was not found' },
    })

    expect(pickerList(root)).toContain('G2 — no placement rule matched')
    expect(pickerList(root)).not.toContain(NOTE_OF_G2)
    const notices = root.querySelector('[data-testid="map-notices"]')?.textContent ?? ''
    expect(notices).toContain('The placement notes could not be read')
    expect(notices).toContain('par_cell.json was not found')
    expect(notices.split('The placement notes could not be read')).toHaveLength(2)
    // Nothing else broke: the map still drew its group.
    const picker = root.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['G1'])
  })
})
