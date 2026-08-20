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

// Plan 05-07's five ingest routes (src/pesto/api/ingest.py). The events
// route is read with sse.ts's readEvents, not apiGet -- a progress stream
// is not one JSON body -- so this module only exposes its URL.
export const INGEST_EVENTS_URL = '/api/run/ingest/events'

export interface ArtifactRow {
  name: string
  kind: string
  state: string
  reason: string | null
  stale: boolean
  seconds: number | null
  bytes: number
}

export interface Capability {
  available: boolean
  blockedBy: { artifact: string; reason: string }[]
}

export interface IngestState {
  fresh: boolean
  artifacts: ArtifactRow[]
  capabilities: { map: Capability; stats: Capability; chips: Capability }
  ingestSeconds: number | null
  cacheBytes: number | null
}

export interface IngestEstimate {
  total: number
  perArtifact: { name: string; bytes: number }[]
  notes: string[]
  freeBytes: number
  cacheRootExists: boolean
}

function toCapability(raw: unknown): Capability {
  const capability = raw as { available: boolean; blocked_by: { artifact: string; reason: string }[] }
  return { available: capability.available, blockedBy: capability.blocked_by }
}

export async function ingestState(): Promise<IngestState> {
  const raw = (await apiGet('/api/run/ingest/state')) as {
    fresh: boolean
    artifacts: ArtifactRow[]
    capabilities: { map: unknown; stats: unknown; chips: unknown }
    ingest_seconds: number | null
    cache_bytes: number | null
  }
  return {
    fresh: raw.fresh,
    artifacts: raw.artifacts,
    capabilities: {
      map: toCapability(raw.capabilities.map),
      stats: toCapability(raw.capabilities.stats),
      chips: toCapability(raw.capabilities.chips),
    },
    ingestSeconds: raw.ingest_seconds,
    cacheBytes: raw.cache_bytes,
  }
}

export async function ingestEstimate(): Promise<IngestEstimate> {
  const raw = (await apiGet('/api/run/ingest/estimate')) as {
    total: number
    per_artifact: { name: string; bytes: number }[]
    notes: string[]
    free_bytes: number
    cache_root_exists: boolean
  }
  return {
    total: raw.total,
    perArtifact: raw.per_artifact,
    notes: raw.notes,
    freeBytes: raw.free_bytes,
    cacheRootExists: raw.cache_root_exists,
  }
}

export async function ingestStart(): Promise<void> {
  await apiPost('/api/run/ingest', {})
}

export async function ingestCancel(): Promise<void> {
  await apiPost('/api/run/ingest/cancel', {})
}
