// The overlay data half: answers for the shown iteration only, one hatch mask for the drawn
// group and layer, the dots to flag, and words for both toggles with every left-out item counted.

import { describe, expect, it, vi } from 'vitest'
import { HATCH_AT_BOUNDS, HATCH_CONFLICT } from '../src/data/hatch-mask'
import type { AtBoundsAnswer, AtBoundsResult, PdcSitesAnswer, PdcSitesResult } from '../src/data/overlays'
import type { ParIdentity } from '../src/data/parmap'
import type { OverlayStatus } from '../src/ui/overlay-controls'
import { createOverlaySource, type OverlayInputs } from '../src/views/overlay-source'

function atBounds(iteration: number, extra: Partial<AtBoundsAnswer> = {}): AtBoundsResult {
  return {
    ok: true,
    answer: {
      available: true,
      reason: null,
      artifact: 'par_change',
      iteration,
      firstIteration: 0,
      lastIteration: 3,
      rule: 'near a bound by pestpp rule',
      caveat: 'can be one high against pcs.csv',
      groups: [{ group: 'hk', nPar: 6, nCounted: 5, nAtBounds: 4, nExcluded: { fixed: 1, tied: 0 } }],
      names: ['hk_a', 'hk_b', 'hk_c', 'hk_gone'],
      ...extra,
    },
  }
}

function pdc(iteration: number, extra: Partial<PdcSitesAnswer> = {}): PdcSitesResult {
  return {
    ok: true,
    answer: {
      available: true,
      reason: null,
      artifact: `pdc/${iteration}`,
      iteration,
      source: 'computed',
      sourceFile: null,
      weightsSource: 'obs weights',
      rule: 'a site is conflicted when any of its observations is',
      nObs: 9,
      nSites: 5,
      nUnmatched: 2,
      nLeftOut: 1,
      byGroup: [
        { group: 'heads', nObs: 6, nSites: 3 },
        { group: 'conc', nObs: 3, nSites: 2 },
      ],
      // Sites 10, 11 heads layer 0; 12 heads layer 1; 13 conc layer 0; 14 conc unknown layer.
      sites: {
        id: Int32Array.from([10, 11, 12, 13, 14]),
        cell: Int32Array.from([0, 2, 5, 1, 3]),
        layer: Int32Array.from([0, 0, 1, 0, -1]),
        groupIndex: Int32Array.from([0, 0, 0, 1, 1]),
        nObs: Int32Array.from([2, 2, 2, 2, 1]),
      },
      groups: ['heads', 'conc'],
      notes: [],
      ...extra,
    },
  }
}

const id = (parnme: string, pargp = 'hk'): ParIdentity => ({ parnme, pargp, partrans: 'log' })

// Rows: hk_a cell 0 layer 0, hk_b cell 1 layer 0, hk_c cell 4 layer 1, hk_d unplaced, hk_e cell 2.
const JOINED = [id('hk_a'), id('hk_b'), id('hk_c'), id('hk_d'), id('hk_e')]
const CELLS = Int32Array.from([0, 1, 4, -1, 2])
const LAYERS = Int32Array.from([0, 0, 1, 0, 0])

function inputs(extra: Partial<OverlayInputs> = {}): OverlayInputs {
  return {
    nCells: 6,
    layer: 0,
    allLayers: false,
    colourSource: 'par',
    parGroup: 'hk',
    joined: JOINED,
    cellArray: CELLS,
    layerArray: LAYERS,
    pointRows: null,
    obsGroup: null,
    dotSiteIds: null,
    ...extra,
  }
}

const BOTH = { atBounds: true, conflict: true }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function loaded(at: AtBoundsResult = atBounds(3), conflict: PdcSitesResult = pdc(3), iteration = 3, group: string | null = 'hk') {
  const source = createOverlaySource({ loadAtBounds: async () => at, loadPdc: async () => conflict })
  expect(await source.load(iteration, group)).toEqual({ stale: false })
  return source
}

function title(status: OverlayStatus): string {
  if (status.kind !== 'shown') throw new Error(`status is ${status.kind}`)
  return status.title
}

function label(status: OverlayStatus): string {
  if (status.kind !== 'shown') throw new Error(`status is ${status.kind}`)
  return status.label
}

describe('createOverlaySource load', () => {
  it('asks each route once for the shown iteration and group, and not again while they are out', async () => {
    const a = deferred<AtBoundsResult>()
    const p = deferred<PdcSitesResult>()
    const loadAtBounds = vi.fn((_iteration: number, _group?: string) => a.promise)
    const loadPdc = vi.fn((_iteration: number) => p.promise)
    const source = createOverlaySource({ loadAtBounds, loadPdc })
    const first = source.load(3, 'hk')
    const second = source.load(3, 'hk')
    expect(loadAtBounds).toHaveBeenCalledTimes(1)
    expect(loadAtBounds.mock.calls[0].slice(0, 2)).toEqual([3, 'hk'])
    expect(loadPdc).toHaveBeenCalledTimes(1)
    expect(loadPdc.mock.calls[0][0]).toBe(3)
    a.resolve(atBounds(3))
    p.resolve(pdc(3))
    expect(await first).toEqual({ stale: false })
    expect(await second).toEqual({ stale: false })
    await source.load(3, 'hk')
    expect(loadAtBounds).toHaveBeenCalledTimes(1)
  })

  it('drops the answers for an iteration the map has left, and never builds from them', async () => {
    const old = { a: deferred<AtBoundsResult>(), p: deferred<PdcSitesResult>() }
    const now = { a: deferred<AtBoundsResult>(), p: deferred<PdcSitesResult>() }
    const loadAtBounds = vi.fn((iteration: number) => (iteration === 3 ? old.a.promise : now.a.promise))
    const loadPdc = vi.fn((iteration: number) => (iteration === 3 ? old.p.promise : now.p.promise))
    const source = createOverlaySource({ loadAtBounds, loadPdc })
    const three = source.load(3, 'hk')
    const four = source.load(4, 'hk')
    old.a.resolve(atBounds(3))
    old.p.resolve(pdc(3))
    expect(await three).toEqual({ stale: true })
    let built = source.build(inputs(), BOTH)
    expect(built.atBounds).toEqual({ kind: 'loading' })
    expect(built.conflict).toEqual({ kind: 'loading' })
    expect(built.mask).toBeNull()
    now.a.resolve(atBounds(4, { names: ['hk_b'], groups: [{ group: 'hk', nPar: 6, nCounted: 6, nAtBounds: 1, nExcluded: {} }] }))
    now.p.resolve(pdc(4))
    expect(await four).toEqual({ stale: false })
    built = source.build(inputs(), BOTH)
    expect(label(built.atBounds)).toBe('45° at bounds: 1 parameter')
  })

  it('turns a thrown loader error into a reason instead of losing it', async () => {
    const source = createOverlaySource({
      loadAtBounds: async () => {
        throw new Error('network down')
      },
      loadPdc: async () => pdc(3),
    })
    expect(await source.load(3, 'hk')).toEqual({ stale: false })
    const built = source.build(inputs(), BOTH)
    expect(built.atBounds).toEqual({ kind: 'off', reason: 'par_change: network down' })
    expect(built.conflict.kind).toBe('shown')
  })

  it('shows loading before any answer is held', () => {
    const source = createOverlaySource({ loadAtBounds: async () => atBounds(3), loadPdc: async () => pdc(3) })
    const built = source.build(inputs(), BOTH)
    expect(built).toEqual({
      mask: null,
      atBoundsDots: new Set(),
      conflictDots: new Set(),
      atBounds: { kind: 'loading' },
      conflict: { kind: 'loading' },
    })
  })
})

describe('the at-bounds overlay', () => {
  it('hatches the named parameters on the drawn layer and counts the rest in the title', async () => {
    const source = await loaded()
    const built = source.build(inputs({ pointRows: Int32Array.from([1, 2, 4, 0]) }), { atBounds: true, conflict: false })
    expect(built.mask).not.toBeNull()
    const mask = built.mask as Uint8Array
    expect([...mask].map((v) => v & HATCH_AT_BOUNDS)).toEqual([1, 1, 0, 0, 0, 0])
    expect(label(built.atBounds)).toBe('45° at bounds: 4 parameters')
    const t = title(built.atBounds)
    expect(t).toContain('near a bound by pestpp rule')
    expect(t).toContain('can be one high against pcs.csv')
    expect(t).toContain('1 fixed')
    expect(t).not.toContain('0 tied')
    expect(t).toContain('1 on another layer')
    expect(t).toContain('1 not in the parameter table')
    // Dots 0 and 3 sit on rows 1 and 0, both named; row 2 is on layer 1 and row 4 is not named.
    expect([...built.atBoundsDots].sort()).toEqual([0, 3])
  })

  it('counts a named parameter with no cell as not placed', async () => {
    const source = await loaded(atBounds(3, { names: ['hk_d'] }))
    const built = source.build(inputs(), BOTH)
    expect(title(built.atBounds)).toContain('1 not placed')
  })

  it('says one parameter, not one parameters', async () => {
    const source = await loaded(atBounds(3, { names: ['hk_a'], groups: [{ group: 'hk', nPar: 1, nCounted: 1, nAtBounds: 1, nExcluded: {} }] }))
    expect(label(source.build(inputs(), BOTH).atBounds)).toBe('45° at bounds: 1 parameter')
  })

  it('is off with the reason when the map is coloured by observations', async () => {
    const source = await loaded()
    const built = source.build(inputs({ colourSource: 'obs', obsGroup: 'heads' }), BOTH)
    expect(built.atBounds).toEqual({ kind: 'off', reason: 'at-bounds hatching follows the parameter group the map is coloured by' })
    expect(built.atBoundsDots.size).toBe(0)
    const mask = built.mask as Uint8Array
    expect([...mask].some((v) => (v & HATCH_AT_BOUNDS) !== 0)).toBe(false)
  })

  it('is loading, not another group answer, when the coloured group differs from the loaded one', async () => {
    const source = await loaded()
    expect(source.build(inputs({ parGroup: 'sy' }), BOTH).atBounds).toEqual({ kind: 'loading' })
  })

  it('is off with the answer reason when the iteration has no near-bound counts', async () => {
    const reason = 'near-bound counts exist for iterations 0 and 3 only'
    const source = await loaded(atBounds(2, { available: false, reason, names: null, groups: [] }), pdc(2), 2)
    const built = source.build(inputs(), BOTH)
    expect(built.atBounds).toEqual({ kind: 'off', reason })
    expect(built.atBoundsDots.size).toBe(0)
  })

  it('is off with artifact and reason when the answer was refused', async () => {
    const source = await loaded({ ok: false, artifact: 'par_change', reason: 'no group sy' })
    expect(source.build(inputs(), BOTH).atBounds).toEqual({ kind: 'off', reason: 'par_change: no group sy' })
  })

  it('refuses an answer that is for another iteration than the one asked', async () => {
    const source = await loaded(atBounds(0), pdc(0), 3)
    const built = source.build(inputs(), BOTH)
    expect(built.atBounds.kind).toBe('off')
    expect(built.conflict.kind).toBe('off')
    expect((built.atBounds as { reason: string }).reason).toContain('iteration 0')
    expect(built.mask).toBeNull()
  })
})

describe('the conflict overlay', () => {
  it('counts the coloured group only and flags the drawn dots of its conflicted sites', async () => {
    const source = await loaded()
    const built = source.build(
      inputs({ colourSource: 'obs', obsGroup: 'heads', dotSiteIds: Int32Array.from([11, 13, 10, 12]) }),
      BOTH,
    )
    expect(label(built.conflict)).toBe('135° conflict: 6 observations at 3 sites · computed')
    const mask = built.mask as Uint8Array
    expect([...mask].map((v) => v & HATCH_CONFLICT)).toEqual([2, 0, 2, 0, 0, 0])
    // Dot 0 is site 11 and dot 2 is site 10; site 13 is another group, 12 another layer.
    expect([...built.conflictDots].sort()).toEqual([0, 2])
    const t = title(built.conflict)
    expect(t).toContain('1 site on another layer')
    expect(t).toContain('2 sites in other groups')
    expect(t).toContain('2 pdc rows match no observation')
    expect(t).toContain('1 conflicted observation left out')
  })

  it('takes every group on the drawn layer when no observation group is coloured', async () => {
    const source = await loaded(atBounds(3), pdc(3, { source: 'file', sourceFile: 'case.pdc.csv' }))
    const built = source.build(inputs(), { atBounds: false, conflict: true })
    expect(label(built.conflict)).toBe('135° conflict: 9 observations at 5 sites · from file')
    const mask = built.mask as Uint8Array
    expect([...mask]).toEqual([2, 2, 2, 0, 0, 0])
    const t = title(built.conflict)
    expect(t).toContain('case.pdc.csv')
    expect(t).toContain('1 site on another layer')
    expect(t).toContain('1 site with an unknown layer, shown only under all layers')
  })

  it('takes unknown-layer sites only under all layers', async () => {
    const source = await loaded()
    const built = source.build(inputs({ allLayers: true }), { atBounds: false, conflict: true })
    expect([...(built.mask as Uint8Array)]).toEqual([2, 2, 2, 2, 0, 2])
    expect(title(built.conflict)).not.toContain('unknown layer')
  })

  it('says one observation at one site', async () => {
    const source = await loaded(atBounds(3), pdc(3, { nObs: 1, nSites: 1 }))
    expect(label(source.build(inputs(), BOTH).conflict)).toBe('135° conflict: 1 observation at 1 site · computed')
  })

  it('is off with the reason, prefixed by the iteration, when the iteration has no conflict table', async () => {
    const empty = { id: new Int32Array(0), cell: new Int32Array(0), layer: new Int32Array(0), groupIndex: new Int32Array(0), nObs: new Int32Array(0) }
    const off = pdc(3, { available: false, reason: 'no pdc file and no obs+noise to compute one', nObs: null, nSites: null, sites: empty, byGroup: [], groups: [] })
    const source = await loaded(atBounds(3), off)
    const built = source.build(inputs(), BOTH)
    expect(built.conflict).toEqual({ kind: 'off', reason: 'no prior-data conflict for iteration 3: no pdc file and no obs+noise to compute one' })
    expect(built.conflictDots.size).toBe(0)
  })

  it('is off with artifact and reason when the answer was refused', async () => {
    const source = await loaded(atBounds(3), { ok: false, artifact: 'pdc/3', reason: 'the /obs/pdc answer has no sites' })
    expect(source.build(inputs(), BOTH).conflict).toEqual({ kind: 'off', reason: 'pdc/3: the /obs/pdc answer has no sites' })
  })

  it('counts cells outside the grid instead of setting them', async () => {
    const source = await loaded(atBounds(3), pdc(3, { sites: { id: Int32Array.from([10]), cell: Int32Array.from([99]), layer: Int32Array.from([0]), groupIndex: Int32Array.from([0]), nObs: Int32Array.from([1]) } }))
    const built = source.build(inputs(), { atBounds: false, conflict: true })
    expect(built.mask).toBeNull()
    expect(title(built.conflict)).toContain('1 outside the grid')
  })
})

describe('the combined mask', () => {
  it('gives a cell set by both overlays the value 3, for cross-hatching', async () => {
    const source = await loaded()
    const mask = source.build(inputs(), BOTH).mask as Uint8Array
    expect(mask[0]).toBe(HATCH_AT_BOUNDS | HATCH_CONFLICT)
    expect(mask[0]).toBe(3)
  })

  it('leaves out the bit of a toggle the user turned off, and its dots', async () => {
    const source = await loaded()
    const built = source.build(inputs({ pointRows: Int32Array.from([0]) }), { atBounds: false, conflict: true })
    expect([...(built.mask as Uint8Array)].some((v) => (v & HATCH_AT_BOUNDS) !== 0)).toBe(false)
    expect(built.atBoundsDots.size).toBe(0)
    expect(label(built.atBounds)).toBe('45° at bounds: 4 parameters')
  })

  it('is null with both toggles off', async () => {
    const source = await loaded()
    const built = source.build(inputs(), { atBounds: false, conflict: false })
    expect(built.mask).toBeNull()
    expect(built.atBounds.kind).toBe('shown')
    expect(built.conflict.kind).toBe('shown')
  })

  it('is null when there is nothing to hatch', async () => {
    const source = await loaded(atBounds(3, { names: [] }), pdc(3), 3)
    const built = source.build(inputs({ layer: 2 }), BOTH)
    expect(built.mask).toBeNull()
    expect(label(built.atBounds)).toBe('45° at bounds: 4 parameters')
  })
})
