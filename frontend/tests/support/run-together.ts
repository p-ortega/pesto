// The run-together check shared by the guard test and any later test that renders
// a component and wants to know that adjacent text parts do not fuse into one string.
//
// It walks every element that has two or more element children carrying real text
// and fails, naming the component and the two strings, when an adjacent pair has no
// real separation: no non-zero `gap` on a flex/grid parent, no non-zero margin on
// either side, no whitespace text node between them, and neither side is a
// block-level box that would force its own line regardless of gap.
//
// `<select>` is skipped as a parent: its `<option>` children render one per native
// dropdown row by the browser's own form-control chrome, not by CSS box layout.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

const supportDir = dirname(fileURLToPath(import.meta.url))
const styleSheetPath = join(supportDir, '..', '..', 'src', 'style.css')

const BLOCK_LIKE = new Set(['block', 'list-item', 'flex', 'grid', 'table', 'flow-root'])
const FLEX_OR_GRID = new Set(['flex', 'inline-flex', 'grid', 'inline-grid'])

function textOf(el: Element): string {
  return (el.textContent ?? '').trim()
}

function isZeroOrUnset(value: string): boolean {
  if (value === '' || value === 'auto') return true
  const n = parseFloat(value)
  return Number.isFinite(n) && n === 0
}

// A whitespace-only text node directly between the two elements in the DOM
// -- the plain-HTML way two inline elements end up with a real space
// between them, even with no CSS involved at all.
function hasWhitespaceTextBetween(parent: Element, a: Element, b: Element): boolean {
  const nodes = Array.from(parent.childNodes)
  const startIndex = nodes.indexOf(a)
  const endIndex = nodes.indexOf(b)
  for (let i = startIndex + 1; i < endIndex; i++) {
    const node = nodes[i]
    if (node.nodeType === 3 && (node.textContent ?? '').length > 0 && (node.textContent ?? '').trim() === '') {
      return true
    }
  }
  return false
}

function hasRealMargin(a: Element, b: Element): boolean {
  const aStyle = getComputedStyle(a)
  const bStyle = getComputedStyle(b)
  const candidates = [aStyle.marginRight, aStyle.marginBottom, bStyle.marginLeft, bStyle.marginTop]
  return candidates.some((value) => !isZeroOrUnset(value))
}

function hasRealGapOnParent(parent: Element): boolean {
  const style = getComputedStyle(parent)
  if (!FLEX_OR_GRID.has(style.display)) return false
  const gap = style.gap || style.rowGap || style.columnGap
  return gap !== '' && gap !== '0px' && gap !== 'normal'
}

function isBlockLike(el: Element): boolean {
  return BLOCK_LIKE.has(getComputedStyle(el).display)
}

// Separated if any one of: a real whitespace text node between them, a real
// margin on either side, a real gap on a flex/grid parent, or either side
// is itself a block-level box (which forces its own line regardless of the
// parent's own display or gap).
function pairIsSeparated(parent: Element, a: Element, b: Element): boolean {
  return (
    hasWhitespaceTextBetween(parent, a, b) ||
    hasRealMargin(a, b) ||
    hasRealGapOnParent(parent) ||
    isBlockLike(a) ||
    isBlockLike(b)
  )
}

export interface Violation {
  component: string
  parent: string
  textA: string
  textB: string
}

function describeParent(el: Element): string {
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(' ').join('.')}` : ''
  return `${el.tagName.toLowerCase()}${cls}`
}

// Walks every element under (and including) `root`, and for each one with
// two or more element children carrying real text, checks every adjacent
// pair of those text-bearing children. `<select>` is skipped.
export function findRunTogetherText(root: Element, component: string): Violation[] {
  const violations: Violation[] = []
  const candidates = [root, ...Array.from(root.querySelectorAll('*'))]
  for (const parent of candidates) {
    if (parent.tagName === 'SELECT' || parent.tagName === 'OPTGROUP') continue
    const textBearing = Array.from(parent.children).filter((child) => textOf(child).length > 0)
    for (let i = 0; i + 1 < textBearing.length; i++) {
      const a = textBearing[i]
      const b = textBearing[i + 1]
      if (!pairIsSeparated(parent, a, b)) {
        violations.push({ component, parent: describeParent(parent), textA: textOf(a), textB: textOf(b) })
      }
    }
  }
  return violations
}

export function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `[${v.component}] inside <${v.parent}>: "${v.textA}" runs into "${v.textB}" with no separation`)
    .join('\n')
}

export function expectNoRunTogetherText(root: Element, component: string): void {
  const violations = findRunTogetherText(root, component)
  expect(violations, formatViolations(violations)).toEqual([])
}

export function loadRealStylesheet(): void {
  const style = document.createElement('style')
  style.textContent = readFileSync(styleSheetPath, 'utf8')
  document.head.appendChild(style)
}
