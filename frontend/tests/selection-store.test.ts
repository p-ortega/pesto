import { describe, expect, it, vi } from 'vitest'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore } from '../src/state/selection'

// A scheduler the test steps by hand: it records the callbacks and never runs them.
function manualSchedule() {
  const schedule = vi.fn((run: () => void) => {
    void run
  })
  return schedule
}

function mount() {
  const schedule = manualSchedule()
  const store = createSelectionStore({ initial: emptySelection('run-a', 0), schedule })
  return { store, schedule }
}

describe('createSelectionStore: one notification, none for a no-op', () => {
  it('notifies a subscriber once with next, prev and the origin', () => {
    const { store } = mount()
    const listener = vi.fn()
    store.subscribe((s) => s.iteration, listener)
    store.set({ iteration: 3 }, 'iteration-toggle')
    store.flush()
    expect(listener).toHaveBeenCalledTimes(1)
    const [next, prev, origins] = listener.mock.calls[0]
    expect(next.iteration).toBe(3)
    expect(prev.iteration).toBe(0)
    expect(origins.has('iteration-toggle')).toBe(true)
  })

  it('does not schedule or notify when a scalar is set to its current value', () => {
    const { store, schedule } = mount()
    const listener = vi.fn()
    store.subscribe((s) => s.iteration, listener)
    store.set({ iteration: 0 }, 'x')
    store.flush()
    expect(schedule).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not schedule or notify when a new Set holds the same members in another order', () => {
    const { store, schedule } = mount()
    const listener = vi.fn()
    store.set({ cells: new Set([2, 4]) }, 'map')
    store.flush()
    schedule.mockClear()
    store.subscribe((s) => s.cells, listener)
    store.set({ cells: new Set([4, 2]) }, 'map')
    store.flush()
    expect(schedule).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })

  it('returns the new snapshot from get() before the flush', () => {
    const { store } = mount()
    store.set({ layer: 5 }, 'map')
    expect(store.get().layer).toBe(5)
  })

  it('treats a store built with no patches as silent', () => {
    const { store, schedule } = mount()
    const listener = vi.fn()
    store.subscribe((s) => s, listener)
    store.flush()
    expect(schedule).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })

  it('tells reals "all" from an empty reals set, and notifies once when clearing to empty', () => {
    const { store } = mount()
    const listener = vi.fn()
    store.subscribe((s) => s.reals, listener)
    store.set({ reals: new Set<string>() }, 'reals-panel')
    store.flush()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][1].reals).toBe('all')
    expect(listener.mock.calls[0][0].reals).toEqual(new Set())
  })

  it('treats R17 and r17 as different realizations', () => {
    const { store } = mount()
    const listener = vi.fn()
    store.set({ reals: new Set(['R17']) }, 'a')
    store.flush()
    store.subscribe((s) => s.reals, listener)
    store.set({ reals: new Set(['r17']) }, 'b')
    store.flush()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('createSelectionStore: batching, slices and origins', () => {
  it('sends one call per subscriber for three sets in one frame, with every origin', () => {
    const { store, schedule } = mount()
    const listener = vi.fn()
    const other = vi.fn()
    store.subscribe((s) => s.layer, listener)
    store.subscribe((s) => s.iteration, other)
    store.set({ layer: 1 }, 'layer-slider')
    store.set({ layer: 2 }, 'map')
    store.set({ iteration: 3 }, 'iteration-toggle')
    expect(schedule).toHaveBeenCalledTimes(1)
    store.flush()
    expect(listener.mock.calls.length).toBe(1)
    const [next, prev, origins] = listener.mock.calls[0]
    expect(next.layer).toBe(2)
    expect(prev.layer).toBe(0)
    expect(origins.size).toBe(3)
    expect([...origins].sort()).toEqual(['iteration-toggle', 'layer-slider', 'map'])
    expect(other).toHaveBeenCalledTimes(1)
  })

  it('does not wake a reals subscriber when only the layer changed', () => {
    const { store } = mount()
    const reals = vi.fn()
    store.subscribe((s) => s.reals, reals)
    store.set({ layer: 4 }, 'map')
    store.flush()
    expect(reals).not.toHaveBeenCalled()
  })

  it('compares an object-returning selector field by field', () => {
    const { store } = mount()
    const listener = vi.fn()
    store.subscribe((s) => ({ layer: s.layer }), listener)
    store.set({ iteration: 2 }, 'x')
    store.flush()
    expect(listener).not.toHaveBeenCalled()
    store.set({ layer: 1 }, 'x')
    store.flush()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('compares a selector returning sets by members', () => {
    const { store } = mount()
    const listener = vi.fn()
    store.subscribe((s) => ({ cells: s.cells, reals: s.reals }), listener)
    store.set({ cells: new Set([1, 2]) }, 'a')
    store.set({ cells: new Set<number>() }, 'a')
    store.flush()
    expect(listener).not.toHaveBeenCalled()
  })

  it('calls nobody when a value is changed and set back inside one frame', () => {
    const { store } = mount()
    const listener = vi.fn()
    store.subscribe((s) => s.layer, listener)
    store.set({ layer: 1 }, 'a')
    store.set({ layer: 0 }, 'b')
    store.flush()
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops later calls to a listener that unsubscribes itself', () => {
    const { store } = mount()
    const calls: number[] = []
    const off = store.subscribe(
      (s) => s.layer,
      () => {
        calls.push(1)
        off()
      },
    )
    store.set({ layer: 1 }, 'a')
    store.flush()
    store.set({ layer: 2 }, 'a')
    store.flush()
    expect(calls).toEqual([1])
  })

  it('lets a later listener run when an earlier one throws, then re-throws the first error', () => {
    const { store } = mount()
    const later = vi.fn()
    store.subscribe(
      (s) => s.layer,
      () => {
        throw new Error('first')
      },
    )
    store.subscribe(
      (s) => s.layer,
      () => {
        throw new Error('second')
      },
    )
    store.subscribe((s) => s.layer, later)
    store.set({ layer: 1 }, 'a')
    expect(() => store.flush()).toThrow('first')
    expect(later).toHaveBeenCalledTimes(1)
  })

  it('calls subscribers in the order they subscribed', () => {
    const { store } = mount()
    const order: string[] = []
    store.subscribe((s) => s.layer, () => order.push('one'))
    store.subscribe((s) => s.layer, () => order.push('two'))
    store.subscribe((s) => s.layer, () => order.push('three'))
    store.set({ layer: 1 }, 'a')
    store.flush()
    expect(order).toEqual(['one', 'two', 'three'])
  })

  it('starts a new batch for a set made inside a listener', () => {
    const { store, schedule } = mount()
    store.subscribe(
      (s) => s.layer,
      () => store.set({ iteration: 9 }, 'echo'),
    )
    const iteration = vi.fn()
    store.subscribe((s) => s.iteration, iteration)
    store.set({ layer: 1 }, 'a')
    store.flush()
    expect(schedule).toHaveBeenCalledTimes(2)
    store.flush()
    expect(iteration).toHaveBeenCalledTimes(1)
    expect([...iteration.mock.calls[0][2]]).toEqual(['echo'])
  })

  it('never lets a mutated patch set reach the store', () => {
    const { store } = mount()
    const cells = new Set([1])
    store.set({ cells }, 'a')
    cells.add(2)
    expect([...store.get().cells]).toEqual([1])
  })
})
