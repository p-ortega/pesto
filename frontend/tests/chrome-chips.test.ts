// @vitest-environment jsdom
//
// MAP-10's five header chips, or the single D-12 failure chip: pure
// reporting from `config.json`'s own facts, never a guess and never a
// placeholder.

import { describe, expect, it, vi } from 'vitest'
import { renderChips, renderHeader, type ChipRunConfig, type ChipsInput } from '../src/ui/chrome'
import { chipFactsFrom, type ConfigFact, type ConfigReading } from '../src/data/config'

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

  it('renderHeader puts extra elements after the chips and before the theme control', () => {
    const el = mount()
    const extra = document.createElement('button')
    extra.textContent = 'base'
    renderHeader(el, {
      title: 'a run',
      themeChoice: 'dark',
      onThemeChange: vi.fn(),
      chips: { config: FULL_CONFIG, failure: null },
      extras: [extra],
    })

    const children = Array.from(el.children)
    expect(children).toHaveLength(4)
    expect(children[1].textContent).toContain('1234 par')
    expect(children[2]).toBe(extra)
    expect(children[3].tagName).toBe('LABEL')
  })

  it('renderHeader without extras keeps the title, chips and theme control only', () => {
    const el = mount()
    renderHeader(el, {
      title: 'a run',
      themeChoice: 'dark',
      onThemeChange: vi.fn(),
      chips: { config: FULL_CONFIG, failure: null },
    })

    const children = Array.from(el.children)
    expect(children).toHaveLength(3)
    expect(children[2].tagName).toBe('LABEL')
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

function chipTexts(el: HTMLElement): string[] {
  return Array.from(el.children).map((c) => c.textContent ?? '')
}

describe('chips whose sources disagree (D-17)', () => {
  it('marks the realization chip with the warning icon and the words, in the warning colour', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, disagree: ['ensemble_size'] }, failure: null })

    const chip = (Array.from(el.children) as HTMLElement[]).find((c) => c.textContent?.includes('reals'))!
    expect(chip.textContent?.startsWith('⚠')).toBe(true)
    expect(chip.textContent).toContain('200 reals')
    expect(chip.textContent).toContain('sources disagree')
    expect(chip.style.color).toBe('var(--status-warning)')
  })

  it('marks the realization chip when the base fact disagrees', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, disagree: ['base'] }, failure: null })
    expect(chipTexts(el).filter((t) => t.includes('sources disagree')).length).toBe(1)
    expect(chipTexts(el).find((t) => t.includes('reals'))).toContain('sources disagree')
  })

  it('marks the iteration chip when noptmax disagrees and leaves the others alone', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, disagree: ['noptmax'] }, failure: null })

    const marked = chipTexts(el).filter((t) => t.includes('sources disagree'))
    expect(marked.length).toBe(1)
    expect(marked[0]).toContain('3 iter')
  })

  it('marks the noise chip when noise disagrees and there is no noise', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, has_noise: false, disagree: ['noise'] }, failure: null })

    const noise = chipTexts(el).find((t) => t.includes('no measurement noise'))!
    expect(noise.startsWith('⚠')).toBe(true)
    expect(noise).toContain('sources disagree')
  })

  it('shows a noise chip for a noise disagreement even when the answer is noise on', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, has_noise: true, disagree: ['noise'] }, failure: null })

    const noise = chipTexts(el).find((t) => t.includes('measurement noise'))!
    expect(noise.startsWith('⚠')).toBe(true)
    expect(noise).toContain('sources disagree')
    expect(noise).not.toContain('no measurement noise')
  })

  it('names the facts that disagree in the chip title', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, disagree: ['ensemble_size'] }, failure: null })
    const chip = (Array.from(el.children) as HTMLElement[]).find((c) => c.textContent?.includes('reals'))!
    expect(chip.title).toContain('ensemble size')
  })

  it('gives the same chips as before for a config with no facts', () => {
    const plain = mount()
    renderChips(plain, { config: FULL_CONFIG, failure: null })
    const empty = mount()
    renderChips(empty, { config: { ...FULL_CONFIG, disagree: [], base: null }, failure: null })
    expect(chipTexts(empty)).toEqual(chipTexts(plain))
    expect(chipTexts(plain).join('|')).not.toContain('sources disagree')
  })
})

describe('the base chip follows the base fact (D-16, D-17)', () => {
  it('says base alive when the last ingested iteration has base', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, base_realization: false, base: { state: 'present' } }, failure: null })
    expect(el.textContent).toContain('200 reals · base alive')
  })

  it('says where base went missing', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, base: { state: 'missing', iteration: 3 } }, failure: null })
    expect(el.textContent).toContain('200 reals · base missing at iteration 3')
  })

  it('says "no base", not "base lost", when the run never included it', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, base_realization: false, base: { state: 'not_included' } }, failure: null })
    expect(el.textContent).toContain('200 reals · no base')
    expect(el.textContent).not.toContain('lost')
  })

  it('falls back to base_realization when the base fact says nothing', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, base_realization: false, base: null }, failure: null })
    expect(el.textContent).toContain('200 reals · base lost')

    const unknown = mount()
    renderChips(unknown, { config: { ...FULL_CONFIG, base_realization: true, base: { state: 'unknown' } }, failure: null })
    expect(unknown.textContent).toContain('200 reals · base alive')
  })
})

function reading(source: string, value: ConfigReading['value'], shown: string, extra: ConfigReading['extra'] = null): ConfigReading {
  return { source, value, shown, evidence: '', extra }
}

function fact(key: string, readings: ConfigReading[], agree: boolean | null = null): ConfigFact {
  return { key, label: key, readings, agree, looked_for: [], note: null }
}

describe('chipFactsFrom', () => {
  const cache = (iteration: number, value: boolean | null) =>
    reading('cache', value, `iteration ${iteration}`, { iteration })

  it('lists the facts whose sources disagree', () => {
    const facts = [
      fact('noptmax', [reading('control file', 5, '5'), reading('run record', 4, '4')], false),
      fact('noise', [reading('run record', false, 'no noise')], null),
      fact('ensemble_size', [reading('run record', 50, '50'), reading('control file', 50, '50')], true),
    ]
    expect(chipFactsFrom(facts).disagree).toEqual(['noptmax'])
  })

  it('takes the base state from the last cache reading', () => {
    const present = fact('base', [cache(0, true), cache(3, true)], null)
    expect(chipFactsFrom([present]).base).toEqual({ state: 'present' })

    const missing = fact('base', [cache(0, true), cache(3, false), cache(6, false)], false)
    expect(chipFactsFrom([missing]).base).toEqual({ state: 'missing', iteration: 3 })
    expect(chipFactsFrom([missing]).disagree).toEqual([])

    const never = fact('base', [cache(0, false), cache(3, false)], null)
    expect(chipFactsFrom([never]).base).toEqual({ state: 'not_included' })
  })

  it('skips an iteration that was not ingested', () => {
    const base = fact('base', [cache(0, true), cache(3, null)], null)
    expect(chipFactsFrom([base]).base).toEqual({ state: 'present' })
  })

  it('has nothing to say without facts', () => {
    expect(chipFactsFrom(undefined)).toEqual({ disagree: [], base: null })
    expect(chipFactsFrom([])).toEqual({ disagree: [], base: null })
  })
})
