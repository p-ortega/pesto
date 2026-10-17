// The map screen's shell: it builds the frame (header, notice area, the
// map column, the divider, the right panel, the status bar), owns the
// selection store, the parameter field source, the divider and the saved view
// state, and renders the Params panel. The map itself is views/map-view.ts;
// the two meet only through the store and the callbacks passed below.

import type { IngestState, ViewState } from '../data/client'
import { readViewState, writeViewState } from '../data/client'
import { emptySelection } from '../state/rules'
import { createSelectionStore, type SelectionStore } from '../state/selection'
import { renderDivider } from '../ui/divider'
import { renderParamsPanel } from '../ui/params-panel'
import { mountMapView, type MapViewHandle, type RunConfig } from './map-view'
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
  // splits it from the Params panel rendered into paramsPanelHost.
  const mapColumn = document.createElement('div')
  mapColumn.classList.add('map-column')
  const dividerEl = document.createElement('div')
  const paramsPanelHost = document.createElement('div')
  panel.appendChild(mapColumn)
  panel.appendChild(dividerEl)
  panel.appendChild(paramsPanelHost)
  const statusBar = document.createElement('div')
  statusBar.classList.add('status-bar')

  root.appendChild(header)
  root.appendChild(noticeArea)
  root.appendChild(panel)
  root.appendChild(statusBar)

  const runId = opts.state.runId ?? opts.config?.case ?? 'run'
  const store =
    opts.store ?? createSelectionStore({ initial: emptySelection(runId, opts.config?.first_iteration ?? 0) })
  const source = createParameterFieldSource({ runId })

  // D-11: the divider fraction and the map's colour/scale/group choices
  // persist per run, server-side. Every write is debounced onto one timer,
  // shared by the divider drag and every map choice, so a slider dragged
  // across several positions writes once rather than once per tick.
  let dividerFraction = 0.72
  let viewWriteTimer: ReturnType<typeof setTimeout> | null = null
  let mapView: MapViewHandle | null = null

  function scheduleViewWrite(): void {
    if (viewWriteTimer !== null) clearTimeout(viewWriteTimer)
    viewWriteTimer = setTimeout(() => {
      viewWriteTimer = null
      if (mapView === null) return
      const state: ViewState = { divider: dividerFraction, ...mapView.viewFields() }
      // A failed persist is a convenience regression, not a request failure
      // (D-11): the on-screen state is never touched, and no error surfaces.
      void writeViewState(state).catch(() => {})
    }, 400)
  }

  // Started before the map view mounts, so it is the first request the page
  // makes, ahead of the mesh and parmap fetches. A failed read is not
  // reported here: the server-side store never raises and falls back to its
  // own defaults.
  const viewStatePromise = readViewState().catch((): ViewState | null => null)
  void viewStatePromise.then((viewState) => {
    dividerFraction = viewState?.divider ?? dividerFraction
    renderDivider(dividerEl, {
      container: panel,
      before: mapColumn,
      after: paramsPanelHost,
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
    onPanelFacts: (facts) => renderParamsPanel(paramsPanelHost, facts),
    onViewStateChange: scheduleViewWrite,
  })
}
