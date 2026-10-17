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

  it('tells assistive technology the realization name, never the slider position', () => {
    const { el, handle } = mount(THREE_NAMES)
    const slider = el.querySelector('input[aria-label="Realization"]') as HTMLInputElement
    expect(slider.getAttribute('aria-valuetext')).toBe('base')

    slider.value = '2'
    slider.dispatchEvent(new Event('input'))
    expect(slider.getAttribute('aria-valuetext')).toBe('r002')

    handle.setRealizations({ ok: true, names: ['base', 'r001'] }, 'zzz')
    expect(slider.getAttribute('aria-valuetext')).toBe('none picked')

    slider.click()
    expect(slider.getAttribute('aria-valuetext')).toBe('base')

    handle.setRealizations({ ok: true, names: ['r001', 'base'] }, 'base')
    expect(slider.getAttribute('aria-valuetext')).toBe('base')

    handle.setRealizations({ ok: false, iteration: 3, reason: 'none' }, 'base')
    expect(slider.getAttribute('aria-valuetext')).toBe('names not recorded')
  })

  it('tells assistive technology the names were not recorded when none were at mount', () => {
    const { el } = mount({ ok: false, iteration: 4, reason: 'none' })
    const slider = el.querySelector('input[aria-label="Realization"]') as HTMLInputElement
    expect(slider.getAttribute('aria-valuetext')).toBe('names not recorded')
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

  // WINDOWS.md #8: a restored view state carried reverseColormap: true and
  // it was applied to the ramp, but the checkbox this same module renders
  // read unchecked -- the control never learned what the caller already
  // knew. This is the same class of bug as #5 (the scale dropdown not
  // resyncing on a group change): the view can update `committed` without
  // ever telling the DOM controls.
  it('shows a restored colormap, reverse, scale and limits mode at construction, not the fresh-run defaults', () => {
    const el = document.createElement('div')
    const handle = renderSelectionControls(el, {
      nlay: 3,
      iteration: 0,
      realNames: THREE_NAMES,
      partrans: 'none',
      initial: {
        colormap: 'magma',
        reverseColormap: true,
        scale: 'log10',
        scaleInferred: false,
        limitsMode: 'minmax',
        manualLimits: null,
      },
      onSelectionChange: vi.fn(),
      onFitToExtent: vi.fn(),
    })

    expect((el.querySelector('input[aria-label="Reverse colormap"]') as HTMLInputElement).checked).toBe(true)
    expect((el.querySelector('select[aria-label="Colormap"]') as HTMLSelectElement).value).toBe('magma')
    expect((el.querySelector('select[aria-label="Value scale"]') as HTMLSelectElement).value).toBe('log10')
    expect((el.querySelector('select[aria-label="Limits"]') as HTMLSelectElement).value).toBe('minmax')
    expect(handle).toBeDefined()
  })

  it('shows a restored statistic at construction, with the realization slider off for an aggregate', () => {
    const el = document.createElement('div')
    const onSelectionChange = vi.fn()
    renderSelectionControls(el, {
      nlay: 3,
      iteration: 0,
      realNames: THREE_NAMES,
      partrans: 'none',
      initial: {
        colormap: 'viridis',
        reverseColormap: false,
        scale: 'linear',
        scaleInferred: true,
        limitsMode: 'robust',
        manualLimits: null,
        stat: 'mean',
      },
      onSelectionChange,
      onFitToExtent: vi.fn(),
    })

    expect((el.querySelector('select[aria-label="Statistic"]') as HTMLSelectElement).value).toBe('mean')
    expect((el.querySelector('input[aria-label="Realization"]') as HTMLInputElement).disabled).toBe(true)
    const layerSlider = el.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerSlider.value = '1'
    layerSlider.dispatchEvent(new Event('input'))
    expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ stat: 'mean', realization: null }))
  })

  it('a restored reverse setting survives an unrelated control change, instead of being silently dropped', () => {
    const el = document.createElement('div')
    const onSelectionChange = vi.fn()
    renderSelectionControls(el, {
      nlay: 3,
      iteration: 0,
      realNames: THREE_NAMES,
      partrans: 'none',
      initial: {
        colormap: 'viridis',
        reverseColormap: true,
        scale: 'linear',
        scaleInferred: true,
        limitsMode: 'robust',
        manualLimits: null,
      },
      onSelectionChange,
      onFitToExtent: vi.fn(),
    })

    const layerSlider = el.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerSlider.value = '1'
    layerSlider.dispatchEvent(new Event('input'))

    expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ reverseColormap: true }))
  })

  it('sync() pushes a selection into the displayed controls without emitting onSelectionChange', () => {
    const { el, handle, onSelectionChange } = mount(THREE_NAMES)
    onSelectionChange.mockClear()

    handle.sync({
      colormap: 'turbo',
      reverseColormap: true,
      scale: 'log10',
      scaleInferred: true,
      limitsMode: 'manual',
      manualLimits: [2, 9],
    })

    expect((el.querySelector('select[aria-label="Colormap"]') as HTMLSelectElement).value).toBe('turbo')
    expect((el.querySelector('input[aria-label="Reverse colormap"]') as HTMLInputElement).checked).toBe(true)
    expect((el.querySelector('select[aria-label="Value scale"]') as HTMLSelectElement).value).toBe('log10')
    expect((el.querySelector('select[aria-label="Limits"]') as HTMLSelectElement).value).toBe('manual')
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  describe('after another iteration is shown', () => {
    const realInput = (el: HTMLElement) => el.querySelector('input[aria-label="Realization"]') as HTMLInputElement
    const labelOf = (el: HTMLElement) => realInput(el).nextElementSibling?.textContent

    it('setRealizations moves the slider to the wanted name and returns its new index', () => {
      const { el, handle, onSelectionChange } = mount(THREE_NAMES)
      onSelectionChange.mockClear()

      const index = handle.setRealizations({ ok: true, names: ['r002', 'zz', 'base'] }, 'base')

      expect(index).toBe(2)
      expect(realInput(el).value).toBe('2')
      expect(realInput(el).max).toBe('2')
      expect(labelOf(el)).toBe('base')
      expect(onSelectionChange).not.toHaveBeenCalled()
    })

    it('setRealizations returns null and reads "—" when the name is not there', () => {
      const { el, handle } = mount(THREE_NAMES)

      const index = handle.setRealizations({ ok: true, names: ['base', 'r001'] }, 'zzz')

      expect(index).toBeNull()
      expect(labelOf(el)).toBe('—')
    })

    it('matches names exactly, with no trimming or case folding', () => {
      const { handle } = mount(THREE_NAMES)
      expect(handle.setRealizations({ ok: true, names: ['Base', ' r001'] }, 'base')).toBeNull()
      expect(handle.setRealizations({ ok: true, names: ['Base', ' r001'] }, 'r001')).toBeNull()
    })

    it('emits no realization while the wanted one is missing, whatever position the slider holds', () => {
      const { el, handle, onSelectionChange } = mount(THREE_NAMES)
      handle.setRealizations({ ok: true, names: ['base', 'r001'] }, 'zzz')
      onSelectionChange.mockClear()

      const layer = el.querySelector('input[aria-label="Layer"]') as HTMLInputElement
      layer.value = '1'
      layer.dispatchEvent(new Event('input'))

      expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ realization: null }))
    })

    it('names a realization again once the slider is moved, or its thumb clicked', () => {
      const { el, handle, onSelectionChange } = mount(THREE_NAMES)
      handle.setRealizations({ ok: true, names: ['base', 'r001'] }, 'zzz')
      onSelectionChange.mockClear()

      realInput(el).value = '1'
      realInput(el).dispatchEvent(new Event('input'))
      expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ realization: 'r001' }))

      handle.setRealizations({ ok: true, names: ['base', 'r001'] }, 'zzz')
      realInput(el).click()
      expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ realization: 'base' }))
      expect(labelOf(el)).toBe('base')
    })

    it('setRealizations with names that were not recorded disables the slider and says why', () => {
      const { el, handle } = mount(THREE_NAMES)

      const index = handle.setRealizations({ ok: false, iteration: 3, reason: 'none' }, 'base')

      expect(index).toBeNull()
      expect(realInput(el).disabled).toBe(true)
      expect(labelOf(el)).toBe('—')
      expect(el.textContent).toContain("Realization names weren't recorded for iteration 3")

      handle.setRealizations({ ok: true, names: ['base', 'r001'] }, 'base')
      expect(el.textContent).not.toContain("weren't recorded")
    })

    it('setIteration changes the iteration every later selection carries, and emits nothing', () => {
      const { el, handle, onSelectionChange } = mount(THREE_NAMES)
      onSelectionChange.mockClear()

      handle.setIteration(3)
      expect(onSelectionChange).not.toHaveBeenCalled()

      const layer = el.querySelector('input[aria-label="Layer"]') as HTMLInputElement
      layer.value = '1'
      layer.dispatchEvent(new Event('input'))
      expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ iteration: 3 }))
    })
  })
})
