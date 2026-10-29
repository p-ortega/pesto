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

const noteText = (line: Element | null | undefined): string => line?.querySelector('.note-text')?.textContent ?? ''

function mount(realNames: RealNamesResult, nlay = 3, partrans: string | null = null) {
  const el = document.createElement('div')
  const onSelectionChange = vi.fn()
  const handle = renderSelectionControls(el, {
    nlay,
    iteration: 0,
    realNames,
    partrans,
    onSelectionChange,
  })
  return { el, onSelectionChange, handle }
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
    expect(label.textContent).toBe('1 (0)')
  })

  it('says why the layer slider is disabled on a one-layer grid, under it, on hover and to a screen reader', () => {
    const { el } = mount(THREE_NAMES, 1)
    const slider = el.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    const reason = el.querySelector('#layer-reason') as HTMLElement
    expect(reason.textContent).toBe('ℹ the grid has one layer')
    expect(noteText(reason)).toBe('the grid has one layer')
    expect(reason.style.display).toBe('')
    expect(slider.title).toBe('the grid has one layer')
    expect(slider.getAttribute('aria-describedby')).toBe('layer-reason')
    expect(reason.closest('.card-row')).toBe(slider.closest('.card-row'))
    expect(reason.hasAttribute('data-colour-source')).toBe(false)
  })

  it('has no layer reason on a grid with more than one layer', () => {
    const { el } = mount(THREE_NAMES, 17)
    const slider = el.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    expect(slider.disabled).toBe(false)
    expect((el.querySelector('#layer-reason') as HTMLElement).style.display).toBe('none')
    expect(slider.hasAttribute('aria-describedby')).toBe(false)
  })

  describe('the layer value, one-based with the index alongside (LD-5)', () => {
    const TIP = (n: number) => `Layer ${n + 1}, index ${n}. Layers count from 1 at the top; the index counts from 0.`

    it('reads 4 (3) for layer index 3, keeps the slider zero-based, and says both numbers on hover and to a screen reader', () => {
      const { el, handle } = mount(THREE_NAMES, 17)
      handle.setLayer(3)
      const slider = el.querySelector('input[aria-label="Layer"]') as HTMLInputElement
      const value = slider.nextElementSibling as HTMLElement
      expect(value.textContent).toBe('4 (3)')
      expect(slider.value).toBe('3')
      expect(slider.max).toBe('16')
      expect(slider.getAttribute('aria-valuetext')).toBe('layer 4, index 3')
      expect(value.title).toBe(TIP(3))
      expect(slider.title).toBe(TIP(3))
    })

    it('starts at 1 (0) and follows the slider, emitting the zero-based layer', () => {
      const { el, onSelectionChange } = mount(THREE_NAMES, 17)
      const slider = el.querySelector('input[aria-label="Layer"]') as HTMLInputElement
      const value = slider.nextElementSibling as HTMLElement
      expect(value.textContent).toBe('1 (0)')
      expect(slider.getAttribute('aria-valuetext')).toBe('layer 1, index 0')
      slider.value = '16'
      slider.dispatchEvent(new Event('input'))
      expect(value.textContent).toBe('17 (16)')
      expect(slider.getAttribute('aria-valuetext')).toBe('layer 17, index 16')
      expect(value.title).toBe(TIP(16))
      expect(slider.title).toBe(TIP(16))
      expect(onSelectionChange.mock.lastCall?.[0].layer).toBe(16)
    })
  })

  describe('the card rows', () => {
    const rowLabels = (host: HTMLElement) =>
      Array.from(host.querySelectorAll(':scope > .card-row > .card-row-label')).map((label) => label.textContent)

    it('lays out Layer, Statistic and Realization, then the six Colours rows, then the observation line', () => {
      const { el } = mount(THREE_NAMES)
      expect(rowLabels(el)).toEqual([
        'Layer',
        'Statistic',
        'Realization',
        'Colormap',
        'Value scale',
        'Limits',
        'Colour steps',
        'Centre on zero',
        'Patterns',
      ])
      const children = Array.from(el.children)
      expect(children.slice(0, 9).every((child) => child.classList.contains('card-row'))).toBe(true)
      expect(children[9].classList.contains('colours-obs-line')).toBe(true)
      expect(children).toHaveLength(10)
    })

    it('puts each control in its own row', () => {
      const { el } = mount(THREE_NAMES)
      const rowOf = (selector: string) =>
        (el.querySelector(selector) as HTMLElement).closest('.card-row')?.querySelector('.card-row-label')?.textContent
      expect(rowOf('input[aria-label="Layer"]')).toBe('Layer')
      expect(rowOf('select[aria-label="Statistic"]')).toBe('Statistic')
      expect(rowOf('input[aria-label="Realization"]')).toBe('Realization')
      expect(rowOf('input[aria-label="Go to realization"]')).toBe('Realization')
      expect(rowOf('select[aria-label="Colormap"]')).toBe('Colormap')
      expect(rowOf('input[aria-label="Reverse colormap"]')).toBe('Colormap')
      expect(rowOf('select[aria-label="Value scale"]')).toBe('Value scale')
      expect(rowOf('select[aria-label="Limits"]')).toBe('Limits')
      expect(rowOf('input[aria-label="Lower limit"]')).toBe('Limits')
      expect(rowOf('input[aria-label="Upper limit"]')).toBe('Limits')
      expect(rowOf('select[aria-label="Colour steps"]')).toBe('Colour steps')
      expect(rowOf('input[aria-label="Centre on zero"]')).toBe('Centre on zero')
      expect(rowOf('input[aria-label="Patterns instead of colours"]')).toBe('Patterns')
    })

    it('tags every Colours row and the realization row for parameters, the layer row for neither, and the line for observations', () => {
      const { el } = mount(THREE_NAMES)
      const rows = Array.from(el.querySelectorAll(':scope > .card-row')) as HTMLElement[]
      expect(rows[0].hasAttribute('data-colour-source')).toBe(false)
      for (const row of rows.slice(2)) expect(row.getAttribute('data-colour-source')).toBe('par')
      expect((el.querySelector('select[aria-label="Statistic"]') as HTMLElement).getAttribute('data-colour-source')).toBe('par')
      const line = el.querySelector('.colours-obs-line') as HTMLElement
      expect(line.textContent).toBe('Colormap, value scale, limits, colour steps, centring and patterns apply to parameter fields only.')
      expect(line.getAttribute('data-colour-source')).toBe('obs')
    })

    it('puts the layer, statistic and realization controls into the Data rows it is given, leaving the element the Colours rows', async () => {
      const { renderDataCard } = await import('../src/ui/data-card')
      const body = document.createElement('div')
      const data = renderDataCard(body)
      const el = document.createElement('div')
      const onSelectionChange = vi.fn()
      renderSelectionControls(el, {
        nlay: 3,
        iteration: 0,
        realNames: THREE_NAMES,
        partrans: null,
        dataRows: { layer: data.layer, statistic: data.statistic, realization: data.realization },
        onSelectionChange,
      })
      expect(data.layer.control.querySelector('input[aria-label="Layer"]')).not.toBeNull()
      expect(data.statistic.control.querySelector('select[aria-label="Statistic"]')).not.toBeNull()
      expect(data.realization.control.querySelector('input[aria-label="Realization"]')).not.toBeNull()
      expect(data.realization.control.querySelector('input[aria-label="Go to realization"]')).not.toBeNull()
      // The Data card's statistic row will also hold the observation statistic, so only the select is tagged.
      expect(data.statistic.row.hasAttribute('data-colour-source')).toBe(false)
      expect(rowLabels(el)).toEqual(['Colormap', 'Value scale', 'Limits', 'Colour steps', 'Centre on zero', 'Patterns'])
      expect(el.querySelector('input[aria-label="Layer"]')).toBeNull()
      expect(el.lastElementChild?.classList.contains('colours-obs-line')).toBe(true)

      const slider = data.layer.control.querySelector('input[aria-label="Layer"]') as HTMLInputElement
      slider.value = '2'
      slider.dispatchEvent(new Event('input'))
      expect(onSelectionChange.mock.lastCall?.[0]).toMatchObject({ layer: 2, stat: 'value', realization: 'base' })
    })

    it('hides the realization row unless the statistic is value, and asks for a name in the Go to box', () => {
      const { el } = mount(THREE_NAMES)
      const statSelect = el.querySelector('select[aria-label="Statistic"]') as HTMLSelectElement
      const row = (el.querySelector('input[aria-label="Realization"]') as HTMLElement).closest('.card-row') as HTMLElement
      expect(row.hidden).toBe(false)
      statSelect.value = 'mean'
      statSelect.dispatchEvent(new Event('change'))
      expect(row.hidden).toBe(true)
      statSelect.value = 'value'
      statSelect.dispatchEvent(new Event('change'))
      expect(row.hidden).toBe(false)
      expect((el.querySelector('input[aria-label="Go to realization"]') as HTMLInputElement).placeholder).toBe('type a name')
    })

    it('starts the realization row hidden for a restored aggregate statistic', () => {
      const el = document.createElement('div')
      renderSelectionControls(el, {
        nlay: 3,
        iteration: 0,
        realNames: THREE_NAMES,
        partrans: null,
        initial: { colormap: 'viridis', reverseColormap: false, scale: 'linear', scaleInferred: true, limitsMode: 'robust', manualLimits: null, stat: 'q50' },
        onSelectionChange: () => undefined,
      })
      expect(((el.querySelector('input[aria-label="Realization"]') as HTMLElement).closest('.card-row') as HTMLElement).hidden).toBe(true)
    })
  })

  describe('the Colours folded line', () => {
    it('reads the defaults in the controls own words', () => {
      const { handle } = mount(THREE_NAMES)
      expect(handle.coloursSummary()).toBe('viridis · linear · robust 2–98% · smooth')
    })

    it('names a reversed ramp, log scale, min–max limits, steps, centring and patterns', () => {
      const { handle } = mount(THREE_NAMES)
      handle.sync({
        colormap: 'magma',
        reverseColormap: true,
        scale: 'log10',
        scaleInferred: false,
        limitsMode: 'minmax',
        manualLimits: null,
        style: { classes: 9, symmetric: true, texture: true },
      })
      expect(handle.coloursSummary()).toBe('magma reversed · log₁₀ · min–max · 9 steps · centred · patterns')
    })

    it('names manual limits and jet without its warning glyph, and leaves out greyed centring and patterns boxes', () => {
      const { handle } = mount(THREE_NAMES)
      handle.sync({
        colormap: 'jet',
        reverseColormap: false,
        scale: 'linear',
        scaleInferred: true,
        limitsMode: 'manual',
        manualLimits: [0, 1],
        style: { classes: 7, symmetric: true, texture: true },
      })
      handle.showStyle(
        { classes: 7, symmetric: false, texture: false },
        { classes: null, symmetric: 'centring needs robust or min–max limits', texture: 'patterns apply to cell fields' },
      )
      expect(handle.coloursSummary()).toBe('jet · linear · manual · 7 steps')
    })

    it('sends the new line after a colour change and after a sync, and not after a layer move', () => {
      const el = document.createElement('div')
      const onColoursChange = vi.fn()
      const handle = renderSelectionControls(el, {
        nlay: 3,
        iteration: 0,
        realNames: THREE_NAMES,
        partrans: null,
        onSelectionChange: () => undefined,
        onColoursChange,
      })
      const pick = (label: string, value: string) => {
        const select = el.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
        select.value = value
        select.dispatchEvent(new Event('change'))
      }
      pick('Colormap', 'cividis')
      expect(onColoursChange).toHaveBeenLastCalledWith('cividis · linear · robust 2–98% · smooth')
      const reverse = el.querySelector('input[aria-label="Reverse colormap"]') as HTMLInputElement
      reverse.checked = true
      reverse.dispatchEvent(new Event('change'))
      expect(onColoursChange).toHaveBeenLastCalledWith('cividis reversed · linear · robust 2–98% · smooth')
      pick('Value scale', 'log10')
      expect(onColoursChange).toHaveBeenLastCalledWith('cividis reversed · log₁₀ · robust 2–98% · smooth')
      pick('Limits', 'minmax')
      expect(onColoursChange).toHaveBeenLastCalledWith('cividis reversed · log₁₀ · min–max · smooth')
      pick('Colour steps', '11')
      expect(onColoursChange).toHaveBeenLastCalledWith('cividis reversed · log₁₀ · min–max · 11 steps')
      const patterns = el.querySelector('input[aria-label="Patterns instead of colours"]') as HTMLInputElement
      patterns.checked = true
      patterns.dispatchEvent(new Event('change'))
      expect(onColoursChange).toHaveBeenLastCalledWith('cividis reversed · log₁₀ · min–max · 11 steps · patterns')

      onColoursChange.mockClear()
      handle.sync({ colormap: 'viridis', reverseColormap: false, scale: 'linear', scaleInferred: true, limitsMode: 'robust', manualLimits: null })
      expect(onColoursChange).toHaveBeenLastCalledWith('viridis · linear · robust 2–98% · 11 steps · patterns')

      onColoursChange.mockClear()
      const layer = el.querySelector('input[aria-label="Layer"]') as HTMLInputElement
      layer.value = '1'
      layer.dispatchEvent(new Event('input'))
      expect(onColoursChange).not.toHaveBeenCalled()
    })

    it('sends the new line when the field forces the scale back to linear', () => {
      const el = document.createElement('div')
      const onColoursChange = vi.fn()
      const handle = renderSelectionControls(el, {
        nlay: 3,
        iteration: 0,
        realNames: THREE_NAMES,
        partrans: 'log',
        onSelectionChange: () => undefined,
        onColoursChange,
      })
      expect(handle.coloursSummary()).toBe('viridis · log₁₀ · robust 2–98% · smooth')
      handle.setLogUsability(4)
      expect(onColoursChange).toHaveBeenLastCalledWith('viridis · linear · robust 2–98% · smooth')
    })
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

  it('names the limits options with an en dash, as the legend does, and keeps their values', () => {
    const { el } = mount(THREE_NAMES)
    const select = el.querySelector('select[aria-label="Limits"]') as HTMLSelectElement
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['robust', 'Robust 2–98%'],
      ['minmax', 'Min–max'],
      ['manual', 'Manual'],
    ])
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
    expect(noteText(warningEl)).toBe('Log₁₀ unavailable — 3 cells are zero or negative. Showing linear.')
    expect(warningEl?.textContent?.startsWith('⚠ ')).toBe(true)

    handle.setLogUsability(0)
    expect(logOption.disabled).toBe(false)
    expect(select.getAttribute('aria-describedby')).toBeNull()
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

  describe('the Colour steps select', () => {
    const classes = (el: HTMLElement) => el.querySelector('select[aria-label="Colour steps"]') as HTMLSelectElement

    it('lists Smooth, 7 steps, 9 steps and 11 steps in that order, as a parameter-only row', () => {
      const { el } = mount(THREE_NAMES)
      const select = classes(el)
      expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
        ['0', 'Smooth'],
        ['7', '7 steps'],
        ['9', '9 steps'],
        ['11', '11 steps'],
      ])
      expect(select.value).toBe('0')
      expect(select.closest('.card-row')?.getAttribute('data-colour-source')).toBe('par')
    })

    it('is labelled Colour steps, says what it does on hover, and has a hint under it', () => {
      const { el } = mount(THREE_NAMES)
      const select = classes(el)
      const label = select.closest('.card-row')?.querySelector('.card-row-label') as HTMLElement
      expect(label.textContent).toBe('Colour steps')
      expect(select.title).toBe('Smooth shades every value. Steps split the range into equal bands, like a contour map, so layers can be compared by eye.')
      expect(label.title).toBe('Smooth shades every value. Steps split the range into equal bands, like a contour map, so layers can be compared by eye.')
      const hint = select.nextElementSibling as HTMLElement
      expect(hint.classList.contains('card-hint')).toBe(true)
      expect(hint.classList.contains('wrap-note')).toBe(true)
      expect(hint.textContent).toBe('Bands values like a contour map.')
      expect(hint.style.color).toBe('var(--ink-secondary)')
      expect(hint.getAttribute('data-colour-source')).toBe('par')
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
      expect(noteText(note)).toBe('the limits are equal')
      expect(note.textContent).toBe('⚠ the limits are equal')
      expect(classes(el).getAttribute('aria-describedby')).toBe('classes-note')
      handle.showStyle({ classes: 9, symmetric: false, texture: false }, { classes: null, symmetric: null, texture: null })
      expect(note.style.display).toBe('none')
      expect(classes(el).hasAttribute('aria-describedby')).toBe(false)
    })
  })

  describe('the Centre on zero switch', () => {
    const box = (el: HTMLElement) => el.querySelector('input[aria-label="Centre on zero"]') as HTMLInputElement
    const reason = (el: HTMLElement) => el.querySelector('#symmetric-reason') as HTMLElement
    const NO_NOTES = { classes: null, symmetric: null, texture: null }
    const LINEAR = { classes: 0, symmetric: false, texture: false }

    function pick(select: HTMLSelectElement, value: string): void {
      select.value = value
      select.dispatchEvent(new Event('change'))
    }

    it('is labelled Centre on zero, says what it does on hover, and has a hint under it', () => {
      const { el } = mount(THREE_NAMES)
      const label = box(el).closest('.card-row')?.querySelector('.card-row-label') as HTMLElement
      expect(label.textContent).toBe('Centre on zero')
      expect(box(el).title).toBe('Puts zero in the middle of the colour ramp, so values above and below zero get matching colours.')
      expect(label.title).toBe('Puts zero in the middle of the colour ramp, so values above and below zero get matching colours.')
      const hint = box(el).nextElementSibling as HTMLElement
      expect(hint.classList.contains('card-hint')).toBe(true)
      expect(hint.textContent).toBe('For changes and residuals.')
    })

    it('is a parameter-only checkbox after the Colour steps select, with its reason line hidden', () => {
      const { el } = mount(THREE_NAMES)
      const input = box(el)
      expect(input.type).toBe('checkbox')
      expect(input.checked).toBe(false)
      const label = input.closest('.card-row') as HTMLElement
      expect(label.textContent).toContain('Centre on zero')
      expect(label.getAttribute('data-colour-source')).toBe('par')
      const classesLabel = (el.querySelector('select[aria-label="Colour steps"]') as HTMLElement).closest('.card-row') as HTMLElement
      expect(classesLabel.nextElementSibling).toBe(label)
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
      expect(noteText(reason(el))).toBe('centre on zero was turned off: a log scale has no zero to centre on')
      expect(reason(el).textContent).toBe('⚠ centre on zero was turned off: a log scale has no zero to centre on')
      expect((reason(el).querySelector('span[aria-hidden="true"]') as HTMLElement).style.color).toBe('var(--status-warning)')
      expect((reason(el).querySelector('.note-text') as HTMLElement).style.color).toBe('var(--ink-primary)')
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
      expect(noteText(reason(el))).toBe('centre on zero was turned off: manual limits are used as typed')
    })

    it('gives only the plain reason, not a turned-off line, when the scale moves while symmetric is off', () => {
      const { el } = mount(THREE_NAMES)
      pick(el.querySelector('select[aria-label="Value scale"]') as HTMLSelectElement, 'log10')
      expect(box(el).disabled).toBe(true)
      expect(reason(el).textContent).toBe('ℹ a log scale has no zero to centre on')
      expect((reason(el).querySelector('.note-text') as HTMLElement).style.color).toBe('var(--ink-secondary)')
      expect(box(el).title).toBe('a log scale has no zero to centre on')
      expect(box(el).getAttribute('aria-describedby')).toBe('symmetric-reason')
      pick(el.querySelector('select[aria-label="Value scale"]') as HTMLSelectElement, 'linear')
      expect(box(el).disabled).toBe(false)
      expect(noteText(reason(el))).toBe('')
      expect(box(el).title).toBe('Puts zero in the middle of the colour ramp, so values above and below zero get matching colours.')
    })

    it('is disabled with the reason showStyle gives, and enabled again when there is none', () => {
      const { el, handle } = mount(THREE_NAMES)
      handle.showStyle(LINEAR, { ...NO_NOTES, symmetric: 'a log scale has no zero to centre on' })
      expect(box(el).disabled).toBe(true)
      expect(noteText(reason(el))).toBe('a log scale has no zero to centre on')
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
      expect(noteText(reason(el))).toBe('centre on zero was turned off: a log scale has no zero to centre on')
      // The view drew linear after all (log refused for non-positive cells): the trace stays.
      handle.showStyle(LINEAR, NO_NOTES)
      expect(box(el).disabled).toBe(false)
      expect(noteText(reason(el))).toBe('centre on zero was turned off: a log scale has no zero to centre on')

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
      expect(noteText(reason(el))).toBe('')
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
        'centre on zero was turned off: a log scale has no zero to centre on',
      )
      expect(box(el).checked).toBe(false)
      expect(noteText(reason(el))).toBe('centre on zero was turned off: a log scale has no zero to centre on')
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
        styleNote: 'centre on zero was turned off: manual limits are used as typed',
        onSelectionChange: vi.fn(),
      })
      expect(box(el).checked).toBe(true)
      expect(noteText(reason(el))).toBe('centre on zero was turned off: manual limits are used as typed')
    })
  })

  describe('the Patterns switch', () => {
    const box = (el: HTMLElement) => el.querySelector('input[aria-label="Patterns instead of colours"]') as HTMLInputElement
    const classesSelect = (el: HTMLElement) => el.querySelector('select[aria-label="Colour steps"]') as HTMLSelectElement
    const continuous = (el: HTMLElement) => classesSelect(el).querySelector('option[value="0"]') as HTMLOptionElement
    const note = (el: HTMLElement) => el.querySelector('#classes-note') as HTMLElement
    const reason = (el: HTMLElement) => el.querySelector('#texture-reason') as HTMLElement
    const NO_NOTES = { classes: null, symmetric: null, texture: null }

    function check(el: HTMLElement, on: boolean): void {
      box(el).checked = on
      box(el).dispatchEvent(new Event('change'))
    }

    it('is labelled Patterns instead of colours, says what it does on hover, and has a hint under it', () => {
      const { el } = mount(THREE_NAMES)
      const label = box(el).closest('label') as HTMLElement
      expect(label.textContent).toBe('Patterns instead of colours')
      expect(box(el).title).toBe('Draws each colour step as its own line pattern, for black-and-white printing, colour-blind readers, or seeing a basemap through the field. Uses colour steps.')
      expect(label.title).toBe('Draws each colour step as its own line pattern, for black-and-white printing, colour-blind readers, or seeing a basemap through the field. Uses colour steps.')
      const rowLabel = label.closest('.card-row')?.querySelector('.card-row-label') as HTMLElement
      expect(rowLabel.textContent).toBe('Patterns')
      expect(rowLabel.title).toBe(label.title)
      const hint = label.nextElementSibling as HTMLElement
      expect(hint.classList.contains('card-hint')).toBe(true)
      expect(hint.textContent).toBe('For print, colour-blind readers, or a basemap underneath.')
    })

    it('is a parameter-only checkbox after the Centre on zero row, with its reason line hidden', () => {
      const { el } = mount(THREE_NAMES)
      const input = box(el)
      expect(input.type).toBe('checkbox')
      expect(input.checked).toBe(false)
      const label = input.closest('.card-row') as HTMLElement
      expect(label.textContent).toContain('Patterns instead of colours')
      expect(label.getAttribute('data-colour-source')).toBe('par')
      const symmetricLabel = (el.querySelector('input[aria-label="Centre on zero"]') as HTMLElement).closest('.card-row') as HTMLElement
      expect(symmetricLabel.nextElementSibling).toBe(label)
      expect(reason(el).style.display).toBe('none')
      expect(reason(el).getAttribute('data-colour-source')).toBe('par')
    })

    // [edge MAPX-03 continuous]
    it('raises Smooth to 7 steps when checked, emits once, says so, and keeps Smooth off the list while on', () => {
      const { el, onSelectionChange } = mount(THREE_NAMES)
      onSelectionChange.mockClear()
      check(el, true)
      expect(classesSelect(el).value).toBe('7')
      expect(onSelectionChange).toHaveBeenCalledTimes(1)
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ style: { classes: 7, symmetric: false, texture: true } }),
      )
      expect(noteText(note(el))).toBe('patterns need colour steps, so 7 steps are drawn; pick 9 or 11 here')
      expect(note(el).textContent).toBe('⚠ patterns need colour steps, so 7 steps are drawn; pick 9 or 11 here')
      expect(note(el).style.display).toBe('')
      expect(continuous(el).disabled).toBe(true)

      check(el, false)
      expect(continuous(el).disabled).toBe(false)
      expect(classesSelect(el).value).toBe('7')
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ style: { classes: 7, symmetric: false, texture: false } }),
      )
      expect(note(el).style.display).toBe('none')
    })

    it('keeps the 7-classes note through a redraw with no class reason, and drops it when 9 or 11 is picked', () => {
      const { el, handle } = mount(THREE_NAMES)
      check(el, true)
      handle.showStyle({ classes: 7, symmetric: false, texture: true }, NO_NOTES)
      expect(noteText(note(el))).toBe('patterns need colour steps, so 7 steps are drawn; pick 9 or 11 here')
      classesSelect(el).value = '9'
      classesSelect(el).dispatchEvent(new Event('change'))
      expect(note(el).style.display).toBe('none')
    })

    it('keeps 11 classes when checked, with no note', () => {
      const { el, onSelectionChange } = mount(THREE_NAMES)
      classesSelect(el).value = '11'
      classesSelect(el).dispatchEvent(new Event('change'))
      check(el, true)
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ style: { classes: 11, symmetric: false, texture: true } }),
      )
      expect(note(el).style.display).toBe('none')
    })

    it('is disabled with the reason showStyle gives for a dot group, and enabled again without it', () => {
      const { el, handle } = mount(THREE_NAMES)
      const dots = 'patterns apply to cell fields; this group is drawn as dots'
      handle.showStyle({ classes: 7, symmetric: false, texture: false }, { ...NO_NOTES, texture: dots })
      expect(box(el).disabled).toBe(true)
      expect(noteText(reason(el))).toBe(dots)
      expect(reason(el).textContent).toBe(`ℹ ${dots}`)
      expect(box(el).title).toBe(dots)
      expect(reason(el).style.display).toBe('')
      expect(box(el).getAttribute('aria-describedby')).toBe('texture-reason')
      handle.showStyle({ classes: 7, symmetric: false, texture: false }, NO_NOTES)
      expect(box(el).disabled).toBe(false)
      expect(box(el).title).toBe('Draws each colour step as its own line pattern, for black-and-white printing, colour-blind readers, or seeing a basemap through the field. Uses colour steps.')
      expect(reason(el).style.display).toBe('none')
    })

    it('moves with sync without emitting, and disables Smooth while patterns are on', () => {
      const { el, handle, onSelectionChange } = mount(THREE_NAMES)
      handle.sync({
        colormap: 'viridis',
        reverseColormap: false,
        scale: 'linear',
        scaleInferred: true,
        limitsMode: 'robust',
        manualLimits: null,
        style: { classes: 9, symmetric: false, texture: true },
      })
      expect(box(el).checked).toBe(true)
      expect(continuous(el).disabled).toBe(true)
      expect(onSelectionChange).not.toHaveBeenCalled()
    })
  })

  it('lays its rows out as the card grid, with no inline layout of its own', () => {
    const { el } = mount(THREE_NAMES)
    expect(el.classList.contains('card-rows')).toBe(true)
    expect(el.style.maxWidth).toBe('')
    expect(el.style.display).toBe('')
    loadRealStylesheet()
    document.body.appendChild(el)
    const row = el.querySelector('.card-row') as HTMLElement
    expect(getComputedStyle(row).display).toBe('grid')
    expect(getComputedStyle(row).gridTemplateColumns).toBe('88px 144px')
    el.remove()
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
      expect(noteText(refusal(el))).toBe('realization "1" is not in iteration 0')
      expect(refusal(el)?.textContent).toBe('⚠ realization "1" is not in iteration 0')
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
      expect(noteText(refusal(el))).toBe(`realization "${typed}" is not in iteration 0`)
    })

    it('treats an empty box as nothing to do and clears an earlier refusal', () => {
      const { el, onSelectionChange } = mount(THREE_NAMES)
      commit(el, 'zzz')
      onSelectionChange.mockClear()

      commit(el, '')

      expect(onSelectionChange).not.toHaveBeenCalled()
      expect(noteText(refusal(el)) ?? '').toBe('')
      expect(goBox(el).hasAttribute('aria-invalid')).toBe(false)
    })

    it('clears the refusal on a later pick, a slider move and a slider click', () => {
      const { el } = mount(THREE_NAMES)

      commit(el, 'zzz')
      commit(el, 'r001')
      expect(noteText(refusal(el)) ?? '').toBe('')
      expect(goBox(el).hasAttribute('aria-invalid')).toBe(false)

      commit(el, 'zzz')
      slider(el).value = '2'
      slider(el).dispatchEvent(new Event('input'))
      expect(noteText(refusal(el)) ?? '').toBe('')

      commit(el, 'zzz')
      slider(el).click()
      expect(noteText(refusal(el)) ?? '').toBe('')
      expect(goBox(el).hasAttribute('aria-invalid')).toBe(false)
    })

    it('names the shown iteration, and rebuilds the list when the iteration changes', () => {
      const { el, handle } = mount(THREE_NAMES)
      commit(el, 'zzz')

      handle.setIteration(3)
      handle.setRealizations({ ok: true, names: ['r017', 'base'] }, 'base')

      expect(listValues(el)).toEqual(['r017', 'base'])
      expect(noteText(refusal(el)) ?? '').toBe('')
      commit(el, 'r001')
      expect(noteText(refusal(el))).toBe('realization "r001" is not in iteration 3')
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
      expect(el.textContent).toContain("ℹ Realization names weren't recorded for iteration 3")
      expect(realInput(el).title).toBe("Realization names weren't recorded for iteration 3, so a realization can't be named.")

      handle.setRealizations({ ok: true, names: ['base', 'r001'] }, 'base')
      expect(el.textContent).not.toContain("weren't recorded")
      expect(realInput(el).hasAttribute('title')).toBe(false)
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
