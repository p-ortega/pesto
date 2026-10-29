// @vitest-environment jsdom
//
// The section on the map (SECT-01, SECT-02): two armed clicks on the plan set the line, the
// Section view asks for it once and draws the answer in place of the plan with its own camera,
// and a click on the section names the cell and layer. The real map screen against a stubbed
// fetch, with the GL context and the shared MeshLayer double mocked and a recording 2D overlay.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { Camera } from '../src/gl/camera'
import { SectionCamera } from '../src/gl/section-camera'
import { axesInset } from '../src/ui/section-axes'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'
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

// The real controller, with the hooks the map calls counted.
vi.mock('../src/ui/section-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/section-view')>()
  return {
    ...actual,
    createSectionView: vi.fn((opts: Parameters<typeof actual.createSectionView>[0]) => {
      const handle = actual.createSectionView(opts)
      handle.refresh = vi.fn(handle.refresh)
      handle.planLayerChanged = vi.fn(handle.planLayerChanged)
      return handle
    }),
  }
})

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'section-tracer-answer.json'), 'utf8'),
) as Record<string, unknown>

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

// Two unit cells side by side, two layers, drawn relative to an origin far from zero.
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

// Two observation sites on layer 0, for the legend case coloured by observations.
const HEADS = [
  { id: 101, name: 's101', x: 0.25, y: 0.5, layer: 0, cell: 0 },
  { id: 102, name: 's102', x: 1.75, y: 0.5, layer: 0, cell: 1 },
]

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function ipc(columns: Record<string, unknown[]>): Uint8Array {
  return Uint8Array.from(tableToIPC(tableFromArrays(columns), 'stream'))
}

function sitesTable(): Uint8Array {
  return ipc({
    site_id: HEADS.map((s) => s.id),
    site: HEADS.map((s) => s.name),
    n_obs: HEADS.map(() => 3),
    x: HEADS.map((s) => s.x),
    y: HEADS.map((s) => s.y),
    xy_source: HEADS.map(() => 'own'),
    layer: HEADS.map((s) => s.layer),
    cell: HEADS.map((s) => s.cell),
    rule: HEADS.map(() => 'own xy'),
    note: HEADS.map(() => null),
  })
}

function groupsTable(): Uint8Array {
  return ipc({
    group: ['heads'],
    n_obs: [6],
    n_sites: [HEADS.length],
    n_placed: [HEADS.length],
    n_weighted: [6],
    n_with_target: [6],
    n_zero_weight: [0],
    n_sentinel: [0],
    n_no_value: [0],
    time_kind: ['numeric'],
    inequality: ['none'],
    first_iteration: [0],
    last_iteration: [1],
    rmse_first: [1],
    rmse_last: [0.5],
    n_resid_first: [6],
    n_resid_last: [6],
  })
}

function timesBody(group: string): Record<string, unknown> {
  return {
    group,
    order_digest: 'digest-a',
    time_kind: 'numeric',
    steps_by: 'time',
    times: [10, 20],
    n_at_time: [2, 2],
    n_sites: HEADS.length,
    iterations: [{ iteration: 0, available: true, reason: null }],
    limits: { resid_mean: [-1, 1], rmse: [0, 2], std: [0, 1], mean: [9, 11] },
    limits_rule: 'pooled over the first and last iteration',
    limits_refused: null,
    refused: null,
    notes: [],
  }
}

interface Stub {
  section: URLSearchParams[]
  calls: string[]
}

function stubEnvironment(): Stub {
  const stub: Stub = { section: [], calls: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
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
      const group = query.get('group') ?? ''
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
          throw new Error('no saved view')
        case '/api/run/grid/section':
          stub.section.push(query)
          return respond({ status: 200, body: FIXTURE })
        case '/api/run/obs/groups':
          return respond({ status: 200, bytes: groupsTable() })
        case '/api/run/obs/sites':
          return respond({ status: 200, bytes: sitesTable(), headers: { 'X-Pesto-Meta': JSON.stringify({ order_digest: 'digest-a' }) } })
        case '/api/run/obs/times':
          return respond({ status: 200, body: timesBody(group) })
        case '/api/run/obs/frame': {
          const time = Number(query.get('time'))
          const stat = query.get('stat') ?? 'resid_mean'
          return respond({
            status: 200,
            bytes: bytesOf(new Float32Array([0.1, -0.1])),
            headers: {
              'X-Pesto-Meta': JSON.stringify({
                dtype: '<f4',
                group,
                order_digest: 'digest-a',
                iteration: 0,
                time,
                stat,
                n_sites: HEADS.length,
                n_at_time: HEADS.length,
                n_rows_hidden: 0,
                n_finite: HEADS.length,
              }),
            },
          })
        }
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
  return stub
}

// Delivers each batch on a microtask, as the map's own writes need to be heard.
function autoStore(): SelectionStore {
  return createSelectionStore({ initial: emptySelection('test_run', 0), schedule: (run) => queueMicrotask(run) })
}

type Mocked = ReturnType<typeof vi.fn>

interface LayerDouble {
  setMatrix: Mocked
  setValues: Mocked
  setInactive: Mocked
  setFootprint: Mocked
  setFootprintColor: Mocked
  setHairlineColor: Mocked
  reupload: Mocked
  setPoints: Mocked
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
  return (await meshLayerMock()).mock.instances[1] as unknown as LayerDouble
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

// Every ResizeObserver the map makes, so a test can say the map box changed size.
const observers: { callback: ResizeObserverCallback; target: Element | null }[] = []

function stubResizeObserver(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private entry: { callback: ResizeObserverCallback; target: Element | null }
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, target: null }
        observers.push(this.entry)
      }
      observe(target: Element): void {
        this.entry.target = target
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  )
}

async function mounted(): Promise<Mounted> {
  stubResizeObserver()
  const stub = stubEnvironment()
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    }),
  )
  const store = autoStore()
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

function planCamera(canvas: HTMLCanvasElement): Camera {
  const camera = new Camera(canvas.width, canvas.height)
  camera.fit(BOUNDS)
  return camera
}

// Plan world to client pixels, through a camera fitted the way the map fits the mesh.
function clientAtPlan(canvas: HTMLCanvasElement, wx: number, wy: number): [number, number] {
  const camera = planCamera(canvas)
  const [x0, y0] = camera.screenToWorld(0, 0)
  const [x1, y1] = camera.screenToWorld(1, 1)
  return [(wx - x0) / (x1 - x0), (wy - y0) / (y1 - y0)]
}

// The world point the map reads at a client point: the plan point plus the mesh origin.
function worldAtClient(canvas: HTMLCanvasElement, [cx, cy]: [number, number]): [number, number] {
  const [wx, wy] = planCamera(canvas).screenToWorld((cx / canvas.width) * canvas.width, (cy / canvas.height) * canvas.height)
  return [wx + ORIGIN[0], wy + ORIGIN[1]]
}

// Section distance and elevation to client pixels, through a camera fitted as the section fits,
// clear of the axes.
function clientAtSection(canvas: HTMLCanvasElement, s: number, z: number): [number, number] {
  const camera = new SectionCamera(canvas.width, canvas.height)
  camera.setInset(axesInset(1))
  camera.fit([0, 3.5, 0, 10])
  return camera.worldToScreen(s, z)
}

function pointer(type: string, [x, y]: [number, number]): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true, cancelable: true })
}

// A press and release in one spot, then the click a browser fires after it.
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
const readoutText = (root: HTMLElement): string => root.querySelector('.floating-bottom-right')?.textContent ?? ''

const A_PLAN: [number, number] = [0.25, 0.5]
const B_PLAN: [number, number] = [1.75, 0.5]

function drawLine(m: Mounted): { a: [number, number]; b: [number, number] } {
  const a = clientAtPlan(m.canvas, ...A_PLAN)
  const b = clientAtPlan(m.canvas, ...B_PLAN)
  toolButton(m.root).click()
  clickAt(m.canvas, a)
  clickAt(m.canvas, b)
  return { a, b }
}

async function showSection(m: Mounted): Promise<void> {
  sectionToggle(m.root).click()
  await vi.waitFor(() => expect(sectionToggle(m.root).getAttribute('aria-pressed')).toBe('true'))
  await settle()
}

describe('the section tracer on the map', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
    stubOverlayContext()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('keeps Section view disabled with its reason until a line is drawn', async () => {
    const m = await mounted()
    expect(sectionToggle(m.root).disabled).toBe(true)
    expect(m.root.querySelector('.section-controls')?.textContent).toContain('draw a section line on the plan first')
    expect(toolButton(m.root).textContent).toBe('Draw section line')
  })

  it('sets the line from two armed clicks without picking a cell or moving the plan, then enables Section view', async () => {
    const m = await mounted()
    const matrixCalls = m.layer.setMatrix.mock.calls.length
    const lastMatrix = m.layer.setMatrix.mock.calls.at(-1)?.[0]
    drawLine(m)
    await settle()

    expect(m.store.get().cells.size).toBe(0)
    expect(m.stub.calls).not.toContain('/api/run/link/cell')
    expect(m.layer.setMatrix.mock.calls.length).toBe(matrixCalls)
    expect(m.layer.setMatrix.mock.calls.at(-1)?.[0]).toEqual(lastMatrix)
    expect(toolButton(m.root).getAttribute('aria-pressed')).toBe('false')
    expect(sectionToggle(m.root).disabled).toBe(false)
    // The line and both labels are drawn over the plan.
    const texts = recording.calls.filter((c) => c.method === 'fillText').map((c) => c.args[0])
    expect(texts).toEqual(expect.arrayContaining(['A', 'B']))
    // Nothing is asked for until the section is shown (D-26).
    expect(m.stub.section).toHaveLength(0)
  })

  it('asks for the section once when shown, with the clicked world points written as String(number)', async () => {
    const m = await mounted()
    const { a, b } = drawLine(m)
    await showSection(m)

    expect(m.stub.section).toHaveLength(1)
    const query = m.stub.section[0]
    const wa = worldAtClient(m.canvas, a)
    const wb = worldAtClient(m.canvas, b)
    expect(query.get('ax')).toBe(String(wa[0]))
    expect(query.get('ay')).toBe(String(wa[1]))
    expect(query.get('bx')).toBe(String(wb[0]))
    expect(query.get('by')).toBe(String(wb[1]))
  })

  it('draws the answer as six quads on a second MeshLayer, absence outlined, in place of the plan', async () => {
    const m = await mounted()
    drawLine(m)
    const planDraws = m.layer.draw.mock.calls.length
    await showSection(m)

    const MeshLayer = await meshLayerMock()
    expect(MeshLayer.mock.calls).toHaveLength(2)
    expect((MeshLayer.mock.calls[1][1] as { nCells: number }).nCells).toBe(6)
    const section = await sectionLayer()
    // Cell 2 is not in this plan's two-cell mesh, so its quads are drawn as absence, not as no value.
    expect(Array.from(section.setInactive.mock.calls.at(-1)?.[0] as Uint8Array)).toEqual([0, 0, 0, 1, 1, 1])
    expect(Array.from(section.setFootprint.mock.calls.at(-1)?.[0] as Uint8Array)).toEqual([0, 0, 0, 0, 0, 0])
    // The section gets the theme colours the plan layer gets.
    expect(section.setFootprintColor).toHaveBeenCalled()
    expect(section.setHairlineColor).toHaveBeenCalled()
    expect(section.draw.mock.calls.length).toBeGreaterThan(0)
    expect(m.layer.draw.mock.calls.length).toBe(planDraws)
  })

  it('states the fitted vertical exaggeration in the legend', async () => {
    const m = await mounted()
    drawLine(m)
    await showSection(m)
    expect(legendText(m.root)).toContain('vertical exaggeration')
    expect(legendText(m.root)).toContain('× (fitted)')
    // The plan layer line sits right after the exaggeration line.
    expect(legendText(m.root)).toContain('× (fitted)plan layer 1 (index 0)')
  })

  it('names the layer and cell under a click on the section, and absence by its status text', async () => {
    const m = await mounted()
    drawLine(m)
    await showSection(m)

    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 7.5))
    expect(readoutText(m.root)).toContain('layer 1 (index 0), cell 0')
    expect(readoutText(m.root)).toContain('distance from A: 1 model units')
    expect(readoutText(m.root)).not.toContain('inactive')

    clickAt(m.canvas, clientAtSection(m.canvas, 2.0, 2.5))
    expect(readoutText(m.root)).toContain('layer 2 (index 1), cell 1')
    expect(readoutText(m.root)).toContain('inactive (idomain 0)')
    expect(readoutText(m.root)).toContain('top 5, bottom 0 model units')
    // The active quad asks what its cell holds; the absent one asks nothing (map-section-click covers the rest).
    expect(m.stub.calls.filter((path) => path === '/api/run/link/cell')).toHaveLength(1)
  })

  it('shows the held answer again after Plan view, with no second request', async () => {
    const m = await mounted()
    drawLine(m)
    await showSection(m)
    planToggle(m.root).click()
    expect(sectionToggle(m.root).getAttribute('aria-pressed')).toBe('false')
    sectionToggle(m.root).click()
    await settle()
    expect(sectionToggle(m.root).getAttribute('aria-pressed')).toBe('true')
    expect(m.stub.section).toHaveLength(1)
  })
})

interface SectionHooks {
  refresh: Mocked
  planLayerChanged: Mocked & ((layer: number) => void)
}

async function sectionHooks(): Promise<SectionHooks> {
  const { createSectionView } = await import('../src/ui/section-view')
  return vi.mocked(createSectionView).mock.results[0].value as unknown as SectionHooks
}

function lastMatrix(layer: LayerDouble): Float32Array {
  return layer.setMatrix.mock.calls.at(-1)?.[0] as Float32Array
}

function key(canvas: HTMLCanvasElement, name: string): void {
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
}

async function shownSection(): Promise<{ m: Mounted; section: LayerDouble }> {
  const m = await mounted()
  drawLine(m)
  await showSection(m)
  return { m, section: await sectionLayer() }
}

describe('the section behaves like the map it replaces', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.head.textContent = ''
    recording.calls.length = 0
    observers.length = 0
    stubOverlayContext()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('pans, zooms and fits the section camera, never the plan one, and the plan comes back as it was', async () => {
    const m = await mounted()
    drawLine(m)
    const planMatrix = lastMatrix(m.layer)
    const planMatrixCalls = m.layer.setMatrix.mock.calls.length
    await showSection(m)
    const section = await sectionLayer()
    const fitted = Float32Array.from(lastMatrix(section))

    // A drag of 50 pixels moves the section 2 * 50 / 800 in clip space.
    m.canvas.dispatchEvent(pointer('pointerdown', [400, 240]))
    m.canvas.dispatchEvent(pointer('pointermove', [450, 240]))
    m.canvas.dispatchEvent(pointer('pointerup', [450, 240]))
    expect(lastMatrix(section)[6] - fitted[6]).toBeCloseTo(0.125, 5)

    const beforeWheel = lastMatrix(section)[0]
    m.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, deltaMode: 0, clientX: 400, clientY: 240, cancelable: true }))
    expect(lastMatrix(section)[0] / beforeWheel).toBeCloseTo(1.1, 5)

    m.canvas.focus()
    const beforeKeys = Float32Array.from(lastMatrix(section))
    key(m.canvas, 'ArrowLeft')
    expect(lastMatrix(section)[6] - beforeKeys[6]).toBeCloseTo(0.1, 5)
    key(m.canvas, '+')
    expect(lastMatrix(section)[0] / beforeKeys[0]).toBeCloseTo(1.1, 5)
    key(m.canvas, '-')
    expect(lastMatrix(section)[0] / beforeKeys[0]).toBeCloseTo(1, 5)

    key(m.canvas, 'Home')
    expect(Array.from(lastMatrix(section))).toEqual(Array.from(fitted))
    key(m.canvas, 'ArrowUp')
    expect(Array.from(lastMatrix(section))).not.toEqual(Array.from(fitted))
    buttonByText(m.root, 'Fit to extent').click()
    expect(Array.from(lastMatrix(section))).toEqual(Array.from(fitted))

    expect(m.layer.setMatrix.mock.calls.length).toBe(planMatrixCalls)
    const planDraws = m.layer.draw.mock.calls.length
    planToggle(m.root).click()
    expect(lastMatrix(m.layer)).toEqual(planMatrix)
    expect(m.layer.draw.mock.calls.length).toBeGreaterThan(planDraws)
    // Back on the plan, a drag moves the plan again.
    m.canvas.dispatchEvent(pointer('pointerdown', [400, 240]))
    m.canvas.dispatchEvent(pointer('pointermove', [450, 240]))
    m.canvas.dispatchEvent(pointer('pointerup', [450, 240]))
    expect(m.layer.setMatrix.mock.calls.length).toBeGreaterThan(planMatrixCalls)
  })

  it('resizes the section camera with the canvas and keeps the view centre', async () => {
    const { m, section } = await shownSection()
    const before = Float32Array.from(lastMatrix(section))
    const area = m.root.querySelector('.map-area') as HTMLElement
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 }) as DOMRect
    for (const o of observers) if (o.target === area) o.callback([], {} as ResizeObserver)

    expect(m.canvas.width).toBe(1000)
    const after = lastMatrix(section)
    // The scales are untouched, so they span less clip space on a larger canvas.
    expect(after[0] / before[0]).toBeCloseTo(0.8, 5)
    expect(after[4] / before[4]).toBeCloseTo(0.8, 5)
    // The world point at the middle of the canvas, relative to the reference, stays in the middle.
    expect(-after[6] / after[0]).toBeCloseTo(-before[6] / before[0], 5)
    expect(-after[7] / after[4]).toBeCloseTo(-before[7] / before[4], 5)
  })

  it('re-uploads the section from held copies on a restored context, with the theme colours and no request', async () => {
    const { m, section } = await shownSection()
    const { createContext } = await import('../src/gl/context')
    const ctx = vi.mocked(createContext).mock.results[0].value as { onRestored: Mocked }
    const restored = ctx.onRestored.mock.calls[0][0] as () => void
    const calls = m.stub.calls.length
    const colours = section.setFootprintColor.mock.calls.length
    const draws = section.draw.mock.calls.length

    restored()

    expect(section.reupload).toHaveBeenCalledTimes(1)
    expect(section.setFootprintColor.mock.calls.length).toBe(colours + 1)
    expect(section.draw.mock.calls.length).toBeGreaterThan(draws)
    expect(m.stub.calls.length).toBe(calls)
    expect(m.stub.section).toHaveLength(1)
  })

  it('refreshes the section on a colormap change, with no new request', async () => {
    const { m, section } = await shownSection()
    const hooks = await sectionHooks()
    const refreshes = hooks.refresh.mock.calls.length
    const values = section.setValues.mock.calls.length
    const select = m.root.querySelector('select[aria-label="Colormap"]') as HTMLSelectElement
    select.value = 'magma'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()

    expect(hooks.refresh.mock.calls.length).toBeGreaterThan(refreshes)
    expect(section.setValues.mock.calls.length).toBeGreaterThan(values)
    expect(m.stub.section).toHaveLength(1)
  })

  it('tells the section about a plan layer change, with no new request, and names the new plan layer in the legend', async () => {
    const { m } = await shownSection()
    const hooks = await sectionHooks()
    m.store.set({ layer: 1 }, 'other')
    await settle()

    expect(hooks.planLayerChanged).toHaveBeenLastCalledWith(1)
    expect(m.stub.section).toHaveLength(1)
    expect(legendText(m.root)).toContain('plan layer 2 (index 1)')

    hooks.planLayerChanged(3)
    expect(legendText(m.root)).toContain('plan layer 4 (index 3)')
    expect(legendText(m.root)).not.toContain('plan layer 2 (index 1)')
  })

  it('shows only the section lines while coloured by observations, and the observation legend again on the plan', async () => {
    const m = await mounted()
    m.store.set({ colour: { source: 'obs', stat: 'resid_mean' } }, 'other')
    await vi.waitFor(() => {
      const call = m.layer.setPoints.mock.calls.at(-1) as [Float32Array, Float32Array] | undefined
      expect(call?.[1].length).toBe(2)
    })
    await settle()
    const obsLegend = legendText(m.root)
    expect(obsLegend).toContain('heads')

    drawLine(m)
    await showSection(m)
    expect(legendText(m.root)).toContain('vertical exaggeration')
    expect(legendText(m.root)).not.toContain('heads')

    planToggle(m.root).click()
    expect(legendText(m.root)).toBe(obsLegend)
  })

  it('marks the map area while the section shows, and hides the plan outlines only then', async () => {
    loadRealStylesheet()
    const m = await mounted()
    drawLine(m)
    const area = m.root.querySelector('.map-area') as HTMLElement
    const lassoOverlay = area.querySelector('.lasso-overlay') as HTMLElement
    const lineOverlay = area.querySelector('.section-line-overlay') as HTMLElement
    expect(getComputedStyle(lineOverlay).display).not.toBe('none')

    await showSection(m)
    expect(area.classList.contains('showing-section')).toBe(true)
    expect(getComputedStyle(lassoOverlay).display).toBe('none')
    expect(getComputedStyle(lineOverlay).display).toBe('none')
    // The tool waits on the plan while the section shows.
    expect(toolButton(m.root).disabled).toBe(true)

    planToggle(m.root).click()
    expect(area.classList.contains('showing-section')).toBe(false)
    expect(getComputedStyle(lassoOverlay).display).not.toBe('none')
    expect(getComputedStyle(lineOverlay).display).not.toBe('none')
    expect(toolButton(m.root).disabled).toBe(false)
  })
})
