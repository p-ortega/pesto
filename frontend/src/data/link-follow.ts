// How the map follows the shared selection (LINK-02, D-08 to D-10, D-20): which drawn dots hold
// a selected id, which cells a picked parameter sets on the drawn layer, and the counts of
// selected items the map cannot draw, as plain sentences. No DOM here; the map view shows the
// sentences as text.

import { OUTLINE_MAX_CELLS } from '../gl/outline'
import { MAX_LINK_PARS, MAX_LINK_SITES, type ParLinkResult, type SitesWhereResult } from './link-targets'

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
  /** Cells of a pilot point's reach the server did not list, so not outlined. */
  reachCapped: number
  unknown: number
  notAsked: number
}

/** The union of the cells the answered parameters set on `layer`, and a count of every one left out. */
export function parameterRingCells(answer: ParLinkAnswer, layer: number): ParameterRings {
  const union = new Set<number>()
  const otherLayer = new Map<number, number>()
  const noCell = new Map<string, number>()
  let unknownLayer = 0
  let reachCapped = 0
  for (const par of answer.pars) {
    const own = par.cells.length > 0 ? par.cells : par.cell >= 0 ? [par.cell] : []
    if (par.kind === 'unplaced' || own.length === 0) {
      const reason = par.reason ?? 'no reason was recorded'
      noCell.set(reason, (noCell.get(reason) ?? 0) + 1)
    } else if (par.layer < 0) {
      unknownLayer += 1
    } else if (par.layer !== layer) {
      otherLayer.set(par.layer, (otherLayer.get(par.layer) ?? 0) + 1)
    } else {
      for (const cell of own) union.add(cell)
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
    capped: all.length - cells.length,
    reachCapped,
    unknown: answer.unknown.length,
    notAsked: answer.notAsked,
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
  if (rings.capped > 0) {
    lines.push(`${cellsAre(rings.capped)} not outlined: the outline stops at ${OUTLINE_MAX_CELLS.toLocaleString('en-US')} cells`)
  }
  if (rings.reachCapped > 0) {
    lines.push(`${cellsAre(rings.reachCapped)} not outlined: the server lists a pilot point's reach only up to its cap`)
  }
  if (rings.unknown > 0) lines.push(`${selected(rings.unknown, 'parameter', 'is')} not in this run's parameter table`)
  if (rings.notAsked > 0) lines.push(`${selected(rings.notAsked, 'parameter', 'is')} not looked up: only the first ${MAX_LINK_PARS} are`)
  return lines
}

export interface DrawnSites {
  colourSource: 'par' | 'obs'
  /** The coloured observation group; null while none is known, so no site counts as another group's. */
  group: string | null
  layer: number
  allLayers: boolean
}

/** One sentence per reason a selected site is not drawn as a dot, with counts (D-09, D-10). */
export function whereLines(answer: SitesWhereAnswer, drawn: DrawnSites): string[] {
  if (drawn.colourSource === 'par') {
    const total = answer.sites.length + answer.unknown.length + answer.notAsked
    return total === 0 ? [] : [`${selected(total, 'site', 'is')} not drawn: the map is coloured by parameters`]
  }
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
  if (answer.unknown.length > 0) lines.push(`${selected(answer.unknown.length, 'site', 'is')} not in this run's index`)
  if (answer.notAsked > 0) lines.push(`${selected(answer.notAsked, 'site', 'is')} not checked: only the first ${MAX_LINK_SITES} are`)
  return lines
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
