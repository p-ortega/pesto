import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../src/data/client'
import type { ParIdentity } from '../src/data/parmap'
import type { PpIndex } from '../src/data/fields'
import {
  computeGroupPlacement,
  computePerCell,
  createParameterFieldSource,
  dotLayerFor,
  footprintMask,
  partransForGroup,
  type FieldRequest,
  type PerCellInput,
} from '../src/views/parameter-field-source'

interface Pending {
  url: string
  signal: AbortSignal | undefined
  resolve: (values: number[]) => void
  reject: (error: unknown) => void
}

// A fetch whose answers the test releases by hand; an aborted request rejects like a real one.
function stubDeferredFetch(): Pending[] {
  const pending: Pending[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL, init?: { signal?: AbortSignal }) => {
      return new Promise((resolve, reject) => {
        const entry: Pending = {
          url: typeof input === 'string' ? input : input.toString(),
          signal: init?.signal,
          resolve: (values) => {
            const bytes = new Float32Array(values)
            resolve({
              ok: true,
              status: 200,
              arrayBuffer: async () => bytes.buffer,
              headers: { get: () => null },
            })
          },
          reject,
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        pending.push(entry)
      })
    }),
  )
  return pending
}

function request(over: Partial<FieldRequest> = {}): FieldRequest {
  return { iteration: 0, group: 'G1', kind: 'block', stat: 'value', realization: 'r001', ...over }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ParameterFieldSource.fetchField', () => {
  it('drops the first answer when a second request starts, and aborts the first', async () => {
    const pending = stubDeferredFetch()
    const source = createParameterFieldSource({ runId: 'run-a' })
    const first = source.fetchField(request({ realization: 'r001' }))
    const second = source.fetchField(request({ realization: 'r002' }))
    expect(pending).toHaveLength(2)
    expect(pending[0].signal?.aborted).toBe(true)
    pending[1].resolve([1, 2])
    pending[0].resolve([9, 9])
    expect(await first).toEqual({ stale: true })
    const landed = await second
    expect(landed.stale).toBe(false)
    if (!landed.stale) {
      expect(Array.from(landed.field)).toEqual([1, 2])
      expect(landed.request.realization).toBe('r002')
    }
  })

  it('treats an answer that lands after a newer request started as stale even if the loader ignored the abort', async () => {
    const pending = stubDeferredFetch()
    const source = createParameterFieldSource({ runId: 'run-a' })
    const first = source.fetchField(request({ stat: 'mean', realization: null }))
    const second = source.fetchField(request({ stat: 'std', realization: null }))
    pending[1].resolve([5])
    expect((await second).stale).toBe(false)
    expect(await first).toEqual({ stale: true })
  })

  it('asks /grid/values for a block field with iteration plus realization', async () => {
    const pending = stubDeferredFetch()
    const source = createParameterFieldSource({ runId: 'run-a' })
    const result = source.fetchField(request({ iteration: 3, realization: 'r 7' }))
    expect(pending[0].url).toBe('/api/run/grid/values?iteration=3&realization=r%207')
    pending[0].resolve([1])
    await result
  })

  it('asks /grid/values for a block field with iteration plus stat', async () => {
    const pending = stubDeferredFetch()
    const source = createParameterFieldSource({ runId: 'run-a' })
    const result = source.fetchField(request({ stat: 'q95', realization: null }))
    expect(pending[0].url).toBe('/api/run/grid/values?iteration=0&stat=q95')
    pending[0].resolve([1])
    await result
  })

  it('asks /grid/field for a cell field with the group added', async () => {
    const pending = stubDeferredFetch()
    const source = createParameterFieldSource({ runId: 'run-a' })
    const result = source.fetchField(request({ kind: 'cell', group: 'pp_k', realization: 'base' }))
    expect(pending[0].url).toBe('/api/run/grid/field?iteration=0&group=pp_k&realization=base')
    pending[0].resolve([1])
    await result
  })

  it('rejects when the current request fails with an ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ title: 'boom', status: 500 }),
        headers: { get: () => null },
      })),
    )
    const source = createParameterFieldSource({ runId: 'run-a' })
    await expect(source.fetchField(request())).rejects.toBeInstanceOf(ApiError)
  })

  it('never rejects for an abort', async () => {
    const pending = stubDeferredFetch()
    const source = createParameterFieldSource({ runId: 'run-a' })
    const first = source.fetchField(request({ realization: 'r001' }))
    void source.fetchField(request({ realization: 'r002' }))
    pending[0].reject(new DOMException('aborted', 'AbortError'))
    await expect(first).resolves.toEqual({ stale: true })
  })
})

function id(parnme: string, pargp: string, partrans: string | null = 'none'): ParIdentity {
  return { parnme, pargp, partrans }
}

const NO_PP: PpIndex = { groups: [], not_interpolable: [], notes: [] }

describe('computeGroupPlacement', () => {
  it('offers a group that placed, lists one that did not as unmapped, and keeps control-file order', () => {
    const identities = [id('a', 'G2'), id('b', 'G1'), id('c', 'G3')]
    const joined = [identities[1], identities[0]]
    const cells = new Int32Array([4, -1])
    const out = computeGroupPlacement(identities, joined, cells, NO_PP)
    expect(out.drawable).toEqual(['G1'])
    expect(out.unmapped).toEqual([
      { group: 'G2', note: null },
      { group: 'G3', note: null },
    ])
    expect(out.interpolated).toEqual([])
  })

  it('draws an interpolated group that placed nowhere and carries the refusal reason for a refused one', () => {
    const identities = [id('a', 'pp_k'), id('b', 'pp_bad')]
    const ppIndex: PpIndex = {
      groups: [{ group: 'pp_k', layer: 1, n_pp: 5, log_space: false, format: 'text', notes: [] }],
      not_interpolable: [{ group: 'pp_bad', reason: 'no factors file' }],
      notes: [],
    }
    const out = computeGroupPlacement(identities, [], new Int32Array(0), ppIndex)
    expect(out.drawable).toEqual(['pp_k'])
    expect(out.interpolated).toEqual(['pp_k'])
    expect(out.unmapped).toEqual([{ group: 'pp_bad', note: 'pp_bad — no factors file' }])
  })
})

describe('partransForGroup', () => {
  it('reads the partrans from the joined row, falling back to the control table for a group not in the block', () => {
    const identities = [id('a', 'G1', 'log'), id('b', 'pp', 'fixed')]
    expect(partransForGroup([identities[0]], 'G1', identities)).toBe('log')
    expect(partransForGroup([identities[0]], 'pp', identities)).toBe('fixed')
    expect(partransForGroup([null], 'missing', identities)).toBeNull()
  })
})

// Four cells on one layer. Rows 0 and 1 of G1 both sit on cell 0, row 2 of G1 sits on cell 1,
// row 3 is a G2 row on cell 2, and cell 3 is outside the model by idomain.
function perCellInput(over: Partial<PerCellInput> = {}): PerCellInput {
  const joined = [id('p0', 'G1'), id('p1', 'G1'), id('p2', 'G1'), id('p3', 'G2')]
  return {
    field: new Float32Array([10, 20, 30, 40]),
    layerIndex: 0,
    nCells: 4,
    fieldKind: 'block',
    fieldGroup: 'G1',
    drawnGroup: 'G1',
    ppIndex: NO_PP,
    joined,
    cellArray: new Int32Array([0, 0, 1, 2]),
    layerArray: new Int32Array([0, 0, 0, 0]),
    pointXy: null,
    idomain: new Int32Array([1, 1, 1, 0]),
    maskCache: { referenced: null },
    ...over,
  }
}

describe('computePerCell', () => {
  it('gives a valued cell its row value, leaves a contested cell without one, and tells no-parameter from outside-model', () => {
    const out = computePerCell(perCellInput())
    expect(out.classes.map((c) => c.kind)).toEqual(['contested', 'valued', 'no-parameter', 'outside-model'])
    expect(out.perCell[1]).toBe(30)
    expect(Number.isNaN(out.perCell[0])).toBe(true)
    expect(Number.isNaN(out.perCell[2])).toBe(true)
    expect(out.contested).toBe(1)
    expect(out.noValue).toBe(1)
  })

  it('counts a cell some row names as in the model when the grid has no idomain', () => {
    const out = computePerCell(perCellInput({ idomain: null }))
    expect(out.classes.map((c) => c.kind)).toEqual(['contested', 'valued', 'no-parameter', 'outside-model'])
    expect(out.noValue).toBe(1)
  })

  it('classes a group with positions as points and leaves every cell without a value', () => {
    const nan = Number.NaN
    const pointXy = new Float32Array([1, 1, 2, 2, 3, 3, nan, nan])
    const out = computePerCell(perCellInput({ pointXy }))
    expect(out.classes[0]).toEqual({ kind: 'points', rows: [0, 1] })
    expect(out.classes[1]).toEqual({ kind: 'points', rows: [2] })
    expect(out.classes.slice(2).map((c) => c.kind)).toEqual(['no-parameter', 'outside-model'])
    expect(out.perCell.every((v) => Number.isNaN(v))).toBe(true)
    expect(out.noValue).toBe(1)
    expect(Array.from(footprintMask(out.classes))).toEqual([1, 1, 1, 0])
  })

  it('classes an interpolated field by finite value on its own layer and marks nothing as contested', () => {
    const ppIndex: PpIndex = {
      groups: [{ group: 'pp_k', layer: 0, n_pp: 3, log_space: false, format: 'text', notes: [] }],
      not_interpolable: [],
      notes: [],
    }
    const field = new Float32Array([1, Number.NaN, 3, 4])
    const input = perCellInput({ field, fieldKind: 'cell', fieldGroup: 'pp_k', drawnGroup: 'pp_k', ppIndex })
    const out = computePerCell(input)
    // Cell 3 is outside by idomain but carries a finite value, so the field puts it in the model.
    expect(out.classes.map((c) => c.kind)).toEqual(['interpolated', 'no-parameter', 'interpolated', 'interpolated'])
    expect(out.perCell[2]).toBe(3)
    expect(out.contested).toBe(0)
    expect(out.noValue).toBe(1)
  })

  it('holds back a field drawn for another layer: every active cell is no-parameter', () => {
    const ppIndex: PpIndex = {
      groups: [{ group: 'pp_k', layer: 1, n_pp: 3, log_space: false, format: 'text', notes: [] }],
      not_interpolable: [],
      notes: [],
    }
    const out = computePerCell(
      perCellInput({ fieldKind: 'cell', fieldGroup: 'pp_k', drawnGroup: 'pp_k', ppIndex, idomain: new Int32Array([1, 1, 1, 0, 1, 1, 1, 0]) }),
    )
    expect(out.classes.map((c) => c.kind)).toEqual(['no-parameter', 'no-parameter', 'no-parameter', 'outside-model'])
  })
})

describe('dotLayerFor', () => {
  it('opens a dot group on the lowest layer holding a dot, and stays put when the current layer holds one', () => {
    const joined = [id('p0', 'D'), id('p1', 'D'), id('p2', 'D')]
    const pointXy = new Float32Array([1, 1, 2, 2, 3, 3])
    const layerArray = new Int32Array([2, 1, 3])
    const input = { ppIndex: NO_PP, joined, pointXy, layerArray, currentLayer: 0 }
    expect(dotLayerFor('D', input)).toBe(1)
    expect(dotLayerFor('D', { ...input, currentLayer: 3 })).toBeNull()
    expect(dotLayerFor('D', { ...input, pointXy: null })).toBeNull()
  })
})
