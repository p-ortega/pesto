// The two map overlays' answers: parameters at their bounds and sites in prior-data conflict.
// An answer with available false is still an answer: its reason and artifact are kept so the
// toggle can say why it is off. A missing field is a refusal naming the field and the route.

import { apiGet, type FetchOptions } from './client'
import {
  field,
  flag,
  guarded,
  list,
  objectOf,
  Refusal,
  text,
  textOrNull,
  texts,
  wholeNumber,
  wholeNumberOrNull,
  type Json,
} from './json-fields'
import type { Refused } from './obs'
import { activeRunId, runUrl } from './run'

// ---- parameters at their bounds ----

export interface AtBoundsGroup {
  group: string
  nPar: number
  nCounted: number
  nAtBounds: number
  /** Parameters that could not be counted, by why (fixed, tied, ...). */
  nExcluded: Record<string, number>
}

export interface AtBoundsAnswer {
  available: boolean
  /** Why the overlay is off; null when it is available. */
  reason: string | null
  artifact: string
  iteration: number
  firstIteration: number | null
  lastIteration: number | null
  rule: string
  caveat: string
  groups: AtBoundsGroup[]
  /** Every at-bounds parameter of the asked group; null when no group was asked. */
  names: string[] | null
}

export type AtBoundsResult = { ok: true; answer: AtBoundsAnswer } | Refused

function readCounts(o: Json, key: string, where: string): Record<string, number> {
  const counts = objectOf(field(o, key, where), `${where}'s ${key}`)
  for (const [kind, value] of Object.entries(counts)) {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new Refusal(`the ${where}'s ${key} count for '${kind}' is not a whole number`)
  }
  return counts as Record<string, number>
}

function readAtBoundsGroup(value: unknown, where: string): AtBoundsGroup {
  const o = objectOf(value, where)
  return {
    group: text(o, 'group', where),
    nPar: wholeNumber(o, 'n_par', where),
    nCounted: wholeNumber(o, 'n_counted', where),
    nAtBounds: wholeNumber(o, 'n_at_bounds', where),
    nExcluded: readCounts(o, 'n_excluded', where),
  }
}

export async function fetchAtBounds(iteration: number, group?: string, opts?: FetchOptions): Promise<AtBoundsResult> {
  return guarded('par_change', async () => {
    const payload = await apiGet(runUrl(activeRunId(), '/api/run/par/at_bounds', { iteration, group }), opts)
    const where = '/par/at_bounds answer'
    const o = objectOf(payload, where)
    const names = field(o, 'names', where)
    const answer: AtBoundsAnswer = {
      available: flag(o, 'available', where),
      reason: textOrNull(o, 'reason', where),
      artifact: text(o, 'artifact', where),
      iteration: wholeNumber(o, 'iteration', where),
      firstIteration: wholeNumberOrNull(o, 'first_iteration', where),
      lastIteration: wholeNumberOrNull(o, 'last_iteration', where),
      rule: text(o, 'rule', where),
      caveat: text(o, 'caveat', where),
      groups: list(o, 'groups', where).map((row, i) => readAtBoundsGroup(row, `${where}'s groups[${i}]`)),
      names: names === null ? null : texts(o, 'names', where),
    }
    return { ok: true as const, answer }
  })
}

// ---- sites in prior-data conflict ----

/** Parallel columns in site_id order, the shape data/hatch-mask.ts siteCells takes. */
export interface PdcSiteColumns {
  id: Int32Array
  /** -1 when the site is unplaced. */
  cell: Int32Array
  /** -1 when the layer is unknown. */
  layer: Int32Array
  /** Position in groups. */
  groupIndex: Int32Array
  nObs: Int32Array
}

export interface PdcSitesAnswer {
  available: boolean
  reason: string | null
  artifact: string
  iteration: number
  source: 'file' | 'computed' | null
  sourceFile: string | null
  weightsSource: string | null
  rule: string | null
  /** Counts are null only on an answer with available false that carries none. */
  nObs: number | null
  nSites: number | null
  nUnmatched: number | null
  /** Conflicted observations left out because a simulated value was a placeholder or not a number. */
  nLeftOut: number | null
  byGroup: { group: string; nObs: number; nSites: number }[]
  sites: PdcSiteColumns
  groups: string[]
  notes: string[]
}

export type PdcSitesResult = { ok: true; answer: PdcSitesAnswer } | Refused

const SITE_COLUMNS = [
  ['id', 'id'],
  ['cell', 'cell'],
  ['layer', 'layer'],
  ['group_index', 'groupIndex'],
  ['n_obs', 'nObs'],
] as const

const INT32_MIN = -(2 ** 31)
const INT32_MAX = 2 ** 31 - 1

// Int32Array would wrap a value out of range without a word, so such a value is refused.
function int32Column(o: Json, key: string, where: string): Int32Array {
  const values = list(o, key, where)
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
      throw new Refusal(`the ${where}'s ${key} holds something other than 32-bit whole numbers`)
    }
  }
  return Int32Array.from(values as number[])
}

function readSiteColumns(o: Json, where: string, nGroups: number): PdcSiteColumns {
  const sites = objectOf(field(o, 'sites', where), `${where}'s sites`)
  const inner = `${where}'s sites`
  const columns = Object.fromEntries(SITE_COLUMNS.map(([key, name]) => [name, int32Column(sites, key, inner)])) as unknown as PdcSiteColumns
  const length = columns.id.length
  for (const [key, name] of SITE_COLUMNS) {
    if (columns[name].length !== length) {
      throw new Refusal(`the ${inner} lists are not the same length: id has ${length}, ${key} has ${columns[name].length}`)
    }
  }
  for (let i = 0; i < length; i++) {
    const g = columns.groupIndex[i]
    if (g < 0 || g >= nGroups) throw new Refusal(`the ${inner}'s group_index ${g} in entry ${i + 1} names no group`)
  }
  return columns
}

function readByGroup(value: unknown, where: string): { group: string; nObs: number; nSites: number } {
  const o = objectOf(value, where)
  return { group: text(o, 'group', where), nObs: wholeNumber(o, 'n_obs', where), nSites: wholeNumber(o, 'n_sites', where) }
}

const PDC_SOURCES: readonly (string | null)[] = ['file', 'computed', null]

export async function fetchPdcSites(iteration: number, opts?: FetchOptions): Promise<PdcSitesResult> {
  const artifact = `pdc/${iteration}`
  return guarded(artifact, async () => {
    const payload = await apiGet(runUrl(activeRunId(), '/api/run/obs/pdc', { iteration }), opts)
    const where = '/obs/pdc answer'
    const o = objectOf(payload, where)
    const available = flag(o, 'available', where)
    // An answer that is off may carry no counts; one that is on must carry them all.
    const count = available ? wholeNumber : wholeNumberOrNull
    const source = field(o, 'source', where)
    if (!PDC_SOURCES.includes(source as string | null)) throw new Refusal(`the ${where}'s source is not file, computed or null`)
    const groups = texts(o, 'groups', where)
    const answer: PdcSitesAnswer = {
      available,
      reason: textOrNull(o, 'reason', where),
      artifact: text(o, 'artifact', where),
      iteration: wholeNumber(o, 'iteration', where),
      source: source as PdcSitesAnswer['source'],
      sourceFile: textOrNull(o, 'source_file', where),
      weightsSource: textOrNull(o, 'weights_source', where),
      rule: textOrNull(o, 'rule', where),
      nObs: count(o, 'n_obs', where),
      nSites: count(o, 'n_sites', where),
      nUnmatched: count(o, 'n_unmatched', where),
      nLeftOut: count(o, 'n_left_out', where),
      byGroup: list(o, 'by_group', where).map((row, i) => readByGroup(row, `${where}'s by_group[${i}]`)),
      sites: readSiteColumns(o, where, groups.length),
      groups,
      notes: texts(o, 'notes', where),
    }
    return { ok: true as const, answer }
  })
}
