import { tableFromIPC } from 'apache-arrow'
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

export interface BytesResult {
  buffer: ArrayBuffer
  meta: Record<string, unknown> | null
}

// apiGet's binary sibling. Shares handleResponse's failure handling, but
// branches to arrayBuffer() on success instead of readJson, and also
// returns the parsed X-Pesto-Meta header blob_response attaches -- present
// on every numeric route (mesh buffers, parmap, values, cells), absent on
// the Arrow-stream routes, which carry their shape in the stream itself.
export async function apiGetBytes(route: string): Promise<BytesResult> {
  const response = await fetch(route, { headers: authHeaders() })
  if (!response.ok) {
    const problem = (await readJson(response)) as ProblemDetails
    throw new ApiError(problem)
  }
  const buffer = await response.arrayBuffer()
  const raw = response.headers.get('X-Pesto-Meta')
  return { buffer, meta: raw ? (JSON.parse(raw) as Record<string, unknown>) : null }
}

function typedArrayForDtype(dtype: string, buffer: ArrayBuffer): Float32Array | Int32Array | Uint32Array {
  switch (dtype) {
    case '<f4':
      return new Float32Array(buffer)
    case '<i4':
      return new Int32Array(buffer)
    case '<u4':
      return new Uint32Array(buffer)
    default:
      throw new Error(`unexpected numeric dtype from the server: ${dtype}`)
  }
}

export interface MeshInfo {
  nVert: number
  nTri: number
  nCells: number
  nlay: number
  bounds: [number, number, number, number]
  crs: string | null
  tag: string | null
}

export async function gridMesh(): Promise<MeshInfo> {
  const raw = (await apiGet('/api/run/grid/mesh')) as {
    n_vert: number
    n_tri: number
    n_cells: number
    nlay: number
    bounds: [number, number, number, number]
    crs: string | null
    tag: string | null
  }
  return {
    nVert: raw.n_vert,
    nTri: raw.n_tri,
    nCells: raw.n_cells,
    nlay: raw.nlay,
    bounds: raw.bounds,
    crs: raw.crs,
    tag: raw.tag,
  }
}

export type MeshBufferName = 'positions' | 'cell_index' | 'indices'

export async function gridMeshBuffer(buffer: MeshBufferName): Promise<Float32Array | Int32Array | Uint32Array> {
  const { buffer: bytes, meta } = await apiGetBytes(`/api/run/grid/mesh/${buffer}`)
  const dtype = meta?.dtype as string | undefined
  if (!dtype) {
    throw new Error(`the ${buffer} buffer arrived with no dtype to read it as`)
  }
  return typedArrayForDtype(dtype, bytes)
}

// D-05: the map block's slice of the block-to-control permutation, raw
// little-endian i32 -- for block row i, parmap[i] is that row's position
// in the control-order /meta?kind=par table.
export async function gridParmap(iteration: number): Promise<Int32Array> {
  const { buffer } = await apiGetBytes(`/api/run/grid/parmap?iteration=${encodeURIComponent(String(iteration))}`)
  return new Int32Array(buffer)
}

export interface GridValuesQuery {
  iteration: number
  stat?: string
  realization?: string
}

// D-05 (inherited): layer is never sent here -- ValuesQuery forbids it,
// and layer selection is filtered client-side out of the whole field this
// returns.
export async function gridValues(query: GridValuesQuery): Promise<Float32Array> {
  const params = new URLSearchParams({ iteration: String(query.iteration) })
  if (query.stat !== undefined) params.set('stat', query.stat)
  if (query.realization !== undefined) params.set('realization', query.realization)
  const { buffer } = await apiGetBytes(`/api/run/grid/values?${params.toString()}`)
  return new Float32Array(buffer)
}

export async function gridCells(which: 'cell' | 'layer', iteration: number): Promise<Int32Array> {
  const { buffer } = await apiGetBytes(
    `/api/run/grid/cells/${which}?iteration=${encodeURIComponent(String(iteration))}`,
  )
  return new Int32Array(buffer)
}

// The raw Arrow stream bytes for /meta -- parsing (tableFromIPC, getChild
// by field name) is data/parmap.ts's job, the D-05 join's first use of
// apache-arrow.
export async function runMeta(kind: 'par' | 'obs'): Promise<ArrayBuffer> {
  const { buffer } = await apiGetBytes(`/api/run/meta?kind=${kind}`)
  return buffer
}

export async function runReals(iteration: number): Promise<string[]> {
  const { buffer } = await apiGetBytes(`/api/run/reals?iteration=${encodeURIComponent(String(iteration))}`)
  const table = tableFromIPC(new Uint8Array(buffer))
  const column = table.getChild('realization')
  if (!column) {
    throw new Error('the realization table is missing its realization column')
  }
  const out: string[] = new Array(table.numRows)
  for (let i = 0; i < table.numRows; i++) {
    out[i] = String(column.get(i))
  }
  return out
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
