// The section along one straight line, from GET /api/run/grid/section: the pieces of cells the
// line crosses, in order from A, with each piece's layer elevations and status. Every field is
// read by name and every length is checked against n_pieces and nlay before anything is built.

import { apiGet, ApiError, type FetchOptions } from './client'
import { activeRunId, runUrl } from './run'

export interface SectionAnswer {
  line: { a: [number, number]; b: [number, number]; length: number }
  nlay: number
  nPieces: number
  /** The grid's own cell id of each piece, the same id the plan picks. */
  cell: Int32Array
  s0: Float64Array
  s1: Float64Array
  /** n_pieces x (nlay + 1), piece-major: row 0 the top, row k + 1 the bottom of layer k; NaN where not finite. */
  z: Float64Array
  /** n_pieces x nlay, piece-major; 0 is active, anything else is absence. */
  status: Uint8Array
  statusText: Map<number, string>
  hasIdomain: boolean
  gridType: string
  lengthUnits: string | null
  counts: Record<string, number>
  notes: string[]
  tag: string | null
}

/** `retryable` is false when the answer refuses the line itself, true when asking again may work. */
export type SectionResult =
  | { ok: true; answer: SectionAnswer }
  | { ok: false; artifact: string; reason: string; retryable: boolean }

const ARTIFACT = 'grid/section'
const WHAT = 'section answer'
const MAX_STATUS = 5

class Refusal extends Error {}

type Raw = Record<string, unknown>

function objectOf(value: unknown, what: string): Raw {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Refusal(`the ${what} was not an object`)
  return value as Raw
}

function field(raw: Raw, name: string, what: string): unknown {
  if (!(name in raw)) throw new Refusal(`the ${what} is missing ${name}`)
  return raw[name]
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function countField(raw: Raw, name: string, what: string): number {
  const value = field(raw, name, what)
  if (!isCount(value)) throw new Refusal(`${name} in the ${what} is not a whole number of zero or more`)
  return value
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function listOf(raw: Raw, name: string, expected: number, rule: string): unknown[] {
  const value = field(raw, name, WHAT)
  if (!Array.isArray(value)) throw new Refusal(`${name} in the ${WHAT} is not a list`)
  if (value.length !== expected) {
    throw new Refusal(`${name} in the ${WHAT} holds ${value.length} values; ${expected} were expected (${rule})`)
  }
  return value
}

function pair(value: unknown, name: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(finite)) {
    throw new Refusal(`${name} of the line in the ${WHAT} is not a pair of numbers`)
  }
  return [value[0], value[1]]
}

function textOrNull(raw: Raw, name: string): string | null {
  const value = field(raw, name, WHAT)
  if (value !== null && typeof value !== 'string') throw new Refusal(`${name} in the ${WHAT} is not text`)
  return value
}

function statusTexts(raw: Raw): Map<number, string> {
  const table = objectOf(field(raw, 'status_text', WHAT), `status_text of the ${WHAT}`)
  const out = new Map<number, string>()
  for (const [key, text] of Object.entries(table)) {
    const code = Number(key)
    if (!Number.isInteger(code) || code < 0 || code > MAX_STATUS) {
      throw new Refusal(`status_text in the ${WHAT} names a status ${key}, not one of 0 to ${MAX_STATUS}`)
    }
    if (typeof text !== 'string') throw new Refusal(`status_text ${key} in the ${WHAT} is not text`)
    out.set(code, text)
  }
  return out
}

export function parseSection(payload: unknown): SectionAnswer {
  const raw = objectOf(payload, WHAT)
  const lineRaw = objectOf(field(raw, 'line', WHAT), `line of the ${WHAT}`)
  const length = field(lineRaw, 'length', `line of the ${WHAT}`)
  if (!finite(length) || length < 0) throw new Refusal(`length of the line in the ${WHAT} is not a number of zero or more`)
  const line = { a: pair(field(lineRaw, 'a', `line of the ${WHAT}`), 'a'), b: pair(field(lineRaw, 'b', `line of the ${WHAT}`), 'b'), length }

  const nlay = countField(raw, 'nlay', WHAT)
  if (nlay < 1) throw new Refusal(`nlay in the ${WHAT} is 0; a section needs at least one layer`)
  const nPieces = countField(raw, 'n_pieces', WHAT)

  const cellList = listOf(raw, 'cell', nPieces, 'one per piece')
  const cell = new Int32Array(nPieces)
  cellList.forEach((v, i) => {
    if (!isCount(v)) throw new Refusal(`cell in the ${WHAT} holds something that is not a cell id`)
    cell[i] = v
  })
  const distances = (name: string): Float64Array => {
    const out = new Float64Array(nPieces)
    listOf(raw, name, nPieces, 'one per piece').forEach((v, i) => {
      if (!finite(v)) throw new Refusal(`${name} in the ${WHAT} holds something that is not a number`)
      out[i] = v
    })
    return out
  }
  const s0 = distances('s0')
  const s1 = distances('s1')

  const z = new Float64Array(nPieces * (nlay + 1))
  listOf(raw, 'z', z.length, 'n_pieces x (nlay + 1)').forEach((v, i) => {
    if (v === null) z[i] = Number.NaN
    else if (finite(v)) z[i] = v
    else throw new Refusal(`z in the ${WHAT} holds something that is neither a number nor null`)
  })

  const statusText = statusTexts(raw)
  const status = new Uint8Array(nPieces * nlay)
  listOf(raw, 'status', status.length, 'n_pieces x nlay').forEach((v, i) => {
    if (!isCount(v) || v > MAX_STATUS) throw new Refusal(`status in the ${WHAT} holds ${String(v)}, not one of 0 to ${MAX_STATUS}`)
    if (!statusText.has(v)) throw new Refusal(`status ${v} in the ${WHAT} has no text in status_text`)
    status[i] = v
  })

  const hasIdomain = field(raw, 'has_idomain', WHAT)
  if (typeof hasIdomain !== 'boolean') throw new Refusal(`has_idomain in the ${WHAT} is not true or false`)
  const gridType = field(raw, 'grid_type', WHAT)
  if (typeof gridType !== 'string') throw new Refusal(`grid_type in the ${WHAT} is not text`)
  const lengthUnits = textOrNull(raw, 'length_units')

  const countsRaw = objectOf(field(raw, 'counts', WHAT), `counts of the ${WHAT}`)
  const counts: Record<string, number> = {}
  for (const [name, value] of Object.entries(countsRaw)) {
    if (!isCount(value)) throw new Refusal(`${name} in the counts of the ${WHAT} is not a whole number of zero or more`)
    counts[name] = value
  }
  const notesRaw = field(raw, 'notes', WHAT)
  if (!Array.isArray(notesRaw)) throw new Refusal(`notes in the ${WHAT} is not a list`)
  const notes = notesRaw.map((n) => {
    if (typeof n !== 'string') throw new Refusal(`notes in the ${WHAT} holds something that is not text`)
    return n
  })
  const tag = textOrNull(raw, 'tag')

  return { line, nlay, nPieces, cell, s0, s1, z, status, statusText, hasIdomain, gridType, lengthUnits, counts, notes, tag }
}

/** One key per run and line; the ends are written as String(number), so no digit is rounded away. */
export function sectionKey(runId: string | null, a: readonly [number, number], b: readonly [number, number]): string {
  return [runId ?? '-', String(a[0]), String(a[1]), String(b[0]), String(b[1])].join('|')
}

/** Asks for the section from world point `a` to `b`. A problem answer or a malformed one is a refusal with its reason. */
export async function fetchSection(
  a: readonly [number, number],
  b: readonly [number, number],
  opts?: FetchOptions,
): Promise<SectionResult> {
  const query = { ax: String(a[0]), ay: String(a[1]), bx: String(b[0]), by: String(b[1]) }
  try {
    const payload = await apiGet(runUrl(activeRunId(), '/api/run/grid/section', query), opts)
    return { ok: true, answer: parseSection(payload) }
  } catch (error) {
    if (error instanceof ApiError) {
      const reason = error.problem.detail ?? error.problem.title
      // A 4xx refuses this line or this run; a 5xx is the server failing, which may pass.
      const retryable = !(typeof error.problem.status === 'number' && error.problem.status < 500)
      return { ok: false, artifact: error.problem.artifact ?? ARTIFACT, reason, retryable }
    }
    if (error instanceof Refusal) return { ok: false, artifact: ARTIFACT, reason: error.message, retryable: false }
    throw error
  }
}
