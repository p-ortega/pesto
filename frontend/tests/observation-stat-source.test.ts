import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObsSiteRow, ObsTimesPayload } from '../src/data/obs'

const mocks = vi.hoisted(() => ({
  fetchObsSites: vi.fn(),
  fetchObsTimes: vi.fn(),
  fetchObsFrame: vi.fn(),
}))

vi.mock('../src/data/obs', () => mocks)

import {
  createObservationStatSource,
  dotsFor,
  type ObsGroupData,
} from '../src/views/observation-stat-source'

function row(over: Partial<ObsSiteRow> & { siteId: number }): ObsSiteRow {
  return {
    site: `site-${over.siteId}`,
    nObs: 1,
    x: 10 * over.siteId,
    y: 5 * over.siteId,
    xySource: 'own',
    layer: 2,
    cell: over.siteId,
    rule: 'name-token',
    note: null,
    ...over,
  }
}

function timesPayload(over: Partial<ObsTimesPayload> = {}): ObsTimesPayload {
  return {
    group: 'g1',
    time_kind: 'numeric',
    steps_by: 'time',
    times: [1, 2, 3],
    n_at_time: [2, 2, 2],
    n_sites: 5,
    iterations: [{ iteration: 0, available: true, reason: null }],
    limits: { resid_mean: [-1, 1], rmse: [0, 1], std: [0, 1], mean: [0, 1] },
    limits_rule: 'fixed per group',
    refused: null,
    notes: [],
    ...over,
  }
}

// A: layer 2 own, B: layer 2 cell centre, C: layer 5, D: layer unknown, E: unplaced.
const SITES: ObsSiteRow[] = [
  row({ siteId: 1, site: 'A' }),
  row({ siteId: 2, site: 'B', xySource: 'cell_centre' }),
  row({ siteId: 3, site: 'C', xySource: 'cell_centre', layer: 5 }),
  row({ siteId: 4, site: 'D', xySource: 'cell_centre', layer: -1 }),
  row({ siteId: 5, site: 'E', xySource: 'none', layer: -1, cell: -1, x: Number.NaN, y: Number.NaN, note: 'no cell holds x, y' }),
]

function groupData(rows: ObsSiteRow[] = SITES): ObsGroupData {
  return {
    group: 'g1',
    rows,
    times: timesPayload(),
    xy: Float32Array.from(rows.flatMap((r) => [r.x, r.y])),
    layer: Int32Array.from(rows.map((r) => r.layer)),
  }
}

beforeEach(() => {
  mocks.fetchObsSites.mockReset()
  mocks.fetchObsTimes.mockReset()
  mocks.fetchObsFrame.mockReset()
})

describe('dotsFor', () => {
  it('draws the layer own sites and counts what is left off and why', () => {
    const dots = dotsFor(groupData(), 2, false)
    expect(Array.from(dots.rows)).toEqual([0, 1])
    expect(dots.counts).toEqual({
      drawn: 2,
      onOtherLayers: 1,
      unknownLayerHidden: 1,
      unplaced: 1,
      own: 1,
      cellCentre: 1,
      unplacedNotes: ['no cell holds x, y'],
    })
    expect(dots.lowestLayer).toBe(2)
    expect(Array.from(dots.xy)).toEqual([10, 5, 20, 10])
  })

  it('draws every placed site under all layers and never an unplaced one', () => {
    const dots = dotsFor(groupData(), 2, true)
    expect(Array.from(dots.rows)).toEqual([0, 1, 2, 3])
    expect(dots.counts.unknownLayerHidden).toBe(0)
    expect(dots.counts.unplaced).toBe(1)
    expect(dots.counts.unplacedNotes).toEqual(['no cell holds x, y'])
    expect(dots.rows.includes(4)).toBe(false)
  })

  it('gives no dots and the lowest layer holding one when the layer is empty', () => {
    const dots = dotsFor(groupData(), 0, false)
    expect(dots.rows.length).toBe(0)
    expect(dots.counts.drawn).toBe(0)
    expect(dots.lowestLayer).toBe(2)
  })

  it('has no lowest layer when no placed site knows its layer', () => {
    const only = [row({ siteId: 1, layer: -1 })]
    expect(dotsFor(groupData(only), 0, true).lowestLayer).toBeNull()
  })

  it('keeps two sites at the same x and y as two dots', () => {
    const twins = [row({ siteId: 1, x: 3, y: 4 }), row({ siteId: 2, x: 3, y: 4 })]
    const dots = dotsFor(groupData(twins), 2, false)
    expect(Array.from(dots.rows)).toEqual([0, 1])
    expect(Array.from(dots.xy)).toEqual([3, 4, 3, 4])
  })

  it('counts a site with a position source but no finite position as unplaced', () => {
    const odd = [row({ siteId: 1, x: Number.NaN })]
    const dots = dotsFor(groupData(odd), 2, true)
    expect(dots.rows.length).toBe(0)
    expect(dots.counts.unplaced).toBe(1)
  })

  it('returns equal dot arrays for the same choice twice', () => {
    const data = groupData()
    const a = dotsFor(data, 2, false)
    const b = dotsFor(data, 2, false)
    expect(Array.from(b.rows)).toEqual(Array.from(a.rows))
    expect(Array.from(b.xy)).toEqual(Array.from(a.xy))
    expect(b.counts).toEqual(a.counts)
  })
})

describe('loadGroup', () => {
  it('turns stubbed sites and times into group data', async () => {
    mocks.fetchObsSites.mockResolvedValue({ ok: true, rows: SITES, notes: [] })
    mocks.fetchObsTimes.mockResolvedValue({ ok: true, payload: timesPayload() })
    const source = createObservationStatSource({ runId: 'run' })
    const answer = await source.loadGroup('g1')
    if (answer.stale || 'failed' in answer) throw new Error('expected data')
    expect(answer.data.group).toBe('g1')
    expect(answer.data.rows).toBe(SITES)
    expect(answer.data.times.times).toEqual([1, 2, 3])
    expect(Array.from(answer.data.layer)).toEqual([2, 2, 5, -1, -1])
    expect(Array.from(answer.data.xy.slice(0, 4))).toEqual([10, 5, 20, 10])
    expect(Number.isNaN(answer.data.xy[8])).toBe(true)
    expect(dotsFor(answer.data, 2, false).counts.drawn).toBe(2)
  })

  it('does not request again when the same choice is made twice', async () => {
    mocks.fetchObsSites.mockResolvedValue({ ok: true, rows: SITES, notes: [] })
    mocks.fetchObsTimes.mockResolvedValue({ ok: true, payload: timesPayload() })
    const source = createObservationStatSource({ runId: 'run' })
    const first = await source.loadGroup('g1')
    const second = await source.loadGroup('g1')
    if (first.stale || second.stale || 'failed' in first || 'failed' in second) throw new Error('expected data')
    expect(mocks.fetchObsSites).toHaveBeenCalledTimes(1)
    expect(second.data).toBe(first.data)
  })

  it('answers the first group stale when a second is asked for while it is in flight', async () => {
    const releases: Array<() => void> = []
    mocks.fetchObsSites.mockImplementation(
      (group: string) =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true, rows: SITES, notes: [] }))
          void group
        }),
    )
    mocks.fetchObsTimes.mockResolvedValue({ ok: true, payload: timesPayload() })
    const source = createObservationStatSource({ runId: 'run' })
    const first = source.loadGroup('g1')
    const second = source.loadGroup('g2')
    releases.forEach((release) => release())
    expect(await first).toEqual({ stale: true })
    const answer = await second
    expect(answer.stale).toBe(false)
  })

  it('aborts the sites request of the group it replaces', async () => {
    const signals: Array<AbortSignal | undefined> = []
    mocks.fetchObsSites.mockImplementation(
      (_group: string, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signals.push(opts?.signal)
          opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const source = createObservationStatSource({ runId: 'run' })
    const first = source.loadGroup('g1')
    void source.loadGroup('g2')
    expect(signals[0]?.aborted).toBe(true)
    expect(await first).toEqual({ stale: true })
  })

  it('comes back failed with the artifact and reason when sites are refused', async () => {
    mocks.fetchObsSites.mockResolvedValue({ ok: false, artifact: 'obs_cell', reason: 'no placement was recorded' })
    const source = createObservationStatSource({ runId: 'run' })
    expect(await source.loadGroup('g1')).toEqual({
      stale: false,
      failed: { artifact: 'obs_cell', reason: 'no placement was recorded' },
    })
    expect(mocks.fetchObsTimes).not.toHaveBeenCalled()
  })

  it('comes back failed when times are refused, and asks again next time', async () => {
    mocks.fetchObsSites.mockResolvedValue({ ok: true, rows: SITES, notes: [] })
    mocks.fetchObsTimes.mockResolvedValue({ ok: false, artifact: 'obs_index', reason: 'group has no times' })
    const source = createObservationStatSource({ runId: 'run' })
    expect(await source.loadGroup('g1')).toEqual({
      stale: false,
      failed: { artifact: 'obs_index', reason: 'group has no times' },
    })
    await source.loadGroup('g1')
    expect(mocks.fetchObsSites).toHaveBeenCalledTimes(2)
  })

  it('refuses a times answer whose rows do not match the sites count', async () => {
    mocks.fetchObsSites.mockResolvedValue({ ok: true, rows: SITES, notes: [] })
    mocks.fetchObsTimes.mockResolvedValue({ ok: true, payload: timesPayload({ n_sites: 9 }) })
    const source = createObservationStatSource({ runId: 'run' })
    const answer = await source.loadGroup('g1')
    if (answer.stale || !('failed' in answer)) throw new Error('expected a failure')
    expect(answer.failed.reason).toContain('5')
    expect(answer.failed.reason).toContain('9')
  })
})
