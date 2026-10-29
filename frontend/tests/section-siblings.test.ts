// Sibling groups for a stacked section: who is a sibling comes from the name, the layer each one
// fills comes from the data, a layer two siblings fill is contested, and the legend says all of it.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PpIndex } from '../src/data/fields'
import type { ParIdentity } from '../src/data/parmap'
import { parseSection } from '../src/data/section'
import {
  layerRanges,
  planSiblings,
  SiblingFields,
  siblingKey,
  stackLegend,
  type SiblingFieldRequest,
  type SiblingInput,
} from '../src/data/section-siblings'
import { classifyQuad, sectionValues, type LayerFill, type SectionValuesInput } from '../src/data/section-values'

describe('siblingKey', () => {
  it('replaces the digits after "layer" and keeps everything else', () => {
    expect(siblingKey('npfklayer1pp')).toEqual({ key: 'npfklayer#pp' })
    expect(siblingKey('npfklayer12pp')).toEqual({ key: 'npfklayer#pp' })
    expect(siblingKey('gwt_sconclayer3pp')).toEqual({ key: 'gwt_sconclayer#pp' })
  })

  it('leaves other digit runs alone', () => {
    expect(siblingKey('npfk33layer12pp')).toEqual({ key: 'npfk33layer#pp' })
    expect(siblingKey('npfk33layer12pp')).not.toEqual(siblingKey('npfk34layer12pp'))
  })

  it('gives no key to a name with no "layer" followed by digits', () => {
    expect(siblingKey('hk1')).toEqual({ key: null, reason: null })
    expect(siblingKey('layerpp')).toEqual({ key: null, reason: null })
    expect(siblingKey('npfk')).toEqual({ key: null, reason: null })
  })

  it('matches the token in any case but keeps the case of the rest', () => {
    expect(siblingKey('NPFKLayer3PP')).toEqual({ key: 'NPFKLayer#PP' })
    expect(siblingKey('NPFKLAYER3PP')).toEqual({ key: 'NPFKLAYER#PP' })
    expect(siblingKey('NPFKLayer3PP')).not.toEqual(siblingKey('npfklayer3pp'))
  })

  it('refuses, with a reason, a name with digits after "layer" in two places', () => {
    const key = siblingKey('layer1_layer2')
    expect(key.key).toBeNull()
    expect(key.key === null && key.reason).toContain('layer1_layer2')
  })
})

function identity(parnme: string, pargp: string): ParIdentity {
  return { parnme, pargp } as ParIdentity
}

function pp(group: string, layer: number): PpIndex['groups'][number] {
  return { group, layer, n_pp: 1, log_space: false, format: 'text', notes: [] }
}

interface BlockRow {
  group: string
  cell: number
  layer: number
}

function input(groups: string[], ppGroups: PpIndex['groups'], rows: BlockRow[] = [], nlay = 6, points: string[] = []): SiblingInput {
  return {
    groups,
    ppIndex: { groups: ppGroups, not_interpolable: [], notes: [] },
    joined: rows.map((r, i) => identity(`p${i}`, r.group)),
    cellArray: Int32Array.from(rows, (r) => r.cell),
    layerArray: Int32Array.from(rows, (r) => r.layer),
    nlay,
    isPointGroup: (g) => points.includes(g),
  }
}

describe('planSiblings', () => {
  it('has nothing to stack for a group with no layer token or no other sibling', () => {
    expect(planSiblings('hk', input(['hk', 'hklayer1'], [pp('hk', 0)]))).toBeNull()
    expect(planSiblings('hklayer1', input(['hklayer1', 'sslayer1'], [pp('hklayer1', 0)]))).toBeNull()
  })

  it('takes the layer from the pilot-point index, never from the digits in the name', () => {
    const plan = planSiblings('klayer1pp', input(['klayer1pp', 'klayer3pp', 'other'], [pp('klayer1pp', 0), pp('klayer3pp', 5)]))!
    expect(plan.key).toBe('klayer#pp')
    expect(plan.fillers[5]).toEqual(['klayer3pp'])
    expect(plan.fillers[3]).toEqual([])
    expect(plan.fillers[0]).toEqual(['klayer1pp'])
    expect(plan.members.find((m) => m.group === 'klayer3pp')).toEqual({ group: 'klayer3pp', kind: 'cell', layers: [5] })
  })

  it('takes a cell-placed sibling layers from the rows it actually sets', () => {
    const rows = [
      { group: 'kblayer1', cell: 0, layer: 0 },
      { group: 'kblayer2', cell: 0, layer: 2 },
      { group: 'kblayer2', cell: 1, layer: 3 },
      // A row with no cell sets nothing.
      { group: 'kblayer2', cell: -1, layer: 4 },
    ]
    const plan = planSiblings('kblayer1', input(['kblayer1', 'kblayer2'], [], rows))!
    expect(plan.members.find((m) => m.group === 'kblayer2')).toEqual({ group: 'kblayer2', kind: 'block', layers: [2, 3] })
    expect(plan.fillers.map((g) => g.length)).toEqual([1, 0, 1, 1, 0, 0])
  })

  it('lists both groups on a layer two siblings fill, without picking one', () => {
    const plan = planSiblings('klayer1pp', input(['klayer1pp', 'klayer2pp', 'klayer5pp'], [pp('klayer1pp', 0), pp('klayer2pp', 1), pp('klayer5pp', 1)]))!
    expect(plan.fillers[1]).toEqual(['klayer2pp', 'klayer5pp'])
  })

  it('notes a sibling with no layer in the data, one drawn as dots, and a layer the grid does not have', () => {
    const rows = [{ group: 'klayer4pp', cell: 0, layer: 1 }]
    const plan = planSiblings(
      'klayer1pp',
      input(['klayer1pp', 'klayer2pp', 'klayer3pp', 'klayer4pp'], [pp('klayer1pp', 0), pp('klayer3pp', 9)], rows, 6, ['klayer4pp']),
    )!
    expect(plan.notes).toEqual([
      'group klayer2pp has no pilot-point layer and no parameter placed on a cell, so it fills no layer',
      'group klayer3pp names layer 9, which this grid of 6 layers does not have',
      'group klayer4pp is placed as dots, so the section shows no value for it',
    ])
    expect(plan.members.map((m) => m.group)).toEqual(['klayer1pp'])
  })
})

describe('the stacked legend', () => {
  it('says which group fills which layer, compactly, with the full mapping in the title', () => {
    const groups = Array.from({ length: 17 }, (_, i) => `npfklayer${i + 1}pp`)
    const plan = planSiblings('npfklayer1pp', input(groups, groups.map((g, i) => pp(g, i)), [], 19))!
    const entries = stackLegend(plan, { loading: [], failed: [] })
    expect(entries[0].text).toBe('npfklayer#pp: layers 0–16 from 17 groups')
    expect(entries[0].title?.split('\n')[0]).toBe('layer 0: npfklayer1pp')
    expect(entries[0].title?.split('\n')[16]).toBe('layer 16: npfklayer17pp')
    expect(entries[1].text).toBe('no group of npfklayer#pp fills layers 17–18')
  })

  it('names a contested layer, the layers still loading, and a sibling that failed', () => {
    const plan = planSiblings('klayer1pp', input(['klayer1pp', 'klayer2pp', 'klayer5pp'], [pp('klayer1pp', 0), pp('klayer2pp', 1), pp('klayer5pp', 1)], [], 3))!
    const texts = stackLegend(plan, { loading: [2], failed: [{ group: 'klayer9pp', layers: [2], reason: 'the field is missing' }] }).map((e) => e.text)
    expect(texts).toContain('layer 1 is contested: klayer2pp and klayer5pp both fill it; no value drawn')
    expect(texts).toContain('no group of klayer#pp fills layer 2')
    expect(texts).toContain('reading layer 2…')
    expect(texts).toContain('klayer9pp could not be read, so layer 2 is drawn with no value: the field is missing')
    expect(stackLegend(plan, { loading: [], failed: [] })[0].title).toContain('layer 1: klayer2pp and klayer5pp (contested)')
  })

  it('writes runs of layers as ranges', () => {
    expect(layerRanges([3])).toBe('3')
    expect(layerRanges([0, 1, 2, 3, 5, 7, 8])).toBe('0–3, 5 and 7–8')
  })
})

// Three pieces on cells 0, 1 and 2, two layers; quad 3 (cell 1, layer 1) is idomain 0.
const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'section-tracer-answer.json'), 'utf8'),
) as Record<string, unknown>

function cellPlan(extra: Partial<SectionValuesInput> = {}): SectionValuesInput {
  return {
    fullField: new Float32Array([1, 2, 3]),
    limits: [0, 5],
    fieldKind: 'cell',
    drawnGroup: 'klayer1pp',
    ppLayer: 0,
    joined: [],
    cellArray: new Int32Array(0),
    layerArray: new Int32Array(0),
    nCells: 3,
    drawsAsPoints: false,
    obsActive: false,
    hasIdomain: true,
    referenced: null,
    ...extra,
  }
}

function list(values: Float32Array | Uint8Array): Array<number | null> {
  return Array.from(values, (v) => (Number.isNaN(v) ? null : v))
}

describe('sectionValues with a stack', () => {
  const own: LayerFill = { kind: 'cell', group: 'klayer1pp', field: new Float32Array([1, 2, 3]), raw: null }

  it('reads each layer from its own sibling and counts values beyond the limits', () => {
    const sibling: LayerFill = { kind: 'cell', group: 'klayer9pp', field: new Float32Array([7, 8, 9]), raw: new Float32Array([7, 8, 9]) }
    const out = sectionValues(parseSection(FIXTURE), cellPlan(), [own, sibling])
    expect(list(out.values)).toEqual([1, 7, 2, null, 3, 9])
    expect(out.beyondLimits).toBe(2)
  })

  it('draws a contested layer with the contested stripe and no value', () => {
    const out = sectionValues(parseSection(FIXTURE), cellPlan(), [own, { kind: 'contested', groups: ['a', 'b'] }])
    expect(list(out.contestedMask)).toEqual([0, 1, 0, 0, 0, 1])
    expect(list(out.values)).toEqual([1, null, 2, null, 3, null])
    // The inactive quad stays absence and is not counted as contested.
    expect(out.contested).toBe(2)
  })

  it('draws a loading layer with no value at all, never an older one', () => {
    const out = sectionValues(parseSection(FIXTURE), cellPlan(), [own, { kind: 'loading', group: 'klayer9pp' }])
    expect(list(out.values)).toEqual([1, null, 2, null, 3, null])
    expect(list(out.noValue)).toEqual([0, 1, 0, 0, 0, 1])
  })

  it('counts sibling values the log scale could not draw', () => {
    const sibling: LayerFill = {
      kind: 'cell',
      group: 'klayer9pp',
      field: new Float32Array([Number.NaN, 0.5, 1]),
      raw: new Float32Array([-1, 3, 10]),
    }
    expect(sectionValues(parseSection(FIXTURE), cellPlan(), [own, sibling]).noLogValue).toBe(1)
  })

  it('classifies a click on a stacked layer by the sibling that fills it', () => {
    const plan = cellPlan({
      fieldKind: 'block',
      drawnGroup: 'kblayer1',
      fullField: new Float32Array([10, 40]),
      joined: [identity('b0', 'kblayer1'), identity('b1', 'kblayer2')],
      cellArray: Int32Array.from([0, 0]),
      layerArray: Int32Array.from([0, 1]),
    })
    const fills: LayerFill[] = [
      { kind: 'block', group: 'kblayer1', field: plan.fullField!, raw: null },
      { kind: 'block', group: 'kblayer2', field: plan.fullField!, raw: null },
    ]
    const answer = parseSection(FIXTURE)
    expect(classifyQuad(answer, plan, 1, fills)).toEqual({ kind: 'valued', row: 1 })
    expect(classifyQuad(answer, plan, 0, fills)).toEqual({ kind: 'valued', row: 0 })
    expect(classifyQuad(answer, plan, 5, fills)).toEqual({ kind: 'no-parameter' })
    expect(classifyQuad(answer, plan, 1, [fills[0], { kind: 'loading', group: 'kblayer2' }])).toBeNull()
  })
})

function request(group: string, iteration = 0): SiblingFieldRequest {
  return { kind: 'cell', group, iteration, stat: 'mean', realization: null }
}

describe('SiblingFields', () => {
  function deferredLoader() {
    const calls: Array<{ group: string; signal: AbortSignal; resolve: (v: Float32Array) => void; reject: (e: unknown) => void }> = []
    const load = (r: SiblingFieldRequest, signal: AbortSignal) =>
      new Promise<Float32Array>((resolve, reject) => calls.push({ group: r.group, signal, resolve, reject }))
    return { calls, load }
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 3; i++) await Promise.resolve()
  }

  it('reads at most three at a time and starts the next as one lands', async () => {
    const { calls, load } = deferredLoader()
    let settled = 0
    const fields = new SiblingFields(load, () => (settled += 1))
    fields.want(['a', 'b', 'c', 'd', 'e'].map((g) => request(g)))
    expect(calls.map((c) => c.group)).toEqual(['a', 'b', 'c'])
    expect(fields.get(request('d'))).toEqual({ state: 'loading' })
    calls[0].resolve(new Float32Array([1]))
    await flush()
    expect(calls.map((c) => c.group)).toEqual(['a', 'b', 'c', 'd'])
    expect(fields.get(request('a'))).toEqual({ state: 'ok', raw: new Float32Array([1]) })
    expect(settled).toBe(1)
  })

  it('lets go of what is no longer wanted, so a new iteration never shows an old field', async () => {
    const { calls, load } = deferredLoader()
    const fields = new SiblingFields(load, () => {})
    fields.want([request('a', 0)])
    fields.want([request('a', 3)])
    expect(calls[0].signal.aborted).toBe(true)
    calls[0].resolve(new Float32Array([1]))
    await flush()
    expect(fields.get(request('a', 0))).toBeUndefined()
    expect(fields.get(request('a', 3))).toEqual({ state: 'loading' })
  })

  it('keeps a failure with its reason, and forgets it on stop so it is asked again', async () => {
    const { calls, load } = deferredLoader()
    const fields = new SiblingFields(load, () => {})
    fields.want([request('a')])
    calls[0].reject(new Error('no such field'))
    await flush()
    expect(fields.get(request('a'))).toEqual({ state: 'failed', reason: 'no such field' })
    fields.stop()
    expect(fields.get(request('a'))).toBeUndefined()
    fields.want([request('a')])
    expect(calls).toHaveLength(2)
  })
})
