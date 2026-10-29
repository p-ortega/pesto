// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { classColour, ramp, swatchCssAngle, textureAngles } from '../src/gl/colormap'
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
    expect(el.textContent).toContain('Robust 2–98%')

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

  it('centres each edge number on the boundary between its two swatches', () => {
    const el = document.createElement('div')
    renderLegend(el, { ...BASE_OPTIONS, limits: [0, 7], style: { classes: 7, symmetric: false, texture: false } })
    const swatches = [...el.querySelectorAll('.legend-class')] as HTMLElement[]
    const edges = [...el.querySelectorAll('.legend-edge')] as HTMLElement[]
    expect(edges).toHaveLength(swatches.length + 1)
    // Edge j spans half-columns 2j+1..2j+4 so its centre is grid line 2j+3, where swatch j starts.
    swatches.forEach((swatch, k) => expect(swatch.style.gridColumn).toBe(`${2 * k + 3} / span 2`))
    edges.forEach((edge, j) => expect(edge.style.gridColumn).toBe(`${2 * j + 1} / span 4`))
    // Neighbouring edges sit on different rows, so their numbers never touch.
    edges.forEach((edge, j) => expect(edge.style.gridRow).toBe(String(2 + (j % 2))))
    expect((el.querySelector('.legend-class-grid') as HTMLElement).style.width).toBe('100%')
  })

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

  it('says centred on zero only when the drawn limits are symmetric, and leaves the ramp alone', () => {
    const on = document.createElement('div')
    renderLegend(on, { ...BASE_OPTIONS, limits: [-5, 5], style: { classes: 0, symmetric: true, texture: false }, styleNotes: NO_NOTES })
    const off = document.createElement('div')
    renderLegend(off, { ...BASE_OPTIONS, limits: [-5, 5], style: { classes: 0, symmetric: false, texture: false }, styleNotes: NO_NOTES })

    const line = (el: HTMLElement) => [...el.querySelectorAll('div.label')].find((d) => d.textContent === 'centred on zero')
    expect(line(on)).toBeDefined()
    expect(line(off)).toBeUndefined()
    const gradient = (el: HTMLElement) => [...el.querySelectorAll('div')].find((d) => d.style.background.includes('linear-gradient'))
    expect(gradient(on)?.style.background).toBe(gradient(off)?.style.background)
  })

  it('still says centred on zero for zero limits', () => {
    const el = document.createElement('div')
    renderLegend(el, { ...BASE_OPTIONS, limits: [0, 0], style: { classes: 0, symmetric: true, texture: false }, styleNotes: NO_NOTES })
    expect([...el.querySelectorAll('div.label')].some((d) => d.textContent === 'centred on zero')).toBe(true)
  })

  it('draws each class as lines at its angle over the surface, with the edges, when texture is on', () => {
    const el = document.createElement('div')
    renderLegend(el, { ...BASE_OPTIONS, limits: [0, 7], style: { classes: 7, symmetric: false, texture: true }, styleNotes: NO_NOTES })

    const swatches = [...el.querySelectorAll('.legend-class')] as HTMLElement[]
    expect(swatches).toHaveLength(7)
    const angles = textureAngles(7)
    swatches.forEach((swatch, k) => {
      const background = swatch.style.background
      expect(background).toContain(`repeating-linear-gradient(${swatchCssAngle(angles[k])}deg`)
      expect(background).toContain('var(--ink-primary)')
      expect(background).toContain('var(--surface)')
      expect(background).not.toContain('rgb(')
      expect(swatch.style.border).toContain('var(--hairline)')
    })
    expect(el.querySelectorAll('.legend-edge')).toHaveLength(8)
    expect([...el.querySelectorAll('span')].some((s) => s.textContent === '12 cells no value')).toBe(true)
  })

  it('keeps the colour swatches when texture is off', () => {
    const el = document.createElement('div')
    renderLegend(el, { ...BASE_OPTIONS, style: { classes: 7, symmetric: false, texture: false }, styleNotes: NO_NOTES })
    const first = el.querySelector('.legend-class') as HTMLElement
    const [r, g, b] = classColour(0, 7, ramp('viridis'))
    expect(first.style.background).toBe(`rgb(${r}, ${g}, ${b})`)
    expect(first.style.border).toBe('')
  })

  it('keeps the gradient when continuous', () => {
    const el = document.createElement('div')
    renderLegend(el, { ...BASE_OPTIONS, style: { classes: 0, symmetric: false, texture: false }, styleNotes: NO_NOTES })
    expect(el.querySelectorAll('.legend-class')).toHaveLength(0)
    const gradient = [...el.querySelectorAll('div')].find((d) => d.style.background.includes('linear-gradient'))
    expect(gradient).toBeDefined()
  })
})

describe('renderLegend over a basemap', () => {
  const BLENDED = 'blended — colours approximate'
  const labels = (el: HTMLElement) => [...el.querySelectorAll('.label')].map((l) => l.textContent)

  it('says the colours are approximate when the field is blended, below the scale and limits lines', () => {
    const el = document.createElement('div')
    renderLegend(el, { ...BASE_OPTIONS, blended: true })
    const lines = labels(el)
    expect(lines.filter((l) => l === BLENDED)).toHaveLength(1)
    expect(lines.indexOf(BLENDED)).toBeGreaterThan(lines.indexOf('Limits: Robust 2–98%'))
    expect(lines.indexOf(BLENDED)).toBeGreaterThan(lines.findIndex((l) => l?.startsWith('Scale:')))
  })

  it('says nothing about blending when the field is opaque or the option is absent', () => {
    for (const options of [{ ...BASE_OPTIONS, blended: false }, BASE_OPTIONS]) {
      const el = document.createElement('div')
      renderLegend(el, options)
      expect(el.textContent).not.toContain('blended')
    }
  })
})
