// The two parameter-view fetchers: a missing artifact is a result with its reason,
// an answer of the wrong shape is refused, and anything else still throws.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchParGroups, fetchPlacement } from '../src/data/par'

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchParGroups', () => {
  it('asks the run-scoped groups route and returns the payload as sent', async () => {
    const body = { groups: [{ group: 'hk' }], notes: [] }
    const fetchMock = stubFetch(200, body)

    const result = await fetchParGroups()

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/par/groups')
    expect(result).toEqual({ ok: true, payload: body })
  })

  it('turns a 404 into a result naming the artifact and the reason', async () => {
    stubFetch(404, { type: 'about:blank', title: 'not found', status: 404, artifact: 'par_groups', detail: 'par_groups.json is not in the cache' })

    expect(await fetchParGroups()).toEqual({
      ok: false,
      artifact: 'par_groups',
      reason: 'par_groups.json is not in the cache',
    })
  })

  it('turns a 409 into a result, and refuses an answer with no group list', async () => {
    stubFetch(409, { type: 'about:blank', title: 'no run is open', status: 409 })
    expect(await fetchParGroups()).toEqual({ ok: false, artifact: 'par_groups', reason: 'no run is open' })

    stubFetch(200, { divider: 0.5 })
    const refused = await fetchParGroups()
    expect(refused.ok).toBe(false)
  })

  it('still throws for a server error', async () => {
    stubFetch(500, { type: 'about:blank', title: 'boom', status: 500 })

    await expect(fetchParGroups()).rejects.toThrow()
  })
})

describe('fetchPlacement', () => {
  it('asks the placement route and returns the payload as sent', async () => {
    const body = { summary: '3 of 5 placed', groups: [{ group: 'u', rule: 'none', mapped: 0, total: 12, notes: [] }], notes: [] }
    const fetchMock = stubFetch(200, body)

    const result = await fetchPlacement()

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/grid/placement')
    expect(result).toEqual({ ok: true, payload: body })
  })

  it('turns a 404 into a result naming the artifact and the reason', async () => {
    stubFetch(404, { type: 'about:blank', title: 'par_cell is missing', status: 404, artifact: 'par_cell' })

    expect(await fetchPlacement()).toEqual({ ok: false, artifact: 'par_cell', reason: 'par_cell is missing' })
  })
})
