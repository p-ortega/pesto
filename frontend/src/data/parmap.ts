// The D-05 join: the map block's slice of the block-to-control permutation
// (fetchParmap), joined against the control table's parameter identity
// (fetchParIdentities), so a block row's parameter name, group and
// partrans come from inside the file, never from where the row sits.

import { tableFromIPC } from 'apache-arrow'
import { gridParmap, runMeta, type FetchOptions } from './client'

export interface ParIdentity {
  parnme: string
  pargp: string
  /** null when the stored table has no partrans column; the scale then defaults to linear. */
  partrans: string | null
}

export async function fetchParmap(iteration: number, opts?: FetchOptions): Promise<Int32Array> {
  return gridParmap(iteration, opts)
}

// The columns the map cannot draw without; the server refuses the request if one is missing.
export const PAR_TABLE_COLUMNS = ['parnme', 'pargp'] as const

// Columns the Params panel and the scale default read when the run has them.
// The server names any it lacks in X-Pesto-Absent-Columns and the panel shows dashes.
export const PAR_TABLE_OPTIONAL_COLUMNS = ['parlbnd', 'parubnd', 'partrans'] as const

/** One request for the parameter table, only the columns the page reads. */
export function fetchParTable(opts?: FetchOptions): Promise<ArrayBuffer> {
  return runMeta('par', PAR_TABLE_COLUMNS, PAR_TABLE_OPTIONAL_COLUMNS, opts)
}

/**
 * Returns one identity per control-table row, in control-file order, from a
 * parameter table answer. Columns are read by field name, never by a numbered
 * position, because the control table's column order is the control
 * file's own order and nothing sorts it.
 */
export function parseParIdentities(buffer: ArrayBuffer): ParIdentity[] {
  const table = tableFromIPC(new Uint8Array(buffer))

  const parnme = table.getChild('parnme')
  const pargp = table.getChild('pargp')
  const partrans = table.getChild('partrans')
  if (!parnme || !pargp) {
    throw new Error('the parameter table is missing parnme or pargp')
  }

  const out: ParIdentity[] = new Array(table.numRows)
  for (let i = 0; i < table.numRows; i++) {
    out[i] = {
      parnme: String(parnme.get(i)),
      pargp: String(pargp.get(i)),
      partrans: partrans ? String(partrans.get(i)) : null,
    }
  }
  return out
}

/** Asks for the parameter table and returns its identities. */
export async function fetchParIdentities(): Promise<ParIdentity[]> {
  return parseParIdentities(await fetchParTable())
}

/**
 * Block row `i` -> the identity at control row `parmap[i]`. When a
 * `parmap` entry falls outside the identity table, that row is recorded as
 * `null` -- unidentifiable -- rather than substituting a guess; the caller
 * is the one that says so.
 */
export function joinBlockToIdentity(parmap: Int32Array, identities: ParIdentity[]): Array<ParIdentity | null> {
  const out: Array<ParIdentity | null> = new Array(parmap.length)
  for (let i = 0; i < parmap.length; i++) {
    const row = parmap[i]
    out[i] = row >= 0 && row < identities.length ? identities[row] : null
  }
  return out
}

// D-06's four marks. `row`/`rows` are indices into the block-order arrays
// (`joined`, and whatever raw field the caller holds) -- never a value --
// so the caller looks up the parameter's name and its value itself. A
// contested cell keeps every one of its rows in scan order; nothing here
// ever picks one, averages them, or treats two equal values as a tiebreak.
export type CellClass =
  | { kind: 'valued'; row: number }
  | { kind: 'contested'; rows: number[] }
  | { kind: 'no-parameter' }
  | { kind: 'outside-model' }
  | { kind: 'interpolated' }
  /** A cell hosting rows of a group drawn as dots: unfilled, the dots carry the values. */
  | { kind: 'points'; rows: number[] }

export interface ClassifyCellsResult {
  /** One entry per grid cell, `classes[cell]`. */
  classes: CellClass[]
  contestedCount: number
  noValueCount: number
}

/**
 * Classifies every grid cell against one drawn group and layer, from the
 * D-05 join and the block-order cell/layer companion arrays -- the same
 * inputs `computePerCell` already reprojects with. A cell is "outside the
 * model" when `active` says it is not in the model on the drawn layer and
 * no row of the drawn group sits there; a row of the drawn group is always
 * drawn, whatever `active` says.
 */
export function classifyCells(
  joined: Array<ParIdentity | null>,
  cells: Int32Array,
  layers: Int32Array,
  group: string,
  layer: number,
  active: Uint8Array,
): ClassifyCellsResult {
  const nCells = active.length
  const rowsByCell: Array<number[] | undefined> = new Array(nCells)
  for (let i = 0; i < cells.length; i++) {
    if (layers[i] !== layer) continue
    const identity = joined[i]
    if (identity === null || identity.pargp !== group) continue
    const c = cells[i]
    if (c < 0 || c >= nCells) continue
    const rows = rowsByCell[c] ?? (rowsByCell[c] = [])
    rows.push(i)
  }

  const classes: CellClass[] = new Array(nCells)
  let contestedCount = 0
  let noValueCount = 0
  for (let c = 0; c < nCells; c++) {
    const rows = rowsByCell[c]
    if (!rows || rows.length === 0) {
      if (active[c]) {
        classes[c] = { kind: 'no-parameter' }
        noValueCount += 1
      } else {
        classes[c] = { kind: 'outside-model' }
      }
    } else if (rows.length === 1) {
      classes[c] = { kind: 'valued', row: rows[0] }
    } else {
      classes[c] = { kind: 'contested', rows }
      contestedCount += 1
    }
  }

  return { classes, contestedCount, noValueCount }
}
