import { describe, expect, it } from 'vitest'
import { classifyFieldCells } from '../src/data/fields'

describe('classifyFieldCells', () => {
  it('marks finite cells on the group layer interpolated, the rest no value, inactive cells outside the model', () => {
    const field = new Float32Array([1, Number.NaN, 3, 4])
    const active = new Uint8Array([1, 1, 1, 0])
    const onLayer = classifyFieldCells(field, active, 2, 2)
    expect(onLayer.classes.map((c) => c.kind)).toEqual(['interpolated', 'no-parameter', 'interpolated', 'outside-model'])
    expect(onLayer.noValueCount).toBe(1)
    const offLayer = classifyFieldCells(field, active, 2, 0)
    expect(offLayer.classes.map((c) => c.kind)).toEqual(['no-parameter', 'no-parameter', 'no-parameter', 'outside-model'])
    expect(offLayer.noValueCount).toBe(3)
  })
})
