// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
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
})
