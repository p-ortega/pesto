// @vitest-environment jsdom
//
// The Obs panel: the group summary, the chosen group's sites, and the shared selection it writes.
// The two fetchers are mocked, so each test controls exactly what the panel is told.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import type { ObsGroupRow } from '../src/data/obs'
import { renderObsPanel, type ObsPanelOptions } from '../src/ui/obs-panel'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'

const obsApi = vi.hoisted(() => ({
  fetchObsGroups: vi.fn(),
  fetchObsSites: vi.fn(),
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
