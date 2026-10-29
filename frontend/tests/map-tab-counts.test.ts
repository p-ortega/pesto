// @vitest-environment jsdom
//
// The Params and Obs tab counts in the real map shell: they follow the shared selection's
// pars and sites by name, say what they count in their title, and go away when empty.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import { emptySelection } from '../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../src/state/selection'

// The map view is not under test here; the counts live in the shell.
vi.mock('../src/views/map-view', () => ({
  CONTEXT_RECOVERY_WINDOW_MS: 0,
  openingIteration: () => ({ iteration: 0 }),
  mountMapView: vi.fn(() => ({ viewFields: () => null })),
}))

function baseState(): IngestState {
  return {
    fresh: true,
    artifacts: [],
    capabilities: {
      map: { available: true, blockedBy: [] },
      stats: { available: true, blockedBy: [] },
      chips: { available: true, blockedBy: [] },
    },
    ingestSeconds: null,
    cacheBytes: null,
  }
}

async function openShell(store: SelectionStore): Promise<HTMLElement> {
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: null, state: baseState(), store })
  return root
}

const tab = (root: HTMLElement, id: string): HTMLElement => root.querySelector(`#tab-${id}`) as HTMLElement
const countTitle = (root: HTMLElement, id: string): string | null =>
  tab(root, id).querySelector('.tab-count')!.getAttribute('title')

describe('the tab counts in the map shell', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), headers: { get: () => null } })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows no count on an empty selection', async () => {
    const store = createSelectionStore({ initial: emptySelection('run', 0), schedule: () => {} })
    const root = await openShell(store)

    expect(tab(root, 'params').textContent).toBe('Params')
    expect(tab(root, 'obs').textContent).toBe('Obs')
    expect(tab(root, 'config').textContent).toBe('Config')
  })

  it('counts the selected parameters and sites, singular for one, and clears with them', async () => {
    const store = createSelectionStore({ initial: emptySelection('run', 0), schedule: () => {} })
    const root = await openShell(store)

    store.set({ pars: new Set(['a', 'b']) }, 'test')
    store.flush()
    expect(tab(root, 'params').textContent).toBe('Params · 2')
    expect(countTitle(root, 'params')).toBe('2 parameters selected')

    store.set({ sites: new Set([7]) }, 'test')
    store.flush()
    expect(tab(root, 'obs').textContent).toBe('Obs · 1')
    expect(countTitle(root, 'obs')).toBe('1 site selected')

    store.set({ pars: new Set(['a']), sites: new Set([7, 8, 9, 10]) }, 'test')
    store.flush()
    expect(countTitle(root, 'params')).toBe('1 parameter selected')
    expect(tab(root, 'obs').textContent).toBe('Obs · 4')
    expect(countTitle(root, 'obs')).toBe('4 sites selected')

    store.set({ pars: new Set(), sites: new Set() }, 'test')
    store.flush()
    expect(tab(root, 'params').textContent).toBe('Params')
    expect(tab(root, 'obs').textContent).toBe('Obs')
    expect(countTitle(root, 'params')).toBeNull()
  })

  it('starts from what the store already holds', async () => {
    const store = createSelectionStore({
      initial: { ...emptySelection('run', 0), pars: new Set(['x', 'y', 'z']), sites: new Set([1, 2]) },
      schedule: () => {},
    })
    const root = await openShell(store)

    expect(tab(root, 'params').textContent).toBe('Params · 3')
    expect(tab(root, 'obs').textContent).toBe('Obs · 2')
  })
})
