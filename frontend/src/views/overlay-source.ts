// The data half of the map overlays (D-21 to D-29): it loads the at-bounds and conflict answers
// for the shown iteration, and turns them into one hatch mask, the dots to flag and the words for
// both toggles. It draws nothing and imports no view, so a view may use it.

import type { FetchOptions } from '../data/client'
import { buildHatchMask, parameterCells, siteCells } from '../data/hatch-mask'
import { LatestWins, isAbortError } from '../data/latest-wins'
import type { Refused } from '../data/obs'
import { fetchAtBounds, fetchPdcSites, type AtBoundsResult, type PdcSitesResult } from '../data/overlays'
import type { ParIdentity } from '../data/parmap'
import { fetchKey } from '../data/run'
import type { OverlayStatus } from '../ui/overlay-controls'

export type AtBoundsLoader = (iteration: number, group?: string, opts?: FetchOptions) => Promise<AtBoundsResult>
export type PdcLoader = (iteration: number, opts?: FetchOptions) => Promise<PdcSitesResult>

export interface OverlaySourceOptions {
  loadAtBounds?: AtBoundsLoader
  loadPdc?: PdcLoader
}

export interface OverlayInputs {
  nCells: number
  layer: number
  allLayers: boolean
  colourSource: 'par' | 'obs'
  /** The parameter group the map is coloured by. */
  parGroup: string | null
  joined: ReadonlyArray<ParIdentity | null>
  cellArray: Int32Array
  layerArray: Int32Array
  /** Block row of each drawn pilot-point dot; null when the dots are not pilot points. */
  pointRows: Int32Array | null
  /** The coloured observation group; null for every group. */
  obsGroup: string | null
  /** Site id of each drawn observation dot; null when the dots are not observation sites. */
  dotSiteIds: Int32Array | null
}

export interface OverlayBuild {
  /** One entry per cell, HATCH_AT_BOUNDS and HATCH_CONFLICT bits; null when nothing is hatched. */
  mask: Uint8Array | null
  atBoundsDots: Set<number>
  conflictDots: Set<number>
  atBounds: OverlayStatus
  conflict: OverlayStatus
}

export interface OverlaySource {
  load(iteration: number, parGroup: string | null): Promise<{ stale: true } | { stale: false }>
  build(inputs: OverlayInputs, enabled: { atBounds: boolean; conflict: boolean }): OverlayBuild
  /** Drops the held answers and any request still out. */
  cancel(): void
}

interface Held {
  key: string
  iteration: number
  group: string | null
  atBounds: AtBoundsResult
  pdc: PdcSitesResult
}

interface Part {
  status: OverlayStatus
  cells: number[]
  dots: Set<number>
}

const AT_BOUNDS_OFF_FOR_OBS = 'at-bounds hatching follows the parameter group the map is coloured by'

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// A loader that throws is turned into a refusal so its reason reaches the toggle.
async function settle<T>(artifact: string, read: () => Promise<T | Refused>): Promise<T | Refused> {
  try {
    return await read()
  } catch (error) {
    if (isAbortError(error)) throw error
    return { ok: false, artifact, reason: error instanceof Error ? error.message : String(error) }
  }
}

function inGrid(cells: number[], nCells: number): { cells: number[]; outside: number } {
  const kept = cells.filter((c) => Number.isInteger(c) && c >= 0 && c < nCells)
  return { cells: kept, outside: cells.length - kept.length }
}

function leftOutLine(parts: [number, string, string][]): string | null {
  const words = parts.filter(([n]) => n > 0).map(([n, one, many]) => plural(n, one, many))
  return words.length === 0 ? null : `not hatched: ${words.join(', ')}`
}

function off(reason: string): Part {
  return { status: { kind: 'off', reason }, cells: [], dots: new Set() }
}

function wrongIteration(asked: number, answered: number): string {
  return `the answer is for iteration ${answered}, not the shown iteration ${asked}`
}

function atBoundsPart(held: Held, inputs: OverlayInputs): Part {
  if (inputs.colourSource !== 'par') return off(AT_BOUNDS_OFF_FOR_OBS)
  if (inputs.parGroup === null) return off('no parameter group is coloured, so no parameter is at its bounds here')
  const result = held.atBounds
  if (!result.ok) return off(`${result.artifact}: ${result.reason}`)
  const answer = result.answer
  if (answer.iteration !== held.iteration) return off(wrongIteration(held.iteration, answer.iteration))
  if (!answer.available) {
    const where =
      answer.firstIteration !== null && answer.lastIteration !== null
        ? `near-bound counts exist for iterations ${answer.firstIteration} and ${answer.lastIteration} only`
        : `no near-bound counts for iteration ${held.iteration}`
    return off(answer.reason ?? where)
  }
  if (answer.names === null) return off(`the at-bounds answer names no parameter of group ${inputs.parGroup}`)

  const group = answer.groups.find((g) => g.group === inputs.parGroup)
  const count = group?.nAtBounds ?? answer.names.length
  const found = parameterCells(new Set(answer.names), inputs.joined, inputs.cellArray, inputs.layerArray, inputs.layer)
  const placed = inGrid(found.cells, inputs.nCells)
  const rows = new Set(found.rows)
  const dots = new Set<number>()
  if (inputs.pointRows !== null) {
    for (let i = 0; i < inputs.pointRows.length; i++) if (rows.has(inputs.pointRows[i])) dots.add(i)
  }

  const lines = [answer.rule, answer.caveat]
  const excluded = Object.entries(group?.nExcluded ?? {}).filter(([, n]) => n > 0)
  if (excluded.length > 0) lines.push(`left out of the count: ${excluded.map(([kind, n]) => `${n} ${kind}`).join(', ')}`)
  const leftOut = leftOutLine([
    [found.otherLayer, 'on another layer', 'on other layers'],
    [found.unplaced, 'not placed', 'not placed'],
    [found.unknown, 'not in the parameter table', 'not in the parameter table'],
    [placed.outside, 'outside the grid', 'outside the grid'],
  ])
  if (leftOut !== null) lines.push(leftOut)
  if (inputs.pointRows !== null) lines.push(`${plural(dots.size, 'pilot point', 'pilot points')} marked`)
  return {
    status: { kind: 'shown', label: `At bounds: ${plural(count, 'parameter', 'parameters')}`, title: lines.join('\n') },
    cells: placed.cells,
    dots,
  }
}

function noConflictReason(iteration: number, reason: string | null): string {
  const lead = `no prior-data conflict for iteration ${iteration}`
  if (reason === null) return lead
  return reason.startsWith('no prior-data conflict') ? reason : `${lead}: ${reason}`
}

const SOURCE_WORD = { computed: 'computed', file: 'from file' } as const

function conflictPart(held: Held, inputs: OverlayInputs): Part {
  const result = held.pdc
  if (!result.ok) return off(`${result.artifact}: ${result.reason}`)
  const answer = result.answer
  if (answer.iteration !== held.iteration) return off(wrongIteration(held.iteration, answer.iteration))
  if (!answer.available) return off(noConflictReason(held.iteration, answer.reason))

  const oneGroup = inputs.colourSource === 'obs' && inputs.obsGroup !== null ? inputs.obsGroup : null
  let nObs: number
  let nSites: number
  let groupIndex: number | null = null
  if (oneGroup !== null) {
    // A group absent from the answer has no conflicted site; -1 then leaves every site out by group.
    groupIndex = answer.groups.indexOf(oneGroup)
    const row = answer.byGroup.find((g) => g.group === oneGroup)
    nObs = row?.nObs ?? 0
    nSites = row?.nSites ?? 0
  } else {
    nObs = answer.nObs ?? answer.byGroup.reduce((sum, g) => sum + g.nObs, 0)
    nSites = answer.nSites ?? answer.byGroup.reduce((sum, g) => sum + g.nSites, 0)
  }
  const found = siteCells(answer.sites, { layer: inputs.layer, allLayers: inputs.allLayers, groupIndex })
  const placed = inGrid(found.cells, inputs.nCells)
  const ids = new Set(found.siteIds)
  const dots = new Set<number>()
  if (inputs.dotSiteIds !== null) {
    for (let i = 0; i < inputs.dotSiteIds.length; i++) if (ids.has(inputs.dotSiteIds[i])) dots.add(i)
  }

  const source = answer.source === null ? 'source not recorded' : SOURCE_WORD[answer.source]
  const lines: string[] = []
  if (answer.rule !== null) lines.push(answer.rule)
  lines.push(answer.sourceFile !== null ? `source: ${source}, ${answer.sourceFile}` : `source: ${source}`)
  if (answer.weightsSource !== null) lines.push(`weights: ${answer.weightsSource}`)
  lines.push(oneGroup !== null ? `group ${oneGroup}` : 'every observation group')
  const leftOut = leftOutLine([
    [found.leftOut.otherLayer, 'site on another layer', 'sites on other layers'],
    [found.leftOut.unknownLayer, 'site with an unknown layer, shown only under all layers', 'sites with an unknown layer, shown only under all layers'],
    [found.leftOut.otherGroup, 'site in another group', 'sites in other groups'],
    [found.leftOut.unplaced, 'site not placed', 'sites not placed'],
    [placed.outside, 'outside the grid', 'outside the grid'],
  ])
  if (leftOut !== null) lines.push(leftOut)
  const unmatched = answer.nUnmatched ?? 0
  if (unmatched > 0) lines.push(`${plural(unmatched, 'pdc row matches', 'pdc rows match')} no observation`)
  const leftOutObs = answer.nLeftOut ?? 0
  if (leftOutObs > 0) {
    lines.push(`${plural(leftOutObs, 'conflicted observation', 'conflicted observations')} left out: a simulated value was a placeholder or not a number`)
  }
  lines.push(...answer.notes)
  const text = `Prior-data conflict: ${plural(nObs, 'observation', 'observations')} at ${plural(nSites, 'site', 'sites')} · ${source}`
  return { status: { kind: 'shown', label: text, title: lines.join('\n') }, cells: placed.cells, dots }
}

function loadingBuild(): OverlayBuild {
  return { mask: null, atBoundsDots: new Set(), conflictDots: new Set(), atBounds: { kind: 'loading' }, conflict: { kind: 'loading' } }
}

export function createOverlaySource({ loadAtBounds = fetchAtBounds, loadPdc = fetchPdcSites }: OverlaySourceOptions = {}): OverlaySource {
  const slot = new LatestWins<{ atBounds: AtBoundsResult; pdc: PdcSitesResult }>()
  let held: Held | null = null
  let pending: { key: string; promise: Promise<{ stale: true } | { stale: false }> } | null = null

  return {
    load(iteration, parGroup) {
      const key = fetchKey(null, iteration, parGroup === null ? null : encodeURIComponent(parGroup))
      if (held !== null && held.key === key) return Promise.resolve({ stale: false as const })
      if (pending !== null && pending.key === key) return pending.promise
      // Cleared at once, so a build for the new iteration never shows the old one's numbers.
      held = null
      const promise = slot
        .run(key, (signal) =>
          Promise.all([
            settle('par_change', () => loadAtBounds(iteration, parGroup ?? undefined, { signal })),
            settle(`pdc/${iteration}`, () => loadPdc(iteration, { signal })),
          ]).then(([atBounds, pdc]) => ({ atBounds, pdc })),
        )
        .then((answer): { stale: true } | { stale: false } => {
          if (pending?.key === key) pending = null
          if (answer.stale) return { stale: true }
          held = { key, iteration, group: parGroup, ...answer.value }
          return { stale: false }
        })
      pending = { key, promise }
      return promise
    },

    build(inputs, enabled) {
      if (held === null) return loadingBuild()
      // The at-bounds answer is per group, so one for another group is not used.
      const atBounds =
        inputs.colourSource === 'par' && inputs.parGroup !== held.group
          ? { status: { kind: 'loading' } as OverlayStatus, cells: [], dots: new Set<number>() }
          : atBoundsPart(held, inputs)
      const conflict = conflictPart(held, inputs)
      const atCells = enabled.atBounds ? atBounds.cells : []
      const conflictCells = enabled.conflict ? conflict.cells : []
      const mask = atCells.length + conflictCells.length === 0 ? null : buildHatchMask(inputs.nCells, atCells, conflictCells).mask
      return {
        mask,
        atBoundsDots: enabled.atBounds ? atBounds.dots : new Set(),
        conflictDots: enabled.conflict ? conflict.dots : new Set(),
        atBounds: atBounds.status,
        conflict: conflict.status,
      }
    },

    cancel() {
      slot.cancel()
      held = null
      pending = null
    },
  }
}
