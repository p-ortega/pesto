// Interpolated pilot-point groups: the index of groups the server can
// interpolate, one group's per-cell field, and the classification the map
// draws it with. A cell's value here is a value, not a block row -- there is
// no parameter sitting on the cell, so the readout reaches for the
// contributors route instead of the D-05 join.

import { apiGet, apiGetBytes, type FetchOptions } from './client'
import type { CellClass } from './parmap'
import { activeRunId, runUrl } from './run'

export interface PpGroupInfo {
  group: string
  layer: number
  n_pp: number
  log_space: boolean
  format: 'text' | 'binary'
  notes: string[]
}

export interface PpIndex {
  groups: PpGroupInfo[]
  not_interpolable: { group: string; reason: string }[]
  notes: string[]
}

export const EMPTY_PP_INDEX: PpIndex = { groups: [], not_interpolable: [], notes: [] }

export async function fetchPpIndex(opts?: FetchOptions): Promise<PpIndex> {
  return (await apiGet(runUrl(activeRunId(), '/api/run/grid/pp'), opts)) as PpIndex
}

export interface FieldQuery {
  iteration: number
  group: string
  realization?: string
  stat?: string
}

export async function gridField(query: FieldQuery, opts?: FetchOptions): Promise<Float32Array> {
  const { buffer } = await apiGetBytes(
    runUrl(activeRunId(), '/api/run/grid/field', {
      iteration: query.iteration,
      group: query.group,
      stat: query.stat,
      realization: query.realization,
    }),
    opts,
  )
  return new Float32Array(buffer)
}

export interface Contributor {
  parnme: string
  weight: number
}

export async function fieldContributors(
  iteration: number,
  group: string,
  cell: number,
  opts?: FetchOptions,
): Promise<Contributor[]> {
  const body = (await apiGet(runUrl(activeRunId(), '/api/run/grid/field/cell', { iteration, group, cell }), opts)) as {
    contributors: Contributor[]
  }
  return body.contributors
}

/** Every cell's class for an interpolated group on one layer: a finite value
 *  on the group's own layer is `interpolated`; anything else in the model is
 *  `no-parameter`; a cell outside the model keeps its hairline. */
export function classifyFieldCells(
  field: Float32Array,
  active: Uint8Array,
  groupLayer: number,
  layer: number,
): { classes: CellClass[]; noValueCount: number } {
  const classes: CellClass[] = new Array(active.length)
  let noValueCount = 0
  for (let c = 0; c < active.length; c++) {
    if (!active[c]) {
      classes[c] = { kind: 'outside-model' }
    } else if (layer === groupLayer && Number.isFinite(field[c])) {
      classes[c] = { kind: 'interpolated' }
    } else {
      classes[c] = { kind: 'no-parameter' }
      noValueCount += 1
    }
  }
  return { classes, noValueCount }
}
