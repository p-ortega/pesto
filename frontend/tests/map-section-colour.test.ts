// @vitest-environment jsdom
//
// The section is coloured with exactly what the plan draws (D-08 to D-11, D-26, D-34, D-37, D-38):
// the plan's colormap, limits and style object reach the section layer as given, a style change
// recolours it from values already held, and the legend says what the section could not colour.
// The real map screen against a stubbed fetch, with the GL context and the MeshLayer double mocked.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { Camera } from '../src/gl/camera'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'
import { createRecording2d } from './support/recording-2d'

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

// Three pieces on cells 0, 1 and 2, two layers; quad q is piece * 2 + layer, and quad 3 (cell 1,
// layer 1) is idomain 0.
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

function parEns(k: number): IngestState['artifacts'][number] {
  return { name: `par_ens/${k}`, kind: 'par_ens', state: 'ok', reason: null, stale: false, seconds: null, bytes: 0 }
}

function baseState(twoIterations = false): IngestState {
  return {
    fresh: true,
    artifacts: twoIterations ? [parEns(0), parEns(3)] : [],
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

const NO_IDOMAIN_NOTE =
  'the grid file records no idomain, so a cell counts as in the model when any parameter lands on it'

// Three unit cells side by side, two layers, drawn relative to an origin far from zero.
const ORIGIN: [number, number] = [1000, 2000]
const BOUNDS: [number, number, number, number] = [0, 3, 0, 1]
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1, 2, 0, 3, 0, 3, 1, 2, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11])

// Block rows: G1 sets both layers (and cell 1 layer 1, which the section's idomain calls
// inactive), D is placed by x/y and draws as dots. PP1 is a pilot-point group of layer 1 only.
const ROWS = [
  { parnme: 'p0', pargp: 'G1', cell: 0, layer: 0, value: 10, x: Number.NaN, y: Number.NaN },
  { parnme: 'p1', pargp: 'G1', cell: 1, layer: 0, value: 20, x: Number.NaN, y: Number.NaN },
  { parnme: 'p2', pargp: 'G1', cell: 0, layer: 1, value: 30, x: Number.NaN, y: Number.NaN },
  { parnme: 'p3', pargp: 'G1', cell: 1, layer: 1, value: 40, x: Number.NaN, y: Number.NaN },
  { parnme: 'p4', pargp: 'G1', cell: 2, layer: 1, value: 50, x: Number.NaN, y: Number.NaN },
  { parnme: 'd0', pargp: 'D', cell: 0, layer: 0, value: 1, x: 0.5, y: 0.5 },
  { parnme: 'd1', pargp: 'D', cell: 1, layer: 0, value: 2, x: 1.5, y: 0.5 },
]
const PAR_TABLE = tableToIPC(
  tableFromArrays({
    parnme: [...ROWS.map((r) => r.parnme), 'pp0'],
    pargp: [...ROWS.map((r) => r.pargp), 'PP1'],
    partrans: [...ROWS.map(() => 'none'), 'none'],
  }),
  'stream',
)
const PARMAP = Int32Array.from(ROWS, (_, i) => i)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')
// The pilot-point field, one value per cell.
const PP_FIELD = new Float32Array([7, 8, 9])

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

interface World {
  hasIdomain: boolean
  // Adds iteration 3, which holds only the dot group D, so G1 has nothing to draw there.
  twoIterations: boolean
  answer: Record<string, unknown>
  // When set, each section answer waits until the test releases it.
  holdSections: boolean
}

interface Stub {
  section: URLSearchParams[]
  held: Array<(body: Record<string, unknown>) => void>
}

function stubEnvironment(world: World): Stub {
  const stub: Stub = { section: [], held: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path, search] = url.split('?')
      const query = new URLSearchParams(search ?? '')
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
      // Iteration 3 keeps only rows 5 and 6, the dot group D.
      const onlyD = world.twoIterations && query.get('iteration') === '3'
      const kept = onlyD ? ROWS.slice(5) : ROWS
      switch (path) {
        case '/api/run/grid/mesh':
          return respond({
            status: 200,
            body: {
              n_vert: 12,
              n_tri: 6,
              n_cells: 3,
              nlay: 2,
              bounds: BOUNDS,
              origin: ORIGIN,
              crs: null,
              tag: 'section-colour',
              has_idomain: world.hasIdomain,
              notes: world.hasIdomain ? [] : [NO_IDOMAIN_NOTE],
            },
          })
        case '/api/run/grid/mesh/positions':
          return respond({ status: 200, bytes: bytesOf(POSITIONS), headers: metaHeader('<f4') })
        case '/api/run/grid/mesh/cell_index':
          return respond({ status: 200, bytes: bytesOf(CELL_INDEX), headers: metaHeader('<f4') })
        case '/api/run/grid/mesh/indices':
          return respond({ status: 200, bytes: bytesOf(INDICES), headers: metaHeader('<u4') })
        case '/api/run/grid/mesh/idomain':
          return respond({ status: 200, bytes: bytesOf(new Int32Array(6).fill(1)), headers: metaHeader('<i4') })
        case '/api/run/grid/parmap':
          return respond({ status: 200, bytes: bytesOf(onlyD ? Int32Array.from([5, 6]) : PARMAP) })
        case '/api/run/meta':
          return respond({ status: 200, bytes: PAR_TABLE })
        case '/api/run/grid/cells/cell':
          return respond({ status: 200, bytes: bytesOf(Int32Array.from(kept, (r) => r.cell)) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(Int32Array.from(kept, (r) => r.layer)) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 200, bytes: bytesOf(Float32Array.from(kept.flatMap((r) => [r.x, r.y]))) })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(Float32Array.from(kept, (r) => r.value)) })
        case '/api/run/grid/pp':
          return respond({
            status: 200,
            body: {
              groups: [{ group: 'PP1', layer: 1, n_pp: 1, log_space: false, format: 'text', notes: [] }],
              not_interpolable: [],
              notes: [],
            },
          })
        case '/api/run/grid/field':
          return respond({
            status: 200,
            bytes: bytesOf(PP_FIELD),
            headers: { 'X-Pesto-Meta': JSON.stringify({ order: 'cell', group: 'PP1', layer: 1, n_pp: 1 }) },
          })
        case '/api/run/view':
          throw new Error('no saved view')
        case '/api/run/grid/section':
          stub.section.push(query)
          if (world.holdSections) {
            return new Promise((resolve) => {
              stub.held.push((body) => resolve(respond({ status: 200, body })))
            })
          }
          return respond({ status: 200, body: world.answer })
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

type Mocked = ReturnType<typeof vi.fn>

interface LayerDouble {
  setValues: Mocked
  setLimits: Mocked
  setStyle: Mocked
  setColormap: Mocked
  setInactive: Mocked
  setFootprint: Mocked
  setContested: Mocked
}

async function meshLayerMock() {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer)
}

async function sectionLayer(): Promise<LayerDouble> {
  return (await meshLayerMock()).mock.instances[1] as unknown as LayerDouble
}

const recording = createRecording2d()

interface Mounted {
  root: HTMLElement
  canvas: HTMLCanvasElement
  stub: Stub
  store: SelectionStore
  plan: LayerDouble
}

async function mounted(extra: Partial<World> = {}): Promise<Mounted> {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
  const world: World = { hasIdomain: true, twoIterations: false, answer: FIXTURE, holdSections: false, ...extra }
  const stub = stubEnvironment(world)
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
  mountMap(root, { config: CONFIG, state: baseState(world.twoIterations), store })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  const canvas = root.querySelector('canvas') as HTMLCanvasElement
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
  const plan = (await meshLayerMock()).mock.instances[0] as unknown as LayerDouble
  return { root, canvas, stub, store, plan }
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

const sectionToggle = (root: HTMLElement): HTMLButtonElement => buttonByText(root, 'Section view')
const planToggle = (root: HTMLElement): HTMLButtonElement => buttonByText(root, 'Plan view')
const legendText = (root: HTMLElement): string => root.querySelector('.floating-bottom-left')?.textContent ?? ''

function drawLine(m: Mounted, ay = 0.5, by = 0.5): void {
  ;(m.root.querySelector('button[aria-label="Draw a section line"]') as HTMLButtonElement).click()
  clickAt(m.canvas, clientAtPlan(m.canvas, 0.25, ay))
  clickAt(m.canvas, clientAtPlan(m.canvas, 2.75, by))
}

async function showSection(m: Mounted): Promise<LayerDouble> {
  sectionToggle(m.root).click()
  await vi.waitFor(() => expect(sectionToggle(m.root).getAttribute('aria-pressed')).toBe('true'))
  await settle()
  return sectionLayer()
}

function select(root: HTMLElement, label: string, value: string): void {
  const el = root.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
  el.value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function check(root: HTMLElement, label: string, on: boolean): void {
  const box = root.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement
  box.checked = on
  box.dispatchEvent(new Event('change'))
}

function last(mock: Mocked): unknown[] {
  return mock.mock.calls.at(-1) as unknown[]
}

function lastValues(layer: LayerDouble): Array<number | null> {
  return Array.from(last(layer.setValues)[0] as Float32Array, (v) => (Number.isNaN(v) ? null : v))
}

describe('the section coloured with what the plan draws', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    recording.calls.length = 0
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
      type === '2d' ? recording.ctx : null) as typeof HTMLCanvasElement.prototype.getContext)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('takes the plan colormap, limits and style object as given, and the block group values on both layers', async () => {
    const m = await mounted()
    expect(legendText(m.root)).toContain('G1')
    drawLine(m)
    const section = await showSection(m)

    expect(last(section.setColormap)).toEqual(last(m.plan.setColormap))
    expect(last(section.setLimits)[0]).toEqual(last(m.plan.setLimits)[0])
    expect(last(section.setStyle)[0]).toBe(last(m.plan.setStyle)[0])
    expect(lastValues(section)).toEqual([10, 30, 20, null, null, 50])
    expect(Array.from(last(section.setFootprint)[0] as Uint8Array)).toEqual([0, 0, 0, 0, 1, 0])
    expect(Array.from(last(section.setInactive)[0] as Uint8Array)).toEqual([0, 0, 0, 1, 0, 0])
    // G1 sets every layer, so no layers line.
    expect(legendText(m.root)).not.toContain('other layers have no value')
  })

  it('takes the old colours and legend lines away when the plan stops drawing a field', async () => {
    const m = await mounted({ twoIterations: true })
    drawLine(m)
    const section = await showSection(m)
    expect(lastValues(section)).toEqual([10, 30, 20, null, null, 50])
    expect(legendText(m.root)).toContain('inactive in idomain')

    ;(m.root.querySelector('button[aria-label="Iteration 3"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(m.root.textContent).toContain('group G1 has nothing to draw in iteration 3'))
    await settle()

    expect(sectionToggle(m.root).getAttribute('aria-pressed')).toBe('true')
    expect(lastValues(section).every((v) => v === null)).toBe(true)
    expect(legendText(m.root)).not.toContain('inactive in idomain')
    expect(m.stub.section).toHaveLength(1)
  })

  it('says how many section cells hold a value but are inactive in idomain', async () => {
    const m = await mounted()
    drawLine(m)
    await showSection(m)
    expect(legendText(m.root)).toContain('1 section cell holds a value but is inactive in idomain; drawn as absence')
  })

  it('recolours on every style change from values already held, with one section request', async () => {
    const m = await mounted()
    drawLine(m)
    const section = await showSection(m)
    const steps: Array<[string, () => void]> = [
      ['9 classes', () => select(m.root, 'Colour classes', '9')],
      ['colormap', () => select(m.root, 'Colormap', 'magma')],
      ['log10', () => select(m.root, 'Value scale', 'log10')],
      ['linear again', () => select(m.root, 'Value scale', 'linear')],
      ['symmetric', () => check(m.root, 'Symmetric about 0', true)],
      ['texture', () => check(m.root, 'Texture fill', true)],
    ]
    for (const [name, step] of steps) {
      const styles = section.setStyle.mock.calls.length
      const maps = section.setColormap.mock.calls.length
      step()
      await settle()
      expect(section.setStyle.mock.calls.length + section.setColormap.mock.calls.length, name).toBeGreaterThan(styles + maps)
      expect(last(section.setStyle)[0], name).toBe(last(m.plan.setStyle)[0])
      expect(last(section.setLimits)[0], name).toEqual(last(m.plan.setLimits)[0])
      expect(last(section.setColormap), name).toEqual(last(m.plan.setColormap))
    }
    expect(last(section.setColormap)[0]).toBe('magma')
    expect(m.stub.section).toHaveLength(1)
  })

  it('counts section values beyond the limits', async () => {
    const m = await mounted()
    drawLine(m)
    await showSection(m)
    select(m.root, 'Limits', 'manual')
    const lower = m.root.querySelector('input[aria-label="Lower limit"]') as HTMLInputElement
    const upper = m.root.querySelector('input[aria-label="Upper limit"]') as HTMLInputElement
    lower.value = '15'
    lower.dispatchEvent(new Event('input'))
    upper.value = '35'
    upper.dispatchEvent(new Event('input'))
    await settle()

    const section = await sectionLayer()
    expect(last(section.setLimits)[0]).toEqual([15, 35])
    // 10 and 50 fall outside; 20 and 30 inside.
    expect(legendText(m.root)).toContain('2 section cells beyond the limits')
    expect(m.stub.section).toHaveLength(1)
  })

  it('fills only layer 1 for a pilot-point group of layer 1, and says so', async () => {
    const m = await mounted()
    drawLine(m)
    const section = await showSection(m)
    select(m.root, 'Parameter group', 'PP1')
    await vi.waitFor(() => expect(legendText(m.root)).toContain('group PP1 sets layer 1 only'))

    expect(lastValues(section)).toEqual([null, 7, null, null, null, 9])
    expect(legendText(m.root)).toContain('group PP1 sets layer 1 only; other layers have no value from this group')
    expect(m.stub.section).toHaveLength(1)
  })

  it('draws geometry only for a group drawn as dots, and says why', async () => {
    const m = await mounted()
    drawLine(m)
    const section = await showSection(m)
    select(m.root, 'Parameter group', 'D')
    await vi.waitFor(() => expect(legendText(m.root)).toContain('this group is drawn as dots; the section shows no values for it'))

    expect(lastValues(section).every((v) => v === null)).toBe(true)
    expect(Array.from(last(section.setFootprint)[0] as Uint8Array)).toEqual([1, 1, 1, 0, 1, 1])
  })

  it('draws geometry only when coloured by observations, and says the section colours parameter fields only', async () => {
    const m = await mounted()
    drawLine(m)
    const section = await showSection(m)
    m.store.set({ colour: { source: 'obs', stat: 'resid_mean' } }, 'other')
    await vi.waitFor(() => expect(legendText(m.root)).toContain('the section colours parameter fields only'))

    expect(lastValues(section).every((v) => v === null)).toBe(true)
    expect(legendText(m.root)).not.toContain('inactive in idomain')
    expect(m.stub.section).toHaveLength(1)
  })

  it('shows the mesh note when the grid has no idomain', async () => {
    const m = await mounted({ hasIdomain: false })
    drawLine(m)
    await showSection(m)
    expect(legendText(m.root)).toContain('the grid file records no idomain')
  })

  it("puts the answer's own notes in the legend", async () => {
    const m = await mounted({ answer: { ...FIXTURE, notes: ['2 ties on a shared edge went to the lower cell id'] } })
    drawLine(m)
    await showSection(m)
    expect(legendText(m.root)).toContain('2 ties on a shared edge went to the lower cell id')
  })

  it('never draws an answer that lands after its line was replaced', async () => {
    const m = await mounted({ holdSections: true })
    drawLine(m)
    sectionToggle(m.root).click()
    await vi.waitFor(() => expect(m.stub.held).toHaveLength(1))
    planToggle(m.root).click()
    drawLine(m, 0.25, 0.75)
    sectionToggle(m.root).click()
    await vi.waitFor(() => expect(m.stub.held).toHaveLength(2))

    const MeshLayer = await meshLayerMock()
    m.stub.held[0]({ ...FIXTURE, notes: ['answer for line one'] })
    await settle()
    expect(MeshLayer.mock.instances).toHaveLength(1)
    expect(legendText(m.root)).not.toContain('answer for line one')

    m.stub.held[1]({ ...FIXTURE, notes: ['answer for line two'] })
    await vi.waitFor(() => expect(sectionToggle(m.root).getAttribute('aria-pressed')).toBe('true'))
    await settle()
    expect(MeshLayer.mock.instances).toHaveLength(2)
    expect(legendText(m.root)).toContain('answer for line two')
    expect(legendText(m.root)).not.toContain('answer for line one')
  })
})
