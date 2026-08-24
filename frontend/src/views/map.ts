// The map screen: header, notice area, canvas and status bar, and the
// load-and-draw sequence that turns a run's mesh, parameter table and one
// realization's field into a WebGL2 drawing. This replaces placeholder.ts
// as the screen every flow in this phase ends at.

import { ApiError, type GridValuesQuery, type IngestState, type MeshInfo } from '../data/client'
import { gridCells, gridMesh, gridMeshBuffer, gridValues } from '../data/client'
import { fetchParIdentities, fetchParmap, joinBlockToIdentity, type ParIdentity } from '../data/parmap'
import { fetchRealNames } from '../data/reals'
import { Camera } from '../gl/camera'
import { scaleLimits } from '../gl/colormap'
import { createContext, type GlContext } from '../gl/context'
import { MeshLayer, type MeshData } from '../gl/mesh-layer'
import { renderSelectionControls, type Selection } from '../ui/controls'
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
  panel.appendChild(canvas)
  panel.appendChild(mapNotice)
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

  // The full block-order field for the selection currently committed to the
  // canvas -- kept so a layer change can re-filter it locally without a
  // fetch. `committed` is that selection; `pending` is a newer one whose
  // fetch has not landed yet, shown in the status bar while `fullField`
  // still holds the last one that did.
  let fullField: Float32Array | null = null
  let committed: Selection = { iteration: 0, layer: 0, stat: 'value', realization: null }
  let pending: Selection | null = null
  let statusError: string | null = null
  let requestToken = 0
  let rafScheduled = false

  // Loaded once at mount and constant afterwards -- this plan carries no
  // iteration selector, so a redraw only ever needs the layer to change.
  let mesh: MeshInfo | null = null
  let joined: Array<ParIdentity | null> = []
  let cellArray: Int32Array = new Int32Array(0)
  let layerArray: Int32Array = new Int32Array(0)
  let drawnGroup: string | null = null

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
  // one layer and the drawn group. A block row's index is its position in
  // the ensemble file, not a grid cell id -- the block-order `cell`
  // companion array is the only thing that says which physical cell each
  // row belongs to. Two block rows landing on the same cell (a contested
  // cell, D-06) overwrite here rather than blend; the contested mark
  // itself is out of this plan's scope.
  function computePerCell(field: Float32Array, layerIndex: number): Float32Array {
    const nCells = mesh?.nCells ?? 0
    const perCell = new Float32Array(nCells).fill(Number.NaN)
    for (let i = 0; i < field.length; i++) {
      const identity = joined[i]
      const onLayer = layerArray[i] === layerIndex
      const inDrawnGroup = identity !== null && identity.pargp === drawnGroup
      if (!onLayer || !inDrawnGroup) continue
      const cellId = cellArray[i]
      if (cellId >= 0 && cellId < nCells) {
        perCell[cellId] = field[i]
      }
    }
    return perCell
  }

  // A layer change never fetches -- the client already holds the whole
  // field, so this re-filters it locally against the layer companion array
  // and draws. Never touches the legend's limits: the one-scale-per-run
  // rule (D-01) means only a landed fetch may change them.
  function applyLayer(): void {
    if (!fullField || !layer) return
    layer.setValues(computePerCell(fullField, committed.layer))
    redraw()
    canvas.setAttribute('data-drawn', 'true')
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

    // D-01: limits come from the full array the moment it lands, before
    // any layer filter -- one scale for the whole run, computed only here,
    // never on the layer-change path.
    const limits = scaleLimits(field, 'robust')
    fullField = field
    layer?.setLimits(limits)
    committed = selection
    pending = null
    statusError = null
    applyLayer()
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
    committed = { ...committed, layer: next.layer }
    applyLayer()
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
    const inactiveMask = new Uint8Array(mesh.nCells).fill(1)
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

    const camera = new Camera(canvas.width, canvas.height)
    camera.fit(mesh.bounds)
    layer.setMatrix(camera.matrix())

    // A run whose realization names were never recorded can still show an
    // aggregate statistic, which needs no realization name -- 'value'
    // would only ever fail to load, so it is not offered as the default.
    const initialStat = realNames.ok ? 'value' : 'mean'
    const initialRealization = realNames.ok ? (realNames.names[0] ?? null) : null
    committed = { iteration, layer: 0, stat: initialStat, realization: initialRealization }

    const controlsEl = document.createElement('div')
    panel.appendChild(controlsEl)
    renderSelectionControls(controlsEl, {
      nlay: mesh.nlay,
      iteration,
      realNames,
      onSelectionChange: handleSelectionChange,
    })

    await performFetch(committed)
  }
}
