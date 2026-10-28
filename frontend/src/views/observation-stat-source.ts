// The data half of the map's observation colouring: which sites of a group are dots on a layer,
// the frames that colour them, and how the time carries across a group change. It draws nothing
// and imports no view or ui module, so a view may use it.

import {
  fetchObsFrame,
  fetchObsSites,
  fetchObsTimes,
  type ObsSiteRow,
  type ObsStat,
  type ObsTimesPayload,
} from '../data/obs'
import { LatestWins, isAbortError } from '../data/latest-wins'
import { fetchKey } from '../data/run'

export interface ObsFailure {
  artifact: string
  reason: string
}

export interface ObsGroupData {
  group: string
  /** The observation table the sites and times were cut from; every frame must carry it too. */
  orderDigest: string
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

export type FrameAnswer = { stale: true } | { stale: false; values: Float32Array } | { stale: false; failed: ObsFailure }

export interface ObservationStatSource {
  loadGroup(group: string): Promise<GroupAnswer>
  frames: FrameCache
}

// Two frames each side of the wanted one are fetched ahead; 12 held is room for a short scrub back.
const WINDOW_RADIUS = 2
const MAX_FRAMES = 12

interface FrameSpec {
  group: string
  orderDigest: string
  iteration: number
  time: number
  stat: ObsStat
}

type Outcome =
  | { kind: 'values'; values: Float32Array }
  | { kind: 'failed'; failed: ObsFailure }
  | { kind: 'aborted' }
  | { kind: 'error'; error: unknown }

interface InFlight {
  controller: AbortController
  promise: Promise<Outcome>
}

interface Held extends FrameSpec {
  values: Float32Array
}

/**
 * Frames by run, group, iteration, time and statistic. Not a LatestWins slot: that would cancel
 * the prefetch. Only a request that leaves the window is aborted, and a failure is never kept.
 */
export class FrameCache {
  private readonly held = new Map<string, Held>()
  private readonly inFlight = new Map<string, InFlight>()
  private wantedKey: string | null = null
  private current: { group: string; orderDigest: string; iteration: number; stat: ObsStat; times: readonly number[]; index: number } | null = null
  private generation = 0

  constructor(private readonly runId: string | null) {}

  key(group: string, iteration: number, time: number, stat: string, orderDigest: string): string {
    // A group name may hold the separator, so it travels encoded.
    return fetchKey(this.runId, encodeURIComponent(group), orderDigest, iteration, time, stat)
  }

  get(key: string): Float32Array | undefined {
    return this.held.get(key)?.values
  }

  clear(): void {
    this.generation += 1
    this.wantedKey = null
    this.current = null
    for (const entry of this.inFlight.values()) entry.controller.abort()
    this.inFlight.clear()
    this.held.clear()
  }

  /**
   * Fetches the frame at `times[index]` if it is not held, then the ones around it. Answers stale
   * when a newer frame was wanted meanwhile; the landed frame stays held either way.
   */
  async want(
    group: string,
    orderDigest: string,
    iteration: number,
    times: readonly number[],
    index: number,
    stat: ObsStat,
  ): Promise<FrameAnswer> {
    if (!Number.isInteger(index) || index < 0 || index >= times.length) {
      return { stale: false, failed: { artifact: 'obs_agg', reason: `this group has no time at position ${index} of ${times.length}` } }
    }
    const wantedKey = this.key(group, iteration, times[index], stat, orderDigest)
    this.wantedKey = wantedKey
    this.current = { group, orderDigest, iteration, stat, times, index }

    const order = [index, index - 2, index - 1, index + 1, index + 2].filter((i) => i >= 0 && i < times.length)
    const inWindow = new Set(order.map((i) => this.key(group, iteration, times[i], stat, orderDigest)))
    for (const [key, entry] of this.inFlight) {
      if (inWindow.has(key)) continue
      entry.controller.abort()
      this.inFlight.delete(key)
    }
    for (const i of order) {
      const key = this.key(group, iteration, times[i], stat, orderDigest)
      if (!this.held.has(key) && !this.inFlight.has(key)) this.launch(key, { group, orderDigest, iteration, time: times[i], stat })
    }
    this.evict()

    const held = this.held.get(wantedKey)
    const outcome: Outcome = held ? { kind: 'values', values: held.values } : await this.inFlight.get(wantedKey)!.promise
    if (this.wantedKey !== wantedKey) return { stale: true }
    if (outcome.kind === 'values') return { stale: false, values: outcome.values }
    if (outcome.kind === 'failed') return { stale: false, failed: outcome.failed }
    if (outcome.kind === 'error') throw outcome.error
    return { stale: true }
  }

  private launch(key: string, spec: FrameSpec): void {
    const controller = new AbortController()
    const generation = this.generation
    const entry: InFlight = { controller, promise: undefined as unknown as Promise<Outcome> }
    this.inFlight.set(key, entry)
    entry.promise = (async (): Promise<Outcome> => {
      try {
        const result = await fetchObsFrame(spec.group, spec.iteration, spec.time, spec.stat, { signal: controller.signal })
        if (!result.ok) return { kind: 'failed', failed: { artifact: result.artifact, reason: result.reason } }
        const meta = result.meta
        if (meta.orderDigest !== spec.orderDigest) {
          return {
            kind: 'failed',
            failed: {
              artifact: 'obs_index',
              reason: 'the frame was cut for a different observation table than the sites on the map; choose the group again or reload the page',
            },
          }
        }
        if (meta.group !== spec.group || meta.iteration !== spec.iteration || meta.time !== spec.time || meta.stat !== spec.stat) {
          return {
            kind: 'failed',
            failed: {
              artifact: 'obs_agg',
              reason: `asked for ${spec.stat} at time ${spec.time} of iteration ${spec.iteration} but the answer was for ${meta.stat} at time ${meta.time} of iteration ${meta.iteration}`,
            },
          }
        }
        // A frame that lands after clear() belongs to a cache that was emptied on purpose.
        if (generation === this.generation) {
          this.held.set(key, { ...spec, values: result.values })
          this.evict()
        }
        return { kind: 'values', values: result.values }
      } catch (error) {
        return isAbortError(error) ? { kind: 'aborted' } : { kind: 'error', error }
      } finally {
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key)
      }
    })()
  }

  // Distance in slider steps from the wanted time; a frame of another group, iteration or statistic is farthest.
  private distance(frame: Held): number {
    const now = this.current
    if (now === null || frame.group !== now.group || frame.orderDigest !== now.orderDigest || frame.iteration !== now.iteration || frame.stat !== now.stat) return Infinity
    const position = now.times.indexOf(frame.time)
    return position < 0 ? Infinity : Math.abs(position - now.index)
  }

  private evict(): void {
    while (this.held.size > MAX_FRAMES) {
      let farthest: string | null = null
      let most = -1
      for (const [key, frame] of this.held) {
        const d = this.distance(frame)
        if (d > most) {
          most = d
          farthest = key
        }
      }
      if (farthest === null) return
      this.held.delete(farthest)
    }
  }
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

/** The frame's value for each dot, in dot order. */
export function valuesForDots(frame: Float32Array, dots: ObsDots): Float32Array {
  const out = new Float32Array(dots.rows.length)
  for (let k = 0; k < dots.rows.length; k++) {
    const row = dots.rows[k]
    if (row >= frame.length) throw new Error(`the frame has ${frame.length} values but a dot belongs to site row ${row + 1}`)
    out[k] = frame[row]
  }
  return out
}

export interface TimeCounts {
  /** Dots whose site has a finite value in the frame. */
  withValue: number
  /** Sites of the whole group with an observation at this time but no finite value; n_at_time is not split by layer. */
  withObservationNoValue: number
  total: number
}

export function countsAtTime(frame: Float32Array, dots: ObsDots, nAtTime: number): TimeCounts {
  let withValue = 0
  for (let k = 0; k < dots.rows.length; k++) {
    if (Number.isFinite(frame[dots.rows[k]])) withValue += 1
  }
  let finiteInFrame = 0
  for (let i = 0; i < frame.length; i++) {
    if (Number.isFinite(frame[i])) finiteInFrame += 1
  }
  return { withValue, withObservationNoValue: Math.max(0, nAtTime - finiteInFrame), total: dots.rows.length }
}

export interface TimePosition {
  kind: string
  times: readonly number[]
  index: number
}

// Only these two kinds hold a time whose number means the same thing in every group; an ordinal axis is a position.
const CARRYABLE_KINDS = ['numeric', 'datetime']

/**
 * Where the slider goes when the group changes. The same time value is kept only when both groups
 * have it and count time the same way; a slider index is never reused as a position.
 */
export function carryTime(
  previous: TimePosition | null,
  next: { kind: string; times: readonly number[] },
  describe: (kind: string, value: number) => string,
): { index: number; note: string | null } {
  if (next.times.length === 0) return { index: -1, note: 'this group has no time to show' }
  const value = previous === null ? undefined : previous.times[previous.index]
  if (previous === null || value === undefined) return { index: 0, note: null }
  if (previous.kind !== next.kind || !CARRYABLE_KINDS.includes(next.kind)) {
    return {
      index: 0,
      note: `the two groups count time differently (${previous.kind} and ${next.kind}), so the slider moved to this group's first time`,
    }
  }
  const found = next.times.indexOf(value)
  if (found >= 0) return { index: found, note: null }
  return { index: 0, note: `this group has no observation at ${describe(previous.kind, value)}, so the slider moved to its first time` }
}

type Loaded ={ ok: true; data: ObsGroupData } | { ok: false; failed: ObsFailure }

function dataOf(group: string, orderDigest: string, rows: ObsSiteRow[], times: ObsTimesPayload): ObsGroupData {
  const xy = new Float32Array(2 * rows.length)
  const layer = new Int32Array(rows.length)
  rows.forEach((site, i) => {
    const placed = site.xySource !== 'none'
    xy[2 * i] = placed ? site.x : Number.NaN
    xy[2 * i + 1] = placed ? site.y : Number.NaN
    layer[i] = site.layer
  })
  return { group, orderDigest, rows, times, xy, layer }
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
      // Frame entry i belongs to sites row i, so another table or a different count would colour the wrong dots.
      if (payload.order_digest !== sites.orderDigest) {
        return {
          ok: false,
          failed: {
            artifact: 'obs_index',
            reason: 'the sites and the times were cut from different observation tables; choose the group again or reload the page',
          },
        }
      }
      if (payload.refused === null && payload.n_sites !== sites.rows.length) {
        return {
          ok: false,
          failed: {
            artifact: 'obs_index',
            reason: `the sites table has ${sites.rows.length} rows but the times answer says ${payload.n_sites} sites`,
          },
        }
      }
      return { ok: true, data: dataOf(group, sites.orderDigest, sites.rows, payload) }
    })
    if (answer.stale) return { stale: true }
    if (!answer.value.ok) return { stale: false, failed: answer.value.failed }
    loaded = { key, data: answer.value.data }
    return { stale: false, data: answer.value.data }
  }

  return { loadGroup, frames: new FrameCache(opts.runId) }
}
