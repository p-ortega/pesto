// Screen point to grid cell: a linear scan over the mesh's triangles,
// point-in-polygon on the CPU. Fine at this model class's scale (PROJECT.md
// notes 9,902-17,726 cells on the benchmarks) and avoids a second render
// pass or a spatial index -- a later problem, not this one.

import type { MeshData } from './mesh-layer'

export function pickAtWorld(mesh: MeshData, wx: number, wy: number): number | null {
  const { positions, cellIndex, indices } = mesh
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]
    const b = indices[t + 1]
    const c = indices[t + 2]
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
    if (u >= 0 && v >= 0 && u + v <= 1) return cellIndex[a]
  }
  return null
}
