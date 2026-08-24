// The map screen: header, notice area, canvas and status bar, and the
// load-and-draw sequence that turns a run's mesh, parameter table and one
// realization's field into a WebGL2 drawing. This replaces placeholder.ts
// as the screen every flow in this phase ends at.

import type { GridValuesQuery, IngestState, MeshInfo } from '../data/client'
import { gridCells, gridMesh, gridMeshBuffer, gridValues, runReals } from '../data/client'
import { fetchParIdentities, fetchParmap, joinBlockToIdentity, type ParIdentity } from '../data/parmap'
import { Camera } from '../gl/camera'
import { scaleLimits } from '../gl/colormap'
import { createContext, type GlContext } from '../gl/context'
import { MeshLayer, type MeshData } from '../gl/mesh-layer'
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

  function paintStatusBar(): void {
    renderStatusBar(statusBar, {
      'Ingest time': opts.state.ingestSeconds === null ? null : formatSeconds(opts.state.ingestSeconds),
      'Cache size': opts.state.cacheBytes === null ? null : formatBytes(opts.state.cacheBytes),
      ...statusExtra,
    })
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

  clearCanvas()

  void loadAndDraw(ctx)

  async function loadAndDraw(gl: GlContext): Promise<void> {
    const iteration = opts.config?.first_iteration ?? 0

    let mesh: MeshInfo
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
    const joined = joinBlockToIdentity(parmap, identities)

    let cellArray: Int32Array
    let layerArray: Int32Array
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

    const drawnGroup = pickFirstGroup(joined)
    if (drawnGroup === null) {
      renderNotice(mapNotice, {
        title: 'No parameter group can be drawn',
        detail: 'Every parameter in this run is unmapped, so there is no field to colour the grid with.',
        tone: 'info',
      })
      return
    }

    let realizations: string[]
    try {
      realizations = await runReals(iteration)
    } catch (error) {
      renderNotice(mapNotice, {
        title: 'No realizations were recorded',
        detail: describeError(error),
        tone: 'serious',
      })
      return
    }
    const realization = realizations[0]
    if (realization === undefined) {
      renderNotice(mapNotice, { title: 'No realizations were recorded', tone: 'info' })
      return
    }

    let field: Float32Array
    try {
      const query: GridValuesQuery = { iteration, realization }
      field = await gridValues(query)
    } catch (error) {
      renderNotice(mapNotice, { title: 'The field could not be read', detail: describeError(error), tone: 'serious' })
      return
    }

    if (field.length === 0) {
      renderNotice(mapNotice, {
        title: 'This realization has no values',
        detail: 'The server returned an empty field, so there is nothing to draw.',
        tone: 'info',
      })
      return
    }

    // D-01: limits are computed over the whole field before any layer or
    // group filter, so one scale covers the whole run and a later layer
    // change is a comparison rather than a re-normalisation.
    const limits = scaleLimits(field, 0.02)

    // Reproject from block order into grid-cell order: a block row's index
    // is its position in the ensemble file, not a grid cell id -- the
    // block-order `cell` companion array is the only thing that says which
    // physical cell each row belongs to. Skipping this step would upload
    // block row i's value to grid cell i, which is only ever right by
    // coincidence. Two block rows landing on the same cell (a contested
    // cell, D-06) overwrite here rather than blend -- that decision, and
    // the contested mark itself, belong to a later plan; this tracer never
    // invents an averaged value.
    const perCell = new Float32Array(mesh.nCells).fill(Number.NaN)
    for (let i = 0; i < field.length; i++) {
      const identity = joined[i]
      const onLayerZero = layerArray[i] === 0
      const inDrawnGroup = identity !== null && identity.pargp === drawnGroup
      if (!onLayerZero || !inDrawnGroup) continue
      const cellId = cellArray[i]
      if (cellId >= 0 && cellId < mesh.nCells) {
        perCell[cellId] = field[i]
      }
    }

    mapNotice.textContent = ''

    const meshData: MeshData = { positions, cellIndex: cellIndexBuf, indices, nCells: mesh.nCells }
    layer = new MeshLayer(gl.gl, meshData)
    layer.setValues(perCell)
    layer.setLimits(limits)
    layer.setColormap('viridis')

    const camera = new Camera(canvas.width, canvas.height)
    camera.fit(mesh.bounds)
    layer.setMatrix(camera.matrix())

    redraw()
    canvas.setAttribute('data-drawn', 'true')
  }
}
