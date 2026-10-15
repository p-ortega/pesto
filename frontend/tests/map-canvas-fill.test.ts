// @vitest-environment jsdom
//
// The canvas's pixel size follows the box it sits in, at the device's own
// pixel ratio, so the map fills the frame between the header and the status
// bar instead of sitting in a fixed 800x480 island at the top left. Drives
// the real map screen against the recording WebGL2 stub, the same way
// map-empty-layer.test.ts does.

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

const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 1, nlay: 1, bounds: [0, 1, 0, 1], crs: null, tag: 'fill' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0])
const CELL_ARRAY = new Int32Array([0])
const LAYER_ARRAY = new Int32Array([0])
const FIELD = new Float32Array([10])

const PAR_TABLE = tableToIPC(tableFromArrays({ parnme: ['p0'], pargp: ['G1'], partrans: ['none'] }), 'stream')
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL) => {
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
      case '/api/run/grid/cells/xy':
        return respond({ status: 404, body: { title: 'no point positions were recorded for that iteration', status: 404 } })
      case '/api/run/reals':
        return respond({ status: 200, bytes: REALS_TABLE })
      case '/api/run/grid/values':
        return respond({ status: 200, bytes: bytesOf(FIELD) })
      default:
        throw new Error(`unhandled fetch in test: GET ${path}`)
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// jsdom lays nothing out, so the box the canvas sits in is given a size by
// hand: every `.map-area` element reports `mapAreaSize`, everything else
// reports the zero rect jsdom returns anyway.
let mapAreaSize = { width: 0, height: 0 }

function stubLayout(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const size = this.classList.contains('map-area') ? mapAreaSize : { width: 0, height: 0 }
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: size.width,
      bottom: size.height,
      width: size.width,
      height: size.height,
      toJSON: () => ({}),
    } as DOMRect
  })
}

const resizeCallbacks: Array<() => void> = []

function stubResizeObserver(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        resizeCallbacks.push(this.callback)
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  )
}

async function mountAndDraw(): Promise<{ root: HTMLElement; canvas: HTMLCanvasElement }> {
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: baseState() })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  return { root, canvas: root.querySelector('canvas') as HTMLCanvasElement }
}

describe('the canvas fills the box it sits in', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
    resizeCallbacks.length = 0
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('takes its box size at the device pixel ratio before the first draw', async () => {
    mapAreaSize = { width: 1000, height: 600 }
    stubFetch()
    stubLayout()
    stubResizeObserver()

    const { canvas } = await mountAndDraw()

    expect(canvas.width).toBe(2000)
    expect(canvas.height).toBe(1200)
    const viewports = recording.calls.filter((c) => c.method === 'viewport')
    expect(viewports.at(-1)!.args).toEqual([0, 0, 2000, 1200])
  })

  it('keeps the 800x480 default when its box has no layout yet', async () => {
    mapAreaSize = { width: 0, height: 0 }
    stubFetch()
    stubLayout()
    stubResizeObserver()

    const { canvas } = await mountAndDraw()

    expect(canvas.width).toBe(800)
    expect(canvas.height).toBe(480)
  })

  it('follows the box when it changes size and redraws without another fetch', async () => {
    mapAreaSize = { width: 1000, height: 600 }
    const fetchMock = stubFetch()
    stubLayout()
    stubResizeObserver()

    const { canvas } = await mountAndDraw()
    expect(resizeCallbacks.length).toBeGreaterThan(0)
    const fetchesBefore = fetchMock.mock.calls.length
    const drawsBefore = recording.calls.filter((c) => c.method === 'drawElements').length

    mapAreaSize = { width: 1400, height: 700 }
    for (const callback of resizeCallbacks) callback()

    expect(canvas.width).toBe(2800)
    expect(canvas.height).toBe(1400)
    expect(fetchMock.mock.calls.length).toBe(fetchesBefore)
    expect(recording.calls.filter((c) => c.method === 'drawElements').length).toBeGreaterThan(drawsBefore)
  })
})
