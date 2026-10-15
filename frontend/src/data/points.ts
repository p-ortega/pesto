// Position helpers for a group placed by x/y: which rows draw as dots on
// the drawn layer, and which dot a click is nearest to.

import type { ParIdentity } from './parmap'

export interface DrawnPoints {
  /** Block rows of the drawn group on the drawn layer with a finite x/y, in block order. */
  rows: Int32Array
  /** Their positions, `2 * rows.length` long. */
  xy: Float32Array
}

export function hasPosition(xy: Float32Array, row: number): boolean {
  return Number.isFinite(xy[2 * row]) && Number.isFinite(xy[2 * row + 1])
}

export function isPointGroup(joined: Array<ParIdentity | null>, xy: Float32Array | null, group: string): boolean {
  if (xy === null) return false
  for (let row = 0; row < joined.length; row++) {
    if (joined[row]?.pargp === group && Number.isFinite(xy[2 * row])) return true
  }
  return false
}

export function pointsOnLayer(
  joined: Array<ParIdentity | null>,
  layers: Int32Array,
  xy: Float32Array,
  group: string,
  layer: number,
): DrawnPoints {
  const rows: number[] = []
  for (let row = 0; row < joined.length; row++) {
    if (joined[row]?.pargp === group && layers[row] === layer && hasPosition(xy, row)) rows.push(row)
  }
  const out = new Float32Array(2 * rows.length)
  rows.forEach((row, i) => {
    out[2 * i] = xy[2 * row]
    out[2 * i + 1] = xy[2 * row + 1]
  })
  return { rows: Int32Array.from(rows), xy: out }
}

export function pickPoint(points: DrawnPoints, wx: number, wy: number, maxDistance: number): number | null {
  let best: number | null = null
  let bestD2 = maxDistance * maxDistance
  for (let i = 0; i < points.rows.length; i++) {
    const dx = points.xy[2 * i] - wx
    const dy = points.xy[2 * i + 1] - wy
    const d2 = dx * dx + dy * dy
    if (d2 <= bestD2 && (best === null || d2 < bestD2)) {
      best = i
      bestD2 = d2
    }
  }
  return best
}
