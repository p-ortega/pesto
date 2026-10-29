// @vitest-environment jsdom
//
// Switching the iteration from the map's floating controls: the toggle itself,
// and the map screen reloading everything that depends on the iteration. The
// map-screen cases use the same harness as map-store.test.ts: the real map
// against a stubbed fetch, with only the two GL modules mocked.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactRow, IngestState } from '../src/data/client'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import { iterationsFrom, renderIterationToggle } from '../src/ui/iteration-toggle'
import type { RunConfig } from '../src/views/map'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

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

function artifact(name: string, state = 'ok'): ArtifactRow {
  return { name, kind: name.split('/')[0], state, reason: null, stale: false, seconds: null, bytes: 0 }
}

describe('iterationsFrom', () => {
  it('lists the ok parameter ensembles, sorted and unique, and nothing else', () => {
    const state = {
      artifacts: [
        artifact('par_ens/3'),
        artifact('par_ens/0'),
        artifact('par_agg/0'),
        artifact('par_ens/5', 'failed'),
        artifact('par_ens/3'),
      ],
    } as unknown as IngestState
    expect(iterationsFrom(state)).toEqual([0, 3])
  })

  it('is empty when the ingest holds no artifacts', () => {
    expect(iterationsFrom({ artifacts: [] } as unknown as IngestState)).toEqual([])
  })
})

describe('renderIterationToggle', () => {
  it('shows one button per iteration in a labelled group, the current one pressed', () => {
    const el = document.createElement('div')
    renderIterationToggle(el, { iterations: [0, 3], current: 0, onChange: vi.fn() })

    const group = el.querySelector('[role="group"]') ?? el
    expect(group.getAttribute('aria-label')).toBe('Iteration')
    const buttons = Array.from(el.querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['0', '3'])
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    expectNoRunTogetherText(el, 'iteration toggle')
  })

  it('names each button with the word Iteration, not only its number', () => {
    const el = document.createElement('div')
    renderIterationToggle(el, { iterations: [0, 3], current: 0, onChange: vi.fn() })

    const buttons = Array.from(el.querySelectorAll('button'))
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Iteration 0', 'Iteration 3'])
  })

  it('carries the class the stylesheet uses to mark the pressed iteration', () => {
    const el = document.createElement('div')
    renderIterationToggle(el, { iterations: [0, 1], current: 1, onChange: vi.fn() })

    expect(el.classList.contains('iteration-toggle')).toBe(true)
    const css = readFileSync(resolve(__dirname, '../src/style.css'), 'utf8')
    expect(css).toContain(".iteration-toggle button[aria-pressed='true']")
  })

  it('calls onChange with the clicked iteration and moves the press with setCurrent', () => {
    const el = document.createElement('div')
    const onChange = vi.fn()
    const handle = renderIterationToggle(el, { iterations: [0, 3], current: 0, onChange })
    const buttons = Array.from(el.querySelectorAll('button'))

    buttons[1].click()
    expect(onChange).toHaveBeenCalledWith(3)

    handle.setCurrent(3)
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('starts with a visible Iteration label that screen readers skip', () => {
    const el = document.createElement('div')
    renderIterationToggle(el, { iterations: [0, 3], current: 0, onChange: vi.fn() })

    const first = el.firstElementChild as HTMLElement
    expect(first.tagName).toBe('SPAN')
    expect(first.classList.contains('label')).toBe(true)
    expect(first.textContent).toBe('Iteration')
    expect(first.getAttribute('aria-hidden')).toBe('true')
    expect(el.getAttribute('aria-label')).toBe('Iteration')
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['0', '3'])
    expect(el.style.alignItems).toBe('center')
  })

  it('passes the run-together check with the label before the buttons', () => {
    loadRealStylesheet()
    const el = document.createElement('div')
    document.body.appendChild(el)
    renderIterationToggle(el, { iterations: [0, 3], current: 0, onChange: vi.fn() })
    expectNoRunTogetherText(el, 'iteration toggle with label')
  })

  it.each([[[0]], [[]]])('draws nothing for %j', (iterations) => {
    const el = document.createElement('div')
    renderIterationToggle(el, { iterations, current: 0, onChange: vi.fn() })
    expect(el.children.length).toBe(0)
    expect(el.querySelector('button')).toBeNull()
  })
})

describe('renderIterationToggle as a card row', () => {
  it('drops the floating card and its own Iteration word, and keeps the group, its name and its buttons', () => {
    const el = document.createElement('div')
    renderIterationToggle(el, { iterations: [0, 1, 2], current: 0, onChange: vi.fn(), bare: true })

    expect(el.classList.contains('floating')).toBe(false)
    expect(el.classList.contains('iteration-toggle')).toBe(true)
    expect(el.getAttribute('role')).toBe('group')
    expect(el.getAttribute('aria-label')).toBe('Iteration')
    expect(el.querySelector('span.label')).toBeNull()
    expect(el.textContent).not.toContain('Iteration')
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Iteration 0',
      'Iteration 1',
      'Iteration 2',
    ])
  })

  it('without bare keeps its floating card and its Iteration word', () => {
    const el = document.createElement('div')
    renderIterationToggle(el, { iterations: [0, 1, 2], current: 0, onChange: vi.fn() })

    expect(el.classList.contains('floating')).toBe(true)
    expect(el.querySelector('span.label')?.textContent).toBe('Iteration')
    expect(el.querySelectorAll('button')).toHaveLength(3)
  })
})

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

const TWO_ITERATIONS = [artifact('par_ens/0'), artifact('par_ens/3'), artifact('par_agg/0')]

// Two unit cells side by side, one layer. Groups hk (rows 0 and 1) and sy
// (row 2) both place in iteration 0; iteration 3's map block has no sy row.
const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 2, bounds: [0, 2, 0, 1], crs: null, tag: 'iter' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['hk0', 'hk1', 'sy0'], pargp: ['hk', 'hk', 'sy'], partrans: ['none', 'none', 'none'] }),
  'stream',
)

interface IterationFixture {
  parmap: number[]
  cell: number[]
  layer: number[]
  reals: string[] | null
  fields: Record<string, number[]>
}

const ITERATIONS: Record<string, IterationFixture> = {
  '0': {
    parmap: [0, 1, 2],
    cell: [0, 1, 1],
    layer: [0, 0, 0],
    reals: ['base', 'r001', 'r017'],
    fields: { base: [1, 2, 3], r001: [4, 5, 6], r017: [7, 8, 9] },
  },
  '3': {
    parmap: [0, 1],
    cell: [0, 1],
    layer: [0, 0],
    reals: ['r017', 'base'],
    fields: { r017: [70, 80], base: [10, 20] },
  },
}

interface Stub {
  valuesCalls: { iteration: string; realization: string | null; stat: string | null }[]
  /** While set, every /values answer waits for it. */
  gate: Promise<void> | null
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function stubEnvironment(iterations: Record<string, IterationFixture> = ITERATIONS): Stub {
  const stub: Stub = { valuesCalls: [], gate: null }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path, search] = url.split('?')
      const query = new URLSearchParams(search ?? '')
      const iteration = query.get('iteration') ?? '0'
      const fixture = iterations[iteration]
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
          if (!fixture) return respond({ status: 404, body: { title: 'no such iteration', status: 404 } })
          return respond({ status: 200, bytes: bytesOf(new Int32Array(fixture.parmap)) })
        case '/api/run/grid/cells/cell':
          return respond({ status: 200, bytes: bytesOf(new Int32Array(fixture?.cell ?? [])) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(new Int32Array(fixture?.layer ?? [])) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 404, body: { title: 'no point positions were recorded for that iteration', status: 404 } })
        case '/api/run/reals': {
          if (!fixture?.reals) return respond({ status: 404, body: { title: 'no realization names', status: 404 } })
          return respond({ status: 200, bytes: tableToIPC(tableFromArrays({ realization: fixture.reals }), 'stream') })
        }
        case '/api/run/grid/values': {
          stub.valuesCalls.push({ iteration, realization: query.get('realization'), stat: query.get('stat') })
          if (stub.gate) await stub.gate
          const name = query.get('realization') ?? 'base'
          const field = fixture?.fields[name] ?? [0, 0]
          return respond({ status: 200, bytes: bytesOf(new Float32Array(field)) })
        }
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
  return stub
}

// A hand-stepped store: nothing reaches a subscriber until flush() is called.
function manualStore(): SelectionStore {
  return createSelectionStore({ initial: emptySelection('test_run', 0), schedule: () => {} })
}

async function mountedWith(
  store: SelectionStore,
  artifacts: ArtifactRow[] = TWO_ITERATIONS,
  iterations?: Record<string, IterationFixture>,
): Promise<{ root: HTMLElement; stub: Stub }> {
  const stub = stubEnvironment(iterations)
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
  mountMap(root, { config: CONFIG, state: stateWith(artifacts), store })
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
  const found = Array.from(group.querySelectorAll('button')).find((b) => b.textContent === label)
  return found as HTMLButtonElement
}

function sliderLabel(root: HTMLElement): string {
  return (root.querySelector('[aria-label="Realization"]') as HTMLInputElement).nextElementSibling?.textContent ?? ''
}

async function choose(root: HTMLElement, store: SelectionStore, label: string): Promise<void> {
  toggleButton(root, label).click()
  store.flush()
}

async function meshLayerInstance() {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer).mock.instances[0] as unknown as {
    setValues: ReturnType<typeof vi.fn>
  }
}

describe('switching the iteration', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    delete (window as { __pestoFrames?: unknown }).__pestoFrames
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('draws no toggle and asks for nothing extra when the ingest holds fewer than two iterations', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store, [])
    expect(root.querySelector('[aria-label="Iteration"]')).toBeNull()
    expect(stub.valuesCalls.length).toBe(1)
  })

  it("puts the toggle in the Data card's Iteration row with the first iteration pressed", async () => {
    const { root } = await mountedWith(manualStore())
    const toggle = root.querySelector('[aria-label="Iteration"]') as HTMLElement
    const buttons = Array.from(toggle.querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['0', '3'])
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    expect(root.querySelector('.floating-top-left')?.contains(buttons[0])).toBe(true)
    const row = toggle.closest('.card-row') as HTMLElement
    expect(row.closest('[data-fold]')?.getAttribute('data-fold')).toBe('data')
    expect(row.querySelector('.card-row-label')?.textContent).toBe('Iteration')
    // The row's label says Iteration, so the toggle neither floats nor says it again.
    expect(toggle.classList.contains('floating')).toBe(false)
    expect(Array.from(toggle.querySelectorAll('span')).map((s) => s.textContent)).not.toContain('Iteration')
    expectNoRunTogetherText(root.querySelector('.floating-top-left') as HTMLElement, 'map controls with toggle')
  })

  it('asks for the same realization by name in the new iteration and moves the slider to it', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    setInput(root, 'Realization', '2')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.realization).toBe('r017'))
    expect(sliderLabel(root)).toBe('r017')

    await choose(root, store, '3')

    await vi.waitFor(() => {
      expect(stub.valuesCalls.at(-1)).toEqual({ iteration: '3', realization: 'r017', stat: null })
    })
    expect(store.get().iteration).toBe(3)
    expect((root.querySelector('[aria-label="Realization"]') as HTMLInputElement).value).toBe('0')
    expect(sliderLabel(root)).toBe('r017')
    expect(toggleButton(root, '3').getAttribute('aria-pressed')).toBe('true')
    expect(toggleButton(root, '0').getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps asking for the new iteration after a later control move', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    await choose(root, store, '3')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.iteration).toBe('3'))

    setInput(root, 'Realization', '1')
    await vi.waitFor(() => {
      expect(stub.valuesCalls.at(-1)).toEqual({ iteration: '3', realization: 'base', stat: null })
    })
  })

  it('stamps the frame drawn after the switch with the iteration', async () => {
    window.__pestoFrames = []
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    expect(window.__pestoFrames.at(-1)?.iteration).toBe(0)

    await choose(root, store, '3')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.iteration).toBe('3'))
    await vi.waitFor(() => expect(window.__pestoFrames?.at(-1)?.iteration).toBe(3))
  })

  it("shows each iteration's own unmapped groups in the Params panel", async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const unmapped = () => root.querySelector('.params-unmapped')?.textContent ?? ''
    await vi.waitFor(() => expect(root.querySelector('.params-panel, .params-table, [data-testid]')).not.toBeNull())
    expect(unmapped()).not.toContain('sy')

    await choose(root, store, '3')
    await vi.waitFor(() => expect(unmapped()).toContain('sy'))

    await choose(root, store, '0')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.iteration).toBe('0'))
    await vi.waitFor(() => expect(unmapped()).not.toContain('sy'))
  })

  it("names the new iteration's unmapped groups in the group picker too", async () => {
    const store = manualStore()
    const { root } = await mountedWith(store)
    await choose(root, store, '3')
    await vi.waitFor(() => {
      expect(root.querySelector('.floating-top-left')?.textContent).toContain('1 group unmapped')
    })
  })

  it('follows an iteration set by another view and moves the press', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)

    store.set({ iteration: 3 }, 'other-view')
    store.flush()

    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.iteration).toBe('3'))
    expect(toggleButton(root, '3').getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps drawing the old iteration and says so when the new one cannot be read', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)

    store.set({ iteration: 9 }, 'other-view')
    store.flush()

    await vi.waitFor(() => {
      expect(root.querySelector('[data-testid="map-notices"]')?.textContent).toContain('Iteration 9 could not be read')
    })
    expect(store.get().iteration).toBe(0)
    expect(toggleButton(root, '0').getAttribute('aria-pressed')).toBe('true')
    expect(stub.valuesCalls.every((c) => c.iteration === '0')).toBe(true)
  })

  it('drops a field fetched for the old iteration that lands after the switch has loaded', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const instance = await meshLayerInstance()
    // From here animation frames wait for the test, so the new fetch is held back too.
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        frames.push(cb)
        return 1
      }),
    )
    let release: () => void = () => {}
    stub.gate = new Promise((resolve) => {
      release = resolve
    })

    setInput(root, 'Realization', '2')
    frames.splice(0).forEach((cb) => cb(0))
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)).toEqual({ iteration: '0', realization: 'r017', stat: null }))
    await choose(root, store, '3')
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))
    const before = instance.setValues.mock.calls.length

    release()
    stub.gate = null
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(instance.setValues.mock.calls.length).toBe(before)

    frames.splice(0).forEach((cb) => cb(0))
    await vi.waitFor(() => expect(instance.setValues.mock.calls.length).toBeGreaterThan(before))
    expect(Array.from(instance.setValues.mock.calls.at(-1)?.[0] as Float32Array)).toEqual([70, 80])
  })
})


function drawnNotice(root: HTMLElement): string {
  return root.querySelector('[data-testid="iteration-drawn-notice"]')?.textContent ?? ''
}

function selectedNotice(root: HTMLElement): string {
  return root.querySelector('[data-testid="iteration-selected-notice"]')?.textContent ?? ''
}

function lastValues(instance: { setValues: ReturnType<typeof vi.fn> }): number[] {
  return Array.from(instance.setValues.mock.calls.at(-1)?.[0] as Float32Array)
}

describe('a realization or group the new iteration lacks', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    delete (window as { __pestoFrames?: unknown }).__pestoFrames
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('draws no field, clears the legend and readout, and says which realization is missing', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const instance = await meshLayerInstance()
    setInput(root, 'Realization', '1')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.realization).toBe('r001'))
    await vi.waitFor(() => expect(root.querySelector('.floating-bottom-left > .fold-body')?.textContent).not.toBe(''))
    const callsBefore = stub.valuesCalls.length

    await choose(root, store, '3')

    await vi.waitFor(() => expect(drawnNotice(root)).toContain('realization r001 is not in iteration 3'))
    expect(stub.valuesCalls.length).toBe(callsBefore)
    expect(stub.valuesCalls.some((c) => c.iteration === '3' && c.realization === 'r001')).toBe(false)
    const values = lastValues(instance)
    expect(values.length).toBe(2)
    expect(values.every((v) => Number.isNaN(v))).toBe(true)
    expect(root.querySelector('.floating-bottom-left > .fold-body')?.textContent).toBe('')
    expect(selectedNotice(root)).toBe('')
    expect(sliderLabel(root)).toBe('—')
  })

  it('never draws another realization or the mean in its place, even after another control moves', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const instance = await meshLayerInstance()
    setInput(root, 'Realization', '1')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.realization).toBe('r001'))
    await choose(root, store, '3')
    await vi.waitFor(() => expect(drawnNotice(root)).toContain('r001'))
    const callsBefore = stub.valuesCalls.length

    setInput(root, 'Layer', '1')
    setInput(root, 'Colormap', 'magma', 'change')

    expect(stub.valuesCalls.length).toBe(callsBefore)
    expect(lastValues(instance).every((v) => Number.isNaN(v))).toBe(true)
    expect(drawnNotice(root)).toContain('realization r001 is not in iteration 3')
  })

  it('keeps the missing name as the wanted one, so switching back draws it and clears both notices', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    setInput(root, 'Realization', '1')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.realization).toBe('r001'))
    await choose(root, store, '3')
    await vi.waitFor(() => expect(drawnNotice(root)).toContain('r001'))

    await choose(root, store, '0')

    await vi.waitFor(() => {
      expect(stub.valuesCalls.at(-1)).toEqual({ iteration: '0', realization: 'r001', stat: null })
    })
    await vi.waitFor(() => expect(drawnNotice(root)).toBe(''))
    expect(selectedNotice(root)).toBe('')
    expect(sliderLabel(root)).toBe('r001')
    expect((root.querySelector('[aria-label="Realization"]') as HTMLInputElement).value).toBe('1')
  })

  it('draws again, and drops the notice, when a realization of the new iteration is picked', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    setInput(root, 'Realization', '1')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.realization).toBe('r001'))
    await choose(root, store, '3')
    await vi.waitFor(() => expect(drawnNotice(root)).toContain('r001'))

    setInput(root, 'Realization', '1')

    await vi.waitFor(() => {
      expect(stub.valuesCalls.at(-1)).toEqual({ iteration: '3', realization: 'base', stat: null })
    })
    await vi.waitFor(() => expect(drawnNotice(root)).toBe(''))
    expect(store.get().reals).toEqual(new Set(['base']))
  })

  it('still draws a statistic for the new iteration, and says again that the realization is missing when value returns', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    setInput(root, 'Realization', '1')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.realization).toBe('r001'))
    setInput(root, 'Statistic', 'mean', 'change')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.stat).toBe('mean'))

    await choose(root, store, '3')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)).toEqual({ iteration: '3', realization: null, stat: 'mean' }))
    await vi.waitFor(() => expect(drawnNotice(root)).toBe(''))

    const callsBefore = stub.valuesCalls.length
    setInput(root, 'Statistic', 'value', 'change')
    expect(stub.valuesCalls.length).toBe(callsBefore)
    expect(drawnNotice(root)).toContain('realization r001 is not in iteration 3')
  })

  it('says names were not recorded, and draws no single realization, when the new iteration has none', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store, TWO_ITERATIONS, {
      ...ITERATIONS,
      '3': { ...ITERATIONS['3'], reals: null },
    })
    const callsBefore = stub.valuesCalls.length

    await choose(root, store, '3')

    await vi.waitFor(() => expect(drawnNotice(root)).toContain('realization names were not recorded for iteration 3'))
    expect(stub.valuesCalls.length).toBe(callsBefore)
    expect((root.querySelector('[aria-label="Realization"]') as HTMLInputElement).disabled).toBe(true)
  })

  it('draws no field and names the group when it has nothing to draw in the new iteration', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    const instance = await meshLayerInstance()
    setInput(root, 'Parameter group', 'sy', 'change')
    const callsBefore = stub.valuesCalls.length

    await choose(root, store, '3')

    await vi.waitFor(() => expect(drawnNotice(root)).toContain('group sy has nothing to draw in iteration 3'))
    expect(stub.valuesCalls.length).toBe(callsBefore)
    expect(lastValues(instance).every((v) => Number.isNaN(v))).toBe(true)
    expect(root.querySelector('.floating-bottom-left > .fold-body')?.textContent).toBe('')

    // Picking a group that does draw in this iteration fetches its field.
    setInput(root, 'Parameter group', 'hk', 'change')
    await vi.waitFor(() => {
      expect(stub.valuesCalls.at(-1)).toEqual({ iteration: '3', realization: 'base', stat: null })
    })
    await vi.waitFor(() => expect(drawnNotice(root)).toBe(''))
    expect(lastValues(instance)).toEqual([10, 20])
  })

  it('counts the selected realizations the new iteration lacks and keeps every name in the store', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store)
    store.set({ reals: new Set(['base', 'r001', 'rX']) }, 'test')
    store.flush()

    await choose(root, store, '3')

    await vi.waitFor(() => expect(selectedNotice(root)).toContain('2 selected realizations are not in iteration 3'))
    expect(store.get().reals).toEqual(new Set(['base', 'r001', 'rX']))
    expect(drawnNotice(root)).toBe('')
  })

  it('says "1 selected realization is not in iteration 3" for one missing name that is not drawn', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store)
    store.set({ reals: new Set(['base', 'rX']) }, 'test')
    store.flush()

    await choose(root, store, '3')

    await vi.waitFor(() => expect(selectedNotice(root)).toContain('1 selected realization is not in iteration 3'))
    expect(selectedNotice(root)).not.toContain('realizations')
  })

  it('shows only the drawn-realization line when the drawn one is the only missing name', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    setInput(root, 'Realization', '1')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.realization).toBe('r001'))
    expect(store.get().reals).toEqual(new Set(['r001']))

    await choose(root, store, '3')

    await vi.waitFor(() => expect(drawnNotice(root)).toContain('r001'))
    expect(selectedNotice(root)).toBe('')
  })

  it('shows no selected-realization notice when none are missing', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    store.set({ reals: new Set(['base', 'r017']) }, 'test')
    store.flush()

    await choose(root, store, '3')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.iteration).toBe('3'))

    expect(selectedNotice(root)).toBe('')
    expect(root.querySelector('[data-testid="iteration-selected-notice"]')?.children.length).toBe(0)
  })

  it('replaces the selected-realization notice on every switch, never stacking a second', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    store.set({ reals: new Set(['base', 'r001', 'rX']) }, 'test')
    store.flush()
    const count = () => root.querySelectorAll('[data-testid="iteration-selected-notice"] .notice-parts').length

    for (const label of ['3', '0', '3']) {
      await choose(root, store, label)
      await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.iteration).toBe(label))
      expect(count()).toBe(1)
    }
    expect(selectedNotice(root)).toContain('2 selected realizations are not in iteration 3')

    // Back in iteration 0 only rX is missing, so the count follows the shown iteration.
    await choose(root, store, '0')
    await vi.waitFor(() => expect(selectedNotice(root)).toContain('1 selected realization is not in iteration 0'))
    expect(count()).toBe(1)
  })

  it('passes the run-together check for the toggle and both notices', async () => {
    loadRealStylesheet()
    const store = manualStore()
    const { root } = await mountedWith(store)
    setInput(root, 'Realization', '1')
    store.set({ reals: new Set(['base', 'r001', 'rX']) }, 'test')
    store.flush()
    await choose(root, store, '3')
    await vi.waitFor(() => expect(drawnNotice(root)).toContain('r001'))
    await vi.waitFor(() => expect(selectedNotice(root)).toContain('selected'))

    expectNoRunTogetherText(root.querySelector('[data-testid="map-notices"]') as HTMLElement, 'iteration notices')
    expectNoRunTogetherText(toggleButton(root, '0').parentElement as HTMLElement, 'iteration toggle')
  })
})

describe('the Go to realization box on the map', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    delete (window as { __pestoFrames?: unknown }).__pestoFrames
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('draws the realization typed into the box', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)

    setInput(root, 'Go to realization', 'r017', 'change')

    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)).toEqual({ iteration: '0', realization: 'r017', stat: null }))
    expect(sliderLabel(root)).toBe('r017')
  })

  const refusalOf = (root: HTMLElement): string => {
    const id = (root.querySelector('[aria-label="Go to realization"]') as HTMLElement).getAttribute('aria-describedby')
    return (id ? root.querySelector(`#${id} .note-text`)?.textContent : '') ?? ''
  }

  it('refuses a name the shown iteration lacks and draws nothing in its place', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    setInput(root, 'Realization', '1')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.realization).toBe('r001'))
    await choose(root, store, '3')
    await vi.waitFor(() => expect(drawnNotice(root)).toContain('realization r001 is not in iteration 3'))
    const callsBefore = stub.valuesCalls.length
    const noticeBefore = drawnNotice(root)

    setInput(root, 'Go to realization', 'r001', 'change')

    expect(refusalOf(root)).toBe('realization "r001" is not in iteration 3')
    expect(stub.valuesCalls.length).toBe(callsBefore)
    expect(stub.valuesCalls.some((c) => c.iteration === '3' && c.realization === 'r001')).toBe(false)
    expect(drawnNotice(root)).toBe(noticeBefore)
    expect(sliderLabel(root)).toBe('—')
  })

  it('draws a name the new iteration holds, and clears the refusal and the drawn-realization notice', async () => {
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    setInput(root, 'Realization', '1')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.realization).toBe('r001'))
    await choose(root, store, '3')
    await vi.waitFor(() => expect(drawnNotice(root)).toContain('r001'))
    setInput(root, 'Go to realization', 'r001', 'change')
    expect(refusalOf(root)).not.toBe('')

    setInput(root, 'Go to realization', 'base', 'change')

    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)).toEqual({ iteration: '3', realization: 'base', stat: null }))
    await vi.waitFor(() => expect(drawnNotice(root)).toBe(''))
    expect(refusalOf(root)).toBe('')
    expect(sliderLabel(root)).toBe('base')
  })

  it('offers only the shown iteration names and drops an earlier refusal after a switch', async () => {
    const store = manualStore()
    const { root } = await mountedWith(store)
    const box = root.querySelector('[aria-label="Go to realization"]') as HTMLElement
    const names = () =>
      Array.from(root.querySelectorAll(`datalist#${box.getAttribute('list')} option`)).map((o) => o.getAttribute('value'))
    expect(names()).toEqual(['base', 'r001', 'r017'])
    setInput(root, 'Go to realization', 'nope', 'change')
    expect(refusalOf(root)).toBe('realization "nope" is not in iteration 0')

    await choose(root, store, '3')

    await vi.waitFor(() => expect(names()).toEqual(['r017', 'base']))
    expect(refusalOf(root)).toBe('')
  })
})

describe('a layer another view sets while a field fetch is out', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    delete (window as { __pestoFrames?: unknown }).__pestoFrames
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('is still the layer drawn when the fetch lands', async () => {
    window.__pestoFrames = []
    const store = manualStore()
    const { root, stub } = await mountedWith(store)
    let release: () => void = () => {}
    stub.gate = new Promise((resolve) => {
      release = resolve
    })

    setInput(root, 'Realization', '1')
    await vi.waitFor(() => expect(stub.valuesCalls.at(-1)?.realization).toBe('r001'))
    store.set({ layer: 1 }, 'other-view')
    store.flush()
    expect((root.querySelector('[aria-label="Layer"]') as HTMLInputElement).value).toBe('1')

    release()
    stub.gate = null
    await vi.waitFor(() => expect(window.__pestoFrames?.at(-1)?.selection).toBe('r001'))

    expect(window.__pestoFrames?.at(-1)?.layer).toBe(1)
    expect(store.get().layer).toBe(1)
    expect((root.querySelector('[aria-label="Layer"]') as HTMLInputElement).value).toBe('1')
  })
})
