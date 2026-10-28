// fetchLinkPar and fetchLinkSites: names travel unchanged, long lists are cut and the cut is
// counted, a missing field is refused by name, and a problem is a typed refusal.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLinkPar, fetchLinkSites, MAX_LINK_PARS, MAX_LINK_SITES } from '../src/data/link-targets'

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

function query(fetchMock: ReturnType<typeof vi.fn>, call = 0): URLSearchParams {
  return new URL(fetchMock.mock.calls[call][0] as string, 'http://pesto.test').searchParams
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function parRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parnme: 'hk,1',
    pargp: 'hk',
    kind: 'pilot_point',
    layer: 0,
    cell: 12,
    cells: [3, 12, 40],
    n_cells: 3,
    cells_capped: false,
    reason: null,
    ...extra,
  }
}

describe('fetchLinkPar', () => {
  it('sends the names as one JSON list, unchanged, and reads each answer', async () => {
    const fetchMock = stubFetch({ json: { pars: [parRow()], unknown: [' hk_1 '] } })

    const result = await fetchLinkPar([' hk_1 ', 'hk,1'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0][0] as string).startsWith('/api/run/link/par?')).toBe(true)
    expect(query(fetchMock).getAll('names')).toEqual([JSON.stringify([' hk_1 ', 'hk,1'])])
    expect(result).toEqual({
      ok: true,
      pars: [{ parnme: 'hk,1', pargp: 'hk', kind: 'pilot_point', layer: 0, cell: 12, cells: [3, 12, 40], nCells: 3, cellsCapped: false, reason: null }],
      unknown: [' hk_1 '],
      notAsked: 0,
    })
  })

  it('asks for the first 50 of 60 names in the order given and says 10 were left out', async () => {
    const fetchMock = stubFetch({ json: { pars: [], unknown: [] } })
    const names = Array.from({ length: 60 }, (_, i) => `p${i}`)

    const result = await fetchLinkPar(names)

    expect(MAX_LINK_PARS).toBe(50)
    expect(JSON.parse(query(fetchMock).get('names') as string)).toEqual(names.slice(0, 50))
    expect(result.ok && result.notAsked).toBe(10)
  })

  it('refuses an answer missing cells_capped, naming the field and the route', async () => {
    const row = parRow()
    delete row.cells_capped
    stubFetch({ json: { pars: [row], unknown: [] } })

    const result = await fetchLinkPar(['hk,1'])

    expect(result).toEqual({ ok: false, artifact: 'par_cell', reason: "the /link/par answer's pars[0] is missing cells_capped" })
  })

  it('refuses an answer missing unknown rather than taking it as none', async () => {
    stubFetch({ json: { pars: [] } })

    const result = await fetchLinkPar(['a'])

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('the /link/par answer is missing unknown')
  })

  it('refuses a kind it does not know and a cell that is not a whole number', async () => {
    stubFetch({ json: { pars: [parRow({ kind: 'zone' })], unknown: [] } })
    const kind = await fetchLinkPar(['a'])
    expect(!kind.ok && kind.reason).toContain("kind 'zone'")

    stubFetch({ json: { pars: [parRow({ cell: null })], unknown: [] } })
    const cell = await fetchLinkPar(['a'])
    expect(!cell.ok && cell.reason).toBe("the /link/par answer's pars[0]'s cell is not a whole number")
  })

  it('asks nothing for an empty list', async () => {
    const fetchMock = stubFetch({ json: {} })

    expect(await fetchLinkPar([])).toEqual({ ok: false, artifact: 'par_cell', reason: 'no parameter was asked for' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('turns a 404 or 409 problem into a refusal with its artifact and reason', async () => {
    stubFetch(problem(404, { artifact: 'pp_factors', detail: 'no factor file was read' }))
    expect(await fetchLinkPar(['a'])).toEqual({ ok: false, artifact: 'pp_factors', reason: 'no factor file was read' })

    stubFetch(problem(409))
    expect(await fetchLinkPar(['a'])).toEqual({ ok: false, artifact: 'par_cell', reason: 'status 409' })
  })

  it('still throws for a server error and rethrows an aborted fetch', async () => {
    stubFetch(problem(500))
    await expect(fetchLinkPar(['a'])).rejects.toThrow()

    const abort = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(abort)))
    await expect(fetchLinkPar(['a'])).rejects.toBe(abort)
  })
})

function siteRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { site_id: 3, site: 'well a', group: 'heads', layer: -1, cell: 7, placed: true, has_value: true, ...extra }
}

describe('fetchLinkSites', () => {
  it('sends the ids in the order asked with the iteration and reads true, false and null values', async () => {
    const body = {
      iteration: 1,
      sites: [siteRow(), siteRow({ site_id: 1, has_value: false }), siteRow({ site_id: 2, cell: -1, placed: false, has_value: null })],
      unknown: [9],
      value_rule: 'a site has a value when at least one of its observations has a usable ensemble mean in this iteration',
      value_reason: null,
    }
    const fetchMock = stubFetch({ json: body })

    const result = await fetchLinkSites([3, 1, 2], 1)

    expect((fetchMock.mock.calls[0][0] as string).startsWith('/api/run/link/sites?')).toBe(true)
    expect(query(fetchMock).get('sites')).toBe('3,1,2')
    expect(query(fetchMock).get('iteration')).toBe('1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sites.map((s) => s.hasValue)).toEqual([true, false, null])
    expect(result.sites[0]).toEqual({ siteId: 3, site: 'well a', group: 'heads', layer: -1, cell: 7, placed: true, hasValue: true })
    expect(result.unknown).toEqual([9])
    expect(result.valueRule).toBe(body.value_rule)
    expect(result.valueReason).toBeNull()
    expect(result.notAsked).toBe(0)
  })

  it('asks for the first 200 of 250 ids and says 50 were left out', async () => {
    const fetchMock = stubFetch({ json: { iteration: 0, sites: [], unknown: [], value_rule: 'r', value_reason: 'no observation statistics for iteration 0' } })
    const ids = Array.from({ length: 250 }, (_, i) => 249 - i)

    const result = await fetchLinkSites(ids, 0)

    expect(MAX_LINK_SITES).toBe(200)
    expect(query(fetchMock).get('sites')).toBe(ids.slice(0, 200).join(','))
    expect(result.ok && result.notAsked).toBe(50)
    expect(result.ok && result.valueReason).toBe('no observation statistics for iteration 0')
  })

  it('refuses an answer missing value_rule or has_value, naming the field', async () => {
    stubFetch({ json: { iteration: 0, sites: [], unknown: [], value_reason: null } })
    const rule = await fetchLinkSites([1], 0)
    expect(rule).toEqual({ ok: false, artifact: 'obs_cell', reason: 'the /link/sites answer is missing value_rule' })

    const row = siteRow()
    delete row.has_value
    stubFetch({ json: { iteration: 0, sites: [row], unknown: [], value_rule: 'r', value_reason: null } })
    const value = await fetchLinkSites([1], 0)
    expect(!value.ok && value.reason).toBe("the /link/sites answer's sites[0] is missing has_value")
  })

  it('asks nothing for an empty list or an id that is not a whole number', async () => {
    const fetchMock = stubFetch({ json: {} })

    expect((await fetchLinkSites([], 0)).ok).toBe(false)
    expect(await fetchLinkSites([1.5], 0)).toEqual({ ok: false, artifact: 'obs_cell', reason: 'a site id was not a whole number' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('turns a 404 into a refusal and rethrows an aborted fetch', async () => {
    stubFetch(problem(404, { artifact: 'obs_cell', detail: 'no placement was ingested' }))
    expect(await fetchLinkSites([1], 0)).toEqual({ ok: false, artifact: 'obs_cell', reason: 'no placement was ingested' })

    const abort = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(abort)))
    await expect(fetchLinkSites([1], 0)).rejects.toBe(abort)
  })
})
