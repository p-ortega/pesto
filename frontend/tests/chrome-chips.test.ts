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
    expect(text).not.toContain('noise: off')
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

describe('chips whose readings disagree name the PEST++ files (D-17)', () => {
  const files = ['.rec', '.pst']

  it('marks the realization chip with the warning icon and the files, in the warning colour', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, disagree: ['ensemble_size'], mismatch: { ensemble_size: files } }, failure: null })

    const chip = (Array.from(el.children) as HTMLElement[]).find((c) => c.textContent?.includes('reals'))!
    expect(chip.textContent?.startsWith('⚠')).toBe(true)
    expect(chip.textContent).toBe('⚠ 200 reals · base alive · .rec and .pst do not match')
    expect(chip.style.color).toBe('var(--status-warning)')
  })

  it('marks the realization chip when the base fact disagrees', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, disagree: ['base'], mismatch: { base: ['.pst', 'pesto cache'] } }, failure: null })
    expect(chipTexts(el).filter((t) => t.includes('do not match')).length).toBe(1)
    expect(chipTexts(el).find((t) => t.includes('reals'))).toContain('.pst and pesto cache do not match')
  })

  it('marks the iteration chip when noptmax disagrees and leaves the others alone', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, disagree: ['noptmax'], mismatch: { noptmax: files } }, failure: null })

    const marked = chipTexts(el).filter((t) => t.includes('do not match'))
    expect(marked.length).toBe(1)
    expect(marked[0]).toContain('3 iter')
  })

  it('says files do not match when it was not told which', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, disagree: ['noptmax'] }, failure: null })
    expect(chipTexts(el).find((t) => t.includes('iter'))).toBe('⚠ 3 iter · files do not match')
  })

  it('names the files and the facts in the chip title', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, disagree: ['ensemble_size'], mismatch: { ensemble_size: files } }, failure: null })
    const chip = (Array.from(el.children) as HTMLElement[]).find((c) => c.textContent?.includes('reals'))!
    expect(chip.title).toBe('The .rec and the .pst do not match on ensemble size. The Config tab lists what each one says.')
  })

  it('gives the same chips as before for a config with no facts', () => {
    const plain = mount()
    renderChips(plain, { config: FULL_CONFIG, failure: null })
    const empty = mount()
    renderChips(empty, { config: { ...FULL_CONFIG, disagree: [], base: null }, failure: null })
    expect(chipTexts(empty)).toEqual(chipTexts(plain))
    expect(chipTexts(plain).join('|')).not.toContain('do not match')
  })
})

describe('the noise chip in PEST++ words', () => {
  const noiseChip = (el: HTMLElement): HTMLElement =>
    (Array.from(el.children) as HTMLElement[]).find((c) => c.textContent?.includes('noise'))!

  it('says noise is off and which file says so', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, has_noise: false, noise_from: '.rec' }, failure: null })
    expect(noiseChip(el).textContent).toBe('⚠ noise: off (from .rec)')
    expect(noiseChip(el).style.color).toBe('var(--status-warning)')
  })

  it('says what the .pst says when it does not match the .rec', () => {
    const el = mount()
    renderChips(el, {
      config: {
        ...FULL_CONFIG,
        has_noise: false,
        noise_from: '.rec',
        noise_against: ['.pst'],
        disagree: ['noise'],
        mismatch: { noise: ['.rec', '.pst'] },
      },
      failure: null,
    })
    expect(noiseChip(el).textContent).toBe('⚠ noise: off (from .rec) · .pst says on')
    expect(noiseChip(el).title).toBe('The .rec and the .pst do not match on noise. The Config tab lists what each one says.')
  })

  it('shows a noise chip for a mismatch even when noise is on', () => {
    const el = mount()
    renderChips(el, {
      config: { ...FULL_CONFIG, has_noise: true, noise_from: '.rec', noise_against: ['.pst'], disagree: ['noise'], mismatch: { noise: ['.rec', '.pst'] } },
      failure: null,
    })
    expect(noiseChip(el).textContent).toBe('⚠ noise: on (from .rec) · .pst says off')
  })

  it('says also when two lines of the deciding file do not match', () => {
    const el = mount()
    renderChips(el, {
      config: { ...FULL_CONFIG, has_noise: false, noise_from: '.pst', noise_against: ['.pst'], disagree: ['noise'], mismatch: { noise: ['.pst'] } },
      failure: null,
    })
    expect(noiseChip(el).textContent).toBe('⚠ noise: off (from .pst) · .pst also says on')
  })

  it('says not known when nothing decided it', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, has_noise: null, disagree: ['noise'], mismatch: { noise: ['.rec'] } }, failure: null })
    expect(noiseChip(el).textContent).toBe('⚠ noise: not known · lines in the .rec do not match')
  })

  it('never uses the words source or chip', () => {
    const el = mount()
    renderChips(el, {
      config: { ...FULL_CONFIG, has_noise: false, noise_from: '.rec', noise_against: ['.pst'], disagree: ['noise', 'noptmax'], mismatch: { noise: ['.rec', '.pst'], noptmax: ['.rec', '.pst'] } },
      failure: null,
    })
    for (const chip of Array.from(el.children) as HTMLElement[]) {
      expect(`${chip.textContent} ${chip.title}`).not.toMatch(/source|chip/i)
    }
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

describe('the realization chip says where Select base is (G-14-5)', () => {
  const WHERE = 'Select base is on the Site plots line of the Obs tab.'
  const chipWith = (el: HTMLElement, words: string): HTMLElement =>
    (Array.from(el.children) as HTMLElement[]).find((c) => c.textContent?.includes(words))!

  it('names the Site plots line on a chip with base present', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, n_real: 494, base: { state: 'present' } }, failure: null })
    expect(chipWith(el, '494 reals').textContent).toBe('494 reals · base alive')
    expect(chipWith(el, '494 reals').title).toBe(WHERE)
  })

  it('names the Site plots line on a chip that says no base', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, n_real: 494, base: { state: 'not_included' } }, failure: null })
    expect(chipWith(el, '494 reals').title).toBe(WHERE)
  })

  it('keeps the disagreement title on a realization chip whose readings disagree', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, disagree: ['ensemble_size'] }, failure: null })
    expect(chipWith(el, 'reals').title).not.toBe(WHERE)
    expect(chipWith(el, 'reals').title).toContain('ensemble size')
  })

  it('gives no other chip a title', () => {
    const el = mount()
    renderChips(el, { config: { ...FULL_CONFIG, has_noise: false, n_iterations: 2 }, failure: null })
    const others = (Array.from(el.children) as HTMLElement[]).filter((c) => !c.textContent?.includes('reals'))
    expect(others.length).toBeGreaterThan(0)
    for (const chip of others) expect(chip.title).toBe('')
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

  it('lists the facts whose readings disagree', () => {
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
    const nothing = { disagree: [], mismatch: {}, noiseAgainst: [], base: null }
    expect(chipFactsFrom(undefined)).toEqual(nothing)
    expect(chipFactsFrom([])).toEqual(nothing)
  })

  it('names the files whose readings do not match, as .rec and .pst', () => {
    const facts = [fact('noptmax', [reading('run record', 4, '4'), reading('control file', 5, '5')], false)]
    expect(chipFactsFrom(facts).mismatch).toEqual({ noptmax: ['.rec', '.pst'] })
  })

  it('lists the files whose noise reading says the opposite of the answer', () => {
    const noise = fact(
      'noise',
      [reading('run record', false, 'noise off'), reading('run record', null, 'options dump'), reading('control file', true, 'noise on')],
      false,
    )
    expect(chipFactsFrom([noise], false).noiseAgainst).toEqual(['.pst'])
    expect(chipFactsFrom([noise], true).noiseAgainst).toEqual(['.rec'])
    expect(chipFactsFrom([noise], null).noiseAgainst).toEqual([])
  })
})
