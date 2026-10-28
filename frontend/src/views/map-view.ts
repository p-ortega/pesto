// The map view: canvas, camera, GL layer, picking, controls, legend,
// readout, group picker and map notices, and the load-and-draw sequence that
// turns a run's mesh, parameter table and one realization's field into a
// WebGL2 drawing. It reaches other views only through the shared store; the
// shell (views/map.ts) owns the frame, the divider and the Params panel.

import { ApiError, type IngestState, type MeshInfo, type ViewState } from '../data/client'
import { gridIdomain, gridMesh, gridMeshBuffer } from '../data/client'
import { chipFactsFrom, type ConfigFact } from '../data/config'
import { pickPoint, pickPointsWithin, pointsOnLayer, type DrawnPoints } from '../data/points'
import { fetchObsGroups, fetchObsSite, OBS_STAT_LABEL, shareRead, type ObsSitePayload, type ObsStat } from '../data/obs'
import { inactiveLandingNotes, layerActiveMask } from '../data/domain'
import { fetchPlacement } from '../data/par'
import { frameLogInstalled, markFrame } from '../perf'
import type { CellClass, ParIdentity } from '../data/parmap'
import {
  EMPTY_PP_INDEX,
  fieldContributors,
  type Contributor,
  type PpGroupInfo,
  type PpIndex,
} from '../data/fields'
import { Camera, wheelZoomFactor } from '../gl/camera'
import { applyScale, logIsUsable, scaleLimits, subsetValues, LimitsMemory, type ColormapName, type ValueScale } from '../gl/colormap'
import { readColorToken, readNumberToken } from '../gl/color-token'
import { createContext, type GlContext } from '../gl/context'
import { MeshLayer, type MeshData } from '../gl/mesh-layer'
import { pickAtWorld, preparePickIndex } from '../gl/picking'
import { renderSelectionControls, type FieldChoice, type SelectionControlsHandle } from '../ui/controls'
import { renderLegend, type LegendOptions } from '../ui/legend'
import { iterationsFrom, renderIterationToggle, type IterationToggleHandle } from '../ui/iteration-toggle'
import { fetchBase, type BaseResult, type RealNamesResult } from '../data/reals'
import { renderBaseChip } from '../ui/base-chip'
import { BASE_STYLE } from '../ui/charts/base-style'
import { renderOverlayControls, type OverlayControlsHandle } from '../ui/overlay-controls'
import { renderGroupPicker, type GroupPickerState } from '../ui/group-picker'
import { renderReadout, type ReadoutPick, type SiteReadoutEntry } from '../ui/readout'
import { renderTimeSlider, type TimeSliderHandle } from '../ui/time-slider'
import { formatTimeValue } from '../ui/charts/time-axis'
import {
  isObsStat,
  OBS_RAMP,
  renderObsColourControls,
  renderObsLegend,
  type ObsColourControlsHandle,
} from '../ui/obs-colour-controls'
import {
  prefersReducedMotion,
  renderHeader,
  renderNotice,
  renderStatusBar,
  type ChipsInput,
  type NoticeTone,
  type RenderNoticeOptions,
} from '../ui/chrome'
import { currentTheme, setTheme, type ThemeChoice } from '../ui/theme'
import {
  activeMask,
  computeGroupPlacement,
  computePerCell as computePerCellFor,
  dotLayerFor as dotLayerForGroup,
  drawsAsPoints as drawsAsPointsFor,
  footprintMask,
  interpolatedEntry as findInterpolatedEntry,
  partransForGroup,
  type MaskCache,
  type ParameterFieldSource,
  type RecordedPlacement,
  type UnmappedEntry,
} from './parameter-field-source'
import {
  carryTime,
  countsAtTime,
  createObservationStatSource,
  dotsFor,
  valuesForDots,
  type ObsDots,
  type ObsGroupData,
  type TimePosition,
} from './observation-stat-source'
import { fetchLinkCell, type CellLinkResult } from '../data/link'
import { createOverlaySource, type OverlayInputs } from './overlay-source'
import { LatestWins } from '../data/latest-wins'
import { buildPointFlags } from '../data/hatch-mask'
import {
  missingValueLine,
  offScreenCount,
  offScreenLine,
  parameterLines,
  parameterRingCells,
  selectedDotIndices,
  whereLines,
} from '../data/link-follow'
import { fetchLinkPar, fetchLinkSites, MAX_LINK_PARS, MAX_LINK_SITES, type ParLinkResult, type SitesWhereResult } from '../data/link-targets'
import { modeOf } from '../state/modifiers'
import { sameSet, selectCells, selectPars, selectSites, type SelectMode, type SharedSelection } from '../state/rules'
import type { SelectionStore } from '../state/selection'

// MAP-08: how long a lost context is given to come back on its own before
// this falls to the unrecoverable designed state. Not specified by any
// source document -- a planner judgment call, long enough that an ordinary
// tab-switch or GPU driver hiccup recovers within it, short enough that a
// genuinely dead context does not leave the user waiting indefinitely.
export const CONTEXT_RECOVERY_WINDOW_MS = 5000

export interface NoiseFact {
  has_noise: boolean | null
  decided_by: string
  evidence: string[]
  notes: string[]
}

export interface RunConfig {
  case: string
  n_par: number | null
  n_real: number | null
  base_realization: boolean | null
  n_iterations: number | null
  noptmax: number | null
  first_iteration: number | null
  projection: string | null
  projection_known: boolean
  noise: NoiseFact
  /** Absent in a config from before the facts existed, and in older test fixtures. */
  facts?: ConfigFact[]
  facts_version?: number | null
  facts_note?: string
  par_iterations?: number[]
}

/** What the Params panel needs; the map view finds it out, the shell renders it. */
export interface PanelFacts {
  unmapped: UnmappedEntry[]
  artifactNotes: { artifact: string; reason: string }[]
  parTable: Promise<ArrayBuffer>
}

/** The map's own choices that the shell saves, next to the divider. */
export type MapViewFields = Pick<
  ViewState,
  'colormap' | 'reverse' | 'scale' | 'limitsMode' | 'group' | 'stat' | 'layer'
>

export interface MapViewOptions {
  store: SelectionStore
  source: ParameterFieldSource
  config: RunConfig | null
  state: IngestState
  /** The shell's elements; the map view paints into them. */
  header: HTMLElement
  noticeArea: HTMLElement
  statusBar: HTMLElement
  /** Started by the shell before the mesh fetch, so request order is kept. */
  viewState: Promise<ViewState | null>
  onPanelFacts(facts: PanelFacts): void
  onViewStateChange(): void
}

export interface MapViewHandle {
  /** Null until the map has read the saved choices and settled its own; nothing it holds before that was chosen. */
  viewFields(): MapViewFields | null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

/** The iteration the map opens on, and a note to show when the run's configuration did not name it. */
export function openingIteration(config: RunConfig | null, state: IngestState): { iteration: number; note: string | null } {
  if (config !== null && config.first_iteration !== null) return { iteration: config.first_iteration, note: null }
  const ingested = iterationsFrom(state)
  if (ingested.length > 0) {
    const first = ingested[0]
    return {
      iteration: first,
      note: `The run's configuration does not name it, so the map opens on iteration ${first}, the lowest one with a parameter ensemble.`,
    }
  }
  return {
    iteration: 0,
    note: "Neither the run's configuration nor the ingest names an iteration, so the map tries iteration 0.",
  }
}

type ObsSiteRead = { state: 'loading' } | { state: 'done'; payload: ObsSitePayload } | { state: 'failed'; reason: string }

// A site's observed value is read for at most this many listed entries.
const OBS_SITE_LIST_CAP = 20

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)} s`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Names the artifact and the reason a problem+json body carried, rather
// than a generic message -- the "No cell mapping" designed state names
// both, never a bare "could not be read" (CLAUDE.md's second and third
// hard rules).
function problemArtifactAndReason(error: unknown): { artifact: string | null; reason: string } {
  if (error instanceof ApiError) {
    return { artifact: error.problem.artifact ?? null, reason: error.problem.detail ?? error.problem.title }
  }
  return { artifact: null, reason: describeError(error) }
}

// A fresh child per call, so several notices can sit in the same
// container without each new one erasing the last -- renderNotice itself
// clears whatever element it is given, which is right for one slot and
// wrong for a list of them.
function addNotice(container: HTMLElement, opts: RenderNoticeOptions): void {
  const el = document.createElement('div')
  renderNotice(el, opts)
  container.appendChild(el)
}

const CAPABILITY_LABELS: Record<'map' | 'stats' | 'chips', string> = {
  map: 'the map',
  stats: 'the summary statistics',
  chips: "the run's own configuration chips",
}

const BLOCKED_TONE: NoticeTone = 'warning'

// D-12's rule applied to a screen the user reaches after leaving the
// ingest screen, or after a reload: a blocked capability's artifact and
// its recorded reason must still be told here, not only on a screen the
// user has already left.
function renderBlockedCapabilities(container: HTMLElement, state: IngestState): void {
  container.textContent = ''

  const capabilities = [
    ['map', state.capabilities.map] as const,
    ['stats', state.capabilities.stats] as const,
    ['chips', state.capabilities.chips] as const,
  ]

  for (const [name, capability] of capabilities) {
    if (capability.available) {
      continue
    }
    for (const block of capability.blockedBy) {
      addNotice(container, {
        title: `${CAPABILITY_LABELS[name]} is unavailable`,
        detail: `${block.artifact}: ${block.reason}`,
        tone: BLOCKED_TONE,
      })
    }
  }
}

// D-11's restored view state carries plain strings from a JSON file on
// disk, not the closed unions the rest of this module trusts -- a value
// this code has never seen (an older store, a hand-edited file) falls back
// to the same default the fresh-run path already uses, rather than being
// trusted blind.
const KNOWN_COLORMAPS = new Set([
  'viridis',
  'magma',
  'cividis',
  'greys',
  'RdBu',
  'coolwarm',
  'BrBG',
  'turbo',
  'jet',
])

function restoredColormap(value: string | undefined): ColormapName {
  return value !== undefined && KNOWN_COLORMAPS.has(value) ? (value as ColormapName) : 'viridis'
}

const KNOWN_STATS = new Set(['value', 'mean', 'std', 'q05', 'q25', 'q50', 'q75', 'q95'])

function restoredStat(value: string | undefined, realNamesOk: boolean): FieldChoice['stat'] {
  if (value !== undefined && KNOWN_STATS.has(value)) {
    if (value === 'value' && !realNamesOk) return 'mean'
    return value as FieldChoice['stat']
  }
  return realNamesOk ? 'value' : 'mean'
}

// WINDOWS.md #11: the view-state wire (prefs.py's _VIEW_STATE_DEFAULTS,
// ViewStateWire in client.ts) has a field for the limits MODE but none at
// all for a manual PAIR -- the numbers a manual choice needs were never
// saved. A restored 'manual' mode is therefore never trustworthy on its
// own: trusting it draws a fabricated range (committed.manualLimits stays
// null, so deriveAndDraw falls to [0, 1]; a later control interaction can
// even compute [0, 0] from the empty number inputs) and presents it as the
// pair the user actually chose. Falling back to robust here, with a notice
// naming why, is the honest version of "we don't actually know this."
function restoredLimitsMode(mode: ViewState['limitsMode']): 'robust' | 'minmax' {
  return mode === 'manual' ? 'robust' : mode
}

/**
 * The map view: the canvas panel and everything floating over it, then the
 * load-and-draw sequence -- mesh, the D-05 join, the cell/layer companions,
 * one realization's field -- ending in one WebGL2 draw of one parameter
 * group's field on a themed canvas. Paints the shell's header, notice area
 * and status bar, and mounts into `host` (the map column).
 */
export function mountMapView(host: HTMLElement, opts: MapViewOptions): MapViewHandle {
  const { store, source, header, noticeArea, statusBar } = opts
  host.textContent = ''

  // The positioning context for the four floating overlays is the canvas's
  // own box, not the whole map column -- the column also holds mapNotice below
  // the canvas, and anchoring "bottom" to the column's bottom would pull the
  // legend and readout down over that notice text instead of the map.
  const mapCanvasArea = document.createElement('div')
  mapCanvasArea.classList.add('map-area')
  const canvas = document.createElement('canvas')
  // A fallback only: fitCanvasToFrame below sizes the canvas to its box as
  // soon as the box has a layout, and keeps it there.
  canvas.width = 800
  canvas.height = 480
  canvas.tabIndex = 0
  canvas.setAttribute('aria-label', 'Model grid map: drag to pan, scroll to zoom, arrow keys pan, + and - zoom, Home fits to extent')
  const mapNotice = document.createElement('div')
  mapNotice.setAttribute('data-testid', 'map-notices')
  // Visual contract §6: controls top-left, legend bottom-left, readout
  // bottom-right. The group picker isn't in that diagram -- it rides in
  // the same top-left cluster as the controls, stacked under them, since
  // it's a selection control too and has no other place the contract names.
  const topLeftEl = document.createElement('div')
  topLeftEl.classList.add('floating-top-left')
  const legendEl = document.createElement('div')
  legendEl.classList.add('floating-bottom-left')
  const pickerEl = document.createElement('div')
  // Hidden by the .colour-obs rules while the map is coloured by observations.
  pickerEl.setAttribute('data-colour-source', 'par')
  const readoutEl = document.createElement('div')
  readoutEl.classList.add('floating-bottom-right')
  topLeftEl.appendChild(pickerEl)
  // Two notices about the shown iteration. Each is replaced on every switch,
  // never stacked: the drawn realization or group is missing (D-04), and how
  // many selected realizations are missing (D-03).
  const iterationNotes = document.createElement('div')
  // A switch that leaves the map empty must be heard, not only seen.
  iterationNotes.setAttribute('role', 'status')
  const drawnNoticeEl = document.createElement('div')
  drawnNoticeEl.setAttribute('data-testid', 'iteration-drawn-notice')
  const selectedNoticeEl = document.createElement('div')
  selectedNoticeEl.setAttribute('data-testid', 'iteration-selected-notice')
  iterationNotes.appendChild(drawnNoticeEl)
  iterationNotes.appendChild(selectedNoticeEl)
  mapNotice.appendChild(iterationNotes)
  // The observation colouring's own notice, replaced on every draw, never stacked.
  const obsNoticeEl = document.createElement('div')
  obsNoticeEl.setAttribute('data-testid', 'obs-notices')
  obsNoticeEl.setAttribute('role', 'status')
  mapNotice.appendChild(obsNoticeEl)
  mapCanvasArea.appendChild(topLeftEl)
  mapCanvasArea.appendChild(canvas)
  mapCanvasArea.appendChild(legendEl)
  mapCanvasArea.appendChild(readoutEl)
  host.appendChild(mapCanvasArea)
  host.appendChild(mapNotice)

  let ctx: GlContext | null = null
  let layer: MeshLayer | null = null
  let meshBytes: number | null = null
  // Set once the mesh and camera are loaded (loadAndDraw) -- the click
  // handler is wired from mount, so both are nullable until then.
  let camera: Camera | null = null
  let meshGeom: MeshData | null = null
  let selectedCellId: number | null = null
  // One request at a time for what the clicked cells hold; a newer click makes an older answer stale.
  const linkSlot = new LatestWins<CellLinkResult>()
  // The cell set a request is out for, so a quick second shift-click adds to it, not to the store's older set.
  let pendingCells: ReadonlySet<number> | null = null

  function dropPendingLink(): void {
    linkSlot.cancel()
    pendingCells = null
  }

  // The cells last handed to the layer as rings, so a write that changes nothing draws nothing.
  // A new layer rings nothing.
  let ringedKey = ''
  // Cells of parameters picked outside the map, on the drawn layer.
  let parRingCells: readonly number[] = []
  // Where the parameters picked outside the map are (/link/par); null while none is held.
  const parSlot = new LatestWins<ParLinkResult>()
  let parAnswer: ParLinkResult | null = null
  let parRingsFor: { answer: ParLinkResult; layer: number } | null = null
  let parLines: string[] = []
  // Where the selected sites are and whether they have a value this iteration (/link/sites).
  const sitesSlot = new LatestWins<SitesWhereResult>()
  let sitesAnswer: SitesWhereResult | null = null
  // The ringed site dots and the positions they index, for the off-screen count.
  let ringedSiteDots: number[] = []
  let ringedSiteXy: Float32Array | null = null
  // D-09, D-10: how many selected items the map cannot draw, and why. It never moves the map to show them.
  const whereEl = document.createElement('div')
  whereEl.setAttribute('data-testid', 'selection-where')
  whereEl.setAttribute('role', 'status')
  whereEl.classList.add('floating')
  whereEl.hidden = true
  topLeftEl.appendChild(whereEl)
  let whereText = ''

  // Rings the cell set of an unanswered click when there is one, else the store's cells, plus the
  // picked parameters' cells. Says whether the rings changed, so the caller redraws once.
  function refreshRings(): boolean {
    if (!layer) return false
    const ring = new Set(pendingCells ?? store.get().cells)
    for (const cell of parRingCells) ring.add(cell)
    const ids = [...ring].sort((a, b) => a - b)
    const key = ids.join(',')
    if (key === ringedKey) return false
    ringedKey = key
    // setSelected is the one-element form of setSelectedCells.
    if (ids.length <= 1) layer.setSelected(ids[0] ?? null)
    else layer.setSelectedCells(ids)
    return true
  }

  // What the layer's dots are now, so dot marks are never handed to a set of another length.
  let pointsSerial = 0
  let drawnPoints: { kind: 'none' | 'par' | 'obs'; count: number } = { kind: 'none', count: 0 }
  // The dot marks last handed to the layer; setPoints clears them, so a new set changes the key.
  let marksKey: string | null = null

  function putPoints(xy: Float32Array, values: Float32Array, kind: 'par' | 'obs' = 'par'): void {
    if (!layer) return
    layer.setPoints(xy, values)
    pointsSerial += 1
    drawnPoints = { kind: values.length === 0 ? 'none' : kind, count: values.length }
  }

  // The two overlays (D-21 to D-29): one source for both answers, one hatch pass, swatches in dots.
  const overlaySource = createOverlaySource()
  let overlayControls: OverlayControlsHandle | null = null
  // The iteration and group last asked for, and what the last build was made from. A build runs
  // only when one of these moves, never on a pan or zoom frame.
  let overlayAsked: string | null = null
  let overlayBuiltFrom: string | null = null
  let overlayAnswers = 0
  let overlayHatched = false
  // Swatches for the drawn dots, good only for the dot set they were built for.
  let overlayDots: { serial: number; key: string; atBounds: ReadonlySet<number>; conflict: ReadonlySet<number> } = {
    serial: -1,
    key: '',
    atBounds: new Set(),
    conflict: new Set(),
  }

  function overlayInputs(nCells: number): OverlayInputs {
    const { kind, count } = drawnPoints
    const pointRows = kind === 'par' && currentPoints.rows.length === count ? currentPoints.rows : null
    let dotSiteIds: Int32Array | null = null
    if (kind === 'obs' && obsDots !== null && obsData !== null && obsDots.rows.length === count) {
      const data = obsData
      dotSiteIds = Int32Array.from(obsDots.rows, (row) => data.rows[row].siteId)
    }
    return {
      nCells,
      layer: committed.layer,
      // The all-layers switch is shown only while the map is coloured by observations.
      allLayers: obsActive && obsAllLayers,
      colourSource: obsActive ? 'obs' : 'par',
      parGroup: drawnGroup,
      joined,
      cellArray,
      layerArray,
      pointRows,
      obsGroup: obsActive ? obsGroupInUse : null,
      dotSiteIds,
    }
  }

  // Asks for the shown iteration's answers when the iteration or group moved, and rebuilds the
  // hatch from the held answers otherwise. Says whether the hatch changed, so the caller redraws.
  function refreshOverlays(): boolean {
    if (!layer || !mesh || !overlayControls) return false
    const controls = overlayControls
    const iteration = loadingIteration ?? committed.iteration
    const group = drawnGroup
    const asked = `${iteration}|${group}`
    if (asked !== overlayAsked) {
      overlayAsked = asked
      overlaySource.load(iteration, group).then(
        (answer) => {
          if (answer.stale || overlayAsked !== asked) return
          overlayAnswers += 1
          redrawOverlays()
        },
        () => {},
      )
    }
    // While an iteration's tables load, the held cells are the old iteration's.
    const loading = loadingIteration !== null
    const from = loading
      ? 'loading'
      : `${overlayAnswers}|${asked}|${committed.layer}|${obsActive}|${obsAllLayers}|${obsGroupInUse}|${pointsSerial}`
    if (from === overlayBuiltFrom) return false
    overlayBuiltFrom = from
    let mask: Uint8Array | null = null
    let atDots: ReadonlySet<number> = new Set()
    let conflictDots: ReadonlySet<number> = new Set()
    if (loading) {
      controls.setStatus('atBounds', { kind: 'loading' })
      controls.setStatus('conflict', { kind: 'loading' })
    } else {
      const inputs = overlayInputs(mesh.nCells)
      // Built once for the words, then again only when the user has one of the toggles off.
      let build = overlaySource.build(inputs, { atBounds: true, conflict: true })
      controls.setStatus('atBounds', build.atBounds)
      controls.setStatus('conflict', build.conflict)
      const enabled = { atBounds: controls.isOn('atBounds'), conflict: controls.isOn('conflict') }
      if (!enabled.atBounds || !enabled.conflict) build = overlaySource.build(inputs, enabled)
      mask = build.mask
      atDots = build.atBoundsDots
      conflictDots = build.conflictDots
    }
    overlayDots = { serial: pointsSerial, key: `${[...atDots].join(',')}/${[...conflictDots].join(',')}`, atBounds: atDots, conflict: conflictDots }
    if (mask === null && !overlayHatched) return false
    layer.setHatch(mask)
    overlayHatched = mask !== null
    return true
  }

  // An answer landed or a toggle moved: the hatch and swatches are redone, and drawn once any field is.
  function redrawOverlays(): void {
    const hatch = refreshOverlays()
    const dots = refreshPointMarks()
    if ((hatch || dots) && canvas.getAttribute('data-drawn') === 'true') redraw()
  }

  // Site dots follow selection.sites and pilot-point dots follow selection.pars: the selected ones
  // are ringed and, while their kind has a selection, the rest dim (D-02). Never a hidden dot.
  // The at-bounds and conflict swatches sit next to the dim flag, from the last overlay build.
  function refreshPointMarks(): boolean {
    if (!layer) return false
    const selection = store.get()
    const { kind, count } = drawnPoints
    let selected: number[] = []
    let dimOn = false
    ringedSiteDots = []
    ringedSiteXy = null
    if (kind === 'obs' && obsDots !== null && obsData !== null && obsDots.rows.length === count) {
      const data = obsData
      selected = selectedDotIndices(obsDots.rows, (row) => data.rows[row].siteId, selection.sites)
      dimOn = selection.sites.size > 0
      ringedSiteDots = selected
      ringedSiteXy = obsDots.xy
    } else if (kind === 'par' && currentPoints.rows.length === count) {
      selected = selectedDotIndices(currentPoints.rows, (row) => joined[row]?.parnme ?? null, selection.pars)
      dimOn = selection.pars.size > 0
    }
    const swatches = overlayDots.serial === pointsSerial ? overlayDots : null
    const atDots = swatches !== null && swatches.atBounds.size > 0 ? swatches.atBounds : null
    const conflictDots = swatches !== null && swatches.conflict.size > 0 ? swatches.conflict : null
    const hasOverlay = atDots !== null || conflictDots !== null
    const key = `${pointsSerial}|${dimOn}|${selected.join(',')}|${hasOverlay ? swatches!.key : ''}`
    if (key === marksKey) return false
    marksKey = key
    layer.setSelectedPoints(selected)
    if (count === 0 || (!dimOn && !hasOverlay)) {
      layer.setPointFlags(null)
    } else {
      const chosen = new Set(selected)
      layer.setPointFlags(
        buildPointFlags(count, {
          atBounds: atDots !== null ? (dot) => atDots.has(dot) : undefined,
          conflict: conflictDots !== null ? (dot) => conflictDots.has(dot) : undefined,
          dim: dimOn ? (dot) => !chosen.has(dot) : undefined,
        }),
      )
    }
    return true
  }

  // Everything the map marks from the shared selection, then one redraw if any of it changed.
  // Runs after every dot draw, layer change and time change, so a redraw never loses a mark.
  function refreshMarks(draw = true): void {
    refreshParRings()
    const rings = refreshRings()
    const hatch = refreshOverlays()
    const dots = refreshPointMarks()
    if ((rings || hatch || dots) && draw) redraw()
    renderWhere()
  }

  // The held /link/par answer on the drawn layer; worked out again only when the answer or layer moves.
  function refreshParRings(): void {
    const answer = parAnswer
    if (answer === null) {
      parRingsFor = null
      parRingCells = []
      parLines = []
      return
    }
    if (parRingsFor !== null && parRingsFor.answer === answer && parRingsFor.layer === committed.layer) return
    parRingsFor = { answer, layer: committed.layer }
    if (!answer.ok) {
      parRingCells = []
      parLines = [`The cells of the selected parameters could not be read: ${answer.artifact}: ${answer.reason}`]
      return
    }
    const rings = parameterRingCells(answer, committed.layer)
    parRingCells = rings.cells
    parLines = parameterLines(rings)
  }

  // The world box the camera shows now, as [minX, minY, maxX, maxY].
  function cameraBox(): [number, number, number, number] | null {
    if (!camera) return null
    const [ax, ay] = camera.screenToWorld(0, 0)
    const [bx, by] = camera.screenToWorld(canvas.width, canvas.height)
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
  }

  // Local work only, so it can run on every pan frame; the lines are rebuilt only when they change.
  function renderWhere(): void {
    const lines = [...parLines]
    const answer = sitesAnswer
    if (answer !== null && store.get().sites.size > 0) {
      if (!answer.ok) {
        lines.push(`Where the selected sites are could not be read: ${answer.artifact}: ${answer.reason}`)
      } else {
        const drawn = { colourSource: obsActive ? 'obs' : 'par', group: obsGroupInUse, layer: committed.layer, allLayers: obsAllLayers } as const
        lines.push(...whereLines(answer, drawn))
      }
    }
    const box = ringedSiteDots.length > 0 ? cameraBox() : null
    if (box !== null && ringedSiteXy !== null) {
      const off = offScreenLine(offScreenCount(ringedSiteXy, ringedSiteDots, box))
      if (off !== null) lines.push(off)
    }
    const text = lines.join('\n')
    if (text === whereText) return
    whereText = text
    whereEl.textContent = ''
    for (const line of lines) {
      const el = document.createElement('div')
      el.classList.add('link-reach')
      el.textContent = line
      whereEl.appendChild(el)
    }
    whereEl.hidden = lines.length === 0
  }

  // Parameters picked outside the map ring the cells they set; the map's own writes already ring theirs.
  function followPars(origins: ReadonlySet<string>): void {
    const names = [...store.get().pars].sort()
    parAnswer = null
    if (names.length === 0 || [...origins].every((origin) => origin === 'map')) {
      parSlot.cancel()
      refreshMarks()
      return
    }
    refreshMarks()
    const key = `${names.length}|${JSON.stringify(names.slice(0, MAX_LINK_PARS))}`
    void parSlot.run(key, (signal) => fetchLinkPar(names, { signal })).then(
      (result) => {
        if (result.stale) return
        parAnswer = result.value
        refreshMarks()
      },
      (error: unknown) => {
        parAnswer = { ok: false, artifact: 'link/par', reason: problemArtifactAndReason(error).reason }
        refreshMarks()
      },
    )
  }

  // Asked when the sites or the shown iteration change, whoever wrote them; it only reads and draws.
  function askSitesWhere(): void {
    const ids = [...store.get().sites].sort((a, b) => a - b)
    const iteration = committed.iteration
    if (ids.length === 0) {
      sitesSlot.cancel()
      sitesAnswer = null
      renderWhere()
      renderSelectedNotice()
      return
    }
    const key = `${iteration}|${ids.length}|${ids.slice(0, MAX_LINK_SITES).join(',')}`
    if (sitesSlot.current() === key) return
    sitesAnswer = null
    renderWhere()
    renderSelectedNotice()
    const land = (answer: SitesWhereResult): void => {
      sitesAnswer = answer
      renderWhere()
      renderSelectedNotice()
    }
    void sitesSlot.run(key, (signal) => fetchLinkSites(ids, iteration, { signal })).then(
      (result) => {
        if (!result.stale) land(result.value)
      },
      (error: unknown) => land({ ok: false, artifact: 'link/sites', reason: problemArtifactAndReason(error).reason }),
    )
  }

  // MAP-08: true from webglcontextlost until webglcontextrestored (or the
  // unrecoverable fallback fires). Guards redraw() so nothing calls into a
  // context the browser has already taken away. The selection, camera and
  // drawn group are untouched by any of this -- they are plain JS state,
  // never invalidated by losing the GL context, so recovery has nothing to
  // reconstruct beyond the GPU objects layer.reupload() already rebuilds.
  let contextLost = false
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null

  // The raw block-order field for the selection currently committed to the
  // canvas, as fetched -- never transformed, so a scale change can derive
  // from it without a fetch. `committed` is that selection; `pending` is a
  // newer one whose fetch has not landed yet, shown in the status bar
  // while the canvas keeps drawing the last field that did.
  let rawFullField: Float32Array | null = null
  let rawFieldNonPositiveCount = 0
  // The applyScale-transformed field actually reprojected and drawn --
  // cached against the scale it was computed for, since a pure layer
  // change never needs to redo an O(n) transform of the whole field.
  let scaledField: Float32Array | null = null
  let scaledFieldScale: ValueScale | null = null
  // A field currently reprojected per cell for the drawn layer -- kept so
  // applyLayer has something to filter without recomputing the transform.
  let fullField: Float32Array | null = null
  let committed: FieldChoice = {
    iteration: 0,
    layer: 0,
    stat: 'value',
    realization: null,
    colormap: 'viridis',
    reverseColormap: false,
    scale: 'linear',
    scaleInferred: true,
    limitsMode: 'robust',
    manualLimits: null,
  }
  let pending: FieldChoice | null = null
  // What picks the values of the field held (null when none is held) and of
  // the fetch that is out (null when none is). See fieldKey.
  let heldKey: string | null = null
  let inFlightKey: string | null = null
  // The last choice this view put into the store, so a control move writes
  // only the fields it changed.
  let reported: FieldChoice = committed
  let statusError: string | null = null
  let rafScheduled = false
  const limitsMemory = new LimitsMemory()
  let controlsHandle: SelectionControlsHandle | null = null
  let toggleHandle: IterationToggleHandle | null = null
  // The iteration whose tables, cell arrays and names the view holds now.
  let loadedIteration = 0
  let realNames: RealNamesResult = { ok: false, iteration: 0, reason: '' }
  // The realization the user last picked by name. It follows an iteration
  // switch by name; its slider position never does.
  let wantedRealization: string | null = null
  // True while the shown iteration lacks the wanted realization (or recorded no names).
  let realizationMissing = false
  // The drawn group, when the shown iteration has nothing to draw for it.
  let groupGone: string | null = null
  // A newer iteration switch or field landing makes older fetches drop their answers.
  let generation = 0
  let switchSerial = 0
  // The iteration whose tables are loading. Until they land, the held field
  // and cells are the old iteration's, so a click would describe the wrong one.
  let loadingIteration: number | null = null

  // Set once loadAndDraw has put the restored or fresh choices into `committed`.
  let choicesSettled = false

  // D-11: the shell saves the divider and these choices together, on one
  // debounced timer. This view only says when one of its choices moved.
  function viewFields(): MapViewFields | null {
    if (!choicesSettled) return null
    return {
      colormap: committed.colormap,
      reverse: committed.reverseColormap,
      scale: committed.scale,
      limitsMode: committed.limitsMode,
      group: drawnGroup,
      stat: committed.stat,
      layer: committed.layer,
    }
  }

  function scheduleViewWrite(): void {
    opts.onViewStateChange()
  }

  // Loaded once at mount and constant afterwards -- this plan carries no
  // iteration selector, so a redraw only ever needs the layer to change.
  let mesh: MeshInfo | null = null
  let joined: Array<ParIdentity | null> = []
  let cellArray: Int32Array = new Int32Array(0)
  let layerArray: Int32Array = new Int32Array(0)
  // The grid file's idomain, flat and layer-major; null when the grid has none.
  let idomain: Int32Array | null = null
  // x/y of every block row placed by position, NaN elsewhere; null when the run recorded none.
  let pointXy: Float32Array | null = null
  let currentPoints: DrawnPoints = { rows: new Int32Array(0), xy: new Float32Array(0) }
  // Held as a block row, not a dot index, since a layer change changes which dots are drawn.
  let selectedPointRow: number | null = null
  const maskCache: MaskCache = { referenced: null }
  let drawnGroup: string | null = null
  // Interpolated pilot-point groups. `fieldKind` says what rawFullField
  // holds: block rows from /values, or one value per cell from /field.
  // What pesto recorded about each group's placement, read once per run; undefined until read or when it could not be.
  let recordedPlacement: ReadonlyMap<string, RecordedPlacement> | undefined
  let placementNotes: string[] = []
  let ppIndex: PpIndex = EMPTY_PP_INDEX
  let allIdentities: ParIdentity[] = []
  let fieldKind: 'block' | 'cell' = 'block'
  // The group a per-cell field was fetched for; it keeps drawing as that
  // group until the next fetch lands, even if the picker moved on.
  let fieldGroup: string | null = null
  // A group the picker moved to whose field has not landed yet. drawnGroup
  // keeps naming the field on screen until it does, so the legend and the
  // limits memory never describe one group's values under another's name.
  let pendingGroup: string | null = null

  // The points behind an interpolated cell, fetched on click and kept until
  // the drawn field changes.
  const contributorsMemo = new Map<number, Contributor[] | { failed: string }>()

  // Observation colouring (D-21 to D-26): one group's sites as dots, coloured from a frame.
  const obsSource = createObservationStatSource({ runId: opts.state.runId ?? null })
  const loadObsGroups = shareRead(() => fetchObsGroups())
  let obsControls: ObsColourControlsHandle | null = null
  let obsSlider: TimeSliderHandle | null = null
  // The slider may be stepped only once the group it shows has its times and dots.
  let obsTimeReady = false
  // The time index of the frame on screen; null while no frame is.
  let obsDrawnIndex: number | null = null
  let obsStepSerial = 0
  // Legend lines that hold at every time; the carry sentences are dropped on a slider step.
  let obsStaticNotes: string[] = []
  // True while the dots own the layer; a parameter field must not draw over them.
  let obsActive = false
  // The iteration has no statistics: the parameter colouring is back and a notice says why.
  let obsParked = false
  let obsSerial = 0
  let obsGroupInUse: string | null = null
  let obsData: ObsGroupData | null = null
  let obsDots: ObsDots | null = null
  let obsFrame: Float32Array | null = null
  let obsStat: ObsStat = 'resid_mean'
  let obsIteration = 0
  let obsTimePos: TimePosition | null = null
  let obsAllLayers = false
  let obsLayerMoved: number | null = null
  let obsDotsKey = ''
  let obsLookLayer: number | null = null
  let obsPick: ReadoutPick | null = null
  // Site rows (not dot positions) of the last click, so a time or layer change can redraw its readout.
  let obsPickedRows: number[] = []
  const obsSiteMemo = new Map<number, ObsSiteRead>()

  function interpolatedEntry(group: string | null): PpGroupInfo | null {
    return findInterpolatedEntry(ppIndex, group)
  }

  function drawsAsPoints(): boolean {
    return drawsAsPointsFor(fieldKind, drawnGroup, ppIndex, joined, pointXy)
  }

  // The store hears about every ring taken away, so no view keeps a cell or parameter the map no longer shows.
  function clearSelection(publish = true): void {
    selectedCellId = null
    selectedPointRow = null
    dropPendingLink()
    if (!publish) return
    store.set({ cells: new Set(), pars: new Set() }, 'map')
    refreshMarks()
  }

  function activeMaskFor(layerIndex: number): Uint8Array {
    return activeMask(idomain, cellArray, mesh?.nCells ?? 0, layerIndex, maskCache)
  }

  // A cell drawn with a value on this layer is never outlined, whatever the mask says.
  function drawnInactiveMask(): Uint8Array {
    const active = activeMaskFor(committed.layer)
    const mask = new Uint8Array(active.length)
    for (let c = 0; c < mask.length; c++) {
      const kind = currentClasses[c]?.kind
      const drawn = kind === 'valued' || kind === 'contested' || kind === 'interpolated' || kind === 'points'
      mask[c] = !active[c] && !drawn ? 1 : 0
    }
    return mask
  }

  function legendGroupLabel(): string {
    const group = drawnGroup ?? ''
    // D-17: the drawn realization is named base when it is the shown iteration's base.
    const drawnBase = committed.stat === 'value' && isBase(committed.iteration, committed.realization) ? ` · ${BASE_STYLE.label}` : ''
    if (interpolatedEntry(drawnGroup) === null) return `${group}${drawnBase}`
    const multiplier = allIdentities.some((i) => i.pargp === group && /_pstyle:m(_|$)/.test(i.parnme))
    return multiplier ? `${group} · interpolated multiplier field${drawnBase}` : `${group} · interpolated${drawnBase}`
  }
  // The drawn layer's own classification (D-06), recomputed by applyLayer
  // on every layer/group change and every landed fetch -- Task 2's click
  // readout reads this directly rather than reclassifying per click.
  let currentClasses: CellClass[] = []

  function isBase(iteration: number, realization: string | null): boolean {
    return realization !== null && baseNames.get(iteration) === realization
  }

  function selectionLabel(selection: FieldChoice): string {
    if (selection.stat !== 'value') return selection.stat
    const name = selection.realization
    if (name === null) return '—'
    return isBase(selection.iteration, name) && name !== BASE_STYLE.label ? `${name} · ${BASE_STYLE.label}` : name
  }

  // The legend last drawn for the parameter field, so a base name that lands later can relabel it.
  let shownLegend: LegendOptions | null = null

  function paintLegend(legend: LegendOptions | null): void {
    shownLegend = legend
    renderLegend(legendEl, legend)
  }

  // The base name landed for the shown iteration: every label that names the drawn realization follows.
  function followBaseName(): void {
    paintStatusBar()
    if (!obsActive && rawFullField !== null && shownLegend !== null) paintLegend({ ...shownLegend, group: legendGroupLabel() })
    updateReadout()
  }

  // A hand-built status-bar field rather than a renderStatusBar entry --
  // that helper has no notion of per-field ink, and this is the one field
  // that must turn warning-coloured on a failed fetch (D-14) without
  // touching chrome.ts, which this plan does not modify.
  function appendSelectionField(): void {
    const label =
      statusError ?? (loadingIteration !== null ? `loading iteration ${loadingIteration}` : selectionLabel(pending ?? committed))
    const field = document.createElement('span')
    const labelEl = document.createElement('span')
    labelEl.textContent = 'Selection'
    field.appendChild(labelEl)
    const valueEl = document.createElement('span')
    valueEl.classList.add('tabular-nums')
    valueEl.textContent = label
    if (statusError) {
      valueEl.style.color = 'var(--status-warning)'
    }
    field.appendChild(valueEl)
    statusBar.appendChild(field)
  }

  // A hand-built field, same reason as appendSelectionField: this is the
  // one field that turns warning-coloured while the context is restoring
  // (D-16), and only appears at all while contextLost holds.
  function appendCanvasField(): void {
    if (!contextLost) return
    const field = document.createElement('span')
    const labelEl = document.createElement('span')
    labelEl.textContent = 'Canvas'
    field.appendChild(labelEl)
    const valueEl = document.createElement('span')
    valueEl.classList.add('tabular-nums')
    valueEl.textContent = 'restoring'
    valueEl.style.color = 'var(--status-warning)'
    field.appendChild(valueEl)
    statusBar.appendChild(field)
  }

  function paintStatusBar(): void {
    renderStatusBar(statusBar, {
      'Ingest time': opts.state.ingestSeconds === null ? null : formatSeconds(opts.state.ingestSeconds),
      'Cache size': opts.state.cacheBytes === null ? null : formatBytes(opts.state.cacheBytes),
      'Mesh size': meshBytes === null ? null : formatBytes(meshBytes),
    })
    appendCanvasField()
    appendSelectionField()
  }

  function clearCanvas(): void {
    if (!ctx) return
    const [r, g, b] = readColorToken('--page-plane')
    ctx.gl.viewport(0, 0, canvas.width, canvas.height)
    ctx.gl.clearColor(r, g, b, 1)
    ctx.gl.clear(ctx.gl.COLOR_BUFFER_BIT)
  }

  // D-16: a lost context stops drawing entirely rather than calling into
  // GL objects the browser has already invalidated -- there is nothing to
  // clear or draw until webglcontextrestored fires.
  function redraw(): void {
    if (contextLost) return
    clearCanvas()
    layer?.draw()
    if (frameLogInstalled()) {
      // finish() makes the stamp wait for the GPU, so the delay covers the drawn frame.
      ctx?.gl.finish()
      markFrame({
        selection: selectionLabel(committed),
        layer: committed.layer,
        group: obsActive ? obsGroupInUse : drawnGroup,
        colormap: committed.colormap,
        reverse: committed.reverseColormap,
        scale: committed.scale,
        limits: committed.limitsMode,
        iteration: committed.iteration,
        ...(obsActive && obsDrawnIndex !== null ? { timeIdx: obsDrawnIndex } : {}),
      })
    }
  }

  // The stripe (--ink-primary over the neutral --gridline fill) and the
  // selection ring (--accent) resolve exactly like the hairline: read once
  // at mount, and again on every theme change, never cached across one.
  function applyThemeColors(): void {
    // --ink-primary, --gridline and --accent carry no alpha of their own
    // (WINDOWS.md #12 confirmed this by reading style.css) -- only their
    // RGB is needed here, so the resolved alpha is dropped explicitly by
    // destructuring, not silently by the reader.
    const [ir, ig, ib] = readColorToken('--ink-primary')
    const [gr, gg, gb] = readColorToken('--gridline')
    const [ar, ag, ab] = readColorToken('--accent')
    layer?.setContestedColors([ir, ig, ib], [gr, gg, gb])
    // --surface is lighter than --page-plane in the light theme, so it would not show as a shade there.
    layer?.setFootprintColor([gr, gg, gb])
    // The selection halo is whichever of page and ink is lighter, so it is near-white in both themes.
    const [pr, pg, pb] = readColorToken('--page-plane')
    const halo: [number, number, number] = pr + pg + pb > ir + ig + ib ? [pr, pg, pb] : [ir, ig, ib]
    layer?.setAccentColor([ar, ag, ab], halo)
    // The ring takes the colour the canvas is cleared to, so a dot reads on any fill.
    layer?.setPointRingColor([pr, pg, pb])
    layer?.setHatchColors([ir, ig, ib], [pr, pg, pb])
    try {
      layer?.setDimAlpha(readNumberToken('--dim-alpha'))
    } catch (error) {
      addNotice(mapNotice, {
        title: 'The dim strength could not be read from the theme',
        detail: `${describeError(error)} Unselected dots dim at the map's own default.`,
        tone: 'warning',
      })
    }
  }

  // Resolves synchronously from currentClasses/rawFullField -- the client
  // already holds the field and the D-05 join, so there is no fetch and no
  // loading state here (D-08).
  function updateReadout(): void {
    if (obsPick !== null) {
      renderReadout(readoutEl, { pick: obsPick, group: obsGroupInUse ?? '', joined, field: new Float32Array(0) })
      return
    }
    const group = drawnGroup ?? ''
    const field = rawFullField ?? new Float32Array(0)
    const classification = selectedCellId !== null ? currentClasses[selectedCellId] : undefined
    const pointRow = selectedPointRow
    const pick: ReadoutPick =
      pointRow !== null && pointXy !== null
        ? {
            kind: 'point',
            row: pointRow,
            layer: committed.layer,
            x: pointXy[2 * pointRow] + (mesh?.origin[0] ?? 0),
            y: pointXy[2 * pointRow + 1] + (mesh?.origin[1] ?? 0),
            selectionLabel: selectionLabel(committed),
          }
        : selectedCellId !== null && classification
        ? {
            kind: 'cell',
            cellId: selectedCellId,
            layer: committed.layer,
            selectionLabel: selectionLabel(committed),
            classification,
          }
        : { kind: 'none' }
    const entry = fieldKind === 'cell' ? interpolatedEntry(fieldGroup) : null
    const interpolated =
      selectedCellId !== null && classification?.kind === 'interpolated' && entry !== null
        ? {
            value: field[selectedCellId],
            nPoints: entry.n_pp,
            contributors: contributorsMemo.get(selectedCellId) ?? null,
          }
        : undefined
    renderReadout(readoutEl, { pick, group, joined, field, interpolated })
  }

  function fetchContributors(cellId: number): void {
    const group = fieldGroup
    if (group === null || contributorsMemo.has(cellId)) return
    const iteration = committed.iteration
    void fieldContributors(iteration, group, cellId)
      .then((list): Contributor[] | { failed: string } => list)
      .catch((error: unknown) => ({ failed: problemArtifactAndReason(error).reason }))
      .then((result) => {
        if (fieldGroup !== group || committed.iteration !== iteration) return
        contributorsMemo.set(cellId, result)
        if (selectedCellId === cellId) updateReadout()
      })
  }

  // camera.screenToWorld then pickAtWorld on a canvas click -- both are
  // null until loadAndDraw lands, so a click before then is a no-op.
  function handleCanvasClick(event: MouseEvent): void {
    // The click that ends a pan selects nothing.
    if (gestureWasDrag) {
      gestureWasDrag = false
      return
    }
    if (!camera || !meshGeom || loadingIteration !== null) return
    const rect = canvas.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height
    const [wx, wy] = camera.screenToWorld(x, y)
    // Dots are sized in device pixels, so the reach is 6 CSS pixels at the device's ratio.
    const reach = 6 * (window.devicePixelRatio || 1)
    const reachWorld = camera.screenToWorld(x + reach, y)[0] - wx
    const mode = modeOf(event)
    const obsHits =
      obsActive && obsDots !== null && obsData !== null
        ? pickPointsWithin({ rows: obsDots.rows, xy: obsDots.xy }, wx, wy, reachWorld)
        : []
    if (obsHits.length > 0) {
      pickObservationSites(obsHits, mode)
      return
    }
    // Parameter dots are not drawn while the map is coloured by observations, so none can be hit.
    const pointIndex = obsActive ? null : pickPoint(currentPoints, wx, wy, reachWorld)
    if (pointIndex !== null) {
      takeAwaySitePick()
      clearSelection(false)
      selectedPointRow = currentPoints.rows[pointIndex]
      updateReadout()
      const name = joined[selectedPointRow]?.parnme
      const current = store.get()
      const pars =
        name !== undefined ? selectPars(current, [name], mode).pars : mode === 'replace' ? new Set<string>() : current.pars
      // Sites stay; only a plain click clears the cells.
      store.set(mode === 'replace' ? { cells: new Set(), pars } : { pars }, 'map')
      refreshMarks()
      return
    }
    const cellId = pickAtWorld(meshGeom, wx, wy)
    if (cellId === null) {
      // D-01: a shift or alt click on empty space changes nothing.
      if (mode !== 'replace') return
      takeAwaySitePick()
      clearSelection(false)
      redraw()
      updateReadout()
      store.set({ cells: new Set(), sites: new Set(), pars: new Set() }, 'map')
      refreshMarks()
      return
    }
    takeAwaySitePick()
    selectedPointRow = null
    // The readout describes the cell just clicked; the rings follow the whole cell set.
    selectedCellId = mode === 'remove' ? null : cellId
    updateReadout()
    if (selectedCellId !== null && currentClasses[selectedCellId]?.kind === 'interpolated') {
      fetchContributors(selectedCellId)
    }
    const current = store.get()
    const base = pendingCells ?? current.cells
    const next = selectCells({ ...current, cells: new Set(base) }, [cellId], mode).cells
    if (sameSet(next, base)) return
    if (next.size === 0) {
      // Parameters and sites stay: a tab or lasso may have written them since.
      dropPendingLink()
      store.set({ cells: new Set() }, 'map')
    } else {
      askLinkCell(committed.layer, next)
    }
    refreshRings()
    redraw()
  }

  // A miss on the site dots takes their ring and readout away; the store hears with the cell write.
  function takeAwaySitePick(): void {
    obsPick = null
    obsPickedRows = []
  }

  // The ring is already drawn; the store hears of the cells with their parameters and sites
  // in one write, once the answer for this exact cell set lands.
  function askLinkCell(layerIndex: number, cells: ReadonlySet<number>): void {
    const sorted = [...cells].sort((a, b) => a - b)
    const storeCells = store.get().cells
    pendingCells = cells
    const settle = (write: () => void): void => {
      if (pendingCells === cells) pendingCells = null
      // Another view moved the cells while this was out, so this answer is no longer the selection's.
      if (sameSet(store.get().cells, storeCells)) write()
      refreshMarks()
    }
    const failed = (artifact: string, reason: string): void => {
      store.set({ cells: new Set(cells) }, 'map')
      addNotice(mapNotice, {
        title: 'What the clicked cells hold could not be read',
        detail: `${artifact}: ${reason}. The cells are selected; the parameters and sites were left as they were.`,
        tone: 'warning',
      })
    }
    void linkSlot.run(`${layerIndex}|${sorted.join(',')}`, (signal) => fetchLinkCell(layerIndex, sorted, { signal })).then(
      (result) => {
        if (result.stale) return
        const value = result.value
        settle(() => {
          if (!value.ok) {
            failed(value.artifact, value.reason)
            return
          }
          store.set(
            {
              cells: new Set(cells),
              pars: new Set(value.answer.pars.map((p) => p.parnme)),
              sites: new Set(value.answer.sites.map((s) => s.siteId)),
            },
            'map',
          )
        })
      },
      (error: unknown) => {
        settle(() => {
          const { artifact, reason } = problemArtifactAndReason(error)
          failed(artifact ?? 'link/cell', reason)
        })
      },
    )
  }
  canvas.addEventListener('click', handleCanvasClick)

  // Client CSS pixels -> the canvas's own pixel space (800x480, whatever
  // its displayed size), the same ratio handleCanvasClick already applies
  // so a drag and a click agree on where the pointer actually is.
  function canvasPoint(event: { clientX: number; clientY: number }): [number, number] {
    const rect = canvas.getBoundingClientRect()
    const width = rect.width || canvas.width
    const height = rect.height || canvas.height
    return [((event.clientX - rect.left) / width) * canvas.width, ((event.clientY - rect.top) / height) * canvas.height]
  }

  function redrawFromCamera(): void {
    if (!camera) return
    layer?.setMatrix(camera.matrix())
    redraw()
    renderWhere()
  }

  // The canvas's pixel size follows the box it sits in, at the device's
  // pixel ratio, so the map fills the frame rather than a fixed 800x480. A
  // box with no layout yet (jsdom, or a frame not yet attached) leaves the
  // size alone rather than collapsing the canvas to nothing.
  function fitCanvasToFrame(): void {
    const rect = mapCanvasArea.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const ratio = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(rect.width * ratio))
    const height = Math.max(1, Math.round(rect.height * ratio))
    if (width === canvas.width && height === canvas.height) return
    canvas.width = width
    canvas.height = height
    if (camera) {
      camera.resize(width, height)
      redrawFromCamera()
    }
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => fitCanvasToFrame()).observe(mapCanvasArea)
  }

  // MAP-11/D-15: the button and the Home key call exactly this, both
  // easing over ~200ms normally and jumping in one frame under
  // prefers-reduced-motion -- a direct mouse drag is user motion and never
  // goes through here (visual contract §11).
  function fitToExtent(): void {
    if (!camera || !mesh) return
    camera.fitAnimated(mesh.bounds, redrawFromCamera, { reduced: prefersReducedMotion() })
  }

  // Pointer drag-to-pan (D-15): the delta between two consecutive pointer
  // positions, in the canvas's own pixel space, fed straight to
  // camera.pan -- the same "grab and move" a drag on any map surface uses.
  let dragLast: [number, number] | null = null
  let dragPointerId: number | null = null
  let dragStart: [number, number] = [0, 0]
  // A press that moves further than this is a pan, not a click (CSS pixels).
  const DRAG_CLICK_SLOP = 4
  let gestureWasDrag = false

  canvas.addEventListener('pointerdown', (event) => {
    if (!camera || event.button !== 0) return
    // Ignore a second finger, but not a press that follows a lost release: the
    // same pointer again, or another one after the first lost capture.
    if (
      dragPointerId !== null &&
      event.pointerId !== dragPointerId &&
      canvas.hasPointerCapture?.(dragPointerId) !== false
    ) {
      return
    }
    // A drag released off the canvas may fire no click, so the mark must not outlive the press.
    gestureWasDrag = false
    dragLast = canvasPoint(event)
    dragPointerId = event.pointerId
    dragStart = [event.clientX, event.clientY]
    try {
      canvas.setPointerCapture?.(event.pointerId)
    } catch {
      // The drag still works on canvas events; capture only helps when the pointer leaves it.
    }
  })

  canvas.addEventListener('pointermove', (event) => {
    if (!camera || !dragLast || event.pointerId !== dragPointerId) return
    if (Math.hypot(event.clientX - dragStart[0], event.clientY - dragStart[1]) > DRAG_CLICK_SLOP) {
      gestureWasDrag = true
    }
    const point = canvasPoint(event)
    camera.pan(point[0] - dragLast[0], point[1] - dragLast[1])
    dragLast = point
    redrawFromCamera()
  })

  function endDrag(event: PointerEvent): void {
    if (!dragLast || event.pointerId !== dragPointerId) return
    dragLast = null
    dragPointerId = null
    if (typeof canvas.releasePointerCapture === 'function') {
      canvas.releasePointerCapture(event.pointerId)
    }
  }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)
  canvas.addEventListener('lostpointercapture', (event) => {
    if (event.pointerId !== dragPointerId) return
    dragLast = null
    dragPointerId = null
  })

  // Wheel-to-zoom (D-15): the zoom follows the distance scrolled and zoomAt
  // holds the world point under the cursor fixed, so the grid stays under the pointer.
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!camera) return
      // Always prevented: a sideways swipe must not scroll the page or swipe back.
      event.preventDefault()
      const pageHeight = canvas.getBoundingClientRect().height || canvas.height
      const factor = wheelZoomFactor(event, pageHeight)
      if (factor === null) return
      const [x, y] = canvasPoint(event)
      camera.zoomAt(x, y, factor)
      redrawFromCamera()
    },
    { passive: false },
  )

  const PAN_STEP = 40
  const ZOOM_FACTOR = 1.1

  // MAP-11's three canvas bindings, active only while the canvas itself
  // holds focus -- guarded explicitly on document.activeElement so a
  // slider's own arrow-key handling is never also read as a pan. Bound to
  // the canvas element, which only ever receives a keydown when it is the
  // focused element, but the explicit check is kept as the one place this
  // invariant is stated and testable, not merely relied on by construction.
  canvas.addEventListener('keydown', (event) => {
    if (!camera || document.activeElement !== canvas) return
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault()
        camera.pan(PAN_STEP, 0)
        redrawFromCamera()
        break
      case 'ArrowRight':
        event.preventDefault()
        camera.pan(-PAN_STEP, 0)
        redrawFromCamera()
        break
      case 'ArrowUp':
        event.preventDefault()
        camera.pan(0, PAN_STEP)
        redrawFromCamera()
        break
      case 'ArrowDown':
        event.preventDefault()
        camera.pan(0, -PAN_STEP)
        redrawFromCamera()
        break
      case '+':
      case '=':
        event.preventDefault()
        camera.zoomAt(canvas.width / 2, canvas.height / 2, ZOOM_FACTOR)
        redrawFromCamera()
        break
      case '-':
      case '_':
        event.preventDefault()
        camera.zoomAt(canvas.width / 2, canvas.height / 2, 1 / ZOOM_FACTOR)
        redrawFromCamera()
        break
      case 'Home':
        event.preventDefault()
        fitToExtent()
        break
      default:
        break
    }
  })

  // The last picker state painted, so a group chosen elsewhere can move the picker's selection.
  let paintedPicker: GroupPickerState = { kind: 'loading' }

  function paintPicker(state: GroupPickerState): void {
    paintedPicker = state
    renderGroupPicker(pickerEl, { state, onGroupChange: handleGroupChange })
  }

  // A group change re-runs classifyCells (via applyLayer, which reads
  // drawnGroup), re-derives the scale default from the new group's
  // partrans, and redraws -- no fetch, since the client already holds the
  // whole field. The limits memory is not cleared: the drawn group is part
  // of its cache key (deriveAndDraw), so a group switched back to replays
  // its own previously computed pair, exactly like a statistic does. The
  // selection is cleared: the previous readout described a cell in the old
  // group.
  function handleGroupChange(group: string): void {
    const latest = pending ?? committed
    if (realizationMissing && latest.stat === 'value') {
      // No realization of this iteration is picked, so there is still no field to draw for any group.
      dropPendingFetch()
      pendingGroup = null
      groupGone = null
      drawnGroup = group
      drawNothing()
      renderDrawnNotice()
      paintStatusBar()
      scheduleViewWrite()
      return
    }
    // The raw field itself changes when either side of the switch is an
    // interpolated group, or when no field is held (the last iteration had
    // nothing for the old group), so that switch fetches; block to block stays local.
    const entry = interpolatedEntry(group)
    const fieldFollowsGroup = rawFullField === null || fieldKind === 'cell' || entry !== null
    const drawnPartrans = partransForGroup(joined, group, allIdentities)
    const newScale: ValueScale = drawnPartrans?.trim().toLowerCase() === 'log' ? 'log10' : 'linear'
    // An interpolated group has values on one layer only, so it opens there.
    const nextLayer = entry?.layer ?? dotLayerFor(group) ?? committed.layer
    // Built from the newest choice, so a realization still loading is the one asked for.
    const next: FieldChoice = { ...latest, layer: nextLayer, scale: newScale, scaleInferred: true }
    if (fieldFollowsGroup) {
      pendingGroup = group
    } else {
      pendingGroup = null
      drawnGroup = group
    }
    controlsHandle?.setLayer(nextLayer)
    // WINDOWS.md #5: the scale control must show what was just inferred,
    // not whatever it happened to display for the previous group --
    // deriveAndDraw's own setLogUsability call can still override this to
    // linear, for a genuinely different reason (the new field has
    // non-positive values), so this runs first.
    controlsHandle?.sync(next)
    clearSelection()
    applyChoice(next, !fieldFollowsGroup)
    updateReadout()
    publishChoice({ ...reported, layer: nextLayer })
  }

  function dotLayerFor(group: string): number | null {
    return dotLayerForGroup(group, { ppIndex, joined, pointXy, layerArray, currentLayer: committed.layer })
  }

  // D-12/MAP-10: the chips capability, not the config object, decides
  // whether the failure chip replaces the row -- the config artifact can
  // fail even when `opts.config` itself came back non-null from an earlier
  // read, and `opts.config` can be null for reasons that are not a chip
  // failure at all (no run open yet). No chip row at all until one of the
  // two is actually known.
  function chipsInput(): ChipsInput | null {
    const chipsCap = opts.state.capabilities.chips
    if (!chipsCap.available) {
      const blocked = chipsCap.blockedBy[0]
      return blocked ? { config: null, failure: { artifact: blocked.artifact, reason: blocked.reason } } : null
    }
    if (!opts.config) return null
    const { disagree, base } = chipFactsFrom(opts.config.facts)
    return {
      failure: null,
      config: {
        n_par: opts.config.n_par,
        n_real: opts.config.n_real,
        base_realization: opts.config.base_realization,
        n_iterations: opts.config.n_iterations,
        noptmax: opts.config.noptmax,
        projection: opts.config.projection,
        has_noise: opts.config.noise.has_noise,
        disagree,
        base,
      },
    }
  }

  // The base realization's name per iteration, as the header chip read it, so the map can name it.
  const baseNames = new Map<number, string | null>()

  function loadBase(k: number): Promise<BaseResult> {
    return fetchBase(k).then((result) => {
      baseNames.set(k, result.ok ? result.answer.name : null)
      if (k === committed.iteration) followBaseName()
      return result
    })
  }

  // Built once, so a header repaint keeps the same chip and its state.
  const baseChip = renderBaseChip(document.createElement('div'), {
    store,
    loadBase,
    iteration: openingIteration(opts.config, opts.state).iteration,
  })

  function paintHeader(): void {
    renderHeader(header, {
      title: opts.config?.case ?? 'This run',
      themeChoice: currentTheme(),
      chips: chipsInput(),
      extras: [baseChip.el],
      onThemeChange: (choice: ThemeChoice) => {
        setTheme(choice)
        paintHeader()
        // --model-edge resolves differently under each data-theme value, so
        // it is re-read here exactly like --page-plane is, never cached.
        layer?.setHairlineColor(readColorToken('--model-edge'))
        applyThemeColors()
        redraw()
      },
    })
  }
  paintHeader()

  renderBlockedCapabilities(noticeArea, opts.state)
  paintStatusBar()
  paintPicker({ kind: 'loading' })
  updateReadout()

  try {
    ctx = createContext(canvas)
  } catch {
    addNotice(mapNotice, {
      title: "This browser can't draw the map",
      detail: "pesto needs WebGL2, which this browser doesn't provide. Try a recent version of Chrome, Firefox or Edge.",
      tone: 'critical',
    })
    canvas.remove()
    return { viewFields }
  }

  // MAP-08/D-16: on loss, stop drawing and say so; on restore, rebuild
  // every GL object and re-upload the mesh, cell/layer arrays and the
  // current field from the copies this module already holds -- zero
  // network requests, and the camera, selection, drawn group and
  // statistic are untouched, since none of them ever lived in the GL
  // context to begin with. A loss that never restores within the recovery
  // window falls to the critical designed state instead of a blank canvas.
  ctx.onLost(() => {
    contextLost = true
    paintStatusBar()
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null
      if (!contextLost) return
      addNotice(mapNotice, {
        title: "This browser can't draw the map",
        detail: "The graphics context was lost and couldn't be restored. Reloading the page may fix this.",
        tone: 'critical',
      })
    }, CONTEXT_RECOVERY_WINDOW_MS)
  })
  ctx.onRestored(() => {
    if (recoveryTimer !== null) {
      clearTimeout(recoveryTimer)
      recoveryTimer = null
    }
    contextLost = false
    layer?.reupload()
    layer?.setHairlineColor(readColorToken('--model-edge'))
    applyThemeColors()
    if (camera) layer?.setMatrix(camera.matrix())
    redraw()
    paintStatusBar()
  })

  function computePerCell(field: Float32Array, layerIndex: number) {
    return computePerCellFor({
      field,
      layerIndex,
      nCells: mesh?.nCells ?? 0,
      fieldKind,
      fieldGroup,
      drawnGroup,
      ppIndex,
      joined,
      cellArray,
      layerArray,
      pointXy,
      idomain,
      maskCache,
    })
  }

  // A layer change never fetches -- the client already holds the whole
  // field, so this re-filters it locally against the layer companion array
  // and draws. Never touches the legend's limits: the one-scale-per-run
  // rule (D-01) means only a landed fetch may change them.
  function applyLayer(): { contested: number; noValue: number } {
    if (!fullField || !layer) return { contested: 0, noValue: 0 }
    const { perCell, contested, noValue, classes } = computePerCell(fullField, committed.layer)
    currentClasses = classes
    layer.setInactive(drawnInactiveMask())
    const contestedMask = new Uint8Array(classes.length)
    for (let c = 0; c < classes.length; c++) {
      contestedMask[c] = classes[c].kind === 'contested' ? 1 : 0
    }
    layer.setContested(contestedMask)
    layer.setFootprint(drawsAsPoints() ? footprintMask(classes) : null)
    layer.setValues(perCell)
    applyPoints(fullField)
    redraw()
    canvas.setAttribute('data-drawn', 'true')
    // A layer/group change can move the selected cell into a different
    // class (valued -> contested, say) -- the readout re-derives from
    // whatever currentClasses now says, never a stale copy.
    updateReadout()
    return { contested, noValue }
  }

  // Each dot reads the same scaled field the fill does, so log scale and its refusal apply alike.
  function applyPoints(field: Float32Array): void {
    if (!layer) return
    if (pointXy === null || !drawsAsPoints()) {
      currentPoints = { rows: new Int32Array(0), xy: new Float32Array(0) }
      selectedPointRow = null
      putPoints(new Float32Array(0), new Float32Array(0))
      refreshMarks(false)
      return
    }
    const onLayer = pointsOnLayer(joined, layerArray, pointXy, drawnGroup ?? '', committed.layer)
    // The shader drops a non-finite value, so such a dot is left out here too and cannot be picked.
    const kept: number[] = []
    onLayer.rows.forEach((row, i) => {
      if (Number.isFinite(field[row])) kept.push(i)
    })
    const xy = new Float32Array(2 * kept.length)
    const values = new Float32Array(kept.length)
    kept.forEach((i, k) => {
      xy[2 * k] = onLayer.xy[2 * i]
      xy[2 * k + 1] = onLayer.xy[2 * i + 1]
      values[k] = field[onLayer.rows[i]]
    })
    currentPoints = { rows: Int32Array.from(kept, (i) => onLayer.rows[i]), xy }
    putPoints(xy, values, 'par')
    if (selectedPointRow !== null && currentPoints.rows.indexOf(selectedPointRow) < 0) selectedPointRow = null
    refreshMarks(false)
  }

  // Recomputes the drawn scale, limits and colormap from the raw held
  // field and redraws -- never a fetch. Runs after every selection change
  // that isn't a stat/realization/iteration change, and once when a fetch
  // lands. D-02: robust/minmax limits are remembered per statistic, scale,
  // limits mode and drawn group (so switching any of the four never reuses
  // a pair computed for a different one); manual limits are the caller's
  // own pair and are never cached.
  //
  // The pair itself is computed from only the drawn group's own block
  // rows, across every layer of that group -- never the whole map block.
  // Different parameter groups are different physical quantities (a
  // conductance and a concentration, say), and a scale spanning both
  // treats the smaller one as noise near zero. Computing over every layer
  // of the group, rather than just the current one, is what keeps the
  // layer slider from moving the legend's own end values (D-01).
  function deriveAndDraw(): void {
    if (obsActive) {
      void drawObservations()
      return
    }
    if (!rawFullField || !layer) {
      paintLegend(null)
      return
    }

    controlsHandle?.setLogUsability(rawFieldNonPositiveCount)

    // D-03: log10 is refused, with the count named, when the field holds
    // non-positive values -- the hairline stays the only mark meaning
    // "outside the model."
    const effectiveScale: ValueScale =
      committed.scale === 'log10' && rawFieldNonPositiveCount > 0 ? 'linear' : committed.scale
    if (effectiveScale !== committed.scale) {
      committed = { ...committed, scale: effectiveScale }
    }

    if (scaledFieldScale !== effectiveScale) {
      scaledField = applyScale(rawFullField, effectiveScale)
      scaledFieldScale = effectiveScale
    }
    const scaled = scaledField!

    let limits: [number, number]
    if (committed.limitsMode === 'manual') {
      limits = committed.manualLimits ?? [0, 1]
    } else {
      const key = `${committed.iteration}:${effectiveScale}:${committed.limitsMode}:${committed.stat}:${drawnGroup ?? ''}`
      const cached = limitsMemory.get(key)
      if (cached) {
        limits = cached
      } else {
        const groupRows: number[] = []
        if (fieldKind === 'cell') {
          // The per-cell field is the group's own; scaleLimits skips its NaNs.
          for (let c = 0; c < scaled.length; c++) groupRows.push(c)
        } else {
          for (let i = 0; i < joined.length; i++) {
            if (joined[i]?.pargp === drawnGroup) groupRows.push(i)
          }
        }
        // A group with no finite rows at all (every row non-finite after
        // the scale, or the group has no rows for some other reason)
        // falls back to scaleLimits's own empty-set [0, 1] -- the same
        // honest "nothing to show a range of" already used everywhere
        // else, not a new sentinel invented here. A group with exactly one
        // distinct value gets lo === hi, which normalize already renders
        // as a single flat colour without producing NaN -- a true fact
        // about the data, not a scaling bug.
        limits = scaleLimits(subsetValues(scaled, groupRows), committed.limitsMode)
        limitsMemory.set(key, limits)
      }
    }

    fullField = scaled
    layer.setColormap(committed.colormap, committed.reverseColormap)
    layer.setLimits(limits)
    const { contested, noValue } = applyLayer()

    paintLegend({
      colormap: committed.colormap,
      reverse: committed.reverseColormap,
      limits,
      scale: effectiveScale,
      scaleInferred: committed.scaleInferred,
      limitsMode: committed.limitsMode,
      group: legendGroupLabel(),
      contested,
      noValue,
      points: drawsAsPoints() ? currentPoints.rows.length : undefined,
      inactiveDrawn: inactiveDrawnCount(),
    })
  }

  // A pilot-point field paints its value on an idomain-inactive cell too; this says how many.
  function inactiveDrawnCount(): number | undefined {
    if (idomain === null || fieldKind !== 'cell') return undefined
    const active = layerActiveMask(idomain, mesh?.nCells ?? 0, committed.layer)
    let count = 0
    for (let c = 0; c < active.length; c++) {
      if (!active[c] && currentClasses[c]?.kind === 'interpolated') count += 1
    }
    return count
  }

  // D-13: a realization, statistic or iteration change is coalesced to the
  // next animation frame, so a drag through several positions issues one
  // fetch, for the last selection, rather than one per step.
  function scheduleFetch(next: FieldChoice): void {
    pending = next
    statusError = null
    paintStatusBar()
    if (rafScheduled) return
    rafScheduled = true
    requestAnimationFrame(() => {
      rafScheduled = false
      const toFetch = pending
      if (toFetch) void performFetch(toFetch)
    })
  }

  async function performFetch(selection: FieldChoice): Promise<void> {
    const group = pendingGroup ?? drawnGroup
    const kind: 'block' | 'cell' = interpolatedEntry(group) !== null ? 'cell' : 'block'
    const key = fieldKey(selection, group)
    inFlightKey = key
    const startedIn = generation
    let field: Float32Array
    try {
      // A newer request aborts this one; its answer comes back stale and is dropped silently, never drawn.
      const answer = await source.fetchField({
        iteration: selection.iteration,
        group: group!,
        kind,
        stat: selection.stat,
        realization: selection.realization,
      })
      if (answer.stale || startedIn !== generation) return
      field = answer.field
    } catch (error) {
      if (startedIn !== generation) return
      const status = error instanceof ApiError ? error.problem.status : 'unknown'
      statusError = `${selectionLabel(selection)} — couldn't load (${status})`
      pending = null
      inFlightKey = null
      if (pendingGroup !== null) {
        // The switch failed: the picker and controls go back to what is drawn.
        pendingGroup = null
        const select = pickerEl.querySelector('select')
        if (select && drawnGroup !== null) select.value = drawnGroup
        controlsHandle?.sync(committed)
        controlsHandle?.setLayer(committed.layer)
      }
      paintStatusBar()
      // An iteration switch whose field failed still shows that iteration's overlays.
      redrawOverlays()
      return
    }
    // Only the choice still wanted may draw. A block field holds every
    // group, so the group drawn is the one picked now, not the one this
    // fetch started under.
    const want = pending
    const landedGroup = pendingGroup ?? drawnGroup
    if (want === null || fieldKey(want, landedGroup) !== key) return
    drawnGroup = landedGroup
    pendingGroup = null

    // D-01: the raw field lands here, before any scale, layer or group
    // filter, untouched -- so every later transform can recompute from
    // this same array without a fetch. The scale (log10 vs linear) is one
    // choice for the whole run; the LIMITS derived from it are scoped to
    // the drawn group's own rows (deriveAndDraw), because different groups
    // are different physical quantities and a range spanning all of them
    // buries the smaller ones near zero.
    //
    // rawFieldNonPositiveCount (D-03) stays whole-field on purpose: it
    // decides whether log10 is offered at all, and that decision is
    // deliberately left unscoped here, as a separate, narrower defect from
    // the one this fix addresses -- a group with no non-positive values of
    // its own can still have log10 disabled by another group's zero or
    // negative row. Scoping it to the drawn group would need recomputing
    // and re-showing the count on every group switch, not just every
    // fetch, which is a real change but not one this fix's verification
    // covers; left as a follow-up rather than folded in silently.
    rawFullField = field
    heldKey = key
    fieldKind = kind
    if (fieldGroup !== landedGroup || kind === 'block') contributorsMemo.clear()
    fieldGroup = landedGroup
    rawFieldNonPositiveCount = logIsUsable(field)
    scaledField = null
    scaledFieldScale = null
    // The colour, scale and limits are the newest the controls hold, and the
    // layer is whatever the store last heard: either may have moved while this fetch was out.
    committed = { ...want, layer: reported.layer }
    pending = null
    inFlightKey = null
    statusError = null
    groupGone = null
    deriveAndDraw()
    renderDrawnNotice()
    paintStatusBar()
    scheduleViewWrite()
  }

  // The part of a choice other views care about, in the store's own terms.
  // The realization is named only while a single realization is drawn.
  function storePatch(choice: FieldChoice, before: FieldChoice | null): Partial<SharedSelection> {
    const patch: Partial<SharedSelection> = {}
    if (before === null || choice.layer !== before.layer) patch.layer = choice.layer
    if (before === null || choice.iteration !== before.iteration) patch.iteration = choice.iteration
    // While the map is coloured by observations the colour belongs to them, not to this statistic.
    if ((before === null || choice.stat !== before.stat) && store.get().colour.source === 'par') {
      patch.colour = { source: 'par', stat: choice.stat }
    }
    const named = choice.stat === 'value' ? choice.realization : null
    if (named !== null && (before === null || before.stat !== 'value' || named !== before.realization)) {
      patch.reals = new Set([named])
    }
    return patch
  }

  // Local effects come first, so the map never waits a frame for its own change.
  function publishChoice(choice: FieldChoice): void {
    store.set(storePatch(choice, reported), 'map')
    reported = choice
  }

  // What picks a field's values. A block field holds every group, so the
  // group counts only for an interpolated one; the realization counts only for 'value'.
  function fieldKey(choice: FieldChoice, group: string | null): string {
    const cell = interpolatedEntry(group) !== null
    return JSON.stringify([
      cell ? 'cell' : 'block',
      cell ? group : null,
      choice.iteration,
      choice.stat,
      choice.stat === 'value' ? choice.realization : null,
    ])
  }

  function looksDifferent(a: FieldChoice, b: FieldChoice): boolean {
    return (
      a.layer !== b.layer ||
      a.colormap !== b.colormap ||
      a.reverseColormap !== b.reverseColormap ||
      a.scale !== b.scale ||
      a.scaleInferred !== b.scaleInferred ||
      a.limitsMode !== b.limitsMode ||
      a.manualLimits?.[0] !== b.manualLimits?.[0] ||
      a.manualLimits?.[1] !== b.manualLimits?.[1]
    )
  }

  // The fetch out, or about to go out, is for a choice the user has left: it never lands.
  function dropPendingFetch(): void {
    if (pending !== null || inFlightKey !== null) {
      source.cancelField()
      generation += 1
      statusError = null
    }
    pending = null
    inFlightKey = null
  }

  // Draws a new choice from the held field when that field already answers
  // it, and drops any fetch still out. Otherwise the fetch already out is
  // kept when it is for the same field, or a new one is made.
  function applyChoice(next: FieldChoice, groupMoved = false): void {
    const key = fieldKey(next, pendingGroup ?? drawnGroup)
    if (rawFullField !== null && key === heldKey) {
      dropPendingFetch()
      if (pendingGroup !== null) {
        drawnGroup = pendingGroup
        pendingGroup = null
      }
      committed = next
      deriveAndDraw()
      paintStatusBar()
      scheduleViewWrite()
      return
    }
    const shown: FieldChoice = { ...next, iteration: committed.iteration, stat: committed.stat, realization: committed.realization }
    if (rawFullField !== null && pendingGroup === null && (groupMoved || looksDifferent(shown, committed))) {
      // The held field keeps drawing until the new one lands, in the new colour, scale, limits and layer.
      committed = shown
      deriveAndDraw()
      scheduleViewWrite()
    }
    if (pending !== null && inFlightKey === key && !rafScheduled) {
      pending = next
      paintStatusBar()
      return
    }
    scheduleFetch(next)
  }

  function handleSelectionChange(next: FieldChoice): void {
    if (obsActive) {
      // Only the layer slider is visible in observation mode; the parameter choices stay as they were.
      committed = { ...committed, layer: next.layer }
      publishChoice({ ...reported, layer: next.layer })
      void drawObservations()
      scheduleViewWrite()
      return
    }
    if (next.realization !== null) {
      wantedRealization = next.realization
      realizationMissing = false
    }
    if (realizationMissing && next.stat === 'value' && next.realization === null) {
      // Still no realization of this iteration is picked: nothing to fetch, nothing to draw.
      dropPendingFetch()
      if (pendingGroup !== null) {
        drawnGroup = pendingGroup
        pendingGroup = null
      }
      committed = { ...next, realization: wantedRealization }
      drawNothing()
      renderDrawnNotice()
      paintStatusBar()
      scheduleViewWrite()
      publishChoice(next)
      return
    }
    if (groupGone !== null && pendingGroup === null) {
      // The drawn group has nothing in this iteration, whatever the statistic or realization.
      dropPendingFetch()
      committed = next
      drawNothing()
      renderDrawnNotice()
      paintStatusBar()
      scheduleViewWrite()
      publishChoice(next)
      return
    }
    applyChoice(next)
    publishChoice(next)
  }

  // Another view moved the layer: follow it with no fetch, the way a layer
  // slider move does. A change written only by this view is already applied.
  function followForeignLayer(layerIndex: number, origins: ReadonlySet<string>): void {
    if (origins.size === 1 && origins.has('map')) return
    if (!Number.isInteger(layerIndex) || layerIndex < 0 || layerIndex >= (mesh?.nlay ?? 0)) {
      addNotice(mapNotice, {
        title: 'A layer was asked for that this grid does not have',
        detail: `Another view asked for layer ${layerIndex}; the grid has ${mesh?.nlay ?? 0}. The map keeps drawing layer ${committed.layer}.`,
        tone: 'serious',
      })
      return
    }
    committed = { ...committed, layer: layerIndex }
    reported = { ...reported, layer: layerIndex }
    controlsHandle?.setLayer(layerIndex)
    deriveAndDraw()
    scheduleViewWrite()
  }

  // Draws no field at all: every cell empty, no dots, no legend, no readout. Used when the
  // shown iteration has nothing for the drawn realization or group, so that no other
  // realization, group or the mean is ever drawn in its place.
  function drawNothing(): void {
    rawFullField = null
    heldKey = null
    fullField = null
    scaledField = null
    scaledFieldScale = null
    currentClasses = []
    currentPoints = { rows: new Int32Array(0), xy: new Float32Array(0) }
    if (obsActive) {
      // The dots are not parameter fields; they keep drawing.
      void drawObservations()
      return
    }
    clearSelection()
    paintLegend(null)
    if (layer) {
      const nCells = mesh?.nCells ?? 0
      layer.setValues(new Float32Array(nCells).fill(Number.NaN))
      putPoints(new Float32Array(0), new Float32Array(0))
      layer.setContested(new Uint8Array(nCells))
      layer.setFootprint(null)
      layer.setInactive(drawnInactiveMask())
      refreshMarks(false)
      redraw()
    }
    updateReadout()
  }

  // The iteration the shown one replaced, named in the "switch back" advice.
  let loadedFrom = 0

  // D-04: says why nothing is drawn. Replaced whole, so it never stacks.
  function renderDrawnNotice(): void {
    drawnNoticeEl.textContent = ''
    const shown = committed.iteration
    const back = `or switch back to iteration ${loadedFrom}.`
    if (groupGone !== null) {
      addNotice(drawnNoticeEl, {
        title: `group ${groupGone} has nothing to draw in iteration ${shown}`,
        detail: `No field is drawn. Pick another group, ${back}`,
        tone: 'warning',
      })
    }
    if (realizationMissing && committed.stat === 'value') {
      if (!realNames.ok) {
        addNotice(drawnNoticeEl, {
          title: `realization names were not recorded for iteration ${shown}`,
          detail: `No field is drawn for a single realization. Pick a statistic, ${back}`,
          tone: 'warning',
        })
      } else if (wantedRealization === null) {
        addNotice(drawnNoticeEl, {
          title: `no realization is picked in iteration ${shown}`,
          detail: 'No field is drawn. Pick a realization from this iteration.',
          tone: 'warning',
        })
      } else {
        addNotice(drawnNoticeEl, {
          title: `realization ${wantedRealization} is not in iteration ${shown}`,
          detail: `No field is drawn. Pick a realization from this iteration, ${back}`,
          tone: 'warning',
        })
      }
    }
  }

  // D-03, D-20: selected realizations and sites the shown iteration lacks stay in the store; this only counts them.
  function renderSelectedNotice(): void {
    selectedNoticeEl.textContent = ''
    renderMissingRealizations()
    renderMissingSites()
  }

  function renderMissingSites(): void {
    const answer = sitesAnswer
    const total = store.get().sites.size
    if (answer === null || !answer.ok || total === 0 || answer.iteration !== committed.iteration) return
    const line = missingValueLine(answer, total)
    if (line !== null) addNotice(selectedNoticeEl, { ...line, tone: 'info' })
  }

  function renderMissingRealizations(): void {
    const reals = store.get().reals
    if (reals === 'all' || reals.size === 0) return
    const shown = committed.iteration
    const known = realNames.ok ? new Set(realNames.names) : new Set<string>()
    const missing = [...reals].filter((name) => !known.has(name))
    if (missing.length === 0) return
    // The drawn realization's own line already says it is missing.
    const drawnLineShown = realizationMissing && committed.stat === 'value'
    if (drawnLineShown && missing.length === 1 && missing[0] === wantedRealization) return
    const count = missing.length
    if (!realNames.ok) {
      addNotice(selectedNoticeEl, {
        title: `${count} selected ${count === 1 ? 'realization' : 'realizations'} cannot be matched in iteration ${shown}`,
        detail: 'Its realization names were not recorded. The selection is kept.',
        tone: 'info',
      })
      return
    }
    addNotice(selectedNoticeEl, {
      title: `${count} selected ${count === 1 ? 'realization is' : 'realizations are'} not in iteration ${shown}`,
      detail: 'The selection is kept; switching back shows them again.',
      tone: 'info',
    })
  }

  // The Params panel's notes that depend on the shown iteration's own join and cells.
  function buildArtifactNotes(identities: ParIdentity[]): PanelFacts['artifactNotes'] {
    // Every artifact the ingest recorded a reason for, named and shown verbatim (CLAUDE.md's
    // fourth hard rule -- nothing dropped without a trace).
    const artifactNotes = opts.state.artifacts
      .filter((artifact): artifact is typeof artifact & { reason: string } => artifact.reason !== null)
      .map((artifact) => ({ artifact: artifact.name, reason: artifact.reason }))
    for (const note of mesh?.notes ?? []) artifactNotes.push({ artifact: 'mesh', reason: note })
    for (const note of placementNotes) artifactNotes.push({ artifact: 'par_cell', reason: note })
    if (idomain !== null && mesh !== null) {
      for (const note of inactiveLandingNotes(joined, cellArray, layerArray, idomain, mesh.nCells)) {
        artifactNotes.push({ artifact: 'idomain', reason: note })
      }
    }
    // A pp_factors refusal found before the template named a group is keyed
    // by its file; it has no group row to sit beside, so it is listed here.
    const knownGroups = new Set(identities.map((i) => i.pargp))
    for (const refusal of ppIndex.not_interpolable) {
      if (!knownGroups.has(refusal.group)) {
        artifactNotes.push({ artifact: 'pp_factors', reason: `${refusal.group}: ${refusal.reason}` })
      }
    }
    return artifactNotes
  }

  // D-01 to D-04. The toggle or another view moved the iteration: reload what depends on it,
  // look the wanted realization up by name in the new list, and either fetch its field or
  // say why no field is drawn.
  async function switchIteration(k: number): Promise<void> {
    const token = ++switchSerial
    const from = loadedIteration
    loadingIteration = k
    paintStatusBar()
    // The old iteration's hatch is taken away at once, and the new one's answers are asked for.
    redrawOverlays()
    let answer
    try {
      answer = await source.loadIteration(k)
    } catch (error) {
      if (token !== switchSerial) return
      loadingIteration = null
      paintStatusBar()
      redrawOverlays()
      addNotice(mapNotice, {
        title: `Iteration ${k} could not be read`,
        detail: `${describeError(error)} The map keeps drawing iteration ${from}.`,
        tone: 'serious',
      })
      toggleHandle?.setCurrent(from)
      store.set({ iteration: from }, 'map')
      return
    }
    if (answer.stale || token !== switchSerial) return
    loadingIteration = null
    const data = answer.data

    // Fetches already out were made for the old iteration's rows; they drop their answers.
    const base: FieldChoice = { ...(pending ?? committed), layer: reported.layer }
    dropPendingFetch()
    generation += 1
    statusError = null

    loadedFrom = from
    loadedIteration = k
    joined = data.tables.joined
    allIdentities = data.tables.identities
    cellArray = data.cells.cell
    layerArray = data.cells.layer
    pointXy = data.pointXy.xy
    if (data.pointXy.problem !== null) {
      addNotice(mapNotice, {
        title: 'Point positions could not be read',
        detail: `${data.pointXy.problem} Groups placed by x/y draw as the cells their points sit in.`,
        tone: 'serious',
      })
    }
    maskCache.referenced = null
    realNames = data.realNames
    // The held field and classes describe the old iteration's rows; none of it may be read now.
    rawFullField = null
    heldKey = null
    fullField = null
    scaledField = null
    scaledFieldScale = null
    currentClasses = []
    currentPoints = { rows: new Int32Array(0), xy: new Float32Array(0) }
    selectedPointRow = null
    contributorsMemo.clear()

    const placement = computeGroupPlacement(data.tables.identities, joined, cellArray, ppIndex, recordedPlacement)
    if (pendingGroup !== null && !placement.drawable.includes(pendingGroup)) pendingGroup = null
    const target = pendingGroup ?? drawnGroup
    const groupMissing = target === null || !placement.drawable.includes(target)
    if (placement.drawable.length === 0) {
      paintPicker({ kind: 'none-drawable', unmapped: placement.unmapped })
    } else {
      paintPicker({
        kind: 'ready',
        drawable: placement.drawable,
        interpolated: placement.interpolated,
        unmapped: placement.unmapped,
        selected: groupMissing ? '' : target,
      })
    }
    opts.onPanelFacts({
      unmapped: placement.unmapped,
      artifactNotes: buildArtifactNotes(data.tables.identities),
      parTable: data.tables.parTable,
    })

    controlsHandle?.setIteration(k)
    const index = controlsHandle?.setRealizations(data.realNames, wantedRealization) ?? null
    const statIsValue = base.stat === 'value'
    realizationMissing = index === null
    groupGone = groupMissing ? target : null
    committed = { ...base, iteration: k, realization: statIsValue ? wantedRealization : null }
    reported = { ...reported, iteration: k }
    baseChip.setIteration(k)

    if ((statIsValue && realizationMissing) || groupMissing) {
      drawNothing()
      renderDrawnNotice()
      renderSelectedNotice()
      askSitesWhere()
      paintStatusBar()
      scheduleViewWrite()
      return
    }

    // A dot group may sit on another layer in this iteration; the first draw makes the same move.
    const dotLayer = dotLayerForGroup(target, { ppIndex, joined, pointXy, layerArray, currentLayer: committed.layer })
    if (dotLayer !== null && dotLayer !== committed.layer) {
      committed = { ...committed, layer: dotLayer }
      controlsHandle?.setLayer(dotLayer)
      reported = { ...reported, layer: dotLayer }
      store.set({ layer: dotLayer }, 'map')
    }
    renderDrawnNotice()
    renderSelectedNotice()
    askSitesWhere()
    scheduleFetch(committed)
  }

  function followIteration(iteration: number, origins: ReadonlySet<string>): void {
    if (origins.size === 1 && origins.has('map')) return
    toggleHandle?.setCurrent(iteration)
    void switchIteration(iteration)
  }

  // A group chosen in another view moves the map only to a group it can draw, and
  // never echoes: the map does not write parGroups when its own picker changes.
  function followGroup(groups: ReadonlySet<string>, origins: ReadonlySet<string>): void {
    if (origins.size === 1 && origins.has('map')) return
    if (groups.size !== 1) return
    const [group] = groups
    if (paintedPicker.kind !== 'ready' || !paintedPicker.drawable.includes(group)) return
    if (group === (pendingGroup ?? drawnGroup)) return
    paintPicker({ ...paintedPicker, selected: group })
    handleGroupChange(group)
  }

  // ---- observation colouring ----

  function showObsNotice(title: string, detail: string, tone: NoticeTone = 'warning'): void {
    obsNoticeEl.textContent = ''
    addNotice(obsNoticeEl, { title, detail, tone })
  }

  function sitesText(n: number): string {
    return n === 1 ? '1 site' : `${n} sites`
  }

  // Cells outside the model are outlined, as under the parameter field.
  function obsInactiveMask(active: Uint8Array): Uint8Array {
    const mask = new Uint8Array(active.length)
    for (let c = 0; c < mask.length; c++) mask[c] = active[c] ? 0 : 1
    return mask
  }

  // No parameter field, the quiet footprint only, and no dot until the frame lands.
  function enterObsLook(): void {
    if (!layer || !mesh) return
    if (obsActive && obsLookLayer === committed.layer) return
    const fresh = !obsActive
    obsActive = true
    obsLookLayer = committed.layer
    mapCanvasArea.classList.add('colour-obs')
    const active = activeMaskFor(committed.layer)
    layer.setMissingStyle('ring')
    layer.setValues(new Float32Array(mesh.nCells).fill(Number.NaN))
    layer.setContested(new Uint8Array(mesh.nCells))
    layer.setFootprint(active)
    layer.setInactive(obsInactiveMask(active))
    putPoints(new Float32Array(0), new Float32Array(0))
    obsDotsKey = ''
    obsDrawnIndex = null
    selectedPointRow = null
    if (fresh) renderObsLegend(legendEl, null)
  }

  // Nothing is drawn as a dot: a failure or an empty group says so, and no stale dot stays.
  function clearObsDots(): void {
    obsDots = null
    obsFrame = null
    obsDotsKey = ''
    obsPick = null
    obsPickedRows = []
    obsDrawnIndex = null
    putPoints(new Float32Array(0), new Float32Array(0))
    renderObsLegend(legendEl, null)
    refreshMarks(false)
    redraw()
    updateReadout()
  }

  // Puts the parameter colouring back exactly as the held field has it.
  function restoreParameterLook(): void {
    obsSerial += 1
    obsActive = false
    obsLookLayer = null
    obsGroupInUse = null
    obsDots = null
    obsFrame = null
    obsDotsKey = ''
    obsPick = null
    obsPickedRows = []
    obsDrawnIndex = null
    obsTimeReady = false
    obsStepSerial += 1
    obsSlider?.hide()
    mapCanvasArea.classList.remove('colour-obs')
    if (!layer) return
    layer.setMissingStyle('discard')
    if (rawFullField !== null) {
      deriveAndDraw()
    } else {
      layer.setValues(new Float32Array(mesh?.nCells ?? 0).fill(Number.NaN))
      putPoints(new Float32Array(0), new Float32Array(0))
      layer.setFootprint(null)
      layer.setInactive(drawnInactiveMask())
      paintLegend(null)
      refreshMarks(false)
      redraw()
    }
    updateReadout()
  }

  function leaveObservations(): void {
    obsParked = false
    obsNoticeEl.textContent = ''
    restoreParameterLook()
  }

  // The chosen iteration has no observation statistics: never another iteration's, the parameter colouring instead.
  function parkObservations(title: string, detail: string): void {
    if (!obsParked || obsActive) restoreParameterLook()
    obsParked = true
    showObsNotice(title, detail, 'warning')
  }

  // The same path a layer written by another view takes, but this view is the writer.
  function moveObsLayer(target: number): void {
    committed = { ...committed, layer: target }
    reported = { ...reported, layer: target }
    controlsHandle?.setLayer(target)
    store.set({ layer: target }, 'map')
    scheduleViewWrite()
  }

  // The last row at the time, the same one the frame takes, and how many rows sit at that time.
  function rowsAt(times: number[], time: number): { last: number; count: number } {
    let last = -1
    let count = 0
    times.forEach((t, i) => {
      if (t === time) {
        last = i
        count += 1
      }
    })
    return { last, count }
  }

  function observedFor(siteId: number, time: number | null): { observed: SiteReadoutEntry['observed']; rowsAtTime: number } {
    if (time === null) return { observed: { kind: 'no_observation' }, rowsAtTime: 0 }
    const read = obsSiteMemo.get(siteId)
    if (read === undefined || read.state === 'loading') return { observed: { kind: 'loading' }, rowsAtTime: 0 }
    if (read.state === 'failed') return { observed: { kind: 'unavailable', reason: read.reason }, rowsAtTime: 0 }
    const { time: times, obsval, no_value: noValue, sentinel, weighted } = read.payload
    // The exact time only; the nearest time is never used.
    const { last: at, count: rowsAtTime } = rowsAt(times, time)
    if (at < 0) return { observed: { kind: 'no_observation' }, rowsAtTime: 0 }
    const value = obsval[at]
    if (noValue[at] || sentinel[at] || value === null) return { observed: { kind: 'no_value' }, rowsAtTime }
    return { observed: weighted[at] ? { kind: 'value', value } : { kind: 'zero_weight', value }, rowsAtTime }
  }

  function sitesPick(rows: number[]): ReadoutPick {
    const data = obsData!
    const frame = obsFrame!
    const position = obsTimePos
    const time = position !== null && position.index >= 0 ? position.times[position.index] : null
    const timeText = position === null || time === null ? 'no time' : formatTimeValue(position.kind, time)
    const [originX, originY] = mesh?.origin ?? [0, 0]
    const entries: SiteReadoutEntry[] = rows.slice(0, OBS_SITE_LIST_CAP).map((row) => {
      const site = data.rows[row]
      const value = frame[row]
      const seen = observedFor(site.siteId, time)
      return {
        name: site.site,
        group: data.group,
        x: data.xy[2 * row] + originX,
        y: data.xy[2 * row + 1] + originY,
        xySource: site.xySource === 'own' ? 'own' : 'cell_centre',
        layer: site.layer >= 0 ? site.layer : null,
        cell: site.cell,
        rule: site.rule,
        timeText,
        observed: seen.observed,
        rowsAtTime: seen.rowsAtTime,
        stat: { label: OBS_STAT_LABEL[obsStat], value: Number.isFinite(value) ? value : null, iteration: obsIteration },
      }
    })
    return { kind: 'sites', entries, total: rows.length }
  }

  // Rebuilt from the held frame, so a time, layer or statistic change keeps the readout true.
  function refreshObsPick(): void {
    const dots = obsDots
    if (obsPickedRows.length === 0 || dots === null || obsData === null || obsFrame === null) {
      if (obsPick !== null) {
        obsPick = null
        updateReadout()
      }
      return
    }
    const dotOf = new Map<number, number>()
    dots.rows.forEach((row, i) => dotOf.set(row, i))
    obsPickedRows = obsPickedRows.filter((row) => dotOf.has(row))
    if (obsPickedRows.length === 0) {
      obsPick = null
      updateReadout()
      return
    }
    obsPick = sitesPick(obsPickedRows)
    updateReadout()
  }

  // Once per site per page unless the read failed, and only for the entries the readout lists.
  function readObservedValues(rows: number[]): void {
    const data = obsData
    if (data === null) return
    for (const row of rows.slice(0, OBS_SITE_LIST_CAP)) {
      const siteId = data.rows[row].siteId
      // A failed read stays on show until the next click, which asks again.
      const held = obsSiteMemo.get(siteId)
      if (held !== undefined && held.state !== 'failed') continue
      obsSiteMemo.set(siteId, { state: 'loading' })
      void fetchObsSite(siteId)
        .then(
          (result): ObsSiteRead =>
            result.ok ? { state: 'done', payload: result.payload } : { state: 'failed', reason: `${result.artifact}: ${result.reason}` },
          (error: unknown): ObsSiteRead => ({ state: 'failed', reason: describeError(error) }),
        )
        .then((read) => {
          obsSiteMemo.set(siteId, read)
          if (obsPickedRows.includes(row)) refreshObsPick()
        })
    }
  }

  // D-31, D-32: every site within reach is read out; D-01: the click replaces, adds or removes
  // them in the shared selection, and only a plain click also clears the cells and parameters.
  function pickObservationSites(hits: number[], mode: SelectMode): void {
    const dots = obsDots
    const data = obsData
    if (dots === null || data === null) return
    const rows = hits.map((i) => dots.rows[i])
    obsPickedRows = rows
    obsPick = sitesPick(rows)
    updateReadout()
    readObservedValues(rows)
    dropPendingLink()
    const sites = selectSites(store.get(), rows.map((row) => data.rows[row].siteId), mode).sites
    if (mode === 'replace') {
      selectedCellId = null
      store.set({ sites, cells: new Set(), pars: new Set() }, 'map')
    } else {
      store.set({ sites }, 'map')
    }
    refreshMarks()
  }

  async function drawObservations(): Promise<void> {
    if (!layer || !mesh) return
    const selection = store.get()
    if (selection.colour.source !== 'obs') return
    const serial = ++obsSerial
    // A parked map keeps its parameter colouring until the iteration check below passes.
    if (!obsParked) enterObsLook()
    try {
      await drawObservationsFor(serial, selection)
    } catch (error) {
      if (serial !== obsSerial) return
      showObsNotice('The observation colouring could not be drawn', describeError(error), 'serious')
      if (obsActive) clearObsDots()
    }
  }

  async function drawObservationsFor(serial: number, selection: SharedSelection): Promise<void> {
    const statText = selection.colour.stat
    if (!isObsStat(statText)) {
      showObsNotice('That statistic cannot colour the observations', `${statText} is not one of the observation statistics.`)
      if (obsActive) clearObsDots()
      return
    }
    const stat = statText
    obsStat = stat

    // Taken before an automatic pick sets obsGroupInUse, so that pick counts as a change too.
    const previousGroup = obsGroupInUse
    let group = [...selection.obsGroups][0] ?? null
    if (group === null) {
      const groups = await loadObsGroups()
      if (serial !== obsSerial) return
      if (!groups.ok) {
        showObsNotice(`${groups.artifact} could not be read`, groups.reason)
        if (obsActive) clearObsDots()
        return
      }
      // The first group with a placed site; with none placed, the first group so its legend can say why.
      const pick = groups.rows.find((row) => (row.nPlaced ?? 0) > 0) ?? groups.rows[0]
      if (pick === undefined) {
        showObsNotice('This run has no observation groups', 'obs_index: there is no group to colour the map by.')
        if (obsActive) clearObsDots()
        return
      }
      group = pick.group
      obsGroupInUse = group
      store.set({ obsGroups: new Set([group]) }, 'map')
    }
    const groupChanged = group !== previousGroup
    obsGroupInUse = group
    if (groupChanged) {
      // The old group's times must not be steppable while the new group loads.
      obsTimeReady = false
      obsSlider?.hide()
      obsLayerMoved = null
      obsPick = null
      obsPickedRows = []
      obsDotsKey = ''
    }
    obsNoticeEl.textContent = ''

    const loaded = await obsSource.loadGroup(group)
    if (serial !== obsSerial || loaded.stale) return
    if ('failed' in loaded) {
      showObsNotice(`${loaded.failed.artifact} could not be read for ${group}`, loaded.failed.reason)
      if (obsActive) clearObsDots()
      return
    }
    const data = loaded.data
    obsData = data

    const iteration = selection.iteration
    const entry = data.times.iterations.find((i) => i.iteration === iteration)
    if (entry === undefined || !entry.available) {
      parkObservations(
        `No observation statistics for iteration ${iteration}`,
        `obs_agg/${iteration}: ${entry?.reason ?? 'this iteration is not in the run'}. The map keeps its parameter colouring; no other iteration is drawn in its place.`,
      )
      return
    }
    obsParked = false
    obsIteration = iteration
    enterObsLook()

    const times = data.times.times
    const kind = data.times.time_kind
    const notes: string[] = []
    const timeNotes: string[] = []
    let index = -1
    if (data.times.refused !== null) {
      showObsNotice(`${group} has no time axis`, `obs_index: ${data.times.refused}`)
      obsSlider?.refuse(data.times.refused)
    } else if (times.length === 0) {
      showObsNotice(`${group} has no time to show`, 'obs_index: no observation of this group has a finite time.')
      obsSlider?.refuse('no observation of this group has a finite time')
    } else {
      // Read now, not from the snapshot: the slider may have moved while the group loaded.
      const wanted = store.get().timeIdx
      const wantedOk = Number.isInteger(wanted) && wanted >= 0 && wanted < times.length
      if (obsTimePos !== null && groupChanged) {
        const carried = carryTime(obsTimePos, { kind, times }, formatTimeValue)
        index = carried.index
        if (carried.note !== null) timeNotes.push(carried.note)
      } else if (wantedOk) {
        index = wanted
      } else {
        index = 0
        timeNotes.push(`the slider position ${wanted} is not a time of this group, so the first time is shown`)
      }
      obsTimePos = { kind, times, index }
      if (index !== wanted) store.set({ timeIdx: index }, 'map')
      obsSlider?.show(times, kind, data.times.steps_by, index, timeNotes.length > 0 ? timeNotes.join('. ') : null, group)
      obsTimeReady = true
      obsStepSerial += 1
    }

    let frame: Float32Array
    if (index >= 0) {
      if (obsSource.frames.get(obsSource.frames.key(group, iteration, times[index], stat, data.orderDigest)) === undefined) {
        obsSlider?.setStatus('reading this time…')
      }
      const answer = await obsSource.frames.want(group, data.orderDigest, iteration, times, index, stat)
      if (serial !== obsSerial || answer.stale) return
      if ('failed' in answer) {
        showObsNotice(`${answer.failed.artifact} could not be read for ${group}`, answer.failed.reason)
        obsSlider?.setStatus(`${answer.failed.artifact}: ${answer.failed.reason}`)
        clearObsDots()
        return
      }
      obsSlider?.setStatus(null)
      frame = answer.values
    } else {
      frame = new Float32Array(data.rows.length).fill(Number.NaN)
    }

    let dots = dotsFor(data, committed.layer, obsAllLayers)
    if (groupChanged && dots.counts.drawn === 0 && dots.lowestLayer !== null) {
      moveObsLayer(dots.lowestLayer)
      obsLayerMoved = dots.lowestLayer
      enterObsLook()
      dots = dotsFor(data, committed.layer, obsAllLayers)
    }

    const target = layer
    if (target === null) return
    const values = valuesToDraw(data, frame, dots)
    const limits = data.times.limits[stat]
    target.setColormap(OBS_RAMP[stat], false)
    target.setLimits(limits ?? [0, 1])
    const key = `${group}|${committed.layer}|${obsAllLayers}`
    if (key === obsDotsKey && obsDots !== null && obsDots.rows.length === dots.rows.length) {
      target.setPointValues(values)
    } else {
      putPoints(dots.xy, values, 'obs')
    }
    obsDotsKey = key
    obsDots = dots
    obsFrame = frame
    obsDrawnIndex = index >= 0 ? index : null
    refreshMarks(false)
    redraw()

    if (obsAllLayers) {
      let unknown = 0
      for (const row of dots.rows) if (data.layer[row] < 0) unknown += 1
      if (unknown > 0) notes.push(`${sitesText(unknown)} with an unknown layer drawn because all layers is on`)
    }
    for (const note of data.times.notes) notes.push(note)
    obsStaticNotes = notes
    paintObsLegend(frame, index, timeNotes)
    refreshObsPick()
  }

  // With no known limits a colour would be a guess, so the dots are drawn as missing.
  function valuesToDraw(data: ObsGroupData, frame: Float32Array, dots: ObsDots): Float32Array {
    if (data.times.limits_refused) return new Float32Array(dots.rows.length).fill(Number.NaN)
    return valuesForDots(frame, dots)
  }

  // Everything but the time comes from what the last full draw left in place.
  function paintObsLegend(frame: Float32Array, index: number, timeNotes: string[]): void {
    const data = obsData
    const dots = obsDots
    if (data === null || dots === null) return
    const times = data.times.times
    renderObsLegend(legendEl, {
      group: data.group,
      stat: obsStat,
      iteration: obsIteration,
      limits: data.times.limits[obsStat],
      limitsRule: data.times.limits_rule,
      limitsRefused: data.times.limits_refused,
      timeText: index >= 0 ? formatTimeValue(data.times.time_kind, times[index]) : 'no time to show',
      counts: dots.counts,
      atTime: index >= 0 ? countsAtTime(frame, dots, data.times.n_at_time[index] ?? 0, obsSource.frames.rowsHiddenIn(frame)) : null,
      layerMoved: obsLayerMoved === committed.layer ? obsLayerMoved : null,
      notes: [...timeNotes, ...obsStaticNotes],
    })
  }

  // A frame for the time the slider shows: dot positions stay, only values change.
  function paintObsFrame(frame: Float32Array, index: number): void {
    const data = obsData
    const dots = obsDots
    if (!layer || data === null || dots === null) return
    layer.setPointValues(valuesToDraw(data, frame, dots))
    obsFrame = frame
    obsTimePos = { kind: data.times.time_kind, times: data.times.times, index }
    obsDrawnIndex = index
    redraw()
    obsSlider?.setStatus(null)
    paintObsLegend(frame, index, [])
    refreshObsPick()
  }

  // D-29: a held frame draws at once with no request; the window around it is kept prefetched.
  function stepObsTime(index: number): void {
    const data = obsData
    const position = obsTimePos
    if (!obsTimeReady || !obsActive || obsParked || data === null || obsDots === null || position === null) return
    const times = data.times.times
    if (!Number.isInteger(index) || index < 0 || index >= times.length) return
    store.set({ timeIdx: index }, 'time-slider')
    const step = ++obsStepSerial
    const iteration = obsIteration
    const stat = obsStat
    const frames = obsSource.frames
    const held = frames.get(frames.key(data.group, iteration, times[index], stat, data.orderDigest))
    const stillWanted = (): boolean => step === obsStepSerial && obsActive && obsData === data
    if (held !== undefined) {
      paintObsFrame(held, index)
      void frames.want(data.group, data.orderDigest, iteration, times, index, stat).catch(() => undefined)
      return
    }
    obsSlider?.setStatus('reading this time…')
    frames.want(data.group, data.orderDigest, iteration, times, index, stat).then(
      (answer) => {
        if (answer.stale || !stillWanted()) return
        if ('failed' in answer) {
          obsSlider?.setStatus(`${answer.failed.artifact}: ${answer.failed.reason}`)
          return
        }
        paintObsFrame(answer.values, index)
      },
      (error: unknown) => {
        if (stillWanted()) obsSlider?.setStatus(describeError(error))
      },
    )
  }

  function followColour(next: SharedSelection): void {
    if (next.colour.source === 'obs') {
      void drawObservations()
      return
    }
    if (obsActive || obsParked) leaveObservations()
  }

  // Draws from the store whatever view wrote it, but a group this view just chose is already drawing.
  function followObsGroup(next: SharedSelection): void {
    if (next.colour.source !== 'obs') return
    const first = [...next.obsGroups][0]
    if (first === undefined || first === obsGroupInUse) return
    void drawObservations()
  }

  function followObsTime(origins: ReadonlySet<string>): void {
    // The map's own writes are already drawn; so is a slider step.
    if ([...origins].every((origin) => origin === 'map' || origin === 'time-slider')) return
    if (store.get().colour.source === 'obs') void drawObservations()
  }

  clearCanvas()

  void loadAndDraw(ctx)

  async function readPlacement(): Promise<void> {
    let failure: string
    try {
      const answer = await fetchPlacement()
      if (answer.ok) {
        recordedPlacement = new Map(answer.payload.groups.map((entry) => [entry.group, entry]))
        placementNotes = answer.payload.notes ?? []
        return
      }
      failure = `${answer.artifact}: ${answer.reason}`
    } catch (error) {
      const { artifact, reason } = problemArtifactAndReason(error)
      failure = artifact === null ? reason : `${artifact}: ${reason}`
    }
    addNotice(mapNotice, {
      title: 'The placement notes could not be read',
      detail: `${failure}. Unmapped groups keep their general wording.`,
      tone: 'warning',
    })
  }

  // A failed or misshapen read draws every group as cells, with a notice saying why.
  async function readPointXy(iteration: number): Promise<Float32Array | null> {
    const { xy, problem } = await source.loadPointXy(iteration, cellArray.length)
    if (problem !== null) {
      addNotice(mapNotice, {
        title: 'Point positions could not be read',
        detail: `${problem} Groups placed by x/y draw as the cells their points sit in.`,
        tone: 'serious',
      })
    }
    return xy
  }

  async function loadAndDraw(gl: GlContext): Promise<void> {
    const opening = openingIteration(opts.config, opts.state)
    const iteration = opening.iteration
    if (opening.note !== null) {
      addNotice(mapNotice, { title: 'The first iteration was not recorded', detail: opening.note, tone: 'info' })
    }

    // The shell started this read ahead of the mesh/parmap fetches and owns
    // the divider; the restored choices are read once the groups are known.
    const viewStatePromise = opts.viewState

    // Asked with the first requests and read when the groups are sorted; a failed
    // read keeps the old wording in the unmapped list and says so once.
    const placementRead = readPlacement()

    let positions: Float32Array
    let cellIndexBuf: Float32Array
    let indices: Uint32Array
    try {
      mesh = await gridMesh()
      positions = (await gridMeshBuffer('positions')) as Float32Array
      cellIndexBuf = (await gridMeshBuffer('cell_index')) as Float32Array
      indices = (await gridMeshBuffer('indices')) as Uint32Array
    } catch {
      addNotice(mapNotice, {
        title: 'No grid file for this run',
        detail: "This run has no MODFLOW 6 grid file, so there's nothing to draw on the map. Every other view still works.",
        tone: 'info',
      })
      paintPicker({ kind: 'failed' })
      canvas.remove()
      return
    }
    meshBytes = positions.byteLength + cellIndexBuf.byteLength + indices.byteLength

    if (mesh.hasIdomain) {
      let reason: string | null = null
      try {
        const read = await gridIdomain()
        const expected = mesh.nlay * mesh.nCells
        if (read.length === expected) {
          idomain = read
        } else {
          reason = `It has ${read.length} values, not the ${expected} the grid needs (${mesh.nlay} layers of ${mesh.nCells} cells).`
        }
      } catch (error) {
        reason = describeError(error)
      }
      if (reason !== null) {
        addNotice(mapNotice, {
          title: "The grid file's idomain could not be read",
          detail: `${reason} A cell counts as in the model when any parameter lands on it.`,
          tone: 'serious',
        })
      }
    }

    // Not a failure and never blocking (visual contract §9): a run with no
    // CRS is a normal state, so this is purely additive and the load
    // sequence carries on regardless.
    if (mesh.crs === null) {
      addNotice(mapNotice, {
        title: 'No coordinate system',
        detail: "This run has no CRS. The map shows model coordinates with no scale bar — that's normal, not a problem.",
        tone: 'info',
      })
    }

    // One request for the parameter table, shared with the Params panel.
    let parTable: Promise<ArrayBuffer>
    let identities: ParIdentity[]
    try {
      const tables = await source.loadParameterTables(iteration)
      parTable = tables.parTable
      identities = tables.identities
      joined = tables.joined
    } catch (error) {
      addNotice(mapNotice, {
        title: 'The parameter table could not be read',
        detail: describeError(error),
        tone: 'serious',
      })
      paintPicker({ kind: 'failed' })
      canvas.remove()
      return
    }
    allIdentities = identities
    const pp = await source.loadPpIndex()
    ppIndex = pp.index
    if (pp.problem !== null) {
      addNotice(mapNotice, {
        title: 'The pilot-point index could not be read',
        detail: `${pp.problem} Pilot-point groups are not drawn as interpolated fields.`,
        tone: 'serious',
      })
    }

    try {
      const cells = await source.loadCells(iteration)
      cellArray = cells.cell
      layerArray = cells.layer
    } catch (error) {
      const { artifact, reason } = problemArtifactAndReason(error)
      addNotice(mapNotice, {
        title: artifact ? `No cell mapping for ${artifact}` : 'No cell mapping for this run',
        detail: reason,
        tone: 'serious',
      })
      paintPicker({ kind: 'failed' })
      canvas.remove()
      return
    }
    pointXy = await readPointXy(iteration)

    const artifactNotes = buildArtifactNotes(identities)

    // D-07: only groups that place on at least one cell are offered; the
    // rest are counted and named behind the picker's own disclosure.
    await placementRead
    const { drawable, unmapped, interpolated } = computeGroupPlacement(
      identities,
      joined,
      cellArray,
      ppIndex,
      recordedPlacement,
    )
    if (drawable.length === 0) {
      addNotice(mapNotice, {
        title: 'No parameter group can be drawn on this map',
        detail: 'Every group in this run failed to place on the grid. The unmapped list below names each one and the rule that was tried.',
        tone: 'info',
      })
      paintPicker({ kind: 'none-drawable', unmapped })
      opts.onPanelFacts({ unmapped, artifactNotes, parTable })
      canvas.remove()
      return
    }
    // D-11: a reopened run comes back showing the group it was left on,
    // when that group is still drawable -- never a group the current data
    // cannot place, which the fresh-run default (drawable[0]) already
    // guards against.
    //
    // `group` is the one field in the wire shape with a genuine unset
    // sentinel (`null`, prefs.py's own default): every other field
    // (colormap, scale, limits_mode, stat) has a non-null default that is
    // indistinguishable on the wire from a value the user actually chose.
    // A non-null restored group is therefore the one honest signal that
    // this cache_root has ever been written to at all -- everything else
    // restored view state carries is only trusted alongside it.
    const restoredView = await viewStatePromise
    const wasVisitedBefore = restoredView !== null && restoredView.group !== null
    drawnGroup =
      wasVisitedBefore && drawable.includes(restoredView!.group!) ? restoredView!.group! : drawable[0]
    paintPicker({ kind: 'ready', drawable, interpolated, unmapped, selected: drawnGroup })
    opts.onPanelFacts({ unmapped, artifactNotes, parTable })

    realNames = await source.loadRealNames(iteration)
    loadedIteration = iteration
    loadedFrom = iteration

    meshGeom = { positions, cellIndex: cellIndexBuf, indices, nCells: mesh.nCells }
    layer = new MeshLayer(gl.gl, meshGeom)
    layer.setColormap('viridis')
    layer.setInactive(drawnInactiveMask())
    layer.setHairlineColor(readColorToken('--model-edge'))
    applyThemeColors()

    fitCanvasToFrame()
    camera = new Camera(canvas.width, canvas.height)
    camera.fit(mesh.bounds)
    layer.setMatrix(camera.matrix())

    // A run whose realization names were never recorded can still show an
    // aggregate statistic, which needs no realization name -- 'value'
    // would only ever fail to load, so it is not offered as the default.
    // D-11: a restored statistic wins over the fresh-run default, on a run
    // that has actually been visited before, unless it is 'value' on a run
    // whose names were never recorded, which would only ever fail to load.
    const initialStat = wasVisitedBefore ? restoredStat(restoredView!.stat, realNames.ok) : restoredStat(undefined, realNames.ok)
    const initialRealization = realNames.ok ? (realNames.names[0] ?? null) : null
    wantedRealization = initialRealization
    // D-03: the scale defaults from the drawn group's own partrans, read
    // through the D-05 join -- matched case-insensitively after trimming,
    // and linear for anything this code has never seen. A restored scale
    // is only trusted on a run that has actually been visited before
    // (`wasVisitedBefore`); otherwise the store's own hardcoded default
    // ('linear') would silently override a correct log10 inference on
    // every run that has never once been opened, which is the common case,
    // not an edge case.
    const drawnPartrans = partransForGroup(joined, drawnGroup, allIdentities)
    const inferredScale: ValueScale = drawnPartrans?.trim().toLowerCase() === 'log' ? 'log10' : 'linear'
    const initialScale: ValueScale = wasVisitedBefore ? restoredView!.scale : inferredScale
    if (wasVisitedBefore && restoredView!.limitsMode === 'manual') {
      addNotice(mapNotice, {
        title: 'Manual limits could not be restored',
        detail:
          "This run was left with manual colour limits, but the saved state has no record of the numbers used -- showing the robust 2-98% range instead.",
        tone: 'info',
      })
    }
    const savedLayer = wasVisitedBefore ? restoredView!.layer : null
    committed = {
      iteration,
      layer: interpolatedEntry(drawnGroup)?.layer ?? (savedLayer !== null && savedLayer < mesh.nlay ? savedLayer : 0),
      stat: initialStat,
      realization: initialRealization,
      colormap: wasVisitedBefore ? restoredColormap(restoredView!.colormap) : 'viridis',
      reverseColormap: wasVisitedBefore ? restoredView!.reverse : false,
      scale: initialScale,
      scaleInferred: !wasVisitedBefore,
      limitsMode: wasVisitedBefore ? restoredLimitsMode(restoredView!.limitsMode) : 'robust',
      manualLimits: null,
    }
    // A saved layer holding none of a dot group's dots gives way to the layer that does.
    committed = { ...committed, layer: dotLayerFor(drawnGroup) ?? committed.layer }
    choicesSettled = true

    // Placed before pickerEl, not appended at the end: the controls come
    // first in the top-left cluster, both visually (flex column) and in
    // tab order, with the group picker stacked under them.
    const controlsEl = document.createElement('div')
    topLeftEl.insertBefore(controlsEl, pickerEl)
    // WINDOWS.md #8: `committed` already carries the restored colormap,
    // reverse, scale and limits state (or the fresh-run defaults, when
    // there is none) -- passed straight through so the checkbox and
    // selects the user sees never disagree with what performFetch is
    // about to draw.
    controlsHandle = renderSelectionControls(controlsEl, {
      nlay: mesh.nlay,
      iteration,
      realNames,
      partrans: drawnPartrans,
      initial: {
        colormap: committed.colormap,
        reverseColormap: committed.reverseColormap,
        scale: committed.scale,
        scaleInferred: committed.scaleInferred,
        limitsMode: committed.limitsMode,
        manualLimits: committed.manualLimits,
        stat: committed.stat,
      },
      onSelectionChange: handleSelectionChange,
      onFitToExtent: fitToExtent,
    })
    controlsHandle.setLayer(committed.layer)

    // D-01, D-02: one button per ingested iteration, right after the controls; absent below two.
    const iterations = iterationsFrom(opts.state)
    if (iterations.length >= 2) {
      const toggleEl = document.createElement('div')
      topLeftEl.insertBefore(toggleEl, pickerEl)
      toggleHandle = renderIterationToggle(toggleEl, {
        iterations,
        current: iteration,
        onChange: (next) => {
          store.set({ iteration: next }, 'iteration-toggle')
          toggleHandle?.setCurrent(next)
        },
      })
    }

    // Only a run that recorded observations offers the switch; the Obs tab says why when it did not.
    const obsCapability = opts.state.capabilities.obs
    if (obsCapability !== undefined && obsCapability.available) {
      const sliderEl = document.createElement('div')
      topLeftEl.insertBefore(sliderEl, pickerEl)
      obsSlider = renderTimeSlider(sliderEl, { onChange: stepObsTime })
      const colourEl = document.createElement('div')
      topLeftEl.insertBefore(colourEl, sliderEl)
      obsControls = renderObsColourControls(colourEl, {
        store,
        loadGroups: loadObsGroups,
        onAllLayersChange: (on) => {
          obsAllLayers = on
          if (store.get().colour.source === 'obs') void drawObservations()
        },
      })
    }

    reported = committed
    store.set(storePatch(committed, null), 'map')
    store.subscribe(
      (selection) => selection.layer,
      (next, _prev, origins) => followForeignLayer(next.layer, origins),
    )
    store.subscribe(
      (selection) => selection.iteration,
      (next, _prev, origins) => followIteration(next.iteration, origins),
    )
    store.subscribe(
      (selection) => selection.parGroups,
      (next, _prev, origins) => followGroup(next.parGroups, origins),
    )
    // D-03: the count follows the selection whichever view changes it; the iteration
    // side is redrawn by switchIteration once the new names have landed.
    store.subscribe(
      (selection) => selection.reals,
      () => renderSelectedNotice(),
    )

    store.subscribe(
      (selection) => selection.colour,
      (next) => followColour(next),
    )
    // Drawing rings writes nothing, so following every origin cannot loop.
    store.subscribe(
      (selection) => selection.cells,
      () => refreshMarks(),
    )
    store.subscribe(
      (selection) => selection.sites,
      () => {
        askSitesWhere()
        refreshMarks()
      },
    )
    store.subscribe(
      (selection) => selection.pars,
      (_next, _prev, origins) => followPars(origins),
    )
    if (store.get().pars.size > 0) followPars(new Set(['mount']))
    askSitesWhere()
    // The first draw is still to come and shows these.
    refreshMarks(false)
    store.subscribe(
      (selection) => selection.obsGroups,
      (next) => followObsGroup(next),
    )
    store.subscribe(
      (selection) => selection.timeIdx,
      (_next, _prev, origins) => followObsTime(origins),
    )
    // No echo skip: a failed iteration switch writes the old iteration back as 'map'.
    store.subscribe(
      (selection) => selection.iteration,
      () => {
        if (store.get().colour.source === 'obs') void drawObservations()
      },
    )

    // D-22: the overlay toggles lead the map controls; they ask nothing until the first field draws.
    const overlayEl = document.createElement('div')
    topLeftEl.insertBefore(overlayEl, topLeftEl.firstChild)
    overlayControls = renderOverlayControls(overlayEl, {
      onToggle: () => {
        overlayBuiltFrom = null
        redrawOverlays()
      },
    })
    store.subscribe(
      (selection) => selection.runId,
      () => {
        overlaySource.cancel()
        overlayAsked = null
        overlayBuiltFrom = null
        baseNames.clear()
        redrawOverlays()
      },
    )
    baseChip.setIteration(iteration)

    pending = committed
    await performFetch(committed)
    if (canvas.getAttribute('data-drawn') === 'true') schedulePickIndex(meshGeom)
    if (store.get().colour.source === 'obs') void drawObservations()
  }

  // Built in idle time after the first draw, so the first click does not pay for it.
  function schedulePickIndex(drawn: MeshData): void {
    const build = () => preparePickIndex(drawn)
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(build)
    else setTimeout(build, 0)
  }
  return { viewFields }
}
