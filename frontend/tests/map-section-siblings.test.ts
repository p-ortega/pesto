// @vitest-environment jsdom
//
// A group split one per layer (kblayer1, kblayer2; kxlayer1pp, kxlayer9pp) fills the whole section:
// each layer is read from the sibling the data says fills it, in the picked group's style, read only
// while the section shows, and a click names the sibling. The plan draws the picked group alone.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { Camera } from '../src/gl/camera'
import { SectionCamera } from '../src/gl/section-camera'
import { emptySelection } from '../src/state/rules'
import { axesInset } from '../src/ui/section-axes'
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
const BOUNDS: [number, number, number, number] = [0, 3, 0, 1]
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1, 2, 0, 3, 0, 3, 1, 2, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11])

// kblayer1 sets layer 0 and kblayer2 layer 1 through their par_cell rows.
const ROWS = [
  { parnme: 'b0', pargp: 'kblayer1', cell: 0, layer: 0, value: 10 },
  { parnme: 'b1', pargp: 'kblayer1', cell: 1, layer: 0, value: 20 },
  { parnme: 'b2', pargp: 'kblayer1', cell: 2, layer: 0, value: 30 },
  { parnme: 'b3', pargp: 'kblayer2', cell: 0, layer: 1, value: 40 },
  { parnme: 'b4', pargp: 'kblayer2', cell: 2, layer: 1, value: 50 },
]
const PAR_TABLE = tableToIPC(
  tableFromArrays({
    parnme: [...ROWS.map((r) => r.parnme), 'pp1', 'pp9'],
    pargp: [...ROWS.map((r) => r.pargp), 'kxlayer1pp', 'kxlayer9pp'],
    partrans: [...ROWS.map(() => 'none'), 'none', 'none'],
  }),
  'stream',
)
const PARMAP = Int32Array.from(ROWS, (_, i) => i)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')
// The name kxlayer9pp says 9; its index entry says layer 1, and that is the layer it fills.
const PP_GROUPS = [
  { group: 'kxlayer1pp', layer: 0, n_pp: 1, log_space: false, format: 'text', notes: [] },
  { group: 'kxlayer9pp', layer: 1, n_pp: 2, log_space: false, format: 'text', notes: [] },
]
const PP_FIELDS: Record<string, Float32Array> = {
  kxlayer1pp: new Float32Array([1, 2, 3]),
  kxlayer9pp: new Float32Array([7, 8, 9]),
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

interface Stub {
  fields: URLSearchParams[]
  contributors: URLSearchParams[]
  /** Field answers for kxlayer9pp waiting for the test to release them. */
  held: Array<() => void>
  holdSibling: boolean
}

function stubEnvironment(stub: Stub): void {
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
      switch (path) {
        case '/api/run/grid/mesh':
          return respond({
            status: 200,
            body: { n_vert: 12, n_tri: 6, n_cells: 3, nlay: 2, bounds: BOUNDS, origin: ORIGIN, crs: null, tag: 'siblings', has_idomain: true, notes: [] },
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
          return respond({ status: 200, bytes: bytesOf(PARMAP) })
        case '/api/run/meta':
          return respond({ status: 200, bytes: PAR_TABLE })
        case '/api/run/grid/cells/cell':
          return respond({ status: 200, bytes: bytesOf(Int32Array.from(ROWS, (r) => r.cell)) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(Int32Array.from(ROWS, (r) => r.layer)) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 200, bytes: bytesOf(Float32Array.from(ROWS.flatMap(() => [Number.NaN, Number.NaN]))) })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(Float32Array.from(ROWS, (r) => r.value)) })
        case '/api/run/grid/pp':
          return respond({ status: 200, body: { groups: PP_GROUPS, not_interpolable: [], notes: [] } })
        case '/api/run/grid/field': {
          stub.fields.push(query)
          const group = query.get('group') ?? ''
          const answer = () => respond({ status: 200, bytes: bytesOf(PP_FIELDS[group]) })
          if (group === 'kxlayer9pp' && stub.holdSibling) {
            return new Promise((resolve) => stub.held.push(() => resolve(answer())))
          }
          return answer()
        }
        case '/api/run/grid/field/cell':
          stub.contributors.push(query)
          return respond({ status: 200, body: { contributors: [{ parnme: query.get('group') === 'kxlayer9pp' ? 'pp9' : 'pp1', weight: 1 }] } })
        case '/api/run/view':
          throw new Error('no saved view')
        case '/api/run/grid/section':
          return respond({ status: 200, body: FIXTURE })
        case '/api/run/link/cell': {
          const cells = (query.get('cells') ?? '').split(',').map(Number)
          return respond({
            status: 200,
            body: {
              layer: Number(query.get('layer')),
              cells,
              ring: [],
              ring_rule: 'a neighbouring cell shares at least one corner with a clicked cell',
              pars: [],
              pars_total: 0,
              par_notes: [],
              sites: [],
              sites_total: 0,
              sites_cap: 50,
              site_counts: { unknown_layer_included: 0, other_layer_left_out: 0, unplaced_in_run: 0 },
              reasons: { pars: null, sites: null },
            },
          })
        }
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

type Mocked = ReturnType<typeof vi.fn>

interface LayerDouble {
  setValues: Mocked
  setContested: Mocked
  setFootprint: Mocked
  setStyle: Mocked
  setLimits: Mocked
}

async function meshLayerMock() {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer)
}

const recording = createRecording2d()

interface Mounted {
  root: HTMLElement
  canvas: HTMLCanvasElement
  stub: Stub
  store: SelectionStore
  plan: LayerDouble
}

async function mounted(holdSibling = false): Promise<Mounted> {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
  const stub: Stub = { fields: [], contributors: [], held: [], holdSibling }
  stubEnvironment(stub)
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
  await vi.waitFor(() => expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull())
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

function clientAtSection(canvas: HTMLCanvasElement, s: number, z: number): [number, number] {
  const camera = new SectionCamera(canvas.width, canvas.height)
  camera.setInset(axesInset(1))
  camera.fit([0, 3.5, 0, 10])
  return camera.worldToScreen(s, z)
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
const readoutText = (root: HTMLElement): string => root.querySelector('.floating-bottom-right')?.textContent ?? ''

function legendLine(root: HTMLElement, starts: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>('.section-legend-line')).find((el) => el.textContent?.startsWith(starts))
}

function drawLine(m: Mounted): void {
  ;(m.root.querySelector('button[aria-label="Draw section line"]') as HTMLButtonElement).click()
  clickAt(m.canvas, clientAtPlan(m.canvas, 0.25, 0.5))
  clickAt(m.canvas, clientAtPlan(m.canvas, 2.75, 0.5))
}

async function showSection(m: Mounted): Promise<LayerDouble> {
  sectionToggle(m.root).click()
  await vi.waitFor(() => expect(sectionToggle(m.root).getAttribute('aria-pressed')).toBe('true'))
  await settle()
  return (await meshLayerMock()).mock.instances[1] as unknown as LayerDouble
}

function select(root: HTMLElement, label: string, value: string): void {
  const el = root.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
  el.value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function lastValues(layer: LayerDouble): Array<number | null> {
  const values = layer.setValues.mock.calls.at(-1)?.[0] as Float32Array
  return Array.from(values, (v) => (Number.isNaN(v) ? null : v))
}

function siblingFieldRequests(stub: Stub): URLSearchParams[] {
  return stub.fields.filter((q) => q.get('group') === 'kxlayer9pp')
}

describe('a section stacked from sibling groups', () => {
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

  it('fills each layer from the block sibling its par_cell rows set, from the field the plan already holds', async () => {
    const m = await mounted()
    const planBefore = lastValues(m.plan)
    drawLine(m)
    const section = await showSection(m)

    expect(lastValues(section)).toEqual([10, 40, 20, null, 30, 50])
    const line = legendLine(m.root, 'kblayer#:')
    expect(line?.textContent).toBe('kblayer#: layers 1–2 (index 0–1) from 2 groups')
    expect(line?.title).toBe('layer 1 (index 0): kblayer1\nlayer 2 (index 1): kblayer2')
    expect(legendText(m.root)).not.toContain('other layers have no value')
    expect(m.stub.fields).toHaveLength(0)

    planToggle(m.root).click()
    await settle()
    // The plan still draws the picked group alone.
    expect(lastValues(m.plan)).toEqual(planBefore)
    expect(legendText(m.root)).not.toContain('kblayer#')
  })

  it('names the sibling that fills the clicked layer, not the picked group', async () => {
    const m = await mounted()
    drawLine(m)
    await showSection(m)
    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 2.5))
    await vi.waitFor(() => expect(readoutText(m.root)).toContain('b3 (kblayer2): 40.00'))
    expect(readoutText(m.root)).toContain('layer 1, cell 0')

    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 7.5))
    await vi.waitFor(() => expect(readoutText(m.root)).toContain('b0 (kblayer1): 10.00'))
  })

  it('reads an interpolated sibling only once the section shows, says it is loading, and fills the layer its index names', async () => {
    const m = await mounted(true)
    select(m.root, 'Parameter group', 'kxlayer1pp')
    await vi.waitFor(() => expect(m.stub.fields.some((q) => q.get('group') === 'kxlayer1pp')).toBe(true))
    await settle()
    drawLine(m)
    await settle()
    expect(siblingFieldRequests(m.stub)).toHaveLength(0)

    const section = await showSection(m)
    await vi.waitFor(() => expect(m.stub.held).toHaveLength(1))
    const asked = siblingFieldRequests(m.stub)[0]
    const own = m.stub.fields.find((q) => q.get('group') === 'kxlayer1pp')!
    expect(asked.get('iteration')).toBe(own.get('iteration'))
    expect(asked.get('stat')).toBe(own.get('stat'))
    expect(asked.get('realization')).toBe(own.get('realization'))
    // Layer 1 waits with no value rather than showing anything stale.
    expect(lastValues(section)).toEqual([1, null, 2, null, 3, null])
    expect(legendText(m.root)).toContain('reading layer 2 (index 1)…')

    m.stub.held[0]()
    await vi.waitFor(() => expect(lastValues(section)).toEqual([1, 7, 2, null, 3, 9]))
    expect(legendText(m.root)).not.toContain('reading layer')
    expect(legendLine(m.root, 'kxlayer#pp:')?.textContent).toBe('kxlayer#pp: layers 1–2 (index 0–1) from 2 groups')
    expect(legendLine(m.root, 'kxlayer#pp:')?.title).toBe('layer 1 (index 0): kxlayer1pp\nlayer 2 (index 1): kxlayer9pp')
    // The sibling is drawn with the picked group's limits and style.
    expect(section.setLimits.mock.calls.at(-1)?.[0]).toEqual(m.plan.setLimits.mock.calls.at(-1)?.[0])
    expect(section.setStyle.mock.calls.at(-1)?.[0]).toBe(m.plan.setStyle.mock.calls.at(-1)?.[0])

    clickAt(m.canvas, clientAtSection(m.canvas, 1.0, 2.5))
    await vi.waitFor(() => expect(readoutText(m.root)).toContain('kxlayer9pp: 7.000'))
    expect(readoutText(m.root)).toContain('Interpolated from 2 pilot points')
    await vi.waitFor(() => expect(readoutText(m.root)).toContain('pp9 (weight 1.00)'))
    expect(m.stub.contributors.at(-1)?.get('group')).toBe('kxlayer9pp')
  })

  it('stops reading when the section is hidden and asks again when it shows', async () => {
    const m = await mounted(true)
    select(m.root, 'Parameter group', 'kxlayer1pp')
    await vi.waitFor(() => expect(m.stub.fields.some((q) => q.get('group') === 'kxlayer1pp')).toBe(true))
    await settle()
    drawLine(m)
    const section = await showSection(m)
    await vi.waitFor(() => expect(m.stub.held).toHaveLength(1))

    planToggle(m.root).click()
    await settle()
    m.stub.held[0]()
    await settle()
    expect(lastValues(section)).toEqual([1, null, 2, null, 3, null])

    m.stub.holdSibling = false
    await showSection(m)
    await vi.waitFor(() => expect(lastValues(section)).toEqual([1, 7, 2, null, 3, 9]))
    expect(siblingFieldRequests(m.stub)).toHaveLength(2)
  })
})
