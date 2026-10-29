// The section's colours come from the field the plan already holds, by the plan's own join rules:
// one row of the drawn group on a cell and layer is a value, two are contested, none is no value,
// and every quad left uncoloured is counted (D-08 to D-11, D-27, D-34, D-36 to D-38).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ParIdentity } from '../src/data/parmap'
import { parseSection, type SectionAnswer } from '../src/data/section'
import { classifyQuad, layersSetLine, sectionValues, type SectionValuesInput } from '../src/data/section-values'

// Three pieces on cells 0, 1 and 2, two layers; quad q is piece * 2 + layer and quad 3 (cell 1,
// layer 1) is idomain 0.
const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'section-tracer-answer.json'), 'utf8'),
) as Record<string, unknown>

function answer(): SectionAnswer {
  return parseSection(FIXTURE)
}

function identity(parnme: string, pargp: string): ParIdentity {
  return { parnme, pargp } as ParIdentity
}

interface Row {
  group: string
  cell: number
  layer: number
  value: number
}

function blockPlan(rows: Row[], extra: Partial<SectionValuesInput> = {}): SectionValuesInput {
  return {
    fullField: Float32Array.from(rows, (r) => r.value),
    limits: [0, 100],
    fieldKind: 'block',
    drawnGroup: 'G',
    ppLayer: null,
    joined: rows.map((r, i) => identity(`p${i}`, r.group)),
    cellArray: Int32Array.from(rows, (r) => r.cell),
    layerArray: Int32Array.from(rows, (r) => r.layer),
    nCells: 3,
    drawsAsPoints: false,
    obsActive: false,
    hasIdomain: true,
    referenced: null,
    ...extra,
  }
}

const G_ROWS: Row[] = [
  { group: 'G', cell: 0, layer: 0, value: 10 },
  { group: 'G', cell: 0, layer: 1, value: 20 },
  { group: 'G', cell: 2, layer: 1, value: 30 },
]

function list(values: Float32Array | Uint8Array): Array<number | null> {
  return Array.from(values, (v) => (Number.isNaN(v) ? null : v))
}

describe('sectionValues for a block group', () => {
  it('fills each quad from the one row of the drawn group on its cell and layer, and marks the rest no value', () => {
    const out = sectionValues(answer(), blockPlan(G_ROWS))
    expect(list(out.values)).toEqual([10, 20, null, null, null, 30])
    expect(list(out.noValue)).toEqual([0, 0, 1, 0, 1, 0])
    expect(list(out.absence)).toEqual([0, 0, 0, 1, 0, 0])
    expect(out.contested).toBe(0)
    expect(out.layersSet).toEqual([0, 1])
  })

  it('leaves a quad with two rows of the drawn group unfilled and counts it contested', () => {
    const rows = [...G_ROWS, { group: 'G', cell: 1, layer: 0, value: 5 }, { group: 'G', cell: 1, layer: 0, value: 6 }]
    const out = sectionValues(answer(), blockPlan(rows))
    expect(Number.isNaN(out.values[2])).toBe(true)
    expect(out.contested).toBe(1)
    expect(list(out.contestedMask)).toEqual([0, 0, 1, 0, 0, 0])
    expect(out.noValue[2]).toBe(0)
  })

  it('takes nothing from another group, even one whose name looks like the drawn one', () => {
    const rows = [...G_ROWS, { group: 'H', cell: 2, layer: 0, value: 7 }, { group: 'G2', cell: 1, layer: 0, value: 8 }]
    const out = sectionValues(answer(), blockPlan(rows))
    expect(Number.isNaN(out.values[4])).toBe(true)
    expect(Number.isNaN(out.values[2])).toBe(true)
    expect(out.noValue[4]).toBe(1)
    expect(out.noValue[2]).toBe(1)
    expect(out.layersSet).toEqual([0, 1])
  })

  it('draws an idomain-inactive quad as absence even when the field holds a value there, and counts it', () => {
    const rows = [...G_ROWS, { group: 'G', cell: 1, layer: 1, value: 9 }]
    const out = sectionValues(answer(), blockPlan(rows))
    expect(Number.isNaN(out.values[3])).toBe(true)
    expect(out.absence[3]).toBe(1)
    expect(out.noValue[3]).toBe(0)
    expect(out.inactiveWithValue).toBe(1)
    expect(out.absentWithValue).toBe(0)
  })

  it('counts a contested quad on an inactive cell as holding a value, not as contested', () => {
    const rows = [...G_ROWS, { group: 'G', cell: 1, layer: 1, value: 9 }, { group: 'G', cell: 1, layer: 1, value: 9 }]
    const out = sectionValues(answer(), blockPlan(rows))
    expect(out.inactiveWithValue).toBe(1)
    expect(out.contested).toBe(0)
    expect(out.contestedMask[3]).toBe(0)
  })

  it('counts a value on a quad with no usable thickness apart from idomain', () => {
    const pinched = { ...FIXTURE, status: [3, 0, 0, 1, 0, 0] }
    const out = sectionValues(parseSection(pinched), blockPlan(G_ROWS))
    expect(Number.isNaN(out.values[0])).toBe(true)
    expect(out.absentWithValue).toBe(1)
    expect(out.inactiveWithValue).toBe(0)
  })

  it('counts the finite values beyond the limits', () => {
    const rows = [
      { group: 'G', cell: 0, layer: 0, value: 1.5 },
      { group: 'G', cell: 0, layer: 1, value: -0.2 },
      { group: 'G', cell: 2, layer: 1, value: 0.5 },
    ]
    const out = sectionValues(answer(), blockPlan(rows, { limits: [0, 1] }))
    expect(out.beyondLimits).toBe(2)
  })

  it('gives no values when coloured by observations or for a group drawn as dots', () => {
    for (const extra of [{ obsActive: true }, { drawsAsPoints: true }]) {
      const out = sectionValues(answer(), blockPlan(G_ROWS, extra))
      expect(out.values.every((v) => Number.isNaN(v))).toBe(true)
      expect(list(out.noValue)).toEqual([1, 1, 1, 0, 1, 1])
    }
  })

  it('with no idomain, draws as absence every quad of a cell the plan counts outside the model', () => {
    const plan = blockPlan(G_ROWS, { hasIdomain: false, referenced: Uint8Array.from([1, 0, 1]) })
    const out = sectionValues(answer(), plan)
    expect(list(out.absence)).toEqual([0, 0, 1, 1, 0, 0])
    expect(list(out.noValue)).toEqual([0, 0, 0, 0, 1, 0])
  })

  it('gives no value to an answer cell the plan does not hold, rather than another layer of a held cell', () => {
    // With two cells, cell 2 on layer 0 and cell 0 on layer 1 would share a key.
    const out = sectionValues(answer(), blockPlan(G_ROWS.slice(0, 2), { nCells: 2 }))
    expect(list(out.values)).toEqual([10, 20, null, null, null, null])
  })

  it('draws an answer cell the plan does not hold as absence and counts it, never as a quiet no value', () => {
    const out = sectionValues(answer(), blockPlan(G_ROWS.slice(0, 2), { nCells: 2 }))
    expect(list(out.absence)).toEqual([0, 0, 0, 1, 1, 1])
    expect(list(out.noValue)).toEqual([0, 0, 1, 0, 0, 0])
    expect(out.unknownCell).toBe(2)
    expect(sectionValues(answer(), blockPlan(G_ROWS)).unknownCell).toBe(0)
  })

  it('classifies a quad on a cell the plan does not hold as outside the model, not as holding no parameter', () => {
    const plan = blockPlan(G_ROWS.slice(0, 2), { nCells: 2 })
    expect(classifyQuad(answer(), plan, 4)).toEqual({ kind: 'outside-model' })
    expect(classifyQuad(answer(), plan, 2)).toEqual({ kind: 'no-parameter' })
  })

  it('returns one entry per quad of the answer however large the model is', () => {
    const rows = [...G_ROWS, { group: 'G', cell: 49_999_999, layer: 99, value: 1 }]
    const out = sectionValues(answer(), blockPlan(rows, { nCells: 50_000_000 }))
    for (const array of [out.values, out.noValue, out.absence, out.contestedMask]) expect(array.length).toBe(6)
    expect(list(out.values)).toEqual([10, 20, null, null, null, 30])
    expect(out.layersSet).toEqual([0, 1, 99])
  })
})

describe('sectionValues for a pilot-point group', () => {
  function ppPlan(field: number[], ppLayer: number): SectionValuesInput {
    return {
      ...blockPlan([]),
      fullField: Float32Array.from(field),
      fieldKind: 'cell',
      drawnGroup: 'npfklayer1pp',
      ppLayer,
    }
  }

  it('fills only its own layer, from the held per-cell field where it is finite', () => {
    const out = sectionValues(answer(), ppPlan([1, 2, Number.NaN], 1))
    expect(list(out.values)).toEqual([null, 1, null, null, null, null])
    expect(list(out.noValue)).toEqual([1, 0, 1, 0, 1, 1])
    // Cell 1 on layer 1 is idomain 0, so its value is counted and drawn as absence.
    expect(out.inactiveWithValue).toBe(1)
    expect(out.layersSet).toEqual([1])
  })

  it('fills layer 0 quads only when the group is a layer 0 group', () => {
    const out = sectionValues(answer(), ppPlan([1, 2, 3], 0))
    expect(list(out.values)).toEqual([1, null, 2, null, 3, null])
  })
})

describe('layersSetLine', () => {
  it('names a single layer', () => {
    expect(layersSetLine('npfklayer17pp', [17], 18)).toBe(
      'group npfklayer17pp sets layer 17 only; other layers have no value from this group',
    )
  })

  it('joins several layers with commas and "and"', () => {
    expect(layersSetLine('G', [0, 3, 5], 18)).toBe('group G sets layers 0, 3 and 5; other layers have no value from this group')
    expect(layersSetLine('G', [3, 0], 18)).toBe('group G sets layers 0 and 3; other layers have no value from this group')
  })

  it('says nothing when the group sets every layer or none', () => {
    expect(layersSetLine('G', [0, 1], 2)).toBeNull()
    expect(layersSetLine('G', [], 2)).toBeNull()
  })
})
