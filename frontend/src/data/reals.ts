// Realization names for one iteration, read from GET /reals in the order
// the ensemble file recorded them (CLAUDE.md's "never substitute position
// for identity"). A route that answers "no names were recorded" carries a
// different fact than an empty list, so the two are kept apart in the
// return type rather than both collapsing to `[]`.

import { tableFromIPC } from 'apache-arrow'
import { apiGet, apiGetBytes, ApiError, type FetchOptions } from './client'
import { activeRunId, runUrl } from './run'

export interface RealNamesFound {
  ok: true
  names: string[]
}

export interface RealNamesNotRecorded {
  ok: false
  iteration: number
  reason: string
}

export type RealNamesResult = RealNamesFound | RealNamesNotRecorded

export async function fetchRealNames(iteration: number, opts?: FetchOptions): Promise<RealNamesResult> {
  let buffer: ArrayBuffer
  try {
    const result = await apiGetBytes(runUrl(activeRunId(), '/api/run/reals', { iteration }), opts)
    buffer = result.buffer
  } catch (error) {
    if (error instanceof ApiError && error.problem.status === 404) {
      return { ok: false, iteration, reason: error.problem.title }
    }
    throw error
  }

  const table = tableFromIPC(new Uint8Array(buffer))
  const column = table.getChild('realization')
  if (!column) {
    throw new Error('the realization table is missing its realization column')
  }
  const names: string[] = new Array(table.numRows)
  for (let i = 0; i < table.numRows; i++) {
    names[i] = String(column.get(i))
  }
  return { ok: true, names }
}

/** The base realization of one iteration's parameter ensemble; name null with a reason when there is none. */
export interface BaseAnswer {
  iteration: number
  name: string | null
  note: string | null
  reason: string | null
}

export type BaseResult = { ok: true; answer: BaseAnswer } | { ok: false; iteration: number; reason: string }

// A malformed answer is a reason, not a guess: the first missing or wrong field is named.
function readBase(payload: unknown, iteration: number): BaseAnswer | string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return 'the /reals/base answer is not an object'
  const o = payload as Record<string, unknown>
  for (const key of ['iteration', 'name', 'note', 'reason']) {
    if (!(key in o)) return `the /reals/base answer is missing ${key}`
  }
  // A base name from another iteration would put the chip on the wrong realization.
  if (o.iteration !== iteration) return `the /reals/base answer is for iteration ${String(o.iteration)}, not ${iteration}`
  for (const key of ['name', 'note', 'reason']) {
    if (o[key] !== null && typeof o[key] !== 'string') return `the /reals/base answer's ${key} is neither text nor null`
  }
  const answer = { iteration, name: o.name, note: o.note, reason: o.reason } as BaseAnswer
  if (answer.name === null && answer.reason === null) return 'the /reals/base answer has no base name and no reason'
  return answer
}

export async function fetchBase(iteration: number, opts?: FetchOptions): Promise<BaseResult> {
  let payload: unknown
  try {
    payload = await apiGet(runUrl(activeRunId(), '/api/run/reals/base', { iteration }), opts)
  } catch (error) {
    if (error instanceof ApiError && error.problem.status === 404) {
      return { ok: false, iteration, reason: error.problem.detail ?? error.problem.title }
    }
    throw error
  }
  const answer = readBase(payload, iteration)
  return typeof answer === 'string' ? { ok: false, iteration, reason: answer } : { ok: true, answer }
}
