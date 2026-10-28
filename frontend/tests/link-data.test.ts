// fetchLinkCell against a stubbed fetch: every field read by name into camelCase, a missing
// field refused with its name, a problem answer turned into a reason, and the held answer.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLinkCell, MAX_LINK_CELLS, recentCellLink } from '../src/data/link'

function answer(): Record<string, unknown> {
  return {
    layer: 2,
    cells: [4, 7],
    ring: [3, 5, 8],
    ring_rule: 'a neighbouring cell shares at least one corner with a clicked cell',
    pars: [
      { parnme: 'hk_4', pargp: 'hk', kind: 'cell', cell: 4, weights: [], rule: 'sets this cell (par_cell)' },
      { parnme: 'pp_1', pargp: 'pp', kind: 'pilot_point', cell: 7, weights: [{ cell: 7, weight: 0.25 }], rule: 'sets this cell (par_cell)' },
    ],
    pars_total: 2,
    par_notes: ['a note'],
    sites: [
      { site_id: 91, site: 'w1', group: 'heads', layer: 2, cell: 4, in_clicked_cell: true },
      { site_id: 12, site: 'w2', group: 'heads', layer: -1, cell: 5, in_clicked_cell: false },
    ],
    sites_total: 61,
    sites_cap: 50,
    site_counts: { unknown_layer_included: 1, other_layer_left_out: 2, unplaced_in_run: 3 },
    reasons: { pars: null, sites: null },
  }
}

function stubAnswer(status: number, body: unknown): { urls: string[] } {
  const seen = { urls: [] as string[] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      seen.urls.push(typeof input === 'string' ? input : input.toString())
      return { ok: status >= 200 && status < 300, status, json: async () => body }
    }),
  )
  return seen
}

describe('fetchLinkCell', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('caps a request at 50 cells', () => {
    expect(MAX_LINK_CELLS).toBe(50)
  })

  it('asks for the layer and the cells and reads every field into camelCase', async () => {
    const seen = stubAnswer(200, answer())

    const result = await fetchLinkCell(2, [4, 7])

    const query = new URLSearchParams(seen.urls[0].split('?')[1])
    expect(seen.urls[0].split('?')[0]).toBe('/api/run/link/cell')
    expect(query.get('layer')).toBe('2')
    expect(query.get('cells')).toBe('4,7')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const a = result.answer
    expect(a.layer).toBe(2)
    expect(a.cells).toEqual([4, 7])
    expect(a.ring).toEqual([3, 5, 8])
    expect(a.ringRule).toBe('a neighbouring cell shares at least one corner with a clicked cell')
    expect(a.pars[1]).toEqual({ parnme: 'pp_1', pargp: 'pp', kind: 'pilot_point', cell: 7, weights: [{ cell: 7, weight: 0.25 }], rule: 'sets this cell (par_cell)' })
    expect(a.parsTotal).toBe(2)
    expect(a.parNotes).toEqual(['a note'])
    expect(a.sites[1]).toEqual({ siteId: 12, site: 'w2', group: 'heads', layer: -1, cell: 5, inClickedCell: false })
    expect(a.sitesTotal).toBe(61)
    expect(a.sitesCap).toBe(50)
    expect(a.siteCounts).toEqual({ unknownLayerIncluded: 1, otherLayerLeftOut: 2, unplacedInRun: 3 })
    expect(a.reasons).toEqual({ pars: null, sites: null })
  })

  it.each(['ring', 'sites_total', 'site_counts', 'pars', 'reasons'])('refuses an answer missing %s and names it', async (name) => {
    const body = answer()
    delete body[name]
    stubAnswer(200, body)

    const result = await fetchLinkCell(2, [4, 7])

    expect(result).toEqual({ ok: false, artifact: 'link/cell', reason: `the link/cell answer is missing ${name}` })
  })

  it('refuses a site entry with no site_id rather than taking its position', async () => {
    const body = answer()
    delete (body.sites as Record<string, unknown>[])[0].site_id
    stubAnswer(200, body)

    const result = await fetchLinkCell(2, [4, 7])

    expect(result).toEqual({ ok: false, artifact: 'link/cell', reason: 'the site entry is missing site_id' })
  })

  it('turns a problem answer into its artifact and reason', async () => {
    stubAnswer(404, { type: 'about:blank', title: 'read failure', status: 404, artifact: 'obs_cell', detail: 'failed to read obs_cell.json' })

    const result = await fetchLinkCell(0, [1])

    expect(result).toEqual({ ok: false, artifact: 'obs_cell', reason: 'failed to read obs_cell.json' })
  })

  it('holds the last answer for exactly the cell set it was for', async () => {
    stubAnswer(200, answer())
    await fetchLinkCell(2, [4, 7])

    expect(recentCellLink(new Set([7, 4]))?.sitesTotal).toBe(61)
    expect(recentCellLink(new Set([4]))).toBeNull()
  })
})
