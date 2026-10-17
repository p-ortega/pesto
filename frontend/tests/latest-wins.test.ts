// A late answer must never be drawn: LatestWins reports any answer whose key
// has moved on as stale, and an aborted request is stale rather than an error.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, gridValues } from '../src/data/client'
import { isAbortError, LatestWins } from '../src/data/latest-wins'
import { fetchKey, runUrl, setActiveRun } from '../src/data/run'

interface Pending {
  url: string
  init: RequestInit | undefined
  resolve: (response: Response) => void
  reject: (error: unknown) => void
}

function stubFetch(): Pending[] {
  const pending: Pending[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (input: string | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          pending.push({ url: String(input), init, resolve, reject })
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    ),
  )
  return pending
}

function floats(...values: number[]): Response {
  return new Response(new Float32Array(values).buffer, { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
  setActiveRun(null)
})

describe('LatestWins with a values fetch', () => {
  it('aborts the first request when a second starts, and only the second is fresh', async () => {
    const pending = stubFetch()
    const slot = new LatestWins<Float32Array>()

    const first = slot.run('a', (signal) => gridValues({ iteration: 1 }, { signal }))
    const second = slot.run('b', (signal) => gridValues({ iteration: 2 }, { signal }))

    expect(pending[0]!.init?.signal?.aborted).toBe(true)
    expect(pending[1]!.init?.signal?.aborted).toBe(false)
    pending[1]!.resolve(floats(2))

    expect(await first).toEqual({ stale: true })
    const fresh = await second
    expect(fresh.stale).toBe(false)
    if (!fresh.stale) expect(Array.from(fresh.value)).toEqual([2])
  })

  it('builds the values URL through runUrl, unchanged on the wire', async () => {
    const pending = stubFetch()
    const slot = new LatestWins<Float32Array>()
    const run = slot.run('k', (signal) => gridValues({ iteration: 3, realization: 'r 1' }, { signal }))
    expect(pending[0]!.url).toBe('/api/run/grid/values?iteration=3&realization=r%201')
    pending[0]!.resolve(floats(1))
    await run
  })
})

describe('LatestWins', () => {
  it('treats two calls with the same key as two requests: first stale, second fresh', async () => {
    const slot = new LatestWins<string>()
    let releaseFirst: (value: string) => void = () => {}
    const first = slot.run('k', () => new Promise<string>((resolve) => (releaseFirst = resolve)))
    const second = slot.run('k', async () => 'second')

    releaseFirst('first')
    expect(await first).toEqual({ stale: true })
    expect(await second).toEqual({ stale: false, value: 'second' })
  })

  it('answers a first call with no earlier request, and cancel() with nothing in flight does nothing', async () => {
    const slot = new LatestWins<number>()
    expect(() => slot.cancel()).not.toThrow()
    expect(slot.current()).toBeNull()
    expect(await slot.run('a', async () => 7)).toEqual({ stale: false, value: 7 })
    expect(slot.current()).toBe('a')
  })

  it('returns only the most recently started key as fresh when answers arrive out of order', async () => {
    const slot = new LatestWins<string>()
    const releases: ((value: string) => void)[] = []
    const first = slot.run('one', () => new Promise<string>((resolve) => releases.push(resolve)))
    const second = slot.run('two', () => new Promise<string>((resolve) => releases.push(resolve)))

    releases[1]!('late-two-first')
    releases[0]!('one')

    expect(await second).toEqual({ stale: false, value: 'late-two-first' })
    expect(await first).toEqual({ stale: true })
  })

  it('keeps the key check as the guard when the loader ignores the abort', async () => {
    const slot = new LatestWins<string>()
    const first = slot.run('one', async () => 'one')
    const second = slot.run('two', async () => 'two')
    expect(await first).toEqual({ stale: true })
    expect(await second).toEqual({ stale: false, value: 'two' })
  })

  it('reports an aborted request as stale and never throws it', async () => {
    const slot = new LatestWins<string>()
    const run = slot.run('a', (signal) => {
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    slot.cancel()
    expect(await run).toEqual({ stale: true })
  })

  it('throws a real error on the current key to the caller', async () => {
    const slot = new LatestWins<string>()
    const problem = { type: 'about:blank', title: 'nope', status: 500 }
    await expect(
      slot.run('a', async () => {
        throw new ApiError(problem)
      }),
    ).rejects.toBeInstanceOf(ApiError)
  })

  it('drops a real error from a request that is no longer current', async () => {
    const slot = new LatestWins<string>()
    let failFirst: (error: unknown) => void = () => {}
    const first = slot.run('a', () => new Promise<string>((_resolve, reject) => (failFirst = reject)))
    const second = slot.run('b', async () => 'b')
    failFirst(new Error('boom'))
    expect(await first).toEqual({ stale: true })
    expect(await second).toEqual({ stale: false, value: 'b' })
  })
})

describe('isAbortError', () => {
  it('recognises an AbortError that is not a DOMException', () => {
    const plain = Object.assign(new Error('x'), { name: 'AbortError' })
    expect(isAbortError(plain)).toBe(true)
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true)
    expect(isAbortError(new Error('x'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })
})

describe('runUrl and fetchKey', () => {
  it('encodes the query and leaves undefined values out', () => {
    expect(runUrl(null, '/api/run/grid/values', { iteration: 3, realization: 'r 1' })).toBe(
      '/api/run/grid/values?iteration=3&realization=r%201',
    )
    expect(runUrl(null, '/api/run/grid/values', { iteration: 3, stat: undefined })).toBe(
      '/api/run/grid/values?iteration=3',
    )
  })

  it('sends no run id on the wire in M1', () => {
    expect(runUrl('abc', '/api/run/grid/mesh')).toBe('/api/run/grid/mesh')
  })

  it('refuses a route that is not run-scoped', () => {
    expect(() => runUrl(null, '/api/fs/roots')).toThrow()
    expect(() => runUrl(null, '/api/runner')).toThrow()
  })

  it('joins the run and parts with a bar, writing null and undefined as a dash', () => {
    expect(fetchKey('abc', 'values', 3)).toBe('abc|values|3')
    expect(fetchKey(null, undefined, 'x')).toBe('-|-|x')
  })
})
