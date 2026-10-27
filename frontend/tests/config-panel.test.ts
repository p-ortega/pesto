// @vitest-environment jsdom
//
// The Config tab (D-14 to D-17, CONF-01 to CONF-04): one row per setup fact the
// server sends, each with its value and the source it came from. These tests
// build facts by hand, so they pin what the panel does with a payload and say
// nothing about any local run.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigFact, ConfigReading } from '../src/data/config'
import type { IngestState } from '../src/data/client'
import type { RunConfig } from '../src/views/map'
import { renderConfigPanel } from '../src/ui/config-panel'
import { formatBytes } from '../src/ui/progress'

vi.mock('../src/views/map-view', () => ({
  CONTEXT_RECOVERY_WINDOW_MS: 0,
  openingIteration: () => ({ iteration: 0, note: null }),
  mountMapView: vi.fn(() => ({
    viewFields: () => ({
      colormap: 'viridis',
      reverse: false,
      scale: 'linear',
      limitsMode: 'robust',
      group: null,
      stat: 'value',
      layer: null,
    }),
  })),
}))

function reading(source: string, value: ConfigReading['value'], shown: string, over: Partial<ConfigReading> = {}): ConfigReading {
  return { source, value, shown, evidence: '', extra: null, ...over }
}

function fact(key: string, label: string, readings: ConfigReading[], over: Partial<ConfigFact> = {}): ConfigFact {
  return { key, label, readings, agree: null, looked_for: [], note: null, ...over }
}

const VERSION = fact('pestpp_version', 'pestpp version', [reading('run record', '5.2.23', '5.2.23')])
const REGULARIZATION = fact(
  'regularization',
  'Regularization',
  [
    reading('run record', 0, 'off (reg_factor 0)'),
    reading('run record', 0, 'off (reg_factor 0)'),
    reading('control file', 0, 'off (reg_factor 0)'),
  ],
  { agree: true },
)

function runConfig(over: Partial<RunConfig> = {}): RunConfig {
  return {
    case: 'demo',
    n_par: 10,
    n_real: 5,
    base_realization: true,
    n_iterations: 2,
    noptmax: 2,
    first_iteration: 0,
    projection: null,
    projection_known: true,
    noise: { has_noise: null, decided_by: '', evidence: [], notes: [] },
    facts_version: 1,
    facts: [VERSION, REGULARIZATION],
    par_iterations: [0, 2],
    ...over,
  }
}

function baseState(): IngestState {
  return {
    fresh: true,
    artifacts: [],
    capabilities: {
      map: { available: true, blockedBy: [] },
      stats: { available: true, blockedBy: [] },
      chips: { available: true, blockedBy: [] },
    },
    ingestSeconds: null,
    cacheBytes: null,
  }
}

function mount(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return host
}

async function openShell(config: RunConfig | null): Promise<HTMLElement> {
  const { mountMap } = await import('../src/views/map')
  const root = mount()
  mountMap(root, { config, state: baseState() })
  return root
}

function rowFor(host: HTMLElement, key: string): HTMLElement {
  const row = host.querySelector<HTMLElement>(`.config-row[data-fact="${key}"]`)
  if (row === null) throw new Error(`no row for ${key}`)
  return row
}

beforeEach(() => {
  document.body.innerHTML = ''
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ divider: 0.5, colormap: 'viridis', reverse: false, scale: 'linear', limits_mode: 'robust', group: null, stat: 'value', layer: null, tab: 'params' }),
      headers: { get: () => null },
    })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the Config tab in the map shell', () => {
  it('shows each fact as a row with its label, its value and the source it came from', async () => {
    const root = await openShell(runConfig())
    const panel = root.querySelector<HTMLElement>('#panel-config')!

    const version = rowFor(panel, 'pestpp_version')
    expect(version.textContent).toContain('pestpp version')
    expect(version.querySelector('.config-value')?.textContent).toBe('5.2.23')
    expect(version.querySelector('.config-source')?.textContent).toBe('run record')

    const regularization = rowFor(panel, 'regularization')
    expect(regularization.querySelector('.config-value')?.textContent).toBe('off (reg_factor 0)')
    expect(regularization.querySelector('.config-source')?.textContent).toBe('run record, control file')
  })

  it('keeps the rows in the order the server sent them', async () => {
    const root = await openShell(runConfig())
    const keys = Array.from(root.querySelectorAll('#panel-config .config-row')).map((el) => (el as HTMLElement).dataset.fact)
    expect(keys).toEqual(['pestpp_version', 'regularization'])
  })

  it('no longer shows the Config placeholder, and the Obs tab holds its panel instead of a placeholder', async () => {
    const root = await openShell(runConfig())
    expect(root.querySelector('#panel-config')?.textContent).not.toContain('How the run was set up will show here')
    expect(root.querySelector('#panel-obs .obs-groups')).not.toBeNull()
    expect(root.querySelector('#panel-obs')?.textContent).not.toContain('Observations will show here')
  })

  it('shows the server note once when the config was written before the facts existed', async () => {
    const note = 'written before the setup facts existed; run the ingest again'
    const root = await openShell(runConfig({ facts: [], facts_version: null, facts_note: note }))
    const panel = root.querySelector<HTMLElement>('#panel-config')!

    expect(panel.querySelectorAll('.notice-parts').length).toBe(1)
    expect(panel.textContent).toContain(note)
    expect(panel.querySelectorAll('.config-row').length).toBe(0)
  })

  it('says the configuration could not be read when there is none', async () => {
    const root = await openShell(null)
    const panel = root.querySelector<HTMLElement>('#panel-config')!

    expect(panel.querySelectorAll('.notice-parts').length).toBe(1)
    expect(panel.textContent).toContain('configuration could not be read')
  })
})

function panelWith(...facts: ConfigFact[]): HTMLElement {
  const host = mount()
  renderConfigPanel(host, { config: runConfig({ facts }) })
  return host
}

function texts(row: HTMLElement, selector: string): string[] {
  return Array.from(row.querySelectorAll(selector)).map((el) => el.textContent ?? '')
}

describe('a fact whose sources disagree (D-14, CONF-04)', () => {
  const noise = fact(
    'noise',
    'Measurement noise',
    [
      reading('run record', false, 'no noise: pestpp reset ies_no_noise', { evidence: 'case.rec line 12' }),
      reading('control file', true, 'noise on: a supplied observation ensemble'),
    ],
    { agree: false },
  )

  it('shows the run record first, then the control file as "control file says X", under a warning', () => {
    const row = rowFor(panelWith(noise), 'noise')

    expect(row.querySelector('.config-main .config-value')?.textContent).toBe('no noise: pestpp reset ies_no_noise')
    expect(row.querySelector('.config-main .config-source')?.textContent).toBe('run record')
    expect(texts(row, '.config-line .config-value')).toEqual(['control file says noise on: a supplied observation ensemble'])

    const notice = row.querySelector('.notice-parts') as HTMLElement
    expect(notice.textContent).toContain('⚠')
    expect(notice.textContent).toContain('Warning')
    expect(notice.textContent).toContain('Sources disagree')
  })

  it('shows every reading of another fact too, in the order the server sent them', () => {
    const size = fact(
      'ensemble_size',
      'Ensemble size',
      [reading('run record', 200, '200'), reading('control file', 100, '100'), reading('cache', 50, '50')],
      { agree: false },
    )
    const row = rowFor(panelWith(size), 'ensemble_size')

    expect(row.querySelector('.config-main .config-value')?.textContent).toBe('200')
    expect(texts(row, '.config-line .config-value')).toEqual(['control file says 100', 'cache says 50'])
  })

  it('shows no warning when the sources agree', () => {
    const row = rowFor(panelWith(REGULARIZATION), 'regularization')
    expect(row.querySelector('.notice-parts')).toBeNull()
  })

  it('shows a supporting reading with no value as a muted line, never as a disagreement', () => {
    const quiet = fact(
      'noise',
      'Measurement noise',
      [
        reading('run record', false, 'no noise: pestpp reset ies_no_noise'),
        reading('run record', null, 'ies_no_noise: true in the options dump'),
        reading('files present', null, 'an obs+noise file is present', { evidence: 'case.obs+noise.csv' }),
      ],
      { agree: null },
    )
    const row = rowFor(panelWith(quiet), 'noise')

    expect(row.querySelector('.notice-parts')).toBeNull()
    const muted = Array.from(row.querySelectorAll('.config-line.config-muted'))
    expect(muted.map((el) => el.querySelector('.config-value')?.textContent)).toEqual([
      'ies_no_noise: true in the options dump',
      'an obs+noise file is present',
    ])
    expect(row.querySelector('.config-main .config-value')?.textContent).toBe('no noise: pestpp reset ies_no_noise')
  })
})

describe('the localization row (CONF-02)', () => {
  const FILE = 898_800_000
  const stat = (now: boolean, size: number) =>
    reading('files present', null, `localization.jcb, ${size} bytes`, {
      evidence: now ? 'stat now; the file was not opened' : 'stat at the ingest; the file was not opened',
      extra: { name: 'localization.jcb', size_bytes: size, mtime_ns: 1, ...(now ? { now: true } : {}) },
    })
  const localization = (...extra: ConfigReading[]) =>
    fact(
      'localization',
      'Localization',
      [
        reading('run record', true, 'on, 5 sequential upgrade steps'),
        reading('control file', true, 'ies_localizer names localization.jcb'),
        stat(false, FILE),
        ...extra,
      ],
      { agree: true },
    )

  it('says on, gives the file name and size, and says pesto did not read the file', () => {
    const row = rowFor(panelWith(localization()), 'localization')

    expect(row.querySelector('.config-main .config-value')?.textContent).toBe('on')
    expect(row.textContent).toContain(`localization.jcb, ${formatBytes(FILE)}`)
    expect(formatBytes(FILE)).toBe('857.2 MB')
    expect(row.textContent).toContain('pesto did not read this file')
  })

  it('says off when the sources say off', () => {
    const off = fact('localization', 'Localization', [reading('run record', false, 'off (not using localization)')])
    const row = rowFor(panelWith(off), 'localization')

    expect(row.querySelector('.config-main .config-value')?.textContent).toBe('off')
    expect(row.textContent).not.toContain('pesto did not read this file')
  })

  it('shows both sizes and the note when the file changed since the ingest', () => {
    const note = 'the localization file changed since the ingest'
    const changed = { ...localization(stat(true, FILE * 2)), note }
    const row = rowFor(panelWith(changed), 'localization')

    expect(row.textContent).toContain(`at the ingest: localization.jcb, ${formatBytes(FILE)}`)
    expect(row.textContent).toContain(`now: localization.jcb, ${formatBytes(FILE * 2)}`)
    expect(row.textContent).toContain(note)
  })
})

describe('the base row (D-16, CONF-03)', () => {
  const cache = (iteration: number, value: boolean | null, shown: string) =>
    reading('cache', value, shown, { extra: { iteration } })

  it('shows one line per ingested iteration in the order sent', () => {
    const base = fact(
      'base',
      'Base realization',
      [
        reading('control file', true, 'ies_include_base is true'),
        cache(0, true, 'iteration 0: base present'),
        cache(3, false, 'iteration 3: base missing'),
        cache(6, true, 'iteration 6: base present'),
      ],
      { agree: false },
    )
    const row = rowFor(panelWith(base), 'base')

    const cacheLines = texts(row, '.config-value').filter((t) => t.startsWith('iteration'))
    expect(cacheLines).toEqual(['iteration 0: base present', 'iteration 3: base missing', 'iteration 6: base present'])
  })

  it('does not call a change over the run a disagreement between sources', () => {
    const base = fact(
      'base',
      'Base realization',
      [cache(0, true, 'iteration 0: base present'), cache(3, false, 'iteration 3: base missing')],
      { agree: false },
    )
    expect(rowFor(panelWith(base), 'base').querySelector('.notice-parts')).toBeNull()
  })

  it('warns when the control file says base was included and the first iteration has none', () => {
    const base = fact(
      'base',
      'Base realization',
      [
        reading('control file', true, 'ies_include_base is true'),
        cache(0, false, 'iteration 0: base was not included in this run'),
      ],
      { agree: false },
    )
    const row = rowFor(panelWith(base), 'base')

    expect(row.querySelector('.notice-parts')).not.toBeNull()
    expect(row.textContent).toContain('control file says ies_include_base is true')
  })

  it('shows "base was not included in this run" as sent and never builds the word lost', () => {
    const base = fact('base', 'Base realization', [
      cache(0, false, 'iteration 0: base was not included in this run'),
      cache(6, false, 'iteration 6: base was not included in this run'),
    ])
    const row = rowFor(panelWith(base), 'base')

    expect(row.textContent).toContain('iteration 0: base was not included in this run')
    expect(row.textContent).not.toMatch(/lost/i)
  })

  it('shows an iteration that was not ingested as sent', () => {
    const base = fact('base', 'Base realization', [
      cache(0, true, 'iteration 0: base present'),
      cache(2, null, 'iteration 2: not ingested'),
    ])
    expect(rowFor(panelWith(base), 'base').textContent).toContain('iteration 2: not ingested')
  })
})

describe('facts with nothing to compare', () => {
  it('says "not found" and lists what pesto looked for when there is no reading', () => {
    const none = fact('reinflation', 'Reinflation', [], {
      looked_for: ['reinflation lines in case.rec', 'files named like case.N.reinflate.pcs.csv'],
      note: 'not found',
    })
    const row = rowFor(panelWith(none), 'reinflation')

    expect(row.querySelector('.config-main .config-value')?.textContent).toBe('not found')
    expect(texts(row, '.config-line .config-value')).toEqual([
      'pesto looked for:',
      'reinflation lines in case.rec',
      'files named like case.N.reinflate.pcs.csv',
    ])
    expect(row.textContent?.match(/not found/g)?.length).toBe(1)
  })

  it('shows the noise band row naming the file and the base exclusion as sent', () => {
    const band = fact('noise_band', 'Noise band', [
      reading('files present', null, 'case.obs+noise.csv is the source of the band', { evidence: 'case.obs+noise.csv' }),
      reading('cache', null, 'base excluded from the band, 49 realizations used', { extra: { base: 'excluded' } }),
    ])
    const row = rowFor(panelWith(band), 'noise_band')

    expect(row.textContent).toContain('case.obs+noise.csv is the source of the band')
    expect(row.textContent).toContain('base excluded from the band, 49 realizations used')
  })

  it('puts the evidence of each reading in the row title', () => {
    const both = fact('noise', 'Measurement noise', [
      reading('run record', false, 'no noise', { evidence: 'case.rec line 12' }),
      reading('control file', false, 'no noise', { evidence: 'case.pst line 40' }),
    ])
    const row = rowFor(panelWith(both), 'noise')

    expect(row.title).toContain('run record: case.rec line 12')
    expect(row.title).toContain('control file: case.pst line 40')
  })
})

describe('text from the run (T-09-22)', () => {
  it('is set as text, never as markup', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const bad = fact('noise', 'Measurement noise', [reading('run record', false, hostile, { evidence: hostile })], {
      note: hostile,
    })
    const host = panelWith(bad)

    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain(hostile)
    expect(rowFor(host, 'noise').title).toContain(hostile)
  })
})
