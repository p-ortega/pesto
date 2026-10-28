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
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
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
  const hits = tree.search(minX, minY, maxX, maxY)
  return hits.filter((i) => pointInPolygon(xy[2 * i], xy[2 * i + 1], poly)).sort((a, b) => a - b)
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
