// @vitest-environment jsdom
//
// The Obs tab's 'Selected sites' section: where a cell click found its sites, the cap and the
// counts of what it left out, and the place of sites chosen any other way.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CellLinkAnswer, CellLinkSite } from '../src/data/link'
import type { SitesWhereResult, SiteWhere } from '../src/data/link-targets'
import { emptySelection, type SharedSelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import { renderSelectedSites, type SelectedSitesOptions } from '../src/ui/obs-selected'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

const linkApi = vi.hoisted(() => ({ recentCellLink: vi.fn() }))
vi.mock('../src/data/link', async () => ({
  ...(await vi.importActual<typeof import('../src/data/link')>('../src/data/link')),
  ...linkApi,
}))

function linkSite(id: number, over: Partial<CellLinkSite> = {}): CellLinkSite {
  return { siteId: id, site: `site_${id}`, group: 'gw_head', layer: 3, cell: 1234, inClickedCell: true, ...over }
}

function cellAnswer(over: Partial<CellLinkAnswer> = {}): CellLinkAnswer {
  return {
    layer: 3,
    cells: [1234],
    ring: [1, 2, 3, 4, 5, 6, 7, 8],
    ringRule: 'cells sharing at least one corner with a clicked cell',
    pars: [],
    parsTotal: 0,
    parNotes: [],
    sites: [linkSite(10), linkSite(11, { inClickedCell: false, cell: 1235, group: 'gw_date' })],
    sitesTotal: 2,
    sitesCap: 50,
    siteCounts: { unknownLayerIncluded: 0, otherLayerLeftOut: 0, unplacedInRun: 0 },
    reasons: { pars: null, sites: null },
    ...over,
  }
}

function where(id: number, over: Partial<SiteWhere> = {}): SiteWhere {
  return { siteId: id, site: `site_${id}`, group: 'gw_head', layer: 2, cell: 40 + id, placed: true, hasValue: true, ...over }
}

function whereAnswer(sites: SiteWhere[], over: Partial<Extract<SitesWhereResult, { ok: true }>> = {}): SitesWhereResult {
  return { ok: true, iteration: 0, sites, unknown: [], valueRule: 'one observation with a value', valueReason: null, notAsked: 0, ...over }
}

function makeStore(over: Partial<SharedSelection> = {}): SelectionStore {
  return createSelectionStore({ initial: { ...emptySelection('run', 0), ...over }, schedule: () => {} })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function mount(over: Partial<SelectedSitesOptions> & { hidden?: boolean } = {}) {
  const host = document.createElement('div')
  host.classList.add('obs-selected')
  document.body.appendChild(host)
  const store = over.store ?? makeStore()
  const state = { hidden: over.hidden === true }
  const onPick = over.onPick ?? vi.fn()
  const loadWhere = over.loadWhere ?? vi.fn(async () => whereAnswer([]))
  const handle = renderSelectedSites(host, { store, isHidden: () => state.hidden, onPick, loadWhere })
  return { host, store, state, handle, onPick, loadWhere }
}

function title(host: HTMLElement): string {
  return host.querySelector('.obs-selected-title')?.textContent ?? ''
}

function lines(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.link-reach')].map((l) => l.textContent ?? '')
}

function rows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('.obs-grid-row')]
}

function cell(row: HTMLElement, column: string): HTMLElement {
  return row.querySelector<HTMLElement>(`[data-column="${column}"]`)!
}

beforeEach(() => {
  document.body.innerHTML = ''
  linkApi.recentCellLink.mockReset()
  linkApi.recentCellLink.mockReturnValue(null)
})

afterEach(() => {
  document.head.textContent = ''
})

describe('after a cell click', () => {
  function clicked(answer: CellLinkAnswer) {
    linkApi.recentCellLink.mockReturnValue(answer)
    const store = makeStore({ cells: new Set(answer.cells), sites: new Set(answer.sites.map((s) => s.siteId)) })
    const view = mount({ store })
    view.handle.refresh()
    return view
  }

  it('says the sites were found in the cell and its first ring, and lists each with group, layer and where', () => {
    const { host, loadWhere } = clicked(cellAnswer())

    expect(title(host)).toBe('Sites in cell 1234 and its 8 neighbouring cells on layer 3')
    const [a, b] = rows(host)
    expect(cell(a, 'site').textContent).toBe('site_10')
    expect(cell(a, 'group').textContent).toBe('gw_head')
    expect(cell(a, 'layer').textContent).toBe('3')
    expect(cell(a, 'where').textContent).toBe('in the cell')
    expect(cell(b, 'group').textContent).toBe('gw_date')
    expect(cell(b, 'where').textContent).toBe('in a neighbouring cell')
    expect(loadWhere).not.toHaveBeenCalled()
  })

  it('names every clicked cell when there are a few', () => {
    const { host } = clicked(cellAnswer({ cells: [12, 34], ring: Array.from({ length: 14 }, (_, i) => i) }))

    expect(title(host)).toBe('Sites in cells 12 and 34 and their 14 neighbouring cells on layer 3')
  })

  it('says how many sites the cap left out', () => {
    const sites = Array.from({ length: 50 }, (_, i) => linkSite(i))
    const { host } = clicked(cellAnswer({ sites, sitesTotal: 73, sitesCap: 50 }))

    expect(lines(host)).toContain('50 of 73 sites shown; zoom in or lasso to pick fewer')
    expect(rows(host).length).toBeLessThanOrEqual(50)
  })

  it('counts unknown-layer, other-layer and unplaced sites, and prints nothing for a zero count', () => {
    const { host } = clicked(cellAnswer({ siteCounts: { unknownLayerIncluded: 2, otherLayerLeftOut: 4, unplacedInRun: 12 } }))

    expect(lines(host)).toEqual([
      '2 sites of unknown layer included',
      '4 sites on other layers in these cells left out',
      '12 sites in this run are not placed, so no cell click can find them',
    ])

    document.body.innerHTML = ''
    const none = clicked(cellAnswer())
    expect(lines(none.host)).toEqual([])
  })

  it("gives the answer's reason as the section's text when no site is in reach", () => {
    const reason = 'no observation site in this cell or its neighbours on layer 3'
    const { host } = clicked(cellAnswer({ sites: [], sitesTotal: 0, reasons: { pars: null, sites: reason }, siteCounts: { unknownLayerIncluded: 0, otherLayerLeftOut: 4, unplacedInRun: 0 } }))

    expect(title(host)).toBe(reason)
    expect(lines(host)).toEqual(['4 sites on other layers in these cells left out'])
    expect(rows(host).length).toBe(0)
  })

  it('stops reading the cell answer once the sites no longer match it', async () => {
    const { host, store, handle, loadWhere } = clicked(cellAnswer())
    vi.mocked(loadWhere).mockResolvedValue(whereAnswer([where(10)]))

    store.set({ sites: new Set([10]) }, 'obs')
    handle.refresh()
    await vi.waitFor(() => expect(rows(host).length).toBe(1))

    expect(title(host)).toBe('Selected sites: 1')
    expect(loadWhere).toHaveBeenCalledWith([10], 0, expect.anything())
    expect(rows(host).map((r) => r.dataset.siteId)).toEqual(['10'])
  })
})

describe('sites chosen another way', () => {
  it('asks where the first 200 sites are at the shown iteration, once, and lists name, group and layer', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i)
    const store = makeStore({ sites: new Set(ids), iteration: 2 })
    const loadWhere = vi.fn(async () => whereAnswer([where(0), where(1, { placed: false, cell: -1, layer: -1 })], { iteration: 2, notAsked: 50 }))
    const { host, handle } = mount({ store, loadWhere })

    handle.refresh()
    await vi.waitFor(() => expect(rows(host).length).toBe(2))
    handle.refresh()

    expect(loadWhere).toHaveBeenCalledTimes(1)
    const [askedIds, iteration] = loadWhere.mock.calls[0] as unknown as [number[], number]
    expect(askedIds.length).toBe(200)
    expect(askedIds.slice(0, 3)).toEqual([0, 1, 2])
    expect(iteration).toBe(2)
    expect(title(host)).toBe('Selected sites: 250')
    const [a, b] = rows(host)
    expect(cell(a, 'site').textContent).toBe('site_0')
    expect(cell(a, 'group').textContent).toBe('gw_head')
    expect(cell(a, 'layer').textContent).toBe('2')
    expect(cell(b, 'layer').textContent).toBe('unknown')
    expect(cell(b, 'where').textContent).toBe('not placed')
    expect(lines(host)).toContain('50 more selected sites are not listed: only the first 200 are looked up')
  })

  it('counts ids the run does not know and sites with no observation at the iteration', async () => {
    const store = makeStore({ sites: new Set([1, 2, 3]) })
    const loadWhere = vi.fn(async () => whereAnswer([where(1), where(2, { hasValue: false })], { unknown: [3] }))
    const { host, handle } = mount({ store, loadWhere })

    handle.refresh()
    await vi.waitFor(() => expect(rows(host).length).toBe(2))

    expect(lines(host)).toContain('1 selected site id is not in this run')
    expect(lines(host)).toContain('1 of these sites has no observation with a value at iteration 0')
  })

  it('shows the reason when the places cannot be read', async () => {
    const store = makeStore({ sites: new Set([1]) })
    const loadWhere = vi.fn(async (): Promise<SitesWhereResult> => ({ ok: false, artifact: 'obs_cell', reason: 'obs_cell is not in the cache' }))
    const { host, handle } = mount({ store, loadWhere })

    handle.refresh()
    await vi.waitFor(() => expect(host.textContent).toContain('obs_cell: obs_cell is not in the cache'))
    expect(rows(host).length).toBe(0)
  })

  it('refuses an answer for another iteration than the one asked for', async () => {
    const store = makeStore({ sites: new Set([1]), iteration: 3 })
    const loadWhere = vi.fn(async () => whereAnswer([where(1)], { iteration: 2 }))
    const { host, handle } = mount({ store, loadWhere })

    handle.refresh()
    await vi.waitFor(() => expect(host.textContent).toContain('the answer was for iteration 2, not 3'))
    expect(rows(host).length).toBe(0)
  })

  it('draws only the newest answer when an older one lands late', async () => {
    const slow = deferred<SitesWhereResult>()
    const loadWhere = vi.fn((ids: readonly number[]) =>
      ids[0] === 1 ? slow.promise : Promise.resolve(whereAnswer([where(2)])),
    )
    const store = makeStore({ sites: new Set([1]) })
    const { host, handle } = mount({ store, loadWhere })

    handle.refresh()
    store.set({ sites: new Set([2]) }, 'map')
    handle.refresh()
    await vi.waitFor(() => expect(rows(host).length).toBe(1))
    slow.resolve(whereAnswer([where(1)]))
    await new Promise((r) => setTimeout(r, 0))

    expect(rows(host).map((r) => r.dataset.siteId)).toEqual(['2'])
  })

  it('windows a long list', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => i)
    const store = makeStore({ sites: new Set(ids) })
    const loadWhere = vi.fn(async () => whereAnswer(ids.map((id) => where(id))))
    const { host, handle } = mount({ store, loadWhere })

    handle.refresh()
    await vi.waitFor(() => expect(rows(host).length).toBeGreaterThan(0))
    expect(rows(host).length).toBeLessThan(100)

    const pane = host.querySelector<HTMLElement>('.scroll-pane')!
    expect(pane.firstElementChild).toBeInstanceOf(HTMLElement)
    expect((pane.firstElementChild as HTMLElement).style.height).toBe(`${200 * 24}px`)
    pane.scrollTop = 180 * 24
    pane.dispatchEvent(new Event('scroll'))
    expect(rows(host).map((r) => r.dataset.siteId)).toContain('190')
  })
})

describe('the section in general', () => {
  it('shows nothing with no site chosen', () => {
    const { host, handle } = mount()

    handle.refresh()

    expect(host.textContent).toBe('')
    expect(host.children.length).toBe(0)
  })

  it('hands a row click and its modifiers to the panel', async () => {
    const store = makeStore({ sites: new Set([5]) })
    const loadWhere = vi.fn(async () => whereAnswer([where(5)]))
    const { host, handle, onPick } = mount({ store, loadWhere })
    handle.refresh()
    await vi.waitFor(() => expect(rows(host).length).toBe(1))

    rows(host)[0].dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
    rows(host)[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))

    expect(onPick).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(onPick).mock.calls
    expect(calls[0][0]).toBe(5)
    expect(calls[0][1].altKey).toBe(true)
    expect(calls[1][1].shiftKey).toBe(true)
  })

  it('fetches nothing while hidden and fetches on show what changed meanwhile', async () => {
    const store = makeStore({ sites: new Set([7]) })
    const loadWhere = vi.fn(async () => whereAnswer([where(7)]))
    const { host, handle, state } = mount({ store, loadWhere, hidden: true })

    handle.refresh()
    await Promise.resolve()
    expect(loadWhere).not.toHaveBeenCalled()
    expect(rows(host).length).toBe(0)

    state.hidden = false
    handle.onShow()
    await vi.waitFor(() => expect(rows(host).length).toBe(1))
    expect(loadWhere).toHaveBeenCalledTimes(1)
  })

  it('writes names through textContent and keeps the full name in the title', async () => {
    const name = '<img src=x onerror=alert(1)>'
    const store = makeStore({ sites: new Set([1]) })
    const loadWhere = vi.fn(async () => whereAnswer([where(1, { site: name, group: name })]))
    const { host, handle } = mount({ store, loadWhere })

    handle.refresh()
    await vi.waitFor(() => expect(rows(host).length).toBe(1))

    expect(host.querySelector('img')).toBeNull()
    expect(cell(rows(host)[0], 'site').textContent).toBe(name)
    expect(cell(rows(host)[0], 'site').title).toBe(name)
    expect(cell(rows(host)[0], 'group').title).toBe(name)
  })

  it('builds its rows with role row, so the 10em name column rule applies', () => {
    linkApi.recentCellLink.mockReturnValue(cellAnswer())
    const store = makeStore({ cells: new Set([1234]), sites: new Set([10, 11]) })
    const { host, handle } = mount({ store })
    handle.refresh()

    expect(host.querySelector('[role="grid"] > .obs-grid-header')?.getAttribute('role')).toBe('row')
    expect(rows(host).every((r) => r.getAttribute('role') === 'row')).toBe(true)
  })

  it('never runs its title, lines or cells together', () => {
    loadRealStylesheet()
    linkApi.recentCellLink.mockReturnValue(cellAnswer({ sitesTotal: 73, siteCounts: { unknownLayerIncluded: 2, otherLayerLeftOut: 4, unplacedInRun: 12 } }))
    const store = makeStore({ cells: new Set([1234]), sites: new Set([10, 11]) })
    const { host, handle } = mount({ store })
    handle.refresh()

    expectNoRunTogetherText(host, 'obs-selected.ts')
  })

  it('stops any read once disposed', async () => {
    const slow = deferred<SitesWhereResult>()
    const store = makeStore({ sites: new Set([1]) })
    const { host, handle } = mount({ store, loadWhere: vi.fn(() => slow.promise) })

    handle.refresh()
    handle.dispose()
    slow.resolve(whereAnswer([where(1)]))
    await new Promise((r) => setTimeout(r, 0))

    expect(rows(host).length).toBe(0)
  })
})
