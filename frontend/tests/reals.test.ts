// The realization slider's names come from GET /reals -- these tests prove
// fetchRealNames reads the recorded order and, when the route reports no
// names were recorded, returns a distinct discriminated result rather than
// an empty list or a thrown error (CLAUDE.md's "never substitute position
// for identity").

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchBase, fetchRealNames } from '../src/data/reals'

vi.mock('../src/data/client', () => ({
  apiGet: vi.fn(),
  apiGetBytes: vi.fn(),
  ApiError: class ApiError extends Error {
    problem: { type: string; title: string; status: number; artifact?: string }
    constructor(problem: { type: string; title: string; status: number; artifact?: string }) {
      super(problem.title)
      this.problem = problem
    }
  },
}))

describe('fetchRealNames', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('reads names from the realization column, in the order the route served them', async () => {
    const table = tableFromArrays({ realization: ['r003', 'r001', 'r009'] })
    const bytes = tableToIPC(table, 'stream')

    const client = await import('../src/data/client')
    vi.mocked(client.apiGetBytes).mockResolvedValue({ buffer: bytes.buffer as ArrayBuffer, meta: null })

    const result = await fetchRealNames(0)

    expect(result).toEqual({ ok: true, names: ['r003', 'r001', 'r009'] })
  })

  it('reports no names recorded, carrying the reason, rather than an empty list or a throw', async () => {
    const client = await import('../src/data/client')
    vi.mocked(client.apiGetBytes).mockRejectedValue(
      new client.ApiError({
        type: 'about:blank',
        title: 'no realization names were recorded for that iteration',
        status: 404,
        artifact: 'par_reals/3',
      }),
    )

    const result = await fetchRealNames(3)

    expect(result).toEqual({
      ok: false,
      iteration: 3,
      reason: 'no realization names were recorded for that iteration',
    })
  })

  it('rethrows a non-404 failure rather than treating it as no names recorded', async () => {
    const client = await import('../src/data/client')
    vi.mocked(client.apiGetBytes).mockRejectedValue(new Error('network down'))

    await expect(fetchRealNames(0)).rejects.toThrow('network down')
  })
})

describe('fetchBase', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('asks for the iteration and returns the base name as the server spelled it', async () => {
    const client = await import('../src/data/client')
    vi.mocked(client.apiGet).mockResolvedValue({ iteration: 2, name: 'base', note: null, reason: null })

    const result = await fetchBase(2)

    expect(vi.mocked(client.apiGet).mock.calls[0][0]).toBe('/api/run/reals/base?iteration=2')
    expect(result).toEqual({ ok: true, answer: { iteration: 2, name: 'base', note: null, reason: null } })
  })

  it('keeps a missing base as an answer with its reason', async () => {
    const client = await import('../src/data/client')
    vi.mocked(client.apiGet).mockResolvedValue({ iteration: 0, name: null, note: null, reason: 'no realization named base in iteration 0' })

    expect(await fetchBase(0)).toEqual({
      ok: true,
      answer: { iteration: 0, name: null, note: null, reason: 'no realization named base in iteration 0' },
    })
  })

  it('turns a 404 into a result carrying the reason, as fetchRealNames does', async () => {
    const client = await import('../src/data/client')
    vi.mocked(client.apiGet).mockRejectedValue(
      new client.ApiError({ type: 'about:blank', title: 'no realization names were recorded for that iteration', status: 404, artifact: 'par_reals/2' }),
    )

    expect(await fetchBase(2)).toEqual({ ok: false, iteration: 2, reason: 'no realization names were recorded for that iteration' })
  })

  it('refuses an answer missing reason, naming the field', async () => {
    const client = await import('../src/data/client')
    vi.mocked(client.apiGet).mockResolvedValue({ iteration: 2, name: 'base', note: null })

    expect(await fetchBase(2)).toEqual({ ok: false, iteration: 2, reason: 'the /reals/base answer is missing reason' })
  })

  it('refuses an answer for another iteration or with neither a name nor a reason', async () => {
    const client = await import('../src/data/client')
    vi.mocked(client.apiGet).mockResolvedValue({ iteration: 1, name: 'base', note: null, reason: null })
    const other = await fetchBase(2)
    expect(!other.ok && other.reason).toBe('the /reals/base answer is for iteration 1, not 2')

    vi.mocked(client.apiGet).mockResolvedValue({ iteration: 2, name: null, note: null, reason: null })
    const empty = await fetchBase(2)
    expect(!empty.ok && empty.reason).toBe('the /reals/base answer has no base name and no reason')
  })

  it('rethrows any other failure', async () => {
    const client = await import('../src/data/client')
    vi.mocked(client.apiGet).mockRejectedValue(new client.ApiError({ type: 'about:blank', title: 'par_reals/2 has an unexpected shape', status: 502 }))
    await expect(fetchBase(2)).rejects.toThrow('unexpected shape')

    vi.mocked(client.apiGet).mockRejectedValue(new Error('network down'))
    await expect(fetchBase(2)).rejects.toThrow('network down')
  })
})
