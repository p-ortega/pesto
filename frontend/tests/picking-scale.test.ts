// @vitest-environment node
// Cell picking at the size of the largest benchmark model: 504,100 cells,
// 1,008,200 triangles. Times the index build and 1,000 warm picks against the
// limits pesto bench reports (SpeedLimits.pick_index_build_ms and pick_p95_ms).
// pesto bench itself does not run Node, so this test is where picking is measured.

import { describe, expect, it } from 'vitest'
import { pickAtWorld, preparePickIndex } from '../src/gl/picking'
import { nearestRankP95 } from './visual/bench-json'
import { linearPickAtWorld } from './support/linear-pick'
import { pickLimits } from './support/pick-limits'
import { quadMesh, seededRandom } from './support/pick-mesh'

const SIDE = 710
const WARM_PICKS = 1000
const AGREEMENT_POINTS = 300
const LINEAR_SAMPLES = 20

describe('cell picking at a million triangles', () => {
  it('builds the index and picks within the limits, and agrees with the linear scan', () => {
    const limits = pickLimits()
    const mesh = quadMesh(SIDE, SIDE, { seed: 1 })
    expect(mesh.nCells).toBe(504_100)
    expect(mesh.indices.length / 3).toBe(1_008_200)

    const buildStart = performance.now()
    preparePickIndex(mesh)
    const buildMs = performance.now() - buildStart

    const random = seededRandom(99)
    const durations: number[] = []
    for (let n = 0; n < WARM_PICKS; n++) {
      const x = random() * SIDE
      const y = random() * SIDE
      const start = performance.now()
      pickAtWorld(mesh, x, y)
      durations.push(performance.now() - start)
    }
    const p95 = nearestRankP95(durations)
    if (p95 === null) throw new Error('no pick durations were recorded')

    const linearDurations: number[] = []
    for (let n = 0; n < LINEAR_SAMPLES; n++) {
      const start = performance.now()
      linearPickAtWorld(mesh, random() * SIDE, random() * SIDE)
      linearDurations.push(performance.now() - start)
    }
    const linearMean = linearDurations.reduce((sum, value) => sum + value, 0) / linearDurations.length

    console.log(
      `pick index build ${buildMs.toFixed(0)} ms, warm pick p95 ${p95.toFixed(3)} ms, ` +
        `linear scan mean ${linearMean.toFixed(2)} ms`,
    )

    let disagreements = 0
    for (let n = 0; n < AGREEMENT_POINTS; n++) {
      const x = random() * SIDE
      const y = random() * SIDE
      if (pickAtWorld(mesh, x, y) !== linearPickAtWorld(mesh, x, y)) disagreements++
    }
    expect(disagreements).toBe(0)
    expect(buildMs).toBeLessThanOrEqual(limits.pick_index_build_ms)
    expect(p95).toBeLessThanOrEqual(limits.pick_p95_ms)
  }, 30_000)
})
