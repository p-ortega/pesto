// Which grid cells are in the model. The grid file's idomain says so per
// layer; with no idomain, a cell counts when any block row names it.

import type { ParIdentity } from './parmap'

/** 1 where some block row names the cell, at any layer and in any group. */
export function referencedMask(cells: Int32Array, nCells: number): Uint8Array {
  const mask = new Uint8Array(nCells)
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]
    if (c >= 0 && c < nCells) mask[c] = 1
  }
  return mask
}

/** 1 where the drawn layer's idomain is above 0. `idomain` is flat, layer-major. */
export function layerActiveMask(idomain: Int32Array, nCells: number, layer: number): Uint8Array {
  const mask = new Uint8Array(nCells)
  const offset = layer * nCells
  for (let c = 0; c < nCells; c++) {
    mask[c] = idomain[offset + c] > 0 ? 1 : 0
  }
  return mask
}

/** One note per group whose parameters land on cells the idomain marks inactive, in group-name order. */
export function inactiveLandingNotes(
  joined: Array<ParIdentity | null>,
  cells: Int32Array,
  layers: Int32Array,
  idomain: Int32Array,
  nCells: number,
): string[] {
  const nlay = nCells > 0 ? Math.floor(idomain.length / nCells) : 0
  const counts = new Map<string, number>()
  for (let i = 0; i < cells.length; i++) {
    const identity = joined[i]
    const c = cells[i]
    const l = layers[i]
    if (identity === null || identity === undefined) continue
    if (c < 0 || c >= nCells || l < 0 || l >= nlay) continue
    if (idomain[l * nCells + c] > 0) continue
    counts.set(identity.pargp, (counts.get(identity.pargp) ?? 0) + 1)
  }
  return Array.from(counts.keys())
    .sort()
    .map(
      (group) =>
        `${group}: ${counts.get(group)} parameter(s) sit on cells the grid file marks inactive (idomain 0 or less); they are still drawn`,
    )
}
