// @vitest-environment jsdom
//
// Outside the model from the grid file's idomain: the outline follows the
// drawn layer's idomain, and a grid with none falls back to the old rule
// with the mesh's own note in the Params panel. Built on
// map-interpolated.test.ts's harness.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeshLayer } from '../src/gl/mesh-layer'
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
const NO_IDOMAIN_NOTE =
  'the grid file records no idomain, so a cell counts as in the model when any parameter lands on it'
let meshBody: Record<string, unknown> = {}
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 2, 0, 2, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2])
// By default cell 1 is inactive on layer 0 and active on layer 1.
let idomain = new Int32Array([1, 0, 1, 1])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, -1])
const LAYER_ARRAY = new Int32Array([0, -1])
const FIELD = new Float32Array([10, 20])
const idomainFetches: string[] = []

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

const fieldFetches: string[] = []
// 'hang' never answers, so a test can act while the fetch is pending.
let fieldMode: 'ok' | 'fail' | 'hang' = 'ok'
const valueFetches: string[] = []
// The layer the pp index gives G3, and the group a reopened run was left on.
let ppLayer = 0
let restoredGroup: string | null = null

function stubFetch(): void {
  fieldFetches.length = 0
  idomainFetches.length = 0
  fieldMode = 'ok'
  valueFetches.length = 0
  ppLayer = 0
  idomain = new Int32Array([1, 0, 1, 1])
  restoredGroup = null
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
        case '/api/run/grid/mesh/idomain':
          idomainFetches.push(url)
          return respond({ status: 200, bytes: bytesOf(idomain), headers: metaHeader('<i4') })
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
          valueFetches.push(url)
          return respond({ status: 200, bytes: bytesOf(FIELD) })
        case '/api/run/grid/pp':
          return respond({
            status: 200,
            body: {
              groups: [{ group: 'G3', layer: ppLayer, n_pp: 1, log_space: false, format: 'text', notes: [] }],
              not_interpolable: [
                { group: 'G2', reason: 'no template' },
                { group: 'g9pp_inst0pp.dat', reason: 'template g9pp_inst0pp.dat.tpl is not in the run directory' },
              ],
              notes: [],
            },
          })
        case '/api/run/view':
          if (restoredGroup === null) throw new Error('no saved view')
          return respond({
            status: 200,
            body: { divider: 0.72, colormap: 'viridis', reverse: false, scale: 'linear', limits_mode: 'robust', group: restoredGroup, stat: 'value' },
          })
        case '/api/run/grid/field/cell':
          return respond({
            status: 200,
            body: { group: 'G3', cell: 0, contributors: [{ parnme: 'p2', weight: 1.0 }] },
          })
        case '/api/run/grid/field':
          fieldFetches.push(url)
          if (fieldMode === 'hang') return new Promise(() => {})
          if (fieldMode === 'fail') return respond({ status: 404, body: { title: 'read failure', status: 404 } })
          return respond({
            status: 200,
            bytes: bytesOf(new Float32Array([7, 8])),
            headers: { 'X-Pesto-Meta': JSON.stringify({ order: 'cell', group: 'G3', layer: 0, n_pp: 1 }) },
          })
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

function meshWith(extra: Record<string, unknown>): Record<string, unknown> {
  return { n_vert: 6, n_tri: 4, n_cells: 2, nlay: 2, bounds: [0, 2, 0, 1], crs: null, tag: 'idomain', ...extra }
}

async function mounted(setup: () => void = () => {}): Promise<HTMLElement> {
  stubFetch()
  setup()
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: baseState() })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  return root
}

function choose(root: HTMLElement, group: string): void {
  const picker = root.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
  picker.value = group
  picker.dispatchEvent(new Event('change'))
}

function lastInactive(spy: ReturnType<typeof vi.spyOn>): number[] {
  const mask = spy.mock.calls.at(-1)![0] as Uint8Array
  return Array.from(mask)
}

describe('outside the model on the map', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('outlines a cell from the drawn layer\'s idomain, and clears it on a layer where it is active', async () => {
    const spy = vi.spyOn(MeshLayer.prototype, 'setInactive')
    const root = await mounted(() => {
      meshBody = meshWith({ has_idomain: true, notes: [] })
    })
    expect(idomainFetches.length).toBe(1)
    expect(lastInactive(spy)).toEqual([0, 1])
    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerInput.value = '1'
    layerInput.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(lastInactive(spy)).toEqual([0, 0]))
  })

  it('a grid with no idomain keeps the old rule and says so in the Params panel', async () => {
    const spy = vi.spyOn(MeshLayer.prototype, 'setInactive')
    const root = await mounted(() => {
      meshBody = meshWith({ has_idomain: false, notes: [NO_IDOMAIN_NOTE] })
    })
    expect(idomainFetches.length).toBe(0)
    expect(lastInactive(spy)).toEqual([0, 1])
    expect(root.querySelector('.params-panel')?.textContent).toContain(NO_IDOMAIN_NOTE)
  })

  it('an interpolated value puts its cell in the model on the group\'s own layer only', async () => {
    const spy = vi.spyOn(MeshLayer.prototype, 'setInactive')
    const root = await mounted(() => {
      meshBody = meshWith({ has_idomain: true, notes: [] })
      // Cell 1 is inactive on layer 1 only; the field gives it a value.
      idomain = new Int32Array([1, 1, 1, 0])
    })
    choose(root, 'G3')
    await vi.waitFor(() => {
      expect(root.querySelector('.floating-bottom-left')?.textContent).toContain('G3 · interpolated')
    })
    expect(lastInactive(spy)).toEqual([0, 0])
    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerInput.value = '1'
    layerInput.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(lastInactive(spy)).toEqual([0, 1]))
  })

  it('a wrong-sized idomain is refused with a notice naming the lengths, and the old rule applies', async () => {
    const spy = vi.spyOn(MeshLayer.prototype, 'setInactive')
    const root = await mounted(() => {
      meshBody = meshWith({ has_idomain: true, notes: [] })
      idomain = new Int32Array([1, 1, 1])
    })
    const notices = root.querySelector('[data-testid="map-notices"]')?.textContent ?? ''
    expect(notices).toContain("The grid file's idomain could not be read")
    expect(notices).toContain('It has 3 values, not the 4 the grid needs (2 layers of 2 cells).')
    expect(lastInactive(spy)).toEqual([0, 1])
    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerInput.value = '1'
    layerInput.dispatchEvent(new Event('input'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lastInactive(spy)).toEqual([0, 1])
  })

  it('the legend says how many inactive cells an interpolated field still paints', async () => {
    const root = await mounted(() => {
      meshBody = meshWith({ has_idomain: true, notes: [] })
    })
    choose(root, 'G3')
    const legend = () => root.querySelector('.floating-bottom-left')?.textContent ?? ''
    await vi.waitFor(() => expect(legend()).toContain('G3 · interpolated'))
    // Cell 1 is inactive on layer 0, G3's layer, and the field gives it a value.
    expect(legend()).toContain('1 cells inactive in idomain, still drawn')
  })

  it('with no idomain the legend says nothing about inactive cells', async () => {
    const root = await mounted(() => {
      meshBody = meshWith({ has_idomain: false, notes: [NO_IDOMAIN_NOTE] })
    })
    choose(root, 'G3')
    const legend = () => root.querySelector('.floating-bottom-left')?.textContent ?? ''
    await vi.waitFor(() => expect(legend()).toContain('G3 · interpolated'))
    expect(legend()).not.toContain('inactive in idomain')
  })
})
