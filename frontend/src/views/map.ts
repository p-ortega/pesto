// The map screen: header, notice area, canvas and status bar, and the
// load-and-draw sequence that turns a run's mesh, parameter table and one
// realization's field into a WebGL2 drawing. This replaces placeholder.ts
// as the screen every flow in this phase ends at.

import { ApiError, type GridValuesQuery, type IngestState, type MeshInfo, type ViewState } from '../data/client'
import {
  gridCells,
  gridIdomain,
  gridMesh,
  gridMeshBuffer,
  gridPointXy,
  gridValues,
  readViewState,
  writeViewState,
} from '../data/client'
import { hasPosition, isPointGroup, pickPoint, pointsOnLayer, type DrawnPoints } from '../data/points'
import { inactiveLandingNotes, layerActiveMask, referencedMask } from '../data/domain'
import { renderDivider } from '../ui/divider'
import { renderParamsPanel } from '../ui/params-panel'
import {
  classifyCells,
  fetchParIdentities,
  fetchParmap,
  joinBlockToIdentity,
  type CellClass,
  type ParIdentity,
} from '../data/parmap'
import { fetchRealNames } from '../data/reals'
import {
  EMPTY_PP_INDEX,
  classifyFieldCells,
  fetchPpIndex,
  fieldContributors,
  gridField,
  type Contributor,
  type PpGroupInfo,
  type PpIndex,
} from '../data/fields'
import { Camera } from '../gl/camera'
import { applyScale, logIsUsable, scaleLimits, subsetValues, LimitsMemory, type ColormapName, type ValueScale } from '../gl/colormap'
// WINDOWS.md #10: this parser lives outside views/ because style-frame.test.ts
// scans every file under views/ and ui/ for a raw hex colour literal --
// this module's own hex-digit regex and doc comments would trip that scan,
// even though it reads colours rather than writing one.
export { parseColorToken } from '../gl/color-token'
import { readColorToken } from '../gl/color-token'
import { createContext, type GlContext } from '../gl/context'
import { MeshLayer, type MeshData } from '../gl/mesh-layer'
import { pickAtWorld } from '../gl/picking'
import { renderSelectionControls, type Selection, type SelectionControlsHandle } from '../ui/controls'
import { renderLegend } from '../ui/legend'
import { renderGroupPicker, type GroupPickerState, type UnmappedGroup } from '../ui/group-picker'
import { renderReadout, type ReadoutPick } from '../ui/readout'
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
}

export interface MountMapOptions {
  config: RunConfig | null
  state: IngestState
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

// D-07: a group is drawable when at least one of its block rows places on
// a real cell (cell !== -1, Phase 3's own -1 sentinel for "no rule
// matched"); every other group in the control table is unmapped. The map
// block carries only the parameters that placed, so a group none of whose
// parameters placed never appears in it at all -- on a real PstFrom run
// that is nearly every group -- which is why the groups are read from the
// control table, which lists every parameter, and only the placed set from
// the block. Order is first-seen in control-file order. The recorded
// placement note (ParCells.notes) is not exposed by any route today, so
// every unmapped entry carries `note: null` and falls back to the "no
// placement rule matched" copy -- a real gap, not a silent guess.
function computeGroupPlacement(
  identities: ParIdentity[],
  joined: Array<ParIdentity | null>,
  cells: Int32Array,
  ppIndex: PpIndex,
): { drawable: string[]; unmapped: UnmappedGroup[]; interpolated: string[] } {
  const order: string[] = []
  const seen = new Set<string>()
  for (const identity of identities) {
    if (!seen.has(identity.pargp)) {
      seen.add(identity.pargp)
      order.push(identity.pargp)
    }
  }
  const placed = new Set<string>()
  for (let i = 0; i < joined.length; i++) {
    const identity = joined[i]
    if (identity !== null && cells[i] >= 0) placed.add(identity.pargp)
  }
  // An interpolated group draws as a field even when no parameter of it
  // places on a cell; a group the index refused carries the index's reason.
  const interpolated = new Set(ppIndex.groups.map((g) => g.group))
  const refused = new Map(ppIndex.not_interpolable.map((r) => [r.group, r.reason]))
  const drawable: string[] = []
  const unmapped: UnmappedGroup[] = []
  for (const group of order) {
    if (placed.has(group) || interpolated.has(group)) {
      drawable.push(group)
    } else {
      const reason = refused.get(group)
      unmapped.push({ group, note: reason === undefined ? null : `${group} — ${reason}` })
    }
  }
  return { drawable, unmapped, interpolated: drawable.filter((g) => interpolated.has(g)) }
}

// The drawn group's own partrans, read straight from the D-05 join --
// never a positional guess. A group with no identified row (never reached
// while drawnGroup itself came from this same join) returns null, which
// the scale default treats as linear.
function partransForGroup(
  joined: Array<ParIdentity | null>,
  group: string,
  identities: ParIdentity[] = [],
): string | null {
  for (const identity of joined) {
    if (identity !== null && identity.pargp === group) return identity.partrans
  }
  // A pilot-point group need not sit in the map block at all; the control
  // table still names its partrans.
  for (const identity of identities) {
    if (identity.pargp === group) return identity.partrans
  }
  return null
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

function restoredStat(value: string | undefined, realNamesOk: boolean): Selection['stat'] {
  if (value !== undefined && KNOWN_STATS.has(value)) {
    if (value === 'value' && !realNamesOk) return 'mean'
    return value as Selection['stat']
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
 * The map screen: header, blocked-capability notices, the canvas panel and
 * the status bar, then the load-and-draw sequence -- mesh, the D-05 join,
 * the cell/layer companions, one realization's field -- ending in one
 * WebGL2 draw of one parameter group's field on a themed canvas.
 */
export function mountMap(root: HTMLElement, opts: MountMapOptions): void {
  root.textContent = ''
  root.classList.add('page', 'page-map')

  const header = document.createElement('div')
  header.classList.add('header')
  const noticeArea = document.createElement('div')
  const panel = document.createElement('div')
  panel.classList.add('map-frame')
  // D-09: the map is on the left and always present, not a tab. mapArea
  // holds the canvas and everything floating over it; the divider splits
  // it from the Params panel plan 05.1-07's Task 3 renders into
  // paramsPanelHost.
  const mapArea = document.createElement('div')
  mapArea.classList.add('map-column')
  const dividerEl = document.createElement('div')
  const paramsPanelHost = document.createElement('div')
  // The positioning context for the four floating overlays is the canvas's
  // own box, not the whole of mapArea -- mapArea also holds mapNotice below
  // the canvas, and anchoring "bottom" to mapArea's bottom would pull the
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
  const readoutEl = document.createElement('div')
  readoutEl.classList.add('floating-bottom-right')
  topLeftEl.appendChild(pickerEl)
  mapCanvasArea.appendChild(topLeftEl)
  mapCanvasArea.appendChild(canvas)
  mapCanvasArea.appendChild(legendEl)
  mapCanvasArea.appendChild(readoutEl)
  mapArea.appendChild(mapCanvasArea)
  mapArea.appendChild(mapNotice)
  panel.appendChild(mapArea)
  panel.appendChild(dividerEl)
  panel.appendChild(paramsPanelHost)
  const statusBar = document.createElement('div')
  statusBar.classList.add('status-bar')

  root.appendChild(header)
  root.appendChild(noticeArea)
  root.appendChild(panel)
  root.appendChild(statusBar)

  let ctx: GlContext | null = null
  let layer: MeshLayer | null = null
  let meshBytes: number | null = null
  // Set once the mesh and camera are loaded (loadAndDraw) -- the click
  // handler is wired from mount, so both are nullable until then.
  let camera: Camera | null = null
  let meshGeom: MeshData | null = null
  let selectedCellId: number | null = null

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
  let committed: Selection = {
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
  let pending: Selection | null = null
  let statusError: string | null = null
  let requestToken = 0
  let rafScheduled = false
  const limitsMemory = new LimitsMemory()
  let controlsHandle: SelectionControlsHandle | null = null

  // D-11: the divider fraction and the colour/scale/group choices persist
  // per run, server-side, through the view-state routes plan 05.1-02
  // added. Every write is debounced onto one timer, shared by the divider
  // drag and every selection/group change, so a slider dragged across
  // several positions writes once rather than once per tick.
  let dividerFraction = 0.72
  let viewWriteTimer: ReturnType<typeof setTimeout> | null = null

  function currentViewState(): ViewState {
    return {
      divider: dividerFraction,
      colormap: committed.colormap,
      reverse: committed.reverseColormap,
      scale: committed.scale,
      limitsMode: committed.limitsMode,
      group: drawnGroup,
      stat: committed.stat,
      layer: committed.layer,
    }
  }

  // A failed persist is a convenience regression, not a request failure
  // (D-11): the on-screen state is never touched here, and no error ever
  // surfaces from a write that did not land.
  function scheduleViewWrite(): void {
    if (viewWriteTimer !== null) clearTimeout(viewWriteTimer)
    viewWriteTimer = setTimeout(() => {
      viewWriteTimer = null
      void writeViewState(currentViewState()).catch(() => {})
    }, 400)
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
  let referenced: Uint8Array | null = null
  let drawnGroup: string | null = null
  // Interpolated pilot-point groups. `fieldKind` says what rawFullField
  // holds: block rows from /values, or one value per cell from /field.
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

  function interpolatedEntry(group: string | null): PpGroupInfo | null {
    return ppIndex.groups.find((g) => g.group === group) ?? null
  }

  // An interpolated group draws its field even when its points carry an x/y.
  function drawsAsPoints(): boolean {
    if (fieldKind !== 'block' || drawnGroup === null || interpolatedEntry(drawnGroup) !== null) return false
    return isPointGroup(joined, pointXy, drawnGroup)
  }

  function clearSelection(): void {
    selectedCellId = null
    selectedPointRow = null
    layer?.setSelected(null)
    layer?.setSelectedPoint(null)
  }

  // In the model on one layer: the idomain when the grid has one, else any
  // cell a block row names, at any layer (the mesh notes say which).
  function activeMaskFor(layerIndex: number): Uint8Array {
    const nCells = mesh?.nCells ?? 0
    if (idomain !== null) return layerActiveMask(idomain, nCells, layerIndex)
    if (referenced === null) referenced = referencedMask(cellArray, nCells)
    return referenced.slice()
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
    if (interpolatedEntry(drawnGroup) === null) return group
    const multiplier = allIdentities.some((i) => i.pargp === group && /_pstyle:m(_|$)/.test(i.parnme))
    return multiplier ? `${group} · interpolated multiplier field` : `${group} · interpolated`
  }
  // The drawn layer's own classification (D-06), recomputed by applyLayer
  // on every layer/group change and every landed fetch -- Task 2's click
  // readout reads this directly rather than reclassifying per click.
  let currentClasses: CellClass[] = []

  function selectionLabel(selection: Selection): string {
    return selection.stat === 'value' ? (selection.realization ?? '—') : selection.stat
  }

  // A hand-built status-bar field rather than a renderStatusBar entry --
  // that helper has no notion of per-field ink, and this is the one field
  // that must turn warning-coloured on a failed fetch (D-14) without
  // touching chrome.ts, which this plan does not modify.
  function appendSelectionField(): void {
    const label = statusError ?? selectionLabel(pending ?? committed)
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
  }

  // Resolves synchronously from currentClasses/rawFullField -- the client
  // already holds the field and the D-05 join, so there is no fetch and no
  // loading state here (D-08).
  function updateReadout(): void {
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
            x: pointXy[2 * pointRow],
            y: pointXy[2 * pointRow + 1],
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
    if (!camera || !meshGeom) return
    const rect = canvas.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height
    const [wx, wy] = camera.screenToWorld(x, y)
    // Dots are sized in device pixels, so the reach is 6 CSS pixels at the device's ratio.
    const reach = 6 * (window.devicePixelRatio || 1)
    const pointIndex = pickPoint(currentPoints, wx, wy, camera.screenToWorld(x + reach, y)[0] - wx)
    if (pointIndex !== null) {
      clearSelection()
      selectedPointRow = currentPoints.rows[pointIndex]
      layer?.setSelectedPoint(pointIndex)
      redraw()
      updateReadout()
      return
    }
    selectedPointRow = null
    layer?.setSelectedPoint(null)
    selectedCellId = pickAtWorld(meshGeom, wx, wy)
    layer?.setSelected(selectedCellId)
    redraw()
    updateReadout()
    if (selectedCellId !== null && currentClasses[selectedCellId]?.kind === 'interpolated') {
      fetchContributors(selectedCellId)
    }
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

  canvas.addEventListener('pointerdown', (event) => {
    if (!camera) return
    dragLast = canvasPoint(event)
    if (typeof canvas.setPointerCapture === 'function') {
      canvas.setPointerCapture(event.pointerId)
    }
  })

  canvas.addEventListener('pointermove', (event) => {
    if (!camera || !dragLast) return
    const point = canvasPoint(event)
    camera.pan(point[0] - dragLast[0], point[1] - dragLast[1])
    dragLast = point
    redrawFromCamera()
  })

  function endDrag(event: PointerEvent): void {
    if (!dragLast) return
    dragLast = null
    if (typeof canvas.releasePointerCapture === 'function') {
      canvas.releasePointerCapture(event.pointerId)
    }
  }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)

  // Wheel-to-zoom (D-15): zoomAt holds the world point under the cursor
  // fixed as the scale changes, so the grid stays under the pointer rather
  // than drifting while the user zooms.
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!camera) return
      event.preventDefault()
      const [x, y] = canvasPoint(event)
      camera.zoomAt(x, y, event.deltaY < 0 ? 1.1 : 1 / 1.1)
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

  function paintPicker(state: GroupPickerState): void {
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
    // The raw field itself changes when either side of the switch is an
    // interpolated group, so that switch fetches; block to block stays local.
    const needsFetch = fieldKind === 'cell' || interpolatedEntry(group) !== null
    const drawnPartrans = partransForGroup(joined, group, allIdentities)
    const newScale: ValueScale = drawnPartrans?.trim().toLowerCase() === 'log' ? 'log10' : 'linear'
    if (needsFetch) {
      pendingGroup = group
      // An interpolated group has values on one layer only, so it opens there.
      const nextLayer = interpolatedEntry(group)?.layer ?? dotLayerFor(group) ?? committed.layer
      const next: Selection = { ...committed, layer: nextLayer, scale: newScale, scaleInferred: true }
      controlsHandle?.sync(next)
      controlsHandle?.setLayer(nextLayer)
      clearSelection()
      scheduleFetch(next)
      updateReadout()
      return
    }
    pendingGroup = null
    drawnGroup = group
    const nextLayer = dotLayerFor(group) ?? committed.layer
    committed = { ...committed, layer: nextLayer, scale: newScale, scaleInferred: true }
    controlsHandle?.setLayer(nextLayer)
    // WINDOWS.md #5: the scale control must show what was just inferred,
    // not whatever it happened to display for the previous group --
    // deriveAndDraw's own setLogUsability call (below) can still override
    // this to linear, for a genuinely different reason (the new field has
    // non-positive values), so this runs first.
    controlsHandle?.sync(committed)
    clearSelection()
    deriveAndDraw()
    updateReadout()
    scheduleViewWrite()
  }

  // A dot group picked on a layer holding none of its dots opens on the lowest layer that does.
  function dotLayerFor(group: string): number | null {
    if (interpolatedEntry(group) !== null || !isPointGroup(joined, pointXy, group)) return null
    let lowest: number | null = null
    for (let row = 0; row < joined.length; row++) {
      if (joined[row]?.pargp !== group || pointXy === null || !hasPosition(pointXy, row)) continue
      const l = layerArray[row]
      if (l === committed.layer) return null
      if (l >= 0 && (lowest === null || l < lowest)) lowest = l
    }
    return lowest
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
      },
    }
  }

  function paintHeader(): void {
    renderHeader(header, {
      title: opts.config?.case ?? 'This run',
      themeChoice: currentTheme(),
      chips: chipsInput(),
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
    return
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

  // Reprojects a full block-order field into grid-cell order, filtered to
  // one layer and the drawn group, from classifyCells' own D-06
  // classification -- a contested cell gets no value at all (NaN; the
  // stripe is its only mark) rather than the last-seen row's value.
  function computePerCell(
    field: Float32Array,
    layerIndex: number,
  ): { perCell: Float32Array; contested: number; noValue: number; classes: CellClass[] } {
    const nCells = mesh?.nCells ?? 0
    const entry = fieldKind === 'cell' ? interpolatedEntry(fieldGroup) : null
    if (fieldKind === 'cell' && entry !== null) {
      const active = activeMaskFor(layerIndex)
      // The field is drawn only on its own layer, so only there does a value put a cell in the model.
      if (layerIndex === entry.layer) {
        for (let c = 0; c < active.length; c++) {
          if (Number.isFinite(field[c])) active[c] = 1
        }
      }
      const { classes, noValueCount } = classifyFieldCells(field, active, entry.layer, layerIndex)
      const perCell = new Float32Array(nCells).fill(Number.NaN)
      for (let c = 0; c < nCells; c++) {
        if (classes[c].kind === 'interpolated') perCell[c] = field[c]
      }
      return { perCell, contested: 0, noValue: noValueCount, classes }
    }
    if (drawsAsPoints()) {
      // The dots carry the values; a cell only says which of the group's rows it hosts.
      const hosted = new Map<number, number[]>()
      for (let row = 0; row < joined.length; row++) {
        const c = cellArray[row]
        if (joined[row]?.pargp !== drawnGroup || layerArray[row] !== layerIndex || c < 0 || c >= nCells) continue
        const rows = hosted.get(c)
        if (rows) rows.push(row)
        else hosted.set(c, [row])
      }
      const active = activeMaskFor(layerIndex)
      const classes: CellClass[] = []
      let noValue = 0
      for (let c = 0; c < nCells; c++) {
        const rows = hosted.get(c)
        if (rows) classes.push({ kind: 'points', rows })
        else if (active[c]) classes.push({ kind: 'no-parameter' })
        else classes.push({ kind: 'outside-model' })
        if (!rows && active[c]) noValue += 1
      }
      return { perCell: new Float32Array(nCells).fill(Number.NaN), contested: 0, noValue, classes }
    }
    const { classes, contestedCount, noValueCount } = classifyCells(
      joined,
      cellArray,
      layerArray,
      drawnGroup ?? '',
      layerIndex,
      activeMaskFor(layerIndex),
    )
    const perCell = new Float32Array(nCells).fill(Number.NaN)
    for (let c = 0; c < nCells; c++) {
      const cls = classes[c]
      if (cls.kind === 'valued') {
        perCell[c] = field[cls.row]
      }
    }
    return { perCell, contested: contestedCount, noValue: noValueCount, classes }
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

  // Under dots no cell carries a value, so this quiet fill is what shows the model's shape.
  function footprintMask(classes: CellClass[]): Uint8Array {
    const mask = new Uint8Array(classes.length)
    for (let c = 0; c < classes.length; c++) {
      const kind = classes[c].kind
      mask[c] = kind === 'points' || kind === 'no-parameter' ? 1 : 0
    }
    return mask
  }

  // Each dot reads the same scaled field the fill does, so log scale and its refusal apply alike.
  function applyPoints(field: Float32Array): void {
    if (!layer) return
    if (pointXy === null || !drawsAsPoints()) {
      currentPoints = { rows: new Int32Array(0), xy: new Float32Array(0) }
      selectedPointRow = null
      layer.setSelectedPoint(null)
      layer.setPoints(new Float32Array(0), new Float32Array(0))
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
    layer.setPoints(xy, values)
    const index = selectedPointRow === null ? -1 : currentPoints.rows.indexOf(selectedPointRow)
    if (index < 0) selectedPointRow = null
    layer.setSelectedPoint(index < 0 ? null : index)
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
    if (!rawFullField || !layer) {
      renderLegend(legendEl, null)
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
      const key = `${effectiveScale}:${committed.limitsMode}:${committed.stat}:${drawnGroup ?? ''}`
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

    renderLegend(legendEl, {
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
  function scheduleFetch(next: Selection): void {
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

  async function performFetch(selection: Selection): Promise<void> {
    // Guards the response against a newer request that started before this
    // one landed -- a superseded answer is dropped silently, never drawn.
    const token = ++requestToken
    const query: GridValuesQuery =
      selection.stat === 'value'
        ? { iteration: selection.iteration, realization: selection.realization ?? undefined }
        : { iteration: selection.iteration, stat: selection.stat }

    const group = pendingGroup ?? drawnGroup
    const kind: 'block' | 'cell' = interpolatedEntry(group) !== null ? 'cell' : 'block'
    let field: Float32Array
    try {
      field =
        kind === 'cell'
          ? await gridField({ ...query, group: group! })
          : await gridValues(query)
    } catch (error) {
      if (token !== requestToken) return
      const status = error instanceof ApiError ? error.problem.status : 'unknown'
      statusError = `${selectionLabel(selection)} — couldn't load (${status})`
      pending = null
      if (pendingGroup !== null) {
        // The switch failed: the picker and controls go back to what is drawn.
        pendingGroup = null
        const select = pickerEl.querySelector('select')
        if (select && drawnGroup !== null) select.value = drawnGroup
        controlsHandle?.sync(committed)
        controlsHandle?.setLayer(committed.layer)
      }
      paintStatusBar()
      return
    }
    if (token !== requestToken) return
    drawnGroup = group
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
    fieldKind = kind
    if (fieldGroup !== group || kind === 'block') contributorsMemo.clear()
    fieldGroup = group
    rawFieldNonPositiveCount = logIsUsable(field)
    scaledField = null
    scaledFieldScale = null
    committed = selection
    pending = null
    statusError = null
    deriveAndDraw()
    paintStatusBar()
    scheduleViewWrite()
  }

  function handleSelectionChange(next: Selection): void {
    const needsFetch =
      next.stat !== committed.stat ||
      next.realization !== committed.realization ||
      next.iteration !== committed.iteration
    if (needsFetch) {
      scheduleFetch(next)
      return
    }
    committed = next
    deriveAndDraw()
    scheduleViewWrite()
  }

  clearCanvas()

  void loadAndDraw(ctx)

  // A failed or misshapen read draws every group as cells, with a notice saying why.
  async function readPointXy(iteration: number): Promise<Float32Array | null> {
    let reason: string
    try {
      const xy = await gridPointXy(iteration)
      if (xy === null || xy.length === 2 * cellArray.length) return xy
      reason = `It has ${xy.length} values, not the ${2 * cellArray.length} the map block needs (an x and a y per row).`
    } catch (error) {
      reason = describeError(error)
    }
    addNotice(mapNotice, {
      title: 'Point positions could not be read',
      detail: `${reason} Groups placed by x/y draw as the cells their points sit in.`,
      tone: 'serious',
    })
    return null
  }

  async function loadAndDraw(gl: GlContext): Promise<void> {
    const iteration = opts.config?.first_iteration ?? 0

    // Started here, ahead of the mesh/parmap fetches -- the divider's own
    // position does not depend on any of that data, so it is rendered as
    // soon as the read lands rather than waiting on the whole map to load.
    // A failed read is not this plan's problem to report: the server-side
    // store never raises and already falls back to its own defaults.
    const viewStatePromise = readViewState().catch((): ViewState | null => null)
    void viewStatePromise.then((viewState) => {
      dividerFraction = viewState?.divider ?? dividerFraction
      renderDivider(dividerEl, {
        container: panel,
        before: mapArea,
        after: paramsPanelHost,
        initialFraction: dividerFraction,
        onCommit: (fraction) => {
          dividerFraction = fraction
          scheduleViewWrite()
        },
      })
    })

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

    let parmap: Int32Array
    let identities: ParIdentity[]
    try {
      parmap = await fetchParmap(iteration)
      identities = await fetchParIdentities()
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
    joined = joinBlockToIdentity(parmap, identities)
    allIdentities = identities
    // A run with no pilot points has no index; that is not an error.
    try {
      ppIndex = await fetchPpIndex()
    } catch {
      ppIndex = EMPTY_PP_INDEX
    }

    try {
      cellArray = await gridCells('cell', iteration)
      layerArray = await gridCells('layer', iteration)
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

    // The Params panel's per-artifact notes: every artifact the ingest
    // recorded a reason for, named and shown verbatim (CLAUDE.md's fourth
    // hard rule -- nothing dropped without a trace).
    const artifactNotes = opts.state.artifacts
      .filter((artifact): artifact is typeof artifact & { reason: string } => artifact.reason !== null)
      .map((artifact) => ({ artifact: artifact.name, reason: artifact.reason }))
    for (const note of mesh.notes) artifactNotes.push({ artifact: 'mesh', reason: note })
    if (idomain !== null) {
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

    // D-07: only groups that place on at least one cell are offered; the
    // rest are counted and named behind the picker's own disclosure.
    const { drawable, unmapped, interpolated } = computeGroupPlacement(identities, joined, cellArray, ppIndex)
    if (drawable.length === 0) {
      addNotice(mapNotice, {
        title: 'No parameter group can be drawn on this map',
        detail: 'Every group in this run failed to place on the grid. The unmapped list below names each one and the rule that was tried.',
        tone: 'info',
      })
      paintPicker({ kind: 'none-drawable', unmapped })
      renderParamsPanel(paramsPanelHost, { unmapped, artifactNotes })
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
    renderParamsPanel(paramsPanelHost, { unmapped, artifactNotes })

    const realNames = await fetchRealNames(iteration)

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

    await performFetch(committed)
  }
}
