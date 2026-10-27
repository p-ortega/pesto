// The map screen's shell: it builds the frame (header, notice area, the
// map column, the divider, the right panel, the status bar), owns the
// selection store, the parameter field source, the divider and the saved view
// state, and renders the tabbed right panel (Params, Obs, Config). The map
// itself is views/map-view.ts; the two meet only through the store and the
// callbacks passed below.

import type { IngestState, PanelTab, ViewState } from '../data/client'
import { readViewState, writeViewState } from '../data/client'
import { fetchParGroups, shareGroupsRead } from '../data/par'
import { emptySelection } from '../state/rules'
import { createSelectionStore, type SelectionStore } from '../state/selection'
import { renderDivider } from '../ui/divider'
import { renderConfigPanel, type ConfigPanelHandle } from '../ui/config-panel'
import { renderObsPanel, type ObsPanelHandle } from '../ui/obs-panel'
import { renderParamsPanel, type ParamsPanelHandle } from '../ui/params-panel'
import { renderTabs } from '../ui/tabs'
import { mountMapView, openingIteration, type MapViewFields, type MapViewHandle, type RunConfig } from './map-view'
import { createParameterFieldSource } from './parameter-field-source'

// WINDOWS.md #10: this parser lives outside views/ because style-frame.test.ts
// scans every file under views/ and ui/ for a raw hex colour literal --
// this module's own hex-digit regex and doc comments would trip that scan,
// even though it reads colours rather than writing one.
export { parseColorToken } from '../gl/color-token'
export { CONTEXT_RECOVERY_WINDOW_MS, type NoiseFact, type RunConfig } from './map-view'

export interface MountMapOptions {
  config: RunConfig | null
  state: IngestState
  /** Only for tests: the store the map view shares. The shell makes its own otherwise. */
  store?: SelectionStore
}

function savedMapFields(saved: ViewState): MapViewFields {
  const { colormap, reverse, scale, limitsMode, group, stat, layer } = saved
  return { colormap, reverse, scale, limitsMode, group, stat, layer }
}

/**
 * The map screen: header, blocked-capability notices, the map column, the
 * divider, the Params panel and the status bar. The load-and-draw sequence
 * lives in the map view mounted into the map column.
 */
export function mountMap(root: HTMLElement, opts: MountMapOptions): void {
  root.textContent = ''
  root.classList.add('page', 'page-map')

  const header = document.createElement('div')
  header.classList.add('header')
  const noticeArea = document.createElement('div')
  const panel = document.createElement('div')
  panel.classList.add('map-frame')
  // D-09: the map is on the left and always present, not a tab. The divider
  // splits it from the tabbed panel rendered into rightPanelHost.
  const mapColumn = document.createElement('div')
  mapColumn.classList.add('map-column')
  const dividerEl = document.createElement('div')
  const rightPanelHost = document.createElement('div')
  panel.appendChild(mapColumn)
  panel.appendChild(dividerEl)
  panel.appendChild(rightPanelHost)
  const statusBar = document.createElement('div')
  statusBar.classList.add('status-bar')

  root.appendChild(header)
  root.appendChild(noticeArea)
  root.appendChild(panel)
  root.appendChild(statusBar)

  // The store's run id only tells two runs apart; the field source keys its requests on the real id or none.
  const storeRunId = opts.state.runId ?? opts.config?.case ?? 'run'
  const store =
    opts.store ??
    createSelectionStore({ initial: emptySelection(storeRunId, openingIteration(opts.config, opts.state).iteration) })
  const source = createParameterFieldSource({ runId: opts.state.runId ?? null })

  // D-11: the divider fraction and the map's colour/scale/group choices
  // persist per run, server-side. Every write is debounced onto one timer,
  // shared by the divider drag and every map choice, so a slider dragged
  // across several positions writes once rather than once per tick.
  let dividerFraction = 0.72
  let viewWriteTimer: ReturnType<typeof setTimeout> | null = null
  let mapView: MapViewHandle | null = null
  // D-09: the last open tab is saved with the divider. A run opened for the
  // first time starts on Params.
  let currentTab: PanelTab = 'params'
  let userPickedTab = false

  function scheduleViewWrite(): void {
    if (viewWriteTimer !== null) clearTimeout(viewWriteTimer)
    viewWriteTimer = setTimeout(() => {
      viewWriteTimer = null
      if (mapView === null) return
      const view = mapView
      void viewStatePromise.then((saved) => {
        // Until the map has settled its choices, the saved ones are kept as they were.
        const fields = view.viewFields() ?? (saved === null ? null : savedMapFields(saved))
        if (fields === null) return
        const state: ViewState = { divider: dividerFraction, ...fields, tab: currentTab }
        // A failed persist is a convenience regression, not a request failure
        // (D-11): the on-screen state is never touched, and no error surfaces.
        void writeViewState(state).catch(() => {})
      })
    }, 400)
  }

  // The Params panel can be rendered more than once; hide and show go to the
  // latest one.
  let paramsHandle: ParamsPanelHandle | null = null
  // The group summary does not change with the iteration, so one read serves
  // every panel drawn; a refused or failed read is forgotten so the next show asks again.
  const loadGroups = shareGroupsRead(() => fetchParGroups())

  let configHandle: ConfigPanelHandle | null = null
  let obsHandle: ObsPanelHandle | null = null

  const tabs = renderTabs(rightPanelHost, {
    tabs: [
      { id: 'params', label: 'Params', onShow: () => paramsHandle?.onShow(), onHide: () => paramsHandle?.onHide() },
      { id: 'obs', label: 'Obs', onShow: () => obsHandle?.onShow(), onHide: () => obsHandle?.onHide() },
      { id: 'config', label: 'Config', onShow: () => configHandle?.onShow(), onHide: () => configHandle?.onHide() },
    ],
    initial: currentTab,
    onSelect: (id) => {
      userPickedTab = true
      currentTab = id as PanelTab
      scheduleViewWrite()
    },
  })

  obsHandle = renderObsPanel(tabs.panel('obs'), {
    store,
    capabilities: opts.state.capabilities,
    startHidden: tabs.current() !== 'obs',
  })

  configHandle = renderConfigPanel(tabs.panel('config'), { config: opts.config })

  // Started before the map view mounts, so it is the first request the page
  // makes, ahead of the mesh and parmap fetches. A failed read is not
  // reported here: the server-side store never raises and falls back to its
  // own defaults.
  const viewStatePromise = readViewState().catch((): ViewState | null => null)
  void viewStatePromise.then((viewState) => {
    dividerFraction = viewState?.divider ?? dividerFraction
    // A tab the user already clicked before the saved state landed wins.
    if (viewState?.tab !== undefined && !userPickedTab) {
      currentTab = viewState.tab
      tabs.select(viewState.tab)
    }
    renderDivider(dividerEl, {
      container: panel,
      before: mapColumn,
      after: rightPanelHost,
      initialFraction: dividerFraction,
      onCommit: (fraction) => {
        dividerFraction = fraction
        scheduleViewWrite()
      },
    })
  })

  mapView = mountMapView(mapColumn, {
    store,
    source,
    config: opts.config,
    state: opts.state,
    header,
    noticeArea,
    statusBar,
    viewState: viewStatePromise,
    onPanelFacts: (facts) => {
      paramsHandle?.dispose()
      paramsHandle = renderParamsPanel(tabs.panel('params'), {
        ...facts,
        store,
        loadGroups,
        startHidden: tabs.current() !== 'params',
        parView: opts.state.capabilities.parView,
      })
    },
    onViewStateChange: scheduleViewWrite,
  })
}
