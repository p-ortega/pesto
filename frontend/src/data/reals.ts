// Realization names for one iteration, read from GET /reals in the order
// the ensemble file recorded them (CLAUDE.md's "never substitute position
// for identity"). A route that answers "no names were recorded" carries a
// different fact than an empty list, so the two are kept apart in the
// return type rather than both collapsing to `[]`.

import { tableFromIPC } from 'apache-arrow'
import { apiGetBytes, ApiError } from './client'

export interface RealNamesFound {
  ok: true
  names: string[]
}

export interface RealNamesNotRecorded {
  ok: false
  iteration: number
  reason: string
}

export type RealNamesResult = RealNamesFound | RealNamesNotRecorded

export async function fetchRealNames(iteration: number): Promise<RealNamesResult> {
  let buffer: ArrayBuffer
  try {
    const result = await apiGetBytes(`/api/run/reals?iteration=${encodeURIComponent(String(iteration))}`)
    buffer = result.buffer
  } catch (error) {
    if (error instanceof ApiError && error.problem.status === 404) {
      return { ok: false, iteration, reason: error.problem.title }
    }
    throw error
  }

  const table = tableFromIPC(new Uint8Array(buffer))
  const column = table.getChild('realization')
  if (!column) {
    throw new Error('the realization table is missing its realization column')
  }
  const names: string[] = new Array(table.numRows)
  for (let i = 0; i < table.numRows; i++) {
    names[i] = String(column.get(i))
  }
  return { ok: true, names }
}
