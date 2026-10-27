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

const parApi = vi.hoisted(() => ({ fetchParGroups: vi.fn(), fetchPlacement: vi.fn() }))
vi.mock('../src/data/par', () => parApi)

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
