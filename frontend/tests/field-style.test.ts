// The class maths the legend and the readout use, mirrored against the
// shader in float32, and the rule that turns a request into what is drawn.
// Test values sit at class middles, never on an edge (research Pitfall 3).

import { describe, expect, it } from 'vitest'
import { classColour, classEdges, classOf, classTexelIndices, ramp } from '../src/gl/colormap'
import {
  DEFAULT_STYLE,
  ONE_CLASS_EMPTY,
  ONE_CLASS_EQUAL,
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

  it('never adds a note while continuous', () => {
    for (const c of [ctx, { ...ctx, limits: [5, 5] as [number, number] }, { ...ctx, valued: false }]) {
      const { effective, notes } = resolveStyle(DEFAULT_STYLE, c)
      expect(effective.classes).toBe(0)
      expect(notes).toEqual({ classes: null, symmetric: null, texture: null })
    }
  })
})
