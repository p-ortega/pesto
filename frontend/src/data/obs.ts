// The observation view's routes. Every answer is read by field or column name, and a missing
// name is a refusal that says which one, never a default. A route that answers "that artifact
// is not there" is a typed result with its reason, so the panel can say what is missing.

import { tableFromIPC, type Table } from 'apache-arrow'
import { apiGet, apiGetBytes, ApiError, type FetchOptions } from './client'
import { activeRunId, runUrl } from './run'

export interface Refused {
  ok: false
  artifact: string
  reason: string
}

/** A malformed answer: carries the reason the panel shows. */
class Refusal extends Error {}

// 404 means the artifact is missing, 409 that no run is open or the group is too big; both carry a reason worth showing.
function notThere(error: unknown, fallback: string): Refused | null {
  if (error instanceof ApiError && (error.problem.status === 404 || error.problem.status === 409)) {
    return { ok: false, artifact: error.problem.artifact ?? fallback, reason: error.problem.detail ?? error.problem.title }
  }
  if (error instanceof Refusal) return { ok: false, artifact: fallback, reason: error.message }
  return null
}

async function guarded<T>(fallback: string, read: () => Promise<T>): Promise<T | Refused> {
  try {
    return await read()
  } catch (error) {
    const refused = notThere(error, fallback)
    if (refused) return refused
    throw error
  }
}

// The Arrow table's column by name; a missing one names itself in the reason.
function requireColumns(table: Table, what: string, names: readonly string[]): void {
  for (const name of names) {
    if (!table.getChild(name)) throw new Refusal(`the ${what} table is missing ${name}`)
  }
}

function columnOf(table: Table, name: string) {
  const column = table.getChild(name)
  if (!column) throw new Error(`column ${name} was not checked`)
  return column
}

function count(value: unknown, name: string, row: number): number {
  const number = Number(value)
  if (value === null || value === undefined || !Number.isFinite(number)) {
    throw new Refusal(`${name} has no number in row ${row + 1}`)
  }
  return number
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function requireText(value: unknown, name: string, row: number): string {
  if (value === null || value === undefined) throw new Refusal(`${name} has no text in row ${row + 1}`)
  return String(value)
}

export type XySource = 'own' | 'cell_centre' | 'none'

/** One site of a group, in obs_index order. x and y are origin-relative, NaN when there is no position. */
export interface ObsSiteRow {
  siteId: number
  site: string
  nObs: number
  x: number
  y: number
  xySource: XySource
  /** -1 when the layer is unknown. */
  layer: number
  /** -1 when the site is unplaced. */
  cell: number
  rule: string
  note: string | null
}

/** orderDigest names the observation table the rows were cut from; a frame must carry the same one. */
export type ObsSitesResult = { ok: true; rows: ObsSiteRow[]; orderDigest: string; notes: string[] } | Refused

const SITE_COLUMNS = ['site_id', 'site', 'n_obs', 'x', 'y', 'xy_source', 'layer', 'cell', 'rule', 'note'] as const
const XY_SOURCES: readonly string[] = ['own', 'cell_centre', 'none']

// A float32 column holds NaN for "no position"; a null means the same thing.
function coordinate(value: unknown): number {
  return value === null || value === undefined ? Number.NaN : Number(value)
}

function readSiteRows(buffer: ArrayBuffer): ObsSiteRow[] {
  const table = tableFromIPC(new Uint8Array(buffer))
  requireColumns(table, 'site', SITE_COLUMNS)
  const [id, site, nObs, x, y, source, layer, cell, rule, note] = SITE_COLUMNS.map((name) => columnOf(table, name))
  const rows: ObsSiteRow[] = new Array(table.numRows)
  for (let i = 0; i < table.numRows; i++) {
    const xySource = requireText(source.get(i), 'xy_source', i)
    if (!XY_SOURCES.includes(xySource)) throw new Refusal(`xy_source '${xySource}' in row ${i + 1} is not own, cell_centre or none`)
    rows[i] = {
      siteId: count(id.get(i), 'site_id', i),
      site: requireText(site.get(i), 'site', i),
      nObs: count(nObs.get(i), 'n_obs', i),
      x: coordinate(x.get(i)),
      y: coordinate(y.get(i)),
      xySource: xySource as XySource,
      layer: count(layer.get(i), 'layer', i),
      cell: count(cell.get(i), 'cell', i),
      rule: requireText(rule.get(i), 'rule', i),
      note: textOrNull(note.get(i)),
    }
  }
  return rows
}

export async function fetchObsSites(group: string, opts?: FetchOptions): Promise<ObsSitesResult> {
  return guarded('obs_cell', async () => {
    const { buffer, meta, notes } = await apiGetBytes(runUrl(activeRunId(), '/api/run/obs/sites', { group }), opts)
    const orderDigest = metaText(requireMeta(meta), 'order_digest')
    return { ok: true as const, rows: readSiteRows(buffer), orderDigest, notes: notes ?? [] }
  })
}

export type ObsFetched<T> = { ok: true; payload: T } | Refused

// A JSON answer must be an object carrying every field the view reads; the first missing one is named.
function requireKeys<T>(payload: unknown, what: string, keys: readonly string[]): T {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Refusal(`the ${what} answer was not an object`)
  }
  for (const key of keys) {
    if (!(key in payload)) throw new Refusal(`the ${what} answer is missing ${key}`)
  }
  return payload as T
}

async function fetchJson<T>(
  fallback: string,
  what: string,
  keys: readonly string[],
  route: string,
  query: Record<string, string | number | undefined>,
  opts?: FetchOptions,
): Promise<ObsFetched<T>> {
  return guarded(fallback, async () => {
    const payload = await apiGet(runUrl(activeRunId(), route, query), opts)
    return { ok: true as const, payload: requireKeys<T>(payload, what, keys) }
  })
}

// ---- the statistics the map can show, and the names that go with them ----

export type ObsStat = 'resid_mean' | 'rmse' | 'std' | 'mean'
export const OBS_STATS: readonly ObsStat[] = ['resid_mean', 'rmse', 'std', 'mean']

// The map's rmse is the root mean square over realizations of each observation's residual. The
// table's RMSE is the root mean square of the ensemble-mean residual. They are different numbers,
// so each gets its own name and neither is ever shown as plain "RMSE".
export const OBS_STAT_LABEL: Record<ObsStat, string> = {
  resid_mean: 'mean residual (simulated minus observed)',
  rmse: 'RMS residual over realizations',
  std: 'standard deviation over realizations',
  mean: 'ensemble mean',
}
export const TABLE_RMSE_LABEL = 'RMSE of the ensemble-mean residual'

// ---- groups ----

export interface ObsGroupRow {
  group: string
  nObs: number
  nSites: number
  /** null when obs_cell is unavailable. */
  nPlaced: number | null
  nWeighted: number
  nWithTarget: number
  nZeroWeight: number
  nSentinel: number
  nNoValue: number
  timeKind: string
  inequality: string
  firstIteration: number
  lastIteration: number | null
  /** Both RMSEs are the table's: the root mean square of the ensemble-mean residual. */
  rmseFirst: number | null
  rmseLast: number | null
  nResidFirst: number
  nResidLast: number
}

export type ObsGroupsResult = { ok: true; rows: ObsGroupRow[]; notes: string[] } | Refused

const GROUP_COLUMNS = [
  'group',
  'n_obs',
  'n_sites',
  'n_placed',
  'n_weighted',
  'n_with_target',
  'n_zero_weight',
  'n_sentinel',
  'n_no_value',
  'time_kind',
  'inequality',
  'first_iteration',
  'last_iteration',
  'rmse_first',
  'rmse_last',
  'n_resid_first',
  'n_resid_last',
] as const

function readGroupRows(buffer: ArrayBuffer): ObsGroupRow[] {
  const table = tableFromIPC(new Uint8Array(buffer))
  requireColumns(table, 'group', GROUP_COLUMNS)
  const c = Object.fromEntries(GROUP_COLUMNS.map((name) => [name, columnOf(table, name)]))
  const rows: ObsGroupRow[] = new Array(table.numRows)
  for (let i = 0; i < table.numRows; i++) {
    rows[i] = {
      group: requireText(c.group.get(i), 'group', i),
      nObs: count(c.n_obs.get(i), 'n_obs', i),
      nSites: count(c.n_sites.get(i), 'n_sites', i),
      nPlaced: numberOrNull(c.n_placed.get(i)),
      nWeighted: count(c.n_weighted.get(i), 'n_weighted', i),
      nWithTarget: count(c.n_with_target.get(i), 'n_with_target', i),
      nZeroWeight: count(c.n_zero_weight.get(i), 'n_zero_weight', i),
      nSentinel: count(c.n_sentinel.get(i), 'n_sentinel', i),
      nNoValue: count(c.n_no_value.get(i), 'n_no_value', i),
      timeKind: requireText(c.time_kind.get(i), 'time_kind', i),
      inequality: requireText(c.inequality.get(i), 'inequality', i),
      firstIteration: count(c.first_iteration.get(i), 'first_iteration', i),
      lastIteration: numberOrNull(c.last_iteration.get(i)),
      rmseFirst: numberOrNull(c.rmse_first.get(i)),
      rmseLast: numberOrNull(c.rmse_last.get(i)),
      nResidFirst: count(c.n_resid_first.get(i), 'n_resid_first', i),
      nResidLast: count(c.n_resid_last.get(i), 'n_resid_last', i),
    }
  }
  return rows
}

export async function fetchObsGroups(opts?: FetchOptions): Promise<ObsGroupsResult> {
  return guarded('obs_index', async () => {
    const { buffer, notes } = await apiGetBytes(runUrl(activeRunId(), '/api/run/obs/groups'), opts)
    return { ok: true as const, rows: readGroupRows(buffer), notes: notes ?? [] }
  })
}

// ---- times ----

export type Limits = [number, number] | null

export interface ObsTimesPayload {
  group: string
  /** The observation table these times were cut from. */
  order_digest: string
  time_kind: string
  steps_by: 'time' | 'position'
  /** Sorted, unique, finite; empty when the answer is refused. */
  times: number[]
  n_at_time: number[]
  n_sites: number
  iterations: { iteration: number; available: boolean; reason: string | null }[]
  limits: { resid_mean: Limits; rmse: Limits; std: Limits; mean: Limits }
  limits_rule: string
  /** Why no limits could be made; null when there are limits, or the statistic has no finite value. */
  limits_refused: string | null
  refused: string | null
  notes: string[]
}
export type ObsTimesResult = ObsFetched<ObsTimesPayload>

export async function fetchObsTimes(group: string, opts?: FetchOptions): Promise<ObsTimesResult> {
  return fetchJson('obs_index', 'times', ['group', 'order_digest', 'times', 'n_at_time', 'iterations', 'limits', 'limits_refused', 'refused'], '/api/run/obs/times', { group }, opts)
}

// ---- frame: one statistic of every site at one time ----

export interface ObsFrameMeta {
  group: string
  iteration: number
  time: number
  stat: ObsStat
  /** The observation table the frame was cut for; entry i is row i of the sites with this digest. */
  orderDigest: string
  nSites: number
  nAtTime: number
  /** Rows at this time that lost to a later row of the same site; the frame shows the last. */
  nRowsHidden: number
  nFinite: number
}

export interface ObsFrame {
  /** Entry i belongs to row i of the group's sites; NaN where nothing sits at that time or the statistic is not a number. */
  values: Float32Array
  meta: ObsFrameMeta
}
export type ObsFrameResult = ({ ok: true } & ObsFrame) | Refused

function metaNumber(meta: Record<string, unknown>, name: string): number {
  const value = meta[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Refusal(`the answer's meta is missing ${name}`)
  return value
}

function metaText(meta: Record<string, unknown>, name: string): string {
  const value = meta[name]
  if (typeof value !== 'string') throw new Refusal(`the answer's meta is missing ${name}`)
  return value
}

function requireMeta(meta: Record<string, unknown> | null): Record<string, unknown> {
  if (meta === null) throw new Refusal('the answer came with no X-Pesto-Meta header')
  return meta
}

function float32Of(buffer: ArrayBuffer, meta: Record<string, unknown>): Float32Array {
  if (meta.dtype !== undefined && meta.dtype !== '<f4') throw new Refusal(`the answer's dtype is ${String(meta.dtype)}, not <f4`)
  if (buffer.byteLength % 4 !== 0) throw new Refusal('the answer is not a whole number of float32 values')
  return new Float32Array(buffer)
}

export async function fetchObsFrame(
  group: string,
  iteration: number,
  time: number,
  stat: ObsStat,
  opts?: FetchOptions,
): Promise<ObsFrameResult> {
  return guarded('obs_agg', async () => {
    const answer = await apiGetBytes(runUrl(activeRunId(), '/api/run/obs/frame', { group, iteration, time, stat }), opts)
    const meta = requireMeta(answer.meta)
    const values = float32Of(answer.buffer, meta)
    const nSites = metaNumber(meta, 'n_sites')
    if (values.length !== nSites) throw new Refusal(`the frame has ${values.length} values but its meta says ${nSites} sites`)
    return {
      ok: true as const,
      values,
      meta: {
        group: metaText(meta, 'group'),
        iteration: metaNumber(meta, 'iteration'),
        time: metaNumber(meta, 'time'),
        stat: metaText(meta, 'stat') as ObsStat,
        orderDigest: metaText(meta, 'order_digest'),
        nSites,
        nAtTime: metaNumber(meta, 'n_at_time'),
        nRowsHidden: metaNumber(meta, 'n_rows_hidden'),
        nFinite: metaNumber(meta, 'n_finite'),
      },
    }
  })
}

// ---- one site ----

export interface SiteNoise {
  available: true
  q05: (number | null)[]
  q95: (number | null)[]
  source: string
  base: string
  n_real_used: number
}
export interface SitePlacement {
  available: true
  rule: string
  note: string | null
  layer: number
  cell: number
}
export interface Unavailable {
  available: false
  artifact: string
  reason: string
}

export interface ObsSitePayload {
  site_id: number
  site: string
  group: string
  time_kind: string
  inequality: 'none' | 'greater' | 'less'
  n_obs: number
  time: number[]
  obsval: (number | null)[]
  no_value: boolean[]
  sentinel: boolean[]
  weighted: boolean[]
  noise: SiteNoise | Unavailable
  placement: SitePlacement | Unavailable
  iterations: number[]
  notes: string[]
}
export type ObsSiteResult = ObsFetched<ObsSitePayload>

const SITE_KEYS = [
  'site_id',
  'site',
  'group',
  'time_kind',
  'inequality',
  'n_obs',
  'time',
  'obsval',
  'no_value',
  'sentinel',
  'weighted',
  'noise',
  'placement',
  'iterations',
  'notes',
] as const

export async function fetchObsSite(siteId: number, opts?: FetchOptions): Promise<ObsSiteResult> {
  return fetchJson('obs_index', 'site', SITE_KEYS, '/api/run/obs/site', { site: siteId }, opts)
}

// ---- one site's realizations ----

export interface ObsSeries {
  /** Observation-major: row r, realization j is values[r * nReal + j]. */
  values: Float32Array
  /** Number of observations (rows). */
  count: number
  nReal: number
  siteId: number
  iteration: number
  /** Column of the base realization; an empty list when none was found. */
  baseIndex: number[]
  baseNote: string | null
  nNaN: number
  /** Simulated values that were a 1e20-or-more placeholder; the server sent them as NaN. */
  nSentinel: number
}
export type ObsSeriesResult = ({ ok: true } & ObsSeries) | Refused

export async function fetchObsSeries(siteId: number, iteration: number, opts?: FetchOptions): Promise<ObsSeriesResult> {
  return guarded('obs_ens', async () => {
    const answer = await apiGetBytes(runUrl(activeRunId(), '/api/run/obs/series', { site: siteId, iteration }), opts)
    const meta = requireMeta(answer.meta)
    const values = float32Of(answer.buffer, meta)
    const shape = meta.shape
    if (!Array.isArray(shape) || shape.length !== 2 || !shape.every((n) => Number.isInteger(n) && n >= 0)) {
      throw new Refusal("the answer's meta is missing shape as two whole numbers")
    }
    const [rows, nReal] = [shape[0] as number, metaNumber(meta, 'n_real')]
    if (shape[1] !== nReal) throw new Refusal(`the series shape says ${shape[1]} realizations but its meta says ${nReal}`)
    if (values.length !== rows * nReal) {
      throw new Refusal(`the series has ${values.length} values, not ${rows} observations times ${nReal} realizations`)
    }
    const baseIndex = meta.base_index
    if (!Array.isArray(baseIndex) || !baseIndex.every((n) => typeof n === 'number')) {
      throw new Refusal("the answer's meta is missing base_index")
    }
    if (!('base_note' in meta)) throw new Refusal("the answer's meta is missing base_note")
    return {
      ok: true as const,
      values,
      count: rows,
      nReal,
      siteId: metaNumber(meta, 'site_id'),
      iteration: metaNumber(meta, 'iteration'),
      baseIndex: baseIndex as number[],
      baseNote: textOrNull(meta.base_note),
      nNaN: metaNumber(meta, 'n_nan'),
      nSentinel: typeof meta.n_sentinel === 'number' ? meta.n_sentinel : 0,
    }
  })
}

// ---- 1:1 ----

export interface SeriesPoints {
  iteration: number
  obsval: number[]
  mean: (number | null)[]
  q05: (number | null)[]
  q95: (number | null)[]
  weighted: boolean[]
}

/** One site's observations that have a target, with the ensemble's mean and band for each. */
export interface SitePoints {
  site_id: number
  site: string
  rmse_last: number | null
  series: SeriesPoints[]
}

export interface Obs1to1Payload {
  group: string
  n_bins: number
  /** null when the group is refused. */
  lo: number | null
  hi: number | null
  x_label: string
  y_label: string
  /** counts[iy * n_bins + ix], iy along the simulated axis. */
  grids: { iteration: number; counts: number[]; n_points: number; n_outside: number; n_no_valid: number; n_nonfinite: number }[]
  n_with_target: number
  n_zero_weight: number
  left_out: { no_value: number; sentinel: number }
  outlying: SitePoints[]
  ranking_rule: string
  rmse_rule: string
  refused: string | null
  notes: string[]
}
export type Obs1to1Result = ObsFetched<Obs1to1Payload>

export async function fetchObs1to1(group: string, opts?: FetchOptions): Promise<Obs1to1Result> {
  return fetchJson(
    'obs_1to1',
    '1:1',
    ['group', 'n_bins', 'lo', 'hi', 'grids', 'left_out', 'outlying', 'ranking_rule', 'rmse_rule', 'refused'],
    '/api/run/obs/1to1',
    { group },
    opts,
  )
}

// ---- points for chosen sites ----

export interface ObsPointsPayload {
  group: string
  sites: SitePoints[]
  not_in_group: number[]
  unknown: number[]
}
export type ObsPointsResult = ObsFetched<ObsPointsPayload>

export const MAX_POINT_SITES = 20

export async function fetchObsPoints(group: string, siteIds: readonly number[], opts?: FetchOptions): Promise<ObsPointsResult> {
  if (siteIds.length === 0) return { ok: false, artifact: 'obs_index', reason: 'no site was asked for' }
  if (siteIds.length > MAX_POINT_SITES) {
    return { ok: false, artifact: 'obs_index', reason: `at most ${MAX_POINT_SITES} sites can be asked for at once, got ${siteIds.length}` }
  }
  if (!siteIds.every((id) => Number.isInteger(id))) return { ok: false, artifact: 'obs_index', reason: 'a site id was not a whole number' }
  return fetchJson('obs_index', 'points', ['group', 'sites', 'not_in_group', 'unknown'], '/api/run/obs/points', { group, sites: siteIds.join(',') }, opts)
}

// ---- residual histogram ----

export interface ResidSeries {
  iteration: number
  n: number
  counts: number[]
  density: number[]
}

export interface ObsResidHistPayload {
  group: string
  residual: 'simulated minus observed'
  inequality: string
  inequality_note: string | null
  /** 51 edges, or none when refused. */
  edges: number[]
  first: ResidSeries | null
  last: ResidSeries | null
  n_outside: { first: number; last: number }
  left_out: { no_value: number; sentinel: number; no_valid_realization: { first: number; last: number } }
  n_zero_weight: number
  refused: string | null
  notes: string[]
}
export type ObsResidHistResult = ObsFetched<ObsResidHistPayload>

export async function fetchObsResidHist(group: string, opts?: FetchOptions): Promise<ObsResidHistResult> {
  return fetchJson(
    'obs_agg',
    'residual histogram',
    ['group', 'residual', 'edges', 'first', 'last', 'n_outside', 'left_out', 'refused'],
    '/api/run/obs/resid_hist',
    { group },
    opts,
  )
}

// ---- brushing a residual range on the histogram ----

export interface ObsBrushPayload {
  group: string
  iteration: number
  lo: number
  hi: number
  /** Site ids, ascending, with at least one observation whose residual is inside lo..hi. */
  sites: number[]
  n_obs_in_range: number
  left_out: { no_target: number; sentinel: number; no_valid_realization: number }
  /** The brushed sites' residuals in the histogram's other iteration, on the same edges; null when there is none. */
  other: { iteration: number; counts: number[]; density: number[]; n_sites: number; n_obs: number } | null
}
export type ObsBrushResult = ObsFetched<ObsBrushPayload>

export async function fetchObsBrush(group: string, iteration: number, lo: number, hi: number, opts?: FetchOptions): Promise<ObsBrushResult> {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { ok: false, artifact: 'obs_agg', reason: `the brushed range ${lo} to ${hi} is not two finite numbers` }
  if (lo > hi) return { ok: false, artifact: 'obs_agg', reason: `the brushed range starts at ${lo}, past its end ${hi}` }
  return fetchJson(
    'obs_agg',
    'brush',
    ['group', 'iteration', 'lo', 'hi', 'sites', 'n_obs_in_range', 'left_out', 'other'],
    '/api/run/obs/brush',
    { group, iteration, lo, hi },
    opts,
  )
}

// ---- the observation ensemble's realization names ----

export interface ObsRealsPayload {
  iteration: number
  /** In the order the ensemble file recorded them; column j of a series is names[j]. */
  names: string[]
  base_index: number[]
  base_note: string | null
}
export type ObsRealsResult = ObsFetched<ObsRealsPayload>

export async function fetchObsReals(iteration: number, opts?: FetchOptions): Promise<ObsRealsResult> {
  return fetchJson(`obs_ens/${iteration}`, 'realization names', ['iteration', 'names', 'base_index', 'base_note'], '/api/run/obs/reals', { iteration }, opts)
}

// ---- one read shared by every caller ----

/** One answer shared by every caller. A refused or thrown answer is forgotten, so the next call asks again. */
export function shareRead<T extends { ok: boolean }>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
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
