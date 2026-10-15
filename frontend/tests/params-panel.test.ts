// @vitest-environment jsdom
//
// The Params panel (D-09/E8): the windowed parameter table, the unmapped
// list and the per-artifact notes. `runMeta` is mocked so every test
// controls exactly what the panel's own fetch resolves or rejects with.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderParamsPanel } from '../src/ui/params-panel'
import { ApiError, type IngestState } from '../src/data/client'
import * as client from '../src/data/client'
import type { RunConfig } from '../src/views/map'

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({
    gl: { clearColor: vi.fn(), clear: vi.fn(), viewport: vi.fn(), COLOR_BUFFER_BIT: 0 },
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

function mount(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

function parTableBuffer(columns: Record<string, unknown[]>): ArrayBuffer {
  const ipc = tableToIPC(tableFromArrays(columns), 'stream')
  return ipc.buffer.slice(ipc.byteOffset, ipc.byteOffset + ipc.byteLength) as ArrayBuffer
}

const BASIC_COLUMNS = {
  parnme: ['p1', 'p2'],
  pargp: ['G1', 'G1'],
  parlbnd: [0.1, null],
  parubnd: [10, null],
  partrans: ['log', null],
}

describe('renderParamsPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows exactly one muted "Loading parameters…" line during the first fetch, no skeleton rows', () => {
    const el = mount()
    vi.spyOn(client, 'runMeta').mockReturnValue(new Promise(() => {}))
    renderParamsPanel(el, { unmapped: [], artifactNotes: [] })

    expect(el.textContent).toContain('Loading parameters…')
    expect(el.querySelectorAll('.param-row').length).toBe(0)
  })

  it('names the artifact and the reason in place of the table when the fetch fails', async () => {
    const el = mount()
    vi.spyOn(client, 'runMeta').mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'bad read', status: 502, artifact: 'meta', detail: 'the control file is not readable' }),
    )
    renderParamsPanel(el, { unmapped: [], artifactNotes: [] })

    await vi.waitFor(() => {
      expect(el.textContent).toContain('The parameter table could not be read')
    })
    expect(el.textContent).toContain('meta')
    expect(el.textContent).toContain('the control file is not readable')
    expect(el.textContent).not.toContain('Loading parameters')
  })

  it('a table of 100,000 parameters puts fewer than 200 row elements in the DOM at once, and scrolling replaces them', async () => {
    const el = mount()
    const n = 100_000
    const columns = {
      parnme: Array.from({ length: n }, (_, i) => `p${i}`),
      pargp: Array.from({ length: n }, () => 'G1'),
      parlbnd: Array.from({ length: n }, () => 0),
      parubnd: Array.from({ length: n }, () => 1),
      partrans: Array.from({ length: n }, () => 'none'),
    }
    vi.spyOn(client, 'runMeta').mockResolvedValue(parTableBuffer(columns))
    renderParamsPanel(el, { unmapped: [], artifactNotes: [] })

    await vi.waitFor(() => {
      expect(el.querySelector('.scroll-pane')).not.toBeNull()
    })

    const rowsBefore = el.querySelectorAll('.param-row').length
    expect(rowsBefore).toBeGreaterThan(0)
    expect(rowsBefore).toBeLessThan(200)

    const namesBefore = Array.from(el.querySelectorAll('.param-row')).map((r) => r.textContent)

    const scrollPane = el.querySelector('.scroll-pane') as HTMLElement
    scrollPane.scrollTop = 50_000
    scrollPane.dispatchEvent(new Event('scroll'))

    const rowsAfter = el.querySelectorAll('.param-row').length
    expect(rowsAfter).toBeLessThan(200)
    const namesAfter = Array.from(el.querySelectorAll('.param-row')).map((r) => r.textContent)
    expect(namesAfter).not.toEqual(namesBefore)
  })

  it('a parameter with no recorded bounds shows an em dash, never a zero', async () => {
    const el = mount()
    vi.spyOn(client, 'runMeta').mockResolvedValue(parTableBuffer(BASIC_COLUMNS))
    renderParamsPanel(el, { unmapped: [], artifactNotes: [] })

    await vi.waitFor(() => {
      expect(el.querySelectorAll('.param-row').length).toBe(2)
    })
    const rows = el.querySelectorAll('.param-row')
    expect(rows[1].textContent).toContain('—')
    expect(rows[1].textContent).not.toContain('0')
  })

  it('reads every column by field name, proven by reversing the column order', async () => {
    const forward = mount()
    vi.spyOn(client, 'runMeta').mockResolvedValueOnce(parTableBuffer(BASIC_COLUMNS))
    renderParamsPanel(forward, { unmapped: [], artifactNotes: [] })
    await vi.waitFor(() => expect(forward.querySelectorAll('.param-row').length).toBe(2))
    const forwardText = Array.from(forward.querySelectorAll('.param-row')).map((r) => r.textContent)

    const reversedColumns = Object.fromEntries(Object.entries(BASIC_COLUMNS).reverse())
    const reversed = mount()
    vi.spyOn(client, 'runMeta').mockResolvedValueOnce(parTableBuffer(reversedColumns))
    renderParamsPanel(reversed, { unmapped: [], artifactNotes: [] })
    await vi.waitFor(() => expect(reversed.querySelectorAll('.param-row').length).toBe(2))
    const reversedText = Array.from(reversed.querySelectorAll('.param-row')).map((r) => r.textContent)

    expect(reversedText).toEqual(forwardText)
  })

  it('truncates a long parameter or group name and carries the full string in a title', async () => {
    const el = mount()
    const longName = 'p'.repeat(200)
    vi.spyOn(client, 'runMeta').mockResolvedValue(
      parTableBuffer({ parnme: [longName], pargp: ['G1'], parlbnd: [0], parubnd: [1], partrans: ['none'] }),
    )
    renderParamsPanel(el, { unmapped: [], artifactNotes: [] })

    await vi.waitFor(() => {
      expect(el.querySelectorAll('.param-row').length).toBe(1)
    })
    const nameEl = el.querySelector('.param-row .truncate') as HTMLElement
    expect(nameEl.classList.contains('truncate')).toBe(true)
    expect(nameEl.title).toBe(longName)
  })

  it('lists the unmapped groups and the per-artifact notes passed through, never rebuilt independently', () => {
    const el = mount()
    vi.spyOn(client, 'runMeta').mockReturnValue(new Promise(() => {}))
    renderParamsPanel(el, {
      unmapped: [{ group: 'G9', note: 'a recorded placement note' }],
      artifactNotes: [{ artifact: 'par_ens', reason: 'one realization dropped' }],
    })

    expect(el.textContent).toContain('1 group unmapped')
    expect(el.textContent).toContain('a recorded placement note')
    expect(el.textContent).toContain('par_ens')
    expect(el.textContent).toContain('one realization dropped')
  })
})

describe('the status bar carries real figures (Task 3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('renders ingest time, cache size, mesh size and the current selection with tabular-nums', async () => {
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
    const STATE: IngestState = {
      fresh: true,
      artifacts: [],
      capabilities: {
        map: { available: true, blockedBy: [] },
        stats: { available: true, blockedBy: [] },
        chips: { available: true, blockedBy: [] },
      },
      ingestSeconds: 12.3,
      cacheBytes: 4096,
    }

    const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 2, nlay: 1, bounds: [0, 1, 0, 1], crs: null, tag: 'tag1' }
    const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
    const CELL_INDEX = new Float32Array([0, 0, 1, 1])
    const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
    const PARMAP = new Int32Array([0])
    const CELL_ARRAY = new Int32Array([0])
    const LAYER_ARRAY = new Int32Array([0])
    const PAR_TABLE = tableToIPC(tableFromArrays({ parnme: ['p0'], pargp: ['G1'], partrans: ['none'] }), 'stream')
    const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')
    const VALUES = new Float32Array([5])

    function bytesOf(view: ArrayBufferView): Uint8Array {
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    }
    function metaHeader(dtype: string): Record<string, string> {
      return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = (init?.method ?? 'GET').toUpperCase()
        const path = url.split('?')[0]
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
          case '/api/run/grid/values':
            return respond({ status: 200, bytes: bytesOf(VALUES) })
          case '/api/run/view':
            if (method === 'GET') {
              return respond({
                status: 200,
                body: { divider: 0.72, colormap: 'viridis', reverse: false, scale: 'linear', limits_mode: 'robust', group: null, stat: 'value' },
              })
            }
            return respond({ status: 200, body: {} })
          default:
            return respond({ status: 404, body: { type: 'about:blank', title: 'not found', status: 404 } })
        }
      }),
    )

    const { mountMap } = await import('../src/views/map')
    const root = document.createElement('div')
    document.body.appendChild(root)
    mountMap(root, { config: CONFIG, state: STATE })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    const statusBar = root.querySelector('.status-bar') as HTMLElement
    expect(statusBar.textContent).toContain('Ingest time')
    expect(statusBar.textContent).toContain('12.3 s')
    expect(statusBar.textContent).toContain('Cache size')
    expect(statusBar.textContent).toContain('4.0 KB')
    expect(statusBar.textContent).toContain('Mesh size')
    expect(statusBar.textContent).toContain('Selection')

    const numericSpans = Array.from(statusBar.querySelectorAll('.tabular-nums'))
    expect(numericSpans.length).toBeGreaterThan(0)
  })
})
