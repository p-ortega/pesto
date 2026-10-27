// The parameter view fetchers: a missing artifact is a result with its reason,
// an answer of the wrong shape is refused, and anything else still throws.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchParChange, fetchParGroups, fetchParHist, fetchParValues, fetchPlacement } from '../src/data/par'

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

describe('fetchParHist', () => {
  it('asks the histogram route for the group and returns the payload as sent', async () => {
    const body = { group: 'hk pilot', space: 'log10', edges: [0, 1], first: null, last: null, refused: null, notes: [] }
    const fetchMock = stubFetch(200, body)

    const result = await fetchParHist('hk pilot')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/par/hist?group=hk%20pilot')
    expect(result).toEqual({ ok: true, payload: body })
  })

  it('turns a 404 into a result naming the artifact and the reason, and refuses an answer of the wrong shape', async () => {
    stubFetch(404, { type: 'about:blank', title: 'no such group', status: 404, artifact: 'par_hist', detail: "no group named 'x'" })
    expect(await fetchParHist('x')).toEqual({ ok: false, artifact: 'par_hist', reason: "no group named 'x'" })

    stubFetch(200, { divider: 0.5 })
    expect((await fetchParHist('x')).ok).toBe(false)
  })
})

describe('fetchParValues', () => {
  it('asks the values route for the parameter and returns the payload as sent', async () => {
    const body = { parameter: 'hk_0001', group: 'hk', space: 'native', edges: null, first: null, last: null, refused: 'fixed', notes: [] }
    const fetchMock = stubFetch(200, body)

    const result = await fetchParValues('hk_0001')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/par/values?parameter=hk_0001')
    expect(result).toEqual({ ok: true, payload: body })
  })

  it('turns the drill-down limit 409 into a result carrying the stored reason', async () => {
    const detail = 'This group has 12,000 parameters. Drill-down is offered up to 10,000.'
    stubFetch(409, { type: 'about:blank', title: 'drill-down is not offered for this group', status: 409, artifact: 'par_groups', detail })

    expect(await fetchParValues('hk_0001')).toEqual({ ok: false, artifact: 'par_groups', reason: detail })
  })
})

function stubArrowFetch(status: number, body: ArrayBuffer | unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => body as ArrayBuffer,
    headers: { get: () => null },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function ipc(columns: Record<string, unknown[]>): ArrayBuffer {
  const bytes = tableToIPC(tableFromArrays(columns), 'stream')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('fetchParChange', () => {
  it('reads the change table by column name, whatever order the columns come in', async () => {
    const fetchMock = stubArrowFetch(
      200,
      ipc({
        mean_shift_sd: [0.5, Number.NaN],
        sd_change_pct: [-10, null],
        mean_change_refused: [null, 'the prior mean is too close to zero'],
        mean_change_pct: [4, null],
        excluded_reason: [null, null],
        included: [true, true],
        parnme: ['p2', 'p1'],
      }),
    )

    const result = await fetchParChange('hk')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/par/change?group=hk')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload[0]).toMatchObject({ parnme: 'p2', mean_change_pct: 4, sd_change_pct: -10, mean_shift_sd: 0.5, included: true })
    expect(result.payload[1]).toMatchObject({
      parnme: 'p1',
      mean_change_pct: null,
      mean_change_refused: 'the prior mean is too close to zero',
      sd_change_pct: null,
      mean_shift_sd: null,
    })
  })

  it('carries the reason of a parameter that is left out', async () => {
    stubArrowFetch(200, ipc({ parnme: ['p1'], included: [false], excluded_reason: ['fixed: does not move'] }))

    const result = await fetchParChange('hk')

    expect(result.ok && result.payload[0]).toMatchObject({ included: false, excluded_reason: 'fixed: does not move', mean_change_pct: null })
  })

  it('fails when the table has no parameter names, rather than reading rows by position', async () => {
    stubArrowFetch(200, ipc({ included: [true] }))

    await expect(fetchParChange('hk')).rejects.toThrow('parnme')
  })

  it('turns the drill-down limit 409 into a result carrying the stored reason', async () => {
    const detail = 'This group has 12,000 parameters. Drill-down is offered up to 10,000.'
    stubArrowFetch(409, { type: 'about:blank', title: 'drill-down is not offered for this group', status: 409, artifact: 'par_groups', detail })

    expect(await fetchParChange('hk')).toEqual({ ok: false, artifact: 'par_groups', reason: detail })
  })
})
