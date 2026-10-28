// @vitest-environment jsdom
//
// The time slider on its own: what it shows for each kind of group, what it tells the caller, and
// that nothing it is given reaches the page as markup.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderTimeSlider, type TimeSliderHandle } from '../src/ui/time-slider'

let host: HTMLElement
let onChange: ReturnType<typeof vi.fn<(index: number) => void>>
let handle: TimeSliderHandle

const range = (): HTMLInputElement | null => host.querySelector('input[type="range"]')

beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.appendChild(host)
  onChange = vi.fn<(index: number) => void>()
  handle = renderTimeSlider(host, { onChange })
})

describe('renderTimeSlider', () => {
  it('starts hidden', () => {
    expect(host.hidden).toBe(true)
  })

  it('shows one step per time and the first time as text', () => {
    handle.show([10, 20, 30], 'numeric', 'time', 0, null, 'heads')
    expect(host.hidden).toBe(false)
    expect(range()!.min).toBe('0')
    expect(range()!.max).toBe('2')
    expect(range()!.value).toBe('0')
    expect(host.textContent).toContain('day 10 (model time)')
    expect(host.textContent).toContain('1 of 3')
  })

  it('is a labelled range input that names the group', () => {
    handle.show([10, 20], 'numeric', 'time', 0, null, 'heads')
    expect(range()!.getAttribute('aria-label')).toBe('Observation time of heads')
  })

  it('tells the caller the chosen index and updates its text on an input event', () => {
    handle.show([10, 20, 30], 'numeric', 'time', 0, null)
    range()!.value = '2'
    range()!.dispatchEvent(new Event('input'))
    expect(onChange).toHaveBeenCalledWith(2)
    expect(host.textContent).toContain('day 30 (model time)')
  })

  it('moves with setIndex and does not call the caller', () => {
    handle.show([10, 20, 30], 'numeric', 'time', 0, null)
    handle.setIndex(1)
    expect(range()!.value).toBe('1')
    expect(host.textContent).toContain('day 20 (model time)')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ignores a setIndex outside the times', () => {
    handle.show([10, 20], 'numeric', 'time', 0, null)
    handle.setIndex(5)
    expect(range()!.value).toBe('0')
  })

  it('shows dates for a datetime group', () => {
    handle.show([19000, 19001], 'datetime', 'time', 1, null)
    expect(host.textContent).toContain('2022-01-09')
  })

  it('says an ordinal group steps by position', () => {
    handle.show([1, 2, 3], 'ordinal (no time found)', 'position', 0, null)
    expect(host.textContent).toContain('steps by position in site (no time found)')
  })

  it('shows a group with one time as text and no range input', () => {
    handle.show([10], 'numeric', 'time', 0, null)
    expect(host.textContent).toContain('day 10 (model time)')
    expect(range()).toBeNull()
  })

  it('shows the refusal and no range input for a refused group', () => {
    handle.show([10, 20], 'numeric', 'time', 0, null)
    handle.refuse('the sites of this group mix time kinds')
    expect(host.hidden).toBe(false)
    expect(range()).toBeNull()
    expect(host.textContent).toContain('the sites of this group mix time kinds')
  })

  it('shows the note it is given', () => {
    handle.show([10, 20], 'numeric', 'time', 0, 'this group has no observation at day 9, so the slider moved to its first time')
    expect(host.textContent).toContain('so the slider moved to its first time')
  })

  it('shows and clears a status line', () => {
    handle.show([10, 20], 'numeric', 'time', 0, null)
    handle.setStatus('reading this time…')
    expect(host.querySelector('[role="status"]')!.textContent).toBe('reading this time…')
    handle.setStatus(null)
    expect(host.querySelector('[role="status"]')!.textContent).toBe('')
  })

  it('hides and drops its input', () => {
    handle.show([10, 20], 'numeric', 'time', 0, null)
    handle.hide()
    expect(host.hidden).toBe(true)
    expect(range()).toBeNull()
  })

  it('keeps the same input across a show with the same kind of group, so focus stays', () => {
    handle.show([10, 20, 30], 'numeric', 'time', 0, null, 'heads')
    const first = range()
    handle.show([10, 20, 30], 'numeric', 'time', 2, null, 'heads')
    expect(range()).toBe(first)
    expect(first!.value).toBe('2')
  })

  it('puts a name, a reason and a note on the page as text, never as markup', () => {
    handle.show([10, 20], 'numeric', 'time', 0, '<b>note</b>', '<i>group</i>')
    handle.setStatus('<u>status</u>')
    expect(host.querySelector('b, i, u')).toBeNull()
    expect(range()!.getAttribute('aria-label')).toBe('Observation time of <i>group</i>')
    handle.refuse('<s>reason</s>')
    expect(host.querySelector('s')).toBeNull()
    expect(host.textContent).toContain('<s>reason</s>')
  })
})
