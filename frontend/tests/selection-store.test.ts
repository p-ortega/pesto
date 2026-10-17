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
})
