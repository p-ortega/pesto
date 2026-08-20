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
