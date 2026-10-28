// The hatch mask and dot flags (D-21, D-25, D-29): which cells carry the
// at-bounds and conflict bits, and every item left out counted by reason.

import { describe, expect, it } from 'vitest'
import type { ParIdentity } from '../src/data/parmap'
import {
  HATCH_AT_BOUNDS,
  HATCH_CONFLICT,
  POINT_FLAG_AT_BOUNDS,
  POINT_FLAG_CONFLICT,
  POINT_FLAG_DIM,
  buildHatchMask,
  buildPointFlags,
  parameterCells,
  siteCells,
} from '../src/data/hatch-mask'

function par(parnme: string, pargp = 'hk'): ParIdentity {
  return { parnme, pargp, partrans: 'log' }
}

describe('bits', () => {
  it('keeps the at-bounds and conflict bits apart, in the mask and on the dots', () => {
    expect(HATCH_AT_BOUNDS).toBe(1)
    expect(HATCH_CONFLICT).toBe(2)
    expect(POINT_FLAG_AT_BOUNDS).toBe(1)
    expect(POINT_FLAG_CONFLICT).toBe(2)
    expect(POINT_FLAG_DIM).toBe(4)
  })
})

describe('parameterCells', () => {
  // Rows: p1 layer 0 cell 4, p2 layer 0 cell 5, p3 layer 0 cell 6, p4 layer 1 cell 7, p5 unplaced, no identity.
  const joined = [par('p1'), par('p2'), par('p3'), par('p4'), par('p5'), null]
  const cellArray = Int32Array.from([4, 5, 6, 7, -1, 9])
  const layerArray = Int32Array.from([0, 0, 0, 1, 0, 0])

  it('returns the cells and block rows of the named parameters on the drawn layer', () => {
    const out = parameterCells(new Set(['p1', 'p3']), joined, cellArray, layerArray, 0)
    expect(out.cells).toEqual([4, 6])
    expect(out.rows).toEqual([0, 2])
    expect(out.otherLayer).toBe(0)
    expect(out.unplaced).toBe(0)
    expect(out.unknown).toBe(0)
  })

  it('counts a parameter on another layer, an unplaced one and an unknown name', () => {
    const out = parameterCells(new Set(['p1', 'p4', 'p5', 'nope']), joined, cellArray, layerArray, 0)
    expect(out.cells).toEqual([4])
    expect(out.rows).toEqual([0])
    expect(out.otherLayer).toBe(1)
    expect(out.unplaced).toBe(1)
    expect(out.unknown).toBe(1)
  })

  it('names nothing and counts nothing for no names', () => {
    const out = parameterCells(new Set(), joined, cellArray, layerArray, 0)
    expect(out).toEqual({ cells: [], rows: [], otherLayer: 0, unplaced: 0, unknown: 0 })
  })
})

describe('siteCells', () => {
  // Site 10 layer 0 group 2; 11 layer 1 group 2; 12 unknown layer group 2; 13 unplaced group 2; 14 layer 0 group 3.
  const sites = {
    id: Int32Array.from([10, 11, 12, 13, 14]),
    cell: Int32Array.from([3, 4, 5, -1, 6]),
    layer: Int32Array.from([0, 1, -1, 0, 0]),
    groupIndex: Int32Array.from([2, 2, 2, 2, 3]),
  }

  it('hatches conflicted sites on the drawn layer and counts the rest by reason', () => {
    const out = siteCells(sites, { layer: 0, allLayers: false, groupIndex: null })
    expect(out.cells).toEqual([3, 6])
    expect(out.siteIds).toEqual([10, 14])
    expect(out.leftOut).toEqual({ otherLayer: 1, unknownLayer: 1, otherGroup: 0, unplaced: 1 })
  })

  it('lets sites of unknown layer join only with all layers on', () => {
    const out = siteCells(sites, { layer: 0, allLayers: true, groupIndex: null })
    expect(out.siteIds).toEqual([10, 11, 12, 14])
    expect(out.cells).toEqual([3, 4, 5, 6])
    expect(out.leftOut).toEqual({ otherLayer: 0, unknownLayer: 0, otherGroup: 0, unplaced: 1 })
  })

  it('limits the hatch to the coloured group and counts the other groups', () => {
    const out = siteCells(sites, { layer: 0, allLayers: false, groupIndex: 2 })
    expect(out.siteIds).toEqual([10])
    expect(out.leftOut).toEqual({ otherLayer: 1, unknownLayer: 1, otherGroup: 1, unplaced: 1 })
  })

  it('takes plain number lists as well as typed columns', () => {
    const out = siteCells(
      { id: [1, 2], cell: [0, 1], layer: [0, 0], groupIndex: [0, 0] },
      { layer: 0, allLayers: false, groupIndex: null },
    )
    expect(out.cells).toEqual([0, 1])
  })

  it('refuses columns of different lengths instead of pairing them by position', () => {
    expect(() =>
      siteCells(
        { id: [1, 2], cell: [0], layer: [0, 0], groupIndex: [0, 0] },
        { layer: 0, allLayers: false, groupIndex: null },
      ),
    ).toThrow(/length/)
  })
})

describe('buildHatchMask', () => {
  it('sets bit 0 for at-bounds cells and bit 1 for conflict cells', () => {
    const out = buildHatchMask(5, [1, 2], [2, 4])
    expect(Array.from(out.mask)).toEqual([0, 1, 3, 0, 2])
    expect(out.outOfRange).toBe(0)
  })

  it('never sets a cell outside the grid, and counts it', () => {
    const fromBounds = buildHatchMask(5, [1, 7], [])
    expect(Array.from(fromBounds.mask)).toEqual([0, 1, 0, 0, 0])
    expect(fromBounds.outOfRange).toBe(1)
    const fromConflict = buildHatchMask(5, [], [7])
    expect(Array.from(fromConflict.mask)).toEqual([0, 0, 0, 0, 0])
    expect(fromConflict.outOfRange).toBe(1)
    expect(buildHatchMask(5, [-1, 2.5], []).outOfRange).toBe(2)
  })

  it('is all zero for empty lists', () => {
    const out = buildHatchMask(4, [], [])
    expect(Array.from(out.mask)).toEqual([0, 0, 0, 0])
    expect(out.outOfRange).toBe(0)
  })
})

describe('buildPointFlags', () => {
  it('sets the dim, at-bounds and conflict bits per dot', () => {
    const flags = buildPointFlags(4, { dim: (i) => i === 0, atBounds: (i) => i === 1, conflict: (i) => i === 1 })
    expect(flags).toBeInstanceOf(Float32Array)
    expect(Array.from(flags)).toEqual([4, 3, 0, 0])
  })

  it('leaves a bit clear when its predicate is not given', () => {
    expect(Array.from(buildPointFlags(3, { dim: (i) => i !== 1 }))).toEqual([4, 0, 4])
    expect(Array.from(buildPointFlags(2, {}))).toEqual([0, 0])
  })
})
