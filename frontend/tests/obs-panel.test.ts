// @vitest-environment jsdom
//
// The Obs panel: the group summary, the chosen group's sites, and the shared selection it writes.
// The two fetchers are mocked, so each test controls exactly what the panel is told.

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
