// @vitest-environment jsdom
//
// A field fetch that is still out when the user moves on. Whatever lands
// late, the canvas, legend and store must end up describing the newest
// choice, never the one the fetch started from. Same harness as
// iteration-toggle.test.ts: the real map screen against a stubbed fetch,
// with only the two GL modules mocked, plus a way to hold any one answer.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactRow, IngestState } from '../src/data/client'
import { Camera } from '../src/gl/camera'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({
    gl: { clearColor: vi.fn(), clear: vi.fn(), viewport: vi.fn(), finish: vi.fn(), COLOR_BUFFER_BIT: 0 },
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
      setFootprint: vi.fn(),
      setFootprintColor: vi.fn(),
      setSelectedPoint: vi.fn(),
      draw: vi.fn(),
      reupload: vi.fn(),
      dispose: vi.fn(),
    })
  }),
}))

function artifact(name: string, state = 'ok'): ArtifactRow {
  return { name, kind: name.split('/')[0], state, reason: null, stale: false, seconds: null, bytes: 0 }
}

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

function stateWith(artifacts: ArtifactRow[]): IngestState {
  return {
    fresh: true,
    artifacts,
    capabilities: {
      map: { available: true, blockedBy: [] },
      stats: { available: true, blockedBy: [] },
      chips: { available: true, blockedBy: [] },
    },
    ingestSeconds: null,
    cacheBytes: null,
  }
}

const TWO_ITERATIONS = [artifact('par_ens/0'), artifact('par_ens/3')]

// Two unit cells side by side, two layers. Block groups hk (rows 0 and 1)
// and sy (row 2) place in iteration 0; iteration 3 has no sy row. Group pp
// places on no cell and is drawn only as an interpolated field.
const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 2, bounds: [0, 2, 0, 1], crs: null, tag: 'races' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PAR_TABLE = tableToIPC(
  tableFromArrays({
    parnme: ['hk0', 'hk1', 'sy0', 'pp0'],
    pargp: ['hk', 'hk', 'sy', 'pp'],
    partrans: ['none', 'none', 'none', 'none'],
  }),
  'stream',
)

interface IterationFixture {
  parmap: number[]
  cell: number[]
  layer: number[]
  reals: string[]
  fields: Record<string, number[]>
}

const ITERATIONS: Record<string, IterationFixture> = {
  '0': {
    parmap: [0, 1, 2],
    cell: [0, 1, 1],
    layer: [0, 0, 0],
    reals: ['base', 'r001', 'r017'],
    fields: { base: [1, 2, 3], r001: [4, 5, 6], r017: [7, 8, 9], mean: [-1, -2, -3] },
  },
  '3': {
    parmap: [0, 1],
    cell: [0, 1],
    layer: [0, 0],
    reals: ['r017', 'base'],
    fields: { r017: [70, 80], base: [10, 20], mean: [-10, -20] },
  },
}

const PP_INDEX = {
  groups: [{ group: 'pp', layer: 0, n_pp: 1, log_space: false, format: 'text', notes: [] }],
  not_interpolable: [],
  notes: [],
}

interface FieldCall {
  iteration: string
  group: string | null
  realization: string | null
  stat: string | null
}

interface Stub {
  valuesCalls: FieldCall[]
  fieldCalls: FieldCall[]
  /** Answers named here (a realization, a statistic, or "it3") wait until released. */
  held: Map<string, Promise<void>>
  savedView: Record<string, unknown> | null
  puts: Record<string, unknown>[]
  /** When set, the pilot-point index answers with this problem instead of the index. */
  ppProblem: { status: number; title: string; detail: string } | null
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function stubEnvironment(stub: Stub): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path, search] = url.split('?')
      const query = new URLSearchParams(search ?? '')
      const iteration = query.get('iteration') ?? '0'
      const fixture = ITERATIONS[iteration]
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
      const meta = (dtype: string) => ({ 'X-Pesto-Meta': JSON.stringify({ dtype }) })
      // A field answer waits on its own name or on its iteration ("it3").
      const wait = async (name: string, alsoIteration = true) => {
        const gate = stub.held.get(name) ?? (alsoIteration ? stub.held.get(`it${iteration}`) : undefined)
        if (gate) await gate
      }
      switch (path) {
        case '/api/run/grid/mesh':
          await wait('mesh', false)
          return respond({ status: 200, body: MESH_BODY })
        case '/api/run/grid/mesh/positions':
          return respond({ status: 200, bytes: bytesOf(POSITIONS), headers: meta('<f4') })
        case '/api/run/grid/mesh/cell_index':
          return respond({ status: 200, bytes: bytesOf(CELL_INDEX), headers: meta('<f4') })
        case '/api/run/grid/mesh/indices':
          return respond({ status: 200, bytes: bytesOf(INDICES), headers: meta('<u4') })
        case '/api/run/meta':
          return respond({ status: 200, bytes: PAR_TABLE })
        case '/api/run/grid/pp':
          if (stub.ppProblem !== null) return respond({ status: stub.ppProblem.status, body: stub.ppProblem })
          return respond({ status: 200, body: PP_INDEX })
        case '/api/run/grid/parmap':
          await wait(`tables${iteration}`, false)
          return respond({ status: 200, bytes: bytesOf(new Int32Array(fixture.parmap)) })
        case '/api/run/grid/cells/cell':
          return respond({ status: 200, bytes: bytesOf(new Int32Array(fixture.cell)) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(new Int32Array(fixture.layer)) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 404, body: { title: 'no point positions were recorded for that iteration', status: 404 } })
        case '/api/run/reals':
          return respond({ status: 200, bytes: tableToIPC(tableFromArrays({ realization: fixture.reals }), 'stream') })
        case '/api/run/view':
          if (init?.method === 'PUT') {
            stub.puts.push(JSON.parse(String(init.body)))
            return respond({ status: 200, body: JSON.parse(String(init.body)) })
          }
          if (stub.savedView === null) return respond({ status: 404, body: { title: 'no saved view', status: 404 } })
          return respond({ status: 200, body: stub.savedView })
        case '/api/run/grid/values': {
          const name = query.get('realization') ?? query.get('stat') ?? ''
          stub.valuesCalls.push({ iteration, group: null, realization: query.get('realization'), stat: query.get('stat') })
          await wait(name)
          return respond({ status: 200, bytes: bytesOf(new Float32Array(fixture.fields[name] ?? [0, 0, 0])) })
        }
        case '/api/run/grid/field': {
          const name = query.get('realization') ?? query.get('stat') ?? ''
          stub.fieldCalls.push({ iteration, group: query.get('group'), realization: query.get('realization'), stat: query.get('stat') })
          await wait(name)
          return respond({
            status: 200,
            bytes: bytesOf(new Float32Array([100, 200])),
            headers: { 'X-Pesto-Meta': JSON.stringify({ order: 'cell', group: 'pp', layer: 0, n_pp: 1 }) },
          })
        }
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

function newStub(): Stub {
  return { valuesCalls: [], fieldCalls: [], held: new Map(), savedView: null, puts: [], ppProblem: null }
}

// Holds every answer named `name` until the returned function is called.
function hold(stub: Stub, name: string): () => void {
  let release: () => void = () => {}
  stub.held.set(
    name,
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  return () => {
    stub.held.delete(name)
    release()
  }
}

// A hand-stepped store: nothing reaches a subscriber until flush() is called.
function manualStore(): SelectionStore {
  return createSelectionStore({ initial: emptySelection('test_run', 0), schedule: () => {} })
}

async function mountedWith(
  store: SelectionStore,
  stub: Stub = newStub(),
  artifacts: ArtifactRow[] = TWO_ITERATIONS,
  config: RunConfig = CONFIG,
): Promise<{ root: HTMLElement; stub: Stub }> {
  stubEnvironment(stub)
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    }),
  )
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config, state: stateWith(artifacts), store })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  return { root, stub }
}

function setInput(root: HTMLElement, label: string, value: string, event = 'input'): void {
  const el = root.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement
  el.value = value
  el.dispatchEvent(new Event(event))
}

function toggleButton(root: HTMLElement, label: string): HTMLButtonElement {
  const group = root.querySelector('[aria-label="Iteration"]') as HTMLElement
  return Array.from(group.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement
}

async function meshLayerInstance() {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer).mock.instances[0] as unknown as {
    setValues: ReturnType<typeof vi.fn>
    setColormap: ReturnType<typeof vi.fn>
  }
}

function lastValues(instance: { setValues: ReturnType<typeof vi.fn> }): number[] {
  return Array.from(instance.setValues.mock.calls.at(-1)?.[0] as Float32Array)
}

function legendText(root: HTMLElement): string {
  return root.querySelector('.floating-bottom-left')?.textContent ?? ''
}

function lastFrame() {
  return window.__pestoFrames?.at(-1)
}

// Lets every answer already released run to the end of its landing.
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('a control moved back while a field fetch is out', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.__pestoFrames = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    delete (window as { __pestoFrames?: unknown }).__pestoFrames
  })

  it('keeps drawing the realization moved back to when the one left behind lands', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const instance = await meshLayerInstance()
    const drawnBase = lastValues(instance)
    const release = hold(stub, 'r001')

    setInput(root, 'Realization', '1')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.realization).toBe('r001'))
    setInput(root, 'Realization', '0')
    release()
    await settle()

    expect(lastValues(instance)).toEqual(drawnBase)
    expect(lastFrame()?.selection).toBe('base')
    expect(store.get().reals).toEqual(new Set(['base']))
    expect(root.querySelector('.status-bar')?.textContent).toContain('base')
    expect(root.querySelector('.status-bar')?.textContent).not.toContain('r001')
  })

  it('keeps drawing the value field when the statistic goes to mean and back before the mean lands', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const instance = await meshLayerInstance()
    const drawnBase = lastValues(instance)
    const release = hold(stub, 'mean')

    setInput(root, 'Statistic', 'mean', 'change')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.stat).toBe('mean'))
    setInput(root, 'Statistic', 'value', 'change')
    release()
    await settle()

    expect(lastValues(instance)).toEqual(drawnBase)
    expect(lastFrame()?.selection).toBe('base')
    expect(store.get().colour.stat).toBe('value')
    expect(root.querySelector('.status-bar')?.textContent).not.toContain('mean')
  })
})

describe('a group picked while a field fetch is out', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.__pestoFrames = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    delete (window as { __pestoFrames?: unknown }).__pestoFrames
  })

  it('is still the group drawn when the realization fetch lands', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const release = hold(stub, 'r001')

    setInput(root, 'Realization', '1')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.realization).toBe('r001'))
    setInput(root, 'Parameter group', 'sy', 'change')
    expect(legendText(root)).toContain('sy')
    release()
    await vi.waitFor(() => expect(lastFrame()?.selection).toBe('r001'))

    expect(lastFrame()?.group).toBe('sy')
    expect(legendText(root)).toContain('sy')
    expect(legendText(root)).not.toContain('hk')
    expect((root.querySelector('[aria-label="Parameter group"]') as HTMLSelectElement).value).toBe('sy')
  })

  it('asks the interpolated group for the realization still loading, not the one drawn', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const release = hold(stub, 'r001')

    setInput(root, 'Realization', '1')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.realization).toBe('r001'))
    setInput(root, 'Parameter group', 'pp', 'change')
    release()

    await vi.waitFor(() => expect(stub.fieldCalls.length).toBeGreaterThan(0))
    expect(stub.fieldCalls.at(-1)).toEqual({ iteration: '0', group: 'pp', realization: 'r001', stat: null })
    await vi.waitFor(() => expect(lastFrame()?.group).toBe('pp'))
    expect(lastFrame()?.selection).toBe('r001')
  })
})

describe('a colour choice made while an iteration switch loads its field', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.__pestoFrames = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    delete (window as { __pestoFrames?: unknown }).__pestoFrames
  })

  it('is the colour drawn once the field lands, and the field is asked for once', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const instance = await meshLayerInstance()
    const release = hold(stub, 'it3')

    toggleButton(root, '3').click()
    store.flush()
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.iteration).toBe('3'))
    const callsBefore = stub.valuesCalls.length
    setInput(root, 'Colormap', 'cividis', 'change')
    setInput(root, 'Limits', 'minmax', 'change')
    release()
    await vi.waitFor(() => expect(lastFrame()?.iteration).toBe(3))
    await settle()

    expect(instance.setColormap.mock.calls.at(-1)).toEqual(['cividis', false])
    expect(lastFrame()?.colormap).toBe('cividis')
    expect(lastFrame()?.limits).toBe('minmax')
    expect(legendText(root)).toContain('Min-max')
    expect(stub.valuesCalls.length).toBe(callsBefore)
  })
})

describe('a statistic or realization change while the drawn group has nothing in the shown iteration', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    window.__pestoFrames = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    delete (window as { __pestoFrames?: unknown }).__pestoFrames
  })

  function drawnNotice(root: HTMLElement): string {
    return root.querySelector('[data-testid="iteration-drawn-notice"]')?.textContent ?? ''
  }

  it('keeps the notice, draws nothing and fetches nothing', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const instance = await meshLayerInstance()
    setInput(root, 'Parameter group', 'sy', 'change')
    toggleButton(root, '3').click()
    store.flush()
    await vi.waitFor(() => expect(drawnNotice(root)).toContain('group sy has nothing to draw in iteration 3'))
    const callsBefore = stub.valuesCalls.length

    setInput(root, 'Statistic', 'mean', 'change')
    await settle()
    expect(drawnNotice(root)).toContain('group sy has nothing to draw in iteration 3')
    expect(stub.valuesCalls.length).toBe(callsBefore)
    expect(legendText(root)).toBe('')
    expect(lastValues(instance).every((v) => Number.isNaN(v))).toBe(true)

    setInput(root, 'Statistic', 'value', 'change')
    setInput(root, 'Realization', '0')
    await settle()
    expect(drawnNotice(root)).toContain('group sy has nothing to draw in iteration 3')
    expect(stub.valuesCalls.length).toBe(callsBefore)
    expect(legendText(root)).toBe('')

    // A group this iteration does draw still fetches, and the notice goes.
    setInput(root, 'Parameter group', 'hk', 'change')
    await vi.waitFor(() => expect(drawnNotice(root)).toBe(''))
    expect(stub.valuesCalls.at(-1)).toEqual({ iteration: '3', group: null, realization: 'r017', stat: null })
  })
})

describe('a tab clicked before the map has loaded', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('saves the tab without wiping the map choices the run was left with', async () => {
    const stub = newStub()
    stub.savedView = {
      divider: 0.5,
      colormap: 'magma',
      reverse: true,
      scale: 'log10',
      limits_mode: 'minmax',
      group: 'sy',
      stat: 'q50',
      layer: 1,
      tab: 'config',
    }
    hold(stub, 'mesh')
    stubEnvironment(stub)
    const { mountMap } = await import('../src/views/map')
    const root = document.createElement('div')
    document.body.appendChild(root)
    mountMap(root, { config: CONFIG, state: stateWith(TWO_ITERATIONS), store: manualStore() })
    const obs = root.querySelector('#tab-obs') as HTMLElement
    await vi.waitFor(() => expect((root.querySelector('#tab-config') as HTMLElement).getAttribute('aria-selected')).toBe('true'))

    obs.click()
    // An earlier test's map can still flush a debounced write into this stub; only this page's counts.
    const ours = () => stub.puts.filter((body) => body.tab === 'obs')
    await vi.waitFor(() => expect(ours().length).toBe(1), { timeout: 2000 })

    expect(ours()[0]).toMatchObject({
      colormap: 'magma',
      reverse: true,
      scale: 'log10',
      limits_mode: 'minmax',
      group: 'sy',
      stat: 'q50',
      layer: 1,
      tab: 'obs',
    })
    expect(root.querySelector('canvas[data-drawn="true"]')).toBeNull()
  })
})

describe('the wait while a new iteration loads its tables', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  // Where a world point lands on the canvas after Camera.fit, read back through screenToWorld.
  function clickAtWorld(canvas: HTMLCanvasElement, wx: number, wy: number): void {
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
    const camera = new Camera(canvas.width, canvas.height)
    camera.fit([0, 2, 0, 1])
    const [x0, y0] = camera.screenToWorld(0, 0)
    const [x1, y1] = camera.screenToWorld(1, 1)
    canvas.dispatchEvent(new MouseEvent('click', { clientX: (wx - x0) / (x1 - x0), clientY: (wy - y0) / (y1 - y0) }))
  }

  function statusText(root: HTMLElement): string {
    return root.querySelector('.status-bar')?.textContent ?? ''
  }

  it('says the iteration is loading and reads no click until it has', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const release = hold(stub, 'tables3')

    toggleButton(root, '3').click()
    store.flush()
    await vi.waitFor(() => expect(statusText(root)).toContain('loading iteration 3'))
    clickAtWorld(canvas, 0.5, 0.5)
    expect(store.get().cells.size).toBe(0)
    expect(root.querySelector('.floating-bottom-right')?.textContent).not.toContain('cell 0')

    release()
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.iteration).toBe('3'))
    await settle()
    expect(statusText(root)).not.toContain('loading iteration')
    clickAtWorld(canvas, 0.5, 0.5)
    expect(Array.from(store.get().cells)).toEqual([0])
  })
})

describe('a run whose configuration does not name its first iteration', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  function noticeText(root: HTMLElement): string {
    return root.querySelector('[data-testid="map-notices"]')?.textContent ?? ''
  }

  it('opens on the lowest ingested iteration and says so', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store, newStub(), [artifact('par_ens/3')], { ...CONFIG, first_iteration: null })

    expect(stub.valuesCalls[0]?.iteration).toBe('3')
    expect(store.get().iteration).toBe(3)
    expect(noticeText(root)).toContain('first iteration was not recorded')
    expect(noticeText(root)).toContain('iteration 3')
  })

  it('says it is only trying iteration 0 when nothing names an iteration', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store, newStub(), [], { ...CONFIG, first_iteration: null })

    expect(stub.valuesCalls[0]?.iteration).toBe('0')
    expect(noticeText(root)).toContain('first iteration was not recorded')
    expect(noticeText(root)).toContain('iteration 0')
  })

  it('says nothing when the configuration names it', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store)

    expect(noticeText(root)).not.toContain('first iteration')
  })
})

describe('a pilot-point index that cannot be read', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  function noticeText(root: HTMLElement): string {
    return root.querySelector('[data-testid="map-notices"]')?.textContent ?? ''
  }

  it.each([404, 500])('says so, with the reason, when the index answers %i', async (status) => {
    const stub = newStub()
    stub.ppProblem = { status, title: 'pp_index could not be read', detail: 'failed to read pp_index.json: no such file' }
    const { root } = await mountedWith(manualStore(), stub)

    expect(noticeText(root)).toContain('The pilot-point index could not be read')
    expect(noticeText(root)).toContain('failed to read pp_index.json: no such file')
    // With no index, the group it would have interpolated is not offered as one.
    const options = Array.from(root.querySelectorAll('[aria-label="Parameter group"] option')).map((o) => o.textContent)
    expect(options.some((text) => text?.includes('pp'))).toBe(false)
  })

  it('says nothing when the index reads', async () => {
    const { root } = await mountedWith(manualStore())

    expect(noticeText(root)).not.toContain('pilot-point index')
  })
})
