// @vitest-environment jsdom
//
// The basemap controls: each view says what was concluded and reports clicks; nothing is saved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatCoordinate,
  formatExtent,
  renderBasemapControls,
  type BasemapView,
} from '../src/ui/basemap-controls'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const opts = {
    onAdd: vi.fn(),
    onConfirm: vi.fn(),
    onSubmitNumbers: vi.fn(),
    onCancel: vi.fn(),
    onRemove: vi.fn(),
    onColourChange: vi.fn(),
    onOpacityChange: vi.fn(),
  }
  const handle = renderBasemapControls(host, opts)
  return { host, handle, opts }
}

function buttons(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('button')).map((b) => b.textContent ?? '')
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === text)
  if (!found) throw new Error(`no button ${text}`)
  return found
}

function input(host: HTMLElement, label: string): HTMLInputElement {
  const found = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!found) throw new Error(`no input ${label}`)
  return found
}

function lines(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('.basemap-controls > div')).map((d) => d.textContent ?? '')
}

function typeNumbers(host: HTMLElement, values: [string, string, string, string]): void {
  ;['x min', 'x max', 'y min', 'y max'].forEach((label, i) => {
    input(host, label).value = values[i]
  })
}

const PROPOSAL: BasemapView = {
  kind: 'proposal',
  name: 'map.png',
  worldFile: 'map.pgw',
  extent: [999, 1199, 1901, 2001],
  notes: ['rotation flag in the file ignored; placed as stored'],
}

const NUMBERS: BasemapView = {
  kind: 'numbers',
  name: 'map.png',
  reason: 'no world file was found next to the image',
  worldFiles: [],
  modelExtent: [0, 1000, 0, 500],
}

function ready(overrides: Partial<Extract<BasemapView, { kind: 'ready' }>> = {}): BasemapView {
  return {
    kind: 'ready',
    name: 'map.png',
    placedBy: 'world_file',
    worldFile: 'map.pgw',
    extent: [999, 1199, 1901, 2001],
    notes: ['downscaled to 8192 px wide for the graphics card'],
    colour: false,
    opacity: 1,
    ...overrides,
  }
}

beforeEach(() => {
  document.body.textContent = ''
})

afterEach(() => {
  document.head.textContent = ''
})

describe('formatCoordinate and formatExtent', () => {
  it('drops trailing zeros and keeps three decimals at most', () => {
    expect(formatCoordinate(999)).toBe('999')
    expect(formatCoordinate(7020000.25)).toBe('7020000.25')
    expect(formatCoordinate(1 / 3)).toBe('0.333')
    expect(formatCoordinate(-0.0001)).toBe('0')
  })

  it('writes x then y with a middle dot between', () => {
    expect(formatExtent([999, 1199, 1901, 2001])).toBe('x 999 to 1199 · y 1901 to 2001')
  })
})

describe('renderBasemapControls', () => {
  it('starts with one Add basemap button that calls onAdd', () => {
    const { host, opts } = mount()
    expect(host.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Basemap')
    expect(buttons(host)).toEqual(['Add basemap'])
    button(host, 'Add basemap').click()
    expect(opts.onAdd).toHaveBeenCalledTimes(1)
  })

  it('shows only the text while busy', () => {
    const { host, handle } = mount()
    handle.show({ kind: 'busy', text: 'reading map.png…' })
    expect(buttons(host)).toEqual([])
    expect(lines(host)).toEqual(['reading map.png…'])
  })

  it('asks to confirm a world-file placement with the numbers and notes, in one click', () => {
    const { host, handle, opts } = mount()
    handle.show(PROPOSAL)
    expect(lines(host)).toEqual([
      'Place map.png by its world file map.pgw?',
      'x 999 to 1199 · y 1901 to 2001',
      'rotation flag in the file ignored; placed as stored',
      'ConfirmCancel',
    ])
    button(host, 'Confirm').click()
    expect(opts.onConfirm).toHaveBeenCalledTimes(1)
    button(host, 'Cancel').click()
    expect(opts.onCancel).toHaveBeenCalledTimes(1)
  })

  it('shows the four-number form with the reason and the model extent as a hint', () => {
    const { host, handle } = mount()
    handle.show({ ...NUMBERS, worldFiles: ['map.pgw', 'map.wld'] })
    const text = host.textContent ?? ''
    expect(text).toContain('no world file was found next to the image')
    expect(text).toContain('map.pgw, map.wld')
    expect(text).toContain('the model spans x 0 to 1000 · y 0 to 500')
    for (const label of ['x min', 'x max', 'y min', 'y max']) {
      expect(input(host, label).type).toBe('number')
      expect(input(host, label).closest('label')?.textContent).toBe(label)
    }
    expect(buttons(host)).toContain('Place')
  })

  it('places four good numbers in x min, x max, y min, y max order', () => {
    const { host, handle, opts } = mount()
    handle.show(NUMBERS)
    typeNumbers(host, ['0', '1000', '0', '500'])
    button(host, 'Place').click()
    expect(opts.onSubmitNumbers).toHaveBeenCalledWith([0, 1000, 0, 500])
  })

  it('refuses an out-of-order x pair inline and calls nothing', () => {
    const { host, handle, opts } = mount()
    handle.show(NUMBERS)
    typeNumbers(host, ['10', '5', '0', '500'])
    button(host, 'Place').click()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('x min must be less than x max')
    expect(opts.onSubmitNumbers).not.toHaveBeenCalled()
  })

  it('refuses an out-of-order y pair inline', () => {
    const { host, handle, opts } = mount()
    handle.show(NUMBERS)
    typeNumbers(host, ['0', '1000', '500', '500'])
    button(host, 'Place').click()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('y min must be less than y max')
    expect(opts.onSubmitNumbers).not.toHaveBeenCalled()
  })

  it('refuses an empty or non-finite number inline', () => {
    const { host, handle, opts } = mount()
    handle.show(NUMBERS)
    typeNumbers(host, ['0', '', '0', '500'])
    button(host, 'Place').click()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('each of the four numbers must be a finite number')
    typeNumbers(host, ['0', '1e999', '0', '500'])
    button(host, 'Place').click()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('each of the four numbers must be a finite number')
    expect(opts.onSubmitNumbers).not.toHaveBeenCalled()
  })

  it('shows a server error and keeps the numbers typed for the same image', () => {
    const { host, handle } = mount()
    handle.show(NUMBERS)
    typeNumbers(host, ['5000', '6000', '0', '500'])
    button(host, 'Place').click()
    handle.show({ ...NUMBERS, error: 'the numbers you typed do not overlap the model' })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('the numbers you typed do not overlap the model')
    expect(input(host, 'x min').value).toBe('5000')
  })

  it('shows a refusal and offers Add basemap again', () => {
    const { host, handle, opts } = mount()
    handle.show({ kind: 'refused', reason: 'TIFF and GeoTIFF basemaps are not supported yet (planned for M2)' })
    expect(lines(host)[0]).toBe('TIFF and GeoTIFF basemaps are not supported yet (planned for M2)')
    expect(host.querySelector('.basemap-warning')).not.toBeNull()
    button(host, 'Add basemap').click()
    expect(opts.onAdd).toHaveBeenCalledTimes(1)
  })

  it('says a ready basemap was placed by its world file, with the numbers and notes', () => {
    const { host, handle, opts } = mount()
    handle.show(ready())
    expect(lines(host).slice(0, 3)).toEqual([
      'basemap placed by world file map.pgw',
      'x 999 to 1199 · y 1901 to 2001',
      'downscaled to 8192 px wide for the graphics card',
    ])
    button(host, 'Remove basemap').click()
    expect(opts.onRemove).toHaveBeenCalledTimes(1)
  })

  it('says a ready basemap was placed by four numbers you typed', () => {
    const { host, handle } = mount()
    handle.show(ready({ placedBy: 'numbers', worldFile: null, extent: [0, 1000, 0, 500] }))
    expect(lines(host).slice(0, 2)).toEqual(['basemap placed by four numbers you typed', 'x 0 to 1000 · y 0 to 500'])
  })

  it('starts the colour toggle off and reports a change', () => {
    const { host, handle, opts } = mount()
    handle.show(ready())
    const colour = input(host, 'Colour')
    expect(colour.type).toBe('checkbox')
    expect(colour.checked).toBe(false)
    colour.click()
    expect(opts.onColourChange).toHaveBeenCalledWith(true)
  })

  it('starts the field opacity at 100% and reads outlines only at 0', () => {
    const { host, handle, opts } = mount()
    handle.show(ready())
    const range = input(host, 'Field opacity')
    const reading = host.querySelector('.basemap-opacity-reading')
    expect(range.type).toBe('range')
    expect(range.min).toBe('0')
    expect(range.max).toBe('100')
    expect(range.value).toBe('100')
    expect(reading?.textContent).toBe('100%')

    range.value = '40'
    range.dispatchEvent(new Event('input'))
    expect(opts.onOpacityChange).toHaveBeenLastCalledWith(0.4)
    expect(reading?.textContent).toBe('40%')

    range.value = '0'
    range.dispatchEvent(new Event('input'))
    expect(opts.onOpacityChange).toHaveBeenLastCalledWith(0)
    expect(reading?.textContent).toBe('outlines only')
  })

  it('takes colour and opacity from the view each time it is shown', () => {
    const { host, handle } = mount()
    handle.show(ready({ colour: true, opacity: 0 }))
    expect(input(host, 'Colour').checked).toBe(true)
    expect(input(host, 'Field opacity').value).toBe('0')
    expect(host.querySelector('.basemap-opacity-reading')?.textContent).toBe('outlines only')
  })

  it('shows why an unavailable basemap is not drawn and offers Remove', () => {
    const { host, handle, opts } = mount()
    handle.show({ kind: 'unavailable', reason: 'map.png changed size since it was placed' })
    expect(lines(host)[0]).toBe('map.png changed size since it was placed')
    expect(buttons(host)).toEqual(['Remove basemap'])
    button(host, 'Remove basemap').click()
    expect(opts.onRemove).toHaveBeenCalledTimes(1)
  })

  it('shows a failure as a quiet reason with no buttons', () => {
    const { host, handle } = mount()
    handle.show({ kind: 'failed', reason: 'this browser cannot decode images for the map (no createImageBitmap)' })
    expect(buttons(host)).toEqual([])
    expect(host.querySelector('.basemap-muted')?.textContent).toBe('this browser cannot decode images for the map (no createImageBitmap)')
  })

  it('renders a name holding markup as text', () => {
    const { host, handle } = mount()
    handle.show({ ...PROPOSAL, name: '<img src=x onerror=alert(1)>.png' })
    expect(host.querySelector('img')).toBeNull()
    expect(lines(host)[0]).toBe('Place <img src=x onerror=alert(1)>.png by its world file map.pgw?')
  })

  it('does nothing after dispose', () => {
    const { host, handle, opts } = mount()
    const add = button(host, 'Add basemap')
    handle.dispose()
    expect(host.textContent).toBe('')
    add.click()
    handle.show(ready())
    expect(opts.onAdd).not.toHaveBeenCalled()
    expect(host.textContent).toBe('')
  })

  it('keeps every part of every view apart with the real stylesheet', () => {
    loadRealStylesheet()
    const views: BasemapView[] = [
      { kind: 'none' },
      PROPOSAL,
      { ...NUMBERS, worldFiles: ['a.pgw', 'a.wld'], error: 'the numbers you typed do not overlap the model' },
      { kind: 'refused', reason: 'a reason' },
      ready(),
      { kind: 'unavailable', reason: 'a reason' },
    ]
    for (const view of views) {
      const { host, handle } = mount()
      handle.show(view)
      expectNoRunTogetherText(host, `basemap-controls ${view.kind}`)
    }
  })
})
