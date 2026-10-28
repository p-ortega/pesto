// The observation fetchers: answers are read by name, a missing name is a refusal that says which,
// a missing artifact is a result with its reason, and anything else still throws.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchObs1to1,
  fetchObsBrush,
  fetchObsFrame,
  fetchObsGroups,
  fetchObsPoints,
  fetchObsReals,
  fetchObsResidHist,
  fetchObsSeries,
  fetchObsSite,
  fetchObsSites,
  fetchObsTimes,
  OBS_STATS,
  OBS_STAT_LABEL,
  shareRead,
  TABLE_RMSE_LABEL,
} from '../src/data/obs'

interface Stub {
  status?: number
  json?: unknown
  bytes?: ArrayBuffer
  headers?: Record<string, string>
}

function stubFetch({ status = 200, json, bytes, headers = {} }: Stub): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    arrayBuffer: async () => bytes as ArrayBuffer,
    headers: { get: (name: string) => headers[name] ?? null },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function ipc(columns: Record<string, unknown[]>): ArrayBuffer {
  const out = tableToIPC(tableFromArrays(columns), 'stream')
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
}

function problem(status: number, extra: Record<string, unknown> = {}): Stub {
  return { status, json: { type: 'about:blank', title: `status ${status}`, status, ...extra } }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function siteColumns(): Record<string, unknown[]> {
  return {
    site_id: [0, 1],
    site: ['well_a', 'well_b'],
    n_obs: [3, 4],
    x: [Float32Array.of(10.5)[0], Number.NaN],
    y: [Float32Array.of(-20.25)[0], Number.NaN],
    xy_source: ['own', 'none'],
    layer: [1, -1],
    cell: [42, -1],
    rule: ['own xy', 'no position'],
    note: [null, 'no xy given'],
  }
}

const SITES_META = { 'X-Pesto-Meta': JSON.stringify({ order_digest: 'digest-a' }) }

describe('fetchObsSites', () => {
  it('reads two rows by column name and builds the URL with group as a query value', async () => {
    const fetchMock = stubFetch({ bytes: ipc(siteColumns()), headers: { ...SITES_META, 'X-Pesto-Notes': JSON.stringify(['one note']) } })

    const result = await fetchObsSites('heads')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/obs/sites?group=heads')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.notes).toEqual(['one note'])
    expect(result.orderDigest).toBe('digest-a')
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toEqual({
      siteId: 0,
      site: 'well_a',
      nObs: 3,
      x: 10.5,
      y: -20.25,
      xySource: 'own',
      layer: 1,
      cell: 42,
      rule: 'own xy',
      note: null,
    })
    expect(Number.isNaN(result.rows[1].x)).toBe(true)
    expect(Number.isNaN(result.rows[1].y)).toBe(true)
    expect(result.rows[1].layer).toBe(-1)
    expect(result.rows[1].note).toBe('no xy given')
  })

  it('reads columns by name, whatever order the table puts them in', async () => {
    const columns = siteColumns()
    const reversed = Object.fromEntries(Object.entries(columns).reverse())
    stubFetch({ bytes: ipc(reversed), headers: SITES_META })

    const result = await fetchObsSites('heads')

    expect(result.ok && result.rows[0].site).toBe('well_a')
    expect(result.ok && result.notes).toEqual([])
  })

  it('refuses sites that come with no order digest', async () => {
    stubFetch({ bytes: ipc(siteColumns()) })

    const result = await fetchObsSites('heads')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('X-Pesto-Meta')
  })

  it('refuses a table missing xy_source, naming it', async () => {
    const columns = siteColumns()
    delete columns.xy_source
    stubFetch({ bytes: ipc(columns), headers: SITES_META })

    const result = await fetchObsSites('heads')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('the site table is missing xy_source')
  })

  it('refuses an xy_source it does not know instead of passing it on', async () => {
    const columns = siteColumns()
    columns.xy_source = ['own', 'guess']
    stubFetch({ bytes: ipc(columns), headers: SITES_META })

    const result = await fetchObsSites('heads')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('guess')
  })

  it('turns a 404 naming obs_cell into a result carrying the problem detail', async () => {
    stubFetch(problem(404, { artifact: 'obs_cell', detail: 'obs_cell is not in the cache' }))

    expect(await fetchObsSites('heads')).toEqual({ ok: false, artifact: 'obs_cell', reason: 'obs_cell is not in the cache' })
  })

  it('turns the too-many-sites 409 into a result, and still throws for a server error', async () => {
    stubFetch(problem(409, { detail: 'this group has 120,000 sites' }))
    const refused = await fetchObsSites('heads')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe('this group has 120,000 sites')

    stubFetch(problem(500))
    await expect(fetchObsSites('heads')).rejects.toThrow()
  })

  it('sends a group name with spaces, ampersand and slash as an encoded query value, never in the path', async () => {
    const fetchMock = stubFetch({ bytes: ipc(siteColumns()), headers: SITES_META })

    await fetchObsSites('a b&c/d')

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toBe('/api/run/obs/sites?group=a%20b%26c%2Fd')
    expect(url.split('?')[0]).toBe('/api/run/obs/sites')
  })
})

function blobOf(values: number[]): ArrayBuffer {
  return Float32Array.from(values).buffer as ArrayBuffer
}

function groupColumns(): Record<string, unknown[]> {
  return {
    group: ['heads', 'flows'],
    n_obs: [10, 5],
    n_sites: [2, 1],
    n_placed: [2, null],
    n_weighted: [9, 5],
    n_with_target: [10, 5],
    n_zero_weight: [1, 0],
    n_sentinel: [0, 0],
    n_no_value: [0, 0],
    time_kind: ['datetime', 'numeric'],
    inequality: ['none', 'greater'],
    first_iteration: [0, 0],
    last_iteration: [3, null],
    rmse_first: [4.5, null],
    rmse_last: [1.25, null],
    n_resid_first: [10, 0],
    n_resid_last: [10, 0],
  }
}

describe('fetchObsGroups', () => {
  it('reads every column by name and keeps a null as null', async () => {
    const fetchMock = stubFetch({ bytes: ipc(groupColumns()) })

    const result = await fetchObsGroups()

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/obs/groups')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows[0]).toEqual({
      group: 'heads',
      nObs: 10,
      nSites: 2,
      nPlaced: 2,
      nWeighted: 9,
      nWithTarget: 10,
      nZeroWeight: 1,
      nSentinel: 0,
      nNoValue: 0,
      timeKind: 'datetime',
      inequality: 'none',
      firstIteration: 0,
      lastIteration: 3,
      rmseFirst: 4.5,
      rmseLast: 1.25,
      nResidFirst: 10,
      nResidLast: 10,
    })
    expect(result.rows[1].nPlaced).toBeNull()
    expect(result.rows[1].lastIteration).toBeNull()
    expect(result.rows[1].rmseFirst).toBeNull()
    expect(result.rows[1].rmseLast).toBeNull()
  })

  it('refuses a table missing a column, naming it', async () => {
    const columns = groupColumns()
    delete columns.n_zero_weight
    stubFetch({ bytes: ipc(columns) })

    const result = await fetchObsGroups()

    expect(result).toEqual({ ok: false, artifact: 'obs_index', reason: 'the group table is missing n_zero_weight' })
  })

  it('turns a 404 into a result with the reason', async () => {
    stubFetch(problem(404, { artifact: 'obs_index', detail: 'no observations were read' }))

    expect(await fetchObsGroups()).toEqual({ ok: false, artifact: 'obs_index', reason: 'no observations were read' })
  })
})

describe('fetchObsFrame', () => {
  const meta = { group: 'heads', iteration: 1, time: 18262.5, stat: 'resid_mean', order_digest: 'digest-a', n_sites: 3, n_at_time: 2, n_rows_hidden: 1, n_finite: 2, dtype: '<f4' }

  it('builds the query with the time as written and returns the values with their meta', async () => {
    const fetchMock = stubFetch({ bytes: blobOf([1.5, Number.NaN, -2]), headers: { 'X-Pesto-Meta': JSON.stringify(meta) } })

    const result = await fetchObsFrame('heads', 1, 18262.5, 'resid_mean')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/obs/frame?group=heads&iteration=1&time=18262.5&stat=resid_mean')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.values[0]).toBe(1.5)
    expect(Number.isNaN(result.values[1])).toBe(true)
    expect(result.meta).toEqual({ group: 'heads', iteration: 1, time: 18262.5, stat: 'resid_mean', orderDigest: 'digest-a', nSites: 3, nAtTime: 2, nRowsHidden: 1, nFinite: 2 })
    expect(result.meta.nSites).toBe(result.values.length)
  })

  it('refuses a frame whose length disagrees with n_sites', async () => {
    stubFetch({ bytes: blobOf([1, 2]), headers: { 'X-Pesto-Meta': JSON.stringify(meta) } })

    const result = await fetchObsFrame('heads', 1, 18262.5, 'resid_mean')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('2 values')
  })

  it('refuses a frame with no meta header, and one with a meta field missing', async () => {
    stubFetch({ bytes: blobOf([1, 2, 3]) })
    expect((await fetchObsFrame('heads', 1, 5, 'rmse')).ok).toBe(false)

    const short: Record<string, unknown> = { ...meta }
    delete short.n_finite
    stubFetch({ bytes: blobOf([1, 2, 3]), headers: { 'X-Pesto-Meta': JSON.stringify(short) } })
    const result = await fetchObsFrame('heads', 1, 5, 'rmse')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('n_finite')
  })

  it('refuses a frame that names no order digest', async () => {
    const short: Record<string, unknown> = { ...meta }
    delete short.order_digest
    stubFetch({ bytes: blobOf([1, 2, 3]), headers: { 'X-Pesto-Meta': JSON.stringify(short) } })

    const result = await fetchObsFrame('heads', 1, 5, 'rmse')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('order_digest')
  })

  it('turns a 404 into a result with the reason', async () => {
    stubFetch(problem(404, { artifact: 'obs_agg', detail: 'no statistics for iteration 7' }))

    expect(await fetchObsFrame('heads', 7, 1, 'std')).toEqual({ ok: false, artifact: 'obs_agg', reason: 'no statistics for iteration 7' })
  })
})

describe('fetchObsSeries', () => {
  const meta = { shape: [2, 3], dtype: '<f4', site_id: 4, iteration: 1, n_real: 3, base_index: [0], base_note: null, n_nan: 1 }

  it('returns the observation-major values with the base and the NaN count', async () => {
    const fetchMock = stubFetch({
      bytes: blobOf([1, 2, 3, 4, Number.NaN, 6]),
      headers: { 'X-Pesto-Meta': JSON.stringify(meta) },
    })

    const result = await fetchObsSeries(4, 1)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/obs/series?site=4&iteration=1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.count).toBe(2)
    expect(result.nReal).toBe(3)
    expect(result.values.length).toBe(result.count * result.nReal)
    expect(result.baseIndex).toEqual([0])
    expect(result.baseNote).toBeNull()
    expect(result.nNaN).toBe(1)
    expect(result.iteration).toBe(1)
    expect(result.siteId).toBe(4)
  })

  it('refuses a blob that is not count times nReal long', async () => {
    stubFetch({ bytes: blobOf([1, 2, 3, 4, 5]), headers: { 'X-Pesto-Meta': JSON.stringify(meta) } })

    const result = await fetchObsSeries(4, 1)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('5 values')
  })

  it('refuses meta with no base_index rather than guessing the base', async () => {
    const short: Record<string, unknown> = { ...meta }
    delete short.base_index
    stubFetch({ bytes: blobOf([1, 2, 3, 4, 5, 6]), headers: { 'X-Pesto-Meta': JSON.stringify(short) } })

    const result = await fetchObsSeries(4, 1)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('base_index')
  })

  it('turns a 404 into a result with the reason', async () => {
    stubFetch(problem(404, { artifact: 'obs_ens/3', detail: 'no ensemble for iteration 3' }))

    expect(await fetchObsSeries(4, 3)).toEqual({ ok: false, artifact: 'obs_ens/3', reason: 'no ensemble for iteration 3' })
  })
})

describe('the JSON routes', () => {
  it('fetchObsTimes asks for the group and returns the payload as sent', async () => {
    const body = { group: 'a b', order_digest: 'digest-a', times: [1, 2], n_at_time: [3, 3], iterations: [], limits: {}, limits_refused: null, refused: null }
    const fetchMock = stubFetch({ json: body })

    const result = await fetchObsTimes('a b')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/obs/times?group=a%20b')
    expect(result).toEqual({ ok: true, payload: body })
  })

  it('fetchObsSite asks for the site number and refuses an answer missing a field, naming it', async () => {
    const full = {
      site_id: 3,
      site: 's',
      group: 'g',
      time_kind: 'numeric',
      inequality: 'none',
      n_obs: 1,
      time: [1],
      obsval: [2],
      no_value: [false],
      sentinel: [false],
      weighted: [true],
      noise: { available: false, artifact: 'noise_agg', reason: 'none' },
      placement: { available: false, artifact: 'obs_cell', reason: 'none' },
      iterations: [0],
      notes: [],
    }
    const fetchMock = stubFetch({ json: full })
    expect(await fetchObsSite(3)).toEqual({ ok: true, payload: full })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/obs/site?site=3')

    const short: Record<string, unknown> = { ...full }
    delete short.weighted
    stubFetch({ json: short })
    const refused = await fetchObsSite(3)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe('the site answer is missing weighted')
  })

  it('fetchObs1to1 asks for the group and refuses an answer with no grids', async () => {
    const body = {
      group: 'g',
      n_bins: 2,
      lo: 0,
      hi: 1,
      x_label: 'observed',
      y_label: 'simulated',
      grids: [{ iteration: 0, counts: [1, 0, 0, 1], n_points: 2, n_outside: 0, n_no_valid: 0, n_nonfinite: 0 }],
      left_out: { no_value: 0, sentinel: 0 },
      outlying: [],
      ranking_rule: 'r',
      rmse_rule: 'm',
      refused: null,
    }
    const fetchMock = stubFetch({ json: body })
    expect(await fetchObs1to1('g')).toEqual({ ok: true, payload: body })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/obs/1to1?group=g')

    const short: Record<string, unknown> = { ...body }
    delete short.grids
    stubFetch({ json: short })
    const refused = await fetchObs1to1('g')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain('grids')
  })

  it('fetchObsResidHist asks for the group and turns a 404 into a result', async () => {
    const body = { group: 'g', residual: 'simulated minus observed', edges: [], first: null, last: null, n_outside: {}, left_out: {}, refused: 'none' }
    const fetchMock = stubFetch({ json: body })
    expect(await fetchObsResidHist('g')).toEqual({ ok: true, payload: body })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/obs/resid_hist?group=g')

    stubFetch(problem(404, { artifact: 'obs_agg', detail: 'missing' }))
    expect(await fetchObsResidHist('g')).toEqual({ ok: false, artifact: 'obs_agg', reason: 'missing' })
  })

  it('sends a name with path or query characters as a query value only', async () => {
    const fetchMock = stubFetch({ json: {} })

    await fetchObsTimes('x&y=1/../z')
    await fetchObs1to1('x&y=1/../z')
    await fetchObsResidHist('x&y=1/../z')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const call of fetchMock.mock.calls) {
      const url = call[0] as string
      expect(url).toContain('group=x%26y%3D1%2F..%2Fz')
      expect(url.split('?')).toHaveLength(2)
    }
  })

  it('still throws for a server error', async () => {
    stubFetch(problem(500))

    await expect(fetchObsTimes('g')).rejects.toThrow()
  })
})

describe('fetchObsPoints', () => {
  it('joins the ids with commas and returns the payload as sent', async () => {
    const body = { group: 'g', sites: [], not_in_group: [9], unknown: [] }
    const fetchMock = stubFetch({ json: body })

    const result = await fetchObsPoints('g', [1, 2, 3])

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/obs/points?group=g&sites=1%2C2%2C3')
    expect(result).toEqual({ ok: true, payload: body })
  })

  it('refuses more than 20 ids before any request', async () => {
    const fetchMock = stubFetch({ json: {} })

    const result = await fetchObsPoints('g', Array.from({ length: 21 }, (_, i) => i))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('21')
  })

  it('refuses no ids and a non-integer id before any request', async () => {
    const fetchMock = stubFetch({ json: {} })

    expect((await fetchObsPoints('g', [])).ok).toBe(false)
    expect((await fetchObsPoints('g', [1.5])).ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the statistic names', () => {
  it('lists the four statistics and gives the map and the table different RMSE names', () => {
    expect([...OBS_STATS]).toEqual(['resid_mean', 'rmse', 'std', 'mean'])
    expect(OBS_STAT_LABEL.rmse).toBe('RMS residual over realizations')
    expect(OBS_STAT_LABEL.resid_mean).toBe('mean residual (simulated minus observed)')
    expect(TABLE_RMSE_LABEL).toBe('RMSE of the ensemble-mean residual')
    expect(OBS_STAT_LABEL.rmse).not.toBe(TABLE_RMSE_LABEL)
    for (const stat of OBS_STATS) expect(OBS_STAT_LABEL[stat]).not.toBe('RMSE')
  })
})

describe('shareRead', () => {
  it('shares one promise between two calls', async () => {
    const read = vi.fn(async () => ({ ok: true as const, value: 1 }))
    const shared = shareRead(read)

    const [a, b] = [shared(), shared()]

    expect(a).toBe(b)
    await a
    expect(shared()).toBe(a)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('forgets an {ok: false} answer, so the next call reads again', async () => {
    const read = vi
      .fn<() => Promise<{ ok: boolean }>>()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true })
    const shared = shareRead(read)

    expect((await shared()).ok).toBe(false)
    await Promise.resolve()
    expect((await shared()).ok).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('forgets a thrown answer, so the next call reads again', async () => {
    const read = vi
      .fn<() => Promise<{ ok: boolean }>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ ok: true })
    const shared = shareRead(read)

    await expect(shared()).rejects.toThrow('network')
    await Promise.resolve()
    expect((await shared()).ok).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('fetchObsBrush', () => {
  function brushBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      group: 'heads',
      iteration: 1,
      lo: -0.5,
      hi: 0.5,
      sites: [2, 4, 9],
      n_obs_in_range: 7,
      left_out: { no_target: 1, sentinel: 2, no_valid_realization: 0 },
      other: { iteration: 0, counts: [0, 3], density: [0, 0.5], n_sites: 3, n_obs: 6 },
      ...extra,
    }
  }

  it('sends group, iteration, lo and hi and returns the payload as sent', async () => {
    const body = brushBody()
    const fetchMock = stubFetch({ json: body })

    const result = await fetchObsBrush('heads', 1, -0.5, 0.5)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/obs/brush?group=heads&iteration=1&lo=-0.5&hi=0.5')
    expect(result).toEqual({ ok: true, payload: body })
  })

  it('takes other as null but refuses an answer without it, naming it', async () => {
    const one = brushBody({ other: null })
    stubFetch({ json: one })
    expect(await fetchObsBrush('heads', 1, -0.5, 0.5)).toEqual({ ok: true, payload: one })

    const short = brushBody()
    delete short.other
    stubFetch({ json: short })
    expect(await fetchObsBrush('heads', 1, -0.5, 0.5)).toEqual({ ok: false, artifact: 'obs_agg', reason: 'the brush answer is missing other' })
  })

  it('asks nothing for a range that is reversed or not finite', async () => {
    const fetchMock = stubFetch({ json: brushBody() })

    expect((await fetchObsBrush('heads', 1, 1, -1)).ok).toBe(false)
    expect((await fetchObsBrush('heads', 1, Number.NaN, 1)).ok).toBe(false)
    expect((await fetchObsBrush('heads', 1, 0, Number.POSITIVE_INFINITY)).ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('turns an unknown group 404 into a refusal', async () => {
    stubFetch(problem(404, { artifact: 'obs_index', detail: "no group 'zz'" }))

    expect(await fetchObsBrush('zz', 1, 0, 1)).toEqual({ ok: false, artifact: 'obs_index', reason: "no group 'zz'" })
  })
})

describe('fetchObsReals', () => {
  it('returns the names in the order the server sent them, with base_index and base_note', async () => {
    const body = { iteration: 0, names: ['r3', 'base', 'r1'], base_index: [1], base_note: null }
    const fetchMock = stubFetch({ json: body })

    const result = await fetchObsReals(0)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/obs/reals?iteration=0')
    expect(result).toEqual({ ok: true, payload: body })
    expect(result.ok && result.payload.names).toEqual(['r3', 'base', 'r1'])
  })

  it('turns a 404 naming obs_ens/0 into a refusal with that artifact', async () => {
    stubFetch(problem(404, { artifact: 'obs_ens/0', detail: 'no observation ensemble for iteration 0' }))

    expect(await fetchObsReals(0)).toEqual({ ok: false, artifact: 'obs_ens/0', reason: 'no observation ensemble for iteration 0' })
  })

  it('refuses an answer missing base_index, naming it', async () => {
    stubFetch({ json: { iteration: 0, names: [], base_note: null } })

    expect(await fetchObsReals(0)).toEqual({ ok: false, artifact: 'obs_ens/0', reason: 'the realization names answer is missing base_index' })
  })
})
