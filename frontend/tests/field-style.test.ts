// The class maths the legend and the readout use, mirrored against the
// shader in float32, and the rule that turns a request into what is drawn.
// Test values sit at class middles, never on an edge (research Pitfall 3).

import { describe, expect, it } from 'vitest'
import { classColour, classEdges, classOf, classTexelIndices, ramp, swatchCssAngle, symmetricLimits, textureAngles } from '../src/gl/colormap'
import {
  DEFAULT_STYLE,
  ONE_CLASS_EMPTY,
  ONE_CLASS_EQUAL,
  SYMMETRIC_LOG_REASON,
  SYMMETRIC_MANUAL_REASON,
  SYMMETRIC_TURNED_OFF_PREFIX,
  TEXTURE_CLASSES_NOTE,
  TEXTURE_DOTS_REASON,
  classLabel,
  followLimits,
  isClassCount,
  resolveStyle,
  type StyleContext,
} from '../src/gl/field-style'

const f = Math.fround

// The shader's own sums in float32: v_norm in the vertex shader, then floor(v_norm * n).
function shaderClass(value: number, limits: [number, number], n: number): number {
  const span = Math.max(f(f(limits[1]) - f(limits[0])), 1e-20)
  const norm = Math.min(Math.max(f(f(f(value) - f(limits[0])) / f(span)), 0), 1)
  return Math.min(Math.floor(f(norm * n)), n - 1)
}

describe('classEdges', () => {
  it('gives n + 1 equal steps between the limits', () => {
    expect(classEdges([0, 9], 9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('steps in the drawn scale, so log10 limits give equal log10 steps', () => {
    expect(classEdges([-1, 2], 3)).toEqual([-1, 0, 1, 2])
  })
})

describe('classOf', () => {
  for (const n of [7, 9, 11]) {
    for (const limits of [
      [0, 1],
      [-5, 5],
      [1e3, 2e3],
    ] as Array<[number, number]>) {
      it(`puts each class middle in its own class (n ${n}, limits ${limits.join(' to ')})`, () => {
        const edges = classEdges(limits, n)
        for (let k = 0; k < n; k++) {
          const middle = (edges[k] + edges[k + 1]) / 2
          expect(classOf(middle, limits, n)).toBe(k)
        }
      })
    }
  }

  it('puts a value beyond the limits in the end classes', () => {
    expect(classOf(-100, [0, 9], 9)).toBe(0)
    expect(classOf(100, [0, 9], 9)).toBe(8)
    expect(classOf(9, [0, 9], 9)).toBe(8)
  })

  it('gives -1 for a value that is not finite', () => {
    expect(classOf(Number.NaN, [0, 9], 9)).toBe(-1)
    expect(classOf(Number.POSITIVE_INFINITY, [0, 9], 9)).toBe(-1)
    expect(classOf(Number.NEGATIVE_INFINITY, [0, 9], 9)).toBe(-1)
  })

  it('agrees with the float32 shader sum one ulp either side of every edge', () => {
    const limits: [number, number] = [0.1, 0.7]
    for (const n of [7, 9, 11]) {
      for (const edge of classEdges(limits, n)) {
        const e = f(edge)
        const below = e - Math.abs(e) * 2 ** -23
        const above = e + Math.abs(e) * 2 ** -23
        for (const v of [f(below), f(above)]) {
          expect(classOf(v, limits, n)).toBe(shaderClass(v, limits, n))
        }
      }
    }
  })

  it('gives one class for equal limits without dividing by zero', () => {
    expect(classOf(5, [5, 5], 1)).toBe(0)
    expect(classOf(6, [5, 5], 1)).toBe(0)
  })
})

describe('classColour', () => {
  it('reads the ramp entry nearest each class middle', () => {
    const table = ramp('viridis')
    for (const n of [7, 9, 11]) {
      for (let k = 0; k < n; k++) {
        const i = Math.round(((k + 0.5) / n) * 255)
        expect(classColour(k, n, table)).toEqual([table[i * 4], table[i * 4 + 1], table[i * 4 + 2]])
      }
    }
  })

  it('rounds the 42.5 half of class 1 of 9 up, on the CPU, not in the shader', () => {
    expect(classTexelIndices(9)[1]).toBe(43)
  })

  it('reads the middle entry for the one-class case', () => {
    expect(classTexelIndices(1)).toEqual([128])
  })
})

describe('isClassCount', () => {
  it('accepts only the four offered numbers', () => {
    expect([0, 7, 9, 11].every(isClassCount)).toBe(true)
    expect(isClassCount(5)).toBe(false)
    expect(isClassCount('9')).toBe(false)
    expect(isClassCount(true)).toBe(false)
    expect(isClassCount(null)).toBe(false)
  })
})

describe('resolveStyle', () => {
  const ctx: StyleContext = { scale: 'linear', limitsMode: 'robust', drawsAsPoints: false, limits: [0, 1], valued: true }
  const nine = { ...DEFAULT_STYLE, classes: 9 as const }

  it('draws the requested classes when the limits can be split', () => {
    const { effective, notes } = resolveStyle(nine, ctx)
    expect(effective.classes).toBe(9)
    expect(notes.classes).toBeNull()
  })

  it('draws one class, with the reason, when the limits are equal', () => {
    const { effective, notes } = resolveStyle(nine, { ...ctx, limits: [5, 5] })
    expect(effective.classes).toBe(1)
    expect(notes.classes).toBe(ONE_CLASS_EQUAL)
  })

  it('draws one class, with the reason, when the limits run backwards or are not finite', () => {
    expect(resolveStyle(nine, { ...ctx, limits: [6, 5] }).effective.classes).toBe(1)
    const nan = resolveStyle(nine, { ...ctx, limits: [Number.NaN, 1] })
    expect(nan.effective.classes).toBe(1)
    expect(nan.notes.classes).toBe(ONE_CLASS_EQUAL)
  })

  it('draws one class, with the reason, when no cell has a value', () => {
    const { effective, notes } = resolveStyle(nine, { ...ctx, valued: false })
    expect(effective.classes).toBe(1)
    expect(notes.classes).toBe(ONE_CLASS_EMPTY)
  })

  it('never adds a note while continuous, whatever the limits', () => {
    for (const c of [ctx, { ...ctx, limits: [5, 5] as [number, number] }, { ...ctx, valued: false }]) {
      const { effective, notes } = resolveStyle(DEFAULT_STYLE, c)
      expect(effective.classes).toBe(0)
      expect(notes).toEqual({ classes: null, symmetric: null, texture: null })
    }
  })
})

describe('classLabel', () => {
  const nine = { classes: 9, symmetric: false, texture: false }

  it('names the class and its edges', () => {
    expect(classLabel(2.5, [0, 9], nine, 'linear')).toBe('class 3 of 9 (2 to 3)')
  })

  it('says the edges are log10 numbers on a log10 scale', () => {
    expect(classLabel(0.5, [-1, 2], { ...nine, classes: 3 }, 'log10')).toBe('class 2 of 3 (log₁₀ 0 to 1)')
  })

  it('gives nothing while continuous or for a value that is not finite', () => {
    expect(classLabel(2.5, [0, 9], { ...nine, classes: 0 }, 'linear')).toBeNull()
    expect(classLabel(Number.NaN, [0, 9], nine, 'linear')).toBeNull()
  })

  it('names the one class by the limits', () => {
    expect(classLabel(5, [5, 5], { ...nine, classes: 1 }, 'linear')).toBe('class 1 of 1 (5 to 5)')
  })
})

describe('symmetricLimits', () => {
  it('centres the pair on zero at the larger absolute end', () => {
    expect(symmetricLimits([-2, 5])).toEqual([-5, 5])
    expect(symmetricLimits([3, 7])).toEqual([-7, 7])
    expect(symmetricLimits([-4, -1])).toEqual([-4, 4])
  })

  it('gives [0, 0] for zero limits, never a negative zero', () => {
    const [lo, hi] = symmetricLimits([0, 0])
    expect(Object.is(lo, 0)).toBe(true)
    expect(Object.is(hi, 0)).toBe(true)
  })
})

describe('resolveStyle with symmetric', () => {
  const ctx: StyleContext = { scale: 'linear', limitsMode: 'robust', drawsAsPoints: false, limits: [-2, 5], valued: true }
  const symmetric = { ...DEFAULT_STYLE, symmetric: true }

  it('draws symmetric on a linear scale with robust or min-max limits, with no note', () => {
    for (const limitsMode of ['robust', 'minmax'] as const) {
      const { effective, notes } = resolveStyle(symmetric, { ...ctx, limitsMode })
      expect(effective.symmetric).toBe(true)
      expect(notes.symmetric).toBeNull()
    }
  })

  it('refuses symmetric on log10 with the reason', () => {
    const { effective, notes } = resolveStyle(symmetric, { ...ctx, scale: 'log10' })
    expect(effective.symmetric).toBe(false)
    expect(notes.symmetric).toBe(SYMMETRIC_LOG_REASON)
    expect(SYMMETRIC_LOG_REASON).toBe('a log scale has no zero to centre on')
  })

  it('refuses symmetric under manual limits with the reason', () => {
    const { effective, notes } = resolveStyle(symmetric, { ...ctx, limitsMode: 'manual' })
    expect(effective.symmetric).toBe(false)
    expect(notes.symmetric).toBe(SYMMETRIC_MANUAL_REASON)
    expect(SYMMETRIC_MANUAL_REASON).toBe('manual limits are used as typed')
  })

  it('still gives the reason when symmetric was never asked for, so the switch is greyed with it', () => {
    expect(resolveStyle(DEFAULT_STYLE, { ...ctx, scale: 'log10' }).notes.symmetric).toBe(SYMMETRIC_LOG_REASON)
    expect(resolveStyle(DEFAULT_STYLE, { ...ctx, limitsMode: 'manual' }).notes.symmetric).toBe(SYMMETRIC_MANUAL_REASON)
    expect(resolveStyle(DEFAULT_STYLE, ctx).notes.symmetric).toBeNull()
  })

  it('splits the classes on the drawn symmetric limits, not the raw pair', () => {
    const { effective, notes } = resolveStyle({ ...symmetric, classes: 9 }, { ...ctx, limits: [3, 3] })
    expect(effective.classes).toBe(9)
    expect(notes.classes).toBeNull()
  })

  it('keeps one class for zero limits made symmetric', () => {
    const { effective } = resolveStyle({ ...symmetric, classes: 9 }, { ...ctx, limits: [0, 0] })
    expect(effective.symmetric).toBe(true)
    expect(effective.classes).toBe(1)
  })
})

describe('followLimits', () => {
  const symmetric = { ...DEFAULT_STYLE, classes: 9 as const, symmetric: true }

  it('turns a requested symmetric off on log10 and says why', () => {
    expect(followLimits(symmetric, 'log10', 'robust')).toEqual({
      style: { ...symmetric, symmetric: false },
      turnedOff: SYMMETRIC_LOG_REASON,
    })
  })

  it('turns a requested symmetric off under manual limits and says why', () => {
    expect(followLimits(symmetric, 'linear', 'manual')).toEqual({
      style: { ...symmetric, symmetric: false },
      turnedOff: SYMMETRIC_MANUAL_REASON,
    })
  })

  it('changes nothing otherwise', () => {
    expect(followLimits(symmetric, 'linear', 'minmax')).toEqual({ style: symmetric, turnedOff: null })
    expect(followLimits(DEFAULT_STYLE, 'log10', 'manual')).toEqual({ style: DEFAULT_STYLE, turnedOff: null })
  })

  it('has a prefix that reads as a full line with the reason', () => {
    expect(SYMMETRIC_TURNED_OFF_PREFIX + SYMMETRIC_LOG_REASON).toBe('symmetric was turned off: a log scale has no zero to centre on')
  })
})

describe('textureAngles and swatchCssAngle', () => {
  it('spaces N angles evenly over 0 to 180 degrees, lowest class first', () => {
    expect(textureAngles(7)).toEqual([0, 1, 2, 3, 4, 5, 6].map((k) => (k * 180) / 7))
    expect(textureAngles(9)[8]).toBe(160)
    expect(textureAngles(1)).toEqual([0])
  })

  it('turns a shader angle into the CSS gradient angle that draws the same lines', () => {
    expect(swatchCssAngle(45)).toBe(315)
    expect(swatchCssAngle(0)).toBe(0)
    expect(swatchCssAngle(160)).toBe(200)
  })
})

describe('resolveStyle with texture', () => {
  const ctx: StyleContext = { scale: 'linear', limitsMode: 'robust', drawsAsPoints: false, limits: [0, 1], valued: true }

  it('raises continuous to 7 classes and says so', () => {
    const { effective, notes } = resolveStyle({ ...DEFAULT_STYLE, texture: true }, ctx)
    expect(effective.texture).toBe(true)
    expect(effective.classes).toBe(7)
    expect(notes.texture).toBe(TEXTURE_CLASSES_NOTE)
  })

  it('keeps 9 classes with no note', () => {
    const { effective, notes } = resolveStyle({ classes: 9, symmetric: false, texture: true }, ctx)
    expect(effective).toEqual({ classes: 9, symmetric: false, texture: true })
    expect(notes.texture).toBeNull()
  })

  it('refuses texture on a group drawn as dots, with the reason, and still applies the classes', () => {
    const { effective, notes } = resolveStyle({ classes: 9, symmetric: false, texture: true }, { ...ctx, drawsAsPoints: true })
    expect(effective.texture).toBe(false)
    expect(effective.classes).toBe(9)
    expect(notes.texture).toBe(TEXTURE_DOTS_REASON)
  })

  it('gives the dots reason even when texture was not asked for, so the switch can say why it is grey', () => {
    const { effective, notes } = resolveStyle({ classes: 7, symmetric: false, texture: false }, { ...ctx, drawsAsPoints: true })
    expect(effective.texture).toBe(false)
    expect(notes.texture).toBe(TEXTURE_DOTS_REASON)
  })

  it('combines with the one-class rule: one class, texture still on', () => {
    const { effective, notes } = resolveStyle({ ...DEFAULT_STYLE, texture: true }, { ...ctx, limits: [5, 5] })
    expect(effective.classes).toBe(1)
    expect(effective.texture).toBe(true)
    expect(notes.classes).toBe(ONE_CLASS_EQUAL)
  })

  it('leaves texture off when it was not asked for', () => {
    const { effective, notes } = resolveStyle({ classes: 7, symmetric: false, texture: false }, ctx)
    expect(effective.texture).toBe(false)
    expect(notes.texture).toBeNull()
  })
})
