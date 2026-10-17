import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/data/client'
import { createParameterFieldSource, type FieldRequest } from '../src/views/parameter-field-source'

interface Pending {
  url: string
  signal: AbortSignal | undefined
  resolve: (values: number[]) => void
  reject: (error: unknown) => void
}

// A fetch whose answers the test releases by hand; an aborted request rejects like a real one.
function stubDeferredFetch(): Pending[] {
  const pending: Pending[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL, init?: { signal?: AbortSignal }) => {
      return new Promise((resolve, reject) => {
        const entry: Pending = {
          url: typeof input === 'string' ? input : input.toString(),
          signal: init?.signal,
          resolve: (values) => {
            const bytes = new Float32Array(values)
            resolve({
              ok: true,
              status: 200,
              arrayBuffer: async () => bytes.buffer,
              headers: { get: () => null },
            })
          },
          reject,
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        pending.push(entry)
      })
    }),
  )
  return pending
}

function request(over: Partial<FieldRequest> = {}): FieldRequest {
  return { iteration: 0, group: 'G1', kind: 'block', stat: 'value', realization: 'r001', ...over }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ParameterFieldSource.fetchField', () => {
  it('drops the first answer when a second request starts, and aborts the first', async () => {
    const pending = stubDeferredFetch()
    const source = createParameterFieldSource({ runId: 'run-a' })
    const first = source.fetchField(request({ realization: 'r001' }))
    const second = source.fetchField(request({ realization: 'r002' }))
    expect(pending).toHaveLength(2)
    expect(pending[0].signal?.aborted).toBe(true)
    pending[1].resolve([1, 2])
    pending[0].resolve([9, 9])
    expect(await first).toEqual({ stale: true })
    const landed = await second
    expect(landed.stale).toBe(false)
    if (!landed.stale) {
      expect(Array.from(landed.field)).toEqual([1, 2])
      expect(landed.request.realization).toBe('r002')
    }
  })

  it('treats an answer that lands after a newer request started as stale even if the loader ignored the abort', async () => {
    const pending = stubDeferredFetch()
    const source = createParameterFieldSource({ runId: 'run-a' })
    const first = source.fetchField(request({ stat: 'mean', realization: null }))
    const second = source.fetchField(request({ stat: 'std', realization: null }))
    pending[1].resolve([5])
    expect((await second).stale).toBe(false)
    expect(await first).toEqual({ stale: true })
  })

  it('asks /grid/values for a block field with iteration plus realization', async () => {
    const pending = stubDeferredFetch()
    const source = createParameterFieldSource({ runId: 'run-a' })
    const result = source.fetchField(request({ iteration: 3, realization: 'r 7' }))
    expect(pending[0].url).toBe('/api/run/grid/values?iteration=3&realization=r%207')
    pending[0].resolve([1])
    await result
  })

  it('asks /grid/values for a block field with iteration plus stat', async () => {
    const pending = stubDeferredFetch()
    const source = createParameterFieldSource({ runId: 'run-a' })
    const result = source.fetchField(request({ stat: 'q95', realization: null }))
    expect(pending[0].url).toBe('/api/run/grid/values?iteration=0&stat=q95')
    pending[0].resolve([1])
    await result
  })

  it('asks /grid/field for a cell field with the group added', async () => {
    const pending = stubDeferredFetch()
    const source = createParameterFieldSource({ runId: 'run-a' })
    const result = source.fetchField(request({ kind: 'cell', group: 'pp_k', realization: 'base' }))
    expect(pending[0].url).toBe('/api/run/grid/field?iteration=0&group=pp_k&realization=base')
    pending[0].resolve([1])
    await result
  })

  it('rejects when the current request fails with an ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ title: 'boom', status: 500 }),
        headers: { get: () => null },
      })),
    )
    const source = createParameterFieldSource({ runId: 'run-a' })
    await expect(source.fetchField(request())).rejects.toBeInstanceOf(ApiError)
  })

  it('never rejects for an abort', async () => {
    const pending = stubDeferredFetch()
    const source = createParameterFieldSource({ runId: 'run-a' })
    const first = source.fetchField(request({ realization: 'r001' }))
    void source.fetchField(request({ realization: 'r002' }))
    pending[0].reject(new DOMException('aborted', 'AbortError'))
    await expect(first).resolves.toEqual({ stale: true })
  })
})
