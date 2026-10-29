// @vitest-environment jsdom
//
// The 'Selected parameters' section of the Params tab (D-05, D-07, OQ15): what `pars` holds,
// grouped by pargp, and after a cell click the cells, layer, factors and notes the answer gave.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CellLinkAnswer, CellLinkPar } from '../src/data/link'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'
import { renderSelectedParams, type SelectedParamsOptions } from '../src/ui/params-selected'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

const linkApi = vi.hoisted(() => ({ recentCellLink: vi.fn() }))
vi.mock('../src/data/link', () => linkApi)

function makeStore(over: { pars?: string[]; cells?: number[] } = {}): SelectionStore {
  const initial = {
    ...emptySelection('run', 0),
    pars: new Set(over.pars ?? []),
    cells: new Set(over.cells ?? []),
  }
  return createSelectionStore({ initial, schedule: () => {} })
}

function direct(parnme: string, pargp: string | null, cell = 1234): CellLinkPar {
  return { parnme, pargp, kind: 'cell', cell, weights: [], rule: 'sets this cell (par_cell)' }
}

function pilot(parnme: string, pargp: string, weights: { cell: number; weight: number }[]): CellLinkPar {
  return { parnme, pargp, kind: 'pilot_point', cell: 99, weights, rule: 'pilot point with a non-zero factor on this cell' }
}

function answer(over: Partial<CellLinkAnswer> = {}): CellLinkAnswer {
  return {
    layer: 3,
    cells: [1234],
    ring: [],
    ringRule: 'cells sharing a corner',
    pars: [],
    parsTotal: 0,
    parNotes: [],
    sites: [],
    sitesTotal: 0,
    sitesCap: 50,
    siteCounts: { unknownLayerIncluded: 0, otherLayerLeftOut: 0, unplacedInRun: 0 },
    reasons: { pars: null, sites: null },
    ...over,
  }
}

function mount(): HTMLElement {
  const el = document.createElement('div')
  el.classList.add('params-selected')
  document.body.appendChild(el)
  return el
}

function render(store: SelectionStore, over: Partial<SelectedParamsOptions> = {}) {
  const host = mount()
  const onPick = vi.fn()
  const pargp: Record<string, string> = { a1: 'A', a2: 'A', b1: 'B', hk1: 'hk', hk2: 'hk' }
  const handle = renderSelectedParams(host, {
    store,
    pargpOf: (name) => pargp[name] ?? null,
    onPick,
    isHidden: () => false,
    ...over,
  })
  return { host, handle, onPick }
}

function parRows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-selected-parameter]')]
}

function groupRows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('.selected-group')]
}

function title(host: HTMLElement): string {
  return host.querySelector('.params-selected-title')!.textContent ?? ''
}

function lines(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.params-selected-line')].map((l) => l.textContent ?? '')
}

beforeEach(() => {
  linkApi.recentCellLink.mockReset()
  linkApi.recentCellLink.mockReturnValue(null)
})

afterEach(() => {
  document.body.textContent = ''
})

describe('renderSelectedParams after a cell click', () => {
  it('names the cell and layer, groups by pargp in the answer order with a count, and shows pilot-point factors', () => {
    const found = answer({
      pars: [direct('hk_c1234', 'hk'), pilot('pp_k3', 'pp_k', [{ cell: 1234, weight: 0.42 }]), direct('rch_c1234', 'rch'), pilot('pp_k7', 'pp_k', [{ cell: 1234, weight: 0.1 }])],
      parsTotal: 4,
    })
    linkApi.recentCellLink.mockReturnValue(found)
    const store = makeStore({ pars: found.pars.map((p) => p.parnme), cells: [1234] })
    const { host } = render(store)

    expect(title(host)).toBe('Selected parameters · 4')
    expect(lines(host)[0]).toBe('Parameters that set cell 1234 on layer 4 (index 3)')
    expect(groupRows(host).map((g) => g.dataset.group)).toEqual(['hk', 'pp_k', 'rch'])
    expect(groupRows(host)[1].textContent).toContain('2 parameters')
    expect(groupRows(host)[0].textContent).toContain('1 parameter')
    expect(parRows(host).map((r) => r.dataset.selectedParameter)).toEqual(['hk_c1234', 'pp_k3', 'pp_k7', 'rch_c1234'])
    const pp = parRows(host).find((r) => r.dataset.selectedParameter === 'pp_k3')!
    expect(pp.textContent).toContain('factor 0.42 on cell 1234')
  })

  it('says "cells 12, 13" when more than one cell was clicked', () => {
    const found = answer({ cells: [12, 13], pars: [direct('a1', 'A', 12)], parsTotal: 1 })
    linkApi.recentCellLink.mockReturnValue(found)
    const { host } = render(makeStore({ pars: ['a1'], cells: [12, 13] }))

    expect(lines(host)[0]).toBe('Parameters that set cells 12, 13 on layer 4 (index 3)')
  })

  it('lists the par_notes under the heading', () => {
    const note = 'group pp_k: k.bin is a binary factor file, and pesto lists the points behind a cell only from text factor files'
    const found = answer({ pars: [direct('a1', 'A')], parsTotal: 1, parNotes: [note] })
    linkApi.recentCellLink.mockReturnValue(found)
    const { host } = render(makeStore({ pars: ['a1'], cells: [1234] }))

    const notes = [...host.querySelectorAll('.link-reach')].map((n) => n.textContent)
    expect(notes).toContain(note)
  })

  it('says "500 of 620 shown" when the answer was capped', () => {
    const pars = Array.from({ length: 500 }, (_, i) => direct(`p${i}`, 'G'))
    const found = answer({ pars, parsTotal: 620 })
    linkApi.recentCellLink.mockReturnValue(found)
    const { host } = render(makeStore({ pars: pars.map((p) => p.parnme), cells: [1234] }))

    expect(title(host)).toBe('Selected parameters · 500')
    expect(lines(host)).toContain('500 of 620 shown')
  })

  it('shows the answer reason when no parameter sets the cell, never an empty section', () => {
    const reason = 'no parameter sets cell 1234 on layer 4 (index 3)'
    linkApi.recentCellLink.mockReturnValue(answer({ reasons: { pars: reason, sites: null } }))
    const { host } = render(makeStore({ pars: [], cells: [1234] }))

    expect(title(host)).toBe('Selected parameters · 0')
    expect(lines(host)).toEqual([reason])
    expect(host.style.display).not.toBe('none')
    expect(parRows(host).length).toBe(0)
  })

  it('words the cell and layer itself when the server gave notes but no reason', () => {
    const note = 'group pp_k: its factor file could not be read'
    linkApi.recentCellLink.mockReturnValue(answer({ parNotes: [note], reasons: { pars: null, sites: null } }))
    const { host } = render(makeStore({ pars: [], cells: [1234] }))

    expect(title(host)).toBe('Selected parameters · 0')
    expect(lines(host)).toEqual(['no parameter listed for cell 1234 on layer 4 (index 3)'])
    expect(host.textContent).toContain(note)
  })

  it('keeps the title and words the cell when the server gave neither a reason nor notes', () => {
    linkApi.recentCellLink.mockReturnValue(answer())
    const { host } = render(makeStore({ pars: [], cells: [1234] }))

    expect(host.style.display).not.toBe('none')
    expect(title(host)).toBe('Selected parameters · 0')
    expect(lines(host)).toEqual(['no parameter listed for cell 1234 on layer 4 (index 3)'])
  })

  it('draws 500 rows windowed, with only the visible rows and the overscan in the DOM', () => {
    const pars = Array.from({ length: 500 }, (_, i) => direct(`p${i}`, 'G'))
    linkApi.recentCellLink.mockReturnValue(answer({ pars, parsTotal: 500 }))
    const { host } = render(makeStore({ pars: pars.map((p) => p.parnme), cells: [1234] }))

    const drawn = parRows(host).length
    expect(drawn).toBeGreaterThan(0)
    expect(drawn).toBeLessThan(100)
    const pane = host.querySelector<HTMLElement>('.scroll-pane')!
    pane.scrollTop = 400 * 24
    pane.dispatchEvent(new Event('scroll'))
    expect(parRows(host).map((r) => r.dataset.selectedParameter)).toContain('p399')
  })
})

describe('renderSelectedParams keeps its place', () => {
  it('puts a redrawn list back where it was scrolled to', () => {
    const names = Array.from({ length: 300 }, (_, i) => `p${i}`)
    const store = makeStore({ pars: names })
    const { host, handle } = render(store)
    const pane = host.querySelector<HTMLElement>('.scroll-pane')!
    pane.scrollTop = 200 * 24

    store.set({ pars: new Set(names.slice(0, 299)) }, 'map')
    handle.refresh()

    const again = host.querySelector<HTMLElement>('.scroll-pane')!
    expect(again).not.toBe(pane)
    expect(again.scrollTop).toBe(200 * 24)
  })
})

describe('renderSelectedParams for pars from a tab or a dot', () => {
  it('ignores a cell answer whose names are not the selected pars, and groups by the parameter table', () => {
    linkApi.recentCellLink.mockReturnValue(answer({ pars: [direct('zz', 'Z')], parsTotal: 1 }))
    const { host } = render(makeStore({ pars: ['b1', 'a1', 'a2'], cells: [1234] }))

    expect(host.textContent).not.toContain('Parameters that set')
    expect(host.textContent).not.toContain('layer 3')
    expect(title(host)).toBe('Selected parameters · 3')
    expect(lines(host)).toEqual(['Picked in the table or a plot'])
    expect(groupRows(host).map((g) => g.dataset.group)).toEqual(['B', 'A'])
    expect(parRows(host).map((r) => r.dataset.selectedParameter)).toEqual(['b1', 'a1', 'a2'])
  })

  it('keeps a name the parameter table does not know, under its own heading', () => {
    const { host } = render(makeStore({ pars: ['a1', 'ghost'] }))

    expect(parRows(host).map((r) => r.dataset.selectedParameter)).toEqual(['a1', 'ghost'])
    expect(host.textContent).toContain('not in the parameter table')
  })

  it('shows the title and the hint, and no grid, when pars is empty', () => {
    const { host } = render(makeStore())

    expect(host.style.display).not.toBe('none')
    expect(title(host)).toBe('Selected parameters')
    expect(lines(host)).toEqual(['ℹ Click a cell on the map to list the parameters that set it, or pick rows in the table below.'])
    expect(host.querySelector('[role="grid"]')).toBeNull()
  })

  it('puts the count in a tabular-nums span', () => {
    const { host } = render(makeStore({ pars: ['a1', 'a2'] }))

    const count = host.querySelector('.params-selected-title .tabular-nums')!
    expect(count.textContent).toBe('· 2')
  })

  it('follows a later pars change on refresh', () => {
    const store = makeStore({ pars: ['a1'] })
    const { host, handle } = render(store)
    store.set({ pars: new Set(['b1']) }, 'map')
    handle.refresh()

    expect(parRows(host).map((r) => r.dataset.selectedParameter)).toEqual(['b1'])
  })
})

describe('renderSelectedParams clicks and text', () => {
  it('hands a row click and its event to onPick, and a group heading click to nobody', () => {
    const store = makeStore({ pars: ['a1', 'a2'] })
    const { host, onPick } = render(store)

    const row = parRows(host)[1]
    const event = new MouseEvent('click', { bubbles: true, altKey: true })
    row.dispatchEvent(event)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toBe('a2')
    expect(onPick.mock.calls[0][1]).toBe(event)

    groupRows(host)[0].click()
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(store.get().parGroups.size).toBe(0)
  })

  it('treats Enter on a row as a click', () => {
    const { host, onPick } = render(makeStore({ pars: ['a1'] }))

    parRows(host)[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    expect(onPick).toHaveBeenCalledTimes(1)
    expect((onPick.mock.calls[0][1] as KeyboardEvent).shiftKey).toBe(true)
  })

  it('writes names and notes as text with the full name in the title, never as markup', () => {
    const nasty = '<img src=x onerror=alert(1)>'
    const found = answer({ pars: [direct(nasty, nasty)], parsTotal: 1, parNotes: [nasty] })
    linkApi.recentCellLink.mockReturnValue(found)
    const { host } = render(makeStore({ pars: [nasty], cells: [1234] }))

    expect(host.querySelector('img')).toBeNull()
    const nameCell = parRows(host)[0].firstElementChild as HTMLElement
    expect(nameCell.textContent).toBe(nasty)
    expect(nameCell.title).toBe(nasty)
  })

  it('builds rows with role="row" so the section layout rules apply', () => {
    const { host } = render(makeStore({ pars: ['a1'] }))

    expect(parRows(host).every((r) => r.getAttribute('role') === 'row')).toBe(true)
    expect(groupRows(host).every((r) => r.getAttribute('role') === 'row')).toBe(true)
    expect(host.querySelector('[role="grid"]')).not.toBeNull()
  })

  it('keeps the heading, count, group, name and factor parts apart under the real stylesheet', () => {
    loadRealStylesheet()
    const found = answer({
      pars: [pilot('pp_k3', 'pp_k', [{ cell: 1234, weight: 0.42 }]), direct('hk1', 'hk')],
      parsTotal: 3,
      parNotes: ['group pp_k: k.bin is a binary factor file'],
    })
    linkApi.recentCellLink.mockReturnValue(found)
    const { host } = render(makeStore({ pars: ['pp_k3', 'hk1'], cells: [1234] }))

    expectNoRunTogetherText(host, 'params-selected.ts renderSelectedParams')
    document.head.textContent = ''
  })

  it('draws nothing on a scroll while hidden', () => {
    let hidden = false
    const pars = Array.from({ length: 300 }, (_, i) => `p${i}`)
    const { host } = render(makeStore({ pars }), { pargpOf: () => 'G', isHidden: () => hidden })
    const before = parRows(host).map((r) => r.dataset.selectedParameter)

    hidden = true
    const pane = host.querySelector<HTMLElement>('.scroll-pane')!
    pane.scrollTop = 250 * 24
    pane.dispatchEvent(new Event('scroll'))
    expect(parRows(host).map((r) => r.dataset.selectedParameter)).toEqual(before)
  })
})
