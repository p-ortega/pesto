// pickAtWorld's own point-in-triangle scan, extracted from the tracer's
// MeshLayer method into a plain function so it can run with no GL context
// at all -- views/map.ts calls it straight off the mesh arrays it already
// holds, on every canvas click.

import { describe, expect, it } from 'vitest'
import { pickAtWorld } from '../src/gl/picking'
import type { MeshData } from '../src/gl/mesh-layer'

// Two unit quads side by side, same layout as mesh-layer.test.ts's
// threeCellMesh (minus the third cell -- not needed here).
function twoCellMesh(): MeshData {
  const positions = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
  const cellIndex = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
  return { positions, cellIndex, indices, nCells: 2 }
}

describe('pickAtWorld', () => {
  it('returns the cell whose triangle contains the point', () => {
    const mesh = twoCellMesh()
    expect(pickAtWorld(mesh, 0.5, 0.5)).toBe(0)
    expect(pickAtWorld(mesh, 1.5, 0.5)).toBe(1)
  })

  it('returns null for a point outside every triangle', () => {
    const mesh = twoCellMesh()
    expect(pickAtWorld(mesh, 5, 5)).toBeNull()
    expect(pickAtWorld(mesh, -1, -1)).toBeNull()
  })
})
