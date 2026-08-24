// @vitest-environment jsdom
//
// Real jsdom (approved after a package-legitimacy gate, 82a7a98). Building
// three real form elements and reading their attributes and values is
// exactly what a working DOM is for.

import { describe, expect, it, vi } from 'vitest'
import type { RealNamesResult } from '../src/data/reals'
import { STOPS, type ColormapName } from '../src/gl/colormap'
import { renderSelectionControls, STATISTICS } from '../src/ui/controls'

function mount(realNames: RealNamesResult, nlay = 3, partrans: string | null = null) {
  const el = document.createElement('div')
  const onSelectionChange = vi.fn()
  const onFitToExtent = vi.fn()
  const handle = renderSelectionControls(el, {
    nlay,
    iteration: 0,
    realNames,
    partrans,
    onSelectionChange,
    onFitToExtent,
  })
  return { el, onSelectionChange, onFitToExtent, handle }
}

const THREE_NAMES: RealNamesResult = { ok: true, names: ['base', 'r001', 'r002'] }

describe('renderSelectionControls', () => {
  it('offers exactly the eight servable statistics and nothing else', () => {
    const { el } = mount(THREE_NAMES)
    const select = el.querySelector('select[aria-label="Statistic"]') as HTMLSelectElement
    const values = Array.from(select.options).map((option) => option.value)
    expect(values).toEqual([...STATISTICS])
  })

  it('spans three positions and reads the name at the current position, not the index', () => {
    const { el } = mount(THREE_NAMES)
    const slider = el.querySelector('input[aria-label="Realization"]') as HTMLInputElement
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('2')

    slider.value = '1'
    slider.dispatchEvent(new Event('input'))

    const label = slider.nextElementSibling as HTMLElement
    expect(label.textContent).toBe('r001')
  })

  it('disables the realization slider and states the reason when no names were recorded', () => {
    const notRecorded: RealNamesResult = {
      ok: false,
      iteration: 4,
      reason: 'no realization names were recorded for that iteration',
    }
    const { el } = mount(notRecorded)

    const slider = el.querySelector('input[aria-label="Realization"]') as HTMLInputElement
    expect(slider.disabled).toBe(true)
    expect(el.textContent).toContain(
      "Realization names weren't recorded for iteration 4, so a realization can't be named.",
    )
  })

  it('renders the layer slider disabled with its single value named for a one-layer run, never hidden', () => {
    const { el } = mount(THREE_NAMES, 1)
    const slider = el.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    expect(slider).not.toBeNull()
    expect(slider.disabled).toBe(true)
    const label = slider.nextElementSibling as HTMLElement
    expect(label.textContent).toBe('0')
  })

  it('gives every control an accessible name and never sets a tabindex above zero', () => {
    const { el } = mount(THREE_NAMES)
    const controls = el.querySelectorAll('input, select')
    expect(controls.length).toBeGreaterThanOrEqual(3)
    for (const control of controls) {
      expect(control.getAttribute('aria-label')).toBeTruthy()
      const tabIndexAttr = control.getAttribute('tabindex')
      if (tabIndexAttr !== null) {
        expect(Number(tabIndexAttr)).toBeLessThanOrEqual(0)
      }
    }
  })

  it('carries the tabular-nums class on the value label beside each slider', () => {
    const { el } = mount(THREE_NAMES)
    const layerValue = el.querySelector('input[aria-label="Layer"]')!.nextElementSibling as HTMLElement
    const realValue = el.querySelector('input[aria-label="Realization"]')!.nextElementSibling as HTMLElement
    expect(layerValue.classList.contains('tabular-nums')).toBe(true)
    expect(realValue.classList.contains('tabular-nums')).toBe(true)
  })

  it('emits onSelectionChange carrying iteration, layer, stat and realization', () => {
    const { el, onSelectionChange } = mount(THREE_NAMES)
    const layerSlider = el.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerSlider.value = '2'
    layerSlider.dispatchEvent(new Event('input'))

    expect(onSelectionChange).toHaveBeenCalledWith({
      iteration: 0,
      layer: 2,
      stat: 'value',
      realization: 'base',
      colormap: 'viridis',
      reverseColormap: false,
      scale: 'linear',
      scaleInferred: true,
      limitsMode: 'robust',
      manualLimits: null,
    })
  })

  it('disables the realization slider when the statistic is not value, and re-enables it when it is', () => {
    const { el } = mount(THREE_NAMES)
    const statSelect = el.querySelector('select[aria-label="Statistic"]') as HTMLSelectElement
    const realSlider = el.querySelector('input[aria-label="Realization"]') as HTMLInputElement
    expect(realSlider.disabled).toBe(false)

    statSelect.value = 'mean'
    statSelect.dispatchEvent(new Event('change'))
    expect(realSlider.disabled).toBe(true)

    statSelect.value = 'value'
    statSelect.dispatchEvent(new Event('change'))
    expect(realSlider.disabled).toBe(false)
  })

  it('lists exactly the nine ramp names, with jet flagged and its reason stated', () => {
    const { el } = mount(THREE_NAMES)
    const select = el.querySelector('select[aria-label="Colormap"]') as HTMLSelectElement
    const values = Array.from(select.options).map((option) => option.value)
    expect(values).toEqual(Object.keys(STOPS))

    const jetOption = Array.from(select.options).find((option) => option.value === 'jet')!
    expect(jetOption.title.length).toBeGreaterThan(0)
    expect(jetOption.textContent).not.toBe('jet')
  })

  it('the reverse switch is an accessible checkbox that emits reverseColormap when toggled', () => {
    const { el, onSelectionChange } = mount(THREE_NAMES)
    const checkbox = el.querySelector('input[aria-label="Reverse colormap"]') as HTMLInputElement
    expect(checkbox.type).toBe('checkbox')

    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change'))

    expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ reverseColormap: true }))
  })

  it('defaults the scale to log10 when partrans is log in any casing, and to linear otherwise', () => {
    const scaleValue = (partrans: string | null) => {
      const { el } = mount(THREE_NAMES, 3, partrans)
      return (el.querySelector('select[aria-label="Value scale"]') as HTMLSelectElement).value
    }

    expect(scaleValue('LOG')).toBe('log10')
    expect(scaleValue(' Log ')).toBe('log10')
    expect(scaleValue('none')).toBe('linear')
    expect(scaleValue('fixed')).toBe('linear')
    expect(scaleValue('some-unrecognised-value')).toBe('linear')
    expect(scaleValue(null)).toBe('linear')
  })

  it('disables log10 with the named count, aria-describedby and a forced linear value when the field forbids it', () => {
    const { el, handle } = mount(THREE_NAMES, 3, 'log')
    const select = el.querySelector('select[aria-label="Value scale"]') as HTMLSelectElement
    expect(select.value).toBe('log10')

    handle.setLogUsability(3)

    const logOption = Array.from(select.options).find((option) => option.value === 'log10')!
    expect(logOption.disabled).toBe(true)
    expect(select.value).toBe('linear')
    expect(select.getAttribute('aria-describedby')).toBeTruthy()
    const warningEl = el.querySelector(`#${select.getAttribute('aria-describedby')}`)
    expect(warningEl?.textContent).toBe('Log₁₀ unavailable — 3 cells are zero or negative. Showing linear.')

    handle.setLogUsability(0)
    expect(logOption.disabled).toBe(false)
    expect(select.getAttribute('aria-describedby')).toBeNull()
  })

  it('renders a real Fit to extent button that calls onFitToExtent when clicked', () => {
    const { el, onFitToExtent } = mount(THREE_NAMES)
    const buttons = Array.from(el.querySelectorAll('button'))
    const fitButton = buttons.find((button) => button.textContent === 'Fit to extent')
    expect(fitButton).toBeTruthy()
    expect(fitButton?.getAttribute('tabindex')).toBeNull()

    fitButton!.dispatchEvent(new Event('click'))
    expect(onFitToExtent).toHaveBeenCalledTimes(1)
  })
})
