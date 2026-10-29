// @vitest-environment jsdom
//
// Select base in the Obs tab heading row (LD-6) and the word base in the map's labels: one click
// selects the shown iteration's base, an iteration with none says why and keeps the selection, and
// the legend names the drawn realization base when it is. The real map screen against a stubbed
// fetch, with the GL context and the shared MeshLayer double mocked.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
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

vi.mock('../src/gl/mesh-layer', async (importOriginal) =>
  (await import('./support/mesh-layer-mock')).meshLayerMockModule(await importOriginal()),
)

const CONFIG: RunConfig = {
  case: 'test_run',
  n_par: 2,
  n_real: 2,
  base_realization: true,
  n_iterations: null,
  noptmax: null,
  first_iteration: 3,
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

// Two unit cells side by side, one layer, one group.
const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 1, bounds: [0, 2, 0, 1], crs: null, tag: 'base' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PAR_TABLE = tableToIPC(tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }), 'stream')

// Iteration 3's base is b0; iteration 5 has no base.
const REALS: Record<string, string[]> = { '3': ['b0', 'r1'], '5': ['r1', 'r2'] }
const BASE: Record<string, { name: string | null; reason: string | null }> = {
  '3': { name: 'b0', reason: null },
  '5': { name: null, reason: 'iteration 5 has no base realization' },
}

interface Stub {
  base: string[]
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function stubEnvironment(): Stub {
  const stub: Stub = { base: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path, search] = url.split('?')
      const query = new URLSearchParams(search ?? '')
      const iteration = query.get('iteration') ?? '3'
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
        case '/api/run/meta':
          return respond({ status: 200, bytes: PAR_TABLE })
        case '/api/run/grid/parmap':
          return respond({ status: 200, bytes: bytesOf(new Int32Array([0, 1])) })
        case '/api/run/grid/cells/cell':
          return respond({ status: 200, bytes: bytesOf(new Int32Array([0, 1])) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(new Int32Array([0, 0])) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 404, body: { title: 'no point positions were recorded for that iteration', status: 404 } })
        case '/api/run/reals':
          return respond({ status: 200, bytes: tableToIPC(tableFromArrays({ realization: REALS[iteration] ?? [] }), 'stream') })
        case '/api/run/reals/base': {
          stub.base.push(iteration)
          const answer = BASE[iteration]
          return respond({ status: 200, body: { iteration: Number(iteration), name: answer.name, note: null, reason: answer.reason } })
        }
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(new Float32Array([1, 2])) })
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
  return stub
}

// A hand-stepped store: nothing reaches a subscriber until flush() is called.
function manualStore(): SelectionStore {
  return createSelectionStore({ initial: emptySelection('test_run', 3), schedule: () => {} })
}

async function mounted(store: SelectionStore): Promise<{ root: HTMLElement; stub: Stub }> {
  const stub = stubEnvironment()
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
  mountMap(root, { config: CONFIG, state: baseState(), store })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  return { root, stub }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const chipOf = (root: HTMLElement): HTMLButtonElement =>
  root.querySelector('#panel-obs .obs-heading-row button.base-chip') as HTMLButtonElement
const reasonOf = (root: HTMLElement): string => root.querySelector('#base-chip-reason')?.textContent ?? ''
const legendText = (root: HTMLElement): string => root.querySelector('.floating-bottom-left')?.textContent ?? ''
const selectedNotice = (root: HTMLElement): string =>
  root.querySelector('[data-testid="iteration-selected-notice"]')?.textContent ?? ''

async function chipReady(root: HTMLElement): Promise<void> {
  await vi.waitFor(() => expect(chipOf(root).disabled).toBe(false))
}

// Moves the realization slider, which writes reals to the store as the map's own choice.
async function drawRealization(root: HTMLElement, store: SelectionStore, index: number, name: string): Promise<void> {
  const slider = root.querySelector('[aria-label="Realization"]') as HTMLInputElement
  slider.value = String(index)
  slider.dispatchEvent(new Event('input'))
  store.flush()
  await vi.waitFor(() => expect(store.get().reals).toEqual(new Set([name])))
  await settle()
}

describe('Select base in the Obs heading row', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('sits at the right of the Obs heading, not in the header, and asks for the shown iteration\'s base once', async () => {
    const store = manualStore()
    const { root, stub } = await mounted(store)
    await chipReady(root)

    const chip = chipOf(root)
    expect(chip.textContent).toBe('Select base')
    expect(chip.closest('.obs-heading-actions')).not.toBeNull()
    expect(root.querySelector('#panel-obs .obs-heading-row .heading')?.textContent).toBe('Obs')
    expect(root.querySelector('.header button.base-chip')).toBeNull()
    // The header keeps its plain fact chip.
    expect(root.querySelector('.header')?.textContent).toContain('2 reals')
    expect(root.querySelector('.header')?.textContent).toContain('base alive')
    expect(stub.base).toEqual(['3'])
  })

  it('writes reals {base} from the header on a click, and the realization notice stays silent', async () => {
    const store = manualStore()
    const { root } = await mounted(store)
    await chipReady(root)
    await drawRealization(root, store, 1, 'r1')
    const heard: string[][] = []
    store.subscribe(
      (s) => s.reals,
      (_next, _prev, origins) => heard.push([...origins]),
    )

    chipOf(root).click()
    store.flush()

    expect(store.get().reals).toEqual(new Set(['b0']))
    expect(heard).toEqual([['header']])
    expect(chipOf(root).getAttribute('aria-pressed')).toBe('true')
    expect(selectedNotice(root)).toBe('')
  })

  it('says when the new iteration has no base, keeps the selection, and counts it as missing', async () => {
    const store = manualStore()
    const { root, stub } = await mounted(store)
    await chipReady(root)
    await drawRealization(root, store, 1, 'r1')
    chipOf(root).click()
    store.flush()

    store.set({ iteration: 5 }, 'test')
    store.flush()

    await vi.waitFor(() => expect(reasonOf(root)).toBe('ℹ iteration 5 has no base realization'))
    expect(chipOf(root).textContent).toBe('Select base')
    expect(chipOf(root).disabled).toBe(true)
    expect(chipOf(root).title).toBe('iteration 5 has no base realization')
    expect(store.get().reals).toEqual(new Set(['b0']))
    await vi.waitFor(() => expect(selectedNotice(root)).toContain('1 selected realization is not in iteration 5'))
    expect(selectedNotice(root)).toContain('The selection is kept; switching back shows them again.')
    expect(stub.base).toEqual(['3', '5'])
  })

  it('names the drawn realization base in the legend and the status bar only when it is the base', async () => {
    const store = manualStore()
    const { root } = await mounted(store)
    await chipReady(root)

    // b0 is the first name of iteration 3, so it is drawn first.
    await vi.waitFor(() => expect(legendText(root)).toContain('G1 · base'))
    expect(root.textContent).toContain('b0 · base')

    await drawRealization(root, store, 1, 'r1')
    await vi.waitFor(() => expect(legendText(root)).toContain('G1'))
    expect(legendText(root)).not.toContain('base')
    expect(root.textContent).not.toContain('r1 · base')
  })

  it('shift-click adds base, and a second plain click selects all again', async () => {
    const store = manualStore()
    const { root } = await mounted(store)
    await chipReady(root)
    await drawRealization(root, store, 1, 'r1')

    chipOf(root).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    store.flush()
    expect(store.get().reals).toEqual(new Set(['r1', 'b0']))

    chipOf(root).click()
    store.flush()
    expect(store.get().reals).toEqual(new Set(['b0']))
    chipOf(root).click()
    store.flush()
    expect(store.get().reals).toBe('all')
  })

  it('keeps the same chip, with its state, when a theme change repaints the header', async () => {
    const store = manualStore()
    const { root, stub } = await mounted(store)
    await chipReady(root)
    const before = chipOf(root)

    const theme = root.querySelector('select[aria-label="Theme"]') as HTMLSelectElement
    theme.value = 'dark'
    theme.dispatchEvent(new Event('change'))

    expect(chipOf(root)).toBe(before)
    expect(before.isConnected).toBe(true)
    expect(before.disabled).toBe(false)
    expect(before.textContent).toBe('Select base')
    expect(stub.base).toEqual(['3'])
  })
})
