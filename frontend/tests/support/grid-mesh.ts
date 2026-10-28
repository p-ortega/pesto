import type { MeshData } from '../../src/gl/mesh-layer'

// A cols x rows grid of unit squares, numbered row by row from the origin.
// Each cell has its own four vertices, as the server's fan_polygons writes them.
export function gridMesh(cols: number, rows: number): MeshData {
  const n = cols * rows
  const positions = new Float32Array(n * 8)
  const cellIndex = new Float32Array(n * 4)
  const indices = new Uint32Array(n * 6)
  for (let cell = 0; cell < n; cell++) {
    const x = cell % cols
    const y = Math.floor(cell / cols)
    positions.set([x, y, x + 1, y, x + 1, y + 1, x, y + 1], cell * 8)
    cellIndex.fill(cell, cell * 4, cell * 4 + 4)
    const v = cell * 4
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], cell * 6)
  }
  return { positions, cellIndex, indices, nCells: n }
}
