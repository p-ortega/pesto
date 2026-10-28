// Field readers for the JSON routes the linking and overlay fetchers use. A missing or wrong-typed
// field throws a Refusal naming the field and where it was looked for; nothing is filled in.

import { ApiError } from './client'
import type { Refused } from './obs'

/** A malformed answer: carries the reason the view shows. */
export class Refusal extends Error {}

export type Json = Record<string, unknown>

// 404 means the artifact is missing, 409 that no run is open; both carry a reason worth showing.
export async function guarded<T>(fallback: string, read: () => Promise<T>): Promise<T | Refused> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof ApiError && (error.problem.status === 404 || error.problem.status === 409)) {
      return { ok: false, artifact: error.problem.artifact ?? fallback, reason: error.problem.detail ?? error.problem.title }
    }
    if (error instanceof Refusal) return { ok: false, artifact: fallback, reason: error.message }
    throw error
  }
}

export function objectOf(value: unknown, where: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Refusal(`the ${where} is not an object`)
  return value as Json
}

export function field(o: Json, key: string, where: string): unknown {
  if (!(key in o)) throw new Refusal(`the ${where} is missing ${key}`)
  return o[key]
}

function isWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

export function wholeNumber(o: Json, key: string, where: string): number {
  const value = field(o, key, where)
  if (!isWhole(value)) throw new Refusal(`the ${where}'s ${key} is not a whole number`)
  return value
}

export function wholeNumberOrNull(o: Json, key: string, where: string): number | null {
  const value = field(o, key, where)
  if (value !== null && !isWhole(value)) throw new Refusal(`the ${where}'s ${key} is neither a whole number nor null`)
  return value
}

export function finiteNumbers(o: Json, key: string, where: string): number[] {
  const values = list(o, key, where)
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Refusal(`the ${where}'s ${key} holds something other than numbers`)
  return values as number[]
}

export function text(o: Json, key: string, where: string): string {
  const value = field(o, key, where)
  if (typeof value !== 'string') throw new Refusal(`the ${where}'s ${key} is not text`)
  return value
}

export function textOrNull(o: Json, key: string, where: string): string | null {
  const value = field(o, key, where)
  if (value !== null && typeof value !== 'string') throw new Refusal(`the ${where}'s ${key} is neither text nor null`)
  return value
}

export function flag(o: Json, key: string, where: string): boolean {
  const value = field(o, key, where)
  if (typeof value !== 'boolean') throw new Refusal(`the ${where}'s ${key} is not true or false`)
  return value
}

export function flagOrNull(o: Json, key: string, where: string): boolean | null {
  const value = field(o, key, where)
  if (value !== null && typeof value !== 'boolean') throw new Refusal(`the ${where}'s ${key} is neither true, false nor null`)
  return value
}

export function list(o: Json, key: string, where: string): unknown[] {
  const value = field(o, key, where)
  if (!Array.isArray(value)) throw new Refusal(`the ${where}'s ${key} is not a list`)
  return value
}

export function wholeNumbers(o: Json, key: string, where: string): number[] {
  const values = list(o, key, where)
  if (!values.every(isWhole)) throw new Refusal(`the ${where}'s ${key} holds something other than whole numbers`)
  return values as number[]
}

export function texts(o: Json, key: string, where: string): string[] {
  const values = list(o, key, where)
  if (!values.every((v) => typeof v === 'string')) throw new Refusal(`the ${where}'s ${key} holds something other than text`)
  return values as string[]
}
