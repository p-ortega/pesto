// @vitest-environment jsdom
//
// WINDOWS.md #8: a restored view state carried reverse: true and it was
// applied to the ramp on first paint, but the checkbox read unchecked --
// and the first layer change (which reads the checkbox, not `committed`,
// for its own reverseColormap) then silently dropped the setting. Drives
// the real map screen with a real /api/run/view GET, MeshLayer mocked
// (only the DOM and the calls made to it matter here, not pixels).

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import type { RunConfig } from '../src/views/map'
import { storeWithGroup } from './support/chosen-group'

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

const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 2, nlay: 2, bounds: [0, 1, 0, 1], crs: null, tag: 'view-state' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
const CELL_INDEX = new Float32Array([0, 0, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0, 1])
const CELL_ARRAY = new Int32Array([0, 1])
const LAYER_ARRAY = new Int32Array([0, 1])
const FIELD = new Float32Array([10, 20])

const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

const RESTORED_VIEW = {
  divider: 0.5,
  colormap: 'viridis',
  reverse: true,
  scale: 'linear',
  limits_mode: 'robust',
  group: 'G1' as string | null,
  stat: 'value',
  layer: null as number | null,
  tab: undefined as string | undefined,
  classes: 0,
  symmetric: false,
  texture: false,
}

// Lets a test hold the map before it settles its choices.
let holdMesh = false

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

function stubEnvironment(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path] = url.split('?')
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
        case '/api/run/view':
          if (init?.method === 'PUT') return respond({ status: 200, body: RESTORED_VIEW })
          return respond({ status: 200, body: RESTORED_VIEW })
        case '/api/run/grid/mesh':
          if (holdMesh) return new Promise(() => {})
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
          return respond({ status: 200, bytes: bytesOf(FIELD) })
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

function mountFreshRoot(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}

async function meshLayerInstance() {
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  return vi.mocked(MeshLayer).mock.instances[0] as unknown as {
    setColormap: ReturnType<typeof vi.fn>
  }
}

describe('a restored reverse-colormap setting (WINDOWS.md #8)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('shows the checkbox checked at mount, matching the ramp it already drew', async () => {
    stubEnvironment()
    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    const reverseCheckbox = root.querySelector('input[aria-label="Reverse colormap"]') as HTMLInputElement
    expect(reverseCheckbox.checked).toBe(true)

    const instance = await meshLayerInstance()
    const lastColormapCall = instance.setColormap.mock.calls.at(-1)
    expect(lastColormapCall?.[1]).toBe(true)
  })

  it('keeps the restored reverse setting through the first layer change instead of dropping it', async () => {
    stubEnvironment()
    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerInput.value = '1'
    layerInput.dispatchEvent(new Event('input'))

    const instance = await meshLayerInstance()
    const lastColormapCall = instance.setColormap.mock.calls.at(-1)
    expect(lastColormapCall?.[1]).toBe(true)

    const reverseCheckbox = root.querySelector('input[aria-label="Reverse colormap"]') as HTMLInputElement
    expect(reverseCheckbox.checked).toBe(true)
  })
})

describe('a restored statistic', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    RESTORED_VIEW.stat = 'mean'
  })

  afterEach(() => {
    RESTORED_VIEW.stat = 'value'
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('shows in the Statistic menu at mount, matching the field it drew', async () => {
    stubEnvironment()
    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    const valueUrls = vi.mocked(fetch).mock.calls.map(([input]) => String(input)).filter((u) => u.startsWith('/api/run/grid/values'))
    expect(valueUrls.at(-1)).toContain('stat=mean')
    expect((root.querySelector('select[aria-label="Statistic"]') as HTMLSelectElement).value).toBe('mean')
    expect((root.querySelector('input[aria-label="Realization"]') as HTMLInputElement).disabled).toBe(true)
  })
})

describe('a restored layer', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    RESTORED_VIEW.layer = null
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  async function openedOn(saved: number | null): Promise<HTMLElement> {
    RESTORED_VIEW.layer = saved
    stubEnvironment()
    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })
    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })
    return root
  }

  it('opens on the layer the run was left on', async () => {
    const root = await openedOn(1)
    expect((root.querySelector('input[aria-label="Layer"]') as HTMLInputElement).value).toBe('1')
  })

  it('opens on layer 0 when the saved layer is past the bottom of the grid', async () => {
    const root = await openedOn(9)
    expect((root.querySelector('input[aria-label="Layer"]') as HTMLInputElement).value).toBe('0')
  })
})

describe('the remembered right-panel tab (D-09)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    RESTORED_VIEW.tab = undefined
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  async function openMap(saved: string | undefined): Promise<HTMLElement> {
    RESTORED_VIEW.tab = saved
    stubEnvironment()
    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState(), store: storeWithGroup('G1') })
    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })
    return root
  }

  function tab(root: HTMLElement, name: string): HTMLElement {
    return root.querySelector(`#tab-${name}`) as HTMLElement
  }

  function putBodies(): Array<Record<string, unknown>> {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([input, init]) => String(input).startsWith('/api/run/view') && init?.method === 'PUT')
      .map(([, init]) => JSON.parse(String(init?.body)))
  }

  it('opens on Obs when the run was left on Obs, with the Params panel hidden but present', async () => {
    const root = await openMap('obs')

    expect(tab(root, 'obs').getAttribute('aria-selected')).toBe('true')
    expect(tab(root, 'params').getAttribute('aria-selected')).toBe('false')
    const paramsPanel = root.querySelector('#panel-params') as HTMLElement
    expect(paramsPanel.hidden).toBe(true)
    expect(paramsPanel.querySelector('.param-row')).not.toBeNull()
  })

  it('opens on Params when the saved state has no tab', async () => {
    const root = await openMap(undefined)

    expect(tab(root, 'params').getAttribute('aria-selected')).toBe('true')
    expect((root.querySelector('#panel-params') as HTMLElement).hidden).toBe(false)
  })

  it('opens on Params when the saved tab is not one this build knows', async () => {
    const root = await openMap('phi')

    expect(tab(root, 'params').getAttribute('aria-selected')).toBe('true')
  })

  it('shows the three tabs in the order Params, Obs, Config', async () => {
    const root = await openMap(undefined)

    const labels = Array.from(root.querySelectorAll('[role="tab"]')).map((el) => el.textContent)
    expect(labels).toEqual(['Params', 'Obs', 'Config'])
    expect(root.querySelector('.map-frame')?.children.length).toBe(3)
  })

  it('writes the tab the user clicked into the next saved view state', async () => {
    const root = await openMap(undefined)

    tab(root, 'config').click()

    await vi.waitFor(() => expect(putBodies().some((body) => body.tab === 'config')).toBe(true), { timeout: 3000 })
  })
})

describe('the saved field style (classes, symmetric, texture)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    RESTORED_VIEW.classes = 0
    RESTORED_VIEW.symmetric = false
    RESTORED_VIEW.texture = false
    RESTORED_VIEW.scale = 'linear'
    RESTORED_VIEW.group = 'G1'
    holdMesh = false
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  function putBodies(): Array<Record<string, unknown>> {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([input, init]) => String(input).startsWith('/api/run/view') && init?.method === 'PUT')
      .map(([, init]) => JSON.parse(String(init?.body)))
  }

  async function opened(): Promise<HTMLElement> {
    stubEnvironment()
    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })
    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })
    return root
  }

  async function lastStyle(): Promise<{ classes: number; symmetric: boolean; texture: boolean }> {
    const { MeshLayer } = await import('../src/gl/mesh-layer')
    const instance = vi.mocked(MeshLayer).mock.instances[0] as unknown as { setStyle: ReturnType<typeof vi.fn> }
    return instance.setStyle.mock.calls.at(-1)?.[0]
  }

  const classesSelect = (root: HTMLElement) => root.querySelector('select[aria-label="Colour classes"]') as HTMLSelectElement
  const symmetricBox = (root: HTMLElement) => root.querySelector('input[aria-label="Symmetric about 0"]') as HTMLInputElement

  function moveLayer(root: HTMLElement): void {
    const layerInput = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerInput.value = '1'
    layerInput.dispatchEvent(new Event('input'))
  }

  it('opens a run visited before with its saved classes', async () => {
    RESTORED_VIEW.classes = 9
    const root = await opened()

    expect(classesSelect(root).value).toBe('9')
    expect((await lastStyle()).classes).toBe(9)
  })

  it('keeps a saved texture in the next saved request', async () => {
    RESTORED_VIEW.classes = 9
    RESTORED_VIEW.texture = true
    const root = await opened()
    moveLayer(root)

    // Waits for this map's own write: an earlier test's debounced write can land first.
    await vi.waitFor(() => expect(putBodies().at(-1)).toMatchObject({ classes: 9, texture: true }), { timeout: 3000 })
  })

  it('opens a saved log10 with symmetric on as symmetric off, says so, and saves it off', async () => {
    RESTORED_VIEW.scale = 'log10'
    RESTORED_VIEW.symmetric = true
    const root = await opened()

    expect(symmetricBox(root).checked).toBe(false)
    expect(symmetricBox(root).disabled).toBe(true)
    expect((root.querySelector('#symmetric-reason') as HTMLElement).textContent).toBe(
      'symmetric was turned off: a log scale has no zero to centre on',
    )
    expect((await lastStyle()).symmetric).toBe(false)

    moveLayer(root)
    await vi.waitFor(() => expect(putBodies().at(-1)).toMatchObject({ scale: 'log10', symmetric: false }), { timeout: 3000 })
  })

  it('opens a run never visited continuous, symmetric off and texture off, whatever the store holds', async () => {
    RESTORED_VIEW.group = null
    RESTORED_VIEW.classes = 9
    RESTORED_VIEW.symmetric = true
    RESTORED_VIEW.texture = true
    const root = await opened()

    expect(classesSelect(root).value).toBe('0')
    expect(symmetricBox(root).checked).toBe(false)
    expect(await lastStyle()).toEqual({ classes: 0, symmetric: false, texture: false })
  })

  it('saves the picked classes with symmetric and texture next to the colour settings', async () => {
    const root = await opened()
    classesSelect(root).value = '11'
    classesSelect(root).dispatchEvent(new Event('change'))

    await vi.waitFor(
      () =>
        expect(putBodies().at(-1)).toMatchObject({
          colormap: 'viridis',
          scale: 'linear',
          limits_mode: 'robust',
          classes: 11,
          symmetric: false,
          texture: false,
        }),
      { timeout: 3000 },
    )
  })

  it('writes the saved classes, symmetric and texture back unchanged until the map has settled', async () => {
    RESTORED_VIEW.classes = 7
    RESTORED_VIEW.symmetric = true
    RESTORED_VIEW.texture = true
    holdMesh = true
    stubEnvironment()
    const { mountMap } = await import('../src/views/map')
    const root = mountFreshRoot()
    mountMap(root, { config: CONFIG, state: baseState() })

    ;(root.querySelector('#tab-config') as HTMLElement).click()

    await vi.waitFor(
      () => expect(putBodies().at(-1)).toMatchObject({ tab: 'config', classes: 7, symmetric: true, texture: true }),
      { timeout: 3000 },
    )
  })
})
