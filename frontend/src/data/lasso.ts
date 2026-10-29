// Lasso geometry (D-12): which drawn dots fall inside a freehand outline.
// A Flatbush index over the dots narrows the search to the outline's box,
// then an exact even-odd crossing test decides each candidate. Pure: the
// caller keeps one index per drawn set of dots.

import Flatbush from 'flatbush'

export const MIN_LASSO_POINTS = 3

const NODE_SIZE = 16

export type LassoPoint = readonly [number, number]

/** An index over `xy` (x, y per dot); null for no dots, since Flatbush refuses an empty index. */
export function buildDotIndex(xy: Float32Array): Flatbush | null {
  const n = Math.floor(xy.length / 2)
  if (n === 0) return null
  const tree = new Flatbush(n, NODE_SIZE, Float32Array)
  for (let i = 0; i < n; i++) tree.add(xy[2 * i], xy[2 * i + 1], xy[2 * i], xy[2 * i + 1])
  tree.finish()
  return tree
}

/**
 * Even-odd crossing test. Each edge counts as crossed when the dot's y lies
 * in [low, high) of its span and the dot is left of it, so a dot exactly on
 * an edge two outlines share belongs to one of them, never both.
 */
export function pointInPolygon(x: number, y: number, poly: readonly LassoPoint[]): boolean {
  if (poly.length < MIN_LASSO_POINTS) return false
  return insideFlat(x, y, flatten(poly))
}

function flatten(poly: readonly LassoPoint[]): Float64Array {
  const flat = new Float64Array(2 * poly.length)
  poly.forEach(([px, py], i) => {
    flat[2 * i] = px
    flat[2 * i + 1] = py
  })
  return flat
}

// Same test over a flat x, y array, so thousands of candidates skip the tuple reads.
function insideFlat(x: number, y: number, flat: Float64Array): boolean {
  let inside = false
  const n = flat.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = flat[2 * i]
    const yi = flat[2 * i + 1]
    const xj = flat[2 * j]
    const yj = flat[2 * j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The dots inside `poly`, ascending by dot index. */
export function dotsInPolygon(tree: Flatbush | null, xy: Float32Array, poly: readonly LassoPoint[]): number[] {
  if (tree === null || poly.length < MIN_LASSO_POINTS) return []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [px, py] of poly) {
    if (px < minX) minX = px
    if (py < minY) minY = py
    if (px > maxX) maxX = px
    if (py > maxY) maxY = py
  }
  const flat = flatten(poly)
  const hits = tree.search(minX, minY, maxX, maxY)
  return hits.filter((i) => insideFlat(xy[2 * i], xy[2 * i + 1], flat)).sort((a, b) => a - b)
}

/** Whether any dot lies within `r` of (wx, wy); with no index every dot is checked. */
export function dotWithin(tree: Flatbush | null, xy: Float32Array, wx: number, wy: number, r: number): boolean {
  const limit = r * r
  const near = (i: number) => (xy[2 * i] - wx) ** 2 + (xy[2 * i + 1] - wy) ** 2 <= limit
  if (tree !== null) return tree.search(wx - r, wy - r, wx + r, wy + r, near).length > 0
  const n = Math.floor(xy.length / 2)
  for (let i = 0; i < n; i++) if (near(i)) return true
  return false
}

/** Drops points closer than `minSpacing` to the last kept one; the first and last always stay. */
export function thinPath(points: readonly LassoPoint[], minSpacing: number): [number, number][] {
  if (points.length <= 2) return points.map(([x, y]) => [x, y])
  const kept: [number, number][] = [[points[0][0], points[0][1]]]
  const limit = minSpacing * minSpacing
  for (let i = 1; i < points.length - 1; i++) {
    const [lx, ly] = kept[kept.length - 1]
    const [x, y] = points[i]
    if ((x - lx) ** 2 + (y - ly) ** 2 >= limit) kept.push([x, y])
  }
  const last = points[points.length - 1]
  kept.push([last[0], last[1]])
  return kept
}
