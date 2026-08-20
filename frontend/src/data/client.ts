import { authHeaders } from '../auth/token'

export interface ProblemDetails {
  type: string
  title: string
  status: number
  artifact?: string
  detail?: string
}

export class ApiError extends Error {
  problem: ProblemDetails

  constructor(problem: ProblemDetails) {
    super(problem.title)
    this.problem = problem
  }
}

// The picker's wire shape (Plan 05-03): a display name and an opaque id,
// never a real filesystem location. This type has no field carrying that
// location, and never will -- that omission is what makes rendering one a
// type error rather than a discipline (T-5-05).
export interface DirEntry {
  id: string
  name: string
  isRun: boolean
  reason: string | null
}

export interface OpenResult {
  isRun: boolean
  case: string | null
}

// A response that is not valid JSON should not happen, but reading it
// straight would surface a raw parser error to a screen. One place turns
// that into a message naming what failed instead.
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new Error(`the server's answer could not be read (status ${response.status})`)
  }
}

async function handleResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    const problem = (await readJson(response)) as ProblemDetails
    throw new ApiError(problem)
  }
  return readJson(response)
}

export async function apiGet(route: string): Promise<unknown> {
  const response = await fetch(route, { headers: authHeaders() })
  return handleResponse(response)
}

export async function apiPost(route: string, body: unknown): Promise<unknown> {
  const response = await fetch(route, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return handleResponse(response)
}

function toDirEntry(raw: unknown): DirEntry {
  const entry = raw as { id: string; name: string; is_run: boolean; reason: string | null }
  return { id: entry.id, name: entry.name, isRun: entry.is_run, reason: entry.reason }
}

export async function fsRoots(): Promise<DirEntry[]> {
  const roots = (await apiGet('/api/fs/roots')) as unknown[]
  return roots.map(toDirEntry)
}

export async function fsList(id: string): Promise<DirEntry[]> {
  const entries = (await apiGet(`/api/fs/list?id=${encodeURIComponent(id)}`)) as unknown[]
  return entries.map(toDirEntry)
}

export async function fsOpen(id: string): Promise<OpenResult> {
  const result = (await apiPost('/api/fs/open', { id })) as { is_run: boolean; case: string | null }
  return { isRun: result.is_run, case: result.case }
}
