// The overlay masks (D-21, D-25, D-29): which cells the hatch pass marks for
// at-bounds parameters and for prior-data-conflict sites, and the per-dot
// flags the points shader reads. Every item left out is counted by reason.

import type { ParIdentity } from './parmap'

// The one home of these bits; MeshLayer's shaders use the same numbers.
export const HATCH_AT_BOUNDS = 1
export const HATCH_CONFLICT = 2
export const POINT_FLAG_AT_BOUNDS = 1
export const POINT_FLAG_CONFLICT = 2
export const POINT_FLAG_DIM = 4

export interface ParameterCellsResult {
  cells: number[]
  rows: number[]
  /** Named block rows placed on a layer other than the drawn one. */
  otherLayer: number
  /** Named block rows with no cell. */
  unplaced: number
  /** Names with no block row at all. */
  unknown: number
}

/** The cells and block rows of the named parameters on `layer`. */
export function parameterCells(
  names: ReadonlySet<string>,
  joined: ReadonlyArray<ParIdentity | null>,
  cellArray: Int32Array,
  layerArray: Int32Array,
  layer: number,
): ParameterCellsResult {
  const out: ParameterCellsResult = { cells: [], rows: [], otherLayer: 0, unplaced: 0, unknown: 0 }
  if (names.size === 0) return out
  const found = new Set<string>()
  for (let row = 0; row < joined.length; row++) {
    const name = joined[row]?.parnme
    if (name === undefined || !names.has(name)) continue
    found.add(name)
    if (cellArray[row] < 0) out.unplaced += 1
    else if (layerArray[row] !== layer) out.otherLayer += 1
    else {
      out.cells.push(cellArray[row])
      out.rows.push(row)
    }
  }
  for (const name of names) if (!found.has(name)) out.unknown += 1
  return out
}

type IntColumn = Int32Array | readonly number[]

/** The /obs/pdc sites block: parallel columns, one entry per conflicted site. */
export interface PdcSiteColumns {
  id: IntColumn
  cell: IntColumn
  layer: IntColumn
  groupIndex: IntColumn
}

export interface SiteCellsOptions {
  layer: number
  allLayers: boolean
  /** The coloured observation group, or null for every group. */
  groupIndex: number | null
}

export interface SiteCellsResult {
  cells: number[]
  siteIds: number[]
  leftOut: { otherLayer: number; unknownLayer: number; otherGroup: number; unplaced: number }
}

/**
 * The cells of conflicted sites under the Phase 10 dot rule: the drawn layer
 * only, or every placed site with all layers on (unknown layer included).
 */
export function siteCells(sites: PdcSiteColumns, opts: SiteCellsOptions): SiteCellsResult {
  const n = sites.id.length
  if (sites.cell.length !== n || sites.layer.length !== n || sites.groupIndex.length !== n) {
    throw new Error(
      `pdc site columns differ in length: id ${n}, cell ${sites.cell.length}, layer ${sites.layer.length}, groupIndex ${sites.groupIndex.length}`,
    )
  }
  const out: SiteCellsResult = {
    cells: [],
    siteIds: [],
    leftOut: { otherLayer: 0, unknownLayer: 0, otherGroup: 0, unplaced: 0 },
  }
  for (let i = 0; i < n; i++) {
    if (opts.groupIndex !== null && sites.groupIndex[i] !== opts.groupIndex) {
      out.leftOut.otherGroup += 1
      continue
    }
    if (sites.cell[i] < 0) {
      out.leftOut.unplaced += 1
      continue
    }
    const siteLayer = sites.layer[i]
    if (!opts.allLayers) {
      if (siteLayer < 0) {
        out.leftOut.unknownLayer += 1
        continue
      }
      if (siteLayer !== opts.layer) {
        out.leftOut.otherLayer += 1
        continue
      }
    }
    out.cells.push(sites.cell[i])
    out.siteIds.push(sites.id[i])
  }
  return out
}

export interface HatchMaskResult {
  /** One entry per cell: HATCH_AT_BOUNDS and HATCH_CONFLICT bits. */
  mask: Uint8Array
  /** Cell ids in either list that are not a cell of this grid; never set. */
  outOfRange: number
}

export function buildHatchMask(
  nCells: number,
  atBoundsCells: ArrayLike<number>,
  conflictCells: ArrayLike<number>,
): HatchMaskResult {
  const mask = new Uint8Array(nCells)
  let outOfRange = 0
  const mark = (cells: ArrayLike<number>, bit: number) => {
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]
      if (Number.isInteger(c) && c >= 0 && c < nCells) mask[c] |= bit
      else outOfRange += 1
    }
  }
  mark(atBoundsCells, HATCH_AT_BOUNDS)
  mark(conflictCells, HATCH_CONFLICT)
  return { mask, outOfRange }
}

export interface PointFlagRules {
  dim?: (dot: number) => boolean
  atBounds?: (dot: number) => boolean
  conflict?: (dot: number) => boolean
}

/** One float per drawn dot holding its flag bits, as the points attribute wants. */
export function buildPointFlags(n: number, rules: PointFlagRules): Float32Array {
  const flags = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let bits = 0
    if (rules.atBounds?.(i)) bits |= POINT_FLAG_AT_BOUNDS
    if (rules.conflict?.(i)) bits |= POINT_FLAG_CONFLICT
    if (rules.dim?.(i)) bits |= POINT_FLAG_DIM
    flags[i] = bits
  }
  return flags
}
