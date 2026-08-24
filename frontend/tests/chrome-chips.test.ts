// @vitest-environment jsdom
//
// MAP-10's five header chips, or the single D-12 failure chip: pure
// reporting from `config.json`'s own facts, never a guess and never a
// placeholder.

import { describe, expect, it, vi } from 'vitest'
import { renderChips, renderHeader, type ChipRunConfig, type ChipsInput } from '../src/ui/chrome'

function mount(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

const FULL_CONFIG: ChipRunConfig = {
  n_par: 1234,
  n_real: 200,
  base_realization: true,
  n_iterations: 3,
  noptmax: 3,
  projection: 'EPSG:26910',
  has_noise: true,
}

describe('renderChips', () => {
  it('renders five chips for a complete config, with noise present so no noise chip is shown', () => {
    const el = mount()
    const opts: ChipsInput = { config: FULL_CONFIG, failure: null }
    renderChips(el, opts)

    const text = el.textContent ?? ''
    expect(text).toContain('1234 par')
    expect(text).toContain('200 reals · base alive')
    expect(text).toContain('3 iter')
    expect(text).toContain('crs')
    expect(text).not.toContain('no measurement noise')
    expect(el.children.length).toBe(4)
  })

  it('a config recording that base did not survive renders "base lost"', () => {
    const el = mount()
    const config: ChipRunConfig = { ...FULL_CONFIG, base_realization: false }
    renderChips(el, { config, failure: null })

    expect(el.textContent).toContain('200 reals · base lost')
  })

  it('an iteration count strictly below noptmax renders the "of" form; equality renders the plain form', () => {
    const shortEl = mount()
    renderChips(shortEl, { config: { ...FULL_CONFIG, n_iterations: 2, noptmax: 5 }, failure: null })
    expect(shortEl.textContent).toContain('2 of 5 iter')

    const equalEl = mount()
    renderChips(equalEl, { config: { ...FULL_CONFIG, n_iterations: 5, noptmax: 5 }, failure: null })
    expect(equalEl.textContent).toContain('5 iter')
    expect(equalEl.textContent).not.toContain('of 5 iter')
  })

  it('renders no noise chip at all when measurement noise is present', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, has_noise: true }, failure: null })
    expect(el.textContent).not.toContain('measurement noise')
  })

  it('a config with no projection renders "no crs" in muted ink, not warning ink', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, projection: null }, failure: null })

    const spans = Array.from(el.children) as HTMLElement[]
    const crsChip = spans.find((s) => s.textContent === 'no crs')
    expect(crsChip).toBeDefined()
    expect(crsChip!.style.color).toBe('var(--ink-muted)')
    expect(crsChip!.style.color).not.toBe('var(--status-warning)')
  })

  it('a count the server reported as null omits its chip rather than rendering a zero', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, n_par: null }, failure: null })
    expect(el.textContent).not.toContain('0 par')
    expect(el.textContent).not.toMatch(/\bpar\b/)
  })

  it('with the chips capability blocked, one chip in serious ink replaces all five', () => {
    const el = mount()
    renderChips(el, { config: null, failure: { artifact: 'config', reason: 'run configuration could not be read' } })

    expect(el.children.length).toBe(1)
    const chip = el.children[0] as HTMLElement
    expect(chip.textContent).toBe('config failed — run configuration could not be read')
    expect(chip.style.color).toBe('var(--status-serious)')
  })

  it('a long failure reason truncates and carries the full reason in a title', () => {
    const el = mount()
    const longReason = 'x'.repeat(300)
    renderChips(el, { config: null, failure: { artifact: 'config', reason: longReason } })

    const chip = el.children[0] as HTMLElement
    expect(chip.classList.contains('truncate')).toBe(true)
    expect(chip.title).toBe(longReason)
  })

  it('renderHeader shows no chip row at all until the config has landed', () => {
    const el = mount()
    renderHeader(el, {
      title: 'a run',
      themeChoice: 'dark',
      onThemeChange: vi.fn(),
      chips: null,
    })
    expect(el.textContent).not.toMatch(/par|reals|iter|crs/)

    el.textContent = ''
    renderHeader(el, {
      title: 'a run',
      themeChoice: 'dark',
      onThemeChange: vi.fn(),
      chips: { config: FULL_CONFIG, failure: null },
    })
    expect(el.textContent).toContain('1234 par')
  })

  it('every numeric chip span carries tabular-nums', () => {
    const el = mount()
    renderChips(el, { config: FULL_CONFIG, failure: null })

    const spans = Array.from(el.children) as HTMLElement[]
    const numericChips = spans.filter((s) => /\d/.test(s.textContent ?? ''))
    expect(numericChips.length).toBeGreaterThan(0)
    for (const chip of numericChips) {
      expect(chip.classList.contains('tabular-nums')).toBe(true)
    }
  })
})
