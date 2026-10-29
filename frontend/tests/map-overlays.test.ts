// @vitest-environment jsdom
//
// The two overlays on the map: parameters at their bounds hatch at 45 degrees and
// prior-data-conflict sites at 135, from answers for the shown iteration only, with a toggle and
// count each, and swatches in the flagged dots. The real map screen against a stubbed fetch, with
// the GL context and the shared MeshLayer double mocked.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { POINT_FLAG_AT_BOUNDS, POINT_FLAG_CONFLICT, POINT_FLAG_DIM } from '../src/data/hatch-mask'
import { OVERLAY_SUPPRESSED_REASON, TEXTURE_DOTS_REASON } from '../src/gl/field-style'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'

const noteText = (line: Element | null | undefined): string => line?.querySelector('.note-text')?.textContent ?? ''

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
      obs: { available: true, blockedBy: [] },
    },
    ingestSeconds: null,
    cacheBytes: null,
  }
}

// Two unit cells side by side, two layers. G1 sets the cells; k is placed by x/y and draws as dots.
const MESH_BODY = { n_vert: 8, n_tri: 4, n_cells: 2, nlay: 2, bounds: [0, 2, 0, 1], crs: null, tag: 'overlays' }
const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
const PARMAP = new Int32Array([0, 1, 2, 3])
const CELL_ARRAY = new Int32Array([0, 1, 0, 1])
const LAYER_ARRAY = new Int32Array([0, 0, 0, 0])
const NAN = Number.NaN
const POINT_XY = new Float32Array([NAN, NAN, NAN, NAN, 0.25, 0.5, 1.5, 0.5])
const PAR_TABLE = tableToIPC(
  tableFromArrays({ parnme: ['p0', 'p1', 'pa', 'pb'], pargp: ['G1', 'G1', 'k', 'k'], partrans: ['none', 'none', 'none', 'none'] }),
  'stream',
)
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

// Site ids are not row numbers. s103 sits on layer 1.
const HEADS = [
  { id: 101, name: 's101', x: 0.25, y: 0.6, layer: 0, cell: 0 },
  { id: 102, name: 's102', x: 0.75, y: 0.6, layer: 0, cell: 0 },
  { id: 103, name: 's103', x: 1.5, y: 0.5, layer: 1, cell: 1 },
  { id: 104, name: 's104', x: 1.75, y: 0.5, layer: 0, cell: 1 },
]

const RULE = 'a parameter is at bounds when it has at least 10% of realizations near a bound'
const CAVEAT = 'counts from the float32 cache can be one high'
const NO_COUNTS = 'near-bound counts exist for iterations 0 and 3 only'

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
    n_obs: [10],
    n_sites: [HEADS.length],
    n_placed: [HEADS.length],
    n_weighted: [10],
    n_with_target: [10],
    n_zero_weight: [0],
    n_sentinel: [0],
    n_no_value: [0],
    time_kind: ['numeric'],
    inequality: ['none'],
    first_iteration: [0],
    last_iteration: [3],
    rmse_first: [1],
    rmse_last: [0.5],
    n_resid_first: [10],
    n_resid_last: [10],
  })
}

function timesBody(group: string): Record<string, unknown> {
  return {
    group,
    order_digest: 'digest-a',
    time_kind: 'numeric',
    steps_by: 'time',
    times: [10, 20],
    n_at_time: [4, 4],
    n_sites: HEADS.length,
    iterations: [{ iteration: 3, available: true, reason: null }],
    limits: { resid_mean: [-1, 1], rmse: [0, 2], std: [0, 1], mean: [9, 11] },
    limits_rule: 'pooled over the first and last iteration',
    limits_refused: null,
    refused: null,
    notes: [],
  }
}

// Which parameters of each group are at their bounds, for iteration 3; iteration 2 has no counts.
const AT_BOUNDS: Record<string, string[]> = { G1: ['p1'], k: ['pb'] }

function atBoundsBody(iteration: number, group: string | null): Record<string, unknown> {
  const available = iteration !== 2
  const names = group === null || !available ? null : (AT_BOUNDS[group] ?? [])
  return {
    available,
    reason: null,
    artifact: 'par_change',
    iteration,
    first_iteration: 0,
    last_iteration: 3,
    rule: RULE,
    caveat: CAVEAT,
    groups: group === null || !available ? [] : [{ group, n_par: 2, n_counted: 2, n_at_bounds: names!.length, n_excluded: {} }],
    names,
  }
}

// s101 (heads, cell 0) and s900 (another group, cell 1) are in conflict at iteration 3.
function pdcBody(iteration: number): Record<string, unknown> {
  if (iteration === 2) {
    return {
      available: false,
      reason: 'no pdc file for iteration 2',
      artifact: 'pdc/2',
      iteration,
      source: null,
      source_file: null,
      weights_source: null,
      rule: null,
      n_obs: null,
      n_sites: null,
      n_unmatched: null,
      n_left_out: null,
      by_group: [],
      sites: { id: [], cell: [], layer: [], group_index: [], n_obs: [] },
      groups: [],
      notes: [],
    }
  }
  return {
    available: true,
    reason: null,
    artifact: `pdc/${iteration}`,
    iteration,
    source: 'file',
    source_file: 'case.3.pdc.csv',
    weights_source: 'control file',
    rule: 'pestpp-ies prior-data conflict',
    n_obs: 3,
    n_sites: 2,
    n_unmatched: 0,
    n_left_out: 0,
    by_group: [
      { group: 'heads', n_obs: 2, n_sites: 1 },
      { group: 'other', n_obs: 1, n_sites: 1 },
    ],
    sites: { id: [101, 900], cell: [0, 1], layer: [0, 0], group_index: [0, 1], n_obs: [2, 1] },
    groups: ['heads', 'other'],
    notes: [],
  }
}

interface Stub {
  atBounds: { iteration: string; group: string | null }[]
  pdc: string[]
  /** While set, overlay answers for that iteration wait until released. */
  hold: Set<string>
  release: (() => void)[]
}

function stubEnvironment(): Stub {
  const stub: Stub = { atBounds: [], pdc: [], hold: new Set(), release: [] }
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
      const iteration = query.get('iteration') ?? ''
      const wait = async () => {
        if (stub.hold.has(iteration)) await new Promise<void>((resolve) => stub.release.push(resolve))
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
          return respond({ status: 200, bytes: bytesOf(POINT_XY) })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(new Float32Array([10, 20, 30, 40])) })
        case '/api/run/grid/pp':
          return respond({ status: 200, body: { groups: [], not_interpolable: [], notes: [] } })
        case '/api/run/view':
          throw new Error('no saved view')
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
            bytes: bytesOf(new Float32Array(HEADS.map((_, i) => 0.1 * i))),
            headers: {
              'X-Pesto-Meta': JSON.stringify({
                dtype: '<f4',
                group,
                order_digest: 'digest-a',
                iteration: 3,
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
        case '/api/run/link/sites': {
          const ids = (query.get('sites') ?? '').split(',').map(Number)
          return respond({
            status: 200,
            body: {
              iteration: Number(iteration),
              sites: [],
              unknown: ids,
              value_rule: 'a site has a valid observation when one of its observations has a measured value',
              value_reason: null,
              reason: null,
              notes: [],
            },
          })
        }
        case '/api/run/par/at_bounds': {
          // The Params panel asks for every group at once; only the map asks for one group.
          if (query.get('group') !== null) stub.atBounds.push({ iteration, group: query.get('group') })
          await wait()
          return respond({ status: 200, body: atBoundsBody(Number(iteration), query.get('group')) })
        }
        case '/api/run/obs/pdc': {
          stub.pdc.push(iteration)
          await wait()
          return respond({ status: 200, body: pdcBody(Number(iteration)) })
        }
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
  return stub
}

// Delivers each batch on a microtask, as the obs colouring needs its own writes heard.
function autoStore(): SelectionStore {
  return createSelectionStore({ initial: emptySelection('test_run', 3), schedule: (run) => queueMicrotask(run) })
}

type Mocked = ReturnType<typeof vi.fn>

interface LayerDouble {
  setHatch: Mocked
  setHatchColors: Mocked
  setValues: Mocked
  setLimits: Mocked
  setColormap: Mocked
  setPoints: Mocked
  setPointFlags: Mocked
  setStyle: Mocked
  setSurfaceColor: Mocked
  draw: Mocked
}

async function mounted(store: SelectionStore = autoStore()): Promise<{ root: HTMLElement; stub: Stub; layer: LayerDouble; store: SelectionStore }> {
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
  const { MeshLayer } = await import('../src/gl/mesh-layer')
  const layer = vi.mocked(MeshLayer).mock.instances[0] as unknown as LayerDouble
  return { root, stub, layer, store }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function lastHatch(layer: LayerDouble): number[] | null {
  const call = layer.setHatch.mock.calls.at(-1)
  if (call === undefined) throw new Error('setHatch was never called')
  const mask = call[0] as Uint8Array | null
  return mask === null ? null : Array.from(mask)
}

function toggle(root: HTMLElement, kind: 'atBounds' | 'conflict'): HTMLButtonElement {
  return root.querySelector(`button[data-overlay="${kind}"]`) as HTMLButtonElement
}

const toggleText = (root: HTMLElement, kind: 'atBounds' | 'conflict'): string => toggle(root, kind).textContent ?? ''

const textureBox = (root: HTMLElement): HTMLInputElement => root.querySelector('input[aria-label="Patterns instead of colours"]') as HTMLInputElement

function setTexture(root: HTMLElement, on: boolean): void {
  textureBox(root).checked = on
  textureBox(root).dispatchEvent(new Event('change'))
}

// The flags on the drawn dots now, read only from calls made after the last setPoints.
function dotFlags(layer: LayerDouble): number[] | null {
  const pointsAt = Math.max(0, ...layer.setPoints.mock.invocationCallOrder)
  const flagsAt = layer.setPointFlags.mock.invocationCallOrder.at(-1) ?? -1
  expect(flagsAt).toBeGreaterThan(pointsAt)
  const flags = layer.setPointFlags.mock.calls.at(-1)![0] as Float32Array | null
  return flags === null ? null : Array.from(flags)
}

function lastPointCount(layer: LayerDouble): number {
  const call = layer.setPoints.mock.calls.at(-1) as [Float32Array, Float32Array] | undefined
  return call === undefined ? -1 : call[1].length
}

async function shown(root: HTMLElement): Promise<void> {
  await vi.waitFor(() => {
    expect(toggleText(root, 'atBounds')).toContain('45° at bounds: 1 parameter')
    expect(toggleText(root, 'conflict')).toContain('135° conflict: 3 observations at 2 sites')
  })
}

describe('the overlays on the map', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.documentElement.style.removeProperty('--ink-primary')
    document.documentElement.style.removeProperty('--page-plane')
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('asks once for each answer of the shown iteration and group, and hatches both kinds in one mask', async () => {
    const { root, stub, layer } = await mounted()
    await shown(root)

    expect(stub.atBounds).toEqual([{ iteration: '3', group: 'G1' }])
    expect(stub.pdc).toEqual(['3'])
    // p1 sets cell 1 (bit 0); s101 sits in cell 0 and s900 in cell 1 (bit 1).
    expect(lastHatch(layer)).toEqual([2, 3])
    expect(toggle(root, 'atBounds').getAttribute('aria-pressed')).toBe('true')
    expect(toggle(root, 'conflict').getAttribute('aria-pressed')).toBe('true')
    expect(toggleText(root, 'conflict')).toContain('from file')
  })

  it('puts the toggles first in the map controls', async () => {
    const { root } = await mounted()
    const cluster = root.querySelector('.floating-top-left') as HTMLElement
    expect(cluster.firstElementChild?.querySelector('.overlay-controls')).not.toBeNull()
  })

  it('clears only the at-bounds bit when its toggle is turned off, asking nothing, and clears the hatch with both off', async () => {
    const { root, stub, layer } = await mounted()
    await shown(root)

    toggle(root, 'atBounds').click()
    expect(lastHatch(layer)).toEqual([2, 2])
    toggle(root, 'conflict').click()
    expect(lastHatch(layer)).toBeNull()
    toggle(root, 'atBounds').click()
    expect(lastHatch(layer)).toEqual([0, 1])

    await settle()
    expect(stub.atBounds.length).toBe(1)
    expect(stub.pdc.length).toBe(1)
  })

  it('rebuilds the mask for a layer change without asking again', async () => {
    const { root, stub, layer, store } = await mounted()
    await shown(root)

    store.set({ layer: 1 }, 'other')
    await settle()

    // Nothing of G1 and no conflicted site sits on layer 1.
    expect(lastHatch(layer)).toBeNull()
    expect(stub.atBounds.length).toBe(1)
    expect(stub.pdc.length).toBe(1)

    store.set({ layer: 0 }, 'other')
    await settle()
    expect(lastHatch(layer)).toEqual([2, 3])
  })

  it('takes the hatch away while a new iteration loads and asks for that iteration', async () => {
    const { root, stub, layer, store } = await mounted()
    await shown(root)
    stub.hold.add('2')

    store.set({ iteration: 2 }, 'other')
    await vi.waitFor(() => expect(stub.pdc).toContain('2'))

    expect(lastHatch(layer)).toBeNull()
    expect(toggleText(root, 'atBounds')).toContain('reading…')
    expect(toggleText(root, 'conflict')).toContain('reading…')
    expect(stub.atBounds.at(-1)).toEqual({ iteration: '2', group: 'G1' })
    for (const release of stub.release) release()
  })

  it('never draws a late answer for the iteration the map has left', async () => {
    const { root, stub, layer, store } = await mounted()
    await shown(root)
    layer.setHatch.mockClear()
    // From here the iteration 3 answers wait, so the map can leave 3 before they land.
    stub.hold.add('3')

    store.set({ iteration: 2 }, 'other')
    await vi.waitFor(() => expect(stub.pdc).toContain('2'))
    await vi.waitFor(() => expect(toggleText(root, 'atBounds')).toContain(NO_COUNTS))
    store.set({ iteration: 3 }, 'other')
    await vi.waitFor(() => expect(stub.pdc.filter((k) => k === '3').length).toBe(2))
    store.set({ iteration: 2 }, 'other')
    await vi.waitFor(() => expect(stub.pdc.filter((k) => k === '2').length).toBe(2))
    await vi.waitFor(() => expect(toggleText(root, 'atBounds')).toContain(NO_COUNTS))

    // Iteration 3's second answer lands now, after the map moved back to 2.
    expect(stub.release.length).toBeGreaterThanOrEqual(2)
    for (const release of stub.release) release()
    await settle()

    for (const call of layer.setHatch.mock.calls) expect(call[0]).toBeNull()
    expect(toggleText(root, 'atBounds')).toContain(NO_COUNTS)
  })

  it('disables a toggle with its reason for an iteration with no counts and no pdc, and hatches nothing of either', async () => {
    const { root, layer, store } = await mounted()
    await shown(root)

    store.set({ iteration: 2 }, 'other')
    await vi.waitFor(() => expect(toggleText(root, 'atBounds')).toContain(NO_COUNTS))

    expect(toggle(root, 'atBounds').disabled).toBe(true)
    expect(toggle(root, 'conflict').disabled).toBe(true)
    expect(toggleText(root, 'conflict')).toContain('no pdc file for iteration 2')
    expect(lastHatch(layer)).toBeNull()
  })

  it('turns at-bounds off with its reason under the observation colouring, and swatches only the coloured group\'s conflicted dots next to the dim flag', async () => {
    const { root, layer, store } = await mounted()
    await shown(root)

    store.set({ colour: { source: 'obs', stat: 'resid_mean' } }, 'other')
    await vi.waitFor(() => expect(lastPointCount(layer)).toBe(3))
    await settle()

    expect(toggleText(root, 'atBounds')).toContain('at-bounds hatching follows the parameter group the map is coloured by')
    expect(toggle(root, 'atBounds').disabled).toBe(true)
    // Only s101 is a conflicted heads site; s900 is in another group.
    expect(lastHatch(layer)).toEqual([2, 0])
    // Drawn on layer 0: s101, s102 and s104.
    expect(dotFlags(layer)).toEqual([POINT_FLAG_CONFLICT, 0, 0])

    store.set({ sites: new Set([102]) }, 'other')
    await settle()
    expect(dotFlags(layer)).toEqual([POINT_FLAG_CONFLICT | POINT_FLAG_DIM, 0, POINT_FLAG_DIM])
  })

  it('swatches the dot of a pilot point at its bounds and hatches its cell', async () => {
    const { root, stub, layer } = await mounted()
    await shown(root)

    const picker = root.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
    picker.value = 'k'
    picker.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(stub.atBounds.at(-1)).toEqual({ iteration: '3', group: 'k' }))
    await vi.waitFor(() => expect(dotFlags(layer)).toEqual([0, POINT_FLAG_AT_BOUNDS]))

    // pb sits in cell 1; the conflict hatch stays where it was.
    expect(lastHatch(layer)).toEqual([2, 3])
    expect(toggle(root, 'atBounds').title).toContain('1 pilot point marked')
  })

  it('reads the hatch ink and halo from the theme on mount and again on a theme change', async () => {
    document.documentElement.style.setProperty('--ink-primary', '#102030')
    document.documentElement.style.setProperty('--page-plane', '#f0e0d0')
    const { layer } = await mounted()
    expect(layer.setHatchColors.mock.calls.at(-1)).toEqual([
      [16 / 255, 32 / 255, 48 / 255],
      [240 / 255, 224 / 255, 208 / 255],
    ])

    document.documentElement.style.setProperty('--ink-primary', '#e0e0e0')
    document.documentElement.style.setProperty('--page-plane', '#101010')
    const theme = document.querySelector('select[aria-label="Theme"]') as HTMLSelectElement
    theme.value = 'dark'
    theme.dispatchEvent(new Event('change'))
    expect(layer.setHatchColors.mock.calls.at(-1)).toEqual([
      [224 / 255, 224 / 255, 224 / 255],
      [16 / 255, 16 / 255, 16 / 255],
    ])
  })

  it('reads the texture fill surface from the theme on mount and again on a theme change', async () => {
    document.documentElement.style.setProperty('--surface', '#fcfcfb')
    const { layer } = await mounted()
    expect(layer.setSurfaceColor.mock.calls.at(-1)).toEqual([[252 / 255, 252 / 255, 251 / 255]])

    document.documentElement.style.setProperty('--surface', '#1a1a19')
    const theme = document.querySelector('select[aria-label="Theme"]') as HTMLSelectElement
    theme.value = 'dark'
    theme.dispatchEvent(new Event('change'))
    expect(layer.setSurfaceColor.mock.calls.at(-1)).toEqual([[26 / 255, 26 / 255, 25 / 255]])
    document.documentElement.style.removeProperty('--surface')
  })

  // [edge MAPX-03 restore]
  it('sets both toggles aside with their counts while texture fill is on, and gives back the user choices after', async () => {
    const { root, stub, layer } = await mounted()
    await shown(root)
    toggle(root, 'conflict').click()
    expect(lastHatch(layer)).toEqual([0, 1])

    setTexture(root, true)
    expect(layer.setStyle.mock.calls.at(-1)?.[0]).toEqual({ classes: 7, symmetric: false, texture: true })
    for (const kind of ['atBounds', 'conflict'] as const) {
      expect(toggle(root, kind).disabled).toBe(true)
      expect(toggle(root, kind).getAttribute('aria-pressed')).toBe('false')
      expect(toggle(root, kind).title).toBe(OVERLAY_SUPPRESSED_REASON)
      expect(toggleText(root, kind)).toContain(OVERLAY_SUPPRESSED_REASON)
    }
    expect(toggleText(root, 'atBounds')).toContain('45° at bounds: 1 parameter')
    expect(toggleText(root, 'conflict')).toContain('135° conflict: 3 observations at 2 sites')

    setTexture(root, false)
    expect(toggle(root, 'atBounds').disabled).toBe(false)
    expect(toggle(root, 'atBounds').getAttribute('aria-pressed')).toBe('true')
    expect(toggle(root, 'conflict').getAttribute('aria-pressed')).toBe('false')
    // Only p1's cell, the at-bounds bit; conflict stays as the user left it.
    expect(lastHatch(layer)).toEqual([0, 1])

    await settle()
    expect(stub.atBounds.length).toBe(1)
    expect(stub.pdc.length).toBe(1)
  })

  it('rebuilds the overlays on a texture flip alone, with nothing else moved', async () => {
    const { root, layer } = await mounted()
    await shown(root)
    layer.setHatch.mockClear()

    setTexture(root, true)
    expect(toggle(root, 'atBounds').disabled).toBe(true)
    expect(layer.setHatch).toHaveBeenCalled()
    setTexture(root, false)
    expect(toggle(root, 'atBounds').disabled).toBe(false)
    expect(lastHatch(layer)).toEqual([2, 3])
  })

  it('refuses texture fill on a group drawn as dots, with the reason, and still steps the dots', async () => {
    const { root, stub, layer } = await mounted()
    await shown(root)
    setTexture(root, true)

    const picker = root.querySelector('select[aria-label="Parameter group"]') as HTMLSelectElement
    picker.value = 'k'
    picker.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(stub.atBounds.at(-1)).toEqual({ iteration: '3', group: 'k' }))
    await vi.waitFor(() => expect(dotFlags(layer)).toEqual([0, POINT_FLAG_AT_BOUNDS]))

    const box = textureBox(root)
    expect(box.disabled).toBe(true)
    expect(noteText(root.querySelector('#texture-reason'))).toBe(TEXTURE_DOTS_REASON)
    expect(layer.setStyle.mock.calls.at(-1)?.[0]).toEqual({ classes: 7, symmetric: false, texture: false })
    // No texture is drawn, so the overlays stay as they were.
    expect(toggle(root, 'atBounds').disabled).toBe(false)
  })

  it('never touches the values, limits or colormap to show or change an overlay', async () => {
    const { root, layer } = await mounted()
    await shown(root)
    layer.setValues.mockClear()
    layer.setLimits.mockClear()
    layer.setColormap.mockClear()

    toggle(root, 'atBounds').click()
    toggle(root, 'conflict').click()
    toggle(root, 'conflict').click()
    await settle()

    expect(layer.setHatch).toHaveBeenCalled()
    expect(layer.setValues).not.toHaveBeenCalled()
    expect(layer.setLimits).not.toHaveBeenCalled()
    expect(layer.setColormap).not.toHaveBeenCalled()
  })
})
