// A click on the section lands on exactly one quad by stated rules (D-25), a pinched layer is
// listed rather than picked (D-41), and the cell it names is the plan's own cell id (Pitfall 5).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSection, type SectionAnswer } from '../src/data/section'
import { pickSection, pinchedLayers } from '../src/data/section-pick'
import type { MeshData } from '../src/gl/mesh-layer'
import { pickAtWorld } from '../src/gl/picking'

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'section-tracer-answer.json'), 'utf8'),
) as Record<string, unknown>

interface Pieces {
  nlay: number
  cell: number[]
  s0: number[]
  s1: number[]
  /** Piece-major, nlay + 1 interfaces per piece; null reads as no finite elevation. */
  z: Array<number | null>
  status: number[]
}

function answerOf(p: Pieces): SectionAnswer {
  return parseSection({ ...FIXTURE, nlay: p.nlay, n_pieces: p.cell.length, cell: p.cell, s0: p.s0, s1: p.s1, z: p.z, status: p.status })
}

describe('the section pick rules', () => {
  it('names the cell by the answer cell id of the piece under the click', () => {
    const answer = answerOf({ nlay: 1, cell: [7, 2], s0: [0, 1], s1: [1, 2], z: [10, 0, 10, 0], status: [0, 0] })
    expect(pickSection(answer, 0.5, 5)).toMatchObject({ piece: 0, cell: 7 })
    expect(pickSection(answer, 1.5, 5)).toMatchObject({ piece: 1, cell: 2 })
  })

  it('gives a piece boundary to the lower-distance piece', () => {
    const answer = answerOf({ nlay: 1, cell: [7, 2], s0: [0, 1], s1: [1, 2], z: [10, 0, 10, 0], status: [0, 0] })
    expect(pickSection(answer, 1, 5)).toMatchObject({ piece: 0, cell: 7 })
  })

  it('never picks a pinched layer: a click at its elevation goes to the upper of the layers that meet there', () => {
    const answer = answerOf({ nlay: 3, cell: [4], s0: [0], s1: [1], z: [10, 6, 6, 0], status: [0, 3, 0] })
    expect(pickSection(answer, 0.5, 6)).toMatchObject({ layer: 0 })
    expect(pickSection(answer, 0.5, 5.999)).toMatchObject({ layer: 2 })
    for (const z of [10, 8, 6, 3, 0]) expect(pickSection(answer, 0.5, z)?.layer).not.toBe(1)
  })

  it('picks a quad whose bottom is above its top between the two values, with its status', () => {
    const answer = answerOf({ nlay: 2, cell: [4], s0: [0], s1: [1], z: [5, 8, 8], status: [4, 3] })
    expect(pickSection(answer, 0.5, 6.5)).toMatchObject({ layer: 0, status: 4, top: 5, bottom: 8 })
    expect(pickSection(answer, 0.5, 8)).toMatchObject({ layer: 0, status: 4 })
  })

  it('never picks a layer with an elevation that is not finite, and still picks the layers clear of it', () => {
    const answer = answerOf({ nlay: 4, cell: [4], s0: [0], s1: [1], z: [10, 8, null, 4, 0], status: [0, 5, 5, 0] })
    expect(pickSection(answer, 0.5, 9)).toMatchObject({ layer: 0 })
    expect(pickSection(answer, 0.5, 2)).toMatchObject({ layer: 3 })
    expect(pickSection(answer, 0.5, 6)).toBeNull()
    expect(pickSection(answer, 0.5, 5)).toBeNull()
  })
})

describe('the pinched layers of a piece', () => {
  it('lists the pinched layers in order', () => {
    const answer = answerOf({
      nlay: 6,
      cell: [4, 5],
      s0: [0, 1],
      s1: [1, 2],
      z: [10, 9, 8, 7, 7, 7, 0, 10, 9, 8, 7, 6, 5, 0],
      status: [0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0],
    })
    expect(pinchedLayers(answer, 0)).toEqual([3, 4])
    expect(pinchedLayers(answer, 1)).toEqual([])
  })

  it('lists nothing for a piece the answer does not hold', () => {
    const answer = answerOf({ nlay: 1, cell: [4], s0: [0], s1: [1], z: [10, 0], status: [0] })
    expect(pinchedLayers(answer, 1)).toEqual([])
    expect(pinchedLayers(answer, -1)).toEqual([])
  })
})

// The tracer grid's rings in model coordinates; world = model + (1000, 2000).
const RINGS: Array<Array<[number, number]>> = [
  [[0, 0], [1, 0], [1, 1], [0, 1]],
  [[1, 0], [2, 0], [2, 1], [1.5, 1.6], [1, 1]],
  [[2, 1], [3, 0], [3.6, 0.6], [3.2, 1.6], [2.4, 2.0], [1.5, 1.6]],
]
const TO_WORLD: [number, number] = [1000, 2000]
const ORIGIN: [number, number] = [1001.8, 2001.0]

// The plan mesh as the server fans it: each ring's vertices unshared and in order, minus the origin.
function tracerPlanMesh(): MeshData {
  const positions: number[] = []
  const cellIndex: number[] = []
  const indices: number[] = []
  RINGS.forEach((ring, cell) => {
    const start = cellIndex.length
    for (const [x, y] of ring) {
      positions.push(x + TO_WORLD[0] - ORIGIN[0], y + TO_WORLD[1] - ORIGIN[1])
      cellIndex.push(cell)
    }
    for (let i = 1; i < ring.length - 1; i++) indices.push(start, start + i, start + i + 1)
  })
  return {
    positions: new Float32Array(positions),
    cellIndex: new Float32Array(cellIndex),
    indices: new Uint32Array(indices),
    nCells: RINGS.length,
  }
}

describe('one id for one cell in both views', () => {
  it('gives the same cell id from the plan pick and the section pick at the middle of each piece', () => {
    const answer = parseSection(FIXTURE)
    const mesh = tracerPlanMesh()
    const [ax, ay] = answer.line.a
    const [bx, by] = answer.line.b
    for (let p = 0; p < answer.nPieces; p++) {
      const s = (answer.s0[p] + answer.s1[p]) / 2
      const t = s / answer.line.length
      const wx = ax + t * (bx - ax) - ORIGIN[0]
      const wy = ay + t * (by - ay) - ORIGIN[1]
      expect(pickSection(answer, s, 7.5)?.cell).toBe(pickAtWorld(mesh, wx, wy))
    }
  })

  it('names cell 1 on both views at distance 2.0, elevation 7.5', () => {
    const answer = parseSection(FIXTURE)
    expect(pickAtWorld(tracerPlanMesh(), 999.5 + 2.0 - ORIGIN[0], 2000.5 - ORIGIN[1])).toBe(1)
    expect(pickSection(answer, 2.0, 7.5)?.cell).toBe(1)
  })
})
