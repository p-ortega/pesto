// @vitest-environment jsdom
//
// D-13/D-14: a layer change never fetches; a realization, statistic or
// iteration change is coalesced to one animation frame with one request in
// flight and the newest selection winning. These tests drive the real map
// screen (mountMap) against a stubbed fetch and a hand-stepped
// requestAnimationFrame -- only the two GL modules are mocked, exactly as
// tests/main.test.ts already does for the same reason (jsdom has no real
// WebGL2).

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import type { RunConfig } from '../src/views/map'

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({
    gl: { clearColor: vi.fn(), clear: vi.fn(), viewport: vi.fn(), COLOR_BUFFER_BIT: 0 },
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
      draw: vi.fn(),
      reupload: vi.fn(),
      dispose: vi.fn(),
    })
  }),
}))

vi.mock('../src/gl/colormap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/gl/colormap')>()
  return { ...actual, scaleLimits: vi.fn(actual.scaleLimits) }
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

// Two block rows, on two different layers and cells, both in group G1 --
// enough to prove the layer filter without needing a second group.
const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 2, nlay: 2, bounds: [0, 1, 0, 1], crs: null, tag: 'tag1' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
const CELL_INDEX = new Float32Array([0, 0, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 1])
const LAYER_ARRAY = new Int32Array([0, 1])

type DeferredMap = Map<string, { resolve: (bytes: Uint8Array) => void; reject: (error: unknown) => void }>

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

interface Handler {
  (query: URLSearchParams): { status: number; bytes?: Uint8Array; body?: unknown; headers?: Record<string, string> } | Promise<{
    status: number
    bytes?: Uint8Array
    body?: unknown
    headers?: Record<string, string>
  }>
}

interface StubResult {
  calls: string[]
  valuesCalls: string[]
}

const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base', 'r001', 'r002'] }), 'stream')

function stubEnvironment(valuesHandler: Handler): StubResult {
  const stub: StubResult = { calls: [], valuesCalls: [] }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path, search] = url.split('?')
      const key = `GET ${path}`
      stub.calls.push(key)
      const query = new URLSearchParams(search ?? '')

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
        case '/api/run/grid/values': {
          stub.valuesCalls.push(query.get('realization') ?? query.get('stat') ?? '')
          return respond(await valuesHandler(query))
        }
        default:
          throw new Error(`unhandled fetch in test: ${key}`)
      }
    }),
  )

  return stub
}

function stubRaf(): { flush: () => void; pendingCount: () => number } {
  let callbacks: FrameRequestCallback[] = []
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      callbacks.push(cb)
      return callbacks.length
    }),
  )
  return {
    flush: () => {
      const toRun = callbacks
      callbacks = []
      for (const cb of toRun) cb(0)
    },
    pendingCount: () => callbacks.length,
  }
}

function fields(): Record<string, Float32Array> {
  return {
    base: new Float32Array([10, 20]),
    r001: new Float32Array([11, 21]),
    r002: new Float32Array([12, 22]),
  }
}

async function meshLayerInstance() {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer).mock.instances[0] as unknown as {
    setValues: ReturnType<typeof vi.fn>
    setLimits: ReturnType<typeof vi.fn>
    draw: ReturnType<typeof vi.fn>
  }
}

function statusBarText(root: HTMLElement): string {
  return root.querySelector('.status-bar')?.textContent ?? ''
}

function statusSelectionColor(root: HTMLElement): string {
  const spans = Array.from(root.querySelectorAll('.status-bar > span'))
  const selectionField = spans.find((span) => span.textContent?.startsWith('Selection'))
  const value = selectionField?.querySelector('.tabular-nums') as HTMLElement | undefined
  return value?.style.color ?? ''
}

function mountFreshRoot(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}

describe('the redraw path', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('five layer changes in a row issue zero fetches and produce one draw per change', async () => {
    const values = fields()
    const stub = stubEnvironment((query) => ({ status: 200, bytes: bytesOf(values[query.get('realization') ?? 'base']) }))
    stubRaf()

    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    const instance = await meshLayerInstance()
    const drawsBefore = instance.draw.mock.calls.length
    const valuesFetchesBefore = stub.calls.filter((c) => c === 'GET /api/run/grid/values').length

    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    for (const value of ['1', '0', '1', '0', '1']) {
      layerInput.value = value
      layerInput.dispatchEvent(new Event('input'))
    }

    const valuesFetchesAfter = stub.calls.filter((c) => c === 'GET /api/run/grid/values').length
    expect(valuesFetchesAfter).toBe(valuesFetchesBefore)
    expect(instance.draw.mock.calls.length).toBe(drawsBefore + 5)
  })

  it('five realization changes inside one animation frame issue exactly one fetch, for the last selection', async () => {
    const values = fields()
    const stub = stubEnvironment((query) => ({ status: 200, bytes: bytesOf(values[query.get('realization') ?? 'base']) }))
    const raf = stubRaf()

    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    const valuesCallsBefore = stub.valuesCalls.length
    const realInput = root.querySelector('input[aria-label="Realization"]') as HTMLInputElement
    for (const value of ['1', '2', '0', '1', '2']) {
      realInput.value = value
      realInput.dispatchEvent(new Event('input'))
    }

    // Not yet fetched -- coalesced onto the next animation frame.
    expect(stub.valuesCalls.length).toBe(valuesCallsBefore)
    raf.flush()
    await vi.waitFor(() => {
      expect(stub.valuesCalls.length).toBe(valuesCallsBefore + 1)
    })
    expect(stub.valuesCalls[stub.valuesCalls.length - 1]).toBe('r002')
  })

  it('drops a response for an older token once a newer request has started', async () => {
    const deferred: DeferredMap = new Map()
    const stub = stubEnvironment(
      (query) =>
        new Promise((resolve, reject) => {
          deferred.set(query.get('realization') ?? '', {
            resolve: (bytes) => resolve({ status: 200, bytes }),
            reject,
          })
        }),
    )
    const raf = stubRaf()

    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })
    await vi.waitFor(() => expect(deferred.has('base')).toBe(true))
    deferred.get('base')!.resolve(bytesOf(fields().base))
    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    const instance = await meshLayerInstance()
    const setValuesBefore = instance.setValues.mock.calls.length

    const realInput = root.querySelector('input[aria-label="Realization"]') as HTMLInputElement
    realInput.value = '1'
    realInput.dispatchEvent(new Event('input'))
    raf.flush()
    await vi.waitFor(() => expect(deferred.has('r001')).toBe(true))

    realInput.value = '2'
    realInput.dispatchEvent(new Event('input'))
    raf.flush()
    await vi.waitFor(() => expect(deferred.has('r002')).toBe(true))

    // The older (r001) request resolves after the newer (r002) one started.
    deferred.get('r001')!.resolve(bytesOf(fields().r001))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(instance.setValues.mock.calls.length).toBe(setValuesBefore)

    deferred.get('r002')!.resolve(bytesOf(fields().r002))
    await vi.waitFor(() => {
      expect(instance.setValues.mock.calls.length).toBe(setValuesBefore + 1)
    })
    expect(stub.calls.filter((c) => c === 'GET /api/run/grid/values').length).toBeGreaterThanOrEqual(3)
  })

  it('keeps the last drawn field on screen and names the pending selection while a fetch is in flight', async () => {
    const deferred: DeferredMap = new Map()
    stubEnvironment(
      (query) =>
        new Promise((resolve) => {
          deferred.set(query.get('realization') ?? '', { resolve: (bytes) => resolve({ status: 200, bytes }), reject: () => {} })
        }),
    )
    const raf = stubRaf()

    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })

    await vi.waitFor(() => expect(deferred.has('base')).toBe(true))
    deferred.get('base')!.resolve(bytesOf(fields().base))
    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    const instance = await meshLayerInstance()
    const setValuesBefore = instance.setValues.mock.calls.length

    const realInput = root.querySelector('input[aria-label="Realization"]') as HTMLInputElement
    realInput.value = '1'
    realInput.dispatchEvent(new Event('input'))
    raf.flush()
    await vi.waitFor(() => expect(deferred.has('r001')).toBe(true))

    // Still pending: the canvas has not been redrawn from it yet.
    expect(instance.setValues.mock.calls.length).toBe(setValuesBefore)
    expect(statusBarText(root)).toContain('r001')

    deferred.get('r001')!.resolve(bytesOf(fields().r001))
    await vi.waitFor(() => {
      expect(instance.setValues.mock.calls.length).toBe(setValuesBefore + 1)
    })
  })

  it('on a rejected fetch, keeps the last good field, writes the failure in warning ink, and clears it on the next landed fetch', async () => {
    const values = fields()
    let failNext = false
    stubEnvironment((query) => {
      if (failNext) {
        failNext = false
        return { status: 502, body: { type: 'about:blank', title: 'the field could not be read', status: 502 } }
      }
      return { status: 200, bytes: bytesOf(values[query.get('realization') ?? 'base']) }
    })
    const raf = stubRaf()

    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    const instance = await meshLayerInstance()
    const setValuesBefore = instance.setValues.mock.calls.length

    failNext = true
    const realInput = root.querySelector('input[aria-label="Realization"]') as HTMLInputElement
    realInput.value = '1'
    realInput.dispatchEvent(new Event('input'))
    raf.flush()

    await vi.waitFor(() => {
      expect(statusBarText(root)).toMatch(/couldn't load \(502\)/)
    })
    expect(instance.setValues.mock.calls.length).toBe(setValuesBefore)
    expect(realInput.disabled).toBe(false)
    expect(statusSelectionColor(root)).toBe('var(--status-warning)')

    realInput.value = '2'
    realInput.dispatchEvent(new Event('input'))
    raf.flush()

    // Wait for the actual landed effect, not the status line -- the line
    // clears the moment the next fetch is scheduled (before it lands), so
    // asserting on it first would race the fetch's own promise chain.
    await vi.waitFor(() => {
      expect(instance.setValues.mock.calls.length).toBe(setValuesBefore + 1)
    })
    expect(statusBarText(root)).not.toMatch(/couldn't load/)
  })

  it('computes limits only in the response-landed path, not on a layer-only change', async () => {
    const values = fields()
    stubEnvironment((query) => ({ status: 200, bytes: bytesOf(values[query.get('realization') ?? 'base']) }))
    stubRaf()

    const { mountMap } = await import('../src/views/map')
    const { scaleLimits } = await import('../src/gl/colormap')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    const callsAfterLoad = vi.mocked(scaleLimits).mock.calls.length
    expect(callsAfterLoad).toBeGreaterThanOrEqual(1)

    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerInput.value = '1'
    layerInput.dispatchEvent(new Event('input'))

    expect(vi.mocked(scaleLimits).mock.calls.length).toBe(callsAfterLoad)
  })
})
