import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'style.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

interface Rule {
  selectors: string[]
  body: string
  index: number
}

const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((match) => ({
  selectors: match[1].split(',').map((part) => part.trim()),
  body: match[2],
  index: match.index ?? 0,
}))

function rulesFor(selector: string): Rule[] {
  const found = rules.filter((r) => r.selectors.includes(selector))
  if (found.length === 0) throw new Error(`style.css has no rule for ${selector}`)
  return found
}

// Every declaration of every rule whose selector list names exactly this selector.
function rule(selector: string): string {
  return rulesFor(selector)
    .map((r) => r.body)
    .join('\n')
}

describe('the header and status bar', () => {
  it('pad top and bottom with the small step, giving the map its height back', () => {
    for (const selector of ['.header', '.status-bar']) {
      expect(rule(selector), selector).toMatch(/padding:\s*var\(--space-sm\) var\(--space-md\)/)
      expect(rule(selector), selector).not.toMatch(/--space-lg/)
    }
  })
})

describe('sideways scrollbars', () => {
  it('colour every rule that scrolls sideways, so no white bar shows in dark theme', () => {
    const sideways = rules.filter((r) => /overflow-x:\s*auto/.test(r.body))
    expect(sideways.length).toBeGreaterThan(0)
    for (const r of sideways) {
      expect(r.body, r.selectors.join(', ')).toMatch(/scrollbar-color:\s*var\(--axis\) var\(--gridline\)/)
    }
  })
})

describe('pickable rows', () => {
  for (const row of ['.group-row', '.param-row', '.obs-grid-row']) {
    it(`${row} shows a pointer and a gridline hover that is never accent`, () => {
      expect(rule(row)).toMatch(/cursor:\s*pointer/)
      const hover = rule(`${row}:hover`)
      expect(hover).toMatch(/background:\s*var\(--gridline\)/)
      expect(hover).not.toMatch(/--accent/)
    })

    it(`${row} keeps its inset accent bar when selected, drawn before the hover rule`, () => {
      const selected = rulesFor(`${row}[aria-selected='true']`)
      expect(selected.map((r) => r.body).join('\n')).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--accent\)/)
      const lastSelected = Math.max(...selected.map((r) => r.index))
      const firstHover = Math.min(...rulesFor(`${row}:hover`).map((r) => r.index))
      expect(firstHover).toBeGreaterThan(lastSelected)
    })
  }
})

describe('the selected sections', () => {
  it('take at most 40% of their tab', () => {
    expect(rule('.params-selected')).toMatch(/max-height:\s*40%/)
    expect(rule('.obs-selected')).toMatch(/max-height:\s*40%/)
  })

  it('give the Params Notes section at most 40% of the tab, scrolling inside under its title line', () => {
    expect(rule('.params-notes')).toMatch(/max-height:\s*40%/)
    expect(rule('.params-notes > .fold-body')).toMatch(/overflow-y:\s*auto/)
    // The unmapped list no longer has a cap of its own: it scrolls with the notes.
    expect(rule('.params-unmapped')).not.toMatch(/max-height/)
  })
})

describe('basemap warnings', () => {
  for (const selector of ['.basemap-warning', '.basemap-picker-status.refused']) {
    it(`${selector} reads in primary ink behind a warning glyph`, () => {
      expect(rule(selector)).toMatch(/color:\s*var\(--ink-primary\)/)
      expect(rule(selector)).not.toMatch(/--status-warning/)
      const glyph = rule(`${selector}::before`)
      expect(glyph).toMatch(/content:\s*'⚠ '/)
      expect(glyph).toMatch(/color:\s*var\(--status-warning\)/)
    })
  }

  it('hides the glyph of an empty warning line along with the line', () => {
    expect(rule('.basemap-warning:empty')).toMatch(/display:\s*none/)
  })
})

describe('controls in the floating cards', () => {
  it('use the body type instead of the browser default', () => {
    for (const selector of ['.floating button', '.floating select', '.floating input']) {
      expect(rule(selector), selector).toMatch(/font:\s*inherit/)
      expect(rule(selector), selector).toMatch(/font-size:\s*14px/)
    }
  })

  it('give a card button at least 32px of height', () => {
    expect(rule('.floating button')).toMatch(/min-height:\s*32px/)
  })

  it('keep the fold button at 24px, with a selector that outranks the card-button rule', () => {
    expect(rule('.fold-button')).toMatch(/min-height:\s*24px/)
    expect(rule('.floating .fold-button')).toMatch(/min-height:\s*24px/)
  })
})

const SPACE: Record<string, number> = { '--space-xs': 4, '--space-sm': 8, '--space-md': 16, '--space-lg': 24 }

// A length in px from a plain px value or a calc() of sums of px, spacing steps and products.
function px(value: string): number {
  const inner = value.trim().replace(/^calc\((.*)\)$/, '$1')
  return inner.split('+').reduce((sum, term) => {
    const product = term.split('*').reduce((acc, factor) => {
      const f = factor.trim()
      const space = /^var\((--space-[a-z]+)\)$/.exec(f)
      if (space) return acc * SPACE[space[1]]
      const n = /^(\d+(?:\.\d+)?)(px)?$/.exec(f)
      if (!n) throw new Error(`cannot read ${f} as a length`)
      return acc * Number(n[1])
    }, 1)
    return sum + product
  }, 0)
}

function declared(selector: string, property: string): number {
  const found = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`).exec(rule(selector))
  if (!found) throw new Error(`${selector} has no ${property}`)
  return px(found[1])
}

// The type steps in px: a 24px fold button line, a 14px body line at 1.5, a 12px label line at 1.4.
const TITLE_LINE = 24
const BODY_LINE = 14 * 1.5
const LABEL_LINE = 12 * 1.4
const ROW = 24

describe('the Obs tab floors', () => {
  it('never squeezes a site plot below one whole panel: its title line, the panel title, the 200px plot and two legend lines', () => {
    const floor = declared(".obs-spaghetti[data-folded='false']:has(.obs-spaghetti-plot)", 'min-height')
    expect(floor).toBeGreaterThanOrEqual(TITLE_LINE + BODY_LINE + 200 + 2 * LABEL_LINE)
    // The old 8rem floor was 128px, well short of the 200px plot.
    expect(floor).toBeGreaterThan(8 * 16)
  })

  it('keeps the empty plot prompt to its line, with no floor of its own, and never shrinks it under that line', () => {
    expect(rule('.obs-spaghetti')).not.toMatch(/min-height/)
    expect(rule(".obs-spaghetti.fold-card.fold-section[data-folded='false']:not(:has(.obs-spaghetti-plot))")).toMatch(/flex-shrink:\s*0;/)
  })

  it("holds the site list's title, hint, header and four rows once it lists sites", () => {
    const floor = declared(".obs-sites[data-folded='false']:has(.obs-grid)", 'min-height')
    expect(floor).toBeGreaterThanOrEqual(TITLE_LINE + LABEL_LINE + 25 + 4 * ROW)
    expect(declared('.obs-sites .obs-grid', 'min-height')).toBeGreaterThanOrEqual(25 + 4 * ROW)
    expect(rule('.obs-sites')).not.toMatch(/min-height/)
  })

  it('caps the site list notes at two lines', () => {
    expect(declared('.obs-site-notes', 'max-height')).toBeLessThanOrEqual(Math.ceil(2 * LABEL_LINE))
    expect(declared(".obs-sites[data-folded='false']:has(.obs-site-notes)", 'min-height')).toBeGreaterThan(
      declared(".obs-sites[data-folded='false']:has(.obs-grid)", 'min-height'),
    )
  })

  it('lets a folded section drop every floor', () => {
    expect(rule(".fold-card.fold-section[data-folded='true']")).toMatch(/min-height:\s*0/)
    expect(rule(".fold-card.fold-section[data-folded='true']")).toMatch(/flex:\s*0 0 auto/)
  })
})

// A group row is its 21px body line, 4px padding above and below and a 1px rule; its header wraps to two label lines.
const GROUP_ROW = BODY_LINE + 2 * 4 + 1
const GROUP_HEADER = 2 * LABEL_LINE + 2 * 4 + 1

describe('the Params tab floors', () => {
  it('never shrinks the Groups table below its title line, header and three rows', () => {
    const floor = declared(".params-groups[data-folded='false']:has([role='grid'])", 'min-height')
    expect(floor).toBeGreaterThanOrEqual(TITLE_LINE + Math.floor(GROUP_HEADER) + 3 * GROUP_ROW)
  })

  it('never shrinks the Parameters list below its title line, header and three rows', () => {
    const floor = declared(".params-table[data-folded='false']:has(.param-header)", 'min-height')
    expect(floor).toBeGreaterThanOrEqual(TITLE_LINE + 25 + 3 * ROW)
  })

  it('never squeezes a detail holding a chart below its title line, the whole 200px chart and two text lines', () => {
    const floor = declared(".params-detail-host[data-folded='false']:has(.params-chart)", 'min-height')
    expect(floor).toBeGreaterThanOrEqual(TITLE_LINE + 200 + 2 * LABEL_LINE)
    // The old 8rem floor was 128px, well short of the chart.
    expect(floor).toBeGreaterThan(8 * 16)
  })

  it('keeps the floors off a folded section and off a section with nothing to list', () => {
    for (const selector of ['.params-groups', '.params-table', '.params-detail-host']) {
      expect(rule(selector), selector).not.toMatch(/min-height:\s*(calc|[1-9])/)
    }
  })

  it('gives the Group column a 12em floor and widens the grid to hold it', () => {
    expect(rule('.group-row > :nth-child(1)')).toMatch(/min-width:\s*12em/)
    expect(rule('.group-header > :nth-child(1)')).toMatch(/min-width:\s*12em/)
    const grid = /min-width:\s*(\d+(?:\.\d+)?)em/.exec(rule('.params-groups .group-header'))
    expect(Number(grid![1])).toBeGreaterThanOrEqual(57)
  })

  it('lets the detail and the list scroll inside their sections, under a title line that stays put', () => {
    expect(rule('.params-detail-host > .fold-body')).toMatch(/overflow-y:\s*auto/)
    expect(rule('.params-table > .fold-body')).toMatch(/overflow-x:\s*auto/)
  })
})
