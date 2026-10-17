// pickAtWorld looks the point up in a spatial index. These tests hold it to
// the M0 linear scan (tests/support/linear-pick.ts): same cell for every
// probe, shared edges and corners included. No GL context is involved.

import { describe, expect, it } from 'vitest'
import { pickAtWorld, preparePickIndex } from '../src/gl/picking'
import type { MeshData } from '../src/gl/mesh-layer'
import { linearPickAtWorld } from './support/linear-pick'
import { nearEdgePoints, quadMesh, seededRandom } from './support/pick-mesh'

// Two unit quads side by side, same layout as mesh-layer.test.ts's
// threeCellMesh (minus the third cell -- not needed here).
function twoCellMesh(): MeshData {
  const positions = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1])
  const cellIndex = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1])
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
  return { positions, cellIndex, indices, nCells: 2 }
}

function disagreements(mesh: MeshData, points: Array<[number, number]>): number {
  let count = 0
  for (const [x, y] of points) {
    if (pickAtWorld(mesh, x, y) !== linearPickAtWorld(mesh, x, y)) count++
  }
  return count
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

  it('gives a point on a shared edge to the lower triangle index, as the linear scan does', () => {
    const mesh = twoCellMesh()
    expect(linearPickAtWorld(mesh, 1, 0.5)).toBe(0)
    expect(pickAtWorld(mesh, 1, 0.5)).toBe(0)
  })

  it('gives a shared corner to whatever the linear scan gives', () => {
    const mesh = quadMesh(2, 2)
    const expected = linearPickAtWorld(mesh, 1, 1)
    expect(expected).toBe(0)
    expect(pickAtWorld(mesh, 1, 1)).toBe(expected)
  })

  it('agrees with the linear scan on 5,000 points within 1e-6 of the edges of a jittered mesh', () => {
    const mesh = quadMesh(40, 40, { jitter: 0.6, seed: 7 })
    const points = nearEdgePoints(mesh, 5000, 1e-6, seededRandom(11))
    expect(points.length).toBe(5000)
    expect(disagreements(mesh, points)).toBe(0)
  })

  it('agrees with the linear scan when the triangles are not in cell order', () => {
    const mesh = quadMesh(40, 40, { jitter: 0.6, seed: 7, reverse: true })
    const points = nearEdgePoints(mesh, 5000, 1e-6, seededRandom(13))
    expect(disagreements(mesh, points)).toBe(0)
    // On a shared edge the lower triangle index wins, which is now the higher cell.
    expect(pickAtWorld(mesh, 1, 0.5)).toBe(linearPickAtWorld(mesh, 1, 0.5))
  })

  it('agrees with the linear scan on points spread over and around the whole mesh', () => {
    const mesh = quadMesh(40, 40, { jitter: 0.6, seed: 3 })
    const random = seededRandom(5)
    const points: Array<[number, number]> = []
    for (let n = 0; n < 2000; n++) points.push([random() * 44 - 2, random() * 44 - 2])
    expect(disagreements(mesh, points)).toBe(0)
  })

  it('returns null for an empty mesh and builds nothing for it', () => {
    const mesh: MeshData = {
      positions: new Float32Array(0),
      cellIndex: new Float32Array(0),
      indices: new Uint32Array(0),
      nCells: 0,
    }
    expect(() => preparePickIndex(mesh)).not.toThrow()
    expect(pickAtWorld(mesh, 0, 0)).toBeNull()
  })

  it('skips a degenerate triangle, as the linear scan does', () => {
    const positions = new Float32Array([0, 0, 1, 1, 2, 2, 0, 0, 1, 0, 1, 1])
    const cellIndex = new Float32Array([0, 0, 0, 1, 1, 1])
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5])
    const mesh: MeshData = { positions, cellIndex, indices, nCells: 2 }
    expect(linearPickAtWorld(mesh, 1, 1)).toBe(1)
    expect(pickAtWorld(mesh, 1, 1)).toBe(1)
    expect(pickAtWorld(mesh, 0.5, 0.5)).toBe(linearPickAtWorld(mesh, 0.5, 0.5))
  })

  it('builds the index once per mesh', () => {
    const mesh = quadMesh(4, 4)
    preparePickIndex(mesh)
    const first = pickAtWorld(mesh, 2.5, 2.5)
    preparePickIndex(mesh)
    expect(pickAtWorld(mesh, 2.5, 2.5)).toBe(first)
  })
})
