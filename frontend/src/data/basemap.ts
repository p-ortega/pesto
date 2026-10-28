// The basemap routes by opaque id and display name only; no type here can hold a filesystem
// location (D-16, D-23). A missing or mistyped field is a refusal that names it, never a default.

import { apiGet, apiGetBytes, apiPost, ApiError, type FetchOptions } from './client'
import { activeRunId, runUrl } from './run'
import { isAbortError } from './latest-wins'

/** x min, x max, y min, y max, in the frame the map is drawn in. */
export type Extent = [number, number, number, number]

export type ImageKind = 'folder' | 'png' | 'jpeg' | 'tiff' | 'link'

export interface ImageEntry {
  id: string
  name: string
  kind: ImageKind
  note: string | null
  reason: string | null
}

export interface ImageListing {
  entries: ImageEntry[]
  skipped: { otherFiles: number; notChecked: number; unreadable: number }
}

export interface BasemapFolder {
  id: string
  name: string
}

export type Placement =
  | { by: 'world_file'; worldFile: string; extent: Extent }
  | { by: 'numbers'; reason: string; worldFiles: string[] }

export interface InspectAnswer {
  fileId: string
  name: string
  format: 'png' | 'jpeg'
  width: number
  height: number
  stamp: string
  notes: string[]
  modelExtent: Extent
  placement: Placement
}

export type ReadyState = {
  status: 'ready'
  name: string
  format: 'png' | 'jpeg'
  width: number
  height: number
  extent: Extent
  placedBy: 'world_file' | 'numbers'
  worldFile: string | null
  notes: string[]
  tag: string
}

export type BasemapState =
  | { status: 'none' }
  | ReadyState
  | { status: 'unavailable'; reason: string; name: string | null; placedBy: string | null; extent: Extent | null }

export interface BasemapRefused {
  ok: false
  reason: string
  code: string | null
}

/** An ok answer with its payload, or a refusal with the server's reason and code. */
export type Answer<T> = ({ ok: true } & T) | BasemapRefused

export type RegisterRequest =
  | { id: string; stamp: string; by: 'world_file' }
  | { id: string; stamp: string; by: 'numbers'; extent: Extent }

export type BasemapImage = { ok: true; bitmap: ImageBitmap; notes: string[] } | BasemapRefused

export const NO_DECODER_REASON = 'this browser cannot decode images for the map (no createImageBitmap)'

class Refusal extends Error {}

type Raw = Record<string, unknown>

interface Check<T> {
  test(value: unknown): value is T
  is: string
}

const TEXT: Check<string> = { test: (v): v is string => typeof v === 'string', is: 'text' }
const TEXT_OR_NULL: Check<string | null> = {
  test: (v): v is string | null => v === null || typeof v === 'string',
  is: 'text or null',
}
const COUNT: Check<number> = {
  test: (v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0,
  is: 'a whole number of zero or more',
}
const SIZE: Check<number> = {
  test: (v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0,
  is: 'a whole number above zero',
}
const TEXTS: Check<string[]> = {
  test: (v): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string'),
  is: 'a list of text',
}
const OBJECT: Check<Raw> = {
  test: (v): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v),
  is: 'an object',
}
const EXTENT: Check<Extent> = {
  test: (v): v is Extent =>
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    v[0] < v[1] &&
    v[2] < v[3],
  is: 'four finite numbers with x min below x max and y min below y max',
}
const EXTENT_OR_NULL: Check<Extent | null> = {
  test: (v): v is Extent | null => v === null || EXTENT.test(v),
  is: `null or ${EXTENT.is}`,
}
const PAIR_OR_NULL: Check<[number, number] | null> = {
  test: (v): v is [number, number] | null =>
    v === null || (Array.isArray(v) && v.length === 2 && v.every((n) => SIZE.test(n))),
  is: 'null or two whole numbers above zero',
}

function oneOf<T extends string>(values: readonly T[]): Check<T> {
  return {
    test: (v): v is T => typeof v === 'string' && (values as readonly string[]).includes(v),
    is: `one of ${values.join(', ')}`,
  }
}

const KIND = oneOf<ImageKind>(['folder', 'png', 'jpeg', 'tiff', 'link'])
const FORMAT = oneOf<'png' | 'jpeg'>(['png', 'jpeg'])
const STATUS = oneOf<BasemapState['status']>(['none', 'ready', 'unavailable'])
const PLACED_BY = oneOf<'world_file' | 'numbers'>(['world_file', 'numbers'])

function readField<T>(raw: Raw, name: string, check: Check<T>, what: string): T {
  if (!(name in raw)) throw new Refusal(`the ${what} is missing ${name}`)
  const value = raw[name]
  if (!check.test(value)) throw new Refusal(`${name} in the ${what} is ${JSON.stringify(value)}, not ${check.is}`)
  return value
}

function objectOf(value: unknown, what: string): Raw {
  if (!OBJECT.test(value)) throw new Refusal(`the ${what} was not an object`)
  return value
}

function refusalOf(error: unknown): BasemapRefused {
  if (error instanceof ApiError) {
    const problem = (OBJECT.test(error.problem) ? error.problem : {}) as Raw
    const title = typeof problem.title === 'string' ? problem.title : 'the server refused without a reason'
    const detail = typeof problem.detail === 'string' && problem.detail !== title ? problem.detail : null
    const code = typeof problem.code === 'string' ? problem.code : null
    return { ok: false, reason: detail ? `${title}: ${detail}` : title, code }
  }
  if (error instanceof Error) return { ok: false, reason: error.message, code: null }
  return { ok: false, reason: String(error), code: null }
}

// An abort is the caller moving on, not a failure to show, so it is thrown, never turned into a reason.
async function attempt<T>(work: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { ok: true, ...(await work()) }
  } catch (error) {
    if (isAbortError(error)) throw error
    return refusalOf(error)
  }
}

export function parseFolder(payload: unknown): BasemapFolder {
  const what = 'basemap start answer'
  const raw = objectOf(payload, what)
  return { id: readField(raw, 'id', TEXT, what), name: readField(raw, 'name', TEXT, what) }
}

function entryOf(value: unknown): ImageEntry {
  const what = 'image listing entry'
  const raw = objectOf(value, what)
  return {
    id: readField(raw, 'id', TEXT, what),
    name: readField(raw, 'name', TEXT, what),
    kind: readField(raw, 'kind', KIND, what),
    note: readField(raw, 'note', TEXT_OR_NULL, what),
    reason: readField(raw, 'reason', TEXT_OR_NULL, what),
  }
}

export function parseListing(payload: unknown): ImageListing {
  const what = 'image listing'
  const raw = objectOf(payload, what)
  const entries = readField(raw, 'entries', { test: (v): v is unknown[] => Array.isArray(v), is: 'a list' }, what)
  const skippedWhat = 'skipped counts of the image listing'
  const skipped = objectOf(readField(raw, 'skipped', OBJECT, what), skippedWhat)
  return {
    entries: entries.map(entryOf),
    skipped: {
      otherFiles: readField(skipped, 'other_files', COUNT, skippedWhat),
      notChecked: readField(skipped, 'not_checked', COUNT, skippedWhat),
      unreadable: readField(skipped, 'unreadable', COUNT, skippedWhat),
    },
  }
}

function placementOf(value: unknown): Placement {
  const what = 'placement of the inspect answer'
  const raw = objectOf(value, what)
  const by = readField(raw, 'by', PLACED_BY, what)
  if (by === 'world_file') {
    return { by, worldFile: readField(raw, 'world_file', TEXT, what), extent: readField(raw, 'extent', EXTENT, what) }
  }
  return { by, reason: readField(raw, 'reason', TEXT, what), worldFiles: readField(raw, 'world_files', TEXTS, what) }
}

export function parseInspect(payload: unknown): InspectAnswer {
  const what = 'inspect answer'
  const raw = objectOf(payload, what)
  return {
    fileId: readField(raw, 'file_id', TEXT, what),
    name: readField(raw, 'name', TEXT, what),
    format: readField(raw, 'format', FORMAT, what),
    width: readField(raw, 'width', SIZE, what),
    height: readField(raw, 'height', SIZE, what),
    stamp: readField(raw, 'stamp', TEXT, what),
    notes: readField(raw, 'notes', TEXTS, what),
    modelExtent: readField(raw, 'model_extent', EXTENT, what),
    placement: placementOf(readField(raw, 'placement', OBJECT, what)),
  }
}

export function parseState(payload: unknown): BasemapState {
  const what = 'basemap state'
  const raw = objectOf(payload, what)
  const status = readField(raw, 'status', STATUS, what)
  if (status === 'none') return { status }
  if (status === 'unavailable') {
    return {
      status,
      reason: readField(raw, 'reason', TEXT, what),
      name: readField(raw, 'name', TEXT_OR_NULL, what),
      placedBy: readField(raw, 'placed_by', TEXT_OR_NULL, what),
      extent: readField(raw, 'extent', EXTENT_OR_NULL, what),
    }
  }
  return {
    status,
    name: readField(raw, 'name', TEXT, what),
    format: readField(raw, 'format', FORMAT, what),
    width: readField(raw, 'width', SIZE, what),
    height: readField(raw, 'height', SIZE, what),
    extent: readField(raw, 'extent', EXTENT, what),
    placedBy: readField(raw, 'placed_by', PLACED_BY, what),
    worldFile: readField(raw, 'world_file', TEXT_OR_NULL, what),
    notes: readField(raw, 'notes', TEXTS, what),
    tag: readField(raw, 'tag', TEXT, what),
  }
}

/** The run folder the picker opens on. */
export function basemapStart(opts?: FetchOptions): Promise<Answer<{ folder: BasemapFolder }>> {
  return attempt(async () => ({
    folder: parseFolder(await apiGet(runUrl(activeRunId(), '/api/run/basemap/start'), opts)),
  }))
}

/** The folders and image files in one folder, by its opaque id. */
export function listImages(id: string, opts?: FetchOptions): Promise<Answer<{ listing: ImageListing }>> {
  return attempt(async () => ({
    listing: parseListing(await apiGet(`/api/fs/images?id=${encodeURIComponent(id)}`, opts)),
  }))
}

/** What pesto reads from one picked file: its size, its notes and how it could be placed. */
export function inspectBasemap(id: string): Promise<Answer<{ answer: InspectAnswer }>> {
  return attempt(async () => ({
    answer: parseInspect(await apiPost(runUrl(activeRunId(), '/api/run/basemap/inspect'), { id })),
  }))
}

export function registerBasemap(request: RegisterRequest): Promise<Answer<{ state: BasemapState }>> {
  const body =
    request.by === 'numbers'
      ? { id: request.id, stamp: request.stamp, by: 'numbers', extent: [...request.extent] }
      : { id: request.id, stamp: request.stamp, by: 'world_file' }
  return attempt(async () => ({ state: parseState(await apiPost(runUrl(activeRunId(), '/api/run/basemap'), body)) }))
}

export function readBasemapState(opts?: FetchOptions): Promise<Answer<{ state: BasemapState }>> {
  return attempt(async () => ({ state: parseState(await apiGet(runUrl(activeRunId(), '/api/run/basemap'), opts)) }))
}

export function removeBasemap(): Promise<Answer<{ state: BasemapState }>> {
  return attempt(async () => ({
    state: parseState(await apiPost(runUrl(activeRunId(), '/api/run/basemap/remove'), {})),
  }))
}

type Decode = (image: Blob, options?: ImageBitmapOptions) => Promise<ImageBitmap>

function abortError(): DOMException {
  return new DOMException('the basemap load was cancelled', 'AbortError')
}

// Shrinks in the browser when the server sends resize_to (D-22 fallback); a decode of the wrong
// size is refused, since a browser may ignore imageOrientation or the resize options (A3).
export async function loadBasemapImage(
  state: ReadyState,
  maxTextureSize: number,
  opts?: { signal?: AbortSignal },
): Promise<BasemapImage> {
  const decode = (globalThis as { createImageBitmap?: Decode }).createImageBitmap
  if (typeof decode !== 'function') return { ok: false, reason: NO_DECODER_REASON, code: null }
  if (!Number.isFinite(maxTextureSize) || maxTextureSize < 1) {
    return { ok: false, reason: `the graphics card reported a texture size of ${maxTextureSize}, which pesto cannot use`, code: null }
  }

  let meta: { format: 'png' | 'jpeg'; servedWidth: number; servedHeight: number; resizeTo: [number, number] | null; notes: string[]; tag: string }
  let buffer: ArrayBuffer
  try {
    const answer = await apiGetBytes(
      runUrl(activeRunId(), '/api/run/basemap/image', { max: Math.floor(maxTextureSize) }),
      { signal: opts?.signal },
    )
    buffer = answer.buffer
    const what = 'basemap image header'
    if (answer.meta === null) throw new Refusal(`the ${what} is missing`)
    const raw = answer.meta
    meta = {
      format: readField(raw, 'format', FORMAT, what),
      servedWidth: readField(raw, 'served_width', SIZE, what),
      servedHeight: readField(raw, 'served_height', SIZE, what),
      resizeTo: readField(raw, 'resize_to', PAIR_OR_NULL, what),
      notes: readField(raw, 'notes', TEXTS, what),
      tag: readField(raw, 'tag', TEXT, what),
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    return refusalOf(error)
  }
  if (meta.tag !== state.tag) {
    return { ok: false, reason: 'the basemap changed on the server while it was loading; read its state again', code: null }
  }

  const blob = new Blob([buffer], { type: meta.format === 'png' ? 'image/png' : 'image/jpeg' })
  // D-36: the world file describes the stored raster, so an EXIF rotation flag must not turn it.
  const options: ImageBitmapOptions = { imageOrientation: 'none' }
  if (meta.resizeTo !== null) {
    options.resizeWidth = meta.resizeTo[0]
    options.resizeHeight = meta.resizeTo[1]
    options.resizeQuality = 'high'
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await decode(blob, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `the image could not be decoded: ${message}`, code: null }
  }
  if (opts?.signal?.aborted) {
    bitmap.close()
    throw abortError()
  }

  const [wantWidth, wantHeight] = meta.resizeTo ?? [meta.servedWidth, meta.servedHeight]
  if (bitmap.width !== wantWidth || bitmap.height !== wantHeight) {
    const got = `${bitmap.width} x ${bitmap.height}`
    bitmap.close()
    return {
      ok: false,
      reason: `the browser decoded the image as ${got} pixels, but pesto read ${wantWidth} x ${wantHeight} from the file, so it is not drawn`,
      code: null,
    }
  }
  return { ok: true, bitmap, notes: meta.notes }
}
