// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { paintNote } from '../src/ui/note-line'

function line(): HTMLElement {
  const el = document.createElement('div')
  el.id = 'some-note'
  return el
}

const glyph = (el: HTMLElement) => el.querySelector('span[aria-hidden="true"]') as HTMLElement
const text = (el: HTMLElement) => el.querySelector('.note-text') as HTMLElement

describe('paintNote', () => {
  it('draws a reason as an ℹ glyph and the message in secondary ink', () => {
    const el = line()
    el.style.display = 'none'
    paintNote(el, { kind: 'reason', text: 'a log scale has no zero to centre on' })
    expect(el.style.display).toBe('')
    expect(el.textContent).toBe('ℹ a log scale has no zero to centre on')
    expect(glyph(el).textContent).toBe('ℹ')
    expect(text(el).textContent).toBe('a log scale has no zero to centre on')
    expect(text(el).style.color).toBe('var(--ink-secondary)')
  })

  it('draws a warning with only the ⚠ glyph in warning ink and the message in primary ink', () => {
    const el = line()
    paintNote(el, { kind: 'warning', text: 'x' })
    expect(el.textContent).toBe('⚠ x')
    expect(glyph(el).textContent).toBe('⚠')
    expect(glyph(el).style.color).toBe('var(--status-warning)')
    expect(text(el).style.color).toBe('var(--ink-primary)')
  })

  it('empties and hides the line for null, keeping its id', () => {
    const el = line()
    paintNote(el, { kind: 'warning', text: 'x' })
    paintNote(el, null)
    expect(el.textContent).toBe('')
    expect(el.childElementCount).toBe(0)
    expect(el.style.display).toBe('none')
    expect(el.id).toBe('some-note')
  })

  it('replaces the previous note instead of adding to it', () => {
    const el = line()
    paintNote(el, { kind: 'warning', text: 'first' })
    paintNote(el, { kind: 'reason', text: 'second' })
    expect(el.textContent).toBe('ℹ second')
    expect(el.querySelectorAll('.note-text')).toHaveLength(1)
  })

  it('shows markup in a message as text, never as elements', () => {
    const el = line()
    paintNote(el, { kind: 'reason', text: '<b>bold</b>' })
    expect(text(el).textContent).toBe('<b>bold</b>')
    expect(el.querySelector('b')).toBeNull()
  })
})
