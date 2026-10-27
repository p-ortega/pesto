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

export type ObsSitesResult = { ok: true; rows: ObsSiteRow[]; notes: string[] } | Refused

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
    const { buffer, notes } = await apiGetBytes(runUrl(activeRunId(), '/api/run/obs/sites', { group }), opts)
    return { ok: true as const, rows: readSiteRows(buffer), notes: notes ?? [] }
  })
}
