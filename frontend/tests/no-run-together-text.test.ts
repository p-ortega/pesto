// @vitest-environment jsdom
//
// WINDOWS.md #13: chrome.ts's renderNotice built its icon, tone word, title
// and detail as four adjacent spans inside a plain block `<div>` -- `gap`
// does nothing on a block container, so the live browser read
// "ℹNoteNo coordinate systemThis run has no CRS...", one run-together
// string. That is the third time this exact shape of bug has turned up in
// this phase: plan 05.1-01 fixed it on the status bar and ingest rows, a
// later gap fix added `.legend-figures` for the legend, and this gap fix
// found it again on the notices, the header chips' own siblings, the
// controls panel, and a directory entry's marker/name/reason parts. Each
// prior fix targeted one component; the next instance kept appearing
// somewhere else.
//
// This test targets the CLASS of bug instead of one more instance of it.
// It renders each of the seven modules the gap-closure brief named with
// the real stylesheet loaded into jsdom, walks every element that has two
// or more element children carrying real text, and fails -- naming the
// component and the two strings that run together -- when an adjacent pair
// has no real separation between them: no non-zero `gap` on a flex/grid
// parent, no non-zero margin on either side, no whitespace text node
// between them, and neither side is a block-level box that would force its
// own line regardless of gap. A future run-together spot in any of these
// seven modules fails this test too, not just the ones already known.
//
// `<select>` is exempted from the walk: its `<option>` children render one
// per native dropdown row by the browser's own form-control chrome, not by
// CSS box layout, so treating adjacent options as "run-together text" would
// be a false positive this test would raise on every select in the app.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RealNamesResult } from '../src/data/reals'
import type { IngestState } from '../src/data/client'
import type { RunConfig } from '../src/views/map'
import { renderChips, renderHeader, renderNotice, renderStatusBar } from '../src/ui/chrome'
import { renderLegend, type LegendOptions } from '../src/ui/legend'
import { renderSelectionControls } from '../src/ui/controls'
import { renderParamsPanel } from '../src/ui/params-panel'
import { renderConfigPanel } from '../src/ui/config-panel'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore } from '../src/state/selection'
import { renderGroupPicker } from '../src/ui/group-picker'
import { createRecordingGl } from './support/recording-gl'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

beforeEach(() => {
  loadRealStylesheet()
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.head.textContent = ''
  document.body.textContent = ''
})

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

// ---------------------------------------------------------------------------
// frontend/src/ui/chrome.ts
// ---------------------------------------------------------------------------

describe('chrome.ts (WINDOWS.md #13)', () => {
  it('renderNotice: the icon, tone word, title and detail never run together, for every tone', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    for (const tone of ['info', 'warning', 'serious', 'critical'] as const) {
      const host = document.createElement('div')
      root.appendChild(host)
      renderNotice(host, {
        title: 'No coordinate system',
        detail: "This run has no CRS. The map shows model coordinates with no scale bar -- that's normal, not a problem.",
        tone,
      })
    }
    expectNoRunTogetherText(root, 'chrome.ts renderNotice')
  })

  it('renderNotice: a notice with no detail still separates icon, word and title', () => {
    const root = document.createElement('div')
    renderNotice(root, { title: 'ingest complete', tone: 'info' })
    expectNoRunTogetherText(root, 'chrome.ts renderNotice (no detail)')
  })

  it('renderHeader: the title/subtitle pair and every header chip are separated, called the way every real screen calls it (a `.header`-classed container)', () => {
    const header = document.createElement('div')
    header.classList.add('header')
    document.body.appendChild(header)
    renderHeader(header, {
      title: 'demo_case',
      subtitle: 'a run with a real subtitle',
      themeChoice: 'dark',
      onThemeChange: () => undefined,
      chips: {
        config: {
          n_par: 128,
          n_real: 50,
          base_realization: true,
          n_iterations: 2,
          noptmax: 5,
          projection: null,
          has_noise: false,
        },
        failure: null,
      },
    })
    expectNoRunTogetherText(header, 'chrome.ts renderHeader')
  })

  it('renderHeader: the single failure chip replacing the row is not itself a run-together case', () => {
    const header = document.createElement('div')
    header.classList.add('header')
    renderHeader(header, {
      title: 'demo_case',
      themeChoice: 'light',
      onThemeChange: () => undefined,
      chips: { config: null, failure: { artifact: 'config', reason: 'run configuration could not be read' } },
    })
    expectNoRunTogetherText(header, 'chrome.ts renderHeader (failure chip)')
  })

  it('renderChips: every populated chip is separated from its neighbour, in the bare container renderChips itself is handed', () => {
    const el = document.createElement('div')
    renderChips(el, {
      config: {
        n_par: 128,
        n_real: 50,
        base_realization: false,
        n_iterations: 5,
        noptmax: 5,
        projection: 'EPSG:26910',
        has_noise: false,
      },
      failure: null,
    })
    expectNoRunTogetherText(el, 'chrome.ts renderChips')
  })

  it('renderStatusBar: label/value pairs and adjacent fields are separated, called the way every real screen calls it (a `.status-bar`-classed container)', () => {
    const statusBar = document.createElement('div')
    statusBar.classList.add('status-bar')
    renderStatusBar(statusBar, { 'Ingest time': '39.9 s', 'Cache size': '264.9 MB', Entries: 12 })
    expectNoRunTogetherText(statusBar, 'chrome.ts renderStatusBar')
  })
})

// ---------------------------------------------------------------------------
// frontend/src/ui/legend.ts
// ---------------------------------------------------------------------------

describe('legend.ts (WINDOWS.md #13)', () => {
  it('renderLegend: end values, scale/limits/group lines and the two absence counts never run together', () => {
    const el = document.createElement('div')
    const options: LegendOptions = {
      colormap: 'viridis',
      reverse: false,
      limits: [1.5, 98.25],
      scale: 'log10',
      scaleInferred: true,
      limitsMode: 'robust',
      group: 'hk1',
      contested: 3,
      noValue: 12,
    }
    renderLegend(el, options)
    expectNoRunTogetherText(el, 'legend.ts renderLegend')
  })
})

// ---------------------------------------------------------------------------
// frontend/src/ui/progress.ts
// ---------------------------------------------------------------------------

describe('progress.ts (WINDOWS.md #13)', () => {
  function scriptedReader(chunks: Uint8Array[]) {
    let index = 0
    return {
      read: async () => {
        if (index < chunks.length) {
          const value = chunks[index]
          index += 1
          return { done: false, value }
        }
        return { done: true, value: undefined }
      },
      releaseLock: () => undefined,
    }
  }

  const encoder = new TextEncoder()

  it('mountEstimate: the total, free-space and free-space-below-projection notice all separate their parts', async () => {
    const { mountEstimate } = await import('../src/ui/progress')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input, 'http://localhost')
        if (url.pathname === '/api/run/ingest/estimate') {
          return jsonResponse(200, {
            total: 200 * 1024 * 1024,
            per_artifact: [{ name: 'grid', bytes: 5 * 1024 * 1024 }],
            notes: ['control could not be sized: the .pst file carries no signal about table size'],
            free_bytes: 10 * 1024 * 1024,
            cache_root_exists: true,
          })
        }
        throw new Error(`unhandled request: ${url.pathname}`)
      }),
    )
    const root = document.createElement('div')
    document.body.appendChild(root)
    await mountEstimate(root, { onAgree: () => undefined, onDecline: () => undefined })
    expectNoRunTogetherText(root, 'progress.ts mountEstimate')
  })

  it('mountProgress: a failed row with a reason and notes, and the closing report with a blocked capability, never run their parts together', async () => {
    const { mountProgress } = await import('../src/ui/progress')
    const progressRow = {
      artifact: 'par_agg/head',
      state: 'failed',
      index: 0,
      total: 1,
      source_bytes: 4096,
      written_bytes: 0,
      seconds: 0,
      reason: 'crashed reading iteration 3',
      notes: ['3 NaN values repaired in realization 12'],
    }
    const text = `data: ${JSON.stringify(progressRow)}\n\nevent: done\ndata: {}\n\n`
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://localhost')
        const method = init?.method ?? 'GET'
        if (url.pathname === '/api/run/ingest' && method === 'POST') return jsonResponse(202, { started: true })
        if (url.pathname === '/api/run/ingest/state') {
          return jsonResponse(200, {
            fresh: false,
            artifacts: [],
            capabilities: {
              map: { available: true, blocked_by: [] },
              stats: { available: false, blocked_by: [{ artifact: 'par_agg/head', reason: 'crashed reading iteration 3' }] },
              chips: { available: true, blocked_by: [] },
            },
            ingest_seconds: 8.1,
            cache_bytes: 20 * 1024 * 1024,
          })
        }
        if (url.pathname === '/api/run/ingest/events') {
          return { ok: true, status: 200, body: { getReader: () => scriptedReader([encoder.encode(text)]) } }
        }
        throw new Error(`unhandled request: ${url.pathname}`)
      }),
    )
    const root = document.createElement('div')
    document.body.appendChild(root)
    mountProgress(root, { onFinished: () => undefined })
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    expectNoRunTogetherText(root, 'progress.ts mountProgress')
  })
})

// ---------------------------------------------------------------------------
// frontend/src/ui/params-panel.ts
// ---------------------------------------------------------------------------

describe('params-panel.ts (WINDOWS.md #13)', () => {
  it('the parameter table rows, the unmapped-group section and the per-artifact notes never run their parts together', async () => {
    const columns = {
      parnme: ['p1', 'p2'],
      pargp: ['G1', 'G1'],
      parlbnd: [0.1, null],
      parubnd: [10, null],
      partrans: ['log', null],
    }
    const ipc = tableToIPC(tableFromArrays(columns), 'stream')
    const bytes = ipc.buffer.slice(ipc.byteOffset, ipc.byteOffset + ipc.byteLength) as ArrayBuffer
    const el = document.createElement('div')
    document.body.appendChild(el)
    const store = createSelectionStore({
      initial: { ...emptySelection('run', 0), parGroups: new Set(['G1']) },
      schedule: () => {},
    })
    const none = { fixed: 0, tied: 0, nonpositive_log: 0, no_values: 0, unknown_transform: 0 }
    const groups = {
      ok: true as const,
      payload: {
        first_iteration: 0,
        last_iteration: 3,
        n_common: 5,
        single_iteration: false,
        left_out: { count: 0, n_only_first: 0, n_only_last: 0, only_first: [], only_last: [], reason: null },
        notes: [],
        groups: ['G1', 'G2'].map((group) => ({
          group,
          n_par: 2,
          n_included: 2,
          excluded: none,
          type: { value: 'array', source: 'parameter name', note: null },
          layer: { value: 0, source: 'placement rule grid', note: null },
          change: {
            pesto: {
              mean_change_pct: 12.5,
              sd_change_pct: 4,
              mean_shift_sd_median: 0.3,
              n_used: 2,
              n_refused_near_zero: 0,
              n_no_spread: 0,
              label: 'pesto, over the 5 realizations present in both iterations',
            },
            pestpp: {
              mean_change: 11.8,
              std_change: 3.9,
              num_at_near_lbound: 0,
              num_at_near_ubound: 0,
              source: 'pestpp, case.3.pcs.csv',
              note: null,
            },
            reason: null,
          },
          sigma_ratio: { state: 'shown' as const, median: 0.42, p10: 0.3, p90: 0.61, n_used: 2, n_no_spread: 0, reason: null },
          at_bounds_last: { near_lower: 0, near_upper: 0, n_counted: 2 },
          drill_down: { offered: true, reason: null },
          notes: [],
        })),
      },
    }
    renderParamsPanel(el, {
      unmapped: [
        { group: 'G2', note: null },
        { group: 'G3', note: 'no placement rule matched the control file' },
      ],
      artifactNotes: [{ artifact: 'par_ens/head', reason: 'group obs2 excluded' }],
      parTable: Promise.resolve(bytes),
      store,
      loadGroups: () => Promise.resolve(groups),
    })
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    expectNoRunTogetherText(el, 'params-panel.ts renderParamsPanel')
  })
})

// ---------------------------------------------------------------------------
// frontend/src/ui/config-panel.ts
// ---------------------------------------------------------------------------

describe('config-panel.ts (WINDOWS.md #13)', () => {
  it('renderConfigPanel: a value, its source, extra readings and the warning never run together', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const read = (source: string, value: boolean | null, shown: string) => ({ source, value, shown, evidence: '', extra: null })
    renderConfigPanel(el, {
      config: {
        facts: [
          {
            key: 'noise',
            label: 'Measurement noise',
            readings: [read('run record', false, 'no noise'), read('control file', true, 'noise on'), read('files present', null, 'file present')],
            agree: false,
            looked_for: [],
            note: 'decided by the run record',
          },
          { key: 'reinflation', label: 'Reinflation', readings: [], agree: null, looked_for: ['case.rec'], note: 'not found' },
        ],
      },
    })
    expectNoRunTogetherText(el, 'config-panel.ts renderConfigPanel')
  })
})

// ---------------------------------------------------------------------------
// frontend/src/ui/dir-picker.ts
// ---------------------------------------------------------------------------

describe('dir-picker.ts (WINDOWS.md #13)', () => {
  it('a run entry\'s marker and name, an unreadable entry\'s reason, and a plain entry\'s disabled-Open reason never run together', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input, 'http://localhost')
        if (url.pathname === '/api/fs/roots') {
          return jsonResponse(200, [
            { id: 'run', name: 'RunDir', is_run: true, reason: null },
            { id: 'bad', name: 'NoPermission', is_run: false, reason: 'cannot be read: permission denied' },
            { id: 'plain', name: 'PlainDir', is_run: false, reason: null },
          ])
        }
        throw new Error(`unhandled request: ${url.pathname}`)
      }),
    )
    const { mountPicker } = await import('../src/ui/dir-picker')
    const root = document.createElement('div')
    document.body.appendChild(root)
    mountPicker(root, { onOpened: () => undefined })
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    expectNoRunTogetherText(root, 'dir-picker.ts mountPicker')
  })
})

// ---------------------------------------------------------------------------
// frontend/src/ui/controls.ts
// ---------------------------------------------------------------------------

describe('controls.ts (WINDOWS.md #13)', () => {
  it('every control row -- the fit button, each labelled control, the log warning and the manual-limits inputs -- is separated from its neighbour', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const realNames: RealNamesResult = { ok: true, names: ['base', 'r001', 'r002'] }
    const handle = renderSelectionControls(el, {
      nlay: 3,
      iteration: 0,
      realNames,
      partrans: 'log',
      initial: {
        colormap: 'viridis',
        reverseColormap: false,
        scale: 'linear',
        scaleInferred: false,
        limitsMode: 'manual',
        manualLimits: [0, 1],
      },
      onSelectionChange: () => undefined,
      onFitToExtent: () => undefined,
    })
    // Surfaces the log-unavailable warning line -- another text-bearing
    // sibling inside the scale control's own label.
    handle.setLogUsability(4)
    expectNoRunTogetherText(el, 'controls.ts renderSelectionControls')
  })

  it('the realization-names-unavailable warning line does not run into its neighbours either', () => {
    const el = document.createElement('div')
    const realNames: RealNamesResult = { ok: false, iteration: 4, reason: 'no realization names were recorded for that iteration' }
    renderSelectionControls(el, {
      nlay: 1,
      iteration: 0,
      realNames,
      partrans: null,
      onSelectionChange: () => undefined,
      onFitToExtent: () => undefined,
    })
    expectNoRunTogetherText(el, 'controls.ts renderSelectionControls (no realization names)')
  })
})

// ---------------------------------------------------------------------------
// frontend/src/ui/group-picker.ts
// ---------------------------------------------------------------------------

describe('group-picker.ts (WINDOWS.md #14)', () => {
  it('the group select and the "N groups unmapped" button are separated', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    renderGroupPicker(el, {
      state: {
        kind: 'ready',
        interpolated: [],
        drawable: ['G1', 'G2'],
        unmapped: [{ group: 'G3', note: null }],
        selected: 'G1',
      },
      onGroupChange: () => undefined,
    })
    expectNoRunTogetherText(el, 'group-picker.ts renderGroupPicker')
  })

  it('the notice and the unmapped list of a run with nothing drawable are separated', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    renderGroupPicker(el, {
      state: { kind: 'none-drawable', unmapped: [{ group: 'G1', note: null }] },
      onGroupChange: () => undefined,
    })
    expectNoRunTogetherText(el, 'group-picker.ts renderGroupPicker (none drawable)')
  })
})

// ---------------------------------------------------------------------------
// frontend/src/views/map.ts
// ---------------------------------------------------------------------------

const mapRecording = createRecordingGl()

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({ gl: mapRecording.gl, onLost: vi.fn(), onRestored: vi.fn() })),
}))

describe('map.ts (WINDOWS.md #13)', () => {
  const CONFIG: RunConfig = {
    case: 'demo_case',
    n_par: 4,
    n_real: 2,
    base_realization: true,
    n_iterations: 1,
    noptmax: 5,
    first_iteration: 0,
    projection: null,
    projection_known: true,
    noise: { has_noise: false, decided_by: 'control file', evidence: [], notes: [] },
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
      ingestSeconds: 12.4,
      cacheBytes: 42 * 1024 * 1024,
    }
  }

  const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 2, nlay: 1, bounds: [0, 1, 0, 1], crs: null, tag: 'no-crs' }
  const POSITIONS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
  const CELL_INDEX = new Float32Array([0, 0, 1, 1])
  const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
  const PARMAP = new Int32Array([0, 1])
  const CELL_ARRAY = new Int32Array([0, 1])
  const LAYER_ARRAY = new Int32Array([0, 0])
  const FIELD = new Float32Array([10, 20])

  const PAR_TABLE = tableToIPC(tableFromArrays({ parnme: ['p0', 'p1'], pargp: ['G1', 'G1'], partrans: ['none', 'none'] }), 'stream')
  const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

  function bytesOf(view: ArrayBufferView): Uint8Array {
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  function metaHeader(dtype: string): Record<string, string> {
    return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
  }

  function stubEnvironment(): void {
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
            return respond({ status: 200, bytes: bytesOf(FIELD) })
          case '/api/run/view-state':
            return respond({ status: 200, body: null })
          default:
            throw new Error(`unhandled fetch in test: GET ${path}`)
        }
      }),
    )
  }

  it('the whole mounted screen -- header chips, the no-CRS notice, the status bar, the legend and the controls -- never runs text together', async () => {
    stubEnvironment()
    const { mountMap } = await import('../src/views/map')
    const root = document.createElement('div')
    document.body.appendChild(root)
    mountMap(root, { config: CONFIG, state: baseState() })

    await vi.waitFor(() => {
      expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    })

    expectNoRunTogetherText(root, 'views/map.ts mountMap')
  })
})
