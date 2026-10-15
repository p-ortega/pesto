// @vitest-environment jsdom
//
// WINDOWS.md #6: on a layer where the drawn group has no cell at all (a
// real repro from hm_20251104154614, group gwt_src_benzene_63, layer 10 --
// the group only ever sits on layers 2 and 5), the live canvas painted the
// whole model extent with the ramp's low-end colour instead of leaving it
// blank. This drives the real map screen end to end, with the real
// (unmocked) MeshLayer against a recording WebGL2 stub, so it can inspect
// the exact bytes the shader would read -- the same instrumentation the
// gap-closure brief asked for, done as a committed regression test instead
// of a throwaway console.log.
//
// Only ../src/gl/context is mocked (jsdom has no real WebGL2); MeshLayer,
// computePerCell and classifyCells all run for real.

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

// Mirrors the live repro's shape at a much smaller scale: two cells, both
// active (in the model), both carrying a row of group G1 -- cell 0 at layer
// 0, cell 1 at layer 1. nlay=3 so layer 2 is real (a valid slider position)
// yet no row of any group ever names it, exactly like benzene's layer 10.
const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 2, nlay: 3, bounds: [0, 1, 0, 1], crs: null, tag: 'empty-layer' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
const CELL_INDEX = new Float32Array([0, 0, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 1])
const LAYER_ARRAY = new Int32Array([0, 1])
const FIELD = new Float32Array([10, 20])

const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function stubEnvironment(): void {
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
}

function mountFreshRoot(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}

describe('a layer where the drawn group has zero cells (WINDOWS.md #6)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('uploads an all-NaN value texture -- no finite, no +/-Infinity -- for the empty layer', async () => {
    stubEnvironment()

    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    // Layer 2: no block row of G1 (or anything else) ever names it -- the
    // same shape as benzene's layer 10 on hm_20251104154614.
    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerInput.value = '2'
    layerInput.dispatchEvent(new Event('input'))

    const legendText = root.querySelector('.floating-bottom-left')?.textContent ?? ''
    expect(legendText).toMatch(/0.*cells contested/)
    expect(legendText).toMatch(/2.*cells no value/)

    const uploads = recording.calls.filter((c) => c.method === 'texSubImage2D')
    expect(uploads.length).toBeGreaterThan(0)
    const staging = uploads.at(-1)!.args[8] as Float32Array

    let nanCount = 0
    let finiteCount = 0
    let infiniteCount = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const v of staging) {
      if (Number.isNaN(v)) nanCount += 1
      else if (Number.isFinite(v)) {
        finiteCount += 1
        min = Math.min(min, v)
        max = Math.max(max, v)
      } else infiniteCount += 1
    }
    // Instrumentation counts, reported verbatim in the gap-closure summary:
    // the uploaded staging buffer for cells 0 and 1 (the only two real
    // cells; the rest of the R32F texture is unused padding, also NaN).
    // eslint-disable-next-line no-console
    console.log('map-empty-layer staging counts', {
      nanCount,
      finiteCount,
      infiniteCount,
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
      cell0: staging[0],
      cell1: staging[1],
    })

    expect(Number.isNaN(staging[0])).toBe(true)
    expect(Number.isNaN(staging[1])).toBe(true)
    expect(infiniteCount).toBe(0)
    expect(finiteCount).toBe(0)
  })
})
