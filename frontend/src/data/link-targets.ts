// Where a selected parameter or site is: the cells each parameter sets and the place of each site.
// Every field the contract names must be in the answer with the right type; a missing one is a
// refusal naming the field and the route, never a default. Names travel exactly as written.

import { apiGet, type FetchOptions } from './client'
import { flag, flagOrNull, guarded, list, objectOf, Refusal, text, textOrNull, texts, wholeNumber, wholeNumbers } from './json-fields'
import type { Refused } from './obs'
import { activeRunId, runUrl } from './run'

export const MAX_LINK_PARS = 50
export const MAX_LINK_SITES = 200

export type ParKind = 'cell' | 'pilot_point' | 'unplaced'
const PAR_KINDS: readonly string[] = ['cell', 'pilot_point', 'unplaced']

export interface ParLink {
  parnme: string
  pargp: string
  kind: ParKind
  /** -1 when the layer is unknown. */
  layer: number
  /** The parameter's own cell; -1 when it has none. */
  cell: number
  /** Every cell the parameter sets, ascending; a pilot point's list stops at the server's cap. */
  cells: number[]
  nCells: number
  cellsCapped: boolean
  /** Why the parameter sets no cell, or why its cells are only its own; null otherwise. */
  reason: string | null
}

/** notAsked counts the names past MAX_LINK_PARS that were left out of the request. */
export type ParLinkResult = { ok: true; pars: ParLink[]; unknown: string[]; notAsked: number } | Refused

export interface SiteWhere {
  siteId: number
  site: string
  group: string
  /** -1 when the layer is unknown. */
  layer: number
  /** -1 when the site is unplaced. */
  cell: number
  placed: boolean
  /** null when the iteration has no observation statistics; valueReason says why. */
  hasValue: boolean | null
}

/** notAsked counts the ids past MAX_LINK_SITES that were left out of the request. */
export type SitesWhereResult =
  | { ok: true; iteration: number; sites: SiteWhere[]; unknown: number[]; valueRule: string; valueReason: string | null; notAsked: number }
  | Refused

function readParLink(value: unknown, where: string): ParLink {
  const o = objectOf(value, where)
  const kind = text(o, 'kind', where)
  if (!PAR_KINDS.includes(kind)) throw new Refusal(`the ${where}'s kind '${kind}' is not cell, pilot_point or unplaced`)
  return {
    parnme: text(o, 'parnme', where),
    pargp: text(o, 'pargp', where),
    kind: kind as ParKind,
    layer: wholeNumber(o, 'layer', where),
    cell: wholeNumber(o, 'cell', where),
    cells: wholeNumbers(o, 'cells', where),
    nCells: wholeNumber(o, 'n_cells', where),
    cellsCapped: flag(o, 'cells_capped', where),
    reason: textOrNull(o, 'reason', where),
  }
}

export async function fetchLinkPar(names: readonly string[], opts?: FetchOptions): Promise<ParLinkResult> {
  if (names.length === 0) return { ok: false, artifact: 'par_cell', reason: 'no parameter was asked for' }
  const asked = names.slice(0, MAX_LINK_PARS)
  const notAsked = names.length - asked.length
  return guarded('par_cell', async () => {
    // One JSON value, because a comma can be part of a PEST name.
    const payload = await apiGet(runUrl(activeRunId(), '/api/run/link/par', { names: JSON.stringify(asked) }), opts)
    const where = '/link/par answer'
    const o = objectOf(payload, where)
    const pars = list(o, 'pars', where).map((row, i) => readParLink(row, `${where}'s pars[${i}]`))
    return { ok: true as const, pars, unknown: texts(o, 'unknown', where), notAsked }
  })
}

function readSiteWhere(value: unknown, where: string): SiteWhere {
  const o = objectOf(value, where)
  return {
    siteId: wholeNumber(o, 'site_id', where),
    site: text(o, 'site', where),
    group: text(o, 'group', where),
    layer: wholeNumber(o, 'layer', where),
    cell: wholeNumber(o, 'cell', where),
    placed: flag(o, 'placed', where),
    hasValue: flagOrNull(o, 'has_value', where),
  }
}

export async function fetchLinkSites(siteIds: readonly number[], iteration: number, opts?: FetchOptions): Promise<SitesWhereResult> {
  if (siteIds.length === 0) return { ok: false, artifact: 'obs_cell', reason: 'no site was asked for' }
  if (!siteIds.every((id) => Number.isInteger(id))) return { ok: false, artifact: 'obs_cell', reason: 'a site id was not a whole number' }
  const asked = siteIds.slice(0, MAX_LINK_SITES)
  const notAsked = siteIds.length - asked.length
  return guarded('obs_cell', async () => {
    const payload = await apiGet(runUrl(activeRunId(), '/api/run/link/sites', { sites: asked.join(','), iteration }), opts)
    const where = '/link/sites answer'
    const o = objectOf(payload, where)
    return {
      ok: true as const,
      iteration: wholeNumber(o, 'iteration', where),
      sites: list(o, 'sites', where).map((row, i) => readSiteWhere(row, `${where}'s sites[${i}]`)),
      unknown: wholeNumbers(o, 'unknown', where),
      valueRule: text(o, 'value_rule', where),
      valueReason: textOrNull(o, 'value_reason', where),
      notAsked,
    }
  })
}
