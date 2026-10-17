// Screen point to grid cell: a Flatbush index over the triangles' boxes,
// built once per mesh, then the exact barycentric test on each hit. Ties on a
// shared edge or corner go to the lowest triangle index, as the old linear scan
// did (kept in tests/support/linear-pick.ts), so no click changes its answer.

import Flatbush from 'flatbush'
import type { MeshData } from './mesh-layer'

interface PickIndex {
  tree: Flatbush
  // Search box half-width, so a point a rounding error outside a box still finds its triangle.
  pad: number
}

// null marks a mesh with no triangles: Flatbush refuses to build an empty index.
const indexes = new WeakMap<MeshData, PickIndex | null>()

const PAD_FRACTION = 1e-6
const NODE_SIZE = 16

function buildIndex(mesh: MeshData): PickIndex | null {
  const { positions, indices } = mesh
  const nTri = Math.floor(indices.length / 3)
  if (nTri === 0) return null

  // Float32 boxes are exact here because the vertex positions are float32.
  const tree = new Flatbush(nTri, NODE_SIZE, Float32Array)
  let lowX = Infinity
  let lowY = Infinity
  let highX = -Infinity
  let highY = -Infinity
  for (let t = 0; t < nTri * 3; t += 3) {
    const a = indices[t] * 2
    const b = indices[t + 1] * 2
    const c = indices[t + 2] * 2
    const minX = Math.min(positions[a], positions[b], positions[c])
    const minY = Math.min(positions[a + 1], positions[b + 1], positions[c + 1])
    const maxX = Math.max(positions[a], positions[b], positions[c])
    const maxY = Math.max(positions[a + 1], positions[b + 1], positions[c + 1])
    tree.add(minX, minY, maxX, maxY)
    if (minX < lowX) lowX = minX
    if (minY < lowY) lowY = minY
    if (maxX > highX) highX = maxX
    if (maxY > highY) highY = maxY
  }
  tree.finish()
  const span = Math.max(highX - lowX, highY - lowY)
  return { tree, pad: Number.isFinite(span) ? span * PAD_FRACTION : 0 }
}

export function preparePickIndex(mesh: MeshData): void {
  if (!indexes.has(mesh)) indexes.set(mesh, buildIndex(mesh))
}

export function pickAtWorld(mesh: MeshData, wx: number, wy: number): number | null {
  preparePickIndex(mesh)
  const index = indexes.get(mesh)
  if (index === null || index === undefined) return null

  const { positions, cellIndex, indices } = mesh
  const hits = index.tree.search(wx - index.pad, wy - index.pad, wx + index.pad, wy + index.pad)
  let best = -1
  for (const t of hits) {
    if (best !== -1 && t > best) continue
    const a = indices[t * 3]
    const b = indices[t * 3 + 1]
    const c = indices[t * 3 + 2]
    const ax = positions[a * 2]
    const ay = positions[a * 2 + 1]
    const bx = positions[b * 2]
    const by = positions[b * 2 + 1]
    const cx = positions[c * 2]
    const cy = positions[c * 2 + 1]
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (d === 0) continue
    const u = ((by - cy) * (wx - cx) + (cx - bx) * (wy - cy)) / d
    const v = ((cy - ay) * (wx - cx) + (ax - cx) * (wy - cy)) / d
    if (u >= 0 && v >= 0 && u + v <= 1) best = t
  }
  return best === -1 ? null : cellIndex[indices[best * 3]]
}
