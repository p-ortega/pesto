import { beforeEach, describe, expect, it, vi } from 'vitest'

// No jsdom in this task's fixed stack -- readTokenOnce() only needs
// location.href and history.replaceState, so a plain object stub covers it.
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

function stubSessionStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  }
  vi.stubGlobal('sessionStorage', storage)
  return store
}

function stubThrowingSessionStorage() {
  const fail = () => {
    throw new Error('storage disabled')
  }
  vi.stubGlobal('sessionStorage', { getItem: fail, setItem: fail, removeItem: fail, clear: fail })
}

async function freshToken() {
  vi.resetModules()
  return import('../src/auth/token')
}

describe('readTokenOnce', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the value seeded in the search string', async () => {
    stubBrowserUrl('http://localhost/?token=abc123')
    const { readTokenOnce } = await freshToken()
    expect(readTokenOnce()).toBe('abc123')
  })

  it('strips token from the address bar', async () => {
    stubBrowserUrl('http://localhost/?token=abc123')
    const { readTokenOnce } = await freshToken()
    readTokenOnce()
    expect(location.search).not.toContain('token=')
  })

  it('exports a header name matching x-pesto-token case-insensitively', async () => {
    const { TOKEN_HEADER } = await freshToken()
    expect(TOKEN_HEADER.toLowerCase()).toBe('x-pesto-token')
  })

  it('returns the same value on a second call without re-reading the URL', async () => {
    stubBrowserUrl('http://localhost/?token=abc123')
    const { readTokenOnce } = await freshToken()
    const first = readTokenOnce()
    stubBrowserUrl('http://localhost/?token=different')
    const second = readTokenOnce()
    expect(second).toBe(first)
  })
})

describe('surviving a reload', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('recovers the token when the URL no longer carries it', async () => {
    stubSessionStorage()
    stubBrowserUrl('http://localhost/?token=abc123')
    const first = await freshToken()
    expect(first.readTokenOnce()).toBe('abc123')

    // A reload: fresh module state, and the address bar was already stripped.
    stubBrowserUrl('http://localhost/')
    const reloaded = await freshToken()
    expect(reloaded.readTokenOnce()).toBe('abc123')
  })

  it('reports no token when there is neither a URL token nor a stored one', async () => {
    stubSessionStorage()
    stubBrowserUrl('http://localhost/')
    const { readTokenOnce, hasToken } = await freshToken()
    expect(readTokenOnce()).toBe('')
    expect(hasToken()).toBe(false)
  })

  it('prefers a fresh URL token over a stale stored one', async () => {
    stubSessionStorage({ 'pesto.token': 'stale' })
    stubBrowserUrl('http://localhost/?token=fresh')
    const { readTokenOnce } = await freshToken()
    expect(readTokenOnce()).toBe('fresh')
  })

  it('never writes the token anywhere but sessionStorage', async () => {
    const store = stubSessionStorage()
    stubBrowserUrl('http://localhost/?token=abc123')
    const { readTokenOnce } = await freshToken()
    readTokenOnce()
    expect([...store.values()]).toContain('abc123')
    expect(location.href).not.toContain('abc123')
  })

  it('still boots when storage is disabled', async () => {
    stubThrowingSessionStorage()
    stubBrowserUrl('http://localhost/?token=abc123')
    const { readTokenOnce } = await freshToken()
    expect(readTokenOnce()).toBe('abc123')
  })
})
