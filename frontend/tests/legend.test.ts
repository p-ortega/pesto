// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { classColour, ramp } from '../src/gl/colormap'
import { ONE_CLASS_EQUAL } from '../src/gl/field-style'
import { renderLegend, type LegendOptions } from '../src/ui/legend'

const BASE_OPTIONS: LegendOptions = {
  colormap: 'viridis',
  reverse: false,
  limits: [1.5, 98.25],
  scale: 'log10',
  scaleInferred: true,
  limitsMode: 'robust',
  group: 'hk1',
  contested: 3,
  noValue: 12,
}

describe('renderLegend', () => {
  it('renders all seven fields, with tabular-nums on the end values and the group name truncated with a title', () => {
    const el = document.createElement('div')
    renderLegend(el, BASE_OPTIONS)

    expect(el.textContent).toContain('hk1')
    expect(el.textContent).toContain('3 cells contested')
    expect(el.textContent).toContain('12 cells no value')
    expect(el.textContent).toContain('Robust 2-98%')

    const numberSpans = Array.from(el.querySelectorAll('.tabular-nums'))
    expect(numberSpans.length).toBeGreaterThanOrEqual(2)
    expect(numberSpans.some((span) => span.textContent === (1.5).toPrecision(4))).toBe(true)
    expect(numberSpans.some((span) => span.textContent === (98.25).toPrecision(4))).toBe(true)

    const groupEl = el.querySelector('.truncate') as HTMLElement
    expect(groupEl.classList.contains('truncate')).toBe(true)
    expect(groupEl.getAttribute('title')).toBe('hk1')
  })

  it('renders no legend element at all when no field is drawn', () => {
    const el = document.createElement('div')
    renderLegend(el, null)
    expect(el.textContent).toBe('')
    expect(el.children.length).toBe(0)
  })

  it('states the scale in use and that it was inferred from partrans when it was', () => {
    const el = document.createElement('div')
    renderLegend(el, { ...BASE_OPTIONS, scale: 'log10', scaleInferred: true })
    expect(el.textContent).toContain('Log₁₀')
    expect(el.textContent).toContain('inferred')

    const el2 = document.createElement('div')
    renderLegend(el2, { ...BASE_OPTIONS, scale: 'linear', scaleInferred: false })
    expect(el2.textContent).toContain('Linear')
    expect(el2.textContent).not.toContain('inferred')
  })

  it('renders a group name with non-ASCII characters verbatim through textContent', () => {
    const el = document.createElement('div')
    const name = 'hk_région_1 <b>bold</b>'
    renderLegend(el, { ...BASE_OPTIONS, group: name })

    const groupEl = el.querySelector('.truncate') as HTMLElement
    expect(groupEl.textContent).toBe(name)
    expect(groupEl.children.length).toBe(0)
  })

  it('with a point count, says how many points and drops the contested and no-value spans', () => {
    const el = document.createElement('div')
    renderLegend(el, { ...BASE_OPTIONS, points: 12 })

    expect(el.textContent).toContain('12 points on this layer')
    expect(el.textContent).not.toContain('contested')
    expect(el.textContent).not.toContain('no value')
  })

  it('says how many inactive cells a field still paints, and only when there are some', () => {
    const el = document.createElement('div')
    renderLegend(el, { ...BASE_OPTIONS, inactiveDrawn: 3 })
    expect(el.textContent).toContain('3 cells inactive in idomain, still drawn')
    for (const inactiveDrawn of [0, undefined]) {
      renderLegend(el, { ...BASE_OPTIONS, inactiveDrawn })
      expect(el.textContent).not.toContain('inactive in idomain')
    }
  })
})

describe('renderLegend with classes', () => {
  const NO_NOTES = { classes: null, symmetric: null, texture: null }

  it('shows one swatch per class in the shader colour and one edge per boundary', () => {
    const el = document.createElement('div')
    renderLegend(el, { ...BASE_OPTIONS, limits: [0, 9], style: { classes: 9, symmetric: false, texture: false }, styleNotes: NO_NOTES })

    const swatches = [...el.querySelectorAll('.legend-class')] as HTMLElement[]
    expect(swatches).toHaveLength(9)
    const table = ramp('viridis')
    swatches.forEach((swatch, k) => {
      const [r, g, b] = classColour(k, 9, table)
      expect(swatch.style.background).toBe(`rgb(${r}, ${g}, ${b})`)
    })
    expect([...el.querySelectorAll('.legend-edge')].map((e) => e.textContent)).toEqual(
      ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
    )
    const gradient = [...el.querySelectorAll('div')].find((d) => d.style.background.includes('linear-gradient'))
    expect(gradient).toBeUndefined()
  })

  it('reads the swatches from the reversed table when the ramp is reversed', () => {
    const el = document.createElement('div')
    renderLegend(el, { ...BASE_OPTIONS, reverse: true, style: { classes: 7, symmetric: false, texture: false } })
    const first = el.querySelector('.legend-class') as HTMLElement
    const [r, g, b] = classColour(0, 7, ramp('viridis', true))
    expect(first.style.background).toBe(`rgb(${r}, ${g}, ${b})`)
  })

  it('shows one swatch, its two edges and the reason for the one-class case', () => {
    const el = document.createElement('div')
    renderLegend(el, {
      ...BASE_OPTIONS,
      limits: [5, 5],
      style: { classes: 1, symmetric: false, texture: false },
      styleNotes: { ...NO_NOTES, classes: ONE_CLASS_EQUAL },
    })
    expect(el.querySelectorAll('.legend-class')).toHaveLength(1)
    expect([...el.querySelectorAll('.legend-edge')].map((e) => e.textContent)).toEqual(['5', '5'])
    const note = [...el.querySelectorAll('div.label')].find((d) => d.textContent === ONE_CLASS_EQUAL)
    expect(note).toBeDefined()
  })

  it('keeps the gradient when continuous', () => {
    const el = document.createElement('div')
    renderLegend(el, { ...BASE_OPTIONS, style: { classes: 0, symmetric: false, texture: false }, styleNotes: NO_NOTES })
    expect(el.querySelectorAll('.legend-class')).toHaveLength(0)
    const gradient = [...el.querySelectorAll('div')].find((d) => d.style.background.includes('linear-gradient'))
    expect(gradient).toBeDefined()
  })
})
