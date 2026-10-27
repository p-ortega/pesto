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

  it('no longer shows the Config placeholder, and the Obs tab keeps its own', async () => {
    const root = await openShell(runConfig())
    expect(root.querySelector('#panel-config')?.textContent).not.toContain('How the run was set up will show here')
    expect(root.querySelector('#panel-obs')?.textContent).toContain('Observations will show here')
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
    expect(panel.textContent).toContain("configuration could not be read")
  })
})
