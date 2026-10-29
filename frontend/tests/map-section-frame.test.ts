// @vitest-environment jsdom
//
// The section's frame on the map (SECT-01, D-19 to D-21): the vertical exaggeration offered,
// used and always stated, Home and the fit button fitting the section at that exaggeration,
// and the band over the plan's layer. The real map screen against a stubbed fetch, as in
// map-section.test.ts, with the GL context and MeshLayer mocked and a recording 2D overlay.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { Camera } from '../src/gl/camera'
import { SectionCamera, type VeMode } from '../src/gl/section-camera'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'
import { axesInset } from '../src/ui/section-axes'
import { createRecording2d } from './support/recording-2d'
import { loadRealStylesheet } from './support/run-together'

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({
    gl: { clearColor: vi.fn(), clear: vi.fn(), viewport: vi.fn(), finish: vi.fn(), COLOR_BUFFER_BIT: 0 },
    onLost: vi.fn(),
    onRestored: vi.fn(),
  })),
}))

vi.mock('../src/gl/mesh-layer', async (importOriginal) =>
  (await import('./support/mesh-layer-mock')).meshLayerMockModule(await importOriginal()),
)

// The real controller, with the layer hook counted so a test can call it directly.
vi.mock('../src/ui/section-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/section-view')>()
  return {
    ...actual,
    createSectionView: vi.fn((opts: Parameters<typeof actual.createSectionView>[0]) => {
      const handle = actual.createSectionView(opts)
      handle.planLayerChanged = vi.fn(handle.planLayerChanged)
      return handle
    }),
  }
})

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'section-tracer-answer.json'), 'utf8'),
) as Record<string, unknown>
const SECTION_BOUNDS: [number, number, number, number] = [0, 3.5, 0, 10]
// The section layer subtracts half the line length and the middle elevation before drawing.
const SECTION_REF: [number, number] = [1.75, 5]

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
      obs: { available: true, blockedBy: [] },
      section: { available: true, blockedBy: [] },
    },
    ingestSeconds: null,
    cacheBytes: null,
  }
}

const ORIGIN: [number, number] = [1000, 2000]
const BOUNDS: [number, number, number, number] = [0, 2, 0, 1]
const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 2, bounds: BOUNDS, origin: ORIGIN, crs: null, tag: 'section', has_idomain: true }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PARMAP = new Int32Array([0, 1, 2, 3])
const CELL_ARRAY = new Int32Array([0, 1, 0, 1])
const LAYER_ARRAY = new Int32Array([0, 0, 1, 1])
const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1', 'p2', 'p3'], pargp: ['G1', 'G1', 'G1', 'G1'], partrans: ['none', 'none', 'none', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')
const VIEW_KEYS = ['classes', 'colormap', 'divider', 'group', 'layer', 'limits_mode', 'reverse', 'scale', 'stat', 'symmetric', 'tab', 'texture']

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

interface Stub {
  section: URLSearchParams[]
  calls: string[]
  puts: Record<string, unknown>[]
}

function stubEnvironment(): Stub {
  const stub: Stub = { section: [], calls: [], puts: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path, search] = url.split('?')
      const query = new URLSearchParams(search ?? '')
      stub.calls.push(path)
      const respond = (result: { status: number; bytes?: Uint8Array; body?: unknown; headers?: Record<string, string> }) => {
        const bytes = result.bytes ?? new Uint8Array(0)
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          json: async () => result.body ?? {},
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
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
        case '/api/run/grid/idomain':
          return respond({ status: 200, bytes: bytesOf(new Int32Array([1, 1, 1, 1])) })
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
          return respond({ status: 200, bytes: bytesOf(new Float32Array([10, 20, 30, 40])) })
        case '/api/run/grid/pp':
          return respond({ status: 200, body: { groups: [], not_interpolable: [], notes: [] } })
        case '/api/run/view':
          if (init?.method === 'PUT') {
            stub.puts.push(JSON.parse(String(init.body)) as Record<string, unknown>)
            return respond({ status: 200, body: {} })
          }
          throw new Error('no saved view')
        case '/api/run/grid/section':
          stub.section.push(query)
          return respond({ status: 200, body: FIXTURE })
        case '/api/run/obs/groups':
          return respond({ status: 404, body: { title: 'no observation groups in this test', status: 404 } })
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
  return stub
}

type Mocked = ReturnType<typeof vi.fn>

interface LayerDouble {
  setMatrix: Mocked
  setValues: Mocked
  reupload: Mocked
  draw: Mocked
}

async function meshLayerMock() {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer)
}

async function planLayer(): Promise<LayerDouble> {
  return (await meshLayerMock()).mock.instances[0] as unknown as LayerDouble
}

async function sectionLayer(): Promise<LayerDouble> {
  return (await meshLayerMock()).mock.instances.at(-1) as unknown as LayerDouble
}

const recording = createRecording2d()

function stubOverlayContext(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === '2d' ? recording.ctx : null) as typeof HTMLCanvasElement.prototype.getContext)
}

interface Mounted {
  root: HTMLElement
  canvas: HTMLCanvasElement
  stub: Stub
  store: SelectionStore
  layer: LayerDouble
}

async function mounted(): Promise<Mounted> {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
  const stub = stubEnvironment()
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    }),
  )
  const store = createSelectionStore({ initial: emptySelection('test_run', 0), schedule: (run) => queueMicrotask(run) })
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: baseState(), store })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  const canvas = root.querySelector('canvas') as HTMLCanvasElement
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
  return { root, canvas, stub, store, layer: await planLayer() }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function clientAtPlan(canvas: HTMLCanvasElement, wx: number, wy: number): [number, number] {
  const camera = new Camera(canvas.width, canvas.height)
  camera.fit(BOUNDS)
  const [x0, y0] = camera.screenToWorld(0, 0)
  const [x1, y1] = camera.screenToWorld(1, 1)
  return [(wx - x0) / (x1 - x0), (wy - y0) / (y1 - y0)]
}

function pointer(type: string, [x, y]: [number, number]): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true, cancelable: true })
}

function clickAt(canvas: HTMLCanvasElement, point: [number, number]): void {
  canvas.dispatchEvent(pointer('pointerdown', point))
  canvas.dispatchEvent(pointer('pointerup', point))
  canvas.dispatchEvent(new MouseEvent('click', { clientX: point[0], clientY: point[1], bubbles: true }))
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!found) throw new Error(`no button reads ${text}`)
  return found as HTMLButtonElement
}

const toolButton = (root: HTMLElement): HTMLButtonElement =>
  root.querySelector('button[aria-label="Draw section line"]') as HTMLButtonElement
const sectionToggle = (root: HTMLElement): HTMLButtonElement => buttonByText(root, 'Section view')
const planToggle = (root: HTMLElement): HTMLButtonElement => buttonByText(root, 'Plan view')
const legendText = (root: HTMLElement): string => root.querySelector('.floating-bottom-left')?.textContent ?? ''
const veSelect = (root: HTMLElement): HTMLSelectElement =>
  root.querySelector('select[aria-label="Vertical exaggeration"]') as HTMLSelectElement

function drawLine(m: Mounted, a: [number, number] = [0.25, 0.5], b: [number, number] = [1.75, 0.5]): void {
  toolButton(m.root).click()
  clickAt(m.canvas, clientAtPlan(m.canvas, ...a))
  clickAt(m.canvas, clientAtPlan(m.canvas, ...b))
}

async function showSection(m: Mounted): Promise<void> {
  sectionToggle(m.root).click()
  await vi.waitFor(() => expect(sectionToggle(m.root).getAttribute('aria-pressed')).toBe('true'))
  await settle()
}

async function shownSection(): Promise<{ m: Mounted; section: LayerDouble }> {
  const m = await mounted()
  drawLine(m)
  await showSection(m)
  return { m, section: await sectionLayer() }
}

function lastMatrix(layer: LayerDouble): Float32Array {
  return layer.setMatrix.mock.calls.at(-1)?.[0] as Float32Array
}

// The exaggeration a matrix draws: its vertical clip scale over its horizontal one, in pixels.
function veOf(matrix: Float32Array, canvas: HTMLCanvasElement): number {
  return (matrix[4] * canvas.height) / (matrix[0] * canvas.width)
}

function choose(m: Mounted, value: string): void {
  const select = veSelect(m.root)
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function expectedMatrix(canvas: HTMLCanvasElement, mode: VeMode): Float32Array {
  const camera = new SectionCamera(canvas.width, canvas.height)
  camera.setInset(axesInset(1))
  camera.setVe(mode)
  camera.fit(SECTION_BOUNDS)
  return camera.matrix(SECTION_REF)
}

function expectMatrixClose(actual: Float32Array, expected: Float32Array): void {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i], 5)
}

function key(canvas: HTMLCanvasElement, name: string): void {
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
}

function prepare(): void {
  document.body.innerHTML = ''
  document.head.textContent = ''
  recording.calls.length = 0
  stubOverlayContext()
}

function cleanUp(): void {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
}

describe('the vertical exaggeration control', () => {
  beforeEach(prepare)
  afterEach(cleanUp)

  it('offers fitted, 1×, 2×, 5×, 10×, 20×, 50× and 100× while the section shows, starting at fitted, and hides on the plan', async () => {
    loadRealStylesheet()
    const m = await mounted()
    drawLine(m)
    const select = veSelect(m.root)
    expect(select).not.toBeNull()
    const row = select.closest('.section-ve-row') as HTMLElement
    expect(row.hidden).toBe(true)
    expect(getComputedStyle(row).display).toBe('none')

    await showSection(m)
    expect(row.hidden).toBe(false)
    expect(getComputedStyle(row).display).not.toBe('none')
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['fitted', '1×', '2×', '5×', '10×', '20×', '50×', '100×'])
    expect(select.value).toBe('fitted')

    planToggle(m.root).click()
    expect(row.hidden).toBe(true)
  })

  it('draws a chosen exaggeration and states it without "fitted", and brings the fitted line back', async () => {
    const { m, section } = await shownSection()
    expect(legendText(m.root)).toContain('vertical exaggeration 0.21× (fitted)')
    const draws = section.draw.mock.calls.length

    choose(m, '10')
    expect(veOf(lastMatrix(section), m.canvas)).toBeCloseTo(10, 4)
    expect(section.draw.mock.calls.length).toBeGreaterThan(draws)
    expect(legendText(m.root)).toContain('vertical exaggeration 10×')
    expect(legendText(m.root)).not.toContain('(fitted)')

    choose(m, '1')
    expect(veOf(lastMatrix(section), m.canvas)).toBeCloseTo(1, 4)
    expect(legendText(m.root)).toContain('vertical exaggeration 1×')

    choose(m, 'fitted')
    expect(legendText(m.root)).toContain('vertical exaggeration 0.21× (fitted)')
    expectMatrixClose(lastMatrix(section), expectedMatrix(m.canvas, 'fitted'))
  })

  it('keeps the exaggeration through a zoom', async () => {
    const { m, section } = await shownSection()
    choose(m, '20')
    m.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, deltaMode: 0, clientX: 300, clientY: 100, cancelable: true }))
    expect(veOf(lastMatrix(section), m.canvas)).toBeCloseTo(20, 4)
    expect(legendText(m.root)).toContain('vertical exaggeration 20×')
  })
})

describe('Home and the fit button on the section', () => {
  beforeEach(prepare)
  afterEach(cleanUp)

  it('refit the section at the chosen exaggeration and leave the plan camera alone', async () => {
    const { m, section } = await shownSection()
    const planCalls = m.layer.setMatrix.mock.calls.length
    const planMatrix = Array.from(lastMatrix(m.layer))
    choose(m, '10')

    m.canvas.dispatchEvent(pointer('pointerdown', [400, 240]))
    m.canvas.dispatchEvent(pointer('pointermove', [470, 200]))
    m.canvas.dispatchEvent(pointer('pointerup', [470, 200]))
    m.canvas.focus()
    key(m.canvas, 'Home')
    expectMatrixClose(lastMatrix(section), expectedMatrix(m.canvas, 10))

    key(m.canvas, '+')
    buttonByText(m.root, 'Fit to extent').click()
    expectMatrixClose(lastMatrix(section), expectedMatrix(m.canvas, 10))
    expect(legendText(m.root)).toContain('vertical exaggeration 10×')

    expect(m.layer.setMatrix.mock.calls.length).toBe(planCalls)
    planToggle(m.root).click()
    expect(Array.from(lastMatrix(m.layer))).toEqual(planMatrix)
  })
})

describe('the exaggeration choice lasts while the page is open', () => {
  beforeEach(prepare)
  afterEach(cleanUp)

  it('is kept across Plan view and a new line, and is never written to the view state', async () => {
    const { m } = await shownSection()
    choose(m, '5')
    planToggle(m.root).click()
    await showSection(m)
    expect(veSelect(m.root).value).toBe('5')
    expect(veOf(lastMatrix(await sectionLayer()), m.canvas)).toBeCloseTo(5, 4)

    planToggle(m.root).click()
    drawLine(m, [0.25, 0.3], [1.75, 0.7])
    await showSection(m)
    expect(m.stub.section).toHaveLength(2)
    expect(veSelect(m.root).value).toBe('5')
    expect(veOf(lastMatrix(await sectionLayer()), m.canvas)).toBeCloseTo(5, 4)
    expect(legendText(m.root)).toContain('vertical exaggeration 5×')

    planToggle(m.root).click()
    const colormap = m.root.querySelector('select[aria-label="Colormap"]') as HTMLSelectElement
    colormap.value = 'magma'
    colormap.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(m.stub.puts.at(-1)?.colormap).toBe('magma'), { timeout: 3000 })
    for (const put of m.stub.puts) expect(Object.keys(put).sort()).toEqual(VIEW_KEYS)
  })
})

interface FrameHooks {
  planLayerChanged(layer: number): void
}

async function frameHooks(): Promise<FrameHooks> {
  const { createSectionView } = await import('../src/ui/section-view')
  return vi.mocked(createSectionView).mock.results[0].value as unknown as FrameHooks
}

// The dashed outlines the frame drew last: one per piece.
function lastBand(): number[][] {
  return recording.calls
    .filter((c) => c.method === 'strokeRect' && c.state.dash.length > 0)
    .slice(-3)
    .map((c) => c.args as number[])
}

function expectBandOver(canvas: HTMLCanvasElement, top: number, bottom: number): void {
  const camera = new SectionCamera(canvas.width, canvas.height)
  camera.setInset(axesInset(1))
  camera.fit(SECTION_BOUNDS)
  const pieces: Array<[number, number]> = [
    [0.5, 1.5],
    [1.5, 2.5],
    [3.0, 3.5],
  ]
  const band = lastBand()
  expect(band).toHaveLength(3)
  for (const [i, [s0, s1]] of pieces.entries()) {
    const [x0, y0] = camera.worldToScreen(s0, top)
    const [x1, y1] = camera.worldToScreen(s1, bottom)
    expect(band[i][0]).toBeCloseTo(x0, 4)
    expect(band[i][1]).toBeCloseTo(y0, 4)
    expect(band[i][2]).toBeCloseTo(x1 - x0, 4)
    expect(band[i][3]).toBeCloseTo(y1 - y0, 4)
  }
}

function texts(): unknown[] {
  return recording.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0])
}

// The x of the last time a text was painted.
function lastText(text: string): number {
  return recording.calls.filter((c) => c.method === 'fillText' && c.args[0] === text).at(-1)?.args[1] as number
}

describe('the frame over the section', () => {
  beforeEach(prepare)
  afterEach(cleanUp)

  it('shows its axes only while the section shows', async () => {
    const m = await mounted()
    drawLine(m)
    const overlay = m.root.querySelector('canvas.section-axes-overlay') as HTMLCanvasElement
    expect(overlay).not.toBeNull()
    expect(overlay.hidden).toBe(true)
    // The map canvas is still the first canvas in the map area.
    expect(m.root.querySelector('canvas')).toBe(m.canvas)

    await showSection(m)
    expect(overlay.hidden).toBe(false)
    expect(texts()).toContain('distance from A (model units)')
    expect(texts()).toContain('elevation (model units)')

    planToggle(m.root).click()
    expect(overlay.hidden).toBe(true)
  })

  it('outlines the plan layer in every piece and follows a layer change without recolouring the section', async () => {
    const { m, section } = await shownSection()
    expectBandOver(m.canvas, 10, 5)

    m.store.set({ layer: 1 }, 'other')
    await settle()
    expectBandOver(m.canvas, 5, 0)

    const hooks = await frameHooks()
    const values = section.setValues.mock.calls.length
    hooks.planLayerChanged(0)
    expectBandOver(m.canvas, 10, 5)
    expect(section.setValues.mock.calls.length).toBe(values)
    expect(m.stub.section).toHaveLength(1)
  })

  it('repaints the axes from the moved camera after a pan', async () => {
    const { m } = await shownSection()
    const aBefore = lastText('A')
    m.canvas.dispatchEvent(pointer('pointerdown', [400, 240]))
    m.canvas.dispatchEvent(pointer('pointermove', [440, 240]))
    m.canvas.dispatchEvent(pointer('pointerup', [440, 240]))
    expect(lastText('A') - aBefore).toBeCloseTo(40, 4)
  })
})
