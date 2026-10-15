// @vitest-environment jsdom
//
// Interpolated pilot-point groups on the map: the picker offers a group the
// pp index lists even though none of its parameters places on a cell, the
// field route feeds the canvas instead of the block route, and a layer
// change never refetches. Built on map-unmapped-groups.test.ts's harness,
// whose own header follows.
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
const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 1, nlay: 2, bounds: [0, 1, 0, 1], crs: null, tag: 'unmapped' }
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

const fieldFetches: string[] = []
// 'hang' never answers, so a test can act while the fetch is pending.
let fieldMode: 'ok' | 'fail' | 'hang' = 'ok'
const valueFetches: string[] = []
// The layer the pp index gives G3, and the group a reopened run was left on.
let ppLayer = 0
let restoredGroup: string | null = null

function stubFetch(): void {
  fieldFetches.length = 0
  fieldMode = 'ok'
  valueFetches.length = 0
  ppLayer = 0
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
            bytes: bytesOf(new Float32Array([7])),
            headers: { 'X-Pesto-Meta': JSON.stringify({ order: 'cell', group: 'G3', layer: 0, n_pp: 1 }) },
          })
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
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

describe('an interpolated pilot-point group on the map', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('offers an interpolated group, marked, and drops it from the unmapped list', async () => {
    const root = await mounted()
    const picker = root.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual(['G1', 'G3 · interpolated'])
    const disclosure = Array.from(root.querySelectorAll('button')).find((b) => /groups? unmapped/.test(b.textContent ?? ''))
    expect(disclosure?.textContent).toBe('1 group unmapped')
    expect(root.querySelector('.params-panel')?.textContent).toContain('G2 — no template')
  })

  it('fetches the field when the interpolated group is chosen and draws it per cell', async () => {
    const root = await mounted()
    choose(root, 'G3')
    await vi.waitFor(() => expect(fieldFetches.length).toBe(1))
    expect(fieldFetches[0]).toContain('group=G3')
    await vi.waitFor(() => {
      expect(root.querySelector('.floating-bottom-left')?.textContent).toContain('G3 · interpolated')
    })
    const uploads = recording.calls.filter((c) => c.method === 'texSubImage2D')
    const staging = uploads.at(-1)!.args[8] as Float32Array
    expect(staging[0]).toBe(7)
  })

  it('a layer change on an interpolated group never fetches, and a switch back to a cell group fetches the block once', async () => {
    const root = await mounted()
    expect(valueFetches.length).toBe(1)
    choose(root, 'G3')
    await vi.waitFor(() => expect(fieldFetches.length).toBe(1))
    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerInput.value = '1'
    layerInput.dispatchEvent(new Event('input'))
    layerInput.value = '0'
    layerInput.dispatchEvent(new Event('input'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fieldFetches.length).toBe(1)
    expect(valueFetches.length).toBe(1)
    choose(root, 'G1')
    await vi.waitFor(() => expect(valueFetches.length).toBe(2))
  })

  it('choosing an interpolated group moves the layer slider to the group\'s own layer and draws it there', async () => {
    const root = await mounted(() => {
      ppLayer = 1
    })
    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    expect(layerInput.value).toBe('0')
    choose(root, 'G3')
    await vi.waitFor(() => {
      expect(root.querySelector('.floating-bottom-left')?.textContent).toContain('G3 · interpolated')
    })
    expect(layerInput.value).toBe('1')
    const uploads = recording.calls.filter((c) => c.method === 'texSubImage2D')
    const staging = uploads.at(-1)!.args[8] as Float32Array
    expect(staging[0]).toBe(7)
  })

  it('a run reopened on an interpolated group opens on that group\'s layer', async () => {
    const root = await mounted(() => {
      ppLayer = 1
      restoredGroup = 'G3'
    })
    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    expect(layerInput.value).toBe('1')
    const uploads = recording.calls.filter((c) => c.method === 'texSubImage2D')
    const staging = uploads.at(-1)!.args[8] as Float32Array
    expect(staging[0]).toBe(7)
  })

  it('a failed switch to an interpolated group puts the layer slider back', async () => {
    const root = await mounted(() => {
      ppLayer = 1
    })
    fieldMode = 'fail'
    choose(root, 'G3')
    const picker = root.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
    await vi.waitFor(() => expect(fieldFetches.length).toBe(1))
    await vi.waitFor(() => expect(picker.value).toBe('G1'))
    expect((root.querySelector('input[aria-label="Layer"]') as HTMLInputElement).value).toBe('0')
  })

  it('a click on an interpolated cell names its point count, then the points behind it', async () => {
    const root = await mounted()
    choose(root, 'G3')
    await vi.waitFor(() => expect(fieldFetches.length).toBe(1))
    await vi.waitFor(() => {
      expect(root.querySelector('.floating-bottom-left')?.textContent).toContain('G3 · interpolated')
    })
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
    canvas.dispatchEvent(new MouseEvent('click', { clientX: canvas.width / 2, clientY: canvas.height / 2 }))
    const readout = () => root.textContent ?? ''
    await vi.waitFor(() => expect(readout()).toContain('Interpolated from 1 pilot point'))
    await vi.waitFor(() => expect(readout()).toContain('p2 (weight 1.00)'))
  })

  it('a refusal the index keys by file, not group, still reaches the Params panel', async () => {
    const root = await mounted()
    const panel = root.querySelector('.params-panel')?.textContent ?? ''
    expect(panel).toContain('g9pp_inst0pp.dat')
    expect(panel).toContain('template g9pp_inst0pp.dat.tpl is not in the run directory')
  })

  it('while a switch to an interpolated group is pending, the legend keeps naming the field on screen', async () => {
    const root = await mounted()
    fieldMode = 'hang'
    choose(root, 'G3')
    await vi.waitFor(() => expect(fieldFetches.length).toBe(1))
    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerInput.value = '1'
    layerInput.dispatchEvent(new Event('input'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const legend = root.querySelector('.floating-bottom-left')?.textContent ?? ''
    expect(legend).toContain('G1')
    expect(legend).not.toContain('G3')
  })

  it('a failed switch puts the picker back on the group still drawn', async () => {
    const root = await mounted()
    fieldMode = 'fail'
    choose(root, 'G3')
    await vi.waitFor(() => expect(fieldFetches.length).toBe(1))
    const picker = root.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
    await vi.waitFor(() => expect(picker.value).toBe('G1'))
    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerInput.value = '1'
    layerInput.dispatchEvent(new Event('input'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(root.querySelector('.floating-bottom-left')?.textContent ?? '').not.toContain('G3')
  })
})
