// @vitest-environment jsdom
//
// The tools card at the map's top right (LD-1): Plan view and Section view, then Draw section
// line, Lasso sites and Fit to extent on one row, then the exaggeration row, then one reason line
// per disabled button. The where notice sits above the readout, outside the left stack. The real
// map screen against a stubbed fetch, with the GL context and the shared MeshLayer double mocked.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { Camera } from '../src/gl/camera'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import { renderSectionControls } from '../src/ui/section-controls'
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

const SECTION_OPEN = { available: true, blockedBy: [] }

function baseState(section: IngestState['capabilities']['section'] = SECTION_OPEN): IngestState {
  return {
    fresh: true,
    artifacts: [],
    capabilities: {
      map: { available: true, blockedBy: [] },
      stats: { available: true, blockedBy: [] },
      chips: { available: true, blockedBy: [] },
      obs: { available: true, blockedBy: [] },
      section,
    },
    ingestSeconds: null,
    cacheBytes: null,
  }
}

const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 2, bounds: [0, 2, 0, 1], origin: [0, 0], crs: null, tag: 'tools', has_idomain: true }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1', 'p2', 'p3'], pargp: ['G1', 'G1', 'G1', 'G1'], partrans: ['none', 'none', 'none', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path] = url.split('?')
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
      const meta = (dtype: string) => ({ 'X-Pesto-Meta': JSON.stringify({ dtype }) })
      switch (path) {
        case '/api/run/grid/mesh':
          return respond({ status: 200, body: MESH_BODY })
        case '/api/run/grid/mesh/positions':
          return respond({ status: 200, bytes: bytesOf(POSITIONS), headers: meta('<f4') })
        case '/api/run/grid/mesh/cell_index':
          return respond({ status: 200, bytes: bytesOf(CELL_INDEX), headers: meta('<f4') })
        case '/api/run/grid/mesh/indices':
          return respond({ status: 200, bytes: bytesOf(INDICES), headers: meta('<u4') })
        case '/api/run/grid/idomain':
          return respond({ status: 200, bytes: bytesOf(new Int32Array([1, 1, 1, 1])) })
        case '/api/run/grid/parmap':
          return respond({ status: 200, bytes: bytesOf(new Int32Array([0, 1, 2, 3])) })
        case '/api/run/meta':
          return respond({ status: 200, bytes: PAR_TABLE })
        case '/api/run/grid/cells/cell':
          return respond({ status: 200, bytes: bytesOf(new Int32Array([0, 1, 0, 1])) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(new Int32Array([0, 0, 1, 1])) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 404, body: { title: 'no point positions were recorded for that iteration', status: 404 } })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(new Float32Array([10, 20, 30, 40])) })
        case '/api/run/grid/pp':
          return respond({ status: 200, body: { groups: [], not_interpolable: [], notes: [] } })
        case '/api/run/link/par':
          return respond({ status: 404, body: { title: 'not found', status: 404, detail: 'no parameter links in this test', artifact: 'par_links' } })
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

// Every ResizeObserver the map makes, so a test can say an element changed size.
const observers: { callback: ResizeObserverCallback; target: Element | null }[] = []

function stubResizeObserver(): void {
  observers.length = 0
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

interface Mounted {
  root: HTMLElement
  canvas: HTMLCanvasElement
  store: SelectionStore
}

const recording = createRecording2d()

async function mounted(section: IngestState['capabilities']['section'] = SECTION_OPEN): Promise<Mounted> {
  stubResizeObserver()
  stubFetch()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === '2d' ? recording.ctx : null) as typeof HTMLCanvasElement.prototype.getContext)
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
  mountMap(root, { config: CONFIG, state: baseState(section), store })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  const canvas = root.querySelector('canvas') as HTMLCanvasElement
  return { root, canvas, store }
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!found) throw new Error(`no button reads ${text}`)
  return found as HTMLButtonElement
}

const card = (root: HTMLElement): HTMLElement => root.querySelector('.floating-top-right .section-controls') as HTMLElement
const toolsRow = (root: HTMLElement): HTMLElement => root.querySelector('[data-testid="map-tools"]') as HTMLElement

describe('the tools card at the map top right', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('holds the toggle, the tools row, the exaggeration row and the reasons, in that order', async () => {
    const { root } = await mounted()
    const rows = Array.from(card(root).children)
    expect(rows.map((el) => el.className)).toEqual(['section-toggle-row', 'tools-row', 'section-ve-row label', 'tools-reasons'])
    expect(Array.from(rows[0].querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Plan view', 'Section view'])
    const row = toolsRow(root)
    expect(row.getAttribute('role')).toBe('group')
    expect(row.getAttribute('aria-label')).toBe('Map tools')
    expect(Array.from(row.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Draw section line',
      'Lasso sites',
      'Fit to extent',
    ])
  })

  it('leaves no tool button in the left stack', async () => {
    const { root } = await mounted()
    const left = root.querySelector('.floating-top-left') as HTMLElement
    const words = Array.from(left.querySelectorAll('button')).map((b) => b.textContent)
    for (const word of ['Draw section line', 'Lasso sites', 'Fit to extent']) expect(words).not.toContain(word)
    expect(left.querySelector('.lasso-button, .section-button')).toBeNull()
  })

  it('fits the plan with Fit to extent exactly as the Home key does, and says so in its title', async () => {
    const { root, canvas } = await mounted()
    const fit = buttonByText(toolsRow(root), 'Fit to extent')
    expect(fit.title).toBe('Fit the model into the space the cards leave free. Same as the Home key.')
    const fitSpy = vi.spyOn(Camera.prototype, 'fitAnimated')
    fit.click()
    expect(fitSpy).toHaveBeenCalledTimes(1)
    canvas.focus()
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }))
    expect(fitSpy).toHaveBeenCalledTimes(2)
    expect(fitSpy.mock.calls[1][0]).toEqual(fitSpy.mock.calls[0][0])
  })
})

const reasonLines = (root: HTMLElement): { id: string; text: string }[] =>
  Array.from(root.querySelectorAll('.tools-reasons > *'))
    .filter((el) => !(el as HTMLElement).hidden)
    .map((el) => ({ id: el.id, text: el.textContent ?? '' }))

describe('the tools say what they do, and a disabled one says why with its name', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('titles Draw section line with what it does, and a disabled lasso with its reason', async () => {
    const { root } = await mounted()
    const line = root.querySelector('button[aria-label="Draw section line"]') as HTMLButtonElement
    expect(line.disabled).toBe(false)
    expect(line.title).toBe('Click two points on the plan to draw a section line. Esc stops.')
    const lasso = buttonByText(toolsRow(root), 'Lasso sites')
    expect(lasso.disabled).toBe(true)
    expect(lasso.title).toBe('no observation site dots are drawn; colour the map by observations')
  })

  it('shows one named reason line per disabled button, in button order', async () => {
    const { root } = await mounted()
    expect(reasonLines(root)).toEqual([
      { id: 'section-view-reason', text: 'ℹ Section view: draw a section line on the plan first' },
      { id: 'lasso-reason', text: 'ℹ Lasso sites: no observation site dots are drawn; colour the map by observations' },
    ])
    expect(buttonByText(root, 'Section view').getAttribute('aria-describedby')).toBe('section-view-reason')
    expect(buttonByText(toolsRow(root), 'Lasso sites').getAttribute('aria-describedby')).toBe('lasso-reason')
    const line = root.querySelector('button[aria-label="Draw section line"]') as HTMLButtonElement
    expect(line.getAttribute('aria-describedby')).toBeNull()
  })

  it('names Draw section line in its reason, and puts the reason in its title, when the run has no section', async () => {
    const reason = 'the grid file records no layer bottoms'
    const { root } = await mounted({ available: false, blockedBy: [{ artifact: 'grid', reason }] })
    const line = root.querySelector('button[aria-label="Draw section line"]') as HTMLButtonElement
    expect(line.disabled).toBe(true)
    expect(line.title).toBe(reason)
    expect(line.getAttribute('aria-describedby')).toBe('section-tool-reason')
    expect(reasonLines(root).map((r) => r.text)).toEqual([
      `ℹ Section view: ${reason}`,
      `ℹ Draw section line: ${reason}`,
      'ℹ Lasso sites: no observation site dots are drawn; colour the map by observations',
    ])
  })
})

describe('the Section view reason line', () => {
  it('names Section view for a block and a failure, and says loading plainly', () => {
    const host = document.createElement('div')
    const controls = renderSectionControls(host, { onPlan: () => {}, onSection: () => {} })
    const line = host.querySelector('#section-view-reason') as HTMLElement
    const toggle = buttonByText(host, 'Section view')
    expect(line.textContent).toBe('ℹ Section view: draw a section line on the plan first')
    expect(toggle.title).toBe('draw a section line on the plan first')

    controls.setHasLine(true)
    expect(line.hidden).toBe(true)
    expect(toggle.getAttribute('aria-describedby')).toBeNull()

    controls.setLoading(true)
    expect(line.textContent).toBe('loading the section')
    expect(line.hidden).toBe(false)
    controls.setLoading(false)

    controls.setFailure('<b>the server</b> did not answer')
    expect(line.textContent).toBe('⚠ Section view: <b>the server</b> did not answer')
    expect(line.querySelector('b')).toBeNull()
    expect(toggle.getAttribute('aria-describedby')).toBe('section-view-reason')
    controls.dispose()
  })
})

describe('the where notice', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('sits in the map area above the readout, not in the left stack or inside the readout', async () => {
    const { root, store } = await mounted()
    const where = root.querySelector('[data-testid="selection-where"]') as HTMLElement
    expect(where.parentElement?.classList.contains('map-area')).toBe(true)
    expect(where.classList.contains('where-notice')).toBe(true)
    expect(where.closest('.floating-top-left')).toBeNull()

    store.set({ pars: new Set(['p0']) }, 'params')
    await vi.waitFor(() => expect(where.hidden).toBe(false))
    const text = where.textContent ?? ''
    expect(text).toContain('The cells of the selected parameters could not be read')
    expect(root.querySelector('.floating-bottom-right')?.textContent ?? '').not.toContain(text)
  })

  it('tracks the readout height, so it stays directly above the readout', async () => {
    const { root } = await mounted()
    const area = root.querySelector('.map-area') as HTMLElement
    const readout = root.querySelector('.floating-bottom-right') as HTMLElement
    Object.defineProperty(readout, 'offsetHeight', { configurable: true, value: 57 })
    const watcher = observers.find((o) => o.target === readout)
    expect(watcher).toBeDefined()
    watcher!.callback([], {} as ResizeObserver)
    expect(area.style.getPropertyValue('--readout-height')).toBe('57px')
  })
})
