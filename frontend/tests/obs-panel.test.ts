// @vitest-environment jsdom
//
// The Obs panel: the group summary, the chosen group's sites, and the shared selection it writes.
// The two fetchers are mocked, so each test controls exactly what the panel is told.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import type { ObsGroupRow, ObsSiteRow } from '../src/data/obs'
import { renderObsPanel, type ObsPanelOptions } from '../src/ui/obs-panel'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'

const obsApi = vi.hoisted(() => ({
  fetchObsGroups: vi.fn(),
  fetchObsSites: vi.fn(),
  fetchObsSite: vi.fn(),
  fetchObsSeries: vi.fn(),
  fetchObsTimes: vi.fn(),
  fetchObs1to1: vi.fn(),
  fetchObsResidHist: vi.fn(),
  fetchObsPoints: vi.fn(),
}))
vi.mock('../src/data/obs', async () => ({
  ...(await vi.importActual<typeof import('../src/data/obs')>('../src/data/obs')),
  ...obsApi,
}))

const linkTargets = vi.hoisted(() => ({ fetchLinkSites: vi.fn() }))
vi.mock('../src/data/link-targets', async () => ({
  ...(await vi.importActual<typeof import('../src/data/link-targets')>('../src/data/link-targets')),
  ...linkTargets,
}))

const overlaysApi = vi.hoisted(() => ({ fetchPdcSites: vi.fn() }))
vi.mock('../src/data/overlays', async () => ({
  ...(await vi.importActual<typeof import('../src/data/overlays')>('../src/data/overlays')),
  ...overlaysApi,
}))

const linkApi = vi.hoisted(() => ({ recentCellLink: vi.fn() }))
vi.mock('../src/data/link', async () => ({
  ...(await vi.importActual<typeof import('../src/data/link')>('../src/data/link')),
  ...linkApi,
}))

function group(name: string, over: Partial<ObsGroupRow> = {}): ObsGroupRow {
  return {
    group: name,
    nObs: 100,
    nSites: 10,
    nPlaced: 8,
    nWeighted: 90,
    nWithTarget: 100,
    nZeroWeight: 10,
    nSentinel: 0,
    nNoValue: 0,
    timeKind: 'datetime',
    inequality: 'none',
    firstIteration: 0,
    lastIteration: 3,
    rmseFirst: 2.5,
    rmseLast: 1.25,
    nResidFirst: 100,
    nResidLast: 100,
    ...over,
  }
}

function pdcSites(entries: { id: number; nObs: number; group?: number }[]) {
  return {
    id: Int32Array.from(entries.map((e) => e.id)),
    cell: Int32Array.from(entries.map(() => 0)),
    layer: Int32Array.from(entries.map(() => 1)),
    groupIndex: Int32Array.from(entries.map((e) => e.group ?? 0)),
    nObs: Int32Array.from(entries.map((e) => e.nObs)),
  }
}

function pdcOn(iteration: number, over: Record<string, unknown> = {}) {
  return {
    ok: true,
    answer: {
      available: true,
      reason: null,
      artifact: `pdc/${iteration}`,
      iteration,
      source: 'file',
      sourceFile: 'case.3.pdc.csv',
      weightsSource: null,
      rule: null,
      nObs: 9,
      nSites: 3,
      nUnmatched: 0,
      nLeftOut: 0,
      byGroup: [{ group: 'gw_head', nObs: 7, nSites: 2 }],
      sites: pdcSites([
        { id: 40, nObs: 5 },
        { id: 41, nObs: 2 },
      ]),
      groups: ['gw_head'],
      notes: [],
      ...over,
    },
  }
}

function pdcOff(iteration: number, reason: string) {
  return {
    ok: true,
    answer: {
      available: false,
      reason,
      artifact: `pdc/${iteration}`,
      iteration,
      source: null,
      sourceFile: null,
      weightsSource: null,
      rule: null,
      nObs: null,
      nSites: null,
      nUnmatched: null,
      nLeftOut: null,
      byGroup: [],
      sites: pdcSites([]),
      groups: [],
      notes: [],
    },
  }
}

function groupsAnswer(rows: ObsGroupRow[], notes: string[] = []) {
  return { ok: true, rows, notes }
}

function makeStore(chosen: string[] = []): SelectionStore {
  return createSelectionStore({ initial: { ...emptySelection('run', 0), obsGroups: new Set(chosen) }, schedule: () => {} })
}

function available(): IngestState['capabilities'] {
  return {
    map: { available: true, blockedBy: [] },
    stats: { available: true, blockedBy: [] },
    chips: { available: true, blockedBy: [] },
    obs: { available: true, blockedBy: [] },
    obsStats: { available: true, blockedBy: [] },
    noise: { available: true, blockedBy: [] },
  }
}

function mount(over: Partial<ObsPanelOptions> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const store = over.store ?? makeStore()
  const handle = renderObsPanel(host, { store, capabilities: available(), ...over })
  return { host, store, handle }
}

function groupRows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('.obs-groups .obs-grid-row')]
}

function cell(row: HTMLElement, column: string): HTMLElement {
  return row.querySelector<HTMLElement>(`[data-column="${column}"]`)!
}

beforeEach(() => {
  document.body.innerHTML = ''
  obsApi.fetchObsGroups.mockReset()
  obsApi.fetchObsSites.mockReset()
  obsApi.fetchObsSite.mockReset()
  obsApi.fetchObsSeries.mockReset()
  obsApi.fetchObsTimes.mockReset()
  obsApi.fetchObs1to1.mockReset()
  obsApi.fetchObsResidHist.mockReset()
  obsApi.fetchObsPoints.mockReset()
  obsApi.fetchObs1to1.mockResolvedValue({ ok: false, artifact: 'obs_1to1', reason: 'no 1:1 in this test' })
  obsApi.fetchObsResidHist.mockResolvedValue({ ok: false, artifact: 'obs_agg', reason: 'no histogram in this test' })
  obsApi.fetchObsPoints.mockResolvedValue({ ok: false, artifact: 'obs_index', reason: 'no points in this test' })
  obsApi.fetchObsSites.mockResolvedValue({ ok: true, rows: [], notes: [] })
  obsApi.fetchObsGroups.mockResolvedValue(groupsAnswer([group('gw_head'), group('gw_date')]))
  linkTargets.fetchLinkSites.mockReset()
  linkTargets.fetchLinkSites.mockResolvedValue({ ok: false, artifact: 'obs_cell', reason: 'no site places in this test' })
  linkApi.recentCellLink.mockReset()
  linkApi.recentCellLink.mockReturnValue(null)
  overlaysApi.fetchPdcSites.mockReset()
  overlaysApi.fetchPdcSites.mockImplementation(async (iteration: number) => pdcOff(iteration, 'no pdc in this test'))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the group summary', () => {
  it('draws one row per group in the order the server sent, with every figure', async () => {
    const { host } = mount()
    await vi.waitFor(() => expect(groupRows(host).length).toBe(2))

    const rows = groupRows(host)
    expect(rows.map((r) => r.dataset.group)).toEqual(['gw_head', 'gw_date'])
    const first = rows[0]
    expect(cell(first, 'group').textContent).toBe('gw_head')
    expect(cell(first, 'n_obs').textContent).toBe('100')
    expect(cell(first, 'n_sites').textContent).toBe('10')
    expect(cell(first, 'n_placed').textContent).toBe('8')
    expect(cell(first, 'n_weighted').textContent).toBe('90')
    expect(cell(first, 'time_kind').textContent).toBe('datetime')
    expect(cell(first, 'rmse_first').textContent).toBe('2.500')
    expect(cell(first, 'rmse_last').textContent).toBe('1.250')
  })

  it('keeps a text cell on one line and carries its full text in the title', async () => {
    const { host } = mount()
    await vi.waitFor(() => expect(groupRows(host).length).toBe(2))
    const kind = cell(groupRows(host)[0], 'time_kind')
    expect(kind.classList.contains('truncate')).toBe(true)
    expect(kind.title.startsWith('datetime; ')).toBe(true)
  })

  it('names the RMSE rule and the iteration in the two RMSE headings', async () => {
    const { host } = mount()
    await vi.waitFor(() => expect(groupRows(host).length).toBe(2))

    const headings = [...host.querySelectorAll('.obs-groups [role="columnheader"]')].map((h) => h.textContent)
    expect(headings).toContain('RMSE of the ensemble-mean residual, first (iteration 0)')
    expect(headings).toContain('RMSE of the ensemble-mean residual, last (iteration 3)')
  })

  it('shows a dash with its reason for a group that has no residual', async () => {
    obsApi.fetchObsGroups.mockResolvedValue(groupsAnswer([group('gw_head', { rmseLast: null, nResidLast: 0 })]))
    const { host } = mount()
    await vi.waitFor(() => expect(groupRows(host).length).toBe(1))

    const figure = cell(groupRows(host)[0], 'rmse_last')
    expect(figure.textContent).toBe('—')
    expect(figure.title).toBe('no observation in this group has a residual at this iteration')
  })

  it('writes the chosen group to the selection with the origin obs and marks the row', async () => {
    const store = makeStore()
    const heard: { groups: string[]; origins: string[] }[] = []
    store.subscribe(
      (s) => s.obsGroups,
      (next, _prev, origins) => heard.push({ groups: [...next.obsGroups], origins: [...origins] }),
    )
    const { host } = mount({ store })
    await vi.waitFor(() => expect(groupRows(host).length).toBe(2))

    groupRows(host)[0].click()
    store.flush()

    expect(heard).toEqual([{ groups: ['gw_head'], origins: ['obs'] }])
    expect(groupRows(host)[0].getAttribute('aria-selected')).toBe('true')
    expect(groupRows(host)[1].getAttribute('aria-selected')).toBe('false')
  })

  it('answers Enter on a focused row like a click', async () => {
    const { host, store } = mount()
    await vi.waitFor(() => expect(groupRows(host).length).toBe(2))

    groupRows(host)[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect([...store.get().obsGroups]).toEqual(['gw_date'])
  })

  it('shows the artifact and reason in place of the table when the groups cannot be read', async () => {
    obsApi.fetchObsGroups.mockResolvedValue({ ok: false, artifact: 'obs_index', reason: 'obs_index is not in the cache' })
    const { host } = mount()
    await vi.waitFor(() => expect(host.querySelector('.obs-groups .notice-parts')).not.toBeNull())

    expect(host.querySelector('.obs-groups')?.textContent).toContain('obs_index: obs_index is not in the cache')
    expect(host.querySelector('.obs-groups .obs-grid')).toBeNull()
  })

  it('shows a rejected read as a notice too', async () => {
    obsApi.fetchObsGroups.mockRejectedValue(new Error('network down'))
    const { host } = mount()
    await vi.waitFor(() => expect(host.querySelector('.obs-groups .notice-parts')).not.toBeNull())

    expect(host.querySelector('.obs-groups')?.textContent).toContain('network down')
  })

  it('writes names through textContent, so markup in a name stays text', async () => {
    const name = '<img src=x onerror=alert(1)>'
    obsApi.fetchObsGroups.mockResolvedValue(groupsAnswer([group(name)]))
    const { host } = mount()
    await vi.waitFor(() => expect(groupRows(host).length).toBe(1))

    expect(host.querySelector('.obs-groups img')).toBeNull()
    expect(cell(groupRows(host)[0], 'group').textContent).toBe(name)
  })

  it('reads top to bottom: heading, notices, selected sites, groups, site list, site plots, then the group fit', () => {
    const { host } = mount({ startHidden: true })

    const classes = [...host.children].map((el) => el.className).filter((c) => c.startsWith('obs-'))
    expect(classes).toEqual(['obs-heading-row', 'obs-notices', 'obs-selected', 'obs-groups', 'obs-sites', 'obs-spaghetti', 'obs-fit'])
  })

  it('opens with a heading row: Obs on the left and an empty slot for actions on the right', () => {
    const { host, handle } = mount({ startHidden: true })

    const row = host.firstElementChild as HTMLElement
    expect(row.className).toBe('obs-heading-row')
    expect([...row.children].map((el) => el.className)).toEqual(['heading', 'obs-heading-actions'])
    expect(row.querySelector('.heading')?.textContent).toBe('Obs')
    expect(handle.headingActions).toBe(row.querySelector('.obs-heading-actions'))
    expect(handle.headingActions.childElementCount).toBe(0)
  })
})

function names(host: HTMLElement): string[] {
  return groupRows(host).map((r) => r.dataset.group!)
}

function heading(host: HTMLElement, text: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>('.obs-groups [role="columnheader"]')].find((h) =>
    h.textContent!.startsWith(text),
  )
  if (!found) throw new Error(`no heading starting with ${text}`)
  return found
}

function sortButton(host: HTMLElement, text: string): HTMLButtonElement {
  return heading(host, text).querySelector('button')!
}

describe('sorting the group summary', () => {
  const rows = () => [
    group('g0', { rmseLast: 3 }),
    group('g1', { rmseLast: null }),
    group('g2', { rmseLast: 1 }),
    group('g3', { rmseLast: 3 }),
    group('g4', { rmseLast: 2 }),
  ]

  async function open() {
    obsApi.fetchObsGroups.mockResolvedValue(groupsAnswer(rows()))
    const view = mount()
    await vi.waitFor(() => expect(groupRows(view.host).length).toBe(5))
    return view
  }

  it('sorts ascending on a first click and descending on a second, with no figure last both ways', async () => {
    const { host } = await open()
    const last = sortButton(host, 'RMSE of the ensemble-mean residual, last')

    last.click()
    expect(names(host)).toEqual(['g2', 'g4', 'g0', 'g3', 'g1'])
    expect(heading(host, 'RMSE of the ensemble-mean residual, last').getAttribute('aria-sort')).toBe('ascending')

    last.click()
    expect(names(host)).toEqual(['g0', 'g3', 'g4', 'g2', 'g1'])
    expect(heading(host, 'RMSE of the ensemble-mean residual, last').getAttribute('aria-sort')).toBe('descending')
  })

  it('keeps the server order between equal values, both ways', async () => {
    const { host } = await open()
    const last = sortButton(host, 'RMSE of the ensemble-mean residual, last')

    last.click()
    const up = names(host)
    last.click()
    const down = names(host)

    expect(up.indexOf('g0')).toBeLessThan(up.indexOf('g3'))
    expect(down.indexOf('g0')).toBeLessThan(down.indexOf('g3'))
  })

  it('sorts a name column as text and marks only the sorted heading', async () => {
    const { host } = await open()

    sortButton(host, 'Group').click()
    sortButton(host, 'Group').click()

    expect(names(host)).toEqual(['g4', 'g3', 'g2', 'g1', 'g0'])
    expect(heading(host, 'Sites').getAttribute('aria-sort')).toBe('none')
  })
})

describe('a long group list', () => {
  const many = () => Array.from({ length: 11264 }, (_, i) => group(`g${i}`))

  it('puts only the visible rows and the overscan in the document, and scrolling moves the window', async () => {
    obsApi.fetchObsGroups.mockResolvedValue(groupsAnswer(many()))
    const { host } = mount()
    await vi.waitFor(() => expect(groupRows(host).length).toBeGreaterThan(0))

    expect(groupRows(host).length).toBeLessThan(100)
    const spacer = host.querySelector<HTMLElement>('.obs-groups .scroll-pane > div')!
    expect(spacer.style.height).toBe(`${11264 * 24}px`)

    const pane = host.querySelector<HTMLElement>('.obs-groups .scroll-pane')!
    pane.scrollTop = 5000 * 24
    pane.dispatchEvent(new Event('scroll'))

    expect(names(host)).toContain('g5000')
    expect(names(host)).not.toContain('g0')
    expect(groupRows(host).length).toBeLessThan(100)
  })

  it('keeps its scroll position across a hide and a show', async () => {
    obsApi.fetchObsGroups.mockResolvedValue(groupsAnswer(many()))
    const { host, handle } = mount()
    await vi.waitFor(() => expect(groupRows(host).length).toBeGreaterThan(0))
    const pane = host.querySelector<HTMLElement>('.obs-groups .scroll-pane')!
    pane.scrollTop = 3000 * 24
    pane.dispatchEvent(new Event('scroll'))

    handle.onHide()
    pane.scrollTop = 0
    handle.onShow()

    expect(pane.scrollTop).toBe(3000 * 24)
    expect(names(host)).toContain('g3000')
  })
})

describe('a hidden panel', () => {
  it('fetches and draws nothing until it is shown, then fetches once', async () => {
    const { host, handle } = mount({ startHidden: true })
    await Promise.resolve()

    expect(obsApi.fetchObsGroups).not.toHaveBeenCalled()
    expect(groupRows(host).length).toBe(0)

    handle.onShow()
    await vi.waitFor(() => expect(groupRows(host).length).toBe(2))
    handle.onHide()
    handle.onShow()

    expect(obsApi.fetchObsGroups).toHaveBeenCalledTimes(1)
  })

  it('asks again on the next show after a refused read', async () => {
    obsApi.fetchObsGroups.mockResolvedValueOnce({ ok: false, artifact: 'obs_index', reason: 'not ready' })
    const { host, handle } = mount({ startHidden: true })
    handle.onShow()
    await vi.waitFor(() => expect(host.querySelector('.obs-groups .notice-parts')).not.toBeNull())

    handle.onHide()
    handle.onShow()

    await vi.waitFor(() => expect(groupRows(host).length).toBe(2))
  })
})

describe('what is not available', () => {
  it('names the artifact and reason when observations are off, and asks the server for nothing', async () => {
    const capabilities = available()
    capabilities.obs = { available: false, blockedBy: [{ artifact: 'obs_ens', reason: 'no observation ensemble was written' }] }
    const { host } = mount({ capabilities })
    await Promise.resolve()

    const notice = host.querySelector('.obs-notices [data-capability="obs"]')!
    expect(notice.textContent).toContain('obs_ens: no observation ensemble was written')
    expect(obsApi.fetchObsGroups).not.toHaveBeenCalled()
    expect(obsApi.fetchObsSites).not.toHaveBeenCalled()
    expect(groupRows(host).length).toBe(0)
  })

  it('shows a dash for every RMSE and names the statistics artifact when they are off', async () => {
    const capabilities = available()
    capabilities.obsStats = { available: false, blockedBy: [{ artifact: 'obs_agg/K', reason: 'the aggregate was not built' }] }
    const { host } = mount({ capabilities })
    await vi.waitFor(() => expect(groupRows(host).length).toBe(2))

    expect(host.querySelector('.obs-notices [data-capability="obsStats"]')?.textContent).toContain('obs_agg/K: the aggregate was not built')
    for (const row of groupRows(host)) {
      expect(cell(row, 'rmse_first').textContent).toBe('—')
      expect(cell(row, 'rmse_last').textContent).toBe('—')
      expect(cell(row, 'rmse_last').title).toContain('obs_agg/K')
    }
  })

  it('gives the noise reason and still draws the table', async () => {
    const capabilities = available()
    capabilities.noise = { available: false, blockedBy: [{ artifact: 'noise', reason: 'the run has no observation noise' }] }
    const { host } = mount({ capabilities })
    await vi.waitFor(() => expect(groupRows(host).length).toBe(2))

    expect(host.querySelector('.obs-notices [data-capability="noise"]')?.textContent).toContain('the run has no observation noise')
    expect(cell(groupRows(host)[0], 'rmse_first').textContent).toBe('2.500')
  })

  it('says so when a capability is off with no reason recorded', () => {
    const capabilities = available()
    capabilities.noise = { available: false, blockedBy: [] }
    const { host } = mount({ capabilities, startHidden: true })

    expect(host.querySelector('.obs-notices')?.textContent).toContain('no reason was recorded')
  })

  it('shows the notes of a capability that is on', () => {
    const capabilities = available()
    capabilities.noise = { available: true, blockedBy: [], notes: ['noise taken from the control file'] }
    const { host } = mount({ capabilities, startHidden: true })

    expect(host.querySelector('.obs-notices')?.textContent).toContain('noise taken from the control file')
  })
})

describe('the narrow-panel layout', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  // Every declaration of every rule whose selector list names exactly this selector.
  function rule(selector: string): string {
    const bodies: string[] = []
    for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (match[1].split(',').some((part) => part.trim() === selector)) bodies.push(match[2])
    }
    if (bodies.length === 0) throw new Error(`style.css has no rule for ${selector}`)
    return bodies.join('\n')
  }

  it('gives the name column a minimum width', () => {
    expect(rule('.obs-col-name')).toMatch(/min-width:\s*\d+(\.\d+)?em/)
  })

  it('scrolls the grid sideways as one piece, with the header and rows kept wide', () => {
    expect(rule('.obs-grid')).toMatch(/overflow-x:\s*auto/)
    expect(css).toMatch(/\.obs-grid-header,\s*\.obs-grid > \.scroll-pane\s*\{[^}]*min-width:\s*\d+em/)
  })

  it('keeps the group table wide enough for its columns and never scrolls its rows apart from the header', () => {
    // 10em name + 4 figures + 1 text + 2 rmse + 2 conflict columns, plus nine 8px gaps.
    const floor = 10 + 4 * 5.5 + 5.5 + 2 * 8.5 + 2 * 5.5 + (9 * 8) / 16
    const wide = Number(/\.obs-grid-header,\s*\.obs-grid > \.scroll-pane\s*\{[^}]*min-width:\s*(\d+)em/.exec(css)?.[1])
    expect(wide).toBeGreaterThanOrEqual(floor)
    expect(rule('.obs-grid > .scroll-pane')).toMatch(/overflow-x:\s*hidden/)
  })

  it('keeps the Params group table and the Selected sites grid as wide as their columns', () => {
    // Params: 8 + 4 + 4.5 + 5.5 + 4 x 6.5em, seven 8px gaps and 4px padding each side.
    const params = Number(/\.params-groups \.group-header,\s*\.params-groups \.scroll-pane\s*\{[^}]*min-width:\s*(\d+)em/.exec(css)?.[1])
    expect(params).toBeGreaterThanOrEqual(8 + 4 + 4.5 + 5.5 + 4 * 6.5 + (7 * 8 + 8) / 16)
    // Selected sites: two 10em name columns, two 5.5em columns and three 8px gaps.
    const selected = Number(/\.obs-selected \.obs-grid-header,\s*\.obs-selected \.obs-grid > \.scroll-pane\s*\{[^}]*min-width:\s*(\d+)em/.exec(css)?.[1])
    expect(selected).toBeGreaterThanOrEqual(2 * 10 + 2 * 5.5 + (3 * 8) / 16)
    expect(rule('.params-groups .scroll-pane')).toMatch(/overflow-x:\s*hidden/)
    expect(rule('.obs-selected .scroll-pane')).toMatch(/overflow-x:\s*hidden/)
  })

  it('lets the lists below the table shrink while the table keeps a floor', () => {
    expect(rule('.obs-sites')).toMatch(/flex:\s*0 1 auto/)
    expect(rule('.obs-sites')).toMatch(/max-height/)
    expect(rule('.obs-groups')).toMatch(/flex:\s*1 1 0/)
    expect(rule('.obs-groups')).toMatch(/min-height:\s*\d+rem/)
    expect(rule('.obs-groups')).toMatch(/max-height:\s*\d+%/)
  })

  it('lets the plot hosts shrink and scroll inside themselves so the page does not scroll', () => {
    for (const host of ['.obs-fit', '.obs-spaghetti']) {
      expect(rule(host), host).toMatch(/flex:\s*0 1 auto/)
      expect(rule(host), host).toMatch(/overflow-y:\s*auto/)
      expect(rule(host), host).toMatch(/max-height:\s*\d+%/)
    }
  })

  it('sets the spaghetti panel height and the width of both plot hosts', () => {
    expect(rule('.obs-spaghetti canvas')).toMatch(/height:\s*200px/)
    expect(rule('.obs-spaghetti canvas')).not.toMatch(/#/)
  })
})

function site(id: number, name: string, over: Partial<ObsSiteRow> = {}): ObsSiteRow {
  return { siteId: id, site: name, nObs: 7, x: 1, y: 2, xySource: 'own', layer: 1, cell: 4, rule: 'xy columns', note: null, ...over }
}

function sitesAnswer(rows: ObsSiteRow[], notes: string[] = []) {
  return { ok: true, rows, notes }
}

function siteRows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('.obs-sites .obs-grid-row')]
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

async function openWithGroups(over: Partial<ObsPanelOptions> = {}) {
  const view = mount(over)
  await vi.waitFor(() => expect(groupRows(view.host).length).toBe(2))
  return view
}

describe('the site list', () => {
  beforeEach(() => {
    obsApi.fetchObsSites.mockImplementation(async (name: string) =>
      sitesAnswer(
        name === 'gw_head'
          ? [site(40, 'well_a'), site(41, 'well_b', { layer: -1, xySource: 'none', cell: -1, note: 'no x or y in the file', rule: 'none' })]
          : [site(50, 'date_a')],
      ),
    )
  })

  it('asks the user to click a group before one is chosen', async () => {
    const { host } = await openWithGroups()

    expect(host.querySelector('.obs-sites')?.textContent).toContain('Click a group above to list its sites.')
    expect(obsApi.fetchObsSites).not.toHaveBeenCalled()
  })

  it("lists the chosen group's sites with name, observations, layer and placement", async () => {
    const { host } = await openWithGroups()

    groupRows(host)[0].click()
    await vi.waitFor(() => expect(siteRows(host).length).toBe(2))

    expect(obsApi.fetchObsSites).toHaveBeenCalledWith('gw_head', expect.anything())
    const [a, b] = siteRows(host)
    expect(cell(a, 'site').textContent).toBe('well_a')
    expect(cell(a, 'n_obs').textContent).toBe('7')
    expect(cell(a, 'layer').textContent).toBe('2 (1)')
    expect(cell(a, 'placement').textContent).toBe('own position')
    expect(cell(b, 'site').textContent).toBe('well_b')
    expect(cell(b, 'layer').textContent).toBe('unknown')
    expect(cell(b, 'placement').textContent).toBe('not placed')
    expect(cell(b, 'placement').title).toBe('no x or y in the file')
    expect(host.querySelector('.obs-sites-count')?.textContent).toBe('Sites in gw_head · 2')
    const heading = host.querySelector<HTMLElement>('.obs-sites [role="columnheader"][data-column="layer"]')!
    expect(heading.title).toBe('Layer counted from 1; the index from 0 is in brackets.')
  })

  it('words a layer one-based with the index alongside, and never shows an unknown layer as 1 (0)', async () => {
    obsApi.fetchObsSites.mockResolvedValue(sitesAnswer([site(60, 'deep', { layer: 3 }), site(61, 'lost', { layer: -1 })]))
    const { host } = await openWithGroups()

    groupRows(host)[0].click()
    await vi.waitFor(() => expect(siteRows(host).length).toBe(2))

    expect(cell(siteRows(host)[0], 'layer').textContent).toBe('4 (3)')
    expect(cell(siteRows(host)[1], 'layer').textContent).toBe('unknown')
  })

  it('puts Show selected on the title line and says how to pick under it, naming Option on macOS', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    try {
      const { host } = await openWithGroups()
      groupRows(host)[0].click()
      await vi.waitFor(() => expect(siteRows(host).length).toBe(2))

      const title = host.querySelector<HTMLElement>('.obs-sites-title')!
      expect(title.querySelector('.obs-sites-count')).not.toBeNull()
      expect(title.querySelector('button')?.textContent).toBe('Show selected')
      const hint = host.querySelector<HTMLElement>('.obs-sites-hint')!
      expect(title.nextElementSibling).toBe(hint)
      expect(hint.textContent).toBe('ℹ Click a site to select it and draw its plot below. Shift-click adds, Option-click removes.')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('names Alt in the pick hint on other platforms', async () => {
    vi.stubGlobal('navigator', { platform: 'Win32' })
    try {
      const { host } = await openWithGroups()
      groupRows(host)[0].click()
      await vi.waitFor(() => expect(siteRows(host).length).toBe(2))

      expect(host.querySelector('.obs-sites-hint')?.textContent).toBe(
        'ℹ Click a site to select it and draw its plot below. Shift-click adds, Alt-click removes.',
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('never scrolls the panel or the list on its own when a site is picked', async () => {
    const scrolled = vi.fn()
    const had = Object.prototype.hasOwnProperty.call(Element.prototype, 'scrollIntoView')
    const before = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrolled
    try {
      const { host } = await openWithGroups()
      groupRows(host)[0].click()
      await vi.waitFor(() => expect(siteRows(host).length).toBe(2))
      host.scrollTop = 120
      const pane = host.querySelector<HTMLElement>('.obs-sites .scroll-pane')!
      pane.scrollTop = 0

      siteRows(host)[1].click()

      expect(host.scrollTop).toBe(120)
      expect(pane.scrollTop).toBe(0)
      expect(scrolled).not.toHaveBeenCalled()
    } finally {
      if (had) Element.prototype.scrollIntoView = before
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('shows the site by name and keys it by site_id, never by position', async () => {
    const { host } = await openWithGroups()

    groupRows(host)[0].click()
    await vi.waitFor(() => expect(siteRows(host).length).toBe(2))

    expect(siteRows(host).map((r) => r.dataset.siteId)).toEqual(['40', '41'])
    expect(siteRows(host).map((r) => cell(r, 'site').textContent)).toEqual(['well_a', 'well_b'])
  })

  it('writes the clicked site_id to the selection with the origin obs and marks the row', async () => {
    const store = makeStore()
    const heard: { sites: number[]; origins: string[] }[] = []
    store.subscribe(
      (s) => s.sites,
      (next, _prev, origins) => heard.push({ sites: [...next.sites], origins: [...origins] }),
    )
    const { host } = await openWithGroups({ store })
    groupRows(host)[0].click()
    await vi.waitFor(() => expect(siteRows(host).length).toBe(2))

    siteRows(host)[1].click()
    store.flush()

    expect(heard).toEqual([{ sites: [41], origins: ['obs'] }])
    expect(siteRows(host)[1].getAttribute('aria-selected')).toBe('true')
    expect(siteRows(host)[0].getAttribute('aria-selected')).toBe('false')
  })

  it('marks a site that another view selected', async () => {
    const { host, store } = await openWithGroups()
    groupRows(host)[0].click()
    await vi.waitFor(() => expect(siteRows(host).length).toBe(2))

    store.set({ sites: new Set([40]) }, 'map')
    store.flush()

    expect(siteRows(host)[0].getAttribute('aria-selected')).toBe('true')
    expect(siteRows(host)[1].getAttribute('aria-selected')).toBe('false')
  })

  it('follows a group chosen on the map, and ignores one the table does not hold', async () => {
    const { host, store } = await openWithGroups()

    store.set({ obsGroups: new Set(['gw_date']) }, 'map')
    store.flush()
    await vi.waitFor(() => expect(siteRows(host).length).toBe(1))
    expect(groupRows(host)[1].getAttribute('aria-selected')).toBe('true')
    expect(cell(siteRows(host)[0], 'site').textContent).toBe('date_a')

    obsApi.fetchObsSites.mockClear()
    store.set({ obsGroups: new Set(['not_a_group']) }, 'map')
    store.flush()
    await Promise.resolve()

    expect(obsApi.fetchObsSites).not.toHaveBeenCalled()
    expect(cell(siteRows(host)[0], 'site').textContent).toBe('date_a')
    expect(groupRows(host)[1].getAttribute('aria-selected')).toBe('true')
  })

  it('does not fetch again for its own echo', async () => {
    const { host, store } = await openWithGroups()

    groupRows(host)[0].click()
    store.flush()
    await vi.waitFor(() => expect(siteRows(host).length).toBe(2))

    expect(obsApi.fetchObsSites).toHaveBeenCalledTimes(1)
  })

  it('follows a group already in the selection when the table arrives', async () => {
    const { host } = await openWithGroups({ store: makeStore(['gw_date']) })

    await vi.waitFor(() => expect(siteRows(host).length).toBe(1))
    expect(groupRows(host)[1].getAttribute('aria-selected')).toBe('true')
  })

  it('draws only the second group when the first answer lands late', async () => {
    const slow = deferred<ReturnType<typeof sitesAnswer>>()
    obsApi.fetchObsSites.mockImplementation((name: string) =>
      name === 'gw_head' ? slow.promise : Promise.resolve(sitesAnswer([site(50, 'date_a')])),
    )
    const { host } = await openWithGroups()

    groupRows(host)[0].click()
    groupRows(host)[1].click()
    await vi.waitFor(() => expect(siteRows(host).length).toBe(1))
    slow.resolve(sitesAnswer([site(40, 'well_a'), site(41, 'well_b')]))
    await new Promise((r) => setTimeout(r, 0))

    expect(siteRows(host).map((r) => cell(r, 'site').textContent)).toEqual(['date_a'])
    expect(host.querySelector('.obs-sites-count')?.textContent).toBe('Sites in gw_date · 1')
  })

  it('shows the reason in place of the list when the sites are refused', async () => {
    obsApi.fetchObsSites.mockResolvedValue({ ok: false, artifact: 'obs_cell', reason: 'obs_cell is not in the cache' })
    const { host } = await openWithGroups()

    groupRows(host)[0].click()
    await vi.waitFor(() => expect(host.querySelector('.obs-sites .notice-parts')).not.toBeNull())

    expect(host.querySelector('.obs-sites')?.textContent).toContain('obs_cell: obs_cell is not in the cache')
    expect(siteRows(host).length).toBe(0)
  })

  it('tries again when the same group is chosen after a refusal', async () => {
    obsApi.fetchObsSites.mockResolvedValueOnce({ ok: false, artifact: 'obs_cell', reason: 'not ready' })
    const { host } = await openWithGroups()
    groupRows(host)[0].click()
    await vi.waitFor(() => expect(host.querySelector('.obs-sites .notice-parts')).not.toBeNull())

    groupRows(host)[0].click()

    await vi.waitFor(() => expect(siteRows(host).length).toBe(2))
  })

  it('shows the server notes that came with the sites', async () => {
    obsApi.fetchObsSites.mockResolvedValue(sitesAnswer([site(40, 'well_a')], ['2 sites have no position']))
    const { host } = await openWithGroups()

    groupRows(host)[0].click()
    await vi.waitFor(() => expect(siteRows(host).length).toBe(1))

    expect(host.querySelector('.obs-sites')?.textContent).toContain('2 sites have no position')
  })

  it('notes a group chosen on the map while hidden, and fetches only when shown', async () => {
    const { host, store, handle } = await openWithGroups()
    handle.onHide()

    store.set({ obsGroups: new Set(['gw_date']) }, 'map')
    store.flush()
    await Promise.resolve()
    expect(obsApi.fetchObsSites).not.toHaveBeenCalled()

    handle.onShow()
    await vi.waitFor(() => expect(siteRows(host).length).toBe(1))
    expect(obsApi.fetchObsSites).toHaveBeenCalledTimes(1)
    expect(obsApi.fetchObsSites).toHaveBeenCalledWith('gw_date', expect.anything())
  })

  it('windows a group of 9,086 sites', async () => {
    obsApi.fetchObsSites.mockResolvedValue(sitesAnswer(Array.from({ length: 9086 }, (_, i) => site(i, `site_${i}`))))
    const { host } = await openWithGroups()

    groupRows(host)[0].click()
    await vi.waitFor(() => expect(siteRows(host).length).toBeGreaterThan(0))
    expect(siteRows(host).length).toBeLessThan(100)

    const pane = host.querySelector<HTMLElement>('.obs-sites .obs-grid > .scroll-pane')!
    pane.scrollTop = 7000 * 24
    pane.dispatchEvent(new Event('scroll'))

    expect(siteRows(host).map((r) => r.dataset.siteId)).toContain('7000')
    expect(siteRows(host).length).toBeLessThan(100)
  })

  it('stops following the selection once disposed', async () => {
    const { host, store, handle } = await openWithGroups()

    handle.dispose()
    store.set({ obsGroups: new Set(['gw_date']) }, 'map')
    store.flush()
    await Promise.resolve()

    expect(obsApi.fetchObsSites).not.toHaveBeenCalled()
    expect(groupRows(host)[1].getAttribute('aria-selected')).toBe('false')
  })
})

describe('picking sites with modifiers', () => {
  beforeEach(() => {
    obsApi.fetchObsSites.mockResolvedValue(sitesAnswer([site(2, 's2'), site(3, 's3'), site(4, 's4')]))
  })

  async function openSites(over: Partial<ObsPanelOptions> = {}) {
    const view = await openWithGroups(over)
    groupRows(view.host)[0].click()
    await vi.waitFor(() => expect(siteRows(view.host).length).toBe(3))
    return view
  }

  function rowOf(host: HTMLElement, id: number): HTMLElement {
    return siteRows(host).find((r) => r.dataset.siteId === String(id))!
  }

  function clickRow(host: HTMLElement, id: number, init: MouseEventInit = {}): void {
    rowOf(host, id).dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
  }

  it('replaces on a plain click, adds on shift and removes on alt, always with the origin obs', async () => {
    const store = makeStore()
    const heard: { sites: number[]; origins: string[] }[] = []
    store.subscribe(
      (s) => s.sites,
      (next, _prev, origins) => heard.push({ sites: [...next.sites].sort(), origins: [...origins] }),
    )
    const { host } = await openSites({ store })

    clickRow(host, 2)
    store.flush()
    clickRow(host, 3, { shiftKey: true })
    store.flush()
    clickRow(host, 2, { altKey: true })
    store.flush()

    expect(heard).toEqual([
      { sites: [2], origins: ['obs'] },
      { sites: [2, 3], origins: ['obs'] },
      { sites: [3], origins: ['obs'] },
    ])
  })

  it('treats Enter and shift+Enter like a click and a shift-click', async () => {
    const { host, store } = await openSites()

    rowOf(host, 2).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    rowOf(host, 4).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))

    expect([...store.get().sites].sort()).toEqual([2, 4])
  })

  it('marks the sites another view chose and dims the rest, and dims nothing with no site chosen', async () => {
    const { host, store } = await openSites()

    store.set({ sites: new Set([3]) }, 'map')
    store.flush()
    expect(rowOf(host, 3).getAttribute('aria-selected')).toBe('true')
    expect(rowOf(host, 3).classList.contains('dimmed')).toBe(false)
    expect(rowOf(host, 2).classList.contains('dimmed')).toBe(true)
    expect(rowOf(host, 4).classList.contains('dimmed')).toBe(true)

    store.set({ sites: new Set() }, 'map')
    store.flush()
    expect(siteRows(host).some((r) => r.classList.contains('dimmed'))).toBe(false)
  })

  it('keeps every row in its place whatever is chosen', async () => {
    const { host, store } = await openSites()
    sortButton(host, 'Group').click()
    sortButton(host, 'Group').click()
    const groupsBefore = names(host)

    store.set({ sites: new Set([4]) }, 'map')
    store.flush()
    clickRow(host, 3, { shiftKey: true })
    store.flush()

    expect(siteRows(host).map((r) => r.dataset.siteId)).toEqual(['2', '3', '4'])
    expect(names(host)).toEqual(groupsBefore)
    expect(heading(host, 'Group').getAttribute('aria-sort')).toBe('descending')
  })

  it('leaves the group rows alone when the sites change', async () => {
    const { host, store } = await openSites()
    const groupsSelected = groupRows(host).map((r) => r.getAttribute('aria-selected'))

    store.set({ sites: new Set([2]) }, 'map')
    store.flush()

    expect(groupRows(host).map((r) => r.getAttribute('aria-selected'))).toEqual(groupsSelected)
    expect(groupRows(host).some((r) => r.classList.contains('dimmed'))).toBe(false)
    expect([...store.get().obsGroups]).toEqual(['gw_head'])
  })
})

describe("the site list's 'Show selected' button", () => {
  function showButton(host: HTMLElement): HTMLButtonElement {
    return host.querySelector<HTMLButtonElement>('.obs-sites-title button')!
  }

  it('scrolls to the first chosen site in list order', async () => {
    obsApi.fetchObsSites.mockResolvedValue(sitesAnswer(Array.from({ length: 9086 }, (_, i) => site(i, `site_${i}`))))
    const { host, store } = await openWithGroups()
    groupRows(host)[0].click()
    await vi.waitFor(() => expect(siteRows(host).length).toBeGreaterThan(0))

    store.set({ sites: new Set([8000, 7000]) }, 'map')
    store.flush()
    expect(showButton(host).disabled).toBe(false)
    showButton(host).click()

    const pane = host.querySelector<HTMLElement>('.obs-sites .obs-grid > .scroll-pane')!
    expect(pane.scrollTop).toBe(7000 * 24)
    expect(siteRows(host).map((r) => r.dataset.siteId)).toContain('7000')
  })

  it('is disabled with the reason when no chosen site is in this group', async () => {
    obsApi.fetchObsSites.mockResolvedValue(sitesAnswer([site(2, 's2'), site(3, 's3')]))
    const { host, store } = await openWithGroups()
    groupRows(host)[0].click()
    await vi.waitFor(() => expect(siteRows(host).length).toBe(2))

    expect(showButton(host).textContent).toBe('Show selected')
    expect(showButton(host).disabled).toBe(true)
    expect(showButton(host).title).toBe('no selected site is in this group')

    store.set({ sites: new Set([99]) }, 'map')
    store.flush()
    expect(showButton(host).disabled).toBe(true)

    store.set({ sites: new Set([3]) }, 'map')
    store.flush()
    expect(showButton(host).disabled).toBe(false)
  })
})

describe('the Selected sites section in the panel', () => {
  function cellAnswer() {
    return {
      layer: 3,
      cells: [1234],
      ring: [1, 2, 3, 4, 5, 6, 7, 8],
      ringRule: 'cells sharing a corner',
      pars: [],
      parsTotal: 0,
      parNotes: [],
      sites: [
        { siteId: 10, site: 'well_a', group: 'gw_head', layer: 3, cell: 1234, inClickedCell: true },
        { siteId: 11, site: 'well_b', group: 'gw_head', layer: 3, cell: 1235, inClickedCell: false },
      ],
      sitesTotal: 73,
      sitesCap: 50,
      siteCounts: { unknownLayerIncluded: 0, otherLayerLeftOut: 0, unplacedInRun: 0 },
      reasons: { pars: null, sites: null },
    }
  }

  function selectedRows(host: HTMLElement): HTMLElement[] {
    return [...host.querySelectorAll<HTMLElement>('.obs-selected .obs-grid-row')]
  }

  it("states where a cell click found its sites when the map writes the click's cells and sites", async () => {
    linkApi.recentCellLink.mockReturnValue(cellAnswer())
    const { host, store } = await openWithGroups()

    store.set({ cells: new Set([1234]), sites: new Set([10, 11]) }, 'map')
    store.flush()

    expect(host.querySelector('.obs-selected-title')?.textContent).toBe('Selected sites · 2')
    expect(host.querySelector('.obs-selected-line')?.textContent).toBe('Sites in cell 1234 and its 8 neighbouring cells on layer 4 (index 3)')
    expect(host.querySelector('.obs-selected')?.textContent).toContain('2 of 73 sites shown; zoom in or lasso to pick fewer')
    expect(selectedRows(host).length).toBe(2)
    expect(linkTargets.fetchLinkSites).not.toHaveBeenCalled()
  })

  it('turns a shift-click in the section into an added site with the origin obs', async () => {
    linkTargets.fetchLinkSites.mockResolvedValue({
      ok: true,
      iteration: 0,
      sites: [{ siteId: 5, site: 's5', group: 'gw_head', layer: 1, cell: 9, placed: true, hasValue: true }],
      unknown: [],
      valueRule: 'rule',
      valueReason: null,
      notAsked: 0,
      reason: null,
      notes: [],
    })
    const store = makeStore()
    const { host } = await openWithGroups({ store })
    store.set({ sites: new Set([5]) }, 'map')
    store.flush()
    await vi.waitFor(() => expect(selectedRows(host).length).toBe(1))
    const heard: string[][] = []
    store.subscribe(
      (s) => s.sites,
      (_next, _prev, origins) => heard.push([...origins]),
    )

    selectedRows(host)[0].dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
    store.flush()

    expect([...store.get().sites]).toEqual([])
    expect(heard).toEqual([['obs']])
    expect(host.querySelector('.obs-selected-title')?.textContent).toBe('Selected sites')
    expect(selectedRows(host).length).toBe(0)
  })

  it('asks where the sites are only once the tab is shown', async () => {
    const { store, handle } = mount({ startHidden: true })
    store.set({ sites: new Set([5]) }, 'map')
    store.flush()
    await Promise.resolve()
    expect(linkTargets.fetchLinkSites).not.toHaveBeenCalled()

    handle.onShow()

    await vi.waitFor(() => expect(linkTargets.fetchLinkSites).toHaveBeenCalledTimes(1))
    expect(linkTargets.fetchLinkSites).toHaveBeenCalledWith([5], 0, expect.anything())
  })
})

describe('prior-data conflict in the group table and the site list', () => {
  it('asks once for the shown iteration and fills both columns from by_group, 0 for an unlisted group', async () => {
    overlaysApi.fetchPdcSites.mockImplementation(async (iteration: number) => pdcOn(iteration))
    const { host } = await openWithGroups({ store: createSelectionStore({ initial: emptySelection('run', 3), schedule: () => {} }) })

    await vi.waitFor(() => expect(cell(groupRows(host)[0], 'pdc_obs').textContent).toBe('7'))
    expect(overlaysApi.fetchPdcSites).toHaveBeenCalledTimes(1)
    expect(overlaysApi.fetchPdcSites).toHaveBeenCalledWith(3, expect.anything())
    expect(cell(groupRows(host)[0], 'pdc_sites').textContent).toBe('2')
    expect(cell(groupRows(host)[1], 'pdc_obs').textContent).toBe('0')
    expect(cell(groupRows(host)[1], 'pdc_sites').textContent).toBe('0')
    expect(heading(host, 'Conflict obs').textContent).toBe('Conflict obs')
    expect(heading(host, 'Conflict sites').textContent).toBe('Conflict sites')
  })

  it('sorts on the conflict count', async () => {
    overlaysApi.fetchPdcSites.mockImplementation(async (iteration: number) => pdcOn(iteration))
    const { host } = await openWithGroups()
    await vi.waitFor(() => expect(cell(groupRows(host)[0], 'pdc_obs').textContent).toBe('7'))

    sortButton(host, 'Conflict obs').click()
    expect(names(host)).toEqual(['gw_date', 'gw_head'])
    sortButton(host, 'Conflict obs').click()
    expect(names(host)).toEqual(['gw_head', 'gw_date'])
  })

  it("says in the heading's title where the figures came from and what matched nothing or was left out", async () => {
    overlaysApi.fetchPdcSites.mockImplementation(async (iteration: number) => pdcOn(iteration, { nUnmatched: 3, nLeftOut: 2 }))
    const { host } = await openWithGroups()
    await vi.waitFor(() => expect(cell(groupRows(host)[0], 'pdc_obs').textContent).toBe('7'))

    const title = heading(host, 'Conflict obs').title
    expect(title).toContain("from pestpp's pdc file")
    expect(title).toContain('3 pdc rows match no observation')
    expect(title).toContain('2 rows left out: a simulated range holds a sentinel')
    expect(heading(host, 'Conflict sites').title).toBe(title)
  })

  it('names the rule when the conflict was computed, and leaves out zero counts', async () => {
    overlaysApi.fetchPdcSites.mockImplementation(async (iteration: number) =>
      pdcOn(iteration, { source: 'computed', sourceFile: null, rule: 'obs+noise outside the simulated range' }),
    )
    const { host } = await openWithGroups()
    await vi.waitFor(() => expect(cell(groupRows(host)[0], 'pdc_obs').textContent).toBe('7'))

    const title = heading(host, 'Conflict obs').title
    expect(title).toContain('computed: obs+noise outside the simulated range')
    expect(title).not.toContain('match no observation')
    expect(title).not.toContain('left out')
  })

  it('marks conflicted sites in the site list with the 135-degree swatch and the count in its title', async () => {
    overlaysApi.fetchPdcSites.mockImplementation(async (iteration: number) => pdcOn(iteration))
    obsApi.fetchObsSites.mockResolvedValue(sitesAnswer([site(40, 'well_a'), site(42, 'well_c')]))
    const { host } = await openWithGroups()
    groupRows(host)[0].click()
    await vi.waitFor(() => expect(siteRows(host).length).toBe(2))
    await vi.waitFor(() => expect(host.querySelector('.obs-sites .conflict-mark')).not.toBeNull())

    const [a, c] = siteRows(host)
    const mark = cell(a, 'site').querySelector<HTMLElement>('.conflict-mark')!
    expect(mark.title).toBe('prior-data conflict at iteration 0: 5 observations')
    expect(cell(a, 'site').textContent).toBe('well_a')
    expect(cell(c, 'site').querySelector('.conflict-mark')).toBeNull()
  })

  it('shows a dash with the reason and no marks when the iteration has no conflict answer', async () => {
    overlaysApi.fetchPdcSites.mockImplementation(async (iteration: number) =>
      pdcOff(iteration, 'no prior-data conflict for iteration 0: no pdc file and no obs+noise to compute one'),
    )
    obsApi.fetchObsSites.mockResolvedValue(sitesAnswer([site(40, 'well_a')]))
    const { host } = await openWithGroups()
    await vi.waitFor(() => expect(overlaysApi.fetchPdcSites).toHaveBeenCalled())
    groupRows(host)[0].click()
    await vi.waitFor(() => expect(siteRows(host).length).toBe(1))
    await new Promise((r) => setTimeout(r, 0))

    for (const row of groupRows(host)) {
      expect(cell(row, 'pdc_obs').textContent).toBe('—')
      expect(cell(row, 'pdc_sites').textContent).toBe('—')
      expect(cell(row, 'pdc_obs').title).toContain('no pdc file and no obs+noise to compute one')
    }
    expect(host.querySelector('.conflict-mark')).toBeNull()
  })

  it('says pdc: and the reason when the answer is refused', async () => {
    overlaysApi.fetchPdcSites.mockResolvedValue({ ok: false, artifact: 'pdc/0', reason: 'the pdc table could not be read' })
    const { host } = await openWithGroups()

    await vi.waitFor(() => expect(host.textContent).toContain('pdc: the pdc table could not be read'))
    expect(cell(groupRows(host)[0], 'pdc_obs').textContent).toBe('—')
    expect(cell(groupRows(host)[0], 'pdc_obs').title).toContain('the pdc table could not be read')
  })

  it('refuses an answer for another iteration than the one shown', async () => {
    overlaysApi.fetchPdcSites.mockImplementation(async () => pdcOn(2))
    const { host } = await openWithGroups()

    await vi.waitFor(() => expect(host.textContent).toContain('pdc: the answer was for iteration 2, not 0'))
    expect(cell(groupRows(host)[0], 'pdc_obs').textContent).toBe('—')
  })

  it('asks again on an iteration change while shown and never draws the older answer', async () => {
    const slow = deferred<ReturnType<typeof pdcOn>>()
    overlaysApi.fetchPdcSites.mockImplementation((iteration: number) =>
      iteration === 0 ? slow.promise : Promise.resolve(pdcOn(iteration, { byGroup: [{ group: 'gw_head', nObs: 1, nSites: 1 }] })),
    )
    const { host, store } = await openWithGroups()

    store.set({ iteration: 4 }, 'map')
    store.flush()
    await vi.waitFor(() => expect(cell(groupRows(host)[0], 'pdc_obs').textContent).toBe('1'))
    slow.resolve(pdcOn(0))
    await new Promise((r) => setTimeout(r, 0))

    expect(overlaysApi.fetchPdcSites).toHaveBeenCalledWith(4, expect.anything())
    expect(cell(groupRows(host)[0], 'pdc_obs').textContent).toBe('1')
  })

  it('shows a dash while the new iteration is asked for, never the old numbers', async () => {
    const later = deferred<ReturnType<typeof pdcOn>>()
    overlaysApi.fetchPdcSites.mockImplementation((iteration: number) => (iteration === 0 ? Promise.resolve(pdcOn(0)) : later.promise))
    const { host, store } = await openWithGroups()
    await vi.waitFor(() => expect(cell(groupRows(host)[0], 'pdc_obs').textContent).toBe('7'))

    store.set({ iteration: 1 }, 'map')
    store.flush()

    expect(cell(groupRows(host)[0], 'pdc_obs').textContent).toBe('—')
    expect(cell(groupRows(host)[0], 'pdc_obs').title).toContain('iteration 1')
  })

  it('asks for nothing while hidden, and asks for the iteration shown at the next show', async () => {
    const { store, handle } = mount({ startHidden: true })
    store.set({ iteration: 2 }, 'map')
    store.flush()
    await Promise.resolve()
    expect(overlaysApi.fetchPdcSites).not.toHaveBeenCalled()

    handle.onShow()
    await vi.waitFor(() => expect(overlaysApi.fetchPdcSites).toHaveBeenCalledTimes(1))
    expect(overlaysApi.fetchPdcSites).toHaveBeenCalledWith(2, expect.anything())

    handle.onHide()
    store.set({ iteration: 3 }, 'map')
    store.flush()
    await Promise.resolve()
    expect(overlaysApi.fetchPdcSites).toHaveBeenCalledTimes(1)
    handle.onShow()
    await vi.waitFor(() => expect(overlaysApi.fetchPdcSites).toHaveBeenCalledTimes(2))
    expect(overlaysApi.fetchPdcSites).toHaveBeenLastCalledWith(3, expect.anything())
  })

  it('makes no request when the pdc capability is off, and gives its reason', async () => {
    const capabilities = available()
    capabilities.pdc = { available: false, blockedBy: [{ artifact: 'pdc', reason: 'no iteration has a conflict source' }] }
    const { host } = await openWithGroups({ capabilities })
    await new Promise((r) => setTimeout(r, 0))

    expect(overlaysApi.fetchPdcSites).not.toHaveBeenCalled()
    expect(cell(groupRows(host)[0], 'pdc_obs').textContent).toBe('—')
    expect(cell(groupRows(host)[0], 'pdc_obs').title).toContain('pdc: no iteration has a conflict source')
  })
})

describe('the spaghetti plot mounted in the panel', () => {
  it('sits in the .obs-spaghetti host', () => {
    const { host } = mount({ startHidden: true })

    expect(host.querySelector('.obs-spaghetti .obs-spaghetti-stage')).not.toBeNull()
  })

  it('fetches a selected site only once the tab is shown, and stops when it is hidden again', async () => {
    obsApi.fetchObsSite.mockResolvedValue({ ok: false, artifact: 'obs_index', reason: 'no such site' })
    const { store, handle } = mount({ startHidden: true })
    store.set({ sites: new Set([7]) }, 'map')
    store.flush()
    expect(obsApi.fetchObsSite).not.toHaveBeenCalled()

    handle.onShow()
    await vi.waitFor(() => expect(obsApi.fetchObsSite).toHaveBeenCalledTimes(1))

    handle.onHide()
    store.set({ sites: new Set([7, 8]) }, 'map')
    store.flush()
    expect(obsApi.fetchObsSite).toHaveBeenCalledTimes(1)
  })

  it('stops following the selection once the panel is disposed', async () => {
    obsApi.fetchObsSite.mockResolvedValue({ ok: false, artifact: 'obs_index', reason: 'no such site' })
    const { store, handle } = mount()
    handle.dispose()
    store.set({ sites: new Set([7]) }, 'map')
    store.flush()

    expect(obsApi.fetchObsSite).not.toHaveBeenCalled()
  })
})

describe('the group fit mounted in the panel', () => {
  it('sits in the .obs-fit host and stays empty until a group is chosen', async () => {
    const { host } = mount()
    await vi.waitFor(() => expect(groupRows(host).length).toBe(2))

    expect(host.querySelector('.obs-fit')!.children.length).toBe(0)
    expect(obsApi.fetchObs1to1).not.toHaveBeenCalled()
  })

  it('asks for the 1:1 of a group when its row is clicked', async () => {
    const { host } = mount()
    await vi.waitFor(() => expect(groupRows(host).length).toBe(2))

    groupRows(host)[1].click()

    await vi.waitFor(() => expect(obsApi.fetchObs1to1).toHaveBeenCalledWith('gw_date', expect.anything()))
    expect(host.querySelector('.obs-fit')!.textContent).toContain('gw_date')
  })

  it('follows a group another view chose', async () => {
    const { host, store } = mount()
    await vi.waitFor(() => expect(groupRows(host).length).toBe(2))

    store.set({ obsGroups: new Set(['gw_head']) }, 'map')
    store.flush()

    await vi.waitFor(() => expect(obsApi.fetchObs1to1).toHaveBeenCalledWith('gw_head', expect.anything()))
  })

  it('fetches a group chosen while hidden only once the tab is shown', async () => {
    const { host, handle, store } = mount({ startHidden: true })
    handle.onShow()
    await vi.waitFor(() => expect(groupRows(host).length).toBe(2))
    handle.onHide()

    store.set({ obsGroups: new Set(['gw_head']) }, 'map')
    store.flush()
    expect(obsApi.fetchObs1to1).not.toHaveBeenCalled()

    handle.onShow()
    await vi.waitFor(() => expect(obsApi.fetchObs1to1).toHaveBeenCalledTimes(1))
  })
})
