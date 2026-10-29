// @vitest-environment jsdom
//
// A click on the section reads and selects like a click on the plan (SECT-02, D-23, D-24, D-33):
// the readout names the value, layer and place along the line, the store gets cells, pars and
// sites in one write, askLinkCell asks the link route about the clicked layer, absence is named and never
// selected, and the selected cells ring through every layer. The real map screen against a
// stubbed fetch, with the GL context and the MeshLayer double mocked.

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

// Three pieces on cells 0, 1 and 2, two layers, z 10 / 5 / 0; quad 3 (cell 1, layer 1) is idomain 0.
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
const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 2, bounds: BOUNDS, origin: ORIGIN, crs: null, tag: 'click', has_idomain: true }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PARMAP = new Int32Array([0, 1, 2, 3])
// p4 of G3 is a pilot-point group: in the control table, never in the map block.
const PAR_TABLE = tableToIPC(
  tableFromArrays({
    parnme: ['p0', 'p1', 'p2', 'p3', 'p4'],
    pargp: ['G1', 'G1', 'G1', 'G1', 'G3'],
    partrans: ['none', 'none', 'none', 'none', 'none'],
  }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

interface Env {
  answer: Record<string, unknown>
  cellArray: Int32Array
  layerArray: Int32Array
  values: Float32Array
  pp: boolean
}

function defaultEnv(): Env {
  return {
    answer: FIXTURE,
    // Block rows p0..p3: cell 0 and 1 on layer 0, then cell 0 and 1 on layer 1.
    cellArray: new Int32Array([0, 1, 0, 1]),
    layerArray: new Int32Array([0, 0, 1, 1]),
    values: new Float32Array([10, 20, 30, 40]),
    pp: false,
  }
}

interface Stub {
  calls: string[]
  link: URLSearchParams[]
  release: Array<() => void>
  contributors: URLSearchParams[]
  /** The parameters the /link/par answer knows, by name. */
  pars: Record<string, { cells: number[] }>
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

// What the clicked cells hold: each cell's own parameter on the asked layer and one site per cell.
function linkBody(layer: number, cells: number[]): Record<string, unknown> {
  return {
    layer,
    cells,
    ring: [],
    ring_rule: 'a neighbouring cell shares at least one corner with a clicked cell',
    pars: cells.map((c) => ({ parnme: `p${layer * 2 + c}`, pargp: 'G1', kind: 'cell', cell: c, weights: [], rule: 'sets this cell (par_cell)' })),
    pars_total: cells.length,
    par_notes: [],
    sites: cells.map((c) => ({ site_id: 100 + c, site: `s${c}`, group: 'heads', layer, cell: c, in_clicked_cell: true })),
    sites_total: cells.length,
    sites_cap: 50,
    site_counts: { unknown_layer_included: 0, other_layer_left_out: 0, unplaced_in_run: 0 },
    reasons: { pars: null, sites: null },
  }
}

function stubEnvironment(env: Env): Stub {
  const stub: Stub = { calls: [], link: [], release: [], contributors: [], pars: {} }
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
          return respond({ status: 200, bytes: bytesOf(env.cellArray) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(env.layerArray) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 404, body: { title: 'no point positions were recorded for that iteration', status: 404 } })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(env.values) })
        case '/api/run/grid/pp':
          return respond({
            status: 200,
            body: {
              groups: env.pp ? [{ group: 'G3', layer: 1, n_pp: 1, log_space: false, format: 'text', notes: [] }] : [],
              not_interpolable: [],
              notes: [],
            },
          })
        case '/api/run/grid/field':
          return respond({
            status: 200,
            bytes: bytesOf(new Float32Array([7, 8])),
            headers: { 'X-Pesto-Meta': JSON.stringify({ order: 'cell', group: 'G3', layer: 1, n_pp: 1 }) },
          })
        case '/api/run/grid/field/cell':
          stub.contributors.push(query)
          return respond({ status: 200, body: { group: 'G3', cell: Number(query.get('cell')), contributors: [{ parnme: 'p4', weight: 1.0 }] } })
        case '/api/run/view':
          throw new Error('no saved view')
        case '/api/run/grid/section':
          return respond({ status: 200, body: env.answer })
        case '/api/run/link/cell': {
          stub.link.push(query)
          await new Promise<void>((resolve) => stub.release.push(resolve))
          const layer = Number(query.get('layer'))
          return respond({ status: 200, body: linkBody(layer, (query.get('cells') ?? '').split(',').map(Number)) })
        }
        case '/api/run/link/par': {
          const names = JSON.parse(query.get('names') ?? '[]') as string[]
          const known = names.filter((n) => n in stub.pars)
          return respond({
            status: 200,
            body: {
              pars: known.map((parnme) => ({
                parnme,
                pargp: 'G1',
                kind: 'cell',
                layer: 0,
                cell: stub.pars[parnme].cells[0],
                cells: stub.pars[parnme].cells,
                n_cells: stub.pars[parnme].cells.length,
                cells_capped: false,
                reason: null,
              })),
              unknown: names.filter((n) => !(n in stub.pars)),
              reason: null,
              notes: [],
            },
          })
        }
        case '/api/run/link/sites':
          return respond({
            status: 200,
            body: { iteration: 0, sites: [], unknown: [], value_rule: 'any measured value', value_reason: null, reason: null, notes: [] },
          })
        default:
          return respond({ status: 404, body: { title: 'not in this test', status: 404, artifact: path } })
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
  setSelected: Mocked
  setSelectedCells: Mocked
}

async function layerDouble(index: number): Promise<LayerDouble> {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer).mock.instances[index] as unknown as LayerDouble
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
}

async function mounted(change: (env: Env) => void = () => {}): Promise<Mounted> {
  stubResizeObserver()
  const env = defaultEnv()
  change(env)
  const stub = stubEnvironment(env)
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
  await vi.waitFor(() => expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull())
  const canvas = root.querySelector('canvas') as HTMLCanvasElement
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
  return { root, canvas, stub, store }
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

// Through a camera fitted as the section fits: the whole line, the finite elevations, clear of the axes.
function clientAtSection(canvas: HTMLCanvasElement, s: number, z: number, zRange: [number, number] = [0, 10]): [number, number] {
  const camera = new SectionCamera(canvas.width, canvas.height)
  camera.setInset(axesInset(1))
  camera.fit([0, 3.5, zRange[0], zRange[1]])
  return camera.worldToScreen(s, z)
}

function pointer(type: string, [x, y]: [number, number]): PointerEvent {
  return new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true, cancelable: true })
}

function clickAt(canvas: HTMLCanvasElement, point: [number, number], init: MouseEventInit = {}): void {
  canvas.dispatchEvent(pointer('pointerdown', point))
  canvas.dispatchEvent(pointer('pointerup', point))
  canvas.dispatchEvent(new MouseEvent('click', { ...init, clientX: point[0], clientY: point[1], bubbles: true }))
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!found) throw new Error(`no button reads ${text}`)
  return found as HTMLButtonElement
}

const readoutText = (root: HTMLElement): string => root.querySelector('.floating-bottom-right')?.textContent ?? ''
const layerInput = (root: HTMLElement): HTMLInputElement => root.querySelector('input[aria-label="Layer"]') as HTMLInputElement

async function showSection(m: Mounted): Promise<void> {
  ;(m.root.querySelector('button[aria-label="Draw section line"]') as HTMLButtonElement).click()
  clickAt(m.canvas, clientAtPlan(m.canvas, 0.25, 0.5))
  clickAt(m.canvas, clientAtPlan(m.canvas, 1.75, 0.5))
  buttonByText(m.root, 'Section view').click()
  await vi.waitFor(() => expect(buttonByText(m.root, 'Section view').getAttribute('aria-pressed')).toBe('true'))
  await settle()
}

// Answers the oldest held /link/cell request and lets the store hear it.
async function answerLink(m: Mounted, index: number): Promise<void> {
  await vi.waitFor(() => expect(m.stub.release.length).toBeGreaterThan(index))
  m.stub.release[index]()
  await settle()
}

function linkCallCount(m: Mounted): number {
  return m.stub.calls.filter((path) => path === '/api/run/link/cell').length
}

function choose(root: HTMLElement, label: string, value: string): void {
  const select = root.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
  select.value = value
  select.dispatchEvent(new Event('change'))
}

describe('a click on the section reads and selects like a plan click', () => {
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

  it('reads the value, its class, the layer, the distance and the elevations, and asks about the clicked layer', async () => {
    const m = await mounted()
    choose(m.root, 'Colour steps', '7')
    await settle()
    await showSection(m)
    const heard = vi.fn()
    m.store.subscribe((s) => [s.cells, s.pars, s.sites], heard)

    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 2.5))
    const text = readoutText(m.root)
    expect(text).toContain('p2 (G1): 30.00')
    expect(text).toMatch(/step \d of 7/)
    expect(text).toContain('layer 2 (index 1), cell 0')
    expect(text).toContain('distance from A: 1 model units')
    expect(text).toContain('top 5, bottom 0 model units')

    await vi.waitFor(() => expect(m.stub.link).toHaveLength(1))
    expect(m.stub.link[0].get('layer')).toBe('1')
    expect(m.stub.link[0].get('cells')).toBe('0')
    expect(m.store.get().cells.size).toBe(0)

    await answerLink(m, 0)
    expect([...m.store.get().cells]).toEqual([0])
    expect([...m.store.get().pars]).toEqual(['p2'])
    expect([...m.store.get().sites]).toEqual([100])
    expect(heard).toHaveBeenCalledTimes(1)
    expect(heard.mock.calls[0][2]).toEqual(new Set(['map']))
    // The plan stays on its own layer.
    expect(layerInput(m.root).value).toBe('0')
    expect(m.store.get().layer).toBe(0)
  })

  it('adds with shift, removes with alt, and writes cells only when the last cell goes', async () => {
    const m = await mounted()
    await showSection(m)

    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 7.5))
    await answerLink(m, 0)
    expect([...m.store.get().cells]).toEqual([0])

    clickAt(m.canvas, clientAtSection(m.canvas, 2.0, 7.5), { shiftKey: true })
    await vi.waitFor(() => expect(m.stub.link).toHaveLength(2))
    expect(m.stub.link[1].get('cells')).toBe('0,1')
    expect(m.stub.link[1].get('layer')).toBe('0')
    await answerLink(m, 1)
    expect([...m.store.get().cells].sort()).toEqual([0, 1])

    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 7.5), { altKey: true })
    await vi.waitFor(() => expect(m.stub.link).toHaveLength(3))
    expect(m.stub.link[2].get('cells')).toBe('1')
    await answerLink(m, 2)
    expect([...m.store.get().cells]).toEqual([1])
    const parsBefore = m.store.get().pars
    const sitesBefore = m.store.get().sites

    clickAt(m.canvas, clientAtSection(m.canvas, 2.0, 7.5), { altKey: true })
    await settle()
    expect(m.store.get().cells.size).toBe(0)
    expect(m.store.get().pars).toEqual(parsBefore)
    expect(m.store.get().sites).toEqual(sitesBefore)
    expect(m.stub.link).toHaveLength(3)
  })

  it('moves the plan readout to the cell a section click selects, as a plan click does', async () => {
    const m = await mounted()
    clickAt(m.canvas, clientAtPlan(m.canvas, 1.5, 0.5))
    await answerLink(m, 0)
    expect(readoutText(m.root)).toContain('layer 1 (index 0), cell 1')
    await showSection(m)

    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 2.5))
    await answerLink(m, 1)
    expect(readoutText(m.root)).toContain('layer 2 (index 1), cell 0')
    buttonByText(m.root, 'Plan view').click()
    await settle()

    // The plan reads the same cell on its own layer, not the cell it was clicked on before.
    expect(readoutText(m.root)).toContain('layer 1 (index 0), cell 0')
    expect(readoutText(m.root)).not.toContain('cell 1')
  })

  it('clears the readout when an alt click takes the cell away, in the section as on the plan', async () => {
    const m = await mounted()
    await showSection(m)
    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 7.5))
    await answerLink(m, 0)
    expect(readoutText(m.root)).toContain('layer 1 (index 0), cell 0')

    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 7.5), { altKey: true })
    await settle()
    expect(readoutText(m.root)).not.toContain('cell 0')
    expect(readoutText(m.root)).toContain('Click a cell to see its value.')
    buttonByText(m.root, 'Plan view').click()
    await settle()
    expect(readoutText(m.root)).toContain('Click a cell to see its value.')
  })

  it('shows a contested quad with every row, as the plan does', async () => {
    const m = await mounted((env) => {
      env.cellArray = new Int32Array([0, 1, 0, 0])
    })
    await showSection(m)
    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 2.5))
    const text = readoutText(m.root)
    expect(text).toContain('Contested cell')
    expect(text).toContain('p2 (G1): 30.00')
    expect(text).toContain('p3 (G1): 40.00')
    expect(text).toContain('layer 2 (index 1), cell 0')
  })

  it('shows a pilot-point value and the points behind the cell through the plan\'s contributors fetch', async () => {
    const m = await mounted((env) => {
      env.pp = true
    })
    choose(m.root, 'Parameter group', 'G3')
    await vi.waitFor(() => expect(m.root.querySelector('.floating-bottom-left')?.textContent).toContain('G3 · interpolated'))
    const planLayer = layerInput(m.root).value
    await showSection(m)

    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 2.5))
    expect(readoutText(m.root)).toContain('G3: 7.000')
    expect(readoutText(m.root)).toContain('Interpolated from 1 pilot point')
    await vi.waitFor(() => expect(readoutText(m.root)).toContain('p4 (weight 1.00)'))
    expect(m.stub.contributors).toHaveLength(1)
    expect(m.stub.contributors[0].get('cell')).toBe('0')
    expect(layerInput(m.root).value).toBe(planLayer)

    // Layer 0 of the same cell has no value from this group.
    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 7.5))
    expect(readoutText(m.root)).toContain('No parameter of G3 sits on this cell.')
    expect(readoutText(m.root)).toContain('layer 1 (index 0), cell 0')
  })

  it('names absence by its reason and leaves the selection as it was', async () => {
    const m = await mounted()
    await showSection(m)
    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 7.5))
    await answerLink(m, 0)
    const before = m.store.get()
    const heard = vi.fn()
    m.store.subscribe((s) => [s.cells, s.pars, s.sites], heard)

    for (const init of [{}, { shiftKey: true }, { altKey: true }]) {
      clickAt(m.canvas, clientAtSection(m.canvas, 2.0, 2.5), init)
      await settle()
      expect(readoutText(m.root)).toContain('inactive (idomain 0)')
      expect(readoutText(m.root)).toContain('layer 2 (index 1), cell 1')
    }
    expect(m.stub.link).toHaveLength(1)
    expect(linkCallCount(m)).toBe(1)
    expect(heard).not.toHaveBeenCalled()
    expect(m.store.get().cells).toBe(before.cells)
    expect(m.store.get().pars).toBe(before.pars)
    expect(m.store.get().sites).toBe(before.sites)
  })

  it('says a section cell the plan does not hold cannot be read, rather than that no parameter sits on it', async () => {
    const m = await mounted()
    await showSection(m)
    // The answer's third piece is cell 2; this plan holds cells 0 and 1 only.
    clickAt(m.canvas, clientAtSection(m.canvas, 3.25, 7.5))
    await settle()
    expect(readoutText(m.root)).toContain('the plan holds no cell 2, so this section cell cannot be read')
    expect(readoutText(m.root)).not.toContain('No parameter')
    expect(m.root.querySelector('.floating-bottom-left')?.textContent).toContain(
      '2 section cells name a cell the plan does not hold; drawn as absence',
    )
  })

  it('lists the pinched layers of the clicked piece', async () => {
    const answer = {
      ...FIXTURE,
      nlay: 5,
      z: [10, 8, 6, 4, 4, 4, 10, 8, 6, 4, 2, 0, 10, 8, 6, 4, 2, 2],
      status: [0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
    }
    const m = await mounted((env) => {
      env.answer = answer
    })
    await showSection(m)
    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 9, [0, 10]))
    expect(readoutText(m.root)).toContain('layer 1 (index 0), cell 0')
    expect(readoutText(m.root)).toContain('pinched out in this cell (zero thickness): layers 4, 5 (index 3, 4)')

    clickAt(m.canvas, clientAtSection(m.canvas, 2.0, 9, [0, 10]))
    expect(readoutText(m.root)).toContain('layer 1 (index 0), cell 1')
    expect(readoutText(m.root)).not.toContain('pinched out')

    clickAt(m.canvas, clientAtSection(m.canvas, 3.25, 9, [0, 10]))
    expect(readoutText(m.root)).toContain('layer 1 (index 0), cell 2')
    expect(readoutText(m.root)).toContain('pinched out in this cell (zero thickness): layer 5 (index 4)')
  })

  it('clears cells, sites and pars once on a plain click in a gap, and changes nothing on a shift or alt click there', async () => {
    const m = await mounted()
    await showSection(m)
    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 7.5))
    await answerLink(m, 0)
    expect(m.store.get().pars.size).toBe(1)
    const shown = readoutText(m.root)
    const heard = vi.fn()
    m.store.subscribe((s) => [s.cells, s.pars, s.sites], heard)

    for (const init of [{ shiftKey: true }, { altKey: true }]) {
      clickAt(m.canvas, clientAtSection(m.canvas, 2.75, 5), init)
      await settle()
    }
    expect(heard).not.toHaveBeenCalled()
    expect(readoutText(m.root)).toBe(shown)

    clickAt(m.canvas, clientAtSection(m.canvas, 2.75, 5))
    await settle()
    expect(heard).toHaveBeenCalledTimes(1)
    expect(m.store.get().cells.size).toBe(0)
    expect(m.store.get().pars.size).toBe(0)
    expect(m.store.get().sites.size).toBe(0)
    expect(readoutText(m.root)).toBe('Click a cell to see its value. The Params and Obs tabs then list what sets it.')
    expect(m.stub.link).toHaveLength(1)
  })
})

// The last ids a layer was told to ring, whichever of the two calls told it.
function lastRing(layer: LayerDouble): number[] {
  const calls: Array<{ order: number; ids: number[] }> = []
  layer.setSelected.mock.calls.forEach((args, i) => {
    const id = args[0] as number | null
    calls.push({ order: layer.setSelected.mock.invocationCallOrder[i], ids: id === null ? [] : [id] })
  })
  layer.setSelectedCells.mock.calls.forEach((args, i) => {
    calls.push({ order: layer.setSelectedCells.mock.invocationCallOrder[i], ids: [...(args[0] as number[])] })
  })
  calls.sort((a, b) => a.order - b.order)
  return calls.at(-1)?.ids ?? []
}

describe('selected cells ring their whole column in the section', () => {
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

  it('rings every layer of a cell selected before the section was built', async () => {
    const m = await mounted()
    m.store.set({ cells: new Set([0]) }, 'params')
    await settle()
    await showSection(m)
    const section = await layerDouble(1)
    expect(lastRing(section)).toEqual([0, 1])
  })

  it('follows a selection written by another view, and clears with an empty one', async () => {
    const m = await mounted()
    await showSection(m)
    const section = await layerDouble(1)

    m.store.set({ cells: new Set([1]) }, 'params')
    await vi.waitFor(() => expect(lastRing(section)).toEqual([2, 3]))
    m.store.set({ cells: new Set([0, 1]) }, 'params')
    await vi.waitFor(() => expect(lastRing(section)).toEqual([0, 1, 2, 3]))
    m.store.set({ cells: new Set() }, 'params')
    await vi.waitFor(() => expect(lastRing(section)).toEqual([]))
  })

  it('rings the cell of an unanswered section click at once', async () => {
    const m = await mounted()
    await showSection(m)
    const section = await layerDouble(1)

    clickAt(m.canvas, clientAtSection(m.canvas, 2.0, 7.5))
    expect(lastRing(section)).toEqual([2, 3])
    expect(m.store.get().cells.size).toBe(0)
    await answerLink(m, 0)
    expect(lastRing(section)).toEqual([2, 3])
  })

  it('leaves the rings of parameters picked in a tab on the plan only', async () => {
    const m = await mounted()
    m.stub.pars.p9 = { cells: [1] }
    const plan = await layerDouble(0)
    m.store.set({ cells: new Set([0]), pars: new Set(['p9']) }, 'params')
    await vi.waitFor(() => expect(lastRing(plan)).toEqual([0, 1]))
    await showSection(m)
    const section = await layerDouble(1)
    expect(lastRing(section)).toEqual([0, 1])
    // Quads 0 and 1 are cell 0's two layers; cell 1's quads 2 and 3 stay unringed.
    expect(section.setSelectedCells.mock.calls.some((args) => (args[0] as number[]).includes(2))).toBe(false)
  })
})
