// @vitest-environment jsdom
//
// Real jsdom (approved after a package-legitimacy gate, 82a7a98). These
// tests assert routing -- which screens mount for which answers, in which
// order, and which do not mount at all -- not the pixel rendering each
// screen's own test file already covers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CONFIG_BODY = {
  case: 'forecast_run',
  n_par: 42,
  n_real: 100,
  noise: { has_noise: true, decided_by: 'noise_ensemble', evidence: [], notes: [] },
}

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    fresh: true,
    artifacts: [],
    capabilities: {
      map: { available: true, blocked_by: [] },
      stats: { available: true, blocked_by: [] },
      chips: { available: true, blocked_by: [] },
    },
    ingest_seconds: 12.4,
    cache_bytes: 1048576,
    ...overrides,
  }
}

const ESTIMATE_BODY = {
  total: 10 * 1024 * 1024,
  per_artifact: [{ name: 'grid', bytes: 5 * 1024 * 1024 }],
  notes: [],
  free_bytes: 100 * 1024 * 1024,
  cache_root_exists: true,
}

const NO_RUN_OPEN = { type: 'about:blank', title: 'no run is open', status: 409 }

type FetchHandler = (init?: RequestInit) => { status: number; body?: unknown; stream?: Uint8Array[] }

interface FetchStub {
  calls: string[]
  handlers: Record<string, FetchHandler>
  signals: Record<string, AbortSignal | undefined>
}

function stubFetch(handlers: Record<string, FetchHandler>): FetchStub {
  const stub: FetchStub = { calls: [], handlers, signals: {} }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = url.split('?')[0]
      const key = `${method} ${path}`
      stub.calls.push(key)
      stub.signals[key] = init?.signal ?? undefined

      const handler = stub.handlers[key]
      if (!handler) {
        throw new Error(`unhandled fetch in test: ${key}`)
      }
      const result = handler(init)

      if (result.stream) {
        let index = 0
        const chunks = result.stream
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          json: async () => result.body ?? {},
          body: {
            getReader: () => ({
              read: async () => {
                if (index < chunks.length) {
                  const value = chunks[index]
                  index += 1
                  return { done: false, value }
                }
                return { done: true, value: undefined }
              },
              releaseLock: () => undefined,
            }),
          },
        }
      }

      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => result.body,
      }
    }),
  )

  return stub
}

function screenText(): string {
  return document.getElementById('app')?.textContent ?? ''
}

function screenHasText(text: string): boolean {
  return screenText().includes(text)
}

function findButtonByText(text: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll('button'))
  const match = buttons.find((button) => button.textContent?.includes(text))
  if (!match) {
    throw new Error(`no button found with text containing "${text}"`)
  }
  return match as HTMLButtonElement
}

async function bootMain(): Promise<void> {
  vi.resetModules()
  document.body.innerHTML = '<div id="app"></div>'
  await import('../src/main')
}

const encoder = new TextEncoder()

describe('the screen router', () => {
  beforeEach(() => {
    try {
      localStorage.clear()
    } catch {
      // Node's own experimental localStorage (distinct from jsdom's) is
      // not enabled in this run; theme.ts already falls back to "system"
      // when storage throws, so nothing here depends on it being present.
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mounts the picker when no run is open, and never requests ingest state', async () => {
    const stub = stubFetch({
      'GET /api/run/config': () => ({ status: 409, body: NO_RUN_OPEN }),
      'GET /api/fs/roots': () => ({ status: 200, body: [] }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('Choose a run directory')).toBe(true)
    })
    expect(stub.calls).toContain('GET /api/run/config')
    expect(stub.calls.some((call) => call.includes('ingest'))).toBe(false)
  })

  it('routes straight to the placeholder on a warm boot, skipping the estimate and start routes', async () => {
    const stub = stubFetch({
      'GET /api/run/config': () => ({ status: 200, body: CONFIG_BODY }),
      'GET /api/run/ingest/state': () => ({ status: 200, body: baseState() }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('The map is not built yet')).toBe(true)
    })
    expect(screenHasText('forecast_run')).toBe(true)
    expect(screenHasText('5.1')).toBe(true)
    expect(stub.calls).not.toContain('GET /api/run/ingest/estimate')
    expect(stub.calls).not.toContain('POST /api/run/ingest')
  })

  it("the placeholder's notice reads as informational, never critical", async () => {
    stubFetch({
      'GET /api/run/config': () => ({ status: 200, body: CONFIG_BODY }),
      'GET /api/run/ingest/state': () => ({ status: 200, body: baseState() }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('The map is not built yet')).toBe(true)
    })
    expect(screenHasText('Critical')).toBe(false)
  })

  it('shows the estimate gate on a cold boot, and does not start ingest until agree is activated', async () => {
    const stub = stubFetch({
      'GET /api/run/config': () => ({ status: 200, body: CONFIG_BODY }),
      'GET /api/run/ingest/state': () => ({ status: 200, body: baseState({ fresh: false }) }),
      'GET /api/run/ingest/estimate': () => ({ status: 200, body: ESTIMATE_BODY }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('Agree and ingest')).toBe(true)
    })
    expect(stub.calls).not.toContain('POST /api/run/ingest')
  })

  it('returns to the picker when the estimate is declined', async () => {
    stubFetch({
      'GET /api/run/config': () => ({ status: 200, body: CONFIG_BODY }),
      'GET /api/run/ingest/state': () => ({ status: 200, body: baseState({ fresh: false }) }),
      'GET /api/run/ingest/estimate': () => ({ status: 200, body: ESTIMATE_BODY }),
      'GET /api/fs/roots': () => ({ status: 200, body: [] }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('Agree and ingest')).toBe(true)
    })
    findButtonByText('Go back').click()

    await vi.waitFor(() => {
      expect(screenHasText('Choose a run directory')).toBe(true)
    })
  })

  it('re-fetches config and state before mounting the placeholder when ingest finishes, and aborts the stream read', async () => {
    let configCalls = 0
    let stateCalls = 0
    const stub = stubFetch({
      'GET /api/run/config': () => {
        configCalls += 1
        return { status: 200, body: CONFIG_BODY }
      },
      'GET /api/run/ingest/state': () => {
        stateCalls += 1
        return { status: 200, body: baseState({ fresh: false }) }
      },
      'GET /api/run/ingest/estimate': () => ({ status: 200, body: ESTIMATE_BODY }),
      'POST /api/run/ingest': () => ({ status: 202, body: { started: true } }),
      'GET /api/run/ingest/events': () => ({
        status: 200,
        stream: [encoder.encode('event: done\ndata: {}\n\n')],
      }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('Agree and ingest')).toBe(true)
    })
    findButtonByText('Agree and ingest').click()

    await vi.waitFor(() => {
      expect(configCalls).toBeGreaterThanOrEqual(2)
      expect(stateCalls).toBeGreaterThanOrEqual(2)
    })
    await vi.waitFor(() => {
      expect(screenHasText('The map is not built yet')).toBe(true)
    })

    const eventsSignal = stub.signals['GET /api/run/ingest/events']
    expect(eventsSignal?.aborted).toBe(true)
  })

  it('re-checks freshness after opening a directory, skipping the estimate screen when it is already fresh', async () => {
    const stub = stubFetch({
      'GET /api/run/config': () => ({ status: 409, body: NO_RUN_OPEN }),
      'GET /api/fs/roots': () => ({
        status: 200,
        body: [{ id: 'r1', name: 'Home', is_run: true, reason: null }],
      }),
      'POST /api/fs/open': () => ({ status: 200, body: { is_run: true, case: 'forecast_run' } }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('Choose a run directory')).toBe(true)
    })

    // Once the run is opened, its cache turns out to be fully fresh.
    stub.handlers['GET /api/run/config'] = () => ({ status: 200, body: CONFIG_BODY })
    stub.handlers['GET /api/run/ingest/state'] = () => ({ status: 200, body: baseState() })

    await vi.waitFor(() => {
      findButtonByText('Open')
    })
    findButtonByText('Open').click()

    await vi.waitFor(() => {
      expect(screenHasText('The map is not built yet')).toBe(true)
    })
    expect(stub.calls).not.toContain('GET /api/run/ingest/estimate')
  })

  it("shows a notice naming a blocked capability's artifact and reason on the placeholder", async () => {
    const partiallyBlocked = baseState({
      capabilities: {
        map: { available: true, blocked_by: [] },
        stats: {
          available: false,
          blocked_by: [
            { artifact: 'par_agg/head', reason: 'the aggregation step crashed reading iteration 3' },
          ],
        },
        chips: { available: true, blocked_by: [] },
      },
    })
    stubFetch({
      'GET /api/run/config': () => ({ status: 200, body: CONFIG_BODY }),
      'GET /api/run/ingest/state': () => ({ status: 200, body: partiallyBlocked }),
    })

    await bootMain()

    await vi.waitFor(() => {
      expect(screenHasText('par_agg/head')).toBe(true)
      expect(screenHasText('the aggregation step crashed reading iteration 3')).toBe(true)
    })
  })
})
