// @vitest-environment jsdom
//
// The Data and Colours cards on a mounted map (LD-2): where they sit, what each holds, how each
// folds on its own, and the Colours card's folded line.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 1, nlay: 2, bounds: [0, 100, 0, 100], crs: 'EPSG:1', tag: 'tag1' }
const POSITIONS = new Float32Array([0, 0, 100, 0, 100, 100, 0, 100])
const CELL_INDEX = new Float32Array([0, 0, 0, 0])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0])
const CELL_ARRAY = new Int32Array([0])
const LAYER_ARRAY = new Int32Array([0])
const FIELD = new Float32Array([42])
const PAR_TABLE = tableToIPC(tableFromArrays({ parnme: ['p0'], pargp: ['G1'], partrans: ['none'] }), 'stream')
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base', 'r1'] }), 'stream')
const VIEW_STATE_BODY = {
  divider: 0.72,
  colormap: 'viridis',
  reverse: false,
  scale: 'linear',
  limits_mode: 'robust',
  group: null,
  stat: 'value',
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function stubEnvironment(): void {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const [path] = (typeof input === 'string' ? input : input.toString()).split('?')
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
}

// jsdom lays nothing out, so the map's height is given here.
function stubMapHeight(height: number): void {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('map-area') ? height : 0
  })
}

// The left stack always holds more than its room, whatever is folded.
function stubStackOverflow(): void {
  const inStack = (el: HTMLElement) => el.classList.contains('floating-top-left')
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return inStack(this) ? 1000 : 0
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return inStack(this) ? 400 : 0
  })
}

async function mountReady(): Promise<HTMLElement> {
  stubEnvironment()
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: baseState() })
  await vi.waitFor(() => expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull())
  return root
}

const card = (root: HTMLElement, key: string) => root.querySelector(`[data-fold="${key}"]`) as HTMLElement
const foldButton = (root: HTMLElement, key: string) => card(root, key).querySelector(':scope > .fold-button') as HTMLButtonElement
const summary = (root: HTMLElement, key: string) => card(root, key).querySelector(':scope > .fold-summary')?.textContent
const rowLabels = (body: Element) =>
  Array.from(body.querySelectorAll(':scope > .card-row > .card-row-label')).map((label) => label.textContent)

// Node's own experimental localStorage shadows jsdom's and is undefined here, so each test brings one.
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  }
}

let localStorage: Pick<Storage, 'getItem' | 'setItem'>

describe('the Data and Colours cards', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage = memoryStorage()
    vi.stubGlobal('localStorage', localStorage)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('stacks Data, Colours and then Overlays at the top left, in place of one Controls card', async () => {
    const root = await mountReady()
    const stack = Array.from(root.querySelector('.floating-top-left')!.children)
    expect(stack.slice(0, 3).map((el) => el.getAttribute('data-fold'))).toEqual(['data', 'colours', 'overlays'])
    expect(root.querySelector('[data-fold="controls"]')).toBeNull()
    expect(foldButton(root, 'data').getAttribute('aria-label')).toBe('Data')
    expect(foldButton(root, 'colours').getAttribute('aria-label')).toBe('Colours')
  })

  it('holds the Data, Colours, Overlays and Basemap cards in the left stack and nothing else', async () => {
    const root = await mountReady()
    const stack = root.querySelector('.floating-top-left') as HTMLElement
    await vi.waitFor(() => expect(stack.querySelector(':scope > [data-fold="basemap"]')).not.toBeNull())
    expect(Array.from(stack.children).map((el) => el.getAttribute('data-fold'))).toEqual(['data', 'colours', 'overlays', 'basemap'])
  })

  it("puts the parameter group select in the Data card's Group row, with no card of its own", async () => {
    const root = await mountReady()
    const data = card(root, 'data').querySelector('.fold-body') as HTMLElement
    await vi.waitFor(() => expect(data.querySelector('select[aria-label="Parameter group"]:not([disabled])')).not.toBeNull())
    const select = data.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
    const row = select.closest('.card-row') as HTMLElement
    expect(row.querySelector('.card-row-label')?.textContent).toBe('Group')
    const picker = select.closest('[data-colour-source="par"]') as HTMLElement
    expect(picker.classList.contains('floating')).toBe(false)
  })

  it('leaves the Iteration row empty with one iteration and the Colour by row empty with no observations', async () => {
    const root = await mountReady()
    const data = card(root, 'data').querySelector('.fold-body') as HTMLElement
    const control = (label: string) =>
      Array.from(data.querySelectorAll(':scope > .card-row')).find((row) => row.querySelector('.card-row-label')?.textContent === label)!
        .querySelector('.card-row-control') as HTMLElement
    expect(control('Iteration').childNodes.length).toBe(0)
    expect(control('Colour by').childNodes.length).toBe(0)
    expect(control('Time').childNodes.length).toBe(0)
    expect(root.querySelector('.iteration-toggle')).toBeNull()
  })

  it('puts the layer, statistic and realization rows in Data and the six colour rows in Colours', async () => {
    const root = await mountReady()
    const data = card(root, 'data').querySelector('.fold-body') as HTMLElement
    const colours = card(root, 'colours').querySelector('.fold-body') as HTMLElement
    expect(rowLabels(data)).toEqual(['Colour by', 'Group', 'Iteration', 'Layer', '', 'Statistic', 'Realization', 'Time'])
    expect(data.querySelector('input[aria-label="Layer"]')?.closest('.card-row')?.textContent).toContain('1 (0)')
    expect(data.querySelector('select[aria-label="Statistic"]')).not.toBeNull()
    expect(data.querySelector('input[aria-label="Realization"]')).not.toBeNull()
    expect(rowLabels(colours)).toEqual(['Colormap', 'Value scale', 'Limits', 'Colour steps', 'Centre on zero', 'Patterns'])
    expect(colours.querySelector('input[aria-label="Layer"]')).toBeNull()
    expect(colours.querySelector('.colours-obs-line')).not.toBeNull()
  })

  it('folds Colours on its own, stores it, and names the colour settings on its folded line', async () => {
    const root = await mountReady()
    foldButton(root, 'colours').click()
    expect(card(root, 'colours').getAttribute('data-folded')).toBe('true')
    expect(card(root, 'data').getAttribute('data-folded')).toBe('false')
    expect(localStorage.getItem('pesto.fold.colours')).toBe('folded')
    expect(localStorage.getItem('pesto.fold.data')).toBeNull()
    expect(summary(root, 'colours')).toBe('Colours: viridis · linear · robust 2–98% · smooth')
  })

  it('names the drawn group, layer and realization on the folded Data line, and follows the layer slider', async () => {
    const root = await mountReady()
    foldButton(root, 'data').click()
    await vi.waitFor(() => expect(summary(root, 'data')).toBe('Data: G1 · layer 1 (0) · base'))
    const slider = card(root, 'data').querySelector('input[aria-label="Layer"]') as HTMLInputElement
    slider.value = '1'
    slider.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(summary(root, 'data')).toBe('Data: G1 · layer 2 (1) · base'))
  })

  it('names a statistic on the folded Data line when one is drawn', async () => {
    const root = await mountReady()
    const select = card(root, 'data').querySelector('select[aria-label="Statistic"]') as HTMLSelectElement
    select.value = 'mean'
    select.dispatchEvent(new Event('change'))
    foldButton(root, 'data').click()
    await vi.waitFor(() => expect(summary(root, 'data')).toBe('Data: G1 · layer 1 (0) · mean'))
  })

  it('changes the Colours folded line when the colormap changes', async () => {
    const root = await mountReady()
    const select = card(root, 'colours').querySelector('select[aria-label="Colormap"]') as HTMLSelectElement
    select.value = 'magma'
    select.dispatchEvent(new Event('change'))
    // Open, the line is the title alone; folding shows the settings it kept up with meanwhile.
    expect(summary(root, 'colours')).toBe('Colours')
    foldButton(root, 'colours').click()
    expect(summary(root, 'colours')).toBe('Colours: magma · linear · robust 2–98% · smooth')
  })

  it('starts both cards folded on a short map when the viewer never chose', async () => {
    stubMapHeight(600)
    const root = await mountReady()
    expect(foldButton(root, 'data').getAttribute('aria-expanded')).toBe('false')
    expect(foldButton(root, 'colours').getAttribute('aria-expanded')).toBe('false')
    expect(foldButton(root, 'overlays').getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps a stored choice over the short-map start', async () => {
    localStorage.setItem('pesto.fold.data', 'open')
    stubMapHeight(600)
    const root = await mountReady()
    expect(foldButton(root, 'data').getAttribute('aria-expanded')).toBe('true')
    expect(foldButton(root, 'colours').getAttribute('aria-expanded')).toBe('false')
  })

  it('folds the other open cards and stores them when an opened card would not fit, and keeps it open', async () => {
    const root = await mountReady()
    await vi.waitFor(() => expect(card(root, 'basemap')).not.toBeNull())
    foldButton(root, 'colours').click()
    expect(card(root, 'data').getAttribute('data-folded')).toBe('false')
    stubStackOverflow()
    foldButton(root, 'colours').click()
    expect(card(root, 'colours').getAttribute('data-folded')).toBe('false')
    expect(card(root, 'data').getAttribute('data-folded')).toBe('true')
    expect(localStorage.getItem('pesto.fold.data')).toBe('folded')
    expect(localStorage.getItem('pesto.fold.colours')).toBe('open')
    // Folding a card never makes room for anything, so it folds nothing else.
    foldButton(root, 'colours').click()
    expect(card(root, 'data').getAttribute('data-folded')).toBe('true')
  })

  it('at first look folds Basemap, Overlays and then Colours when the stack would not fit, keeps Data open and stores nothing', async () => {
    stubStackOverflow()
    const root = await mountReady()
    await vi.waitFor(() => expect(card(root, 'basemap')?.getAttribute('data-folded')).toBe('true'))
    expect(['data', 'colours', 'overlays', 'basemap'].map((key) => card(root, key).getAttribute('data-folded'))).toEqual([
      'false',
      'true',
      'true',
      'true',
    ])
    for (const key of ['data', 'colours', 'overlays', 'basemap']) expect(localStorage.getItem(`pesto.fold.${key}`)).toBeNull()
  })

  it('at first look leaves a card the viewer chose open', async () => {
    localStorage.setItem('pesto.fold.overlays', 'open')
    stubStackOverflow()
    const root = await mountReady()
    await vi.waitFor(() => expect(card(root, 'basemap')?.getAttribute('data-folded')).toBe('true'))
    expect(card(root, 'overlays').getAttribute('data-folded')).toBe('false')
    expect(card(root, 'colours').getAttribute('data-folded')).toBe('true')
    expect(card(root, 'data').getAttribute('data-folded')).toBe('false')
  })

  it('folds the open stack cards and stores them when the viewer opens a legend that would push them out of sight', async () => {
    const root = await mountReady()
    await vi.waitFor(() => expect(card(root, 'basemap')).not.toBeNull())
    foldButton(root, 'legend').click()
    stubStackOverflow()
    foldButton(root, 'legend').click()
    expect(card(root, 'legend').getAttribute('data-folded')).toBe('false')
    for (const key of ['data', 'colours', 'overlays', 'basemap']) {
      expect(card(root, key).getAttribute('data-folded')).toBe('true')
      expect(localStorage.getItem(`pesto.fold.${key}`)).toBe('folded')
    }
  })

  it('folds the lowest cards the viewer never chose, quietly, when the legend grows on its own', async () => {
    const observed: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private entry: { callback: ResizeObserverCallback; targets: Element[] }
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, targets: [] }
          observed.push(this.entry)
        }
        observe(target: Element): void {
          this.entry.targets.push(target)
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    )
    localStorage.setItem('pesto.fold.overlays', 'open')
    const root = await mountReady()
    await vi.waitFor(() => expect(card(root, 'basemap')).not.toBeNull())
    expect(['data', 'colours', 'overlays', 'basemap'].map((key) => card(root, key).getAttribute('data-folded'))).toEqual([
      'false',
      'false',
      'false',
      'false',
    ])
    stubStackOverflow()
    const legend = card(root, 'legend')
    for (const entry of observed) {
      if (entry.targets.includes(legend)) entry.callback([], {} as ResizeObserver)
    }
    expect(['data', 'colours', 'overlays', 'basemap'].map((key) => card(root, key).getAttribute('data-folded'))).toEqual([
      'false',
      'true',
      'false',
      'true',
    ])
    for (const key of ['data', 'colours', 'basemap']) expect(localStorage.getItem(`pesto.fold.${key}`)).toBeNull()
  })

  it('starts both cards open on a tall map', async () => {
    stubMapHeight(900)
    const root = await mountReady()
    expect(foldButton(root, 'data').getAttribute('aria-expanded')).toBe('true')
    expect(foldButton(root, 'colours').getAttribute('aria-expanded')).toBe('true')
  })
})
