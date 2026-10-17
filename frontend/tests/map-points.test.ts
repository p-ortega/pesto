// @vitest-environment jsdom
//
// A group placed by x/y draws as dots at its own positions rather than
// filling the cells they sit in. Built on map-interpolated.test.ts's
// harness: one unit cell, with group k's two points both inside it, the
// shape that used to draw as one contested cell.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { MeshLayer } from '../src/gl/mesh-layer'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
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

// One unit cell. p0 of G1 places on it as a cell; pa and pb of k are both
// placed by x/y inside it, on layer 0.
const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 1, nlay: 2, bounds: [0, 1, 0, 1], crs: null, tag: 'points' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0, 1, 2])
const CELL_ARRAY = new Int32Array([0, 0, 0])
const POINT_XY = new Float32Array([Number.NaN, Number.NaN, 0.25, 0.5, 0.75, 0.5])
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')
const FIELDS = { plain: [10, 20, 40], log: [10, -5, 20], nan: [10, Number.NaN, 40] }
const NO_POSITIONS = { title: 'no point positions were recorded for that iteration', status: 404 }

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

// 'log' gives k a log partrans and a negative value, so log10 is chosen and
// refused; 'nan' gives pa no value, so its dot cannot be drawn.
let kMode: 'plain' | 'log' | 'nan' = 'plain'
let xyMode: 'ok' | 'none' = 'ok'
// Which layer k's two points sit on: both on 0, both on 1, or pa on 0 and pb on 1.
let layerMode: 'same' | 'k-on-1' | 'split' = 'same'
const LAYERS = { same: [0, 0, 0], 'k-on-1': [0, 1, 1], split: [0, 0, 1] }
// 'field' makes G1 an interpolated pilot-point group on layer 0.
let ppMode: 'none' | 'field' = 'none'
// 'two' adds a second cell at x 1..2 that no parameter lands on, so it is outside the model.
let meshMode: 'one' | 'two' = 'one'
const TWO_CELLS = {
  body: { n_vert: 6, n_tri: 4, n_cells: 2, nlay: 2, bounds: [0, 2, 0, 1], crs: null, tag: 'points-two' },
  positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 2, 0, 2, 1]),
  cellIndex: new Float32Array([0, 0, 0, 0, 1, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2]),
}
const viewWrites: Array<Record<string, unknown>> = []
// What a reload finds saved; null means the run was never opened before.
let savedView: Record<string, unknown> | null = null

function stubFetch(): void {
  kMode = 'plain'
  xyMode = 'ok'
  layerMode = 'same'
  ppMode = 'none'
  meshMode = 'one'
  viewWrites.length = 0
  savedView = null
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
      const kTrans = kMode === 'log' ? 'log' : 'none'
      switch (path) {
        case '/api/run/grid/mesh':
          return respond({ status: 200, body: meshMode === 'two' ? TWO_CELLS.body : MESH_BODY })
        case '/api/run/grid/mesh/positions':
          return respond({ status: 200, bytes: bytesOf(meshMode === 'two' ? TWO_CELLS.positions : POSITIONS), headers: metaHeader('<f4') })
        case '/api/run/grid/mesh/cell_index':
          return respond({ status: 200, bytes: bytesOf(meshMode === 'two' ? TWO_CELLS.cellIndex : CELL_INDEX), headers: metaHeader('<f4') })
        case '/api/run/grid/mesh/indices':
          return respond({ status: 200, bytes: bytesOf(meshMode === 'two' ? TWO_CELLS.indices : INDICES), headers: metaHeader('<u4') })
        case '/api/run/grid/parmap':
          return respond({ status: 200, bytes: bytesOf(PARMAP) })
        case '/api/run/meta':
          return respond({
            status: 200,
            bytes: tableToIPC(
              tableFromArrays({ parnme: ['p0', 'pa', 'pb'], pargp: ['G1', 'k', 'k'], partrans: ['none', kTrans, kTrans] }),
              'stream',
            ),
          })
        case '/api/run/grid/cells/cell':
          return respond({ status: 200, bytes: bytesOf(CELL_ARRAY) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(new Int32Array(LAYERS[layerMode])) })
        case '/api/run/grid/cells/xy':
          if (xyMode === 'none') return respond({ status: 404, body: NO_POSITIONS })
          return respond({ status: 200, bytes: bytesOf(POINT_XY) })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(new Float32Array(FIELDS[kMode])) })
        case '/api/run/grid/pp':
          if (ppMode === 'field') {
            return respond({
              status: 200,
              body: {
                groups: [{ group: 'G1', layer: 0, n_pp: 1, log_space: false, format: 'text', notes: [] }],
                not_interpolable: [],
                notes: [],
              },
            })
          }
          return respond({ status: 200, body: { groups: [], not_interpolable: [], notes: [] } })
        case '/api/run/grid/field': {
          const n = meshMode === 'two' ? 2 : 1
          return respond({
            status: 200,
            bytes: bytesOf(new Float32Array(n).fill(7)),
            headers: { 'X-Pesto-Meta': JSON.stringify({ order: 'cell', group: 'G1', layer: 0, n_pp: 1 }) },
          })
        }
        case '/api/run/view':
          if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>
            viewWrites.push(body)
            return respond({ status: 200, body })
          }
          if (savedView !== null) return respond({ status: 200, body: savedView })
          throw new Error('no saved view')
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

async function mounted(setup: () => void = () => {}, store?: SelectionStore): Promise<HTMLElement> {
  stubFetch()
  setup()
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: baseState(), store })
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

function legendText(root: HTMLElement): string {
  return root.querySelector('.floating-bottom-left')?.textContent ?? ''
}

describe('a group placed by x/y draws as dots', () => {
  let setPoints: ReturnType<typeof vi.spyOn>
  let setContested: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
    setPoints = vi.spyOn(MeshLayer.prototype, 'setPoints')
    setContested = vi.spyOn(MeshLayer.prototype, 'setContested')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  function lastPoints(): [Float32Array, Float32Array] {
    return setPoints.mock.calls.at(-1) as [Float32Array, Float32Array]
  }

  it('draws its two points where they sit and counts them in the legend', async () => {
    const root = await mounted()
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('2 points on this layer'))
    const [xy, values] = lastPoints()
    expect(Array.from(xy)).toEqual([0.25, 0.5, 0.75, 0.5])
    expect(Array.from(values)).toEqual([20, 40])
    expect(legendText(root)).not.toContain('contested')
  })

  it('never marks a cell contested for it', async () => {
    const root = await mounted()
    setContested.mockClear()
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('points on this layer'))
    expect(setContested).toHaveBeenCalled()
    for (const [mask] of setContested.mock.calls as Array<[Uint8Array]>) {
      expect(Array.from(mask).some((bit) => bit !== 0)).toBe(false)
    }
  })

  it('clears the dots when the picker moves to a cell group', async () => {
    const root = await mounted()
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('points on this layer'))
    choose(root, 'G1')
    await vi.waitFor(() => expect(legendText(root)).not.toContain('points on this layer'))
    const [xy, values] = lastPoints()
    expect(xy.length).toBe(0)
    expect(values.length).toBe(0)
  })

  it('refuses log10 over a non-positive value and gives the dots their linear values', async () => {
    const root = await mounted(() => {
      kMode = 'log'
    })
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('points on this layer'))
    expect(root.textContent).toContain('Log₁₀ unavailable')
    const [, values] = lastPoints()
    expect(Array.from(values)).toEqual([-5, 20])
  })

  it('a click on a dot names its parameter and position, not the cell', async () => {
    const root = await mounted()
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('points on this layer'))
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
    // Camera.fit: 4% padding around the unit square, centred on the canvas.
    const scale = 0.96 * Math.min(canvas.width, canvas.height)
    const x = canvas.width / 2 + scale * (0.75 - 0.5)
    canvas.dispatchEvent(new MouseEvent('click', { clientX: x + 2, clientY: canvas.height / 2 }))
    const readout = root.querySelector('.floating-bottom-right')?.textContent ?? ''
    expect(readout).toContain('pb')
    expect(readout).toContain('x 1, y 1 · layer 0')
    expect(readout).not.toMatch(/\bpa\b/)
  })

  it('a click on a dot writes its parameter name to the store and clears the cell', async () => {
    const store = createSelectionStore({ initial: emptySelection('test_run', 0), schedule: () => {} })
    const root = await mounted(() => {}, store)
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('points on this layer'))
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
    const scale = 0.96 * Math.min(canvas.width, canvas.height)
    const x = canvas.width / 2 + scale * (0.75 - 0.5)
    canvas.dispatchEvent(new MouseEvent('click', { clientX: canvas.width / 2, clientY: canvas.height / 2 }))
    expect(Array.from(store.get().cells)).toEqual([0])
    canvas.dispatchEvent(new MouseEvent('click', { clientX: x + 2, clientY: canvas.height / 2 }))
    expect(Array.from(store.get().pars)).toEqual(['pb'])
    expect(store.get().cells.size).toBe(0)
  })

  it("takes the dot's parameter out of the store on a later cell click, and both out on a group change", async () => {
    const store = createSelectionStore({ initial: emptySelection('test_run', 0), schedule: () => {} })
    const root = await mounted(() => {}, store)
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('points on this layer'))
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
    const scale = 0.96 * Math.min(canvas.width, canvas.height)
    const dotX = canvas.width / 2 + scale * (0.75 - 0.5) + 2
    const clickAt = (clientX: number) => canvas.dispatchEvent(new MouseEvent('click', { clientX, clientY: canvas.height / 2 }))

    clickAt(dotX)
    expect(Array.from(store.get().pars)).toEqual(['pb'])
    clickAt(canvas.width / 2)
    expect(Array.from(store.get().cells)).toEqual([0])
    expect(store.get().pars.size).toBe(0)

    clickAt(canvas.width / 2)
    expect(Array.from(store.get().cells)).toEqual([0])
    choose(root, 'G1')
    expect(store.get().cells.size).toBe(0)

    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('points on this layer'))
    clickAt(dotX)
    expect(Array.from(store.get().pars)).toEqual(['pb'])
    choose(root, 'G1')
    expect(store.get().pars.size).toBe(0)
    expect(store.get().cells.size).toBe(0)
  })

  it('a click on the host cell away from its dots says how many sit there, not that none do', async () => {
    const root = await mounted()
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('points on this layer'))
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
    canvas.dispatchEvent(new MouseEvent('click', { clientX: canvas.width / 2, clientY: canvas.height / 2 }))
    const readout = root.querySelector('.floating-bottom-right')?.textContent ?? ''
    expect(readout).toContain('2 parameters of k sit in this cell, drawn as dots. Click a dot to read one.')
    expect(readout).not.toContain('No parameter')
  })

  it('leaves out a dot with no value, so it is neither drawn nor picked', async () => {
    const root = await mounted(() => {
      kMode = 'nan'
    })
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('1 points on this layer'))
    const [xy, values] = lastPoints()
    expect(Array.from(xy)).toEqual([0.75, 0.5])
    expect(Array.from(values)).toEqual([40])
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
    const scale = 0.96 * Math.min(canvas.width, canvas.height)
    const x = canvas.width / 2 + scale * (0.25 - 0.5)
    canvas.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: canvas.height / 2 }))
    const readout = root.querySelector('.floating-bottom-right')?.textContent ?? ''
    expect(readout).not.toMatch(/\bpa\b/)
    expect(readout).toContain('2 parameters of k sit in this cell')
  })

  it('draws as cells exactly as before when the run recorded no positions', async () => {
    const root = await mounted(() => {
      xyMode = 'none'
    })
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('1 cells contested'))
    expect(legendText(root)).not.toContain('points on this layer')
    const contested = setContested.mock.calls.at(-1)![0] as Uint8Array
    expect(Array.from(contested)).toEqual([1])
    expect(root.textContent).not.toContain('Point positions')
  })

  it('lays a quiet footprint under the dots, and takes it away for a cell group', async () => {
    const setFootprint = vi.spyOn(MeshLayer.prototype, 'setFootprint')
    const root = await mounted(() => {
      meshMode = 'two'
    })
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('points on this layer'))
    // Cell 0 hosts the dots; cell 1 has no parameter on it, so it is outside the model.
    const mask = setFootprint.mock.calls.at(-1)![0] as Uint8Array
    expect(Array.from(mask)).toEqual([1, 0])
    choose(root, 'G1')
    await vi.waitFor(() => expect(legendText(root)).not.toContain('points on this layer'))
    expect(setFootprint.mock.calls.at(-1)![0]).toBeNull()
  })

  it('picked from a layer with none of its dots, opens on the first layer that has some', async () => {
    const root = await mounted(() => {
      layerMode = 'k-on-1'
    })
    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    expect(layerInput.value).toBe('0')
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('2 points on this layer'))
    expect(layerInput.value).toBe('1')
  })

  it('picked from a layer that holds some of its dots, stays there', async () => {
    const root = await mounted(() => {
      layerMode = 'split'
    })
    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerInput.value = '1'
    layerInput.dispatchEvent(new Event('input'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('1 points on this layer'))
    expect(layerInput.value).toBe('1')
    const [xy] = lastPoints()
    expect(Array.from(xy)).toEqual([0.75, 0.5])
  })

  it('switched to from an interpolated group, still opens on the layer holding its dots', async () => {
    const root = await mounted(() => {
      layerMode = 'k-on-1'
      ppMode = 'field'
    })
    choose(root, 'G1')
    await vi.waitFor(() => expect(legendText(root)).toContain('G1 · interpolated'))
    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    expect(layerInput.value).toBe('0')
    choose(root, 'k')
    await vi.waitFor(() => expect(legendText(root)).toContain('2 points on this layer'))
    expect(layerInput.value).toBe('1')
    // Earlier tests' maps can still write, so look for this one's write rather than the last.
    await vi.waitFor(() => expect(viewWrites.some((w) => w.group === 'k' && w.layer === 1)).toBe(true), {
      timeout: 2000,
    })
  })

  const SAVED = { divider: 0.7, colormap: 'viridis', reverse: false, scale: 'linear', limits_mode: 'robust', stat: 'value' }

  it('reopens on the saved layer when it still holds some of the dots', async () => {
    const root = await mounted(() => {
      layerMode = 'split'
      savedView = { ...SAVED, group: 'k', layer: 1 }
    })
    await vi.waitFor(() => expect(legendText(root)).toContain('1 points on this layer'))
    expect((root.querySelector('input[aria-label="Layer"]') as HTMLInputElement).value).toBe('1')
  })

  it('reopens on the layer holding the dots when the saved layer holds none', async () => {
    const root = await mounted(() => {
      layerMode = 'k-on-1'
      savedView = { ...SAVED, group: 'k', layer: 0 }
    })
    await vi.waitFor(() => expect(legendText(root)).toContain('2 points on this layer'))
    expect((root.querySelector('input[aria-label="Layer"]') as HTMLInputElement).value).toBe('1')
  })
})
