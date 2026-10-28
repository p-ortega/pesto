// @vitest-environment jsdom
//
// Real jsdom (approved after a package-legitimacy gate, 82a7a98). Building
// three real form elements and reading their attributes and values is
// exactly what a working DOM is for.

import { describe, expect, it, vi } from 'vitest'
import type { RealNamesResult } from '../src/data/reals'
import { STOPS, type ColormapName } from '../src/gl/colormap'
import { renderSelectionControls, STATISTICS } from '../src/ui/controls'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

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
      style: { classes: 0, symmetric: false, texture: false },
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

  describe('the Classes select', () => {
    const classes = (el: HTMLElement) => el.querySelector('select[aria-label="Colour classes"]') as HTMLSelectElement

    it('lists Continuous, 7, 9 and 11 in that order, as a parameter-only row', () => {
      const { el } = mount(THREE_NAMES)
      const select = classes(el)
      expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
        ['0', 'Continuous'],
        ['7', '7'],
        ['9', '9'],
        ['11', '11'],
      ])
      expect(select.value).toBe('0')
      expect(select.closest('label')?.getAttribute('data-colour-source')).toBe('par')
    })

    it('starts at the initial style and emits the picked count', () => {
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
          style: { classes: 11, symmetric: false, texture: false },
        },
        onSelectionChange,
        onFitToExtent: vi.fn(),
      })
      expect(classes(el).value).toBe('11')
      classes(el).value = '7'
      classes(el).dispatchEvent(new Event('change'))
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ style: { classes: 7, symmetric: false, texture: false } }),
      )
    })

    it('moves with sync without emitting', () => {
      const { el, handle, onSelectionChange } = mount(THREE_NAMES)
      handle.sync({
        colormap: 'viridis',
        reverseColormap: false,
        scale: 'linear',
        scaleInferred: true,
        limitsMode: 'robust',
        manualLimits: null,
        style: { classes: 9, symmetric: false, texture: false },
      })
      expect(classes(el).value).toBe('9')
      expect(onSelectionChange).not.toHaveBeenCalled()
    })

    it('shows the reason line only while there is one', () => {
      const { el, handle } = mount(THREE_NAMES)
      const note = el.querySelector('#classes-note') as HTMLElement
      expect(note.style.display).toBe('none')
      handle.showStyle({ classes: 1, symmetric: false, texture: false }, { classes: 'the limits are equal', symmetric: null, texture: null })
      expect(note.style.display).toBe('')
      expect(note.textContent).toBe('the limits are equal')
      expect(classes(el).getAttribute('aria-describedby')).toBe('classes-note')
      handle.showStyle({ classes: 9, symmetric: false, texture: false }, { classes: null, symmetric: null, texture: null })
      expect(note.style.display).toBe('none')
      expect(classes(el).hasAttribute('aria-describedby')).toBe(false)
    })
  })

  describe('the Symmetric about 0 switch', () => {
    const box = (el: HTMLElement) => el.querySelector('input[aria-label="Symmetric about 0"]') as HTMLInputElement
    const reason = (el: HTMLElement) => el.querySelector('#symmetric-reason') as HTMLElement
    const NO_NOTES = { classes: null, symmetric: null, texture: null }
    const LINEAR = { classes: 0, symmetric: false, texture: false }

    function pick(select: HTMLSelectElement, value: string): void {
      select.value = value
      select.dispatchEvent(new Event('change'))
    }

    it('is a parameter-only checkbox after the Classes select, with its reason line hidden', () => {
      const { el } = mount(THREE_NAMES)
      const input = box(el)
      expect(input.type).toBe('checkbox')
      expect(input.checked).toBe(false)
      const label = input.closest('label') as HTMLElement
      expect(label.textContent).toContain('Symmetric about 0')
      expect(label.getAttribute('data-colour-source')).toBe('par')
      const classesLabel = (el.querySelector('select[aria-label="Colour classes"]') as HTMLElement).closest('label') as HTMLElement
      expect(classesLabel.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(reason(el).style.display).toBe('none')
    })

    it('emits style.symmetric true when checked', () => {
      const { el, onSelectionChange } = mount(THREE_NAMES)
      box(el).checked = true
      box(el).dispatchEvent(new Event('change'))
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ style: { classes: 0, symmetric: true, texture: false } }),
      )
    })

    it('turns symmetric off when Log10 is picked, and says so', () => {
      const { el, onSelectionChange } = mount(THREE_NAMES)
      box(el).checked = true
      box(el).dispatchEvent(new Event('change'))
      pick(el.querySelector('select[aria-label="Value scale"]') as HTMLSelectElement, 'log10')

      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ scale: 'log10', style: { classes: 0, symmetric: false, texture: false } }),
      )
      expect(box(el).checked).toBe(false)
      expect(reason(el).textContent).toBe('symmetric was turned off: a log scale has no zero to centre on')
      expect(reason(el).style.display).toBe('')
    })

    it('turns symmetric off when Manual is picked, and says so', () => {
      const { el, onSelectionChange } = mount(THREE_NAMES)
      box(el).checked = true
      box(el).dispatchEvent(new Event('change'))
      pick(el.querySelector('select[aria-label="Limits"]') as HTMLSelectElement, 'manual')

      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ limitsMode: 'manual', style: { classes: 0, symmetric: false, texture: false } }),
      )
      expect(reason(el).textContent).toBe('symmetric was turned off: manual limits are used as typed')
    })

    it('gives only the plain reason, not a turned-off line, when the scale moves while symmetric is off', () => {
      const { el } = mount(THREE_NAMES)
      pick(el.querySelector('select[aria-label="Value scale"]') as HTMLSelectElement, 'log10')
      expect(box(el).disabled).toBe(true)
      expect(reason(el).textContent).toBe('a log scale has no zero to centre on')
      pick(el.querySelector('select[aria-label="Value scale"]') as HTMLSelectElement, 'linear')
      expect(box(el).disabled).toBe(false)
      expect(reason(el).textContent).toBe('')
    })

    it('is disabled with the reason showStyle gives, and enabled again when there is none', () => {
      const { el, handle } = mount(THREE_NAMES)
      handle.showStyle(LINEAR, { ...NO_NOTES, symmetric: 'a log scale has no zero to centre on' })
      expect(box(el).disabled).toBe(true)
      expect(reason(el).textContent).toBe('a log scale has no zero to centre on')
      expect(reason(el).style.display).toBe('')
      expect(box(el).getAttribute('aria-describedby')).toBe('symmetric-reason')

      handle.showStyle(LINEAR, NO_NOTES)
      expect(box(el).disabled).toBe(false)
      expect(reason(el).style.display).toBe('none')
      expect(box(el).hasAttribute('aria-describedby')).toBe(false)
    })

    it('keeps the turned-off line through later draws until the user moves symmetric, the scale or the limits', () => {
      const { el, handle } = mount(THREE_NAMES)
      box(el).checked = true
      box(el).dispatchEvent(new Event('change'))
      pick(el.querySelector('select[aria-label="Value scale"]') as HTMLSelectElement, 'log10')
      handle.showStyle(LINEAR, { ...NO_NOTES, symmetric: 'a log scale has no zero to centre on' })
      expect(reason(el).textContent).toBe('symmetric was turned off: a log scale has no zero to centre on')
      // The view drew linear after all (log refused for non-positive cells): the trace stays.
      handle.showStyle(LINEAR, NO_NOTES)
      expect(box(el).disabled).toBe(false)
      expect(reason(el).textContent).toBe('symmetric was turned off: a log scale has no zero to centre on')

      box(el).checked = true
      box(el).dispatchEvent(new Event('change'))
      expect(reason(el).style.display).toBe('none')
    })

    it('clears the turned-off line when the scale goes back to linear', () => {
      const { el } = mount(THREE_NAMES)
      box(el).checked = true
      box(el).dispatchEvent(new Event('change'))
      const scale = el.querySelector('select[aria-label="Value scale"]') as HTMLSelectElement
      pick(scale, 'log10')
      pick(scale, 'linear')
      expect(reason(el).textContent).toBe('')
      expect(box(el).checked).toBe(false)
    })

    it('shows a turned-off line the view caused through sync, without emitting', () => {
      const { el, handle, onSelectionChange } = mount(THREE_NAMES)
      box(el).checked = true
      handle.sync(
        {
          colormap: 'viridis',
          reverseColormap: false,
          scale: 'log10',
          scaleInferred: true,
          limitsMode: 'robust',
          manualLimits: null,
          style: { classes: 0, symmetric: false, texture: false },
        },
        'symmetric was turned off: a log scale has no zero to centre on',
      )
      expect(box(el).checked).toBe(false)
      expect(reason(el).textContent).toBe('symmetric was turned off: a log scale has no zero to centre on')
      expect(onSelectionChange).not.toHaveBeenCalled()
    })

    it('starts checked from the initial style and shows the initial styleNote', () => {
      const el = document.createElement('div')
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
          style: { classes: 0, symmetric: true, texture: false },
        },
        styleNote: 'symmetric was turned off: manual limits are used as typed',
        onSelectionChange: vi.fn(),
        onFitToExtent: vi.fn(),
      })
      expect(box(el).checked).toBe(true)
      expect(reason(el).textContent).toBe('symmetric was turned off: manual limits are used as typed')
    })
  })

  it('caps the panel at 32rem and still wraps, so it stops spanning the whole map', () => {
    const { el } = mount(THREE_NAMES)
    expect(el.style.maxWidth).toBe('32rem')
    expect(el.style.flexWrap).toBe('wrap')
    expect(el.style.gap).toBe('var(--space-sm)')
  })

  describe('the Go to realization box', () => {
    const goBox = (el: HTMLElement) => el.querySelector('input[aria-label="Go to realization"]') as HTMLInputElement
    const slider = (el: HTMLElement) => el.querySelector('input[aria-label="Realization"]') as HTMLInputElement
    const commit = (el: HTMLElement, text: string) => {
      goBox(el).value = text
      goBox(el).dispatchEvent(new Event('change'))
    }

    it('holds a list of exactly the iteration names, in order, with no option text', () => {
      const { el } = mount(THREE_NAMES)
      const list = el.querySelector(`datalist#${goBox(el).getAttribute('list')}`) as HTMLDataListElement
      expect(list).not.toBeNull()
      const options = Array.from(list.querySelectorAll('option'))
      expect(options.map((o) => o.getAttribute('value'))).toEqual(['base', 'r001', 'r002'])
      expect(options.map((o) => o.textContent)).toEqual(['', '', ''])
    })

    it('sits in a label whose visible text is "Go to"', () => {
      const { el } = mount(THREE_NAMES)
      const label = goBox(el).closest('label') as HTMLElement
      expect(label.classList.contains('label')).toBe(true)
      expect(label.textContent).toBe('Go to')
    })

    it('moves the slider to a typed name, emits it, and empties the box', () => {
      const { el, onSelectionChange } = mount(THREE_NAMES)
      onSelectionChange.mockClear()

      commit(el, 'r002')

      expect(onSelectionChange).toHaveBeenCalledTimes(1)
      expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ realization: 'r002' }))
      expect(slider(el).value).toBe('2')
      expect(slider(el).nextElementSibling?.textContent).toBe('r002')
      expect(goBox(el).value).toBe('')
    })

    it('commits a pick from the list (insertReplacementText) the same way', () => {
      const { el, onSelectionChange } = mount(THREE_NAMES)
      onSelectionChange.mockClear()

      goBox(el).value = 'r001'
      goBox(el).dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText' }))

      expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ realization: 'r001' }))
      expect(slider(el).value).toBe('1')
    })

    it('emits nothing while the user is still typing', () => {
      const { el, onSelectionChange } = mount(THREE_NAMES)
      onSelectionChange.mockClear()

      goBox(el).value = 'r00'
      goBox(el).dispatchEvent(new Event('input'))
      goBox(el).value = 'r001'
      goBox(el).dispatchEvent(new InputEvent('input', { inputType: 'insertText' }))

      expect(onSelectionChange).not.toHaveBeenCalled()
      expect(slider(el).value).toBe('0')
    })
  })

  describe('the Go to realization box refuses what it cannot find', () => {
    const goBox = (el: HTMLElement) => el.querySelector('input[aria-label="Go to realization"]') as HTMLInputElement
    const slider = (el: HTMLElement) => el.querySelector('input[aria-label="Realization"]') as HTMLInputElement
    const commit = (el: HTMLElement, text: string) => {
      goBox(el).value = text
      goBox(el).dispatchEvent(new Event('change'))
    }
    const refusal = (el: HTMLElement) => {
      const id = goBox(el).getAttribute('aria-describedby')
      return id ? el.querySelector(`#${id}`) : null
    }
    const listValues = (el: HTMLElement) =>
      Array.from(el.querySelectorAll(`datalist#${goBox(el).getAttribute('list')} option`)).map((o) => o.getAttribute('value'))

    it('never reads a number as a position', () => {
      const { el, onSelectionChange } = mount(THREE_NAMES)
      onSelectionChange.mockClear()

      commit(el, '1')

      expect(onSelectionChange).not.toHaveBeenCalled()
      expect(slider(el).value).toBe('0')
      expect(slider(el).nextElementSibling?.textContent).toBe('base')
      expect(refusal(el)?.textContent).toBe('realization "1" is not in iteration 0')
    })

    it('marks the box invalid and ties it to a status line', () => {
      const { el } = mount(THREE_NAMES)
      commit(el, 'zzz')

      expect(goBox(el).getAttribute('aria-invalid')).toBe('true')
      expect(refusal(el)?.getAttribute('role')).toBe('status')
      expect(goBox(el).value).toBe('zzz')
    })

    it.each(['Base', ' r001', 'r001 '])('refuses %j, since names match exactly', (typed) => {
      const { el, onSelectionChange } = mount(THREE_NAMES)
      onSelectionChange.mockClear()

      commit(el, typed)

      expect(onSelectionChange).not.toHaveBeenCalled()
      expect(refusal(el)?.textContent).toBe(`realization "${typed}" is not in iteration 0`)
    })

    it('treats an empty box as nothing to do and clears an earlier refusal', () => {
      const { el, onSelectionChange } = mount(THREE_NAMES)
      commit(el, 'zzz')
      onSelectionChange.mockClear()

      commit(el, '')

      expect(onSelectionChange).not.toHaveBeenCalled()
      expect(refusal(el)?.textContent ?? '').toBe('')
      expect(goBox(el).hasAttribute('aria-invalid')).toBe(false)
    })

    it('clears the refusal on a later pick, a slider move and a slider click', () => {
      const { el } = mount(THREE_NAMES)

      commit(el, 'zzz')
      commit(el, 'r001')
      expect(refusal(el)?.textContent ?? '').toBe('')
      expect(goBox(el).hasAttribute('aria-invalid')).toBe(false)

      commit(el, 'zzz')
      slider(el).value = '2'
      slider(el).dispatchEvent(new Event('input'))
      expect(refusal(el)?.textContent ?? '').toBe('')

      commit(el, 'zzz')
      slider(el).click()
      expect(refusal(el)?.textContent ?? '').toBe('')
      expect(goBox(el).hasAttribute('aria-invalid')).toBe(false)
    })

    it('names the shown iteration, and rebuilds the list when the iteration changes', () => {
      const { el, handle } = mount(THREE_NAMES)
      commit(el, 'zzz')

      handle.setIteration(3)
      handle.setRealizations({ ok: true, names: ['r017', 'base'] }, 'base')

      expect(listValues(el)).toEqual(['r017', 'base'])
      expect(refusal(el)?.textContent ?? '').toBe('')
      commit(el, 'r001')
      expect(refusal(el)?.textContent).toBe('realization "r001" is not in iteration 3')
    })

    it('lets a name that only the new iteration holds be picked', () => {
      const { el, handle, onSelectionChange } = mount(THREE_NAMES)
      handle.setIteration(3)
      handle.setRealizations({ ok: true, names: ['r017', 'base'] }, 'base')
      onSelectionChange.mockClear()

      commit(el, 'r017')

      expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ iteration: 3, realization: 'r017' }))
      expect(slider(el).value).toBe('0')
    })

    it('is disabled exactly when the slider is', () => {
      const { el, handle } = mount(THREE_NAMES)
      const stat = el.querySelector('select[aria-label="Statistic"]') as HTMLSelectElement
      expect(goBox(el).disabled).toBe(false)

      stat.value = 'mean'
      stat.dispatchEvent(new Event('change'))
      expect(goBox(el).disabled).toBe(true)
      expect(slider(el).disabled).toBe(true)

      stat.value = 'value'
      stat.dispatchEvent(new Event('change'))
      expect(goBox(el).disabled).toBe(false)

      handle.setRealizations({ ok: false, iteration: 3, reason: 'none' }, 'base')
      expect(goBox(el).disabled).toBe(true)
      expect(listValues(el)).toEqual([])

      handle.setRealizations({ ok: true, names: ['only'] }, 'only')
      expect(goBox(el).disabled).toBe(true)

      handle.setRealizations({ ok: true, names: ['a', 'b'] }, 'a')
      expect(goBox(el).disabled).toBe(false)
    })

    it('is disabled at mount when names were not recorded', () => {
      const { el } = mount({ ok: false, iteration: 0, reason: 'none' })
      expect(goBox(el).disabled).toBe(true)
    })

    it('is disabled at mount with a single name', () => {
      const { el } = mount({ ok: true, names: ['base'] })
      expect(goBox(el).disabled).toBe(true)
    })

    it('passes the run-together check with the box, list and refusal shown', () => {
      loadRealStylesheet()
      const { el } = mount(THREE_NAMES)
      document.body.appendChild(el)
      commit(el, 'zzz')

      expectNoRunTogetherText(el, 'selection controls')
      el.remove()
    })
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
