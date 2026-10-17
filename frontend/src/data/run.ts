// The open run's id and the one place a run-scoped URL is built.

let activeRun: string | null = null

export function setActiveRun(runId: string | null): void {
  activeRun = runId
}

export function activeRunId(): string | null {
  return activeRun
}

// M1 sends no run id on the wire; M3 changes only this function.
export function runUrl(
  runId: string | null,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  void runId
  if (path !== '/api/run' && !path.startsWith('/api/run/')) {
    throw new Error(`runUrl builds run-scoped routes only, got ${path}`)
  }
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(name, String(value))
  }
  // URLSearchParams writes a space as a plus; the %20 form is the one the contract names.
  const text = params.toString().replace(/\+/g, '%20')
  return text === '' ? path : `${path}?${text}`
}

// A cache key for one request: the run plus whatever picks the answer.
export function fetchKey(runId: string | null, ...parts: (string | number | null | undefined)[]): string {
  return [runId, ...parts].map((part) => (part === null || part === undefined ? '-' : String(part))).join('|')
}
