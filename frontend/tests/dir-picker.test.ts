import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, fsList, fsOpen, fsRoots } from '../src/data/client'

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

describe('the typed picker wrappers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fsList maps the wire snake_case shape to camelCase', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, [
          { id: 'a', name: 'alpha', is_run: true, reason: null },
          { id: 'b', name: 'beta', is_run: false, reason: 'no control file found' },
        ]),
      ),
    )

    const entries = await fsList('x')

    expect(entries).toEqual([
      { id: 'a', name: 'alpha', isRun: true, reason: null },
      { id: 'b', name: 'beta', isRun: false, reason: 'no control file found' },
    ])
  })

  it('fsOpen rejects a 404 problem body with status and title carried through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(404, { type: 'about:blank', title: 'that folder is no longer available', status: 404 }),
      ),
    )

    await expect(fsOpen('stale')).rejects.toMatchObject({
      problem: { status: 404, title: 'that folder is no longer available' },
    })
    await expect(fsOpen('stale')).rejects.toBeInstanceOf(ApiError)
  })

  it('fsRoots rejects with a readable message when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0')
        },
      })),
    )

    let caught: unknown
    try {
      await fsRoots()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toMatch(/could not be read/)
    expect(message).not.toMatch(/Unexpected token|JSON at position/)
  })

  it('every request carries the session header', async () => {
    const fetchStub = vi.fn(async (_route: string, _init?: RequestInit) => jsonResponse(200, []))
    vi.stubGlobal('fetch', fetchStub)

    await fsRoots()
    await fsList('x')
    await fsOpen('x').catch(() => undefined)

    for (const call of fetchStub.mock.calls) {
      const init = call[1] as { headers?: Record<string, string> } | undefined
      expect(init?.headers?.['X-Pesto-Token']).toBeDefined()
    }
  })
})
