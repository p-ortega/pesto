// The map screen: header, notice area, canvas and status bar, and the
// load-and-draw sequence that turns a run's mesh, parameter table and one
// realization's field into a WebGL2 drawing. This replaces placeholder.ts
// as the screen every flow in this phase ends at.

import { ApiError, type GridValuesQuery, type IngestState, type MeshInfo } from '../data/client'
import { gridCells, gridMesh, gridMeshBuffer, gridValues } from '../data/client'
import {
  classifyCells,
  fetchParIdentities,
  fetchParmap,
  joinBlockToIdentity,
  type CellClass,
  type ParIdentity,
} from '../data/parmap'
import { fetchRealNames } from '../data/reals'
import { Camera } from '../gl/camera'
import { applyScale, logIsUsable, scaleLimits, LimitsMemory, type ValueScale } from '../gl/colormap'
import { createContext, type GlContext } from '../gl/context'
import { MeshLayer, type MeshData } from '../gl/mesh-layer'
import { renderSelectionControls, type Selection, type SelectionControlsHandle } from '../ui/controls'
import { renderLegend } from '../ui/legend'
import {
  renderHeader,
  renderNotice,
  renderStatusBar,
  type NoticeTone,
  type RenderNoticeOptions,
} from '../ui/chrome'
import { currentTheme, setTheme, type ThemeChoice } from '../ui/theme'

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
  first_iteration: number | null
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

// Reads a resolved CSS custom property the same way for the canvas clear
// colour and the hairline outline -- a hex token (`--page-plane`) or an
// rgba() token (`--hairline`), converted to the 0-1 floats WebGL2 wants.
// No colour value is written here; every number comes from the token.
function readColorToken(name: string): [number, number, number] {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()

  if (value.startsWith('#')) {
    const n = Number.parseInt(value.slice(1), 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }

  const match = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/)
  if (match) {
    return [Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255]
  }

  return [0, 0, 0]
}

// The first group, in block order, that has at least one identified block
// row -- the drawn group for this tracer, since no group picker exists
// yet. Returns null when every row is unidentifiable (D-05's join found
// nothing), which the caller renders as a designed state.
function pickFirstGroup(joined: Array<ParIdentity | null>): string | null {
  for (const identity of joined) {
    if (identity !== null) return identity.pargp
  }
  return null
}

// The drawn group's own partrans, read straight from the D-05 join --
// never a positional guess. A group with no identified row (never reached
// while drawnGroup itself came from this same join) returns null, which
// the scale default treats as linear.
function partransForGroup(joined: Array<ParIdentity | null>, group: string): string | null {
  for (const identity of joined) {
    if (identity !== null && identity.pargp === group) return identity.partrans
  }
  return null
}

/**
 * The map screen: header, blocked-capability notices, the canvas panel and
 * the status bar, then the load-and-draw sequence -- mesh, the D-05 join,
 * the cell/layer companions, one realization's field -- ending in one
 * WebGL2 draw of one parameter group's field on a themed canvas.
 */
export function mountMap(root: HTMLElement, opts: MountMapOptions): void {
  root.textContent = ''
  root.classList.add('page')

  const header = document.createElement('div')
  header.classList.add('header')
  const noticeArea = document.createElement('div')
  const panel = document.createElement('div')
  panel.classList.add('map-frame')
  const canvas = document.createElement('canvas')
  canvas.width = 800
  canvas.height = 480
  canvas.tabIndex = 0
  const mapNotice = document.createElement('div')
  const legendEl = document.createElement('div')
  panel.appendChild(canvas)
  panel.appendChild(mapNotice)
  panel.appendChild(legendEl)
  const statusBar = document.createElement('div')
  statusBar.classList.add('status-bar')

  root.appendChild(header)
  root.appendChild(noticeArea)
  root.appendChild(panel)
  root.appendChild(statusBar)

  let ctx: GlContext | null = null
  let layer: MeshLayer | null = null
  let statusExtra: Record<string, string | number | null> = {}
  let meshBytes: number | null = null

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

  // Loaded once at mount and constant afterwards -- this plan carries no
  // iteration selector, so a redraw only ever needs the layer to change.
  let mesh: MeshInfo | null = null
  let joined: Array<ParIdentity | null> = []
  let cellArray: Int32Array = new Int32Array(0)
  let layerArray: Int32Array = new Int32Array(0)
  let inactiveMask: Uint8Array = new Uint8Array(0)
  let drawnGroup: string | null = null
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

  function paintStatusBar(): void {
    renderStatusBar(statusBar, {
      'Ingest time': opts.state.ingestSeconds === null ? null : formatSeconds(opts.state.ingestSeconds),
      'Cache size': opts.state.cacheBytes === null ? null : formatBytes(opts.state.cacheBytes),
      'Mesh size': meshBytes === null ? null : formatBytes(meshBytes),
      ...statusExtra,
    })
    appendSelectionField()
  }

  function clearCanvas(): void {
    if (!ctx) return
    const [r, g, b] = readColorToken('--page-plane')
    ctx.gl.viewport(0, 0, canvas.width, canvas.height)
    ctx.gl.clearColor(r, g, b, 1)
    ctx.gl.clear(ctx.gl.COLOR_BUFFER_BIT)
  }

  function redraw(): void {
    clearCanvas()
    layer?.draw()
  }

  // The stripe (--ink-primary over the neutral --gridline fill) and the
  // selection ring (--accent) resolve exactly like the hairline: read once
  // at mount, and again on every theme change, never cached across one.
  function applyThemeColors(): void {
    layer?.setContestedColors(readColorToken('--ink-primary'), readColorToken('--gridline'))
    layer?.setAccentColor(readColorToken('--accent'))
  }

  function paintHeader(): void {
    renderHeader(header, {
      title: opts.config?.case ?? 'This run',
      themeChoice: currentTheme(),
      onThemeChange: (choice: ThemeChoice) => {
        setTheme(choice)
        paintHeader()
        // --hairline resolves differently under each data-theme value, so
        // it is re-read here exactly like --page-plane is, never cached.
        layer?.setHairlineColor(readColorToken('--hairline'))
        applyThemeColors()
        redraw()
      },
    })
  }
  paintHeader()

  renderBlockedCapabilities(noticeArea, opts.state)
  paintStatusBar()

  try {
    ctx = createContext(canvas)
  } catch (error) {
    renderNotice(mapNotice, { title: 'This browser cannot draw the grid', detail: describeError(error), tone: 'critical' })
    return
  }

  ctx.onLost(() => {
    statusExtra = { Status: 'restoring' }
    paintStatusBar()
  })
  ctx.onRestored(() => {
    layer?.reupload()
    redraw()
    statusExtra = {}
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
    const { classes, contestedCount, noValueCount } = classifyCells(
      joined,
      cellArray,
      layerArray,
      drawnGroup ?? '',
      layerIndex,
      nCells,
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
    const contestedMask = new Uint8Array(classes.length)
    for (let c = 0; c < classes.length; c++) {
      contestedMask[c] = classes[c].kind === 'contested' ? 1 : 0
    }
    layer.setContested(contestedMask)
    layer.setValues(perCell)
    redraw()
    canvas.setAttribute('data-drawn', 'true')
    return { contested, noValue }
  }

  // Recomputes the drawn scale, limits and colormap from the raw held
  // field and redraws -- never a fetch. Runs after every selection change
  // that isn't a stat/realization/iteration change, and once when a fetch
  // lands. D-02: robust/minmax limits are remembered per statistic (and
  // per effective scale and mode, so switching either never reuses a
  // pair computed in a different domain); manual limits are the caller's
  // own pair and are never cached.
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
      const key = `${effectiveScale}:${committed.limitsMode}:${committed.stat}`
      const cached = limitsMemory.get(key)
      limits = cached ?? scaleLimits(scaled, committed.limitsMode)
      if (!cached) limitsMemory.set(key, limits)
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
      group: drawnGroup ?? '',
      contested,
      noValue,
    })
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

    let field: Float32Array
    try {
      field = await gridValues(query)
    } catch (error) {
      if (token !== requestToken) return
      const status = error instanceof ApiError ? error.problem.status : 'unknown'
      statusError = `${selectionLabel(selection)} — couldn't load (${status})`
      pending = null
      paintStatusBar()
      return
    }
    if (token !== requestToken) return

    // D-01: the raw field lands here, before any scale, layer or group
    // filter -- one scale for the whole run, derived only from this array,
    // never from an already-filtered subset.
    rawFullField = field
    rawFieldNonPositiveCount = logIsUsable(field)
    scaledField = null
    scaledFieldScale = null
    committed = selection
    pending = null
    statusError = null
    deriveAndDraw()
    paintStatusBar()
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
  }

  clearCanvas()

  void loadAndDraw(ctx)

  async function loadAndDraw(gl: GlContext): Promise<void> {
    const iteration = opts.config?.first_iteration ?? 0

    let positions: Float32Array
    let cellIndexBuf: Float32Array
    let indices: Uint32Array
    try {
      mesh = await gridMesh()
      positions = (await gridMeshBuffer('positions')) as Float32Array
      cellIndexBuf = (await gridMeshBuffer('cell_index')) as Float32Array
      indices = (await gridMeshBuffer('indices')) as Uint32Array
    } catch (error) {
      renderNotice(mapNotice, { title: 'The grid could not be read', detail: describeError(error), tone: 'serious' })
      return
    }
    meshBytes = positions.byteLength + cellIndexBuf.byteLength + indices.byteLength

    let parmap: Int32Array
    let identities: ParIdentity[]
    try {
      parmap = await fetchParmap(iteration)
      identities = await fetchParIdentities()
    } catch (error) {
      renderNotice(mapNotice, {
        title: 'The parameter table could not be read',
        detail: describeError(error),
        tone: 'serious',
      })
      return
    }
    joined = joinBlockToIdentity(parmap, identities)

    try {
      cellArray = await gridCells('cell', iteration)
      layerArray = await gridCells('layer', iteration)
    } catch (error) {
      renderNotice(mapNotice, {
        title: 'The cell mapping could not be read',
        detail: describeError(error),
        tone: 'serious',
      })
      return
    }

    drawnGroup = pickFirstGroup(joined)
    if (drawnGroup === null) {
      renderNotice(mapNotice, {
        title: 'No parameter group can be drawn',
        detail: 'Every parameter in this run is unmapped, so there is no field to colour the grid with.',
        tone: 'info',
      })
      return
    }

    const realNames = await fetchRealNames(iteration)

    // Outside the model (MAP-07): a grid cell never referenced by any
    // block row of any group, at any layer -- distinct from a cell that IS
    // in the model but not in the drawn group/layer, which computePerCell
    // already leaves as NaN and the fill shader discards.
    inactiveMask = new Uint8Array(mesh.nCells).fill(1)
    for (let i = 0; i < cellArray.length; i++) {
      const cellId = cellArray[i]
      if (cellId >= 0 && cellId < mesh.nCells) {
        inactiveMask[cellId] = 0
      }
    }

    mapNotice.textContent = ''

    const meshData: MeshData = { positions, cellIndex: cellIndexBuf, indices, nCells: mesh.nCells }
    layer = new MeshLayer(gl.gl, meshData)
    layer.setColormap('viridis')
    layer.setInactive(inactiveMask)
    layer.setHairlineColor(readColorToken('--hairline'))
    applyThemeColors()

    const camera = new Camera(canvas.width, canvas.height)
    camera.fit(mesh.bounds)
    layer.setMatrix(camera.matrix())

    // A run whose realization names were never recorded can still show an
    // aggregate statistic, which needs no realization name -- 'value'
    // would only ever fail to load, so it is not offered as the default.
    const initialStat = realNames.ok ? 'value' : 'mean'
    const initialRealization = realNames.ok ? (realNames.names[0] ?? null) : null
    // D-03: the scale defaults from the drawn group's own partrans, read
    // through the D-05 join -- matched case-insensitively after trimming,
    // and linear for anything this code has never seen.
    const drawnPartrans = partransForGroup(joined, drawnGroup)
    const initialScale: ValueScale = drawnPartrans?.trim().toLowerCase() === 'log' ? 'log10' : 'linear'
    committed = {
      iteration,
      layer: 0,
      stat: initialStat,
      realization: initialRealization,
      colormap: 'viridis',
      reverseColormap: false,
      scale: initialScale,
      scaleInferred: true,
      limitsMode: 'robust',
      manualLimits: null,
    }

    const controlsEl = document.createElement('div')
    panel.appendChild(controlsEl)
    controlsHandle = renderSelectionControls(controlsEl, {
      nlay: mesh.nlay,
      iteration,
      realNames,
      partrans: drawnPartrans,
      onSelectionChange: handleSelectionChange,
    })

    await performFetch(committed)
  }
}
