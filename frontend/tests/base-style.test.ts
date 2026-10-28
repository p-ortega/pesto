// One definition of how base is drawn and named, for every chart and legend.

import { describe, expect, it } from 'vitest'
import { BASE_STYLE, baseLegendFor } from '../src/ui/charts/base-style'

describe('BASE_STYLE', () => {
  it('draws base as a bold line or a larger marker and names it base', () => {
    expect(BASE_STYLE.lineWidth).toBe(2.5)
    expect(BASE_STYLE.markerRadius).toBe(4.5)
    // Larger than the spaghetti's ordinary marker radius of 3.
    expect(BASE_STYLE.markerRadius).toBeGreaterThan(3)
    expect(BASE_STYLE.label).toBe('base')
    expect(BASE_STYLE.legend).toBe('base: the bold line, in the colour of its iteration')
  })

  it('cannot be changed by a caller', () => {
    expect(Object.isFrozen(BASE_STYLE)).toBe(true)
  })

  it('holds no colour, since base takes its iteration colour', () => {
    expect(Object.keys(BASE_STYLE).sort()).toEqual(['label', 'legend', 'lineWidth', 'markerRadius'])
  })
})

describe('baseLegendFor', () => {
  it('gives the base legend when the iteration has a base realization', () => {
    expect(baseLegendFor(3, true)).toBe(BASE_STYLE.legend)
  })

  it('says the iteration has no base realization when it has none', () => {
    expect(baseLegendFor(0, false)).toBe('no base realization in iteration 0')
    expect(baseLegendFor(7, false)).toBe('no base realization in iteration 7')
  })
})
