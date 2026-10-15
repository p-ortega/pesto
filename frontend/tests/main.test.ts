// @vitest-environment jsdom
//
// Real jsdom (approved after a package-legitimacy gate, 82a7a98). These
// tests assert routing -- which screens mount for which answers, in which
// order, and which do not mount at all -- not the pixel rendering each
// screen's own test file already covers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom has no real WebGL2, so every routing test needs the map screen's
// canvas setup to succeed anyway -- these stand in for the two GL modules
// across the whole file. The real drawing pipeline is proven by
// tests/mesh-layer.test.ts (calls made) and tests/visual/mesh.spec.ts
// (pixels), never here; this file only asserts routing and fetch order.
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
      setPoints: vi.fn(),
      setPointRingColor: vi.fn(),
      setSelectedPoint: vi.fn(),
      draw: vi.fn(),
      reupload: vi.fn(),
      dispose: vi.fn(),
    })
  }),
}))

const CONFIG_BODY = {
  case: 'forecast_run',
  n_par: 42,
  n_real: 100,
  noise: { has_noise: true, decided_by: 'noise_ensemble', evidence: [], notes: [] },
}

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    fresh: true,
    artifacts: [],
    capabilities: {
      map: { available: true, blocked_by: [] },
      stats: { available: true, blocked_by: [] },
      chips: { available: true, blocked_by: [] },
    },
    ingest_seconds: 12.4,
    cache_bytes: 1048576,
    ...overrides,
  }
}

const ESTIMATE_BODY = {
  total: 10 * 1024 * 1024,
  per_artifact: [{ name: 'grid', bytes: 5 * 1024 * 1024 }],
  notes: [],
  free_bytes: 100 * 1024 * 1024,
  cache_root_exists: true,
}

const NO_RUN_OPEN = { type: 'about:blank', title: 'no run is open', status: 409 }
const BAD_TOKEN = { type: 'about:blank', title: 'invalid or missing token', status: 401 }

type FetchHandler = (init?: RequestInit) => { status: number; body?: unknown; stream?: Uint8Array[] }

interface FetchStub {
  calls: string[]
  handlers: Record<string, FetchHandler>
  signals: Record<string, AbortSignal | undefined>
}

function stubFetch(handlers: Record<string, FetchHandler>): FetchStub {
  const stub: FetchStub = { calls: [], handlers, signals: {} }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = url.split('?')[0]
      const key = `${method} ${path}`
      stub.calls.push(key)
      stub.signals[key] = init?.signal ?? undefined

      const handler = stub.handlers[key]
      if (!handler) {
        throw new Error(`unhandled fetch in test: ${key}`)
      }
      const result = handler(init)

      if (result.stream) {
        let index = 0
        const chunks = result.stream
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          json: async () => result.body ?? {},
          body: {
            getReader: () => ({
              read: async () => {
                if (index < chunks.length) {
                  const value = chunks[index]
                  index += 1
                  return { done: false, value }
                }
                return { done: true, value: undefined }
              },
              releaseLock: () => undefined,
            }),
          },
        }
      }

      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => result.body,
      }
    }),
  )

  return stub
}

function screenText(): string {
  return document.getElementById('app')?.textContent ?? ''
}

function screenHasText(text: string): boolean {
  return screenText().includes(text)
}

// mountMap appends the .map-frame panel synchronously, before any fetch --
// a stable signal that routing reached the map, independent of whether the
// (mocked, in this file) GL pipeline or the data load beneath it succeeds.
// The canvas itself is no longer that signal (plan 05.1-08): a designed
// state with no mesh loaded removes it, so a routing test that never
// stubs the mesh/parmap/cells routes must not depend on it surviving.
function mapMounted(): boolean {
  return document.querySelector('.map-frame') !== null
}

function findButtonByText(text: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll('button'))
  const match = buttons.find((button) => button.textContent?.includes(text))
  if (!match) {
    throw new Error(`no button found with text containing "${text}"`)
  }
  return match as HTMLButtonElement
}

async function bootMain(): Promise<void> {
  vi.resetModules()
  document.body.innerHTML = '<div id="app"></div>'
  await import('../src/main')
}

// A real session always arrives with a token in the URL, which token.ts reads
// once and strips. Routing tests need that to have happened, or boot stops at
// the session-ended screen before any routing decision is made.
function seedSession(): void {
  history.replaceState(null, '', '?token=test-token')
}

const encoder = new TextEncoder()

describe('the screen router', () => {
  beforeEach(() => {
    seedSession()
    try {
      localStorage.clear()
    } catch {
      // Node's own experimental localStorage (distinct from jsdom's) is
      // not enabled in this run; theme.ts already falls back to "system"
      // when storage throws, so nothing here depends on it being present.
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mounts the picker when no run is open, and never requests ingest state', async () => {
    const stub = stubFetch({
      'GET /api/run/config': () => ({ status: 409, body: NO_RUN_OPEN }),
      'GET /api/fs/roots': () => ({ status: 200, body: [] }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('Choose a run directory')).toBe(true)
    })
    expect(stub.calls).toContain('GET /api/run/config')
    expect(stub.calls.some((call) => call.includes('ingest'))).toBe(false)
  })

  it('routes straight to the placeholder on a warm boot, skipping the estimate and start routes', async () => {
    const stub = stubFetch({
      'GET /api/run/config': () => ({ status: 200, body: CONFIG_BODY }),
      'GET /api/run/ingest/state': () => ({ status: 200, body: baseState() }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(mapMounted()).toBe(true)
    })
    expect(screenHasText('forecast_run')).toBe(true)
    expect(stub.calls).not.toContain('GET /api/run/ingest/estimate')
    expect(stub.calls).not.toContain('POST /api/run/ingest')
  })

  it("the placeholder's notice reads as informational, never critical", async () => {
    stubFetch({
      'GET /api/run/config': () => ({ status: 200, body: CONFIG_BODY }),
      'GET /api/run/ingest/state': () => ({ status: 200, body: baseState() }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(mapMounted()).toBe(true)
    })
    expect(screenHasText('Critical')).toBe(false)
  })

  it('shows the estimate gate on a cold boot, and does not start ingest until agree is activated', async () => {
    const stub = stubFetch({
      'GET /api/run/config': () => ({ status: 200, body: CONFIG_BODY }),
      'GET /api/run/ingest/state': () => ({ status: 200, body: baseState({ fresh: false }) }),
      'GET /api/run/ingest/estimate': () => ({ status: 200, body: ESTIMATE_BODY }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('Agree and ingest')).toBe(true)
    })
    expect(stub.calls).not.toContain('POST /api/run/ingest')
  })

  it('returns to the picker when the estimate is declined', async () => {
    stubFetch({
      'GET /api/run/config': () => ({ status: 200, body: CONFIG_BODY }),
      'GET /api/run/ingest/state': () => ({ status: 200, body: baseState({ fresh: false }) }),
      'GET /api/run/ingest/estimate': () => ({ status: 200, body: ESTIMATE_BODY }),
      'GET /api/fs/roots': () => ({ status: 200, body: [] }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('Agree and ingest')).toBe(true)
    })
    findButtonByText('Go back').click()

    await vi.waitFor(() => {
      expect(screenHasText('Choose a run directory')).toBe(true)
    })
  })

  it('re-fetches config and state before mounting the placeholder when ingest finishes, and aborts the stream read', async () => {
    let configCalls = 0
    let stateCalls = 0
    const stub = stubFetch({
      'GET /api/run/config': () => {
        configCalls += 1
        return { status: 200, body: CONFIG_BODY }
      },
      'GET /api/run/ingest/state': () => {
        stateCalls += 1
        return { status: 200, body: baseState({ fresh: false }) }
      },
      'GET /api/run/ingest/estimate': () => ({ status: 200, body: ESTIMATE_BODY }),
      'POST /api/run/ingest': () => ({ status: 202, body: { started: true } }),
      'GET /api/run/ingest/events': () => ({
        status: 200,
        stream: [encoder.encode('event: done\ndata: {}\n\n')],
      }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('Agree and ingest')).toBe(true)
    })
    findButtonByText('Agree and ingest').click()

    await vi.waitFor(() => {
      expect(configCalls).toBeGreaterThanOrEqual(2)
      expect(stateCalls).toBeGreaterThanOrEqual(2)
    })
    await vi.waitFor(() => {
      expect(mapMounted()).toBe(true)
    })

    const eventsSignal = stub.signals['GET /api/run/ingest/events']
    expect(eventsSignal?.aborted).toBe(true)
  })

  it('re-checks freshness after opening a directory, skipping the estimate screen when it is already fresh', async () => {
    const stub = stubFetch({
      'GET /api/run/config': () => ({ status: 409, body: NO_RUN_OPEN }),
      'GET /api/fs/roots': () => ({
        status: 200,
        body: [{ id: 'r1', name: 'Home', is_run: true, reason: null }],
      }),
      'POST /api/fs/open': () => ({ status: 200, body: { is_run: true, case: 'forecast_run' } }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('Choose a run directory')).toBe(true)
    })

    // Once the run is opened, its cache turns out to be fully fresh.
    stub.handlers['GET /api/run/config'] = () => ({ status: 200, body: CONFIG_BODY })
    stub.handlers['GET /api/run/ingest/state'] = () => ({ status: 200, body: baseState() })

    await vi.waitFor(() => {
      findButtonByText('Open')
    })
    findButtonByText('Open').click()

    await vi.waitFor(() => {
      expect(mapMounted()).toBe(true)
    })
    expect(stub.calls).not.toContain('GET /api/run/ingest/estimate')
  })

  it("shows a notice naming a blocked capability's artifact and reason on the placeholder", async () => {
    const partiallyBlocked = baseState({
      capabilities: {
        map: { available: true, blocked_by: [] },
        stats: {
          available: false,
          blocked_by: [
            { artifact: 'par_agg/head', reason: 'the aggregation step crashed reading iteration 3' },
          ],
        },
        chips: { available: true, blocked_by: [] },
      },
    })
    stubFetch({
      'GET /api/run/config': () => ({ status: 200, body: CONFIG_BODY }),
      'GET /api/run/ingest/state': () => ({ status: 200, body: partiallyBlocked }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('par_agg/head')).toBe(true)
      expect(screenHasText('the aggregation step crashed reading iteration 3')).toBe(true)
    })
  })
})

// The D-05 join and the draw sequence in one place: a real synthetic
// dataset, fetched through the real client.ts/parmap.ts code, in the exact
// order the map screen's load sequence promises. Only the two GL modules
// are mocked (module-level, above); every fetch here is real.
describe("the map screen's load sequence", () => {
  interface BytesHandler {
    (): { status: number; bytes?: Uint8Array; body?: unknown; headers?: Record<string, string> }
  }

  interface BytesStub {
    calls: string[]
  }

  function stubBytesFetch(handlers: Record<string, BytesHandler>): BytesStub {
    const stub: BytesStub = { calls: [] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        const path = url.split('?')[0]
        const key = `GET ${path}`
        stub.calls.push(key)

        const handler = handlers[key]
        if (!handler) {
          throw new Error(`unhandled fetch in test: ${key}`)
        }
        const result = handler()
        const bytes = result.bytes ?? new Uint8Array(0)
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          json: async () => result.body ?? {},
          arrayBuffer: async () => bytes.buffer,
          headers: { get: (name: string) => result.headers?.[name] ?? null },
        }
      }),
    )
    return stub
  }

  function bytesOf(view: ArrayBufferView): Uint8Array {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }

  function metaHeader(dtype: string): Record<string, string> {
    return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
  }

  beforeEach(() => {
    seedSession()
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches mesh, parmap, the par table, cells and values in that order, and draws once', async () => {
    const { tableFromArrays, tableToIPC } = await import('apache-arrow')

    const parTable = tableToIPC(
      tableFromArrays({ parnme: ['p1'], pargp: ['G1'], partrans: ['log'] }),
      'stream',
    )
    const realsTable = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

    const positions = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
    const cellIndex = new Float32Array([0, 0, 0, 0])
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3])
    const parmap = new Int32Array([0])
    const cellArray = new Int32Array([0])
    const layerArray = new Int32Array([0])
    const field = new Float32Array([42])

    const stub = stubBytesFetch({
      'GET /api/run/config': () => ({ status: 200, body: { ...CONFIG_BODY, first_iteration: 0 } }),
      'GET /api/run/ingest/state': () => ({ status: 200, body: baseState() }),
      'GET /api/run/grid/mesh': () => ({
        status: 200,
        body: {
          n_vert: 4,
          n_tri: 2,
          n_cells: 1,
          nlay: 1,
          bounds: [0, 1, 0, 1],
          crs: null,
          tag: 'tag1',
        },
      }),
      'GET /api/run/grid/mesh/positions': () => ({
        status: 200,
        bytes: bytesOf(positions),
        headers: metaHeader('<f4'),
      }),
      'GET /api/run/grid/mesh/cell_index': () => ({
        status: 200,
        bytes: bytesOf(cellIndex),
        headers: metaHeader('<f4'),
      }),
      'GET /api/run/grid/mesh/indices': () => ({
        status: 200,
        bytes: bytesOf(indices),
        headers: metaHeader('<u4'),
      }),
      'GET /api/run/grid/parmap': () => ({ status: 200, bytes: bytesOf(parmap) }),
      'GET /api/run/meta': () => ({ status: 200, bytes: parTable }),
      'GET /api/run/grid/cells/cell': () => ({ status: 200, bytes: bytesOf(cellArray) }),
      'GET /api/run/grid/cells/layer': () => ({ status: 200, bytes: bytesOf(layerArray) }),
      'GET /api/run/reals': () => ({ status: 200, bytes: realsTable }),
      'GET /api/run/grid/values': () => ({ status: 200, bytes: bytesOf(field) }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(document.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    const orderOf = (key: string): number => stub.calls.indexOf(key)
    expect(orderOf('GET /api/run/grid/mesh')).toBeGreaterThanOrEqual(0)
    expect(orderOf('GET /api/run/grid/parmap')).toBeGreaterThan(orderOf('GET /api/run/grid/mesh/indices'))
    expect(orderOf('GET /api/run/meta')).toBeGreaterThan(orderOf('GET /api/run/grid/parmap'))
    expect(orderOf('GET /api/run/grid/cells/cell')).toBeGreaterThan(orderOf('GET /api/run/meta'))
    expect(orderOf('GET /api/run/grid/values')).toBeGreaterThan(orderOf('GET /api/run/grid/cells/layer'))

    const { MeshLayer } = await import('../src/gl/mesh-layer')
    const instance = vi.mocked(MeshLayer).mock.instances[0] as unknown as { draw: ReturnType<typeof vi.fn> }
    expect(instance.draw).toHaveBeenCalledTimes(1)
  })
})

describe('a session that can no longer authenticate', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    try {
      sessionStorage.clear()
    } catch {
      // Storage is optional; token.ts falls back to a page-lifetime token.
    }
    history.replaceState(null, '', '?')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('says the session ended rather than showing a raw token error', async () => {
    stubFetch({ 'GET /api/run/config': () => ({ status: 401, body: BAD_TOKEN }) })
    await bootMain()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const text = document.body.innerText || document.body.textContent || ''
    expect(text).toMatch(/session/i)
    expect(text).toMatch(/relaunch|restart|pesto again/i)
  })

  it('forgets a rejected token so a reload does not offer it again', async () => {
    try {
      sessionStorage.setItem('pesto.token', 'stale')
    } catch {
      return
    }
    stubFetch({ 'GET /api/run/config': () => ({ status: 401, body: BAD_TOKEN }) })
    await bootMain()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sessionStorage.getItem('pesto.token')).toBeNull()
  })
})
