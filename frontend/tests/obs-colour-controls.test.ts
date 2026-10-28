// @vitest-environment jsdom
//
// The colour-by switch, the observation group, statistic and all-layers controls, and the
// observation legend. The switch only writes the shared selection; the map view draws.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObsGroupRow, ObsGroupsResult } from '../src/data/obs'
import { OBS_STATS, OBS_STAT_LABEL } from '../src/data/obs'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import { renderSelectionControls } from '../src/ui/controls'
import {
  OBS_RAMP,
  renderObsColourControls,
  renderObsLegend,
  type ObsLegendOptions,
} from '../src/ui/obs-colour-controls'

function groupRow(group: string, nPlaced: number | null): ObsGroupRow {
  return {
    group,
    nObs: 10,
    nSites: 4,
    nPlaced,
    nWeighted: 10,
    nWithTarget: 10,
    nZeroWeight: 0,
    nSentinel: 0,
    nNoValue: 0,
    timeKind: 'numeric',
    inequality: 'none',
    firstIteration: 0,
    lastIteration: 1,
    rmseFirst: 1,
    rmseLast: 0.5,
    nResidFirst: 10,
    nResidLast: 10,
  }
}

const GROUPS: ObsGroupsResult = { ok: true, rows: [groupRow('conc', 0), groupRow('heads', 5), groupRow('<i>odd</i>', null)], notes: [] }

function manualStore(): SelectionStore {
  return createSelectionStore({ initial: emptySelection('run', 0), schedule: () => {} })
}

function mount(store: SelectionStore, loadGroups = vi.fn(async () => GROUPS), onAllLayersChange?: (on: boolean) => void) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const handle = renderObsColourControls(host, { store, loadGroups, onAllLayersChange })
  return { host, handle, loadGroups }
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!found) throw new Error(`no button ${text}`)
  return found as HTMLButtonElement
}

const groupSelect = (host: HTMLElement) => host.querySelector('select[aria-label="Observation group"]') as HTMLSelectElement
const statSelect = (host: HTMLElement) => host.querySelector('select[aria-label="Observation statistic"]') as HTMLSelectElement

// Records what each write was tagged with, since the switch must write as the map.
function recordWrites(store: SelectionStore): Array<{ colour: string; groups: string[]; origins: string[] }> {
  const writes: Array<{ colour: string; groups: string[]; origins: string[] }> = []
  const set = store.set.bind(store)
  store.set = (patch, origin) => {
    set(patch, origin)
    const now = store.get()
    writes.push({ colour: `${now.colour.source}:${now.colour.stat}`, groups: [...now.obsGroups], origins: [origin] })
  }
  return writes
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('the colour-by switch', () => {
  it('shows Parameters pressed on a fresh selection and reads no group list yet', () => {
    const { host, loadGroups } = mount(manualStore())
    expect(button(host, 'Parameters').getAttribute('aria-pressed')).toBe('true')
    expect(button(host, 'Observations').getAttribute('aria-pressed')).toBe('false')
    expect(host.querySelector('.obs-colour-rows')!.hasAttribute('hidden')).toBe(true)
    expect(loadGroups).not.toHaveBeenCalled()
  })

  it("writes colour obs with the mean residual as the map, and asks for the groups once", async () => {
    const store = manualStore()
    const writes = recordWrites(store)
    const { host, loadGroups } = mount(store)
    button(host, 'Observations').click()
    expect(store.get().colour).toEqual({ source: 'obs', stat: 'resid_mean' })
    expect(writes.at(-1)).toMatchObject({ colour: 'obs:resid_mean', origins: ['map'] })
    expect(button(host, 'Observations').getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('.obs-colour-rows')!.hasAttribute('hidden')).toBe(false)
    await vi.waitFor(() => expect(groupSelect(host).options.length).toBeGreaterThan(1))
    expect(loadGroups).toHaveBeenCalledTimes(1)
  })

  it('goes back to the parameter statistic it left, not to the observation one', () => {
    const store = manualStore()
    store.set({ colour: { source: 'par', stat: 'q50' } }, 'map')
    const { host } = mount(store)
    button(host, 'Observations').click()
    expect(store.get().colour.stat).toBe('resid_mean')
    button(host, 'Parameters').click()
    expect(store.get().colour).toEqual({ source: 'par', stat: 'q50' })
  })

  it('keeps the last observation statistic chosen across a trip to Parameters', () => {
    const store = manualStore()
    const { host } = mount(store)
    button(host, 'Observations').click()
    statSelect(host).value = 'std'
    statSelect(host).dispatchEvent(new Event('change'))
    expect(store.get().colour).toEqual({ source: 'obs', stat: 'std' })
    button(host, 'Parameters').click()
    button(host, 'Observations').click()
    expect(store.get().colour).toEqual({ source: 'obs', stat: 'std' })
  })

  it('offers each statistic under its plain name, and the map rmse is not called RMSE', () => {
    const { host } = mount(manualStore())
    const labels = [...statSelect(host).options].map((o) => o.textContent)
    expect(labels).toEqual(OBS_STATS.map((s) => OBS_STAT_LABEL[s]))
    expect(labels).toContain('RMS residual over realizations')
    expect(labels).not.toContain('RMSE')
  })

  it('has a diverging ramp for the signed residual and viridis for the magnitudes', () => {
    expect(OBS_RAMP).toEqual({ resid_mean: 'RdBu', rmse: 'viridis', std: 'viridis', mean: 'viridis' })
  })
})

describe('the observation group picker', () => {
  it('lists group names with their placed counts as text, markup included', async () => {
    const { host } = mount(manualStore())
    button(host, 'Observations').click()
    await vi.waitFor(() => expect(groupSelect(host).disabled).toBe(false))
    const labels = [...groupSelect(host).options].map((o) => o.textContent)
    expect(labels).toContain('conc · 0 placed')
    expect(labels).toContain('heads · 5 placed')
    expect(labels).toContain('<i>odd</i> · placement unknown')
    expect(host.querySelector('i')).toBeNull()
  })

  it('writes the chosen group as the map', async () => {
    const store = manualStore()
    const writes = recordWrites(store)
    const { host } = mount(store)
    button(host, 'Observations').click()
    await vi.waitFor(() => expect(groupSelect(host).disabled).toBe(false))
    groupSelect(host).value = 'heads'
    groupSelect(host).dispatchEvent(new Event('change'))
    expect([...store.get().obsGroups]).toEqual(['heads'])
    expect(writes.at(-1)!.origins).toEqual(['map'])
  })

  it('follows a group chosen in the Obs tab', async () => {
    const store = manualStore()
    const { host } = mount(store)
    button(host, 'Observations').click()
    await vi.waitFor(() => expect(groupSelect(host).disabled).toBe(false))
    store.set({ obsGroups: new Set(['heads']) }, 'obs')
    store.flush()
    expect(groupSelect(host).value).toBe('heads')
  })

  it('names the artifact and reason when the group list is refused', async () => {
    const { host } = mount(manualStore(), vi.fn(async () => ({ ok: false as const, artifact: 'obs_index', reason: 'not recorded' })))
    button(host, 'Observations').click()
    await vi.waitFor(() => expect(host.textContent).toContain('obs_index: not recorded'))
  })
})

describe('all layers', () => {
  it('tells the map on a user change, and not on a set from outside', () => {
    const changed = vi.fn()
    const { host, handle } = mount(manualStore(), undefined, changed)
    const box = host.querySelector('input[aria-label="All layers"]') as HTMLInputElement
    expect(handle.allLayers()).toBe(false)
    box.checked = true
    box.dispatchEvent(new Event('change'))
    expect(changed).toHaveBeenCalledWith(true)
    expect(handle.allLayers()).toBe(true)
    changed.mockClear()
    handle.setAllLayers(false)
    expect(box.checked).toBe(false)
    expect(changed).not.toHaveBeenCalled()
  })

  it('stops following the store after dispose', () => {
    const store = manualStore()
    const { host, handle } = mount(store)
    handle.dispose()
    store.set({ colour: { source: 'obs', stat: 'resid_mean' } }, 'x')
    store.flush()
    expect(button(host, 'Observations').getAttribute('aria-pressed')).toBe('false')
  })
})

describe('the parameter-only rows of the selection controls', () => {
  it('are marked so the map can hide them, and the layer slider is not', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    renderSelectionControls(host, {
      nlay: 2,
      iteration: 0,
      realNames: { ok: true, names: ['base', 'r1'] },
      partrans: null,
      onSelectionChange: () => {},
      onFitToExtent: () => {},
    })
    const marked = [...host.querySelectorAll('[data-colour-source="par"]')].map((el) => el.textContent ?? '')
    for (const word of ['Statistic', 'Realization', 'Colormap', 'Reverse', 'Value scale', 'Limits']) {
      expect(marked.some((text) => text.includes(word)), word).toBe(true)
    }
    expect((host.querySelector('input[aria-label="Layer"]') as HTMLElement).closest('[data-colour-source]')).toBeNull()
    expect(button(host, 'Fit to extent').closest('[data-colour-source]')).toBeNull()
  })
})

describe('renderObsLegend', () => {
  const counts = { drawn: 3, onOtherLayers: 2, unknownLayerHidden: 1, unplaced: 1, own: 2, cellCentre: 1, unplacedNotes: ['no cell here'] }
  const base: ObsLegendOptions = {
    group: 'heads',
    stat: 'resid_mean',
    iteration: 1,
    limits: [-2, 2],
    limitsRule: 'symmetric about 0',
    timeText: 'day 10 (model time)',
    counts,
    atTime: { withValue: 2, withObservationNoValue: 1, rowsHidden: 0, total: 3 },
    layerMoved: null,
    notes: [],
  }

  it('says the statistic, iteration, time, limits rule, sign and every count', () => {
    const el = document.createElement('div')
    renderObsLegend(el, base)
    const text = el.textContent ?? ''
    expect(text).toContain('mean residual (simulated minus observed), iteration 1')
    expect(text).toContain('simulated minus observed; blue means simulated above observed')
    expect(text).toContain('day 10 (model time)')
    expect(text).toContain('Limits: symmetric about 0')
    expect(text).toContain('2 of 3 sites have a value at this time')
    expect(text).toContain('1 has an observation at this time but no measured value')
    expect(text).toContain("1 at the centre of the cell's vertices, 2 at its own x and y")
    expect(text).toContain('1 site not placed: no cell here')
    expect(text).toContain('2 sites on other layers')
    expect(text).toContain('1 site with an unknown layer, shown only under all layers')
  })

  it('says how many observations lost to a later one of the same site, and is quiet when none did', () => {
    const el = document.createElement('div')
    renderObsLegend(el, base)
    expect(el.textContent).not.toContain('share their time')
    renderObsLegend(el, { ...base, atTime: { ...base.atTime!, rowsHidden: 2 } })
    expect(el.textContent).toContain('2 observations share their time with a later one of the same site; the last is shown')
    renderObsLegend(el, { ...base, atTime: { ...base.atTime!, rowsHidden: 1 } })
    expect(el.textContent).toContain('1 observation shares its time with a later one of the same site; the last is shown')
  })

  it('leaves the sign line off a magnitude statistic and names the spread', () => {
    const el = document.createElement('div')
    renderObsLegend(el, { ...base, stat: 'rmse', limits: [0, 3] })
    const text = el.textContent ?? ''
    expect(text).toContain('RMS residual over realizations, iteration 1')
    expect(text).not.toContain('simulated above observed')
  })

  it('says the layer move, and a missing reason for unplaced sites', () => {
    const el = document.createElement('div')
    renderObsLegend(el, { ...base, layerMoved: 6, counts: { ...counts, unplacedNotes: [] } })
    expect(el.textContent).toContain('moved to layer 6, the lowest layer with a site of this group')
    expect(el.textContent).toContain('1 site not placed: no reason was recorded')
  })

  it('says no site is drawn when the group has none, and counts no time line', () => {
    const el = document.createElement('div')
    renderObsLegend(el, { ...base, counts: { ...counts, drawn: 0, own: 0, cellCentre: 0 }, atTime: { withValue: 0, withObservationNoValue: 0, rowsHidden: 0, total: 0 } })
    expect(el.textContent).toContain('No site of this group is drawn')
    expect(el.textContent).not.toContain('have a value at this time')
  })

  it('shows no figures when a statistic has no limits, with its reason', () => {
    const el = document.createElement('div')
    renderObsLegend(el, { ...base, limits: null })
    expect(el.textContent).toContain('no finite value')
  })

  it('writes a group name as text, never as markup, and clears on null', () => {
    const el = document.createElement('div')
    renderObsLegend(el, { ...base, group: '<b>bold</b>' })
    expect(el.querySelector('b')).toBeNull()
    expect(el.textContent).toContain('<b>bold</b>')
    renderObsLegend(el, null)
    expect(el.textContent).toBe('')
  })

  it('draws a swatch from the ramp table with no colour literal', () => {
    const el = document.createElement('div')
    renderObsLegend(el, base)
    const swatch = el.querySelector('div[aria-hidden="true"]') as HTMLElement
    expect(swatch.style.background).toContain('linear-gradient')
  })
})
