// @vitest-environment jsdom
//
// The section line and toggle on the map (SECT-01): why a run offers no section (D-06, D-12 to
// D-14, D-32), a refused line said in words with nothing built (D-05), the plan coming back as it
// was and nothing saved (D-04, D-07), and the plan-only tools stepping aside while the section
// shows (D-01, D-22). The real map screen against a stubbed fetch, as in map-section.test.ts.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capability, IngestState } from '../src/data/client'
import { Camera } from '../src/gl/camera'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'
import { createRecording2d, type RecordedCall } from './support/recording-2d'

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

const PREDATES = 'this cache predates the section view; it is added on the next ingest'
const NO_BOTTOMS = 'the grid file records no layer bottoms'
const UNREPORTED = 'the server did not report whether this run can have a section'
const NO_LINE = 'draw a section line on the plan first'
const CROSSES_NONE = 'the line crosses no model cell'
const SERVER_DOWN = 'the server is restarting'
const PLAN_ONLY = 'overlays are drawn on the plan only'
const TOOLS_ON_PLAN = 'switch to the plan view to draw on the plan'
const LASSO_NO_DOTS = 'no observation site dots are drawn; colour the map by observations'

// null leaves the section capability out of the state, as an older server would.
function baseState(section: Capability | null = { available: true, blockedBy: [] }): IngestState {
  const capabilities: IngestState['capabilities'] = {
    map: { available: true, blockedBy: [] },
    stats: { available: true, blockedBy: [] },
    chips: { available: true, blockedBy: [] },
    obs: { available: true, blockedBy: [] },
  }
  if (section !== null) capabilities.section = section
  return { fresh: true, artifacts: [], capabilities, ingestSeconds: null, cacheBytes: null }
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

// One parameter of the drawn group at its bounds, and two sites in conflict, so both toggles show counts.
function atBoundsBody(iteration: number, group: string | null): Record<string, unknown> {
  return {
    available: true,
    reason: null,
    artifact: 'par_change',
    iteration,
    first_iteration: 0,
    last_iteration: 1,
    rule: 'a parameter is at bounds when it has at least 10% of realizations near a bound',
    caveat: 'counts from the float32 cache can be one high',
    groups: group === null ? [] : [{ group, n_par: 4, n_counted: 4, n_at_bounds: 1, n_excluded: {} }],
    names: group === null ? null : ['p1'],
  }
}

function pdcBody(iteration: number): Record<string, unknown> {
  return {
    available: true,
    reason: null,
    artifact: `pdc/${iteration}`,
    iteration,
    source: 'file',
    source_file: 'case.0.pdc.csv',
    weights_source: 'control file',
    rule: 'pestpp-ies prior-data conflict',
    n_obs: 3,
    n_sites: 2,
    n_unmatched: 0,
    n_left_out: 0,
    by_group: [{ group: 'heads', n_obs: 3, n_sites: 2 }],
    sites: { id: [101, 102], cell: [0, 1], layer: [0, 0], group_index: [0, 0], n_obs: [2, 1] },
    groups: ['heads'],
    notes: [],
  }
}

interface Options {
  state?: IngestState
  /** The section answer: the fixture, or a 422 with this title. */
  refuse?: string | null
  /** The saved view the map reads, or null for none. */
  saved?: Record<string, unknown> | null
}

interface Stub {
  section: URLSearchParams[]
  calls: string[]
  puts: Record<string, unknown>[]
  refuse: string | null
  /** A one-off failure of the section request: a server error, or no answer at all. */
  failure: 'server' | 'network' | null
}

function stubEnvironment(options: Options): Stub {
  const stub: Stub = { section: [], calls: [], puts: [], refuse: options.refuse ?? null, failure: null }
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
      const group = query.get('group') ?? ''
      const iteration = Number(query.get('iteration') ?? '0')
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
          if (options.saved == null) throw new Error('no saved view')
          return respond({ status: 200, body: options.saved })
        case '/api/run/grid/section':
          stub.section.push(query)
          if (stub.failure === 'server') return respond({ status: 503, body: { title: SERVER_DOWN, status: 503 } })
          if (stub.failure === 'network') throw new TypeError('Failed to fetch')
          if (stub.refuse !== null) return respond({ status: 422, body: { title: stub.refuse, status: 422 } })
          return respond({ status: 200, body: FIXTURE })
        case '/api/run/par/at_bounds':
          return respond({ status: 200, body: atBoundsBody(iteration, query.get('group')) })
        case '/api/run/obs/pdc':
          return respond({ status: 200, body: pdcBody(iteration) })
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

function autoStore(): SelectionStore {
  return createSelectionStore({ initial: emptySelection('test_run', 0), schedule: (run) => queueMicrotask(run) })
}

type Mocked = ReturnType<typeof vi.fn>

interface LayerDouble {
  setMatrix: Mocked
  setHatch: Mocked
  setPoints: Mocked
  draw: Mocked
}

async function meshLayerMock() {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer)
}

const recording = createRecording2d()

function stubOverlayContext(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === '2d' ? recording.ctx : null) as typeof HTMLCanvasElement.prototype.getContext)
}

function stubResizeObserver(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
}

interface Mounted {
  root: HTMLElement
  canvas: HTMLCanvasElement
  stub: Stub
  store: SelectionStore
  layer: LayerDouble
}

async function mounted(options: Options = {}): Promise<Mounted> {
  stubResizeObserver()
  const stub = stubEnvironment(options)
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
  mountMap(root, { config: CONFIG, state: options.state ?? baseState(), store })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  const canvas = root.querySelector('canvas') as HTMLCanvasElement
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
  const MeshLayer = await meshLayerMock()
  const layer = MeshLayer.mock.instances.at(-1) as unknown as LayerDouble
  return { root, canvas, stub, store, layer }
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
const toolCard = (root: HTMLElement): string => root.querySelector('.section-tool')?.textContent ?? ''
const lassoButton = (root: HTMLElement): HTMLButtonElement => root.querySelector('.lasso-button') as HTMLButtonElement
const lassoCard = (root: HTMLElement): string => root.querySelector('.lasso-control')?.textContent ?? ''
const sectionToggle = (root: HTMLElement): HTMLButtonElement => buttonByText(root, 'Section view')
const planToggle = (root: HTMLElement): HTMLButtonElement => buttonByText(root, 'Plan view')
const controlsCard = (root: HTMLElement): string => root.querySelector('.section-controls')?.textContent ?? ''

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

function cleanUp(): void {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
}

function prepare(): void {
  document.body.innerHTML = ''
  recording.calls.length = 0
  stubOverlayContext()
}

describe('why the map offers no section', () => {
  beforeEach(prepare)
  afterEach(cleanUp)

  for (const reason of [PREDATES, NO_BOTTOMS]) {
    it(`disables the tool and Section view with the run's reason: ${reason}`, async () => {
      const m = await mounted({ state: baseState({ available: false, blockedBy: [{ artifact: 'elev', reason }] }) })
      expect(toolButton(m.root).disabled).toBe(true)
      expect(toolCard(m.root)).toContain(reason)
      expect(sectionToggle(m.root).disabled).toBe(true)
      expect(controlsCard(m.root)).toContain(reason)
      // A run reason wins over the no-line one.
      expect(controlsCard(m.root)).not.toContain(NO_LINE)
      toolButton(m.root).click()
      expect(toolButton(m.root).getAttribute('aria-pressed')).toBe('false')
    })
  }

  it('refuses to guess when the server did not say whether the run can have a section', async () => {
    const m = await mounted({ state: baseState(null) })
    expect(toolButton(m.root).disabled).toBe(true)
    expect(toolCard(m.root)).toContain(UNREPORTED)
    expect(sectionToggle(m.root).disabled).toBe(true)
    expect(controlsCard(m.root)).toContain(UNREPORTED)
  })

  it('asks for a line first when the run can have a section', async () => {
    const m = await mounted()
    expect(toolButton(m.root).disabled).toBe(false)
    expect(sectionToggle(m.root).disabled).toBe(true)
    expect(controlsCard(m.root)).toContain(NO_LINE)
  })

  it('says why the server refused a line, keeps the plan and builds no section; a new line clears it', async () => {
    const m = await mounted({ refuse: CROSSES_NONE })
    drawLine(m)
    const planDraws = m.layer.draw.mock.calls.length
    sectionToggle(m.root).click()
    await vi.waitFor(() => expect(controlsCard(m.root)).toContain(CROSSES_NONE))
    await settle()

    expect(m.stub.section).toHaveLength(1)
    expect(sectionToggle(m.root).disabled).toBe(true)
    expect(sectionToggle(m.root).getAttribute('aria-pressed')).toBe('false')
    expect(planToggle(m.root).getAttribute('aria-pressed')).toBe('true')
    expect((await meshLayerMock()).mock.calls).toHaveLength(1)
    expect(m.root.querySelector('.map-area')?.classList.contains('showing-section')).toBe(false)
    expect(m.layer.draw.mock.calls.length).toBeGreaterThanOrEqual(planDraws)

    m.stub.refuse = null
    drawLine(m, [0.5, 0.25], [1.5, 0.75])
    expect(controlsCard(m.root)).not.toContain(CROSSES_NONE)
    expect(sectionToggle(m.root).disabled).toBe(false)
    await showSection(m)
    expect((await meshLayerMock()).mock.calls).toHaveLength(2)
  })

  it('says why the section layer could not be built instead of failing in silence, and builds it on the next click', async () => {
    const m = await mounted()
    drawLine(m)
    const MeshLayer = await meshLayerMock()
    const real = MeshLayer.getMockImplementation()!
    MeshLayer.mockImplementationOnce(() => {
      throw new Error('the graphics context could not create a shader')
    })
    sectionToggle(m.root).click()
    await vi.waitFor(() => expect(controlsCard(m.root)).toContain('the graphics context could not create a shader'))
    await settle()
    expect(sectionToggle(m.root).getAttribute('aria-pressed')).toBe('false')
    expect(sectionToggle(m.root).disabled).toBe(false)

    MeshLayer.mockImplementation(real)
    await showSection(m)
    expect(m.stub.section).toHaveLength(1)
    expect(controlsCard(m.root)).not.toContain('could not create a shader')
  })

  it('says why a one-off failure stopped the section and tries the same line again on the next click', async () => {
    const m = await mounted()
    m.stub.failure = 'server'
    drawLine(m)
    sectionToggle(m.root).click()
    await vi.waitFor(() => expect(controlsCard(m.root)).toContain(SERVER_DOWN))
    await settle()
    expect(sectionToggle(m.root).disabled).toBe(false)
    expect(sectionToggle(m.root).getAttribute('aria-pressed')).toBe('false')

    m.stub.failure = 'network'
    sectionToggle(m.root).click()
    await vi.waitFor(() => expect(controlsCard(m.root)).toContain('the section could not be read: Failed to fetch'))
    await settle()
    expect(m.stub.section).toHaveLength(2)
    expect(sectionToggle(m.root).disabled).toBe(false)

    m.stub.failure = null
    await showSection(m)
    expect(m.stub.section).toHaveLength(3)
    expect(controlsCard(m.root)).not.toContain('could not be read')
    expect((await meshLayerMock()).mock.calls).toHaveLength(2)
  })
})

function lastMatrix(layer: LayerDouble): Float32Array {
  return layer.setMatrix.mock.calls.at(-1)?.[0] as Float32Array
}

// Where the line's A and B labels were last painted.
function lastLabels(calls: RecordedCall[]): { A: unknown[] | undefined; B: unknown[] | undefined } {
  const texts = calls.filter((c) => c.method === 'fillText')
  return { A: texts.filter((c) => c.args[0] === 'A').at(-1)?.args, B: texts.filter((c) => c.args[0] === 'B').at(-1)?.args }
}

const overlayToggle = (root: HTMLElement, kind: 'atBounds' | 'conflict'): HTMLButtonElement =>
  root.querySelector(`button[data-overlay="${kind}"]`) as HTMLButtonElement

async function colourByObservations(m: Mounted): Promise<void> {
  m.store.set({ colour: { source: 'obs', stat: 'resid_mean' } }, 'other')
  await vi.waitFor(() => {
    const call = m.layer.setPoints.mock.calls.at(-1) as [Float32Array, Float32Array] | undefined
    expect(call?.[1].length).toBe(2)
  })
  await settle()
  await vi.waitFor(() => expect(lassoButton(m.root).disabled).toBe(false))
}

// The keys the map and the shell write to the view state; nothing about the section is among them.
const VIEW_KEYS = ['classes', 'colormap', 'divider', 'group', 'layer', 'limits_mode', 'reverse', 'scale', 'stat', 'symmetric', 'tab', 'texture']

describe('the plan comes back as it was and nothing about the line is saved', () => {
  beforeEach(prepare)
  afterEach(cleanUp)

  it('returns the same camera, layer and line after Section view then Plan view', async () => {
    const m = await mounted()
    drawLine(m)
    const matrix = Float32Array.from(lastMatrix(m.layer))
    const labels = lastLabels(recording.calls)
    expect(labels.A).toBeDefined()
    expect(labels.B).toBeDefined()
    const shownFrom = recording.calls.length
    await showSection(m)
    const planDraws = m.layer.draw.mock.calls.length
    // The section's own axes letter A and B too; only the plan's line labels are compared.
    const shownTo = recording.calls.length

    planToggle(m.root).click()
    await settle()
    expect(Array.from(lastMatrix(m.layer))).toEqual(Array.from(matrix))
    const MeshLayer = await meshLayerMock()
    expect(MeshLayer.mock.instances[0]).toBe(m.layer)
    expect(MeshLayer.mock.calls).toHaveLength(2)
    expect(m.layer.draw.mock.calls.length).toBeGreaterThan(planDraws)
    expect(lastLabels([...recording.calls.slice(0, shownFrom), ...recording.calls.slice(shownTo)])).toEqual(labels)
  })

  it('writes no line or plan/section choice to the view state, and a reopened map starts on the plan with no line', async () => {
    const m = await mounted()
    drawLine(m)
    await showSection(m)
    planToggle(m.root).click()
    const select = m.root.querySelector('select[aria-label="Colormap"]') as HTMLSelectElement
    select.value = 'magma'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(m.stub.puts.at(-1)?.colormap).toBe('magma'), { timeout: 3000 })
    for (const put of m.stub.puts) expect(Object.keys(put).sort()).toEqual(VIEW_KEYS)
    const body = m.stub.puts.at(-1)!

    cleanUp()
    prepare()
    const again = await mounted({ saved: body })
    await settle()
    expect(again.stub.calls).toContain('/api/run/view')
    expect(planToggle(again.root).getAttribute('aria-pressed')).toBe('true')
    expect(sectionToggle(again.root).disabled).toBe(true)
    expect(controlsCard(again.root)).toContain(NO_LINE)
    expect(again.stub.section).toHaveLength(0)
    expect(recording.calls.filter((c) => c.method === 'fillText')).toHaveLength(0)
  })
})

describe('the plan-only tools step aside while the section shows', () => {
  beforeEach(prepare)
  afterEach(cleanUp)

  it('says the overlays are drawn on the plan only, keeping counts and choices, and puts them back on the plan', async () => {
    const m = await mounted()
    await vi.waitFor(() => {
      expect(overlayToggle(m.root, 'atBounds').disabled).toBe(false)
      expect(overlayToggle(m.root, 'conflict').disabled).toBe(false)
    })
    // The user turns one off; the choice must outlive the visit to the section.
    overlayToggle(m.root, 'atBounds').click()
    const before = { atBounds: overlayToggle(m.root, 'atBounds').textContent ?? '', conflict: overlayToggle(m.root, 'conflict').textContent ?? '' }
    expect(before.atBounds).toContain(':')
    drawLine(m)
    await showSection(m)

    for (const kind of ['atBounds', 'conflict'] as const) {
      const toggle = overlayToggle(m.root, kind)
      expect(toggle.textContent).toContain(before[kind])
      expect(toggle.textContent).toContain(PLAN_ONLY)
      expect(toggle.disabled).toBe(true)
    }

    planToggle(m.root).click()
    await settle()
    for (const kind of ['atBounds', 'conflict'] as const) {
      expect(overlayToggle(m.root, kind).textContent).toBe(before[kind])
      expect(overlayToggle(m.root, kind).disabled).toBe(false)
    }
    expect(overlayToggle(m.root, 'atBounds').getAttribute('aria-pressed')).toBe('false')
    expect(overlayToggle(m.root, 'conflict').getAttribute('aria-pressed')).toBe('true')
  })

  it('disables the line tool and the lasso with a reason while the section shows, and gives back what they had', async () => {
    const m = await mounted()
    await colourByObservations(m)
    drawLine(m)
    await showSection(m)

    expect(toolButton(m.root).disabled).toBe(true)
    expect(toolCard(m.root)).toContain(TOOLS_ON_PLAN)
    expect(lassoButton(m.root).disabled).toBe(true)
    expect(lassoCard(m.root)).toContain(TOOLS_ON_PLAN)

    planToggle(m.root).click()
    expect(toolButton(m.root).disabled).toBe(false)
    expect(toolCard(m.root)).not.toContain(TOOLS_ON_PLAN)
    expect(lassoButton(m.root).disabled).toBe(false)
    expect(lassoCard(m.root)).not.toContain(TOOLS_ON_PLAN)
  })

  it('puts the lasso back to its own reason when no site dots are drawn', async () => {
    const m = await mounted()
    drawLine(m)
    await showSection(m)
    expect(lassoCard(m.root)).toContain(TOOLS_ON_PLAN)
    planToggle(m.root).click()
    expect(lassoButton(m.root).disabled).toBe(true)
    expect(lassoCard(m.root)).toContain(LASSO_NO_DOTS)
  })

  it('keeps one tool armed: arming either disarms the other', async () => {
    const m = await mounted()
    await colourByObservations(m)
    lassoButton(m.root).click()
    expect(lassoButton(m.root).getAttribute('aria-pressed')).toBe('true')
    toolButton(m.root).click()
    expect(toolButton(m.root).getAttribute('aria-pressed')).toBe('true')
    expect(lassoButton(m.root).getAttribute('aria-pressed')).toBe('false')
    lassoButton(m.root).click()
    expect(lassoButton(m.root).getAttribute('aria-pressed')).toBe('true')
    expect(toolButton(m.root).getAttribute('aria-pressed')).toBe('false')
  })

  it('disarms an armed lasso when the section shows, so a drag pans the section', async () => {
    const m = await mounted()
    await colourByObservations(m)
    drawLine(m)
    lassoButton(m.root).click()
    expect(lassoButton(m.root).getAttribute('aria-pressed')).toBe('true')
    await showSection(m)
    expect(lassoButton(m.root).getAttribute('aria-pressed')).toBe('false')

    const section = (await meshLayerMock()).mock.instances[1] as unknown as LayerDouble
    const fitted = Float32Array.from(lastMatrix(section))
    m.canvas.dispatchEvent(pointer('pointerdown', [400, 240]))
    m.canvas.dispatchEvent(pointer('pointermove', [450, 240]))
    m.canvas.dispatchEvent(pointer('pointerup', [450, 240]))
    expect(lastMatrix(section)[6]).not.toBeCloseTo(fitted[6], 5)
  })
})
