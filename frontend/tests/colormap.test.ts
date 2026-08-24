// Pure functions over plain arrays -- no WebGL2 context needed for any of
// the eight behaviours below.

import { describe, expect, it } from 'vitest'
import { LimitsMemory, STOPS, applyScale, logIsUsable, normalize, ramp, scaleLimits, type ColormapName } from '../src/gl/colormap'

describe('ramp', () => {
  it('returns 256 RGBA entries for each of the nine names, and the reversed table is the forward table read backwards', () => {
    for (const name of Object.keys(STOPS) as ColormapName[]) {
      const forward = ramp(name)
      const reversed = ramp(name, true)
      expect(forward.length).toBe(256 * 4)
      expect(reversed.length).toBe(256 * 4)
      for (let i = 0; i < 256; i++) {
        const f = Array.from(forward.slice(i * 4, i * 4 + 4))
        const r = Array.from(reversed.slice((255 - i) * 4, (255 - i) * 4 + 4))
        expect(r).toEqual(f)
      }
    }
  })
})

describe('applyScale', () => {
  it('returns log10 of each positive value and NaN for each non-positive one, and leaves linear unchanged', () => {
    const values = new Float32Array([1, 10, 100, 0, -5, Number.NaN, Number.POSITIVE_INFINITY])

    const log = applyScale(values, 'log10')
    expect(log[0]).toBeCloseTo(0, 5)
    expect(log[1]).toBeCloseTo(1, 5)
    expect(log[2]).toBeCloseTo(2, 5)
    expect(Number.isNaN(log[3])).toBe(true)
    expect(Number.isNaN(log[4])).toBe(true)
    expect(Number.isNaN(log[5])).toBe(true)
    expect(Number.isNaN(log[6])).toBe(true)

    const linear = applyScale(values, 'linear')
    expect(Array.from(linear)).toEqual(Array.from(values))
  })
})

describe('logIsUsable', () => {
  it('returns the count of zero-or-negative finite entries; zero means log10 is usable', () => {
    expect(logIsUsable(new Float32Array([1, 2, 3]))).toBe(0)
    expect(logIsUsable(new Float32Array([1, 0, -2, 3, Number.NaN]))).toBe(2)
  })
})

describe('scaleLimits', () => {
  it("robust returns the 2nd/98th percentiles, minmax the finite extremes, manual the caller's own pair", () => {
    const values = new Float32Array(Array.from({ length: 100 }, (_, i) => i))

    expect(scaleLimits(values, 'robust')).toEqual([1, 98])
    expect(scaleLimits(values, 'minmax')).toEqual([0, 99])
    expect(scaleLimits(values, 'manual', [3, 7])).toEqual([3, 7])
  })

  it('a value at either limit normalises to 0 or 1, and a value beyond either limit clamps to the same end', () => {
    const limits: [number, number] = [10, 20]
    expect(normalize(10, limits)).toBe(0)
    expect(normalize(20, limits)).toBe(1)
    expect(normalize(5, limits)).toBe(0)
    expect(normalize(25, limits)).toBe(1)
  })

  it('does not produce NaN when every finite value in the field is identical', () => {
    const values = new Float32Array([5, 5, 5, 5])
    const [lo, hi] = scaleLimits(values, 'robust')
    expect(Number.isNaN(lo)).toBe(false)
    expect(Number.isNaN(hi)).toBe(false)
    expect(Number.isNaN(normalize(5, [lo, hi]))).toBe(false)
  })

  it('computes log10 limits from the log10-transformed array, never by taking log10 of linear-scale limits', () => {
    // One non-positive value among 99 positive, cubically skewed values.
    // applyScale drops the non-positive entry before scaleLimits ever sees
    // it, shifting the 2nd-percentile rank onto a different element than
    // the "take linear limits, then log them" route lands on.
    const values = new Float32Array([-1, ...Array.from({ length: 99 }, (_, i) => (i + 1) ** 3)])

    const limitsFromLog = scaleLimits(applyScale(values, 'log10'), 'robust')
    const linearLimits = scaleLimits(values, 'robust')
    const limitsFromLinearThenLog = applyScale(new Float32Array(linearLimits), 'log10')

    expect(limitsFromLog[0]).not.toBeCloseTo(limitsFromLinearThenLog[0], 3)
  })
})

describe('LimitsMemory', () => {
  it('returns the same limits for two different realizations of one statistic, and different limits after the statistic changes', () => {
    const memory = new LimitsMemory()
    memory.set('mean', [0, 10])

    expect(memory.get('mean')).toEqual([0, 10])
    expect(memory.get('mean')).toEqual([0, 10]) // a second realization of 'mean' reads the same entry
    expect(memory.get('std')).toBeUndefined()

    memory.set('std', [0, 1])
    expect(memory.get('std')).toEqual([0, 1])
    expect(memory.get('mean')).toEqual([0, 10]) // switching statistic left 'mean' untouched
  })
})
