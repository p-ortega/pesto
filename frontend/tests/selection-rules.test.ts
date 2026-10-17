import { describe, expect, it } from 'vitest'
import {
  applyPatch,
  clearReals,
  emptySelection,
  sameSet,
  selectCells,
  selectPars,
  selectReals,
  selectSites,
  type SharedSelection,
} from '../src/state/rules'

function base(patch: Partial<SharedSelection> = {}): SharedSelection {
  return applyPatch(emptySelection('run-a', 0), patch)
}

describe('what a patch clears', () => {
  it('keeps cells and reals when iteration, layer or timeIdx changes', () => {
    const s = base({ cells: new Set([1, 2]), reals: new Set(['r1']) })
    for (const patch of [{ iteration: 3 }, { layer: 2 }, { timeIdx: 7 }]) {
      const next = applyPatch(s, patch)
      expect([...next.cells]).toEqual([1, 2])
      expect(next.reals).toEqual(new Set(['r1']))
    }
  })

  it('keeps sites, pars and groups when iteration, layer or timeIdx changes', () => {
    const s = base({
      sites: new Set([9]),
      pars: new Set(['k_1']),
      obsGroups: new Set(['heads']),
      parGroups: new Set(['kh']),
    })
    const next = applyPatch(applyPatch(applyPatch(s, { iteration: 1 }), { layer: 1 }), { timeIdx: 1 })
    expect([...next.sites]).toEqual([9])
    expect([...next.pars]).toEqual(['k_1'])
    expect([...next.obsGroups]).toEqual(['heads'])
    expect([...next.parGroups]).toEqual(['kh'])
  })
})

describe('selectCells, selectSites, selectPars', () => {
  it('replace gives exactly the new ids', () => {
    expect([...selectCells(base({ cells: new Set([1]) }), [5], 'replace').cells]).toEqual([5])
  })

  it('add unions', () => {
    expect(selectCells(base({ cells: new Set([1]) }), [5], 'add').cells).toEqual(new Set([1, 5]))
  })

  it('remove subtracts', () => {
    expect(selectCells(base({ cells: new Set([1, 5]) }), [5], 'remove').cells).toEqual(new Set([1]))
  })

  it('replace with nothing gives an empty set', () => {
    const next = selectCells(base({ cells: new Set([1]) }), [], 'replace')
    expect(next.cells.size).toBe(0)
  })

  it('works the same for sites and pars', () => {
    expect(selectSites(base({ sites: new Set([1]) }), [2], 'add').sites).toEqual(new Set([1, 2]))
    expect(selectPars(base({ pars: new Set(['a']) }), ['b'], 'add').pars).toEqual(new Set(['a', 'b']))
    expect(selectPars(base({ pars: new Set(['a', 'b']) }), ['a'], 'remove').pars).toEqual(new Set(['b']))
  })
})

describe('selectReals and clearReals', () => {
  it('replace gives the named set', () => {
    expect(selectReals(base(), ['r2'], 'replace').reals).toEqual(new Set(['r2']))
  })

  it('add to "all" starts a named set', () => {
    expect(selectReals(base(), ['r2'], 'add').reals).toEqual(new Set(['r2']))
  })

  it('remove from "all" stays "all" because there is no named set to subtract from', () => {
    expect(selectReals(base(), ['r2'], 'remove').reals).toBe('all')
  })

  it('clearReals gives "all"', () => {
    expect(clearReals(base({ reals: new Set(['r1']) })).reals).toBe('all')
  })

  it('an empty named set is not "all"', () => {
    const next = selectReals(base({ reals: new Set(['r1']) }), ['r1'], 'remove')
    expect(next.reals).not.toBe('all')
    expect((next.reals as ReadonlySet<string>).size).toBe(0)
  })
})

describe('names are exact strings', () => {
  it('R17 and r17 are different', () => {
    expect(sameSet(new Set(['R17']), new Set(['r17']))).toBe(false)
  })

  it('a leading space makes a different name', () => {
    expect(sameSet(new Set([' a']), new Set(['a']))).toBe(false)
  })

  it('the reducers store names untouched', () => {
    const next = selectReals(base(), [' R17', 'r17'], 'replace')
    expect(next.reals).toEqual(new Set([' R17', 'r17']))
  })
})

describe('reducers do not mutate their input', () => {
  it('leaves the input sets and the patch sets alone', () => {
    const cells = new Set([1, 2])
    const reals = new Set(['r1'])
    const s = base({ cells, reals })
    selectCells(s, [3], 'add')
    selectCells(s, [1], 'remove')
    selectCells(s, [9], 'replace')
    selectReals(s, ['r2'], 'add')
    clearReals(s)
    expect([...s.cells]).toEqual([1, 2])
    expect([...(s.reals as ReadonlySet<string>)]).toEqual(['r1'])

    const patchCells = new Set([7])
    const next = applyPatch(s, { cells: patchCells })
    patchCells.add(8)
    expect([...next.cells]).toEqual([7])
  })

  it('works on frozen copies of its inputs', () => {
    const frozen = new Set([1, 2])
    Object.freeze(frozen)
    const s = base({ cells: frozen })
    expect(() => selectCells(s, [3], 'add')).not.toThrow()
    expect([...frozen]).toEqual([1, 2])
  })
})
