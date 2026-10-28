// The outer edges of a cell set: every undirected edge seen exactly once.

import { describe, expect, it } from 'vitest'
import { OUTLINE_MAX_CELLS, RING_EACH_MAX, outlineEdges } from '../src/gl/outline'
import { gridMesh } from './support/grid-mesh'

// Cell i of a fan_polygons mesh owns the four vertices from 4 * i.
function ringsOf(nCells: number): Array<[number, number] | null> {
  return Array.from({ length: nCells }, (_, i) => [4 * i, 4] as [number, number])
}

function edgePoints(edges: Uint32Array, positions: Float32Array): string[] {
  const out: string[] = []
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i]
    const b = edges[i + 1]
    const pa = `${positions[2 * a]},${positions[2 * a + 1]}`
    const pb = `${positions[2 * b]},${positions[2 * b + 1]}`
    out.push(pa < pb ? `${pa}-${pb}` : `${pb}-${pa}`)
  }
  return out.sort()
}

describe('outlineEdges', () => {
  it('exports the per-cell ring limit and the outline cap', () => {
    expect(RING_EACH_MAX).toBe(8)
    expect(OUTLINE_MAX_CELLS).toBe(20_000)
  })

  it('returns the 8 outer edges of a 2 x 2 block and none of the 4 inner ones', () => {
    const mesh = gridMesh(2, 2)
    const { edges, skipped } = outlineEdges(ringsOf(4), mesh.positions, [0, 1, 2, 3])
    expect(edges.length / 2).toBe(8)
    expect(skipped).toBe(0)
    expect(edgePoints(edges, mesh.positions)).toEqual(
      [
        '0,0-1,0', '1,0-2,0', '2,0-2,1', '2,1-2,2',
        '1,2-2,2', '0,2-1,2', '0,1-0,2', '0,0-0,1',
      ].sort(),
    )
  })

  it('returns all 4 edges of one cell', () => {
    const mesh = gridMesh(3, 1)
    expect(outlineEdges(ringsOf(3), mesh.positions, [1]).edges.length / 2).toBe(4)
  })

  it('returns all 8 edges of two cells that do not touch', () => {
    const mesh = gridMesh(3, 1)
    expect(outlineEdges(ringsOf(3), mesh.positions, [0, 2]).edges.length / 2).toBe(8)
  })

  it('cancels a shared edge by its end points, though the two cells hold their own copies of its vertices', () => {
    const mesh = gridMesh(2, 1)
    const { edges } = outlineEdges(ringsOf(2), mesh.positions, [0, 1])
    expect(edges.length / 2).toBe(6)
    expect(edgePoints(edges, mesh.positions)).not.toContain('1,0-1,1')
  })

  it('treats 0 and -0 as the same coordinate', () => {
    const mesh = gridMesh(2, 1)
    // Cell 0's copy of the shared corner (1, 0) becomes (1, -0); cell 1's stays (1, 0).
    mesh.positions[2 * 1 + 1] = -0
    expect(Object.is(mesh.positions[3], -0)).toBe(true)
    const { edges } = outlineEdges(ringsOf(2), mesh.positions, [0, 1])
    expect(edges.length / 2).toBe(6)
  })

  it('skips a cell with no ring and counts it', () => {
    const mesh = gridMesh(3, 1)
    const rings = ringsOf(3)
    rings[1] = null
    const { edges, skipped } = outlineEdges(rings, mesh.positions, [0, 1, 2, 7])
    expect(edges.length / 2).toBe(8)
    expect(skipped).toBe(2)
  })

  it('counts a cell listed twice once, so its edges do not cancel against themselves', () => {
    const mesh = gridMesh(2, 1)
    const { edges } = outlineEdges(ringsOf(2), mesh.positions, [0, 0, 1])
    expect(edges.length / 2).toBe(6)
  })

  it('outlines 20,000 cells quickly', () => {
    const mesh = gridMesh(200, 100)
    const cells = Array.from({ length: 20_000 }, (_, i) => i)
    const t0 = performance.now()
    const { edges } = outlineEdges(ringsOf(20_000), mesh.positions, cells)
    const ms = performance.now() - t0
    expect(edges.length / 2).toBe(2 * (200 + 100))
    // About 50 ms is the aim; the bound is loose so a busy machine does not fail it.
    expect(ms).toBeLessThan(250)
  })
})
