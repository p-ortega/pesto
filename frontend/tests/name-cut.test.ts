// @vitest-environment jsdom
//
// A long site or group name keeps its end in view: the start is cut with an ellipsis and the part
// that tells sites apart stays whole. The cut is drawing only; the cell's text and title are the name.

import { describe, expect, it } from 'vitest'
import { nameTailStart, paintCutName } from '../src/ui/name-cut'
import { loadRealStylesheet } from './support/run-together'

const LONG = 'oname:coarse.hds_otype:lst_usecol:sim_head_masl_obs_id:bore-21b'

const tailOf = (name: string): string | null => {
  const at = nameTailStart(name)
  return at === -1 ? null : name.slice(at)
}

describe('where a name keeps its end', () => {
  it('keeps the text after the last separator when it is 4 to 24 characters long', () => {
    expect(tailOf(LONG)).toBe('bore-21b')
    expect(tailOf('coarse.dvhds:eh-38a.eh-38d')).toBe('eh-38a.eh-38d')
    expect(tailOf('coarse.hds:bore-21b')).toBe('bore-21b')
    expect(tailOf('a_very_long_group_name/well|deep-well-07')).toBe('deep-well-07')
  })

  it('does not split a name of 16 characters or fewer', () => {
    expect(nameTailStart('gw_head')).toBe(-1)
    expect(nameTailStart('sixteen_chars_ab')).toBe(-1)
  })

  it('keeps the last 16 characters when no separator sits in the last 25', () => {
    const name = 'coarse.hds.' + 'abcdefghijklmnopqrstuvwxyz0123'
    expect(tailOf(name)).toBe(name.slice(-16))
  })

  it('keeps the last 16 characters when the name ends in a separator', () => {
    const name = 'oname:coarse.hds_otype:lst_'
    expect(tailOf(name)).toBe(name.slice(-16))
  })

  it('keeps the last 16 characters when the part after the separator is too short or too long', () => {
    const short = 'oname:coarse.hds_otype:lst:ab'
    expect(tailOf(short)).toBe(short.slice(-16))
    const long = 'oname:' + 'x'.repeat(30)
    expect(tailOf(long)).toBe(long.slice(-16))
  })
})

describe('a cut name cell', () => {
  it('holds the whole name as its text and title, in a head that cuts and a tail that stays', () => {
    const cell = document.createElement('span')
    paintCutName(cell, LONG)
    expect(cell.textContent).toBe(LONG)
    expect(cell.title).toBe(LONG)
    expect(cell.classList.contains('name-cut')).toBe(true)
    expect(cell.querySelector('.name-head')?.textContent).toBe(LONG.slice(0, LONG.length - 'bore-21b'.length))
    expect(cell.querySelector('.name-tail')?.textContent).toBe('bore-21b')
  })

  it('takes its own title when one is given', () => {
    const cell = document.createElement('span')
    paintCutName(cell, '—', 'no group was recorded for this site')
    expect(cell.textContent).toBe('—')
    expect(cell.title).toBe('no group was recorded for this site')
  })

  it('leaves a short name whole, with no parts', () => {
    const cell = document.createElement('span')
    paintCutName(cell, 'gw_head')
    expect(cell.textContent).toBe('gw_head')
    expect(cell.title).toBe('gw_head')
    expect(cell.querySelector('.name-head')).toBeNull()
    expect(cell.classList.contains('name-cut')).toBe(false)
  })

  it('writes markup in a name as text', () => {
    const name = 'oname:coarse.hds_otype:<img src=x onerror=alert(1)>'
    const cell = document.createElement('span')
    paintCutName(cell, name)
    expect(cell.querySelector('img')).toBeNull()
    expect(cell.textContent).toBe(name)
  })

  it('repaints from scratch, so a cell drawn twice holds one name', () => {
    const cell = document.createElement('span')
    paintCutName(cell, LONG)
    paintCutName(cell, 'gw_head')
    expect(cell.textContent).toBe('gw_head')
    expect(cell.classList.contains('name-cut')).toBe(false)
  })

  it('draws the head shrinking with an ellipsis and the tail at its own width, on one line', () => {
    loadRealStylesheet()
    const cell = document.createElement('span')
    document.body.appendChild(cell)
    paintCutName(cell, LONG)
    expect(getComputedStyle(cell).display).toBe('flex')
    expect(getComputedStyle(cell).whiteSpace).toBe('nowrap')
    const head = getComputedStyle(cell.querySelector('.name-head')!)
    expect(head.textOverflow).toBe('ellipsis')
    expect(head.overflow).toBe('hidden')
    expect(['0', '0px']).toContain(head.minWidth)
    expect(getComputedStyle(cell.querySelector('.name-tail')!).flexShrink).toBe('0')
  })
})
