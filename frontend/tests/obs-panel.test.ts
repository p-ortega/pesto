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

  it('has the five sections in the order the later plans mount into', () => {
    const { host } = mount({ startHidden: true })

    const classes = [...host.children].map((el) => el.className).filter((c) => c.startsWith('obs-'))
    expect(classes).toEqual(['obs-notices', 'obs-groups', 'obs-fit', 'obs-sites', 'obs-spaghetti'])
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

  it('lets the lists below the table shrink while the table keeps a floor', () => {
    expect(rule('.obs-sites')).toMatch(/flex:\s*0 1 auto/)
    expect(rule('.obs-sites')).toMatch(/max-height/)
    expect(rule('.obs-groups')).toMatch(/flex:\s*1 1 0/)
    expect(rule('.obs-groups')).toMatch(/min-height:\s*\d+rem/)
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

  it('asks the user to choose a group before one is chosen', async () => {
    const { host } = await openWithGroups()

    expect(host.querySelector('.obs-sites')?.textContent).toContain('Choose a group above to list its sites')
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
    expect(cell(a, 'layer').textContent).toBe('1')
    expect(cell(a, 'placement').textContent).toBe('own position')
    expect(cell(b, 'site').textContent).toBe('well_b')
    expect(cell(b, 'layer').textContent).toBe('unknown')
    expect(cell(b, 'placement').textContent).toBe('not placed')
    expect(cell(b, 'placement').title).toBe('no x or y in the file')
    expect(host.querySelector('.obs-sites-title')?.textContent).toBe('gw_head: 2 sites')
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
    expect(host.querySelector('.obs-sites-title')?.textContent).toBe('gw_date: 1 site')
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
