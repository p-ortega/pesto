// D-08: the session token rides the URL once, then a request header.
// Must match TOKEN_HEADER in src/pesto/api/security.py case-insensitively.
export const TOKEN_HEADER = 'X-Pesto-Token'

// sessionStorage, not memory alone: stripping the token from the address bar
// means a reload would otherwise lose it with no way back, locking the user
// out of their own session. Still never a cookie and never back in the URL,
// and sessionStorage dies with the tab rather than outliving the server.
const STORAGE_KEY = 'pesto.token'

let storedToken: string | null = null

function readStored(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeStored(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token)
  } catch {
    // A browser with storage disabled keeps the token for this page load
    // only; boot must not fail over it.
  }
}

export function readTokenOnce(): string {
  if (storedToken !== null) {
    return storedToken
  }

  const url = new URL(location.href)
  const fromUrl = url.searchParams.get('token') ?? ''

  // A fresh URL token wins: after a relaunch the server has a new token and
  // whatever this tab stored is stale.
  storedToken = fromUrl || readStored()

  if (fromUrl) {
    writeStored(fromUrl)
    url.searchParams.delete('token')
    history.replaceState(null, '', url.toString())
  }

  return storedToken
}

export function hasToken(): boolean {
  return readTokenOnce() !== ''
}

// Called when the server rejects the token, so a stale one from an earlier
// run of pesto is not offered again on the next reload.
export function forgetToken(): void {
  storedToken = ''
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to clear if storage was never available.
  }
}

export function authHeaders(): Record<string, string> {
  return { [TOKEN_HEADER]: storedToken ?? '' }
}
