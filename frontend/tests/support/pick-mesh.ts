// Meshes and random numbers for the picking tests. Every random draw comes
// from a seeded generator so a failure can be replayed.

import type { MeshData } from '../../src/gl/mesh-layer'

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface QuadMeshOptions {
  jitter?: number
  seed?: number
  // List the cells' triangles from the last cell to the first.
  reverse?: boolean
}

// nx by ny unit quads, four unshared vertices per cell (the fan_polygons
// layout), two triangles per cell, cell index = row * nx + column. Jitter
// moves the shared grid corners, so neighbouring cells still meet exactly.
export function quadMesh(nx: number, ny: number, options: QuadMeshOptions = {}): MeshData {
  const { jitter = 0, seed = 1, reverse = false } = options
  const random = seededRandom(seed)
  const gx = new Float32Array((nx + 1) * (ny + 1))
  const gy = new Float32Array((nx + 1) * (ny + 1))
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      gx[j * (nx + 1) + i] = i + (random() - 0.5) * jitter
      gy[j * (nx + 1) + i] = j + (random() - 0.5) * jitter
    }
  }
  const nCells = nx * ny
  const positions = new Float32Array(nCells * 8)
  const cellIndex = new Float32Array(nCells * 4)
  const indices = new Uint32Array(nCells * 6)
  for (let slot = 0; slot < nCells; slot++) {
    const cell = reverse ? nCells - 1 - slot : slot
    const i = cell % nx
    const j = Math.floor(cell / nx)
    const corners = [
      j * (nx + 1) + i,
      j * (nx + 1) + i + 1,
      (j + 1) * (nx + 1) + i + 1,
      (j + 1) * (nx + 1) + i,
    ]
    const v0 = slot * 4
    for (let k = 0; k < 4; k++) {
      positions[(v0 + k) * 2] = gx[corners[k]]
      positions[(v0 + k) * 2 + 1] = gy[corners[k]]
      cellIndex[v0 + k] = cell
    }
    indices.set([v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3], slot * 6)
  }
  return { positions, cellIndex, indices, nCells }
}

// Points within `spread` of the triangle edges and corners of a mesh.
export function nearEdgePoints(
  mesh: MeshData,
  count: number,
  spread: number,
  random: () => number,
): Array<[number, number]> {
  const { positions, indices } = mesh
  const nTri = indices.length / 3
  const points: Array<[number, number]> = []
  for (let n = 0; n < count; n++) {
    const t = Math.floor(random() * nTri)
    const from = indices[t * 3 + Math.floor(random() * 3)]
    const to = indices[t * 3 + Math.floor(random() * 3)]
    // One in five probes sits on a corner; the rest slide along an edge.
    const s = n % 5 === 0 ? 0 : random()
    const x = positions[from * 2] + s * (positions[to * 2] - positions[from * 2])
    const y = positions[from * 2 + 1] + s * (positions[to * 2 + 1] - positions[from * 2 + 1])
    points.push([x + (random() * 2 - 1) * spread, y + (random() * 2 - 1) * spread])
  }
  return points
}
