// The data half of the map's observation colouring: which sites of a group are dots on a layer,
// the frames that colour them, and how the time carries across a group change. It draws nothing
// and imports no view or ui module, so a view may use it.

import {
  fetchObsSites,
  fetchObsTimes,
  type ObsSiteRow,
  type ObsTimesPayload,
} from '../data/obs'
import { LatestWins } from '../data/latest-wins'
import { fetchKey } from '../data/run'

export interface ObsFailure {
  artifact: string
  reason: string
}

export interface ObsGroupData {
  group: string
  rows: ObsSiteRow[]
  times: ObsTimesPayload
  /** x, y of each site row; NaN, NaN where the site is unplaced. */
  xy: Float32Array
  /** Layer of each site row; -1 where it is unknown. */
  layer: Int32Array
}

export type GroupAnswer = { stale: true } | { stale: false; data: ObsGroupData } | { stale: false; failed: ObsFailure }

export interface ObsDotCounts {
  drawn: number
  onOtherLayers: number
  /** Placed sites whose layer is unknown, left off because one layer is shown. */
  unknownLayerHidden: number
  unplaced: number
  own: number
  cellCentre: number
  unplacedNotes: string[]
}

export interface ObsDots {
  /** Site row of each dot. */
  rows: Int32Array
  xy: Float32Array
  counts: ObsDotCounts
  /** The lowest layer holding a placed site with a known layer, whatever layer is shown. */
  lowestLayer: number | null
}

export interface ObservationStatSource {
  loadGroup(group: string): Promise<GroupAnswer>
}

function hasPosition(xy: Float32Array, row: number): boolean {
  return Number.isFinite(xy[2 * row]) && Number.isFinite(xy[2 * row + 1])
}

/**
 * One dot per placed site. Unplaced sites are never dots and are counted with their notes. A site
 * with an unknown layer is a dot only under "all layers".
 */
export function dotsFor(data: ObsGroupData, layer: number, allLayers: boolean): ObsDots {
  const rows: number[] = []
  const counts: ObsDotCounts = {
    drawn: 0,
    onOtherLayers: 0,
    unknownLayerHidden: 0,
    unplaced: 0,
    own: 0,
    cellCentre: 0,
    unplacedNotes: [],
  }
  let lowestLayer: number | null = null
  for (let i = 0; i < data.rows.length; i++) {
    const site = data.rows[i]
    if (site.xySource === 'none' || !hasPosition(data.xy, i)) {
      counts.unplaced += 1
      if (site.note !== null && !counts.unplacedNotes.includes(site.note)) counts.unplacedNotes.push(site.note)
      continue
    }
    const siteLayer = data.layer[i]
    if (siteLayer >= 0 && (lowestLayer === null || siteLayer < lowestLayer)) lowestLayer = siteLayer
    if (!allLayers) {
      if (siteLayer < 0) {
        counts.unknownLayerHidden += 1
        continue
      }
      if (siteLayer !== layer) {
        counts.onOtherLayers += 1
        continue
      }
    }
    rows.push(i)
    if (site.xySource === 'own') counts.own += 1
    else counts.cellCentre += 1
  }
  counts.drawn = rows.length
  const xy = new Float32Array(2 * rows.length)
  rows.forEach((row, k) => {
    xy[2 * k] = data.xy[2 * row]
    xy[2 * k + 1] = data.xy[2 * row + 1]
  })
  return { rows: Int32Array.from(rows), xy, counts, lowestLayer }
}

type Loaded = { ok: true; data: ObsGroupData } | { ok: false; failed: ObsFailure }

function dataOf(group: string, rows: ObsSiteRow[], times: ObsTimesPayload): ObsGroupData {
  const xy = new Float32Array(2 * rows.length)
  const layer = new Int32Array(rows.length)
  rows.forEach((site, i) => {
    const placed = site.xySource !== 'none'
    xy[2 * i] = placed ? site.x : Number.NaN
    xy[2 * i + 1] = placed ? site.y : Number.NaN
    layer[i] = site.layer
  })
  return { group, rows, times, xy, layer }
}

export function createObservationStatSource(opts: { runId: string | null }): ObservationStatSource {
  const slot = new LatestWins<Loaded>()
  let loaded: { key: string; data: ObsGroupData } | null = null

  async function loadGroup(group: string): Promise<GroupAnswer> {
    const key = fetchKey(opts.runId, 'obs-group', group)
    if (loaded !== null && loaded.key === key) {
      // The same choice again is no new request; it also makes any group still loading stale.
      slot.cancel()
      return { stale: false, data: loaded.data }
    }
    const answer = await slot.run(key, async (signal): Promise<Loaded> => {
      const sites = await fetchObsSites(group, { signal })
      if (!sites.ok) return { ok: false, failed: { artifact: sites.artifact, reason: sites.reason } }
      const times = await fetchObsTimes(group, { signal })
      if (!times.ok) return { ok: false, failed: { artifact: times.artifact, reason: times.reason } }
      const payload = times.payload
      // Frame entry i belongs to sites row i, so a different count would colour the wrong dots.
      if (payload.refused === null && payload.n_sites !== sites.rows.length) {
        return {
          ok: false,
          failed: {
            artifact: 'obs_index',
            reason: `the sites table has ${sites.rows.length} rows but the times answer says ${payload.n_sites} sites`,
          },
        }
      }
      return { ok: true, data: dataOf(group, sites.rows, payload) }
    })
    if (answer.stale) return { stale: true }
    if (!answer.value.ok) return { stale: false, failed: answer.value.failed }
    loaded = { key, data: answer.value.data }
    return { stale: false, data: answer.value.data }
  }

  return { loadGroup }
}
