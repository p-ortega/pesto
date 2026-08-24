// The D-05 join: the map block's slice of the block-to-control permutation
// (fetchParmap), joined against the control table's parameter identity
// (fetchParIdentities), so a block row's parameter name, group and
// partrans come from inside the file, never from where the row sits.

import { tableFromIPC } from 'apache-arrow'
import { gridParmap, runMeta } from './client'

export interface ParIdentity {
  parnme: string
  pargp: string
  partrans: string
}

export async function fetchParmap(iteration: number): Promise<Int32Array> {
  return gridParmap(iteration)
}

/**
 * Reads `/meta?kind=par` and returns one identity per control-table row, in
 * control-file order. Columns are read by field name, never by a numbered
 * position, because the control table's column order is the control
 * file's own order and nothing sorts it.
 */
export async function fetchParIdentities(): Promise<ParIdentity[]> {
  const buffer = await runMeta('par')
  const table = tableFromIPC(new Uint8Array(buffer))

  const parnme = table.getChild('parnme')
  const pargp = table.getChild('pargp')
  const partrans = table.getChild('partrans')
  if (!parnme || !pargp || !partrans) {
    throw new Error('the parameter table is missing parnme, pargp or partrans')
  }

  const out: ParIdentity[] = new Array(table.numRows)
  for (let i = 0; i < table.numRows; i++) {
    out[i] = {
      parnme: String(parnme.get(i)),
      pargp: String(pargp.get(i)),
      partrans: String(partrans.get(i)),
    }
  }
  return out
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
