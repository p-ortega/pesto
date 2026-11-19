// @vitest-environment jsdom
//
// The enlarged chart panel and the small chart controls: a chart's frame is moved over the map
// and put back, Escape and Close both close it, and only one chart is enlarged at a time.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { chartSwitch, chartToggle, enlargeButton, focusedControl, refocusControl } from '../src/ui/charts/controls'
import { closeEnlarged, enlargeChart } from '../src/ui/charts/enlarge'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

function page(): { map: HTMLElement; side: HTMLElement; frame: HTMLElement; box: HTMLElement } {
  const map = document.createElement('div')
  map.classList.add('map-area')
  const side = document.createElement('div')
  const frame = document.createElement('div')
  frame.classList.add('chart-frame')
  const box = document.createElement('div')
  box.classList.add('chart-box')
  box.style.height = '280px'
  frame.appendChild(box)
  side.appendChild(frame)
  document.body.append(map, side)
  return { map, side, frame, box }
}

function escape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

afterEach(() => {
  closeEnlarged()
  document.head.textContent = ''
  document.body.textContent = ''
})

describe('an enlarged chart', () => {
  it('moves the frame over the map with its title and a Close button, and leaves a note where it was', () => {
    const { map, side, frame, box } = page()
    const onResize = vi.fn()
    enlargeChart({ title: '1:1 plot of group gw_head', frame, onResize })

    const panel = map.querySelector('.chart-enlarged-panel')!
    expect(panel.contains(frame)).toBe(true)
    expect(panel.querySelector('.heading')!.textContent).toBe('1:1 plot of group gw_head')
    expect([...panel.querySelectorAll('button')].map((b) => b.textContent)).toContain('Close')
    expect(side.textContent).toContain('shown enlarged over the map')
    // The fixed side-panel height is lifted, so the panel's own layout sizes the chart.
    expect(box.style.height).toBe('')
    expect(onResize).toHaveBeenCalledTimes(1)
  })

  it('puts the frame back where it was, at its old height, when Close is pressed', () => {
    const { map, side, frame, box } = page()
    const onResize = vi.fn()
    const onClose = vi.fn()
    enlargeChart({ title: 'well A', frame, onResize, onClose })

    const close = [...map.querySelectorAll('button')].find((b) => b.textContent === 'Close')!
    close.click()

    expect(map.querySelector('.chart-enlarged')).toBeNull()
    expect(side.firstElementChild).toBe(frame)
    expect(side.textContent).not.toContain('shown enlarged')
    expect(box.style.height).toBe('280px')
    expect(onResize).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape, and on the side panel\'s own Bring back button', () => {
    const { map, side, frame } = page()
    enlargeChart({ title: 'well A', frame, onResize: () => {} })
    escape()
    expect(map.querySelector('.chart-enlarged')).toBeNull()
    expect(side.firstElementChild).toBe(frame)

    enlargeChart({ title: 'well A', frame, onResize: () => {} })
    ;[...side.querySelectorAll('button')].find((b) => b.textContent === 'Bring back')!.click()
    expect(map.querySelector('.chart-enlarged')).toBeNull()
    expect(side.firstElementChild).toBe(frame)
  })

  it('shows one chart at a time: opening a second puts the first back', () => {
    const { map, side, frame } = page()
    const other = document.createElement('div')
    side.appendChild(other)
    const firstClosed = vi.fn()
    enlargeChart({ title: 'first', frame, onResize: () => {}, onClose: firstClosed })
    enlargeChart({ title: 'second', frame: other, onResize: () => {} })

    expect(map.querySelectorAll('.chart-enlarged').length).toBe(1)
    expect(map.querySelector('.heading')!.textContent).toBe('second')
    expect(firstClosed).toHaveBeenCalledTimes(1)
    expect(side.contains(frame)).toBe(true)
  })

  it('lets go of a frame whose place in the side panel is gone, never leaving it over the map', () => {
    const { map, side, frame } = page()
    const handle = enlargeChart({ title: 'well A', frame, onResize: () => {} })
    side.textContent = ''
    handle.close()

    expect(map.querySelector('.chart-enlarged')).toBeNull()
    expect(frame.isConnected).toBe(false)
  })

  it('covers the page when there is no map to cover', () => {
    const frame = document.createElement('div')
    document.body.appendChild(frame)
    enlargeChart({ title: 'well A', frame, onResize: () => {} })

    expect(document.body.querySelector('.chart-enlarged')!.classList.contains('chart-enlarged-page')).toBe(true)
  })

  it('never runs its title, its button or its note together', () => {
    loadRealStylesheet()
    const { frame } = page()
    enlargeChart({ title: 'well A', frame, onResize: () => {} })
    expectNoRunTogetherText(document.body, 'charts/enlarge.ts')
  })
})

describe('the chart controls', () => {
  it('marks the chosen side of a switch with aria-pressed and reports a pick', () => {
    const onPick = vi.fn()
    const { el } = chartSwitch({
      key: 'scale',
      label: 'Scale',
      ariaLabel: 'Scale of the value axis',
      value: 'linear',
      options: [
        { value: 'linear', text: 'linear', title: 'linear axis' },
        { value: 'log', text: 'log', title: 'log axis' },
      ],
      onPick,
    })
    document.body.appendChild(el)
    const [linear, log] = [...el.querySelectorAll('button')]

    expect(el.getAttribute('role')).toBe('group')
    expect(linear.getAttribute('aria-pressed')).toBe('true')
    log.click()
    expect(onPick).toHaveBeenCalledWith('log')
    expect(log.getAttribute('aria-pressed')).toBe('true')
    expect(linear.getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps a refused choice in reach with its reason as the tooltip, and ignores a press on it', () => {
    const onPick = vi.fn()
    const { el } = chartSwitch({
      key: 'scale',
      label: 'Scale',
      ariaLabel: 'Scale of the value axis',
      value: 'linear',
      options: [
        { value: 'linear', text: 'linear', title: 'linear axis' },
        { value: 'log', text: 'log', title: 'log axis', refused: 'A log axis needs every value above zero.' },
      ],
      onPick,
    })
    const log = el.querySelectorAll('button')[1]

    expect(log.getAttribute('aria-disabled')).toBe('true')
    expect(log.title).toBe('A log axis needs every value above zero.')
    log.click()
    expect(onPick).not.toHaveBeenCalled()
    expect(log.getAttribute('aria-pressed')).toBe('false')
  })

  it('flips an on/off button and puts focus back on a control by its key after a rebuild', () => {
    const onToggle = vi.fn()
    const make = () => chartToggle({ key: 'show:base', text: 'base', title: 'Show or hide base', pressed: true, onToggle })
    const root = document.createElement('div')
    document.body.appendChild(root)
    const first = make()
    root.appendChild(first)
    first.focus()
    first.click()
    expect(onToggle).toHaveBeenCalledWith(false)
    expect(first.getAttribute('aria-pressed')).toBe('false')

    const key = focusedControl(root)
    root.textContent = ''
    const second = make()
    root.appendChild(second)
    refocusControl(root, key)
    expect(document.activeElement).toBe(second)
  })

  it('names the Enlarge button and explains it', () => {
    const button = enlargeButton(() => {})
    expect(button.textContent).toBe('Enlarge')
    expect(button.title).toContain('over the map')
  })
})
