// fetchAtBounds and fetchPdcSites: an answer that is off keeps its reason, the conflict sites
// arrive as equal-length Int32Array columns, and a missing field is refused by name.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAtBounds, fetchPdcSites } from '../src/data/overlays'

interface Stub {
  status?: number
  json?: unknown
}

function stubFetch({ status = 200, json }: Stub): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => json }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function problem(status: number, extra: Record<string, unknown> = {}): Stub {
  return { status, json: { type: 'about:blank', title: `status ${status}`, status, ...extra } }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function atBounds(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    reason: null,
    artifact: 'par_change',
    iteration: 1,
    first_iteration: 0,
    last_iteration: 1,
    rule: 'a parameter is at bounds when it has at least 10% of realizations near a bound',
    caveat: 'counts from the float32 cache can be one high',
    groups: [{ group: 'hk', n_par: 10, n_counted: 8, n_at_bounds: 3, n_excluded: { fixed: 1, tied: 1 } }],
    names: null,
    ...extra,
  }
}

describe('fetchAtBounds', () => {
  it('sends the iteration, and the group when one is given', async () => {
    const fetchMock = stubFetch({ json: atBounds() })

    const all = await fetchAtBounds(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/par/at_bounds?iteration=1')
    expect(all).toEqual({
      ok: true,
      answer: {
        available: true,
        reason: null,
        artifact: 'par_change',
        iteration: 1,
        firstIteration: 0,
        lastIteration: 1,
        rule: 'a parameter is at bounds when it has at least 10% of realizations near a bound',
        caveat: 'counts from the float32 cache can be one high',
        groups: [{ group: 'hk', nPar: 10, nCounted: 8, nAtBounds: 3, nExcluded: { fixed: 1, tied: 1 } }],
        names: null,
      },
    })

    const fetchGroup = stubFetch({ json: atBounds({ names: ['hk 1', 'hk,2'] }) })
    const one = await fetchAtBounds(1, 'hk')
    expect(fetchGroup.mock.calls[0][0]).toBe('/api/run/par/at_bounds?iteration=1&group=hk')
    expect(one.ok && one.answer.names).toEqual(['hk 1', 'hk,2'])
  })

  it('keeps the reason and artifact of an answer that is off', async () => {
    const reason = 'near-bound counts exist for iterations 0 and 3 only'
    stubFetch({ json: atBounds({ available: false, reason, iteration: 2, groups: [] }) })

    const result = await fetchAtBounds(2)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.answer.available).toBe(false)
    expect(result.answer.reason).toBe(reason)
    expect(result.answer.artifact).toBe('par_change')
  })

  it('refuses an answer missing caveat, naming the field and the route', async () => {
    const body = atBounds()
    delete body.caveat
    stubFetch({ json: body })

    expect(await fetchAtBounds(1)).toEqual({ ok: false, artifact: 'par_change', reason: 'the /par/at_bounds answer is missing caveat' })
  })

  it('refuses an excluded count that is not a whole number', async () => {
    stubFetch({ json: atBounds({ groups: [{ group: 'hk', n_par: 1, n_counted: 1, n_at_bounds: 0, n_excluded: { fixed: '1' } }] }) })

    const result = await fetchAtBounds(1)
    expect(!result.ok && result.reason).toContain("count for 'fixed'")
  })

  it('turns an unknown group 404 into a refusal and rethrows an aborted fetch', async () => {
    stubFetch(problem(404, { artifact: 'par_change', detail: "no group 'zz'" }))
    expect(await fetchAtBounds(1, 'zz')).toEqual({ ok: false, artifact: 'par_change', reason: "no group 'zz'" })

    const abort = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(abort)))
    await expect(fetchAtBounds(1)).rejects.toBe(abort)
  })
})

function pdc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    reason: null,
    artifact: 'pdc/0',
    iteration: 0,
    source: 'file',
    source_file: 'case.0.pdc.csv',
    weights_source: 'control file',
    rule: 'pestpp-ies prior-data conflict',
    n_obs: 4,
    n_sites: 2,
    n_unmatched: 0,
    n_left_out: 1,
    by_group: [{ group: 'heads', n_obs: 4, n_sites: 2 }],
    sites: { id: [2, 5], cell: [10, -1], layer: [0, -1], group_index: [0, 0], n_obs: [1, 3] },
    groups: ['heads'],
    notes: [],
    ...extra,
  }
}

describe('fetchPdcSites', () => {
  it('asks for the iteration and turns the site lists into Int32Array columns', async () => {
    const fetchMock = stubFetch({ json: pdc() })

    const result = await fetchPdcSites(0)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/obs/pdc?iteration=0')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { sites } = result.answer
    for (const column of [sites.id, sites.cell, sites.layer, sites.groupIndex, sites.nObs]) {
      expect(column).toBeInstanceOf(Int32Array)
      expect(column.length).toBe(2)
    }
    expect(Array.from(sites.id)).toEqual([2, 5])
    expect(Array.from(sites.cell)).toEqual([10, -1])
    expect(Array.from(sites.nObs)).toEqual([1, 3])
    expect(result.answer.byGroup).toEqual([{ group: 'heads', nObs: 4, nSites: 2 }])
    expect(result.answer.nLeftOut).toBe(1)
    expect(result.answer.source).toBe('file')
  })

  it('refuses site lists of unequal length', async () => {
    stubFetch({ json: pdc({ sites: { id: [2, 5], cell: [10], layer: [0, 0], group_index: [0, 0], n_obs: [1, 3] } }) })

    const result = await fetchPdcSites(0)

    expect(result).toEqual({ ok: false, artifact: 'pdc/0', reason: "the /obs/pdc answer's sites lists are not the same length: id has 2, cell has 1" })
  })

  it('refuses a group_index that names no group and a value Int32Array would wrap', async () => {
    stubFetch({ json: pdc({ sites: { id: [2], cell: [1], layer: [0], group_index: [1], n_obs: [1] } }) })
    const group = await fetchPdcSites(0)
    expect(!group.ok && group.reason).toContain('group_index 1')

    stubFetch({ json: pdc({ sites: { id: [2 ** 31], cell: [1], layer: [0], group_index: [0], n_obs: [1] } }) })
    const wrap = await fetchPdcSites(0)
    expect(!wrap.ok && wrap.reason).toContain('32-bit')
  })

  it('refuses an answer missing n_left_out, naming the field and the route', async () => {
    const body = pdc()
    delete body.n_left_out
    stubFetch({ json: body })

    expect(await fetchPdcSites(0)).toEqual({ ok: false, artifact: 'pdc/0', reason: 'the /obs/pdc answer is missing n_left_out' })
  })

  it('keeps the reason of an answer that is off, and allows it no counts', async () => {
    const reason = 'no prior-data conflict was ingested for iteration 3'
    const body = pdc({
      available: false,
      reason,
      artifact: 'pdc/3',
      iteration: 3,
      source: null,
      source_file: null,
      weights_source: null,
      rule: null,
      n_obs: null,
      n_sites: null,
      n_unmatched: null,
      n_left_out: null,
      by_group: [],
      sites: { id: [], cell: [], layer: [], group_index: [], n_obs: [] },
      groups: [],
    })
    stubFetch({ json: body })

    const result = await fetchPdcSites(3)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.answer.available).toBe(false)
    expect(result.answer.reason).toBe(reason)
    expect(result.answer.artifact).toBe('pdc/3')
    expect(result.answer.nObs).toBeNull()
    expect(result.answer.sites.id.length).toBe(0)
  })

  it('refuses an answer that is on but carries no count', async () => {
    stubFetch({ json: pdc({ n_obs: null }) })

    const result = await fetchPdcSites(0)
    expect(!result.ok && result.reason).toBe("the /obs/pdc answer's n_obs is not a whole number")
  })

  it('turns a 404 problem into a refusal and rethrows an aborted fetch', async () => {
    stubFetch(problem(404, { artifact: 'pdc/1', detail: 'a pdc position is past the observation table' }))
    expect(await fetchPdcSites(1)).toEqual({ ok: false, artifact: 'pdc/1', reason: 'a pdc position is past the observation table' })

    stubFetch(problem(409))
    expect(await fetchPdcSites(1)).toEqual({ ok: false, artifact: 'pdc/1', reason: 'status 409' })

    const abort = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(abort)))
    await expect(fetchPdcSites(1)).rejects.toBe(abort)
  })
})
