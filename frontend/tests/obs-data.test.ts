// The observation fetchers: answers are read by name, a missing name is a refusal that says which,
// a missing artifact is a result with its reason, and anything else still throws.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchObsSites } from '../src/data/obs'

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

describe('fetchObsSites', () => {
  it('reads two rows by column name and builds the URL with group as a query value', async () => {
    const fetchMock = stubFetch({ bytes: ipc(siteColumns()), headers: { 'X-Pesto-Notes': JSON.stringify(['one note']) } })

    const result = await fetchObsSites('heads')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/run/obs/sites?group=heads')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.notes).toEqual(['one note'])
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
    stubFetch({ bytes: ipc(reversed) })

    const result = await fetchObsSites('heads')

    expect(result.ok && result.rows[0].site).toBe('well_a')
    expect(result.ok && result.notes).toEqual([])
  })

  it('refuses a table missing xy_source, naming it', async () => {
    const columns = siteColumns()
    delete columns.xy_source
    stubFetch({ bytes: ipc(columns) })

    const result = await fetchObsSites('heads')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('the site table is missing xy_source')
  })

  it('refuses an xy_source it does not know instead of passing it on', async () => {
    const columns = siteColumns()
    columns.xy_source = ['own', 'guess']
    stubFetch({ bytes: ipc(columns) })

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
    const fetchMock = stubFetch({ bytes: ipc(siteColumns()) })

    await fetchObsSites('a b&c/d')

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toBe('/api/run/obs/sites?group=a%20b%26c%2Fd')
    expect(url.split('?')[0]).toBe('/api/run/obs/sites')
  })
})
