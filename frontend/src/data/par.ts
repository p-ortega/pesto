// The parameter view's routes: the per-group summary, the placement notes behind
// each group's layer, one group's histograms, the per-parameter change table and
// one parameter's own distribution. A route that answers "that
// artifact is not there" is a typed result with its reason, not an
// exception, so the panel can say what is missing instead of going blank.

import { tableFromIPC } from 'apache-arrow'
import { apiGet, apiGetBytes, ApiError, type FetchOptions } from './client'
import { activeRunId, runUrl } from './run'

/** A figure the server read from somewhere, with where it came from. */
export interface Sourced<T> {
  value: T | null
  source: string
  note: string | null
}

export interface PestoChange {
  mean_change_pct: number | null
  sd_change_pct: number | null
  mean_shift_sd_median: number | null
  n_used: number
  n_refused_near_zero: number
  n_no_spread: number
  /** Names the figure as pesto's own and says what it was taken over. */
  label: string
}

export interface PestppChange {
  mean_change: number | null
  std_change: number | null
  num_at_near_lbound: number | null
  num_at_near_ubound: number | null
  /** Names the pestpp file the figures came from; null when none was read. */
  source: string | null
  /** Why a figure is missing, or what was adjusted to join it. */
  note: string | null
  /** Only present when the pcs.csv and the run record disagree: the record's own figures. */
  record?: {
    source: string
    mean_change: number | null
    std_change: number | null
  }
}

/** The group's sigma ratio: shown, shown with a warning, or refused with the reason to show instead. */
export interface SigmaRatio {
  state: 'shown' | 'unchecked' | 'refused'
  median: number | null
  p10: number | null
  p90: number | null
  n_used: number | null
  n_no_spread: number | null
  /** The warning when unchecked, the sentence shown instead of the number when refused. */
  reason: string | null
}

export interface ReinflationFacts {
  verdict: 'found' | 'none' | 'unchecked'
  first: number
  last: number
  checked: string[]
  notes: string[]
}

export interface ParGroupRow {
  group: string
  n_par: number
  n_included: number
  excluded: {
    fixed: number
    tied: number
    nonpositive_log: number
    no_values: number
    unknown_transform: number
  }
  type: Sourced<string>
  layer: Sourced<number | 'several'>
  change: {
    pesto: PestoChange | null
    pestpp: PestppChange
    /** Why pesto has no figure for this group. */
    reason: string | null
  }
  sigma_ratio: SigmaRatio
  at_bounds_last: { near_lower: number | null; near_upper: number | null; n_counted: number }
  drill_down: { offered: boolean; reason: string | null }
  notes: string[]
}

export interface ParGroupsPayload {
  first_iteration: number
  last_iteration: number
  n_common: number
  single_iteration: boolean
  left_out: {
    count: number
    n_only_first: number
    n_only_last: number
    only_first: string[]
    only_last: string[]
    reason: string | null
  }
  reinflation?: ReinflationFacts
  groups: ParGroupRow[]
  notes: string[]
}

/** One iteration's histogram on the shared edges. */
export interface HistSeries {
  iteration: number
  n: number
  counts: number[]
  density: number[]
}

export interface ParHistPayload {
  group: string
  /** null when the group has no histogram; `refused` then says why. */
  space: 'log10' | 'native' | null
  edges: number[] | null
  first: HistSeries | null
  last: HistSeries | null
  n_common: number
  left_out: { count: number; reason: string | null }
  excluded: Record<string, number>
  refused: string | null
  notes: string[]
}

export interface ParValuesPayload {
  parameter: string
  group: string
  space: 'log10' | 'native'
  n_common: number
  left_out: { count: number; reason: string | null }
  edges: number[] | null
  first: (HistSeries & { mean: number | null; sd: number | null }) | null
  last: (HistSeries & { mean: number | null; sd: number | null }) | null
  /** Why this parameter has no distribution, when it has none. */
  refused: string | null
  notes: string[]
}

/** One parameter's row of the change table, read by column name. */
export interface ParChangeRow {
  parnme: string
  included: boolean
  excluded_reason: string | null
  mean_change_pct: number | null
  mean_change_refused: string | null
  sd_change_pct: number | null
  sd_change_refused: string | null
  mean_shift_sd: number | null
}

export interface PlacementGroup {
  group: string
  rule: string
  mapped: number
  total: number
  /** Every placement note that names this group. */
  notes: string[]
}

export interface PlacementPayload {
  summary: string
  groups: PlacementGroup[]
  /** Notes that name no group. */
  notes: string[]
}

export type Fetched<T> = { ok: true; payload: T } | { ok: false; artifact: string; reason: string }
export type ParGroupsResult = Fetched<ParGroupsPayload>
export type PlacementResult = Fetched<PlacementPayload>
export type ParHistResult = Fetched<ParHistPayload>
export type ParValuesResult = Fetched<ParValuesPayload>
export type ParChangeResult = Fetched<ParChangeRow[]>

// 404 means the artifact is missing, 409 that no run is open; both carry a reason worth showing.
function notThere(error: unknown, fallback: string): { ok: false; artifact: string; reason: string } | null {
  if (error instanceof ApiError && (error.problem.status === 404 || error.problem.status === 409)) {
    return { ok: false, artifact: error.problem.artifact ?? fallback, reason: error.problem.detail ?? error.problem.title }
  }
  return null
}

function isObjectWithList(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>)[key])
}

export async function fetchParGroups(opts?: FetchOptions): Promise<ParGroupsResult> {
  try {
    const payload = await apiGet(runUrl(activeRunId(), '/api/run/par/groups'), opts)
    if (!isObjectWithList(payload, 'groups')) {
      return { ok: false, artifact: 'par_groups', reason: 'the answer was not shaped like a group summary' }
    }
    return { ok: true, payload: payload as ParGroupsPayload }
  } catch (error) {
    const missing = notThere(error, 'par_groups')
    if (missing) return missing
    throw error
  }
}

/** One read shared by every caller. A refused or thrown answer is forgotten, so the next call asks again. */
export function shareGroupsRead(read: () => Promise<ParGroupsResult>): () => Promise<ParGroupsResult> {
  let pending: Promise<ParGroupsResult> | null = null
  return () => {
    if (pending === null) {
      const answer = read()
      pending = answer
      const forget = (): void => {
        if (pending === answer) pending = null
      }
      answer.then((result) => (result.ok ? undefined : forget()), forget)
    }
    return pending
  }
}

export async function fetchPlacement(opts?: FetchOptions): Promise<PlacementResult> {
  try {
    const payload = await apiGet(runUrl(activeRunId(), '/api/run/grid/placement'), opts)
    if (!isObjectWithList(payload, 'groups')) {
      return { ok: false, artifact: 'par_cell', reason: 'the answer was not shaped like a placement summary' }
    }
    return { ok: true, payload: payload as PlacementPayload }
  } catch (error) {
    const missing = notThere(error, 'par_cell')
    if (missing) return missing
    throw error
  }
}

export async function fetchParHist(group: string, opts?: FetchOptions): Promise<ParHistResult> {
  try {
    const payload = await apiGet(runUrl(activeRunId(), '/api/run/par/hist', { group }), opts)
    if (typeof payload !== 'object' || payload === null || !('group' in payload)) {
      return { ok: false, artifact: 'par_hist', reason: 'the answer was not shaped like a group histogram' }
    }
    return { ok: true, payload: payload as ParHistPayload }
  } catch (error) {
    const missing = notThere(error, 'par_hist')
    if (missing) return missing
    throw error
  }
}

export async function fetchParValues(parameter: string, opts?: FetchOptions): Promise<ParValuesResult> {
  try {
    const payload = await apiGet(runUrl(activeRunId(), '/api/run/par/values', { parameter }), opts)
    if (typeof payload !== 'object' || payload === null || !('parameter' in payload)) {
      return { ok: false, artifact: 'par_change', reason: 'the answer was not shaped like a parameter distribution' }
    }
    return { ok: true, payload: payload as ParValuesPayload }
  } catch (error) {
    const missing = notThere(error, 'par_change')
    if (missing) return missing
    throw error
  }
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

// Every column is read by its field name; the table's column order is not a contract.
function readChangeRows(buffer: ArrayBuffer): ParChangeRow[] {
  const table = tableFromIPC(new Uint8Array(buffer))
  const parnme = table.getChild('parnme')
  if (!parnme) throw new Error('the change table is missing parnme')
  const column = (name: string) => table.getChild(name)
  const included = column('included')
  const excludedReason = column('excluded_reason')
  const meanChange = column('mean_change_pct')
  const meanRefused = column('mean_change_refused')
  const sdChange = column('sd_change_pct')
  const sdRefused = column('sd_change_refused')
  const shift = column('mean_shift_sd')
  const rows: ParChangeRow[] = new Array(table.numRows)
  for (let i = 0; i < table.numRows; i++) {
    rows[i] = {
      parnme: String(parnme.get(i)),
      included: included === null ? true : Boolean(included.get(i)),
      excluded_reason: textOrNull(excludedReason?.get(i)),
      mean_change_pct: finiteOrNull(meanChange?.get(i)),
      mean_change_refused: textOrNull(meanRefused?.get(i)),
      sd_change_pct: finiteOrNull(sdChange?.get(i)),
      sd_change_refused: textOrNull(sdRefused?.get(i)),
      mean_shift_sd: finiteOrNull(shift?.get(i)),
    }
  }
  return rows
}

export async function fetchParChange(group: string, opts?: FetchOptions): Promise<ParChangeResult> {
  try {
    const { buffer } = await apiGetBytes(runUrl(activeRunId(), '/api/run/par/change', { group }), opts)
    return { ok: true, payload: readChangeRows(buffer) }
  } catch (error) {
    const missing = notThere(error, 'par_change')
    if (missing) return missing
    throw error
  }
}
