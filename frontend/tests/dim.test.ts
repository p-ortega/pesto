// @vitest-environment jsdom
// The one dim rule every view shares (D-02, D-03), and the theme token it
// reads its strength from.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isDimmed, readDimAlpha } from '../src/data/dim'

const styleSheetPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'style.css')

function blockOf(source: string, selector: string): string {
  const start = source.indexOf(selector)
  if (start === -1) throw new Error(`selector ${selector} not found in style.css`)
  const open = source.indexOf('{', start)
  return source.slice(open + 1, source.indexOf('}', open))
}

describe('isDimmed', () => {
  it('dims nothing while the selection is empty', () => {
    expect(isDimmed(new Set<number>(), 3)).toBe(false)
  })

  it('dims a mark that is not in a non-empty selection', () => {
    expect(isDimmed(new Set([1]), 3)).toBe(true)
  })

  it('never dims a selected mark', () => {
    expect(isDimmed(new Set([3]), 3)).toBe(false)
  })

  it('dims nothing again once the last member is removed', () => {
    const selected = new Set(['p1'])
    expect(isDimmed(selected, 'p2')).toBe(true)
    selected.delete('p1')
    expect(isDimmed(selected, 'p2')).toBe(false)
  })
})

describe('readDimAlpha', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--dim-alpha')
  })

  it('reads --dim-alpha off the element it is given', () => {
    document.documentElement.style.setProperty('--dim-alpha', '0.35')
    expect(readDimAlpha(document.documentElement)).toBeCloseTo(0.35, 6)
  })

  it('reads an unset token as no dimming', () => {
    expect(readDimAlpha(document.createElement('div'))).toBe(1)
  })

  it('refuses a token that is not an alpha', () => {
    document.documentElement.style.setProperty('--dim-alpha', '1.5')
    expect(() => readDimAlpha(document.documentElement)).toThrow(/1\.5/)
  })
})

describe('style.css dim token', () => {
  const source = readFileSync(styleSheetPath, 'utf8')

  it('declares --dim-alpha in the light and the dark theme', () => {
    expect(blockOf(source, ':root')).toMatch(/--dim-alpha:\s*0?\.\d+;/)
    expect(blockOf(source, "[data-theme='dark']")).toMatch(/--dim-alpha:\s*0?\.\d+;/)
  })

  it('dims a row through the token, never by hiding it', () => {
    const rule = blockOf(source, '.dimmed {')
    expect(rule).toContain('opacity: var(--dim-alpha)')
    expect(rule).not.toMatch(/display:\s*none|visibility:\s*hidden|pointer-events:\s*none/)
  })
})
