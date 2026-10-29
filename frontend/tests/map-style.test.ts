// @vitest-environment jsdom
//
// The Classes control on the real map screen: one effective style reaches the
// layer and the legend together, the held field is redrawn without a fetch,
// and the observation look always draws continuous (D-01, D-02, D-04).

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { Camera } from '../src/gl/camera'
import { scaleLimits } from '../src/gl/colormap'
import { CONTINUOUS, ONE_CLASS_EMPTY, ONE_CLASS_EQUAL, TEXTURE_CLASSES_NOTE, type EffectiveStyle } from '../src/gl/field-style'
import { MeshLayer } from '../src/gl/mesh-layer'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'

const noteText = (line: Element | null | undefined): string => line?.querySelector('.note-text')?.textContent ?? ''

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

// Counted, so a test can tell a remembered pair from a new computation.
vi.mock('../src/gl/colormap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/gl/colormap')>()
  return { ...actual, scaleLimits: vi.fn(actual.scaleLimits) }
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

const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 1, bounds: [0, 2, 0, 1], crs: null, tag: 'map-style' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 1])
const LAYER_ARRAY = new Int32Array([0, 0])

const ONE_GROUP = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }),
  'stream',
)
// G1 is linear and G2 is log, so a group change infers log10.
const TWO_GROUPS = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G2'], partrans: ['none', 'log'] }),
  'stream',
)
let PAR_TABLE = ONE_GROUP
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

let field = new Float32Array([10, 20])
let valueFetches = 0

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function stubEnvironment(): void {
  valueFetches = 0
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
      if (path.startsWith('/api/run/obs/')) {
        return respond({ status: 404, body: { title: 'no observations in this test', status: 404 } })
      }
      switch (path) {
        case '/api/run/view':
          return respond({ status: 404, body: { title: 'no saved view', status: 404 } })
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
        case '/api/run/grid/values':
          valueFetches += 1
          return respond({ status: 200, bytes: bytesOf(field) })
        case '/api/run/grid/pp':
          return respond({ status: 200, body: { groups: [], not_interpolable: [], notes: [] } })
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

type Mocked = ReturnType<typeof vi.fn>
function layerMock(): { setStyle: Mocked; setLimits: Mocked } {
  return vi.mocked(MeshLayer).mock.instances[0] as unknown as { setStyle: Mocked; setLimits: Mocked }
}

function lastLimits(): [number, number] {
  return layerMock().setLimits.mock.calls.at(-1)?.[0] as [number, number]
}

function lastStyle(): EffectiveStyle {
  const calls = layerMock().setStyle.mock.calls
  return calls[calls.length - 1][0] as EffectiveStyle
}

async function mounted(): Promise<{ root: HTMLElement; store: SelectionStore }> {
  stubEnvironment()
  const store = createSelectionStore({ initial: emptySelection('test_run', 0), schedule: (run) => queueMicrotask(run) })
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: baseState(), store })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  return { root, store }
}

function chooseClasses(root: HTMLElement, value: string): void {
  const select = root.querySelector('select[aria-label="Colour steps"]') as HTMLSelectElement
  select.value = value
  select.dispatchEvent(new Event('change'))
}

const legend = (root: HTMLElement): HTMLElement => root.querySelector('.floating-bottom-left') as HTMLElement
const readout = (root: HTMLElement): string => root.querySelector('.floating-bottom-right')?.textContent ?? ''

function clickAtWorld(canvas: HTMLCanvasElement, wx: number, wy: number): void {
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height }) as DOMRect
  const camera = new Camera(canvas.width, canvas.height)
  camera.fit([0, 2, 0, 1])
  const [x0, y0] = camera.screenToWorld(0, 0)
  const [x1, y1] = camera.screenToWorld(1, 1)
  canvas.dispatchEvent(new MouseEvent('click', { clientX: (wx - x0) / (x1 - x0), clientY: (wy - y0) / (y1 - y0) }))
}

describe('the Colour steps control on the map', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    field = new Float32Array([10, 20])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('steps the layer and the legend together from the held field, with no new fetch', async () => {
    const { root } = await mounted()
    const before = valueFetches
    expect(lastStyle().classes).toBe(0)

    chooseClasses(root, '9')

    expect(lastStyle()).toEqual({ classes: 9, symmetric: false, texture: false })
    expect(legend(root).querySelectorAll('.legend-class')).toHaveLength(9)
    expect(legend(root).querySelectorAll('.legend-edge')).toHaveLength(10)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(valueFetches).toBe(before)
  })

  it('puts the smooth ramp back on Smooth', async () => {
    const { root } = await mounted()
    chooseClasses(root, '9')
    chooseClasses(root, '0')

    expect(lastStyle().classes).toBe(0)
    expect(legend(root).querySelectorAll('.legend-class')).toHaveLength(0)
    const gradient = [...legend(root).querySelectorAll('div')].find((d) => d.style.background.includes('linear-gradient'))
    expect(gradient).toBeDefined()
  })

  it('draws one class with the reason when every value of the group is the same', async () => {
    field = new Float32Array([15, 15])
    const { root } = await mounted()
    chooseClasses(root, '9')

    expect(lastStyle().classes).toBe(1)
    expect(legend(root).querySelectorAll('.legend-class')).toHaveLength(1)
    expect(legend(root).textContent).toContain(ONE_CLASS_EQUAL)
    const note = root.querySelector('#classes-note') as HTMLElement
    expect(noteText(note)).toBe(ONE_CLASS_EQUAL)
    expect(note.style.display).toBe('')

    chooseClasses(root, '0')
    expect(note.style.display).toBe('none')
  })

  it('draws one class with the reason when the group has no value at all', async () => {
    field = new Float32Array([Number.NaN, Number.NaN])
    const { root } = await mounted()
    chooseClasses(root, '7')

    expect(lastStyle().classes).toBe(1)
    expect(legend(root).textContent).toContain(ONE_CLASS_EMPTY)
  })

  it('names the clicked cell class from the drawn log10 field, not from the raw value', async () => {
    field = new Float32Array([10, 1000])
    const { root } = await mounted()
    const scale = root.querySelector('select[aria-label="Value scale"]') as HTMLSelectElement
    scale.value = 'log10'
    scale.dispatchEvent(new Event('change'))
    chooseClasses(root, '9')

    clickAtWorld(root.querySelector('canvas') as HTMLCanvasElement, 0.5, 0.5)
    await vi.waitFor(() => expect(readout(root)).toContain('step '))
    // log10 of 10 is 1, the lower limit; the raw 10 would sit beyond the upper limit of 3.
    expect(readout(root)).toContain('step 1 of 9 (log₁₀ 1 to 1.22)')

    chooseClasses(root, '0')
    expect(readout(root)).not.toContain('step ')
  })

  it('draws the observation look continuous and hides the Colour steps row there', async () => {
    const { root, store } = await mounted()
    chooseClasses(root, '9')
    store.set({ colour: { source: 'obs', stat: 'resid_mean' } }, 'test')
    await vi.waitFor(() => expect(lastStyle().classes).toBe(0))

    const row = (root.querySelector('select[aria-label="Colour steps"]') as HTMLElement).closest('.card-row')
    expect(row?.getAttribute('data-colour-source')).toBe('par')
  })
})

describe('the Patterns switch on the map', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    field = new Float32Array([10, 20])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const box = (root: HTMLElement) => root.querySelector('input[aria-label="Patterns instead of colours"]') as HTMLInputElement

  function setTexture(root: HTMLElement, on: boolean): void {
    box(root).checked = on
    box(root).dispatchEvent(new Event('change'))
  }

  it('draws a cell group in 7 texture classes from the held field, with line swatches in the legend', async () => {
    const { root } = await mounted()
    const before = valueFetches

    setTexture(root, true)

    expect(lastStyle()).toEqual({ classes: 7, symmetric: false, texture: true })
    const swatches = [...legend(root).querySelectorAll('.legend-class')] as HTMLElement[]
    expect(swatches).toHaveLength(7)
    for (const swatch of swatches) expect(swatch.style.background).toContain('repeating-linear-gradient(')
    expect(noteText(root.querySelector('#classes-note'))).toBe(TEXTURE_CLASSES_NOTE)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(valueFetches).toBe(before)
  })

  it('draws the observation look with no texture, keeps the row parameter-only, and draws texture again on return', async () => {
    const { root, store } = await mounted()
    setTexture(root, true)
    expect(lastStyle().texture).toBe(true)

    store.set({ colour: { source: 'obs', stat: 'resid_mean' } }, 'test')
    await vi.waitFor(() => expect(lastStyle()).toEqual(CONTINUOUS))
    expect(box(root).closest('label')?.getAttribute('data-colour-source')).toBe('par')

    store.set({ colour: { source: 'par', stat: 'value' } }, 'test')
    await vi.waitFor(() => expect(lastStyle()).toEqual({ classes: 7, symmetric: false, texture: true }))
  })
})

describe('the Centre on zero switch on the map', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    field = new Float32Array([-2, 5])
    PAR_TABLE = ONE_GROUP
  })

  afterEach(() => {
    PAR_TABLE = ONE_GROUP
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  const box = (root: HTMLElement) => root.querySelector('input[aria-label="Centre on zero"]') as HTMLInputElement
  const reason = (root: HTMLElement) => root.querySelector('#symmetric-reason') as HTMLElement
  const symmetricLine = (root: HTMLElement) =>
    [...legend(root).querySelectorAll('div.label')].some((d) => d.textContent === 'centred on zero')

  function setSymmetric(root: HTMLElement, on: boolean): void {
    box(root).checked = on
    box(root).dispatchEvent(new Event('change'))
  }

  function pick(root: HTMLElement, label: string, value: string): void {
    const select = root.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
    select.value = value
    select.dispatchEvent(new Event('change'))
  }

  it('draws -m..+m from the remembered pair and gives the exact pair back when switched off', async () => {
    const { root } = await mounted()
    expect(lastLimits()).toEqual([-2, 5])
    const computed = vi.mocked(scaleLimits).mock.calls.length

    setSymmetric(root, true)
    expect(lastLimits()).toEqual([-5, 5])
    expect(lastStyle()).toEqual({ classes: 0, symmetric: true, texture: false })
    expect(symmetricLine(root)).toBe(true)

    setSymmetric(root, false)
    expect(lastLimits()).toEqual([-2, 5])
    expect(symmetricLine(root)).toBe(false)
    expect(vi.mocked(scaleLimits).mock.calls.length).toBe(computed)
  })

  it('draws zero limits as [0, 0] and still says centred on zero', async () => {
    field = new Float32Array([0, 0])
    const { root } = await mounted()
    setSymmetric(root, true)
    expect(lastLimits()).toEqual([0, 0])
    expect(lastStyle().classes).toBe(0)
    expect(symmetricLine(root)).toBe(true)
  })

  it('draws typed manual limits exactly as typed and shows why symmetric is off', async () => {
    const { root } = await mounted()
    setSymmetric(root, true)
    pick(root, 'Limits', 'manual')
    const lower = root.querySelector('input[aria-label="Lower limit"]') as HTMLInputElement
    const upper = root.querySelector('input[aria-label="Upper limit"]') as HTMLInputElement
    lower.value = '1'
    lower.dispatchEvent(new Event('input'))
    upper.value = '4'
    upper.dispatchEvent(new Event('input'))

    expect(lastLimits()).toEqual([1, 4])
    expect(lastStyle().symmetric).toBe(false)
    expect(box(root).checked).toBe(false)
    expect(box(root).disabled).toBe(true)
    expect(noteText(reason(root))).toBe('centre on zero was turned off: manual limits are used as typed')
    expect(symmetricLine(root)).toBe(false)
  })

  it('turns symmetric off when the user picks Log10, and says so', async () => {
    field = new Float32Array([2, 5])
    const { root } = await mounted()
    setSymmetric(root, true)
    pick(root, 'Value scale', 'log10')

    expect(lastStyle().symmetric).toBe(false)
    expect(box(root).disabled).toBe(true)
    expect(noteText(reason(root))).toBe('centre on zero was turned off: a log scale has no zero to centre on')
    expect(symmetricLine(root)).toBe(false)
  })

  it('turns symmetric off when a group change infers log10, and says so', async () => {
    PAR_TABLE = TWO_GROUPS
    field = new Float32Array([2, 5])
    const { root } = await mounted()
    setSymmetric(root, true)
    expect(lastStyle().symmetric).toBe(true)

    pick(root, 'Parameter group', 'G2')

    await vi.waitFor(() => expect(lastStyle().symmetric).toBe(false))
    expect(box(root).checked).toBe(false)
    expect(box(root).disabled).toBe(true)
    expect(noteText(reason(root))).toBe('centre on zero was turned off: a log scale has no zero to centre on')
  })

  it('keeps symmetric on when the inferred log10 is refused and the group is drawn linear', async () => {
    PAR_TABLE = TWO_GROUPS
    const { root } = await mounted()
    setSymmetric(root, true)

    pick(root, 'Parameter group', 'G2')

    expect(lastStyle().symmetric).toBe(true)
    expect(box(root).checked).toBe(true)
    expect(noteText(reason(root))).toBe('')
  })
})
