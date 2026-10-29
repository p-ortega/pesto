import { describe, expect, it } from 'vitest'
import {
  missingValueLine,
  offScreenCount,
  offScreenLine,
  parameterLines,
  groupSitesById,
  parameterRingCells,
  pickedSiteRings,
  selectedDotIndices,
  whereLines,
  type GroupSitesRead,
  type ParLinkAnswer,
  type SitesWhereAnswer,
} from '../src/data/link-follow'
import type { ParLink, SiteWhere } from '../src/data/link-targets'
import type { ObsSiteRow } from '../src/data/obs'
import { OUTLINE_MAX_CELLS } from '../src/gl/outline'

describe('selectedDotIndices', () => {
  const siteOf = (row: number): number => 100 + row

  it('gives the dots whose site is selected, ascending', () => {
    const rows = Int32Array.from([4, 0, 2, 7])
    expect(selectedDotIndices(rows, siteOf, new Set([107, 100]))).toEqual([1, 3])
  })

  it('gives nothing for an empty selection', () => {
    expect(selectedDotIndices(Int32Array.from([0, 1]), siteOf, new Set())).toEqual([])
  })

  it('matches names as written, and never a dot with no name', () => {
    const names: Array<string | null> = ['pa', null, 'PB', 'pb']
    expect(selectedDotIndices([0, 1, 2, 3], (row) => names[row], new Set(['pb', 'pa']))).toEqual([0, 3])
  })

  it('marks every dot of a stacked site', () => {
    expect(selectedDotIndices([5, 5, 6], siteOf, new Set([105]))).toEqual([0, 1])
  })
})

function par(over: Partial<ParLink> & { parnme: string }): ParLink {
  return { pargp: 'g', kind: 'cell', layer: 0, cell: 0, cells: [0], nCells: 1, cellsCapped: false, reason: null, ...over }
}

function parAnswer(pars: ParLink[], unknown: string[] = [], notAsked = 0, extra: Partial<ParLinkAnswer> = {}): ParLinkAnswer {
  return { ok: true, pars, unknown, notAsked, reason: null, notes: [], ...extra }
}

describe('the reason and notes the server gives for a parameter lookup', () => {
  it("says why no name could be looked up instead of calling them missing from the table", () => {
    const reason = 'no parameter placement was ingested for this run'
    const rings = parameterRingCells(parAnswer([], ['hk1', 'hk2'], 0, { reason }), 0)
    expect(parameterLines(rings)).toEqual([`2 selected parameters are not looked up: ${reason}`])
  })

  it("keeps the server's notes as lines", () => {
    const note = 'pp_factors could not be read: gone, so pilot points are listed as plain parameters'
    const rings = parameterRingCells(parAnswer([par({ parnme: 'a' })], [], 0, { notes: [note] }), 0)
    expect(parameterLines(rings)).toEqual([note])
  })
})

describe('parameterRingCells', () => {
  it('rings the union of cells on the drawn layer, ascending', () => {
    const rings = parameterRingCells(
      parAnswer([
        par({ parnme: 'p8', cell: 5, cells: [5] }),
        par({ parnme: 'pp1', kind: 'pilot_point', cell: -1, cells: [3, 4, 5], nCells: 3 }),
      ]),
      0,
    )
    expect(rings.cells).toEqual([3, 4, 5])
    expect(parameterLines(rings)).toEqual([])
  })

  it('rings nothing for a pilot point on another layer and says which layer', () => {
    const rings = parameterRingCells(parAnswer([par({ parnme: 'pp2', kind: 'pilot_point', layer: 2, cells: [1, 2], nCells: 2 })]), 0)
    expect(rings.cells).toEqual([])
    expect(rings.otherLayer).toEqual([{ layer: 2, count: 1 }])
    expect(parameterLines(rings)).toEqual(['1 selected parameter is on layer 2'])
  })

  it('counts a parameter with no cell by the reason the server gave', () => {
    const reason = 'no cell is recorded for this parameter: rule unmapped'
    const rings = parameterRingCells(parAnswer([par({ parnme: 'u1', kind: 'unplaced', layer: -1, cell: -1, cells: [], nCells: 0, reason })]), 0)
    expect(rings.noCell).toEqual([{ reason, count: 1 }])
    expect(parameterLines(rings)).toEqual([`1 selected parameter has no cell: ${reason}`])
  })

  it('outlines at most the outline cap and counts the cells left out', () => {
    const many = Array.from({ length: OUTLINE_MAX_CELLS + 7 }, (_, i) => i)
    const rings = parameterRingCells(parAnswer([par({ parnme: 'big', kind: 'pilot_point', cells: many, nCells: many.length })]), 0)
    expect(rings.cells.length).toBe(OUTLINE_MAX_CELLS)
    expect(rings.capped).toBe(7)
    expect(parameterLines(rings)).toEqual(['7 cells of the selected parameters are not outlined: the outline stops at 20,000 cells'])
  })

  it("counts a pilot point's reach the server cut short, names it did not know, and names never asked", () => {
    const rings = parameterRingCells(
      parAnswer([par({ parnme: 'pp', kind: 'pilot_point', cells: [1, 2], nCells: 5, cellsCapped: true })], ['ghost', 'gone'], 3),
      0,
    )
    expect(rings.reachCapped).toBe(3)
    expect(parameterLines(rings)).toEqual([
      "3 cells of the selected parameters are not outlined: the server lists a pilot point's reach only up to its cap",
      "2 selected parameters are not in this run's parameter table",
      '3 selected parameters are not looked up: only the first 50 are',
    ])
  })

  it("says a pilot point is outlined by its own cell only when the server gave a reason for it", () => {
    const reason = 'no run directory is open, so the factor file cannot be read'
    const rings = parameterRingCells(parAnswer([par({ parnme: 'pp', kind: 'pilot_point', cell: 7, cells: [7], nCells: 1, reason })]), 0)
    expect(rings.cells).toEqual([7])
    expect(parameterLines(rings)).toEqual([`1 selected parameter has only its own cell outlined: ${reason}`])
  })

  it("does not outline a pilot point's own cell when the server listed no cell and gave a reason", () => {
    const reason = 'no cell has a non-zero factor from this pilot point in pp.fac'
    const rings = parameterRingCells(parAnswer([par({ parnme: 'pp', kind: 'pilot_point', cell: 7, cells: [], nCells: 0, reason })]), 0)
    expect(rings.cells).toEqual([])
    expect(parameterLines(rings)).toEqual([`1 selected parameter has no cell: ${reason}`])
  })

  it('says so for a parameter of unknown layer', () => {
    const rings = parameterRingCells(parAnswer([par({ parnme: 'q', layer: -1 })]), 0)
    expect(parameterLines(rings)).toEqual(['1 selected parameter has an unknown layer'])
  })
})

function site(over: Partial<SiteWhere> & { siteId: number }): SiteWhere {
  return { site: `s${over.siteId}`, group: 'heads', layer: 0, cell: 0, placed: true, hasValue: true, ...over }
}

function sitesAnswer(sites: SiteWhere[], extra: Partial<SitesWhereAnswer> = {}): SitesWhereAnswer {
  return { ok: true, iteration: 2, sites, unknown: [], valueRule: 'a measured value', valueReason: null, notAsked: 0, reason: null, notes: [], ...extra }
}

const OBS = { group: 'heads', layer: 0, allLayers: false }

describe('the reason and notes the server gives for a site lookup', () => {
  it('says why no id could be looked up instead of calling them missing from the index', () => {
    const reason = 'no observation placement was ingested for this run'
    expect(whereLines(sitesAnswer([], { unknown: [1, 2], reason }), OBS)).toEqual([`2 selected sites are not looked up: ${reason}`])
  })

  it("keeps the server's notes", () => {
    const note = 'site x has no observation group, so its group is sent as empty text'
    const answer = sitesAnswer([site({ siteId: 1, group: '' })], { notes: [note] })
    expect(whereLines(answer, OBS)).toEqual(['1 selected site is in another group (shown: heads)', note])
  })
})

describe('whereLines', () => {
  it('gives one line per reason a selected site is not drawn', () => {
    const answer = sitesAnswer([
      site({ siteId: 1, layer: 4 }),
      site({ siteId: 2, group: 'conc' }),
      site({ siteId: 3, placed: false, cell: -1, layer: -1 }),
      site({ siteId: 4 }),
    ])
    expect(whereLines(answer, OBS)).toEqual([
      '1 selected site is on layer 4',
      '1 selected site is in another group (shown: heads)',
      '1 selected site is not placed',
    ])
  })

  it("names ids the server did not know and ids never asked", () => {
    expect(whereLines(sitesAnswer([], { unknown: [77], notAsked: 5 }), OBS)).toEqual([
      "1 selected site is not in this run's index",
      '5 selected sites are not checked: only the first 200 are',
    ])
  })

  it('says to turn on all layers for a site of unknown layer, and nothing once they are on', () => {
    const answer = sitesAnswer([site({ siteId: 1, layer: -1 }), site({ siteId: 2, layer: 3 })])
    expect(whereLines(answer, OBS)).toEqual([
      '1 selected site is on layer 3',
      '1 selected site has an unknown layer; turn on all layers to see it',
    ])
    expect(whereLines(answer, { ...OBS, allLayers: true })).toEqual([])
  })

  it('counts sites on each other layer separately, plural spelled out', () => {
    const answer = sitesAnswer([site({ siteId: 1, layer: 4 }), site({ siteId: 2, layer: 4 }), site({ siteId: 3, layer: 1 })])
    expect(whereLines(answer, OBS)).toEqual(['1 selected site is on layer 1', '2 selected sites are on layer 4'])
  })
})

describe('offScreenCount', () => {
  const xy = new Float32Array([0, 0, 5, 5, -1, 2, 3, 9])

  it('counts the given dots outside the box, edges inside', () => {
    expect(offScreenCount(xy, [0, 1, 2, 3], [0, 0, 5, 5])).toBe(2)
    expect(offScreenCount(xy, [0, 1], [0, 0, 5, 5])).toBe(0)
    expect(offScreenLine(2)).toBe('2 selected sites are off screen')
    expect(offScreenLine(1)).toBe('1 selected site is off screen')
    expect(offScreenLine(0)).toBeNull()
  })
})

describe('missingValueLine', () => {
  it('counts the selected sites with no valid observation in the iteration', () => {
    const sites = Array.from({ length: 12 }, (_, i) => site({ siteId: i, hasValue: i >= 2 }))
    expect(missingValueLine(sitesAnswer(sites), 12)).toEqual({
      title: '2 of 12 selected sites have no valid observation in iteration 2; the selection is kept',
      detail: 'a measured value.',
    })
  })

  it('says one site has none in the singular', () => {
    const line = missingValueLine(sitesAnswer([site({ siteId: 1, hasValue: false }), site({ siteId: 2 })]), 2)
    expect(line?.title).toBe('1 of 2 selected sites has no valid observation in iteration 2; the selection is kept')
  })

  it('says the sites cannot be checked, with the reason, when the iteration has no statistics', () => {
    const answer = sitesAnswer([site({ siteId: 1, hasValue: null })], { iteration: 3, valueReason: 'obs_agg/3 could not be read.' })
    expect(missingValueLine(answer, 1)).toEqual({
      title: 'Selected sites cannot be checked in iteration 3',
      detail: 'obs_agg/3 could not be read.',
    })
  })

  it('gives nothing when every selected site has a value, and says how many were not checked', () => {
    expect(missingValueLine(sitesAnswer([site({ siteId: 1 })]), 1)).toBeNull()
    const line = missingValueLine(sitesAnswer([site({ siteId: 1, hasValue: false })], { notAsked: 4 }), 205)
    expect(line?.detail).toBe('a measured value. Only the first 200 selected sites were checked.')
  })
})

function siteRow(over: Partial<ObsSiteRow> & { siteId: number }): ObsSiteRow {
  return { site: `s${over.siteId}`, nObs: 1, x: 0, y: 0, xySource: 'own', layer: 0, cell: 0, rule: 'own xy', note: null, ...over }
}

const held = (rows: ObsSiteRow[]): GroupSitesRead => groupSitesById(rows)

describe('pickedSiteRings', () => {
  const ON_0 = { layer: 0, allLayers: false }

  it('rings each picked site at its own row of its group, matched by id, never by row position', () => {
    // The table lists 20 before 10; the answer asks 10 first.
    const heads = held([siteRow({ siteId: 20, x: 5, y: 6 }), siteRow({ siteId: 10, x: 1, y: 2 })])
    const rings = pickedSiteRings(sitesAnswer([site({ siteId: 10 }), site({ siteId: 20 })]), () => heads, ON_0)
    expect(rings.siteIds).toEqual([10, 20])
    expect(Array.from(rings.xy)).toEqual([1, 2, 5, 6])
    expect(rings.lines).toEqual([])
  })

  it('reads each site from its own group', () => {
    const tables: Record<string, GroupSitesRead> = {
      heads: held([siteRow({ siteId: 1, x: 1, y: 1 })]),
      conc: held([siteRow({ siteId: 1, x: 9, y: 9 }), siteRow({ siteId: 2, x: 3, y: 4 })]),
    }
    const rings = pickedSiteRings(sitesAnswer([site({ siteId: 2, group: 'conc' })]), (g) => tables[g], ON_0)
    expect(Array.from(rings.xy)).toEqual([3, 4])
  })

  it('lists a site with no position with its reason, and draws no ring for it', () => {
    const heads = held([siteRow({ siteId: 1, xySource: 'none', x: Number.NaN, y: Number.NaN, note: 'no x/y and no cell' })])
    const rings = pickedSiteRings(sitesAnswer([site({ siteId: 1 })]), () => heads, ON_0)
    expect(rings.siteIds).toEqual([])
    expect(rings.lines).toEqual(['1 selected site has no position, not drawn: no x/y and no cell'])
  })

  it('draws a site on another layer or of unknown layer only while all layers is on, as the obs dots do', () => {
    const heads = held([siteRow({ siteId: 1, layer: 2 }), siteRow({ siteId: 2, layer: 2 }), siteRow({ siteId: 3, layer: -1 }), siteRow({ siteId: 4 })])
    const answer = sitesAnswer([1, 2, 3, 4].map((id) => site({ siteId: id })))
    const one = pickedSiteRings(answer, () => heads, ON_0)
    expect(one.siteIds).toEqual([4])
    expect(one.lines).toEqual(['2 selected sites are on layer 2, not drawn on layer 0', '1 selected site has an unknown layer, not drawn on layer 0'])
    const all = pickedSiteRings(answer, () => heads, { layer: 0, allLayers: true })
    expect(all.siteIds).toEqual([1, 2, 3, 4])
    expect(all.lines).toEqual([])
  })

  it('names a site missing from its table, an id on two rows, a table that failed, and one still loading', () => {
    const tables: Record<string, GroupSitesRead> = {
      heads: held([siteRow({ siteId: 1 }), siteRow({ siteId: 2 }), siteRow({ siteId: 2, x: 7 })]),
      conc: { state: 'failed', reason: 'obs_cell: the file is missing' },
      flow: { state: 'loading' },
    }
    const answer = sitesAnswer(
      [site({ siteId: 9 }), site({ siteId: 2 }), site({ siteId: 3, group: 'conc' }), site({ siteId: 4, group: 'flow' })],
      { unknown: [77] },
    )
    const rings = pickedSiteRings(answer, (g) => tables[g], ON_0)
    expect(rings.siteIds).toEqual([])
    expect(rings.lines).toEqual([
      '1 selected site is not drawn: it is not in the sites table of group heads',
      '1 selected site is not drawn: its id is on more than one row of the sites table of group heads',
      '1 selected site is not drawn: the positions of group conc could not be read: obs_cell: the file is missing',
      '1 selected site is not drawn yet: reading where it is',
      "1 selected site is not in this run's index",
    ])
  })
})
