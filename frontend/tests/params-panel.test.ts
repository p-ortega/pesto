// @vitest-environment jsdom
//
// The Params panel (D-09/E8): the windowed parameter table, the unmapped
// list and the per-artifact notes. The parameter table answer is handed
// in, so every test controls exactly what the panel resolves or rejects with.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderParamsPanel, type ParamsPanelOptions } from '../src/ui/params-panel'
import { ApiError, type IngestState } from '../src/data/client'
import type { ParGroupRow, ParGroupsPayload } from '../src/data/par'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import type { RunConfig } from '../src/views/map'
import { createRecording2d } from './support/recording-2d'

const parApi = vi.hoisted(() => ({
  fetchParGroups: vi.fn(),
  fetchPlacement: vi.fn(),
  fetchParHist: vi.fn(),
  fetchParChange: vi.fn(),
  fetchParValues: vi.fn(),
}))
vi.mock('../src/data/par', async () => ({
  ...parApi,
  shareGroupsRead: (await vi.importActual<typeof import('../src/data/par')>('../src/data/par')).shareGroupsRead,
}))

const overlaysApi = vi.hoisted(() => ({ fetchAtBounds: vi.fn() }))
vi.mock('../src/data/overlays', () => overlaysApi)

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

// A store that starts with the given groups chosen; flush() is called by hand.
function makeStore(chosen: string[] = []): SelectionStore {
  const initial = { ...emptySelection('run', 0), parGroups: new Set(chosen) }
  return createSelectionStore({ initial, schedule: () => {} })
}

function panelOptions(over: Partial<ParamsPanelOptions> = {}): ParamsPanelOptions {
  return { unmapped: [], artifactNotes: [], parTable: new Promise(() => {}), store: makeStore(), ...over }
}

const STATED = (value: string | null, source = 'parameter name') => ({ value, source, note: null })

function groupRow(group: string, over: Partial<ParGroupRow> = {}): ParGroupRow {
  return {
    group,
    n_par: 3,
    n_included: 3,
    excluded: { fixed: 0, tied: 0, nonpositive_log: 0, no_values: 0, unknown_transform: 0 },
    type: STATED('array'),
    layer: { value: 0, source: 'placement rule grid', note: null },
    change: {
      pesto: {
        mean_change_pct: 12.5,
        sd_change_pct: 4,
        mean_shift_sd_median: 0.3,
        n_used: 3,
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
    sigma_ratio: { state: 'shown', median: 0.42, p10: 0.3, p90: 0.61, n_used: 3, n_no_spread: 0, reason: null },
    at_bounds_last: { near_lower: 0, near_upper: 0, n_counted: 3 },
    drill_down: { offered: true, reason: null },
    notes: [],
    ...over,
  }
}

function groupsPayload(groups: ParGroupRow[], over: Partial<ParGroupsPayload> = {}): ParGroupsPayload {
  return {
    first_iteration: 0,
    last_iteration: 3,
    n_common: 5,
    single_iteration: false,
    left_out: { count: 0, n_only_first: 0, n_only_last: 0, only_first: [], only_last: [], reason: null },
    groups,
    notes: [],
    ...over,
  }
}

function groupsAnswer(groups: ParGroupRow[], over: Partial<ParGroupsPayload> = {}) {
  return { ok: true, payload: groupsPayload(groups, over) }
}

function groupRows(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>('.group-row')]
}

function cell(row: HTMLElement, column: string): HTMLElement {
  return row.querySelector(`[data-column="${column}"]`) as HTMLElement
}

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

beforeEach(() => {
  parApi.fetchParGroups.mockReset()
  parApi.fetchParGroups.mockResolvedValue({ ok: false, artifact: 'par_groups', reason: 'not stubbed' })
  parApi.fetchPlacement.mockReset()
  for (const name of ['fetchParHist', 'fetchParChange', 'fetchParValues'] as const) {
    parApi[name].mockReset()
    parApi[name].mockResolvedValue({ ok: false, artifact: 'par_hist', reason: 'not stubbed' })
  }
  overlaysApi.fetchAtBounds.mockReset()
  overlaysApi.fetchAtBounds.mockResolvedValue({ ok: false, artifact: 'par_change', reason: 'not stubbed' })
})

describe('renderParamsPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows exactly one muted "Loading parameters…" line during the first fetch, no skeleton rows', () => {
    const el = mount()
    renderParamsPanel(el, panelOptions())

    expect(el.textContent).toContain('Loading parameters…')
    expect(el.querySelectorAll('.param-row').length).toBe(0)
  })

  it('names the artifact and the reason in place of the table when the fetch fails', async () => {
    const el = mount()
    const parTable = Promise.reject(
      new ApiError({ type: 'about:blank', title: 'bad read', status: 502, artifact: 'meta', detail: 'the control file is not readable' }),
    )
    renderParamsPanel(el, panelOptions({ parTable, store: makeStore(['G1']) }))

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
    renderParamsPanel(el, panelOptions({ parTable: Promise.resolve(parTableBuffer(columns)), store: makeStore(['G1']) }))

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
    renderParamsPanel(el, panelOptions({ parTable: Promise.resolve(parTableBuffer(BASIC_COLUMNS)), store: makeStore(['G1']) }))

    await vi.waitFor(() => {
      expect(el.querySelectorAll('.param-row').length).toBe(2)
    })
    const rows = el.querySelectorAll('.param-row')
    expect(rows[1].textContent).toContain('—')
    expect(rows[1].textContent).not.toContain('0')
  })

  it('reads every column by field name, proven by reversing the column order', async () => {
    const forward = mount()
    renderParamsPanel(forward, panelOptions({ parTable: Promise.resolve(parTableBuffer(BASIC_COLUMNS)), store: makeStore(['G1']) }))
    await vi.waitFor(() => expect(forward.querySelectorAll('.param-row').length).toBe(2))
    const forwardText = Array.from(forward.querySelectorAll('.param-row')).map((r) => r.textContent)

    const reversedColumns = Object.fromEntries(Object.entries(BASIC_COLUMNS).reverse())
    const reversed = mount()
    renderParamsPanel(reversed, panelOptions({ parTable: Promise.resolve(parTableBuffer(reversedColumns)), store: makeStore(['G1']) }))
    await vi.waitFor(() => expect(reversed.querySelectorAll('.param-row').length).toBe(2))
    const reversedText = Array.from(reversed.querySelectorAll('.param-row')).map((r) => r.textContent)

    expect(reversedText).toEqual(forwardText)
  })

  it('truncates a long parameter or group name and carries the full string in a title', async () => {
    const el = mount()
    const longName = 'p'.repeat(200)
    const parTable = Promise.resolve(
      parTableBuffer({ parnme: [longName], pargp: ['G1'], parlbnd: [0], parubnd: [1], partrans: ['none'] }),
    )
    renderParamsPanel(el, panelOptions({ parTable, store: makeStore(['G1']) }))

    await vi.waitFor(() => {
      expect(el.querySelectorAll('.param-row').length).toBe(1)
    })
    const nameEl = el.querySelector('.param-row .truncate') as HTMLElement
    expect(nameEl.classList.contains('truncate')).toBe(true)
    expect(nameEl.title).toBe(longName)
  })

  it('lists the unmapped groups and the per-artifact notes passed through, never rebuilt independently', () => {
    const el = mount()
    renderParamsPanel(
      el,
      panelOptions({
        unmapped: [{ group: 'G9', note: 'a recorded placement note' }],
        artifactNotes: [{ artifact: 'par_ens', reason: 'one realization dropped' }],
      }),
    )

    expect(el.textContent).toContain('1 group unmapped')
    expect(el.textContent).toContain('a recorded placement note')
    expect(el.textContent).toContain('par_ens')
    expect(el.textContent).toContain('one realization dropped')
  })

  it('lets Tab reach each scrolling list, so a keyboard user can scroll it', async () => {
    const el = mount()
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('G1')]))
    renderParamsPanel(
      el,
      panelOptions({
        unmapped: [{ group: 'G9', note: null }],
        artifactNotes: [{ artifact: 'par_ens', reason: 'one realization dropped' }],
        parTable: Promise.resolve(parTableBuffer(BASIC_COLUMNS)),
        store: makeStore(['G1']),
      }),
    )

    await vi.waitFor(() => {
      expect(el.querySelectorAll('.scroll-pane').length).toBe(4)
    })
    const panes = [...el.querySelectorAll<HTMLElement>('.scroll-pane')]
    for (const pane of panes) expect(pane.tabIndex).toBe(0)
    expect(panes.map((p) => p.getAttribute('aria-label')).sort()).toEqual([
      'Notes',
      'Parameter groups',
      'Parameter table',
      'Unmapped groups',
    ])
  })
})

describe('the group summary', () => {
  it('shows one row per group in the payload order, with its figures and headings that name pesto and pestpp', async () => {
    parApi.fetchParGroups.mockResolvedValue(
      groupsAnswer([
        groupRow('hk'),
        groupRow('ghb_layer0_pp', {
          n_par: 7,
          type: { value: null, source: 'not stated', note: 'no ptype tag in the parameter names and no ptype column' },
          layer: { value: 'several', source: 'placement rule grid', note: 'placed on layers 0, 1 (zero-based)' },
        }),
      ]),
    )
    const el = mount()
    renderParamsPanel(el, panelOptions())

    await vi.waitFor(() => expect(groupRows(el).length).toBe(2))
    const rows = groupRows(el)
    expect(rows.map((r) => r.dataset.group)).toEqual(['hk', 'ghb_layer0_pp'])
    expect(cell(rows[0], 'group').textContent).toContain('hk')
    expect(cell(rows[0], 'type').textContent).toBe('array')
    expect(cell(rows[0], 'layer').textContent).toBe('0')
    expect(cell(rows[0], 'n_par').textContent).toBe('3')
    expect(cell(rows[0], 'pesto').textContent).toContain('12.5')
    expect(cell(rows[0], 'pestpp').textContent).toContain('11.8')

    const headings = [...el.querySelectorAll('.group-header [role="columnheader"]')].map((h) => h.textContent ?? '')
    expect(headings.some((h) => h.includes('Mean change, pesto'))).toBe(true)
    expect(headings.some((h) => h.includes('Mean change, pestpp'))).toBe(true)
  })

  it('names the source of each change figure in the cell title', async () => {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('hk')]))
    const el = mount()
    renderParamsPanel(el, panelOptions())

    await vi.waitFor(() => expect(groupRows(el).length).toBe(1))
    const row = groupRows(el)[0]
    expect(cell(row, 'pesto').title).toContain('pesto, over the 5 realizations present in both iterations')
    expect(cell(row, 'pestpp').title).toContain('pestpp, case.3.pcs.csv')
  })

  it('says "not stated" for a missing type and "several" for a layer that is not one number', async () => {
    parApi.fetchParGroups.mockResolvedValue(
      groupsAnswer([
        groupRow('g', {
          type: { value: null, source: 'not stated', note: 'no ptype tag' },
          layer: { value: 'several', source: 'placement rule grid', note: 'placed on layers 0, 1 (zero-based)' },
        }),
      ]),
    )
    const el = mount()
    renderParamsPanel(el, panelOptions())

    await vi.waitFor(() => expect(groupRows(el).length).toBe(1))
    const row = groupRows(el)[0]
    expect(cell(row, 'type').textContent).toBe('not stated')
    expect(cell(row, 'type').title).toContain('no ptype tag')
    expect(cell(row, 'layer').textContent).toBe('several')
    expect(cell(row, 'layer').title).toContain('placed on layers 0, 1')
  })

  it('shows a dash for a missing pestpp figure and keeps the stated reason as the cell title', async () => {
    const base = groupRow('g')
    parApi.fetchParGroups.mockResolvedValue(
      groupsAnswer([
        groupRow('g', {
          change: {
            ...base.change,
            pestpp: {
              mean_change: null,
              std_change: null,
              num_at_near_lbound: null,
              num_at_near_ubound: null,
              source: null,
              note: 'the pcs.csv file for iteration 3 was not found',
            },
          },
        }),
      ]),
    )
    const el = mount()
    renderParamsPanel(el, panelOptions())

    await vi.waitFor(() => expect(groupRows(el).length).toBe(1))
    const pestpp = cell(groupRows(el)[0], 'pestpp')
    expect(pestpp.textContent).toBe('—')
    expect(pestpp.title).toContain('the pcs.csv file for iteration 3 was not found')
  })

  it('shows a dash for a missing pesto figure and keeps the stated reason as the cell title', async () => {
    const base = groupRow('g')
    parApi.fetchParGroups.mockResolvedValue(
      groupsAnswer([
        groupRow('g', {
          change: { ...base.change, pesto: null, reason: 'only one iteration was ingested, so there is no change to show' },
        }),
      ]),
    )
    const el = mount()
    renderParamsPanel(el, panelOptions())

    await vi.waitFor(() => expect(groupRows(el).length).toBe(1))
    const pesto = cell(groupRows(el)[0], 'pesto')
    expect(pesto.textContent).toBe('—')
    expect(pesto.title).toContain('only one iteration was ingested')
  })

  it('writes the clicked group into the shared selection with origin "params" and marks its row', async () => {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('hk'), groupRow('rch')]))
    const store = makeStore()
    const heard: { groups: string[]; origins: string[] }[] = []
    store.subscribe(
      (s) => s.parGroups,
      (next, _prev, origins) => heard.push({ groups: [...next.parGroups], origins: [...origins] }),
    )
    const el = mount()
    renderParamsPanel(el, panelOptions({ store }))
    await vi.waitFor(() => expect(groupRows(el).length).toBe(2))

    groupRows(el)[0].click()
    store.flush()

    expect([...store.get().parGroups]).toEqual(['hk'])
    expect(heard).toEqual([{ groups: ['hk'], origins: ['params'] }])
    const rows = groupRows(el)
    expect(rows[0].getAttribute('aria-selected')).toBe('true')
    expect(rows[1].getAttribute('aria-selected')).toBe('false')
  })

  it('marks the row of a group another view chose, without writing anything back', async () => {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('hk'), groupRow('rch')]))
    const store = makeStore()
    const el = mount()
    renderParamsPanel(el, panelOptions({ store }))
    await vi.waitFor(() => expect(groupRows(el).length).toBe(2))

    store.set({ parGroups: new Set(['rch']) }, 'map')
    store.flush()

    expect(groupRows(el)[1].getAttribute('aria-selected')).toBe('true')
    expect(groupRows(el)[0].getAttribute('aria-selected')).toBe('false')
  })

  it('names the artifact and the reason in place of the table when the group summary is not there', async () => {
    parApi.fetchParGroups.mockResolvedValue({
      ok: false,
      artifact: 'par_groups',
      reason: 'par_groups.json was not found in the cache',
    })
    const el = mount()
    renderParamsPanel(el, panelOptions())

    await vi.waitFor(() => expect(el.textContent).toContain('The group summary could not be read'))
    expect(el.textContent).toContain('par_groups')
    expect(el.textContent).toContain('par_groups.json was not found in the cache')
    expect(groupRows(el).length).toBe(0)
  })

  it('makes no group request while the panel starts hidden, and one when it is first shown', async () => {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('hk')]))
    const el = mount()
    const handle = renderParamsPanel(el, panelOptions({ startHidden: true }))
    await Promise.resolve()
    expect(parApi.fetchParGroups).not.toHaveBeenCalled()
    expect(groupRows(el).length).toBe(0)

    handle.onShow()
    await vi.waitFor(() => expect(groupRows(el).length).toBe(1))
    expect(parApi.fetchParGroups).toHaveBeenCalledTimes(1)

    handle.onHide()
    handle.onShow()
    expect(parApi.fetchParGroups).toHaveBeenCalledTimes(1)
  })

  it('sets every group name and note as text, never as markup', async () => {
    const nasty = '<img src=x onerror=alert(1)>'
    parApi.fetchParGroups.mockResolvedValue(
      groupsAnswer([groupRow(nasty, { type: { value: nasty, source: nasty, note: nasty } })]),
    )
    const el = mount()
    renderParamsPanel(el, panelOptions({ unmapped: [{ group: nasty, note: nasty }] }))

    await vi.waitFor(() => expect(groupRows(el).length).toBe(1))
    expect(el.querySelector('img')).toBeNull()
    expect(cell(groupRows(el)[0], 'group').textContent).toContain(nasty)
  })
})

function withChange(row: ParGroupRow, pesto: number | null, pestpp: number | null): ParGroupRow {
  return {
    ...row,
    change: {
      pesto: pesto === null ? null : { ...row.change.pesto!, mean_change_pct: pesto },
      pestpp: { ...row.change.pestpp, mean_change: pestpp },
      reason: pesto === null ? 'no figure' : null,
    },
  }
}

function headingButton(el: HTMLElement, column: string): HTMLButtonElement {
  return el.querySelector(`.group-header [data-column="${column}"] button`) as HTMLButtonElement
}

function shownOrder(el: HTMLElement): (string | undefined)[] {
  return groupRows(el).map((r) => r.dataset.group)
}

describe('sorting the group table', () => {
  const rows = [
    withChange(groupRow('a'), 5, 1),
    withChange(groupRow('b'), null, null),
    withChange(groupRow('c'), 20, 3),
    withChange(groupRow('d'), 5, 2),
    withChange(groupRow('e'), 1, null),
  ]

  async function mounted() {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer(rows))
    const el = mount()
    renderParamsPanel(el, panelOptions())
    await vi.waitFor(() => expect(groupRows(el).length).toBe(5))
    return el
  }

  it('starts in control-file order', async () => {
    const el = await mounted()

    expect(shownOrder(el)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(el.querySelector('[data-column="pesto"][role="columnheader"]')?.getAttribute('aria-sort')).toBe('none')
  })

  it('sorts a number column ascending, then descending, with empty values last both ways', async () => {
    const el = await mounted()

    headingButton(el, 'pesto').click()
    expect(shownOrder(el)).toEqual(['e', 'a', 'd', 'c', 'b'])
    expect(el.querySelector('[data-column="pesto"][role="columnheader"]')?.getAttribute('aria-sort')).toBe('ascending')

    headingButton(el, 'pesto').click()
    expect(shownOrder(el)).toEqual(['c', 'a', 'd', 'e', 'b'])
    expect(el.querySelector('[data-column="pesto"][role="columnheader"]')?.getAttribute('aria-sort')).toBe('descending')
  })

  it('keeps control-file order between two equal values, whichever way it sorts', async () => {
    const el = await mounted()

    headingButton(el, 'pesto').click()
    const ascending = shownOrder(el)
    expect(ascending.indexOf('a')).toBeLessThan(ascending.indexOf('d'))

    headingButton(el, 'pesto').click()
    const descending = shownOrder(el)
    expect(descending.indexOf('a')).toBeLessThan(descending.indexOf('d'))
  })

  it('starts a new column ascending and clears the mark on the old one', async () => {
    const el = await mounted()

    headingButton(el, 'pesto').click()
    headingButton(el, 'pestpp').click()

    expect(shownOrder(el)).toEqual(['a', 'd', 'c', 'b', 'e'])
    expect(el.querySelector('[data-column="pesto"][role="columnheader"]')?.getAttribute('aria-sort')).toBe('none')
    expect(el.querySelector('[data-column="pestpp"][role="columnheader"]')?.getAttribute('aria-sort')).toBe('ascending')
  })

  it('sorts the group column as text and keeps the chosen row marked after a sort', async () => {
    parApi.fetchParGroups.mockResolvedValue(
      groupsAnswer([groupRow('rch'), groupRow('hk'), groupRow('ghb')]),
    )
    const el = mount()
    renderParamsPanel(el, panelOptions({ store: makeStore(['hk']) }))
    await vi.waitFor(() => expect(groupRows(el).length).toBe(3))

    headingButton(el, 'group').click()

    expect(shownOrder(el)).toEqual(['ghb', 'hk', 'rch'])
    expect(groupRows(el).map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
  })

  it('puts a layer given as "several" after the numbered layers and a layer that is not stated last', async () => {
    const layered = (group: string, value: number | 'several' | null) =>
      groupRow(group, { layer: { value, source: 'placement rule grid', note: null } })
    parApi.fetchParGroups.mockResolvedValue(
      groupsAnswer([layered('s', 'several'), layered('n', null), layered('l2', 2), layered('l0', 0)]),
    )
    const el = mount()
    renderParamsPanel(el, panelOptions())
    await vi.waitFor(() => expect(groupRows(el).length).toBe(4))

    headingButton(el, 'layer').click()

    expect(shownOrder(el)).toEqual(['l0', 'l2', 's', 'n'])
  })
})

describe('the drill-down list and the groups that are not on the map', () => {
  const TWO_GROUPS = {
    parnme: ['hk1', 'hk2', 'hk3', 'rch1', 'rch2'],
    pargp: ['hk', 'hk', 'hk', 'rch', 'rch'],
    parlbnd: [0, 0, 0, 0, 0],
    parubnd: [1, 1, 1, 1, 1],
    partrans: ['none', 'none', 'none', 'none', 'none'],
  }

  function listedNames(el: HTMLElement): (string | null)[] {
    return [...el.querySelectorAll('.param-row')].map((r) => r.firstElementChild!.textContent)
  }

  it('asks for a group to be chosen before it lists any parameter', async () => {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('hk'), groupRow('rch')]))
    const el = mount()
    renderParamsPanel(el, panelOptions({ parTable: Promise.resolve(parTableBuffer(TWO_GROUPS)) }))

    await vi.waitFor(() => expect(groupRows(el).length).toBe(2))
    expect(el.textContent).toContain('Choose a group above to list its parameters')
    expect(el.querySelectorAll('.param-row').length).toBe(0)
  })

  it('lists only the chosen group\'s parameters, and follows the choice when it moves', async () => {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('hk'), groupRow('rch')]))
    const store = makeStore()
    const el = mount()
    renderParamsPanel(el, panelOptions({ parTable: Promise.resolve(parTableBuffer(TWO_GROUPS)), store }))
    await vi.waitFor(() => expect(groupRows(el).length).toBe(2))

    groupRows(el)[0].click()
    store.flush()
    expect(listedNames(el)).toEqual(['hk1', 'hk2', 'hk3'])

    groupRows(el)[1].click()
    store.flush()
    expect(listedNames(el)).toEqual(['rch1', 'rch2'])
  })

  it('shows the stored reason and no list for a group the drill-down is not offered for', async () => {
    const reason = 'This group has 12,000 parameters. Drill-down is offered up to 10,000.'
    parApi.fetchParGroups.mockResolvedValue(
      groupsAnswer([groupRow('hk', { drill_down: { offered: false, reason } }), groupRow('rch')]),
    )
    const store = makeStore(['hk'])
    const el = mount()
    renderParamsPanel(el, panelOptions({ parTable: Promise.resolve(parTableBuffer(TWO_GROUPS)), store }))

    await vi.waitFor(() => expect(el.textContent).toContain(reason))
    expect(el.querySelectorAll('.param-row').length).toBe(0)
  })

  it('says "not on the map" for a group the map cannot draw, with the recorded note as secondary text', async () => {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('hk'), groupRow('u')]))
    const el = mount()
    renderParamsPanel(
      el,
      panelOptions({ unmapped: [{ group: 'u', note: "group 'u' carries 'layer', which looks like placement data but ..." }] }),
    )

    await vi.waitFor(() => expect(groupRows(el).length).toBe(2))
    const [onMap, offMap] = groupRows(el)
    expect(onMap.textContent).not.toContain('not on the map')
    expect(offMap.textContent).toContain('not on the map')
    expect(offMap.textContent).toContain("group 'u' carries 'layer'")
  })

  it('says only "not on the map" when the unmapped entry has no note', async () => {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('u')]))
    const el = mount()
    renderParamsPanel(el, panelOptions({ unmapped: [{ group: 'u', note: null }] }))

    await vi.waitFor(() => expect(groupRows(el).length).toBe(1))
    expect(groupRows(el)[0].textContent).toContain('not on the map')
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

// ---------------------------------------------------------------------------
// The detail under the group table: histograms, change, sigma ratio, and the
// one-parameter drill-down. The canvas is a recording context.
// ---------------------------------------------------------------------------

const HIST_EDGES = Array.from({ length: 51 }, (_, i) => -2 + i * 0.1)
const HIST_DENSITY = Array.from({ length: 50 }, (_, i) => 0.1 + (i % 4) * 0.05)

function histAnswer(group: string, over: Record<string, unknown> = {}) {
  return {
    ok: true,
    payload: {
      group,
      space: 'log10',
      edges: HIST_EDGES,
      first: { iteration: 0, n: 5, counts: HIST_DENSITY.map(() => 1), density: HIST_DENSITY },
      last: { iteration: 6, n: 5, counts: HIST_DENSITY.map(() => 1), density: HIST_DENSITY },
      n_common: 5,
      left_out: { count: 0, reason: null },
      excluded: {},
      refused: null,
      notes: [],
      ...over,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function legendTexts(calls: { method: string; args: unknown[] }[]): string[] {
  return calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0]))
}

function canvasLabels(el: HTMLElement): string[] {
  return [...el.querySelectorAll('canvas')].map((c) => c.getAttribute('aria-label') ?? '')
}

const LIST_COLUMNS = {
  parnme: ['hk1', 'hk2', 'hk3', 'rch1'],
  pargp: ['hk', 'hk', 'hk', 'rch'],
  parlbnd: [0.1, 0.1, 0.1, 0],
  parubnd: [10, 10, 10, 1],
  partrans: ['log', 'log', 'log', 'none'],
}

describe('the group detail under the table', () => {
  let recording: ReturnType<typeof createRecording2d>

  beforeEach(() => {
    recording = createRecording2d()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recording.ctx as never)
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(200)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function mountWith(groupNames: string[], over: Partial<ParamsPanelOptions> = {}) {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer(groupNames.map((name) => groupRow(name))))
    const store = over.store ?? makeStore()
    const el = mount()
    const handle = renderParamsPanel(el, panelOptions({ store, parTable: Promise.resolve(parTableBuffer(LIST_COLUMNS)), ...over }))
    if (over.startHidden !== true) await vi.waitFor(() => expect(groupRows(el).length).toBe(groupNames.length))
    return { el, store, handle }
  }

  it('asks /par/hist for the chosen group once and draws its prior and posterior', async () => {
    parApi.fetchParHist.mockResolvedValue(histAnswer('hk'))
    const { el, store } = await mountWith(['hk', 'rch'])

    groupRows(el)[0].click()
    store.flush()

    await vi.waitFor(() => expect(legendTexts(recording.calls)).toContain('posterior, iteration 6'))
    expect(parApi.fetchParHist).toHaveBeenCalledTimes(1)
    expect(parApi.fetchParHist.mock.calls[0][0]).toBe('hk')
    expect(legendTexts(recording.calls)).toContain('prior, iteration 0')
    expect(canvasLabels(el)[0]).toContain('hk')
  })

  it('draws only the latest group when an older answer arrives after a newer choice', async () => {
    const answerA = deferred<unknown>()
    const answerB = deferred<unknown>()
    parApi.fetchParHist.mockImplementation((group: string) => (group === 'a' ? answerA.promise : answerB.promise))
    const { el, store } = await mountWith(['a', 'b'])

    groupRows(el)[0].click()
    store.flush()
    groupRows(el)[1].click()
    store.flush()
    answerB.resolve(histAnswer('b'))
    await vi.waitFor(() => expect(canvasLabels(el).length).toBe(1))
    answerA.resolve(histAnswer('a'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(canvasLabels(el).length).toBe(1)
    expect(canvasLabels(el)[0]).toContain('group b')
    expect(el.textContent).toContain('Group b')
    expect(el.textContent).not.toContain('Group a')
  })

  it('makes no request while the tab is hidden, and asks once when it is shown', async () => {
    parApi.fetchParHist.mockResolvedValue(histAnswer('hk'))
    const { el, store, handle } = await mountWith(['hk'])

    handle.onHide()
    store.set({ parGroups: new Set(['hk']) }, 'test')
    store.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(parApi.fetchParHist).not.toHaveBeenCalled()
    expect(el.querySelector('canvas')).toBeNull()

    handle.onShow()
    await vi.waitFor(() => expect(legendTexts(recording.calls)).toContain('prior, iteration 0'))
    expect(parApi.fetchParHist).toHaveBeenCalledTimes(1)
  })

  it('makes no group or histogram request for a panel that starts hidden until it is shown', async () => {
    parApi.fetchParHist.mockResolvedValue(histAnswer('hk'))
    const { handle } = await mountWith(['hk'], { startHidden: true, store: makeStore(['hk']) })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(parApi.fetchParGroups).not.toHaveBeenCalled()
    expect(parApi.fetchParHist).not.toHaveBeenCalled()

    handle.onShow()
    await vi.waitFor(() => expect(legendTexts(recording.calls)).toContain('prior, iteration 0'))
    expect(parApi.fetchParHist).toHaveBeenCalledTimes(1)
  })

  it('names the blocking artifact and its reason, and asks for nothing, when the parameter view is not available', async () => {
    const { el } = await mountWith(['hk'], {
      store: makeStore(['hk']),
      parView: { available: false, blockedBy: [{ artifact: 'par_change', reason: 'the control file has no parameters' }] },
    })

    await vi.waitFor(() => expect(el.textContent).toContain('par_change: the control file has no parameters'))
    expect(parApi.fetchParHist).not.toHaveBeenCalled()
    expect(parApi.fetchParChange).not.toHaveBeenCalled()
    expect(el.querySelector('canvas')).toBeNull()
  })

  it('shows a refused histogram as a notice and still shows the change and sigma ratio', async () => {
    const reason = '2 log-transformed and 1 untransformed parameters cannot share one axis, so this group has no histogram'
    parApi.fetchParHist.mockResolvedValue(histAnswer('hk', { space: null, edges: null, first: null, last: null, refused: reason }))
    const { el, store } = await mountWith(['hk'])

    groupRows(el)[0].click()
    store.flush()

    await vi.waitFor(() => expect(el.textContent).toContain(reason))
    expect(el.querySelector('canvas')).toBeNull()
    expect(el.textContent).toContain('sigma ratio 0.42')
  })

  it('names the artifact and reason when the histogram request fails', async () => {
    parApi.fetchParHist.mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'bad read', status: 502, artifact: 'par_hist', detail: 'the histogram file is damaged' }),
    )
    const { el, store } = await mountWith(['hk'])

    groupRows(el)[0].click()
    store.flush()

    await vi.waitFor(() => expect(el.textContent).toContain('par_hist: the histogram file is damaged'))
  })

  it('redraws at the real size when a shown, hidden and shown tab comes back, without asking again', async () => {
    parApi.fetchParHist.mockResolvedValue(histAnswer('hk'))
    const { el, store, handle } = await mountWith(['hk'])
    groupRows(el)[0].click()
    store.flush()
    await vi.waitFor(() => expect(legendTexts(recording.calls)).toContain('prior, iteration 0'))

    handle.onHide()
    recording.calls.length = 0
    handle.onShow()

    expect(legendTexts(recording.calls)).toContain('prior, iteration 0')
    expect(parApi.fetchParHist).toHaveBeenCalledTimes(1)
  })
})

describe('the sigma ratio column in the group table', () => {
  const REFUSED = 'Not shown: the ensemble was reinflated at iteration 4 (source: case.rec).'
  const WARNING = 'Reinflation could not be checked: no run record was found.'

  function sigmaGroups(): ParGroupRow[] {
    return [
      groupRow('a', { sigma_ratio: { state: 'shown', median: 0.7, p10: 0.5, p90: 0.9, n_used: 3, n_no_spread: 0, reason: null } }),
      groupRow('b', { sigma_ratio: { state: 'refused', median: null, p10: null, p90: null, n_used: null, n_no_spread: null, reason: REFUSED } }),
      groupRow('c', { sigma_ratio: { state: 'unchecked', median: 0.2, p10: 0.1, p90: 0.3, n_used: 3, n_no_spread: 0, reason: WARNING } }),
    ]
  }

  async function mountSigma(): Promise<HTMLElement> {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer(sigmaGroups()))
    const el = mount()
    renderParamsPanel(el, panelOptions())
    await vi.waitFor(() => expect(groupRows(el).length).toBe(3))
    return el
  }

  it('shows the median, the median with a warning mark, or "not shown" with the stored reason as the title', async () => {
    const el = await mountSigma()
    const [a, b, c] = groupRows(el)

    expect(cell(a, 'sigma').textContent).toBe('0.70')
    expect(cell(b, 'sigma').textContent).toBe('not shown')
    expect(cell(b, 'sigma').title).toBe(REFUSED)
    expect(cell(c, 'sigma').textContent).toBe('0.20 ⚠')
    expect(cell(c, 'sigma').title).toBe(WARNING)
  })

  it('shows no number for a refused ratio anywhere in its row', async () => {
    const el = await mountSigma()

    expect(groupRows(el)[1].querySelector('[data-column="sigma"]')!.textContent).not.toMatch(/\d/)
  })

  it('sorts on the ratio with a refused one last both ways', async () => {
    const el = await mountSigma()
    const button = el.querySelector<HTMLButtonElement>('[data-column="sigma"] button')!
    const order = () => groupRows(el).map((r) => r.dataset.group)

    button.click()
    expect(order()).toEqual(['c', 'a', 'b'])
    button.click()
    expect(order()).toEqual(['a', 'c', 'b'])
  })
})

describe('the change columns and the one-parameter drill-down', () => {
  beforeEach(() => {
    const recording = createRecording2d()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recording.ctx as never)
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(200)
    parApi.fetchParHist.mockResolvedValue(histAnswer('hk'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function change(parnme: string, over: Record<string, unknown> = {}) {
    return {
      parnme,
      included: true,
      excluded_reason: null,
      mean_change_pct: 5,
      mean_change_refused: null,
      sd_change_pct: -20,
      sd_change_refused: null,
      mean_shift_sd: 0.25,
      ...over,
    }
  }

  function valuesAnswer(parameter: string, over: Record<string, unknown> = {}) {
    return {
      ok: true,
      payload: {
        parameter,
        group: 'hk',
        space: 'log10',
        n_common: 5,
        left_out: { count: 0, reason: null },
        edges: HIST_EDGES,
        first: { iteration: 0, n: 5, counts: HIST_DENSITY.map(() => 1), density: HIST_DENSITY, mean: 0.1, sd: 0.2 },
        last: { iteration: 6, n: 5, counts: HIST_DENSITY.map(() => 1), density: HIST_DENSITY, mean: 0.3, sd: 0.1 },
        refused: null,
        notes: [],
        ...over,
      },
    }
  }

  async function mountChosen(rows = [change('hk1'), change('hk2'), change('hk3')]) {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('hk'), groupRow('rch')]))
    parApi.fetchParChange.mockResolvedValue({ ok: true, payload: rows })
    const store = makeStore(['hk'])
    const el = mount()
    renderParamsPanel(el, panelOptions({ store, parTable: Promise.resolve(parTableBuffer(LIST_COLUMNS)) }))
    await vi.waitFor(() => expect(el.querySelectorAll('.param-row').length).toBe(3))
    return { el, store }
  }

  function paramRow(el: HTMLElement, name: string): HTMLElement {
    return el.querySelector(`.param-row[data-parameter="${name}"]`) as HTMLElement
  }

  function figure(el: HTMLElement, name: string, column: string): HTMLElement {
    return paramRow(el, name).querySelector(`[data-column="${column}"]`) as HTMLElement
  }

  it('asks /par/change for the chosen group once and shows mean change, sd change and shift beside the bounds', async () => {
    const { el } = await mountChosen()

    await vi.waitFor(() => expect(figure(el, 'hk1', 'mean_change').textContent).toBe('5%'))
    expect(parApi.fetchParChange).toHaveBeenCalledTimes(1)
    expect(parApi.fetchParChange.mock.calls[0][0]).toBe('hk')
    expect(figure(el, 'hk1', 'sd_change').textContent).toBe('-20%')
    expect(figure(el, 'hk1', 'shift').textContent).toBe('0.25')
    const headings = [...el.querySelectorAll('.param-header span')].map((c) => c.textContent)
    expect(headings).toEqual(['Parameter', 'Group', 'Lower', 'Upper', 'Transform', 'Mean change', 'SD change', 'Shift (prior sd)'])
  })

  it('joins change rows to the list by parameter name when their order differs', async () => {
    const { el } = await mountChosen([
      change('hk3', { mean_change_pct: 3 }),
      change('hk1', { mean_change_pct: 1 }),
      change('hk2', { mean_change_pct: 2 }),
    ])

    await vi.waitFor(() => expect(figure(el, 'hk1', 'mean_change').textContent).toBe('1%'))
    expect(figure(el, 'hk2', 'mean_change').textContent).toBe('2%')
    expect(figure(el, 'hk3', 'mean_change').textContent).toBe('3%')
  })

  it('shows a dash with the refusal reason as the title where a percent change was refused', async () => {
    const reason = 'the prior mean is too close to zero for a percent change'
    const { el } = await mountChosen([
      change('hk1', { mean_change_pct: null, mean_change_refused: reason }),
      change('hk2'),
      change('hk3'),
    ])

    await vi.waitFor(() => expect(figure(el, 'hk2', 'mean_change').textContent).toBe('5%'))
    expect(figure(el, 'hk1', 'mean_change').textContent).toBe('—')
    expect(figure(el, 'hk1', 'mean_change').title).toBe(reason)
  })

  it('shows a dash with the reason for a parameter that was left out of the change figures', async () => {
    const { el } = await mountChosen([
      change('hk1', { included: false, excluded_reason: 'fixed: the parameter does not move', mean_change_pct: null }),
      change('hk2'),
      change('hk3'),
    ])

    await vi.waitFor(() => expect(figure(el, 'hk2', 'mean_change').textContent).toBe('5%'))
    expect(figure(el, 'hk1', 'mean_change').textContent).toBe('—')
    expect(figure(el, 'hk1', 'sd_change').title).toBe('fixed: the parameter does not move')
  })

  it('names the artifact and reason when the change figures cannot be read', async () => {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('hk')]))
    parApi.fetchParChange.mockResolvedValue({ ok: false, artifact: 'par_change', reason: 'par_change.parquet is not in the cache' })
    const el = mount()
    renderParamsPanel(el, panelOptions({ store: makeStore(['hk']), parTable: Promise.resolve(parTableBuffer(LIST_COLUMNS)) }))

    await vi.waitFor(() => expect(el.textContent).toContain('par_change: par_change.parquet is not in the cache'))
    expect(figure(el, 'hk1', 'mean_change').textContent).toBe('—')
  })

  it('draws the clicked parameter\'s own prior and posterior from /par/values', async () => {
    parApi.fetchParValues.mockResolvedValue(valuesAnswer('hk2'))
    const { el } = await mountChosen()

    paramRow(el, 'hk2').click()

    await vi.waitFor(() => expect(canvasLabels(el).some((label) => label.includes('hk2'))).toBe(true))
    expect(parApi.fetchParValues).toHaveBeenCalledTimes(1)
    expect(parApi.fetchParValues.mock.calls[0][0]).toBe('hk2')
    expect(el.textContent).toContain('Parameter hk2')
    expect(paramRow(el, 'hk2').getAttribute('aria-selected')).toBe('true')
  })

  it('shows an excluded parameter\'s stored reason and draws nothing for it', async () => {
    const reason = 'fixed: the parameter does not move'
    parApi.fetchParValues.mockResolvedValue(valuesAnswer('hk1', { edges: null, first: null, last: null, refused: reason }))
    const { el } = await mountChosen()

    paramRow(el, 'hk1').click()

    await vi.waitFor(() => expect(el.textContent).toContain(reason))
    expect(canvasLabels(el).some((label) => label.includes('hk1'))).toBe(false)
  })

  it('shows the problem\'s detail as a notice when the group is over the drill-down limit', async () => {
    const detail = 'This group has 12,000 parameters. Drill-down is offered up to 10,000.'
    parApi.fetchParValues.mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'drill-down is not offered', status: 409, artifact: 'par_groups', detail }),
    )
    const { el } = await mountChosen()

    paramRow(el, 'hk1').click()

    await vi.waitFor(() => expect(el.textContent).toContain(detail))
  })

  it('draws only the latest parameter when an older answer arrives after a newer click', async () => {
    const answerOne = deferred<unknown>()
    const answerTwo = deferred<unknown>()
    parApi.fetchParValues.mockImplementation((name: string) => (name === 'hk1' ? answerOne.promise : answerTwo.promise))
    const { el } = await mountChosen()

    paramRow(el, 'hk1').click()
    paramRow(el, 'hk2').click()
    answerTwo.resolve(valuesAnswer('hk2'))
    await vi.waitFor(() => expect(canvasLabels(el).some((label) => label.includes('hk2'))).toBe(true))
    answerOne.resolve(valuesAnswer('hk1'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(canvasLabels(el).some((label) => label.includes('hk1'))).toBe(false)
    expect(el.textContent).toContain('Parameter hk2')
    expect(el.textContent).not.toContain('Parameter hk1')
  })

  it('drops the parameter detail when another group is chosen', async () => {
    parApi.fetchParValues.mockResolvedValue(valuesAnswer('hk2'))
    const { el, store } = await mountChosen()
    paramRow(el, 'hk2').click()
    await vi.waitFor(() => expect(el.textContent).toContain('Parameter hk2'))

    groupRows(el)[1].click()
    store.flush()

    expect(el.textContent).not.toContain('Parameter hk2')
  })

  it('makes no change request for a group the drill-down is not offered for', async () => {
    parApi.fetchParGroups.mockResolvedValue(
      groupsAnswer([groupRow('hk', { drill_down: { offered: false, reason: 'This group has 12,000 parameters.' } })]),
    )
    const el = mount()
    renderParamsPanel(el, panelOptions({ store: makeStore(['hk']), parTable: Promise.resolve(parTableBuffer(LIST_COLUMNS)) }))

    await vi.waitFor(() => expect(el.textContent).toContain('This group has 12,000 parameters.'))
    expect(parApi.fetchParChange).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Phase 11: the parameter rows read and write the shared `pars` (D-01, D-02,
// D-03, D-08). A row click selects; another view's choice marks and dims.
// ---------------------------------------------------------------------------

describe('the parameter rows and the shared pars selection', () => {
  const SIX = {
    parnme: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
    pargp: ['G', 'G', 'G', 'G', 'G', 'G'],
    parlbnd: [0, 0, 0, 0, 0, 0],
    parubnd: [1, 1, 1, 1, 1, 1],
    partrans: ['none', 'none', 'none', 'none', 'none', 'none'],
  }

  beforeEach(() => {
    const recording = createRecording2d()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recording.ctx as never)
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('G')]))
    parApi.fetchParValues.mockImplementation(async (name: string) => ({ ok: false, artifact: 'par_values', reason: `no values for ${name}` }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function mountSix(columns: Record<string, unknown[]> = SIX) {
    const store = makeStore(['G'])
    const el = mount()
    const handle = renderParamsPanel(el, panelOptions({ store, parTable: Promise.resolve(parTableBuffer(columns)) }))
    await vi.waitFor(() => expect(el.querySelectorAll('.params-table .param-row').length).toBeGreaterThan(0))
    return { el, store, handle }
  }

  function row(el: HTMLElement, name: string): HTMLElement {
    return el.querySelector(`.params-table .param-row[data-parameter="${name}"]`) as HTMLElement
  }

  function tableNames(el: HTMLElement): string[] {
    return [...el.querySelectorAll<HTMLElement>('.params-table .param-row')].map((r) => r.dataset.parameter ?? '')
  }

  function click(target: HTMLElement, mods: { shiftKey?: boolean; altKey?: boolean } = {}): void {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, ...mods }))
  }

  function lastValuesAsked(): string | undefined {
    const calls = parApi.fetchParValues.mock.calls
    return calls.length === 0 ? undefined : calls[calls.length - 1][0]
  }

  it('a plain click replaces, shift adds and alt removes, each written to pars with origin "params"', async () => {
    const { el, store } = await mountSix()
    const heard: { pars: string[]; origins: string[] }[] = []
    store.subscribe(
      (s) => s.pars,
      (next, _prev, origins) => heard.push({ pars: [...next.pars], origins: [...origins] }),
    )

    click(row(el, 'p2'))
    store.flush()
    expect([...store.get().pars]).toEqual(['p2'])
    expect(lastValuesAsked()).toBe('p2')

    click(row(el, 'p3'), { shiftKey: true })
    store.flush()
    expect(new Set(store.get().pars)).toEqual(new Set(['p2', 'p3']))
    expect(lastValuesAsked()).toBe('p3')

    click(row(el, 'p2'), { altKey: true })
    store.flush()
    expect([...store.get().pars]).toEqual(['p3'])
    expect(lastValuesAsked()).toBe('p3')

    expect(heard.every((entry) => entry.origins.length === 1 && entry.origins[0] === 'params')).toBe(true)
    expect(heard.length).toBe(3)
  })

  it('moves the detail to the last remaining selected parameter, and closes it when nothing is left', async () => {
    const { el, store } = await mountSix()
    click(row(el, 'p2'))
    click(row(el, 'p4'), { shiftKey: true })
    click(row(el, 'p5'), { shiftKey: true })
    store.flush()
    expect(lastValuesAsked()).toBe('p5')

    click(row(el, 'p5'), { altKey: true })
    store.flush()
    expect(lastValuesAsked()).toBe('p4')

    click(row(el, 'p4'), { altKey: true })
    click(row(el, 'p2'), { altKey: true })
    store.flush()
    expect(store.get().pars.size).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(el.textContent).not.toContain('Loading distribution')
    expect(el.textContent).not.toContain('no values for p2')
  })

  it('treats Enter as a plain click and shift+Enter as a shift-click', async () => {
    const { el, store } = await mountSix()

    row(el, 'p1').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    row(el, 'p6').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    store.flush()

    expect(new Set(store.get().pars)).toEqual(new Set(['p1', 'p6']))
  })

  it('marks and dims rows for pars another view wrote, with no request and no detail change', async () => {
    const { el, store } = await mountSix()

    store.set({ pars: new Set(['p5']) }, 'map')
    store.flush()

    expect(row(el, 'p5').getAttribute('aria-selected')).toBe('true')
    expect(row(el, 'p5').classList.contains('dimmed')).toBe(false)
    for (const name of ['p1', 'p2', 'p3', 'p4', 'p6']) {
      expect(row(el, name).getAttribute('aria-selected')).toBe('false')
      expect(row(el, name).classList.contains('dimmed')).toBe(true)
    }
    expect(parApi.fetchParValues).not.toHaveBeenCalled()
    expect(el.textContent).not.toContain('Loading distribution')
  })

  it('dims nothing when pars is empty', async () => {
    const { el, store } = await mountSix()
    store.set({ pars: new Set(['p5']) }, 'map')
    store.flush()
    store.set({ pars: new Set() }, 'map')
    store.flush()

    expect(el.querySelectorAll('.params-table .param-row.dimmed').length).toBe(0)
    expect(el.querySelectorAll('.params-table .param-row[aria-selected="true"]').length).toBe(0)
  })

  it('keeps every row in its place whatever is selected', async () => {
    const { el, store } = await mountSix()
    const before = tableNames(el)

    store.set({ pars: new Set(['p6', 'p1']) }, 'map')
    store.flush()
    expect(tableNames(el)).toEqual(before)

    click(row(el, 'p3'), { shiftKey: true })
    store.flush()
    expect(tableNames(el)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
  })

  it('"Show selected" scrolls to the first selected row in table order', async () => {
    const n = 300
    const columns = {
      parnme: Array.from({ length: n }, (_, i) => `p${i}`),
      pargp: Array.from({ length: n }, () => 'G'),
      parlbnd: Array.from({ length: n }, () => 0),
      parubnd: Array.from({ length: n }, () => 1),
      partrans: Array.from({ length: n }, () => 'none'),
    }
    const { el, store } = await mountSix(columns)
    const button = el.querySelector<HTMLButtonElement>('.params-table button.show-selected')!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('no selected parameter is in this group')

    store.set({ pars: new Set(['p250', 'p180']) }, 'map')
    store.flush()
    expect(button.disabled).toBe(false)
    button.click()

    const pane = el.querySelector<HTMLElement>('.params-table .scroll-pane')!
    expect(pane.scrollTop).toBe(180 * 24)
    expect(tableNames(el)).toContain('p180')
  })

  it('disables "Show selected" when no selected parameter is in the shown group', async () => {
    const { el, store } = await mountSix()
    store.set({ pars: new Set(['not-in-this-group']) }, 'map')
    store.flush()

    const button = el.querySelector<HTMLButtonElement>('.params-table button.show-selected')!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('no selected parameter is in this group')
  })

  it('never writes parGroups from a row click, whatever the modifier', async () => {
    const { el, store } = await mountSix()
    const groupWrites: string[][] = []
    store.subscribe(
      (s) => s.parGroups,
      (next) => groupWrites.push([...next.parGroups]),
    )

    click(row(el, 'p1'))
    click(row(el, 'p2'), { shiftKey: true })
    click(row(el, 'p1'), { altKey: true })
    row(el, 'p3').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    store.flush()

    expect(groupWrites).toEqual([])
    expect([...store.get().parGroups]).toEqual(['G'])
  })
})

describe('the Selected parameters section in the panel', () => {
  const MIXED = {
    parnme: ['a1', 'a2', 'b1'],
    pargp: ['A', 'A', 'B'],
    parlbnd: [0, 0, 0],
    parubnd: [1, 1, 1],
    partrans: ['none', 'none', 'none'],
  }

  beforeEach(() => {
    const recording = createRecording2d()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(recording.ctx as never)
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('A'), groupRow('B')]))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function selectedNames(el: HTMLElement): string[] {
    return [...el.querySelectorAll<HTMLElement>('.params-selected [data-selected-parameter]')].map((r) => r.dataset.selectedParameter ?? '')
  }

  async function mountMixed(startHidden = false) {
    const store = makeStore(['A'])
    const el = mount()
    const handle = renderParamsPanel(el, panelOptions({ store, startHidden, parTable: Promise.resolve(parTableBuffer(MIXED)) }))
    if (!startHidden) await vi.waitFor(() => expect(el.querySelectorAll('.params-table .param-row').length).toBe(2))
    else await new Promise((resolve) => setTimeout(resolve, 0))
    return { el, store, handle }
  }

  it('is hidden while pars is empty and lists another view\'s pars grouped by the table\'s pargp', async () => {
    const { el, store } = await mountMixed()
    const section = el.querySelector<HTMLElement>('.params-selected')!
    expect(section.style.display).toBe('none')

    store.set({ pars: new Set(['b1', 'a2']) }, 'map')
    store.flush()

    expect(section.style.display).not.toBe('none')
    expect(selectedNames(el)).toEqual(['b1', 'a2'])
    expect([...section.querySelectorAll<HTMLElement>('.selected-group')].map((g) => g.dataset.group)).toEqual(['B', 'A'])
  })

  it('routes a click in the section through the modifier rule into pars with origin "params", never parGroups', async () => {
    const { el, store } = await mountMixed()
    store.set({ pars: new Set(['a1', 'b1']) }, 'map')
    store.flush()
    const heard: string[][] = []
    store.subscribe(
      (s) => s.pars,
      (_next, _prev, origins) => heard.push([...origins]),
    )

    const b1 = el.querySelector<HTMLElement>('.params-selected [data-selected-parameter="b1"]')!
    b1.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
    store.flush()

    expect([...store.get().pars]).toEqual(['a1'])
    expect(heard).toEqual([['params']])
    expect([...store.get().parGroups]).toEqual(['A'])
    expect(selectedNames(el)).toEqual(['a1'])
  })

  it('draws a pars change made while hidden when the tab is shown, and fetches nothing for it', async () => {
    const { el, store, handle } = await mountMixed(true)
    store.set({ pars: new Set(['a1']) }, 'map')
    store.flush()
    expect(selectedNames(el)).toEqual([])

    handle.onShow()
    expect(selectedNames(el)).toEqual(['a1'])
    expect(parApi.fetchParValues).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Phase 11: the at-bounds column in the group table (D-25, D-26, D-27), fed by
// /par/at_bounds for the map's shown iteration.
// ---------------------------------------------------------------------------

describe('the at-bounds column in the group table', () => {
  const RULE = 'A parameter is at its bounds when pestpp counts it near a bound in at least one realization.'
  const CAVEAT = 'Counts from the float32 cache can be one high against pcs.csv.'

  function atBoundsAnswer(iteration: number, groups: { group: string; n: number; excluded?: Record<string, number> }[]) {
    return {
      ok: true,
      answer: {
        available: true,
        reason: null,
        artifact: 'par_change',
        iteration,
        firstIteration: 0,
        lastIteration: 3,
        rule: RULE,
        caveat: CAVEAT,
        groups: groups.map(({ group, n, excluded }) => ({
          group,
          nPar: 10,
          nCounted: 10,
          nAtBounds: n,
          nExcluded: excluded ?? {},
        })),
        names: null,
      },
    }
  }

  function unavailable(iteration: number, reason: string) {
    return {
      ok: true,
      answer: {
        available: false,
        reason,
        artifact: 'par_change',
        iteration,
        firstIteration: 0,
        lastIteration: 3,
        rule: RULE,
        caveat: CAVEAT,
        groups: [],
        names: null,
      },
    }
  }

  function storeAt(iteration: number): SelectionStore {
    return createSelectionStore({ initial: { ...emptySelection('run', iteration) }, schedule: () => {} })
  }

  async function mountGroups(store: SelectionStore, startHidden = false) {
    parApi.fetchParGroups.mockResolvedValue(groupsAnswer([groupRow('hk'), groupRow('rch'), groupRow('ghb')]))
    const el = mount()
    const handle = renderParamsPanel(el, panelOptions({ store, startHidden }))
    if (!startHidden) await vi.waitFor(() => expect(groupRows(el).length).toBe(3))
    return { el, handle }
  }

  function heading(el: HTMLElement): HTMLElement {
    return el.querySelector('.group-header [data-column="at_bounds"]') as HTMLElement
  }

  it('asks once for the shown iteration and puts each group\'s count in the eighth cell with the rule, caveat and exclusions as its title', async () => {
    overlaysApi.fetchAtBounds.mockResolvedValue(
      atBoundsAnswer(3, [
        { group: 'hk', n: 4, excluded: { fixed: 3, tied: 2 } },
        { group: 'rch', n: 0 },
        { group: 'ghb', n: 12 },
      ]),
    )
    const { el } = await mountGroups(storeAt(3))

    await vi.waitFor(() => expect(cell(groupRows(el)[0], 'at_bounds').textContent).toBe('4'))
    expect(overlaysApi.fetchAtBounds).toHaveBeenCalledTimes(1)
    expect(overlaysApi.fetchAtBounds.mock.calls[0][0]).toBe(3)
    const hk = groupRows(el)[0]
    expect(hk.children.length).toBe(8)
    expect(hk.children[7].getAttribute('data-column')).toBe('at_bounds')
    expect(cell(hk, 'at_bounds').title).toBe(`${RULE} ${CAVEAT} 5 excluded: fixed 3, tied 2`)
    expect(cell(groupRows(el)[1], 'at_bounds').textContent).toBe('0')
    expect(cell(groupRows(el)[1], 'at_bounds').title).toBe(`${RULE} ${CAVEAT} 0 excluded`)
    expect(heading(el).textContent).toContain('At bounds, iteration 3')
    expect(el.querySelectorAll('.group-header [role="columnheader"]').length).toBe(8)
  })

  it('shows a dash and the reason in every row and the heading for a middle iteration', async () => {
    const reason = 'near-bound counts exist for iterations 0 and 3 only'
    overlaysApi.fetchAtBounds.mockResolvedValue(unavailable(2, reason))
    const { el } = await mountGroups(storeAt(2))

    await vi.waitFor(() => expect(cell(groupRows(el)[0], 'at_bounds').title).toBe(reason))
    for (const row of groupRows(el)) {
      expect(cell(row, 'at_bounds').textContent).toBe('—')
      expect(cell(row, 'at_bounds').title).toBe(reason)
    }
    expect(heading(el).title).toBe(reason)
  })

  it('shows a dash with the artifact and reason for a refused answer', async () => {
    overlaysApi.fetchAtBounds.mockResolvedValue({ ok: false, artifact: 'par_change', reason: 'par_change.parquet is not in the cache' })
    const { el } = await mountGroups(storeAt(0))

    await vi.waitFor(() => expect(cell(groupRows(el)[0], 'at_bounds').title).toBe('par_change: par_change.parquet is not in the cache'))
    expect(cell(groupRows(el)[0], 'at_bounds').textContent).toBe('—')
    expect(heading(el).title).toBe('par_change: par_change.parquet is not in the cache')
  })

  it('names the artifact and reason when the request throws', async () => {
    overlaysApi.fetchAtBounds.mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'bad read', status: 502, artifact: 'par_change', detail: 'the frame is damaged' }),
    )
    const { el } = await mountGroups(storeAt(0))

    await vi.waitFor(() => expect(cell(groupRows(el)[0], 'at_bounds').title).toBe('par_change: the frame is damaged'))
  })

  it('sorts on the count with a group that has none last both ways', async () => {
    overlaysApi.fetchAtBounds.mockResolvedValue(atBoundsAnswer(3, [{ group: 'hk', n: 4 }, { group: 'ghb', n: 1 }]))
    const { el } = await mountGroups(storeAt(3))
    await vi.waitFor(() => expect(cell(groupRows(el)[0], 'at_bounds').textContent).toBe('4'))
    const button = headingButton(el, 'at_bounds')

    button.click()
    expect(shownOrder(el)).toEqual(['ghb', 'hk', 'rch'])
    button.click()
    expect(shownOrder(el)).toEqual(['hk', 'ghb', 'rch'])
    expect(cell(groupRows(el)[2], 'at_bounds').textContent).toBe('—')
  })

  it('makes no request while hidden, and asks for the iteration chosen meanwhile when shown', async () => {
    overlaysApi.fetchAtBounds.mockResolvedValue(atBoundsAnswer(3, [{ group: 'hk', n: 4 }]))
    const store = storeAt(0)
    const { el, handle } = await mountGroups(store, true)

    store.set({ iteration: 3 }, 'map')
    store.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(overlaysApi.fetchAtBounds).not.toHaveBeenCalled()

    handle.onShow()
    await vi.waitFor(() => expect(cell(groupRows(el)[0], 'at_bounds').textContent).toBe('4'))
    expect(overlaysApi.fetchAtBounds).toHaveBeenCalledTimes(1)
    expect(overlaysApi.fetchAtBounds.mock.calls[0][0]).toBe(3)

    handle.onHide()
    handle.onShow()
    expect(overlaysApi.fetchAtBounds).toHaveBeenCalledTimes(1)
  })

  it('asks again when the iteration changes while shown, and never draws the old iteration\'s late answer', async () => {
    const old = deferred<unknown>()
    const fresh = deferred<unknown>()
    overlaysApi.fetchAtBounds.mockImplementation((iteration: number) => (iteration === 0 ? old.promise : fresh.promise))
    const store = storeAt(0)
    const { el } = await mountGroups(store)

    store.set({ iteration: 3 }, 'map')
    store.flush()
    expect(overlaysApi.fetchAtBounds).toHaveBeenCalledTimes(2)
    expect(overlaysApi.fetchAtBounds.mock.calls[1][0]).toBe(3)

    old.resolve(atBoundsAnswer(0, [{ group: 'hk', n: 99 }]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cell(groupRows(el)[0], 'at_bounds').textContent).not.toBe('99')

    fresh.resolve(atBoundsAnswer(3, [{ group: 'hk', n: 2 }]))
    await vi.waitFor(() => expect(cell(groupRows(el)[0], 'at_bounds').textContent).toBe('2'))
    expect(heading(el).textContent).toContain('iteration 3')
  })
})
