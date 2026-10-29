// @vitest-environment jsdom
//
// The right panel's tab bar (D-08 to D-10, FOUND-07): ARIA roles and keys,
// hidden panels kept mounted, hide and show calls, the Params table keeping its
// place across a switch, the selection store left alone, and the two notes.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSelectionStore } from '../src/state/selection'
import { emptySelection } from '../src/state/rules'
import { renderParamsPanel } from '../src/ui/params-panel'
import { renderTabs, type TabSpec } from '../src/ui/tabs'
import type { IngestState } from '../src/data/client'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

const holder = vi.hoisted(() => ({
  facts: null as null | { unmapped: []; artifactNotes: []; parTable: Promise<ArrayBuffer> },
}))

// The map view is not under test here; the shell only needs it to report the
// panel facts, as the real one does once the run's tables have loaded.
vi.mock('../src/views/map-view', () => ({
  CONTEXT_RECOVERY_WINDOW_MS: 0,
  mountMapView: vi.fn((_host: HTMLElement, opts: { onPanelFacts: (facts: unknown) => void }) => {
    opts.onPanelFacts(holder.facts)
    return {
      viewFields: () => ({
        colormap: 'viridis',
        reverse: false,
        scale: 'linear',
        limitsMode: 'robust',
        group: null,
        stat: 'value',
        layer: null,
      }),
    }
  }),
}))

function mount(): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  return host
}

function specs(log: string[] = []): TabSpec[] {
  return ['params', 'obs', 'config'].map((id) => ({
    id,
    label: id,
    onShow: () => log.push(`show ${id}`),
    onHide: () => log.push(`hide ${id}`),
  }))
}

function tabEl(host: HTMLElement, id: string): HTMLButtonElement {
  return host.querySelector(`#tab-${id}`) as HTMLButtonElement
}

function key(el: HTMLElement, name: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
}

describe('renderTabs', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('renders a tablist named Panels with one tab and one tabpanel per spec, in order', () => {
    const host = mount()
    renderTabs(host, { tabs: specs(), initial: 'params', onSelect: () => {} })

    const list = host.querySelector('[role="tablist"]') as HTMLElement
    expect(list.getAttribute('aria-label')).toBe('Panels')
    expect(Array.from(list.querySelectorAll('[role="tab"]')).map((el) => el.textContent)).toEqual([
      'params',
      'obs',
      'config',
    ])
    expect(host.querySelectorAll('[role="tabpanel"]').length).toBe(3)
  })

  it('marks the current tab selected and in the tab order, and links each tab to its panel', () => {
    const host = mount()
    renderTabs(host, { tabs: specs(), initial: 'obs', onSelect: () => {} })

    for (const id of ['params', 'obs', 'config']) {
      const tab = tabEl(host, id)
      const current = id === 'obs'
      expect(tab.getAttribute('aria-selected')).toBe(current ? 'true' : 'false')
      expect(tab.tabIndex).toBe(current ? 0 : -1)
      const panel = document.getElementById(tab.getAttribute('aria-controls')!)!
      expect(panel.getAttribute('role')).toBe('tabpanel')
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id)
      expect(panel.hidden).toBe(!current)
    }
  })

  it('keeps all three panels in the DOM after five switches and shows only the current one', () => {
    const host = mount()
    const tabs = renderTabs(host, { tabs: specs(), initial: 'params', onSelect: () => {} })

    for (const id of ['obs', 'config', 'params', 'config', 'obs']) tabEl(host, id).click()

    expect(host.querySelectorAll('[role="tabpanel"]').length).toBe(3)
    const shown = Array.from(host.querySelectorAll<HTMLElement>('[role="tabpanel"]')).filter((p) => !p.hidden)
    expect(shown.map((p) => p.id)).toEqual(['panel-obs'])
    expect(tabs.current()).toBe('obs')
    expect(tabs.panel('config').hasAttribute('hidden')).toBe(true)
  })

  it('runs onHide for the tab left and onShow for the tab chosen, and nothing for the current tab', () => {
    const log: string[] = []
    const host = mount()
    renderTabs(host, { tabs: specs(log), initial: 'params', onSelect: () => {} })

    tabEl(host, 'params').click()
    expect(log).toEqual([])

    tabEl(host, 'config').click()
    expect(log).toEqual(['hide params', 'show config'])

    tabEl(host, 'config').click()
    expect(log).toEqual(['hide params', 'show config'])
  })

  it('hides the old panel before onShow runs, so the new panel can measure itself', () => {
    const host = mount()
    let obsHiddenAtShow: boolean | string | null = null
    const tabs: TabSpec[] = [
      { id: 'params', label: 'Params' },
      { id: 'obs', label: 'Obs', onShow: () => (obsHiddenAtShow = document.getElementById('panel-obs')!.hidden) },
    ]
    renderTabs(host, { tabs, initial: 'params', onSelect: () => {} })

    tabEl(host, 'obs').click()

    expect(obsHiddenAtShow).toBe(false)
  })

  it('calls onSelect for a click or a key, but not for select() or a re-click', () => {
    const onSelect = vi.fn()
    const host = mount()
    const tabs = renderTabs(host, { tabs: specs(), initial: 'params', onSelect })

    tabs.select('obs')
    expect(onSelect).not.toHaveBeenCalled()
    expect(tabs.current()).toBe('obs')

    tabEl(host, 'obs').click()
    expect(onSelect).not.toHaveBeenCalled()

    tabEl(host, 'config').click()
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('config')
  })

  it('ignores select() for an id it does not know', () => {
    const host = mount()
    const tabs = renderTabs(host, { tabs: specs(), initial: 'params', onSelect: () => {} })

    tabs.select('phi')

    expect(tabs.current()).toBe('params')
  })

  it('starts on the first tab when the initial id is unknown', () => {
    const host = mount()
    const tabs = renderTabs(host, { tabs: specs(), initial: 'phi', onSelect: () => {} })

    expect(tabs.current()).toBe('params')
    expect(tabEl(host, 'params').getAttribute('aria-selected')).toBe('true')
  })

  it('moves with the arrow keys, wrapping at both ends, and focuses the tab it lands on', () => {
    const onSelect = vi.fn()
    const host = mount()
    const tabs = renderTabs(host, { tabs: specs(), initial: 'config', onSelect })

    key(tabEl(host, 'config'), 'ArrowRight')
    expect(tabs.current()).toBe('params')
    expect(document.activeElement).toBe(tabEl(host, 'params'))

    key(tabEl(host, 'params'), 'ArrowLeft')
    expect(tabs.current()).toBe('config')
    expect(document.activeElement).toBe(tabEl(host, 'config'))

    key(tabEl(host, 'config'), 'Home')
    expect(tabs.current()).toBe('params')
    expect(document.activeElement).toBe(tabEl(host, 'params'))

    key(tabEl(host, 'params'), 'End')
    expect(tabs.current()).toBe('config')
    expect(document.activeElement).toBe(tabEl(host, 'config'))

    key(tabEl(host, 'config'), 'ArrowRight')
    key(tabEl(host, 'params'), 'ArrowRight')
    expect(tabs.current()).toBe('obs')
    expect(onSelect).toHaveBeenLastCalledWith('obs')
  })

  it('leaves other keys alone', () => {
    const host = mount()
    const tabs = renderTabs(host, { tabs: specs(), initial: 'params', onSelect: () => {} })
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })

    tabEl(host, 'params').dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(tabs.current()).toBe('params')
  })

  it('the tab labels do not run together', () => {
    loadRealStylesheet()
    const host = mount()
    renderTabs(host, {
      tabs: [
        { id: 'params', label: 'Params' },
        { id: 'obs', label: 'Obs' },
        { id: 'config', label: 'Config' },
      ],
      initial: 'params',
      onSelect: () => {},
    })

    expectNoRunTogetherText(host, 'tabs.ts renderTabs')
  })

  it('shows a count after the label with its title, and none for zero or null', () => {
    const host = mount()
    const tabs = renderTabs(host, {
      tabs: [
        { id: 'params', label: 'Params' },
        { id: 'obs', label: 'Obs' },
      ],
      initial: 'params',
      onSelect: () => {},
    })
    const count = tabEl(host, 'params').querySelector('.tab-count.tabular-nums') as HTMLElement

    tabs.setCount('params', 12, '12 parameters selected')
    expect(tabEl(host, 'params').textContent).toBe('Params · 12')
    expect(count.title).toBe('12 parameters selected')
    expect(tabEl(host, 'params').querySelector('.tab-name')?.textContent).toBe('Params')
    expect(tabEl(host, 'obs').textContent).toBe('Obs')

    tabs.setCount('params', 0, '')
    expect(tabEl(host, 'params').textContent).toBe('Params')
    expect(count.textContent).toBe('')
    expect(count.hasAttribute('title')).toBe(false)

    tabs.setCount('params', 3, '3 parameters selected')
    tabs.setCount('params', null, '')
    expect(tabEl(host, 'params').textContent).toBe('Params')
  })

  it('keeps clicks and arrow keys working with a count shown, and ignores an unknown id', () => {
    const host = mount()
    const tabs = renderTabs(host, { tabs: specs(), initial: 'params', onSelect: () => {} })
    tabs.setCount('obs', 4, '4 sites selected')
    tabs.setCount('nope', 2, 'x')

    tabEl(host, 'obs').click()
    expect(tabs.current()).toBe('obs')
    key(tabEl(host, 'obs'), 'ArrowRight')
    expect(tabs.current()).toBe('config')
    expect(tabEl(host, 'obs').textContent!.startsWith('obs')).toBe(true)
  })

  it('a tab with a count does not run together', () => {
    loadRealStylesheet()
    const host = mount()
    const tabs = renderTabs(host, {
      tabs: [
        { id: 'params', label: 'Params' },
        { id: 'obs', label: 'Obs' },
      ],
      initial: 'params',
      onSelect: () => {},
    })
    tabs.setCount('params', 12, '12 parameters selected')
    tabs.setCount('obs', 1, '1 site selected')

    expectNoRunTogetherText(host, 'tabs.ts renderTabs with counts')
  })
})

function parTable(n: number): Promise<ArrayBuffer> {
  const ipc = tableToIPC(
    tableFromArrays({
      parnme: Array.from({ length: n }, (_, i) => `p${i}`),
      pargp: Array.from({ length: n }, () => 'G1'),
      parlbnd: Array.from({ length: n }, () => 0),
      parubnd: Array.from({ length: n }, () => 1),
      partrans: Array.from({ length: n }, () => 'none'),
    }),
    'stream',
  )
  return Promise.resolve(ipc.buffer.slice(ipc.byteOffset, ipc.byteOffset + ipc.byteLength) as ArrayBuffer)
}

function rowNames(panel: HTMLElement): string[] {
  return Array.from(panel.querySelectorAll('.param-row')).map((row) => row.firstElementChild!.textContent ?? '')
}

describe('the Params panel inside the tabs', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  async function paramsInTabs() {
    const host = mount()
    let handle: ReturnType<typeof renderParamsPanel> | null = null
    const tabs = renderTabs(host, {
      tabs: [
        { id: 'params', label: 'Params', onShow: () => handle?.onShow(), onHide: () => handle?.onHide() },
        { id: 'obs', label: 'Obs' },
      ],
      initial: 'params',
      onSelect: () => {},
    })
    const store = createSelectionStore({
      initial: { ...emptySelection('run', 0), parGroups: new Set(['G1']) },
      schedule: () => {},
    })
    // The group summary never answers here, so the list below it is the one scroll pane.
    handle = renderParamsPanel(tabs.panel('params'), {
      unmapped: [],
      artifactNotes: [],
      parTable: parTable(500),
      store,
      loadGroups: () => new Promise(() => {}),
    })
    const pane = (await vi.waitFor(() => {
      const found = tabs.panel('params').querySelector('.scroll-pane')
      expect(found).not.toBeNull()
      return found
    })) as HTMLElement
    return { host, tabs, pane }
  }

  it('keeps its place at row 100 across a switch to Obs and back, even when the browser drops the offset', async () => {
    const { host, pane } = await paramsInTabs()
    pane.scrollTop = 100 * 24
    pane.dispatchEvent(new Event('scroll'))
    expect(rowNames(host)).toContain('p100')

    tabEl(host, 'obs').click()
    // A real browser forgets the offset of a box that is not displayed.
    pane.scrollTop = 0
    tabEl(host, 'params').click()

    expect(pane.scrollTop).toBe(100 * 24)
    expect(rowNames(host)).toContain('p100')
  })

  it('draws nothing on a scroll event while hidden, and sizes the window for the real height when shown', async () => {
    const { host, tabs, pane } = await paramsInTabs()
    const panel = tabs.panel('params')
    const before = rowNames(panel)

    tabEl(host, 'obs').click()
    pane.dispatchEvent(new Event('scroll'))
    expect(rowNames(panel)).toEqual(before)

    // The panel is taller by the time it is shown again.
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 2400 })
    tabEl(host, 'params').click()

    expect(rowNames(panel).length).toBeGreaterThan(before.length)
  })
})

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

describe('the map shell with tabs', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    holder.facts = { unmapped: [], artifactNotes: [], parTable: parTable(5) }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ divider: 0.5, colormap: 'viridis', reverse: false, scale: 'linear', limits_mode: 'robust', group: null, stat: 'value', layer: null, tab: 'params' }),
        headers: { get: () => null },
      })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function openShell() {
    const { mountMap } = await import('../src/views/map')
    const root = mount()
    const store = createSelectionStore({
      initial: { ...emptySelection('run', 0), parGroups: new Set(['G1']) },
      schedule: () => {},
    })
    mountMap(root, { config: null, state: baseState(), store })
    await vi.waitFor(() => expect(root.querySelector('.param-row')).not.toBeNull())
    return { root, store }
  }

  it('does not change the selection or wake a subscriber when tabs are switched', async () => {
    const { root, store } = await openShell()
    store.set({ cells: new Set([3]) }, 'test')
    store.flush()
    const listener = vi.fn()
    store.subscribe((snapshot) => snapshot, listener)
    const before = store.get()

    for (const id of ['obs', 'config', 'params', 'obs']) tabEl(root, id).click()
    store.flush()

    expect(listener).not.toHaveBeenCalled()
    expect(store.get()).toBe(before)
  })

  it('mounts the Obs panel in the Obs tab and says why the Config tab has nothing', async () => {
    const { root } = await openShell()

    expect(root.querySelector('#panel-obs .obs-groups')).not.toBeNull()
    expect(root.querySelector('#panel-obs')?.textContent).not.toContain('Observations will show here')
    expect(root.querySelector('#panel-config')?.textContent).toContain('configuration could not be read')
    // Reachable by clicking, with the note shown and the table panel only hidden.
    tabEl(root, 'config').click()
    expect((root.querySelector('#panel-config') as HTMLElement).hidden).toBe(false)
    expect((root.querySelector('#panel-params') as HTMLElement).hidden).toBe(true)
  })

  it('has tab labels that do not run together inside the real shell', async () => {
    loadRealStylesheet()
    const { root } = await openShell()

    expectNoRunTogetherText(root.querySelector('.tabs-bar')!, 'map shell tab bar')
    expectNoRunTogetherText(root.querySelector('#panel-obs')!, 'map shell Obs panel')
  })

  it('hides a Params panel that is rendered again while another tab is open', async () => {
    const { root } = await openShell()
    tabEl(root, 'obs').click()

    const { mountMapView } = await import('../src/views/map-view')
    const opts = vi.mocked(mountMapView).mock.calls.at(-1)![1] as { onPanelFacts: (facts: unknown) => void }
    holder.facts = { unmapped: [], artifactNotes: [], parTable: parTable(500) }
    opts.onPanelFacts(holder.facts)
    const pane = (await vi.waitFor(() => {
      const found = root.querySelector('#panel-params .scroll-pane')
      expect(found).not.toBeNull()
      return found
    })) as HTMLElement
    const before = Array.from(root.querySelectorAll('#panel-params .param-row')).length

    pane.scrollTop = 300 * 24
    pane.dispatchEvent(new Event('scroll'))
    const names = Array.from(root.querySelectorAll('#panel-params .param-row')).map((r) => r.firstElementChild!.textContent)

    expect(before).toBeGreaterThan(0)
    expect(names).not.toContain('p300')
  })
})
