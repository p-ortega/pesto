// The browser's IngestState type carries the five observation capabilities the
// server added in phase 8. They are optional: a server that sends only map,
// stats and chips must still give exactly those three.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestState } from '../src/data/client'

const OK = { available: true, blocked_by: [] }

function stubState(capabilities: Record<string, unknown>): void {
  const body = {
    fresh: true,
    artifacts: [],
    capabilities,
    ingest_seconds: null,
    cache_bytes: null,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ingestState observation capabilities', () => {
  it('maps obs, obs_stats, noise, pdc and phi_check, with blockedBy from blocked_by', async () => {
    const blocked = [{ artifact: 'noise_agg', reason: 'no case.obs+noise file was found for this run' }]
    stubState({
      map: OK,
      stats: OK,
      chips: OK,
      obs: OK,
      obs_stats: { available: false, blocked_by: [{ artifact: 'obs_agg', reason: 'no observation ensemble' }] },
      noise: { available: false, blocked_by: blocked },
      pdc: { available: true, blocked_by: [], notes: ['no pestpp pdc file for iteration(s) 1'] },
      phi_check: { available: false, blocked_by: [{ artifact: 'phi_check', reason: 'no case.phi.actual.csv was found for this run' }] },
    })

    const { capabilities } = await ingestState()

    expect(capabilities.obs).toEqual({ available: true, blockedBy: [] })
    expect(capabilities.obsStats).toEqual({
      available: false,
      blockedBy: [{ artifact: 'obs_agg', reason: 'no observation ensemble' }],
    })
    expect(capabilities.noise).toEqual({ available: false, blockedBy: blocked })
    expect(capabilities.pdc).toEqual({
      available: true,
      blockedBy: [],
      notes: ['no pestpp pdc file for iteration(s) 1'],
    })
    expect(capabilities.phiCheck).toEqual({
      available: false,
      blockedBy: [{ artifact: 'phi_check', reason: 'no case.phi.actual.csv was found for this run' }],
    })
    expect(capabilities.map).toEqual({ available: true, blockedBy: [] })
  })

  it('returns map, stats and chips alone from a server that sends only those', async () => {
    stubState({ map: OK, stats: OK, chips: { available: false, blocked_by: [{ artifact: 'config', reason: 'x' }] } })

    const { capabilities } = await ingestState()

    expect(Object.keys(capabilities).sort()).toEqual(['chips', 'map', 'stats'])
    expect(capabilities.obs).toBeUndefined()
    expect(capabilities.obsStats).toBeUndefined()
    expect(capabilities.noise).toBeUndefined()
    expect(capabilities.pdc).toBeUndefined()
    expect(capabilities.phiCheck).toBeUndefined()
    expect(capabilities.chips.blockedBy).toEqual([{ artifact: 'config', reason: 'x' }])
  })

  it('carries a capability with only some of the new keys', async () => {
    stubState({ map: OK, stats: OK, chips: OK, phi_check: OK })

    const { capabilities } = await ingestState()

    expect(capabilities.phiCheck).toEqual({ available: true, blockedBy: [] })
    expect(capabilities.pdc).toBeUndefined()
  })
})
