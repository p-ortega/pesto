// D-08: the session token rides the URL once, then a request header.
// Must match TOKEN_HEADER in src/pesto/api/security.py case-insensitively.
export const TOKEN_HEADER = 'X-Pesto-Token'

let storedToken: string | null = null

export function readTokenOnce(): string {
  if (storedToken !== null) {
    return storedToken
  }

  const url = new URL(location.href)
  const token = url.searchParams.get('token') ?? ''
  storedToken = token

  url.searchParams.delete('token')
  history.replaceState(null, '', url.toString())

  return storedToken
}

export function authHeaders(): Record<string, string> {
  return { [TOKEN_HEADER]: storedToken ?? '' }
}
