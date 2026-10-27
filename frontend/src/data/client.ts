import { tableFromIPC } from 'apache-arrow'
import { authHeaders } from '../auth/token'
import { activeRunId, runUrl } from './run'

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

export interface FetchOptions {
  signal?: AbortSignal
}

export async function apiGet(route: string, opts?: FetchOptions): Promise<unknown> {
  const response = await fetch(route, { headers: authHeaders(), signal: opts?.signal })
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

export async function apiPut(route: string, body: unknown): Promise<unknown> {
  const response = await fetch(route, {
    method: 'PUT',
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
export async function apiGetBytes(route: string, opts?: FetchOptions): Promise<BytesResult> {
  const response = await fetch(route, { headers: authHeaders(), signal: opts?.signal })
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
  /** Subtracted from the vertex positions before they were sent; [0, 0] when the body had none. */
  origin: [number, number]
  crs: string | null
  tag: string | null
  hasIdomain: boolean
  notes: string[]
}

function readOrigin(raw: unknown): [number, number] {
  if (raw === undefined || raw === null) return [0, 0]
  if (Array.isArray(raw) && raw.length === 2 && raw.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return [raw[0], raw[1]]
  }
  throw new Error(`the mesh answered an origin that is not a pair of numbers: ${JSON.stringify(raw)}`)
}

export async function gridMesh(opts?: FetchOptions): Promise<MeshInfo> {
  const raw = (await apiGet(runUrl(activeRunId(), '/api/run/grid/mesh'), opts)) as {
    n_vert: number
    n_tri: number
    n_cells: number
    nlay: number
    bounds: [number, number, number, number]
    origin?: [number, number]
    crs: string | null
    tag: string | null
    has_idomain?: boolean
    notes?: string[]
  }
  return {
    nVert: raw.n_vert,
    nTri: raw.n_tri,
    nCells: raw.n_cells,
    nlay: raw.nlay,
    bounds: raw.bounds,
    origin: readOrigin(raw.origin),
    crs: raw.crs,
    tag: raw.tag,
    hasIdomain: raw.has_idomain ?? false,
    notes: raw.notes ?? [],
  }
}

export async function gridIdomain(opts?: FetchOptions): Promise<Int32Array> {
  const { buffer } = await apiGetBytes(runUrl(activeRunId(), '/api/run/grid/mesh/idomain'), opts)
  return new Int32Array(buffer)
}

export type MeshBufferName = 'positions' | 'cell_index' | 'indices'

export async function gridMeshBuffer(
  buffer: MeshBufferName,
  opts?: FetchOptions,
): Promise<Float32Array | Int32Array | Uint32Array> {
  const { buffer: bytes, meta } = await apiGetBytes(runUrl(activeRunId(), `/api/run/grid/mesh/${buffer}`), opts)
  const dtype = meta?.dtype as string | undefined
  if (!dtype) {
    throw new Error(`the ${buffer} buffer arrived with no dtype to read it as`)
  }
  return typedArrayForDtype(dtype, bytes)
}

// D-05: the map block's slice of the block-to-control permutation, raw
// little-endian i32 -- for block row i, parmap[i] is that row's position
// in the control-order /meta?kind=par table.
export async function gridParmap(iteration: number, opts?: FetchOptions): Promise<Int32Array> {
  const { buffer } = await apiGetBytes(runUrl(activeRunId(), '/api/run/grid/parmap', { iteration }), opts)
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
export async function gridValues(query: GridValuesQuery, opts?: FetchOptions): Promise<Float32Array> {
  const { buffer } = await apiGetBytes(
    runUrl(activeRunId(), '/api/run/grid/values', {
      iteration: query.iteration,
      stat: query.stat,
      realization: query.realization,
    }),
    opts,
  )
  return new Float32Array(buffer)
}

export async function gridCells(which: 'cell' | 'layer', iteration: number, opts?: FetchOptions): Promise<Int32Array>
export async function gridCells(which: 'xy', iteration: number, opts?: FetchOptions): Promise<Float32Array>
export async function gridCells(
  which: 'cell' | 'layer' | 'xy',
  iteration: number,
  opts?: FetchOptions,
): Promise<Int32Array | Float32Array> {
  const { buffer } = await apiGetBytes(runUrl(activeRunId(), `/api/run/grid/cells/${which}`, { iteration }), opts)
  return which === 'xy' ? new Float32Array(buffer) : new Int32Array(buffer)
}

const NO_POSITIONS_TITLE = 'no point positions were recorded for that iteration'

// null means the run recorded no x/y positions; any other failure is real.
export async function gridPointXy(iteration: number, opts?: FetchOptions): Promise<Float32Array | null> {
  try {
    return await gridCells('xy', iteration, opts)
  } catch (error) {
    if (error instanceof ApiError && error.problem.status === 404 && error.problem.title === NO_POSITIONS_TITLE) {
      return null
    }
    throw error
  }
}

// The raw Arrow stream bytes for /meta -- parsing (tableFromIPC, getChild
// by field name) is data/parmap.ts's job, the D-05 join's first use of
// apache-arrow.
// `columns` must all exist (the server answers 422 naming one that does not);
// `optionalColumns` that the table lacks are left out and named in the
// server's X-Pesto-Absent-Columns header.
export async function runMeta(
  kind: 'par' | 'obs',
  columns?: readonly string[],
  optionalColumns?: readonly string[],
  opts?: FetchOptions,
): Promise<ArrayBuffer> {
  const { buffer } = await apiGetBytes(
    runUrl(activeRunId(), '/api/run/meta', {
      kind,
      columns: columns?.join(','),
      optional_columns: optionalColumns?.join(','),
    }),
    opts,
  )
  return buffer
}

export async function runReals(iteration: number, opts?: FetchOptions): Promise<string[]> {
  const { buffer } = await apiGetBytes(runUrl(activeRunId(), '/api/run/reals', { iteration }), opts)
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

export function ingestEventsUrl(): string {
  return runUrl(activeRunId(), INGEST_EVENTS_URL)
}

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
  // Facts the server adds to a capability that is still available, for example
  // a phi mismatch or iterations with no prior-data conflict source.
  notes?: string[]
}

// Why a cache is being re-read: the version it was made at, the version this
// pesto writes, whether its folder can be written, that folder with the home
// directory shortened to ~, the free space there, and the old cache's size
// (null when the old manifest did not record one).
export interface RewriteFacts {
  found: number
  expected: number
  writable: boolean
  folder: string
  freeBytes: number | null
  oldCacheBytes: number | null
}

interface RawRewrite {
  found: number
  expected: number
  writable: boolean
  folder: string
  free_bytes?: number | null
  old_cache_bytes?: number | null
}

function toRewriteFacts(raw: RawRewrite | null | undefined): RewriteFacts | null {
  if (!raw) {
    return null
  }
  return {
    found: raw.found,
    expected: raw.expected,
    writable: raw.writable,
    folder: raw.folder,
    freeBytes: raw.free_bytes ?? null,
    oldCacheBytes: raw.old_cache_bytes ?? null,
  }
}

export interface IngestState {
  fresh: boolean
  artifacts: ArtifactRow[]
  capabilities: {
    map: Capability
    stats: Capability
    chips: Capability
    // The observation capabilities; absent from a server that does not send them.
    obs?: Capability
    obsStats?: Capability
    noise?: Capability
    pdc?: Capability
    phiCheck?: Capability
    // The parameter view; absent from a server that does not send it.
    parView?: Capability
  }
  ingestSeconds: number | null
  cacheBytes: number | null
  rewrite?: RewriteFacts | null
  // The server's short id for the open run; null from a server that sends none.
  runId?: string | null
}

export interface IngestEstimate {
  total: number
  perArtifact: { name: string; bytes: number }[]
  notes: string[]
  freeBytes: number
  cacheRootExists: boolean
}

function toCapability(raw: unknown): Capability {
  const capability = raw as {
    available: boolean
    blocked_by: { artifact: string; reason: string }[]
    notes?: string[]
  }
  const mapped: Capability = { available: capability.available, blockedBy: capability.blocked_by }
  if (capability.notes) {
    mapped.notes = capability.notes
  }
  return mapped
}

// One key for a capability the server sent, nothing for one it did not, so an
// older server's state has no explicit undefined fields.
function present<K extends string>(key: K, raw: unknown): { [P in K]?: Capability } {
  return raw === undefined || raw === null ? {} : ({ [key]: toCapability(raw) } as { [P in K]?: Capability })
}

export async function ingestState(): Promise<IngestState> {
  const raw = (await apiGet(runUrl(activeRunId(), '/api/run/ingest/state'))) as {
    fresh: boolean
    artifacts: ArtifactRow[]
    capabilities: {
      map: unknown
      stats: unknown
      chips: unknown
      obs?: unknown
      obs_stats?: unknown
      noise?: unknown
      pdc?: unknown
      phi_check?: unknown
      par_view?: unknown
    }
    ingest_seconds: number | null
    cache_bytes: number | null
    rewrite?: RawRewrite | null
    run_id?: string | null
  }
  return {
    fresh: raw.fresh,
    artifacts: raw.artifacts,
    capabilities: {
      map: toCapability(raw.capabilities.map),
      stats: toCapability(raw.capabilities.stats),
      chips: toCapability(raw.capabilities.chips),
      ...present('obs', raw.capabilities.obs),
      ...present('obsStats', raw.capabilities.obs_stats),
      ...present('noise', raw.capabilities.noise),
      ...present('pdc', raw.capabilities.pdc),
      ...present('phiCheck', raw.capabilities.phi_check),
      ...present('parView', raw.capabilities.par_view),
    },
    ingestSeconds: raw.ingest_seconds,
    cacheBytes: raw.cache_bytes,
    rewrite: toRewriteFacts(raw.rewrite),
    runId: raw.run_id ?? null,
  }
}

export async function ingestEstimate(): Promise<IngestEstimate> {
  const raw = (await apiGet(runUrl(activeRunId(), '/api/run/ingest/estimate'))) as {
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
  await apiPost(runUrl(activeRunId(), '/api/run/ingest'), {})
}

export async function ingestCancel(): Promise<void> {
  await apiPost(runUrl(activeRunId(), '/api/run/ingest/cancel'), {})
}

// D-11: the per-run view state GET/PUT /api/run/view (src/pesto/api/runs.py)
// keeps server-side -- the divider position and the colour/scale/group
// choices, so a reopened run comes back as the user left it. The route's
// own Pydantic model already applies every default; a caller that has not
// yet read the current state should call readViewState first rather than
// PUT a partial object, since the server always writes the whole document.
export type PanelTab = 'params' | 'obs' | 'config'

const PANEL_TABS: readonly PanelTab[] = ['params', 'obs', 'config']

function isPanelTab(value: unknown): value is PanelTab {
  return typeof value === 'string' && (PANEL_TABS as readonly string[]).includes(value)
}

export interface ViewState {
  divider: number
  colormap: string
  reverse: boolean
  scale: 'linear' | 'log10'
  limitsMode: 'robust' | 'minmax' | 'manual'
  group: string | null
  stat: string
  layer: number | null
  /** Optional so a caller that only moves the divider still compiles; absent means Params. */
  tab?: PanelTab
}

interface ViewStateWire {
  divider: number
  colormap: string
  reverse: boolean
  scale: 'linear' | 'log10'
  limits_mode: 'robust' | 'minmax' | 'manual'
  group: string | null
  stat: string
  layer?: number | null
  tab?: string
}

function toViewState(raw: unknown): ViewState {
  const wire = raw as ViewStateWire
  return {
    divider: wire.divider,
    colormap: wire.colormap,
    reverse: wire.reverse,
    scale: wire.scale,
    limitsMode: wire.limits_mode,
    group: wire.group,
    stat: wire.stat,
    layer: wire.layer ?? null,
    tab: isPanelTab(wire.tab) ? wire.tab : 'params',
  }
}

function toViewStateWire(state: ViewState): ViewStateWire {
  return {
    divider: state.divider,
    colormap: state.colormap,
    reverse: state.reverse,
    scale: state.scale,
    limits_mode: state.limitsMode,
    group: state.group,
    stat: state.stat,
    layer: state.layer,
    tab: state.tab ?? 'params',
  }
}

export async function readViewState(): Promise<ViewState> {
  const raw = await apiGet(runUrl(activeRunId(), '/api/run/view'))
  return toViewState(raw)
}

export async function writeViewState(state: ViewState): Promise<ViewState> {
  const raw = await apiPut(runUrl(activeRunId(), '/api/run/view'), toViewStateWire(state))
  return toViewState(raw)
}
