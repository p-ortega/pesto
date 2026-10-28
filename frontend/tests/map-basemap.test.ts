// @vitest-environment jsdom
//
// MAPX-04 on the whole map screen: the basemap controls, the layer drawn under the field, and
// the routes it reads, with BasemapLayer and MeshLayer mocked and createImageBitmap stubbed.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { IngestState } from '../src/data/client'
import type { RunConfig } from '../src/views/map'

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({
    gl: { clearColor: vi.fn(), clear: vi.fn(), viewport: vi.fn(), COLOR_BUFFER_BIT: 0 },
    onLost: vi.fn(),
    onRestored: vi.fn(),
  })),
}))

vi.mock('../src/gl/mesh-layer', async (importOriginal) =>
  (await import('./support/mesh-layer-mock')).meshLayerMockModule(await importOriginal()),
)

const layerState = vi.hoisted(() => ({ refusal: null as string | null }))

vi.mock('../src/gl/basemap-layer', () => {
  const BasemapLayer = vi.fn().mockImplementation(function MockBasemapLayer(this: Record<string, unknown>) {
    this.setImage = vi.fn(() => layerState.refusal)
    this.setSaturation = vi.fn()
    this.setMatrix = vi.fn()
    this.draw = vi.fn()
    this.hasImage = vi.fn()
    this.reupload = vi.fn()
    this.dispose = vi.fn()
  })
  Object.assign(BasemapLayer, { maxTextureSize: vi.fn(() => 4096) })
  return { BasemapLayer }
})

interface PickerCall {
  host: HTMLElement
  opts: { onPick(file: { id: string; name: string }): void; onClose(): void }
  close: Mock
}

const picker = vi.hoisted(() => ({ calls: [] as PickerCall[] }))

vi.mock('../src/ui/basemap-picker', () => ({
  openBasemapPicker: vi.fn((host: HTMLElement, opts: PickerCall['opts']) => {
    const close = vi.fn()
    picker.calls.push({ host, opts, close })
    return { close }
  }),
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

const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 2, nlay: 2, bounds: [0, 1, 0, 1], origin: [500, 7000], crs: null, tag: 'basemap' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
const CELL_INDEX = new Float32Array([0, 0, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 1])
const LAYER_ARRAY = new Int32Array([0, 0])
const FIELD = new Float32Array([10, 20])

const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

const VIEW = {
  divider: 0.72,
  colormap: 'viridis',
  reverse: false,
  scale: 'linear',
  limits_mode: 'robust',
  group: 'G1',
  stat: 'value',
  layer: 0,
}

function ready(tag = 't1', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ready',
    name: 'map.png',
    format: 'png',
    width: 4,
    height: 2,
    extent: [0, 1, 0, 1],
    placed_by: 'world_file',
    world_file: 'map.pgw',
    notes: [],
    tag,
    ...extra,
  }
}

function imageMeta(tag: string): Record<string, unknown> {
  return { format: 'png', width: 4, height: 2, served_width: 4, served_height: 2, resize_to: null, notes: [], tag }
}

interface Reply {
  status: number
  bytes?: Uint8Array
  body?: unknown
  headers?: Record<string, string>
}

type Route = (init: RequestInit | undefined, query: URLSearchParams) => Reply | Promise<Reply>

// Basemap routes by "METHOD path"; a route not listed throws like every other unknown route.
let basemapRoutes: Record<string, Route> = {}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function respond(result: Reply) {
  const bytes = result.bytes ?? new Uint8Array(0)
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    json: async () => result.body ?? {},
    arrayBuffer: async () => bytes.buffer,
    headers: { get: (name: string) => result.headers?.[name] ?? null },
  }
}

function stubEnvironment(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path, search] = url.split('?')
      const method = init?.method ?? 'GET'
      const route = basemapRoutes[`${method} ${path}`]
      if (route) return respond(await route(init, new URLSearchParams(search ?? '')))
      switch (path) {
        case '/api/run/view':
          return respond({ status: 200, body: VIEW })
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
          throw new Error(`unhandled fetch in test: ${method} ${path}`)
      }
    }),
  )
}

interface FakeBitmap {
  width: number
  height: number
  close: Mock
}

let bitmaps: FakeBitmap[] = []

function stubDecoder(): void {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      const bitmap = { width: 4, height: 2, close: vi.fn() }
      bitmaps.push(bitmap)
      return bitmap
    }),
  )
}

function serveReady(tag = 't1', extra: Record<string, unknown> = {}): void {
  basemapRoutes['GET /api/run/basemap'] = () => ({ status: 200, body: ready(tag, extra) })
  basemapRoutes['GET /api/run/basemap/image'] = () => ({
    status: 200,
    bytes: new Uint8Array([137, 80, 78, 71]),
    headers: { 'X-Pesto-Meta': JSON.stringify(imageMeta(tag)) },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

type LayerMock = Record<'setImage' | 'setSaturation' | 'setMatrix' | 'draw' | 'reupload', Mock>
type MeshMock = Record<'draw' | 'setMatrix' | 'reupload' | 'setFieldOpacity' | 'setGridLines' | 'setGridLineColor', Mock>

async function basemapLayers(): Promise<LayerMock[]> {
  const { BasemapLayer } = await import('../src/gl/basemap-layer')
  return vi.mocked(BasemapLayer).mock.instances as unknown as LayerMock[]
}

async function meshLayer(): Promise<MeshMock> {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer).mock.instances[0] as unknown as MeshMock
}

async function openMap(): Promise<HTMLElement> {
  stubEnvironment()
  stubDecoder()
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: baseState() })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  return root
}

function controls(root: HTMLElement): HTMLElement {
  const found = root.querySelector<HTMLElement>('.basemap-controls')
  if (!found) throw new Error('no basemap controls')
  return found
}

function buttonIn(el: HTMLElement, text: string): HTMLButtonElement | null {
  return Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === text) ?? null
}

function click(el: HTMLElement, text: string): void {
  const found = buttonIn(el, text)
  if (!found) throw new Error(`no button ${text} in: ${el.textContent}`)
  found.click()
}

function view(root: HTMLElement): string | null {
  return controls(root).getAttribute('data-view')
}

// The map pans from the keyboard only while the canvas holds focus.
function pan(root: HTMLElement, key: string): void {
  const canvas = root.querySelector('canvas')!
  canvas.focus()
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key }))
}

function fetchCalls(prefix: string): Array<[string, RequestInit | undefined]> {
  return vi
    .mocked(fetch)
    .mock.calls.map(([input, init]) => [String(input), init] as [string, RequestInit | undefined])
    .filter(([url]) => url.startsWith(prefix))
}

beforeEach(() => {
  document.body.innerHTML = ''
  basemapRoutes = {}
  bitmaps = []
  picker.calls = []
  layerState.refusal = null
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('a registered basemap drawn when the run opens', () => {
  it('draws the image under the field, placed by its extent and the mesh origin', async () => {
    serveReady()
    const root = await openMap()

    await vi.waitFor(async () => expect((await basemapLayers()).length).toBe(1))
    const [basemap] = await basemapLayers()
    await vi.waitFor(() => expect(basemap.setImage).toHaveBeenCalled())
    expect(basemap.setImage).toHaveBeenCalledWith(bitmaps[0], [0, 1, 0, 1], [500, 7000])
    expect(basemap.setMatrix).toHaveBeenCalled()
    expect(basemap.setSaturation).toHaveBeenCalledWith(0)

    const mesh = await meshLayer()
    basemap.draw.mockClear()
    mesh.draw.mockClear()
    pan(root, 'ArrowLeft')
    expect(basemap.draw).toHaveBeenCalledTimes(1)
    expect(mesh.draw).toHaveBeenCalledTimes(1)
    expect(basemap.draw.mock.invocationCallOrder[0]).toBeLessThan(mesh.draw.mock.invocationCallOrder[0])
  })

  it('asks for the image at the largest texture the graphics card holds', async () => {
    serveReady()
    await openMap()
    await vi.waitFor(() => expect(fetchCalls('/api/run/basemap/image').length).toBe(1))
    const [url] = fetchCalls('/api/run/basemap/image')[0]
    expect(new URLSearchParams(url.split('?')[1]).get('max')).toBe('4096')
  })

  it('keeps the basemap in step with the camera and rebuilds it after a lost context', async () => {
    serveReady()
    const root = await openMap()
    await vi.waitFor(async () => expect((await basemapLayers())[0]?.setImage).toHaveBeenCalled())
    const [basemap] = await basemapLayers()
    const mesh = await meshLayer()

    const before = basemap.setMatrix.mock.calls.at(-1)?.[0] as Float32Array
    pan(root, 'ArrowRight')
    const after = basemap.setMatrix.mock.calls.at(-1)?.[0] as Float32Array
    expect(Array.from(after)).not.toEqual(Array.from(before))
    expect(after).toEqual(mesh.setMatrix.mock.calls.at(-1)?.[0])

    const { createContext } = await import('../src/gl/context')
    const context = vi.mocked(createContext).mock.results[0].value as { onRestored: Mock }
    const restore = context.onRestored.mock.calls[0][0] as () => void
    restore()
    expect(basemap.reupload).toHaveBeenCalledTimes(1)
    expect(mesh.reupload).toHaveBeenCalledTimes(1)
    expect(basemap.setMatrix.mock.calls.at(-1)?.[0]).toEqual(mesh.setMatrix.mock.calls.at(-1)?.[0])
  })

  it('says it was placed by its world file, with the numbers, in the map controls', async () => {
    serveReady()
    const root = await openMap()
    await vi.waitFor(() => expect(view(root)).toBe('ready'))
    const box = controls(root)
    expect(box.textContent).toContain('basemap placed by world file map.pgw')
    expect(box.querySelector('.basemap-extent')?.textContent).toBe('x 0 to 1 · y 0 to 1')
    expect(root.querySelector('.floating-top-left')?.contains(box)).toBe(true)
  })

  it('shows why a registered basemap is unavailable, offers Remove, and builds no layer', async () => {
    basemapRoutes['GET /api/run/basemap'] = () => ({
      status: 200,
      body: {
        status: 'unavailable',
        reason: 'the basemap file map.png is no longer there; remove it or add it again',
        name: 'map.png',
        placed_by: 'world_file',
        extent: [0, 1, 0, 1],
      },
    })
    const root = await openMap()
    await vi.waitFor(() => expect(view(root)).toBe('unavailable'))
    expect(controls(root).textContent).toContain('the basemap file map.png is no longer there; remove it or add it again')
    expect(buttonIn(controls(root), 'Remove basemap')).not.toBeNull()
    expect(fetchCalls('/api/run/basemap/image')).toHaveLength(0)
    expect(await basemapLayers()).toHaveLength(0)
  })

  it('opens as before when the basemap state cannot be read, with only Add and a quiet line', async () => {
    const root = await openMap()
    await vi.waitFor(() => expect(controls(root).querySelector('.basemap-muted')).not.toBeNull())

    const box = controls(root)
    expect(Array.from(box.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Add basemap'])
    expect(box.querySelector('.basemap-muted')?.textContent).toMatch(/^the basemap could not be read: /)
    const notices = root.querySelector('[data-testid="map-notices"]') as HTMLElement
    expect(notices.textContent).not.toMatch(/basemap/i)
    expect(await basemapLayers()).toHaveLength(0)
  })

  it('shows the layer refusal of an image too large for the card and keeps no image', async () => {
    serveReady()
    layerState.refusal = 'the image is 4 × 2 pixels; this graphics card holds at most 2 pixels per side'
    const root = await openMap()
    await vi.waitFor(() => expect(view(root)).toBe('unavailable'))
    expect(controls(root).textContent).toContain('this graphics card holds at most 2 pixels per side')
    expect(bitmaps[0].close).toHaveBeenCalled()
  })

  it('reads the state only after the first draw', async () => {
    const hold = deferred<Reply>()
    basemapRoutes['GET /api/run/basemap'] = () => hold.promise
    const root = await openMap()
    await vi.waitFor(() => expect(fetchCalls('/api/run/basemap')).toHaveLength(1))
    const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input).split('?')[0])
    expect(urls.indexOf('/api/run/basemap')).toBeGreaterThan(urls.indexOf('/api/run/grid/values'))
    hold.resolve({ status: 200, body: { status: 'none' } })
    await vi.waitFor(() => expect(buttonIn(controls(root), 'Add basemap')).not.toBeNull())
    expect(controls(root).querySelector('.basemap-muted')).toBeNull()
  })
})
