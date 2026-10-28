import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObsSiteRow, ObsTimesPayload } from '../src/data/obs'

const mocks = vi.hoisted(() => ({
  fetchObsSites: vi.fn(),
  fetchObsTimes: vi.fn(),
  fetchObsFrame: vi.fn(),
}))

vi.mock('../src/data/obs', () => mocks)

import {
  FrameCache,
  carryTime,
  countsAtTime,
  createObservationStatSource,
  dotsFor,
  valuesForDots,
  type ObsGroupData,
} from '../src/views/observation-stat-source'

const DIGEST = 'digest-a'

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
    order_digest: DIGEST,
    time_kind: 'numeric',
    steps_by: 'time',
    times: [1, 2, 3],
    n_at_time: [2, 2, 2],
    n_sites: 5,
    iterations: [{ iteration: 0, available: true, reason: null }],
    limits: { resid_mean: [-1, 1], rmse: [0, 1], std: [0, 1], mean: [0, 1] },
    limits_rule: 'fixed per group',
    limits_refused: null,
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
    orderDigest: DIGEST,
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
    mocks.fetchObsSites.mockResolvedValue({ ok: true, rows: SITES, orderDigest: DIGEST, notes: [] })
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
    mocks.fetchObsSites.mockResolvedValue({ ok: true, rows: SITES, orderDigest: DIGEST, notes: [] })
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
          releases.push(() => resolve({ ok: true, rows: SITES, orderDigest: DIGEST, notes: [] }))
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
    mocks.fetchObsSites.mockResolvedValue({ ok: true, rows: SITES, orderDigest: DIGEST, notes: [] })
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
    mocks.fetchObsSites.mockResolvedValue({ ok: true, rows: SITES, orderDigest: DIGEST, notes: [] })
    mocks.fetchObsTimes.mockResolvedValue({ ok: true, payload: timesPayload({ n_sites: 9 }) })
    const source = createObservationStatSource({ runId: 'run' })
    const answer = await source.loadGroup('g1')
    if (answer.stale || !('failed' in answer)) throw new Error('expected a failure')
    expect(answer.failed.reason).toContain('5')
    expect(answer.failed.reason).toContain('9')
  })

  it('refuses sites and times that were cut from different observation tables', async () => {
    mocks.fetchObsSites.mockResolvedValue({ ok: true, rows: SITES, orderDigest: DIGEST, notes: [] })
    mocks.fetchObsTimes.mockResolvedValue({ ok: true, payload: timesPayload({ order_digest: 'digest-b' }) })
    const source = createObservationStatSource({ runId: 'run' })
    const answer = await source.loadGroup('g1')
    if (answer.stale || !('failed' in answer)) throw new Error('expected a failure')
    expect(answer.failed.artifact).toBe('obs_index')
    expect(answer.failed.reason).toContain('different observation tables')
  })
})

// ---- the frame cache ----

interface Call {
  group: string
  iteration: number
  time: number
  stat: string
  signal: AbortSignal | undefined
  answer: (values?: number[]) => void
  refuse: (reason: string) => void
  fail: (error: unknown) => void
}

// Frames land when the test says so; a frame carries its own time so a mix-up shows in the values.
function stubFrames(ignoreAbort = false): Call[] {
  const calls: Call[] = []
  mocks.fetchObsFrame.mockImplementation(
    (group: string, iteration: number, time: number, stat: string, opts?: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const meta = { group, iteration, time, stat, orderDigest: DIGEST, nSites: 2, nAtTime: 2, nRowsHidden: 1, nFinite: 2 }
        calls.push({
          group,
          iteration,
          time,
          stat,
          signal: opts?.signal,
          answer: (values = [time, time]) => resolve({ ok: true, values: Float32Array.from(values), meta }),
          refuse: (reason) => resolve({ ok: false, artifact: 'obs_agg', reason }),
          fail: reject,
        })
        if (!ignoreAbort) opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
  )
  return calls
}

const TEN = Array.from({ length: 10 }, (_, i) => 100 + i)

function callTimes(calls: Call[]): number[] {
  return calls.map((c) => c.time)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('FrameCache.want', () => {
  it('fetches the wanted time first, then two each side, nearest the low side first', async () => {
    const calls = stubFrames()
    const cache = new FrameCache('run')
    void cache.want('g', DIGEST, 1, TEN, 4, 'resid_mean')
    expect(callTimes(calls)).toEqual([104, 102, 103, 105, 106])
    calls.forEach((c) => c.answer())
    await tick()
    const key = cache.key('g', 1, 105, 'resid_mean', DIGEST)
    expect(Array.from(cache.get(key) ?? [])).toEqual([105, 105])
  })

  it('answers the wanted frame once it lands', async () => {
    const calls = stubFrames()
    const cache = new FrameCache('run')
    const answer = cache.want('g', DIGEST, 1, TEN, 0, 'mean')
    expect(callTimes(calls)).toEqual([100, 101, 102])
    calls.forEach((c) => c.answer())
    const result = await answer
    if (result.stale || 'failed' in result) throw new Error('expected values')
    expect(Array.from(result.values)).toEqual([100, 100])
  })

  it('skips frames already cached or in flight and asks only for the new edge', async () => {
    const calls = stubFrames()
    const cache = new FrameCache('run')
    void cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    calls.slice(0, 2).forEach((c) => c.answer())
    await tick()
    calls.length = 0
    mocks.fetchObsFrame.mockClear()
    void cache.want('g', DIGEST, 1, TEN, 5, 'mean')
    expect(callTimes(calls)).toEqual([107])
    expect(mocks.fetchObsFrame).toHaveBeenCalledTimes(1)
  })

  it('does not abort a request inside the window when a newer frame is wanted', () => {
    const calls = stubFrames()
    const cache = new FrameCache('run')
    void cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    void cache.want('g', DIGEST, 1, TEN, 5, 'mean')
    const byTime = new Map(calls.map((c) => [c.time, c]))
    for (const t of [103, 104, 105, 106]) expect(byTime.get(t)?.signal?.aborted).toBe(false)
    expect(byTime.get(102)?.signal?.aborted).toBe(true)
  })

  it('aborts in-flight requests outside the window and skips indices past the end', () => {
    const calls = stubFrames()
    const cache = new FrameCache('run')
    void cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    const before = calls.length
    void cache.want('g', DIGEST, 1, TEN, 9, 'mean')
    expect(callTimes(calls.slice(before))).toEqual([109, 107, 108])
    for (const call of calls.slice(0, before)) expect(call.signal?.aborted).toBe(true)
    for (const call of calls.slice(before)) expect(call.signal?.aborted).toBe(false)
  })

  it('keeps the in-flight frames that stay inside the window', () => {
    const calls = stubFrames()
    const cache = new FrameCache('run')
    void cache.want('g', DIGEST, 1, TEN, 6, 'mean')
    void cache.want('g', DIGEST, 1, TEN, 9, 'mean')
    const byTime = new Map(calls.map((c) => [c.time, c]))
    expect(byTime.get(107)?.signal?.aborted).toBe(false)
    expect(byTime.get(108)?.signal?.aborted).toBe(false)
    expect(byTime.get(104)?.signal?.aborted).toBe(true)
  })

  it('evicts the frame farthest from the wanted index when more than 12 are cached', async () => {
    const calls = stubFrames()
    const cache = new FrameCache('run')
    const times = Array.from({ length: 20 }, (_, i) => i)
    for (const index of [0, 3, 6, 9, 12]) {
      void cache.want('g', DIGEST, 1, times, index, 'mean')
      calls.splice(0).forEach((c) => c.answer())
      await tick()
    }
    const held = times.filter((t) => cache.get(cache.key('g', 1, t, 'mean', DIGEST)) !== undefined)
    expect(held).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  })

  it('never caches a failed frame, and the next want asks for it again', async () => {
    const calls = stubFrames()
    const cache = new FrameCache('run')
    const first = cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    calls.find((c) => c.time === 104)?.refuse('no obs_agg for iteration 1')
    expect(await first).toEqual({ stale: false, failed: { artifact: 'obs_agg', reason: 'no obs_agg for iteration 1' } })
    expect(cache.get(cache.key('g', 1, 104, 'mean', DIGEST))).toBeUndefined()
    calls.length = 0
    void cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    expect(callTimes(calls)).toContain(104)
  })

  it('does not cache a prefetch that failed, and asks again later', async () => {
    const calls = stubFrames()
    const cache = new FrameCache('run')
    void cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    calls.find((c) => c.time === 105)?.fail(new Error('network down'))
    await tick()
    calls.length = 0
    void cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    expect(callTimes(calls)).toEqual([105])
  })

  it('throws a real failure of the wanted frame while it is still wanted', async () => {
    const calls = stubFrames()
    const cache = new FrameCache('run')
    const answer = cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    calls.find((c) => c.time === 104)?.fail(new Error('server fell over'))
    await expect(answer).rejects.toThrow('server fell over')
  })

  it('answers stale when overtaken, but keeps the frame that lands later', async () => {
    const calls = stubFrames(true)
    const cache = new FrameCache('run')
    const first = cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    void cache.want('g', DIGEST, 1, TEN, 8, 'mean')
    // The answer was already on the wire when the request was aborted.
    calls.find((c) => c.time === 104)?.answer()
    expect(await first).toEqual({ stale: true })
    expect(cache.get(cache.key('g', 1, 104, 'mean', DIGEST))).toBeDefined()
  })

  it('answers stale and caches nothing when the abort wins', async () => {
    stubFrames()
    const cache = new FrameCache('run')
    const first = cache.want('g', DIGEST, 1, TEN, 0, 'mean')
    void cache.want('g', DIGEST, 1, TEN, 9, 'mean')
    expect(await first).toEqual({ stale: true })
    expect(cache.get(cache.key('g', 1, 100, 'mean', DIGEST))).toBeUndefined()
  })

  it('makes no request for a frame that is wanted again once cached', async () => {
    const calls = stubFrames()
    const cache = new FrameCache('run')
    const first = cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    calls.splice(0).forEach((c) => c.answer())
    await first
    mocks.fetchObsFrame.mockClear()
    const again = await cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    expect(again.stale).toBe(false)
    expect(mocks.fetchObsFrame).not.toHaveBeenCalled()
  })

  it('keys differ by group, iteration, time and statistic', () => {
    const cache = new FrameCache('run')
    const keys = [
      cache.key('a', 1, 5, 'mean', DIGEST),
      cache.key('b', 1, 5, 'mean', DIGEST),
      cache.key('a', 2, 5, 'mean', DIGEST),
      cache.key('a', 1, 6, 'mean', DIGEST),
      cache.key('a', 1, 5, 'std', DIGEST),
    ]
    expect(new Set(keys).size).toBe(5)
  })

  it('does not mix up two groups when a name holds the key separator', () => {
    const cache = new FrameCache('run')
    expect(cache.key('a|1', 2, 5, 'mean', DIGEST)).not.toBe(cache.key('a', 1, 2, 'mean', DIGEST))
  })

  it('refuses a frame whose own meta names another time', async () => {
    mocks.fetchObsFrame.mockImplementation(async (group: string, iteration: number, time: number, stat: string) => ({
      ok: true,
      values: Float32Array.from([1, 2]),
      meta: { group, iteration, time: time + 1, stat, orderDigest: DIGEST, nSites: 2, nAtTime: 2, nRowsHidden: 1, nFinite: 2 },
    }))
    const cache = new FrameCache('run')
    const result = await cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    if (result.stale || !('failed' in result)) throw new Error('expected a failure')
    expect(result.failed.reason).toContain('time')
    expect(cache.get(cache.key('g', 1, 104, 'mean', DIGEST))).toBeUndefined()
  })

  it('refuses a frame cut for another observation table than the sites, and keeps nothing', async () => {
    mocks.fetchObsFrame.mockImplementation(async (group: string, iteration: number, time: number, stat: string) => ({
      ok: true,
      values: Float32Array.from([1, 2]),
      meta: { group, iteration, time, stat, orderDigest: 'digest-b', nSites: 2, nAtTime: 2, nRowsHidden: 1, nFinite: 2 },
    }))
    const cache = new FrameCache('run')
    const result = await cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    if (result.stale || !('failed' in result)) throw new Error('expected a failure')
    expect(result.failed.reason).toContain('different observation table')
    expect(cache.get(cache.key('g', 1, 104, 'mean', DIGEST))).toBeUndefined()
  })

  it('keeps frames of two observation tables apart', () => {
    const cache = new FrameCache('run')
    expect(cache.key('g', 1, 5, 'mean', 'digest-a')).not.toBe(cache.key('g', 1, 5, 'mean', 'digest-b'))
  })

  it('refuses a position that is not in the times', async () => {
    stubFrames()
    const cache = new FrameCache('run')
    const result = await cache.want('g', DIGEST, 1, TEN, 10, 'mean')
    expect('failed' in result).toBe(true)
    expect(mocks.fetchObsFrame).not.toHaveBeenCalled()
  })

  it('clear aborts what is out and forgets what is held', async () => {
    const calls = stubFrames()
    const cache = new FrameCache('run')
    const first = cache.want('g', DIGEST, 1, TEN, 4, 'mean')
    calls.find((c) => c.time === 105)?.answer()
    await tick()
    cache.clear()
    expect(calls.filter((c) => c.time !== 105).every((c) => c.signal?.aborted)).toBe(true)
    expect(cache.get(cache.key('g', 1, 105, 'mean', DIGEST))).toBeUndefined()
    expect(await first).toEqual({ stale: true })
  })
})

const describeTime = (kind: string, value: number): string => `day ${value} (${kind === 'numeric' ? 'model time' : kind})`

describe('carryTime', () => {
  it('keeps the same time value when the new group has it and the same kind', () => {
    const carried = carryTime({ kind: 'numeric', times: [1, 9, 10], index: 1 }, { kind: 'numeric', times: [5, 9] }, describeTime)
    expect(carried).toEqual({ index: 1, note: null })
  })

  it('finds the value by what it is, not by where it was', () => {
    const carried = carryTime({ kind: 'numeric', times: [1, 2, 3, 9], index: 3 }, { kind: 'numeric', times: [9, 20] }, describeTime)
    expect(carried).toEqual({ index: 0, note: null })
  })

  it('goes to the first time and says so when the new group lacks the value', () => {
    const carried = carryTime({ kind: 'numeric', times: [1, 9], index: 1 }, { kind: 'numeric', times: [2, 3] }, describeTime)
    expect(carried).toEqual({
      index: 0,
      note: 'this group has no observation at day 9 (model time), so the slider moved to its first time',
    })
  })

  it('never carries a time across two time kinds even when the number is there', () => {
    const carried = carryTime(
      { kind: 'numeric', times: [18262], index: 0 },
      { kind: 'datetime', times: [18000, 18262] },
      describeTime,
    )
    expect(carried.index).toBe(0)
    expect(carried.note).toContain('count time differently')
  })

  it('does not carry an ordinal position into another ordinal group', () => {
    const kind = 'ordinal (no time found)'
    const carried = carryTime({ kind, times: [0, 1, 2], index: 2 }, { kind, times: [0, 1, 2, 3] }, describeTime)
    expect(carried.index).toBe(0)
    expect(carried.note).not.toBeNull()
  })

  it('starts at the first time with nothing to carry and no note', () => {
    expect(carryTime(null, { kind: 'numeric', times: [4, 5] }, describeTime)).toEqual({ index: 0, note: null })
  })

  it('starts at the first time when the previous index points at no time', () => {
    const carried = carryTime({ kind: 'numeric', times: [], index: 0 }, { kind: 'numeric', times: [4] }, describeTime)
    expect(carried).toEqual({ index: 0, note: null })
  })

  it('says a group with no times has nothing to show', () => {
    expect(carryTime({ kind: 'numeric', times: [1], index: 0 }, { kind: 'numeric', times: [] }, describeTime)).toEqual({
      index: -1,
      note: 'this group has no time to show',
    })
    expect(carryTime(null, { kind: 'numeric', times: [] }, describeTime).index).toBe(-1)
  })
})

describe('valuesForDots', () => {
  it('picks frame values by the dots site rows', () => {
    const dots = dotsFor(groupData(), 2, true)
    const picked = valuesForDots(Float32Array.from([10, 11, 12, 13, 14]), dots)
    expect(Array.from(picked)).toEqual([10, 11, 12, 13])
  })

  it('says so when a dot points past the end of the frame', () => {
    const dots = dotsFor(groupData(), 2, true)
    expect(() => valuesForDots(Float32Array.from([1, 2]), dots)).toThrow(/2 values/)
  })
})

describe('countsAtTime', () => {
  it('keeps sites with an observation but no value apart from sites with a value', () => {
    const rows = [row({ siteId: 1 }), row({ siteId: 2 }), row({ siteId: 3 }), row({ siteId: 4 })]
    const dots = dotsFor(groupData(rows), 2, false)
    const counts = countsAtTime(Float32Array.from([1, Number.NaN, 2, Number.NaN]), dots, 3)
    expect(counts).toEqual({ withValue: 2, withObservationNoValue: 1, rowsHidden: 0, total: 4 })
  })

  it('counts only the dots that are drawn', () => {
    const dots = dotsFor(groupData(), 2, false)
    const counts = countsAtTime(Float32Array.from([1, Number.NaN, 5, 6, 7]), dots, 4)
    expect(counts.withValue).toBe(1)
    expect(counts.total).toBe(2)
  })

  it('has no site with an observation and no value when every observed site has a value', () => {
    const rows = [row({ siteId: 1 }), row({ siteId: 2 })]
    const dots = dotsFor(groupData(rows), 2, false)
    expect(countsAtTime(Float32Array.from([1, 2]), dots, 2)).toEqual({ withValue: 2, withObservationNoValue: 0, rowsHidden: 0, total: 2 })
  })
})

describe('rows hidden by a later row', () => {
  it('is counted into the time counts as given', () => {
    const dots = dotsFor(groupData([row({ siteId: 1 }), row({ siteId: 2 })]), 2, false)
    expect(countsAtTime(Float32Array.from([1, 2]), dots, 2, 3).rowsHidden).toBe(3)
  })

  it('travels with a held frame and reads 0 for an array the cache never held', async () => {
    const calls = stubFrames()
    const cache = new FrameCache('run')
    const answer = cache.want('g', DIGEST, 1, TEN, 0, 'mean')
    calls.forEach((c) => c.answer())
    const result = await answer
    if (result.stale || 'failed' in result) throw new Error('expected values')
    expect(cache.rowsHiddenIn(result.values)).toBe(1)
    expect(cache.rowsHiddenIn(new Float32Array(2))).toBe(0)
  })
})

describe('createObservationStatSource', () => {
  it('holds a frame cache for its run', () => {
    const source = createObservationStatSource({ runId: 'run' })
    expect(source.frames).toBeInstanceOf(FrameCache)
  })
})
