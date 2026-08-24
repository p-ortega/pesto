// @vitest-environment jsdom
//
// WINDOWS.md #7: the legend rendered two adjacent figures with nothing
// between them -- "0 cells contested298 cells no value" and the two end
// values as "-10.00-5.000" -- the same run-together bug plan 05.1-01 fixed
// on the status bar and ingest rows (a real CSS gap between a container's
// children, not a text separator). This loads the real stylesheet into
// jsdom and reads the actual computed gap, so it proves the fix the way it
// actually works (CSS layout) rather than a textContent string match, which
// can't see a gap at all -- and it scans every multi-child container the
// legend renders, so a third run-together spot introduced later fails this
// test too, not just the two already known.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderLegend, type LegendOptions } from '../src/ui/legend'

const testDir = dirname(fileURLToPath(import.meta.url))
const styleSheetPath = join(testDir, '..', 'src', 'style.css')

const BASE_OPTIONS: LegendOptions = {
  colormap: 'viridis',
  reverse: false,
  limits: [1.5, 98.25],
  scale: 'log10',
  scaleInferred: true,
  limitsMode: 'robust',
  group: 'hk1',
  contested: 3,
  noValue: 12,
}

function loadRealStylesheet(): void {
  const style = document.createElement('style')
  style.textContent = readFileSync(styleSheetPath, 'utf8')
  document.head.appendChild(style)
}

describe('legend spacing (WINDOWS.md #7)', () => {
  it('gives every multi-child figure container a real, non-zero gap between its children', () => {
    loadRealStylesheet()
    const el = document.createElement('div')
    document.body.appendChild(el)
    renderLegend(el, BASE_OPTIONS)

    // Any element the legend renders with two or more element children is a
    // place two figures could run together -- not just the end values and
    // the counts line, so a future third spot is covered automatically.
    const containers = Array.from(el.querySelectorAll('*')).filter((node) => node.children.length >= 2)
    expect(containers.length).toBeGreaterThanOrEqual(2) // at least end values + counts today

    for (const container of containers) {
      const gap = getComputedStyle(container).gap
      expect(gap, `container ${container.className || container.tagName} has no real gap: "${gap}"`).not.toBe('')
      expect(gap).not.toBe('0px')
      expect(gap).not.toBe('normal')
    }
  })

  it('the end values and the counts line both carry the shared .legend-figures gap class', () => {
    const el = document.createElement('div')
    renderLegend(el, BASE_OPTIONS)

    const figureRows = el.querySelectorAll('.legend-figures')
    // End values (low/high) and the counts line (contested/no-value) -- the
    // two run-together spots the live browser check found.
    expect(figureRows.length).toBe(2)
    for (const row of figureRows) {
      expect(row.children.length).toBe(2)
    }
  })
})
