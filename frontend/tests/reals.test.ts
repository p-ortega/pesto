// The realization slider's names come from GET /reals -- these tests prove
// fetchRealNames reads the recorded order and, when the route reports no
// names were recorded, returns a distinct discriminated result rather than
// an empty list or a thrown error (CLAUDE.md's "never substitute position
// for identity").

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchRealNames } from '../src/data/reals'

vi.mock('../src/data/client', () => ({
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
