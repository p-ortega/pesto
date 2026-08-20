import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// No jsdom in this task's fixed stack -- boot() only touches
// location/history (via readTokenOnce), fetch, and one element by id, so
// plain stubs cover all three.
function stubBrowserUrl(href: string): void {
  let current = new URL(href)
  vi.stubGlobal('location', current)
  vi.stubGlobal('history', {
    replaceState: (_state: unknown, _title: string, url: string) => {
      current = new URL(url, current)
      vi.stubGlobal('location', current)
    },
  })
}

function stubAppElement(): { textContent: string } {
  const el = { textContent: '' }
  vi.stubGlobal('document', {
    getElementById: (id: string) => (id === 'app' ? el : null),
  })
  return el
}

function stubFetchJson(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })),
  )
}

async function bootMain(): Promise<void> {
  vi.resetModules()
  await import('../src/main')
  // boot() fires as a module side effect and is not awaited by main.ts
  // itself; give its promise chain a turn to settle before asserting.
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalled()
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('boot', () => {
  beforeEach(() => {
    stubBrowserUrl('http://localhost/?token=abc123')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the run facts on a successful read', async () => {
    const app = stubAppElement()
    stubFetchJson(200, {
      case: 'forecast_run',
      n_par: 42,
      n_real: 100,
      noise: { has_noise: true, decided_by: 'noise_ensemble', evidence: [], notes: [] },
    })

    await bootMain()

    expect(app.textContent).toBe('forecast_run -- n_par 42, n_real 100, noise: yes')
  })

  it('says there is no run open on a 409', async () => {
    const app = stubAppElement()
    stubFetchJson(409, { type: 'about:blank', title: 'no run is open', status: 409 })

    await bootMain()

    expect(app.textContent).toBe('no run is open')
  })

  it('renders the problem document instead of leaving a blank page on any other failure', async () => {
    const app = stubAppElement()
    stubFetchJson(502, {
      type: 'about:blank',
      title: 'read failure',
      status: 502,
      artifact: 'config',
      detail: 'run configuration could not be read',
    })

    await bootMain()

    expect(app.textContent).toContain('read failure')
    expect(app.textContent).toContain('artifact: config')
    expect(app.textContent).toContain('run configuration could not be read')
  })
})
