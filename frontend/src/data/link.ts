// What a clicked set of cells holds: its parameters by name and its sites by id, from
// GET /api/run/link/cell. Every field is read by name, and a missing one is a refusal that
// says which, never a default.

import { apiGet, ApiError, type FetchOptions } from './client'
import { activeRunId, runUrl } from './run'
import { sameSet } from '../state/rules'

/** The most cells one request may name; the route refuses more. */
export const MAX_LINK_CELLS = 50

export interface CellLinkPar {
  parnme: string
  pargp: string | null
  kind: 'cell' | 'pilot_point'
  cell: number
  weights: { cell: number; weight: number }[]
  rule: string
}

export interface CellLinkSite {
  siteId: number
  site: string
  group: string | null
  layer: number
  cell: number
  inClickedCell: boolean
}

export interface CellLinkSiteCounts {
  unknownLayerIncluded: number
  otherLayerLeftOut: number
  unplacedInRun: number
}

export interface CellLinkAnswer {
  layer: number
  cells: number[]
  /** Cells sharing at least one corner with a clicked cell, never a clicked one. */
  ring: number[]
  ringRule: string
  pars: CellLinkPar[]
  parsTotal: number
  parNotes: string[]
  sites: CellLinkSite[]
  sitesTotal: number
  sitesCap: number
  siteCounts: CellLinkSiteCounts
  reasons: { pars: string | null; sites: string | null }
}

export type CellLinkResult = { ok: true; answer: CellLinkAnswer } | { ok: false; artifact: string; reason: string }

const ARTIFACT = 'link/cell'

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

function numberField(raw: Raw, name: string, what: string): number {
  const value = field(raw, name, what)
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Refusal(`${name} in the ${what} is not a number`)
  return value
}

function textField(raw: Raw, name: string, what: string): string {
  const value = field(raw, name, what)
  if (typeof value !== 'string') throw new Refusal(`${name} in the ${what} is not text`)
  return value
}

function textOrNullField(raw: Raw, name: string, what: string): string | null {
  const value = field(raw, name, what)
  if (value !== null && typeof value !== 'string') throw new Refusal(`${name} in the ${what} is not text`)
  return value
}

function listField(raw: Raw, name: string, what: string): unknown[] {
  const value = field(raw, name, what)
  if (!Array.isArray(value)) throw new Refusal(`${name} in the ${what} is not a list`)
  return value
}

function numbers(raw: Raw, name: string, what: string): number[] {
  return listField(raw, name, what).map((v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Refusal(`${name} in the ${what} holds something that is not a number`)
    return v
  })
}

function parOf(value: unknown): CellLinkPar {
  const what = 'parameter entry'
  const raw = objectOf(value, what)
  const kind = textField(raw, 'kind', what)
  if (kind !== 'cell' && kind !== 'pilot_point') throw new Refusal(`kind in the ${what} is ${kind}, not cell or pilot_point`)
  return {
    parnme: textField(raw, 'parnme', what),
    pargp: textOrNullField(raw, 'pargp', what),
    kind,
    cell: numberField(raw, 'cell', what),
    weights: listField(raw, 'weights', what).map((w) => {
      const entry = objectOf(w, 'weight entry')
      return { cell: numberField(entry, 'cell', 'weight entry'), weight: numberField(entry, 'weight', 'weight entry') }
    }),
    rule: textField(raw, 'rule', what),
  }
}

function siteOf(value: unknown): CellLinkSite {
  const what = 'site entry'
  const raw = objectOf(value, what)
  const inClicked = field(raw, 'in_clicked_cell', what)
  if (typeof inClicked !== 'boolean') throw new Refusal(`in_clicked_cell in the ${what} is not true or false`)
  return {
    siteId: numberField(raw, 'site_id', what),
    site: textField(raw, 'site', what),
    group: textOrNullField(raw, 'group', what),
    layer: numberField(raw, 'layer', what),
    cell: numberField(raw, 'cell', what),
    inClickedCell: inClicked,
  }
}

export function parseCellLink(payload: unknown): CellLinkAnswer {
  const what = 'link/cell answer'
  const raw = objectOf(payload, what)
  const reasons = objectOf(field(raw, 'reasons', what), 'reasons of the link/cell answer')
  const countsWhat = 'site_counts of the link/cell answer'
  const counts = objectOf(field(raw, 'site_counts', what), countsWhat)
  return {
    layer: numberField(raw, 'layer', what),
    cells: numbers(raw, 'cells', what),
    ring: numbers(raw, 'ring', what),
    ringRule: textField(raw, 'ring_rule', what),
    pars: listField(raw, 'pars', what).map(parOf),
    parsTotal: numberField(raw, 'pars_total', what),
    parNotes: listField(raw, 'par_notes', what).map((n) => {
      if (typeof n !== 'string') throw new Refusal(`par_notes in the ${what} holds something that is not text`)
      return n
    }),
    sites: listField(raw, 'sites', what).map(siteOf),
    sitesTotal: numberField(raw, 'sites_total', what),
    sitesCap: numberField(raw, 'sites_cap', what),
    siteCounts: {
      unknownLayerIncluded: numberField(counts, 'unknown_layer_included', countsWhat),
      otherLayerLeftOut: numberField(counts, 'other_layer_left_out', countsWhat),
      unplacedInRun: numberField(counts, 'unplaced_in_run', countsWhat),
    },
    reasons: {
      pars: textOrNullField(reasons, 'pars', 'reasons of the link/cell answer'),
      sites: textOrNullField(reasons, 'sites', 'reasons of the link/cell answer'),
    },
  }
}

// The last ok answer, held per run so a tab can read it without asking again.
let held: { runId: string | null; answer: CellLinkAnswer } | null = null

/** Asks for what `cells` on `layer` hold. A problem answer or a malformed one is a refusal with its reason. */
export async function fetchLinkCell(layer: number, cells: readonly number[], opts?: FetchOptions): Promise<CellLinkResult> {
  const runId = activeRunId()
  try {
    const payload = await apiGet(runUrl(runId, '/api/run/link/cell', { layer, cells: cells.join(',') }), opts)
    const answer = parseCellLink(payload)
    held = { runId, answer }
    return { ok: true, answer }
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, artifact: error.problem.artifact ?? ARTIFACT, reason: error.problem.detail ?? error.problem.title }
    }
    if (error instanceof Refusal) return { ok: false, artifact: ARTIFACT, reason: error.message }
    throw error
  }
}

/** The latest answer of the open run when it was for exactly `cells`, else null. */
export function recentCellLink(cells: ReadonlySet<number>): CellLinkAnswer | null {
  if (held === null || held.runId !== activeRunId()) return null
  return sameSet(new Set(held.answer.cells), cells) ? held.answer : null
}
