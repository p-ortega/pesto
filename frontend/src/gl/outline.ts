// The outer edges of a set of cells, for ringing many cells at once (LINK-02).
// A pilot point can reach thousands of cells, and a ring round each one reads
// as noise, so a large set draws as the outline of the whole set instead.

/** Up to this many cells each get their own ring; more draw as one outline. */
export const RING_EACH_MAX = 8

/** At most this many cells are outlined; the caller counts and reports the rest. */
export const OUTLINE_MAX_CELLS = 20_000

/** Every undirected edge that appears exactly once across `cells`, as vertex
 *  index pairs `(a, b)` into `positions`. Cells hold their own unshared copy
 *  of every vertex, so an edge is matched by its end points' coordinates, not
 *  by vertex index. A cell with no ring is skipped and counted in `skipped`;
 *  a cell listed twice counts once. On a mesh with hanging nodes some shared
 *  edges do not match and show as extra inner lines, which is harmless. */
export function outlineEdges(
  rings: ReadonlyArray<readonly [number, number] | null>,
  positions: Float32Array,
  cells: readonly number[],
): { edges: Uint32Array; skipped: number } {
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length)
  // Each distinct point gets a small integer id, keyed by its x and y bit patterns.
  const pointIds = new Map<number, Map<number, number>>()
  const pointOf = (v: number): number => {
    // -0 and 0 are the same place but have different bits.
    const xb = positions[2 * v] === 0 ? 0 : bits[2 * v]
    const yb = positions[2 * v + 1] === 0 ? 0 : bits[2 * v + 1]
    let byY = pointIds.get(xb)
    if (!byY) {
      byY = new Map()
      pointIds.set(xb, byY)
    }
    let id = byY.get(yb)
    if (id === undefined) {
      id = nextPoint++
      byY.set(yb, id)
    }
    return id
  }
  let nextPoint = 0

  const seenCells = new Set<number>()
  const ends: number[] = []
  const pointPairs: number[] = []
  let skipped = 0
  for (const cell of cells) {
    if (seenCells.has(cell)) continue
    seenCells.add(cell)
    const ring = rings[cell]
    if (!ring) {
      skipped += 1
      continue
    }
    const [start, count] = ring
    for (let i = 0; i < count; i++) {
      const a = start + i
      const b = start + ((i + 1) % count)
      ends.push(a, b)
      pointPairs.push(pointOf(a), pointOf(b))
    }
  }

  // Point ids stay well under 2**26 for any cell count up to the cap, so the
  // pair fits exactly in one number.
  const span = nextPoint + 1
  const keys = new Float64Array(pointPairs.length / 2)
  const seen = new Map<number, number>()
  for (let e = 0; e < keys.length; e++) {
    const p = pointPairs[2 * e]
    const q = pointPairs[2 * e + 1]
    const key = p < q ? p * span + q : q * span + p
    keys[e] = key
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }

  const out: number[] = []
  for (let e = 0; e < keys.length; e++) {
    if (seen.get(keys[e]) === 1) out.push(ends[2 * e], ends[2 * e + 1])
  }
  return { edges: new Uint32Array(out), skipped }
}
