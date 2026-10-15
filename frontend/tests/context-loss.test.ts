// @vitest-environment jsdom
//
// MAP-08/D-16: the lost/restored cycle, the re-upload from held copies,
// and the unrecoverable case. Test 1 drives the real gl/context.ts module
// directly -- no map screen needed to prove preventDefault(). Every other
// test mounts the real map screen with the real createContext (canvas's
// own getContext stubbed to a fake WebGL2RenderingContext, since jsdom has
// none) and a mocked MeshLayer, so webglcontextlost/webglcontextrestored
// are real DOM events dispatched at the real canvas, exercising the
// actual listener gl/context.ts registers.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { CONTEXT_RECOVERY_WINDOW_MS, type RunConfig } from '../src/views/map'
import { createContext } from '../src/gl/context'

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
      setFootprint: vi.fn(),
      setFootprintColor: vi.fn(),
      setSelectedPoint: vi.fn(),
      draw: vi.fn(),
      reupload: vi.fn(),
      dispose: vi.fn(),
    })
  }),
}))

const FAKE_GL = { clearColor: vi.fn(), clear: vi.fn(), viewport: vi.fn(), COLOR_BUFFER_BIT: 0 }

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

const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 1, nlay: 1, bounds: [0, 100, 0, 100], crs: 'EPSG:1', tag: 'tag1' }
const POSITIONS = new Float32Array([0, 0, 100, 0, 100, 100, 0, 100])
const CELL_INDEX = new Float32Array([0, 0, 0, 0])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0])
const CELL_ARRAY = new Int32Array([0])
const LAYER_ARRAY = new Int32Array([0])
const FIELD = new Float32Array([42])

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

const PAR_TABLE = tableToIPC(tableFromArrays({ parnme: ['p0'], pargp: ['G1'], partrans: ['none'] }), 'stream')
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')
const VIEW_STATE_BODY = {
  divider: 0.72,
  colormap: 'viridis',
  reverse: false,
  scale: 'linear',
  limits_mode: 'robust',
  group: null,
  stat: 'value',
}

function stubEnvironment(): { calls: string[] } {
  const stub = { calls: [] as string[] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path] = url.split('?')
      stub.calls.push(path)

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
        case '/api/run/view':
          return respond({ status: 200, body: VIEW_STATE_BODY })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(FIELD) })
        default:
          throw new Error(`unhandled fetch in test: ${path}`)
      }
    }),
  )
  return stub
}

function stubMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

function mountFreshRoot(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}

function statusBarText(root: HTMLElement): string {
  return root.querySelector('.status-bar')?.textContent ?? ''
}

function canvasFieldColor(root: HTMLElement): string {
  const spans = Array.from(root.querySelectorAll('.status-bar > span'))
  const field = spans.find((span) => span.textContent?.startsWith('Canvas'))
  const value = field?.querySelector('.tabular-nums') as HTMLElement | undefined
  return value?.style.color ?? ''
}

async function meshLayerInstance() {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer).mock.instances[0] as unknown as {
    reupload: ReturnType<typeof vi.fn>
    setSelected: ReturnType<typeof vi.fn>
  }
}

async function mountReady(): Promise<{ root: HTMLElement; canvas: HTMLCanvasElement; calls: string[] }> {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === 'webgl2' ? (FAKE_GL as unknown as WebGL2RenderingContext) : null) as typeof HTMLCanvasElement.prototype.getContext)
  stubMatchMedia()
  const stub = stubEnvironment()
  const { mountMap } = await import('../src/views/map')
  const root = mountFreshRoot()
  mountMap(root, { config: CONFIG, state: baseState() })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  const canvas = root.querySelector('canvas') as HTMLCanvasElement
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, right: 800, bottom: 480, width: 800, height: 480, x: 0, y: 0, toJSON: () => ({}) }),
  })
  return { root, canvas, calls: stub.calls }
}

describe('preventDefault on webglcontextlost', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is called as the first statement, unconditionally', () => {
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue(FAKE_GL as unknown as WebGL2RenderingContext)
    createContext(canvas)

    const event = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })
})

describe('the lost-and-restored cycle', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.resetModules()
    vi.useRealTimers()
  })

  it('shows "Canvas: restoring" in warning ink on loss', async () => {
    const { root, canvas } = await mountReady()
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))

    expect(statusBarText(root)).toContain('Canvas')
    expect(statusBarText(root)).toContain('restoring')
    expect(canvasFieldColor(root)).toBe('var(--status-warning)')
  })

  it('rebuilds every GL object and re-uploads from held copies on restore, issuing zero network requests', async () => {
    const { canvas, calls } = await mountReady()
    const instance = await meshLayerInstance()
    const reuploadBefore = instance.reupload.mock.calls.length
    const callsBefore = calls.length

    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    canvas.dispatchEvent(new Event('webglcontextrestored'))

    expect(instance.reupload.mock.calls.length).toBe(reuploadBefore + 1)
    expect(calls.length).toBe(callsBefore)
  })

  it('leaves the camera position, the selected cell, the drawn group and the statistic unchanged after a restore', async () => {
    const { root, canvas } = await mountReady()

    canvas.click()
    const readoutBefore = root.textContent

    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    canvas.dispatchEvent(new Event('webglcontextrestored'))

    expect(root.textContent).toBe(readoutBefore)
  })

  it('clears the restoring line once the re-upload finishes', async () => {
    const { root, canvas } = await mountReady()
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(statusBarText(root)).toContain('restoring')

    canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(statusBarText(root)).not.toContain('restoring')
  })

  it('falls to the critical designed state when the context never restores within the recovery window', async () => {
    const { root, canvas } = await mountReady()
    vi.useFakeTimers()

    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    await vi.advanceTimersByTimeAsync(CONTEXT_RECOVERY_WINDOW_MS + 1)

    const bodyText = root.textContent ?? ''
    expect(bodyText).toContain("This browser can't draw the map")
    expect(bodyText).toContain("The graphics context was lost and couldn't be restored. Reloading the page may fix this.")
  })

  it('does not fall to the critical state when the context restores within the window', async () => {
    const { root, canvas } = await mountReady()
    vi.useFakeTimers()

    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    canvas.dispatchEvent(new Event('webglcontextrestored'))
    await vi.advanceTimersByTimeAsync(CONTEXT_RECOVERY_WINDOW_MS + 1)

    expect(root.textContent ?? '').not.toContain("couldn't be restored")
  })
})
