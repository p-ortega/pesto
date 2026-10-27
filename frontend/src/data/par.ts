// The parameter view's two JSON routes: the per-group summary and the
// placement notes behind each group's layer. A route that answers "that
// artifact is not there" is a typed result with its reason, not an
// exception, so the panel can say what is missing instead of going blank.

import { apiGet, ApiError, type FetchOptions } from './client'
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
  groups: ParGroupRow[]
  notes: string[]
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
