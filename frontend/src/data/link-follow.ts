// How the map follows the shared selection (LINK-02, D-08 to D-10, D-20): which drawn dots hold
// a selected id, which cells a picked parameter sets on the drawn layer, and the counts of
// selected items the map cannot draw, as plain sentences. No DOM here; the map view shows the
// sentences as text.

import { OUTLINE_MAX_CELLS } from '../gl/outline'
import { MAX_LINK_PARS, MAX_LINK_SITES, type ParLinkResult, type SitesWhereResult } from './link-targets'
import type { ObsSiteRow } from './obs'

export type ParLinkAnswer = Extract<ParLinkResult, { ok: true }>
export type SitesWhereAnswer = Extract<SitesWhereResult, { ok: true }>

/** The indices of drawn dots whose id is selected, ascending. A null id never matches. */
export function selectedDotIndices(
  rows: Int32Array | readonly number[],
  idOf: (row: number) => number | string | null,
  selected: ReadonlySet<number | string>,
): number[] {
  const out: number[] = []
  if (selected.size === 0) return out
  for (let i = 0; i < rows.length; i++) {
    const id = idOf(rows[i])
    if (id !== null && selected.has(id)) out.push(i)
  }
  return out
}

function selected(n: number, kind: 'site' | 'parameter', verb: 'is' | 'has'): string {
  const plural = verb === 'is' ? 'are' : 'have'
  return n === 1 ? `1 selected ${kind} ${verb}` : `${n} selected ${kind}s ${plural}`
}

function countedLayers(byLayer: Map<number, number>): Array<{ layer: number; count: number }> {
  return [...byLayer.entries()].sort((a, b) => a[0] - b[0]).map(([layer, count]) => ({ layer, count }))
}

export interface ParameterRings {
  /** The cells to outline on the drawn layer, ascending, at most OUTLINE_MAX_CELLS. */
  cells: number[]
  otherLayer: Array<{ layer: number; count: number }>
  unknownLayer: number
  /** Parameters that set no cell, counted by the reason the server gave. */
  noCell: Array<{ reason: string; count: number }>
  /** Cells past OUTLINE_MAX_CELLS, not outlined. */
  capped: number
  /** Parameters outlined by their own cell only, because the server could not give their reach, counted by its reason. */
  ownCellOnly: Array<{ reason: string; count: number }>
  /** Cells of a pilot point's reach the server did not list, so not outlined. */
  reachCapped: number
  unknown: number
  notAsked: number
  /** Why no parameter could be looked up at all (every unknown name is then this reason's); null otherwise. */
  lookupReason: string | null
  /** The server's side notes, as written. */
  notes: string[]
}

/** The union of the cells the answered parameters set on `layer`, and a count of every one left out. */
export function parameterRingCells(answer: ParLinkAnswer, layer: number): ParameterRings {
  const union = new Set<number>()
  const otherLayer = new Map<number, number>()
  const noCell = new Map<string, number>()
  const ownCellOnly = new Map<string, number>()
  let unknownLayer = 0
  let reachCapped = 0
  for (const par of answer.pars) {
    // The server's list is the answer; an empty list with a reason is not the point's own cell.
    const own = par.cells
    if (par.kind === 'unplaced' || own.length === 0) {
      const reason = par.reason ?? 'no reason was recorded'
      noCell.set(reason, (noCell.get(reason) ?? 0) + 1)
    } else if (par.layer < 0) {
      unknownLayer += 1
    } else if (par.layer !== layer) {
      otherLayer.set(par.layer, (otherLayer.get(par.layer) ?? 0) + 1)
    } else {
      for (const cell of own) union.add(cell)
      if (par.reason !== null) ownCellOnly.set(par.reason, (ownCellOnly.get(par.reason) ?? 0) + 1)
      if (par.cellsCapped) reachCapped += Math.max(0, par.nCells - par.cells.length)
    }
  }
  const all = [...union].sort((a, b) => a - b)
  const cells = all.length > OUTLINE_MAX_CELLS ? all.slice(0, OUTLINE_MAX_CELLS) : all
  return {
    cells,
    otherLayer: countedLayers(otherLayer),
    unknownLayer,
    noCell: [...noCell.entries()].map(([reason, count]) => ({ reason, count })),
    ownCellOnly: [...ownCellOnly.entries()].map(([reason, count]) => ({ reason, count })),
    capped: all.length - cells.length,
    reachCapped,
    unknown: answer.unknown.length,
    notAsked: answer.notAsked,
    lookupReason: answer.reason,
    notes: answer.notes,
  }
}

function cellsAre(n: number): string {
  return n === 1 ? '1 cell of the selected parameters is' : `${n} cells of the selected parameters are`
}

/** One sentence per reason a picked parameter is not, or not wholly, outlined on the drawn layer. */
export function parameterLines(rings: ParameterRings): string[] {
  const lines: string[] = []
  for (const { layer, count } of rings.otherLayer) lines.push(`${selected(count, 'parameter', 'is')} on layer ${layer}`)
  if (rings.unknownLayer > 0) lines.push(`${selected(rings.unknownLayer, 'parameter', 'has')} an unknown layer`)
  for (const { reason, count } of rings.noCell) lines.push(`${selected(count, 'parameter', 'has')} no cell: ${reason}`)
  for (const { reason, count } of rings.ownCellOnly) {
    lines.push(`${selected(count, 'parameter', 'has')} only ${count === 1 ? 'its' : 'their'} own cell outlined: ${reason}`)
  }
  if (rings.capped > 0) {
    lines.push(`${cellsAre(rings.capped)} not outlined: the outline stops at ${OUTLINE_MAX_CELLS.toLocaleString('en-US')} cells`)
  }
  if (rings.reachCapped > 0) {
    lines.push(`${cellsAre(rings.reachCapped)} not outlined: the server lists a pilot point's reach only up to its cap`)
  }
  if (rings.unknown > 0) {
    lines.push(
      rings.lookupReason !== null
        ? `${selected(rings.unknown, 'parameter', 'is')} not looked up: ${rings.lookupReason}`
        : `${selected(rings.unknown, 'parameter', 'is')} not in this run's parameter table`,
    )
  }
  if (rings.notAsked > 0) lines.push(`${selected(rings.notAsked, 'parameter', 'is')} not looked up: only the first ${MAX_LINK_PARS} are`)
  lines.push(...rings.notes)
  return lines
}

export interface DrawnSites {
  /** The coloured observation group; null while none is known, so no site counts as another group's. */
  group: string | null
  layer: number
  allLayers: boolean
}

function lookupLines(answer: SitesWhereAnswer): string[] {
  const lines: string[] = []
  if (answer.unknown.length > 0) {
    lines.push(
      answer.reason !== null
        ? `${selected(answer.unknown.length, 'site', 'is')} not looked up: ${answer.reason}`
        : `${selected(answer.unknown.length, 'site', 'is')} not in this run's index`,
    )
  }
  if (answer.notAsked > 0) lines.push(`${selected(answer.notAsked, 'site', 'is')} not checked: only the first ${MAX_LINK_SITES} are`)
  return [...lines, ...answer.notes]
}

/** One sentence per reason a selected site is not drawn as a dot while the map is coloured by observations (D-09). */
export function whereLines(answer: SitesWhereAnswer, drawn: DrawnSites): string[] {
  const otherLayer = new Map<number, number>()
  let otherGroup = 0
  let unknownLayer = 0
  let notPlaced = 0
  // The same order of checks the dots are drawn by: group, then place, then layer.
  for (const site of answer.sites) {
    if (drawn.group !== null && site.group !== drawn.group) otherGroup += 1
    else if (!site.placed) notPlaced += 1
    else if (drawn.allLayers) continue
    else if (site.layer < 0) unknownLayer += 1
    else if (site.layer !== drawn.layer) otherLayer.set(site.layer, (otherLayer.get(site.layer) ?? 0) + 1)
  }
  const lines: string[] = []
  for (const { layer, count } of countedLayers(otherLayer)) lines.push(`${selected(count, 'site', 'is')} on layer ${layer}`)
  if (otherGroup > 0) lines.push(`${selected(otherGroup, 'site', 'is')} in another group (shown: ${drawn.group})`)
  if (unknownLayer > 0) {
    lines.push(`${selected(unknownLayer, 'site', 'has')} an unknown layer; turn on all layers to see ${unknownLayer === 1 ? 'it' : 'them'}`)
  }
  if (notPlaced > 0) lines.push(`${selected(notPlaced, 'site', 'is')} not placed`)
  return [...lines, ...lookupLines(answer)]
}

/** A group's sites table by site id, or why it is not there yet or at all. */
export type GroupSitesRead =
  | { state: 'loading' }
  | { state: 'failed'; reason: string }
  | { state: 'done'; byId: ReadonlyMap<number, ObsSiteRow>; duplicated: ReadonlySet<number> }

/** A sites table by site id; an id on more than one row names no one row, so it is kept apart. */
export function groupSitesById(rows: readonly ObsSiteRow[]): GroupSitesRead {
  const byId = new Map<number, ObsSiteRow>()
  const duplicated = new Set<number>()
  for (const row of rows) {
    if (byId.has(row.siteId)) duplicated.add(row.siteId)
    byId.set(row.siteId, row)
  }
  for (const id of duplicated) byId.delete(id)
  return { state: 'done', byId, duplicated }
}

export interface PickedSiteRings {
  /** The ringed sites, in ring order. */
  siteIds: number[]
  /** The site rows behind the rings, in ring order, for the readout. */
  rows: Array<{ group: string; row: ObsSiteRow }>
  /** x, y of each ring, from the site's own row of its group's sites table. */
  xy: Float32Array
  lines: string[]
}

function countedText(byKey: Map<string, number>): Array<[string, number]> {
  return [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/** Picked sites ringed over a parameter field at the x, y of their own row, by site id. The obs dots'
 *  rule (dotsFor): no position is never drawn; another or unknown layer only while all layers is on. */
export function pickedSiteRings(
  answer: SitesWhereAnswer,
  groupSites: (group: string) => GroupSitesRead,
  drawn: { layer: number; allLayers: boolean },
): PickedSiteRings {
  const siteIds: number[] = []
  const rows: PickedSiteRings['rows'] = []
  const xy: number[] = []
  const add = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  const failed = new Map<string, number>()
  const notInTable = new Map<string, number>()
  const noPosition = new Map<string, number>()
  const otherLayer = new Map<number, number>()
  let loading = 0
  let unknownLayer = 0
  for (const site of answer.sites) {
    const read = groupSites(site.group)
    if (read.state === 'loading') {
      loading += 1
      continue
    }
    if (read.state === 'failed') {
      add(failed, `the positions of group ${site.group} could not be read: ${read.reason}`)
      continue
    }
    if (read.duplicated.has(site.siteId)) {
      add(failed, `its id is on more than one row of the sites table of group ${site.group}`)
      continue
    }
    const row = read.byId.get(site.siteId)
    if (row === undefined) {
      add(notInTable, site.group)
      continue
    }
    if (row.xySource === 'none' || !Number.isFinite(row.x) || !Number.isFinite(row.y)) {
      add(noPosition, row.note ?? 'no position was recorded for this site')
      continue
    }
    if (!drawn.allLayers) {
      if (row.layer < 0) {
        unknownLayer += 1
        continue
      }
      if (row.layer !== drawn.layer) {
        otherLayer.set(row.layer, (otherLayer.get(row.layer) ?? 0) + 1)
        continue
      }
    }
    siteIds.push(site.siteId)
    rows.push({ group: site.group, row })
    xy.push(row.x, row.y)
  }
  const lines: string[] = []
  for (const { layer, count } of countedLayers(otherLayer)) {
    lines.push(`${selected(count, 'site', 'is')} on layer ${layer}, not drawn on layer ${drawn.layer}`)
  }
  if (unknownLayer > 0) lines.push(`${selected(unknownLayer, 'site', 'has')} an unknown layer, not drawn on layer ${drawn.layer}`)
  for (const [reason, count] of countedText(noPosition)) lines.push(`${selected(count, 'site', 'has')} no position, not drawn: ${reason}`)
  for (const [group, count] of countedText(notInTable)) {
    lines.push(`${selected(count, 'site', 'is')} not drawn: it is not in the sites table of group ${group}`)
  }
  for (const [reason, count] of countedText(failed)) lines.push(`${selected(count, 'site', 'is')} not drawn: ${reason}`)
  if (loading > 0) lines.push(`${selected(loading, 'site', 'is')} not drawn yet: reading where ${loading === 1 ? 'it is' : 'they are'}`)
  return { siteIds, rows, xy: Float32Array.from(xy), lines: [...lines, ...lookupLines(answer)] }
}

/** How many of the given dots sit outside the world box [minX, minY, maxX, maxY]. */
export function offScreenCount(xy: Float32Array, indices: readonly number[], box: readonly [number, number, number, number]): number {
  const [minX, minY, maxX, maxY] = box
  let n = 0
  for (const i of indices) {
    const x = xy[2 * i]
    const y = xy[2 * i + 1]
    if (x < minX || x > maxX || y < minY || y > maxY) n += 1
  }
  return n
}

export function offScreenLine(count: number): string | null {
  return count === 0 ? null : `${selected(count, 'site', 'is')} off screen`
}

function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/** The D-20 line: how many selected sites have no valid observation in the shown iteration. */
export function missingValueLine(answer: SitesWhereAnswer, total: number): { title: string; detail: string } | null {
  const notAll = answer.notAsked > 0 ? ` Only the first ${MAX_LINK_SITES} selected sites were checked.` : ''
  if (answer.valueReason !== null) {
    return { title: `Selected sites cannot be checked in iteration ${answer.iteration}`, detail: `${sentence(answer.valueReason)}${notAll}` }
  }
  const missing = answer.sites.filter((site) => site.hasValue === false).length
  if (missing === 0) return null
  const verb = missing === 1 ? 'has' : 'have'
  const noun = total === 1 ? 'site' : 'sites'
  return {
    title: `${missing} of ${total} selected ${noun} ${verb} no valid observation in iteration ${answer.iteration}; the selection is kept`,
    detail: `${sentence(answer.valueRule)}${notAll}`,
  }
}
