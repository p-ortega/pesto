// A click on the section, picked from the answer's own pieces in float64 distance and elevation,
// never from the float32 quads on the GPU (D-25). The cell is the answer's cell id, not a position.

import type { SectionAnswer } from './section'

export interface SectionHit {
  piece: number
  layer: number
  cell: number
  status: number
  top: number
  bottom: number
  /** The clicked distance from A and elevation. */
  s: number
  z: number
}

/** The piece and layer under (s, z), or null outside every piece, above the top or below the bottom. */
export function pickSection(answer: SectionAnswer, s: number, z: number): SectionHit | null {
  if (!Number.isFinite(s) || !Number.isFinite(z)) return null
  const { nlay } = answer
  // The first piece wins, so a shared end goes to the piece nearer A.
  let piece = -1
  for (let p = 0; p < answer.nPieces; p++) {
    if (answer.s0[p] <= s && s <= answer.s1[p]) {
      piece = p
      break
    }
  }
  if (piece < 0) return null
  const row = piece * (nlay + 1)
  // The first layer wins, so an interface goes to the upper layer; a zero-height quad is never picked.
  for (let k = 0; k < nlay; k++) {
    const top = answer.z[row + k]
    const bottom = answer.z[row + k + 1]
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || top === bottom) continue
    if (Math.min(top, bottom) <= z && z <= Math.max(top, bottom)) {
      return { piece, layer: k, cell: answer.cell[piece], status: answer.status[piece * nlay + k], top, bottom, s, z }
    }
  }
  return null
}
